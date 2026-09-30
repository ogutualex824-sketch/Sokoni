'use strict';
/**
 * CERTIFICATION — Batch 0a: the POS till cannot fabricate a card approval.
 *
 * Before: pos-terminals.js `SimulatedAdapter` waited 2.5–4.5 s, then APPROVED 90% of the time with an
 * invented authCode ('SIM…'), a random last-4 and scheme. It served every manual/simulated terminal AND every
 * Bluetooth terminal (`_runBT`). pos.js completed the sale on that result, and the receipt is produced inside
 * `payment.complete()`. Served live on mysokoni.co.ke. No money moved.
 *
 * This suite EXECUTES the real modules (vm sandbox, minimal DOM), twice: the OLD files read from BASELINE
 * (git show) and the NEW files from this tree. Old must fabricate; new must refuse. Controls prove the harness
 * can see a completion (so a "not completed" result is a refusal, not a harness that cannot observe one).
 *
 *   T  pos-terminals.js  payment.initiate for manual / simulated / bluetooth terminals, and the test-pay path
 *   P  pos.js            payment.setMethod('card') + payment.process() → does payment.complete() run?
 *
 *   REPAIR_ROOT  tree under test (default: this repo).  BASELINE  the pre-0a commit (default f3c6630).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const BASELINE = process.env.BASELINE || 'f3c6630';
const WATCHDOG = setTimeout(() => { console.log('\n  ✖ WATCHDOG — suite exceeded 60s'); process.exit(3); }, 60000);

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) { pass++; console.log('  PASS', id, m); } else { fail++; console.log('  FAIL', id, m); } };
const readNew = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* git runs in the repository holding this script, so REPAIR_ROOT may be an export with no .git */
const readOld = (rel) => execSync(`git show ${BASELINE}:${rel}`, { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 26 });

/* ── A permissive browser sandbox: real objects where the code under test reads/writes them, an inert
   stub for everything else. `then` is never stubbed, or every await on a stub would hang. ── */
function inert() {
  const f = function () { return p; };
  const p = new Proxy(f, {
    get(t, k) {
      if (k === 'then' || k === Symbol.toPrimitive || k === Symbol.iterator) return undefined;
      if (k === 'length') return 0;
      return p;
    },
    set() { return true; },
    apply() { return p; },
    construct() { return p; },
  });
  return p;
}
function makeSandbox() {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      elements.set(id, new Proxy({ id, style: {}, dataset: {}, textContent: '', value: '', disabled: false, className: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, setAttribute() {}, removeAttribute() {},
        querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}, click() {} }, {
        get(t, k) { return k in t ? t[k] : inert(); },
      }));
    }
    return elements.get(id);
  };
  const toasts = [];
  const document = {
    getElementById: el,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => el('__new_' + tag + '_' + Math.random()),
    addEventListener() {}, removeEventListener() {},
    /* pos.js's internal toast() appends a div to <body>: capture what it says. */
    body: { appendChild: (c) => { if (c && c.textContent) toasts.push(String(c.textContent)); }, removeChild() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {} },
    head: el('__head'), documentElement: el('__html'),
    readyState: 'complete', visibilityState: 'visible', hidden: false,
  };
  const base = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document, navigator: { onLine: true, userAgent: 'node-vm' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    /* timers run immediately: the old simulator's 2.5–4.5 s wait and the modal's step delays */
    setTimeout: (fn) => { Promise.resolve().then(() => fn()); return 1; },
    clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: (fn) => { Promise.resolve().then(() => fn(0)); return 1; },
    Promise, Date, Math: Object.create(Math, { random: { value: () => 0.5 } }), JSON, Object, Array, String, Number,
    Boolean, RegExp, Error, TypeError, Map, Set, WeakMap, Symbol, Proxy, Reflect, parseInt, parseFloat, isNaN,
    encodeURIComponent, decodeURIComponent, Intl, structuredClone,
    location: { href: 'http://localhost/pos.html', search: '', hash: '', pathname: '/pos.html', reload() {} },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    CustomEvent: function () {}, Event: function () {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    __toasts: toasts,
    __el: el,
  };
  /* Unknown globals resolve to an inert stub, so the 4,400-line pos.js loads without its whole page. */
  const sandbox = new Proxy(base, {
    has() { return true; },
    get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return inert(); },
  });
  base.window = sandbox; base.self = sandbox; base.globalThis = sandbox;
  return { ctx: vm.createContext(sandbox), base, el, toasts };
}

