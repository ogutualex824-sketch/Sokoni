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
  'ring-marketplace', 'ring-seller', 'ring-buyer', 'ring-operational', 'ring-cost'];
function fakeDoc() {
  const els = {};
  IDS.forEach((id) => { els[id] = { id, textContent: '', innerHTML: '', style: {}, onclick: null }; });
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
    evidenceGate: 'Need ≥50 active sellers (currently 3)' }] };

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
