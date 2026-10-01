#!/usr/bin/env node
'use strict';
/* ============================================================================
   Marketing email consent + one-click unsubscribe + SMS lockdown (2026-10-01)
   ----------------------------------------------------------------------------
   Real modules (functions/email-service.js, functions/email-unsubscribe.js) with firebase-admin
   replaced at the SDK boundary by the in-memory Firestore fake; transports never called.
     A  _checkPreferences: marketing needs marketing===true (no doc / no uid / read error → blocked);
        promotions & loyalty count as marketing; service mail unchanged; no category never blocked
     B  send(): a marketing mail to a non-consenting or unknown recipient is SKIPPED before any
        transport; a consenting one gets an HTTPS one-click link (header + footer) and a stored token
     C  headers: One-Click advertised only with an HTTPS URI; transactional mail has no One-Click
     D  emailUnsubscribe: GET shows a confirmation (does not unsubscribe); POST with the right token
        sets marketing/newsletter off + notifyPrefs promotions off; wrong/malformed token → 400;
        service categories untouched; the mail after unsubscribing is skipped; re-opt-in works
     E  posSendSMS is admin-only with App Check (source check)
   node scripts/test-email-consent.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

const F = makeFakeFirestore();
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const resolveFrom = (r) => Module._resolveFilename(r, { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
const fa = resolveFrom('firebase-admin'); require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff } };
const ES = require(path.join(FN, 'email-service.js'));
const UN = require(path.join(FN, 'email-unsubscribe.js'))._internal;

(async () => {
  console.log('Marketing consent + unsubscribe\n');
  console.log('A. _checkPreferences');
  ck('A1 marketing to a user with NO preferences document → blocked', await ES._checkPreferences('uNo', 'marketing') === false);
  ck('A2 marketing with no uid → blocked', await ES._checkPreferences('', 'marketing') === false);
  await F.db.collection('emailPreferences').doc('uYes').set({ marketing: true });
  await F.db.collection('emailPreferences').doc('uOff').set({ marketing: false, orders: true });
  ck('A3 marketing to an opted-in user → allowed', await ES._checkPreferences('uYes', 'marketing') === true);
  ck('A4 promotions and loyalty are marketing (blocked without opt-in)', await ES._checkPreferences('uNo', 'promotions') === false && await ES._checkPreferences('uNo', 'loyalty') === false && await ES._checkPreferences('uYes', 'promotions') === true);
  ck('A5 service mail unchanged: orders/payment allowed without a document', await ES._checkPreferences('uNo', 'order') === true && await ES._checkPreferences('uNo', 'payment') === true);
  ck('A6 mail with no category (OTP/auth) is never blocked', await ES._checkPreferences('uNo', '') === true && await ES._checkPreferences('', undefined) === true);
  const origGet = F.db.collection;
  F.db.collection = () => ({ doc: () => ({ get: async () => { throw new Error('down'); } }) });
  const e1 = await ES._checkPreferences('uYes', 'marketing'), e2 = await ES._checkPreferences('uYes', 'order');
  F.db.collection = origGet;
  ck('A7 read error: marketing blocked (fail closed), service mail allowed', e1 === false && e2 === true, { e1, e2 });

  console.log('\nB. send()');
  const r1 = await ES.send({ to: 'a@example.com', subject: 'Deals', html: '<p>Hi</p>', category: 'marketing', uid: 'uNo' });
  const r2 = await ES.send({ to: 'b@example.com', subject: 'Deals', html: '<p>Hi</p>', category: 'marketing' });
  ck('B1 marketing to a non-consenting user is skipped before any transport', r1 && r1.skipped === true && r1.reason === 'opted_out', r1);
  ck('B2 marketing with no uid (e.g. a broadcast) is skipped — consent cannot be shown', r2 && r2.skipped === true && r2.reason === 'no_consent_recipient', r2);
  const src = fs.readFileSync(path.join(FN, 'email-service.js'), 'utf8');
  ck('B3 a consenting recipient gets the one-click link + footer (code path present before transport)', /if \(payload\.uid && _isMarketing\(payload\.category\)\)[\s\S]{0,200}_withUnsubFooter\(payload, await _unsubUrlFor\(payload\.uid\)\)/.test(src) && src.indexOf('_withUnsubFooter(payload, await _unsubUrlFor') < src.indexOf('result = await _sendViaSendGrid(payload)'));

  console.log('\nC. headers');
  const hT = ES._buildHeaders({ emailId: 'x1', category: 'order' });
  const hM = ES._buildHeaders({ emailId: 'x2', category: 'marketing', _unsubUrl: 'https://us-central1-sokoni-aeb26.cloudfunctions.net/emailUnsubscribe?u=u&t=t' });
  ck('C1 transactional mail: mailto only, NO One-Click header', /^<mailto:/.test(hT['List-Unsubscribe']) && !hT['List-Unsubscribe-Post']);
  ck('C2 marketing mail: HTTPS URI first + One-Click (RFC 8058)', /^<https:\/\//.test(hM['List-Unsubscribe']) && hM['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');

  console.log('\nD. emailUnsubscribe');
  const tok = 'A'.repeat(32);
  await F.db.collection('emailPreferences').doc('uYes').set({ marketing: true, orders: true, unsubToken: tok }, { merge: true });
  const g = await UN.handle({ method: 'GET', query: { u: 'uYes', t: tok } });
  const afterGet = (await F.db.collection('emailPreferences').doc('uYes').get()).data();
  ck('D1 GET shows a confirmation and does NOT unsubscribe (link scanners)', g.status === 200 && /<form method="post"/.test(g.html) && afterGet.marketing === true);
  const bad = await UN.handle({ method: 'POST', query: { u: 'uYes', t: 'B'.repeat(32) } });
  const mal = await UN.handle({ method: 'POST', query: { u: 'uYes', t: '<script>' } });
  ck('D2 wrong or malformed token → 400, nothing changed', bad.status === 400 && mal.status === 400 && (await F.db.collection('emailPreferences').doc('uYes').get()).data().marketing === true);
  const p = await UN.handle({ method: 'POST', query: { u: 'uYes', t: tok } });
  const after = (await F.db.collection('emailPreferences').doc('uYes').get()).data();
  const np = (await F.db.collection('notifyPrefs').doc('uYes').get()).data() || {};
  ck('D3 one-click POST → marketing + newsletter off, service categories untouched', p.status === 200 && after.marketing === false && after.newsletter === false && after.orders === true, after);
  ck('D4 promotional notifications off on every channel (notifyPrefs.promotions)', np.promotions && np.promotions.email === false && np.promotions.sms === false && np.promotions.push === false, np);
  const r3 = await ES.send({ to: 'y@example.com', subject: 'Deals', html: '<p>Hi</p>', category: 'promotions', uid: 'uYes' });
  ck('D5 the next marketing mail after unsubscribing is skipped', r3 && r3.skipped === true, r3);
  await ES.updatePreferences('uYes', { marketing: true });
  ck('D6 re-subscribing (preference set true again) allows marketing again', await ES._checkPreferences('uYes', 'marketing') === true);

  console.log('\nE. SMS lockdown');
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  const sms = idx.slice(idx.indexOf('exports.posSendSMS = onCall('), idx.indexOf('exports.onDeliveryStatusChange'));
  ck('E1 posSendSMS refuses non-admins before reading the payload, and enforces App Check', /enforceAppCheck: true/.test(sms) && sms.indexOf('permission-denied') < sms.indexOf('const { to, message, bulk }') && /_cl\.admin === true/.test(sms));
  ck('E2 emailUnsubscribe exported by name', /exports\.emailUnsubscribe = require\('\.\/email-unsubscribe'\)\.emailUnsubscribe;/.test(idx));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
