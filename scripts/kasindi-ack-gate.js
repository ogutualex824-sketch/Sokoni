#!/usr/bin/env node
/* kasindi-ack-gate.js — ONE-TIME, READ-ONLY acknowledgement gate for Kasindi (owner-gated; never polls).
 *
 * Run ONLY after the owner confirms the business has acknowledged through /agreement-acknowledge:
 *   node scripts/kasindi-ack-gate.js --snapshot <path-to-kasindi-repair-census.json> --run
 *
 * Reads applications/PRVMS7IACKG, providers/users/sellers/businesses/shops/wallets for the uid and the wallet
 * transactions, ONCE, and compares them with the pre-repair census snapshot (digest c0b194f2…). Writes nothing.
 *
 * ASSERTIONS (every one must pass before a named-admin approval manifest may be prepared)
 *   A1 same application: id PRVMS7IACKG, uid unchanged, type/category/hub unchanged
 *   A2 exactly the acknowledgement fields changed on the application:
 *      agreementAccepted, agreementVersion, agreementAcceptedAt, agreementAcknowledgedSurface (+ nothing else)
 *   A3 agreementAcceptedAt is AFTER the surface went live (2026-09-29T21:09:56Z) and not in the future
 *   A4 agreementAccepted === true, agreementVersion === the surface's version, surface marker === 'agreement-acknowledge'
 *   A5 decidedBy is exactly "reindex"; decidedAt unchanged
 *   A6 no unrelated application field changed (full-record digest with the four fields stripped == census digest)
 *   A7 priorDecisions is still ABSENT (no decision has been made yet; it appears only when applicationDecide runs)
 *   A8 provider, users, sellers, businesses, shops, wallet and wallet transactions byte-identical to the snapshot
 */
