// Capture the three dossier screenshots from the built dashboard (run main.ts into out/ first).
//   PLAYWRIGHT=<path to the playwright package> node tools/shoot.mjs [out]
// Each shot is a JPEG whose quality is searched so the file lands in 210-250 KB: four images in base64
// plus the source text must stay under the dossier's 1.5 MiB.
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');
const out = resolve(process.argv[2] ?? 'out');
const page0 = pathToFileURL(join(out, 'dashboard', 'index.html')).href;
const dest = resolve('screenshots');

// The detail shot sorts by net so its selected row (the best net plan, farm or not) is the first, visible
// with its Farm plan column; the filtered shot is another chain and a longer horizon; the last is the model.
const SHOTS = [
  ['1-board.jpg', '#/board', 1280, 1280], // the cover: KPIs, self-checks, both term tests, ledger, best plans, one written out
  ['2-detail.jpg', '#/board?sort=net&dir=desc&sel=__best', 1440, 1200],
  ['3-filtered.jpg', '#/board?chain=Solana&hz=180&sort=expected_value_usd&dir=desc', 1440, 900],
  ['4-model.jpg', '#/model', 1440, 1100],
];
const LO = 210_000, HI = 250_000;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const f of readdirSync(dest)) if (/\.(png|jpe?g)$/i.test(f)) rmSync(join(dest, f));
mkdirSync(dest, { recursive: true });

for (const [name, hash, w, h] of SHOTS) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(page0 + hash.replace(/[?&]sel=__\w+/, ''));
  await page.waitForSelector('body[data-checked]'); // the in-browser recompute has finished
  if (hash.includes('__best')) await page.click('.tbl tbody tr[data-slug]'); // sorted by net, so the first row is the best plan
  await page.waitForTimeout(150);
  await page.evaluate(() => scrollTo(0, 0)); // keep the header and self-check strip in frame
  let lo = 40, hi = 100, best = null;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    const buf = await page.screenshot({ type: 'jpeg', quality: q });
    if (buf.length > HI) hi = q - 1;
    else { best = { q, buf }; if (buf.length >= LO) break; lo = q + 1; }
  }
  if (!best) best = { q: 40, buf: await page.screenshot({ type: 'jpeg', quality: 40 }) };
  writeFileSync(join(dest, name), best.buf);
  console.log(`${name}: quality ${best.q}, ${best.buf.length} bytes${best.buf.length < LO ? ' (below 300 KB even at the top quality that fits)' : ''}`);
}
await browser.close();
