// Token radar model, "comps-v2": one sealed snapshot in, one ranked board out.
//
// The question: if a protocol's record stayed exactly as the snapshot shows it, what would its token
// be worth? We answer by comparison with the snapshot's own protocols whose token already trades.
//
//   1. Comps. Every protocol that records a token AND a market cap gives one ratio, mcap / TVL. We take
//      logs, average per category and shrink each category toward the all-comps mean with a prior of
//      PRIOR_WEIGHT comps (empirical Bayes), so a category with two comps does not set its own price.
//   2. Size. Small protocols trade at richer multiples than large ones. We fit the slope of the
//      log-ratio residual on log TVL across the comps by least squares, clamp it, and apply it.
//   3. Momentum. The 7-day TVL change, clamped, raised to GROWTH_ELASTICITY: a week of inflow is
//      treated as partly persistent.
//   4. Runway. How long the protocol has run with no token. A protocol that has held its TVL for years
//      without paying anyone in tokens has proven demand; a 30-day-old vault has not. A saturating
//      curve maps age to a credibility multiplier.
//   5. Class. The snapshot's watchlist rule is re-applied to every tokenless protocol. One that fails
//      it (a CEX wallet, a liquid-staking wrapper, a bridge, a versioned product) is the product of a
//      token that already trades and is cut by DERIVATIVE_FACTOR; one that passes the rule and sits
//      above the floor yet is left off the watchlist has a DefiLlama parent, so it probably shares the
//      parent's token and is cut by PARENTED_FACTOR.
//
//   implied = TVL x categoryMultiple x sizeAdj x momentum x runway x classFactor
//
// Every constant is stated here and on the dashboard. No protocol name is special-cased: the same
// function prices every row, and the multiples are recomputed from whatever snapshot is read.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'comps-v2';

export const K = {
  PRIOR_WEIGHT: 6, // comps-worth of pull toward the all-comps mean
  RATIO_MIN: 0.01, // mcap/TVL ratios are clamped into [min, max] before the log
  RATIO_MAX: 25,
  SLOPE_MIN: -0.45, // the fitted size slope is clamped into this band
  SLOPE_MAX: 0,
  SIZE_MIN: 0.5, // size adjustment band
  SIZE_MAX: 2.5,
  GROWTH_FLOOR: -50, // 7d change clamp, per cent
  GROWTH_CAP: 80,
  GROWTH_ELASTICITY: 1.5,
  RUNWAY_FLOOR: 0.6, // runway multiplier = floor + range x (1 - e^(-age / tau))
  RUNWAY_RANGE: 0.4,
  RUNWAY_TAU_DAYS: 365,
  PARENTED_FACTOR: 0.35,
  DERIVATIVE_FACTOR: 0.12,
  AIRDROP_SHARE: 0.075, // share of supply assumed to go to farmers
  SEASON_DAYS: 180, // a points season; the reader farms FARM_DAYS of it
  FARM_DAYS: 90,
};

const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPER_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;

export type RowClass = 'watch' | 'early' | 'parented' | 'derivative';

export const CLASS_LABEL: Record<RowClass, string> = {
  watch: 'Watchlist',
  early: 'Early (below floor)',
  parented: 'Has a parent',
  derivative: 'Derivative of a live token',
};

export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** Why the watchlist rule would refuse this protocol, or null when it passes (parent unknowable). */
export function ruleFailure(p: SnapshotProtocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSION_MARKER.test(p.name)) return 'versioned name';
  if (WRAPPER_WORD.test(p.name)) return 'wrapped/staked product';
  if (EXCHANGE_PREFIX.test(p.name)) return 'exchange-branded';
  return null;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const d = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export interface Comp { slug: string; name: string; category: string; symbol: string | null; tvl: number; mcap: number; ratio: number }
export interface CategoryMultiple { category: string; comps: number; raw: number | null; multiple: number }
export interface Calibration {
  comps: Comp[];
  globalMultiple: number;
  slope: number;
  slopeRaw: number;
  logTvlCentre: number;
  categories: Record<string, CategoryMultiple>;
  unknownAgeDays: number;
}

