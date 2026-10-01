#!/usr/bin/env node
/**
 * SOKONI Store operator workspace — hosting static + module certification (no browser).
 *
 *   node scripts/test-sokoni-store-workspace-static.js
 *
 * Proves, without Chromium:
 *   · both sidebars (AdminOS, Super Admin) carry the SOKONI Store entry → merchant-v2.html?store=sokoni;
 *   · merchant-v2 sets store mode before first paint and the shell does not boot in it;
 *   · the workspace asks the SERVER first and, when refused, renders Access denied and makes
 *     ZERO further store calls (no flash, no data);
 *   · unknown renders "—", never 0; the payout number is shown masked only when the server
 *     returns one; nothing is rendered from the URL.
 * The real-browser half is scripts/test-first-party-store-operator.js (QUEUED — browser hold).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); } };

const HREF = 'href="merchant-v2.html?store=sokoni"';
const aos = read('admin-os.html');
const sa = read('super-admin.html');
const mv2 = read('merchant-v2.html');
const ws = read('sokoni-store-workspace.js');

/* ── A. sidebars ─────────────────────────────────────────────────────────── */
const aosNav = aos.slice(aos.indexOf('id="aosNav"'), aos.indexOf('</nav>', aos.indexOf('id="aosNav"')));
ok('A1 AdminOS sidebar carries exactly one SOKONI Store nav-item', (aosNav.match(new RegExp('<a class="nav-item" ' + HREF.replace(/[?.]/g, '\\$&'), 'g')) || []).length === 1);
const saNav = sa.slice(sa.indexOf('id="saNav"'), sa.indexOf('</nav>', sa.indexOf('id="saNav"')));
ok('A2 Super Admin sidebar carries exactly one SOKONI Store nav-item', (saNav.match(new RegExp('class="nav-item" ' + HREF.replace(/[?.]/g, '\\$&'), 'g')) || []).length === 1);
ok('A3 neither entry is gated client-side as if it were the authority (no data-requires-superadmin)',
  !/data-requires-superadmin[^>]*store=sokoni|store=sokoni[^>]*data-requires-superadmin/.test(aos + sa));
