// Token Radar page: renders window.RADAR (written by main.ts from engine.js) as three views, the board
// with filters and a detail panel, the set-aside list, and the model with its held-out tests. It then
// re-runs RadarEngine.build on window.SNAPSHOT in this browser and reports whether every row matches.
// State lives in the hash (#/board?v=farm&sel=slug) so every view can be linked and captured.
(function () {
  'use strict';
  var R = window.RADAR, app = document.getElementById('app');
  if (!R) { app.innerHTML = '<p class="empty">data.js is missing: run main.ts to write it beside the dashboard.</p>'; return; }
  var CLS = ['watch', 'early', 'parented'], LABEL = { watch: 'Watchlist', early: 'Early (below floor)', parented: 'Has a parent' };
  var COLOR = { watch: 'var(--sig)', early: 'var(--amber)', parented: 'var(--violet)' };
  var VERDICT = { farm: 'Farm', marginal: 'Marginal', skip: 'Skip' };
  var bySlug = {}, T = R.test, O = R.odds_test, C = R.counts;
  R.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var MAXV = R.rows[0].implied_value_usd, check = null;

  // ---- formatting
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function money(x) {
    if (x == null) return '–';
    var a = Math.abs(x), s = x < 0 ? '−$' : '$';
    return a >= 1e9 ? s + (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? s + (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M' : a >= 1e4 ? s + (a / 1e3).toFixed(0) + 'K' : a >= 100 ? s + Math.round(a).toLocaleString('en-US') : s + a.toFixed(2);
  }
  function pct(x) { return x == null ? '<span class="sub">n/a</span>' : '<span class="' + (x >= 0 ? 'pos' : 'neg') + '">' + (x >= 0 ? '+' : '') + x.toFixed(1) + '%</span>'; }
  function odds(x) { return Math.round(x * 100) + '%'; }
  function days(d) { return d == null ? '<span class="sub">unknown</span>' : d >= 365 ? (d / 365).toFixed(1) + ' y' : d + ' d'; }
  function x3(v) { return '×' + v.toFixed(3); }
  function badge(c) { return '<span class="badge b-' + c + '">' + esc(LABEL[c] || 'Derivative') + '</span>'; }
  function vchip(r) { return '<span class="vd v-' + r.plan.verdict + '">' + VERDICT[r.plan.verdict] + '</span>'; }
  function signed(x) { return (x >= 0 ? '+' : '') + money(x); }
  function fact(k, v) { return '<div class="fact"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }

  // ---- state in the hash
  var st;
  function readHash() {
    var h = location.hash.replace(/^#\/?/, '').split('?'), p = new URLSearchParams(h[1] || '');
    st = { tab: ['board', 'live', 'aside', 'model'].indexOf(h[0]) >= 0 ? h[0] : 'board', q: p.get('q') || '',
      cls: p.get('cls') ? p.get('cls').split(',').filter(function (c) { return CLS.indexOf(c) >= 0; }) : CLS.slice(),
      cat: p.get('cat') || '', chain: p.get('chain') || '', min: +p.get('min') || 0, grow: p.get('grow') === '1', v: p.get('v') || '',
      sort: p.get('sort') || 'rank', sel: p.get('sel') || '' };
    st.asc = p.get('dir') ? p.get('dir') === 'asc' : st.sort === 'rank';
  }
  function writeHash() {
    var p = new URLSearchParams();
    ['q', 'cat', 'chain', 'min', 'v'].forEach(function (k) { if (st[k]) p.set(k, st[k]); });
    if (st.cls.length !== CLS.length) p.set('cls', st.cls.join(','));
    if (st.grow) p.set('grow', '1');
    if (st.sort !== 'rank') { p.set('sort', st.sort); p.set('dir', st.asc ? 'asc' : 'desc'); }
    if (st.sel) p.set('sel', st.sel);
    history.replaceState(null, '', '#/' + st.tab + (p.toString() ? '?' + p : ''));
  }

  // ---- integrity strip: what was read, what is covered, what was left out, how the model tests
  function header() {
    document.getElementById('ver').textContent = R.model;
    document.getElementById('asof').textContent = 'Snapshot ' + R.as_of + ' · DefiLlama · offline';
    document.getElementById('n-aside').textContent = C.set_aside;
    document.getElementById('n-live').textContent = C.live;
    var lo = T.loo, wf = T.walk_forward;
    var k = [
      ['Snapshot', R.as_of, C.protocols + ' protocols ≥ $5M TVL'],
      ['Watchlist covered', C.watch_covered + ' / ' + C.watch, 'every floor slug is ranked', C.watch_covered === C.watch],
      ['Ranked board', C.board, R.rows.filter(function (r) { return r.class === 'early'; }).length + ' early finds below the floor'],
      ['Excluded', C.live + ' + ' + C.set_aside, 'trade a token · derivative of one'],
      ['Held-out value test', lo.model.rmse.toFixed(2) + ' <small>vs ' + lo.flat.rmse.toFixed(2) + '</small>', 'LOO ln-RMSE, model vs flat multiple', lo.model.rmse < lo.flat.rmse],
      ['Walk-forward', wf.model.rmse.toFixed(2) + ' <small>vs ' + wf.flat.rmse.toFixed(2) + '</small>', wf.test + ' newest tokens, fit on ' + wf.train + ' older', wf.model.rmse < wf.flat.rmse],
      ['Token odds test', 'AUC ' + O.auc.toFixed(2), O.folds + '-fold CV · log-loss ' + O.log_loss.toFixed(3) + ' vs ' + O.base_log_loss.toFixed(3)],
      ['Recomputed here', check ? check.ok + ' / ' + C.board : '…', check ? 'rows match engine.js · ' + check.ms + ' ms' : 'running engine.js in this browser', check && check.ok === C.board],
    ];
    document.getElementById('kpis').innerHTML = k.map(function (x) {
      return '<div class="kpi"><div class="k">' + x[0] + '</div><div class="v' + (x[3] ? ' ok' : '') + '">' + x[1] + '</div><div class="s">' + x[2] + '</div></div>';
    }).join('');
  }
  function testLine() {
    var lo = T.loo, wf = T.walk_forward;
    return '<div class="test"><b>Held-out test</b> Each of ' + lo.model.n + ' trading tokens priced by a fit that never saw it: median miss ×' + lo.model.median_x.toFixed(1) +
      ', ' + Math.round(lo.model.within_3x * 100) + '% within 3×, rank corr ' + lo.model.spearman.toFixed(2) + ' (flat multiple: ×' + lo.flat.median_x.toFixed(1) + ', ' + Math.round(lo.flat.within_3x * 100) + '%, ' + lo.flat.spearman.toFixed(2) +
      '). Walk-forward on the ' + wf.test + ' tokens tracked since ' + wf.cut_listed + ': ×' + wf.model.median_x.toFixed(1) + ' vs ×' + wf.flat.median_x.toFixed(1) + '. So each value carries an 80% band of ' + x3(R.fit.band[0]) + ' to ' + x3(R.fit.band[1]) + '. <a href="#/model">Model &amp; test</a></div>';
  }

  // ---- board
  var COLS = [['rank', '#', 'r'], ['name', 'Protocol'], ['class', 'Class', 'x2'], ['tvl_usd', 'TVL', 'r x2'], ['change_7d', '7d', 'r'], ['tokenless_days', 'No token for', 'r'],
    ['implied_value_usd', 'Implied value', 'r'], ['token_odds', 'Token odds', 'r'], ['expected_value_usd', 'Expected', 'r x2'], ['net', 'Farm plan, 90 d', 'r']];
  function sortVal(r, k) {
    if (k === 'net') return r.plan.net;
    if (k === 'name' || k === 'class') return String(r[k]).toLowerCase();
    return r[k] == null ? -Infinity : r[k];
  }
  function filtered() {
    var q = st.q.toLowerCase();
    return R.rows.filter(function (r) {
      return st.cls.indexOf(r.class) >= 0 && (!st.cat || r.category === st.cat) && (!st.chain || r.chains.indexOf(st.chain) >= 0) && (!st.min || r.tvl_usd >= st.min) &&
        (!st.grow || r.change_7d > 0) && (!st.v || (st.v === 'farm' ? r.plan.verdict === 'farm' : r.plan.verdict !== 'skip')) &&
        (!q || (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) >= 0);
    }).sort(function (a, b) {
      var x = sortVal(a, st.sort), y = sortVal(b, st.sort), c = x < y ? -1 : x > y ? 1 : a.rank - b.rank;
      return st.asc ? c : -c;
    });
  }
  function tally(f) {
    var m = {};
    R.rows.forEach(function (r) { f(r).forEach(function (v) { m[v] = (m[v] || 0) + 1; }); });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a] || (a < b ? -1 : 1); }).map(function (k) { return [k, m[k]]; });
  }
  var CATS = tally(function (r) { return [r.category || 'Uncategorised']; }), CHAINS = tally(function (r) { return r.chains; }).slice(0, 40);
  function select(id, opts, cur) { return '<select id="' + id + '" aria-label="' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; }
  function named(list, all) { return [['', all]].concat(list.map(function (v) { return [v[0], v[0] + ' (' + v[1] + ')']; })); }

  function board() {
    var rows = filtered(), sel = st.sel && bySlug[st.sel];
    var f = '<div class="filters"><input type="search" id="q" placeholder="Search name, category, chain" value="' + esc(st.q) + '" aria-label="Search">' +
      CLS.map(function (c) { return '<button class="chip" data-cls="' + c + '" aria-pressed="' + (st.cls.indexOf(c) >= 0) + '"><i style="background:' + COLOR[c] + '"></i>' + LABEL[c] + '</button>'; }).join('') +
      select('cat', named(CATS, 'All categories'), st.cat) + select('chain', named(CHAINS, 'All chains'), st.chain) +
      select('min', [[0, 'Any TVL'], [1e7, 'TVL ≥ $10M'], [5e7, 'TVL ≥ $50M'], [2e8, 'TVL ≥ $200M']], st.min) +
      select('v', [['', 'Any farm verdict'], ['ok', 'Farm or marginal'], ['farm', 'Farm only']], st.v) +
      '<button class="chip" id="grow" aria-pressed="' + st.grow + '">7d up</button><button class="reset" id="reset">Reset</button>' +
      '<span class="count">' + rows.length + ' of ' + R.rows.length + ' rows · rank = implied value</span></div>';
    var head = '<tr>' + COLS.map(function (c) { return '<th data-k="' + c[0] + '" class="' + (c[2] || '') + (st.sort === c[0] ? ' on' + (st.asc ? ' asc' : '') : '') + '">' + c[1] + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === st.sel ? ' class="sel"' : '') + '><td class="r num">' + r.rank + '</td>' +
        '<td><div class="nm"><i class="cd" style="background:' + COLOR[r.class] + '"></i>' + esc(r.name) + '</div><div class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains[0] || '') + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) + ' chains' : '') + '</div></td>' +
        '<td class="x2">' + badge(r.class) + '</td><td class="r num x2">' + money(r.tvl_usd) + '</td><td class="r num">' + pct(r.change_7d) + '</td><td class="r num">' + days(r.tokenless_days) + '</td>' +
        '<td class="r bar num"><b>' + money(r.implied_value_usd) + '</b><span style="width:' + Math.max(2, Math.sqrt(r.implied_value_usd / MAXV) * 100).toFixed(1) + '%"></span><em>' + money(r.value_band_usd[0]) + '–' + money(r.value_band_usd[1]) + '</em></td>' +
        '<td class="r num">' + odds(r.token_odds) + '</td><td class="r num x2">' + money(r.expected_value_usd) + '</td>' +
        '<td class="r num fp">' + vchip(r) + ' ' + signed(r.plan.net) + '<em>' + money(r.plan.ticket) + ' in · cost ' + money(r.plan.costs.total) + ' · ' + r.plan.hours.toFixed(1) + ' h' + (r.plan.lockup_days ? ' · ' + r.plan.lockup_days + 'd lock' : '') + '</em></td></tr>';
    }).join('');
    app.innerHTML = testLine() + f + '<div class="split' + (sel ? ' has-sel' : ' solo') + '"><div class="tbl"><div class="scroll"><table><thead>' + head + '</thead><tbody>' +
      (body || '<tr><td colspan="10" class="empty">No protocol matches these filters.</td></tr>') + '</tbody></table></div></div>' + (sel ? detail(sel) : '') + '</div>';
    wireBoard();
    var on = app.querySelector('tr.sel');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function waterfall(r) {
    var f = r.factors, v = f.base, top = Math.max(r.tvl_usd, r.core_value_usd * 4), rows = [['Centre comp', v, 'b', 'a ' + money(R.fit.centre_tvl) + '-TVL token']];
    [['Size', f.size, '(TVL/centre)^' + R.fit.b.toFixed(2)], ['Family', f.family, r.family], ['Category', f.category, r.category || 'Uncategorised'], ['Momentum', f.momentum, '7d prior'], ['Runway', f.runway, 'tokenless prior'], ['Class', f.class_factor, LABEL[r.class]]].forEach(function (x) {
      v *= x[1];
      rows.push([x[0] + ' ' + x3(x[1]), v, x[1] >= 1 ? 'up' : 'cut', x[2]]);
    });
    rows[rows.length - 1][2] = 'end';
    return '<div class="wf">' + rows.map(function (s) {
      return '<div title="' + esc(s[3]) + '">' + esc(s[0]) + ' <small>' + esc(s[3]) + '</small></div><div class="t"><span class="' + s[2] + '" style="width:' + Math.min(100, Math.max(0.6, Math.sqrt(s[1] / top) * 100)).toFixed(1) + '%"></span></div><div class="x">' + money(s[1]) + '</div>';
    }).join('') + '</div>';
  }
  function costs(r) {
    var p = r.plan, c = p.costs, line = function (k, v, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + k + '</td><td class="r num">' + v + '</td></tr>'; };
    return '<div class="cg"><table class="mini cost"><tbody>' + line('Capital, returned', money(p.ticket)) + line('Gas on ' + esc(p.chain), money(c.gas)) + line('Bridge in + out', money(c.bridge)) +
      line('Carry, 90 d', money(c.carry)) + line('Risk (' + p.risk + ')', money(c.risk)) + line('Total cost', money(c.total), 'tot') + '</tbody></table><table class="mini cost"><tbody>' +
      line('Drop if it launches', money(p.reward)) + line('× odds ' + odds(r.token_odds), money(p.expected)) + line('Lockup', p.lockup_days ? p.lockup_days + ' days' : 'none') +
      line('Break-even odds', p.breakeven_odds == null || p.breakeven_odds > 1 ? '> 100%' : odds(p.breakeven_odds)) + line('Work', '~' + p.hours.toFixed(1) + ' h') +
      line('Net expected', '<b class="v-' + p.verdict + '">' + signed(p.net) + '</b>', 'tot') + '</tbody></table></div>';
  }
  function detail(r) {
    var p = r.plan;
    return '<aside class="detail" aria-label="Protocol detail"><button class="close" id="close" aria-label="Close detail">✕</button><h2>' + esc(r.name) + '</h2>' +
      '<div class="meta">#' + r.rank + ' of ' + C.board + ' · ' + badge(r.class) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + '</div>' +
      '<div class="big"><div><div class="l">Implied value if it launches</div><div class="v">' + money(r.implied_value_usd) + '</div><div class="sub">80% band ' + money(r.value_band_usd[0]) + ' – ' + money(r.value_band_usd[1]) + '</div></div>' +
      '<div><div class="l">Token odds</div><div class="v2">' + odds(r.token_odds) + '</div><div class="sub">expected ' + money(r.expected_value_usd) + '</div></div></div>' +
      '<div class="facts">' + fact('TVL', money(r.tvl_usd)) + fact('7-day change', pct(r.change_7d)) + fact('Tokenless for', days(r.tokenless_days)) + '</div>' +
      '<h3>How the value is built</h3>' + waterfall(r) +
      '<h3>Farm plan · ' + money(p.ticket) + ' ticket · ' + vchip(r) + '</h3>' + costs(r) +
      '<ol class="steps">' + p.steps.map(function (s) { return '<li><div>' + esc(s.do) + ' <span class="tag c">' + esc(s.cost) + '</span> <span class="tag t">' + esc(s.time) + '</span></div></li>'; }).join('') + '</ol>' +
      '<div class="note">Core value ' + money(r.core_value_usd) + ' is the ridge fit on ' + C.comps + ' trading tokens; momentum and runway are stated priors. DefiLlama records no token for ' + esc(r.name) + ', which is not proof it has none; the value is this model\'s claim, not a forecast of a launch.</div></aside>';
  }

  function wireBoard() {
    var q = document.getElementById('q'), typing;
    q.addEventListener('input', function () { st.q = q.value; clearTimeout(typing); typing = setTimeout(function () { go(); q = document.getElementById('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 150); });
    app.querySelectorAll('[data-cls]').forEach(function (b) {
      b.onclick = function () { var c = b.getAttribute('data-cls'), i = st.cls.indexOf(c); if (i >= 0) st.cls.splice(i, 1); else st.cls.push(c); go(); };
    });
    ['cat', 'chain', 'min', 'v'].forEach(function (id) { document.getElementById(id).onchange = function (e) { st[id] = id === 'min' ? +e.target.value : e.target.value; go(); }; });
    document.getElementById('grow').onclick = function () { st.grow = !st.grow; go(); };
    document.getElementById('reset').onclick = function () { location.hash = '#/board'; };
    app.querySelectorAll('th[data-k]').forEach(function (th) {
      th.onclick = function () { var k = th.getAttribute('data-k'); if (st.sort === k) st.asc = !st.asc; else { st.sort = k; st.asc = k === 'rank' || k === 'name'; } go(); };
    });
    app.querySelectorAll('tbody tr[data-slug]').forEach(function (tr) { tr.onclick = function () { var s = tr.getAttribute('data-slug'); st.sel = st.sel === s ? '' : s; go(); }; });
    var c = document.getElementById('close');
    if (c) c.onclick = function () { st.sel = ''; go(); };
  }

  // ---- set aside
  function aside() {
    app.innerHTML = '<div class="prose"><p>These ' + C.set_aside + ' protocols record no token on DefiLlama but fail the watchlist\'s own rule: a CEX\'s reserve wallets, a staking or bridged wrapper, or a versioned product. Their value already trades as another token, so they stay off the ranked board; the reference value applies a class factor of ' + R.constants.DERIVATIVE + '. Protocols that record a token are listed under <a href="#/live">Token trades</a>.</p></div>' +
      '<div class="tbl"><div class="scroll"><table><thead><tr><th>Protocol</th><th>Category</th><th>Why set aside</th><th class="r">TVL</th><th class="r">7d</th><th class="r">Reference value</th></tr></thead><tbody>' +
      R.set_aside.map(function (r) { return '<tr><td class="nm">' + esc(r.name) + '</td><td class="sub">' + esc(r.category || '–') + '</td><td>' + esc(r.reason) + '</td><td class="r num">' + money(r.tvl_usd) + '</td><td class="r num">' + pct(r.change_7d) + '</td><td class="r num sub">' + money(r.implied_value_usd) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }

  // ---- already trading: off the board, and the source of the comps
  function live() {
    var comp = {}, L = window.SNAPSHOT.protocols.filter(function (p) { return p.gecko_id !== null || p.symbol !== null; }).sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    R.comps.forEach(function (c) { comp[c.slug] = 1; });
    app.innerHTML = '<div class="prose"><p>These ' + L.length + ' protocols record a token on DefiLlama, so they are not on the board: the launch is past. ' + C.comps + ' tokens, one per token, price the value model (marked); ' + C.comps_dropped + ' are left out (no market cap, or a CEX, bridge or wrapper).</p></div>' +
      '<div class="tbl"><div class="scroll"><table><thead><tr><th>Protocol</th><th>Token</th><th>Category</th><th class="r">TVL</th><th class="r">Mcap</th><th>Comp</th></tr></thead><tbody>' +
      L.map(function (p) { return '<tr><td class="nm">' + esc(p.name) + '</td><td class="num">' + esc(p.symbol || p.gecko_id) + '</td><td class="sub">' + esc(p.category || '–') + '</td><td class="r num">' + money(p.tvl_usd) + '</td><td class="r num">' + money(p.mcap_usd) + '</td><td>' + (comp[p.slug] ? '✓' : '') + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }

  // ---- model and its tests
  function scatter() { // leave-one-out prediction against the actual market cap, both on log scales
    var pts = T.points, lo = Infinity, hi = -Infinity, W = 460, P = 34;
    pts.forEach(function (p) { lo = Math.min(lo, p[1], p[2]); hi = Math.max(hi, p[1], p[2]); });
    lo = Math.floor(lo / Math.LN10); hi = Math.ceil(hi / Math.LN10);
    var s = function (v) { return P + ((v / Math.LN10 - lo) / (hi - lo)) * (W - 2 * P); }, y = function (v) { return W - s(v); }, g = '';
    for (var e = lo; e <= hi; e++) g += '<line x1="' + s(e * Math.LN10) + '" x2="' + s(e * Math.LN10) + '" y1="' + P + '" y2="' + (W - P) + '"/><line y1="' + y(e * Math.LN10) + '" y2="' + y(e * Math.LN10) + '" x1="' + P + '" x2="' + (W - P) + '"/><text x="' + s(e * Math.LN10) + '" y="' + (W - 14) + '">' + money(Math.pow(10, e)) + '</text>';
    var band = [Math.log(3), -Math.log(3)].map(function (d) { return '<line class="b3" x1="' + s(lo * Math.LN10) + '" y1="' + y(lo * Math.LN10 + d) + '" x2="' + s(hi * Math.LN10) + '" y2="' + y(hi * Math.LN10 + d) + '"/>'; }).join('');
    return '<svg class="sc" viewBox="0 0 ' + W + ' ' + W + '" role="img" aria-label="Held-out predicted against actual market cap"><g class="grid">' + g + '</g>' + band +
      '<line class="id" x1="' + s(lo * Math.LN10) + '" y1="' + y(lo * Math.LN10) + '" x2="' + s(hi * Math.LN10) + '" y2="' + y(hi * Math.LN10) + '"/>' +
      pts.map(function (p) { return '<circle cx="' + s(p[1]).toFixed(1) + '" cy="' + y(p[2]).toFixed(1) + '" r="3.5"><title>' + esc(p[0]) + '</title></circle>'; }).join('') +
      '<text x="' + W / 2 + '" y="' + (W - 2) + '">actual market cap</text><text transform="translate(10 ' + W / 2 + ') rotate(-90)">predicted, token held out</text></svg>';
  }
  function scoreRows(t) {
    return [['This model', t.model], ['Size only', t.size_only], ['Flat multiple', t.flat]].concat(t.with_priors ? [['Model × priors', t.with_priors]] : []).map(function (x) {
      return '<tr><td>' + x[0] + '</td><td class="r num">' + x[1].rmse.toFixed(3) + '</td><td class="r num">×' + x[1].median_x.toFixed(2) + '</td><td class="r num">' + Math.round(x[1].within_3x * 100) + '%</td><td class="r num">' + x[1].spearman.toFixed(2) + '</td></tr>';
    }).join('');
  }
  function model() {
    var K = R.constants, F = R.fit, H = '<tr><th></th><th class="r">ln-RMSE</th><th class="r">Median miss</th><th class="r">Within 3×</th><th class="r">Rank corr</th></tr>';
    app.innerHTML = '<div class="prose"><p>What would each protocol\'s token be worth if its record stayed as the snapshot shows it, and how likely is a token at all? Both answers are fitted on the snapshot\'s own protocols in <code>engine.js</code> and scored on data the fit did not see. No protocol is named in the code.</p>' +
      '<div class="formula">implied = core × momentum × runway × class<br>core: ln mcap = ' + F.a.toFixed(2) + ' + ' + F.b.toFixed(3) + ' × (ln TVL − ln ' + money(F.centre_tvl) + ') + family + category, ridge λ ' + T.chosen.family_lambda + ' / ' + T.chosen.category_lambda + ' chosen by leave-one-out<br>' +
      'families: ' + F.families.map(function (f) { return esc(f.family) + ' ' + x3(f.effect) + ' (' + f.comps + ')'; }).join(' · ') + '<br>' +
      'momentum = 1 + clamp(7d, ' + K.GROWTH_FLOOR + '%, +' + K.GROWTH_CAP + '%) · runway = ' + K.RUNWAY_FLOOR + ' + ' + K.RUNWAY_RANGE + '(1 − e^(−days/' + K.RUNWAY_TAU + ')), unknown age ' + F.unknown_age_days + ' d<br>' +
      'class = 1 watchlist or early · ' + K.PARENTED + ' parented · ' + K.DERIVATIVE + ' derivative (set aside)<br>' +
      'token odds = logistic(ln TVL, ln(1 + years tracked), ln chains, family), ridge ' + K.ODDS_LAMBDA + ', fitted on ' + O.n + ' protocols (' + O.with_token + ' carry a token)<br>' +
      'drop on a ticket = implied / ' + K.LAUNCH_FLOAT + ' float × ' + K.AIRDROP_SHARE + ' to farmers × ' + K.FARM_DAYS + '/' + K.SEASON_DAYS + ' days × ticket / TVL</div></div>' +
      '<div class="cols"><div><h3>Value model, held out</h3><table class="mini"><thead><tr><th colspan="5">Leave-one-out, ' + T.loo.model.n + ' tokens (exact, hat-matrix)</th></tr>' + H + '</thead><tbody>' + scoreRows(T.loo) + '</tbody></table>' +
      '<table class="mini"><thead><tr><th colspan="5">Walk-forward: fit on ' + T.walk_forward.train + ' tokens tracked first, test the ' + T.walk_forward.test + ' since ' + T.walk_forward.cut_listed + '</th></tr>' + H + '</thead><tbody>' + scoreRows(T.walk_forward) + '</tbody></table>' +
      '<p class="note">Reading it: a fitted size curve beats one flat multiple by a clear margin both ways. Family and category effects add rank skill in leave-one-out (' + T.loo.model.spearman.toFixed(2) + ' vs ' + T.loo.size_only.spearman.toFixed(2) + ') but not on the newest tokens, so they are kept heavily shrunk. The momentum and runway priors cost little held out. Misses are wide (one token in two is off by more than 3×), which is why every value shows its 80% band.</p>' +
      '<h3>Token odds, ' + O.folds + '-fold cross-validated</h3><table class="mini"><tbody><tr><td>AUC (0.5 is a coin)</td><td class="r num">' + O.auc.toFixed(3) + '</td></tr><tr><td>Log-loss, model vs base rate ' + odds(O.base_rate) + '</td><td class="r num">' + O.log_loss.toFixed(3) + ' vs ' + O.base_log_loss.toFixed(3) + '</td></tr></tbody></table>' +
      '<h3>Penalty grid (LOO ln-RMSE, family λ × category λ)</h3><div class="grid4">' + T.grid.map(function (g) { return '<span' + (g.lf === T.chosen.family_lambda && g.lc === T.chosen.category_lambda ? ' class="on"' : '') + '>' + g.lf + '/' + g.lc + ' <b>' + g.rmse.toFixed(3) + '</b></span>'; }).join('') + '</div></div>' +
      '<div><h3>Predicted with the token held out vs actual (dashed: 3×)</h3>' + scatter() + '<p class="note">The tokens that price the fit are marked under <a href="#/live">Token trades</a>.</p></div></div>';
  }

  // ---- router and the in-browser recompute
  function go() { writeHash(); render(); }
  function render() {
    document.querySelectorAll('[data-tab]').forEach(function (a) { a.setAttribute('aria-selected', String(a.getAttribute('data-tab') === st.tab)); });
    if (st.tab === 'aside') aside(); else if (st.tab === 'live') live(); else if (st.tab === 'model') model(); else board();
  }
  window.addEventListener('hashchange', function () { readHash(); render(); });
  readHash();
  header();
  render();
  setTimeout(function () {
    if (!window.RadarEngine || !window.SNAPSHOT) return;
    var t0 = performance.now(), b = window.RadarEngine.build(window.SNAPSHOT), ok = 0;
    b.rows.forEach(function (r, i) { var s = R.rows[i]; if (s && s.slug === r.slug && s.implied_value_usd === r.implied_value_usd && s.token_odds === r.token_odds && s.plan.net === r.plan.net) ok++; });
    check = { ok: ok, ms: Math.round(performance.now() - t0) };
    header();
    document.body.setAttribute('data-checked', '1');
  }, 30);
})();
