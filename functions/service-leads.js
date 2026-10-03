'use strict';
/**
 * SOKONI — SERVICE LEADS & QUOTES  (Tech Hub slice 4F, 2026-10-03, sokoni-b2)
 * ===================================================================================================================
 * The ONE lead / quote authority for service providers. Contract and state machine: docs/SERVICE_LEADS.md.
 *
 *   serviceLeads/{leadId}   server-written only (no rules block → default deny; every read is a callable below)
 *
 * A customer asks a provider (optionally about one service, with repair details for a device service); the provider
 * views, declines or sends a priced quote; the customer accepts / declines / asks for clarification; an accepted quote
 * is booked by bookingCreateService({ leadId }) at the QUOTED price, and the lead becomes `converted` in that booking's
 * own transaction. Conversations hang on the lead (messages.js transaction type `service_lead`).
 *
 * Money: the quote amount is the provider's, validated here; the booking reads it from the lead, never the request.
 * Lead monetization is NOT configured anywhere in SOKONI — every lead records that, and nothing is charged.
 *
 * G7 (Marketing Hub E2E, 2026-10-03): the brief's lead + quote lifecycles on THIS engine — no second store.
 *   lead  stage  new → contacted → qualified → quote_requested → quote_sent → negotiating → won  | lost · cancelled · expired
 *   quote stage  draft → sent → customer_viewed → negotiating → accepted                       | declined · expired · cancelled
 * Stages are DERIVED from the stored status (+ quote validity / inactivity) by leadStage()/quoteStage() — the stored
 * statuses above stay valid for every existing consumer. A quote is itemised (quantity × rate + adjustments + explicit
 * taxes) and its total is computed HERE; a client total is only ever compared, never used. Acceptance names the quote
 * version the customer saw and freezes it as acceptedQuote — the booking reads that frozen copy.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const TSP = require('./shared/tech-service-profile');

const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();
const _uid = (req) => { const u = req && req.auth && req.auth.uid; if (!u) throw new HttpsError('unauthenticated', 'Authentication required.'); return u; };
const _san = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);

const STATUS = Object.freeze({
  CREATED: 'created', VIEWED: 'viewed', QUALIFIED: 'qualified', QUOTE_REQUESTED: 'quote_requested', QUOTE_SENT: 'quote_sent',
  CLARIFY: 'clarification_requested', ACCEPTED: 'quote_accepted', QUOTE_DECLINED: 'quote_declined', DECLINED: 'declined',
  LOST: 'lost', CONVERTED: 'converted', CLOSED: 'closed',
});
const OPEN = Object.freeze([STATUS.CREATED, STATUS.VIEWED, STATUS.QUALIFIED, STATUS.QUOTE_REQUESTED, STATUS.QUOTE_SENT, STATUS.CLARIFY, STATUS.ACCEPTED]);
/** open and not yet quoted (or re-opened for a new quote) — the states a provider may quote / qualify / decline from */
const PRE_QUOTE = Object.freeze([STATUS.CREATED, STATUS.VIEWED, STATUS.QUALIFIED, STATUS.QUOTE_REQUESTED, STATUS.CLARIFY]);
const LIMITS = Object.freeze({ messageLen: 1000, maxOpenPerPair: 3, maxPerDay: 20, minQuoteCents: 100, maxQuoteCents: 1000000000, maxValidDays: 30, notesLen: 500,
  scopeLen: 1000, maxQuantity: 10000, maxAdjustments: 5, maxTaxes: 3, maxTaxPct: 30, leadTtlDays: 30 });
/** The ONLY payment terms SOKONI can honour for a quote: it is booked, paid through IntaSend (verified webhook), held, and
 *  released by the customer's completion PIN. A provider may add a note; it cannot pick terms the money path does not run. */
const PAYMENT_TERMS = Object.freeze({ code: 'paid_on_booking_held_until_pin',
  text: 'Paid in full through SOKONI when booked; held until the customer confirms completion with their PIN.' });
const MONETIZATION = Object.freeze({ status: 'not_configured', note: 'Lead monetization not configured' });

const _event = (by, event, extra) => Object.assign({ at: Date.now(), by, event }, extra || {});

/** The provider's workspace must have `leads` AVAILABLE (approved, QUOTE_REQUEST capability, not suspended). */
async function _providerLeadsWorkspace(db, providerId) {
  return require('./business-workspace').assertModule(db, providerId, 'leads', HttpsError);
}

