# amiras-rabari.github.io

Portfolio and blog of Amiras Rabari. Plain HTML, CSS and JavaScript, built by a small Node script and deployed to GitHub Pages.

## Preview locally

```
npm install      # first time only
npm run dev      # http://localhost:4000, rebuilds when you save
```

## Write a blog post

1. Create `posts/YYYY-MM-DD-short-title.md`:
   ```markdown
   ---
   title: My post title
   date: 2026-11-08
   tags: [systems, c]
   summary: One sentence for the blog list and link previews.
   draft: true        # optional: only shows in local preview
   cover: /assets/img/blog/my-image.png   # optional preview image
   ---
   Post content in Markdown...
   ```
2. Preview with `npm run dev`.
3. Remove `draft: true`, then commit and push. GitHub Actions builds and deploys in about a minute.

Post numbers (AN-001, AN-002…) follow publish date order. The URL is `/blog/<file name without the date>/`.

## Layout

| Path | What it is |
|---|---|
| `pages/` | One HTML file per page, with a small header (title, path, nav) |
| `posts/` | Blog posts in Markdown |
| `templates/layout.html` | Shared head, header and footer |
| `assets/` | CSS, JS, images, resume PDF |
| `site.json` | Site URL, links, analytics and the chip pinout skills |
| `scripts/build.js` | Builds everything into `_site/` |
| `.github/workflows/deploy.yml` | Builds and deploys on every push to `main` |
