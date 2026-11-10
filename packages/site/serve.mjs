// Tiny static server for previewing the promo site: node packages/site/serve.mjs [port]
// HTML pages are filled from config.js on every request, the same way build.mjs does it.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, render } from './render.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? process.argv[2] ?? 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  let file = join(root, path === '/' || path === '\\' ? 'index.html' : path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory())
    file = join(root, 'index.html');
  const type = types[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  if (extname(file) === '.html') return res.end(render(readFileSync(file, 'utf8'), loadConfig(root)));
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Promo site: http://127.0.0.1:${port}`));
