'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');

/* ── Severity inference ─────────────────────────────────────────────────── */
const SEVERITY_KEYWORDS = {
  critical: ['scam','fraud','illegal','abuse','child','threat','extort','kidnap','weapon','drug'],
  high:     ['fake','misleading','stolen','violence','hate','impersonation','phishing'],
  medium:   ['spam','inappropriate','offensive','copyright','counterfeit'],
};
function _inferSeverity(reason) {
  const r = (reason || '').toLowerCase();
  for (const [level, words] of Object.entries(SEVERITY_KEYWORDS)) {
    if (words.some(w => r.includes(w))) return level;
  }
  return 'low';
}

const OPT        = { region: 'us-central1', enforceAppCheck: true, maxInstances: 10 };
const OPT_REPORT = { region: 'us-central1', enforceAppCheck: true, maxInstances: 30 };

/* 2026-10-01: a refusal is a typed HttpsError (permission-denied), not a bare Error that reaches the browser as
   "internal" — the queue must be able to say "you are not an administrator" honestly. */
function _requireAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new HttpsError('permission-denied', 'admin required');
}
function _requireSuperAdmin(req) {
  if (!req.auth?.token?.superAdmin) throw new HttpsError('permission-denied', 'superAdmin required');
}

/* ═════════════════════════════════════════════════════════════════════════
   THE ONE REPORT AUTHORITY (community C2, 2026-10-01)

   Store: `reports` (rules: create false — only this file writes it). Readers: AdminOS › Fraud & Trust › Reports
   Queue and super-admin.html › Trust reports (both mount sokoni-trust-queues.js → tsGetReports / tsReviewReport) and
   the seller's own listings in merchant-v2 (tsGetReports scope:'mine'). Reports are PRIVATE: never public, the seller
   never sees who reported or what they wrote.

   The parallel client stores (`flags` from SokoniReport, `communityReports`, `contentFlags`) are no longer written by
   the product/seller report path; closing their rules is a separate rules slice.
   ═════════════════════════════════════════════════════════════════════════ */

/* Entity types a report may target. 'listing' is the historical name the product page used for a product. */
const REPORT_ENTITY_TYPES = ['product', 'user', 'business', 'message', 'review', 'unboxing'];
const REPORT_ENTITY_ALIASES = { listing: 'product' };

/* THE reason catalogue. The product page's wizard renders THIS list (tsGetReportReasons) — there is no client copy.
   A product report whose reason code is not here is refused. Types with no catalogue keep the historical free-text
   reason (≤120 chars, severity inferred). */
const REPORT_DETAIL_MAX = 500;
const REPORT_DETAIL_MIN_WHEN_REQUIRED = 10;
/* the review catalogue (2026-10-03) — shared by both review kinds */
const REVIEW_REPORT_REASONS = Object.freeze([
  { code: 'fake_review',          label: 'Fake or paid review',                       severity: 'high',   hint: 'Not a real buyer\'s experience, or written in exchange for payment or a reward.' },
  { code: 'spam',                 label: 'Spam or advertising',                       severity: 'medium', hint: 'Adverts, links, repeated text or anything that is not a review.' },
  { code: 'offensive',            label: 'Offensive or abusive',                      severity: 'medium', hint: 'Hateful, sexual, threatening or abusive words or images.' },
  { code: 'off_topic',            label: 'Not about this product or seller',          severity: 'low',    hint: 'About something else entirely.' },
  { code: 'personal_info',        label: 'Shares personal information',               severity: 'high',   hint: 'A phone number, address, ID number or other private details.' },
  { code: 'conflict_of_interest', label: 'Written by the seller or a competitor',     severity: 'high',   hint: 'The writer has an interest in this listing doing well or badly.' },
  { code: 'other',                label: 'Something else',                            severity: 'low',    hint: 'Tell us what is wrong in the next step.', detailRequired: true },
].map(Object.freeze));
const REPORT_REASONS = Object.freeze({
  product: Object.freeze([
    { code: 'counterfeit',    label: 'Counterfeit or fake product',        severity: 'high',     hint: 'A copy of a brand, or not the genuine item it claims to be.' },
    { code: 'prohibited',     label: 'Prohibited or illegal item',         severity: 'critical', hint: 'Weapons, drugs, wildlife products, stolen goods or anything else not allowed on SOKONI.' },
    { code: 'misleading',     label: 'Misleading description or price',    severity: 'medium',   hint: 'The photos, description or price do not match what is being sold.' },
    { code: 'scam',           label: 'Scam or fraud',                      severity: 'critical', hint: 'Asks for payment outside SOKONI, or is not a real offer.' },
    { code: 'offensive',      label: 'Offensive or inappropriate content', severity: 'medium',   hint: 'Hateful, sexual or abusive words or images.' },
    { code: 'wrong_category', label: 'Wrong category',                     severity: 'low',      hint: 'Listed in a category it does not belong to.' },
    { code: 'other',          label: 'Something else',                     severity: 'low',      hint: 'Tell us what is wrong in the next step.', detailRequired: true },
  ].map(Object.freeze)),
  /* 2026-10-03: a REVIEW (reviews/{id}) or an UNBOXING review (unboxingReviews/{id}) — one list for both kinds */
  review: REVIEW_REPORT_REASONS,
  unboxing: REVIEW_REPORT_REASONS,
});
/* review report targets — the moderation transition itself is the review owner's shared module (sokoni-5b,
   functions/shared/review-moderation.js, byte-identical copy of 85a5fcf, pinned by scripts/test-review-reports.js) */
function _isReviewType(t) { return t === 'review' || t === 'unboxing'; }
let _rm = null;
function _reviewModeration() {
  /* loaded on the review path only (no try/catch: a missing module is a loud failure, and the require-closure gate
     proves the file is in the deploy tree) */
  if (!_rm) _rm = require('./shared/review-moderation');
  return _rm;
}
const REVIEW_EXCERPT_MAX = 280;
function _reviewExcerpt(r) {
  const t = [r.body, r.comment, r.text, r.caption, r.review, r.title].find((x) => typeof x === 'string' && x.trim());
  return _cleanText(String(t || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), REVIEW_EXCERPT_MAX);
}
/* REVIEW CONTEXT, captured by the SERVER at report time — nothing the reporter sent is used. The review must exist; its
   writer cannot report it. `authorUid` is for administrators only (never returned to a seller, never to the author).
   `listingSellerUid` is the seller of the reviewed listing, resolved from the canonical record (the product document,
   or the seller id a server-written review targets) — never from a client-written field — and drives the seller's
   status-only view. It is deliberately NOT `sellerUid`: the queue's seller filters and "seller upheld ×N" facts count
   reports AGAINST a seller, and a removed review is not one. */
async function _reviewReportContext(db, entityType, entityId, uid) {
  const kind = entityType === 'unboxing' ? 'unboxing' : 'review';
  const rs = await db.collection(kind === 'unboxing' ? 'unboxingReviews' : 'reviews').doc(entityId).get();
  if (!rs.exists) throw new HttpsError('not-found', 'That review no longer exists.');
  const r = rs.data() || {};
  const authorUid = r.authorUid || r.uid || null;
  if (authorUid && authorUid === uid) throw new HttpsError('failed-precondition', 'You cannot report your own review.');
  const targetType = kind === 'unboxing' ? 'product' : (r.targetType || (r.productId ? 'product' : null));
  const targetId = r.targetId || r.productId || null;
  let listingSellerUid = null;
  if (targetType === 'seller' && kind === 'review') listingSellerUid = _safeId(targetId) || null;
  else if (targetType === 'product' && _safeId(targetId)) {
    const ps = await db.collection('products').doc(String(targetId)).get();
    if (ps.exists) { const p = ps.data() || {}; listingSellerUid = p.sellerUid || p.sellerId || null; }
  }
  return {
    reviewKind: kind,
    /* what the review is ABOUT (the product, or the seller for a seller review) */
    listingType: targetType || null,
    listingId: targetId ? String(targetId).slice(0, 200) : null,
    authorUid,
    listingSellerUid,
    excerpt: _reviewExcerpt(r),
    rating: typeof r.rating === 'number' ? r.rating : null,
    reviewStatus: r.status || null,
  };
}

