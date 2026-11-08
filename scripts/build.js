// Builds the static site into _site/.
//   pages/*.html  -> wrapped in templates/layout.html
//   posts/*.md    -> /blog/<slug>/index.html, plus the blog index, RSS feed and sitemap
//   assets/       -> copied as-is
// Usage: node scripts/build.js            (production: drafts skipped)
//        DRAFTS=1 node scripts/build.js   (include posts marked draft: true)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');
const SHOW_DRAFTS = process.env.DRAFTS === '1';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => { const [y, m, day] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${day}, ${y}`; };
const fmtMonth = (d) => { const [y, m] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };

export function build() {
  const site = JSON.parse(read('site.json'));
  const layout = read('templates/layout.html');
  const buildId = Date.now().toString(36);

  // ---------- Front matter ----------
  function parseFrontMatter(text, file) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) throw new Error(`${file}: missing front matter (--- block at the top)`);
    const data = {};
    for (const line of m[1].split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const i = line.indexOf(':');
      if (i === -1) throw new Error(`${file}: bad front matter line "${line}"`);
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if (/^\[.*\]$/.test(val)) val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      else if (val === 'true' || val === 'false') val = val === 'true';
      else val = val.replace(/^["']|["']$/g, '');
      data[key] = val;
    }
    return { data, body: m[2] };
  }

  // ---------- Page rendering ----------
  function render({ title, description, urlPath, nav, content, ogType = 'website', ogImage, noindex = false, fullTitle = false }) {
    const pageTitle = fullTitle ? title : `${title} | ${site.name}`;
    const vars = {
      page_title: esc(pageTitle),
      og_title: esc(title),
      description: esc(description || site.description),
      canonical: site.url + urlPath,
      og_type: ogType,
      og_image: site.url + (ogImage || site.ogImage),
      site_name: esc(site.name),
      extra_head: noindex ? '<meta name="robots" content="noindex">' : '',
      email: esc(site.email),
      linkedin: site.linkedin,
      github: site.github,
      resume: site.resume,
      goatcounter: site.goatcounter,
      build_id: buildId,
      content,
    };
    return layout
      .replace(/\{\{active:(\w+)\}\}/g, (_, k) => (k === nav ? ' aria-current="page"' : ''))
      .replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? vars[k] : all));
  }

  function writeOut(urlPath, html) {
    const rel = urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath;
    const file = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
  }

  // ---------- Die floorplan (HTML, rendered at build time so it shows without JavaScript) ----------
  function dieHtml() {
    const blocks = site.die.map((b) => `
        <button type="button" class="blk blk-${esc(b.id)}${b.status ? ' wip' : ''}" data-label="${esc(b.label)}" data-name="${esc(b.name)}" data-use="${esc(b.use)}" aria-label="${esc(b.label)}, ${esc(b.name)}: ${esc(b.skills.join(', '))}">
          <span class="blk-label">${esc(b.label)}${b.status ? ` <em>${esc(b.status)}</em>` : ''}</span>
          <span class="blk-name">${esc(b.name)}</span>
          <span class="blk-skills">${b.skills.map((k) => `<span>${esc(k)}</span>`).join('')}</span>
        </button>`).join('');
    return `<div class="die">
      <div class="die-mark"><span>AR-2026</span><span>BCS HONS, AI/ML</span><span>Ottawa, CA</span></div>
      <div class="die-grid">${blocks}
      </div>
    </div>`;
  }

  // ---------- Posts ----------
  const marked = new Marked(
    markedHighlight({
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language }).value;
      },
    })
  );
  // Wrap tables so they scroll sideways on phones instead of widening the page
  const toHtml = (md) => marked.parse(md)
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, '</table></div>');

  const postsDir = path.join(ROOT, 'posts');
  const posts = fs.readdirSync(postsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const { data, body } = parseFrontMatter(fs.readFileSync(path.join(postsDir, f), 'utf8'), `posts/${f}`);
      for (const req of ['title', 'date', 'summary']) if (!data[req]) throw new Error(`posts/${f}: missing "${req}" in the header`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error(`posts/${f}: date must look like 2026-11-08`);
      const slug = data.slug || f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
      const words = body.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
      return {
        ...data,
        tags: Array.isArray(data.tags) ? data.tags.map((t) => t.toLowerCase()) : data.tags ? [String(data.tags).toLowerCase()] : [],
        slug,
        url: `/blog/${slug}/`,
        minutes: Math.max(1, Math.round(words / 220)),
        html: toHtml(body),
        draft: data.draft === true,
      };
    })
    .filter((p) => SHOW_DRAFTS || !p.draft)
    .sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug));

  posts.forEach((p, i) => { p.an = 'AN-' + String(i + 1).padStart(3, '0'); });
  const newestFirst = [...posts].reverse();

  const postItem = (p) => `
      <li data-tags="${esc(p.tags.join(' '))}"><a href="${p.url}"><span class="an">${p.an}</span><span>
        <span class="t">${esc(p.title)}${p.draft ? ' (draft)' : ''}</span>
        <span class="s">${esc(p.summary)}</span>
        <span class="meta"><span>${fmtMonth(p.date)}</span><span>${p.minutes} min read</span>${p.tags.length ? `<span>${esc(p.tags.join(', '))}</span>` : ''}</span>
      </span></a></li>`;
  const postList = (list) => list.length
    ? `<ul class="appnotes">${list.map(postItem).join('')}\n    </ul>`
    : `<p class="empty">No posts yet. The first application note is on its way.</p>`;

  // ---------- Write everything ----------
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(path.join(ROOT, 'assets'), path.join(OUT, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  if (fs.existsSync(path.join(ROOT, 'CNAME'))) fs.copyFileSync(path.join(ROOT, 'CNAME'), path.join(OUT, 'CNAME'));

  const sitemap = [];

  // Pages
  const tokens = { die: dieHtml(), latest_posts: postList(newestFirst.slice(0, 3)) };
  for (const f of fs.readdirSync(path.join(ROOT, 'pages')).filter((f) => f.endsWith('.html'))) {
    const { data, body } = parseFrontMatter(read(`pages/${f}`), `pages/${f}`);
    const content = body.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in tokens ? tokens[k] : all));
    writeOut(data.path, render({
      title: data.title, description: data.description, urlPath: data.path, nav: data.nav,
      content, noindex: data.noindex === true, fullTitle: data.path === '/',
    }));
    if (data.noindex !== true) sitemap.push(data.path);
  }

  // Blog index
  const allTags = [...new Set(posts.flatMap((p) => p.tags))].sort();
  const filters = allTags.length > 1
    ? `<div class="filters" role="group" aria-label="Filter posts by tag"><button type="button" data-tag="all" aria-pressed="true">All</button>${allTags.map((t) => `<button type="button" data-tag="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('')}</div>`
    : '';
  writeOut('/blog/', render({
    title: 'Blog', urlPath: '/blog/', nav: 'blog',
    description: `Application notes by ${site.name}: write-ups of things I've built, fixed and learned.`,
    content: `<div class="wrap">
  <header class="page-head">
    <h1>Application notes</h1>
    <p class="lede">Write-ups of things I've built, fixed and learned. Numbered in the order they were published.</p>
  </header>
  <section style="padding-bottom: clamp(3rem, 7vw, 5rem)">
    ${filters}
    ${postList(newestFirst)}
  </section>
</div>`,
  }));
  sitemap.push('/blog/');

  // Post pages
  posts.forEach((p, i) => {
    const prev = posts[i - 1], next = posts[i + 1];
    const tagLinks = p.tags.map((t) => `<a class="tag" href="/blog/#${esc(t)}">${esc(t)}</a>`).join(' ');
    const content = `<div class="wrap">
  <article class="post">
    <a class="post-back" href="/blog/">All application notes</a>
    <header class="post-head">
      <p class="an">${p.an}</p>
      <h1>${esc(p.title)}</h1>
      <p class="summary">${esc(p.summary)}</p>
      <div class="post-meta"><time datetime="${p.date}">${fmtDate(p.date)}</time><span>${p.minutes} min read</span>${tagLinks ? `<span>${tagLinks}</span>` : ''}</div>
    </header>
    <div class="prose">
${p.html}
    </div>
    ${prev || next ? `<nav class="post-nav" aria-label="More posts">
      ${prev ? `<a class="prev" href="${prev.url}"><span class="k">Previous, ${prev.an}</span><span class="t">${esc(prev.title)}</span></a>` : ''}
      ${next ? `<a class="next" href="${next.url}"><span class="k">Next, ${next.an}</span><span class="t">${esc(next.title)}</span></a>` : ''}
    </nav>` : ''}
  </article>
</div>`;
    writeOut(p.url, render({
      title: p.title, description: p.summary, urlPath: p.url, nav: 'blog', content,
      ogType: 'article', ogImage: p.cover, noindex: p.draft,
    }));
    if (!p.draft) sitemap.push(p.url);
  });

  // RSS feed
  const rssItems = newestFirst.filter((p) => !p.draft).slice(0, 20).map((p) => `
    <item>
      <title>${esc(p.title)}</title>
      <link>${site.url}${p.url}</link>
      <guid>${site.url}${p.url}</guid>
      <pubDate>${new Date(p.date + 'T12:00:00Z').toUTCString()}</pubDate>
      <description>${esc(p.summary)}</description>
    </item>`).join('');
  fs.writeFileSync(path.join(OUT, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(site.name)}: application notes</title>
    <link>${site.url}/blog/</link>
    <description>${esc(site.description)}</description>
    <language>en-ca</language>${rssItems}
  </channel>
</rss>
`);

  // Sitemap and robots
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap.map((u) => `  <url><loc>${site.url}${u}</loc></url>`).join('\n')}
</urlset>
`);
  fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`);

  return { posts: posts.length, pages: sitemap.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = Date.now();
  const r = build();
  console.log(`Built ${r.pages} pages (${r.posts} posts) into _site/ in ${Date.now() - t} ms`);
}
