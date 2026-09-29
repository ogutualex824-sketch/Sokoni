/* test-business-documents.js — universal catalogue U6 (2026-09-29): each kind of business is asked for ITS documents,
 * every document carries an honest review state, only a SOKONI verification reviewer can verify one, and buyers only
 * ever see what was verified.
 *
 * REAL functions/shared/catalogue-capabilities.js, kasshop.saveShopProfile / getShopProfile,
 * business-category-admin (bizAdminShopCompliance / bizAdminReviewPermit) and minishop.getMinishopPublic, over the
 * fake Firestore.
 *
 * PROVES
 *   BD1 per-business documents: a lawyer is asked for the LSK practising certificate, a pharmacy for its PPB licence,
 *       a facility for KMPDC, a food business for its county food permit, a property agent for EARB; a lawyer is not
 *       asked for a PPB licence; every business keeps KRA / SBP / BRS
 *   BD2 the review state is DERIVED by the server: an uploaded document is awaiting review, a typed number alone is
 *       declared; a seller-sent "verified" review is ignored; replacing a verified document re-opens its review
 *   BD3 only a verification reviewer decides: an admin claim alone is refused; a document cannot be verified without an
 *       upload; a rejection needs a reason; a past expiry is refused; every decision is audited
 *   BD4 buyers see only VERIFIED documents (kind + title), served by the server — no number, no file path; an expired
 *       verification disappears; a seller-written `verifiedDocs` on their own shop is stripped
 *   BD5 the owner reads each document's state (getShopProfile); the Permits step renders per-business documents and
 *       honest badges, and never sends a review state
 *
 *   node scripts/test-business-documents.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-business-docs';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.parse('2026-09-29T09:00:00Z'); const realNow = Date.now; Date.now = () => NOW;
const F = makeFakeFirestore({ clock: () => NOW }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 280) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

(async () => {
  const CC = load(path.join(FN, 'shared', 'catalogue-capabilities.js'));
  const KS = load(path.join(FN, 'kasshop.js'));
  const BA = load(path.join(FN, 'business-category-admin.js'));
  const MS = load(path.join(FN, 'minishop.js'));
  const kinds = (c) => (CC.businessDocsFor ? CC.businessDocsFor(c).map((d) => d.kind) : []);
  const base = ['kra', 'sbp', 'brs'].every((k) => kinds('lawyer').includes(k) && kinds('hotel').includes(k));
  ck('BD1 each business is asked for ITS documents (LSK / PPB / KMPDC / food permit / EARB); a lawyer is not asked for PPB; all keep KRA/SBP/BRS',
    typeof CC.businessDocsFor === 'function' && kinds('lawyer').includes('lsk') && !kinds('lawyer').includes('ppb') && kinds('pharmacy').includes('ppb')
    && kinds('facility').includes('kmpdc') && kinds('restaurant').includes('food') && kinds('property').includes('earb') && !kinds('salon').includes('lsk') && base,
    { lawyer: kinds('lawyer'), pharmacy: kinds('pharmacy') });

  /* a pharmacy shop */
  const U = 'pharm1';
  await db.doc('shops/' + U).set({ sellerUid: U, ownerId: U, name: 'Afya Pharmacy', status: 'active', business: { category: 'pharmacy', source: 'admin' }, searchable: true, isPublic: true });
  await db.doc('shopHandles/afya').set({ shopId: U, uid: U });
  const save = (compliance) => KS.saveShopProfile({ auth: { uid: U }, data: { profile: { name: 'Afya Pharmacy' }, compliance } });
  await save({ ppbNumber: 'PPB/123', permits: { ppb: 'kyc-documents/pharm1/permit-ppb-1.pdf' }, kraPin: 'A012345678B',
    review: { ppb: { state: 'verified_on_file' } } /* a seller trying to self-verify */ });
  /* …and a save that sends ONLY a forged review (nothing else changed, so the server computes nothing to overwrite it) */
  await save({ kraPin: 'A012345678B', review: { kra: { state: 'verified_on_file' }, ppb: { state: 'verified_on_file' } } });
  let comp = await get('shops/' + U + '/private/compliance');
  const r1 = comp && comp.review || {};
  ck('BD2a an uploaded document awaits review; a number alone is declared; a seller-sent "verified" is ignored',
    r1.ppb && r1.ppb.state === 'pending_review' && r1.kra && r1.kra.state === 'declared', r1);

  /* BD3 — the reviewer */
  const admin = (uid, claims) => ({ auth: { uid, token: Object.assign({ admin: true }, claims || {}) }, data: {} });
  /* fail closed: a missing op is a refusal to record, never a crash */
