// Builds the publishable site into packages/site/dist: fills the templates from config.js and writes
// robots.txt and sitemap.xml. Upload dist/ as-is to any static host.
//
//   node packages/site/build.mjs           real build; stops when a REQUIRED config field is empty
//   node packages/site/build.mjs --draft   preview build; allows empty fields and blocks indexing
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, render, validate } from './render.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const draft = process.argv.includes('--draft');

const cfg = loadConfig(root);
const { errors, warnings } = validate(cfg);
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  for (const e of errors) console[draft ? 'warn' : 'error'](`${draft ? 'warning' : 'error'}: ${e}`);
  if (!draft) {
    console.error(
      '\nFill these in packages/site/config.js, or run with --draft for a preview build.',
    );
    process.exit(1);
  }
}

const pages = ['index.html', 'polityka-prywatnosci.html'];
const assets = [
  'style.css',
  'main.js',
  'config.js',
  'fonts',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'og.png',
  'site.webmanifest',
];
if (cfg.founder?.photo) assets.push(cfg.founder.photo);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Cache busting: assets keep their names but pages ask for `name?v=<content hash>`, so a new deploy is
// picked up at once even by browsers that still hold the previous file in their cache.
const versioned = ['style.css', 'main.js', 'config.js', 'fonts/fonts.css'];
const hash = (f) =>
  createHash('sha256')
    .update(readFileSync(join(root, f)))
    .digest('hex')
    .slice(0, 10);
const bust = (html) =>
  versioned.reduce(
    (h, f) =>
      h.replace(
        new RegExp(`((?:href|src)=")${f.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`, 'g'),
        `$1${f}?v=${hash(f)}"`,
      ),
    html,
  );
for (const page of pages)
  writeFileSync(join(out, page), bust(render(readFileSync(join(root, page), 'utf8'), cfg)));
for (const a of assets) {
  if (!existsSync(join(root, a))) {
    console.error(`error: missing ${a}`);
    process.exit(1);
  }
  mkdirSync(dirname(join(out, a)), { recursive: true });
  cpSync(join(root, a), join(out, a), { recursive: true });
}

const base = cfg.siteUrl ?? '';
writeFileSync(
  join(out, 'robots.txt'),
  draft
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`,
);
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><lastmod>${today}</lastmod></url>
  <url><loc>${base}/polityka-prywatnosci.html</loc><lastmod>${cfg.privacy?.updated ?? today}</lastmod></url>
</urlset>
`,
);
if (draft) {
  // belt and braces: a draft must never be indexed even if robots.txt is ignored
  for (const page of pages) {
    const p = join(out, page);
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace(
        '<head>',
        '<head>\n    <meta name="robots" content="noindex" />',
      ),
    );
  }
}
console.log(`Built ${draft ? 'DRAFT ' : ''}site in ${out}`);
