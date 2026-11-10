// Frame-time check for the promo site: node packages/site/demo-video/perf.mjs [url] [cpuThrottle]
// Scrolls to each section and reports fps, slow frames and where the main thread spends its time.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../ui/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const url = process.argv[2] ?? 'http://localhost:4173/';
const throttle = Number(process.argv[3] ?? 4);
const profiles = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25 },
  {
    name: 'phone',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
];

const browser = await chromium.launch({
  args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
});
for (const p of profiles) {
  const page = await browser.newPage(p);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const spots = await page.evaluate(() => {
    const t = document.getElementById('filmTrack');
    const top = t.getBoundingClientRect().top + scrollY;
    const span = t.offsetHeight - innerHeight;
    const tb = document.getElementById('tbTrack');
    return {
      hero: 0,
      scan: top + span * 0.1,
      tesseract: top + span * 0.95,
      features: document.getElementById('funkcje').offsetTop,
      tourbillon: tb.offsetTop + (tb.offsetHeight - innerHeight) * 0.4,
      demo: document.getElementById('demo').offsetTop,
    };
  });
  const metric = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    );
  console.log(`\n${p.name} ${p.viewport.width}x${p.viewport.height}, CPU ÷${throttle}`);
  for (const [name, y] of Object.entries(spots)) {
    await page.evaluate((v) => {
      document.documentElement.style.scrollBehavior = 'auto';
      scrollTo(0, v);
    }, y);
    await page.waitForTimeout(name === 'tesseract' ? 6000 : 1200);
    const m0 = await metric();
    const r = await page.evaluate(
      () =>
        new Promise((res) => {
          const d = [];
          let last = performance.now();
          const t0 = last;
          const f = (n) => {
            d.push(n - last);
            last = n;
            if (n - t0 < 3000) requestAnimationFrame(f);
            else {
              d.sort((a, b) => a - b);
              const avg = d.reduce((a, b) => a + b, 0) / d.length;
              res({
                fps: Math.round(1000 / avg),
                p95: Math.round(d[Math.floor(d.length * 0.95)]),
                slow: d.filter((x) => x > 25).length,
                n: d.length,
              });
            }
          };
          requestAnimationFrame(f);
        }),
    );
    const m1 = await metric();
    const per = (k) => Math.round(((m1[k] - m0[k]) / 3) * 1000); // ms of work per second
    console.log(
      `  ${name.padEnd(11)} ${String(r.fps).padStart(3)} fps  p95 ${String(r.p95).padStart(3)} ms  slow ${String(r.slow).padStart(3)}/${r.n}   script ${per('ScriptDuration')} ms/s  style ${per('RecalcStyleDuration')}  layout ${per('LayoutDuration')}  tasks ${per('TaskDuration')}`,
    );
  }
  await page.close();
}
await browser.close();
