#!/usr/bin/env node
/* test-review-reports.js — REVIEW and UNBOXING as REPORT targets on the ONE report authority (2026-10-03)
 *
 *   node scripts/test-review-reports.js                       # working tree — must PASS
 *   SABOTAGE=<name> node scripts/test-review-reports.js       # one fault injected into a TEMP COPY (never the tree)
 *   node scripts/test-review-reports.js --failure-injection   # every fault, one at a time: each must fail its NAMED row;
 *                                                             # the tree's files are hashed before and after
 *
 * The REAL functions/trust-safety.js and the review owner's shared module functions/shared/review-moderation.js
 * (sokoni-5b, commit 85a5fcf — byte-identical, pinned by row M0) run on the transactional fake Firestore
 * (scripts/lib/fake-firestore-txn.js, STRICT read order: a read after a write throws, as the Admin SDK does).
 *
 * NO PRODUCTION, NO NETWORK, NO EMULATOR. TRIPWIRES (incident 2026-10-01: a test wrote to production through
 * application-default credentials): every require of `firebase-admin` (and its app/auth/messaging submodules) THROWS,
 * `./notify` THROWS on require, notifications go to an in-memory seam. Row Z1 asserts they held: neither module is in
 * require.cache, and a positive control proves the tripwire actually fires.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const MODULE_REL = 'shared/review-moderation.js';
const MODULE_SHA_PREFIX = 'c3ea059ef602ad4e';   /* sokoni-5b's module at 85a5fcf — NEVER edit the copy; re-copy it */
const FILES = ['trust-safety.js', MODULE_REL];

/* ── failure injection: each fault, the exact text it replaces, and the NAMED row that must catch it ── */
const SABOTAGES = {
  'skip-module-call':        { file: 'trust-safety.js', catch: 'U1',
    from: 'reviewResult = await (reviewRestore ? RM.restoreReview(tx, o) : RM.removeReview(tx, o));',
    to: "reviewResult = { status: reviewRestore ? 'pending' : 'removed', unchanged: false, targetId: null, from: 'approved', kind: o.kind };" },
  'recompute-for-unboxing':  { file: 'trust-safety.js', catch: 'U3',
    from: "if (out.reviewKind === 'review' && !out.reviewResult.unchanged", to: 'if (!out.reviewResult.unchanged' },
  'accept-client-status':    { file: 'trust-safety.js', catch: 'C1',
    from: 'const newStatus = (isAssign || isRestore) ? null : REPORT_ACTIONS[action];',
    to: 'const newStatus = (isAssign || isRestore) ? null : (data.status || REPORT_ACTIONS[action]);' },
  'leak-reporter-to-seller': { file: 'trust-safety.js', catch: 'S1',
    from: "entityType: r.entityType, subject: 'review_on_your_listing',",
    to: "entityType: r.entityType, subject: 'review_on_your_listing', reportedBy: r.reportedBy || null," },
  'allow-self-report':       { file: 'trust-safety.js', catch: 'R4',
    from: "if (authorUid && authorUid === uid) throw new HttpsError('failed-precondition', 'You cannot report your own review.');", to: '' },
  'trust-client-context':    { file: 'trust-safety.js', catch: 'R2',
    from: '    context = await _reviewReportContext(db, entityType, entityId, uid);',
    to: '    context = Object.assign(await _reviewReportContext(db, entityType, entityId, uid), d.context || {});' },
  'restore-to-approved':     { file: 'trust-safety.js', catch: 'U5',
    from: 'reviewResult = await (reviewRestore ? RM.restoreReview(tx, o) : RM.removeReview(tx, o));',
    to: "reviewResult = await (reviewRestore ? RM.transitionReview(tx, Object.assign({}, o, { action: 'approve' })) : RM.removeReview(tx, o));" },
};

if (process.argv.includes('--failure-injection')) {
  const hash = () => FILES.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(FN, f))).digest('hex')).join(',');
  const before = hash(); let ok = true;
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: name }), encoding: 'utf8', maxBuffer: 64e6 });
    const out = (r.stdout || '') + (r.stderr || '');
    const applied = !/SABOTAGE NOT APPLIED/.test(out);
    const caught = new RegExp('^  FAIL  ' + s.catch + ' ', 'm').test(out);
    const pass = applied && caught && r.status === 1;
    if (!pass) ok = false;
    console.log(`  ${pass ? 'CAUGHT ' : 'MISSED '} ${name.padEnd(26)} → ${s.catch}${applied ? '' : '  (sabotage did not apply — harness fails closed)'}${caught ? '' : '  (named row did not fail)'}  exit=${r.status}`);
  }
  const after = hash();
  console.log(`  tree unchanged after injection: ${before === after ? 'YES' : 'NO'}`);
  console.log(ok && before === after ? '\nFAILURE INJECTION: all caught, all restored' : '\nFAILURE INJECTION: FAILED');
  process.exit(ok && before === after ? 0 : 1);
}

