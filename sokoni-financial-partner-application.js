/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Financial Partner Application — submission primitive (2026-10-01)

   The Banking Hub "apply to be listed" intake: banks, SACCOs, accountants,
   financial advisers, insurers, microfinance, investment and forex firms, chamas.

     authenticated user
          ↓
     applications/{uid}--financial_partner   deterministic — no duplicates
          ↓
     requestedRole: 'financial_partner'      the server's resolveRole() honours it
          ↓
     status: 'pending_review'
          ↓
     ADMIN decision (AdminOS Applications → applicationDecide)
          ↓
     applicationLifecycle → financialProviders/{uid}   (server-written listing)

   Sibling of sokoni-provider-application.js, and for the same reason it imports
   the merchant module's pure parts: the forbidden-field filter, the resubmission
   rules and the status canonicalisation must be ONE copy. Only the vocabulary
   and the profile fields are ours.

   WHAT THIS CANNOT DO. Submitting is a REQUEST. It writes one document: no role,
   no claim, no listing. The checks below exist so an applicant hears about a
   mistake before submitting; the SERVER (functions/financial-partner-listing.js)
   re-validates every field and is the only authority. Nothing here can make a
   listing "verified": licenceClaimed is self-declared text and is labelled so.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var merchant = (typeof module === 'object' && module.exports)
    ? require('./sokoni-merchant-application.js')
    : root.SokoniMerchantApplication;
  var api = factory(merchant);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniFinancialPartnerApplication = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (merchant) {
  'use strict';

  if (!merchant) {
    throw new Error('sokoni-financial-partner-application: sokoni-merchant-application.js must load first');
  }

  var COLLECTION = 'applications';
  var DOC_SUFFIX = '--financial_partner';
  var SUBMITTED  = 'pending_review';
  var ROLE       = 'financial_partner';

  /* Mirrors functions/financial-partner-listing.js. The server list wins on any drift. */
  var INSTITUTION_TYPES = [
    ['BANK', 'Bank'], ['SACCO', 'SACCO'], ['ACCOUNTANT', 'Accountant'],
    ['FINANCIAL_ADVISER', 'Financial adviser'], ['INSURER', 'Insurer'],
    ['MICROFINANCE', 'Microfinance'], ['INVESTMENT', 'Investment firm'],
    ['FOREX', 'Forex bureau'], ['CHAMA', 'Chama'], ['OTHER', 'Other'],
    ['DIGITAL_LENDER', 'Digital lender'], ['PAYMENT_PROVIDER', 'Payment / M-Pesa business services'],
    ['BUSINESS_FINANCE', 'Business loans / merchant finance'],
  ];
  var SERVICES = [
    ['BANK_ACCOUNTS', 'Bank accounts'], ['BUSINESS_BANKING', 'Business banking'],
    ['LOANS', 'Loans'], ['MERCHANT_FINANCE', 'Merchant finance'], ['SAVINGS', 'Savings'],
    ['INSURANCE', 'Insurance'], ['INVESTMENTS', 'Investments'], ['FOREX', 'Forex'],
    ['PAYMENTS', 'Payments'], ['ACCOUNTING', 'Accounting'], ['TAX', 'Tax'],
    ['ADVISORY', 'Advisory'], ['CHAMA_SERVICES', 'Chama services'], ['MICROFINANCE', 'Microfinance'],
    ['DIGITAL_LOANS', 'Digital loans'], ['MOBILE_MONEY', 'Mobile money'],
  ];
  var COUNTIES = [
    'Mombasa', 'Kwale', 'Kilifi', 'Tana River', 'Lamu', 'Taita Taveta', 'Garissa',
    'Wajir', 'Mandera', 'Marsabit', 'Isiolo', 'Meru', 'Tharaka Nithi', 'Embu',
    'Kitui', 'Machakos', 'Makueni', 'Nyandarua', 'Nyeri', 'Kirinyaga', "Murang'a",
    'Kiambu', 'Turkana', 'West Pokot', 'Samburu', 'Trans Nzoia', 'Uasin Gishu',
    'Elgeyo Marakwet', 'Nandi', 'Baringo', 'Laikipia', 'Nakuru', 'Narok',
    'Kajiado', 'Kericho', 'Bomet', 'Kakamega', 'Vihiga', 'Bungoma', 'Busia',
    'Siaya', 'Kisumu', 'Homa Bay', 'Migori', 'Kisii', 'Nyamira', 'Nairobi',
  ];
  var _codes = function (pairs) { return pairs.map(function (p) { return p[0]; }); };

  function docId(uid) { return String(uid) + DOC_SUFFIX; }

  function _text(v, max) {
    return typeof v === 'string'
      ? v.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
      : '';
  }

  /** Field-level checks. Returns { ok, errors: {field: message}, profile }. */
  function validate(input) {
    var i = input || {}, errors = {}, p = {};
    var name = _text(i.institutionName, 120);
    if (name.length < 2) errors.institutionName = 'Enter the institution’s registered name (2 to 120 characters).';
    else p.institutionName = name;

    var type = typeof i.institutionType === 'string' ? i.institutionType.trim().toUpperCase() : '';
    if (_codes(INSTITUTION_TYPES).indexOf(type) < 0) errors.institutionType = 'Choose the type of institution.';
    else p.institutionType = type;

    var svc = [];
    (Array.isArray(i.services) ? i.services : []).forEach(function (s) {
      var k = typeof s === 'string' ? s.trim().toUpperCase() : '';
      if (_codes(SERVICES).indexOf(k) > -1 && svc.indexOf(k) < 0 && svc.length < 8) svc.push(k);
    });
    if (!svc.length) errors.services = 'Choose at least one service (up to 8).';
    else p.services = svc;

    var desc = _text(i.description, 300);
    if (desc) p.description = desc;

    if (i.county) {
      var key = String(i.county).toLowerCase().replace(/[^a-z]/g, '');
      var c = COUNTIES.filter(function (x) { return x.toLowerCase().replace(/[^a-z]/g, '') === key; })[0];
      if (c) p.county = c; else errors.county = 'Choose a county from the list.';
    }
    if (i.website) {
      var w = String(i.website).trim(), u = null;
      try { u = new URL(w); } catch (_) { u = null; }
      if (!u || u.protocol !== 'https:' || u.username || u.password || u.hostname.indexOf('.') < 0 || w.length > 200 || /\s/.test(w)) {
        errors.website = 'Use a full https:// address, for example https://yourbank.co.ke.';
      } else p.website = u.href;
    }
    if (i.businessEmail) {
      var e = String(i.businessEmail).trim().toLowerCase();
      if (e.length > 120 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) errors.businessEmail = 'Enter a valid business email.';
      else p.businessEmail = e;
    }
    if (i.businessPhone) {
      var d = String(i.businessPhone).replace(/\D/g, ''), local = null;
      if (/^0[17]\d{8}$/.test(d)) local = d.slice(1);
      else if (/^[17]\d{8}$/.test(d)) local = d;
      else if (/^254[17]\d{8}$/.test(d)) local = d.slice(3);
      if (!local) errors.businessPhone = 'Enter a Kenyan number, for example 0712 345 678.';
      else p.businessPhone = '+254' + local;
    }
    var lic = _text(i.licenceClaimed, 60);
    if (lic) p.licenceClaimed = lic;

    return { ok: Object.keys(errors).length === 0, errors: errors, profile: p };
  }

  function buildDocument(o) {
    o = o || {};
    var verdict = merchant.decideAction(o.existing);
    if (verdict.action === 'refused') {
      var msg = verdict.reason === 'already_approved'
        ? 'This account is already a listed financial partner. Manage the listing from your partner dashboard.'
        : verdict.reason === 'suspended'
          ? 'This listing is suspended. Contact support: a new application cannot lift a suspension.'
          : verdict.message;
      return { docId: docId(o.uid), data: null, action: 'refused', reason: verdict.reason, message: msg };
    }
    if (o.agreementAccepted !== true) {
      return { docId: docId(o.uid), data: null, action: 'refused', reason: 'agreement_not_accepted',
        message: 'Accept the SOKONI Business Agreement before submitting.' };
    }
    var v = validate(o.input);
    if (!v.ok) {
      return { docId: docId(o.uid), data: null, action: 'refused', reason: 'invalid_fields',
        message: 'Some details need fixing.', errors: v.errors };
    }
    var now = o.nowISO || new Date().toISOString();
    var label = INSTITUTION_TYPES.filter(function (t) { return t[0] === v.profile.institutionType; })[0];
    var data = {
      applicationId:     docId(o.uid),
      uid:               String(o.uid),
      requestedRole:     ROLE,
      type:              ROLE,
      hub:               'banking',
      category:          v.profile.institutionType,
      categoryLabel:     label ? label[1] : v.profile.institutionType,
      status:            SUBMITTED,
      agreementAccepted: true,
      submittedAt:       now,
      source:            o.source || 'business-apply',
    };
    Object.keys(v.profile).forEach(function (k) {
      if (merchant.FORBIDDEN.indexOf(k) === -1) data[k] = v.profile[k];
    });
    if (verdict.action === 'create') data.resubmitCount = 0;
    else if (verdict.action === 'resubmit') {
      data.resubmittedAt = now;
      data.resubmitCount = (Number(o.existing && o.existing.resubmitCount) || 0) + 1;
    }
    return { docId: data.applicationId, data: data, action: verdict.action };
  }

  async function submit(o) {
    o = o || {};
    if (!o.uid) throw new Error('financial partner application: uid is required (sign in first)');
    if (!o.fs)  throw new Error('financial partner application: a firestore adapter is required');
    var id = docId(o.uid);
    var existing = await o.fs.get(COLLECTION, id);
    var built = buildDocument({ uid: o.uid, input: o.input, existing: existing, nowISO: o.nowISO,
      source: o.source, agreementAccepted: o.agreementAccepted });
    if (built.action === 'refused') {
      return { ok: false, applicationId: id, action: 'refused', reason: built.reason, message: built.message,
        errors: built.errors || null, status: merchant.canonStatus(existing && existing.status) };
    }
    await o.fs.set(COLLECTION, id, built.data, { merge: true });
    return { ok: true, applicationId: id, action: built.action, status: SUBMITTED };
  }

  return {
    COLLECTION: COLLECTION, DOC_SUFFIX: DOC_SUFFIX, SUBMITTED: SUBMITTED, ROLE: ROLE,
    INSTITUTION_TYPES: INSTITUTION_TYPES, SERVICES: SERVICES, COUNTIES: COUNTIES,
    docId: docId, validate: validate, buildDocument: buildDocument, submit: submit,
  };
}));
