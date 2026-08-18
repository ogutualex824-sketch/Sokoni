/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Customers — the client layer (2D-2 step 6)

   Built on exactly what the Customers census classified as usable, and nothing
   else:

       LIST + SEARCH   crmCustomerProfiles, read through firestore.rules
       PROFILE         getCustomerProfile   (callable, owner-asserted)
       AGGREGATES      getCRMDashboard      (callable, owner-asserted)

   ── Why the list is a read and not a callable ───────────────────────────────
   There is no customer-list callable. `getCRMDashboard` returns counts and the
   top five by CLV; `getCustomerProfile` reads one profile. So the list is a
   client read, and `crmCustomerProfiles` is the collection whose rules make that
   safe by construction:

       allow read:  resource.data.merchantId == request.auth.uid
       allow write: if false          ← CF-only

   Scoped by the RULES, not by this file. A merchant cannot receive another
   merchant's rows however the query is written, and a client cannot become the
   writer even by accident. Search is therefore performed over rows the server
   has already restricted — client-side search that is scoped by construction.

   `posCustomers` is deliberately NOT used: its rule gates on a `sellerId` body
   field its writers never set (they put the seller in the document id), and
   three different modules query it by three different scope fields.

   ── Three authorities deliberately NOT bound ────────────────────────────────
       posLookupCustomer         searches posCustomers platform-wide with NO
                                 merchant filter — cross-tenant PII disclosure
       posGetCustomerInsights    takes merchantId from the request, unverified
       getCustomerGrowthMetrics  gated on a `sellerId` claim nothing mints

   They are absent from CALLABLES, not fetched-then-hidden. A surface that
   fetches and then hides is still a surface that fetched.

   ── The identity line this module does not cross ────────────────────────────
   `getCustomerProfile` asserts ownership by reading `merchants/{merchantId}`, a
   POS-only document written solely by `business-bootstrap._createBusiness`. A
   merchant who came through the marketplace path has none, so the call refuses.

   This module does NOT paper over that. It does not create a `merchants`
   document, does not fall back to another identity, and does not retry with a
   different id — marketplace onboarding already creates `shops/{shopId}` and a
   subscription, and quietly resurrecting the POS `merchants/{merchantId}`
   identity model to satisfy a legacy CRM callable would undo that. The refusal
   is classified and handed to the surface to state plainly.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantCustomers = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PROFILES = 'crmCustomerProfiles';
  var CALLABLES = {
    profile: 'getCustomerProfile',
    dashboard: 'getCRMDashboard',
  };

  var SEGMENTS = {
    vip:        { label: 'VIP',        tone: 'gold' },
    high_value: { label: 'High value', tone: 'good' },
    regular:    { label: 'Regular',    tone: 'good' },
    first_time: { label: 'First order', tone: 'new' },
    customer:   { label: 'Customer',   tone: 'plain' },
  };
  var CHURN = {
    high:   { label: 'At risk',  tone: 'bad' },
    medium: { label: 'Cooling',  tone: 'warn' },
    low:    { label: 'Active',   tone: 'good' },
  };

  function segmentInfo(s) { return SEGMENTS[String(s)] || SEGMENTS.customer; }
  function churnInfo(l) { return CHURN[String(l)] || null; }

  function scopeNote() {
    return {
      level: 'account',
      label: 'Customers of your account',
      note: 'A customer profile is built from the orders they placed with you, across your ' +
            'SOKONI account rather than one shop.',
    };
  }

  /* ── The scope, and the one place it is decided ───────────────────────────
     `crmCustomerProfiles.merchantId` is compared to `request.auth.uid` by the
     rules, so the merchant id in this domain IS the account uid. Stated here
     once so no caller invents a different mapping. */
  function merchantIdFor(scope) {
    if (!scope || !scope.sellerUid) throw new Error('merchant customers: a signed-in account is required');
    return scope.sellerUid;
  }

  function profileQuery(scope) {
    return {
      collection: PROFILES,
      where: [['merchantId', '==', merchantIdFor(scope)]],
      orderBy: ['clv', 'desc'],
      limit: 500,
    };
  }

  /* Unknown figures stay null. A customer with no computed CLV has not been
     profiled yet — rendering that as 0 would say they spent nothing. */
  function projectCustomer(c) {
    var num = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : null; };
    return {
      uid: c.uid || c.id || null,
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      segment: c.segment || 'customer',
      clv: num(c.clv),
      orderCount: num(c.orderCount),
      totalSpend: num(c.totalSpend),
      avgOrderValue: num(c.avgOrderValue),
      lastOrderAt: c.lastOrderAt || null,
      firstOrderAt: c.firstOrderAt || null,
      churnRiskLevel: c.churnRiskLevel || null,
      loyaltyPoints: num(c.loyaltyPoints),
      loyaltyTier: c.loyaltyTier || null,
      preferredCategories: Array.isArray(c.preferredCategories) ? c.preferredCategories : [],
    };
  }

  async function listCustomers(o) {
    var scope = o.scope;
    if (!scope || !scope.sellerUid) return { ok: false, error: 'Sign in to see your customers.' };
    if (!o.db || typeof o.db.queryProfiles !== 'function') {
      throw new Error('merchant customers: a db adapter with queryProfiles is required');
    }
    try {
      var rows = await o.db.queryProfiles(profileQuery(scope));
      return { ok: true, customers: (rows || []).map(projectCustomer), count: (rows || []).length };
    } catch (e) {
      /* A rules refusal arrives here as permission-denied. Reported, never
         rendered as "you have no customers". */
      return { ok: false, error: (e && e.message) || 'Your customers could not be loaded.',
        code: (e && e.code) || null };
    }
  }

  /* ── Search — over rows the RULES already restricted ──────────────────────
     Not a server lookup: the only server search that exists
     (`posLookupCustomer`) queries the whole platform with no merchant filter.
     Searching locally over an already-scoped set is both honest and, by
     construction, incapable of reaching another merchant's customers. */
  function searchCustomers(customers, term) {
    var t = String(term == null ? '' : term).trim().toLowerCase();
    if (!t) return (customers || []).slice();
    return (customers || []).filter(function (c) {
      return String(c.name || '').toLowerCase().indexOf(t) !== -1
        || String(c.phone || '').toLowerCase().indexOf(t) !== -1
        || String(c.email || '').toLowerCase().indexOf(t) !== -1;
    });
  }

  function _unwrap(res) { return (res && res.data) ? res.data : res; }

  /* ── Profile ──────────────────────────────────────────────────────────────
     A refusal is CLASSIFIED rather than passed through raw, so the surface can
     say the right thing. `not-found` from this callable means the POS-only
     `merchants/{merchantId}` document does not exist — which is the normal state
     for a marketplace merchant, not a fault of theirs. */
  async function getProfile(o) {
    if (typeof o.callProfile !== 'function') throw new Error('merchant customers: callable is required');
    if (!o.uid) throw new Error('merchant customers: a customer uid is required');
    var merchantId = merchantIdFor(o.scope);
    try {
      var d = _unwrap(await o.callProfile({ merchantId: merchantId, uid: String(o.uid) }));
      return { ok: true, profile: projectCustomer(d || {}) };
    } catch (e) {
      var code = (e && e.code) || null;
      var missingMerchantRecord = code === 'not-found' && /merchant not found/i.test((e && e.message) || '');
      return {
        ok: false,
        code: code,
        error: (e && e.message) || 'That customer profile could not be loaded.',
        /* The surface renders an explanation for this one, not an error. */
        reason: missingMerchantRecord ? 'no_pos_merchant_record' : 'refused',
      };
    }
  }

  async function getDashboard(o) {
    if (typeof o.callDashboard !== 'function') throw new Error('merchant customers: callable is required');
    var merchantId = merchantIdFor(o.scope);
    try {
      var d = _unwrap(await o.callDashboard({ merchantId: merchantId }));
      return { ok: true, dashboard: d || {} };
    } catch (e) {
      var code = (e && e.code) || null;
      return { ok: false, code: code,
        error: (e && e.message) || 'Customer figures could not be loaded.',
        reason: (code === 'not-found' && /merchant not found/i.test((e && e.message) || ''))
          ? 'no_pos_merchant_record' : 'refused' };
    }
  }

  /* ── Display ──────────────────────────────────────────────────────────────
     Unknown is an em dash. Never 0, and never an extrapolation. */
  function formatKES(n) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '—';
    return 'KES ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }
  function formatCount(n) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '—';
    return Number(n).toLocaleString('en-KE');
  }
  function initials(name, email) {
    var s = String(name || '').trim() || String(email || '').split('@')[0] || '';
    if (!s) return '?';
    var p = s.split(/[\s._-]+/).filter(Boolean);
    return ((p[0] || '').charAt(0) + (p.length > 1 ? (p[p.length - 1] || '').charAt(0) : '')).toUpperCase() || '?';
  }
  function dateLabel(ts) {
    if (!ts) return '—';
    try {
      var ms = ts.seconds ? ts.seconds * 1000 : (ts._seconds ? ts._seconds * 1000 : Date.parse(ts));
      if (!isFinite(ms) || !ms) return '—';
      return new Date(ms).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (_) { return '—'; }
  }

  return {
    PROFILES: PROFILES,
    CALLABLES: CALLABLES,
    SEGMENTS: SEGMENTS,
    segmentInfo: segmentInfo,
    churnInfo: churnInfo,
    scopeNote: scopeNote,
    merchantIdFor: merchantIdFor,
    profileQuery: profileQuery,
    projectCustomer: projectCustomer,
    listCustomers: listCustomers,
    searchCustomers: searchCustomers,
    getProfile: getProfile,
    getDashboard: getDashboard,
    formatKES: formatKES,
    formatCount: formatCount,
    initials: initials,
    dateLabel: dateLabel,
  };
}));
