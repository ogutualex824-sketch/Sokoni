#!/usr/bin/env node
/* ============================================================================
   GATE 4 — production authorization regression, differentially
   ============================================================================
   Gate 3 proved the 729 candidate was CONSTRUCTED correctly. It did not prove
   the candidate BEHAVES like production across the authorization surface.

   The weak way to test that is to write assertions from what I believe each
   rule intends — which makes the test a record of my assumptions, and would
   have quietly encoded the stale shops/{uid} model had it been run earlier.

   So this is DIFFERENTIAL. The same operations run against two rulesets:

       DEPLOYED    ad2033ad, 709 blocks — what production does today
       CANONICAL   the freshly built 729 artifact

   and every outcome must match. That tests the actual deployed behaviour as
   the oracle instead of my expectation of it, and it fails loudly if the
   reconciliation changed anything a client can observe.

   The named high-risk areas — wallets, settlement, payment destinations,
   dispatch, tills, shops — are covered explicitly, shops including the
   ownerId primary, the legacy uid == storeId fallback, and timezone.

   Usage:
     firebase emulators:exec --only firestore "node scripts/gate-authz-regression.js"
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const ROOT = path.join(__dirname, '..');
const SP = process.env.SOKONI_EVIDENCE_DIR ||
  'C:/Users/USER1/AppData/Local/Temp/claude/c--Users-USER1-OneDrive-Desktop-SOKONI/51f05820-e88d-48b4-8b14-ba44300630f9/scratchpad';
const HOST = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');

const OWNER = 'owner_uid', OTHER = 'other_uid', SELLER = 'seller_uid', RIDER = 'rider_uid';

/* Seed docs written through the admin path, so a denial is the RULE's and not
   a missing document. */
const SEED = {
  businessWallets:        { id: OWNER,      data: { ownerId: OWNER, balance: 100 } },
  businessWalletEntries:  { id: 'e1',       data: { businessId: OWNER, amount: 5 } },
  settlementHolds:        { id: 'o1',       data: { sellerUid: SELLER, amount: 10 } },
  paymentDestinations:    { id: SELLER,     data: { sellerUid: SELLER, till: '123' } },
  sellerRestrictions:     { id: SELLER,     data: { sellerUid: SELLER, blocked: false } },
  deliveryJobs:           { id: 'd1',       data: { assignedRiderId: RIDER, sellerUid: SELLER } },
  deliveryDispatchMessages:{ id: 'm1',      data: { to: RIDER, deliveryId: 'd1' } },
  riderRatings:           { id: 'r1',       data: { riderId: RIDER, stars: 5 } },
  courierQuotes:          { id: 'q1',       data: { sellerUid: SELLER, price: 200 } },
  sokoniTills:            { id: 't1',       data: { sellerUid: SELLER, tillNumber: '555' } },
  storeProvisioning:      { id: OWNER,      data: { uid: OWNER, state: 'ready' } },
  resolutions:            { id: 'res1',     data: { orderId: 'o1', status: 'open' } },
  productReportSummaries: { id: 'p1',       data: { productId: 'p1', reports: 2 } },
  /* shops — the three production cases, as separate documents. */
  shops:                  { id: OWNER,      data: { ownerId: OWNER, name: 'Owned Shop', timezone: 'Africa/Nairobi' } },
};
const EXTRA_SHOPS = [
  { id: 'legacy_shop', data: { name: 'Legacy Shop' } },              /* no ownerId */
  { id: OTHER,         data: { ownerId: OTHER, name: 'Other Shop' } },
];

function casesFor(db, who) {
  const out = [];
  Object.keys(SEED).forEach((c) => {
    const ref = db.collection(c).doc(SEED[c].id);
    out.push([c + '.get.' + who, () => ref.get()]);
    out.push([c + '.list.' + who, () => db.collection(c).limit(1).get()]);
    out.push([c + '.create.' + who, () => db.collection(c).doc('new_' + who).set({ x: 1 })]);
    out.push([c + '.update.' + who, () => ref.update({ x: 2 })]);
    out.push([c + '.delete.' + who, () => ref.delete()]);
  });
  /* shops, the production model, explicitly. */
  const s = (id) => db.collection('shops').doc(id);
  out.push(['shops.ownerId-primary.update.' + who, () => s(OWNER).update({ name: 'Renamed', updatedAt: 1 })]);
  out.push(['shops.wrong-owner.update.' + who, () => s(OTHER).update({ name: 'Hijacked', updatedAt: 1 })]);
  out.push(['shops.legacy-fallback.update.' + who, () => s('legacy_shop').update({ name: 'Legacy Renamed', updatedAt: 1 })]);
  out.push(['shops.timezone-valid.update.' + who, () => s(OWNER).update({ timezone: 'Africa/Nairobi', updatedAt: 1 })]);
  out.push(['shops.timezone-invalid.update.' + who, () => s(OWNER).update({ timezone: 'not a zone!!', updatedAt: 1 })]);
  out.push(['shops.field-not-allowlisted.update.' + who, () => s(OWNER).update({ ownerId: who, updatedAt: 1 })]);
  out.push(['shops.public.get.' + who, () => s(OWNER).get()]);
  return out;
}

