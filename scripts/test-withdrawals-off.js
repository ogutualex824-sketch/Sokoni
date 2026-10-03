#!/usr/bin/env node
'use strict';
/* WITHDRAWALS OFF (owner 2026-10-03) — deliberate breaks against the REAL handlers
     W1  a provider calling requestSellerPayout directly is REFUSED (WITHDRAWALS_DISABLED) when the flag is absent / false / not
         literally true — before any balance, PIN or B2C code runs; the wallet is untouched
     W2  an unreadable flag also refuses (fail closed)
     W3  providerRequestPayout (old provider-payout route) refuses unconditionally (PAYOUT_ROUTE_RETIRED) and marks nothing
     W4  the three older initiators (requestWithdrawal, finosRequestBankPayout, requestPayout) still throw RETIRED before any
         money statement in this tree (static: first statement after auth is the throw)
     W5  DIRECT provider calls to requestWithdrawal / finosRequestBankPayout / requestPayout / approveWithdrawal → refused, wallet untouched
     W6  initiateSellerPayout refuses non-admins as its first statement
     W7  gate CLOSED: processPendingPayouts / autoScheduledPayouts / processPayoutRetries move nothing
     W8  reconcilePayouts (inspect-only) keeps running; W9 positive control — gate OPEN lets the mover proceed
     W10 initiateSellerPayout honours the gate before any B2C
     W12 fail-closed network firewall: zero requests to IntaSend (B2C is a recorder)
   NODE_PATH=<functions/node_modules> node scripts/test-withdrawals-off.js */
const path = require('path'), fs = require('fs');
/* ══ NETWORK FIREWALL (b2 finding 2026-10-04) — this suite must NEVER reach IntaSend ══════════════════════════════════
   The "gate OPEN" positive control lets the payout jobs run their real code; processPendingPayouts then calls
   intasendB2C → fetch('https://payment.intasend.com/...') — the LIVE send-money API. It failed only because no key was in
   the environment. Now, BEFORE any functions module loads: no IntaSend key, sandbox forced, fetch / http / https to any
   IntaSend host refused and COUNTED (row W12 fails the suite on a single attempt), and finos-utils.intasendB2C replaced by
   a RECORDER, so a positive control proves the job REACHED disbursement without anything leaving this process. */
process.env.INTASEND_PRIVATE_KEY = ''; process.env.INTASEND_SECRET_KEY = ''; process.env.INTASEND_SANDBOX = 'true';
const NET = { intasend: 0, urls: [] };
globalThis.fetch = async (url) => { const u = String(url && url.url || url); NET.urls.push(u); if (/intasend/i.test(u)) NET.intasend++;
  return { ok: false, status: 599, json: async () => ({ blocked_by_test_firewall: true }), text: async () => 'blocked by test firewall' }; };
for (const m of ['https', 'http']) {
  const mod = require(m); const origReq = mod.request, origGet = mod.get;
  const guard = (o) => { const h = typeof o === 'string' ? o : (o && (o.hostname || o.host || (o.href || ''))) || ''; if (/intasend/i.test(String(h))) { NET.intasend++; throw new Error('blocked by test firewall: ' + h); } };
  mod.request = function (o, ...r) { guard(o); return origReq.call(this, o, ...r); };
  mod.get = function (o, ...r) { guard(o); return origGet.call(this, o, ...r); };
}
const B2C_CALLS = [];
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const { DOCS } = H;
/* B2C recorder — installed on the shared finos-utils exports BEFORE wallet.js / finos.js load (wallet destructures it). */
{ const FUx = require(path.join(FN, 'finos-utils.js')); FUx.intasendB2C = async (...args) => { B2C_CALLS.push(args.length); return { ok: false, status: 'recorded_by_test', recorded: true }; }; }
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };

