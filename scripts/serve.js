// Local preview: builds the site (drafts included), serves _site/ and rebuilds when files change.
// Usage: npm run dev   then open http://localhost:4000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DRAFTS = '1';
const { build } = await import('./build.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');
const PORT = Number(process.env.PORT) || 4000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.xml': 'application/xml', '.txt': 'text/plain', '.ico': 'image/x-icon',
};

function rebuild() {
  try { const r = build(); console.log(`[${new Date().toLocaleTimeString()}] Built ${r.pages} pages, ${r.posts} posts`); }
  catch (e) { console.error(`Build failed: ${e.message}`); }
}
rebuild();

http.createServer((req, res) => {
  try { handle(req, res); }
  catch (e) {
    // Usually a request that arrived mid-rebuild, while _site/ was being rewritten
    if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '1' });
    res.end('Rebuilding, refresh in a moment.');
  }
}).listen(PORT, () => console.log(`Preview at http://localhost:${PORT}  (Ctrl+C to stop)`));

function handle(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(OUT, p);
  if (!file.startsWith(OUT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    return res.end(fs.readFileSync(path.join(OUT, '404.html')));
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).on('error', () => res.end()).pipe(res);
}

let timer;
for (const dir of ['pages', 'posts', 'templates', 'assets']) {
  fs.watch(path.join(ROOT, dir), { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(rebuild, 150); });
}
fs.watch(path.join(ROOT, 'site.json'), () => { clearTimeout(timer); timer = setTimeout(rebuild, 150); });