/* ── T: pos-terminals.js ─────────────────────────────────────────────────────── */
async function terminalsRun(src) {
  const { ctx, base } = makeSandbox();
  const store = { devices: [], asg: [] };
  base.PosDB = {
    devices: { getAll: async () => store.devices, save: async (d) => { store.devices.push(d); }, delete: async () => {} },
    terminal_assignments: { getAll: async () => store.asg, save: async (a) => { store.asg.push(a); }, delete: async () => {} },
    terminal_queue: { getAll: async () => [], save: async () => {}, delete: async () => {} },
  };
  vm.runInContext(src, ctx, { filename: 'pos-terminals.js' });
  const PT = base.window.PosTerminals || vm.runInContext('window.PosTerminals', ctx);
  const out = {};
  for (const conn of ['manual', 'simulated', 'bluetooth']) {
    /* explicit ids: the sandbox pins Math.random (for a deterministic old simulator), so minted ids would collide */
    const d = await PT.devices.save({ id: 'dev-' + conn, name: 'T-' + conn, type: 'pdq', connectionMethod: conn, status: 'connected', config: {} });
    await PT.assignments.assign('till-' + conn, d.id);
    out[conn] = await PT.payment.initiate(250, 'till-' + conn);
  }
  return out;
}

/* ── P: pos.js card branch ───────────────────────────────────────────────────── */
async function posRun(src, terminalResult, { method = 'card' } = {}) {
  const { ctx, base, el, toasts } = makeSandbox();
  let initiated = 0;
  base.PosTerminals = { payment: { initiate: async () => { initiated++; return terminalResult; }, cancel() {} } };
  vm.runInContext(src + '\n;window.__SPos = SPos;', ctx, { filename: 'pos.js' });
  const SPos = base.window.__SPos || vm.runInContext('SPos', ctx);
  let completed = null;
  SPos.payment.complete = async (info) => { completed = info; };
  SPos.toast = (m) => toasts.push(m);
  SPos.state.cartItems = [{ id: 'p1', name: 'Item', price: 250, qty: 1, quantity: 1 }];
  SPos.state.currentCashier = { id: 'c1', name: 'Cashier' };
  SPos.state.currentShift = { id: 's1' };
  SPos.state.settings = Object.assign({}, SPos.state.settings, { tillId: '1' });
  let total = 0; try { total = SPos.cart.getTotal(); } catch (_) {}
  SPos.payment.setMethod(method);
  const payBtn = el('pay-btn');
  if (method === 'cash') { SPos.state.numpadStr = String(total); }
  await SPos.payment.process();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { total, initiated, completed, toasts: toasts.slice(), payBtnText: payBtn.textContent, payBtnDisabled: payBtn.disabled };
}

const SIM_APPROVAL = { status: 'approved', authCode: 'SIMAB12CD', cardLast4: '4242', cardScheme: 'Visa', reference: 'TSIM1700000000000', amount: 250 };
const REAL_APPROVAL = { status: 'approved', authCode: 'A7K2Q9', cardLast4: '1111', cardScheme: 'Mastercard', reference: 'PDQ-778812', amount: 250 };

