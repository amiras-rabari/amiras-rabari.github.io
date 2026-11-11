---
title: "Joining Tables With Almost No Memory"
date: 2026-10-15
summary: How I built three join algorithms for my own C++ database engine (nested loop, sort-merge and hash join) that work inside a hard limit of a few memory pages.
---

I'm building a small relational database from scratch in C++: it stores tables on disk, reads them through its own cache, and runs queries. One of the most interesting parts to build was the **join**, the operation that matches rows from two tables.

```sql
SELECT * FROM Students S JOIN Enrollments E ON S.id = E.student_id;
```

The idea is simple: find every pair of rows where the keys match. Doing it fast, on tables much bigger than the memory you have, is the hard part. This post explains the problem and the three ways I solved it.

## The real bottleneck: disk, not CPU

A database stores tables on disk in fixed-size blocks called **pages** (4 KB each in my engine). To look at a row, its page has to be loaded into memory first. Memory is split into a few page-sized slots, and the engine can only hold that many pages at once.

Two facts shape everything that follows:

1. **Reading a page from disk is much slower than comparing rows in memory.** So the main cost of a join is how many pages it reads and writes.
2. **Memory is limited.** In my engine, a query gets a fixed number of page slots, and tests run with as few as **4**. That's 16 KB for the entire query, while the tables can be hundreds of pages.

I made the limit strict. Every row the join keeps in memory, even in a plain C++ list, has to be counted against the budget. If a join tries to take a fifth page when it only has four, the engine stops with an error instead of quietly using more memory. That rule is what makes these algorithms interesting.

So the question becomes: **how do you match rows from two large tables while holding only a few pages at a time, and reading as few pages as possible?**

Throughout, I'll call the two tables **R** (M pages) and **S** (N pages).

---

## 1. Nested loop join: compare everything, but in batches

### The naive version

The obvious approach: for every row of R, scan all of S and check each pair.

```text
for each row r in R:
    for each row s in S:
        if r matches s: output (r, s)
```

It's correct, and it works with any condition, not only `=` but also `<`, `>=`, and so on. The trouble is disk reads: S gets read from disk **once per row of R**. With 10,000 rows in R, that's 10,000 full reads of S.

### The fix: load R in blocks

Instead of one row of R at a time, fill all the free memory with a **block** of R's pages. Then read S **once** for the whole block and check every row of S against every row in the block.

```text
memory with 4 page slots
┌──────────┬──────────┬──────────┬──────────┐
│ R block  │ R block  │ S page   │ R page   │
│ page 1   │ page 2   │ (stream) │ (reading)│
└──────────┴──────────┴──────────┴──────────┘
```

Now S is read once per block instead of once per row. With 2 pages per block, a 60-page R means 30 reads of S instead of thousands. With more memory, blocks get bigger and S is read fewer times. If all of R fits in one block, each table is read exactly once, and no join can do better than that.

What doesn't change is the number of comparisons. Every pair is still checked, because you can't know a pair doesn't match without checking it. Blocking cuts disk reads, not CPU work.

**What I had to solve:** a database runs a query as a chain of operators that hand rows to each other one at a time, so the join can't run its loops start to finish. It has to return one matching row, pause, and resume exactly where it stopped. I store "which block, which S row, which position in the block" in the operator, so each call continues the loop from where it left off.

**Best for:** small tables, plenty of memory, or conditions that aren't equality.

---

## 2. Sort-merge join: sort first, then walk once

### The idea

If both tables are **sorted by the join key**, matching becomes a walk with two fingers, one in each table:

```text
R: 1  2  2  3          S: 2  2  4
   ↑                      ↑
```

- If R's key is smaller, move R's finger forward.
- If S's key is smaller, move S's finger forward.
- If they're equal, you found matches.

Each table is read once, from top to bottom. No "compare everything."

### Sorting data bigger than memory

You can't sort a 200-page table in 4 pages of memory in one go. So the engine uses **external merge sort**:

1. Read the table a few pages at a time, sort each chunk in memory, and write it back to disk as a sorted **run**.
2. Merge runs together, a few at a time, into longer sorted runs, until one sorted stream remains.

The final merge doesn't get written to disk. Its rows go straight into the join, which saves a full write and read of each table.

### The tricky case: duplicate keys

This is where sort-merge usually goes wrong. Take the example above: R has two 2s and S has two 2s. The correct answer is **4 rows**, because every 2 in R pairs with every 2 in S.

A buggy version matches the first R row with S's 2s, moves past them, and then has nothing left for the second R row: it returns 2 rows instead of 4. The fix is to **rewind**: after the first R row, go back to the start of S's group of 2s and replay it for the next R row with the same key.

```text
R=2  pairs with S's group [2, 2]   → 2 rows
R=2  same key → rewind the group   → 2 rows
R=3  new key → group is done       → total 4 ✓
```

Rewinding raises a problem of its own. Since S comes straight out of the sort as a stream, there's no going back. So the join **saves the current group of equal keys** in one page of memory and rewinds over that copy.

