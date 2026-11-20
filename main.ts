// Token Radar (make.fun token-radar-01). Node 22, standard library only, no network.
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>), prices every tokenless
// protocol with the comps model in lib/model.ts, ranks the candidates, attaches the farm plans of
// lib/farm.ts, and writes into /output (or $MAKEFUN_OUTPUT_DIR / --output):
//   board.json     the ranked rows the gate reads
//   data.js        the same board plus calibration, set-aside and comps, for the dashboard
//   dashboard/     the static page (copied)
//   screenshots/   the three captures (copied)
//   dossier.json   written last with the vendored buildDossier, as the scorer rebuilds it
// Output is a pure function of the snapshot: both runs write the same bytes.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/board.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

function fail(msg: string, code = 1): never {
  process.stderr.write(`token radar: ${msg}\n`);
  process.exit(code);
}

const input = flag('input', '/input');
const snapshotPath = input.endsWith('.json') ? input : join(input, 'snapshot.json');
if (!existsSync(snapshotPath)) fail(`no snapshot at ${snapshotPath}; pass --input <snapshot.json|dir>`, 2);
const out = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue) fail(`board would fail the gate: ${issue}`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ model: radar.model, as_of: radar.as_of, rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy the plain files of one directory, sorted, so the copy is the same every run. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  rmSync(to, { recursive: true, force: true }); // never leave a stale file for the dossier to pick up
  mkdirSync(to, { recursive: true });
  const names = readdirSync(from).filter((n) => !n.startsWith('.') && statSync(join(from, n)).isFile()).sort();
  for (const n of names) {
    if (!NAME.test(n)) fail(`${from}/${n}: names are letters, digits and . _ -`);
    copyFileSync(join(from, n), join(to, n));
  }
  return names;
}

const pages = copyDir(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyDir(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) fail(`screenshots/ holds ${shots.length} images; hand in 3 or 4`);

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const c = radar.counts;
process.stdout.write(`token radar ${radar.model}: ${c.protocols} protocols, ${c.live} with a token (${radar.calibration.comps} priced comps), ${c.tokenless} tokenless; board ${c.board} rows (watchlist ${c.watch} covered), ${c.set_aside} set aside as derivatives\n`);
process.stdout.write(`token radar: wrote board.json, data.js, dashboard/ (${pages.length} files), screenshots/ (${shots.length}) and dossier.json to ${out}\n`);