async function runVariant(label, rulesText) {
  const env = await initializeTestEnvironment({
    projectId: 'g4-' + label + '-' + Date.now(),
    firestore: { rules: rulesText, host: HOST[0], port: Number(HOST[1]) },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const c of Object.keys(SEED)) await db.collection(c).doc(SEED[c].id).set(SEED[c].data);
    for (const s of EXTRA_SHOPS) await db.collection('shops').doc(s.id).set(s.data);
  });

  const results = {};
  const contexts = [
    ['unauth', env.unauthenticatedContext().firestore()],
    ['owner', env.authenticatedContext(OWNER).firestore()],
    ['other', env.authenticatedContext(OTHER).firestore()],
    ['seller', env.authenticatedContext(SELLER).firestore()],
    ['rider', env.authenticatedContext(RIDER).firestore()],
    ['legacy', env.authenticatedContext('legacy_shop').firestore()],
    ['admin', env.authenticatedContext('admin_uid', { admin: true }).firestore()],
  ];
  for (const [who, db] of contexts) {
    for (const [name, fn] of casesFor(db, who)) {
      try { await fn(); results[name] = 'ALLOWED'; }
      catch (e) { results[name] = 'DENIED'; }
    }
  }
  await env.cleanup();
  return results;
}

(async () => {
  console.log('\nGATE 4 — PRODUCTION AUTHORIZATION REGRESSION (differential)\n');
  const deployed = fs.readFileSync(SP + '/live-rules.txt', 'utf8');
  const canonical = fs.readFileSync(path.join(ROOT, 'firestore.rules.build'), 'utf8');

  const D = await runVariant('deployed', deployed);
  const C = await runVariant('canonical', canonical);

  const names = Object.keys(D);
  const diffs = names.filter((n) => D[n] !== C[n]);
  const allowed = names.filter((n) => D[n] === 'ALLOWED');

  console.log('  cases per ruleset        ' + names.length);
  console.log('  outcomes identical       ' + (names.length - diffs.length) + '/' + names.length);
  console.log('  ALLOWED in production    ' + allowed.length + '   (the oracle is not deny-everything)');
  if (diffs.length) {
    console.log('');
    console.log('  DIFFERENCES — the reconciliation changed observable behaviour:');
    diffs.forEach((n) => console.log('     ' + n + '   deployed=' + D[n] + '  canonical=' + C[n]));
  }

  /* The named shops cases, reported explicitly whatever the aggregate says. */
  console.log('');
  console.log('  shops, production model (deployed -> canonical):');
  names.filter((n) => n.indexOf('shops.') === 0 && n.indexOf('.owner') !== -1 || /shops\.(ownerId|wrong|legacy|timezone|field|public)/.test(n))
    .forEach((n) => console.log('     ' + n.padEnd(46) + D[n] + ' -> ' + C[n] + (D[n] === C[n] ? '' : '   <-- CHANGED')));

  const ev = { gate: 'authz-regression', at: new Date().toISOString(),
    cases: names.length, identical: names.length - diffs.length,
    allowed_in_production: allowed.length, differences: diffs.map((n) => ({ case: n, deployed: D[n], canonical: C[n] })),
    result: (diffs.length === 0 && allowed.length > 0) ? 'GREEN' : 'BLOCKED' };
  try { fs.writeFileSync(path.join(SP, 'gate4-authz-evidence.json'), JSON.stringify(ev, null, 2)); } catch (e) {}

  const green = diffs.length === 0 && allowed.length > 0;
  console.log('');
  console.log('  GATE 4 = ' + (green ? 'GREEN' : 'BLOCKED'));
  console.log('');
  process.exit(green ? 0 : 1);
})().catch((e) => {
  console.error('\n  GATE 4 CRASHED — a failure, not a skip');
  console.error(e && e.stack);
  process.exit(1);
});
