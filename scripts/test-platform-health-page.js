#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   PLATFORM HEALTH — loading states, no invented numbers (no browser)
   ------------------------------------------------------------------------------
   Runs platform-health-view.js in a VM against a fake DOM and fake callables, and
   statically checks the three surfaces that consume it.

   Fixture shapes are copied from the SERVING archive of getPlatformHealthScores /
   getTopBusinessPriorities (f4422b4, revisions getplatformhealthscores-00014-jep and
   gettopbusinesspriorities-00015-hin), not invented: overall + marketplace / seller /
   buyer / operational / cost, a withheld overall (score:null, failedDimensions) when a
   dimension throws, and `topPriorities`.

   States: success · empty · partial (withheld overall) · permission-denied · internal ·
   hang → timeout · priorities-only failure · Retry.

   HISTORY (2026-10-04): getPlatformHealthScores.history = daily snapshots
   [{date, overall, dimensions{5}}] (functions branch feat/platform-health-history-on-669e5ba).
   The over-time chart and KPI sparklines draw ONLY from it; every plotted value must trace
   to a history fixture entry for that series and date; nulls and missing days are gaps.
   Control (c): a mutant that plots null as 0 must fail "history: nulls are gaps, not zeros".

   NEGATIVE CONTROL: the same rows are run against a mutant whose fmtScore renders an
   unknown as "0". The control passes only if the row named
   "unknown overall renders — (never 0)" FAILS on the mutant — proving the suite can see
   the defect it exists to prevent.

     node scripts/test-platform-health-page.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const VIEW_SRC = read('platform-health-view.js');
const DASH = '—';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail && !ok ? '   [' + String(detail).slice(0, 160) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); }
};

function loadView(src) {
  const sandbox = { setTimeout, clearTimeout, Promise, Math, Date, String, Array, Object, isFinite, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'platform-health-view.js' }).runInContext(sandbox);
  return sandbox.SokoniPlatformHealthView;
}

const IDS = ['computed-at', 'overall-fill', 'overall-score', 'overall-grade', 'overall-title',
  'overall-sub', 'alerts-area', 'loading-state', 'main-content', 'scores-grid',
  'priorities-area', 'empty-state', 'error-state', 'error-title', 'error-message', 'retry-btn',
  'ring-marketplace', 'ring-seller', 'ring-buyer', 'ring-operational', 'ring-cost',
  /* redesign 2026-10-04 */
  'status-pill', 'kpi-grid', 'trend-area', 'breakdown-area', 'refresh-btn', 'panel-refresh-btn',
  'panel-computed', 'panel-pri-computed', 'panel-budget', 'panel-recommendation', 'panel-signals'];
/* Regions that carry server-derived content in the data state — the traceability walk
   reads every digit in these and nowhere else (static copy is checked separately). */
const DYNAMIC = ['overall-score', 'overall-grade', 'overall-title', 'overall-sub', 'status-pill',
  'computed-at', 'alerts-area', 'kpi-grid', 'trend-area', 'breakdown-area', 'priorities-area',
  'scores-grid', 'panel-computed', 'panel-pri-computed', 'panel-budget', 'panel-recommendation',
  'panel-signals'];