const call = (fn, uid, claims, data) => (BA._adminH && typeof BA._adminH[fn] === 'function' ? Promise.resolve().then(() => BA._adminH[fn](Object.assign(admin(uid, claims), { data }))) : Promise.reject(new Error('NO_SUCH_OP ' + fn)));
  const REV = { capabilities: ['application_verification_reviewer'] };
  const plain = await codeOf(call('bizAdminReviewPermit', 'adm1', {}, { shopId: U, kind: 'ppb', decision: 'verified_on_file' }));
  const noDoc = await codeOf(call('bizAdminReviewPermit', 'rev1', REV, { shopId: U, kind: 'kra', decision: 'verified_on_file' }));
  const noNote = await codeOf(call('bizAdminReviewPermit', 'rev1', REV, { shopId: U, kind: 'ppb', decision: 'rejected' }));
  const past = await codeOf(call('bizAdminReviewPermit', 'rev1', REV, { shopId: U, kind: 'ppb', decision: 'verified_on_file', expiresAt: NOW - 1000 }));
  const okv = await call('bizAdminReviewPermit', 'rev1', REV, { shopId: U, kind: 'ppb', decision: 'verified_on_file', expiresAt: NOW + 86400000 * 30 }).catch((e) => ({ err: e.message }));
  comp = await get('shops/' + U + '/private/compliance');
  const audit = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).filter((a) => a.shopId === U);
  ck('BD3 only a verification reviewer decides; no verify without an upload; a rejection needs a reason; a past expiry is refused; audited',
    plain === 'NOT_A_REVIEWER' && noDoc === 'NO_DOCUMENT' && noNote === 'NOTE_REQUIRED' && past === 'BAD_EXPIRY' && okv && okv.ok
    && (((comp || {}).review || {}).ppb || {}).state === 'verified_on_file' && ((comp || {}).review || {}).ppb.reviewedBy === 'rev1' && audit.length === 1 && audit[0].action === 'business_doc_verified_on_file',
    { plain, noDoc, noNote, past, audit: audit.length });

  /* BD4 — the storefront */
  const res = () => { const r = { code: 0, body: null, headers: {} }; r.set = (k, v) => { r.headers[k] = v; return r; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.send = () => r; return r; };
  await db.doc('shops/' + U).set({ verifiedDocs: [{ kind: 'lsk', title: 'FORGED badge' }] }, { merge: true });   /* the seller writes their own shop */
  const pub = async () => { const r = res(); await MS.getMinishopPublic({ method: 'GET', query: { handle: 'afya' }, headers: {} }, r); return r.body || {}; };
  const b1 = await pub();
  const blob = JSON.stringify(b1);
  ck('BD4a buyers see only VERIFIED documents, from the server — no number, no path; a seller-written verifiedDocs is stripped',
    Array.isArray(b1.verifiedDocs) && b1.verifiedDocs.length === 1 && b1.verifiedDocs[0].kind === 'ppb' && !/PPB\/123|kyc-documents|FORGED|A012345678B/.test(blob)
    && !(b1.shop && b1.shop.verifiedDocs), { verifiedDocs: b1.verifiedDocs, shopHasForged: !!(b1.shop && b1.shop.verifiedDocs) });
  NOW += 86400000 * 31;
  const b2 = await pub();
  NOW -= 86400000 * 31;
  ck('BD4b an expired verification disappears from the storefront', Array.isArray(b2.verifiedDocs) && b2.verifiedDocs.length === 0, b2.verifiedDocs);

  /* BD2b — replacing a verified document re-opens its review */
  await save({ permits: { ppb: 'kyc-documents/pharm1/permit-ppb-2.pdf' } });
  comp = await get('shops/' + U + '/private/compliance');
  ck('BD2b replacing a verified document re-opens its review (and the storefront stops showing it)', (((comp || {}).review || {}).ppb || {}).state === 'pending_review'
    && (await pub()).verifiedDocs.length === 0, ((comp || {}).review || {}).ppb);

  /* BD5 — the owner's view and the Permits step */
  const g = await KS.getShopProfile({ auth: { uid: U }, data: {} }).catch(() => null);
  const sp = src('sokoni-merchant-shop-profile.js');
  ck('BD5 the owner reads each state; the Permits step is per business, badges are honest, and it never sends a review state',
    !!g && g.compliance && g.compliance.review && g.compliance.review.ppb && g.compliance.review.ppb.state === 'pending_review'
    && /var list = permitsFor\(S\.cat && S\.cat\.id\);/.test(sp) && /Verified by SOKONI/.test(sp) && /Declared — not yet reviewed/.test(sp)
    && /out\.compliance = \{ permits: Object\.assign\(\{\}, comp\.permits\) \};/.test(sp) && !/out\.compliance\.review/.test(sp)
    && !/✓ Document uploaded/.test(sp), g && g.compliance && g.compliance.review);

  Date.now = realNow;
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
