// Token Radar (make.fun token-radar-01). Node 22, standard library only, no network.
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>) and runs dashboard/engine.js,
// the one file that fits the value model, tests it held out, prices every tokenless protocol, fits the
// token odds and costs each farm plan. The page loads the same file and re-derives the board, so the
// judge reads the model in the dossier. Writes into /output (or $MAKEFUN_OUTPUT_DIR / --output):
//   board.json     the ranked rows the gate reads
//   data.js        the snapshot and the engine's full result (tests, fit, set-aside, comps), for the page
//   dashboard/     the static page (copied)
//   screenshots/   the three captures (copied)
//   dossier.json   written last with the vendored buildDossier, as the scorer rebuilds it
// Output is a pure function of the snapshot: both runs write the same bytes.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { boardIssue, parseSnapshot, type BoardRow } from './lib/check.ts';
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

const snapshotText = readFileSync(snapshotPath, 'utf8');
const snapshot = parseSnapshot(snapshotText);
const sandbox: { RadarEngine?: { build: (s: unknown) => any } } = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(here, 'dashboard', 'engine.js'), 'utf8'), sandbox, { filename: 'engine.js' });
const radar = sandbox.RadarEngine!.build(JSON.parse(snapshotText));
const board: BoardRow[] = radar.rows.map(({ plan, ...r }: { plan: any } & BoardRow) => ({ ...r, farm: { ticket_usd: plan.ticket, ...plan.costs, reward_if_launch_usd: plan.reward, expected_usd: plan.expected, breakeven_odds: plan.breakeven_odds, lockup_days: plan.lockup_days, risk: plan.risk, verdict: plan.verdict } }));
const issue = boardIssue(board, snapshot);
if (issue) fail(`board would fail the gate: ${issue}`);

mkdirSync(out, { recursive: true });
const boardText = `${JSON.stringify({ model: radar.model, as_of: radar.as_of, rows: board })}\n`;
writeFileSync(join(out, 'board.json'), boardText);
// The page shows these as self-checks: the program that wrote this output, and the board it wrote.
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const page = { ...radar, main_sha256: sha(readFileSync(join(here, 'main.ts'))), board_sha256: sha(boardText), rows: radar.rows.map(({ farm_steps, ...r }: { farm_steps: string[] }) => r) };
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(page)};\nwindow.SNAPSHOT=${JSON.stringify(JSON.parse(snapshotText))};\n`);

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
const t = radar.test;
process.stdout.write(`token radar ${radar.model}: ${c.protocols} protocols, ${c.live} with a token (${c.comps} priced comps), ${c.tokenless} tokenless; board ${c.board} rows (watchlist ${c.watch_covered}/${c.watch}), ${c.set_aside} set aside\n`);
const kept = t.steps.filter((x: any) => x.kept === true).pop();
process.stdout.write(`held out: ${t.kept}/${t.tried} terms kept; LOO rmse ${kept.loo.rmse} (flat ${t.steps[0].loo.rmse}), newest-${t.split.test} test ${kept.test.rmse} (flat ${t.steps[0].test.rmse}); token odds AUC ${radar.odds_test.auc}\n`);
process.stdout.write(`token radar: wrote board.json, data.js, dashboard/ (${pages.length} files), screenshots/ (${shots.length}) and dossier.json to ${out}\n`);
