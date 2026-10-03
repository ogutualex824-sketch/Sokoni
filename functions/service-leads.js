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
 */
const { HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const TSP = require('./shared/tech-service-profile');

const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();
const _uid = (req) => { const u = req && req.auth && req.auth.uid; if (!u) throw new HttpsError('unauthenticated', 'Authentication required.'); return u; };
const _san = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);

const STATUS = Object.freeze({
  CREATED: 'created', VIEWED: 'viewed', QUOTE_SENT: 'quote_sent', CLARIFY: 'clarification_requested',
  ACCEPTED: 'quote_accepted', QUOTE_DECLINED: 'quote_declined', DECLINED: 'declined', CONVERTED: 'converted', CLOSED: 'closed',
});
const OPEN = Object.freeze([STATUS.CREATED, STATUS.VIEWED, STATUS.QUOTE_SENT, STATUS.CLARIFY, STATUS.ACCEPTED]);
const LIMITS = Object.freeze({ messageLen: 1000, maxOpenPerPair: 3, maxPerDay: 20, minQuoteCents: 100, maxQuoteCents: 1000000000, maxValidDays: 30, notesLen: 500 });
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
const _view = (id, l) => ({ id, customerUid: l.customerUid, providerId: l.providerId, serviceId: l.serviceId || null, message: l.message || '',
  repairDetails: l.repairDetails || null, status: l.status, quote: l.quote || null, bookingId: l.bookingId || null,
  monetization: l.monetization || MONETIZATION, history: Array.isArray(l.history) ? l.history.slice(-20) : [] });

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
  if (docs.filter((l) => l.providerId === providerId && OPEN.includes(l.status)).length >= LIMITS.maxOpenPerPair) {
    throw new HttpsError('resource-exhausted', 'You already have open requests with this provider.');
  }
  if (docs.filter((l) => Number(l.createdAtMs) > now - 86400000).length >= LIMITS.maxPerDay) {
    throw new HttpsError('resource-exhausted', 'Too many requests today. Please try again tomorrow.');
  }
  const ref = await db.collection('serviceLeads').add({
    customerUid: uid, providerId, serviceId, message, repairDetails, status: STATUS.CREATED, quote: null, bookingId: null,
    monetization: MONETIZATION, history: [_event('customer', 'created')], createdAtMs: now, createdAt: _ts(), updatedAt: _ts(),
  });
  return { success: true, leadId: ref.id, status: STATUS.CREATED };
};

_h.leadListMine = async (req) => {
  const uid = _uid(req);
  const snap = await _db().collection('serviceLeads').where('customerUid', '==', uid).limit(100).get();
  return { leads: snap.docs.map((x) => _view(x.id, x.data())).sort((a, b) => (b.history.slice(-1)[0] || {}).at - (a.history.slice(-1)[0] || {}).at) };
};

/* ── provider ── */
_h.leadListForProvider = async (req) => {
  const uid = _uid(req);
  const db = _db();
  await _providerLeadsWorkspace(db, uid);
  const snap = await db.collection('serviceLeads').where('providerId', '==', uid).limit(200).get();
  return { leads: snap.docs.map((x) => _view(x.id, x.data())).sort((a, b) => (b.history.slice(-1)[0] || {}).at - (a.history.slice(-1)[0] || {}).at) };
};

async function _transition(req, role, allowed, build) {
  const uid = _uid(req);
  const db = _db();
  const { ref, lead, leadId } = await _loadLead(db, (req.data || {}).leadId);
  _asParty(lead, uid, role);
  if (role === 'provider') await _providerLeadsWorkspace(db, uid);
  let out;
  await db.runTransaction(async (t) => {
    const cur = (await t.get(ref)).data() || {};
    _from(cur, allowed);
    const patch = await build(cur);
    patch.history = (Array.isArray(cur.history) ? cur.history : []).concat([patch.__event]).slice(-50);
    delete patch.__event;
    patch.updatedAt = _ts();
    t.update(ref, patch);
    out = { success: true, leadId, status: patch.status };
  });
  return out;
}

