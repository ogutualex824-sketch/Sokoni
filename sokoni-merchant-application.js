/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Application — submission primitive  (stage 2A)

   ONE way for a merchant to file the request that starts the seller lifecycle:

     authenticated user
          ↓
     applications/{uid}--merchant        deterministic — no duplicates, ever
          ↓
     type: 'seller'                      the intake vocabulary; the SERVER
          ↓                              resolves it to a role
     status: 'pending_review'
          ↓
     ADMIN decision (applicationDecide)  ← everything past here is 2B

   ── What this module deliberately cannot do ─────────────────────────────────
   Submitting is a REQUEST, not a grant. This writes one document and nothing
   else: no role, no Auth claim, no shop, no subscription. `role` is not written
   at all — `resolveRole()` on the server derives it from `type: 'seller'`, and
   firestore.rules would reject the write anyway (`noAdminFields()` withholds
   `role`, and every other field an approval is made of).

   Anything a caller passes is filtered through FORBIDDEN below before it
   reaches the document, so a compromised or careless call site cannot smuggle
   `status: 'approved'`, `decidedBy`, or a claim into a submission. The status is
   not a caller input: it is set here.

   ── Identity ────────────────────────────────────────────────────────────────
   The application is scoped to the applicant AND to their shop, and those are
   two different identifiers. `sellerUid` is the account; `shopId` is the shop.
   When no shop exists yet, `shopId` is **null with a stated source** — it is
   never back-filled from the uid. A shop id that is silently the uid is how a
   single-shop assumption becomes permanent, and 2B is what actually establishes
   the canonical shop.

   ── Idempotency ─────────────────────────────────────────────────────────────
   The document id is derived from the uid, so re-submitting cannot fork a
   second application. What a re-submission does depends on the state the
   lifecycle is already in — see decideAction():

     (none)      → create,   pending_review
     pending     → update,   stays pending_review (profile edits are welcome)
     rejected    → resubmit, back to pending_review, resubmitCount++
     approved    → REFUSED — an approved merchant does not re-apply, and a
                   merge would reset a live merchant to pending
     suspended   → REFUSED — a suspended merchant must not clear their own
                   suspension by pressing a button

   Both refusals are reported to the caller, never swallowed.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantApplication = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var COLLECTION = 'applications';
  var DOC_SUFFIX = '--merchant';
  var SUBMITTED = 'pending_review';
  var TYPE = 'seller';

  /* Fields that decide, or assert, authority. A submission may never carry one.
     `role`, `approved*`, `verified` and friends are also refused by
     firestore.rules noAdminFields(); the rest are server-owned lifecycle state
     that a client writing them would corrupt rather than escalate. */
  var FORBIDDEN = [
    'role', 'roles', 'approved', 'approvedAt', 'approvedBy', 'adminApproved',
    'verified', 'isAdmin', 'admin', 'superAdmin', 'suspended', 'banned',
    'flagged', 'adminNote', 'commissionRate', 'featured',
    'claims', 'customClaims', 'sellerClaim',
    'decidedBy', 'decidedAt', 'reviewReason',
    'status', 'statusCanonical', 'decisionAppliedFor', 'projectionStatus',
    'projectionError', 'projectionReceipt', 'blockedFor', 'intakeVersion',
    'uid', 'sellerUid', 'applicationId',
  ];

  /* Profile fields a merchant may actually supply. An allowlist, not a
     denylist, so a new forbidden field cannot arrive by being forgotten. */
  var PROFILE_FIELDS = [
    'name', 'businessName', 'category', 'categoryLabel', 'description',
    'phone', 'email', 'location', 'city', 'area', 'county', 'address',
    'deliveryMethods', 'deliveryZones', 'stdRate', 'exprRate',
    'productTypes', 'storeName', 'storeTagline', 'logoUrl', 'website',
  ];

  var CANON_DECIDED = { approved: 1, active: 1, accepted: 1, verified: 1 };
  var CANON_REJECTED = { rejected: 1, declined: 1, denied: 1 };
  var CANON_SUSPENDED = { suspended: 1, revoked: 1, banned: 1, disabled: 1 };

  /* Mirrors the server's canonStatus() so the client reasons about the same
     four states the lifecycle does. 'pending_review' canonicalises to pending,
     which is exactly why the trigger grants nothing on submission. */
  function canonStatus(s) {
    var v = String(s || 'pending').toLowerCase();
    if (CANON_DECIDED[v]) return 'approved';
    if (CANON_REJECTED[v]) return 'rejected';
    if (CANON_SUSPENDED[v]) return 'suspended';
    return 'pending';
  }

  function docId(uid) {
    if (!uid) throw new Error('merchant application: uid is required');
    return String(uid) + DOC_SUFFIX;
  }

  var _s = function (v, n) {
    return String(v == null ? '' : v).slice(0, n || 200).replace(/[<>"]/g, '').trim();
  };

  /* Keep only what a merchant is allowed to describe about themselves. */
  function sanitizeProfile(profile) {
    var out = {};
    if (!profile || typeof profile !== 'object') return out;
    for (var i = 0; i < PROFILE_FIELDS.length; i++) {
      var k = PROFILE_FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(profile, k)) continue;
      var v = profile[k];
      if (v == null || v === '') continue;
      if (Array.isArray(v)) out[k] = v.map(function (x) { return _s(x, 60); }).filter(Boolean).slice(0, 30);
      else if (typeof v === 'number') out[k] = v;
      else out[k] = _s(v, k === 'description' ? 1000 : 200);
    }
    return out;
  }

  /* What a re-submission means, given what the lifecycle already decided. */
  function decideAction(existing) {
    if (!existing) return { action: 'create' };
    var st = canonStatus(existing.status);
    if (st === 'approved') {
      return { action: 'refused', reason: 'already_approved',
        message: 'This account is already an approved merchant — there is nothing to re-apply for.' };
    }
    if (st === 'suspended') {
      return { action: 'refused', reason: 'suspended',
        message: 'This merchant account is suspended. Contact support — a new application cannot lift a suspension.' };
    }
    if (st === 'rejected') return { action: 'resubmit' };
    return { action: 'update' };
  }

  /**
   * Build the document to write. PURE — no I/O, no clock, no globals — so the
   * exact bytes that would reach Firestore can be asserted in a test.
   *
   * @param {object} o
   *   uid          {string}  auth.uid — required (firestore.rules claimsOwner)
   *   shopId       {string|null} canonical shop id, or null when none exists yet
   *   shopIdSource {string}  where shopId came from — 'active_shop' |
   *                          'seller_registry' | 'none_yet'
   *   profile      {object}  merchant-supplied fields (filtered)
   *   existing     {object|null} the current application document, if any
   *   nowISO       {string}  timestamp (injected, so tests are deterministic)
   * @returns {{docId, data, action, reason?, message?}}
   */
  function buildDocument(o) {
    o = o || {};
    var uid = o.uid;
    if (!uid) throw new Error('merchant application: uid is required');

    var verdict = decideAction(o.existing);
    if (verdict.action === 'refused') {
      return { docId: docId(uid), data: null, action: 'refused',
        reason: verdict.reason, message: verdict.message };
    }

    var now = o.nowISO || new Date().toISOString();
    var profile = sanitizeProfile(o.profile);

    /* Belt and braces: even if PROFILE_FIELDS ever admitted one of these, it
       does not survive to the document. */
    for (var i = 0; i < FORBIDDEN.length; i++) delete profile[FORBIDDEN[i]];

    var data = {
      applicationId: docId(uid),
      /* Identity. `uid` is what firestore.rules matches against auth.uid;
         `sellerUid` is the same account stated in the merchant vocabulary, and
         `shopId` is a DIFFERENT identifier that is never derived from it. */
      uid: String(uid),
      sellerUid: String(uid),
      shopId: o.shopId != null && o.shopId !== '' ? String(o.shopId) : null,
      shopIdSource: o.shopIdSource || (o.shopId ? 'active_shop' : 'none_yet'),

      /* Intake vocabulary. NOT `role` — the server's resolveRole() owns that,
         and the rules would reject a client-written role anyway. */
      type: TYPE,
      hub: 'marketplace',

      /* Lifecycle. Set here, never accepted from the caller. */
      status: SUBMITTED,
      submittedAt: now,
      updatedAt: now,
      source: o.source || 'merchant-application',
    };

    for (var k in profile) if (Object.prototype.hasOwnProperty.call(profile, k)) data[k] = profile[k];

    if (verdict.action === 'create') {
      data.createdAt = now;
      data.resubmitCount = 0;
    } else if (verdict.action === 'resubmit') {
      data.resubmittedAt = now;
      data.resubmitCount = (Number(o.existing && o.existing.resubmitCount) || 0) + 1;
      /* A resubmission is a fresh request: the previous refusal must not be
         left on the document describing the new one. */
      data.previousRejectionReason = (o.existing && o.existing.reviewReason) || null;
    }

    return { docId: data.applicationId, data: data, action: verdict.action };
  }

  /**
   * Submit. Reads the existing application (deterministic id), decides, writes
   * at most one document via merge.
   *
   * `fs` is the Firestore adapter — injected so this is testable without a
   * browser and without network. Shape: { get(coll,id), set(coll,id,data) }.
   */
  async function submit(o) {
    o = o || {};
    if (!o.uid) throw new Error('merchant application: uid is required (sign in first)');
    if (!o.fs) throw new Error('merchant application: a firestore adapter is required');

    var id = docId(o.uid);
    var existing = await o.fs.get(COLLECTION, id);
    var built = buildDocument({
      uid: o.uid,
      shopId: o.shopId,
      shopIdSource: o.shopIdSource,
      profile: o.profile,
      existing: existing,
      nowISO: o.nowISO,
      source: o.source,
    });

    if (built.action === 'refused') {
      return { ok: false, applicationId: id, action: 'refused',
        reason: built.reason, message: built.message,
        status: canonStatus(existing && existing.status) };
    }

    await o.fs.set(COLLECTION, id, built.data, { merge: true });
    return { ok: true, applicationId: id, action: built.action, status: SUBMITTED };
  }

  return {
    COLLECTION: COLLECTION,
    DOC_SUFFIX: DOC_SUFFIX,
    SUBMITTED: SUBMITTED,
    TYPE: TYPE,
    FORBIDDEN: FORBIDDEN,
    PROFILE_FIELDS: PROFILE_FIELDS,
    docId: docId,
    canonStatus: canonStatus,
    sanitizeProfile: sanitizeProfile,
    decideAction: decideAction,
    buildDocument: buildDocument,
    submit: submit,
  };
}));
