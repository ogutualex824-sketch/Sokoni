#!/usr/bin/env node
/* test-verif-jobs-rules.js — combined rules candidate, owner gate items 1 + 2 (2026-10-01).
 *   V  verifications / verificationRequests are server-only: a forged approved badge, a self-request, any owner
 *      update and any admin raw write are DENIED; the owner still READS their own records (positive controls).
 *   J  /jobs create: the operator-precedence hole is closed — anonymous create (with or without applicants:0)
 *      DENIED; an authed create with applicants:0 is allowed ONLY when the rest of the contract holds; applicants>0
 *      DENIED; a normal authed create still PASSES.
 * Emulator on a private port via run-rules-suite.js; the ruleset is RULES_FILE. No production.
 *   node scripts/zz-run-rules-suite.js scripts/test-verif-jobs-rules.js firestore.rules.build   (candidate: PASS)
 *   node scripts/zz-run-rules-suite.js scripts/test-verif-jobs-rules.js zz-served.rules         (served: V/J FAIL)
 */
'use strict';
const fs = require('fs'), path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require(require.resolve('@firebase/rules-unit-testing', { paths: [process.cwd(), path.resolve(__dirname, '..')] }));
const RULES = path.resolve(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build');
const [host, port] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
let pass = 0, fail = 0;
const ck = async (label, p) => { try { await p; console.log('  PASS  ' + label); pass++; } catch (e) { console.log('  FAIL  ' + label + '   [' + String(e && e.message || e).slice(0, 120) + ']'); fail++; } };

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-verifjobs', firestore: { rules: fs.readFileSync(RULES, 'utf8'), host, port: Number(port) } });
  console.log('\nRULES: ' + path.basename(RULES));
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await db.doc('verifications/u1').set({ uid: 'u1', facets: { identity: { state: 'pending' } } });
    await db.doc('verificationRequests/r1').set({ applicantUid: 'u1', facet: 'identity', state: 'pending', status: 'pending' });
  });
  const u1 = env.authenticatedContext('u1', {}).firestore();
  const u2 = env.authenticatedContext('u2', {}).firestore();
  const adm = env.authenticatedContext('adm', { admin: true }).firestore();
  const anon = env.unauthenticatedContext().firestore();

  console.log('\n── V: verification badges are server-only ──');
  await ck('V1  forged badge: u2 creates verifications/u2 with facets.identity.state approved → DENIED', assertFails(u2.doc('verifications/u2').set({ uid: 'u2', status: 'pending', facets: { identity: { state: 'approved' } } })));
  await ck('V2  even the old "pending" create shape → DENIED (no browser writer remains)', assertFails(u2.doc('verifications/u2').set({ uid: 'u2', status: 'pending' })));
  await ck('V3  owner upgrades own facet to approved → DENIED', assertFails(u1.doc('verifications/u1').update({ 'facets.identity.state': 'approved' })));
  await ck('V4  admin RAW client write to verifications → DENIED (verificationDecide is the path)', assertFails(adm.doc('verifications/u1').update({ 'facets.identity.state': 'approved' })));
  await ck('V5  self-created verificationRequest → DENIED (verificationSubmit is the path)', assertFails(u2.collection('verificationRequests').add({ applicantUid: 'u2', status: 'pending' })));
  await ck('V6  owner flips own request to approved → DENIED', assertFails(u1.doc('verificationRequests/r1').update({ status: 'approved' })));
  await ck('V7  POSITIVE: the owner still READS their verifications', assertSucceeds(u1.doc('verifications/u1').get()));
  await ck('V8  POSITIVE: the applicant still READS their own request', assertSucceeds(u1.doc('verificationRequests/r1').get()));
  await ck('V9  another user cannot read someone\'s verifications', assertFails(u2.doc('verifications/u1').get()));

  console.log('\n── J: jobs create precedence ──');
  const job = (uid, extra) => Object.assign({ uid, title: 'Cashier', company: 'KASS', description: 'Till work', contactEmail: 'hr@example.com' }, extra || {});
  await ck('J1  anonymous create with applicants:0 → DENIED (the precedence hole)', assertFails(anon.collection('jobs').add(job('anyone', { applicants: 0 }))));
  await ck('J2  anonymous create without applicants → DENIED', assertFails(anon.collection('jobs').add(job('anyone'))));
  await ck('J3  authed create for ANOTHER uid with applicants:0 → DENIED', assertFails(u1.collection('jobs').add(job('u2', { applicants: 0 }))));
  await ck('J4  authed + applicants:0 but NO title → DENIED (the rest of the contract must hold)', assertFails(u1.collection('jobs').add({ uid: 'u1', company: 'K', description: 'd', contactEmail: 'e', applicants: 0 })));
  await ck('J5  authed + applicants:5 → DENIED', assertFails(u1.collection('jobs').add(job('u1', { applicants: 5 }))));
  await ck('J6  POSITIVE: authed + applicants:0 + full contract → ALLOWED', assertSucceeds(u1.collection('jobs').add(job('u1', { applicants: 0 }))));
  await ck('J7  POSITIVE: authed normal create (no applicants) → ALLOWED', assertSucceeds(u1.collection('jobs').add(job('u1'))));

  await env.cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
