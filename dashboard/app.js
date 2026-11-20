// Token Radar dashboard: reads window.RADAR (data.js, written by main.ts) and renders three views,
// the ranked board with filters and a detail panel, the set-aside list, and the model with its comps.
// State lives in the URL hash (#/board?cls=early&sel=slug) so every view can be linked and captured.
(function () {
  'use strict';
  var R = window.RADAR;
  var app = document.getElementById('app');
  if (!R) { app.innerHTML = '<p class="empty">data.js is missing: run main.ts to write it beside the dashboard.</p>'; return; }

  var CLS = ['watch', 'early', 'parented'];
  var CLS_COLOR = { watch: 'var(--sig)', early: 'var(--amber)', parented: 'var(--violet)' };
  var bySlug = {};
  R.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var MAXV = R.rows.length ? R.rows[0].implied_value_usd : 1;

  // ---- formatting -------------------------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(x) {
    if (x == null) return '–';
    var a = Math.abs(x);
    if (a >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (x / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e3) return '$' + (x / 1e3).toFixed(0) + 'K';
    return '$' + x.toFixed(2);
  }
  function pct(x) { return x == null ? '<span class="sub">n/a</span>' : '<span class="' + (x >= 0 ? 'pos' : 'neg') + '">' + (x >= 0 ? '+' : '') + x.toFixed(1) + '%</span>'; }
  function days(d) { return d == null ? '<span class="sub">unknown</span>' : d >= 365 ? (d / 365).toFixed(1) + ' y' : d + ' d'; }
  function mult(x) { return '×' + x.toFixed(3); }
  function badge(c) { return '<span class="badge b-' + c + '">' + esc(R.class_label[c] || c) + '</span>'; }
  function net(r) { return r.est_per_1k_usd * r.plan.ticketUsd / 1000 - r.plan.costUsd; }
  function evClass(r) { var e = r.est_per_1k_usd * r.plan.ticketUsd / 1000; return e > r.plan.costUsd * 1.5 ? 'ev-good' : e > r.plan.costUsd ? 'ev-meh' : 'ev-bad'; }

  // ---- state in the hash --------------------------------------------------------------------------
  var st = { tab: 'board', q: '', cls: CLS.slice(), cat: '', chain: '', min: 0, grow: false, sort: 'rank', asc: true, sel: '' };
  function readHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('?');
    st.tab = ['board', 'aside', 'model'].indexOf(parts[0]) >= 0 ? parts[0] : 'board';
    var p = new URLSearchParams(parts[1] || '');
    st.q = p.get('q') || '';
    st.cls = p.get('cls') ? p.get('cls').split(',').filter(function (c) { return CLS.indexOf(c) >= 0; }) : CLS.slice();
    st.cat = p.get('cat') || '';
    st.chain = p.get('chain') || '';
    st.min = +p.get('min') || 0;
    st.grow = p.get('grow') === '1';
    st.sort = p.get('sort') || 'rank';
    st.asc = p.get('dir') ? p.get('dir') === 'asc' : st.sort === 'rank';
    st.sel = p.get('sel') || '';
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (st.cls.length !== CLS.length) p.set('cls', st.cls.join(','));
    if (st.cat) p.set('cat', st.cat);
    if (st.chain) p.set('chain', st.chain);
    if (st.min) p.set('min', st.min);
    if (st.grow) p.set('grow', '1');
    if (st.sort !== 'rank') { p.set('sort', st.sort); p.set('dir', st.asc ? 'asc' : 'desc'); }
    if (st.sel) p.set('sel', st.sel);
    var s = p.toString();
    history.replaceState(null, '', '#/' + st.tab + (s ? '?' + s : ''));
  }

  // ---- header -----------------------------------------------------------------------------------
  function header() {
    document.getElementById('ver').textContent = R.model;
    document.getElementById('asof').textContent = 'Snapshot ' + R.as_of + ' · DefiLlama · offline';
    document.getElementById('n-aside').textContent = R.counts.set_aside;
    var total = R.rows.reduce(function (a, r) { return a + r.implied_value_usd; }, 0);
    var watchIn = R.rows.filter(function (r) { return r.class === 'watch'; }).length;
    var k = [
      ['Ranked board', R.counts.board, 'tokenless candidates'],
      ['Watchlist covered', watchIn + ' / ' + R.counts.watch, 'every slug on the floor list', watchIn === R.counts.watch],
      ['Early, below floor', R.rows.filter(function (r) { return r.class === 'early'; }).length, 'the radar\'s own finds'],
      ['Implied value, all rows', money(total), 'if records stayed as they are'],
      ['Priced comps', R.calibration.comps, 'live tokens with a market cap'],
      ['Median comp ×TVL', mult(R.calibration.global_multiple), 'geometric mean, all comps'],
    ];
    document.getElementById('kpis').innerHTML = k.map(function (x) {
      return '<div class="kpi"><div class="k">' + x[0] + '</div><div class="v' + (x[3] ? ' ok' : '') + '">' + x[1] + '</div><div class="s">' + x[2] + '</div></div>';
    }).join('');
  }

  // ---- board ------------------------------------------------------------------------------------
  var COLS = [
    ['rank', '#', 'r'], ['name', 'Protocol'], ['class', 'Class', 'x2'], ['chains', 'Chains', 'x2'], ['tvl_usd', 'TVL', 'r'], ['change_7d', '7d', 'r'],
    ['tokenless_days', 'No token for', 'r'], ['implied_value_usd', 'Implied value', 'r'], ['x', '×TVL', 'r x2'], ['est_per_1k_usd', 'Est. drop per $1k', 'r'], ['net', 'Net on ticket', 'r x2'],
  ];
  function sortVal(r, k) {
    if (k === 'x') return r.implied_value_usd / r.tvl_usd;
    if (k === 'net') return net(r);
    if (k === 'chains') return r.chains.length;
    if (k === 'name' || k === 'class') return String(r[k]).toLowerCase();
    var v = r[k];
    return v == null ? -Infinity : v;
  }
  function filtered() {
    var q = st.q.toLowerCase();
    var rows = R.rows.filter(function (r) {
      if (st.cls.indexOf(r.class) < 0) return false;
      if (st.cat && r.category !== st.cat) return false;
      if (st.chain && r.chains.indexOf(st.chain) < 0) return false;
      if (st.min && r.tvl_usd < st.min) return false;
      if (st.grow && !(r.change_7d > 0)) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    rows.sort(function (a, b) {
      var x = sortVal(a, st.sort), y = sortVal(b, st.sort);
      var c = x < y ? -1 : x > y ? 1 : a.rank - b.rank;
      return st.asc ? c : -c;
    });
    return rows;
  }
  function options(values, current, all) {
    return '<option value="">' + all + '</option>' + values.map(function (v) { return '<option' + (v[0] === current ? ' selected' : '') + ' value="' + esc(v[0]) + '">' + esc(v[0]) + ' (' + v[1] + ')</option>'; }).join('');
  }
  function tally(key) {
    var m = {};
    R.rows.forEach(function (r) { (key === 'chains' ? r.chains : [r.category || 'Uncategorised']).forEach(function (v) { m[v] = (m[v] || 0) + 1; }); });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a] || a.localeCompare(b); }).map(function (k) { return [k, m[k]]; });
  }
  var CATS = tally('category'), CHAINS = tally('chains');

  function board() {
    var rows = filtered();
    var sel = st.sel && bySlug[st.sel];
    var f = '<div class="filters">' +
      '<input type="search" id="q" placeholder="Search name, category, chain" value="' + esc(st.q) + '" aria-label="Search">' +
      CLS.map(function (c) { return '<button class="chip" data-cls="' + c + '" aria-pressed="' + (st.cls.indexOf(c) >= 0) + '"><i style="background:' + CLS_COLOR[c] + '"></i>' + esc(R.class_label[c]) + '</button>'; }).join('') +
      '<select id="cat" aria-label="Category">' + options(CATS, st.cat, 'All categories') + '</select>' +
      '<select id="chain" aria-label="Chain">' + options(CHAINS.slice(0, 40), st.chain, 'All chains') + '</select>' +
      '<select id="min" aria-label="Minimum TVL">' + [[0, 'Any TVL'], [1e7, 'TVL ≥ $10M'], [2.5e7, 'TVL ≥ $25M'], [5e7, 'TVL ≥ $50M'], [2e8, 'TVL ≥ $200M']].map(function (o) { return '<option value="' + o[0] + '"' + (st.min === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      '<button class="chip" id="grow" aria-pressed="' + st.grow + '">7d growth &gt; 0</button>' +
      '<button class="reset" id="reset">Reset</button>' +
      '<span class="count">' + rows.length + ' of ' + R.rows.length + ' rows · ranked by implied value</span></div>';
    var head = '<tr>' + COLS.map(function (c) { return '<th data-k="' + c[0] + '" class="' + (c[2] || '') + (st.sort === c[0] ? ' on' + (st.asc ? ' asc' : '') : '') + '">' + c[1] + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r) {
      var w = Math.max(2, Math.sqrt(r.implied_value_usd / MAXV) * 100);
      var n = net(r);
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === st.sel ? ' class="sel"' : '') + '>' +
        '<td class="r num">' + r.rank + '</td>' +
        '<td><div class="nm"><i class="cd" title="' + esc(R.class_label[r.class]) + '" style="background:' + CLS_COLOR[r.class] + '"></i>' + esc(r.name) + '</div><div class="sub">' + esc(r.category || 'Uncategorised') + '</div></td>' +
        '<td class="x2">' + badge(r.class) + '</td>' +
        '<td class="sub x2">' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="r num">' + money(r.tvl_usd) + '</td>' +
        '<td class="r num">' + pct(r.change_7d) + '</td>' +
        '<td class="r num">' + days(r.tokenless_days) + '</td>' +
        '<td class="r bar num"><b>' + money(r.implied_value_usd) + '</b><span style="width:' + w.toFixed(1) + '%"></span></td>' +
        '<td class="r num x2">' + (r.implied_value_usd / r.tvl_usd).toFixed(3) + '</td>' +
        '<td class="r num">$' + r.est_per_1k_usd.toFixed(2) + '</td>' +
        '<td class="r num x2 ' + evClass(r) + '">' + (n >= 0 ? '+' : '−') + money(Math.abs(n)) + '</td></tr>';
    }).join('');
    var table = '<div class="tbl"><div class="scroll"><table><thead>' + head + '</thead><tbody>' + (body || '<tr><td colspan="11" class="empty">No protocol matches these filters.</td></tr>') + '</tbody></table></div></div>';
    app.innerHTML = f + '<div class="split' + (sel ? ' has-sel' : ' solo') + '"><div>' + table + '</div>' + (sel ? detail(sel) : '') + '</div>';
    wireBoard();
    var on = app.querySelector('tr.sel');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function waterfall(r) {
    var f = r.factors, steps = [
      ['TVL', r.tvl_usd, ''],
      ['Category ×' + f.category_multiple.toFixed(3), r.tvl_usd * f.category_multiple, 'cut'],
    ];
    var v = steps[1][1];
    [['Size', f.size], ['Momentum', f.momentum], ['Runway', f.runway], ['Class', f.class_factor]].forEach(function (x) {
      v *= x[1];
      steps.push([x[0] + ' ' + mult(x[1]), v, x[1] >= 1 ? 'up' : 'cut']);
    });
    steps[steps.length - 1][2] = 'end';
    steps[steps.length - 1][0] = 'Implied value';
    var top = r.tvl_usd;
    return '<div class="wf">' + steps.map(function (s) {
      return '<div>' + esc(s[0]) + '</div><div class="t"><span class="' + s[2] + '" style="width:' + Math.max(0.6, Math.sqrt(s[1] / top) * 100).toFixed(1) + '%"></span></div><div class="x">' + money(s[1]) + '</div>';
    }).join('') + '</div><div class="note">Bars on a square-root scale. Each factor is computed from this protocol\'s own record; the category multiple comes from ' + plural(catInfo(r.category).comps || 0, 'trading comp') + ' in ' + esc(r.category || 'Uncategorised') + ', shrunk toward the ' + esc(famInfo(catInfo(r.category).family).family) + ' family at ' + mult(famInfo(catInfo(r.category).family).multiple) + ' (' + plural(famInfo(catInfo(r.category).family).comps, 'comp') + '), itself shrunk toward all comps at ' + mult(R.calibration.global_multiple) + '.</div>';
  }
  function compsOf(r) {
    var k = r.category || 'Uncategorised';
    var cs = R.comps.filter(function (c) { return c.category === k; }).slice(0, 5);
    if (!cs.length) return '<div class="note">No token in ' + esc(k) + ' trades with a market cap in this snapshot, so the all-comps multiple ' + mult(R.calibration.global_multiple) + ' is used.</div>';
    return '<table class="mini"><thead><tr><th>Comp in ' + esc(k) + '</th><th class="r">TVL</th><th class="r">Mcap</th><th class="r">×TVL</th></tr></thead><tbody>' + cs.map(function (c) {
      return '<tr><td>' + esc(c.name) + ' <span class="sub">' + esc(c.symbol || '') + '</span></td><td class="r num">' + money(c.tvl_usd) + '</td><td class="r num">' + money(c.mcap_usd) + '</td><td class="r num">' + c.ratio.toFixed(3) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  function famInfo(f) {
    var fs = R.calibration.families;
    for (var i = 0; i < fs.length; i++) if (fs[i].family === f) return fs[i];
    return { family: 'Other', comps: 0, multiple: R.calibration.global_multiple };
  }
  function catInfo(c) {
    var k = c || 'Uncategorised';
    for (var i = 0; i < R.calibration.categories.length; i++) if (R.calibration.categories[i].category === k) return R.calibration.categories[i];
    return { comps: 0, raw: null, family: 'Other', multiple: R.calibration.global_multiple };
  }
  function detail(r) {
    var p = r.plan, n = net(r), ev = r.est_per_1k_usd * p.ticketUsd / 1000;
    return '<aside class="detail" aria-label="Protocol detail">' +
      '<button class="close" id="close" aria-label="Close detail">✕</button>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<div class="meta">#' + r.rank + ' of ' + R.counts.board + ' · ' + badge(r.class) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + '</div>' +
      '<div class="big"><div><div class="l">Implied token value</div><div class="v">' + money(r.implied_value_usd) + '</div></div>' +
      '<div><div class="l">Farmer pool (' + (R.constants.AIRDROP_SHARE * 100).toFixed(1) + '%)</div><div class="num" style="font-size:18px">' + money(r.airdrop_pool_usd) + '</div></div></div>' +
      '<h3>Record</h3><div class="facts">' +
      fact('TVL', money(r.tvl_usd)) + fact('7-day change', pct(r.change_7d)) + fact('Tokenless for', days(r.tokenless_days)) +
      fact('Value ÷ TVL', mult(r.implied_value_usd / r.tvl_usd)) + fact('Drop / $1k · 90d', '$' + r.est_per_1k_usd.toFixed(2)) + fact('Farm chain', esc(p.chain)) + '</div>' +
      '<h3>How the value is built</h3>' + waterfall(r) +
      compsOf(r) +
      '<h3>Farm plan · ' + money(p.ticketUsd) + ' ticket · ~$' + p.costUsd.toFixed(2) + ' fees · ~' + p.hours + ' h of work</h3>' +
      '<ol class="steps">' + p.steps.map(function (s) {
        return '<li><div>' + esc(s.do) + '</div><div class="tags"><span class="tag c">cost ' + esc(s.cost) + '</span><span class="tag t">time ' + esc(s.time) + '</span></div></li>';
      }).join('') + '</ol>' +
      '<div class="stance"><b>Timing.</b> ' + esc(p.stance) + ' Expected drop on the ticket ' + money(ev) + ', net of fees <b class="' + evClass(r) + '">' + (n >= 0 ? '+' : '−') + money(Math.abs(n)) + '</b>.</div>' +
      '<div class="note">DefiLlama records no token for ' + esc(r.name) + '; that is not proof it has none. Implied value is this model\'s claim if the record stayed as it is, not a forecast that a token launches.</div>' +
      '</aside>';
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function fact(k, v) { return '<div class="fact"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }

  function wireBoard() {
    var q = document.getElementById('q');
    q.addEventListener('input', function () { st.q = q.value; go(true); });
    app.querySelectorAll('[data-cls]').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = b.getAttribute('data-cls'), i = st.cls.indexOf(c);
        if (i >= 0) st.cls.splice(i, 1); else st.cls.push(c);
        go();
      });
    });
    ['cat', 'chain', 'min'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', function (e) { st[id] = id === 'min' ? +e.target.value : e.target.value; go(); });
    });
    document.getElementById('grow').addEventListener('click', function () { st.grow = !st.grow; go(); });
    document.getElementById('reset').addEventListener('click', function () { st.q = ''; st.cls = CLS.slice(); st.cat = st.chain = ''; st.min = 0; st.grow = false; st.sort = 'rank'; st.asc = true; go(); });
    app.querySelectorAll('th[data-k]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-k');
        if (st.sort === k) st.asc = !st.asc; else { st.sort = k; st.asc = k === 'rank' || k === 'name'; }
        go();
      });
    });
    app.querySelectorAll('tbody tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () { var s = tr.getAttribute('data-slug'); st.sel = st.sel === s ? '' : s; go(); });
    });
    var c = document.getElementById('close');
    if (c) c.addEventListener('click', function () { st.sel = ''; go(); });
  }

  // ---- set aside ----------------------------------------------------------------------------------
  function aside() {
    app.innerHTML = '<div class="prose"><p>These ' + R.counts.set_aside + ' protocols record no token on DefiLlama, but each fails the watchlist\'s own rule: a CEX\'s reserve wallets, a liquid-staking or bridged wrapper, or a versioned product. Their value already trades as another token (BTC in WBTC, ETH in a staked-ETH wrapper, the exchange\'s own coin), so they are kept off the ranked board. The model still prices them with a class factor of ' + mult(R.constants.DERIVATIVE_FACTOR) + ' for reference.</p></div>' +
      '<div class="tbl"><div class="scroll"><table><thead><tr><th>Protocol</th><th>Category</th><th>Why set aside</th><th class="r">TVL</th><th class="r">7d</th><th class="r">Reference value</th></tr></thead><tbody>' +
      R.set_aside.map(function (r) { return '<tr><td class="nm">' + esc(r.name) + '</td><td class="sub">' + esc(r.category || '–') + '</td><td>' + esc(r.reason) + '</td><td class="r num">' + money(r.tvl_usd) + '</td><td class="r num">' + pct(r.change_7d) + '</td><td class="r num sub">' + money(r.implied_value_usd) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }

  // ---- model --------------------------------------------------------------------------------------
  function model() {
    var K = R.constants, C = R.calibration;
    var cats = C.categories.slice().sort(function (a, b) { return b.comps - a.comps || a.category.localeCompare(b.category); });
    app.innerHTML = '<div class="prose">' +
      '<p>What would each protocol\'s token be worth if its record stayed exactly as the snapshot shows it? The model prices it against the snapshot\'s own ' + C.comps + ' trading tokens: one comp per token, its market cap over the summed TVL of every product that carries it, leaving out tokens whose main product is a CEX, a bridge, a staking wrapper or a versioned fork. No protocol is named in the code; every number below is recomputed from the snapshot on each run.</p>' +
      '<div class="formula">implied = TVL × category multiple × size × momentum × runway × class<br>' +
      'category multiple = exp( (Σ ln(mcap/TVL) of its comps + ' + K.PRIOR_WEIGHT + ' × family ln) / (n + ' + K.PRIOR_WEIGHT + ') ); family = the same toward all comps (' + mult(C.global_multiple) + ')<br>' +
      'families: ' + C.families.map(function (f) { return esc(f.family) + ' ' + mult(f.multiple) + ' (' + f.comps + ')'; }).join(' · ') + '<br>' +
      'size = (TVL / ' + money(C.centre_tvl) + ')^' + C.slope + ' (least-squares fit on comps, ' + C.slope_raw + ' before clamping), kept in [' + K.SIZE_MIN + ', ' + K.SIZE_MAX + ']<br>' +
      'momentum = (1 + clamp(change_7d, ' + K.GROWTH_FLOOR + '%, +' + K.GROWTH_CAP + '%))^' + K.GROWTH_ELASTICITY + '<br>' +
      'runway = ' + K.RUNWAY_FLOOR + ' + ' + K.RUNWAY_RANGE + ' × (1 − e^(−days tokenless / ' + K.RUNWAY_TAU_DAYS + ')), unknown age: ' + C.unknown_age_days + ' d (median)<br>' +
      'class = 1 watchlist or early · ' + K.PARENTED_FACTOR + ' above floor but parented · ' + K.DERIVATIVE_FACTOR + ' derivative (set aside)<br>' +
      'drop per $1k = implied × ' + K.AIRDROP_SHARE + ' × $1,000 / TVL × ' + K.FARM_DAYS + '/' + K.SEASON_DAYS + ' days</div>' +
      '<p>Why these terms: the category multiple is the market\'s own price for a dollar of TVL in that kind of protocol; size corrects for small protocols trading richer per dollar; momentum gives credit for a week of net inflow; runway rewards a protocol that has held its TVL without paying anyone in tokens, the most honest sign of real demand. A token-bearing protocol is never on the board: it is a comp.</p></div>' +
      '<div class="cols"><div><h3>Category multiples (shrunk)</h3><div class="tbl"><div class="scroll" style="max-height:440px"><table><thead><tr><th>Category</th><th>Family</th><th class="r">Comps</th><th class="r">Raw</th><th class="r">Used</th></tr></thead><tbody>' +
      cats.map(function (c) { return '<tr><td>' + esc(c.category) + '</td><td class="sub">' + esc(c.family) + '</td><td class="r num">' + c.comps + '</td><td class="r num sub">' + (c.raw == null ? '–' : c.raw.toFixed(3)) + '</td><td class="r num">' + c.multiple.toFixed(3) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div></div><div><h3>Trading comps, by market cap</h3><div class="tbl"><div class="scroll" style="max-height:440px"><table><thead><tr><th>Protocol</th><th>Category</th><th class="r">TVL</th><th class="r">Mcap</th><th class="r">×TVL</th></tr></thead><tbody>' +
      R.comps.map(function (c) { return '<tr><td><span class="nm">' + esc(c.name) + '</span> <span class="sub">' + esc(c.symbol || '') + (c.members > 1 ? ' · ' + c.members + ' products' : '') + '</span></td><td class="sub">' + esc(c.category) + '</td><td class="r num">' + money(c.tvl_usd) + '</td><td class="r num">' + money(c.mcap_usd) + '</td><td class="r num">' + c.ratio.toFixed(3) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div></div></div>';
  }

  // ---- router -------------------------------------------------------------------------------------
  var typing;
  function go(keepFocus) {
    writeHash();
    if (keepFocus) { clearTimeout(typing); typing = setTimeout(function () { render(); var q = document.getElementById('q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 120); return; }
    render();
  }
  function render() {
    document.querySelectorAll('[data-tab]').forEach(function (a) { a.setAttribute('aria-selected', String(a.getAttribute('data-tab') === st.tab)); });
    if (st.tab === 'aside') aside(); else if (st.tab === 'model') model(); else board();
  }
  window.addEventListener('hashchange', function () { readHash(); render(); });
  header();
  readHash();
  render();
})();