/** Fit the multiples, the size slope and the unknown-age default from the snapshot itself. */
export function calibrate(s: Snapshot): Calibration {
  const comps: Comp[] = s.protocols
    .filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category ?? 'Uncategorised', symbol: p.symbol, tvl: p.tvl_usd, mcap: p.mcap_usd!, ratio: p.mcap_usd! / p.tvl_usd }));
  const lr = (c: Comp) => Math.log(clamp(c.ratio, K.RATIO_MIN, K.RATIO_MAX));
  const globalLog = comps.reduce((a, c) => a + lr(c), 0) / Math.max(1, comps.length);

  const byCat = new Map<string, Comp[]>();
  for (const c of comps) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c]);
  const catLog = new Map<string, number>();
  const categories: Record<string, CategoryMultiple> = {};
  const allCats = new Set(s.protocols.map((p) => p.category ?? 'Uncategorised'));
  for (const cat of [...allCats].sort()) {
    const cs = byCat.get(cat) ?? [];
    const sum = cs.reduce((a, c) => a + lr(c), 0);
    const shrunk = (sum + K.PRIOR_WEIGHT * globalLog) / (cs.length + K.PRIOR_WEIGHT);
    catLog.set(cat, shrunk);
    categories[cat] = { category: cat, comps: cs.length, raw: cs.length ? r4(Math.exp(sum / cs.length)) : null, multiple: r4(Math.exp(shrunk)) };
  }

  // Least-squares slope of the residual (log ratio minus its category's shrunk mean) on centred log TVL.
  const logTvlCentre = comps.reduce((a, c) => a + Math.log(c.tvl), 0) / Math.max(1, comps.length);
  let sxy = 0;
  let sxx = 0;
  for (const c of comps) {
    const x = Math.log(c.tvl) - logTvlCentre;
    sxy += x * (lr(c) - catLog.get(c.category)!);
    sxx += x * x;
  }
  const slopeRaw = sxx > 0 ? sxy / sxx : 0;

  const ages = s.protocols.filter((p) => !hasToken(p)).map((p) => ageDays(s.as_of, p.listed_at)).filter((a): a is number => a !== null);
  return {
    comps: comps.sort((a, b) => b.mcap - a.mcap || a.slug.localeCompare(b.slug)),
    globalMultiple: r4(Math.exp(globalLog)),
    slope: r4(clamp(slopeRaw, K.SLOPE_MIN, K.SLOPE_MAX)),
    slopeRaw: r4(slopeRaw),
    logTvlCentre,
    categories,
    unknownAgeDays: Math.round(median(ages)),
  };
}

export interface Valuation {
  implied: number;
  multiple: number; // category multiple
  size: number;
  momentum: number;
  runway: number;
  classFactor: number;
  age: number | null;
  ageUsed: number;
}

export function classify(p: SnapshotProtocol, s: Snapshot, watch: Set<string>): RowClass {
  if (watch.has(p.slug)) return 'watch';
  if (ruleFailure(p) !== null) return 'derivative';
  return p.tvl_usd >= s.floor_usd ? 'parented' : 'early';
}

export function value(p: SnapshotProtocol, cls: RowClass, s: Snapshot, cal: Calibration): Valuation {
  const multiple = cal.categories[p.category ?? 'Uncategorised']?.multiple ?? cal.globalMultiple;
  const size = clamp(Math.exp(cal.slope * (Math.log(Math.max(1, p.tvl_usd)) - cal.logTvlCentre)), K.SIZE_MIN, K.SIZE_MAX);
  const g = clamp(p.change_7d ?? 0, K.GROWTH_FLOOR, K.GROWTH_CAP);
  const momentum = Math.pow(1 + g / 100, K.GROWTH_ELASTICITY);
  const age = ageDays(s.as_of, p.listed_at);
  const ageUsed = age ?? cal.unknownAgeDays;
  const runway = K.RUNWAY_FLOOR + K.RUNWAY_RANGE * (1 - Math.exp(-ageUsed / K.RUNWAY_TAU_DAYS));
  const classFactor = cls === 'derivative' ? K.DERIVATIVE_FACTOR : cls === 'parented' ? K.PARENTED_FACTOR : 1;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * size * momentum * runway * classFactor));
  return { implied, multiple, size: r4(size), momentum: r4(momentum), runway: r4(runway), classFactor, age, ageUsed };
}
