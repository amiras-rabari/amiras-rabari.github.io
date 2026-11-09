---
title: "Building a Database Engine from Scratch: Block Nested Loop, Grace Hash, and Sort-Merge Joins"
date: 2026-10-15
draft: true
tags: [databases, cpp, systems]
summary: How I designed and built three join algorithms for my C++ database engine, and how each one stays inside a fixed memory budget.
---
When building a relational database management system (RDBMS) from scratch in C++, few components are as critical—or as challenging to implement correctly—as the **Query Execution Engine**. At the heart of query execution sits the **Join Operator**.

In relational algebra, joins are conceptually simple: take two streams of tuples, evaluate a predicate condition, and combine matching attributes. However, when dealing with datasets that far exceed available RAM, naive implementations quickly collapse under Disk I/O bottlenecks.

In this blog post, I will walk through how I designed and implemented three core join algorithms for my custom C++ database engine:
1. **Block Nested Loop Join (BNLJ)**
2. **Grace Hash Join with Block Fallback**
3. **Sort-Merge Join with Disk-Spilled Group Buffering**

We’ll explore the architectural trade-offs, step through the actual implementation code, and look at how memory frame budget allocation (`FrameShare`) guarantees system stability under extreme memory constraints.

---

## Architectural Context: The Operator Vector Pipeline

Before diving into specific join algorithms, it’s worth understanding the execution model of the engine. The system employs an **Iterator/Volcano-style model** (`open()`, `next()`, `close()`). Every operator in the pipeline is a subclass of `db::exec::Operator`, producing tuples lazily on demand.

To manage physical memory deterministically without relying on host operating system page faults or runaway allocations, memory is granted to operators via an `ExecContext` using fixed-size memory frames (`share.ownFrames` and `share.streamFrames`).

---

## 1. Block Nested Loop Join (BNLJ): The Universal Workhorse

### The Problem with Naive Nested Loops
A standard tuple-at-a-time nested loop join reads an inner table $S$ completely for *every single tuple* in the outer table $R$. If $R$ has $M$ pages and $S$ has $N$ pages, the I/O cost is $M + (|R| \cdot N)$ page reads—an absolute catastrophe for disk access.

### The Solution: Frame-Buffered Outer Blocks
**Block Nested Loop Join** mitigates this by reading the outer table $R$ in contiguous blocks that fill all available memory frames ($B - 2$ frames). For each block of $R$, we scan $S$ once. This reduces the total I/O cost down to:

$$\text{Cost}_{\text{BNLJ}} = M + \left\lceil \frac{M}{B - 2} \right\rceil \cdot N \text{ page reads}$$

While the number of predicate comparisons remains $O(|R| \cdot |S|)$, the reduction in disk reads is dramatic. Crucially, BNLJ works for **any predicate condition** (e.g., `<`, `>`, `!=`), not just equi-joins.

### C++ Implementation Highlights

The join state machine must persist between calls to `doNext(Tuple& out)`. If a tuple from the outer table cannot fit into the current block buffer (`BoundedTupleBuffer`), it is saved as a `carry_` tuple to begin the next block.

```cpp
bool NestedLoopJoinOperator::fillBlock()
{
    block_.clear();
    // The tuple left over from the last block goes first.
    if (hasCarry_)
    {
        block_.tryAdd(carry_);
        hasCarry_ = false;
    }
    Tuple t;
    while (!outerDone_)
    {
        if (!child(0).next(t))
        {
            outerDone_ = true;
            child(0).close(); // Return outer page to pool immediately
            break;
        }
        if (!block_.tryAdd(t))
        {
            carry_ = std::move(t);
            hasCarry_ = true;
            break;
        }
    }
    return block_.size() > 0;
}
```

#### Key Engineering Detail: State Recovery across `doNext()`
Because downstream operators pull one tuple at a time, `doNext()` saves its loop state via `blockIndex_` and `innerOpen_`. When an inner pass over the current outer block finishes, `child(1)` is closed, `fillBlock()` fetches the next batch of $R$, and `child(1)` is re-opened.

---

## 2. Grace Hash Join: High-Throughput Equi-Joins with Dynamic Fallback

For equality join predicates ($R.key = S.key$), hash joins offer unmatched linear $O(|R| + |S|)$ time complexity. However, when tables exceed main memory, a naive in-memory hash table will result in Out-Of-Memory (OOM) crashes.

