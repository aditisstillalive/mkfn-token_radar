// _engine.js (sorts first in the dossier): the whole radar, snapshot in, board out. main.ts runs it to write
// board.json and the page re-runs it on the same snapshot. No imports, no network.
//
//   implied value  = fitted core value x momentum x runway x class                (value if it launches)
//   core value     = exp(a + b ln TVL + any term that survived both tests)       ridge on trading tokens
//   token odds     = logistic(terms that survived both tests)        share of look-alikes carrying a token
//   expected value = token odds x implied value
//   portfolio      = one budget filled by edge per dollar, capped per position and per protocol TVL
//
// Each model's terms are tried in order and kept only if both held-out tests improve; the newest third
// is scored at every step and never chooses.
(function (root) {
'use strict';

var K = {
  MODEL: 'fit-v8',
  LAMBDAS: [1, 3, 10, 30], // ridge penalties tried for a term, chosen by leave-one-out on train
  PRIOR_W: [0.25, 0.5, 0.75, 1], // weights tried on the momentum and runway priors, chosen on the validation fold
  RATIO_MIN: 0.01, RATIO_MAX: 25, // a comp's mcap/TVL is clamped here before the log (leverage cap)
  GROWTH_FLOOR: -50, GROWTH_CAP: 60, // momentum prior: (1 + clamped 7d change)^1
  RUNWAY_FLOOR: 0.6, RUNWAY_RANGE: 0.4, RUNWAY_TAU: 365, // runway prior: floor + range (1 - e^-days/tau)
  PARENTED: 0.35, DERIVATIVE: 0.12, // class factors (derivatives are set aside off the board)
  ODDS_LAMBDA: 1, FOLDS: 10, // logistic ridge penalty and cross-validation folds for token odds
  TICKET: 2500, // deposit: a retail ticket; carry and risk scale with it, so it moves a verdict only via fixed gas
  EXIT_7D: -10, // the plan's exit trigger: a 7-day TVL change below this; a protocol already past it is not a farm
  AIRDROP_SHARE: 0.075, SEASON_DAYS: 180, FARM_DAYS: 90, // farmer share of supply; the reader farms 90 of 180 days
  LAUNCH_FLOAT: 0.3, // circulating share at launch: comps price the float, a drop is a share of the full supply
  LOSS_GIVEN_EXPLOIT: 0.6,
  BUDGET: 10000, POS_CAP: 0.25, TVL_CAP: 0.01, // allocator: total capital, at most a quarter of it and 1% of a protocol's TVL per position
};

var EXCLUDED = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
var WRAPPER = /\b(wrapped|staked|staking)\b/i;
var EXCHANGE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;
var FAMILY = {
  'Vault managers': ['Risk Curators', 'Onchain Capital Allocator', 'Yield Aggregator', 'Yield', 'Liquidity Manager', 'Options Vault', 'Farm', 'Leveraged Farming', 'Indexes'],
  'Trading venues': ['Dexs', 'Derivatives', 'Prediction Market', 'Interest Rate Derivatives', 'Options', 'OTC Marketplace', 'Synthetics', 'Launchpad', 'NFT Marketplace'],
  'Credit & stablecoins': ['Lending', 'CDP', 'CDP Manager', 'Uncollateralized Lending', 'Dual-Token Stablecoin', 'Stablecoin Wrapper', 'Basis Trading', 'Algo-Stables', 'Stablecoin Issuer', 'Reserve Currency', 'Collateral Management'],
  'Real-world assets': ['RWA', 'CeDeFi', 'RWA Lending', 'Payments', 'Crypto Card Issuer'],
  Infrastructure: ['Chain', 'Restaking', 'Collateral Markets', 'Staking Pool', 'Anchor BTC', 'Decentralized BTC', 'Privacy', 'Insurance', 'Governance Incentives', 'Oracle'],
};
var FAMS = Object.keys(FAMILY).concat('Other');
var famOf = {};
FAMS.forEach(function (f) { (FAMILY[f] || []).forEach(function (c) { famOf[c] = f; }); });
function family(cat) { return famOf[cat || ''] || 'Other'; }
function cat(p) { return p.category || 'Uncategorised'; }
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; } // code-unit order: same in Node and browsers

function hasToken(p) { return p.gecko_id !== null || p.symbol !== null; }
/** Why the watchlist rule refuses a protocol (it is a product of a token that trades), or null. */
function ruleFailure(p) {
  if (EXCLUDED.indexOf(p.category) >= 0) return 'category ' + p.category;
  if (VERSIONED.test(p.name)) return 'versioned name';
  if (WRAPPER.test(p.name)) return 'wrapped/staked product';
  if (EXCHANGE.test(p.name)) return 'exchange-branded';
  return null;
}
function ageDays(asOf, d) {
  if (!d) return null;
  var x = (Date.parse(asOf + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 864e5;
  return isFinite(x) ? Math.max(0, Math.round(x)) : null;
}
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function r4(x) { return Math.round(x * 1e4) / 1e4; }
function quantile(xs, q) { var s = xs.slice().sort(function (a, b) { return a - b; }); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; }
function median(xs) { return quantile(xs, 0.5); }

// ---- linear algebra: a d x d inverse by Gauss-Jordan with partial pivoting
function inverse(A) {
  var d = A.length, M = A.map(function (r, i) { return r.concat(r.map(function (_, j) { return i === j ? 1 : 0; })); });
  for (var c = 0; c < d; c++) {
    var p = c;
    for (var r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    var t = M[c]; M[c] = M[p]; M[p] = t;
    var v = M[c][c];
    for (var k = 0; k < 2 * d; k++) M[c][k] /= v;
    for (r = 0; r < d; r++) if (r !== c && M[r][c] !== 0) { var m = M[r][c]; for (k = 0; k < 2 * d; k++) M[r][k] -= m * M[c][k]; }
  }
  return M.map(function (r) { return r.slice(d); });
}
function dot(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
/** Ridge least squares: w = (X'X + diag(pen))^-1 X'y, plus each row's leverage h_ii for exact LOO. */
function ridge(X, y, pen) {
  var d = pen.length, A = [], b = new Array(d).fill(0), i, j, k;
  for (j = 0; j < d; j++) { A.push(new Array(d).fill(0)); A[j][j] = pen[j]; }
  for (i = 0; i < X.length; i++) for (j = 0; j < d; j++) { b[j] += X[i][j] * y[i]; for (k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k]; }
  var Ai = inverse(A), w = Ai.map(function (r) { return dot(r, b); });
  var h = X.map(function (x) { return dot(x, Ai.map(function (r) { return dot(r, x); })); });
  return { w: w, h: h };
}

// ---- comps: one per trading token
/** DefiLlama gives every product of a token the token's whole market cap, so products sharing a
 *  CoinGecko id (or symbol) are merged and their TVL summed. A token whose largest product fails the
 *  watchlist rule (a CEX, a bridge, a staking wrapper) prices an exchange or a base asset: dropped. */
function buildComps(s) {
  var g = {}, keys = [];
  s.protocols.forEach(function (p) {
    if (!hasToken(p) || p.tvl_usd <= 0) return;
    var k = p.gecko_id || 'sym:' + p.symbol;
    if (!g[k]) { g[k] = []; keys.push(k); }
    g[k].push(p);
  });
  var comps = [];
  keys.sort(cmp).forEach(function (k) {
    var m = g[k].slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd || cmp(a.slug, b.slug); }), lead = m[0];
    var mcap = Math.max.apply(null, m.map(function (x) { return x.mcap_usd || 0; }));
    if (mcap <= 0 || ruleFailure(lead)) return;
    var tvl = m.reduce(function (a, x) { return a + x.tvl_usd; }, 0);
    var ch = []; m.forEach(function (x) { x.chains.forEach(function (c) { if (ch.indexOf(c) < 0) ch.push(c); }); });
    comps.push({ slug: lead.slug, name: lead.name, symbol: lead.symbol, category: cat(lead), family: family(lead.category), listed_at: lead.listed_at, chains: ch,
      change_7d: lead.change_7d, tvl: tvl, mcap: mcap, ratio: mcap / tvl, members: m.length });
  });
  return { comps: comps.sort(function (a, b) { return b.mcap - a.mcap || cmp(a.slug, b.slug); }) };
}

// ---- the fitted core: ln mcap = a + b (ln TVL - centre) + kept terms. x = { tvl, category, change_7d, listed_at }
function lnTarget(c) { return Math.log(c.tvl * clamp(c.ratio, K.RATIO_MIN, K.RATIO_MAX)); }
var TERMS = [ // name, and the columns it adds given the training set
  ['family', function () { return FAMS.map(function (f) { return function (x) { return +(family(x.category) === f); }; }); }],
  ['category', function (tr) { return tr.map(function (c) { return c.category; }).filter(function (c, i, a) { return a.indexOf(c) === i; }).sort(cmp).map(function (k) { return function (x) { return +(x.category === k); }; }); }],
  ['7d change', function () { return [function (x) { return Math.log(momentum(x.change_7d)); }]; }],
  ['days tracked', function (tr, s, ua) { return [function (x) { var a = ageDays(s.as_of, x.listed_at); return Math.log1p((a === null ? ua : a) / 365); }]; }],
  // Rev 2 candidates, capped so one sprawling deployment cannot lever the fit; tested after the four above.
  ['chain count, capped at 10', function () { return [function (x) { return Math.log(clamp(x.chains.length, 1, 10)); }]; }],
  ['on Ethereum', function () { return [function (x) { return +(x.chains.indexOf('Ethereum') >= 0); }]; }],
];
function fitCore(tr, terms, lam, s, ua) {
  var centre = tr.reduce(function (a, c) { return a + Math.log(c.tvl); }, 0) / tr.length, cols = [];
  terms.forEach(function (t) { cols = cols.concat(TERMS[t][1](tr, s, ua)); });
  function row(x) { return [1, Math.log(Math.max(1, x.tvl)) - centre].concat(cols.map(function (f) { return f(x); })); }
  var X = tr.map(row), y = tr.map(lnTarget), fit = ridge(X, y, [1e-9, 1e-9].concat(cols.map(function () { return lam; }))), w = fit.w;
  return { centre: centre, a: w[0], b: w[1], predict: function (x) { return dot(w, row(x)); }, rest: function (x) { return dot(w.slice(2), row(x).slice(2)); },
    loo: X.map(function (x, i) { return y[i] - (y[i] - dot(w, x)) / (1 - fit.h[i]); }) }; // exact LOO prediction
}
/** The fit with its penalty chosen by exact leave-one-out on tr. */
function bestFit(tr, terms, s, ua) {
  var act = tr.map(lnTarget), b = null;
  (terms.length ? K.LAMBDAS : [1]).forEach(function (l) { var f = fitCore(tr, terms, l, s, ua); f.lam = l; f.rmse = score(f.loo, act).rmse; if (!b || f.rmse < b.rmse) b = f; });
  return b;
}
function byDate(xs) { var d = xs.slice().sort(function (a, b) { return cmp(a.listed_at || '0000', b.listed_at || '0000') || cmp(a.slug, b.slug); }), k = Math.floor((d.length * 2) / 3); return [d.slice(0, k), d.slice(k)]; }
/** Out-of-sample scores of predictions (ln) against actual ln market caps. */
function score(pred, act) {
  var e = pred.map(function (p, i) { return Math.abs(act[i] - p); });
  return { n: e.length, rmse: r4(Math.sqrt(dot(e, e) / e.length)), median_x: r4(Math.exp(median(e))) };
}
function lnCap(c) { return Math.log(c.mcap); } // held-out targets are scored unclamped; only training clamps
/** Baseline: one flat multiple (geometric mean mcap/TVL of the training comps) times TVL. */
function flat(tr) { var m = tr.reduce(function (a, c) { return a + lnTarget(c) - Math.log(c.tvl); }, 0) / tr.length; return function (c) { return Math.log(c.tvl) + m; }; }

function calibrate(s) {
  var comps = buildComps(s).comps;
  var ages = s.protocols.filter(function (p) { return !hasToken(p); }).map(function (p) { return ageDays(s.as_of, p.listed_at); }).filter(function (a) { return a !== null; });
  var ua = Math.round(median(ages));
  // Walk-forward: train on the oldest two thirds, test on the newest third; train splits again into fit and
  // validation. Every choice (terms, penalties, prior weight) reads train only; the test never chooses.
  var tt = byDate(comps), train = tt[0], test = tt[1], fv = byDate(train), trAct = train.map(lnCap);
  var pri = function (c) { var a = ageDays(s.as_of, c.listed_at); return Math.log(momentum(c.change_7d)) + Math.log(runway(a === null ? ua : a)); };
  var on = function (f, xs) { return score(xs.map(f), xs.map(lnCap)); };
  function scores(terms, w) { // w: the weight on the momentum and runway priors
    var tr = bestFit(train, terms, s, ua), fit = bestFit(fv[0], terms, s, ua), add = function (m) { return function (c) { return m.predict(c) + w * pri(c); }; };
    return { tr: tr, w: w, loo: score(tr.loo.map(function (x, i) { return x + w * pri(train[i]); }), trAct), val: on(add(fit), fv[1]), test: on(add(tr), test) };
  }
  var tot = train.reduce(function (a, c) { return a + lnTarget(c) - Math.log(c.tvl); }, 0);
  var fl = { loo: score(train.map(function (c) { return Math.log(c.tvl) + (tot - lnTarget(c) + Math.log(c.tvl)) / (train.length - 1); }), trAct), val: on(flat(fv[0]), fv[1]), test: on(flat(train), test) };
  var cur = scores([], 0), kept = [], row = function (t, x, k) { return { term: t, kept: k, loo: x.loo, val: x.val, test: x.test }; };
  var steps = [row('flat multiple', fl, 'baseline'), row('size: ln TVL', cur, cur.loo.rmse < fl.loo.rmse && cur.val.rmse < fl.val.rmse)];
  TERMS.forEach(function (t, i) {
    var x = scores(kept.concat(i), 0), k = x.loo.rmse < cur.loo.rmse && x.val.rmse < cur.val.rmse;
    steps.push(row('+ ' + t[0], x, k));
    if (k) { kept.push(i); cur = x; }
  });
  // The brief asks the value to carry growth and runway, so both stay in; their weight is picked from a
  // strictly positive grid on the validation fold alone.
  K.PRIOR_W.forEach(function (w) { var x = scores(kept, w); if (cur.w === 0 || x.val.rmse < cur.val.rmse) cur = x; });
  steps.push(row('× (momentum × runway)^' + cur.w, cur, 'shipped'));
  var core = bestFit(comps, kept, s, ua), w = cur.w, ship = function (m, c) { return m.predict(c) + w * pri(c); };
  // Bands: quantiles of the shipped LOO misses; honesty = share of newest caps inside the train fit's own.
  var Q = [0.1, 0.25, 0.75, 0.9], resid = comps.map(function (c, i) { return lnCap(c) - core.loo[i] - w * pri(c); });
  var tq = Q.map(function (q) { return quantile(train.map(function (c, i) { return trAct[i] - cur.tr.loo[i] - w * pri(c); }), q); });
  var inside = function (lo, hi) { return r4(test.filter(function (c) { var e = lnCap(c) - ship(cur.tr, c); return e >= tq[lo] && e <= tq[hi]; }).length / test.length); };
  return {
    comps: comps, core: core, w: w, unknownAge: ua, terms: kept.map(function (i) { return TERMS[i][0]; }),
    band: Q.map(function (q) { return r4(Math.exp(quantile(resid, q))); }),
    test: {
      steps: steps, kept: kept.length + 1, tried: TERMS.length + 1, w: w, grid: K.PRIOR_W,
      split: { fit: fv[0].length, val: fv[1].length, val_from: fv[1][0].listed_at, train: train.length, test: test.length, test_from: test[0].listed_at },
      coverage: { p25_p75: inside(1, 2), p10_p90: inside(0, 3) },
      points: train.map(function (c, i) { return [r4(cur.tr.loo[i] + w * pri(c)), r4(trAct[i]), 0]; }).concat(test.map(function (c) { return [r4(ship(cur.tr, c)), r4(lnCap(c)), 1]; })),
    },
  };
}

function momentum(g) { return 1 + clamp(g === null || g === undefined ? 0 : g, K.GROWTH_FLOOR, K.GROWTH_CAP) / 100; }
function runway(age) { return K.RUNWAY_FLOOR + K.RUNWAY_RANGE * (1 - Math.exp(-age / K.RUNWAY_TAU)); }

// ---- token odds: a logistic fit of "carries a token" on the protocol's profile. Terms are tried in order
// after the base rate and kept only if they lower the Brier score both in ten-fold CV on the older two
// thirds and on a walk-forward fold (fit its oldest part, score the next). The newest third never chooses.
var OTERMS = [['size: ln TVL', function (p, c) { return [Math.log(p.tvl_usd) - c]; }],
  ['days tracked', function (p, c, ua, s, dt) { var a = ageDays(s.as_of, p.listed_at); return [Math.log1p(((a === null ? ua : a) + dt) / 365)]; }],
  ['chain count', function (p) { return [Math.log(Math.max(1, p.chains.length))]; }],
  ['family', function (p) { var f = family(p.category); return FAMS.map(function (x) { return +(x === f); }); }]];
function oddsModel(s, ua) {
  var pop = s.protocols.filter(function (p) { return !ruleFailure(p) && p.tvl_usd > 0; }), tt = byDate(pop), tr = tt[0], fv = byDate(tr);
  var c = tr.reduce(function (a, p) { return a + Math.log(p.tvl_usd); }, 0) / tr.length, y = function (p) { return hasToken(p) ? 1 : 0; };
  function fit(ps, terms) { // Newton-Raphson on the penalised log-likelihood, a fixed 12 steps (converged well before)
    var row = function (p, dt) { var x = [1]; terms.forEach(function (t) { x = x.concat(OTERMS[t][1](p, c, ua, s, dt || 0)); }); return x; };
    var X = ps.map(function (p) { return row(p, 0); }), d = X[0].length, w = new Array(d).fill(0);
    for (var it = 0; it < 12; it++) {
      var H = [], g = new Array(d).fill(0), j, k;
      for (j = 0; j < d; j++) { H.push(new Array(d).fill(0)); H[j][j] = j ? K.ODDS_LAMBDA : 1e-6; g[j] = j ? -K.ODDS_LAMBDA * w[j] : 0; }
      X.forEach(function (x, i) { var q = 1 / (1 + Math.exp(-dot(w, x))), e = y(ps[i]) - q; for (j = 0; j < d; j++) { g[j] += e * x[j]; for (k = 0; k < d; k++) H[j][k] += q * (1 - q) * x[j] * x[k]; } });
      var Hi = inverse(H);
      w = w.map(function (v, i) { return v + dot(Hi[i], g); });
    }
    return function (p, dt) { return 1 / (1 + Math.exp(-dot(w, row(p, dt)))); };
  }
  var se = function (m, p) { var e = m(p) - y(p); return e * e; }, brier = function (m, ps) { return r4(ps.reduce(function (a, p) { return a + se(m, p); }, 0) / ps.length); };
  function scores(terms) {
    var e = 0, f;
    for (f = 0; f < K.FOLDS; f++) { var m = fit(tr.filter(function (p, i) { return i % K.FOLDS !== f; }), terms); tr.forEach(function (p, i) { if (i % K.FOLDS === f) e += se(m, p); }); }
    return { cv: r4(e / tr.length), val: brier(fit(fv[0], terms), fv[1]), test: brier(fit(tr, terms), tt[1]) };
  }
  var cur = scores([]), kept = [], steps = [Object.assign({ term: 'base rate', kept: 'baseline' }, cur)];
  OTERMS.forEach(function (t, i) {
    var x = scores(kept.concat(i)), k = x.cv < cur.cv && x.val < cur.val;
    steps.push(Object.assign({ term: (i ? '+ ' : '') + t[0], kept: k }, x));
    if (k) { kept.push(i); cur = x; }
  });
  var P = fit(pop, kept);
  // Farming pays only if the token comes while the reader farms: with P(t) the share of this profile carrying
  // one, the chance within H days given none yet is h = (P(t+H) - P(t)) / (1 - P(t)), a cross-sectional approximation.
  return { predict: P, hazard: function (p, H) { var a = P(p), b = P(p, H); return Math.max(0, (b - a) / (1 - a)); }, test: { n: pop.length, with_token: pop.filter(y).length, folds: K.FOLDS, steps: steps, kept: kept.map(function (i) { return OTERMS[i][0]; }),
    shipped: cur, split: { train: tr.length, val: fv[1].length, test: tt[1].length, test_from: tt[1][0].listed_at } } };
}

// ---- valuation
function classify(p, s, watch) {
  if (watch[p.slug]) return 'watch';
  if (ruleFailure(p)) return 'derivative';
  return p.tvl_usd >= s.floor_usd ? 'parented' : 'early';
}
function value(p, cls, s, cal) {
  var core = cal.core, x = { tvl: p.tvl_usd, category: cat(p), change_7d: p.change_7d, listed_at: p.listed_at, chains: p.chains }, age = ageDays(s.as_of, p.listed_at);
  var parts = { base: Math.exp(core.a), size: Math.exp(core.b * (Math.log(Math.max(1, p.tvl_usd)) - core.centre)), terms: Math.exp(core.rest(x)) };
  var coreUsd = Math.exp(core.predict(x));
  var mo = momentum(p.change_7d), ru = runway(age === null ? cal.unknownAge : age), cf = cls === 'derivative' ? K.DERIVATIVE : cls === 'parented' ? K.PARENTED : 1;
  mo = Math.pow(mo, cal.w); ru = Math.pow(ru, cal.w);
  var implied = Math.max(1, Math.round(coreUsd * mo * ru * cf));
  return { implied: implied, core: Math.round(coreUsd), parts: parts, momentum: r4(mo), runway: r4(ru), classFactor: cf, age: age,
    band: cal.band.map(function (q) { return Math.round(implied * q); }) }; // P10, P25, P75, P90
}

// ---- farm plans: steps with capital, gas and bridge, lockup, risk and break-even
var GAS = { Ethereum: 4, Bitcoin: 3, Tron: 1.5, Algorand: 0.01, Solana: 0.01, Sui: 0.02, Aptos: 0.01, Base: 0.05, Arbitrum: 0.08, Optimism: 0.05, Binance: 0.08,
  Polygon: 0.02, Avalanche: 0.1, Monad: 0.03, Sonic: 0.02, Hyperliquid: 0.02, 'Hyperliquid L1': 0.02, Ink: 0.03, Plasma: 0.01, Berachain: 0.05, Stellar: 0.01,
  Ripple: 0.01, Flare: 0.02, Katana: 0.03, Unichain: 0.03, Linea: 0.06, Scroll: 0.06, Mantle: 0.04, TON: 0.03, Starknet: 0.04, Near: 0.01, Cardano: 0.2, Noble: 0.02 };
// Chains whose wallets are not EVM wallets: the wallet to install, and funding by a native exchange withdrawal.
var NATIVE = { Solana: 'Phantom', Stellar: 'Freighter', Sui: 'Slush', Bitcoin: 'Xverse', Algorand: 'Pera', Ripple: 'Xaman', Starknet: 'Ready', Aptos: 'Petra', Stacks: 'Leather',
  Noble: 'Keplr', Provenance: 'Keplr', XION: 'Keplr', Bittensor: 'Talisman', Proton: 'WebAuth', Qubic: 'Qubic Wallet', Canton: 'a Canton wallet', TON: 'Tonkeeper', Near: 'Meteor', Cardano: 'Eternl', Tron: 'TronLink' };
// Per family (and 3 categories that farm differently): asset, test, follow-up, test txs, minutes, lockup days, net
// carry (APR vs a 4.5% T-bill after own yield, plus fees), market risk (IL, liquidation), weekly txs and action.
var ACT = {
  'Vault managers': ['USDC', 'deposit USDC into its largest curated vault on %c; check the vault page names it as curator before signing', 'Add a second vault of the same curator on %c; curator points tend to reward breadth', 1, 15, 0, 0.01, 0.002, 1, 'claim or compound once'],
  'Trading venues': ['USDC and the chain\'s native asset', 'swap $50 each way on %c, then add $100 of liquidity to its deepest pool in a +/-10% range', 'Re-centre the range whenever price leaves it: venues score liquidity in range', 3, 25, 0, 0.02, 0.015, 2, 'swap a small amount out and back (two swaps)'],
  'Credit & stablecoins': ['ETH or USDC', 'supply collateral on %c and borrow at a loan-to-value at least 25 points below liquidation', 'Re-supply part of the borrow once (one loop, no more): supply and borrow both earn points', 2, 20, 0, 0.01, 0.004, 1, 'check the health factor and top up if it fell'],
  'Real-world assets': ['USDC', 'mint or subscribe to its yield-bearing token on %c, after KYC or allow-listing if asked (budget a day)', 'Deposit the minted token into one partner pool it lists; composability boosts are common', 1, 30, 7, 0.005, 0.002, 1, 'claim the yield or points once'],
  Infrastructure: ['ETH, BTC or stablecoins', 'stake, restake or use its core product on %c with the default operator set, not a boosted one', 'Use two or three other apps on %c or a second operator: network programs reward breadth', 1, 30, 14, 0.015, 0.003, 1, 'use one app on the network once'],
  Other: ['USDC', 'deposit into its main product on %c and confirm the position shows in its dashboard', 'Repeat one small interaction on %c so the address shows sustained use', 1, 20, 0, 0.02, 0.003, 1, 'make one small interaction'],
  'Basis Trading': ['USDC', 'mint its delta-neutral stablecoin or deposit into its basis vault on %c; read how it unwinds when funding turns negative', 'Stake the minted token in its own points or staking module on %c', 1, 20, 7, 0.005, 0.006, 1, 'check funding; exit if it was negative all week'],
  Derivatives: ['USDC', 'deposit USDC margin on %c and open a $100 position hedged at 1x (equal long and short, or short against spot)', 'Keep margin at three times maintenance: perp programs score volume and open interest', 2, 25, 0, 0.03, 0.01, 2, 'open and close one small hedged trade (two fills, about 0.1% fees)'],
  Payments: ['USDC', 'open its card or payment account on %c (KYC likely), top up $100 of USDC and make one real purchase', 'Make its card the default for one recurring bill: payment programs score spend, not balance', 2, 40, 0, 0.045, 0.002, 1, 'make one card payment'],
};
function money(x) { var a = Math.abs(x), s = a >= 100 ? String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : a.toFixed(2); return (x < 0 ? '-$' : '$') + s; }
function pct(x) { return (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%'; }

function farmPlan(p, v, P, h, asOf, ua) {
  var a = ACT[p.category] || ACT[family(p.category)] || ACT.Other, chain = p.chains[0] || 'Ethereum', g0 = function (c) { return GAS[c] === undefined ? 0.25 : GAS[c]; }, gas = g0(chain);
  p.chains.forEach(function (c) { if (g0(c) < gas) { gas = g0(c); chain = c; } });
  var nat = NATIVE[chain], evm = !nat, ticket = K.TICKET, D = K.FARM_DAYS, weeks = Math.round(D / 7), yr = D / 365;
  var bridge = chain === 'Ethereum' ? 0 : evm ? 1.5 : 5, testTx = a[3] + (evm ? 1 : 0), wkTx = weeks * a[8]; // an EVM token needs one approval first
  var gasUsd = gas * (1 + testTx + 1 + 2 + wkTx + 2), carry = ticket * a[6] * yr;
  var age = v.age === null ? ua : v.age, pExploit = (age < 365 ? 0.06 : age < 1095 ? 0.03 : 0.015) * (p.tvl_usd < 2e7 ? 1.5 : 1);
  var riskUsd = ticket * (pExploit * yr * K.LOSS_GIVEN_EXPLOIT + a[7]), riskPct = riskUsd / ticket;
  var total = gasUsd + 2 * bridge + carry + riskUsd;
  var reward = ((v.implied / K.LAUNCH_FLOAT) * K.AIRDROP_SHARE * (D / K.SEASON_DAYS) * ticket) / Math.max(1, p.tvl_usd);
  var expected = h * reward, beOdds = reward > 0 ? total / reward : Infinity, g = p.change_7d, bleeding = g !== null && g < K.EXIT_7D;
  var verdict = bleeding ? 'skip' : expected > total * 1.5 ? 'farm' : expected > total ? 'marginal' : 'skip';
  var level = riskPct < 0.005 ? 'low' : riskPct < 0.012 ? 'medium' : 'high', lock = a[5] ? a[5] + '-day exit queue or redemption' : 'no lockup, exit in one transaction';
  var day = function (d) { return new Date(Date.parse(asOf) + d * 864e5).toISOString().slice(0, 10); }, on = function (t) { return t.replace(/%c/g, chain); };
  var steps = [
    ['Check break-even first: costs ' + money(total) + ' (gas ' + money(gasUsd) + ', bridge ' + money(2 * bridge) + ', carry ' + money(carry) + ', risk ' + money(riskUsd) + ') against a ' + money(reward) + ' drop if a token launches. The chance of one within ' + D + ' days, given none by now, is ' + pct(h) + ' (prevalence ' + pct(P) + ' at this age, a cross-sectional approximation), worth ' + money(expected) + '; break-even needs ' + (beOdds > 1 ? 'over 100%' : pct(beOdds)) + ': ' + (bleeding ? 'skip, TVL is already past the exit trigger' : verdict === 'farm' ? 'farm it at this size' : verdict === 'marginal' ? 'marginal, farm only beside other positions on the chain' : 'skip at this size'), 'none', '2 min'],
    [evm ? 'Fund a fresh wallet on ' + chain + (p.chains.length > 1 ? ' (cheapest of its ' + p.chains.length + ' chains)' : '') + ' with ' + a[0] + ' and bookmark the app from its DefiLlama page, not a search ad'
      : 'Install ' + nat + ' (' + chain + ' is not an EVM chain), withdraw ' + a[0] + ' to it natively from an exchange that lists ' + chain + ' withdrawals, and bookmark the app from its DefiLlama page', money(bridge + gas) + (evm ? ' bridge and gas' : ' withdrawal fee and gas'), '15 min'],
    ['Test with $100: ' + on(a[1]) + ' (' + (evm ? 'one approval, then ' : '') + a[3] + ' transaction' + (a[3] > 1 ? 's' : '') + ')', money(gas * testTx) + ' gas', a[4] + ' min'],
    ['Scale to the ' + money(ticket) + ' deposit once the test can be withdrawn; ' + lock, money(ticket) + ' capital, ' + money(carry) + ' carry over ' + D + ' days', '10 min'],
    [on(a[2]), money(gas * 2) + ' gas', '20 min'],
    ['Hold ' + D + ' days; once a week ' + a[9] + ' and log the points snapshot', money(gas * wkTx) + ' gas, ' + wkTx + ' transactions', '5 min a week, ' + weeks + ' weeks'],
    ['Risk ' + level + ': expected loss ' + money(riskUsd) + ' (' + pct(pExploit) + ' a year exploit odds for a ' + Math.round(age / 30) + '-month record, plus market risk). Exit or halve if the 7-day TVL change falls below ' + K.EXIT_7D + '% (now ' + (g === null ? 'unreported' : (g >= 0 ? '+' : '') + g.toFixed(1) + '%') + ')' + (bleeding ? ': it already has, so wait for TVL to steady before entering' : ' or a snapshot is announced'), money(gas * 2 + bridge) + ' exit gas and bridge', '15 min'],
  ];
  steps = steps.map(function (x, i) { return { when: [day(0), day(0), day(0), day(1), day(2), day(2) + ' to ' + day(D), 'weekly, exit by ' + day(D)][i], do: x[0], cost: x[1], time: x[2] }; });
  return { chain: chain, evm: evm, ticket: ticket, lockup_days: a[5], risk: level, costs: { gas: r4(gasUsd), bridge: 2 * bridge, carry: r4(carry), risk: r4(riskUsd), total: r4(total) },
    launch_odds: r4(h), reward: r4(reward), expected: r4(expected), net: r4(expected - total), breakeven_odds: isFinite(beOdds) ? r4(beOdds) : null, verdict: verdict, bleeding: bleeding,
    end: day(D), hours: r4((2 + 15 + a[4] + 10 + 20 + 5 * weeks + 15) / 60), steps: steps };
}

// ---- portfolio: reward, carry and risk scale with the deposit x and gas does not, so net(x) = e x - g. Fill the
// highest edge e first up to the caps; a plan joins only if it nets positive. Launches taken as independent.
function portfolio(rows) {
  var left = K.BUDGET, out = [], sum = function (k) { return r4(out.reduce(function (a, x) { return a + x[k]; }, 0)); };
  rows.map(function (r) { var c = r.plan.costs; return { r: r, p: r.plan, e: (r.plan.expected - c.carry - c.risk) / r.plan.ticket, g: c.gas + c.bridge }; })
    .filter(function (x) { return x.e > 0 && !x.p.bleeding; }).sort(function (a, b) { return b.e - a.e || cmp(a.r.slug, b.r.slug); })
    .forEach(function (x) {
      var d = Math.floor(Math.min(left, K.BUDGET * K.POS_CAP, x.r.tvl_usd * K.TVL_CAP) / 100) * 100;
      if (d < 100 || x.e * d <= x.g) return;
      left -= d;
      out.push({ slug: x.r.slug, name: x.r.name, chain: x.p.chain, deposit: d, edge: r4(x.e), cost: r4(x.g + (d * (x.p.costs.total - x.g)) / x.p.ticket), net: r4(x.e * d - x.g), launch_odds: x.p.launch_odds, hours: x.p.hours });
    });
  return { budget: K.BUDGET, days: K.FARM_DAYS, positions: out, cash: left, net: sum('net'), cost: sum('cost'), hours: sum('hours'),
    p_any: r4(1 - out.reduce(function (a, x) { return a * (1 - x.launch_odds); }, 1)) };
}

// ---- the board
/** o overrides constants for this run only (the page's deposit, drop share and horizon); 0 keeps the default. */
function build(s, o) {
  var save = {}, k;
  for (k in o || {}) if (o[k]) { save[k] = K[k]; K[k] = o[k]; }
  try { return run(s); } finally { for (k in save) K[k] = save[k]; }
}
function fitAll(s) { var cal = calibrate(s); return { cal: cal, odds: oddsModel(s, cal.unknownAge) }; }
function board(s, f) {
  var cal = f.cal, odds = f.odds, watch = {};
  s.watchlist.forEach(function (w) { watch[w] = true; });
  var priced = s.protocols.filter(function (p) { return !hasToken(p); }).map(function (p) { var cls = classify(p, s, watch); return { p: p, cls: cls, v: value(p, cls, s, cal) }; });
  var order = function (a, b) { return b.v.implied - a.v.implied || cmp(a.p.slug, b.p.slug); };
  var cands = priced.filter(function (x) { return x.cls !== 'derivative'; }).sort(order), aside = priced.filter(function (x) { return x.cls === 'derivative'; }).sort(order);
  var rows = cands.map(function (x, i) {
    var p = x.p, v = x.v, o = r4(odds.predict(p)), plan = farmPlan(p, v, o, odds.hazard(p, K.FARM_DAYS), s.as_of, cal.unknownAge);
    return { rank: i + 1, slug: p.slug, name: p.name, implied_value_usd: v.implied, value_band_usd: v.band, token_odds: o, expected_value_usd: Math.round(o * v.implied),
      class: x.cls, category: p.category, family: family(p.category), chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, tokenless_days: v.age,
      core_value_usd: v.core, factors: { base: r4(v.parts.base), size: r4(v.parts.size), terms: r4(v.parts.terms), momentum: v.momentum, runway: v.runway, class_factor: v.classFactor },
      plan: plan,
      farm_steps: plan.steps.map(function (t) { return t.when + ': ' + t.do + '. Cost: ' + t.cost + '. Time: ' + t.time + '.'; }) };
  });
  return { rows: rows, aside: aside, watch: watch, priced: priced };
}
function run(s) {
  var f = fitAll(s), cal = f.cal, b = board(s, f), rows = b.rows, core = cal.core;
  return {
    model: K.MODEL, as_of: s.as_of, source: s.source, floor_usd: s.floor_usd, constants: Object.assign({}, K), rows: rows,
    counts: { protocols: s.protocols.length, live: s.protocols.filter(hasToken).length, comps: cal.comps.length, tokenless: b.priced.length, board: rows.length, watch: s.watchlist.length,
      watch_covered: rows.filter(function (r) { return b.watch[r.slug]; }).length, set_aside: b.aside.length },
    fit: { a: r4(core.a), b: r4(core.b), centre_tvl: Math.round(Math.exp(core.centre)), band: cal.band, w: cal.w, unknown_age_days: cal.unknownAge, terms: cal.terms },
    test: cal.test, odds_test: f.odds.test, portfolio: portfolio(rows),
    set_aside: b.aside.map(function (x) { return { slug: x.p.slug, name: x.p.name, category: x.p.category, tvl_usd: x.p.tvl_usd, change_7d: x.p.change_7d, reason: ruleFailure(x.p), implied_value_usd: x.v.implied }; }),
  };
}
/** Assumptions the snapshot cannot test: how many farm verdicts flip when each is halved or doubled. */
function assumptions(s) {
  var f = fitAll(s), base = {};
  board(s, f).rows.forEach(function (r) { base[r.slug] = r.plan.verdict; });
  return ['PARENTED', 'LAUNCH_FLOAT', 'AIRDROP_SHARE', 'SEASON_DAYS'].map(function (k) {
    var x = K[k], n = [0.5, 2].map(function (m) {
      K[k] = x * m;
      try { return board(s, f).rows.filter(function (r) { return r.plan.verdict !== base[r.slug]; }).length; } finally { K[k] = x; }
    });
    return { key: k, value: x, half: n[0], double: n[1] };
  });
}

root.RadarEngine = { K: K, build: build, assumptions: assumptions, family: family };
})(typeof window !== 'undefined' ? window : globalThis);