_h.leadMarkViewed = (req) => _transition(req, 'provider', [STATUS.CREATED], () => ({ status: STATUS.VIEWED, __event: _event('provider', 'viewed') }));

_h.leadDecline = (req) => _transition(req, 'provider', [STATUS.CREATED, STATUS.VIEWED, STATUS.CLARIFY], () => ({
  status: STATUS.DECLINED, __event: _event('provider', 'declined', { reason: _san((req.data || {}).reason, 300) }) }));

_h.leadSendQuote = async (req) => {
  const uid = _uid(req);
  const d = req.data || {};
  const amountCents = Math.round(Number(d.amountCents));
  if (!Number.isFinite(amountCents) || amountCents < LIMITS.minQuoteCents || amountCents > LIMITS.maxQuoteCents) {
    throw new HttpsError('invalid-argument', 'Quote amount must be between KES 1 and KES 10,000,000.');
  }
  const days = Math.round(Number(d.validDays || 7));
  if (!(days >= 1 && days <= LIMITS.maxValidDays)) throw new HttpsError('invalid-argument', 'Validity must be 1–' + LIMITS.maxValidDays + ' days.');
  const durationMins = Math.max(15, Math.min(Math.round(Number(d.durationMins) || 60), 24 * 60));
  const db = _db();
  const w = await _providerLeadsWorkspace(db, uid);
  const serviceId = _san(d.serviceId, 128);
  if (!serviceId) throw new HttpsError('invalid-argument', 'Choose which of your services this quote is for.');
  const s = await db.collection('providerServices').doc(serviceId).get();
  if (!s.exists || s.data().providerId !== uid || s.data().active === false) throw new HttpsError('failed-precondition', 'That service is not one of your active services.');
  const serviceMode = _san(d.serviceMode, 30).toUpperCase();
  if (serviceMode && (!TSP.MODE_CAPS.includes(serviceMode) || !(w.serviceCapabilities || []).includes(serviceMode))) {
    throw new HttpsError('failed-precondition', 'You are not approved to deliver it that way.');
  }
  return _transition(req, 'provider', [STATUS.CREATED, STATUS.VIEWED, STATUS.CLARIFY, STATUS.QUOTE_SENT], (cur) => {
    const version = ((cur.quote && cur.quote.version) || 0) + 1;
    return {
      status: STATUS.QUOTE_SENT,
      quote: { amountCents, currency: 'KES', serviceId, description: _san(d.description, LIMITS.notesLen), durationMins, serviceMode,
        notes: _san(d.notes, LIMITS.notesLen), validUntil: Date.now() + days * 86400000, version, sentAt: Date.now() },
      __event: _event('provider', 'quote_sent', { version, amountCents }),
    };
  });
};

_h.leadRespond = async (req) => {
  const action = _san((req.data || {}).action, 20);
  if (!['accept', 'decline', 'clarify'].includes(action)) throw new HttpsError('invalid-argument', 'action must be accept, decline or clarify.');
  return _transition(req, 'customer', [STATUS.QUOTE_SENT], (cur) => {
    if (action === 'accept') {
      if (!cur.quote || Number(cur.quote.validUntil) < Date.now()) throw new HttpsError('failed-precondition', 'This quote has expired. Ask the provider for a new one.', { code: 'LEAD_QUOTE_EXPIRED' });
      return { status: STATUS.ACCEPTED, __event: _event('customer', 'quote_accepted', { version: cur.quote.version }) };
    }
    if (action === 'decline') return { status: STATUS.QUOTE_DECLINED, __event: _event('customer', 'quote_declined') };
    return { status: STATUS.CLARIFY, __event: _event('customer', 'clarification_requested', { message: _san((req.data || {}).message, 500) }) };
  });
};

_h.leadClose = (req) => _transition(req, 'customer', OPEN, () => ({ status: STATUS.CLOSED, __event: _event('customer', 'closed') }));

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
  const q = lead.quote || {};
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

module.exports = { _h, STATUS, OPEN, LIMITS, MONETIZATION, quoteForBooking, convertIn };