'use strict';
const fs = require('fs'); const crypto = require('crypto');
const args = process.argv.slice(2); const arg = (k) => { const i = args.indexOf(k); return i === -1 ? null : args[i + 1]; };
if (!args.includes('--run')) { console.error('REFUSING: pass --run only after the owner confirms Kasindi acknowledged. This gate is one-shot and never polls.'); process.exit(64); }
const snapPath = arg('--snapshot'); if (!snapPath || !fs.existsSync(snapPath)) { console.error('--snapshot <kasindi-repair-census.json> required'); process.exit(64); }
const SNAP = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const REPO = 'C:/Users/USER1/OneDrive/Desktop/SOKONI'; const CAP = 'C:/temp/sok-cap';
const _r = require('module').createRequire(REPO + '/functions/package.json');
const admin = _r('firebase-admin'); const { getFirestore } = _r('firebase-admin/firestore');
const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'sokoni-aeb26' }); const db = getFirestore(app);
const VERSION = require(CAP + '/sokoni-merchant-application.js').AGREEMENT_VERSION;
const SURFACE_LIVE_AT = Date.parse('2026-09-29T21:09:56.877Z');
const ACK_FIELDS = ['agreementAccepted', 'agreementVersion', 'agreementAcceptedAt', 'agreementAcknowledgedSurface'];
const UID = SNAP.uid, APP = SNAP.applicationId;
const norm = (v) => (v == null ? null : JSON.parse(JSON.stringify(v, (k, x) => (x && x._seconds !== undefined ? new Date(x._seconds * 1000).toISOString() : (x && x.toDate ? x.toDate().toISOString() : x)))));
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const strip = (a) => { if (!a) return a; const c = Object.assign({}, a); ACK_FIELDS.forEach((k) => delete c[k]); return c; };
let pass = 0, fail = 0; const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
(async () => {
  const docOf = async (p) => { const s = await db.doc(p).get(); return s.exists ? norm(s.data()) : null; };
  const [application, provider, user, seller, business, shop, wallet, decisionRecord] = await Promise.all([docOf('applications/' + APP), docOf('providers/' + UID), docOf('users/' + UID), docOf('sellers/' + UID), docOf('businesses/' + UID), docOf('shops/' + UID), docOf('wallets/' + UID), docOf('applicationDecisions/' + APP)]);
  const walletTx = (await db.collection('walletTransactions').where('uid', '==', UID).limit(50).get()).docs.map((d) => Object.assign({ __id: d.id }, norm(d.data())));
  let claims = null; try { claims = (await admin.auth().getUser(UID)).customClaims || {}; } catch (e) { claims = { error: e.message }; }
  const at = new Date().toISOString();
  console.log('Kasindi acknowledgement gate — read at ' + at + ' (read-only, one shot)\n');
  const before = SNAP.application;
  ck('A1 same application: exists, uid matches, type/category/hub unchanged', !!application && application.uid === UID && application.type === before.type && application.category === before.category && application.hub === before.hub);
  const changed = application ? Object.keys(Object.assign({}, before, application)).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(application[k])) : [];
  ck('A2 exactly the acknowledgement fields changed', changed.length > 0 && changed.every((k) => ACK_FIELDS.includes(k)) && ACK_FIELDS.every((k) => changed.includes(k) || before[k] !== undefined), changed);
  const acceptedAt = application && application.agreementAcceptedAt ? Date.parse(application.agreementAcceptedAt) : NaN;
  ck('A3 agreementAcceptedAt is after the surface went live and not in the future', !isNaN(acceptedAt) && acceptedAt > SURFACE_LIVE_AT && acceptedAt <= Date.now() + 60000, application && application.agreementAcceptedAt);
  ck('A4 agreementAccepted true, version == surface version, surface marker set', !!application && application.agreementAccepted === true && application.agreementVersion === VERSION && application.agreementAcknowledgedSurface === 'agreement-acknowledge', application && { v: application.agreementVersion, s: application.agreementAcknowledgedSurface });
  ck('A5 decidedBy is exactly "reindex"; decidedAt unchanged', !!application && application.decidedBy === 'reindex' && JSON.stringify(application.decidedAt) === JSON.stringify(before.decidedAt), application && { by: application.decidedBy, at: application.decidedAt });
  ck('A6 nothing else changed: stripped-application digest equals the census digest', sha({ application: strip(application), decisionRecord, provider, user, seller, business, shop, claims, walletTx }) === SNAP.digest, SNAP.digest.slice(0, 16));
  ck('A7 priorDecisions still absent; no applicationDecisions record yet (no decision has been made)', !!application && application.priorDecisions === undefined && decisionRecord === null);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ck('A8 provider byte-identical', same(provider, SNAP.provider)); ck('A8 sellers / businesses / shops byte-identical', same(seller, SNAP.seller) && same(business, SNAP.business) && same(shop, SNAP.shop));
  ck('A8 wallet + wallet transactions byte-identical (KES 50 preserved)', same(wallet, SNAP.wallet) && same(walletTx, SNAP.walletTransactions));
  ck('A8 Auth claims unchanged', same(claims, SNAP.auth && SNAP.auth.claims));
  const out = { at, uid: UID, applicationId: APP, changedFields: changed, acknowledgement: application ? ACK_FIELDS.reduce((o, k) => (o[k] = application[k], o), {}) : null, decidedBy: application && application.decidedBy, postDigest: sha({ application, decisionRecord, provider, user, seller, business, shop, claims, walletTx }), pass, fail };
  fs.writeFileSync(require('path').dirname(snapPath) + '/kasindi-ack-gate.json', JSON.stringify(Object.assign({}, out, { application, provider, user, seller, business, shop, wallet, walletTx, claims }), null, 2));
  console.log('\n' + pass + ' passed, ' + fail + ' failed · post-acknowledgement digest ' + out.postDigest);
  console.log(fail ? 'GATE CLOSED — do not prepare the approval manifest.' : 'GATE OPEN — the named-admin approval manifest may be prepared (separate authorization).');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('GATE UNREADABLE', e.message); process.exit(2); });
