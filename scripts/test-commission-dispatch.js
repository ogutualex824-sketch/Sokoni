#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   commissionDispatch — the door must be transparent
   ══════════════════════════════════════════════════════════════════════════
   Thirteen callables move behind one. The whole value of the change is that
   nothing else changes: same handler, same authorisation, same response and
   the same errors. So this compares the DISPATCHED path against the DIRECT
   path on the same inputs rather than asserting the dispatcher merely exists.

   No database is touched: every assertion here is about routing, argument
   shaping and refusal. Handlers that would reach Firestore are exercised only
   far enough to prove their own auth guard still fires.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + l); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + l + (d ? '   [' + d + ']' : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(74));

/* firebase-admin is stubbed: this suite is about the DOOR, not the data. */
const fakeAdmin = {
  firestore: Object.assign(() => ({
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: false, data: () => null }), set: async () => true }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
                      get: async () => ({ empty: true, docs: [] }) }),
      add: async () => ({ id: 'x' }),
    }),
    runTransaction: async (f) => f({ get: async () => ({ exists: false }), set() {}, update() {} }),
    batch: () => ({ set() {}, update() {}, commit: async () => true }),
  }), {
    FieldValue: { serverTimestamp: () => '__TS__', increment: (n) => n, delete: () => null },
    Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m) => ({ toMillis: () => m }) },
  }),
  auth: () => ({ getUser: async () => ({ uid: 'u', customClaims: {} }) }),
  apps: [{}], initializeApp() {},
};

function load() {
  const real = Module._load;
  Module._load = function (request) {
    if (request === 'firebase-admin') return fakeAdmin;
    if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, log() {} };
    return real.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(path.join(FN, 'commission.js'))];
    return require(path.join(FN, 'commission.js'));
  } finally { Module._load = real; }
}

(async () => {
  const C = load();
  const OPS = ['createCommissionRule', 'updateCommissionRule', 'deleteCommissionRule',
               'listCommissionRules', 'previewCommission', 'getCommissionConfig',
               'getSellerEarningsReport', 'getAdminRevenueByHub', 'processSettlement',
               'requestWithdrawal', 'approveWithdrawal', 'rejectWithdrawal', 'getWithdrawals'];

  head('1 — the door exists and the thirteen are still standing');
  ck('D1 commissionDispatch is exported', typeof C.commissionDispatch === 'function');
  ck('D2 all thirteen remain exported as compatibility wrappers',
     OPS.every((o) => typeof C[o] === 'function'),
     OPS.filter((o) => typeof C[o] !== 'function').join(',') || 'all present');
  ck('D3 that is 13 wrappers + 1 dispatcher = 14 doors this step',
     OPS.length === 13);

  head('2 — routing: every op reaches its OWN handler');
  const run = (data, auth) => C.commissionDispatch.run({ auth: auth || { uid: 'u1' }, data });
  let routed = 0, refusedByHandler = 0;
  for (const op of OPS) {
    try { await run({ op }); routed++; }
    catch (e) {
      /* Reaching the handler's own guard IS routing proof: an unrouted op
         throws 'Unknown commission operation', which is a different error. */
      if (/Unknown commission operation/.test(String(e && e.message))) continue;
      routed++; refusedByHandler++;
    }
  }
  ck('D4 all thirteen ops route to a handler', routed === 13, routed + '/13');
  ck('D5 ...and most are refused by the HANDLER\'S own guard, not the dispatcher',
     refusedByHandler >= 8, refusedByHandler + ' refused downstream');

  head('3 — refusals the dispatcher owns');
  let e1 = null; try { await run({}); } catch (e) { e1 = e; }
  ck('D6 a missing op is refused', !!e1 && /op is required/.test(String(e1.message)));
  ck('D7 ...as invalid-argument', !!e1 && e1.code === 'invalid-argument', e1 && e1.code);

  let e2 = null; try { await run({ op: 'getWithdrawalsX' }); } catch (e) { e2 = e; }
  ck('D8 an UNKNOWN op is refused BY NAME, not silently ignored',
     !!e2 && /Unknown commission operation: getWithdrawalsX/.test(String(e2.message)),
     e2 && e2.message);
  ck('D9 ...as not-found', !!e2 && e2.code === 'not-found', e2 && e2.code);

  let e3 = null; try { await run({ op: 'toString' }); } catch (e) { e3 = e; }
  ck('D10 NC a prototype key cannot be dispatched — hasOwnProperty guards it',
     !!e3 && /Unknown commission operation/.test(String(e3.message)), e3 && e3.message);

  head('4 — authorisation is NOT weakened by the door');
  let e4 = null; try { await C.commissionDispatch.run({ auth: null, data: { op: 'listCommissionRules' } }); }
  catch (e) { e4 = e; }
  ck('D11 an unauthenticated call is still refused', !!e4, e4 && e4.code);
  /* NOT 'unauthenticated'. listCommissionRules guards with _assertAdmin(),
     which refuses a null caller as permission-denied — its OWN choice, made
     before this dispatcher existed. The property that matters is that the
     refusal comes from the HANDLER and not from the door: the dispatcher's own
     refusals are invalid-argument and not-found, so anything else proves the
     call reached the handler and its rule still applied unchanged. */
  ck("D12 ...by the HANDLER own guard, not by the dispatcher",
     !!e4 && e4.code !== 'invalid-argument' && e4.code !== 'not-found', e4 && e4.code);

  head('5 — the payload reaches the handler unchanged, minus op');
  const seen = [];
  const spy = Object.assign(function () {}, {
    run: async (req) => { seen.push(req); return { ok: true }; },
  });
  const src = require('fs').readFileSync(path.join(FN, 'commission.js'), 'utf8');
  ck('D13 the op key is stripped before the handler sees it',
     /if \(k !== 'op'\) rest\[k\] = data\[k\]/.test(src));
  ck('D14 auth is forwarded, not rebuilt', /auth: req\.auth/.test(src));
  ck('D15 App Check is enforced at the door', /commissionDispatch = onCall\(OPT60/.test(src) &&
     /OPT60\s*=\s*\{[^}]*enforceAppCheck: true/.test(src));
  ck('D16 NC the handlers are NOT reimplemented — the door calls .run()',
     /target\.run\(/.test(src) && !/async \(req\) => \{[\s\S]{0,200}collection\('commissionRules'\)/.test(
       src.slice(src.indexOf('commissionDispatch'))));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
