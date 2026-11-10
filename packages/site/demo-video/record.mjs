// Records the promo site as a 1920x1080 video, scene by scene, on the timeline in timeline.json.
// Usage:  node record.mjs [url]        (default http://localhost:4180; start the site first)
// Output: ./out/screen.webm  and  ./out/offset.txt (seconds to trim from the start of the file)
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Playwright is installed in the UI package of this monorepo (pnpm install at the repo root).
const require = createRequire(join(here, '..', '..', 'ui', 'package.json'));
const { chromium } = require('@playwright/test');

const url = process.argv[2] ?? 'http://localhost:4180';
const tl = JSON.parse(readFileSync(join(here, 'timeline.json'), 'utf8'));
const at = Object.fromEntries(tl.scenes.map((s) => [s.name, s]));
const out = join(here, 'out');
const tmp = join(out, 'tmp');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: tmp, size: { width: 1920, height: 1080 } },
});
const page = await ctx.newPage();
const created = Date.now();
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500); // let the headline animation finish before the clock starts
const t0 = Date.now();
const offset = (t0 - created) / 1000;
const now = () => (Date.now() - t0) / 1000;
const until = (t) => page.waitForTimeout(Math.max(0, (t - now()) * 1000));
const topOf = (sel, extra = 0) =>
  page.evaluate(
    ([s, e]) => document.querySelector(s).getBoundingClientRect().top + scrollY + e,
    [sel, extra],
  );
// smooth scroll to y over `ms`
async function glide(y, ms = 1400) {
  await page.evaluate(
    ([to, d]) =>
      new Promise((res) => {
        const from = scrollY;
        const t = performance.now();
        const step = (n) => {
          const k = Math.min(1, (n - t) / d);
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          scrollTo(0, from + (to - from) * e);
          if (k < 1) requestAnimationFrame(step);
          else res();
        };
        requestAnimationFrame(step);
      }),
    [y, ms],
  );
}
const log = (s) => console.log(`${now().toFixed(1).padStart(6)}s  ${s}`);

// 1 hero
log('hero');
await until(at.stawka.from);

// 2 stakes
log('stawka');
await glide(await topOf('.stakes', -120));
await until(at.skan.from);

// 3 scan
log('skan');
const filmTop = await topOf('#filmTrack');
await glide(filmTop + 60, 1600);
await until(at.wniosek.from);

// 4 request / 5 breach / 6 documents: use the tabs so each scene is exact
for (const [name, tab] of [
  ['wniosek', 1],
  ['wyciek', 2],
  ['dokumenty', 3],
]) {
  log(name);
  await page.click(`#filmTabs button[data-i="${tab}"]`);
  const next = tl.scenes[at[name].id].from; // next scene start
  await until(next);
}

// 7 features
log('funkcje');
await glide(await topOf('.comp', 40), 1800);
await until(at.ruch.from);

// 8 tourbillon
log('ruch');
const tb = await topOf('#tbTrack');
await glide(tb + 500, 1800);
await until(at.karta.from);

// 9 card: fill the form, pay at the terminal
log('karta');
await glide(await topOf('.demo', 0), 1600);
await page.waitForTimeout(500);
await page.click('#f-name');
await page.keyboard.type('Anna Kowalska', { delay: 70 });
await page.click('#f-company');
await page.keyboard.type('Sklep Lniany', { delay: 70 });
await page.waitForTimeout(500);
await page.click('#nextBtn');
await page.click('#f-email');
await page.keyboard.type('anna@sklep-lniany.pl', { delay: 55 });
await page.waitForTimeout(400);
await page.click('#nextBtn');
await page.click('#sizeOpts .opt[data-v="2–5 osób"]');
await page.waitForTimeout(500);
await page.click('#nextBtn');
await page.click('.chipx:has-text("Wnioski osób")');
await page.click('.chipx:has-text("Wycieki")');
await page.waitForTimeout(500);
await page.click('#nextBtn');
await page.click('#f-consent');
await page.waitForTimeout(400);
await page.click('#demoSubmit');
log('platnosc (scena na pełnym ekranie)');
await page.waitForSelector('#theaterCta:not([hidden])', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('#theaterCta');
await until(at.slad.from);

// 10 data trail
log('slad');
await page.waitForSelector('#trailBtn:not([hidden])', { timeout: 10000 });
await page.waitForTimeout(1500);
await page.click('#trailBtn');
await page.waitForSelector('#trailRes:not([hidden])', { timeout: 15000 });
await until(at.finał.from);

// 11 outro
log('finał');
await glide(0, 2200);
await until(tl.length_seconds);

await ctx.close(); // flushes the video
await browser.close();
const file = readdirSync(tmp).find((f) => f.endsWith('.webm'));
renameSync(join(tmp, file), join(out, 'screen.webm'));
rmSync(tmp, { recursive: true, force: true });
writeFileSync(join(out, 'offset.txt'), `${offset.toFixed(2)}\n`);
console.log(
  `\nSaved out/screen.webm. Trim the first ${offset.toFixed(2)} s (page load) before editing.`,
);