/* ── the copy under test (sabotage applied to ONE file of a temp copy, never the tree) ── */
const SAB = process.env.SABOTAGE || null;
const say = console.log; console.log = console.info = console.warn = console.debug = console.error = () => {};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'revrpt-'));
fs.mkdirSync(path.join(TMP, 'shared'));
for (const f of FILES) {
  let text = fs.readFileSync(path.join(FN, f), 'utf8');
  if (SAB) {
    const s = SABOTAGES[SAB];
    if (!s) { say('UNKNOWN SABOTAGE ' + SAB); process.exit(2); }
    if (s.file === f) {
      const t2 = text.replace(/\r\n/g, '\n');
      if (t2.split(s.from).length !== 2) { say('SABOTAGE NOT APPLIED: ' + SAB); process.exit(3); }
      text = t2.replace(s.from, () => s.to);
      say(`\nSABOTAGE ${SAB} applied to a temp copy of ${f}`);
    }
  }
  fs.writeFileSync(path.join(TMP, f), text);
}

let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 500) : '')); } };

/* ── tripwires + the fake world ── */
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET; delete process.env.FUNCTIONS_EMULATOR;
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin' || /^firebase-admin\/(app|auth|messaging|storage)$/.test(id)) throw new Error('TRIPWIRE: real firebase-admin (' + id + ') required from a test');
  if (id === './notify' || /[\\/]notify(\.js)?$/.test(id)) throw new Error('TRIPWIRE: notify.js required from a test');
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};

const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message, message: e.message, details: e.details }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ _id: d.id }, d.data()));
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data });
const ADMIN = { admin: true };
const logsFor = async (reviewId) => (await all('reviewModerationLog')).filter((x) => x.reviewId === reviewId);