function fakeDoc() {
  const els = {};
  IDS.forEach((id) => {
    els[id] = { id, textContent: '', innerHTML: '', style: {}, onclick: null, disabled: false, className: '',
      attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  });
  els['overall-score'].textContent = DASH;
  els['loading-state'].style.display = 'block';
  els['main-content'].style.display = 'none';
  els['error-state'].style.display = 'none';
  return { els, getElementById: (id) => els[id] || null };
}
const visible = (doc) => ['loading-state', 'main-content', 'empty-state', 'error-state']
  .filter((id) => doc.els[id].style.display && doc.els[id].style.display !== 'none');
const err = (code, message) => Object.assign(new Error(message), { code });

function dimBlock(score, rows) {
  return { score, grade: score >= 80 ? 'A' : score >= 60 ? 'C' : 'D', dataComplete: true, dimensions: rows };
}
const SUCCESS = {
  overall: { score: 72, grade: 'C' },
  marketplace: dimBlock(64, [
    { name: 'Payment Success Rate', value: '96%', contribution: 28.8, max: 30, missing: false },
    { name: 'Listing Completeness (images)', value: 'No active products yet', contribution: 0, max: 25, missing: true },
  ]),
  seller: dimBlock(70, []), buyer: dimBlock(81, []), operational: dimBlock(90, []), cost: dimBlock(55, []),
  alerts: [{ severity: 'high', area: '<img src=x onerror=alert(1)>', message: 'Marketplace health is below 60' }],
  computedAt: '2026-10-03T08:00:00.000Z',
  indexBudget: { used: 192, max: 200 },
};
const PARTIAL = {
  overall: { score: null, grade: null, unavailable: true, failedDimensions: ['operational'] },
  marketplace: dimBlock(64, []), seller: dimBlock(70, []), buyer: dimBlock(81, []), cost: dimBlock(55, []),
  operational: { score: null, grade: null, dimensions: [], dataComplete: false, failed: true,
    error: { code: '9', message: 'FAILED_PRECONDITION: The query requires an index.' } },
  alerts: [{ severity: 'high', area: 'Diagnostics', message: 'The operational dimension could not be computed' }],
  computedAt: '2026-10-03T08:00:00.000Z', indexBudget: { used: 192, max: 200 },
};
const ZERO = JSON.parse(JSON.stringify(SUCCESS)); ZERO.overall = { score: 0, grade: 'F' };
const PRIORITIES = { topPriorities: [
  { name: 'Wallet & Seller Payouts', description: 'Seller balance', totalScore: 18, revenueImpact: 5,
    userDemand: 3, effortInverse: 2, strategic: 5, costInverse: 3, evidenceReady: false,
    evidenceGate: 'Need ≥50 active sellers (currently 3)' },
  /* hostile name + no numeric totalScore: escaped, and no bar */
  { name: '<script>alert(1)</script>Jobs', description: 'Employer dashboard', evidenceReady: true,
    evidenceGate: 'READY — 22 job-related searches logged' }],
  recommendation: 'Wallet & Seller Payouts',
  evidenceSignals: { activeSellerCount: 3, cartToPaidRate: 12.5, jobSearchCount: 22, loyaltyMentions: 1, walletMentions: 2 },
  computedAt: '2026-10-03T08:00:05.000Z' };

/* Every number a fixture carries, in the forms the view may print (raw, rounded,
   one decimal) plus digit runs inside server strings. computedAt is excluded: times are
   rendered inside <time datetime> and checked against the ISO value separately. */
function fixtureNumbers(...objs) {
  const out = new Set();
  const add = (n) => { out.add(String(n)); out.add(String(Math.round(n))); out.add(String(Math.round(n * 10) / 10)); };
  const walk = (v, k) => {
    if (k === 'computedAt') return;
    if (typeof v === 'number' && isFinite(v)) add(v);
    else if (typeof v === 'string') (v.match(/\d+(?:\.\d+)?/g) || []).forEach((m) => out.add(m));
    else if (v && typeof v === 'object') Object.keys(v).forEach((kk) => walk(v[kk], kk));
  };
  objs.forEach((o) => walk(o));
  return out;
}
/* Constants of the SERVER's formulas, shown as labels: the five overall weights, the
   0–100 score scale, and the priorities' 25-point maximum (5 criteria × 5). */
const STATIC_NUMBERS = new Set(['30', '25', '15', '5', '100']);
function renderedText(doc) {
  return DYNAMIC.map((id) => doc.els[id].textContent + ' ' + doc.els[id].innerHTML).join(' ')
    .replace(/<time\b[^>]*>[\s\S]*?<\/time>/g, ' ')
    /* the chart's y-axis ticks are the fixed 0–100 score scale — asserted by their own row */
    .replace(/<div class="ph-axis"[^>]*>[\s\S]*?<\/div>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function untraced(doc, ...fixtures) {
  const ok = fixtureNumbers(...fixtures);
  return (renderedText(doc).match(/\d+(?:\.\d+)?/g) || []).filter((n) => !ok.has(n) && !STATIC_NUMBERS.has(n));
}
/* Daily history fixture. 09-29: overall null (operational failed). 10-01: no snapshot.
   Seller is null on every day (never measured) → no seller line, no seller spark. */
const HDAY = (date, overall, m, b, o, c) => ({ date, overall, dimensions: { marketplace: m, seller: null, buyer: b, operational: o, cost: c } });
const HISTORY = [
  HDAY('2026-09-27', 61, 52, 77, 88, 55),
  HDAY('2026-09-28', 63, 54, 78, 89, 55),
  HDAY('2026-09-29', null, 56, 79, null, 55),
  HDAY('2026-09-30', 66, 58, 80, 91, 55),
  HDAY('2026-10-02', 70, 62, 82, 93, 55),
  HDAY('2026-10-03', 72, 64, 81, 90, 55),
];
const HIST = Object.assign(JSON.parse(JSON.stringify(SUCCESS)), { history: HISTORY });
/* Every point a chart draws: from <title>date: value</title> and from polyline vertices
   mapped back through the 0–100 scale. Returns [{series, date|null, v}]. */
function plotted(trendHtml) {
  const out = [];
  const blocks = trendHtml.split(/data-series="/).slice(1);
  blocks.forEach((b) => {
    const series = b.slice(0, b.indexOf('"'));
    const svg = (b.match(/<svg class="ph-trend-svg[^"]*" viewBox="0 0 (\d+) (\d+)"[\s\S]*?<\/svg>/) || []);
    if (!svg[0]) return;
    const h = +svg[2], pad = series === 'overall' ? 10 : 5;
    [...svg[0].matchAll(/<title>(\d{4}-\d{2}-\d{2}): ([^<]*)<\/title>/g)].forEach((m) => out.push({ series, date: m[1], v: m[2], kind: 'marker' }));
    [...svg[0].matchAll(/<polyline points="([^"]*)"/g)].forEach((m) => m[1].split(' ').forEach((pt) => {
      const y = +pt.split(',')[1];
      out.push({ series, date: null, v: Math.round((1 - (y - pad) / (h - 2 * pad)) * 1000) / 10, kind: 'vertex' });
    }));
  });
  return out;
}
function traces(p, hist) {
  const val = (e) => (p.series === 'overall' ? e.overall : e.dimensions[p.series]);
  if (p.kind === 'marker') return hist.some((e) => e.date === p.date && typeof val(e) === 'number' && String(Math.round(val(e))) === p.v);
  return hist.some((e) => typeof val(e) === 'number' && Math.abs(val(e) - p.v) < 0.6);
}
const FORBIDDEN = /Nexora|Publish|Save draft|Schedule|Upgrade to Pro|Slack|Export|99\.8%|\$/;

async function run(V, scores, priorities, timeoutMs) {
  const doc = fakeDoc();
  const state = await V.load({
    doc, timeoutMs: timeoutMs || 2000,
    callScores: scores, callPriorities: priorities || (() => Promise.resolve({ data: PRIORITIES })),
  });
  return { doc, state };
}

async function suite(V, tag) {
  const rows = {};
  const row = (name, ok, detail) => { rows[name] = !!ok; if (tag === 'real') ck(name, ok, detail); };

  /* success */
  let { doc, state } = await run(V, () => Promise.resolve({ data: SUCCESS }));
  row('success: state=data, only main-content visible', state === 'data' && visible(doc).join() === 'main-content', visible(doc));
  row('success: overall shows server score 72 + grade', doc.els['overall-score'].textContent === '72' && doc.els['overall-grade'].textContent === 'Grade C');
  row('success: five cards rendered with server scores', ['64', '70', '81', '90', '55'].every((s) => doc.els['scores-grid'].innerHTML.includes('>' + s + '<')));
  row('success: missing dimension shows its text, no bar', doc.els['scores-grid'].innerHTML.includes('No active products yet'));
  row('success: priorities table from topPriorities', doc.els['priorities-area'].innerHTML.includes('Wallet &amp; Seller Payouts'));
  row('success: server strings escaped (no raw <img)', !doc.els['alerts-area'].innerHTML.includes('<img'));
  row('success: hero is no longer "Computing scores…"', doc.els['overall-title'].textContent !== 'Computing scores…');

  /* canonical zero is shown as zero */
  ({ doc, state } = await run(V, () => Promise.resolve({ data: ZERO })));
  row('canonical 0 from server renders 0', doc.els['overall-score'].textContent === '0');

  /* partial: withheld overall */
  ({ doc, state } = await run(V, () => Promise.resolve({ data: PARTIAL })));
  row('unknown overall renders — (never 0)', doc.els['overall-score'].textContent === DASH, doc.els['overall-score'].textContent);
  row('unknown overall: no invented verdict', !/requires immediate attention|healthy|needs attention/i.test(doc.els['overall-title'].textContent), doc.els['overall-title'].textContent);
  row('unknown overall: names the withheld dimension', /operational/.test(doc.els['overall-sub'].textContent));
  row('failed dimension card shows — and the server reason', /data-card="operational" data-known="false"/.test(doc.els['scores-grid'].innerHTML)
    && doc.els['scores-grid'].innerHTML.includes('FAILED_PRECONDITION') && !/>null</.test(doc.els['scores-grid'].innerHTML));
  row('unknown ring left empty (no fill offset)', doc.els['overall-fill'].style.strokeDashoffset === doc.els['overall-fill'].style.strokeDasharray);

  /* empty */
  ({ doc, state } = await run(V, () => Promise.resolve({ data: {} })));
  row('empty {}: state=empty, "No health data yet"', state === 'empty' && visible(doc).join() === 'empty-state' && doc.els['overall-title'].textContent === 'No health data yet');
  row('empty {}: overall —, not 0', doc.els['overall-score'].textContent === DASH);
  ({ doc, state } = await run(V, () => Promise.resolve({ data: null })));
  row('empty null: state=empty', state === 'empty');

  /* permission-denied */
  ({ doc, state } = await run(V, () => Promise.reject(err('functions/permission-denied', 'Administrator access required.'))));
  row('permission-denied: error state with server message', state === 'error' && visible(doc).join() === 'error-state'
    && doc.els['error-title'].textContent === 'Admin or Super Admin access required.'
    && doc.els['error-message'].textContent.includes('Administrator access required.'));
  row('permission-denied: hero cleared, score —', doc.els['overall-title'].textContent === 'Health data unavailable' && doc.els['overall-score'].textContent === DASH);

  /* internal */
  ({ doc, state } = await run(V, () => Promise.reject(err('functions/internal', 'INTERNAL'))));
  row('internal: error state, code shown, loading hidden', state === 'error' && doc.els['error-message'].textContent.includes('[internal]') && doc.els['loading-state'].style.display === 'none');

  /* hang → timeout */
  const t0 = Date.now();
  ({ doc, state } = await run(V, () => new Promise(() => {}), () => new Promise(() => {}), 60));
  row('hang: times out into error state (no endless spinner)', state === 'error' && doc.els['error-title'].textContent === 'The health service timed out.' && Date.now() - t0 < 2000);

  /* retry */
  let calls = 0;
  ({ doc, state } = await run(V, () => (++calls === 1 ? Promise.reject(err('unavailable', 'offline')) : Promise.resolve({ data: SUCCESS }))));
  const retried = typeof doc.els['retry-btn'].onclick === 'function' ? await doc.els['retry-btn'].onclick() : null;
  row('retry: button re-runs the load and reaches data', state === 'error' && retried === 'data' && doc.els['overall-score'].textContent === '72');

  /* priorities fail, scores fine */
  ({ doc, state } = await run(V, () => Promise.resolve({ data: SUCCESS }), () => Promise.reject(err('internal', 'boom'))));
  row('priorities failure is local; scores still render', state === 'data' && doc.els['priorities-area'].innerHTML.includes('Priorities unavailable'));
  ({ doc, state } = await run(V, () => Promise.resolve({ data: SUCCESS }), () => Promise.resolve({ data: { topPriorities: [] } })));
  row('priorities empty: honest "No priorities data yet"', doc.els['priorities-area'].innerHTML.includes('No priorities data yet'));

  /* ── redesign 2026-10-04: layout + content integrity ── */
  ({ doc, state } = await run(V, () => Promise.resolve({ data: SUCCESS })));
  const kpi = doc.els['kpi-grid'].innerHTML;
  row('kpi: five dimension cards with server scores', V.CARDS.every((c) => kpi.includes('data-kpi="' + c.id + '"'))
    && ['64', '70', '81', '90', '55'].every((s) => kpi.includes('>' + s + '<')));
  row('no sparkline/trend rendered when no series', !/<polyline|ph-spark|ph-trend-chart/.test(kpi + doc.els['trend-area'].innerHTML)
    && doc.els['trend-area'].innerHTML.includes('Trend history starts after the first daily snapshot'));
  row('no delta rendered when server returns no comparison', !/ph-delta|vs previous|[▲▼]/.test(kpi));
  const seen = renderedText(doc).match(/\d+(?:\.\d+)?/g) || [];
  row('tracer positive control: the walk sees the rendered numbers', ['72', '64', '18', '12.5', '192'].every((n) => seen.includes(n)), seen.join(','));
  row('every rendered number traces to a fixture field (success)', untraced(doc, SUCCESS, PRIORITIES).length === 0, untraced(doc, SUCCESS, PRIORITIES).join(','));
  row('pill: known overall gets the server-score label', doc.els['status-pill'].textContent === 'Needs attention');
  row('breakdown: bar list of server scores, no donut', /class="ph-bars"/.test(doc.els['breakdown-area'].innerHTML)
    && !/<circle|donut/i.test(doc.els['breakdown-area'].innerHTML) && doc.els['breakdown-area'].innerHTML.includes('width:64%'));
  const pa = doc.els['priorities-area'].innerHTML;
  const priRows = pa.split('<li class="ph-top-row">').slice(1);
  row('top list: bar only when totalScore is numeric', priRows.length === 2 && /ph-bar-fill/.test(priRows[0]) && /width:72%/.test(priRows[0])
    && !/ph-bar/.test(priRows[1]) && priRows[1].includes('>' + DASH + '<'));
  row('top list: hostile name escaped', !/<script/i.test(pa) && pa.includes('&lt;script&gt;'));
  row('panel: computed time is the server ISO value', doc.els['panel-computed'].innerHTML.includes('datetime="2026-10-03T08:00:00.000Z"')
    && doc.els['panel-pri-computed'].innerHTML.includes('datetime="2026-10-03T08:00:05.000Z"'));
  row('panel: budget + recommendation + signals from the server', doc.els['panel-budget'].textContent === '192 / 200 indexes'
    && doc.els['panel-recommendation'].textContent === 'Wallet & Seller Payouts' && doc.els['panel-signals'].innerHTML.includes('12.5%'));
  row('no forbidden strings in rendered content', !FORBIDDEN.test(renderedText(doc)), (renderedText(doc).match(FORBIDDEN) || [])[0]);
  row('refresh enabled after data and wired to re-call the server', doc.els['refresh-btn'].disabled === false
    && doc.els['refresh-btn'].onclick === doc.els['panel-refresh-btn'].onclick && typeof doc.els['refresh-btn'].onclick === 'function');
  let rc = 0;
  ({ doc, state } = await run(V, () => { rc++; return Promise.resolve({ data: SUCCESS }); }));
  const again = await doc.els['refresh-btn'].onclick();
  row('refresh: re-calls getPlatformHealthScores and re-renders', again === 'data' && rc === 2);
  const ld = fakeDoc(); V.renderLoading(ld);
  row('refresh disabled while loading; panel shows —', ld.els['refresh-btn'].disabled === true && ld.els['panel-budget'].textContent === DASH && ld.els['status-pill'].textContent === 'Loading');

  /* ── history: the chart draws only from getPlatformHealthScores.history ── */
  row('history: the view reads the server field "history"', V.SERIES_FIELD === 'history');
  ({ doc, state } = await run(V, () => Promise.resolve({ data: HIST })));
  const tr = doc.els['trend-area'].innerHTML;
  row('history: chart renders Overall + the five dimensions as small multiples', /data-series="overall"/.test(tr)
    && V.CARDS.every((c) => tr.includes('data-series="' + c.key + '"')) && /<polyline/.test(tr) && !/ph-trend-empty/.test(tr));
  const pts = plotted(tr);
  const bad = pts.filter((p) => !traces(p, HISTORY));
  row('history: every plotted value traces to a history fixture entry', pts.length > 20 && bad.length === 0,
    bad.slice(0, 4).map((p) => p.series + '@' + (p.date || 'vertex') + '=' + p.v).join(' '));
  const ovBlock = tr.slice(tr.indexOf('data-series="overall"'), tr.indexOf('class="ph-multiples"'));
  const ovPolys = (ovBlock.match(/<polyline/g) || []).length;
  row('history: nulls are gaps, not zeros', !/<title>2026-09-29: /.test(ovBlock) && !pts.some((p) => p.series === 'overall' && p.v === 0)
    && ovPolys === 2 && /<title>2026-09-30: 66<\/title>/.test(ovBlock), 'overall polylines=' + ovPolys);
  row('history: a missing day breaks the line (no bridge over 2026-10-01)', ovPolys === 2
    && !pts.some((p) => p.series === 'overall' && p.kind === 'marker' && p.date === '2026-10-01'));
  row('history: never-measured dimension draws no line and says so', /data-series="seller"[\s\S]*?No reading recorded/.test(tr)
    && !pts.some((p) => p.series === 'seller'));
  row('history: table shows — for unknown, values otherwise', /<th scope="row">2026-09-29<\/th><td>—<\/td>/.test(tr)
    && /<th scope="row">2026-10-03<\/th><td>72<\/td>/.test(tr));
  row('history: y-axis is the fixed 0–100 scale', /<div class="ph-axis" aria-hidden="true"><span>100<\/span><span>50<\/span><span>0<\/span><\/div>/.test(tr));
  const hk = doc.els['kpi-grid'].innerHTML;
  row('history: KPI sparklines only where history has ≥2 readings', /data-kpi="marketplace"[\s\S]*?ph-spark/.test(hk)
    && !/data-kpi="seller"[^]*?<\/article>/.exec(hk)[0].includes('ph-spark'));
  row('every rendered number traces to a fixture field (history)', untraced(doc, HIST, PRIORITIES).length === 0, untraced(doc, HIST, PRIORITIES).join(','));
  row('history: no delta drawn (no comparison field)', !/ph-delta|vs previous/.test(hk));
  for (const [label, h] of [['[]', []], ['absent', undefined], ['null', null]]) {
    const dd = JSON.parse(JSON.stringify(SUCCESS)); if (h !== undefined) dd.history = h;
    ({ doc, state } = await run(V, () => Promise.resolve({ data: dd })));
    row('history ' + label + ': honest empty state, no line', doc.els['trend-area'].innerHTML.includes('Trend history starts after the first daily snapshot')
      && !/<polyline|ph-spark/.test(doc.els['trend-area'].innerHTML + doc.els['kpi-grid'].innerHTML));
  }

  const NULLSIG = JSON.parse(JSON.stringify(PRIORITIES)); NULLSIG.evidenceSignals.cartToPaidRate = null;
  ({ doc, state } = await run(V, () => Promise.resolve({ data: SUCCESS }), () => Promise.resolve({ data: NULLSIG })));
  row('panel: null signal renders —, not 0', /Cart → paid rate<\/dt><dd>—</.test(doc.els['panel-signals'].innerHTML));

  ({ doc, state } = await run(V, () => Promise.resolve({ data: PARTIAL })));
  row('withheld overall: status pill carries no verdict', doc.els['status-pill'].textContent === 'Overall withheld'
    && !/healthy|attention|critical/i.test(doc.els['status-pill'].textContent));
  row('withheld: failed KPI card shows — and the server code', /data-kpi="operational" data-known="false"/.test(doc.els['kpi-grid'].innerHTML)
    && /Could not be computed \(9\)/.test(doc.els['kpi-grid'].innerHTML));
  row('withheld: unknown dimension has an empty bar and —', /data-dim="operational"[\s\S]*?ph-bar empty[\s\S]*?>—</.test(doc.els['breakdown-area'].innerHTML));
  row('every rendered number traces to a fixture field (partial)', untraced(doc, PARTIAL, PRIORITIES).length === 0, untraced(doc, PARTIAL, PRIORITIES).join(','));

  ({ doc, state } = await run(V, () => Promise.reject(err('internal', 'boom'))));
  row('error: KPI grid + panel reset, pill "Not loaded", refresh retries', doc.els['kpi-grid'].innerHTML === ''
    && doc.els['panel-budget'].textContent === DASH && doc.els['status-pill'].textContent === 'Not loaded'
    && typeof doc.els['refresh-btn'].onclick === 'function');
  row('back link by claim', V.backLink({ superAdmin: true }).href === 'super-admin.html' && V.backLink({ admin: true }).href === 'admin-os.html');

  /* AdminOS / super-admin chips */
  const ch = V.chipsHtml({ status: 'fulfilled', value: PARTIAL });
  row('chips: unknown dimension renders —, no "/100", no 0', ch.includes('<strong>' + DASH + '</strong>') && !/data-score="0"/.test(ch));
  row('chips: rejected call shows server message, no spinner', /Health scores unavailable/.test(V.chipsHtml({ status: 'rejected', reason: err('permission-denied', 'Administrator access required.') })));
  row('chips: empty payload says "No health data yet"', /No health data yet/.test(V.chipsHtml({ status: 'fulfilled', value: {} })));
  row('claims: admin OR superAdmin, nothing else', V.isAdminClaims({ admin: true }) && V.isAdminClaims({ superAdmin: true })
    && !V.isAdminClaims({ admin: 'true' }) && !V.isAdminClaims({}) && !V.isAdminClaims(null));
  return rows;
}

(async () => {
  console.log('\nPlatform Health view — states');
  const V = loadView(VIEW_SRC);
  await suite(V, 'real');

  console.log('\nSurfaces — wiring (static)');
  const page = read('platform-health.html');
  const viewIdx = page.indexOf('<script src="platform-health-view.js"></script>');
  const modIdx = page.indexOf('<script type="module">');
  ck('page: view script loads before the module', viewIdx > 0 && modIdx > viewIdx);
  ck('page: SDK 10.12.2 only (matches firebase.js)', !/firebasejs\/(?!10\.12\.2)/.test(page));
  ck('page: gate uses isAdminClaims (admin OR superAdmin)', /PHV\.isAdminClaims\(/.test(page) && !/claims\.admin\)/.test(page));
  ck('page: firebase.js import failure is handled', /import\("\.\/firebase\.js"\)\)[\s\S]{0,80}\.catch\(/.test(page));
  ck('page: token refresh failure is handled', /getIdTokenResult\(true\)[\s\S]*?\}\)\.catch\(/.test(page));
  ck('page: auth watchdog present', /AUTH_WAIT_MS/.test(page) && /deadline-exceeded/.test(page));
  ck('page: error/empty/retry containers exist', ['id="error-state"', 'id="error-title"', 'id="error-message"', 'id="retry-btn"', 'id="empty-state"'].every((s) => page.includes(s)));
  ck('page: self-updates (shared-header.js injects sw-register)', /<script src="shared-header\.js"><\/script>/.test(page) || /sw-register\.js/.test(page));
  const inline = [...page.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
  let compiled = true, compileErr = '';
  for (const m of inline) {
    const isModule = /type="module"/.test(m[1]);
    const body = isModule ? m[2].replace(/^\s*import[^;]+;\s*$/gm, '') : m[2];
    try { new vm.Script(isModule ? '(async () => {' + body + '\n})' : body); } catch (e) { compiled = false; compileErr = e.message; }
  }
  ck('page: every inline script compiles in V8', compiled && inline.length > 0, compileErr);

  const aos = read('sokoni-aos.js');
  /* code reads only — the repair comment names the old field on purpose */
  ck('AdminOS: no longer reads h.scores', !/if \(h\.scores\)|=\s*h\.scores/.test(aos));
  ck('AdminOS: card rendered by PHV.chipsHtml(health) in every outcome', /PHV\.chipsHtml\(health\)/.test(aos));
  ck('AdminOS: health call bounded by withTimeout', /withTimeout\(_call\("getPlatformHealthScores"\)/.test(aos));
  try { new vm.Script(aos); ck('AdminOS: sokoni-aos.js compiles', true); } catch (e) { ck('AdminOS: sokoni-aos.js compiles', false, e.message); }
  const aosHtml = read('admin-os.html');
  ck('AdminOS: view loads before sokoni-aos.js', aosHtml.indexOf('src="platform-health-view.js"') > 0
    && aosHtml.indexOf('src="platform-health-view.js"') < aosHtml.indexOf('src="sokoni-aos.js"'));
  const sa = read('super-admin.html');
  ck('super-admin: no data.dimensions / .priorities shape', !/data\.dimensions\|\|/.test(sa) && !/res\.data\.priorities\)/.test(sa));
  ck('super-admin: view loaded and used', sa.includes('<script src="platform-health-view.js"></script>') && /PHV\.prioritiesList\(res\.data\)/.test(sa) && /PHV\.chips\(outcome\.value\)/.test(sa));

  console.log('\nLayout — reference design mapped honestly (static)');
  const markup = page.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const css = (page.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  ck('layout: header row — h1, subtitle, status pill, computed time, Refresh', /<header class="ph-top">/.test(markup)
    && /<h1>Platform Health<\/h1>/.test(markup) && /class="ph-subtitle">Platform health across marketplace, sellers, buyers, operations and cost</.test(markup)
    && ['id="status-pill"', 'id="computed-at"', 'id="refresh-btn"', 'id="back-link"'].every((x) => markup.includes(x)));
  ck('layout: KPI row (overall + dimension slot), trend, breakdown, top list, drill-down', ['data-kpi="overall"', 'id="kpi-grid"',
    'id="trend-card"', 'id="trend-area"', 'id="breakdown-card"', 'id="priorities-card"', 'id="priorities-area"', 'id="scores-grid"'].every((x) => markup.includes(x)));
  ck('layout: right details panel with tabs, fields and Refresh', /<aside class="ph-card ph-panel" id="details-panel"/.test(markup)
    && /role="tablist"/.test(markup) && (markup.match(/role="tab"/g) || []).length === 3
    && ['id="panel-computed"', 'id="panel-budget"', 'id="panel-signals"', 'id="panel-sources"', 'id="panel-refresh-btn"', 'Admin &amp; Super Admin'].every((x) => markup.includes(x)));
  ck('layout: no <nav>, no sidebar, no brand/logo block, no avatar images', !/<nav\b/i.test(markup) && !/sidebar/i.test(markup + css)
    && !/class="[^"]*\b(logo|brand)/i.test(markup) && !/<img\b/i.test(markup) && !/avatar/i.test(markup + css));
  ck('layout: no forbidden strings in static markup', !FORBIDDEN.test(markup), (markup.match(FORBIDDEN) || [])[0]);
  ck('layout: no placeholder figures in static markup (only — before load)', !/>\s*\d[\d.,%]*\s*</.test(markup));
  /* phone width: every fixed px width outside a min-width media query fits a 320px viewport */
  const cssMobile = css.replace(/@media\s*\(min-width:[^)]*\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const widths = [...cssMobile.matchAll(/(?:^|[;{\s])(?:width|min-width|flex-basis)\s*:\s*(\d+)px/g)].map((m) => +m[1])
    .concat([...cssMobile.matchAll(/minmax\(\s*(\d+)px/g)].map((m) => +m[1]));
  ck('mobile: no fixed width > 288px (320 viewport − 2×16 gutter) outside min-width queries', widths.length > 0 && widths.every((w) => w <= 288), widths.join(','));
  ck('mobile: overall card stops spanning 2 columns at phone width', /@media \(max-width: 420px\)[\s\S]*?\.ph-kpi\.overall \{ grid-column: auto; \}/.test(css));
  ck('mobile: page guards horizontal scroll and uses a 16px gutter', /overflow-x:\s*hidden/.test(css) && /--ph-gutter:\s*16px/.test(css));
  ck('a11y: prefers-reduced-motion and focus-visible styles present', /prefers-reduced-motion:\s*reduce/.test(css) && /:focus-visible/.test(css));
  ck('a11y: charts carry text — breakdown list labelled, trend empty state is text', /aria-label="Dimension scores out of 100"/.test(VIEW_SRC)
    && /role="status"><strong>Trend history/.test(VIEW_SRC));
  ck('data sources: page draws no chart library (no new CDN)', !/chart\.js|chart\.umd|cdnjs|jsdelivr|unpkg/i.test(page));

  console.log('\nNegative control (a) — placeholder sparkline when no series');
  const SPARK_FROM = "if (!validSeries(series)) return '';";
  ck('control (a): anchor present once', VIEW_SRC.split(SPARK_FROM).length === 2);
  const mutA = loadView(VIEW_SRC.replace(SPARK_FROM, "if (!validSeries(series)) series = [{ date: '2026-10-01', v: 50 }, { date: '2026-10-02', v: 50 }];"));
  const arows = await suite(mutA, 'mutant');
  ck('control (a): row "no sparkline/trend rendered when no series" FAILS', arows['no sparkline/trend rendered when no series'] === false);
  ck('control (a): unrelated rows still pass (targeted)', arows['success: overall shows server score 72 + grade'] === true);

  console.log('\nNegative control (b) — invented delta');
  const DELTA_FROM = "if (!isNum(prev) || !isNum(x && x.score)) return '';";
  ck('control (b): anchor present once', VIEW_SRC.split(DELTA_FROM).length === 2);
  const mutB = loadView(VIEW_SRC.replace(DELTA_FROM, 'if (!isNum(prev)) prev = (x && x.score) - 11;'));
  const brows = await suite(mutB, 'mutant');
  ck('control (b): row "no delta rendered when server returns no comparison" FAILS', brows['no delta rendered when server returns no comparison'] === false);
  ck('control (b): row "every rendered number traces to a fixture field (success)" FAILS', brows['every rendered number traces to a fixture field (success)'] === false);
  ck('control (b): unrelated rows still pass (targeted)', brows['success: overall shows server score 72 + grade'] === true);

  console.log('\nNegative control (c) — history nulls plotted as 0');
  const NULL_FROM = 'pts.push({ date: e.date, v: isNum(raw) ? raw : null });';
  ck('control (c): anchor present once', VIEW_SRC.split(NULL_FROM).length === 2);
  const mutC = loadView(VIEW_SRC.replace(NULL_FROM, 'pts.push({ date: e.date, v: isNum(raw) ? raw : 0 });'));
  const crows = await suite(mutC, 'mutant');
  ck('control (c): row "history: nulls are gaps, not zeros" FAILS', crows['history: nulls are gaps, not zeros'] === false);
  ck('control (c): unrelated rows still pass (targeted)', crows['success: overall shows server score 72 + grade'] === true
    && crows['history: chart renders Overall + the five dimensions as small multiples'] === true);

  console.log('\nNegative control — mutant renders unknown as 0');
  const MUT_FROM = 'function fmtScore(v) { return isNum(v) ? String(Math.round(v)) : DASH; }';
  ck('control: mutation anchor present in source', VIEW_SRC.includes(MUT_FROM));
  const mutant = loadView(VIEW_SRC.replace(MUT_FROM, "function fmtScore(v) { return isNum(v) ? String(Math.round(v)) : '0'; }"));
  const mrows = await suite(mutant, 'mutant');
  ck('control: row "unknown overall renders — (never 0)" FAILS on the mutant', mrows['unknown overall renders — (never 0)'] === false);
  ck('control: mutant still passes the success rows (mutation is targeted)', mrows['success: overall shows server score 72 + grade'] === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
