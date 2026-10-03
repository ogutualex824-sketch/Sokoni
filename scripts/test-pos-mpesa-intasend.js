#!/usr/bin/env node
'use strict';
/* ============================================================================
   SmartPOS "Send M-PESA Request" — canonical IntaSend POS rail, no simulated payment (2026-10-03)
   Executes the REAL sendSTK method body from pos.js against stubs (fast timers).
     A  completed (server status) → payment.complete ONCE, method mpesa, amount, server ref + provider ref
     B  failed → no completion, nothing charged message
     C  never confirmed → times out, NO completion, "do not hand over goods"
     D  helper / sign-in missing → refused, no prompt, no completion (no simulated fallback)
     E  split sale: prompt for the M-PESA portion only; wrapper undone when the payment did not complete
     F  static: no 'SIMULATED' / darajaSTKPush / verifyPaymentStatus in pos.js; pos.html loads sokoni-pos-stk.js
        before pos.js; payment.complete inside sendSTK appears only in the completed branch
   node scripts/test-pos-mpesa-intasend.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

const a = src.indexOf('    async sendSTK(amountOverride) {'), b = src.indexOf('    cancelSTK() {');
const body = src.slice(a, b).trim().replace(/,\s*$/, '');
const helper = fs.readFileSync(path.join(ROOT, 'sokoni-pos-stk.js'), 'utf8');

function harness({ status = 'completed', statuses = null, stkThrows = false, noHelper = false, noUser = false } = {}) {
  const calls = { stk: [], verify: 0, complete: [], toasts: [], result: '' };
  const el = { style: {}, textContent: '', disabled: false };
  const ctx = {
    console, Math, Number, String, Promise, JSON, Uint32Array, Date,
    setTimeout: (f) => setTimeout(f, 1), setInterval: (f) => setInterval(f, 2), clearInterval,
    document: { getElementById: (id) => (id === 'mpesa-result' ? { style: {}, set textContent(v) { calls.result = v; }, get textContent() { return calls.result; } } : el) },
    _v: () => '0712345678', toast: (m) => calls.toasts.push(m), _setMpesaStep: () => {},
    cart: { getTotal: () => 1500 }, modal: { close: () => {} },
    payment: { complete: async (x) => { calls.complete.push(x); } }, state: {},
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.crypto = { getRandomValues: (x) => { x[0] = 7; x[1] = 9; return x; } };
  if (!noUser) ctx.firebaseAuth = { currentUser: { uid: 'SHOP1' } };
  if (!noHelper) {
    vm.runInNewContext(helper, ctx);
    let i = 0;
    ctx.sokoniCallable = (name) => async (req) => {
      if (name === 'posInitiateIntasendPayment') { calls.stk.push(req); if (stkThrows) throw new Error('shop not allowed'); return { data: { ref: 'postill_abc', state: 'pending' } }; }
      if (name === 'posCheckPaymentStatus') { calls.verify++; const st = statuses ? (statuses[i++] || statuses[statuses.length - 1]) : status; return { data: { status: st, transactionRef: st === 'completed' ? 'QK12AB' : null, reason: st === 'failed' ? 'insufficient funds' : null } }; }
      throw new Error('unexpected ' + name);
    };
  }
  vm.runInNewContext('var mpesa = {' + body + '};', ctx);
  return { ctx, calls, mpesa: ctx.mpesa };
}

(async () => {
  console.log('SmartPOS M-PESA — IntaSend POS rail, no simulated payment\n');
  { const h = harness({ statuses: ['pending', 'pending', 'completed'] }); const r = await h.mpesa.sendSTK();
    const c = h.calls.complete;
    ck('A completed only after the SERVER status → ONE completion with method mpesa, amount 1500, server ref + provider ref; prompt for KES 1500 on shop SHOP1',
      r.ok === true && c.length === 1 && c[0].method === 'mpesa' && c[0].amountPaid === 1500 && c[0].paymentRef === 'postill_abc' && c[0].mpesaRef === 'QK12AB' && h.calls.stk[0].amountKES === 1500 && h.calls.stk[0].merchantId === 'SHOP1' && h.calls.verify >= 3, { r, c, stk: h.calls.stk }); }
  { const h = harness({ status: 'failed' }); const r = await h.mpesa.sendSTK();
    ck('B failed → no completion; message says nothing was charged', r.ok === false && h.calls.complete.length === 0 && /Nothing was charged/.test(h.calls.result), h.calls.result); }
  { const h = harness({ status: 'pending' }); const r = await h.mpesa.sendSTK();
    ck('C never confirmed → timeout after bounded polls, NO completion, "Do NOT hand over goods"', r.ok === false && h.calls.complete.length === 0 && h.calls.verify === 24 && /Do NOT hand over goods/.test(h.calls.result), { verify: h.calls.verify, msg: h.calls.result }); }
  { const h = harness({ noHelper: true }); const r = await h.mpesa.sendSTK();
    const h2 = harness({ noUser: true }); const r2 = await h2.mpesa.sendSTK();
    const h3 = harness({ stkThrows: true }); const r3 = await h3.mpesa.sendSTK();
    ck('D no helper / not signed in / server refuses the shop → no completion, nothing simulated', r.ok === false && r2.ok === false && r3.ok === false && h.calls.complete.length + h2.calls.complete.length + h3.calls.complete.length === 0 && h2.calls.stk.length === 0, { r, r2, r3 }); }
  { const h = harness({ status: 'completed' }); await h.mpesa.sendSTK(600);
    ck('E1 split: the customer is prompted for the M-PESA portion (600), not the cart total', h.calls.stk[0].amountKES === 600 && h.calls.complete[0].amountPaid === 600, h.calls.stk[0]); }
  ck('E2 split wrapper passes the M-PESA portion and undoes itself when the payment did not complete',
    /const r = await origSendSTK\(mpesaPortion\);\s*if \(!r \|\| !r\.ok\) payment\.complete = origComplete;/.test(src));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ck('F1 pos.js has no SIMULATED path and never calls darajaSTKPush / verifyPaymentStatus', !/SIMULATED/.test(src) && !/'darajaSTKPush'/.test(code) && !/'verifyPaymentStatus'/.test(code));
  ck('F2 inside sendSTK, payment.complete appears exactly once (the completed branch)', (body.match(/payment\.complete\(/g) || []).length === 1 && /st === 'completed'[\s\S]*payment\.complete\(/.test(body));
  ck('F3 pos.html loads sokoni-pos-stk.js BEFORE pos.js', html.indexOf('sokoni-pos-stk.js') > -1 && html.indexOf('sokoni-pos-stk.js') < html.indexOf('src="pos.js"'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
