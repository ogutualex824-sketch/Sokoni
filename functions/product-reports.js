/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PRODUCT REPORTING (the callables)
   functions/product-reports.js

   Somebody looking at a listing says "this should not be here". This module records that,
   routes it to moderation, and does nothing else.

   Every DECISION belongs to product-report-authority.js: which reasons exist, how serious
   each one is, where it lands in the queue, and what a seller is allowed to see. This
   module loads documents, asks that authority, and writes the result.

   ── IT SHARES THE PLATFORM'S EXISTING MODERATION QUEUE ────────────────────────
   Reports are written to `reports` — the same collection tsReportContent writes and
   tsGetReports reads — so AdminOS and Super Admin see product reports in the queue they
   already have. A second collection would mean a second queue, and a second queue is one
   nobody is watching.

   ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
   A report is not a dispute. It carries no order, no money and no entitlement. It cannot
   refund anybody, cannot take a listing down, and cannot suspend a seller. Those are
   moderator actions on the far side of a human decision.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

const A = require('./product-report-authority');
const _ac = require('./admin-claim');

const REGION = 'us-central1';
const db = () => getFirestore();
const stamp = () => FieldValue.serverTimestamp();

const C_REPORTS = 'reports';
const C_PRODUCTS = 'products';
const C_SUMMARY = 'productReportSummaries';
const C_AUDIT = 'trustSafetyAudit';

function fail(code, msg) { throw new HttpsError(code, msg); }

