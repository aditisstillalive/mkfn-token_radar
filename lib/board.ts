// Board assembly: price every tokenless protocol, rank the candidates, set the derivatives aside,
// attach a farm plan to each row, and check the result against the gate's shape before writing it.

import { calibrate, classify, hasToken, K, MODEL_VERSION, ruleFailure, value, CLASS_LABEL, type RowClass, type Snapshot, type SnapshotProtocol } from './model.ts';
import { farmPlan, stepLine } from './farm.ts';

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  implied_value_usd: number;
  class: RowClass;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  tokenless_days: number | null;
  airdrop_pool_usd: number;
  est_per_1k_usd: number;
  factors: { category_multiple: number; size: number; momentum: number; runway: number; class_factor: number };
  farm_steps: string[];
}

export function parseSnapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot;
  if (!s || !Array.isArray(s.protocols) || !Array.isArray(s.watchlist) || typeof s.as_of !== 'string') throw new Error('snapshot: missing protocols, watchlist or as_of');
  return s;
}

const est = (implied: number, tvl: number) => (implied * K.AIRDROP_SHARE * 1000 * (K.FARM_DAYS / K.SEASON_DAYS)) / Math.max(1, tvl);

export function buildRadar(s: Snapshot) {
  const cal = calibrate(s);
  const watch = new Set(s.watchlist);
  const priced = s.protocols.filter((p) => !hasToken(p)).map((p) => {
    const cls = classify(p, s, watch);
    return { p, cls, v: value(p, cls, s, cal) };
  });
  const order = (a: { v: { implied: number }; p: SnapshotProtocol }, b: { v: { implied: number }; p: SnapshotProtocol }) => b.v.implied - a.v.implied || a.p.slug.localeCompare(b.p.slug);
  const candidates = priced.filter((x) => x.cls !== 'derivative').sort(order);
  const setAside = priced.filter((x) => x.cls === 'derivative').sort(order);

  const board: BoardRow[] = [];
  const plans: Record<string, ReturnType<typeof farmPlan>> = {};
  candidates.forEach(({ p, cls, v }, i) => {
    const per1k = Math.round(est(v.implied, p.tvl_usd) * 100) / 100;
    const plan = farmPlan(p, v.age, per1k);
    plans[p.slug] = plan;
    board.push({
      rank: i + 1, slug: p.slug, name: p.name, implied_value_usd: v.implied, class: cls, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, tokenless_days: v.age,
      airdrop_pool_usd: Math.round(v.implied * K.AIRDROP_SHARE), est_per_1k_usd: per1k,
      factors: { category_multiple: v.multiple, size: v.size, momentum: v.momentum, runway: v.runway, class_factor: v.classFactor },
      farm_steps: plan.steps.map(stepLine),
    });
  });

  const radar = {
    model: MODEL_VERSION, as_of: s.as_of, source: s.source, floor_usd: s.floor_usd, constants: K, class_label: CLASS_LABEL,
    counts: { protocols: s.protocols.length, live: s.protocols.length - priced.length, tokenless: priced.length, board: board.length, watch: s.watchlist.length, set_aside: setAside.length },
    calibration: { comps: cal.comps.length, global_multiple: cal.globalMultiple, slope: cal.slope, slope_raw: cal.slopeRaw, centre_tvl: Math.round(Math.exp(cal.logTvlCentre)), unknown_age_days: cal.unknownAgeDays, families: Object.values(cal.families), categories: Object.values(cal.categories).filter((c) => c.comps > 0 || board.some((r) => (r.category ?? 'Uncategorised') === c.category)) },
    rows: board.map((r) => ({ ...r, farm_steps: undefined, plan: plans[r.slug] })),
    set_aside: setAside.map(({ p, v }) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, change_7d: p.change_7d, reason: ruleFailure(p), implied_value_usd: v.implied })),
    comps: cal.comps.filter((c, i) => i < 60 || board.some((r) => (r.category ?? 'Uncategorised') === c.category)).map((c) => ({ slug: c.slug, name: c.name, symbol: c.symbol, category: c.category, tvl_usd: c.tvl, mcap_usd: c.mcap, ratio: Math.round(c.ratio * 1000) / 1000, members: c.members })),
  };
  return { board, radar };
}

/** The gate's board checks, run before anything is written. Null when the board passes. */
export function boardIssue(board: BoardRow[], s: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `${board.length} rows (100 to 4,000)`;
  const known = new Set(s.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const [i, r] of board.entries()) {
    if (!known.has(r.slug) || seen.has(r.slug) || /\s/.test(r.slug)) return `row ${i}: slug ${r.slug}`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${i}: rank ${r.rank}`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) return `row ${i}: implied value`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i}: value rises`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12 || r.farm_steps.some((t) => t.trim().length < 20 || t.trim().length > 600)) return `row ${i}: farm steps`;
  }
  const missing = s.watchlist.filter((w) => !seen.has(w));
  if (missing.length) return `watchlist not covered: ${missing.slice(0, 3).join(', ')}`;
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  return null;
}

export const dataScript = (radar: unknown) => `window.RADAR=${JSON.stringify(radar)};\n`;