(async () => {
  const W = require(path.join(FN, 'wallet.js'));
  const PO = require(path.join(FN, 'provider-ops.js'))._h;
  const run = (fn) => call((r) => (fn.run ? fn.run(r) : fn(r)), 'prov1', { amount: 5000, method: 'mpesa', accountNumber: '254700000000', pin: '1234', idempotencyKey: 'k1' });
  const states = [['absent', null], ['false', { enabled: false }], ['string "true"', { enabled: 'true' }], ['1', { enabled: 1 }]];
  const results = [];
  for (const [label, doc] of states) {
    H.reset();
    DOCS.set('wallets/prov1', { balance: 100000, currency: 'KES' });
    if (doc) DOCS.set('platformConfig/withdrawals', doc);
    const r = await run(W.requestSellerPayout);
    results.push([label, r.det && r.det.code, DOCS.get('wallets/prov1').balance, [...DOCS.keys()].filter((k) => k.startsWith('payoutRequests/')).length]);
  }
  ck('W1', results.every(([, code, bal, reqs]) => code === 'WITHDRAWALS_DISABLED' && bal === 100000 && reqs === 0),
    'direct requestSellerPayout refused unless the flag is literally true; balance untouched, no payout request written', results);

  H.reset();
  DOCS.set('wallets/prov1', { balance: 100000 });
  const origGet = H.db && H.db.collection;
  let threw = false;
  const fsAdmin = require('firebase-admin/firestore').getFirestore();
  const realColl = fsAdmin.collection.bind(fsAdmin);
  fsAdmin.collection = (c) => { if (c === 'platformConfig') { threw = true; throw new Error('UNAVAILABLE'); } return realColl(c); };
  const r2 = await run(W.requestSellerPayout);
  fsAdmin.collection = realColl;
  ck('W2', threw && r2.det && r2.det.code === 'WITHDRAWALS_DISABLED', 'an unreadable flag refuses (fail closed)', r2);

  H.reset();
  DOCS.set('providerPayouts/x', { providerId: 'prov1', status: 'pending', net: 5000 });
  const r3 = await call(PO.providerRequestPayout, 'prov1', {});
  ck('W3', r3.det && r3.det.code === 'PAYOUT_ROUTE_RETIRED' && DOCS.get('providerPayouts/x').status === 'pending', 'providerRequestPayout refuses unconditionally and marks nothing', r3);

  const heads = [['commission.js', 'requestWithdrawal'], ['finos-router.js', 'finosRequestBankPayout'], ['finos.js', 'requestPayout']].map(([f, n]) => {
    const src = fs.readFileSync(path.join(FN, f), 'utf8'); const i = src.indexOf('exports.' + n + ' = onCall');
    const body = src.slice(i, i + 900); const t = body.indexOf("throw new HttpsError('failed-precondition'");
    const money = body.search(/\.runTransaction|intasendB2C|\.update\(|\.set\(|increment\(/);
    return [n, t > 0 && (money < 0 || t < money)];
  });
  ck('W4', heads.every(([, ok]) => ok), 'older initiators still throw RETIRED before any money statement', heads);

  /* W5 DIRECT server calls, as a PROVIDER, to every other payout route (owner: the disabled UI is not evidence) */
  H.reset();
  DOCS.set('wallets/prov1', { balance: 100000, withdrawableBalance: 10000000, availableBalance: 10000000 });
  const direct = [];
  for (const [file, name, data] of [['commission.js', 'requestWithdrawal', { amountCents: 500000, method: 'mpesa', phone: '254700000000' }],
    ['finos-router.js', 'finosRequestBankPayout', { amountCents: 500000, bankCode: '01', accountNumber: '123' }],
    ['finos.js', 'requestPayout', { amountCents: 500000, method: 'mpesa', phone: '254700000000' }],
    ['commission.js', 'approveWithdrawal', { withdrawalId: 'w1' }]]) {
    let mod; try { mod = require(path.join(FN, file)); } catch (e) { direct.push([name, 'LOAD_FAIL ' + e.message.slice(0, 60)]); continue; }
    const r = await call((req) => mod[name].run(req), 'prov1', data);
    direct.push([name, r.ok ? 'MOVED_OR_ACCEPTED' : r.code, DOCS.get('wallets/prov1').balance === 100000 && DOCS.get('wallets/prov1').withdrawableBalance === 10000000]);
  }
  ck('W5', direct.length === 4 && direct.every(([, code, untouched]) => (code === 'failed-precondition' || code === 'permission-denied') && untouched === true),
    'direct provider calls: requestWithdrawal / finosRequestBankPayout / requestPayout REFUSED (retired), approveWithdrawal REFUSED (admin-only); no wallet field moved', direct);
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8'); const i = idx.indexOf('exports.initiateSellerPayout = onCall');
  const head = idx.slice(i, i + 400);
  ck('W6', /if \(!request\.auth \|\| !request\.auth\.token \|\| !request\.auth\.token\.admin\)\s*\{\s*throw new HttpsError\("permission-denied"/.test(head),
    'initiateSellerPayout: the FIRST statement refuses any non-admin caller (index.js is not loaded in-process; static on the exact guard)');

  /* W7–W10 SCHEDULED money movers honour the SAME gate (b2 blocker, owner 2026-10-03).
     Signal = whether the job touches the payout queues AT ALL (a closed gate must stop it before its first queue read);
     the OPEN run is the positive control that the same job does reach the queues. */
  const runJob = async (fn) => { try { await (fn.run ? fn.run({}) : fn({})); return { ok: true }; } catch (e) { return { ok: false, msg: String(e && e.message || e).slice(0, 120) }; } };
  const fsA = require('firebase-admin/firestore').getFirestore();
  const admA = require('firebase-admin').firestore();
  const QUEUES = new Set(['payouts', 'payoutRequests']);
  const spy = (fn) => async () => {
    let touched = 0;
    const wrap = (o) => { const orig = o.collection.bind(o); o.collection = (c) => { if (QUEUES.has(c)) touched++; return orig(c); }; return () => { o.collection = orig; }; };
    const u1 = wrap(fsA), u2 = admA === fsA ? () => {} : wrap(admA);
    const r = await runJob(fn); u1(); u2(); return { r, touched };
  };
  const seedQueues = (open) => {
    H.reset();
    DOCS.set('payouts/po1', { status: 'pending', entityId: 'prov1', netCents: 500000, requestedAt: new Date(Date.now() - 9 * 86400000) });
    DOCS.set('payoutRequests/pr1', { status: 'retry_scheduled', sellerUid: 'prov1', amount: 5000, nextRetryAt: new Date(0) });
    DOCS.set('automationRules/payouts', { enabled: true, holdDays: 1, autoProcessBelow: 100000000 });
    if (open) DOCS.set('platformConfig/withdrawals', { enabled: true });
  };
  const FIN = require(path.join(FN, 'finos.js')), AE = require(path.join(FN, 'automation-engine.js'));
  const jobs = [['processPendingPayouts', FIN.processPendingPayouts], ['autoScheduledPayouts', AE.autoScheduledPayouts], ['processPayoutRetries', W.processPayoutRetries]];
  const closed = [], opened = [];
  for (const [n, fn] of jobs) { seedQueues(false); const x = await spy(fn)(); closed.push([n, x.touched, DOCS.get('payouts/po1').status, DOCS.get('payoutRequests/pr1').status]); }
  for (const [n, fn] of jobs) { seedQueues(true); const x = await spy(fn)(); opened.push([n, x.touched]); }
  ck('W7', closed.every(([, t, po, pr]) => t === 0 && po === 'pending' && pr === 'retry_scheduled'),
    'gate CLOSED: processPendingPayouts / autoScheduledPayouts / processPayoutRetries never touch the payout queues (nothing moves)', closed);
  ck('W9', opened.every(([, t]) => t > 0), 'POSITIVE CONTROL — gate OPEN: each of the same jobs does reach the payout queues', opened);
  seedQueues(false);
  const rc = await spy(W.reconcilePayouts)();
  ck('W8', rc.r.ok && rc.touched > 0, 'reconcilePayouts (inspect/flag only, moves no money) still runs and reads its queue while the gate is closed', rc);
  const idx2 = fs.readFileSync(path.join(FN, 'index.js'), 'utf8'); const k = idx2.indexOf('exports.initiateSellerPayout = onCall'); const body = idx2.slice(k, k + 3000);
  const gi = body.indexOf("require('./shared/withdrawal-gate').withdrawalsOpen(admin.firestore())"), si = body.indexOf('INTASEND_PRIVATE_KEY.value()');
  ck('W10', gi > 0 && si > gi, 'initiateSellerPayout (admin B2C) checks the gate right after the admin check, before the secret / any B2C', { gi, si });
  ck('W12', NET.intasend === 0, 'FAIL-CLOSED: not one request to any IntaSend host was attempted during the whole suite (B2C went to the recorder: ' + B2C_CALLS.length + ' call(s))', NET.urls);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