function uidOf(req) {
  if (!req || !req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in to report a listing.');
  return String(req.auth.uid);
}

/** Stable, non-reversible, and the same for the same pair every time. */
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/**
 * THE SELLER IS RESOLVED, NEVER SUPPLIED.
 *
 * If a reporter could name the seller, a report would be a way to attach a moderation
 * record to any merchant on the platform — the complaint would arrive already pointed at
 * a competitor. The listing decides whose it is.
 */
async function resolveProduct(productId) {
  const snap = await db().collection(C_PRODUCTS).doc(String(productId)).get();
  if (!snap.exists) {
    /* An unresolvable listing is refused rather than filed against nothing. A queue full
       of reports about products that never existed is how the real ones get missed. */
    fail('not-found', 'That listing no longer exists.');
  }
  const p = snap.data() || {};
  return {
    productId: snap.id,
    productName: p.name || p.title || null,
    sellerId: p.sellerId || p.ownerId || p.merchantId || null,
    shopId: p.shopId || p.storeId || p.businessId || null,
  };
}

/* ═══ 1. reportProduct — anyone signed in flags a listing ═════════════════════ */
exports.reportProduct = onCall({ region: REGION, enforceAppCheck: true, maxInstances: 30 }, async (req) => {
  const uid = uidOf(req);

  /* THE AUTHORITY VALIDATES BEFORE ANYTHING IS READ OR WRITTEN. The normalised report it
     returns is the only thing that reaches Firestore — fields the request carried but the
     authority did not name are dropped, not merged, so a crafted request cannot set its
     own status or severity. */
  const v = A.validateReport(req.data || {});
  if (!v.ok) {
    const human = {
      NO_PRODUCT: 'Tell us which listing.',
      NO_REASON: 'Choose a reason.',
      UNKNOWN_REASON: 'That is not a reason we recognise.',
      NOTE_REQUIRED: 'Tell us briefly what is wrong.',
      TOO_MUCH_EVIDENCE: 'That is more files than a report can carry.',
      BAD_EVIDENCE: 'That evidence could not be read.',
      BAD_EVIDENCE_KIND: 'That kind of file cannot be attached.',
      BAD_EVIDENCE_PATH: 'That evidence could not be read.',
    }[v.reason] || 'That report could not be filed.';
    fail('invalid-argument', human);
  }
  const r = v.report;

  const product = await resolveProduct(r.productId);

  /* A seller reporting their own listing is refused — not to protect anyone, but because
     it is the cheapest way to put a competitor's shop in the moderation queue by proxy
     and then point at the queue. */
  if (product.sellerId && product.sellerId === uid) {
    fail('failed-precondition', 'This is your own listing.');
  }

  const routing = A.moderationRouting(r.severity, { safety: r.safety });
  if (!routing.ok) fail('internal', 'That report could not be routed.');

  const key = A.reportKey(r.productId, uid, sha);
  if (!key.ok) fail('internal', 'That report could not be filed.');

  const ref = db().collection(C_REPORTS).doc(key.id);

  /* ONE REPORTER, ONE REPORT — enforced by the document id inside a transaction, so a
     double-tapped button and a retried request converge on the same document instead of
     racing to create two. A query-and-then-write would leave exactly that gap. */
  let replay = false;
  await db().runTransaction(async (txn) => {
    const existing = await txn.get(ref);
    if (existing.exists) { replay = true; return; }

    txn.set(ref, {
      /* The shape the existing moderation queue already reads. */
      entityId: r.productId,
      entityType: 'product',
      reason: r.reason,
      detail: r.note || '',
      reportedBy: uid,
      status: A.STATUS.PENDING,

      /* SERVER-DECIDED, every one of them. */
      severity: r.severity,
      safety: r.safety,
      priority: routing.priority,
      queue: routing.queue,

      /* RESOLVED FROM THE LISTING, not from the request. */
      productName: product.productName,
      sellerId: product.sellerId,
      shopId: product.shopId,

      evidence: r.evidence,
      source: 'product_report_v1',
      createdAt: stamp(),
      reviewedBy: null,
      resolution: null,
      reviewedAt: null,
    });
  });

  if (replay) {
    /* Reported twice is not an error to shout about. The reporter is told their report
       stands, which is true, rather than being made to wonder whether it registered. */
    return { ok: true, reportId: ref.id, already: true, severity: r.severity };
  }

  /* ── the aggregate ──────────────────────────────────────────────────────────
     How many people have reported this listing, and for what. It exists so a moderator
     can see weight — twelve reports for `counterfeit` is a different thing from one.

     IT NEVER ACTS. No threshold here takes a listing down, withholds money or suspends a
     seller; if a count could act on its own, a group could remove any listing on SOKONI
     by agreeing to press the same button. */
  await db().collection(C_SUMMARY).doc(r.productId).set({
    productId: r.productId,
    sellerId: product.sellerId,
    shopId: product.shopId,
    total: FieldValue.increment(1),
    open: FieldValue.increment(1),
    /* NESTED, not a dotted path. Firestore interprets `a.b` as a field path only in
       update(); in set() it is a literal field NAME, so a dotted key here would build
       a flat field called "byReason.counterfeit" that no reader of `byReason` can see.
       merge:true deep-merges this map and the increment applies to the nested leaf. */
    byReason: { [r.reason]: FieldValue.increment(1) },
    lastReportAt: stamp(),
    lastSeverity: r.severity,
    autoAction: null,
  }, { merge: true }).catch(() => { /* the report is filed; the tally is a convenience */ });

  await db().collection(C_AUDIT).add({
    action: 'product_report_filed',
    reportId: ref.id,
    entityId: r.productId,
    entityType: 'product',
    reason: r.reason,
    severity: r.severity,
    /* The reporter is recorded in the audit trail — moderation must be able to see a
       pattern of false reports — but never in anything a seller can read. */
    performedBy: uid,
    createdAt: stamp(),
  }).catch(() => {});

  if (routing.notifyAdmin) {
    await db().collection('notifications').add({
      type: 'trust_safety_critical',
      title: 'Critical listing report',
      body: 'A listing was reported as ' + r.reason + '.',
      targetRole: 'admin',
      priority: 1,
      entityId: ref.id,
      read: false,
      createdAt: stamp(),
    }).catch(() => {});
  }

  return { ok: true, reportId: ref.id, already: false, severity: r.severity };
});

/* ═══ 2. myProductReports — what this reporter has already flagged ════════════
   So a product page can say "you reported this" instead of offering the button again and
   then refusing it. */
exports.myProductReports = onCall({ region: REGION, enforceAppCheck: true }, async (req) => {
  const uid = uidOf(req);
  const productId = String((req.data && req.data.productId) || '').trim();

  let q = db().collection(C_REPORTS).where('reportedBy', '==', uid);
  if (productId) q = q.where('entityId', '==', productId);
  const snap = await q.limit(50).get();

  return {
    ok: true,
    reports: snap.docs.map((d) => {
      const x = d.data() || {};
      return { id: d.id, productId: x.entityId, reason: x.reason, status: x.status, createdAt: x.createdAt || null };
    }),
  };
});

/* ═══ 3. shopReportsForSeller — a seller sees what was said about their listings ═
   A seller must know a listing has been reported: they cannot fix what they cannot see.
   They must NOT learn who reported it, what that person wrote, or what they attached —
   a note routinely identifies its author to a seller holding the order list, even with
   the uid stripped. The projection is the authority's, not this module's. */
exports.shopReportsForSeller = onCall({ region: REGION, enforceAppCheck: true }, async (req) => {
  const uid = uidOf(req);
  const snap = await db().collection(C_REPORTS)
    .where('sellerId', '==', uid)
    .where('entityType', '==', 'product')
    .limit(200).get();

  const rows = snap.docs
    .map((d) => A.sellerView(Object.assign({ id: d.id }, d.data() || {})))
    .sort((a, b) => String(b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().toISOString() : b.createdAt || '')
      .localeCompare(String(a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().toISOString() : a.createdAt || '')));

  return { ok: true, reports: rows, openCount: rows.filter((r) => A.OPEN_STATUSES.indexOf(r.status) > -1).length };
});

/* ═══ 4. adminReviewProductReport — the moderator's decision ══════════════════
   The existing tsReviewReport remains the general moderation action. This one adds what a
   product report needs and the general one has no way to know: the legal-transition table,
   and keeping the per-listing tally honest as reports close.

   It cannot refund, cannot pay and cannot suspend. A moderator deciding a report is
   recording a judgement about a LISTING; money belongs to the refund rail, which has the
   provider confirmation and the idempotency this does not. */
exports.adminReviewProductReport = onCall({ region: REGION, enforceAppCheck: true }, async (req) => {
  const uid = uidOf(req);
  if (!_ac.isAdmin(req.auth.token)) fail('permission-denied', 'Moderator access required.');

  const reportId = String((req.data && req.data.reportId) || '').trim();
  const to = String((req.data && req.data.status) || '').trim();
  const note = String((req.data && req.data.resolution) || '').trim().slice(0, 1000);
  if (!reportId) fail('invalid-argument', 'reportId is required.');

  const ref = db().collection(C_REPORTS).doc(reportId);

  let result = null;
  await db().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) fail('not-found', 'That report does not exist.');
    const cur = snap.data() || {};

    /* WHICH MOVES EXIST is the authority's answer. Re-deciding a decided report would
       rewrite a moderator's record, and a record that can be rewritten is not one. */
    const move = A.canTransition(cur.status || A.STATUS.PENDING, to);
    if (!move.ok) {
      fail('failed-precondition',
        move.reason === 'ILLEGAL_TRANSITION'
          ? 'That report has already been decided.'
          : 'That is not a status a report can hold.');
    }
    if ((to === A.STATUS.ACTIONED || to === A.STATUS.DISMISSED) && note.length < 2) {
      fail('invalid-argument', 'Say why. A decision without a reason cannot be reviewed later.');
    }

    txn.update(ref, {
      status: to,
      resolution: note || null,
      reviewedBy: uid,
      reviewedAt: stamp(),
    });

    const wasOpen = A.OPEN_STATUSES.indexOf(cur.status) > -1;
    const nowOpen = A.OPEN_STATUSES.indexOf(to) > -1;
    if (cur.entityId && wasOpen && !nowOpen) {
      txn.set(db().collection(C_SUMMARY).doc(String(cur.entityId)),
        { open: FieldValue.increment(-1) }, { merge: true });
    }

    result = { ok: true, reportId, status: to, terminal: move.terminal };
  });

  await db().collection(C_AUDIT).add({
    action: 'product_report_reviewed',
    reportId, result: to, resolution: note || '',
    performedBy: uid, createdAt: stamp(),
  }).catch(() => {});

  return result;
});

module.exports.C_REPORTS = C_REPORTS;
module.exports.C_SUMMARY = C_SUMMARY;
module.exports._internal = { resolveProduct, sha };