async function _loadLead(db, id) {
  const leadId = _san(id, 128);
  if (!leadId) throw new HttpsError('invalid-argument', 'leadId is required.');
  const ref = db.collection('serviceLeads').doc(leadId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
  return { ref, lead: snap.data(), leadId };
}
function _asParty(lead, uid, role) {
  const ok = role === 'customer' ? lead.customerUid === uid : lead.providerId === uid;
  if (!ok) throw new HttpsError('permission-denied', 'Not your lead.');
}
function _from(lead, allowed) {
  if (!allowed.includes(lead.status)) throw new HttpsError('failed-precondition', 'This lead is ' + String(lead.status).replace(/_/g, ' ') + '.', { code: 'LEAD_STATE_' + lead.status });
}
const _lastAt = (l) => { const h = Array.isArray(l.history) ? l.history : []; return Number((h[h.length - 1] || {}).at) || Number(l.createdAtMs) || 0; };
/** a pre-quote lead nobody has touched for leadTtlDays has EXPIRED (derived; nothing is rewritten) */
const _ttlExpired = (l, now) => PRE_QUOTE.includes(l.status) && _lastAt(l) > 0 && _lastAt(l) < now - LIMITS.leadTtlDays * 86400000;
const _quoteLapsed = (l, now) => l.status === STATUS.QUOTE_SENT && !!l.quote && Number(l.quote.validUntil) < now;

/** The brief's lead stage, derived from server state only. */
function leadStage(l, now) {
  const t = now || Date.now();
  switch (l.status) {
    case STATUS.CONVERTED: case STATUS.ACCEPTED: return 'won';
    case STATUS.DECLINED: case STATUS.QUOTE_DECLINED: case STATUS.LOST: return 'lost';
    case STATUS.CLOSED: return 'cancelled';
    default: break;
  }
  if (_ttlExpired(l, t) || _quoteLapsed(l, t)) return 'expired';
  return ({ created: 'new', viewed: 'contacted', qualified: 'qualified', quote_requested: 'quote_requested',
    quote_sent: 'quote_sent', clarification_requested: 'negotiating' })[l.status] || 'unknown';
}
/** The brief's quote stage. 'draft' is visible to the provider only (the customer view never carries the draft). */
function quoteStage(l, now, role) {
  const t = now || Date.now();
  const q = l.quote;
  if (!q) return role === 'provider' && l.quoteDraft ? 'draft' : null;
  if (q.cancelledAt) return role === 'provider' && l.quoteDraft ? 'draft' : 'cancelled';
  if (l.status === STATUS.ACCEPTED || l.status === STATUS.CONVERTED) return 'accepted';
  if (l.status === STATUS.QUOTE_DECLINED) return 'declined';
  if ([STATUS.DECLINED, STATUS.LOST, STATUS.CLOSED].includes(l.status)) return 'cancelled';
  if (l.status === STATUS.CLARIFY) return 'negotiating';
  if (l.status === STATUS.QUOTE_SENT) {
    if (Number(q.validUntil) < t) return 'expired';
    return q.viewedVersion === q.version ? 'customer_viewed' : 'sent';
  }
  return null;
}
const _isOpen = (l, now) => OPEN.includes(l.status) && leadStage(l, now) !== 'expired';

const _view = (id, l, role) => {
  const now = Date.now();
  const v = { id, customerUid: l.customerUid, providerId: l.providerId, serviceId: l.serviceId || null, message: l.message || '',
    repairDetails: l.repairDetails || null, status: l.status, stage: leadStage(l, now), quoteStage: quoteStage(l, now, role),
    quote: l.quote || null, acceptedQuote: l.acceptedQuote || null, bookingId: l.bookingId || null,
    monetization: l.monetization || MONETIZATION, history: Array.isArray(l.history) ? l.history.slice(-20) : [] };
  if (role === 'provider') v.quoteDraft = l.quoteDraft || null;   /* a draft is the provider's working copy — never the customer's */
  return v;
};

/**
 * Build a quote from the provider's request. Every figure is computed here; amountCents (the legacy single-figure quote)
 * is accepted as the unit rate of a 1× quote, or — when itemised — only as a CHECK against the computed total.
 * @returns {object} quote (without version / sentAt)
 */
function buildQuote(d, svc, serviceId) {
  const int = (v) => Math.round(Number(v));
  const itemised = d.unitRateCents != null;
  const quantity = d.quantity == null ? 1 : int(d.quantity);
  if (!(Number.isFinite(quantity) && quantity >= 1 && quantity <= LIMITS.maxQuantity)) throw new HttpsError('invalid-argument', 'Quantity must be 1–' + LIMITS.maxQuantity + '.', { code: 'QUOTE_BAD_QUANTITY' });
  const unitRateCents = int(itemised ? d.unitRateCents : d.amountCents);
  if (!Number.isFinite(unitRateCents) || unitRateCents < LIMITS.minQuoteCents || unitRateCents > LIMITS.maxQuoteCents) {
    throw new HttpsError('invalid-argument', 'Quote amount must be between KES 1 and KES 10,000,000.');
  }
  if (!itemised && quantity !== 1) throw new HttpsError('invalid-argument', 'Give a unit rate (unitRateCents) for a quantity above 1.', { code: 'QUOTE_BAD_QUANTITY' });
  const rawAdj = d.adjustments == null ? [] : d.adjustments;
  const rawTax = d.taxes == null ? [] : d.taxes;
  if (!Array.isArray(rawAdj) || rawAdj.length > LIMITS.maxAdjustments) throw new HttpsError('invalid-argument', 'At most ' + LIMITS.maxAdjustments + ' adjustments.', { code: 'QUOTE_BAD_ADJUSTMENT' });
  if (!Array.isArray(rawTax) || rawTax.length > LIMITS.maxTaxes) throw new HttpsError('invalid-argument', 'At most ' + LIMITS.maxTaxes + ' taxes.', { code: 'QUOTE_BAD_TAX' });
  const adjustments = rawAdj.map((a) => {
    const label = _san(a && a.label, 60); const amountCents = int(a && a.amountCents);
    if (!label || !Number.isFinite(amountCents) || amountCents === 0 || Math.abs(amountCents) > LIMITS.maxQuoteCents) {
      throw new HttpsError('invalid-argument', 'Each adjustment needs a label and a non-zero amount.', { code: 'QUOTE_BAD_ADJUSTMENT' });
    }
    return { label, amountCents };
  });
  /* VAT / taxes are NEVER inferred: only a tax the provider states, with its rate, is added. */
  const subtotalCents = quantity * unitRateCents;
  const netCents = subtotalCents + adjustments.reduce((t, a) => t + a.amountCents, 0);
  if (netCents < LIMITS.minQuoteCents) throw new HttpsError('invalid-argument', 'Adjustments cannot take the quote below KES 1.', { code: 'QUOTE_BAD_ADJUSTMENT' });
  const taxes = rawTax.map((x) => {
    const label = _san(x && x.label, 40); const ratePct = Math.round(Number(x && x.ratePct) * 100) / 100;
    if (!label || !Number.isFinite(ratePct) || ratePct <= 0 || ratePct > LIMITS.maxTaxPct) {
      throw new HttpsError('invalid-argument', 'Each tax needs a label and a rate above 0 and at most ' + LIMITS.maxTaxPct + '%.', { code: 'QUOTE_BAD_TAX' });
    }
    return { label, ratePct, amountCents: Math.round(netCents * ratePct / 100) };
  });
  const taxCents = taxes.reduce((t, x) => t + x.amountCents, 0);
  const amountCents = netCents + taxCents;
  if (amountCents > LIMITS.maxQuoteCents) throw new HttpsError('invalid-argument', 'Quote amount must be between KES 1 and KES 10,000,000.');
  if (itemised && d.amountCents != null && int(d.amountCents) !== amountCents) {
    throw new HttpsError('failed-precondition', 'The total does not match the items. Review the quote and send it again.', { code: 'QUOTE_TOTAL_MISMATCH', computedCents: amountCents });
  }
  const MSVC = require('./shared/marketing-services');
  const snap = MSVC.bookingSnapshot(Object.assign({}, svc, { name: svc.name || svc.title || '' }));
  const breakdown = [{ type: 'line', label: (snap.serviceSnapshot.name || 'Service') + (quantity > 1 ? ' × ' + quantity : ''), amount: subtotalCents }]
    .concat(adjustments.map((a) => ({ type: 'adjustment', label: a.label, amount: a.amountCents })))
    .concat(taxes.map((x) => ({ type: 'tax', label: x.label + ' ' + x.ratePct + '%', amount: x.amountCents })));
  return {
    amountCents, currency: 'KES', serviceId, quantity, unitRateCents, subtotalCents, adjustments, taxes, taxCents, breakdown,
    scope: _san(d.scope, LIMITS.scopeLen), paymentTerms: { code: PAYMENT_TERMS.code, text: PAYMENT_TERMS.text, note: _san(d.paymentTermsNote, 300) },
    serviceHub: snap.serviceHub, serviceCategory: snap.serviceCategory, serviceSnapshot: snap.serviceSnapshot,
  };
}

const _h = {};

/* ── customer: ask a provider ── */
_h.leadCreate = async (req) => {
  const uid = _uid(req);
  const d = req.data || {};
  const providerId = _san(d.providerId, 128);
  if (!providerId) throw new HttpsError('invalid-argument', 'providerId is required.');
  if (providerId === uid) throw new HttpsError('failed-precondition', 'You cannot send a request to yourself.');
  const message = _san(d.message, LIMITS.messageLen);
  if (message.length < 5) throw new HttpsError('invalid-argument', 'Describe what you need (at least a few words).');
  const db = _db();
  const prov = await db.collection('providers').doc(providerId).get();
  if (!prov.exists || !['active', 'approved'].includes((prov.data() || {}).status)) throw new HttpsError('failed-precondition', 'This provider is not taking requests.');
  await _providerLeadsWorkspace(db, providerId).catch(() => { throw new HttpsError('failed-precondition', 'This provider is not taking requests.'); });

  let serviceId = null, repairDetails = null;
  if (d.serviceId) {
    serviceId = _san(d.serviceId, 128);
    const s = await db.collection('providerServices').doc(serviceId).get();
    if (!s.exists || s.data().providerId !== providerId || s.data().active === false) throw new HttpsError('failed-precondition', 'That service is not available.');
    if (s.data().techProfile) {
      try { repairDetails = TSP.sanitizeRepairDetails(d.repairDetails, s.data().techProfile); }
      catch (e) { throw new HttpsError('invalid-argument', e.message, { code: 'REPAIR_DETAILS_' + (e.code || 'BAD_VALUE') }); }
    }
  }
  /* abuse limits */
  const mine = await db.collection('serviceLeads').where('customerUid', '==', uid).limit(200).get();
  const now = Date.now();
  const docs = mine.docs.map((x) => x.data());
  if (docs.filter((l) => l.providerId === providerId && _isOpen(l, now)).length >= LIMITS.maxOpenPerPair) {
    throw new HttpsError('resource-exhausted', 'You already have open requests with this provider.');
  }
  if (docs.filter((l) => Number(l.createdAtMs) > now - 86400000).length >= LIMITS.maxPerDay) {
    throw new HttpsError('resource-exhausted', 'Too many requests today. Please try again tomorrow.');
  }
  /* "Quote Requested" from the start when the customer asks for a price (the public hub's Request-a-quote) */
  const status = d.requestQuote === true ? STATUS.QUOTE_REQUESTED : STATUS.CREATED;
  const ref = await db.collection('serviceLeads').add({
    customerUid: uid, providerId, serviceId, message, repairDetails, status, quote: null, bookingId: null,
    monetization: MONETIZATION, history: [_event('customer', status === STATUS.CREATED ? 'created' : 'quote_requested')], createdAtMs: now, createdAt: _ts(), updatedAt: _ts(),
  });
  return { success: true, leadId: ref.id, status };
};

_h.leadListMine = async (req) => {
  const uid = _uid(req);
  const snap = await _db().collection('serviceLeads').where('customerUid', '==', uid).limit(100).get();
  return { leads: snap.docs.map((x) => _view(x.id, x.data(), 'customer')).sort((a, b) => (b.history.slice(-1)[0] || {}).at - (a.history.slice(-1)[0] || {}).at) };
};

/* ── provider ── */
_h.leadListForProvider = async (req) => {
  const uid = _uid(req);
  const db = _db();
  await _providerLeadsWorkspace(db, uid);
  const snap = await db.collection('serviceLeads').where('providerId', '==', uid).limit(200).get();
  return { leads: snap.docs.map((x) => _view(x.id, x.data(), 'provider')).sort((a, b) => (b.history.slice(-1)[0] || {}).at - (a.history.slice(-1)[0] || {}).at) };
};

/** opts.allowExpired: the transition is valid on a lead that went stale (closing / marking lost / re-quoting). */
async function _transition(req, role, allowed, build, opts) {
  const uid = _uid(req);
  const db = _db();
  const { ref, lead, leadId } = await _loadLead(db, (req.data || {}).leadId);
  _asParty(lead, uid, role);
  if (role === 'provider') await _providerLeadsWorkspace(db, uid);
  let out;
  await db.runTransaction(async (t) => {
    const cur = (await t.get(ref)).data() || {};
    _from(cur, allowed);
    if (!(opts && opts.allowExpired) && _ttlExpired(cur, Date.now())) {
      throw new HttpsError('failed-precondition', 'This request has expired. Send a new one.', { code: 'LEAD_EXPIRED' });
    }
    const patch = await build(cur);
    if (patch === null) { out = { success: true, leadId, status: cur.status, unchanged: true }; return; }
    patch.history = (Array.isArray(cur.history) ? cur.history : []).concat([patch.__event]).slice(-50);
    delete patch.__event;
    patch.updatedAt = _ts();
    t.update(ref, patch);
    out = { success: true, leadId, status: patch.status };
  });
  return out;
}

_h.leadMarkViewed = (req) => _transition(req, 'provider', [STATUS.CREATED], () => ({ status: STATUS.VIEWED, __event: _event('provider', 'viewed') }));

_h.leadDecline = (req) => _transition(req, 'provider', PRE_QUOTE, () => ({
  status: STATUS.DECLINED, __event: _event('provider', 'declined', { reason: _san((req.data || {}).reason, 300) }) }), { allowExpired: true });

/* G7 provider: qualify a lead (a real prospect worth quoting) */
_h.leadQualify = (req) => _transition(req, 'provider', [STATUS.CREATED, STATUS.VIEWED], () => ({
  status: STATUS.QUALIFIED, __event: _event('provider', 'qualified', { note: _san((req.data || {}).note, 300) }) }));

/* G7 provider: the deal is lost (customer went quiet, chose someone else…) — from any open state short of acceptance */
_h.leadMarkLost = (req) => _transition(req, 'provider', PRE_QUOTE.concat([STATUS.QUOTE_SENT]), () => ({
  status: STATUS.LOST, __event: _event('provider', 'lost', { reason: _san((req.data || {}).reason, 300) }) }), { allowExpired: true });

/* G7 customer: ask for a price on an open lead */
_h.leadRequestQuote = (req) => _transition(req, 'customer', [STATUS.CREATED, STATUS.VIEWED, STATUS.QUALIFIED], () => ({
  status: STATUS.QUOTE_REQUESTED, __event: _event('customer', 'quote_requested', { message: _san((req.data || {}).message, 500) }) }));

/* G7 provider: withdraw a sent quote (it can then never be accepted); the lead returns to qualified for a new quote */
_h.leadWithdrawQuote = (req) => _transition(req, 'provider', [STATUS.QUOTE_SENT, STATUS.CLARIFY], (cur) => ({
  status: STATUS.QUALIFIED, quote: Object.assign({}, cur.quote || {}, { cancelledAt: Date.now() }),
  __event: _event('provider', 'quote_withdrawn', { version: (cur.quote && cur.quote.version) || null }) }), { allowExpired: true });

/* G7 customer: the customer opened the quote (Customer Viewed). Idempotent per version; no status change. */
_h.leadViewQuote = (req) => _transition(req, 'customer', [STATUS.QUOTE_SENT], (cur) => {
  if (!cur.quote || cur.quote.viewedVersion === cur.quote.version) return null;
  return { status: cur.status, quote: Object.assign({}, cur.quote, { viewedVersion: cur.quote.version, viewedAt: Date.now() }),
    __event: _event('customer', 'quote_viewed', { version: cur.quote.version }) };
}, { allowExpired: true });

/** shared by send + draft: provider, workspace, service ownership, granted mode, marketing approval */
async function _quoteInputs(req) {
  const uid = _uid(req);
  const d = req.data || {};
  const days = Math.round(Number(d.validDays || 7));
  if (!(days >= 1 && days <= LIMITS.maxValidDays)) throw new HttpsError('invalid-argument', 'Validity must be 1–' + LIMITS.maxValidDays + ' days.');
  const durationMins = Math.max(15, Math.min(Math.round(Number(d.durationMins) || 60), 24 * 60));
  const db = _db();
  const w = await _providerLeadsWorkspace(db, uid);
  const serviceId = _san(d.serviceId, 128);
  if (!serviceId) throw new HttpsError('invalid-argument', 'Choose which of your services this quote is for.');
  const s = await db.collection('providerServices').doc(serviceId).get();
  if (!s.exists || s.data().providerId !== uid || s.data().active === false) throw new HttpsError('failed-precondition', 'That service is not one of your active services.');
  const svc = s.data();
  const serviceMode = _san(d.serviceMode, 30).toUpperCase();
  if (serviceMode && (!TSP.MODE_CAPS.includes(serviceMode) || !(w.serviceCapabilities || []).includes(serviceMode))) {
    throw new HttpsError('failed-precondition', 'You are not approved to deliver it that way.');
  }
  if (svc.hub === 'marketing') {
    /* the same server authority the booking re-checks: never quote a marketing service the provider is not approved for */
    const MA = require('./shared/marketing-authority');
    const prov = (await db.collection('providers').doc(uid).get()).data() || {};
    const mAuth = await MA.marketingAuthority(db, uid, prov);
    if (!require('./shared/marketing-services').approvedFor(MA.effectiveProvider(prov, mAuth), svc.category)) {
      throw new HttpsError('failed-precondition', 'This marketing service is not currently approved on SOKONI.', { code: 'MKT_SERVICE_NOT_APPROVED' });
    }
  }
  const q = buildQuote(d, svc, serviceId);
  return Object.assign(q, { description: _san(d.description, LIMITS.notesLen), durationMins, serviceMode, notes: _san(d.notes, LIMITS.notesLen), validDays: days });
}

/* G7 provider: save a DRAFT quote (provider-only; never shown to the customer, never bookable) */
_h.leadSaveQuoteDraft = async (req) => {
  const q = await _quoteInputs(req);
  return _transition(req, 'provider', PRE_QUOTE.concat([STATUS.QUOTE_SENT]), (cur) => ({
    status: cur.status, quoteDraft: Object.assign(q, { savedAt: Date.now() }), __event: _event('provider', 'quote_draft_saved', { amountCents: q.amountCents }) }));
};

_h.leadSendQuote = async (req) => {
  const q = await _quoteInputs(req);
  const days = q.validDays; delete q.validDays;
  /* a re-quote supersedes the previous one: new version, viewed/cancel marks reset, the draft is consumed */
  return _transition(req, 'provider', PRE_QUOTE.concat([STATUS.QUOTE_SENT]), (cur) => {
    const version = ((cur.quote && cur.quote.version) || 0) + 1;
    return {
      status: STATUS.QUOTE_SENT,
      quote: Object.assign(q, { validUntil: Date.now() + days * 86400000, version, sentAt: Date.now() }),
      quoteDraft: null,
      __event: _event('provider', 'quote_sent', { version, amountCents: q.amountCents }),
    };
  }, { allowExpired: true });
};

_h.leadRespond = async (req) => {
  const action = _san((req.data || {}).action, 20);
  if (!['accept', 'decline', 'clarify'].includes(action)) throw new HttpsError('invalid-argument', 'action must be accept, decline or clarify.');
  return _transition(req, 'customer', [STATUS.QUOTE_SENT], (cur) => {
    if (action === 'accept') {
      if (!cur.quote || Number(cur.quote.validUntil) < Date.now()) throw new HttpsError('failed-precondition', 'This quote has expired. Ask the provider for a new one.', { code: 'LEAD_QUOTE_EXPIRED' });
      /* the customer accepts the version they SAW: a re-quote between view and accept must never be accepted unseen */
      const seen = Math.round(Number((req.data || {}).quoteVersion));
      if (seen !== cur.quote.version) throw new HttpsError('failed-precondition', 'The provider has updated this quote. Review the new version.', { code: 'LEAD_QUOTE_CHANGED', version: cur.quote.version });
      /* acceptance LOCKS the terms: a frozen copy the booking reads (the live quote field is never priced from again) */
      const acceptedQuote = Object.assign({}, cur.quote, { acceptedAt: Date.now() });
      return { status: STATUS.ACCEPTED, acceptedQuote, __event: _event('customer', 'quote_accepted', { version: cur.quote.version, amountCents: cur.quote.amountCents }) };
    }
    if (action === 'decline') return { status: STATUS.QUOTE_DECLINED, __event: _event('customer', 'quote_declined') };
    return { status: STATUS.CLARIFY, __event: _event('customer', 'clarification_requested', { message: _san((req.data || {}).message, 500) }) };
  });
};

/* customer cancels the request (stage: cancelled) */
_h.leadClose = (req) => _transition(req, 'customer', OPEN, () => ({ status: STATUS.CLOSED, __event: _event('customer', 'closed', { reason: _san((req.data || {}).reason, 300) }) }), { allowExpired: true });

/**
 * For bookingCreateService({ leadId }), BEFORE its transaction: validates an ACCEPTED, unexpired lead of this customer +
 * provider and returns the quoted price. A lead already 'converted' may be booked again ONLY when its booking is a dead,
 * unpaid hold (expired / cancelled / released) — an abandoned payment must not strand an accepted quote.
 * @returns {{ ref, quote, reuseFrom: string|null }}
 */
async function quoteForBooking(db, { leadId, customerUid, providerId, serviceId }) {
  const { ref, lead } = await _loadLead(db, leadId);
  if (lead.customerUid !== customerUid) throw new HttpsError('permission-denied', 'Not your lead.');
  if (lead.providerId !== providerId) throw new HttpsError('failed-precondition', 'This quote is from a different provider.');
  let reuseFrom = null;
  if (lead.status === STATUS.CONVERTED) {
    const prev = lead.bookingId ? await db.collection('providerBookings').doc(lead.bookingId).get() : null;
    const p = prev && prev.exists ? prev.data() : null;
    const exp = p && p.expiresAt && (typeof p.expiresAt.toMillis === 'function' ? p.expiresAt.toMillis() : Number(p.expiresAt));
    const dead = !p || ((p.paymentStatus || 'pending') === 'pending' && (['cancelled', 'expired', 'released'].includes(p.status) || (exp && exp < Date.now())));
    if (!dead) throw new HttpsError('failed-precondition', 'This quote has already been booked.', { code: 'LEAD_STATE_converted' });
    reuseFrom = lead.bookingId || '';
  } else if (lead.status !== STATUS.ACCEPTED) {
    throw new HttpsError('failed-precondition', 'Accept the quote before booking it.', { code: 'LEAD_STATE_' + lead.status });
  }
  /* the FROZEN accepted terms (G7); a lead accepted before acceptedQuote existed falls back to its quote, which could not
     change after acceptance either (leadSendQuote is not allowed from quote_accepted / converted) */
  const q = lead.acceptedQuote || lead.quote || {};
  if (!(Number(q.validUntil) >= Date.now())) throw new HttpsError('failed-precondition', 'This quote has expired.', { code: 'LEAD_QUOTE_EXPIRED' });
  if (serviceId && q.serviceId && q.serviceId !== serviceId) throw new HttpsError('failed-precondition', 'This quote is for a different service.');
  return { ref, quote: q, reuseFrom };
}
/** Inside the booking transaction, AFTER its writes: flip the lead (read earlier in the same transaction) to converted.
 *  Same booking id (resumed hold) is a no-op; anything else that is not the pre-checked state is refused. */
function convertIn(txn, ref, leadSnap, bookingId, reuseFrom) {
  const cur = (leadSnap && leadSnap.data()) || {};
  if (cur.status === STATUS.CONVERTED && cur.bookingId === bookingId) return;
  const ok = cur.status === STATUS.ACCEPTED || (reuseFrom !== null && cur.status === STATUS.CONVERTED && (cur.bookingId || '') === reuseFrom);
  if (!ok) throw new HttpsError('failed-precondition', 'This quote has already been booked.', { code: 'LEAD_STATE_' + cur.status });
  txn.update(ref, { status: STATUS.CONVERTED, bookingId,
    history: (Array.isArray(cur.history) ? cur.history : []).concat([_event('customer', 'converted', { bookingId })]).slice(-50), updatedAt: _ts() });
}

module.exports = { _h, STATUS, OPEN, PRE_QUOTE, LIMITS, MONETIZATION, PAYMENT_TERMS, leadStage, quoteStage, buildQuote, quoteForBooking, convertIn };
