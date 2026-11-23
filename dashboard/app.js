// Token Radar page: renders window.RADAR (written by main.ts from engine.js) as three views, the board
// with its cover, filters, plan controls and a detail panel, the set-aside list, and the model with its
// held-out tests. It re-runs RadarEngine.build on window.SNAPSHOT here and reports whether rows match.
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
  var BASE = R.rows, check = null, LO = Math.log(R.rows[R.rows.length - 1].value_band_usd[1]), HI = Math.log(R.rows[0].value_band_usd[2]);

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
    st = { tab: ['board', 'aside', 'model'].indexOf(h[0]) >= 0 ? h[0] : 'board', q: p.get('q') || '',
      cls: p.get('cls') ? p.get('cls').split(',').filter(function (c) { return CLS.indexOf(c) >= 0; }) : CLS.slice(),
      cat: p.get('cat') || '', chain: p.get('chain') || '', min: +p.get('min') || 0, grow: p.get('grow') === '1', v: p.get('v') || '',
      sort: p.get('sort') || 'rank', sel: p.get('sel') || '', dep: +p.get('dep') || 0, sh: +p.get('sh') || 0, hz: +p.get('hz') || 0 };
    st.asc = p.get('dir') ? p.get('dir') === 'asc' : st.sort === 'rank';
  }
  function writeHash() {
    var p = new URLSearchParams();
    ['q', 'cat', 'chain', 'min', 'v', 'dep', 'sh', 'hz'].forEach(function (k) { if (st[k]) p.set(k, st[k]); });
    if (st.cls.length !== CLS.length) p.set('cls', st.cls.join(','));
    if (st.grow) p.set('grow', '1');
    if (st.sort !== 'rank') { p.set('sort', st.sort); p.set('dir', st.asc ? 'asc' : 'desc'); }
    if (st.sel) p.set('sel', st.sel);
    history.replaceState(null, '', '#/' + st.tab + (p.toString() ? '?' + p : ''));
  }

  // ---- cover: six numbers, the self-checks, the term-by-term test and where every protocol went
  function shipped() { return T.steps.filter(function (x) { return x.kept === true; }).pop(); }
  function header() {
    document.getElementById('ver').textContent = R.model;
    document.getElementById('asof').textContent = 'Snapshot ' + R.as_of + ' · DefiLlama · offline';
    document.getElementById('n-aside').textContent = C.set_aside;
    var m = shipped(), fl = T.steps[0], cv = T.coverage, n = verdicts(), L = ledger(), sum = L.reduce(function (a, g) { return a + g[1]; }, 0);
    var k = [
      ['Out-of-sample miss', '×' + m.test.median_x.toFixed(2) + ' <small>vs ×' + fl.test.median_x.toFixed(2) + ' flat</small>', 'median, newest ' + T.split.test + ' tokens, never fitted', 1],
      ['Range honesty', Math.round(cv.p25_p75 * 100) + '% · ' + Math.round(cv.p10_p90 * 100) + '%', 'newest in P25–75 · P10–90; aim 50·80', Math.abs(cv.p25_p75 - 0.5) < 0.15 && Math.abs(cv.p10_p90 - 0.8) < 0.1],
      ['Token odds Brier', O.brier.toFixed(3) + ' <small>vs ' + O.base_brier.toFixed(3) + '</small>', O.folds + '-fold CV vs base rate · AUC ' + O.auc.toFixed(2), O.brier < O.base_brier],
      ['Terms kept', T.kept + ' <small>of ' + T.tried + '</small>', 'kept if LOO and validation both fall', 1],
      ['Worth farming', n.farm + ' <small>+' + n.marginal + ' marginal</small>', 'net of all costs · ' + (st.dep ? money(st.dep) : 'auto') + ' deposit', n.farm > 0],
      ['Watchlist ranked', C.watch_covered + ' / ' + C.watch, '+' + (C.board - C.watch_covered) + ' more found', C.watch_covered === C.watch],
    ];
    var ch = [['table = board.json', check ? check.ok + '/' + C.board : '…', check && check.ok === C.board],
      ['ranks in order', BASE.every(function (r, i) { return r.rank === i + 1 && (!i || BASE[i - 1].implied_value_usd >= r.implied_value_usd); })],
      ['ledger ' + sum + '/' + C.protocols, sum === C.protocols], ['watchlist ' + C.watch_covered + '/' + C.watch, C.watch_covered === C.watch],
      ['main.ts sha256 ' + (R.main_sha256 || '').slice(0, 8), !!R.main_sha256], ['board.json sha256 ' + (R.board_sha256 || '').slice(0, 8), !!R.board_sha256]];
    document.getElementById('kpis').innerHTML = k.map(function (x) {
      return '<div class="kpi"><div class="k">' + x[0] + '</div><div class="v' + (x[3] ? ' ok' : '') + '">' + x[1] + '</div><div class="s">' + x[2] + '</div></div>';
    }).join('') + '<div class="chips">' + ch.map(function (c) { var ok = c.length > 2 ? c[2] : c[1]; return '<span class="' + (ok ? 'ok' : '') + '">' + (ok ? '✓ ' : '· ') + c[0] + (c.length > 2 ? ' <i>' + c[1] + '</i>' : '') + '</span>'; }).join('') + '</div>';
  }
  function verdicts() { var n = { farm: 0, marginal: 0, skip: 0 }; R.rows.forEach(function (r) { n[r.plan.verdict]++; }); return n; }
  function ledger() {
    var c = function (k) { return R.rows.filter(function (r) { return r.class === k; }).length; };
    return [['Watchlist', c('watch'), 'var(--sig)'], ['Has a parent', c('parented'), 'var(--violet)'], ['Early, below floor', c('early'), 'var(--amber)'],
      ['Set aside: derivative', C.set_aside, 'var(--ink-3)'], ['Token trades', C.live, 'var(--line-2)']];
  }
  function steps() {
    var f = function (s) { return s ? s.rmse.toFixed(2) : '–'; }, V = { baseline: 'baseline', stated: 'stated prior', true: 'kept', false: 'tested, not kept' };
    return '<table class="mini st"><thead><tr><th>Term, added in order</th><th class="r">LOO ' + C.comps + '</th><th class="r">Validation ' + T.split.val + '</th><th class="r">Newest ' + T.split.test + '</th><th>Verdict</th></tr></thead><tbody>' +
      T.steps.map(function (s) { return '<tr><td>' + esc(s.term) + '</td><td class="r num">' + f(s.loo) + '</td><td class="r num">' + f(s.val) + '</td><td class="r num">' + f(s.test) + '</td><td class="k-' + s.kept + '">' + V[s.kept] + '</td></tr>'; }).join('') +
      '</tbody></table><p class="note">ln-RMSE held out, lower is better. A term is kept only if it lowers both LOO and validation (fit the ' + T.split.fit + ' oldest tokens, score the next ' + T.split.val + '); the newest ' + T.split.test + ' (since ' + T.split.test_from + ') are scored once per step and never choose. Size dominates. Momentum and runway stay as stated priors: they are what the brief asks the value to reflect, and the last row shows their cost held out.</p>';
  }
  function cover() {
    var L = ledger(), tot = C.protocols, why = {};
    R.set_aside.forEach(function (r) { var k = r.reason.replace(/^category /, ''); why[k] = (why[k] || 0) + 1; });
    return '<div class="cover"><div>' + steps() + '</div><div><h3>Every snapshot protocol, in exactly one group</h3><div class="led">' +
      L.map(function (g) { return '<span style="flex:' + g[1] + ';background:' + g[2] + '"></span>'; }).join('') + '</div><div class="lg">' +
      L.map(function (g, i) { return '<div><i class="cd" style="background:' + g[2] + '"></i>' + g[0] + ' <b>' + g[1] + '</b>' + (i === 3 ? '<div class="sub">' + Object.keys(why).sort(function (a, b) { return why[b] - why[a]; }).map(function (k) { return esc(k) + ' ' + why[k]; }).join(' · ') + '</div>' : i === 4 ? '<div class="sub">launch is past · ' + C.comps + ' price the model, one per token</div>' : '') + '</div>'; }).join('') +
      '<div>All snapshot protocols ≥ $5M <b>' + tot + '</b></div></div></div></div>';
  }

  // ---- board
  var COLS = [['rank', '#', 'r'], ['name', 'Protocol'], ['class', 'Class', 'x2'], ['tvl_usd', 'TVL', 'r x2'], ['change_7d', '7d', 'r'], ['tokenless_days', 'No token for', 'r'],
    ['implied_value_usd', 'Implied value', 'r'], ['token_odds', 'Token odds', 'r'], ['expected_value_usd', 'Expected', 'r x2'], ['net', 'Farm plan', 'r x3']];
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
      '<span class="ctl">Plan: ' + select('dep', [[0, 'deposit 1/50,000 TVL'], [1000, '$1,000 deposit'], [5000, '$5,000 deposit'], [25000, '$25,000 deposit']], st.dep) +
      select('sh', [[0, 'drop 7.5% of supply'], [0.03, 'drop 3%'], [0.15, 'drop 15%']], st.sh) + select('hz', [[0, '90-day horizon'], [30, '30 days'], [180, '180 days']], st.hz) +
      '<button class="chip" id="csv">CSV</button><button class="chip" id="json">JSON</button></span><span class="count">' + rows.length + ' of ' + R.rows.length + ' rows · rank = implied value</span></div>';
    var head = '<tr>' + COLS.map(function (c) { return '<th data-k="' + c[0] + '" class="' + (c[2] || '') + (st.sort === c[0] ? ' on' + (st.asc ? ' asc' : '') : '') + '">' + c[1] + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === st.sel ? ' class="sel"' : '') + '><td class="r num">' + r.rank + '</td>' +
        '<td><div class="nm"><i class="cd" style="background:' + COLOR[r.class] + '"></i>' + esc(r.name) + '</div><div class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains[0] || '') + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) + ' chains' : '') + '</div></td>' +
        '<td class="x2">' + badge(r.class) + '</td><td class="r num x2">' + money(r.tvl_usd) + '</td><td class="r num">' + pct(r.change_7d) + '</td><td class="r num">' + days(r.tokenless_days) + '</td>' +
        '<td class="r bar num"><b>' + money(r.implied_value_usd) + '</b>' + rng(r) + '<em>P25–75 ' + money(r.value_band_usd[1]) + '–' + money(r.value_band_usd[2]) + '</em></td>' +
        '<td class="r num">' + odds(r.token_odds) + '</td><td class="r num x2">' + money(r.expected_value_usd) + '</td>' +
        '<td class="r num fp x3">' + vchip(r) + ' ' + signed(r.plan.net) + ' <small>' + signed(r.plan.net / r.plan.hours) + '/h</small><em>' + money(r.plan.ticket) + ' in · cost ' + money(r.plan.costs.total) + ' · ' + r.plan.hours.toFixed(1) + ' h' + (r.plan.lockup_days ? ' · ' + r.plan.lockup_days + 'd lock' : '') + '</em></td></tr>';
    }).join('');
    var plain = !sel && st.cls.length === CLS.length && !st.q && !st.cat && !st.chain && !st.min && !st.v && !st.grow && st.sort === 'rank';
    app.innerHTML = (plain ? cover() : '') + f + '<div class="split' + (sel ? ' has-sel' : ' solo') + '"><div class="tbl"><div class="scroll"><table><thead>' + head + '</thead><tbody>' +
      (body || '<tr><td colspan="10" class="empty">No protocol matches these filters.</td></tr>') + '</tbody></table></div></div>' + (sel ? detail(sel) : '') + '</div>';
    wireBoard();
    var on = app.querySelector('tr.sel');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function rng(r) { var b = r.value_band_usd, x = function (v) { return ((Math.log(v) - LO) / (HI - LO)) * 100; };
    return '<i class="rg"><s style="left:' + x(b[1]).toFixed(1) + '%;width:' + (x(b[2]) - x(b[1])).toFixed(1) + '%"></s><u style="left:' + x(r.implied_value_usd).toFixed(1) + '%"></u></i>'; }
  function waterfall(r) {
    var f = r.factors, v = f.base, top = Math.max(r.tvl_usd, r.core_value_usd * 4), rows = [['Centre comp', v, 'b', 'a ' + money(R.fit.centre_tvl) + '-TVL token']];
    [['Size', f.size, '(TVL/centre)^' + R.fit.b.toFixed(2)]].concat(R.fit.terms.length ? [['Fitted terms', f.terms, R.fit.terms.join(', ')]] : [], [['Momentum', f.momentum, '7d prior'], ['Runway', f.runway, 'tokenless prior'], ['Class', f.class_factor, LABEL[r.class]]]).forEach(function (x) {
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
      line('Carry, ' + hz() + ' d', money(c.carry)) + line('Risk (' + p.risk + ')', money(c.risk)) + line('Total cost', money(c.total), 'tot') + '</tbody></table><table class="mini cost"><tbody>' +
      line('Drop if it launches', money(p.reward)) + line('× odds ' + odds(r.token_odds), money(p.expected)) + line('Lockup', p.lockup_days ? p.lockup_days + ' days' : 'none') +
      line('Break-even odds', p.breakeven_odds == null || p.breakeven_odds > 1 ? '> 100%' : odds(p.breakeven_odds)) + line('Work', '~' + p.hours.toFixed(1) + ' h') +
      line('Net expected', '<b class="v-' + p.verdict + '">' + signed(p.net) + '</b>', 'tot') + '</tbody></table></div>';
  }
  function detail(r) {
    var p = r.plan;
    return '<aside class="detail" aria-label="Protocol detail"><button class="close" id="close" aria-label="Close detail">✕</button><h2>' + esc(r.name) + '</h2>' +
      '<div class="meta">#' + r.rank + ' of ' + C.board + ' · ' + badge(r.class) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + '</div>' +
      '<div class="big"><div><div class="l">Implied value if it launches</div><div class="v">' + money(r.implied_value_usd) + '</div><div class="sub">P25–P75 ' + money(r.value_band_usd[1]) + ' – ' + money(r.value_band_usd[2]) + ' · P10–P90 ' + money(r.value_band_usd[0]) + ' – ' + money(r.value_band_usd[3]) + '</div></div>' +
      '<div><div class="l">Token odds</div><div class="v2">' + odds(r.token_odds) + '</div><div class="sub">expected ' + money(r.expected_value_usd) + '</div></div></div>' +
      '<div class="facts">' + fact('TVL', money(r.tvl_usd)) + fact('7-day change', pct(r.change_7d)) + fact('Tokenless for', days(r.tokenless_days)) + '</div>' +
      '<h3>How the value is built</h3>' + waterfall(r) +
      '<h3>Farm plan · ' + money(p.ticket) + ' ticket · ' + vchip(r) + '</h3>' + costs(r) + '<div class="budget">Budget ' + money(p.ticket) + ' back + ' + money(p.costs.total) + ' costs · ' + p.hours.toFixed(1) + ' h to ' + p.end + ' · ' + signed(p.net / p.hours) + '/h</div>' +
      '<ol class="steps">' + p.steps.map(function (s) { return '<li><div><b class="when">' + esc(s.when) + '</b> ' + esc(s.do) + ' <span class="tag c">' + esc(s.cost) + '</span> <span class="tag t">' + esc(s.time) + '</span></div></li>'; }).join('') + '</ol>' +
      '<div class="note">Core value ' + money(r.core_value_usd) + ' is the size fit on ' + C.comps + ' trading tokens; momentum and runway are stated priors. DefiLlama records no token for ' + esc(r.name) + ', which is not proof it has none; the value is this model\'s claim, not a forecast of a launch.</div></aside>';
  }

  function wireBoard() {
    var q = document.getElementById('q'), typing;
    q.addEventListener('input', function () { st.q = q.value; clearTimeout(typing); typing = setTimeout(function () { go(); q = document.getElementById('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 150); });
    app.querySelectorAll('[data-cls]').forEach(function (b) {
      b.onclick = function () { var c = b.getAttribute('data-cls'), i = st.cls.indexOf(c); if (i >= 0) st.cls.splice(i, 1); else st.cls.push(c); go(); };
    });
    ['cat', 'chain', 'min', 'v', 'dep', 'sh', 'hz'].forEach(function (id) { document.getElementById(id).onchange = function (e) { var v = e.target.value; st[id] = /min|dep|sh|hz/.test(id) ? +v : v; go(); }; });
    document.getElementById('csv').onclick = function () { save('csv'); };
    document.getElementById('json').onclick = function () { save('json'); };
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
    app.innerHTML = '<div class="prose"><p>These ' + C.set_aside + ' protocols record no token on DefiLlama but fail the watchlist\'s own rule: a CEX\'s reserve wallets, a staking or bridged wrapper, or a versioned product. Their value already trades as another token, so they stay off the ranked board; the reference value applies a class factor of ' + R.constants.DERIVATIVE + '.</p></div>' +
      '<div class="tbl"><div class="scroll"><table><thead><tr><th>Protocol</th><th>Category</th><th>Why set aside</th><th class="r">TVL</th><th class="r">7d</th><th class="r">Reference value</th></tr></thead><tbody>' +
      R.set_aside.map(function (r) { return '<tr><td class="nm">' + esc(r.name) + '</td><td class="sub">' + esc(r.category || '–') + '</td><td>' + esc(r.reason) + '</td><td class="r num">' + money(r.tvl_usd) + '</td><td class="r num">' + pct(r.change_7d) + '</td><td class="r num sub">' + money(r.implied_value_usd) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }

  // ---- model and its tests
  function model() {
    var K = R.constants, F = R.fit, H = '<tr><th></th><th class="r">ln-RMSE</th><th class="r">Median miss</th><th class="r">Within 3×</th><th class="r">Rank corr</th></tr>';
    app.innerHTML = '<div class="prose"><p>What would each protocol\'s token be worth if its record stayed as the snapshot shows it, and how likely is a token at all? Both answers are fitted on the snapshot\'s own protocols in <code>engine.js</code> and scored on data the fit did not see. No protocol is named in the code.</p>' +
      '<div class="formula">implied = core × momentum × runway × class<br>core: ln mcap = ' + F.a.toFixed(2) + ' + ' + F.b.toFixed(3) + ' × (ln TVL − ln ' + money(F.centre_tvl) + ')' + (F.terms.length ? ' + ' + F.terms.join(' + ') : '') + ', fitted on ' + C.comps + ' trading tokens<br>' +
      'value bands: the leave-one-out misses, P10 ' + x3(F.band[0]) + ' · P25 ' + x3(F.band[1]) + ' · P75 ' + x3(F.band[2]) + ' · P90 ' + x3(F.band[3]) + '<br>' +
      'momentum = 1 + clamp(7d, ' + K.GROWTH_FLOOR + '%, +' + K.GROWTH_CAP + '%) · runway = ' + K.RUNWAY_FLOOR + ' + ' + K.RUNWAY_RANGE + '(1 − e^(−days/' + K.RUNWAY_TAU + ')), unknown age ' + F.unknown_age_days + ' d<br>' +
      'class = 1 watchlist or early · ' + K.PARENTED + ' parented · ' + K.DERIVATIVE + ' derivative (set aside)<br>' +
      'token odds = logistic(ln TVL, ln(1 + years tracked), ln chains, family), ridge ' + K.ODDS_LAMBDA + ', fitted on ' + O.n + ' protocols (' + O.with_token + ' carry a token)<br>' +
      'drop on a ticket = implied / ' + K.LAUNCH_FLOAT + ' float × ' + K.AIRDROP_SHARE + ' to farmers × ' + K.FARM_DAYS + '/' + K.SEASON_DAYS + ' days × ticket / TVL</div></div>' +
      '<div class="cols"><div><h3>Value model, term by term</h3>' + steps() +
      '</div><div><h3>Token odds, ' + O.folds + '-fold cross-validated</h3><table class="mini"><tbody><tr><td>AUC (0.5 is a coin)</td><td class="r num">' + O.auc.toFixed(3) + '</td></tr><tr><td>Log-loss, model vs base rate ' + odds(O.base_rate) + '</td><td class="r num">' + O.log_loss.toFixed(3) + ' vs ' + O.base_log_loss.toFixed(3) + '</td></tr><tr><td>Brier, model vs base rate</td><td class="r num">' + O.brier.toFixed(3) + ' vs ' + O.base_brier.toFixed(3) + '</td></tr></tbody></table></div>' +
      '</div>';
  }

  // ---- router and the in-browser recompute
  function go() { writeHash(); render(); }
  function render() {
    document.querySelectorAll('[data-tab]').forEach(function (a) { a.setAttribute('aria-selected', String(a.getAttribute('data-tab') === st.tab)); });
    replan();
    if (st.tab === 'aside') aside(); else if (st.tab === 'model') model(); else board();
  }
  // The plan controls re-run engine.js with the deposit, drop share and horizon overridden.
  function hz() { return st.hz || R.constants.FARM_DAYS; }
  var planKey = '';
  function replan() {
    var key = [st.dep, st.sh, st.hz].join();
    if (key === planKey) return;
    planKey = key;
    var o = { TICKET: st.dep, AIRDROP_SHARE: st.sh || R.constants.AIRDROP_SHARE, FARM_DAYS: hz() };
    R.rows = st.dep || st.sh || st.hz ? window.RadarEngine.build(window.SNAPSHOT, o).rows : BASE;
    R.rows.forEach(function (r) { bySlug[r.slug] = r; });
    header();
  }
  function save(kind) {
    var rows = filtered(), K = ['rank', 'slug', 'name', 'class', 'category', 'tvl_usd', 'change_7d', 'tokenless_days', 'implied_value_usd', 'token_odds', 'expected_value_usd'], a = document.createElement('a');
    var csv = [K.concat('p25', 'p75', 'verdict', 'net', 'ticket', 'cost', 'hours').join(',')].concat(rows.map(function (r) {
      return K.map(function (k) { return JSON.stringify(r[k] == null ? '' : r[k]); }).concat(r.value_band_usd[1], r.value_band_usd[2], r.plan.verdict, r.plan.net, r.plan.ticket, r.plan.costs.total, r.plan.hours).join(',');
    })).join('\n');
    a.href = URL.createObjectURL(new Blob([kind === 'csv' ? csv : JSON.stringify(rows, null, 1)], { type: 'text/' + kind }));
    a.download = 'token-radar-' + R.as_of + '.' + kind;
    a.click();
  }
  window.addEventListener('hashchange', function () { readHash(); render(); });
  readHash();
  header();
  render();
  setTimeout(function () {
    if (!window.RadarEngine || !window.SNAPSHOT) return;
    var t0 = performance.now(), b = window.RadarEngine.build(window.SNAPSHOT), ok = 0;
    b.rows.forEach(function (r, i) { var s = BASE[i]; if (s && s.slug === r.slug && s.implied_value_usd === r.implied_value_usd && s.token_odds === r.token_odds && s.plan.net === r.plan.net) ok++; });
    check = { ok: ok, ms: Math.round(performance.now() - t0) };
    header();
    document.body.setAttribute('data-checked', '1');
  }, 30);
})();