(async () => {
  console.log(`\nBatch 0a — the till cannot fabricate a card approval   (tree: ${ROOT}, baseline ${BASELINE})\n`);

  console.log('[T] pos-terminals.js — payment.initiate on terminals with no real driver');
  let TO, TN;
  try { TO = await terminalsRun(readOld('pos-terminals.js')); } catch (e) { ok(false, 'T-X-old', 'old module failed to run: ' + e.message); }
  try { TN = await terminalsRun(readNew('pos-terminals.js')); } catch (e) { ok(false, 'T-X-new', 'new module failed to run: ' + e.message); }
  if (TO && TN) {
    for (const c of ['manual', 'simulated', 'bluetooth']) {
      const o = TO[c] || {}, n = TN[c] || {};
      ok(o.status === 'approved' && /^SIM/.test(o.authCode || ''), `T-${c}-old`,
        `OLD fabricates: ${c} terminal -> status=${o.status}, authCode=${o.authCode || '-'}, last4=${o.cardLast4 || '-'}`);
      ok(n.status === 'unavailable' && !n.authCode && !n.cardLast4 && !n.reference, `T-${c}-new`,
        `NEW refuses: ${c} terminal -> status=${n.status}, authCode=${n.authCode || '-'}, reason="${n.reason || ''}"`);
    }
  }
  {
    const src = readNew('pos-terminals.js');
    ok(!/Math\.random\(\)\s*>\s*0\.1/.test(src) && !/'SIM'\s*\+/.test(src), 'T-src',
      'NEW source carries no approval dice and no SIM code minting');
  }

  console.log('\n[P] pos.js — select Card, press Charge');
  const oldPos = readOld('pos.js'), newPos = readNew('pos.js');
  let P;
  try {
    const oSim = await posRun(oldPos, SIM_APPROVAL);
    const oReal = await posRun(oldPos, REAL_APPROVAL);
    ok(oReal.total > 0 && !!oReal.completed && oReal.completed.method === 'card', 'P-ctl',
      `CONTROL — the harness observes a completion: OLD + a non-simulated approval completes (method=${oReal.completed && oReal.completed.method}, total=${oReal.total})`);
    ok(!!oSim.completed && /^SIM/.test(oSim.completed.cardAuthCode || ''), 'P-old',
      `OLD completes a sale on a SIMULATED approval (cardAuthCode=${oSim.completed && oSim.completed.cardAuthCode}) — and complete() is where the receipt is made`);

    const nSim = await posRun(newPos, SIM_APPROVAL);
    const nReal = await posRun(newPos, REAL_APPROVAL);
    ok(!nSim.completed && nSim.initiated === 0, 'P-new-sim',
      `NEW: no sale, no receipt; the terminal is not even asked (completed=${!!nSim.completed}, initiate calls=${nSim.initiated})`);
    ok(!nReal.completed, 'P-new-any', `NEW: card cannot complete at all until a real card path exists (completed=${!!nReal.completed})`);
    ok(nSim.toasts.some((t) => /Card unavailable — use M-Pesa or cash\./.test(t)), 'P-msg',
      `NEW tells the cashier: "${nSim.toasts.find((t) => /Card unavailable/.test(t)) || '(no message)'}"`);
    ok(/Card unavailable — use M-Pesa or cash\./.test(nSim.payBtnText) && nSim.payBtnDisabled === true, 'P-btn',
      `NEW Charge button: "${nSim.payBtnText}" disabled=${nSim.payBtnDisabled} (the Card button itself stays)`);
    ok(/data-method="card"/.test(readNew('pos.html')), 'P-visible', 'the Card button is still on pos.html (capability kept visible)');

    /* Future-proofing: even when card is re-enabled, a simulated approval must not complete. */
    const enabled = newPos.replace('const CARD_TENDER_AVAILABLE = false;', 'const CARD_TENDER_AVAILABLE = true;');
    ok(enabled !== newPos, 'P-flag', 'the availability flag exists and is false');
    const eSim = await posRun(enabled, SIM_APPROVAL);
    const eReal = await posRun(enabled, REAL_APPROVAL);
    ok(!eSim.completed, 'P-guard', `with card RE-ENABLED, a SIM/TSIM approval still cannot complete (completed=${!!eSim.completed})`);
    ok(!!eReal.completed, 'P-guard-ctl', `…while a non-simulated approval would (control; completed=${!!eReal.completed})`);

    const nCash = await posRun(newPos, null, { method: 'cash' });
    ok(!!nCash.completed && nCash.completed.method === 'cash', 'P-cash', `cash still completes (method=${nCash.completed && nCash.completed.method})`);
    P = true;
  } catch (e) { ok(false, 'P-X', 'pos.js harness failed: ' + (e && e.stack || e)); }

  console.log(`\n${pass} pass / ${fail} fail`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✖ CRASH — ' + (e && e.stack || e)); process.exit(4); });
