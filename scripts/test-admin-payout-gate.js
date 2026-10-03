#!/usr/bin/env node
'use strict';
/* adminProcessPayout behind the ONE withdrawal gate — follow-up to the payout P0 (owner H4), built on the SERVING bytes
   (revision 00024-mih = 45a837d paid-state guard).
     A1  gate CLOSED: approve (may auto-B2C) → WITHDRAWALS_DISABLED; request untouched; no B2C
     A2  gate CLOSED: attest 'paid' → WITHDRAWALS_DISABLED
     A3  gate CLOSED: reject still works (it RETURNS the reserved money to the seller)
     A4  POSITIVE CONTROL — gate OPEN: approve passes the gate (reaches the existing approval logic)
     A5  45a837d preserved — gate OPEN: 'paid' on a NON-approved request is still refused (approved-only Mark Paid)
     A7  an unreadable flag refuses approve (fail closed)
     A6  FAIL-CLOSED network firewall: zero requests to IntaSend (B2C is a recorder)
   NODE_PATH=<functions/node_modules> node scripts/test-admin-payout-gate.js */
const path = require('path');
process.env.INTASEND_PRIVATE_KEY = ''; process.env.INTASEND_SECRET_KEY = ''; process.env.INTASEND_SANDBOX = 'true';
const NET = { intasend: 0, urls: [] };
globalThis.fetch = async (url) => { const u = String(url && url.url || url); NET.urls.push(u); if (/intasend/i.test(u)) NET.intasend++;
  return { ok: false, status: 599, json: async () => ({ blocked_by_test_firewall: true }), text: async () => 'blocked' }; };
for (const m of ['https', 'http']) { const mod = require(m); const o = mod.request; mod.request = function (opt, ...r) { const h = typeof opt === 'string' ? opt : (opt && (opt.hostname || opt.host)) || ''; if (/intasend/i.test(String(h))) { NET.intasend++; throw new Error('blocked'); } return o.call(this, opt, ...r); }; }
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const { DOCS } = H;
const B2C = []; { const FU = require(path.join(FN, 'finos-utils.js')); FU.intasendB2C = async (...a) => { B2C.push(a.length); return { ok: false, recorded: true }; }; }
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
const W = require(path.join(FN, 'wallet.js'));
const ADMIN = { admin: true };
const seed = (status, open) => { H.reset(); DOCS.set('payoutRequests/rq1', { sellerUid: 'prov1', amount: 5000, status, method: 'mpesa', accountNumber: '254700000000' });
  DOCS.set('wallets/prov1', { balance: 0, pendingPayout: 5000 }); if (open) DOCS.set('platformConfig/withdrawals', { enabled: true }); };
const run = (status, extra) => call((r) => W.adminProcessPayout.run(r), 'admin1', Object.assign({ requestId: 'rq1', status }, extra || {}), ADMIN);

(async () => {
  seed('pending', false); const a1 = await run('approved');
  ck('A1', a1.det && a1.det.code === 'WITHDRAWALS_DISABLED' && DOCS.get('payoutRequests/rq1').status === 'pending' && B2C.length === 0, 'gate CLOSED: approve refused, request untouched, no B2C', a1);
  seed('approved', false); const a2 = await run('paid');
  ck('A2', a2.det && a2.det.code === 'WITHDRAWALS_DISABLED' && DOCS.get('payoutRequests/rq1').status === 'approved', 'gate CLOSED: attest paid refused', a2);
  seed('pending', false); const a3 = await run('rejected', { note: 'withdrawals off' });
  ck('A3', !(a3.det && a3.det.code === 'WITHDRAWALS_DISABLED') && DOCS.get('payoutRequests/rq1').status === 'rejected', 'gate CLOSED: reject still works (money back to the seller)', [a3, DOCS.get('payoutRequests/rq1').status]);
  seed('pending', true); const a4 = await run('approved');
  ck('A4', !(a4.det && a4.det.code === 'WITHDRAWALS_DISABLED') && DOCS.get('payoutRequests/rq1').status !== 'pending', 'POSITIVE CONTROL — gate OPEN: approve passes the gate into the existing approval logic', [a4, DOCS.get('payoutRequests/rq1').status]);
  seed('pending', true); const a5 = await run('paid');
  ck('A5', !a5.ok && !(a5.det && a5.det.code === 'WITHDRAWALS_DISABLED') && DOCS.get('payoutRequests/rq1').status === 'pending', '45a837d preserved — gate OPEN: Mark Paid on a non-approved request still refused', a5);
  seed('pending', true);
  { const fsA = require('firebase-admin/firestore').getFirestore(); const realColl = fsA.collection.bind(fsA); let threw = false;
    fsA.collection = (c) => { if (c === 'platformConfig') { threw = true; throw new Error('UNAVAILABLE'); } return realColl(c); };
    const a7 = await run('approved'); fsA.collection = realColl;
    ck('A7', threw && a7.det && a7.det.code === 'WITHDRAWALS_DISABLED' && DOCS.get('payoutRequests/rq1').status === 'pending', 'an UNREADABLE withdrawal flag refuses approval (fail closed) even though the flag doc says enabled', a7); }
  ck('A6', NET.intasend === 0, 'FAIL-CLOSED: zero requests to IntaSend (B2C recorder calls: ' + B2C.length + ')', NET.urls);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
