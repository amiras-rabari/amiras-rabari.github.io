---
title: How this site publishes its posts
date: 2026-11-08
tags: [web, tooling]
summary: Markdown in, static HTML out. A small Node script and a GitHub Action turn each post into its own page.
---

This site has no framework and no server. Every page is a plain HTML file served by GitHub Pages. The blog works the same way, with one extra step before deploy.

## The pipeline

1. I write a post as a Markdown file in the `posts/` folder.
2. I push it to GitHub.
3. A GitHub Action runs a small Node script that turns every post into a full HTML page.
4. The Action deploys the result to GitHub Pages.

The script is about 300 lines. It reads each post's header, converts the Markdown, highlights code blocks, and writes the blog index, an RSS feed and a sitemap.

## Why build the pages ahead of time

A post could also be rendered in the browser with JavaScript. That works for people, but not for the bots that read pages without running scripts. LinkedIn's link preview is one of them. With pre-built pages, every post has its own title, summary and preview image in plain HTML.

## What a post looks like

Each file starts with a short header:

```yaml
---
title: How this site publishes its posts
date: 2026-11-08
tags: [web, tooling]
summary: One sentence that shows up in previews.
---
```

Everything after the header is regular Markdown, including code:

```c
int main(void) {
    puts("hello from the blog");
    return 0;
}
```

| Step | Where it runs | Time |
|---|---|---|
| Write the post | My laptop | As long as it takes |
| Build the pages | GitHub Actions | A few seconds |
| Deploy | GitHub Pages | About a minute |
