#!/usr/bin/env node
'use strict';
/* WITHDRAWALS OFF (owner 2026-10-03) — deliberate breaks against the REAL handlers
     W1  a provider calling requestSellerPayout directly is REFUSED (WITHDRAWALS_DISABLED) when the flag is absent / false / not
         literally true — before any balance, PIN or B2C code runs; the wallet is untouched
     W2  an unreadable flag also refuses (fail closed)
     W3  providerRequestPayout (old provider-payout route) refuses unconditionally (PAYOUT_ROUTE_RETIRED) and marks nothing
     W4  the three older initiators (requestWithdrawal, finosRequestBankPayout, requestPayout) still throw RETIRED before any
         money statement in this tree (static: first statement after auth is the throw)
   NODE_PATH=<functions/node_modules> node scripts/test-withdrawals-off.js */
const path = require('path'), fs = require('fs');
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const { DOCS } = H;
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
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