ok('A4 the link carries no identity (no uid/shopId/operator in the URL)', !/store=sokoni&|store=sokoni[^"]*(uid|shop|operator)/.test(aos + sa));

/* ── B. merchant-v2 store mode ───────────────────────────────────────────── */
const flagIdx = mv2.indexOf("get('store')==='sokoni'");
const firstShellScript = mv2.indexOf('<script type="module" src="firebase.js">');
ok('B1 store mode is set in <head>, before the shell and before first paint', flagIdx > 0 && flagIdx < mv2.indexOf('<body>') && flagIdx < firstShellScript);
ok('B2 store mode hides the merchant chrome (.app, .bnav) by CSS keyed on the <html> attribute', /html\[data-sokoni-store\] \.app,html\[data-sokoni-store\] \.bnav\{display:none!important\}/.test(mv2));
const bootIdx = mv2.indexOf('/* ── BOOT ──');
const guardIdx = mv2.indexOf('if (window.__SOKONI_STORE_MODE === true) return;', bootIdx);
ok('B3 the shell does not boot in store mode (guard precedes buildSidebar / initSession / go)',
  guardIdx > bootIdx && guardIdx < mv2.indexOf('buildSidebar();', bootIdx) && guardIdx < mv2.indexOf('initSession();', bootIdx) && guardIdx < mv2.indexOf('go(boot);', bootIdx));
ok('B4 the store root and the workspace script are present; sw-register kept', /<main id="sokoni-store-root"/.test(mv2) && /<script src="sokoni-store-workspace.js" defer><\/script>\n<script src="\/sw-register.js" defer><\/script>/.test(mv2));
ok('B5 the query only REQUESTS: the flag never sets a shop, uid or capability', !/__SOKONI_STORE_MODE[^;]*(activeShopId|capabilities|S\.uid)/.test(mv2));

/* ── C. the module ───────────────────────────────────────────────────────── */
function loadModule(win) {
  const sandbox = { window: win, document: undefined, console, setTimeout, clearTimeout, Promise, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(ws, sandbox, { filename: 'sokoni-store-workspace.js' });
  return win.SokoniStoreWorkspace;
}
const W = loadModule({});
const R = W._render;
ok('C1 denied panel says the owner\'s words', R.denied('denied').includes('Access denied — the SOKONI Store is operated by its owner'));
ok('C2 denied panel carries no store data slots', !/sks-wallet|sks-orders|sks-products|sks-profile/.test(R.denied('denied')));
ok('C3 store wallet absent → "No store sale has settled yet" and "—", never 0', /No store sale has settled yet/.test(R.wallet({ storeWallet: { exists: false } })) && R.wallet({ storeWallet: { exists: false } }).includes('—') && !/KES 0/.test(R.wallet({ storeWallet: { exists: false } })));
ok('C4 a real canonical 0 renders as KES 0', R.wallet({ storeWallet: { exists: true, balance: 0, pendingPayout: 0 } }).includes('KES 0'));
const held = R.workspace({ ok: true, operator: true, businessName: 'SOKONI Store', profile: { phone: '+254705726803' }, payoutDestination: { status: 'not-set' }, payoutsEnabled: false });
ok('C5 flag OFF → "Store withdrawals are awaiting owner approval"; both buttons disabled; "Not set"',
  /Store withdrawals are awaiting owner approval/.test(held) && /id="sks-dest-btn" disabled/.test(held) && /id="sks-wd-btn" disabled/.test(held) && /Not set/.test(held));
const onNoDest = R.workspace({ ok: true, operator: true, profile: {}, payoutDestination: { status: 'not-set' }, payoutsEnabled: true });
ok('C5b flag ON, no destination → Set enabled, Withdraw disabled, no held note', /id="sks-dest-btn">/.test(onNoDest) && /id="sks-wd-btn" disabled/.test(onNoDest) && !/awaiting owner approval/.test(onNoDest));
const wsSet = R.workspace({ ok: true, operator: true, profile: {}, payoutDestination: { status: 'set', last3: '803' }, payoutsEnabled: true });
ok('C6 destination shown masked to the last 3 (server sends last3 only); Withdraw enabled', wsSet.includes('••• 803') && /id="sks-wd-btn">/.test(wsSet));
ok('C6b a full number smuggled in any field is never rendered as the destination', R.destText({ status: 'set', last3: '705726803' }) === null && R.destText({ status: 'set', msisdn: '+254705726803' }) === null);
const wdForm = wsSet.slice(wsSet.indexOf('id="sks-wd-form"'), wsSet.indexOf('</form>', wsSet.indexOf('id="sks-wd-form"')));
ok('C6c the Withdraw form has amount + PIN only — no destination input', /name="amount"/.test(wdForm) && /name="pin" type="password"/.test(wdForm) && !/name="(msisdn|phone|accountNumber|destination)"/.test(wdForm));
ok('C7 profile values are escaped', R.workspace({ profile: { name: '<img src=x onerror=alert(1)>' }, payoutDestination: {} }).includes('&lt;img'));
ok('C8 orders: markup escaped, unknown total "—"', R.orders({ orders: [{ id: '<b>', status: 'paid', total: null }] }).includes('&lt;b&gt;') && R.orders({ orders: [{ id: 'x', total: null }] }).includes('—'));
ok('C9 absent stock renders "—" (unmetered), not 0', R.products({ products: [{ name: 'Mug', price: 500, stock: null }] }).includes('Stock —'));

/* ── D. runtime: the server decides; a refusal fetches nothing else ─────── */
function fakeRoot() {
  const slots = {};
  return {
    innerHTML: '',
    querySelector(sel) { const id = sel.replace('#', ''); return slots[id] || (slots[id] = { innerHTML: '', id, textContent: '', className: '', disabled: false, addEventListener() {}, elements: {} }); },
    _slots: slots,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
(async () => {
  /* denied admin */
  let calls = [];
  const W2 = loadModule({});
  W2._deps.whenFirebase = () => Promise.resolve();
  W2._deps.currentUser = () => Promise.resolve({ uid: 'adminUid' });
  W2._deps.callable = (name) => () => { calls.push(name); const e = new Error('Access denied'); e.code = 'functions/permission-denied'; e.details = { reason: 'not-store-operator' }; return Promise.reject(e); };
  let root = fakeRoot();
  W2.mount(root); await tick();
  ok('D1 admin-not-operator: Access denied rendered', root.innerHTML.includes('Access denied — the SOKONI Store is operated by its owner'));
  ok('D2 admin-not-operator: exactly ONE server call (the gate), zero store reads', calls.join() === 'sokoniStoreGetContext', calls.join());

  /* operator */
  calls = [];
  const W3 = loadModule({});
  W3._deps.whenFirebase = () => Promise.resolve();
  W3._deps.currentUser = () => Promise.resolve({ uid: 'D5Ql2EYr95bt79IpcGTmOMTK0P83' });
  W3._deps.callable = (name) => () => {
    calls.push(name);
    if (name === 'sokoniStoreGetContext') return Promise.resolve({ ok: true, operator: true, storeId: 'STR_x', businessId: 'SOK-XX2338', profile: { phone: '+254705726803' }, payoutDestination: { status: 'unavailable' } });
    if (name === 'sokoniStoreGetWallet') return Promise.resolve({ storeWallet: { exists: false } });
    if (name === 'sokoniStoreListOrders') return Promise.resolve({ orders: [] });
    return Promise.resolve({ products: [] });
  };
  root = fakeRoot();
  W3.mount(root); await tick();
  ok('D3 operator: workspace rendered', root.innerHTML.includes('data-sks-state="workspace"'));
  ok('D4 operator: gate first, then wallet/orders/products', calls[0] === 'sokoniStoreGetContext' && ['sokoniStoreGetWallet', 'sokoniStoreListOrders', 'sokoniStoreListProducts'].every((n) => calls.includes(n)));
  ok('D5 operator: wallet absent renders "No store sale has settled yet"', /No store sale has settled yet/.test((root._slots['sks-wallet'] || {}).innerHTML));

  /* signed out */
  calls = [];
  const W4 = loadModule({});
  W4._deps.whenFirebase = () => Promise.resolve();
  W4._deps.currentUser = () => Promise.resolve(null);
  W4._deps.callable = (name) => () => { calls.push(name); return Promise.resolve({}); };
  root = fakeRoot(); W4.mount(root); await tick();
  ok('D6 signed-out: denied panel, zero server calls', root.innerHTML.includes('data-sks-state="denied"') && calls.length === 0);

  /* server answers ok:false / malformed */
  const W5 = loadModule({});
  W5._deps.whenFirebase = () => Promise.resolve();
  W5._deps.currentUser = () => Promise.resolve({ uid: 'x' });
  W5._deps.callable = () => () => Promise.resolve({ ok: true });
  root = fakeRoot(); W5.mount(root); await tick();
  ok('D7 a response without operator:true is treated as denied (fail closed)', root.innerHTML.includes('data-sks-state="denied"'));

  ok('E1 module never reads the URL for authority', !/location\.search|URLSearchParams/.test(ws));
  ok('E3 payout calls are only made after the operator gate, and only when the flag is ON (source)',
    /if \(!on \|\| !destForm \|\| !wdForm\) return;/.test(ws) && ws.indexOf("deps.callable('sokoniStorePayoutRequest')") > ws.indexOf('function wirePayout'));
  ok('E4 the payout request sends amount, pin and requestId only — never a destination', /deps\.callable\('sokoniStorePayoutRequest'\)\(\{ amount: [^}]*, pin: [^}]*, requestId: wdRequestId \}\)/.test(ws));
  ok('E5 PIN field cleared after every attempt', (ws.match(/elements\.pin\.value = ''/g) || []).length === 2);
  ok('E2 no success text before the server confirms (Saved. only inside the r.ok branch)', /if \(r && r\.ok\) \{\s*status\.textContent = 'Saved\.'/.test(ws));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a pass):', e && (e.stack || e)); process.exit(2); });
