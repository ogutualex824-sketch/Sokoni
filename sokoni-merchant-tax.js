/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Tax — the client layer (2D-2 Tax Stage 2)

   Built on the eight authorities the Receipts/Tax census classified SAFE, and
   nothing else:

       etimsGetProfile        own profile          etimsProfiles/{auth.uid}
       etimsRegisterSeller    first-time setup     writes etimsProfiles/{auth.uid}
       etimsUpdateProfile     invoice config       allow-listed fields only
       etimsValidatePin       KRA PIN format       stateless, touches nothing
       etimsGetSellerStats    status + figures     invoices WHERE sellerUid == uid
       etimsGenerateInvoice   one order            rejects unless order.sellerUid == uid
       etimsBulkGenerate      a period             orders WHERE sellerUid == uid
       etimsResubmitInvoice   a failure            rejects unless inv.sellerUid == uid

   ── Tax identity is ACCOUNT-scoped, and no identifier is ever sent ──────────
   `etimsProfiles/{auth.uid}` uses the Firebase uid *directly as the document
   id*. Not `sellers/{id}`, not `merchants/{id}`, not `shops/{shopId}`, not a
   claim. Every merchant-facing eTIMS callable derives `sellerUid` from
   `req.auth.uid` and either queries by it or checks it against the resource.

   So this module sends **no merchant identifier at all** — no sellerUid, no
   merchantId, no shopId. There is nothing for a browser to get wrong, and
   nothing for the census's "a client-supplied scope id is not authoritative"
   rule to bite on. `assertNoIdentity()` below makes that a property of the
   code rather than an intention.

   The consequence, which the surface must state plainly: a seller operating
   two shops has ONE KRA PIN, one invoice prefix and one invoice sequence
   across both. That is almost certainly correct — the PIN belongs to the
   taxpayer, not the outlet — but it is account-level, and a two-shop merchant
   who is not told so will read it as a bug.

   ── No Firestore access ─────────────────────────────────────────────────────
   None. `etimsProfiles`, `etimsInvoices`, `etimsCredentials` and
   `etimsSequences` are not client-readable and must not become so; credentials
   are stored encrypted and are never returned by any callable bound here.

   ── Not bound, deliberately ─────────────────────────────────────────────────
       etimsGetBuyerReceipts   a BUYER authority (orders WHERE buyerUid == uid).
                               Correct, but it is not the merchant's data.
       etimsGetAdminStats      admin-only.
       etimsPlatformInvoice    admin-only; uses the PLATFORM KRA PIN.
       hubUpdateTaxConfig      admin-only.
       hubRegisterEtims        admin-only.
       calculateTaxBreakdown   a quote, not a record of tax actually charged.
                               Showing it beside real filed figures would invite
                               it to be read as one.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantTax = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CALLABLES = {
    profile:  'etimsGetProfile',
    register: 'etimsRegisterSeller',
    update:   'etimsUpdateProfile',
    validate: 'etimsValidatePin',
    stats:    'etimsGetSellerStats',
    invoice:  'etimsGenerateInvoice',
    bulk:     'etimsBulkGenerate',
    resubmit: 'etimsResubmitInvoice',
  };

  /* Tax identity is the caller's uid. Any of these appearing in a payload would
     mean this module had started naming a merchant instead of being one. */
  var FORBIDDEN_KEYS = ['sellerUid', 'sellerId', 'merchantId', 'shopId', 'uid', 'ownerId', 'ownerUid'];

  function assertNoIdentity(payload) {
    var p = payload || {};
    for (var i = 0; i < FORBIDDEN_KEYS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(p, FORBIDDEN_KEYS[i])) {
        throw new Error('merchant tax: ' + FORBIDDEN_KEYS[i] + ' must never be sent — ' +
          'the server derives tax identity from auth.uid');
      }
    }
    return p;
  }

  /* Mirrors KRA_PIN_RE in functions/etims.js. The SERVER is the authority and
     performs a live KRA check in production; this only lets the screen refuse an
     obviously malformed PIN with the same wording instead of a round trip. */
  var KRA_PIN_RE = /^[A-Z]\d{9}[A-Z]$/;
  function pinProblem(raw) {
    var p = normalisePin(raw);
    if (!p) return 'Enter your KRA PIN.';
    if (!KRA_PIN_RE.test(p)) return 'Expected format: P051234567T (letter, 9 digits, letter).';
    return null;
  }
  function normalisePin(raw) { return String(raw == null ? '' : raw).toUpperCase().trim(); }

  /* The exact allow-list etimsUpdateProfile accepts. Sending anything else is
     silently dropped by the server, which would make the screen look like it
     saved something it did not. */
  var EDITABLE_FIELDS = [
    { id: 'businessName',  label: 'Business name',   max: 120, hint: 'As registered with KRA' },
    { id: 'vatStatus',     label: 'VAT status',      max: 20,  hint: '', options: ['registered', 'exempt', 'not_registered'] },
    { id: 'taxCategory',   label: 'Tax category',    max: 2,   hint: 'KRA rate class', options: ['A', 'B', 'C', 'D', 'E'] },
    { id: 'invoicePrefix', label: 'Invoice prefix',  max: 6,   hint: 'Up to 6 characters, e.g. INV' },
    { id: 'address',       label: 'Business address', max: 200, hint: '' },
    { id: 'phone',         label: 'Business phone',  max: 20,  hint: '' },
  ];
  var EDITABLE_IDS = EDITABLE_FIELDS.map(function (f) { return f.id; });

  /* Fields etimsRegisterSeller requires and which can never be changed later
     through etimsUpdateProfile — they are credentials or tax identity. */
  var REGISTRATION_ONLY = ['kraPin', 'branchId', 'deviceSerial', 'taxpayerSecret'];

  var VAT_LABELS = {
    registered: 'VAT registered',
    exempt: 'VAT exempt',
    not_registered: 'Not VAT registered',
  };

  function _unwrap(res) { return (res && res.data) ? res.data : res; }

  async function _call(fn, payload, failMessage) {
    if (typeof fn !== 'function') throw new Error('merchant tax: callable is required');
    assertNoIdentity(payload);
    try {
      var d = _unwrap(await fn(payload || {}));
      if (d && d.ok === false) return { ok: false, error: d.error || failMessage };
      return Object.assign({ ok: true }, d || {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || failMessage, code: (e && e.code) || null };
    }
  }

  /* ── Profile ──────────────────────────────────────────────────────────────
     "No profile" is a real, expected answer for a merchant who has not set up
     eTIMS — it is not an error and must not be rendered as one. */
  async function loadProfile(o) {
    var r = await _call(o.callProfile, {}, 'Your tax profile could not be loaded.');
    if (!r.ok) return r;
    var p = r.profile || null;
    return {
      ok: true,
      registered: !!p,
      profile: p ? normaliseProfile(p) : null,
    };
  }

  function normaliseProfile(p) {
    return {
      kraPin: p.kraPin || null,
      businessName: p.businessName || null,
      vatStatus: p.vatStatus || null,
      taxCategory: p.taxCategory || null,
      branchId: p.branchId || null,
      invoicePrefix: p.invoicePrefix || null,
      address: p.address || '',
      phone: p.phone || '',
      status: p.status || null,
      kraVerified: p.kraVerified === true,
      /* Counters kept on the profile document. A missing counter stays null so
         the surface renders a dash — never a 0 that means "unknown". */
      totalInvoices: numOrNull(p.totalInvoices),
      pendingInvoices: numOrNull(p.pendingInvoices),
      failedInvoices: numOrNull(p.failedInvoices),
      lastSubmissionAt: p.lastSubmissionAt || null,
      enabledAt: p.enabledAt || null,
    };
  }
  function numOrNull(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

  /* ── Registration ─────────────────────────────────────────────────────────
     The taxpayer secret and device serial go to the server, are encrypted
     there, and are never read back by any callable this module binds. */
  function buildRegistration(o) {
    var problem = pinProblem(o.kraPin);
    if (problem) throw new Error(problem);
    if (!String(o.businessName || '').trim()) throw new Error('Enter your business name.');
    if (!String(o.deviceSerial || '').trim()) throw new Error('Enter your eTIMS device serial.');
    if (!String(o.taxpayerSecret || '').trim()) throw new Error('Enter your taxpayer secret.');
    return assertNoIdentity({
      kraPin: normalisePin(o.kraPin),
      businessName: String(o.businessName).trim(),
      branchId: String(o.branchId || '00').trim(),
      deviceSerial: String(o.deviceSerial).trim(),
      taxpayerSecret: String(o.taxpayerSecret).trim(),
      vatStatus: o.vatStatus || 'registered',
      taxCategory: o.taxCategory || 'A',
      invoicePrefix: String(o.invoicePrefix || 'INV').toUpperCase().trim().slice(0, 6),
      address: String(o.address || ''),
      phone: String(o.phone || ''),
    });
  }

  async function register(o) {
    return _call(o.callRegister, buildRegistration(o),
      'eTIMS registration could not be completed.');
  }

  async function validatePin(o) {
    var p = normalisePin(o.kraPin);
    if (!p) return { ok: false, error: 'Enter your KRA PIN.' };
    return _call(o.callValidate, { kraPin: p }, 'The PIN could not be checked.');
  }

  /* ── Profile update ───────────────────────────────────────────────────────
     Only the six allow-listed fields, and only those that actually changed, so
     a "saved" toast always corresponds to a real write. */
  function buildUpdate(o) {
    var src = o.fields || {};
    var update = {};
    EDITABLE_FIELDS.forEach(function (f) {
      if (!Object.prototype.hasOwnProperty.call(src, f.id)) return;
      var v = String(src[f.id] == null ? '' : src[f.id]);
      if (v.length > f.max) throw new Error(f.label + ' must be ' + f.max + ' characters or fewer.');
      if (f.options && v && f.options.indexOf(v) === -1) {
        throw new Error(f.label + ' must be one of: ' + f.options.join(', ') + '.');
      }
      update[f.id] = v;
    });
    REGISTRATION_ONLY.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(src, k)) {
        throw new Error('merchant tax: ' + k + ' cannot be changed after registration.');
      }
    });
    if (!Object.keys(update).length) throw new Error('Nothing has changed.');
    return assertNoIdentity(update);
  }

  async function updateProfile(o) {
    return _call(o.callUpdate, buildUpdate(o), 'Your tax settings could not be saved.');
  }

  /* ── Status and figures ───────────────────────────────────────────────────
     One call. Every figure is derived server-side from invoices the caller owns.
     Nothing here is computed locally: a client-side total over a truncated list
     would be a fabricated metric (CLAUDE.md), and the server already caps its
     own queries at 30/20/20 documents. */
  async function loadStats(o) {
    var r = await _call(o.callStats, {}, 'Your eTIMS figures could not be loaded.');
    if (!r.ok) return r;
    /* etimsGetSellerStats returns { profile:null, stats:null } for an
       unregistered account — a real answer, not a failure. */
    if (!r.profile) return { ok: true, registered: false, stats: null, recent: [], failed: [] };
    var s = r.stats || {};
    return {
      ok: true,
      registered: true,
      profile: normaliseProfile(r.profile),
      stats: {
        totalRevenue: numOrNull(s.totalRevenue),
        vatCollected: numOrNull(s.vatCollected),
        acceptedCount: numOrNull(s.acceptedCount),
        failedCount: numOrNull(s.failedCount),
        pendingCount: numOrNull(s.pendingCount),
      },
      recent: (r.recentInvoices || []).map(normaliseInvoice),
      failed: (r.failedInvoices || []).map(normaliseInvoice),
      /* The server truncates. Saying so is the difference between a list and a
         claim about a list. */
      recentCap: 15,
      failedCap: 10,
    };
  }

  function normaliseInvoice(i) {
    i = i || {};
    return {
      invoiceId: i.invoiceId || null,
      invoiceNumber: i.invoiceNumber || null,
      orderId: i.orderId || null,
      total: numOrNull(i.total),
      vat: numOrNull(i.vat),
      status: i.status || null,
      receiptNumber: i.receiptNumber || null,
      error: i.error || null,
      createdAt: i.createdAt || null,
    };
  }

  /* ── Invoice actions ──────────────────────────────────────────────────────
     Each names a RESOURCE (an order, an invoice, a date range) and never a
     merchant. The server checks ownership of that resource against auth.uid. */
  async function generateInvoice(o) {
    var orderId = String(o.orderId || '').trim();
    if (!orderId) return { ok: false, error: 'Enter the order number.' };
    return _call(o.callInvoice, { orderId: orderId },
      'The invoice could not be generated.');
  }

  async function resubmitInvoice(o) {
    var invoiceId = String(o.invoiceId || '').trim();
    if (!invoiceId) return { ok: false, error: 'No invoice selected.' };
    return _call(o.callResubmit, { invoiceId: invoiceId },
      'The invoice could not be resubmitted.');
  }

  function buildBulk(o) {
    var start = String(o.periodStart || '').trim();
    var end = String(o.periodEnd || '').trim();
    if (!start || !end) throw new Error('Choose both a start and an end date.');
    if (start > end) throw new Error('The start date must come before the end date.');
    var p = { periodStart: start, periodEnd: end };
    if (o.billingPeriod) p.billingPeriod = String(o.billingPeriod);
    return assertNoIdentity(p);
  }

  async function bulkGenerate(o) {
    return _call(o.callBulk, buildBulk(o), 'The bulk invoices could not be generated.');
  }

  /* ── Display ──────────────────────────────────────────────────────────────
     Unknown is an em dash. A real zero is zero. */
  function formatCount(n) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '—';
    return Number(n).toLocaleString('en-KE');
  }
  function formatKes(n) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '—';
    return 'KSh ' + Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function vatLabel(status) { return VAT_LABELS[status] || (status || '—'); }

  function formatDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* A profile can exist without being usable. Distinguishing the states is the
     whole point of a status line — "registered" and "submitting to KRA" are not
     the same claim. */
  function statusOf(profile) {
    if (!profile) return { key: 'none', label: 'Not set up', tone: 'idle' };
    if (profile.status !== 'active') {
      return { key: 'inactive', label: 'Registered, not active', tone: 'warn' };
    }
    if (!profile.kraVerified) {
      return { key: 'unverified', label: 'Active, PIN not verified with KRA', tone: 'warn' };
    }
    return { key: 'active', label: 'Active', tone: 'ok' };
  }

  function changedFields(before, after) {
    var out = {};
    EDITABLE_FIELDS.forEach(function (f) {
      var was = String((before || {})[f.id] == null ? '' : (before || {})[f.id]);
      var now = String((after || {})[f.id] == null ? '' : (after || {})[f.id]);
      if (was !== now) out[f.id] = now;
    });
    return out;
  }

  return {
    CALLABLES: CALLABLES,
    FORBIDDEN_KEYS: FORBIDDEN_KEYS,
    EDITABLE_FIELDS: EDITABLE_FIELDS,
    EDITABLE_IDS: EDITABLE_IDS,
    REGISTRATION_ONLY: REGISTRATION_ONLY,
    KRA_PIN_RE: KRA_PIN_RE,
    assertNoIdentity: assertNoIdentity,
    pinProblem: pinProblem,
    normalisePin: normalisePin,
    loadProfile: loadProfile,
    normaliseProfile: normaliseProfile,
    buildRegistration: buildRegistration,
    register: register,
    validatePin: validatePin,
    buildUpdate: buildUpdate,
    updateProfile: updateProfile,
    loadStats: loadStats,
    normaliseInvoice: normaliseInvoice,
    generateInvoice: generateInvoice,
    resubmitInvoice: resubmitInvoice,
    buildBulk: buildBulk,
    bulkGenerate: bulkGenerate,
    formatCount: formatCount,
    formatKes: formatKes,
    formatDate: formatDate,
    vatLabel: vatLabel,
    statusOf: statusOf,
    changedFields: changedFields,
  };
}));