To handle arbitrary data scale, I implemented **Grace Hash Join** paired with a fallback mechanism for memory overflow.

### Phase 1: Partitioning ($h_1$)
During `doOpen()`, both left ($R$) and right ($S$) inputs are scanned and hashed using a partition hash function $h_1$ (`kSeedPartition`). Tuples are streamed into $P$ matching disk partition files (`leftParts_` and `rightParts_`). 

Because hashing is deterministic, any matching tuple pair $(r, s)$ is guaranteed to end up in the exact same partition pair $(R_i, S_i)$.

$$\text{Partitioning Cost} = 2(M + N) \text{ page I/Os}$$

### Phase 2: In-Memory Build & Probe ($h_2$)
During `startPartition()`, the engine processes each partition pair $(R_i, S_i)$ sequentially:
1. **Build:** Load $R_i$ into an in-memory hash table using a second seed hash function $h_2$ (`kSeedTable`).
2. **Probe:** Stream $S_i$ from disk. For each tuple in $S_i$, compute $h_2(s.key)$, look up the bucket index, and test key equality.

```cpp
// In-Memory Probe Loop in doNext()
const std::vector<Tuple>& entries = entries_->tuples();
const std::vector<std::size_t>* bucket = 
    &buckets_[hashKey(probe_, keys_.rightColumns, kSeedTable) % buckets_.size()];

while (candidate_ < bucket->size())
{
    const Tuple& entry = entries[(*bucket)[candidate_]];
    ++candidate_;
    if (compareKeys(entry, keys_.leftColumns, probe_, keys_.rightColumns, comparisons) == 0)
    {
        out = entry;
        out.insert(out.end(), probe_.begin(), probe_.end());
        return true;
    }
}
```

### The Hybrid Fallback: Block Nested Loop on Partition Overflow
What happens if a single partition $R_i$ is *still* larger than the memory budget `tablePages`?

Instead of failing, the operator detects the condition (`leftPart.numPages() > tablePages`) and transparently toggles **Block Mode** (`blockMode_ = true`). It logs the partition to `overflowed_` for telemetry, loads as much of $R_i$ into memory as possible, and runs Block Nested Loop Join across $(R_i, S_i)$.

```cpp
blockMode_ = leftPart.numPages() > tablePages;
if (!blockMode_)
{
    // Standard Grace Hash: load partition into hash table
    entries_ = std::make_unique<BoundedTupleBuffer>(ctx().pool(), child(0).schema(), tablePages);
    // ... build hash table buckets ...
}
else
{
    // Overflow Handling: Switch to Block BNLJ mode for this partition
    overflowed_.push_back(part_);
    entries_ = std::make_unique<BoundedTupleBuffer>(ctx().pool(), child(0).schema(), share_.streamFrames - 2);
    buildReader_ = std::make_unique<RunReader>(ctx().engine(), leftPart, child(0).schema());
    fillBlock();
}
```

This hybrid approach guarantees that the engine **never crashes on skew or unexpected data volume**, maintaining system resilience.

---

## 3. Sort-Merge Join: The Dual-Stream Sorted Join with Memory Spilling

While Hash Joins excel at raw speed for equi-joins, **Sort-Merge Join (SMJ)** provides a major structural advantage: **it preserves output sort order**. If downstream operators require sorted data (e.g., `ORDER BY` or `GROUP BY`), SMJ eliminates the need for a subsequent sort step.

### Step 1: External Run Generation & Final Merging
In `doOpen()`, both child streams are sorted on their join keys using external multi-way merge sort (`sortToRuns`). The allocated memory frame budget `share_.streamFrames` is split between the left and right run mergers:

```cpp
const std::size_t readers = share_.streamFrames - kGroupPages; // Reserve 1 page for duplicate groups
const std::size_t rightReaders = readers / 2;
const std::size_t leftReaders = readers - rightReaders;

leftSorter_ = sortToRuns(ctx().engine(), child(0), ascendingKeys(...), share_, leftReaders + 1, comparisons);
rightSorter_ = sortToRuns(ctx().engine(), child(1), ascendingKeys(...), share_, rightReaders + 1, comparisons);

leftSorter_->startFinalMerge();
rightSorter_->startFinalMerge();
```

