// engine.js: the whole radar, snapshot in, ranked board out. main.ts runs it to write board.json; the page
// runs it again on the same snapshot, so the screenshots show what this code computes. No imports, no network.
//
//   implied value  = fitted core value x momentum x runway x class                (value if it launches)
//   core value     = exp(a + b ln TVL + any term that survived both tests)       ridge on trading tokens
//   token odds     = logistic(terms that survived both tests)        share of look-alikes carrying a token
//   expected value = token odds x implied value
//
// Each model's terms are tried in order and kept only if both held-out tests improve; the newest third
// is scored at every step and never chooses.
(function (root) {
  'use strict';

  var K = {
    MODEL: 'fit-v6',
    LAMBDAS: [1, 3, 10, 30], // ridge penalties tried for a term, chosen by leave-one-out
    RATIO_MIN: 0.01, RATIO_MAX: 25, // a comp's mcap/TVL is clamped here before the log (leverage cap)
    GROWTH_FLOOR: -50, GROWTH_CAP: 60, // momentum prior: (1 + clamped 7d change)^1
    RUNWAY_FLOOR: 0.6, RUNWAY_RANGE: 0.4, RUNWAY_TAU: 365, // runway prior: floor + range (1 - e^-days/tau)
    PARENTED: 0.35, DERIVATIVE: 0.12, // class factors (derivatives are set aside off the board)
    ODDS_LAMBDA: 1, FOLDS: 10, // logistic ridge penalty and cross-validation folds for token odds
    TICKET: 2500, // deposit: a retail ticket; carry and risk scale with it, so it moves a verdict only via fixed gas
    AIRDROP_SHARE: 0.075, SEASON_DAYS: 180, FARM_DAYS: 90, // farmer share of supply; the reader farms 90 of 180 days
    LAUNCH_FLOAT: 0.3, // circulating share at launch: comps price the float, a drop is a share of the full supply
    LOSS_GIVEN_EXPLOIT: 0.6,
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
      comps.push({ slug: lead.slug, name: lead.name, symbol: lead.symbol, category: cat(lead), family: family(lead.category), listed_at: lead.listed_at,
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
  /** Baseline 1: one flat multiple (geometric mean mcap/TVL of the training comps) times TVL. */
  function flat(train) { var m = train.reduce(function (a, c) { return a + Math.log(clamp(c.ratio, K.RATIO_MIN, K.RATIO_MAX)); }, 0) / train.length; return function (c) { return Math.log(c.tvl) + m; }; }

  function calibrate(s) {
    var built = buildComps(s), comps = built.comps, act = comps.map(lnTarget);
    var ages = s.protocols.filter(function (p) { return !hasToken(p); }).map(function (p) { return ageDays(s.as_of, p.listed_at); }).filter(function (a) { return a !== null; });
    var ua = Math.round(median(ages));
    // Walk-forward: train on the tokens DefiLlama tracked first (two thirds), test on the newest third.
    // Inside train the same split again: fit on its older part, validate on its newer part.
    var tt = byDate(comps), train = tt[0], test = tt[1], fv = byDate(train), vAct = fv[1].map(lnTarget), tAct = test.map(lnTarget);
    var on = function (f, xs, a) { return score(xs.map(f), a); };
    function scores(terms) {
      var all = bestFit(comps, terms, s, ua), tr = bestFit(train, terms, s, ua);
      return { fit: all, tr: tr, loo: score(all.loo, act), val: on(bestFit(fv[0], terms, s, ua).predict, fv[1], vAct), test: on(tr.predict, test, tAct) };
    }
    var tot = act.reduce(function (a, x, i) { return a + x - Math.log(comps[i].tvl); }, 0);
    var flatLoo = comps.map(function (c, i) { return Math.log(c.tvl) + (tot - (act[i] - Math.log(c.tvl))) / (comps.length - 1); });
    var fl = { loo: score(flatLoo, act), val: on(flat(fv[0]), fv[1], vAct), test: on(flat(train), test, tAct) };
    var cur = scores([]), kept = [], row = function (t, x, k) { return { term: t, kept: k, loo: x.loo, val: x.val, test: x.test }; };
    var steps = [row('flat multiple', fl, 'baseline'), row('size: ln TVL', cur, cur.loo.rmse < fl.loo.rmse && cur.val.rmse < fl.val.rmse)];
    TERMS.forEach(function (t, i) {
      var x = scores(kept.concat(i)), k = x.loo.rmse < cur.loo.rmse && x.val.rmse < cur.val.rmse;
      steps.push(row('+ ' + t[0], x, k));
      if (k) { kept.push(i); cur = x; }
    });
    var core = cur.fit, pri = function (c) { var a = ageDays(s.as_of, c.listed_at); return Math.log(momentum(c.change_7d)) + Math.log(runway(a === null ? ua : a)); };
    // Momentum and runway are stated priors (as fitted slopes they did not survive); this is their held-out cost.
    steps.push({ term: '× momentum, runway priors', kept: 'stated', loo: score(core.loo.map(function (x, i) { return x + pri(comps[i]); }), act),
      test: on(function (c) { return cur.tr.predict(c) + pri(c); }, test, tAct) });
    // Value bands: quantiles of the leave-one-out misses. Their honesty is checked on the test: the
    // train fit's own quantiles, and the share of the newest tokens that land inside them.
    var Q = [0.1, 0.25, 0.75, 0.9], resid = core.loo.map(function (x, i) { return act[i] - x; });
    var tq = Q.map(function (q) { return quantile(cur.tr.loo.map(function (x, i) { return lnTarget(train[i]) - x; }), q); });
    var inside = function (lo, hi) { return r4(test.filter(function (c, i) { var e = tAct[i] - cur.tr.predict(c); return e >= tq[lo] && e <= tq[hi]; }).length / test.length); };
    return {
      comps: comps, core: core, unknownAge: ua, terms: kept.map(function (i) { return TERMS[i][0]; }),
      band: Q.map(function (q) { return r4(Math.exp(quantile(resid, q))); }),
      test: {
        steps: steps, kept: kept.length + 1, tried: TERMS.length + 1,
        split: { fit: fv[0].length, val: fv[1].length, val_from: fv[1][0].listed_at, train: train.length, test: test.length, test_from: test[0].listed_at },
        coverage: { p25_p75: inside(1, 2), p10_p90: inside(0, 3) },
      },
    };
  }

  function momentum(g) { return 1 + clamp(g === null || g === undefined ? 0 : g, K.GROWTH_FLOOR, K.GROWTH_CAP) / 100; }
  function runway(age) { return K.RUNWAY_FLOOR + K.RUNWAY_RANGE * (1 - Math.exp(-age / K.RUNWAY_TAU)); }

  // ---- token odds: a logistic fit of "carries a token" on the protocol's profile. Terms are tried in order
  // after the base rate and kept only if they lower the Brier score both in ten-fold CV on the older two
  // thirds and on a walk-forward fold (fit its oldest part, score the next). The newest third never chooses.
  var OTERMS = [['size: ln TVL', function (p, c) { return [Math.log(p.tvl_usd) - c]; }],
    ['days tracked', function (p, c, ua, s) { var a = ageDays(s.as_of, p.listed_at); return [Math.log1p((a === null ? ua : a) / 365)]; }],
    ['chain count', function (p) { return [Math.log(Math.max(1, p.chains.length))]; }],
    ['family', function (p) { var f = family(p.category); return FAMS.map(function (x) { return +(x === f); }); }]];
  function oddsModel(s, ua) {
    var pop = s.protocols.filter(function (p) { return !ruleFailure(p) && p.tvl_usd > 0; });
    var c = pop.reduce(function (a, p) { return a + Math.log(p.tvl_usd); }, 0) / pop.length, y = function (p) { return hasToken(p) ? 1 : 0; };
    function fit(ps, terms) { // Newton-Raphson on the penalised log-likelihood, a fixed 12 steps (converged well before)
      var row = function (p) { var x = [1]; terms.forEach(function (t) { x = x.concat(OTERMS[t][1](p, c, ua, s)); }); return x; };
      var X = ps.map(row), d = X[0].length, w = new Array(d).fill(0);
      for (var it = 0; it < 12; it++) {
        var H = [], g = new Array(d).fill(0), j, k;
        for (j = 0; j < d; j++) { H.push(new Array(d).fill(0)); H[j][j] = j ? K.ODDS_LAMBDA : 1e-6; g[j] = j ? -K.ODDS_LAMBDA * w[j] : 0; }
        X.forEach(function (x, i) { var q = 1 / (1 + Math.exp(-dot(w, x))), e = y(ps[i]) - q; for (j = 0; j < d; j++) { g[j] += e * x[j]; for (k = 0; k < d; k++) H[j][k] += q * (1 - q) * x[j] * x[k]; } });
        var Hi = inverse(H);
        w = w.map(function (v, i) { return v + dot(Hi[i], g); });
      }
      return function (p) { return 1 / (1 + Math.exp(-dot(w, row(p)))); };
    }
    var se = function (m, p) { var e = m(p) - y(p); return e * e; }, brier = function (m, ps) { return r4(ps.reduce(function (a, p) { return a + se(m, p); }, 0) / ps.length); };
    var tt = byDate(pop), tr = tt[0], fv = byDate(tr);
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
    return { predict: fit(pop, kept), test: { n: pop.length, with_token: pop.filter(y).length, folds: K.FOLDS, steps: steps, kept: kept.map(function (i) { return OTERMS[i][0]; }),
      shipped: cur, split: { train: tr.length, val: fv[1].length, test: tt[1].length, test_from: tt[1][0].listed_at } } };
  }

  // ---- valuation
  function classify(p, s, watch) {
    if (watch[p.slug]) return 'watch';
    if (ruleFailure(p)) return 'derivative';
    return p.tvl_usd >= s.floor_usd ? 'parented' : 'early';
  }
  function value(p, cls, s, cal) {
    var core = cal.core, x = { tvl: p.tvl_usd, category: cat(p), change_7d: p.change_7d, listed_at: p.listed_at }, age = ageDays(s.as_of, p.listed_at);
    var parts = { base: Math.exp(core.a), size: Math.exp(core.b * (Math.log(Math.max(1, p.tvl_usd)) - core.centre)), terms: Math.exp(core.rest(x)) };
    var coreUsd = Math.exp(core.predict(x));
    var mo = momentum(p.change_7d), ru = runway(age === null ? cal.unknownAge : age), cf = cls === 'derivative' ? K.DERIVATIVE : cls === 'parented' ? K.PARENTED : 1;
    var implied = Math.max(1, Math.round(coreUsd * mo * ru * cf));
    return { implied: implied, core: Math.round(coreUsd), parts: parts, momentum: r4(mo), runway: r4(ru), classFactor: cf, age: age,
      band: cal.band.map(function (q) { return Math.round(implied * q); }) }; // P10, P25, P75, P90
  }

  // ---- farm plans: steps with capital, gas and bridge, lockup, risk and break-even
  var GAS = { Ethereum: 4, Bitcoin: 3, Tron: 1.5, Algorand: 0.01, Solana: 0.01, Sui: 0.02, Aptos: 0.01, Base: 0.05, Arbitrum: 0.08, Optimism: 0.05, Binance: 0.08,
    Polygon: 0.02, Avalanche: 0.1, Monad: 0.03, Sonic: 0.02, Hyperliquid: 0.02, 'Hyperliquid L1': 0.02, Ink: 0.03, Plasma: 0.01, Berachain: 0.05, Stellar: 0.01,
    Ripple: 0.01, Flare: 0.02, Katana: 0.03, Unichain: 0.03, Linea: 0.06, Scroll: 0.06, Mantle: 0.04, TON: 0.03, Starknet: 0.04, Near: 0.01, Cardano: 0.2, Noble: 0.02 };
  // Per family: what to do, txs, minutes, lockup days, net carry (APR forgone vs a 4.5% T-bill, after
  // the position's own yield) and market risk over the farm (IL, liquidation) as a share of the ticket.
  var ACT = {
    'Vault managers': ['USDC', 'deposit USDC into its largest curated vault on %c; check the vault page names it as curator before signing', 'Add a second vault of the same curator on another chain; curator points tend to reward breadth', 2, 15, 0, 0.01, 0.002],
    'Trading venues': ['USDC and the chain\'s native asset', 'provide liquidity to its deepest pool on %c in a +/-10% range, or post USDC margin and trade small hedged size', 'Make one swap or hedged round-trip a week: venues often score volume apart from liquidity', 3, 25, 0, 0.02, 0.015],
    'Credit & stablecoins': ['ETH or USDC', 'supply collateral on %c and borrow at a loan-to-value at least 25 points below liquidation', 'Re-supply part of the borrow once (one loop, no more): supply and borrow both earn points', 3, 20, 0, 0.01, 0.004],
    'Real-world assets': ['USDC', 'mint or subscribe to its yield-bearing token on %c, after KYC or allow-listing if asked (budget a day)', 'Deposit the minted token into one partner pool it lists; composability boosts are common', 2, 30, 7, 0.005, 0.002],
    Infrastructure: ['ETH, BTC or stablecoins', 'stake, restake or use its core product on %c with the default operator set, not a boosted one', 'Use two or three other apps on %c or a second operator: network programs reward breadth', 3, 30, 14, 0.015, 0.003],
    Other: ['USDC', 'deposit into its main product on %c and confirm the position shows in its dashboard', 'Repeat one small interaction a week so the address shows sustained use', 2, 20, 0, 0.02, 0.003],
  };
  function money(x) { var a = Math.abs(x), s = a >= 100 ? String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : a.toFixed(2); return (x < 0 ? '-$' : '$') + s; }
  function pct(x) { return (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%'; }

  function farmPlan(p, v, odds, asOf) {
    var fam = family(p.category), a = ACT[fam] || ACT.Other, chain = p.chains[0] || 'Ethereum', gas = GAS[chain] === undefined ? 0.25 : GAS[chain];
    p.chains.forEach(function (c) { var g = GAS[c] === undefined ? 0.25 : GAS[c]; if (g < gas) { gas = g; chain = c; } });
    var ticket = K.TICKET, weeks = Math.round(K.FARM_DAYS / 7), yr = K.FARM_DAYS / 365;
    var bridge = chain === 'Ethereum' ? 0 : chain === 'Bitcoin' ? 5 : 1.5;
    var gasUsd = gas * (2 + a[3] + 2 + weeks + 2), carry = ticket * a[6] * yr;
    var age = v.age === null ? 700 : v.age, pExploit = (age < 365 ? 0.06 : age < 1095 ? 0.03 : 0.015) * (p.tvl_usd < 2e7 ? 1.5 : 1);
    var riskUsd = ticket * (pExploit * yr * K.LOSS_GIVEN_EXPLOIT + a[7]), riskPct = riskUsd / ticket;
    var total = gasUsd + 2 * bridge + carry + riskUsd;
    var reward = ((v.implied / K.LAUNCH_FLOAT) * K.AIRDROP_SHARE * (K.FARM_DAYS / K.SEASON_DAYS) * ticket) / Math.max(1, p.tvl_usd);
    var expected = odds * reward, beOdds = reward > 0 ? total / reward : Infinity;
    var verdict = expected > total * 1.5 ? 'farm' : expected > total ? 'marginal' : 'skip';
    var level = riskPct < 0.005 ? 'low' : riskPct < 0.012 ? 'medium' : 'high';
    var g = p.change_7d, trig = g === null ? 'TVL falls 20% in a week' : '7-day TVL change drops below ' + Math.min(-10, Math.round(g - 15)) + '% (now ' + (g >= 0 ? '+' : '') + g.toFixed(1) + '%)';
    var lock = a[5] ? a[5] + '-day exit queue or redemption' : 'no lockup, exit in one transaction';
    var steps = [
      ['Fund a fresh wallet on ' + chain + (p.chains.length > 1 ? ' (cheapest of its ' + p.chains.length + ' chains)' : '') + ' with ' + a[0] + ' and bookmark the app from its DefiLlama page, not a search ad', money(bridge + gas * 2) + ' bridge and gas', '15 min'],
      ['Test with $100: ' + a[1].replace(/%c/g, chain), money(gas * a[3]) + ' gas', a[4] + ' min'],
      ['Scale to the ' + money(ticket) + ' ticket once the test can be withdrawn; ' + lock, money(ticket) + ' capital, ' + money(carry) + ' carry over ' + K.FARM_DAYS + ' days', '10 min'],
      [a[2].replace(/%c/g, chain), money(gas * 2) + ' gas', '20 min'],
      ['Hold ' + K.FARM_DAYS + ' days with one small interaction a week (claim, compound or top up) and log each points snapshot', money(gas * weeks) + ' gas in all', '5 min a week, ' + weeks + ' weeks'],
      ['Risk ' + level + ': expected loss ' + money(riskUsd) + ' (' + pct(pExploit) + ' a year exploit odds for a ' + Math.round(age / 30) + '-month record, plus market risk). Exit or halve if the ' + trig + ' or a snapshot is announced', money(gas * 2 + bridge) + ' exit gas and bridge', '15 min'],
      ['Break-even: costs ' + money(total) + ' (gas ' + money(gasUsd) + ', bridge ' + money(2 * bridge) + ', carry ' + money(carry) + ', risk ' + money(riskUsd) + ') against ' + money(reward) + ' if a token launches; at ' + pct(odds) + ' token odds that is ' + money(expected) + ', break-even at ' + (beOdds > 1 ? 'over 100%' : pct(beOdds)) + ' odds: ' + (verdict === 'farm' ? 'farm it at this size' : verdict === 'marginal' ? 'marginal, farm only beside other positions on the chain' : 'skip, or farm only with spare capital already on the chain'), 'none', '2 min'],
    ];
    var day = function (d) { return new Date(Date.parse(asOf) + d * 864e5).toISOString().slice(0, 10); }, D = K.FARM_DAYS;
    steps = steps.map(function (x, i) { return { when: [day(0), day(0), day(1), day(2), day(2) + ' to ' + day(D), 'weekly, exit by ' + day(D), 'before ' + day(0)][i], do: x[0], cost: x[1], time: x[2] }; });
    return { chain: chain, ticket: ticket, lockup_days: a[5], risk: level, costs: { gas: r4(gasUsd), bridge: 2 * bridge, carry: r4(carry), risk: r4(riskUsd), total: r4(total) },
      reward: r4(reward), expected: r4(expected), net: r4(expected - total), breakeven_odds: isFinite(beOdds) ? r4(beOdds) : null, verdict: verdict,
      end: day(D), hours: r4((15 + a[4] + 10 + 20 + 5 * weeks + 15 + 2) / 60), steps: steps };
  }

  // ---- the board
  /** o overrides constants for this run only (the page's deposit, drop share and horizon controls). */
  function build(s, o) {
    var save = {}, k;
    for (k in o || {}) { save[k] = K[k]; K[k] = o[k]; }
    try { return run(s); } finally { for (k in save) K[k] = save[k]; }
  }
  function run(s) {
    var cal = calibrate(s), odds = oddsModel(s, cal.unknownAge), watch = {};
    s.watchlist.forEach(function (w) { watch[w] = true; });
    var priced = s.protocols.filter(function (p) { return !hasToken(p); }).map(function (p) { var cls = classify(p, s, watch); return { p: p, cls: cls, v: value(p, cls, s, cal) }; });
    var order = function (a, b) { return b.v.implied - a.v.implied || cmp(a.p.slug, b.p.slug); };
    var cands = priced.filter(function (x) { return x.cls !== 'derivative'; }).sort(order), aside = priced.filter(function (x) { return x.cls === 'derivative'; }).sort(order);
    var rows = cands.map(function (x, i) {
      var p = x.p, v = x.v, o = r4(odds.predict(p)), plan = farmPlan(p, v, o, s.as_of);
      return { rank: i + 1, slug: p.slug, name: p.name, implied_value_usd: v.implied, value_band_usd: v.band, token_odds: o, expected_value_usd: Math.round(o * v.implied),
        class: x.cls, category: p.category, family: family(p.category), chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, tokenless_days: v.age,
        core_value_usd: v.core, factors: { base: r4(v.parts.base), size: r4(v.parts.size), terms: r4(v.parts.terms), momentum: v.momentum, runway: v.runway, class_factor: v.classFactor },
        plan: plan,
        farm_steps: plan.steps.map(function (t) { return t.when + ': ' + t.do + '. Cost: ' + t.cost + '. Time: ' + t.time + '.'; }) };
    });
    var core = cal.core, live = s.protocols.filter(hasToken).length;
    return {
      model: K.MODEL, as_of: s.as_of, source: s.source, floor_usd: s.floor_usd, constants: Object.assign({}, K), rows: rows,
      counts: { protocols: s.protocols.length, live: live, comps: cal.comps.length, tokenless: priced.length, board: rows.length, watch: s.watchlist.length,
        watch_covered: rows.filter(function (r) { return watch[r.slug]; }).length, set_aside: aside.length },
      fit: { a: r4(core.a), b: r4(core.b), centre_tvl: Math.round(Math.exp(core.centre)), band: cal.band, unknown_age_days: cal.unknownAge, terms: cal.terms },
      test: cal.test, odds_test: odds.test,
      set_aside: aside.map(function (x) { return { slug: x.p.slug, name: x.p.name, category: x.p.category, tvl_usd: x.p.tvl_usd, change_7d: x.p.change_7d, reason: ruleFailure(x.p), implied_value_usd: x.v.implied }; }),
    };
  }

  root.RadarEngine = { K: K, build: build, family: family };
})(typeof window !== 'undefined' ? window : globalThis);