function _normEntityType(t) {
  const s = String(t || '');
  return REPORT_ENTITY_ALIASES[s] || s;
}
function _cleanText(s, max) {
  /* strip control characters (keep newlines/tabs), trim, cap */
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
/* Deterministic report id: ONE report per reporter per entity, enforced by create() (a second create fails
   ALREADY_EXISTS atomically — no read-then-write race). The id embeds the reporter uid, so it is NEVER returned to a
   seller (scope:'mine' returns an opaque hash instead). */
function _reportDocId(uid, entityType, entityId) {
  return `${uid}_${entityType}_${entityId}`;
}
function _opaqueRef(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

/* THE STATE MAPPING — the one place the stored report status meets the shared moderation state machine
   (pending → approved(=upheld) | rejected(=dismissed) | changes_requested | archived | removed).
   Stored values are kept as they were (actioned / dismissed / escalated): every existing report carries them and
   tsCalculateRiskScore / tsGetTrustDashboard query them. New stored values use the shared names directly. */
const REPORT_STATE = Object.freeze({
  pending: 'pending',
  escalated: 'pending',             /* still awaiting a decision — flagged for a senior reviewer */
  actioned: 'approved',             /* upheld */
  dismissed: 'rejected',
  changes_requested: 'changes_requested',
  archived: 'archived',
  removed: 'removed',
});
/* decision action (shared vocabulary + the historical names) → stored status */
const REPORT_ACTIONS = Object.freeze({
  approve: 'actioned', uphold: 'actioned',
  dismiss: 'dismissed', reject: 'dismissed',
  escalate: 'escalated',
  request_changes: 'changes_requested',
  archive: 'archived',
  remove: 'removed',
  reopen: 'pending',                /* community C3: explicit, noted, audited — the ONLY way out of a closed decision */
});
/* stored status a report may move FROM, per target status. Anything else is refused (failed-precondition). */
const REPORT_TRANSITIONS = Object.freeze({
  actioned:          ['pending', 'escalated', 'changes_requested'],
  dismissed:         ['pending', 'escalated', 'changes_requested'],
  escalated:         ['pending'],
  changes_requested: ['pending', 'escalated'],
  archived:          ['pending', 'escalated', 'actioned', 'dismissed', 'changes_requested'],
  removed:           ['pending', 'escalated', 'actioned', 'dismissed', 'changes_requested', 'archived'],
  /* community C3: a CLOSED decision is changed only by an explicit, noted, audited `reopen` — never silently */
  pending:           ['actioned', 'dismissed', 'archived'],
});
function _stateOf(status) {
  return REPORT_STATE[status || 'pending'] || null;   /* an unknown stored status is shown as unknown, never guessed */
}

/* ═════════════════════════════════════════════════════════════════════════
   THE MODERATION QUEUE (community C3, 2026-10-01) — the SAME `reports` collection, decided through the SAME callables.
   No second collection, no second state machine: the queue status below is DERIVED from the stored status plus the
   one new field `assignedTo` (the reviewer who took the report under review).

   stored status (+ assignedTo)      → queueStatus         → seller sees            → reporter is told
   pending, nobody assigned          → open                → report_received        → (nothing new)
   pending, assignedTo set           → under_review        → under_review           → (nothing new)
   escalated                         → escalated           → under_review           → (nothing new)
   changes_requested                 → needs_information   → changes_requested      → (nothing new)
   actioned                          → upheld              → listing_action_taken (taken down) | report_upheld → resolved
   dismissed                         → dismissed           → report_dismissed       → resolved
   archived                          → archived            → closed                 → —
   removed                           → removed             → (not shown)            → —
   ═════════════════════════════════════════════════════════════════════════ */
const OPEN_STATUSES = Object.freeze(['pending', 'escalated', 'changes_requested']);
const QUEUE_STATUS_STORED = Object.freeze({
  active: OPEN_STATUSES,                 /* every undecided report (open + under review + escalated + needs information) */
  open: ['pending'], under_review: ['pending'], escalated: ['escalated'], needs_information: ['changes_requested'],
  upheld: ['actioned'], dismissed: ['dismissed'], archived: ['archived'], removed: ['removed'],
});
function _queueStatusOf(r) {
  const s = (r && r.status) || 'pending';
  if (s === 'pending') return r.assignedTo ? 'under_review' : 'open';
  return ({ escalated: 'escalated', changes_requested: 'needs_information', actioned: 'upheld', dismissed: 'dismissed',
    archived: 'archived', removed: 'removed' })[s] || null;
}
function _sellerStatusOf(r) {
  const s = (r && r.status) || 'pending';
  if (s === 'pending') return r.assignedTo ? 'under_review' : 'report_received';
  if (s === 'escalated') return 'under_review';                 /* escalation is internal — the seller is not told */
  if (s === 'actioned') return r.productHidden === true ? 'listing_action_taken' : 'report_upheld';
  return ({ changes_requested: 'changes_requested', dismissed: 'report_dismissed', archived: 'closed' })[s] || null;
}
/* Assignment is not a status change: it never moves `status`, and is offered only while a report is undecided. */
const ASSIGN_ACTIONS = Object.freeze(['claim', 'unclaim']);

/* TYPED TARGETS. One queue for every content type: a target type is a registry entry, not a new system. A report on a
   type that is not ENABLED here is refused by every moderation operation (failed-precondition). Enforcement exists for
   product listings (isVisible:false + moderationHold) and, since 2026-10-03, reviews / unboxing reviews (an upheld
   report removes the review through functions/shared/review-moderation.js); the others are decided and recorded
   without enforcement, as in C2. Future types are listed DISABLED so the queue can take them later without being
   rewritten. */
const MODERATION_TARGETS = Object.freeze({
  product:            { enabled: true,  enforcement: 'listing_visibility', label: 'Product / listing' },
  user:               { enabled: true,  enforcement: null,                 label: 'Profile' },
  business:           { enabled: true,  enforcement: null,                 label: 'Shop / business' },
  message:            { enabled: true,  enforcement: null,                 label: 'Message' },
  /* 2026-10-03: an upheld report REMOVES the review through the review owner's shared module (sokoni-5b) */
  review:             { enabled: true,  enforcement: 'review_removal',     label: 'Review' },
  unboxing:           { enabled: true,  enforcement: 'review_removal',     label: 'Unboxing review' },
  comment:            { enabled: false, enforcement: null,                 label: 'Comment' },
  media:              { enabled: false, enforcement: null,                 label: 'Media' },
  story:              { enabled: false, enforcement: null,                 label: 'Story' },
  foundation_content: { enabled: false, enforcement: null,                 label: 'Foundation content' },
});
function _targetOf(entityType) {
  const t = _normEntityType(entityType);
  const m = MODERATION_TARGETS[t];
  return { type: t, supported: !!(m && m.enabled && REPORT_ENTITY_TYPES.includes(t)), enforcement: (m && m.enforcement) || null };
}
/* Seller response / appeal: no appeal mechanism exists on the report authority. This hook says so explicitly, so no
   screen implies that a dismissal or a take-down is the end of the road — the route is SOKONI Support. */
const SELLER_RESPONSE = Object.freeze({ supported: false, route: 'support', href: 'support.html' });

function _safeId(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s && s.length <= (max || 128) && !/[/]/.test(s) && s !== '.' && s !== '..' ? s : null;
}
function _actorRole(req) { return req.auth && req.auth.token && req.auth.token.superAdmin ? 'superAdmin' : 'admin'; }
function _auditId(reportId, revision) { return `rpt_${_opaqueRef(reportId)}_r${revision}`; }
function _iso(ts) {
  return ts && typeof ts.toMillis === 'function' ? new Date(ts.toMillis()).toISOString() : null;
}

/* ═════════════════════════════════════════════════════════════════════════
   TAKEDOWN ENFORCEMENT (2026-10-02, owner spec "takedown / hidden product enforcement")

   THE HOLD IS PUBLIC-SAFE. `products/{id}` is world-readable (rules: read if true), so `moderationHold` carries NO
   reporter-derived value and no moderator identity: the report id embeds the reporter's uid, and the reason would tell
   the public "this seller was reported for X". The hold stores only an opaque ref (sha256 prefix of the report id),
   the correlation id, the time and the visibility before it. Who decided and why lives in the report and in
   `trustSafetyAudit` (both server-only). A hold written by the pre-2026-10-02 code (reportId) is still recognised —
   none exists in production (C2/C3 never deployed; the live trust-safety.js never writes products).

   OTHER ENFORCEMENT. A restore only lifts THIS moderation hold. If another enforcement still applies to the listing —
   the seller account banned / suspended / deactivated, the shop deactivated, or the product removed by an admin —
   the restore is REFUSED (failed-precondition, with the enforcement named), so a moderation restore can never become
   the moment a suspended seller's listing goes public again.

   PROMOTIONS. Paid placement never bypasses moderation: a take-down moves the listing's ACTIVE `featuredListings`
   rows to `paused_by_moderation` (status only — payment, price, dates and billing are untouched), and a restore moves
   exactly those rows back to `active`. The public reader (sokoni-featured.js) shows status=='active' only.
   ═════════════════════════════════════════════════════════════════════════ */
const PROMO_PAUSED = 'paused_by_moderation';
function _holdOwnedBy(hold, ids) {
  if (!hold) return null;
  for (const id of ids) {
    if (!id) continue;
    if ((hold.ref && hold.ref === _opaqueRef(id)) || (hold.reportId && hold.reportId === id)) return id;
  }
  return null;
}
/* Reads (transaction-safe: all reads, no writes) the enforcement that is NOT this moderation hold. */
async function _otherEnforcement(tx, db, p) {
  const out = [];
  const st = String((p && p.status) || '').toLowerCase();
  if (['removed', 'banned', 'suspended', 'deleted', 'rejected'].includes(st)) out.push('PRODUCT_' + st.toUpperCase());
  const sellerUid = p && (p.sellerUid || p.sellerId);
  if (sellerUid && _safeId(sellerUid)) {
    const us = await tx.get(db.collection('users').doc(String(sellerUid)));
    const u = us.exists ? (us.data() || {}) : {};
    if (u.status === 'banned') out.push('SELLER_BANNED');
    if (u.status === 'suspended') out.push('SELLER_SUSPENDED');
    if (u.deactivated === true) out.push('SELLER_DEACTIVATED');
  }
  const shopId = p && p.shopId;
  if (shopId && _safeId(shopId)) {
    const ss = await tx.get(db.collection('shops').doc(String(shopId)));
    const s = ss.exists ? (ss.data() || {}) : {};
    if (s.deactivated === true) out.push('SHOP_DEACTIVATED');
    if (['suspended', 'banned'].includes(String(s.status || ''))) out.push('SHOP_' + String(s.status).toUpperCase());
  }
  return out;
}
async function _promotionsFor(tx, db, productId, status) {
  const qs = await tx.get(db.collection('featuredListings').where('itemId', '==', String(productId)).limit(50));
  return qs.docs.filter((d) => { const x = d.data() || {}; return (x.itemType || 'product') === 'product' && x.status === status; });
}

/* ─────────────────────────────────────────────────────────────────────────
   0. tsGetReportReasons — the reason catalogue for a report type (no client copy exists)
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetReportReasons = onCall(OPT_REPORT, async (req) => {
  const entityType = _normEntityType((req.data || {}).entityType);
  if (!REPORT_ENTITY_TYPES.includes(entityType)) throw new HttpsError('invalid-argument', 'Unknown report type.');
  const list = REPORT_REASONS[entityType] || null;
  return {
    entityType,
    reasons: list ? list.map((r) => ({ code: r.code, label: r.label, hint: r.hint || '', detailRequired: r.detailRequired === true })) : [],
    freeText: !list,
    detailMax: REPORT_DETAIL_MAX,
    detailMinWhenRequired: REPORT_DETAIL_MIN_WHEN_REQUIRED,
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   1. tsReportContent — any authenticated user files a report
──────────────────────────────────────────────────────────────────────────── */
exports.tsReportContent = onCall(OPT_REPORT, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to report.');
  const d = req.data || {};
  const entityType = _normEntityType(d.entityType);
  const entityId = String(d.entityId || '').trim().slice(0, 128);
  if (!entityId || /[/]/.test(entityId) || entityId === '.' || entityId === '..' || !REPORT_ENTITY_TYPES.includes(entityType)) {
    throw new HttpsError('invalid-argument', 'A known report type and the item being reported are required.');
  }

  /* reason: a CODE from the server catalogue where one exists; otherwise the historical free text */
  const catalogue = REPORT_REASONS[entityType] || null;
  let reason, reasonCode = null, severity, detailRequired = false;
  if (catalogue) {
    const hit = catalogue.find((r) => r.code === String(d.reasonCode || d.reason || ''));
    if (!hit) throw new HttpsError('invalid-argument', 'Choose one of the listed reasons.');
    reason = hit.label; reasonCode = hit.code; severity = hit.severity; detailRequired = hit.detailRequired === true;
  } else {
    reason = _cleanText(d.reason, 120);
    if (!reason) throw new HttpsError('invalid-argument', 'A reason is required.');
    severity = _inferSeverity(reason);
  }
  const detail = _cleanText(d.detail, REPORT_DETAIL_MAX);
  if (detailRequired && detail.length < REPORT_DETAIL_MIN_WHEN_REQUIRED) {
    throw new HttpsError('invalid-argument', `Describe the problem (at least ${REPORT_DETAIL_MIN_WHEN_REQUIRED} characters).`);
  }
  const evidenceUrls = (Array.isArray(d.evidenceUrls) ? d.evidenceUrls : [])
    .filter((u) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 5).map((u) => u.slice(0, 500));

  const db = getFirestore();

  /* Historical reports (auto ids, before 2026-10-01): one PENDING report per reporter per entity. */
  const dup = await db.collection('reports')
    .where('entityId', '==', entityId)
    .where('reportedBy', '==', uid)
    .where('status', '==', 'pending')
    .limit(1).get();
  if (!dup.empty) throw new HttpsError('already-exists', 'You have already reported this. Our team is reviewing it.');

  /* PRODUCT CONTEXT, captured by the SERVER at report time: the product, its seller / shop and its state then.
     The seller identity is the product document's (never anything the reporter sent). */
  let context = null;
  if (entityType === 'product') {
    const ps = await db.collection('products').doc(entityId).get();
    if (!ps.exists) throw new HttpsError('not-found', 'That product no longer exists.');
    const p = ps.data() || {};
    context = {
      productName: String(p.name || '').slice(0, 120),
      sellerUid: p.sellerUid || p.sellerId || null,
      shopId: p.shopId || null,
      price: typeof p.price === 'number' ? p.price : null,
      status: p.status || null,
      isVisible: p.isVisible !== false,
    };
    if (context.sellerUid && context.sellerUid === uid) throw new HttpsError('failed-precondition', 'You cannot report your own product.');
  } else if (_isReviewType(entityType)) {
    context = await _reviewReportContext(db, entityType, entityId, uid);
  }

  const ref = db.collection('reports').doc(_reportDocId(uid, entityType, entityId));
  try {
    await ref.create({
      entityId, entityType, reason, reasonCode,
      detail,
      evidenceUrls,
      context,
      reportedBy: uid,   /* administrators only — never returned to a seller */
      status: 'pending',
      severity,
      createdAt: FieldValue.serverTimestamp(),
      reviewedBy: null,
      resolution: null,
      reviewedAt: null,
    });
  } catch (e) {
    if (e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS/i.test(String(e.message)))) {
      throw new HttpsError('already-exists', 'You have already reported this. Our team is reviewing it.');
    }
    throw e;
  }

  // Push admin notification for critical reports
  if (severity === 'critical') {
    await db.collection('notifications').add({
      type: 'trust_safety_critical',
      title: 'Critical Report Filed',
      body: `Critical ${entityType} report: ${entityId}`,
      targetRole: 'admin',
      priority: 1,
      entityId: ref.id,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  return { ok: true, reportId: ref.id, severity, status: 'pending', moderationState: 'pending' };
});

/* ─────────────────────────────────────────────────────────────────────────
   2. tsGetReports — admin: THE MODERATION QUEUE (server-filtered, bounded, paginated)
                     seller: scope:'mine' — reports on THEIR OWN products only

   Indexes (measured 2026-10-01, read-only `gcloud firestore indexes composite list`: 416 live composite indexes,
   ZERO on `reports`). So the queue uses ONLY what single-field indexes serve: equality filters (status / reasonCode /
   context.sellerUid / context.shopId / entityId / assignedTo — merged by Firestore without a composite index), an
   implicit document-id order, and a document-id cursor. Derived filters (open vs under review, date range when combined,
   entity type, severity) are applied by the SERVER to the scanned window; the page says how many it scanned and
   whether more exist. A date range alone is a real range query on createdAt (single-field). Global newest-first across
   pages needs the composite (status ASC, createdAt DESC) — written up as a proposal, NOT added (CHANGELOG C3).
──────────────────────────────────────────────────────────────────────────── */
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const QUEUE_SORTS = ['newest', 'oldest', 'severity', 'reports'];

function _adminRow(d) {
  const r = d.data() || {};
  return Object.assign({ id: d.id }, r, {
    ref: _opaqueRef(d.id),
    moderationState: _stateOf(r.status), queueStatus: _queueStatusOf(r),
    target: _targetOf(r.entityType),
    createdAtIso: _iso(r.createdAt), reviewedAtIso: _iso(r.reviewedAt), assignedAtIso: _iso(r.assignedAt),
    lastActionAtIso: _iso(r.lastActionAt) || _iso(r.reviewedAt) || _iso(r.assignedAt) || null,
    revision: Number.isInteger(r.revision) ? r.revision : 0,
  });
}
function _msOf(row) { return Date.parse(row.createdAtIso) || 0; }

exports.tsGetReports = onCall(OPT, async (req) => {
  const data = req.data || {};
  if (data.scope === 'mine') return _myListingReports(req);
  _requireAdmin(req);
  const db = getFirestore();
  const lim = Math.min(Math.max(Math.floor(Number(data.limit)) || 100, 1), 200);

  /* status: queueStatus (C3) | state (C2 shared vocabulary) | status (stored, historical) */
  let stored = null; const post = [];
  if (data.queueStatus) {
    stored = QUEUE_STATUS_STORED[String(data.queueStatus)];
    if (!stored) throw new HttpsError('invalid-argument', 'Unknown queue status.');
    if (data.queueStatus === 'open' || data.queueStatus === 'under_review') post.push((r) => r.queueStatus === data.queueStatus);
  } else if (data.state) {
    stored = Object.keys(REPORT_STATE).filter((k) => REPORT_STATE[k] === data.state);
    if (!stored.length) throw new HttpsError('invalid-argument', 'Unknown state.');
  } else if (data.status) {
    stored = [String(data.status).slice(0, 40)];
  }
  if (data.escalated === true) stored = ['escalated'];

  /* equality filters on stored fields — every value is resolved/validated here; nothing the client sends is a field name */
  const eq = [];
  const addEq = (field, v, label) => {
    if (v === undefined || v === null || v === '') return;
    const s = _safeId(v); if (!s) throw new HttpsError('invalid-argument', `Bad ${label} filter.`);
    eq.push([field, s]);
  };
  addEq('reasonCode', data.reason, 'reason');
  addEq('context.sellerUid', data.seller, 'seller');
  addEq('context.shopId', data.shop, 'shop');
  addEq('entityId', data.product, 'product');
  if (data.assignee) addEq('assignedTo', data.assignee === 'me' ? req.auth.uid : data.assignee, 'reviewer');

  const fromMs = data.from ? Date.parse(String(data.from)) : null;
  const toMs = data.to ? Date.parse(String(data.to)) : null;
  if ((data.from && !fromMs) || (data.to && !toMs)) throw new HttpsError('invalid-argument', 'Bad date filter.');
  const dateOnly = (fromMs || toMs) && !stored && !eq.length;

  let q = db.collection('reports');
  if (stored) q = stored.length === 1 ? q.where('status', '==', stored[0]) : q.where('status', 'in', stored);
  for (const [f, v] of eq) q = q.where(f, '==', v);
  if (dateOnly) {
    if (fromMs) q = q.where('createdAt', '>=', Timestamp.fromMillis(fromMs));
    if (toMs) q = q.where('createdAt', '<=', Timestamp.fromMillis(toMs));
    q = q.orderBy('createdAt', 'desc');
  } else if (fromMs || toMs) {
    post.push((r) => { const m = _msOf(r); return (!fromMs || m >= fromMs) && (!toMs || m <= toMs); });
  }
  if (data.after) {
    const after = _safeId(data.after);
    const cur = after ? await db.collection('reports').doc(after).get() : null;
    if (!cur || !cur.exists) throw new HttpsError('invalid-argument', 'Bad page cursor.');
    q = q.startAfter(cur);
  }
  const snap = await q.limit(lim).get();
  let rows = snap.docs.map(_adminRow);
  if (data.entityType) post.push((r) => _normEntityType(r.entityType) === _normEntityType(data.entityType));
  if (data.severity) post.push((r) => r.severity === data.severity);
  for (const f of post) rows = rows.filter(f);

  if (data.facts === true) await _attachFacts(db, rows);
  const sort = QUEUE_SORTS.includes(data.sort) ? data.sort : 'newest';
  rows.sort((a, b) => {
    if (sort === 'severity') {
      return (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0)
        || ((b.facts || {}).reportsOnListing || 0) - ((a.facts || {}).reportsOnListing || 0) || _msOf(a) - _msOf(b);
    }
    if (sort === 'reports') return ((b.facts || {}).reportsOnListing || 0) - ((a.facts || {}).reportsOnListing || 0) || _msOf(a) - _msOf(b);
    return sort === 'oldest' ? _msOf(a) - _msOf(b) : _msOf(b) - _msOf(a);
  });

  const out = {
    reports: rows,
    page: { limit: lim, scanned: snap.size, hasMore: snap.size === lim, nextCursor: snap.size === lim && snap.docs.length ? snap.docs[snap.docs.length - 1].id : null, sort },
  };
  if (data.groupBy === 'listing') out.groups = _groupByListing(rows);
  return out;
});

/* PRIORITY FACTS — raw, deterministic facts from existing data; no invented danger score. The queue shows them and
   sorts on them (severity comes from the server reason catalogue; the rest are counts the server reads). */
async function _attachFacts(db, rows) {
  const ents = [...new Set(rows.filter((r) => r.entityId).map((r) => r.entityId))];
  const sellers = [...new Set(rows.map((r) => (r.context || {}).sellerUid).filter(Boolean))];
  const count = async (q) => { try { return (await q.count().get()).data().count; } catch (_) { return null; } };   /* unknown stays null, never 0 */
  const per = {};
  await Promise.all(ents.map(async (id) => {
    const base = db.collection('reports').where('entityId', '==', id);
    const [total, open, upheld] = await Promise.all([count(base), count(base.where('status', 'in', OPEN_STATUSES)), count(base.where('status', '==', 'actioned'))]);
    per[id] = { total, open, upheld };
  }));
  const bySeller = {};
  await Promise.all(sellers.map(async (s) => {
    bySeller[s] = await count(db.collection('reports').where('context.sellerUid', '==', s).where('status', '==', 'actioned'));
  }));
  const prodIds = [...new Set(rows.filter((r) => _normEntityType(r.entityType) === 'product' && r.entityId).map((r) => r.entityId))].slice(0, 100);
  const vis = {};
  if (prodIds.length) {
    try {
      const snaps = await db.getAll(...prodIds.map((id) => db.collection('products').doc(id)));
      snaps.forEach((s) => { const p = s.exists ? (s.data() || {}) : null; vis[s.id] = p ? { visible: p.isVisible !== false, held: !!p.moderationHold } : { visible: null, held: null, missing: true }; });
    } catch (_) { /* unknown stays unknown */ }
  }
  for (const r of rows) {
    const e = per[r.entityId] || {}; const v = vis[r.entityId] || null;
    r.facts = {
      severity: r.severity || null,
      reportsOnListing: e.total == null ? null : e.total,
      openOnListing: e.open == null ? null : e.open,
      upheldOnListing: e.upheld == null ? null : e.upheld,
      sellerUpheld: (r.context || {}).sellerUid ? (bySeller[r.context.sellerUid] == null ? null : bySeller[r.context.sellerUid]) : null,
      listingVisible: v ? v.visible : null,
      listingHeld: v ? v.held : null,
      listingMissing: !!(v && v.missing),
    };
  }
}

/* 1 listing + N reports: each report keeps its own record; the group only makes the shared target obvious. */
function _groupByListing(rows) {
  const g = new Map();
  for (const r of rows) {
    const key = _normEntityType(r.entityType) + ':' + (r.entityId || '');
    if (!g.has(key)) g.set(key, { entityType: _normEntityType(r.entityType), entityId: r.entityId || null,
      title: (r.context || {}).productName || null, sellerUid: (r.context || {}).sellerUid || null, shopId: (r.context || {}).shopId || null,
      reportIds: [], openInPage: 0, facts: r.facts || null });
    const x = g.get(key);
    x.reportIds.push(r.id);
    if (OPEN_STATUSES.includes(r.status || 'pending')) x.openInPage++;
  }
  return [...g.values()];
}

/* A SELLER reads reports about THEIR OWN products, filtered by the server on the server-captured context.sellerUid.
   Withheld: who reported (reportedBy), the document id (it embeds the reporter uid), the reporter's free text and
   evidence, the reviewer, internal notes, escalation and the stored status / severity (internal triage). Reports an
   administrator REMOVED (abusive / bad-faith reports) are not shown. */
async function _myListingReports(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await getFirestore().collection('reports').where('context.sellerUid', '==', uid).limit(100).get();
  const reports = snap.docs.map((d) => {
    const r = d.data() || {}; const c = r.context || {};
    const moderationState = _stateOf(r.status || 'pending');
    return {
      ref: _opaqueRef(d.id),
      entityType: r.entityType || null, entityId: r.entityId || null,
      productName: c.productName || null, reasonCode: r.reasonCode || null, reason: r.reason || null,
      moderationState,
      sellerStatus: _sellerStatusOf(r),
      productHidden: r.productHidden === true,
      /* the administrator's OUTCOME note (written for the seller) is shown once a report is decided — never the
         internal note */
      outcome: moderationState === 'pending' ? null : (String(r.resolution || '').slice(0, 500) || null),
      createdAt: _iso(r.createdAt),
      decidedAt: _iso(r.reviewedAt),
      sellerResponse: SELLER_RESPONSE,
    };
  }).filter((x) => x.moderationState !== 'removed');
  /* REVIEWS of this seller's listings (2026-10-03): STATUS VOCABULARY ONLY. Not the reason, not the reporter's words,
     not the excerpt, not the review id or its author, not the outcome note — the seller learns that a review on their
     listing was reported and where that stands, nothing that could identify or pressure the reporter or the writer. */
  const rv = await getFirestore().collection('reports').where('context.listingSellerUid', '==', uid).limit(100).get();
  rv.docs.forEach((d) => {
    const r = d.data() || {}; const c = r.context || {};
    if (!_isReviewType(_normEntityType(r.entityType))) return;
    const moderationState = _stateOf(r.status || 'pending');
    if (moderationState === 'removed') return;
    reports.push({
      ref: _opaqueRef(d.id),
      entityType: r.entityType, subject: 'review_on_your_listing',
      listingType: c.listingType || null, listingId: c.listingId || null,
      /* a seller cannot change somebody else's review: 'needs information' is still under review to them */
      moderationState, sellerStatus: r.status === 'changes_requested' ? 'under_review' : _sellerStatusOf(r),
      createdAt: _iso(r.createdAt), decidedAt: _iso(r.reviewedAt),
      sellerResponse: SELLER_RESPONSE,
    });
  });
  reports.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return { reports, scope: 'mine', sellerResponse: SELLER_RESPONSE };
}

/* What the CALLER may do to this report NOW — computed by the server, rendered by the console (the UI never invents
   an action). Mirrors the checks tsReviewReport enforces. */
function _allowedActions(r, uid, isSuper) {
  const s = (r && r.status) || 'pending';
  const t = _targetOf(r && r.entityType);
  if (!t.supported) return [];
  const owner = (r && r.assignedTo) || null;
  const mine = !owner || owner === uid || isSuper;
  const out = [];
  if (OPEN_STATUSES.includes(s)) {
    if (!owner) out.push('claim');
    else if (owner !== uid && isSuper) out.push('takeover');
    if (owner && (owner === uid || isSuper)) out.push('unclaim');
  }
  if (!mine) return out;
  for (const [action, to] of Object.entries(REPORT_ACTIONS)) {
    if (['uphold', 'reject'].includes(action)) continue;                       /* aliases — offered once */
    if (action === 'escalate' && s === 'escalated') continue;
    if ((REPORT_TRANSITIONS[to] || []).includes(s)) out.push(action);
  }
  if (out.includes('approve') && t.enforcement === 'listing_visibility') out.push('takedown');
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   2b. tsGetReportCase — admin: one report, its listing, the other reports on that listing, its history
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetReportCase = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const reportId = _safeId((req.data || {}).reportId, 300);
  if (!reportId) throw new HttpsError('invalid-argument', 'reportId is required.');
  const db = getFirestore();
  const snap = await db.collection('reports').doc(reportId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Report not found.');
  const report = _adminRow(snap);
  const target = _targetOf(report.entityType);
  const isSuper = !!req.auth.token.superAdmin;

  let product = null, shop = null;
  if (target.type === 'product' && report.entityId) {
    const ps = await db.collection('products').doc(String(report.entityId)).get();
    if (!ps.exists) product = { exists: false, id: report.entityId };
    else {
      const p = ps.data() || {};
      const imgs = [].concat(Array.isArray(p.images) ? p.images : [], p.image || [], p.imageUrl || [])
        .map((x) => (x && typeof x === 'object' ? x.url : x)).filter((u) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 4);
      const h = p.moderationHold || null;
      product = {
        exists: true, id: ps.id, name: String(p.name || '').slice(0, 160) || null, category: p.category || p.categoryId || null,
        images: imgs, price: typeof p.price === 'number' ? p.price : null, status: p.status || null,
        isVisible: p.isVisible !== false, sellerUid: p.sellerUid || p.sellerId || null, shopId: p.shopId || null,
        /* admins see which report holds it — resolved from the opaque ref against the reports on this listing below */
        moderationHold: h ? { ref: h.ref || null, reportId: h.reportId || null, at: _iso(h.at) } : null,
      };
      if (product.shopId && _safeId(product.shopId)) {
        const ss = await db.collection('shops').doc(String(product.shopId)).get();
        shop = ss.exists ? { id: ss.id, name: String((ss.data() || {}).name || '').slice(0, 120) || null } : { id: product.shopId, name: null, missing: true };
      }
    }
  }

  /* REVIEW TARGET (2026-10-03): the review as it is NOW (canonical), plus the listing it is about. Admins only. */
  let review = null;
  if (_isReviewType(target.type) && _safeId(report.entityId, 200)) {
    const kind = target.type;
    const rs = await db.collection(kind === 'unboxing' ? 'unboxingReviews' : 'reviews').doc(String(report.entityId)).get();
    if (!rs.exists) review = { exists: false, kind, id: report.entityId };
    else {
      const x = rs.data() || {}; const c = report.context || {};
      const tType = kind === 'unboxing' ? 'product' : (x.targetType || (x.productId ? 'product' : null));
      const tId = x.targetId || x.productId || null;
      review = {
        exists: true, kind, id: rs.id, status: x.status || null,
        excerpt: _reviewExcerpt(x), excerptAtReport: c.excerpt || null,
        rating: typeof x.rating === 'number' ? x.rating : null,
        listingType: tType, listingId: tId,
        listingHref: tId && tType === 'product' ? 'product.html?id=' + encodeURIComponent(String(tId))
          : (tId && tType === 'seller' ? 'seller-public.html?id=' + encodeURIComponent(String(tId)) : null),
        authorUid: x.authorUid || x.uid || null,
        listingSellerUid: c.listingSellerUid || null,
        moderatedBy: x.moderatedBy || null, moderatedAtIso: _iso(x.moderatedAt),
      };
    }
  }

  /* every report on the same target — each its own record (reporter, reason, time, details): never collapsed */
  const sib = report.entityId ? await db.collection('reports').where('entityId', '==', report.entityId).limit(100).get() : { docs: [] };
  const reports = sib.docs.map(_adminRow).filter((r) => _normEntityType(r.entityType) === target.type)
    .map((r) => ({ id: r.id, ref: r.ref, reasonCode: r.reasonCode || null, reason: r.reason || null, detail: r.detail || '',
      reportedBy: r.reportedBy || null, status: r.status || 'pending', queueStatus: r.queueStatus, assignedTo: r.assignedTo || null,
      createdAtIso: r.createdAtIso, self: r.id === reportId }))
    .sort((a, b) => (Date.parse(a.createdAtIso) || 0) - (Date.parse(b.createdAtIso) || 0));

  /* HISTORY — the append-only audit rows for this report (trustSafetyAudit is server-only: no client rule) plus the
     report's own creation; and the moderation history of the LISTING across all its reports. */
  const auditRows = async (field, value) => {
    const a = await db.collection('trustSafetyAudit').where(field, '==', value).limit(200).get();
    return a.docs.map((d) => { const x = d.data() || {}; return Object.assign({ id: d.id }, x, { at: _iso(x.createdAt) }); })
      .sort((p, q2) => (Date.parse(p.at) || 0) - (Date.parse(q2.at) || 0) || (p.revision || 0) - (q2.revision || 0));
  };
  const history = [{ action: 'report_filed', at: report.createdAtIso, result: 'pending', resultState: 'pending' }].concat(await auditRows('reportId', reportId));
  const listingHistory = report.entityId
    ? (await auditRows('entityId', report.entityId)).filter((x) => _normEntityType(x.entityType) === target.type && (x.productHidden || x.enforcement))
    : [];

  if (product && product.moderationHold) {
    product.moderationHold.reportId = _holdOwnedBy(product.moderationHold, reports.map((r) => r.id)) || product.moderationHold.reportId || null;
    delete product.moderationHold.ref;
  }
  const heldByThis = !!(product && product.moderationHold && product.moderationHold.reportId === reportId);
  const actions = _allowedActions(report, req.auth.uid, isSuper);
  /* RESTORE (takedown spec §22): offered on the upheld report that owns the hold. The server re-checks everything. */
  if (heldByThis && report.status === 'actioned' && target.enforcement === 'listing_visibility'
      && (!report.assignedTo || report.assignedTo === req.auth.uid || isSuper)) actions.push('restore');
  /* REVIEW RESTORE: offered on the upheld report whose uphold removed the review, while the review is still removed.
     The server re-checks everything (and the shared module refuses a moderator with a stake in the review). */
  if (review && review.exists && review.status === 'removed' && report.status === 'actioned'
      && report.reviewEnforcement === 'review_removed' && target.enforcement === 'review_removal'
      && (!report.assignedTo || report.assignedTo === req.auth.uid || isSuper)) actions.push('restore');
  return {
    report, target, product, shop, review, reports, history, listingHistory,
    actions,
    openOnListing: reports.filter((r) => OPEN_STATUSES.includes(r.status)).length,
    /* the listing's take-down belongs to THIS report — dismissing it may restore the listing (restoreListing:true) */
    listingHeldByThisReport: heldByThis,
    sellerResponse: SELLER_RESPONSE,
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   3. tsReviewReport — admin: take under review / decide / reopen, on the ONE state machine

   ONE transaction, all reads before writes: the transition is checked against the report as it is NOW (two moderators
   deciding at once cannot both win), the reviewer lock is checked, and the product take-down and ONE audit row per
   report land together or not at all. Idempotency: an audit row id is deterministic per report revision (create() —
   a second write of the same transition aborts), a retried request with the same requestId returns the recorded
   outcome without writing, and claiming a report you already hold is a no-op. Nothing the client sends is trusted as
   a status, a decision, a seller, a reporter, a target, a hidden flag or an actor: those are resolved here.
──────────────────────────────────────────────────────────────────────────── */
exports.tsReviewReport = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const data = req.data || {};
  const reportId = _safeId(data.reportId, 300);
  const action = String(data.action || '');
  if (!reportId || !action) throw new HttpsError('invalid-argument', 'reportId and action are required.');
  const isAssign = ASSIGN_ACTIONS.includes(action);
  /* RESTORE (takedown spec §3, §22): the explicit AdminOS / Super Admin reverse of an upheld take-down. It is not a
     report status change — the report stays upheld; its history says the listing was restored, by whom and why. */
  const isRestore = action === 'restore';
  const newStatus = (isAssign || isRestore) ? null : REPORT_ACTIONS[action];
  if (!isAssign && !isRestore && !newStatus) {
    throw new HttpsError('invalid-argument', 'action must be one of ' + Object.keys(REPORT_ACTIONS).concat(ASSIGN_ACTIONS, ['restore']).join('|'));
  }
  const resolution = _cleanText(data.resolution, 500);          /* the OUTCOME note — the seller sees it once decided */
  const internalNote = _cleanText(data.internalNote, 1000);     /* moderators only — never sent to a seller */
  if (action === 'reopen' && internalNote.length < 10) {
    throw new HttpsError('invalid-argument', 'Reopening a decided report needs an internal note (at least 10 characters) saying why.');
  }
  if (isRestore && internalNote.length < 10) {
    throw new HttpsError('invalid-argument', 'Restoring a taken-down listing needs an internal note (at least 10 characters) saying why.');
  }
  const requestId = data.requestId == null ? null : (/^[A-Za-z0-9_-]{8,64}$/.test(String(data.requestId)) ? String(data.requestId) : undefined);
  if (requestId === undefined) throw new HttpsError('invalid-argument', 'Bad requestId.');
  const expectedRevision = Number.isInteger(data.expectedRevision) ? data.expectedRevision : null;
  const uid = req.auth.uid;
  const isSuper = !!req.auth.token.superAdmin;
  const actorRole = _actorRole(req);
  const takeover = action === 'claim' && data.takeover === true;
  const wantHide = !isAssign && !isRestore && REPORT_STATE[newStatus] === 'approved' && data.hideProduct === true;
  const applyToListing = !isAssign && !isRestore && (newStatus === 'actioned' || newStatus === 'dismissed') && data.applyToListing === true;
  /* RESTORE — the explicit reverse of a take-down, through the same canonical fields: only when DISMISSING the report
     (or listing group) that owns the listing's moderationHold, and only to the visibility the server recorded before it. */
  const wantRestore = isRestore || (!isAssign && newStatus === 'dismissed' && data.restoreListing === true);

  const db = getFirestore();
  const ref = db.collection('reports').doc(reportId);
  const correlationId = requestId || crypto.randomBytes(9).toString('hex');

  const out = await db.runTransaction(async (tx) => {
    /* ── reads ── */
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Report not found.');
    const report = snap.data() || {};
    const target = _targetOf(report.entityType);
    if (!target.supported) throw new HttpsError('failed-precondition', `Reports on "${report.entityType}" cannot be moderated here (unsupported target type).`);
    if (requestId && report.lastRequest && report.lastRequest.id === requestId && report.lastRequest.action === action) {
      return { replayed: true, report, result: report.lastRequest.result || {} };
    }
    const from = report.status || 'pending';
    const rev = Number.isInteger(report.revision) ? report.revision : 0;
    if (expectedRevision !== null && expectedRevision !== rev) {
      throw new HttpsError('failed-precondition', 'This report changed since you opened it. Reload it and decide again.');
    }
    const owner = report.assignedTo || null;
    const lockedOut = (r) => !!(r.assignedTo && r.assignedTo !== uid && !isSuper);

    if (isAssign) {
      if (!OPEN_STATUSES.includes(from)) throw new HttpsError('failed-precondition', `This report is already ${REPORT_STATE[from] || from}; it cannot be taken under review.`);
      if (action === 'claim') {
        if (owner === uid) return { noop: true, report, result: { assignedTo: uid } };
        if (owner && !(isSuper && takeover)) throw new HttpsError('failed-precondition', 'Another moderator has this report under review.');
      } else {
        if (!owner) return { noop: true, report, result: { assignedTo: null } };
        if (owner !== uid && !isSuper) throw new HttpsError('permission-denied', 'Only the reviewer who holds this report, or a super admin, can release it.');
      }
    } else if (isRestore) {
      if (from !== 'actioned') throw new HttpsError('failed-precondition', `This report is ${REPORT_STATE[from] || from}; only an upheld take-down can be restored from it.`);
      if (lockedOut(report)) throw new HttpsError('failed-precondition', 'Another moderator has this report under review.');
    } else {
      if (!(REPORT_TRANSITIONS[newStatus] || []).includes(from)) {
        throw new HttpsError('failed-precondition', `This report is already ${REPORT_STATE[from] || from}; it cannot be moved to ${REPORT_STATE[newStatus]}.`);
      }
      if (lockedOut(report)) throw new HttpsError('failed-precondition', 'Another moderator has this report under review.');
    }

    /* 1 listing + N reports: a decision on the LISTING resolves its other open reports — each keeps its own record */
    let siblings = [];
    if (applyToListing && report.entityId) {
      const qs = await tx.get(db.collection('reports').where('entityId', '==', String(report.entityId)).limit(100));
      siblings = qs.docs.filter((d) => d.id !== reportId).map((d) => ({ id: d.id, ref: d.ref, r: d.data() || {} }))
        .filter((x) => _normEntityType(x.r.entityType) === target.type && OPEN_STATUSES.includes(x.r.status || 'pending'));
      const locked = siblings.filter((x) => lockedOut(x.r));
      if (locked.length) throw new HttpsError('failed-precondition', `${locked.length} other report(s) on this listing are under review by another moderator.`);
    }

    /* enforcement exists for listings only; hideProduct on any other target is ignored (C2 behaviour) */
    const hide = wantHide && target.enforcement === 'listing_visibility';
    const restore = wantRestore && target.enforcement === 'listing_visibility';
    /* REVIEW ENFORCEMENT (2026-10-03): an UPHOLD removes the review, a RESTORE of that upheld report sends it back to
       PENDING (re-review — never straight to public); a dismiss touches no review. */
    const reviewTarget = target.enforcement === 'review_removal';
    const reviewRemove = reviewTarget && newStatus === 'actioned';
    const reviewRestore = reviewTarget && isRestore;
    if (isRestore && !restore && !reviewRestore) throw new HttpsError('failed-precondition', 'Only a listing take-down or a removed review can be restored.');
    if (reviewRestore && report.reviewEnforcement !== 'review_removed') {
      throw new HttpsError('failed-precondition', report.reviewEnforcement === 'review_restored'
        ? 'This review was already restored from this report.'
        : 'This report did not remove the review, so there is nothing to restore from it.');
    }
    let pref = null, psnap = null, other = [], promos = [];
    if (hide || restore) {
      pref = db.collection('products').doc(String(report.entityId));
      psnap = await tx.get(pref);
      const p0 = psnap.exists ? (psnap.data() || {}) : null;
      /* every read before any write: the other enforcement (restore only) and the listing's paid placements */
      if (restore && p0) other = await _otherEnforcement(tx, db, p0);
      if (p0) promos = await _promotionsFor(tx, db, report.entityId, hide ? 'active' : PROMO_PAUSED);
    }

    /* ── the review transition: the review owner's shared module, LAST among the reads (it reads the review and, for a
       product review, the product, then writes the review and ONE reviewModerationLog row) — so every read of this
       transaction still precedes every write. Its refusals (SELF_REVIEW, SELF_INTEREST, BAD_TRANSITION) abort the
       whole decision: the report does not move either. ── */
    let enforcement = 'none';
    let reviewResult = null;
    if (reviewRemove || reviewRestore) {
      const RM = _reviewModeration();
      const o = { db, FieldValue, kind: target.type === 'unboxing' ? 'unboxing' : 'review', reviewId: String(report.entityId),
        actorUid: uid, source: 'report:' + reportId,
        /* the review document is readable by its author (reviews) or by everyone (unboxingReviews): a FIXED note —
           never the reporter, the reason, the outcome note or the internal note */
        note: reviewRestore ? 'Restored for re-review after a report decision was reversed.' : 'Removed after a report about it was upheld.' };
      try {
        reviewResult = await (reviewRestore ? RM.restoreReview(tx, o) : RM.removeReview(tx, o));
      } catch (e) {
        if (!(e instanceof RM.ModerationError)) throw e;
        /* a review deleted since the report was filed: the uphold stands, nothing to remove (as product_missing) */
        if (reviewRemove && e.reason === 'NOT_FOUND') reviewResult = { missing: true };
        else throw new HttpsError(e.code, e.message, { reason: e.reason });
      }
      enforcement = reviewResult.missing ? 'review_missing'
        : reviewRestore ? 'review_restored'
          /* a re-uphold after a reopen finds the review still removed BY THIS REPORT: it stays this report's removal */
          : (reviewResult.unchanged ? (report.reviewEnforcement === 'review_removed' ? 'review_removed' : 'already_removed') : 'review_removed');
    }

    /* ── writes ── */
    const now = FieldValue.serverTimestamp();
    let promotionsChanged = 0;
    if (hide) {
      if (!psnap || !psnap.exists) enforcement = 'product_missing';
      else {
        const p = psnap.data() || {};
        /* never a second hide: a listing already held by moderation is left exactly as it is */
        if (p.isVisible === false && p.moderationHold) enforcement = 'already_hidden';
        else {
          enforcement = 'listing_hidden';
          const holdRef = _opaqueRef(reportId);
          tx.set(pref, { isVisible: false, moderationHold: { active: true, ref: holdRef, at: now, correlationId,
            previousIsVisible: p.isVisible !== false }, updatedAt: now }, { merge: true });
          /* paid placement never bypasses moderation: pause it (status only — financial history untouched) */
          for (const d of promos) {
            tx.update(d.ref, { status: PROMO_PAUSED, pausedFromStatus: 'active', pausedAt: now, pausedByRef: holdRef, updatedAt: now });
          }
          promotionsChanged = promos.length;
        }
      }
    }
    if (restore) {
      const p = psnap && psnap.exists ? (psnap.data() || {}) : null;
      const hold = p && p.moderationHold;
      if (!hold) throw new HttpsError('failed-precondition', 'This listing is not held by moderation; there is nothing to restore.');
      const owners = [reportId].concat(siblings.map((s) => s.id));
      const ownerId = _holdOwnedBy(hold, owners);
      if (!ownerId) {
        throw new HttpsError('failed-precondition', 'The listing is held by a different report. Restore it by deciding that report.');
      }
      if (other.length) {
        throw new HttpsError('failed-precondition', 'This listing cannot be restored: another enforcement still applies ('
          + other.join(', ') + '). Resolve that first.', { otherEnforcement: other });
      }
      const holder = ownerId === reportId ? report : (siblings.find((s) => s.id === ownerId) || {}).r || {};
      const prior = typeof hold.previousIsVisible === 'boolean' ? hold.previousIsVisible
        : (holder.context && typeof holder.context.isVisible === 'boolean' ? holder.context.isVisible : null);
      if (prior === null) throw new HttpsError('failed-precondition', 'The visibility of this listing before the hold is not recorded; it cannot be restored automatically.');
      enforcement = 'listing_restored';
      const ref0 = hold.ref || _opaqueRef(ownerId);
      tx.set(pref, { isVisible: prior, moderationHold: FieldValue.delete(),
        moderationReleased: { ref: ref0, at: now, correlationId, restoredVisibility: prior }, updatedAt: now }, { merge: true });
      for (const d of promos) {
        const x = d.data() || {};
        if (x.pausedByRef && x.pausedByRef !== ref0) continue;            /* paused by a different hold — not ours to resume */
        tx.update(d.ref, { status: x.pausedFromStatus || 'active', pausedFromStatus: FieldValue.delete(), pausedByRef: FieldValue.delete(),
          resumedAt: now, updatedAt: now });
        promotionsChanged++;
      }
    }
    const productHidden = enforcement === 'listing_hidden' || enforcement === 'already_hidden';

    /* one write + one audit row PER REPORT (the primary and each sibling resolved with it) */
    const apply = (id, docRef, r, primary) => {
      const f = r.status || 'pending';
      const rv = (Number.isInteger(r.revision) ? r.revision : 0) + 1;
      const patch = { revision: rv, lastActionAt: now, lastActionBy: uid };
      let to = f;
      if (action === 'claim') Object.assign(patch, { assignedTo: uid, assignedAt: now, assignedRole: actorRole });
      else if (action === 'unclaim') Object.assign(patch, { assignedTo: null, assignedAt: null });
      else if (isRestore && reviewRestore) {
        Object.assign(patch, { reviewEnforcement: 'review_restored', reviewRestoredAt: now, reviewRestoredBy: uid, internalNote,
          reviewModeration: { kind: target.type, from: reviewResult.from || null, to: reviewResult.status || null, unchanged: reviewResult.unchanged === true, missing: false, at: now } });
      }
      else if (isRestore) Object.assign(patch, { productHidden: false, listingRestoredAt: now, listingRestoredBy: uid, internalNote });
      else {
        to = newStatus;
        Object.assign(patch, { status: newStatus, reviewedBy: uid, reviewedAt: now, resolution });
        if (internalNote) patch.internalNote = internalNote;
        if (productHidden) patch.productHidden = true;
        if (enforcement === 'listing_restored') patch.productHidden = false;
        /* the review outcome is recorded on the PRIMARY report only — it is the one whose decision removed the review */
        if (primary && reviewResult) {
          patch.reviewEnforcement = enforcement;
          patch.reviewModeration = { kind: target.type, from: reviewResult.from || null, to: reviewResult.status || null,
            unchanged: reviewResult.unchanged === true, missing: reviewResult.missing === true, at: now };
        }
        if (action === 'escalate') {
          Object.assign(patch, { assignedTo: null, assignedAt: null,
            escalation: { by: uid, byRole: actorRole, at: now, note: internalNote || null, previousReviewer: r.assignedTo || null, nextAction: 'senior_review' } });
        }
        if (action === 'reopen') Object.assign(patch, { assignedTo: null, assignedAt: null, reopenedBy: uid, reopenedAt: now, reopenCount: FieldValue.increment(1) });
        if (!primary) patch.decidedWith = reportId;
      }
      if (primary && requestId) {
        patch.lastRequest = { id: requestId, action, correlationId, result: { status: to, moderationState: REPORT_STATE[to] || null, productHidden, enforcement } };
      }
      tx.update(docRef, patch);
      tx.create(db.collection('trustSafetyAudit').doc(_auditId(id, rv)), {
        action: isAssign ? 'report_' + action + 'ed' : (isRestore ? (reviewRestore ? 'review_restored' : 'listing_restored') : (action === 'reopen' ? 'report_reopened' : 'report_reviewed')),
        decision: action,
        reportId: id, reportRef: _opaqueRef(id),
        entityId: r.entityId || null, entityType: r.entityType || null,
        targetType: target.type, targetId: r.entityId || null,
        from: f, fromState: REPORT_STATE[f] || null, fromQueue: _queueStatusOf(r),
        result: to, resultState: REPORT_STATE[to] || null,
        productHidden: !isAssign && productHidden,
        enforcement: isAssign ? 'none' : enforcement,
        review: primary && reviewResult ? { kind: target.type, from: reviewResult.from || null, to: reviewResult.status || null,
          unchanged: reviewResult.unchanged === true, missing: reviewResult.missing === true } : null,
        promotions: primary && promotionsChanged ? { changed: promotionsChanged, to: enforcement === 'listing_hidden' ? PROMO_PAUSED : 'resumed' } : null,
        resolution: isAssign ? '' : resolution,
        internalNote: internalNote || null,
        assignedTo: action === 'claim' ? uid : (action === 'unclaim' ? null : (r.assignedTo || null)),
        performedBy: uid, actorRole,
        revision: rv, correlationId, requestId: requestId || null,
        groupSize: 1 + siblings.length, primary, decidedWith: primary ? null : reportId,
        createdAt: now,
      });
      return { id, from: f, to, rv, report: r };
    };
    const decided = [apply(reportId, ref, report, true)].concat(siblings.map((s) => apply(s.id, s.ref, s.r, false)));
    return { report, decided, productHidden, enforcement, reviewResult, reviewKind: reviewTarget ? target.type : null,
      result: { status: decided[0].to, moderationState: REPORT_STATE[decided[0].to] || null, productHidden, enforcement, promotionsChanged } };
  });

  const res = Object.assign({ success: true }, out.result, {
    queueStatus: null, revision: null, resolvedReports: out.decided ? out.decided.length : 0,
    replayed: !!out.replayed, noop: !!out.noop, correlationId: out.replayed ? (out.report.lastRequest || {}).correlationId || null : correlationId,
  });
  if (out.replayed || out.noop) {
    res.status = res.status || out.report.status || 'pending';
    res.moderationState = REPORT_STATE[res.status] || null;
    res.revision = Number.isInteger(out.report.revision) ? out.report.revision : 0;
    res.queueStatus = _queueStatusOf(out.report);
    res.productHidden = res.productHidden === true;
    return res;
  }
  const head = out.decided[0];
  res.revision = head.rv;
  res.queueStatus = _queueStatusOf(Object.assign({}, out.report, { status: head.to,
    assignedTo: action === 'claim' ? uid : (['unclaim', 'escalate', 'reopen'].includes(action) ? null : out.report.assignedTo) }));

  /* REVIEW (2026-10-03): the ratings summary is recomputed AFTER the commit, from approved reviews only, by the shared
     module — for kind 'review' only (an unboxing review has no ratingsSummary). Only when the review actually moved.
     A failed recompute does not undo the decision; it is reported as failed, never as done. */
  if (out.reviewResult) {
    res.review = { kind: out.reviewKind, enforcement: out.enforcement, from: out.reviewResult.from || null,
      status: out.reviewResult.status || null, unchanged: out.reviewResult.unchanged === true };
    res.ratingsSummary = null;
    const tId = out.reviewResult.targetId;
    if (out.reviewKind === 'review' && !out.reviewResult.unchanged && !out.reviewResult.missing && tId) {
      try {
        const sum = await _reviewModeration().recomputeRatingsSummary(db, FieldValue, String(tId));
        res.ratingsSummary = { status: 'recomputed', listingId: String(tId), avg: sum.avg, count: sum.count };
      } catch (e) {
        res.ratingsSummary = { status: 'failed', listingId: String(tId) };
      }
    }
  }

  // Ban the reported entity (user) if requested — only superAdmin can auto-ban; only on an upheld USER report
  if (data.banUser && isSuper && out.report.entityType === 'user' && newStatus === 'actioned') {
    await db.collection('users').doc(String(out.report.entityId)).update({
      status: 'banned',
      bannedAt: FieldValue.serverTimestamp(),
      bannedBy: uid,
      banReason: resolution || `Report actioned: ${out.report.reason}`,
    });
  }

  /* NOTIFICATIONS — after the decision committed, through the ONE notification authority (notify.js), recorded on the
     report and in the audit. A failure is recorded as a failure; nothing is claimed sent that notify() did not record. */
  if (!isAssign && !isRestore && ['actioned', 'dismissed', 'changes_requested'].includes(newStatus)) {
    res.notifications = await _notifyDecision(db, out.decided, newStatus, out.productHidden, resolution, correlationId);
  }
  if (isRestore) res.notifications = await _notifyRestore(db, out.decided[0], correlationId);
  return res;
});

/* Plain text only — notify() may place `body` inside an email; a product name is seller-controlled. */
function _plain(s, max) { return _cleanText(s, max || 80).replace(/[<>&"'`]/g, ''); }
let _notifier = null;   /* test seam: exports._setNotifier — production uses notify.js */
function _getNotify() {
  if (_notifier) return _notifier;
  /* FAIL CLOSED outside a Functions runtime. notify.js initialises the REAL firebase-admin: a local test harness that
     loads this file with only firebase-admin/firestore stubbed would otherwise write notifyLog / notifications to the
     live project through the developer's application-default credentials (it did, 2026-10-01 — see CHANGELOG C3).
     Cloud Run sets K_SERVICE; the functions framework sets FUNCTION_TARGET; the emulator sets FUNCTIONS_EMULATOR. */
  if (!(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.FUNCTIONS_EMULATOR === 'true')) return null;
  try { return require('./notify').notify; } catch (e) { return null; }
}
async function _notifyDecision(db, decided, newStatus, productHidden, resolution, correlationId) {
  const send = _getNotify();
  const results = [];
  const first = decided[0] && decided[0].report ? decided[0].report : {};
  const c = first.context || {};
  /* a report about a review names no review text and no listing to the reporter — just 'a review' */
  const name = _isReviewType(_normEntityType(first.entityType)) ? 'a review' : _plain(c.productName || 'your listing');
  const record = async (reportId, rv, audience, r) => {
    /* recorded on the report (the case view shows it in the history); revision unchanged — it is not a transition */
    try {
      await db.collection('reports').doc(reportId).update({ [`notifications.${audience}`]: Object.assign({ correlationId, revision: rv, at: FieldValue.serverTimestamp() }, r) });
    } catch (_) { /* the decision stands; a missing record is shown as "not recorded" by the console */ }
  };
  const fire = async (uid, msg, dedupeKey) => {
    if (!send) return { status: 'failed', reason: 'notification authority unavailable', type: 'system_update', key: dedupeKey };
    try {
      const r = await send({ uid, type: 'system_update', title: msg.title, body: msg.body, deepLink: msg.deepLink || null, dedupeKey, awaitDelivery: false });
      if (r && r.deduped) return { status: 'deduped', type: 'system_update', key: r.key || dedupeKey };
      const inapp = r && r.channels ? r.channels.inapp || null : null;
      return { status: inapp === 'sent' ? 'recorded' : 'failed', inapp: inapp || 'not_attempted', delivery: 'background', type: 'system_update', key: (r && r.key) || dedupeKey };
    } catch (e) {
      return { status: 'failed', reason: String((e && (e.code || e.message)) || 'error').slice(0, 120), type: 'system_update', key: dedupeKey };
    }
  };

  /* SELLER — one message per listing decision (not one per report) */
  const sellerUid = _normEntityType(first.entityType) === 'product' ? (c.sellerUid || null) : null;
  if (sellerUid) {
    const reason = _plain(first.reason || '', 80);
    const note = resolution ? ' SOKONI: ' + _plain(resolution, 300) : '';
    const msg = newStatus === 'actioned'
      ? (productHidden
        ? { title: 'Listing action taken', body: `Your listing "${name}" was reported (${reason}) and SOKONI has taken it down.${note}` }
        : { title: 'Report upheld on your listing', body: `A report on your listing "${name}" (${reason}) was upheld.${note}` })
      : newStatus === 'dismissed'
        ? { title: 'Report dismissed', body: `A report on your listing "${name}" was reviewed and dismissed. No action is needed.` }
        : { title: 'Change requested on your listing', body: `SOKONI reviewed a report on your listing "${name}" and asks for a change.${note}` };
    msg.deepLink = '/merchant-v2.html#disputes';
    const r = Object.assign({ audience: 'seller' }, await fire(sellerUid, msg, `moderation_seller_${_opaqueRef(String(first.entityId))}_${correlationId}`));
    results.push(r);
    await record(decided[0].id, decided[0].rv, 'seller', r);
  }
  /* REPORTERS — resolved, nothing more (no outcome, no admin detail); only once a report is decided */
  if (newStatus === 'actioned' || newStatus === 'dismissed') {
    for (const d of decided) {
      const who = d.report && d.report.reportedBy;
      if (!who) continue;
      const r = Object.assign({ audience: 'reporter', ref: _opaqueRef(d.id) }, await fire(who,
        { title: 'Your report was reviewed', body: `Thank you. SOKONI reviewed your report on "${name}". It is now resolved.` },
        `moderation_reporter_${_opaqueRef(d.id)}_r${d.rv}`));
      results.push(r);
      await record(d.id, d.rv, 'reporter', r);
    }
  }
  return results;
}

/* The seller is told the listing is back — through the same authority, recorded on the report, no reporter identity. */
async function _notifyRestore(db, head, correlationId) {
  const send = _getNotify();
  const c = (head && head.report && head.report.context) || {};
  if (!c.sellerUid) return [];
  const key = `moderation_restore_${_opaqueRef(String(head.report.entityId))}_r${head.rv}`;
  let r;
  if (!send) r = { status: 'failed', reason: 'notification authority unavailable', type: 'system_update', key };
  else {
    try {
      const x = await send({ uid: c.sellerUid, type: 'system_update', title: 'Listing restored',
        body: `Your listing "${_plain(c.productName || 'your listing')}" was reviewed again and SOKONI has restored it.`,
        deepLink: '/merchant-v2.html#disputes', dedupeKey: key, awaitDelivery: false });
      const inapp = x && x.channels ? x.channels.inapp || null : null;
      r = x && x.deduped ? { status: 'deduped', type: 'system_update', key }
        : { status: inapp === 'sent' ? 'recorded' : 'failed', inapp: inapp || 'not_attempted', delivery: 'background', type: 'system_update', key };
    } catch (e) { r = { status: 'failed', reason: String((e && (e.code || e.message)) || 'error').slice(0, 120), type: 'system_update', key }; }
  }
  r = Object.assign({ audience: 'seller' }, r);
  try {
    await db.collection('reports').doc(head.id).update({ 'notifications.sellerRestore': Object.assign({ correlationId, revision: head.rv, at: FieldValue.serverTimestamp() }, r) });
  } catch (_) { /* the restore stands; a missing record reads as "not recorded" */ }
  return [r];
}

/* exported for tests and for the one documented mapping (CHANGELOG 2026-10-01 "community C2" / "community C3") */
exports._reportModel = { REPORT_ENTITY_TYPES, REPORT_REASONS, REVIEW_REPORT_REASONS, REVIEW_EXCERPT_MAX, REPORT_STATE, REPORT_ACTIONS, REPORT_TRANSITIONS,
  REPORT_DETAIL_MAX, REPORT_DETAIL_MIN_WHEN_REQUIRED, OPEN_STATUSES, QUEUE_STATUS_STORED, ASSIGN_ACTIONS, MODERATION_TARGETS,
  SELLER_RESPONSE, PROMO_PAUSED, LISTING_ACTIONS: Object.freeze(['restore']), queueStatusOf: _queueStatusOf, sellerStatusOf: _sellerStatusOf, allowedActions: _allowedActions,
  holdOwnedBy: _holdOwnedBy, opaqueRef: _opaqueRef };
exports._setNotifier = (fn) => { _notifier = fn || null; };

/* ─────────────────────────────────────────────────────────────────────────
   4. tsBanUser — superAdmin: ban | suspend | restore user
──────────────────────────────────────────────────────────────────────────── */
exports.tsBanUser = onCall(OPT, async (req) => {
  _requireSuperAdmin(req);
  const { uid: targetUid, action, reason, durationDays } = req.data;
  if (!targetUid || !action || !reason) throw new Error('uid, action, reason required');
  const validActions = ['ban', 'suspend', 'restore'];
  if (!validActions.includes(action)) throw new Error('action must be ban|suspend|restore');

  const db = getFirestore();
  const userRef = db.collection('users').doc(targetUid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');

  const statusMap = { ban: 'banned', suspend: 'suspended', restore: 'active' };
  const update = {
    status: statusMap[action],
    statusUpdatedAt: FieldValue.serverTimestamp(),
    statusUpdatedBy: req.auth.uid,
  };

  if (action === 'ban') {
    update.bannedAt = FieldValue.serverTimestamp();
    update.bannedBy = req.auth.uid;
    update.banReason = reason;
  }
  if (action === 'suspend') {
    update.suspendReason = reason;
    update.suspendedUntil = durationDays
      ? new Date(Date.now() + durationDays * 86400000)
      : null;
  }
  if (action === 'restore') {
    update.bannedAt = null;
    update.banReason = null;
    update.suspendedUntil = null;
  }

  await userRef.update(update);

  await db.collection('trustSafetyAudit').add({
    action: `user_${action}`,
    entityId: targetUid,
    entityType: 'user',
    reason,
    performedBy: req.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { success: true, newStatus: statusMap[action] };
});

/* ─────────────────────────────────────────────────────────────────────────
   5. tsCalculateRiskScore — admin: compute composite risk score for entity
──────────────────────────────────────────────────────────────────────────── */
exports.tsCalculateRiskScore = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const { entityId, entityType } = req.data;
  if (!entityId || !entityType) throw new Error('entityId, entityType required');

  const db = getFirestore();
  let score = 0;
  const factors = [];

  if (entityType === 'user') {
    const [userSnap, reportsSnap, disputesSnap] = await Promise.all([
      db.collection('users').doc(entityId).get(),
      db.collection('reports').where('entityId', '==', entityId).where('status', '==', 'actioned').limit(10).get(),
      db.collection('escrows').where('buyerId', '==', entityId).where('status', '==', 'disputed').limit(10).get(),
    ]);

    if (!userSnap.exists) throw new Error('User not found');
    const u = userSnap.data();

    // Account age
    const ageDays = (Date.now() - (u.createdAt?.toMillis?.() || Date.now())) / 86400000;
    if (ageDays < 7)  { score += 30; factors.push({ name: 'Account < 7 days',   impact: 30 }); }
    else if (ageDays < 30) { score += 15; factors.push({ name: 'Account < 30 days', impact: 15 }); }

    // Verification
    if (!u.verified && !u.emailVerified) { score += 20; factors.push({ name: 'Unverified account', impact: 20 }); }

    // Status
    if (u.status === 'banned' || u.status === 'suspended') {
      score += 50; factors.push({ name: 'Previously restricted', impact: 50 });
    }

    // Actioned reports
    if (reportsSnap.size > 0) {
      const ri = reportsSnap.size * 15;
      score += ri;
      factors.push({ name: `${reportsSnap.size} actioned reports`, impact: ri });
    }

    // Disputes filed
    if (disputesSnap.size > 0) {
      const di = disputesSnap.size * 10;
      score += di;
      factors.push({ name: `${disputesSnap.size} disputes filed`, impact: di });
    }
  }

  score = Math.min(score, 100);
  const riskLevel = score >= 70 ? 'critical' : score >= 40 ? 'high' : score >= 20 ? 'medium' : 'low';

  await db.collection('riskScores').doc(entityId).set({
    entityId, entityType, score, riskLevel, factors,
    calculatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { score, riskLevel, factors };
});

/* ─────────────────────────────────────────────────────────────────────────
   6. tsGetRiskScores — admin: list high-risk entities
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetRiskScores = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const { riskLevel, entityType, limit: lim } = req.data;

  const db = getFirestore();
  let q = db.collection('riskScores').orderBy('score', 'desc').limit(Math.min(lim || 50, 200));
  if (riskLevel) q = q.where('riskLevel', '==', riskLevel);

  const snap = await q.get();
  let scores = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (entityType) scores = scores.filter(s => s.entityType === entityType);

  return { scores };
});

/* ─────────────────────────────────────────────────────────────────────────
   7. tsGetBannedTerms — admin: list all banned terms
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetBannedTerms = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const snap = await db.collection('bannedTerms').limit(500).get();
  return { terms: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ─────────────────────────────────────────────────────────────────────────
   8. tsManageBannedTerm — admin: add | delete a banned term
──────────────────────────────────────────────────────────────────────────── */
exports.tsManageBannedTerm = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const { action, termId, term } = req.data;
  const db = getFirestore();

  if (action === 'add') {
    if (!term) throw new Error('term required');
    const clean = term.toLowerCase().trim().slice(0, 100);
    await db.collection('bannedTerms').add({
      term: clean,
      addedBy: req.auth.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { success: true };
  }
  if (action === 'delete') {
    if (!termId) throw new Error('termId required');
    await db.collection('bannedTerms').doc(termId).delete();
    return { success: true };
  }
  throw new Error('action must be add|delete');
});

/* ─────────────────────────────────────────────────────────────────────────
   9. tsGetTrustDashboard — admin: aggregate stats
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetTrustDashboard = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const db = getFirestore();

  const [pending, actioned, dismissed, critical, banned, highRisk] = await Promise.all([
    db.collection('reports').where('status', '==', 'pending').limit(500).get(),
    db.collection('reports').where('status', '==', 'actioned').limit(500).get(),
    db.collection('reports').where('status', '==', 'dismissed').limit(500).get(),
    db.collection('reports').where('severity', '==', 'critical').where('status', '==', 'pending').limit(100).get(),
    db.collection('users').where('status', '==', 'banned').limit(500).get(),
    db.collection('riskScores').where('riskLevel', '==', 'high').limit(200).get(),
  ]);

  // Entity type breakdown of pending reports (in-memory)
  const breakdown = {};
  pending.docs.forEach(d => {
    const t = d.data().entityType || 'unknown';
    breakdown[t] = (breakdown[t] || 0) + 1;
  });

  return {
    pending: pending.size,
    actioned: actioned.size,
    dismissed: dismissed.size,
    criticalPending: critical.size,
    totalBanned: banned.size,
    highRiskEntities: highRisk.size,
    entityBreakdown: breakdown,
  };
});