(async () => {
  say('\nSOURCE: working tree' + (SAB ? ' + SABOTAGE ' + SAB : '') + ' — ' + FN);

  /* M0 — the module is the review owner's, byte for byte */
  const modBytes = fs.readFileSync(path.join(FN, MODULE_REL));
  const modSha = crypto.createHash('sha256').update(modBytes).digest('hex');
  const modText = modBytes.toString('utf8');
  ck('M0 functions/shared/review-moderation.js is byte-identical to sokoni-5b 85a5fcf (sha256 starts ' + MODULE_SHA_PREFIX + '), no require/import',
    modSha.startsWith(MODULE_SHA_PREFIX) && !/\brequire\s*\(|^\s*import\s/m.test(modText), modSha);

  const TS = require(path.join(TMP, 'trust-safety.js'));
  if (typeof TS._setNotifier !== 'function' || !TS._reportModel || !TS._reportModel.REVIEW_REPORT_REASONS) {
    say('BLOCKED — this trust-safety.js has no review report targets'); process.exit(2);
  }
  const sent = [];
  TS._setNotifier(async (o) => { sent.push(o); return { ok: true, key: o.dedupeKey, channels: { inapp: 'sent' } }; });

  /* the world: one product (seller sellerA), reviews of it, an unboxing of it, a seller review */
  await db.doc('products/p1').set({ name: 'Kitenge Dress', sellerUid: 'sellerA', shopId: 'shopA', price: 1500, isVisible: true, status: 'active' });
  await db.doc('reviews/rv1').set({ authorUid: 'authorB', targetType: 'product', targetId: 'p1', status: 'approved', rating: 5,
    title: 'Ok', body: 'Absolutely perfect dress <b>buy now</b> ' + 'x'.repeat(400) });
  await db.doc('reviews/rv2').set({ authorUid: 'authorC', targetType: 'product', targetId: 'p1', status: 'approved', rating: 2, body: 'Seams came apart after one wash.' });
  await db.doc('reviews/rvAdm').set({ authorUid: 'admAuthor', targetType: 'product', targetId: 'p1', status: 'approved', rating: 4, body: 'Written by a moderator account.' });
  await db.doc('reviews/rvSel').set({ authorUid: 'authorE', targetType: 'product', targetId: 'p1', status: 'approved', rating: 1, body: 'Reviewed listing belongs to sellerA.' });
  await db.doc('unboxingReviews/ub1').set({ uid: 'authorD', productId: 'p1', sellerUid: 'sellerA', status: 'approved', caption: 'Unboxing my new dress!' });
  await db.doc('ratingsSummary/p1').set({ targetId: 'p1', avg: 3, count: 4, marker: 'before' });

  /* R1 — the reason list is the SERVER's, for both kinds */
  const rr = await tryv(TS.tsGetReportReasons(as('r1', { entityType: 'review' })));
  const ru = await tryv(TS.tsGetReportReasons(as('r1', { entityType: 'unboxing' })));
  const codes = (x) => (x.reasons || []).map((r) => r.code).join(',');
  const want = 'fake_review,spam,offensive,off_topic,personal_info,conflict_of_interest,other';
  ck('R1 tsGetReportReasons: review and unboxing get the server review catalogue (no free text); "other" needs details',
    codes(rr) === want && codes(ru) === want && rr.freeText === false && (rr.reasons.find((r) => r.code === 'other') || {}).detailRequired === true, { rr, ru });

  /* R2 — report a review: context is SERVER-built, the client's context is ignored */
  const rep1 = await tryv(TS.tsReportContent(as('reporter1', { entityType: 'review', entityId: 'rv1', reasonCode: 'fake_review', detail: 'Paid',
    context: { authorUid: 'forged', excerpt: 'FORGED', listingSellerUid: 'forged-seller', status: 'approved' }, status: 'actioned' })));
  const id1 = 'reporter1_review_rv1';
  const d1 = await get('reports/' + id1);
  const c1 = (d1 && d1.context) || {};
  ck('R2 report a REVIEW: one report {uid}_review_{id}, pending; context server-built (author, listing seller, excerpt ≤280 tag-free, target) — client context/status ignored',
    rep1.ok === true && rep1.reportId === id1 && d1 && d1.status === 'pending' && d1.reasonCode === 'fake_review' && d1.severity === 'high'
      && c1.reviewKind === 'review' && c1.authorUid === 'authorB' && c1.listingSellerUid === 'sellerA' && c1.targetId === 'p1' && c1.targetType === 'product'
      && c1.excerpt.length <= 280 && !/<b>/.test(c1.excerpt) && /^Absolutely perfect dress buy now/.test(c1.excerpt) && !c1.sellerUid
      && !JSON.stringify(d1).includes('forged') && !JSON.stringify(d1).includes('FORGED'), { rep1, d1 });

  /* R3 — report an unboxing review */
  const repU = await tryv(TS.tsReportContent(as('reporter1', { entityType: 'unboxing', entityId: 'ub1', reasonCode: 'spam' })));
  const dU = await get('reports/reporter1_unboxing_ub1');
  ck('R3 report an UNBOXING review: context kind unboxing, author authorD, listing seller from the PRODUCT document',
    repU.ok === true && dU && dU.context.reviewKind === 'unboxing' && dU.context.authorUid === 'authorD' && dU.context.listingSellerUid === 'sellerA'
      && dU.context.excerpt === 'Unboxing my new dress!', { repU, dU });

  /* R4 — the writer cannot report their own review */
  const self = await tryv(TS.tsReportContent(as('authorB', { entityType: 'review', entityId: 'rv1', reasonCode: 'spam' })));
  ck('R4 self-report refused: the review\'s author cannot report it (failed-precondition), nothing written',
    self.error === 'failed-precondition' && !(await get('reports/authorB_review_rv1')), self);

  /* R5 — one report per user per target */
  const dup = await tryv(TS.tsReportContent(as('reporter1', { entityType: 'review', entityId: 'rv1', reasonCode: 'spam' })));
  ck('R5 duplicate refused: the same reporter on the same review → already-exists; the first report is untouched',
    dup.error === 'already-exists' && (await get('reports/' + id1)).reasonCode === 'fake_review', dup);

  /* R6 — reasons from the server list only; missing review → not-found */
  const badCode = await tryv(TS.tsReportContent(as('reporter2', { entityType: 'review', entityId: 'rv2', reasonCode: 'counterfeit' })));
  const freeTxt = await tryv(TS.tsReportContent(as('reporter2', { entityType: 'review', entityId: 'rv2', reason: 'I just do not like it' })));
  const shortOther = await tryv(TS.tsReportContent(as('reporter2', { entityType: 'review', entityId: 'rv2', reasonCode: 'other', detail: 'short' })));
  const missing = await tryv(TS.tsReportContent(as('reporter2', { entityType: 'review', entityId: 'nope', reasonCode: 'spam' })));
  ck('R6 a reason outside the server list (a product code, free text) is refused; "other" needs ≥10 chars; a missing review → not-found',
    badCode.error === 'invalid-argument' && freeTxt.error === 'invalid-argument' && shortOther.error === 'invalid-argument' && missing.error === 'not-found'
      && !(await get('reports/reporter2_review_rv2')), { badCode, freeTxt, shortOther, missing });

  /* a second reporter on rv1 (for the idempotent re-uphold), and reports for the refusal rows */
  await TS.tsReportContent(as('reporter2', { entityType: 'review', entityId: 'rv1', reasonCode: 'spam' }));
  await TS.tsReportContent(as('reporter3', { entityType: 'review', entityId: 'rvAdm', reasonCode: 'offensive' }));
  await TS.tsReportContent(as('reporter3', { entityType: 'review', entityId: 'rvSel', reasonCode: 'offensive' }));
  await TS.tsReportContent(as('reporter3', { entityType: 'review', entityId: 'rv2', reasonCode: 'off_topic' }));

  /* V1 — the case: excerpt, target link, the server's actions (uphold — no listing take-down) */
  const case1 = await tryv(TS.tsGetReportCase(as('adm1', { reportId: id1 }, ADMIN)));
  ck('V1 tsGetReportCase on a review report: the review (excerpt, status, target link product.html?id=p1), actions from the server (approve, no takedown, no restore)',
    case1.review && case1.review.exists && case1.review.status === 'approved' && case1.review.targetHref === 'product.html?id=p1' && /^Absolutely/.test(case1.review.excerpt)
      && case1.target.enforcement === 'review_removal' && case1.actions.includes('approve') && !case1.actions.includes('takedown') && !case1.actions.includes('restore'), case1);

  /* U1 — UPHOLD removes the review through the module, in the same transaction; exactly ONE reviewModerationLog */
  const up1 = await tryv(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'approve', resolution: 'Fake review removed', internalNote: 'clear paid review', requestId: 'req_up1_aaaa' }, ADMIN)));
  const rv1 = await get('reviews/rv1');
  const L1 = await logsFor('rv1');
  const r1 = await get('reports/' + id1);
  ck('U1 uphold → review REMOVED via the shared module (moderatedBy = moderator, fixed note), exactly ONE reviewModerationLog {action remove, source report:<id>}; report actioned, reviewEnforcement review_removed',
    up1.success === true && up1.status === 'actioned' && rv1.status === 'removed' && rv1.moderatedBy === 'adm1' && rv1.moderationNote === 'Removed after a report about it was upheld.'
      && L1.length === 1 && L1[0].action === 'remove' && L1[0].from === 'approved' && L1[0].to === 'removed' && L1[0].source === 'report:' + id1 && L1[0].actorUid === 'adm1'
      && L1[0].kind === 'review' && L1[0].targetId === 'p1'
      && r1.status === 'actioned' && r1.reviewEnforcement === 'review_removed' && up1.enforcement === 'review_removed', { up1, rv1, L1, r1 });
  const aud1 = (await all('trustSafetyAudit')).filter((a) => a.reportId === id1);
  ck('U1b one audit row for the decision, enforcement review_removed, the review transition recorded; the review doc carries no reporter identity',
    aud1.length === 1 && aud1[0].enforcement === 'review_removed' && aud1[0].review && aud1[0].review.to === 'removed'
      && !JSON.stringify(rv1).includes('reporter1') && !JSON.stringify(rv1).includes(id1), { aud1, rv1 });

  /* U2 — ratingsSummary recomputed for a REVIEW, from approved reviews only */
  const rs1 = await get('ratingsSummary/p1');
  ck('U2 ratingsSummary/p1 recomputed after commit from the APPROVED reviews only (2,4,1 → 2.3, count 3)',
    up1.ratingsSummary && up1.ratingsSummary.status === 'recomputed' && rs1.avg === 2.3 && rs1.count === 3, { rs: up1.ratingsSummary, rs1 });

  /* U3 — UNBOXING: removed via the module, ratingsSummary NOT touched */
  await db.doc('ratingsSummary/p1').set({ marker: 'after-review' }, { merge: true });
  const rsBefore = JSON.stringify(await get('ratingsSummary/p1'));
  const upU = await tryv(TS.tsReviewReport(as('adm1', { reportId: 'reporter1_unboxing_ub1', action: 'approve', resolution: 'spam' }, ADMIN)));
  const ub1 = await get('unboxingReviews/ub1');
  const LU = await logsFor('ub1');
  ck('U3 uphold an UNBOXING report → unboxingReviews/ub1 removed, ONE log {kind unboxing}; ratingsSummary is NOT recomputed (unchanged, response null)',
    upU.success === true && ub1.status === 'removed' && LU.length === 1 && LU[0].kind === 'unboxing' && LU[0].action === 'remove'
      && upU.ratingsSummary === null && JSON.stringify(await get('ratingsSummary/p1')) === rsBefore, { upU, ub1, LU });

  /* U4 — idempotent: a second report on the same (already removed) review upheld → no second log; a replayed request → nothing */
  const up2 = await tryv(TS.tsReviewReport(as('adm1', { reportId: 'reporter2_review_rv1', action: 'approve' }, ADMIN)));
  const replay = await tryv(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'approve', requestId: 'req_up1_aaaa' }, ADMIN)));
  const again = await tryv(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'approve' }, ADMIN)));
  ck('U4 repeated uphold = ONE log: a 2nd report on the removed review is upheld as already_removed (module unchanged:true), a replay is replayed, a re-decision is refused',
    up2.success === true && up2.enforcement === 'already_removed' && up2.review && up2.review.unchanged === true && up2.ratingsSummary === null
      && replay.replayed === true && again.error === 'failed-precondition' && (await logsFor('rv1')).length === 1, { up2, replay, again });

  /* U5 — RESTORE of the upheld report → review back to PENDING (never approved); one restore log; a second restore refused */
  const case2 = await tryv(TS.tsGetReportCase(as('adm1', { reportId: id1 }, ADMIN)));
  const noNote = await tryv(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'restore' }, ADMIN)));
  const rst = await tryv(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'restore', internalNote: 'Reporter was a competitor' }, ADMIN)));
  const rv1b = await get('reviews/rv1');
  const L1b = await logsFor('rv1');
  const r1b = await get('reports/' + id1);
  const rst2 = await tryv(TS.tsReviewReport(as('adm1', { reportId: id1, action: 'restore', internalNote: 'Reporter was a competitor' }, ADMIN)));
  const rstOther = await tryv(TS.tsReviewReport(as('adm1', { reportId: 'reporter2_review_rv1', action: 'restore', internalNote: 'not this report' }, ADMIN)));
  ck('U5 restore → review PENDING (re-review, never approved), one restore log; report stays upheld (review_restored); restore needs a note; a 2nd restore and a restore from a report that did not remove it are refused',
    case2.actions && case2.actions.includes('restore') && noNote.error === 'invalid-argument'
      && rst.success === true && rst.enforcement === 'review_restored' && rv1b.status === 'pending'
      && L1b.length === 2 && L1b.filter((l) => l.action === 'restore' && l.to === 'pending' && l.source === 'report:' + id1).length === 1
      && r1b.status === 'actioned' && r1b.reviewEnforcement === 'review_restored'
      && rst2.error === 'failed-precondition' && rstOther.error === 'failed-precondition' && (await logsFor('rv1')).length === 2, { case2: case2.actions, noNote, rst, rv1b, L1b, rst2, rstOther });

  /* E1 — SELF_REVIEW: the moderator wrote the review → refused as the module words it; nothing moves */
  const selfRev = await tryv(TS.tsReviewReport(as('admAuthor', { reportId: 'reporter3_review_rvAdm', action: 'approve' }, ADMIN)));
  ck('E1 SELF_REVIEW mapped: HttpsError(permission-denied, module message, {reason:SELF_REVIEW}); report still pending, review still approved, no log, no audit',
    selfRev.error === 'permission-denied' && selfRev.details && selfRev.details.reason === 'SELF_REVIEW' && /your own review/.test(selfRev.message)
      && (await get('reports/reporter3_review_rvAdm')).status === 'pending' && (await get('reviews/rvAdm')).status === 'approved'
      && (await logsFor('rvAdm')).length === 0 && (await all('trustSafetyAudit')).filter((a) => a.reportId === 'reporter3_review_rvAdm').length === 0, selfRev);

  /* E2 — SELF_INTEREST: the moderator sells the reviewed listing */
  const selfInt = await tryv(TS.tsReviewReport(as('sellerA', { reportId: 'reporter3_review_rvSel', action: 'approve' }, ADMIN)));
  ck('E2 SELF_INTEREST mapped: the listing\'s seller cannot uphold a report on its review ({reason:SELF_INTEREST}); nothing written',
    selfInt.error === 'permission-denied' && selfInt.details && selfInt.details.reason === 'SELF_INTEREST'
      && (await get('reports/reporter3_review_rvSel')).status === 'pending' && (await get('reviews/rvSel')).status === 'approved' && (await logsFor('rvSel')).length === 0, selfInt);

  /* D1 — DISMISS touches no review */
  const dis = await tryv(TS.tsReviewReport(as('adm1', { reportId: 'reporter3_review_rv2', action: 'dismiss', resolution: 'On topic' }, ADMIN)));
  ck('D1 dismiss → report dismissed; the review is untouched (still approved), no reviewModerationLog',
    dis.success === true && dis.status === 'dismissed' && (await get('reviews/rv2')).status === 'approved' && (await logsFor('rv2')).length === 0 && !dis.review, dis);

  /* C1 — a client-supplied status / hidden flag is never trusted */
  await TS.tsReportContent(as('reporter4', { entityType: 'review', entityId: 'rv2', reasonCode: 'spam' }));
  const cl = await tryv(TS.tsReviewReport(as('adm1', { reportId: 'reporter4_review_rv2', action: 'approve', status: 'dismissed', reviewStatus: 'approved', hideProduct: true, enforcement: 'none' }, ADMIN)));
  ck('C1 the decision is the ACTION: a client "status:dismissed" is ignored — the report is upheld and the review removed; hideProduct does nothing to the listing',
    cl.success === true && cl.status === 'actioned' && (await get('reports/reporter4_review_rv2')).status === 'actioned' && (await get('reviews/rv2')).status === 'removed'
      && (await get('products/p1')).isVisible === true && !(await get('products/p1')).moderationHold, cl);

  /* S1 — the listing's seller: status vocabulary only; never the reporter */
  const mine = await tryv(TS.tsGetReports(as('sellerA', { scope: 'mine' })));
  const revRows = (mine.reports || []).filter((x) => x.entityType === 'review' || x.entityType === 'unboxing');
  const allowedKeys = ['ref', 'entityType', 'subject', 'listingType', 'listingId', 'moderationState', 'sellerStatus', 'createdAt', 'decidedAt', 'sellerResponse'];
  const blob = JSON.stringify(mine);
  ck('S1 seller payload: review reports on THEIR listing show status vocabulary only — no reporter, report id, reason, excerpt, review id, author or notes',
    revRows.length >= 4 && revRows.every((x) => Object.keys(x).every((k) => allowedKeys.includes(k)) && x.subject === 'review_on_your_listing' && x.listingId === 'p1')
      && !/reporter[0-9]/.test(blob) && !blob.includes(id1) && !/author[A-Z]/.test(blob) && !blob.includes('Absolutely') && !blob.includes('Fake review removed')
      && !blob.includes('competitor') && !blob.includes('rv1'), mine);

  /* S2 — the review's AUTHOR sees no report about it, and nothing they can read names the reporter */
  const authorView = await tryv(TS.tsGetReports(as('authorB', { scope: 'mine' })));
  ck('S2 the review\'s author: no report rows (they are not the seller); their review doc names no reporter',
    Array.isArray(authorView.reports) && authorView.reports.length === 0 && !/reporter[0-9]/.test(JSON.stringify(await get('reviews/rv1'))), authorView);

  /* N1 — the reporter is told "resolved" about "a review" — no excerpt, no listing */
  const toReporter = sent.filter((m) => m.uid === 'reporter1');
  ck('N1 notifications: the reporter is told the report was reviewed ("a review"), never the review text; no seller message for a review report',
    toReporter.length >= 1 && toReporter.every((m) => /a review/.test(m.body) && !/Absolutely|Kitenge/.test(m.body)) && !sent.some((m) => m.uid === 'sellerA'), sent);

  /* Z1 — tripwires held */
  let fired = false;
  try { require('firebase-admin'); } catch (e) { fired = /TRIPWIRE/.test(e.message); }
  let firedN = false;
  try { require(path.join(FN, 'notify')); } catch (e) { firedN = /TRIPWIRE/.test(e.message); }
  const cached = Object.keys(require.cache).filter((k) => /[\\/]node_modules[\\/]firebase-admin[\\/]|[\\/]notify\.js$/.test(k));
  ck('Z1 tripwires held: real firebase-admin and notify.js never loaded (not in require.cache); positive control — requiring either THROWS',
    fired && firedN && cached.length === 0, { fired, firedN, cached });

  say(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(1); });
