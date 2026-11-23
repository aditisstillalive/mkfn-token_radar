// engine.js: the whole radar, snapshot in, ranked board out. main.ts runs this file to write board.json
// and data.js; the page loads it again and re-derives every row from the snapshot that data.js carries,
// so the screenshots show what this code computes. Plain script, no imports, no network, no names.
//
//   implied value  = fitted core value x momentum x runway x class                (value if it launches)
//   core value     = exp(a + b ln TVL + family effect + category effect)   ridge fit on trading tokens
//   token odds     = logistic(size, age, chains, family)            share of look-alikes carrying a token
//   expected value = token odds x implied value
//
// The core is fitted on the snapshot's own trading tokens and scored out of sample two ways: exact
// leave-one-out, and walk-forward (fit on the tokens DefiLlama tracked first, test on the newest third),
// each against two baselines. Its penalties are chosen by that leave-one-out score, not by hand.
(function (root) {
  'use strict';

  var K = {
    MODEL: 'fit-v3',
    LAMBDAS: [1, 3, 10, 30], // ridge penalties tried for the family and the category effects
    RATIO_MIN: 0.01, RATIO_MAX: 25, // a comp's mcap/TVL is clamped here before the log (leverage cap)
    GROWTH_FLOOR: -50, GROWTH_CAP: 60, // momentum prior: (1 + clamped 7d change)^1
    RUNWAY_FLOOR: 0.6, RUNWAY_RANGE: 0.4, RUNWAY_TAU: 365, // runway prior: floor + range (1 - e^-days/tau)
    PARENTED: 0.35, DERIVATIVE: 0.12, // class factors (derivatives are set aside off the board)
    ODDS_LAMBDA: 1, FOLDS: 5, // logistic ridge penalty and cross-validation folds for token odds
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

  // ---- linear algebra: a d x d inverse by Gauss-Jordan with partial pivoting ------------------------
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

  // ---- comps: one per trading token ---------------------------------------------------------------
  /** DefiLlama gives every product of a token the token's whole market cap, so products sharing a
   *  CoinGecko id (or symbol) are merged and their TVL summed. A token whose largest product fails the
   *  watchlist rule (a CEX, a bridge, a staking wrapper) prices an exchange or a base asset: dropped. */
  function buildComps(s) {
    var g = {}, keys = [], dropped = 0;
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
      if (mcap <= 0 || ruleFailure(lead)) { dropped++; return; }
      var tvl = m.reduce(function (a, x) { return a + x.tvl_usd; }, 0);
      comps.push({ slug: lead.slug, name: lead.name, symbol: lead.symbol, category: cat(lead), family: family(lead.category), listed_at: lead.listed_at,
        change_7d: lead.change_7d, tvl: tvl, mcap: mcap, ratio: mcap / tvl, members: m.length });
    });
    return { comps: comps.sort(function (a, b) { return b.mcap - a.mcap || cmp(a.slug, b.slug); }), dropped: dropped };
  }

  // ---- the fitted core: ln mcap = a + b (ln TVL - centre) + family + category ----------------------
  function lnTarget(c) { return Math.log(c.tvl * clamp(c.ratio, K.RATIO_MIN, K.RATIO_MAX)); }
  function fitCore(train, lf, lc) {
    var cats = [], centre = train.reduce(function (a, c) { return a + Math.log(c.tvl); }, 0) / train.length;
    train.forEach(function (c) { if (cats.indexOf(c.category) < 0) cats.push(c.category); });
    cats.sort(cmp);
    function row(category, tvl) {
      var f = family(category === 'Uncategorised' ? null : category);
      return [1, Math.log(Math.max(1, tvl)) - centre].concat(FAMS.map(function (x) { return x === f ? 1 : 0; }), cats.map(function (x) { return x === category ? 1 : 0; }));
    }
    var pen = [1e-9, 1e-9].concat(FAMS.map(function () { return lf; }), cats.map(function () { return lc; }));
    var X = train.map(function (c) { return row(c.category, c.tvl); }), y = train.map(lnTarget), fit = ridge(X, y, pen);
    var w = fit.w;
    return {
      lf: lf, lc: lc, centre: centre, a: w[0], b: w[1],
      famEffect: function (f) { return w[2 + FAMS.indexOf(f)]; },
      catEffect: function (category) { var i = cats.indexOf(category); return i < 0 ? 0 : w[2 + FAMS.length + i]; },
      predict: function (category, tvl) { return dot(w, row(category, tvl)); },
      loo: X.map(function (x, i) { return y[i] - (y[i] - dot(w, x)) / (1 - fit.h[i]); }), // exact LOO prediction
    };
  }
  /** Out-of-sample scores of predictions (ln) against actual ln market caps. */
  function score(pred, act) {
    var e = pred.map(function (p, i) { return act[i] - p; }), ae = e.map(Math.abs);
    var rank = function (x) { var o = x.map(function (v, i) { return [v, i]; }).sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; }), r = []; o.forEach(function (v, j) { r[v[1]] = j; }); return r; };
    var ra = rank(pred), rb = rank(act), n = pred.length, d2 = 0;
    for (var i = 0; i < n; i++) d2 += (ra[i] - rb[i]) * (ra[i] - rb[i]);
    return { n: n, rmse: r4(Math.sqrt(dot(e, e) / n)), median_x: r4(Math.exp(median(ae))), within_3x: r4(ae.filter(function (x) { return x < Math.log(3); }).length / n),
      spearman: n > 2 ? r4(1 - (6 * d2) / (n * (n * n - 1))) : 0, bias: r4(e.reduce(function (a, x) { return a + x; }, 0) / n) };
  }
  /** Baseline 1: one flat multiple (geometric mean mcap/TVL of the training comps) times TVL. */
  function flat(train) { var m = train.reduce(function (a, c) { return a + Math.log(clamp(c.ratio, K.RATIO_MIN, K.RATIO_MAX)); }, 0) / train.length; return function (c) { return Math.log(c.tvl) + m; }; }

  function calibrate(s) {
    var built = buildComps(s), comps = built.comps, act = comps.map(lnTarget);
    // Penalties: every pair on the grid, scored by exact leave-one-out RMSE; the best pair is kept.
    var grid = [];
    K.LAMBDAS.forEach(function (lf) { K.LAMBDAS.forEach(function (lc) { var f = fitCore(comps, lf, lc); grid.push({ lf: lf, lc: lc, fit: f, s: score(f.loo, act) }); }); });
    var best = grid.slice().sort(function (a, b) { return a.s.rmse - b.s.rmse || a.lf - b.lf || a.lc - b.lc; })[0], core = best.fit;
    // Baselines under the same leave-one-out: a flat multiple, and size alone (no family or category).
    var tot = act.reduce(function (a, x, i) { return a + x - Math.log(comps[i].tvl); }, 0);
    var flatLoo = comps.map(function (c, i) { return Math.log(c.tvl) + (tot - (act[i] - Math.log(c.tvl))) / (comps.length - 1); });
    var sizeOnly = fitCore(comps.map(function (c) { return Object.assign({}, c, { category: 'Uncategorised' }); }), 1e6, 1e6);
    // Walk-forward: fit on the tokens DefiLlama tracked first (two thirds), predict the newest third.
    var byDate = comps.slice().sort(function (a, b) { return cmp(a.listed_at || '0000', b.listed_at || '0000') || cmp(a.slug, b.slug); });
    var cut = Math.floor((byDate.length * 2) / 3), train = byDate.slice(0, cut), test = byDate.slice(cut);
    var wf = fitCore(train, best.lf, best.lc), wfFlat = flat(train);
    var wfSize = fitCore(train.map(function (c) { return Object.assign({}, c, { category: 'Uncategorised' }); }), 1e6, 1e6);
    var tAct = test.map(lnTarget);
    // The momentum and runway priors are not fitted (a comp's age is not tokenless age); this checks
    // that applying them to the comps does not worsen the out-of-sample error much.
    var withPriors = core.loo.map(function (x, i) { var c = comps[i], a = ageDays(s.as_of, c.listed_at); return x + Math.log(momentum(c.change_7d)) + Math.log(runway(a === null ? 0 : a)); });
    var resid = core.loo.map(function (x, i) { return act[i] - x; });
    var ages = s.protocols.filter(function (p) { return !hasToken(p); }).map(function (p) { return ageDays(s.as_of, p.listed_at); }).filter(function (a) { return a !== null; });
    return {
      comps: comps, dropped: built.dropped, core: core, unknownAge: Math.round(median(ages)),
      band: [r4(Math.exp(quantile(resid, 0.1))), r4(Math.exp(quantile(resid, 0.9)))],
      test: {
        chosen: { family_lambda: best.lf, category_lambda: best.lc },
        grid: grid.map(function (g) { return { lf: g.lf, lc: g.lc, rmse: g.s.rmse }; }),
        loo: { model: score(core.loo, act), size_only: score(sizeOnly.loo, act), flat: score(flatLoo, act), with_priors: score(withPriors, act) },
        walk_forward: { train: train.length, test: test.length, cut_listed: test.length ? test[0].listed_at : null,
          model: score(test.map(function (c) { return wf.predict(c.category, c.tvl); }), tAct),
          size_only: score(test.map(function (c) { return wfSize.predict('Uncategorised', c.tvl); }), tAct),
          flat: score(test.map(wfFlat), tAct) },
        points: comps.map(function (c, i) { return [c.slug, r4(act[i]), r4(core.loo[i])]; }),
      },
    };
  }

  function momentum(g) { return 1 + clamp(g === null || g === undefined ? 0 : g, K.GROWTH_FLOOR, K.GROWTH_CAP) / 100; }
  function runway(age) { return K.RUNWAY_FLOOR + K.RUNWAY_RANGE * (1 - Math.exp(-age / K.RUNWAY_TAU)); }

  // ---- token odds: a logistic fit of "carries a token" on the protocol's profile --------------------
  function oddsModel(s, unknownAge) {
    var pop = s.protocols.filter(function (p) { return !ruleFailure(p) && p.tvl_usd > 0; });
    var centre = pop.reduce(function (a, p) { return a + Math.log(p.tvl_usd); }, 0) / pop.length;
    function row(p) {
      var a = ageDays(s.as_of, p.listed_at), f = family(p.category);
      return [1, Math.log(p.tvl_usd) - centre, Math.log1p((a === null ? unknownAge : a) / 365), Math.log(Math.max(1, p.chains.length))].concat(FAMS.map(function (x) { return x === f ? 1 : 0; }));
    }
    function fit(rows) { // Newton-Raphson on the penalised log-likelihood, a fixed 12 steps (converged well before)
      var d = rows[0].x.length, w = new Array(d).fill(0);
      for (var it = 0; it < 12; it++) {
        var H = [], g = new Array(d).fill(0), j, k;
        for (j = 0; j < d; j++) { H.push(new Array(d).fill(0)); H[j][j] = j ? K.ODDS_LAMBDA : 1e-6; g[j] = j ? -K.ODDS_LAMBDA * w[j] : 0; }
        rows.forEach(function (r) { var q = 1 / (1 + Math.exp(-dot(w, r.x))); for (j = 0; j < d; j++) { g[j] += (r.y - q) * r.x[j]; for (k = 0; k < d; k++) H[j][k] += q * (1 - q) * r.x[j] * r.x[k]; } });
        var Hi = inverse(H);
        w = w.map(function (v, j2) { return v + dot(Hi[j2], g); });
      }
      return function (x) { return 1 / (1 + Math.exp(-dot(w, x))); };
    }
    var rows = pop.map(function (p, i) { return { x: row(p), y: hasToken(p) ? 1 : 0, fold: i % K.FOLDS }; });
    var cv = [];
    for (var f = 0; f < K.FOLDS; f++) {
      var m = fit(rows.filter(function (r) { return r.fold !== f; }));
      rows.forEach(function (r) { if (r.fold === f) cv.push([m(r.x), r.y]); });
    }
    var base = rows.filter(function (r) { return r.y; }).length / rows.length;
    var ll = function (q, y) { q = clamp(q, 1e-6, 1 - 1e-6); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };
    var pos = cv.filter(function (c) { return c[1]; }), neg = cv.filter(function (c) { return !c[1]; }), wins = 0;
    pos.forEach(function (a) { neg.forEach(function (b) { wins += a[0] > b[0] ? 1 : a[0] === b[0] ? 0.5 : 0; }); });
    var full = fit(rows);
    return { predict: function (p) { return full(row(p)); },
      test: { n: rows.length, with_token: Math.round(base * rows.length), base_rate: r4(base), folds: K.FOLDS, auc: r4(wins / Math.max(1, pos.length * neg.length)),
        log_loss: r4(cv.reduce(function (a, c) { return a + ll(c[0], c[1]); }, 0) / cv.length), base_log_loss: r4(cv.reduce(function (a, c) { return a + ll(base, c[1]); }, 0) / cv.length) } };
  }

  // ---- valuation -----------------------------------------------------------------------------------
  function classify(p, s, watch) {
    if (watch[p.slug]) return 'watch';
    if (ruleFailure(p)) return 'derivative';
    return p.tvl_usd >= s.floor_usd ? 'parented' : 'early';
  }
  function value(p, cls, s, cal) {
    var core = cal.core, c = cat(p), f = family(p.category), age = ageDays(s.as_of, p.listed_at);
    var parts = { base: Math.exp(core.a), size: Math.exp(core.b * (Math.log(Math.max(1, p.tvl_usd)) - core.centre)), family: Math.exp(core.famEffect(f)), category: Math.exp(core.catEffect(c)) };
    var coreUsd = Math.exp(core.predict(c, p.tvl_usd));
    var mo = momentum(p.change_7d), ru = runway(age === null ? cal.unknownAge : age), cf = cls === 'derivative' ? K.DERIVATIVE : cls === 'parented' ? K.PARENTED : 1;
    var implied = Math.max(1, Math.round(coreUsd * mo * ru * cf));
    return { implied: implied, core: Math.round(coreUsd), parts: parts, momentum: r4(mo), runway: r4(ru), classFactor: cf, age: age,
      band: [Math.round(implied * cal.band[0]), Math.round(implied * cal.band[1])] };
  }

  // ---- farm plans: steps with capital, gas and bridge, lockup, risk and break-even -------------------
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
  function nice(x) { var e = Math.pow(10, Math.floor(Math.log10(x))), m = x / e; return (m < 1.5 ? 1 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * e; }
  function pct(x) { return (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%'; }

  function farmPlan(p, v, odds) {
    var fam = family(p.category), a = ACT[fam] || ACT.Other, chain = p.chains[0] || 'Ethereum', gas = GAS[chain] === undefined ? 0.25 : GAS[chain];
    p.chains.forEach(function (c) { var g = GAS[c] === undefined ? 0.25 : GAS[c]; if (g < gas) { gas = g; chain = c; } });
    var ticket = Math.min(10000, Math.max(250, nice(p.tvl_usd / 50000))), weeks = Math.round(K.FARM_DAYS / 7), yr = K.FARM_DAYS / 365;
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
      ['Scale to the ' + money(ticket) + ' ticket (about 1/50,000 of its TVL) once the test can be withdrawn; ' + lock, money(ticket) + ' capital, ' + money(carry) + ' carry over ' + K.FARM_DAYS + ' days', '10 min'],
      [a[2].replace(/%c/g, chain), money(gas * 2) + ' gas', '20 min'],
      ['Hold ' + K.FARM_DAYS + ' days with one small interaction a week (claim, compound or top up) and log each points snapshot', money(gas * weeks) + ' gas in all', '5 min a week, ' + weeks + ' weeks'],
      ['Risk ' + level + ': expected loss ' + money(riskUsd) + ' (' + pct(pExploit) + ' a year exploit odds for a ' + Math.round(age / 30) + '-month record, plus market risk). Exit or halve if the ' + trig + ' or a snapshot is announced', money(gas * 2 + bridge) + ' exit gas and bridge', '15 min'],
      ['Break-even: costs ' + money(total) + ' (gas ' + money(gasUsd) + ', bridge ' + money(2 * bridge) + ', carry ' + money(carry) + ', risk ' + money(riskUsd) + ') against ' + money(reward) + ' if a token launches; at ' + pct(odds) + ' token odds that is ' + money(expected) + ', break-even at ' + (beOdds > 1 ? 'over 100%' : pct(beOdds)) + ' odds: ' + (verdict === 'farm' ? 'farm it at this size' : verdict === 'marginal' ? 'marginal, farm only beside other positions on the chain' : 'skip, or farm only with spare capital already on the chain'), 'none', '2 min'],
    ].map(function (x) { return { do: x[0], cost: x[1], time: x[2] }; });
    return { chain: chain, ticket: ticket, lockup_days: a[5], risk: level, costs: { gas: r4(gasUsd), bridge: 2 * bridge, carry: r4(carry), risk: r4(riskUsd), total: r4(total) },
      reward: r4(reward), expected: r4(expected), net: r4(expected - total), breakeven_odds: isFinite(beOdds) ? r4(beOdds) : null, verdict: verdict,
      hours: r4((15 + a[4] + 10 + 20 + 5 * weeks + 15 + 2) / 60), steps: steps };
  }

  // ---- the board ----------------------------------------------------------------------------------
  function build(s) {
    var cal = calibrate(s), odds = oddsModel(s, cal.unknownAge), watch = {};
    s.watchlist.forEach(function (w) { watch[w] = true; });
    var priced = s.protocols.filter(function (p) { return !hasToken(p); }).map(function (p) { var cls = classify(p, s, watch); return { p: p, cls: cls, v: value(p, cls, s, cal) }; });
    var order = function (a, b) { return b.v.implied - a.v.implied || cmp(a.p.slug, b.p.slug); };
    var cands = priced.filter(function (x) { return x.cls !== 'derivative'; }).sort(order), aside = priced.filter(function (x) { return x.cls === 'derivative'; }).sort(order);
    var rows = cands.map(function (x, i) {
      var p = x.p, v = x.v, o = r4(odds.predict(p)), plan = farmPlan(p, v, o);
      return { rank: i + 1, slug: p.slug, name: p.name, implied_value_usd: v.implied, value_band_usd: v.band, token_odds: o, expected_value_usd: Math.round(o * v.implied),
        class: x.cls, category: p.category, family: family(p.category), chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, tokenless_days: v.age,
        core_value_usd: v.core, factors: { base: r4(v.parts.base), size: r4(v.parts.size), family: r4(v.parts.family), category: r4(v.parts.category), momentum: v.momentum, runway: v.runway, class_factor: v.classFactor },
        est_per_1k_usd: Math.round((plan.reward / plan.ticket) * 1e5) / 100, plan: plan,
        farm_steps: plan.steps.map(function (t) { return t.do + '. Cost: ' + t.cost + '. Time: ' + t.time + '.'; }) };
    });
    var core = cal.core, live = s.protocols.filter(hasToken).length, nullG = s.protocols.filter(function (p) { return !hasToken(p) && p.change_7d === null; }).length;
    return {
      model: K.MODEL, as_of: s.as_of, source: s.source, floor_usd: s.floor_usd, constants: K, rows: rows,
      counts: { protocols: s.protocols.length, live: live, comps: cal.comps.length, comps_dropped: cal.dropped, tokenless: priced.length, board: rows.length, watch: s.watchlist.length,
        watch_covered: rows.filter(function (r) { return watch[r.slug]; }).length, set_aside: aside.length, unknown_age: priced.filter(function (x) { return x.v.age === null; }).length, null_7d: nullG },
      fit: { a: r4(core.a), b: r4(core.b), centre_tvl: Math.round(Math.exp(core.centre)), band: cal.band, unknown_age_days: cal.unknownAge,
        families: FAMS.map(function (f) { return { family: f, comps: cal.comps.filter(function (c) { return c.family === f; }).length, effect: r4(Math.exp(core.famEffect(f))) }; }),
        categories: Object.keys(cal.comps.reduce(function (m, c) { m[c.category] = 1; return m; }, {})).sort(cmp).map(function (c) { return { category: c, comps: cal.comps.filter(function (x) { return x.category === c; }).length, effect: r4(Math.exp(core.catEffect(c))) }; }) },
      test: cal.test, odds_test: odds.test,
      set_aside: aside.map(function (x) { return { slug: x.p.slug, name: x.p.name, category: x.p.category, tvl_usd: x.p.tvl_usd, change_7d: x.p.change_7d, reason: ruleFailure(x.p), implied_value_usd: x.v.implied }; }),
      comps: cal.comps.map(function (c) { return { slug: c.slug, name: c.name, symbol: c.symbol, category: c.category, tvl_usd: c.tvl, mcap_usd: c.mcap, ratio: r4(c.ratio), members: c.members }; }),
    };
  }

  root.RadarEngine = { K: K, build: build, family: family };
})(typeof window !== 'undefined' ? window : globalThis);
