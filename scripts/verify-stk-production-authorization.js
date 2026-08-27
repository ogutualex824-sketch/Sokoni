#!/usr/bin/env node
/* Production authorisation must remain CLOSED — asserted against PRODUCTION DATA.
 *
 * The code that reads this flag (payment-destinations.js) does not exist on this
 * lineage, so a source assertion here would prove nothing. What matters is the
 * data: no seller anywhere may carry productionAuthorized === true until
 * Safaricom resolves the merchant-of-record question.
 *
 * READ-ONLY. Writes nothing. Sends no STK push.
 *
 *   node scripts/verify-stk-production-authorization.js
 */
'use strict';
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

(async () => {
  console.log('\nProduction authorisation — live data\n');

  const snap = await db.collection('paymentDestinations').get();
  const docs = snap.docs.map((d) => ({ id: d.id, d: d.data() }));
  console.log('  paymentDestinations documents: ' + docs.length);

  /* Control: the read must actually be capable of finding a true value, or
     "none are authorised" is indistinguishable from "the query found nothing". */
  const withFlag = docs.filter((x) => x.d.productionAuthorized !== undefined);
  ck('the collection was actually read (control)', docs.length > 0, docs.length + ' docs');
  ck('  ...and the flag is present to be read (control)', withFlag.length > 0,
     withFlag.length + ' docs carry the field');

  const authorised = docs.filter((x) => x.d.productionAuthorized === true);
  ck('NO seller has productionAuthorized === true', authorised.length === 0,
     authorised.map((x) => x.id).join(', ') || 'none');

  const verified = docs.filter((x) => x.d.activeDestination && x.d.activeDestination.status === 'VERIFIED');
  ck('no seller has a VERIFIED active destination yet', verified.length === 0,
     verified.map((x) => x.id).join(', ') || 'none');

  const KASS = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
  const k = docs.find((x) => x.id === KASS);
  ck('KASS document exists', !!k);
  if (k) {
    ck('KASS productionAuthorized is false', k.d.productionAuthorized === false, JSON.stringify(k.d.productionAuthorized));
    ck('KASS activeDestination is null', !k.d.activeDestination, JSON.stringify(k.d.activeDestination || null));
  }

  const ss = await db.collection('shopSettings').doc(KASS).get();
  ck('KASS Daraja env is sandbox', ss.exists && ss.get('darajaEnv') === 'sandbox', ss.get('darajaEnv'));
  ck('  ...on the public sandbox shortcode, not a real till',
     ss.get('darajaShortCode') === '174379', ss.get('darajaShortCode'));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CHECK FAILED: ' + e.message.slice(0, 200)); process.exit(1); });
