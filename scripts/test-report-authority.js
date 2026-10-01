#!/usr/bin/env node
/* test-report-authority.js — community C2 (2026-10-01): ONE report authority (functions/trust-safety.js).
 *
 *   node scripts/test-report-authority.js                    # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-report-authority.js     # the SERVING lineage (7091029 = live tsReportContent /
 *                                                            # tsGetReports / tsReviewReport, byte-identical) — the
 *                                                            # failures ARE the defects this slice closes
 *
 * REAL functions/trust-safety.js on the transactional fake Firestore (scripts/lib/fake-firestore-txn.js, strict read
 * order). No emulator, no network, no project.
 *
 * PROVES
 *   RR1 the reason list is the SERVER's (tsGetReportReasons): the asked-for reasons, 'other' needs detail; unknown type refused
 *   RW1 sign-in required; unknown type refused; a reason outside the server list refused (a label, a made-up code)
 *   RW2 'other' without detail is refused; detail is length-capped at the server's max
 *   RW3 a missing product is refused; a seller cannot report their own product
 *   RW4 a report lands on the deterministic id, with the server's label/severity and the SERVER-captured product context
 *   RW5 ONE report per user per listing — a second is refused (already-exists) even after a decision; 'listing' is the
 *       same entity as 'product'; another user can still report it; a legacy pending report also blocks
 *   RW6 a type with no catalogue (user — seller-public.html) keeps its free-text reason
 *   SS1 a seller reads reports on THEIR OWN products only; another seller sees none of them
 *   SS2 the reporter is never shown to the seller: no uid, no doc id, no free text, no evidence — anywhere in the payload
 *   SS3 signed-out scope:'mine' is refused; a non-admin without scope is refused (permission-denied)
 *   SS4 an outcome is shown to the seller only once decided; a REMOVED report is not shown
 *   AD1 NEGATIVE CONTROL: action 'action' (the AdminOS bug) is refused and changes nothing
 *   AD2 approve + hideProduct takes the product down (isVisible:false + moderationHold) and audits it, atomically
 *   AD3 the state machine: a decided report cannot be decided again; escalate → dismiss; request_changes → approve;
 *       archive from decided; remove; a seller cannot decide
 *   AD4 THE mapping covers every stored status; tsGetReports returns moderationState and filters by shared state
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF, BASE = '7091029';
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };
let tmp = null;
function load(rel) {
  if (!CPM) return require(path.join(FN, rel));
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'rptauth-'));
  const out = path.join(tmp, rel.replace(/\//g, '__'));
  fs.writeFileSync(out, cp.execFileSync('git', ['show', BASE + ':functions/' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  return require(out);
}
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data });
const ADMIN = { admin: true };

(async () => {
  say('\nSOURCE: ' + (CPM ? `@ ${BASE} (serving lineage) — failures below ARE the defects` : 'working tree (fix)'));
  const TS = load('trust-safety.js');
  const SA = 'sellerA', SB = 'sellerB', BUY = 'buyer1', BUY2 = 'buyer2';
  await db.doc('products/pA').set({ name: 'Kitenge Dress', sellerUid: SA, shopId: 'shopA', price: 2500, status: 'active', isVisible: true });
  await db.doc('products/pA2').set({ name: 'Leso', sellerUid: SA, price: 400, status: 'active' });
  await db.doc('products/pB').set({ name: 'Sufuria', sellerUid: SB, price: 900, status: 'active' });
  await db.doc('users/' + SB).set({ name: 'B' });

  say('\n── the reason list is the server\'s ──');
  const rr = await tryv(Promise.resolve().then(() => TS.tsGetReportReasons(as(null, { entityType: 'product' }))));
  const codes = rr && Array.isArray(rr.reasons) ? rr.reasons.map((r) => r.code) : [];
  const want = ['counterfeit', 'prohibited', 'misleading', 'scam', 'offensive', 'wrong_category', 'other'];
  const otherReq = rr && rr.reasons && (rr.reasons.find((r) => r.code === 'other') || {}).detailRequired === true;
  const rrBad = await codeOf(Promise.resolve().then(() => TS.tsGetReportReasons(as(null, { entityType: 'planet' }))));
  ck('RR1 tsGetReportReasons returns the asked-for catalogue; only "other" needs detail; unknown type refused',
    want.every((c) => codes.includes(c)) && codes.length === want.length && otherReq
      && rr.reasons.filter((r) => r.detailRequired).length === 1 && rr.detailMax === 500 && rrBad === 'invalid-argument', { codes, rrBad, detailMax: rr && rr.detailMax });

  say('\n── filing a report ──');
  const rep = (uid, data) => TS.tsReportContent(as(uid, Object.assign({ entityType: 'product', entityId: 'pA', reasonCode: 'counterfeit', detail: 'Logo is wrong' }, data || {})));
  const rw1 = [await codeOf(rep(null)), await codeOf(rep(BUY, { entityType: 'planet' })),
    await codeOf(rep(BUY, { reasonCode: 'Counterfeit or fake product' })), await codeOf(rep(BUY, { reasonCode: 'i_dislike_it' })),
    await codeOf(rep(BUY, { reasonCode: undefined, reason: 'Counterfeit or suspicious product' }))];
  ck('RW1 signed-out, unknown type, a label instead of a code, a made-up code, an off-list reason → all refused',
    rw1[0] === 'unauthenticated' && rw1.slice(1).every((c) => c === 'invalid-argument'), rw1);
  const rw2a = await codeOf(rep(BUY, { reasonCode: 'other', detail: '  bad ' }));
  ck('RW2a "other" without a real description is refused', rw2a === 'invalid-argument', rw2a);
  const rw3 = [await codeOf(rep(BUY, { entityId: 'noSuch' })), await codeOf(rep(SA))];
  ck('RW3 a missing product is refused; a seller cannot report their own product', rw3[0] === 'not-found' && rw3[1] === 'failed-precondition', rw3);
  const r1 = await tryv(rep(BUY, { detail: 'x'.repeat(900) + '\u0007' }));
  const id1 = 'buyer1_product_pA';
  const d1 = await get('reports/' + id1);
  ck('RW2b detail is capped at the server max (500) and control characters are stripped', !!d1 && d1.detail.length === 500 && !/\u0007/.test(d1.detail), d1 && d1.detail.length);
  ck('RW4 lands on the deterministic id with the server label/severity and server-captured context',
    r1 && r1.reportId === id1 && d1 && d1.reasonCode === 'counterfeit' && d1.reason === 'Counterfeit or fake product' && d1.severity === 'high'
      && d1.status === 'pending' && d1.reportedBy === BUY && d1.context && d1.context.sellerUid === SA && d1.context.shopId === 'shopA'
      && d1.context.productName === 'Kitenge Dress' && d1.context.price === 2500, { r1, d1: d1 && { reasonCode: d1.reasonCode, ctx: d1.context } });

  const again = await codeOf(rep(BUY, { reasonCode: 'scam' }));
  const alias = await codeOf(rep(BUY, { entityType: 'listing', reasonCode: 'scam' }));
  const other = await tryv(rep(BUY2, { reasonCode: 'other', detail: 'The seller asked me to pay on M-Pesa directly' }));
  await db.doc('reports/legacy1').set({ entityId: 'pB', entityType: 'product', reportedBy: BUY, status: 'pending', reason: 'x' });
  const legacy = await codeOf(rep(BUY, { entityId: 'pB' }));
  ck('RW5a one report per user per listing: a second (any reason), the "listing" alias, a legacy pending report → already-exists; another user can',
    again === 'already-exists' && alias === 'already-exists' && legacy === 'already-exists' && other && other.reportId === 'buyer2_product_pA', { again, alias, legacy, other });
  const userRep = await tryv(TS.tsReportContent(as(BUY, { entityType: 'user', entityId: SB, reason: 'Scam / fraud', detail: 'took money' })));
  const ud = await get('reports/buyer1_user_' + SB);
  ck('RW6 a type with no catalogue (user, seller-public.html) keeps its free-text reason', !!ud && ud.reason === 'Scam / fraud' && ud.severity === 'critical' && ud.context === null, { userRep, ud });

  say('\n── the seller\'s view (scope:\'mine\') ──');
  await db.doc('reports/legacy1').set({ entityId: 'pB', entityType: 'product', reportedBy: BUY, status: 'pending', reason: 'x', context: { sellerUid: SB, productName: 'Sufuria' } });
  const mineA = await tryv(TS.tsGetReports(as(SA, { scope: 'mine' })));
  const mineB = await tryv(TS.tsGetReports(as(SB, { scope: 'mine' })));
  const aIds = (mineA.reports || []).map((r) => r.entityId);
  ck('SS1 seller A sees the 2 reports on pA; seller B sees only its own (none of A\'s)',
    Array.isArray(mineA.reports) && mineA.reports.length === 2 && aIds.every((x) => x === 'pA')
      && Array.isArray(mineB.reports) && mineB.reports.length === 1 && mineB.reports[0].entityId === 'pB', { aIds, b: mineB.reports && mineB.reports.map((r) => r.entityId) });
  const blob = JSON.stringify(mineA);
  ck('SS2 the reporter is withheld: no reporter uid, no doc id, no free text, no evidence anywhere in the payload',
    !blob.includes(BUY) && !blob.includes(BUY2) && !blob.includes(id1) && !/reportedBy|"detail"|evidenceUrls/.test(blob) && !blob.includes('M-Pesa directly')
      && Array.isArray(mineA.reports) && mineA.reports.length > 0 && mineA.reports.every((r) => typeof r.ref === 'string' && r.ref.length === 16 && !('id' in r)), blob.slice(0, 300));
  const ss3 = [await codeOf(TS.tsGetReports(as(null, { scope: 'mine' }))), await codeOf(TS.tsGetReports(as(SA, {}))), await codeOf(TS.tsGetReports(as(BUY, { status: 'pending' })))];
  ck('SS3 signed-out scope:mine refused; a seller / buyer without admin cannot list the queue', ss3[0] === 'unauthenticated' && ss3[1] === 'permission-denied' && ss3[2] === 'permission-denied', ss3);

  say('\n── deciding (AdminOS / super admin) ──');
  const badAct = await codeOf(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'action' }, ADMIN)));
  ck('AD1 NEGATIVE CONTROL: action "action" (the old AdminOS button) is refused and the report is unchanged',
    badAct === 'invalid-argument' && (await get('reports/' + id1)).status === 'pending', badAct);
  const bySeller = await codeOf(TS.tsReviewReport(as(SA, { reportId: id1, action: 'dismiss' })));
  const done = await tryv(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed' }, ADMIN)));
  const p = await get('products/pA');
  const audits = (await db.collection('trustSafetyAudit').get()).docs.map((d) => d.data()).filter((a) => a.reportId === id1);
  const after = await get('reports/' + id1);
  ck('AD2 approve + hideProduct: product hidden with moderationHold, report upheld + productHidden, one audit with from/to',
    bySeller === 'permission-denied' && done && done.productHidden === true && done.moderationState === 'approved' && p.isVisible === false
      && p.moderationHold && p.moderationHold.reportId === id1 && after.status === 'actioned' && after.productHidden === true
      && audits.length === 1 && audits[0].from === 'pending' && audits[0].resultState === 'approved' && audits[0].productHidden === true,
    { bySeller, done, hold: p.moderationHold, audits: audits.length });

  const twice = await codeOf(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'dismiss' }, ADMIN)));
  const id2 = 'buyer2_product_pA';
  const esc = await tryv(TS.tsReviewReport(as('adm1', { reportId: id2, action: 'escalate' }, ADMIN)));
  const escAgain = await codeOf(TS.tsReviewReport(as('adm1', { reportId: id2, action: 'escalate' }, ADMIN)));
  const rej = await tryv(TS.tsReviewReport(as('adm1', { reportId: id2, action: 'reject', resolution: 'Payment was inside SOKONI' }, ADMIN)));
  const arch = await tryv(TS.tsReviewReport(as('adm1', { reportId: id2, action: 'archive' }, ADMIN)));
  const archAgain = await codeOf(TS.tsReviewReport(as('adm1', { reportId: id2, action: 'approve' }, ADMIN)));
  const uid2 = 'buyer1_user_' + SB;
  const chg = await tryv(TS.tsReviewReport(as('adm1', { reportId: uid2, action: 'request_changes', resolution: 'Update your profile' }, ADMIN)));
  const upd = await tryv(TS.tsReviewReport(as('adm1', { reportId: uid2, action: 'uphold' }, ADMIN)));
  const rm = await tryv(TS.tsReviewReport(as('adm1', { reportId: 'legacy1', action: 'remove', resolution: 'bad-faith report' }, ADMIN)));
  ck('AD3 state machine: decided twice → failed-precondition; escalate once → reject → archive (then frozen); request_changes → uphold; remove',
    twice === 'failed-precondition' && (esc || {}).moderationState === 'pending' && escAgain === 'failed-precondition' && (rej || {}).moderationState === 'rejected'
      && (arch || {}).moderationState === 'archived' && archAgain === 'failed-precondition' && (chg || {}).moderationState === 'changes_requested'
      && (upd || {}).moderationState === 'approved' && (rm || {}).moderationState === 'removed',
    { twice, esc, escAgain, rej, arch, archAgain, chg, upd, rm });

  const mineA2 = await tryv(TS.tsGetReports(as(SA, { scope: 'mine' })));
  const mineB2 = await tryv(TS.tsGetReports(as(SB, { scope: 'mine' })));
  const up = (mineA2.reports || []).find((r) => r.moderationState === 'approved');
  const ar = (mineA2.reports || []).find((r) => r.moderationState === 'archived');
  ck('SS4 the seller sees the outcome once decided (and the take-down); a REMOVED report is not shown',
    up && up.outcome === 'Counterfeit confirmed' && up.productHidden === true && ar && mineB2.reports && mineB2.reports.length === 0, { a: mineA2.reports, b: mineB2.reports });

  const M = TS._reportModel || {};
  const stored = ['pending', 'escalated', 'actioned', 'dismissed', 'changes_requested', 'archived', 'removed'];
  const shared = ['pending', 'approved', 'rejected', 'changes_requested', 'archived', 'removed'];
  const mapOk = M.REPORT_STATE && stored.every((s) => shared.includes(M.REPORT_STATE[s])) && shared.every((s) => Object.values(M.REPORT_STATE).includes(s))
    && Object.values(M.REPORT_ACTIONS).every((s) => s in M.REPORT_STATE && s in M.REPORT_TRANSITIONS);
  const lst = await tryv(TS.tsGetReports(as('adm1', { state: 'approved' }, ADMIN)));
  const lstAll = await tryv(TS.tsGetReports(as('adm1', {}, ADMIN)));
  ck('AD4 ONE mapping covers every stored status and every shared state; the admin list carries moderationState and filters by it',
    mapOk && lst.reports && lst.reports.length === 2 && lst.reports.every((r) => r.moderationState === 'approved')
      && Array.isArray(lstAll.reports) && lstAll.reports.every((r) => typeof r.moderationState === 'string'), { mapOk, n: lst.reports && lst.reports.length });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
