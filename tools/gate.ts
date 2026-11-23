// Local stand-in for the sealed scorer's seven rows (grade-local does not run program/v1 kits):
//   node tools/gate.ts <out dir> <snapshot.json>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const [out = 'out', snapPath = '/input/snapshot.json'] = process.argv.slice(2);
const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const rows: [string, string | null][] = [];
const check = (name: string, fn: () => string | null) => { try { rows.push([name, fn()]); } catch (e) { rows.push([name, String(e)]); } };

function walk(dir: string, rel = ''): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p, join(rel, n)) : [join(rel, n)]; });
}
check('dashboard_files', () => {
  const d = join(out, 'dashboard'), files = walk(d);
  let bytes = 0, text = 0;
  for (const f of files) {
    const b = readFileSync(join(d, f)); bytes += b.length;
    if (!f.split('/').every((s) => NAME.test(s))) return `bad name ${f}`;
    const s = b.toString('utf8');
    if (/\.(html|css|js|mjs|json|svg|md|txt)$/.test(f)) text += b.length;
    if (f.endsWith('.html') && (/=\s*["']?\s*https?:\/\//i.test(s) || /<style[^>]*>[^<]*https?:\/\//i.test(s))) return `${f}: network address in markup`;
    if (f.endsWith('.css') && /https?:\/\//i.test(s)) return `${f}: network address in CSS`;
    if (/\.m?js$/.test(f) && /(import|from|require\(|import\()\s*["'`]https?:/i.test(s)) return `${f}: network import`;
  }
  if (!files.includes('index.html') || !files.some((f) => f.endsWith('.css')) || !files.some((f) => f.endsWith('.js'))) return 'need index.html, .css, .js';
  if (files.length > 400 || bytes > 4_194_304) return 'too big';
  const shown = JSON.parse(readFileSync(join(out, 'dossier.json'), 'utf8')).text as string;
  console.log(`  dashboard: ${files.length} files, ${bytes} bytes; dossier text ${Buffer.byteLength(shown)} of 65536 bytes`);
  return /\[Cut at \d+ bytes:/.test(shown) ? 'the dossier cuts the source: the judge would read part of it' : null;
});
const board = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
const r: any[] = Array.isArray(board) ? board : board.rows;
const known = new Set(snap.protocols.map((p: any) => p.slug));
check('board_file', () => {
  if (r.length < 100 || r.length > 4000) return `${r.length} rows`;
  const bad = r.filter((x) => !known.has(x.slug) || /\s/.test(x.slug) || !x.name || !Number.isInteger(x.rank) || x.rank < 1 || !Number.isInteger(x.implied_value_usd) || x.implied_value_usd < 1 || x.implied_value_usd > 1e14 || !Array.isArray(x.farm_steps));
  if (bad.length) return `bad rows: ${bad.slice(0, 3).map((x) => x.slug).join(', ')}`;
  if (new Set(r.map((x) => x.slug)).size !== r.length) return 'duplicate slug';
  return new Set(r.map((x) => x.implied_value_usd)).size < 2 ? 'all values equal' : null;
});
check('sorted_by_value', () => {
  const s = [...r].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < s.length; i++) { if (s[i].rank !== i + 1) return `rank ${i + 1} missing`; if (i && s[i].implied_value_usd > s[i - 1].implied_value_usd) return `value rises at rank ${i + 1}`; }
  return null;
});
check('coverage', () => { const have = new Set(r.map((x) => x.slug)); const miss = snap.watchlist.filter((w: string) => !have.has(w)); return miss.length ? `missing ${miss.join(', ')}` : null; });
check('farm_steps', () => { const bad = r.find((x) => x.farm_steps.length < 3 || x.farm_steps.length > 12 || x.farm_steps.some((t: string) => typeof t !== 'string' || t.trim().length < 20 || t.trim().length > 600)); return bad ? `row ${bad.slug}` : null; });

function dims(b: Buffer): [number, number] | null {
  if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length) { if (b[i] !== 0xff) return null; const m = b[i + 1]!, len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + len; }
  return null;
}
check('screenshots', () => {
  const d = join(out, 'screenshots'), fs = readdirSync(d).filter((n) => !n.startsWith('.'));
  if (fs.length < 3 || fs.length > 4) return `${fs.length} images`;
  for (const f of fs) {
    const b = readFileSync(join(d, f)), wh = dims(b);
    if (!NAME.test(f) || !/\.(png|jpe?g)$/i.test(extname(f) || '')) return `${f}: name`;
    if (!wh) return `${f}: not a PNG/JPEG`;
    const [w, h] = wh, long = Math.max(w, h), short = Math.min(w, h);
    console.log(`  ${f}: ${w}x${h}, ${b.length} bytes`);
    if (b.length > 524_288 || long > 1440 || short < 800) return `${f}: ${w}x${h} ${b.length} bytes`;
  }
  return null;
});
check('dossier_matches', () => {
  const want = buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
  const have = readFileSync(join(out, 'dossier.json'));
  console.log(`  dossier: ${have.length} bytes`);
  if (have.length > 1.5 * 1024 * 1024) return 'over 1.5 MiB';
  return Buffer.compare(Buffer.from(want), have) === 0 ? null : 'dossier differs from buildDossier';
});
for (const [n, e] of rows) console.log(`${e ? 'FAIL' : 'pass'}  ${n}${e ? `: ${e}` : ''}`);
process.exit(rows.some(([, e]) => e) ? 1 : 0);
