# amiras-rabari.github.io

My portfolio and blog. Plain HTML, CSS and JavaScript, built by a small Node script and deployed to GitHub Pages.

## Layout

| Path | What it is |
|---|---|
| `pages/` | One HTML file per page |
| `posts/` | Blog posts in Markdown |
| `templates/layout.html` | Shared head, header and footer |
| `assets/` | CSS, JS, images and my resume |
| `site.json` | Site settings, links and the chip floorplan on the home page |
| `scripts/build.js` | Builds everything into `_site/` |
| `.github/workflows/deploy.yml` | Builds and deploys on every push to `main` |

## How I publish posts

I write each post as a Markdown file in `posts/`, named `YYYY-MM-DD-short-title.md`, with a short header:

```markdown
---
title: Post title
date: 2026-11-08
summary: One sentence for the blog list and link previews.
---
```

When I push to `main`, GitHub Actions turns every post into its own static HTML page at `/blog/short-title/` and deploys the site.