### Step 2: Key Alignment & Group Buffering
When merging two sorted streams, unique keys merge in $O(|R| + |S|)$ time. However, duplicate keys introduce a challenge. If $R$ has $m$ tuples with key $K$ and $S$ has $n$ tuples with key $K$, we must generate the Cartesian product $m \times n$.

To do this efficiently, when a matching key is encountered, all contiguous tuples from $S$ sharing that key are collected into a **Group Buffer** (`collectGroup()`).

```cpp
void SortMergeJoinOperator::collectGroup()
{
    groupKey_ = rightHead_;
    addToGroup(rightHead_);
    while (true)
    {
        hasRight_ = rightSorter_->next(rightHead_);
        if (!hasRight_ || compareKeys(rightHead_, keys_.rightColumns, groupKey_, keys_.rightColumns, comparisons) != 0)
            break;
        addToGroup(rightHead_);
    }
    if (groupWriter_)
    {
        groupRun_ = groupWriter_->finish();
        groupWriter_.reset();
    }
    rewindGroup();
}
```

### Step 3: Graceful Disk Spilling for Giant Duplicate Groups
What if a single duplicate key in $S$ contains millions of rows (e.g., joining on a non-unique foreign key like `country = 'USA'`)?

By default, the operator reserves just **1 page** (`kGroupPages = 1`) in RAM for the group buffer. If the group exceeds 1 page, `addToGroup()` hands the memory frame over to a `RunWriter` and spills the group to disk:

```cpp
void SortMergeJoinOperator::addToGroup(const Tuple& t)
{
    if (!groupWriter_ && group_.tryAdd(t))
        return; // Fits in memory frame
        
    if (!groupWriter_)
    {
        // Exceeded 1 page memory budget: transition group to disk run
        group_.giveFrameToOutput();
        groupWriter_ = std::make_unique<RunWriter>(ctx().engine(), child(1).schema());
        while (group_.size() > 0)
        {
            groupWriter_->append(group_.tuples().back());
            group_.popBack();
        }
    }
    groupWriter_->append(t);
}
```

When iterating through multiple matching left tuples, `rewindGroup()` simply resets the memory index or re-opens a `RunReader` over the spilled disk run (`groupRun_`).

---

## Performance & Feature Comparison Matrix

| Feature / Metric | Block Nested Loop Join (BNLJ) | Grace Hash Join | Sort-Merge Join (SMJ) |
| :--- | :--- | :--- | :--- |
| **Supported Predicates** | Any Predicate (`=`, `<`, `>`, `!=`) | Equi-joins only (`=`) | Equi-joins & range bounds |
| **Time Complexity** | $O(|R| \cdot |S|)$ comparisons | $O(\|R\| + \|S\|)$ average | $O(\|R\| \log \|R\| + \|S\| \log \|S\|)$ |
| **Disk I/O Complexity** | $M + \lceil M / (B-2) \rceil \cdot N$ | $3(M + N)$ | $2M(1 + \lceil \log_{B-1} \frac{M}{B} \rceil) + 2N(1 + \dots)$ |
| **Memory Overflow Strategy** | Fits fixed $B-2$ frame limit | Block BNLJ fallback per partition | Spills duplicate group run to disk |
| **Output Ordering** | Preserves Outer ($R$) order | Unordered (Hash bucket order) | Strictly sorted by Join Keys |

---

## Architectural Lessons & Takeaways

Building these three join operators from scratch provided key insights into database internals:

1. **State Machine Mechanics in Push/Pull Pipelines:** Implementing operators that yield single tuples via `doNext()` requires careful state preservation across function calls (e.g., maintaining index counters, carry tuples, and active disk readers).
2. **Deterministic Memory Budgets:** Relying on dynamic vector resizing without page constraints leads to memory instability under scale. Resource tracking via `FrameShare` enforces predictability.
3. **Graceful Fallbacks Over Hard Limits:** Real-world data is skewed. Designing algorithms with tiered fallbacks (Grace Hash $\rightarrow$ Block BNLJ; Memory Group $\rightarrow$ Disk Run Spilling) ensures reliability across unpredictable workloads.

Designing database execution engines from the ground up transforms abstract algorithms into concrete systems engineering. The result is a robust, memory-aware query execution engine built for scale.