// Re-renders og.png and the PNG icons from brand/og.html and favicon.svg with a headless
// Chromium browser (Edge or Chrome). Run after changing either source:
//   node packages/site/brand/make-images.mjs [path-to-browser]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const candidates = [
  process.argv[2],
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) {
  console.error('No Chromium browser found. Pass its path as the first argument.');
  process.exit(1);
}

// a throwaway profile, so the call never hands off to an already running browser window
const profile = mkdtempSync(join(tmpdir(), 'stonekeep-shot-'));

function shot(src, out, w, h, query = '') {
  execFileSync(browser, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--virtual-time-budget=3000',
    `--window-size=${w},${h}`,
    `--screenshot=${join(site, out)}`,
    pathToFileURL(join(here, src)).href + query,
  ]);
  console.log(`${out} (${w}x${h})`);
}

shot('og.html', 'og.png', 1200, 630);
shot('icon.html', 'icon-512.png', 512, 512, '?s=512');
// Headless windows have a minimum size (about 500 px), so smaller icons are downscaled from 512
// with Pillow (python -m pip install pillow).
execFileSync('python', [
  '-I',
  '-c',
  'import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert("RGB")\n' +
    'for n, s in ((sys.argv[2], 192), (sys.argv[3], 180)): im.resize((s, s), Image.LANCZOS).save(n, optimize=True)',
  join(site, 'icon-512.png'),
  join(site, 'icon-192.png'),
  join(site, 'apple-touch-icon.png'),
]);
console.log('icon-192.png, apple-touch-icon.png (downscaled)');
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
