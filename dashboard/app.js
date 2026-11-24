// Token Radar page: renders window.RADAR (main.ts ran _engine.js) as the board, with its cover, filters, plan
// controls and detail, and the model's held-out tests. It re-runs _engine.js here on the same snapshot and
// checks every row. State lives in the hash, so each view can be linked and captured.
(() => {
  'use strict';
  const R = window.RADAR, app = document.getElementById('app'), $ = (id) => document.getElementById(id);
  if (!R) { app.innerHTML = '<p class="empty">data.js is missing: run main.ts.</p>'; return; }
  const CLS = ['watch', 'early', 'parented'], LABEL = { watch: 'Watchlist', early: 'Early (below floor)', parented: 'Parent (inferred)' };
  const COLOR = { watch: 'var(--sig)', early: 'var(--amber)', parented: 'var(--violet)' };
  const T = R.test, O = R.odds_test, C = R.counts, BASE = R.rows, bySlug = {};
  const LO = Math.log(BASE[BASE.length - 1].value_band_usd[1]), HI = Math.log(BASE[0].value_band_usd[2]);
  let st, check = null, planKey = '';

  // ---- formatting
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const money = (x) => {
    const a = Math.abs(x), s = x < 0 ? '−$' : '$';
    return a >= 1e9 ? s + (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? s + (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M' : a >= 1e4 ? s + (a / 1e3).toFixed(0) + 'K' : a >= 100 ? s + Math.round(a).toLocaleString('en-US') : s + a.toFixed(2);
  };
  const pct = (x) => x == null ? '<i class="sub">n/a</i>' : `<span class="${x >= 0 ? 'pos' : 'neg'}">${x >= 0 ? '+' : ''}${x.toFixed(1)}%</span>`;
  const odds = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';
  const days = (d) => d == null ? '<i class="sub">unknown</i>' : d >= 365 ? (d / 365).toFixed(1) + ' y' : d + ' d';
  const signed = (x) => (x >= 0 ? '+' : '') + money(x);
  const vchip = (r) => `<span class="vd v-${r.plan.verdict}">${r.plan.verdict}</span>`;
  const cell = (t, c, tag = 'td') => `<${tag}${c ? ` class="${c}"` : ''}>${t}</${tag}>`;
  const table = (head, rows, cls = 'mini') => `<table class="${cls}">${head ? `<thead><tr>${head.map((h) => cell(h[0], h[1], 'th')).join('')}</tr></thead>` : ''}<tbody>${rows.join('')}</tbody></table>`;
  const hz = () => st.hz || R.constants.FARM_DAYS;

  // ---- state in the hash: #/board?cls=early&sort=net&dir=desc&sel=slug
  const KEYS = ['q', 'cat', 'chain', 'v', 'dep', 'sh', 'hz'];
  function readHash() {
    const h = location.hash.replace(/^#\/?/, '').split('?'), p = new URLSearchParams(h[1] || '');
    st = { tab: h[0] === 'model' ? 'model' : 'board', sort: p.get('sort') || 'rank', sel: p.get('sel') || '', cls: p.get('cls') ? p.get('cls').split(',') : CLS.slice() };
    KEYS.forEach((k) => { st[k] = /dep|sh|hz/.test(k) ? +p.get(k) || 0 : p.get(k) || ''; });
    st.asc = p.get('dir') ? p.get('dir') === 'asc' : st.sort === 'rank';
  }
  function go() {
    const p = new URLSearchParams();
    KEYS.forEach((k) => st[k] && p.set(k, st[k]));
    if (st.cls.length < 3) p.set('cls', st.cls.join(','));
    if (st.sort !== 'rank') { p.set('sort', st.sort); p.set('dir', st.asc ? 'asc' : 'desc'); }
    if (st.sel) p.set('sel', st.sel);
    history.replaceState(null, '', `#/${st.tab}${p.toString() ? '?' + p : ''}`);
    render();
  }

  // ---- header: six numbers about the shipped model and the board, then the self-checks
  const count = (k) => BASE.filter((r) => r.class === k).length;
  const ledger = () => [['Watchlist', count('watch'), 'var(--sig)'], ['Parent (inferred)', count('parented'), 'var(--violet)'], ['Early, below floor', count('early'), 'var(--amber)'],
    ['Set aside: derivative', C.set_aside, 'var(--ink-3)'], ['Token trades', C.live, 'var(--l2)']];
  function header() {
    $('ver').textContent = R.model;
    $('asof').textContent = `Snapshot ${R.as_of} · DefiLlama · offline`;
    const m = T.steps[T.steps.length - 1], fl = T.steps[0], cv = T.coverage, n = { farm: 0, marginal: 0, skip: 0 }, sum = ledger().reduce((a, g) => a + g[1], 0);
    R.rows.forEach((r) => n[r.plan.verdict]++);
    const k = [
      ['Out-of-sample miss', `×${m.test.median_x.toFixed(2)} <small>vs ×${fl.test.median_x.toFixed(2)} flat</small>`, `shipped, median, newest ${T.split.test}`, 1],
      ['Range honesty', `${Math.round(cv.p25_p75 * 100)}% · ${Math.round(cv.p10_p90 * 100)}%`, 'newest in P25–75 · P10–90 (aim 50·80)', Math.abs(cv.p25_p75 - 0.5) < 0.15 && Math.abs(cv.p10_p90 - 0.8) < 0.1],
      ['Token odds Brier', `${O.shipped.test.toFixed(3)} <small>vs ${O.steps[0].test.toFixed(3)}</small>`, `newest ${O.split.test} vs base rate`, O.shipped.test < O.steps[0].test],
      ['Terms kept', `${T.kept}/${T.tried} <small>value</small> ${O.kept.length}/${O.steps.length - 1} <small>odds</small>`, 'only if both held-out tests fall', 1],
      ['Worth farming', `${n.farm} <small>+${n.marginal} marginal</small>`, `${money(R.rows[0].plan.ticket)}, ${hz()} d, net of costs`, n.farm > 0],
      ['Watchlist ranked', `${C.watch_covered} / ${C.watch}`, `+${C.board - C.watch_covered} more found`, C.watch_covered === C.watch],
    ];
    const ch = [[`table = board.json ${check ? check + '/' + C.board : '…'}`, check === C.board],
      ['ranks in order', BASE.every((r, i) => r.rank === i + 1 && (!i || BASE[i - 1].implied_value_usd >= r.implied_value_usd))],
      [`ledger ${sum}/${C.protocols}`, sum === C.protocols], [`watchlist ${C.watch_covered}/${C.watch}`, C.watch_covered === C.watch],
      [`main.ts sha256 ${R.main_sha256.slice(0, 8)}`, 1], [`board.json sha256 ${R.board_sha256.slice(0, 8)}`, 1]];
    $('kpis').innerHTML = k.map((x) => `<div class="kpi"><b>${x[0]}</b><div class="v${x[3] ? ' ok' : ''}">${x[1]}</div>${x[2]}</div>`).join('') +
      `<div class="chips">${ch.map((c) => `<span class="${c[1] ? 'ok' : ''}">${c[1] ? '✓' : '·'} ${c[0]}</span>`).join('')}</div>`;
  }

  // ---- the two term-by-term tables
  function steps(S, k, h, dp) {
    const V = { baseline: 'baseline', shipped: 'shipped', true: 'kept', false: 'not kept' }, f = (v) => v == null ? '–' : (v.rmse || v).toFixed(dp);
    return table([['Term, in order'], ...h.map((x) => [x, 'r']), ['']], S.map((s) => `<tr>${cell(esc(s.term))}${k.map((x) => cell(f(s[x]), 'r num')).join('')}${cell(V[s.kept], 'k-' + s.kept)}</tr>`), 'mini st');
  }
  const tests = () => `<div><h3>Value: ln-RMSE held out</h3>${steps(T.steps, ['loo', 'val', 'test'], ['LOO ' + T.split.train, 'Val ' + T.split.val, 'Newest ' + T.split.test], 2)}
    <p class="note">Terms are chosen on the oldest ${T.split.train} only: kept if leave-one-out and validation both fall. The brief's growth and runway stay, weighted ^${T.w} on validation. The last row is what ships; newest caps scored unclamped.</p></div>
    <div><h3>Token odds: Brier held out</h3>${steps(O.steps, ['cv', 'val', 'test'], [O.folds + '-fold ' + O.split.train, 'Walk-fwd ' + O.split.val, 'Newest ' + O.split.test], 3)}
    <p class="note">${O.n} protocols, ${O.with_token} with a token. Kept if CV on the older two thirds and walk-forward both fall; the newest (since ${O.split.test_from}) never choose.</p></div>`;

  // ---- cover: the tests, where every protocol went, the best plans and one written out
  const plan = (r, p = r.plan) => `<div class="budget">Budget ${money(p.ticket)} back + ${money(p.costs.total)} costs · ${p.hours.toFixed(1)} h to ${p.end} · ${signed(p.net / p.hours)}/h</div><ol class="steps">` +
    p.steps.map((s) => `<li><b class="when">${esc(s.when)}</b> ${esc(s.do)} <span class="tag c">${esc(s.cost)}</span> <span class="tag t">${esc(s.time)}</span></li>`).join('') + '</ol>';
  function cover() {
    const L = ledger(), why = {}, B = R.rows.slice().sort((a, b) => b.plan.net - a.plan.net), pos = B.filter((r) => r.plan.net > 0).length, t = B[0];
    R.set_aside.forEach((r) => { const k = r.reason.replace(/^category /, ''); why[k] = (why[k] || 0) + 1; });
    const sub = ['', 'no parent field: at or above the floor, off the watchlist', '', Object.keys(why).map((k) => `${esc(k)} ${why[k]}`).join(' · '), `launched; ${C.comps} price the model`];
    return `<div class="cover">${tests()}<div><h3>Every snapshot protocol, in exactly one group</h3><div class="led">${L.map((g) => `<span style="flex:${g[1]};background:${g[2]}"></span>`).join('')}</div>
      <div class="lg">${L.map((g, i) => `<div><i class="cd" style="background:${g[2]}"></i>${g[0]} <b>${g[1]}</b><div class="sub">${sub[i]}</div></div>`).join('')}<div>All protocols ≥ $5M <b>${C.protocols}</b></div></div></div></div>
      <div class="cover c2"><div><h3>${pos ? `Best farms first: ${pos} net positive` : `No plan clears its costs at ${money(t.plan.ticket)} over ${hz()} d: closest first`}</h3>` +
      table(0, B.slice(0, 9).map((r) => `<tr data-slug="${esc(r.slug)}">${cell('#' + r.rank, 'num')}${cell(`${esc(r.name)}<div class="sub">${esc(r.category)} · ${esc(r.plan.chain)} · ${odds(r.plan.launch_odds)} in ${hz()} d</div>`)}${cell(vchip(r))}${cell(`${signed(r.plan.net)}<div class="sub">${signed(r.plan.net / r.plan.hours)}/h</div>`, 'r num')}</tr>`), 'mini bf') +
      `<button class="chip" id="best">Whole board, best net first →</button></div><div><h3>${pos ? 'Top farm' : 'Closest to break-even'}, written out: ${esc(t.name)} ${vchip(t)}</h3>${plan(t)}</div></div>`;
  }

  // ---- board
  const COLS = [['rank', '#', 'r'], ['name', 'Protocol'], ['class', 'Class', 'x2'], ['tvl_usd', 'TVL', 'r x2'], ['change_7d', '7d', 'r'], ['tokenless_days', 'No token for', 'r'],
    ['implied_value_usd', 'Implied value', 'r'], ['token_odds', 'Token odds', 'r'], ['expected_value_usd', 'Expected', 'r x2'], ['net', 'Farm plan', 'r']];
  const sortVal = (r, k) => k === 'net' ? r.plan.net : k === 'name' || k === 'class' ? String(r[k]).toLowerCase() : r[k] ?? -Infinity;
  function filtered() {
    const q = st.q.toLowerCase();
    return R.rows.filter((r) => st.cls.includes(r.class) && (!st.cat || r.category === st.cat) && (!st.chain || r.chains.includes(st.chain)) &&
      (!st.v || (st.v === 'farm' ? r.plan.verdict === 'farm' : r.plan.verdict !== 'skip')) && (!q || `${r.name} ${r.category} ${r.chains.join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => { const x = sortVal(a, st.sort), y = sortVal(b, st.sort), c = x < y ? -1 : x > y ? 1 : a.rank - b.rank; return st.asc ? c : -c; });
  }
  function tally(f) {
    const m = {};
    BASE.forEach((r) => f(r).forEach((v) => { m[v] = (m[v] || 0) + 1; }));
    return Object.keys(m).sort((a, b) => m[b] - m[a] || (a < b ? -1 : 1)).map((k) => [k, `${k} (${m[k]})`]);
  }
  const CATS = tally((r) => [r.category || 'Uncategorised']), CHAINS = tally((r) => r.chains).slice(0, 40);
  const select = (id, opts) => `<select id="${id}" aria-label="${id}">${opts.map((o) => `<option value="${esc(o[0])}"${String(o[0]) === String(st[id]) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  function rng(r) {
    const b = r.value_band_usd, x = (v) => (((Math.log(v) - LO) / (HI - LO)) * 100).toFixed(1);
    return `<i class="rg"><s style="left:${x(b[1])}%;width:${x(b[2]) - x(b[1])}%"></s><u style="left:${x(r.implied_value_usd)}%"></u></i>`;
  }
  function board() {
    const rows = filtered(), sel = st.sel && bySlug[st.sel], plain = !sel && st.cls.length === 3 && !st.q && !st.cat && !st.chain && !st.v && st.sort === 'rank';
    const f = `<div class="filters"><input type="search" id="q" placeholder="Search name, category, chain" value="${esc(st.q)}" aria-label="Search">` +
      CLS.map((c) => `<button class="chip" data-cls="${c}" aria-pressed="${st.cls.includes(c)}"><i style="background:${COLOR[c]}"></i>${LABEL[c]}</button>`).join('') +
      select('cat', [['', 'All categories'], ...CATS]) + select('chain', [['', 'All chains'], ...CHAINS]) + select('v', [['', 'Any verdict'], ['ok', 'Farm or marginal'], ['farm', 'Farm only']]) +
      `<span class="ctl">Plan: ${select('dep', [[0, '$2,500 deposit'], [1000, '$1,000'], [10000, '$10,000'], [25000, '$25,000']])}` +
      select('sh', [[0, 'drop 7.5% of supply'], [0.03, 'drop 3%'], [0.15, 'drop 15%']]) + select('hz', [[0, '90-day horizon'], [30, '30 days'], [180, '180 days']]) +
      `<button class="chip" id="csv">CSV</button></span><span class="count">${rows.length} of ${R.rows.length} · rank = implied value</span></div>`;
    const head = COLS.map((c) => `<th data-k="${c[0]}" class="${c[2] || ''}${st.sort === c[0] ? ' on' + (st.asc ? ' asc' : '') : ''}">${c[1]}</th>`).join('');
    const body = rows.map((r) => {
      const p = r.plan;
      return `<tr data-slug="${esc(r.slug)}"${r.slug === st.sel ? ' class="sel"' : ''}>${cell(r.rank, 'r num')}` +
        cell(`<div class="nm"><i class="cd" style="background:${COLOR[r.class]}"></i>${esc(r.name)}</div><div class="sub">${esc(r.category || 'Uncategorised')} · ${esc(r.chains[0])}${r.chains.length > 1 ? ' +' + (r.chains.length - 1) : ''}</div>`) +
        cell(`<span class="badge b-${r.class}">${LABEL[r.class]}</span>`, 'x2') + cell(money(r.tvl_usd), 'r num x2') + cell(pct(r.change_7d), 'r num') + cell(days(r.tokenless_days), 'r num') +
        cell(`<b>${money(r.implied_value_usd)}</b>${rng(r)}<em>P25–75 ${money(r.value_band_usd[1])}–${money(r.value_band_usd[2])}</em>`, 'r num') +
        cell(`${odds(r.token_odds)}<em>${odds(p.launch_odds)} in ${hz()} d</em>`, 'r num') + cell(money(r.expected_value_usd), 'r num x2') +
        cell(`${vchip(r)} ${signed(p.net)}<em>${money(p.ticket)} in · cost ${money(p.costs.total)} · ${p.hours.toFixed(1)} h</em>`, 'r num fp') + '</tr>';
    }).join('');
    app.innerHTML = (plain ? cover() : '') + f + `<div class="split${sel ? '' : ' solo'}"><div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>` +
      (body || '<tr><td colspan="10" class="empty">No protocol matches these filters.</td></tr>') + `</tbody></table></div>${sel ? detail(sel) : ''}</div>`;
    wire();
  }

  // ---- detail: the value built step by step, the costs against the drop, and the dated plan
  function waterfall(r) {
    const f = r.factors, F = R.fit, top = Math.max(r.tvl_usd, r.core_value_usd * 4), w = '^' + F.w;
    let v = f.base;
    const rows = [['Centre comp', v, 'b', `a ${money(F.centre_tvl)}-TVL token`]];
    [['Size', f.size, `(TVL/centre)^${F.b.toFixed(2)}`], ...(F.terms.length ? [['Fitted terms', f.terms, F.terms.join(', ')]] : []),
      ['Momentum', f.momentum, '7d prior ' + w], ['Runway', f.runway, 'tokenless prior ' + w], ['Class', f.class_factor, LABEL[r.class]]].forEach((x) => {
      v *= x[1]; rows.push([`${x[0]} ×${x[1].toFixed(3)}`, v, x[1] >= 1 ? '' : 'cut', x[2]]);
    });
    return `<div class="wf">${rows.map((s) => `<div>${esc(s[0])} <small>${esc(s[3])}</small></div><div class="t"><span class="${s[2]}" style="width:${Math.min(100, Math.max(0.6, Math.sqrt(s[1] / top) * 100)).toFixed(1)}%"></span></div><div class="num">${money(s[1])}</div>`).join('')}</div>`;
  }
  function detail(r) {
    const p = r.plan, c = p.costs;
    return `<aside class="detail"><button class="close" id="close" aria-label="Close">✕</button><h2>${esc(r.name)}</h2><div class="sub">#${r.rank} of ${C.board} · ${LABEL[r.class]} · ${esc(r.category)} · ${esc(r.chains.slice(0, 6).join(', '))}${r.chains.length > 6 ? ` +${r.chains.length - 6} chains` : ''}</div>
      <div class="big"><div><b>Implied value if it launches</b><div class="v">${money(r.implied_value_usd)}</div><div class="sub">P25–75 ${money(r.value_band_usd[1])}–${money(r.value_band_usd[2])} · P10–90 ${money(r.value_band_usd[0])}–${money(r.value_band_usd[3])}</div></div>
      <div><b>Token odds</b><div class="v v2">${odds(r.token_odds)}</div><div class="sub">TVL ${money(r.tvl_usd)} · 7d ${pct(r.change_7d)} · no token ${days(r.tokenless_days)}</div></div></div>
      <h3>How the value is built</h3>${waterfall(r)}<h3>Farm plan · ${money(p.ticket)} on ${esc(p.chain)}${p.evm ? '' : ' (not EVM)'} · ${vchip(r)}</h3>
      <div class="budget">${odds(p.launch_odds)} launch chance in ${hz()} d × ${money(p.reward)} drop = ${money(p.expected)}, against ${money(c.total)} costs (gas ${money(c.gas)}, bridge ${money(c.bridge)}, carry ${money(c.carry)}, ${p.risk} risk ${money(c.risk)}): <b class="v-${p.verdict}">${signed(p.net)}</b>${p.lockup_days ? ` · ${p.lockup_days}-day lockup` : ''}</div>${plan(r)}
      <p class="note">Launch chance h = (P(t+H) − P(t)) / (1 − P(t)) off the fitted token-odds curve: a cross-sectional approximation, not a calendar. No token on DefiLlama is not proof of none.</p></aside>`;
  }

  function wire() {
    let q = $('q'), typing;
    q.oninput = () => { st.q = q.value; clearTimeout(typing); typing = setTimeout(() => { go(); q = $('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 150); };
    app.querySelectorAll('[data-cls]').forEach((b) => { b.onclick = () => { const c = b.dataset.cls; st.cls = st.cls.includes(c) ? st.cls.filter((x) => x !== c) : [...st.cls, c]; go(); }; });
    ['cat', 'chain', 'v', 'dep', 'sh', 'hz'].forEach((id) => { $(id).onchange = (e) => { st[id] = /dep|sh|hz/.test(id) ? +e.target.value : e.target.value; go(); }; });
    $('csv').onclick = save;
    if ($('best')) $('best').onclick = () => { st.sort = 'net'; st.asc = false; go(); };
    app.querySelectorAll('th[data-k]').forEach((th) => { th.onclick = () => { const k = th.dataset.k; if (st.sort === k) st.asc = !st.asc; else { st.sort = k; st.asc = k === 'rank' || k === 'name'; } go(); }; });
    app.querySelectorAll('tr[data-slug]').forEach((tr) => { tr.onclick = () => { st.sel = st.sel === tr.dataset.slug ? '' : tr.dataset.slug; go(); }; });
    if ($('close')) $('close').onclick = () => { st.sel = ''; go(); };
    app.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
  }

  // ---- model: the formula, both tests, a calibration scatter and the assumptions no data can test
  function scatter() {
    const P = T.points, W = 400, lo = Math.min(...P.flatMap((p) => [p[0], p[1]])), hi = Math.max(...P.flatMap((p) => [p[0], p[1]]));
    const x = (v) => (34 + ((v - lo) / (hi - lo)) * (W - 44)).toFixed(1), y = (v) => (W - 26 - ((v - lo) / (hi - lo)) * (W - 44)).toFixed(1), l3 = Math.log(3);
    let g = '';
    for (let d = Math.ceil(lo / Math.LN10); d <= hi / Math.LN10; d++) g += `<line x1="34" x2="${W - 10}" y1="${y(d * Math.LN10)}" y2="${y(d * Math.LN10)}"/><text x="30" y="${+y(d * Math.LN10) + 4}" text-anchor="end">${money(10 ** d)}</text>`;
    return `<svg class="sc" viewBox="0 0 ${W} ${W}" role="img" aria-label="Predicted against actual market cap">${g}` +
      [0, l3, -l3].map((o) => `<line class="${o ? 'b3' : 'id'}" x1="${x(lo)}" y1="${y(lo + o)}" x2="${x(hi)}" y2="${y(hi + o)}"/>`).join('') +
      P.map((p) => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="3.2" class="${p[2] ? 't' : 'l'}"/>`).join('') +
      `<text x="${W / 2}" y="${W - 6}" text-anchor="middle">predicted (held out) against actual cap; dashed = within 3×</text></svg>`;
  }
  function model() {
    const K = R.constants, F = R.fit, A = { PARENTED: 'parent class factor', LAUNCH_FLOAT: 'float at launch', AIRDROP_SHARE: 'supply to farmers', SEASON_DAYS: 'season, days' };
    app.innerHTML = `<div class="formula">implied = core × (momentum × runway)^${F.w} × class<br>core: ln mcap = ${F.a.toFixed(2)} + ${F.b.toFixed(3)} × (ln TVL − ln ${money(F.centre_tvl)})${F.terms.map((t) => ' + ' + t).join('')}, ridge on ${C.comps} trading tokens<br>
      momentum = 1 + clamp(7d, ${K.GROWTH_FLOOR}%, +${K.GROWTH_CAP}%) · runway = ${K.RUNWAY_FLOOR} + ${K.RUNWAY_RANGE}(1 − e^(−days/${K.RUNWAY_TAU})), unknown age ${F.unknown_age_days} d<br>
      bands: shipped leave-one-out misses, P10 ×${F.band[0]} · P25 ×${F.band[1]} · P75 ×${F.band[2]} · P90 ×${F.band[3]}<br>
      token odds P(t) = logistic(${O.kept.join(', ') || 'base rate'}) · launch within H days h = (P(t+H) − P(t)) / (1 − P(t))<br>
      drop = implied / ${K.LAUNCH_FLOAT} float × ${K.AIRDROP_SHARE} to farmers × H/${K.SEASON_DAYS} d × deposit / TVL · farm if h × drop > 1.5 × costs and 7d > ${K.EXIT_7D}%</div>
      <div class="cols m">${tests()}<div><h3>Calibration: ${T.split.train} train (leave-one-out) · <span class="pos">${T.split.test} newest</span></h3>${scatter()}</div>
      <div><h3>Assumptions no snapshot can test</h3>${table([['Assumption'], ['Value', 'r'], ['Verdicts flip at ½×', 'r'], ['at 2×', 'r']], R.assumptions.map((a) => `<tr>${cell(A[a.key])}${cell(a.value, 'r num')}${cell(a.half, 'r num')}${cell(a.double, 'r num')}</tr>`))}
      <p class="note">Of ${C.board} farm verdicts at the default plan. Parent is inferred (the snapshot has no parent field): a protocol at or above the floor that the watchlist leaves out.</p></div></div>`;
  }

  // ---- router, plan controls and the in-browser recompute
  function render() {
    document.querySelectorAll('[data-tab]').forEach((a) => a.setAttribute('aria-selected', String(a.dataset.tab === st.tab)));
    const key = [st.dep, st.sh, st.hz].join();
    if (key !== planKey) { // deposit, drop share and horizon re-run the engine; 0 keeps its default
      planKey = key;
      R.rows = st.dep || st.sh || st.hz ? window.RadarEngine.build(window.SNAPSHOT, { TICKET: st.dep, AIRDROP_SHARE: st.sh, FARM_DAYS: st.hz }).rows : BASE;
      R.rows.forEach((r) => { bySlug[r.slug] = r; });
      header();
    }
    if (st.tab === 'model') model(); else board();
  }
  function save() {
    const K = ['rank', 'slug', 'name', 'class', 'category', 'tvl_usd', 'change_7d', 'tokenless_days', 'implied_value_usd', 'token_odds', 'expected_value_usd'], a = document.createElement('a');
    const csv = [[...K, 'p25', 'p75', 'launch_odds', 'verdict', 'net', 'ticket', 'cost', 'hours'].join(',')].concat(filtered().map((r) => {
      const p = r.plan;
      return [...K.map((k) => JSON.stringify(r[k] ?? '')), r.value_band_usd[1], r.value_band_usd[2], p.launch_odds, p.verdict, p.net, p.ticket, p.costs.total, p.hours].join(',');
    })).join('\n');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `token-radar-${R.as_of}.csv`;
    a.click();
  }
  window.addEventListener('hashchange', () => { readHash(); render(); });
  readHash();
  render();
  setTimeout(() => {
    const b = window.RadarEngine.build(window.SNAPSHOT);
    check = b.rows.filter((r, i) => BASE[i].slug === r.slug && BASE[i].implied_value_usd === r.implied_value_usd && BASE[i].token_odds === r.token_odds && BASE[i].plan.net === r.plan.net).length;
    header();
    document.body.setAttribute('data-checked', '1');
  }, 30);
})();
