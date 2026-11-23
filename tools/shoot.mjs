// Capture the three dossier screenshots from the built dashboard (run main.ts into out/ first).
//   PLAYWRIGHT=<path to the playwright package> node tools/shoot.mjs [out]
// Each shot is a 1440x900 JPEG whose quality is searched so the file lands in 300-350 KB, the band the
// rules ask for (three images under the dossier cap, each well inside the gate's 512 KiB).
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');
const out = resolve(process.argv[2] ?? 'out');
const page0 = pathToFileURL(join(out, 'dashboard', 'index.html')).href;
const dest = resolve('screenshots');

// The detail view is captured tall (1280x1440: long side 1440, short side over 800) so the value
// build-up and the whole farm plan show in one image.
const SHOTS = [
  ['1-board.jpg', '#/board', 1440, 900],
  ['2-detail.jpg', '#/board?sel=__farm', 1280, 1440], // the best-ranked row whose costed plan says farm
  ['3-filtered.jpg', '#/board?cls=early&v=ok&sort=net&dir=desc&sel=__first', 1440, 900],
];
const LO = 300_000, HI = 350_000;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const f of readdirSync(dest)) if (/\.(png|jpe?g)$/i.test(f)) rmSync(join(dest, f));
mkdirSync(dest, { recursive: true });

for (const [name, hash, w, h] of SHOTS) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(page0 + hash.replace(/[?&]sel=__\w+/, ''));
  await page.waitForSelector('body[data-checked]'); // the in-browser recompute has finished
  if (hash.includes('__first')) await page.click('tbody tr[data-slug]');
  if (hash.includes('__farm')) await page.click(`tr[data-slug="${await page.evaluate(() => window.RADAR.rows.find((r) => r.plan.verdict === 'farm' && Math.abs(r.change_7d) >= 10).slug)}"]`);
  await page.waitForTimeout(150);
  await page.evaluate(() => scrollTo(0, 0)); // keep the header and integrity strip in frame
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
