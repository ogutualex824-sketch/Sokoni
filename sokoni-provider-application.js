/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Provider Application — submission primitive

   The services half of the dual-business intake. Its sibling
   `sokoni-merchant-application.js` files the PRODUCTS request; this files the
   SERVICES one, and an account may hold BOTH.

     authenticated user
          ↓
     applications/{uid}--provider        deterministic — no duplicates, ever
          ↓
     type: 'provider'                    intake vocabulary; the SERVER's
          ↓                              resolveRole() derives the role
     status: 'pending_review'
          ↓
     ADMIN decision (applicationDecide)

   ── WHY A SEPARATE DOCUMENT AND NOT A FIELD ────────────────────────────────

   A dual business is TWO approvals, not one application with two boxes ticked.
   They are decided separately, can be suspended separately, and a cyber café
   whose seller approval is withdrawn must keep providing services. One
   document with a `scopes: ['products','services']` array could not express a
   half-suspension without inventing a per-scope status inside it — which is
   two documents wearing a trench coat.

   It also means neither application had to change to make dual work. The
   merchant intake is certified machinery; this sits beside it.

   ── WHY THIS REUSES ITS SIBLING RATHER THAN COPYING IT ─────────────────────

   The rules that make a submission safe — the FORBIDDEN field filter, the
   resubmission semantics, the status canonicalisation — are IDENTICAL for both
   halves, and two copies of a security filter is one copy that will be updated
   and one that will not. So the pure parts are imported from the merchant
   module and only the intake vocabulary differs here.

   ── WHAT THIS CANNOT DO ────────────────────────────────────────────────────

   Submitting is a REQUEST, not a grant. It writes one document: no role, no
   claim, no provider registry record, no subscription. `providers/{uid}` state
   fields are written ONLY by projectProvider() on admin approval — the
   self-service wizard was explicitly stopped from reaching them
   (provider-onboarding.js:395). This changes none of that.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var merchant = (typeof module === 'object' && module.exports)
    ? require('./sokoni-merchant-application.js')
    : root.SokoniMerchantApplication;
  var api = factory(merchant);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniProviderApplication = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (merchant) {
  'use strict';

  if (!merchant) {
    throw new Error('sokoni-provider-application: sokoni-merchant-application.js must load first');
  }

  var COLLECTION = 'applications';
  var DOC_SUFFIX = '--provider';
  var SUBMITTED  = 'pending_review';
  var TYPE       = 'provider';

  function docId(uid) { return String(uid) + DOC_SUFFIX; }

  /* Build the submission. Deliberately delegates every SAFETY decision to the
     merchant module: same forbidden-field filter, same resubmission rules,
     same status canonicalisation. Only the vocabulary is ours. */
  function buildDocument(o) {
    o = o || {};
    var verdict = merchant.decideAction(o.existing);

    if (verdict.action === 'refused') {
      return { docId: docId(o.uid), data: null, action: 'refused',
        reason: verdict.reason, message: verdict.message };
    }
    if (o.agreementAccepted !== true) {
      return { docId: docId(o.uid), data: null, action: 'refused',
        reason: 'agreement_not_accepted',
        message: 'Accept the Provider Agreement before submitting — an application without it cannot be approved.' };
    }

    var now = o.nowISO || new Date().toISOString();
    var profile = merchant.sanitizeProfile(o.profile || {});

    /* Strip anything an approval is made of, using the SIBLING'S list so the
       two can never drift. A caller cannot smuggle status, role or a claim. */
    var clean = {};
    Object.keys(profile).forEach(function (k) {
      if (merchant.FORBIDDEN.indexOf(k) === -1) clean[k] = profile[k];
    });

    var data = {
      applicationId:     docId(o.uid),
      uid:               String(o.uid),
      providerUid:       String(o.uid),
      type:              TYPE,
      hub:               'service',
      status:            SUBMITTED,
      agreementAccepted: true,
      submittedAt:       now,
      source:            o.source || 'business-apply',
    };
    Object.keys(clean).forEach(function (k) { data[k] = clean[k]; });

    if (verdict.action === 'create')        data.resubmitCount = 0;
    else if (verdict.action === 'resubmit') {
      data.resubmittedAt = now;
      data.resubmitCount = (Number(o.existing && o.existing.resubmitCount) || 0) + 1;
    }

    return { docId: data.applicationId, data: data, action: verdict.action };
  }

  async function submit(o) {
    o = o || {};
    if (!o.uid) throw new Error('provider application: uid is required (sign in first)');
    if (!o.fs)  throw new Error('provider application: a firestore adapter is required');

    var id = docId(o.uid);
    var existing = await o.fs.get(COLLECTION, id);
    var built = buildDocument({
      uid: o.uid, profile: o.profile, existing: existing,
      nowISO: o.nowISO, source: o.source, agreementAccepted: o.agreementAccepted,
    });

    if (built.action === 'refused') {
      return { ok: false, applicationId: id, action: 'refused',
        reason: built.reason, message: built.message,
        status: merchant.canonStatus(existing && existing.status) };
    }

    await o.fs.set(COLLECTION, id, built.data, { merge: true });
    return { ok: true, applicationId: id, action: built.action, status: SUBMITTED };
  }

  return {
    COLLECTION: COLLECTION, DOC_SUFFIX: DOC_SUFFIX,
    SUBMITTED: SUBMITTED, TYPE: TYPE,
    docId: docId, buildDocument: buildDocument, submit: submit,
  };
}));