But what if a single key appears thousands of times, more than a page can hold? Then the join moves the group to a **temporary file on disk** and replays it from there. It reuses the same memory page to write the file, so memory use never goes above the limit. I tested this with 1,200 rows on each side all sharing one key (1.44 million output rows) using just 4 pages of memory.

**Best for:** medium-sized inputs, or data that's already sorted.

---

## 3. Hash join: split the problem into pieces that fit

### Why a hash map helps

For an equality join, a hash map is the natural tool: put every row of R into a hash map keyed by the join value, then for each row of S, look up its key. Each lookup only checks the few rows with the same key, not all of R.

The catch: the hash map has to fit in memory, and R usually doesn't.

### The fix: partition first (Grace hash join)

The trick is to use hashing **twice**.

**Step 1: Partition.** Pick a number of buckets, P. Read R and send each row to bucket `hash(key) mod P`, written to its own file on disk. Do the same with S **using the same hash function**.

```text
            hash(key) mod 3
  R ───────┬─────────┬─────────┐
           ▼         ▼         ▼
          R0        R1        R2
          S0        S1        S2
```

The key point: **rows with the same key always land in the same bucket number.** A row in R1 can only match rows in S1. One big join has become P small, independent joins.

**Step 2: Build and probe.** For each bucket pair, load R's bucket into an in-memory hash map, stream S's bucket past it, look up each row, and output the matches. Then throw the hash map away and move to the next bucket.

The cost: each table is read once, written once (into buckets), and read once more, so about **3 × (M + N)** pages, whatever the table sizes. That's why hash join is the usual choice for big equality joins.

### Two things I had to get right

**My own hash function.** C++'s built-in `std::hash` can return different values on different compilers and machines. In my engine, the same query must report the same page counts every time on every machine, so bucket sizes can't change between machines. I wrote a hash over the exact bytes of the key (FNV-1a with a final bit-mixing step), with two different seeds: one to pick the bucket, one for the in-memory hash map. Using the same hash for both would push all of a bucket's rows into the same few hash map slots.

**What if a bucket is still too big?** Partitioning assumes each bucket of R fits in memory. With skewed data it may not. If one value makes up 40% of the table, **every copy of it lands in the same bucket**, whatever hash function you use, because equal keys always hash the same. So re-hashing can't split that bucket.

My solution: after partitioning, I already know each bucket's size. **Before** building a hash map, the join checks whether the bucket fits. If it doesn't, the join uses the block nested loop from section 1 on just that one bucket pair. The other buckets still use fast hash lookups, and memory is never exceeded.

**Best for:** large tables joined on equality.

---

## So which one wins?

I measured all three on the same two tables (60 and 30 pages), giving them more and more memory. These are total pages read and written:

| Memory (pages) | Nested loop | Sort-merge | Hash |
|---:|---:|---:|---:|
| 4 | 991 | 783 | **590** |
| 8 | 371 | 424 | **323** |
| 16 | **216** | 244 | 308 |
| 64 | **92** | 243 | 370 |

- **With very little memory, hash join wins.** Nested loop has to re-read S over and over, and sort-merge needs extra sorting passes.
- **With more memory, nested loop wins.** Once most of R fits in one block, S is read only a few times.
- **The surprise: hash join got *worse* with more memory.** More memory means more buckets, and every bucket's last page is usually only partly full. With small tables and many buckets, most of those pages are nearly empty but still have to be written and read. The textbook "3 × (M + N)" assumes full pages, which only holds when the tables are much bigger than the number of buckets.

That last result changed how I think about cost formulas. They're a starting point, and measuring is how you find out what they leave out.

---

## How I checked it's correct

- **All three joins must return exactly the same rows** for the same input, including duplicate keys, empty tables, and joins whose output is larger than either input.
- **The memory limit is checked by the engine itself.** It tracks the most pages ever held at once, and every query, including multi-join plans, runs with just 4.
- **Nothing is left behind.** After a query finishes, the engine checks that no page is still held and no temporary file still exists.
- **Tests that can fail.** For each test, I deliberately broke the code (for example, made sort-merge skip the rewind), confirmed the test caught it, and then restored the code.

## Takeaways

- **Nested loop** is simple and works for any condition. Reading the outer table in blocks turns "read S once per row" into "read S once per block."
- **Sort-merge** pays to sort once, then matches in one pass. The hard part is duplicate keys, solved by rewinding over a saved group that can spill to disk.
- **Hash join** splits one join too big for memory into many small ones that fit. The hard part is skew, solved by checking bucket sizes first and falling back to nested loop when a bucket is too big.

All three answer the same question: *how do you avoid comparing everything with everything, without running out of memory?* Each one gives a different answer, and which is best depends on how much memory you have and how big your tables are.

*Built in C++20, with no external database libraries. Every page goes through the engine's own buffer pool, and every number above comes from real runs.*
