/* SOKONI — Entertainment Messaging Controls, Enquiries and Call Requests  functions/ent-enquiries.js
 * ============================================================================================
 * PUBLIC ENQUIRY FIRST, PRIVATE CONVERSATION AFTER A REAL RELATIONSHIP.
 *
 * This is not a messaging system. Every conversation is the canonical `conversations/{id}`
 * (functions/messages.js) — the inbox, chat.html, moderation and retention are unchanged. What this
 * module adds is the CONTROL in front of it:
 *
 *   entMessagingSettings/{uid}       who may enquire, business hours, response time, public info,
 *                                    templates, call-request policy (server-validated, owner-written)
 *   entEnquiries/{id}                a STRUCTURED enquiry: category · question · service · date ·
 *                                    budget, and a server-owned state machine:
 *                                    OPEN → ACKNOWLEDGED → RESPONDED → PROPOSAL_SENT →
 *                                    BOOKING_PENDING → CONVERTED   ·  CLOSED · EXPIRED · BLOCKED
 *   conversations/ent_enquiry_{id}   created by the SERVER when (and only when) an enquiry is sent
 *   entEnquiryLimits/{…}             server rate limits (per buyer, per buyer→provider, per provider)
 *   entEnquiryDedup/{…}              duplicate-enquiry suppression (create-once per 24 h)
 *   entBlocks/{providerUid}_{uid}    a provider's block of a user from PUBLIC enquiries
 *   entCallRequests/{id}             REQUEST CALL → accept / decline / schedule — never an instant ring
 *
 * A private booking conversation (ent_booking_*, entertainment-bookings.js) is TRANSACTIONAL: no
 * setting, block or limit here can close it. A buyer who has paid always keeps their channel.
 */
'use strict';
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const crypto = require('crypto');

const COL = Object.freeze({ SETTINGS: 'entMessagingSettings', ENQ: 'entEnquiries', LIMITS: 'entEnquiryLimits', DEDUP: 'entEnquiryDedup',
  BLOCKS: 'entBlocks', CALLS: 'entCallRequests', REPORTS: 'moderationQueue', AUDIT: 'entCommsAudit' });
const STATUS = Object.freeze({ OPEN: 'OPEN', ACKNOWLEDGED: 'ACKNOWLEDGED', RESPONDED: 'RESPONDED', PROPOSAL_SENT: 'PROPOSAL_SENT',
  BOOKING_PENDING: 'BOOKING_PENDING', CONVERTED: 'CONVERTED', CLOSED: 'CLOSED', EXPIRED: 'EXPIRED', BLOCKED: 'BLOCKED' });
const OPEN_STATES = new Set([STATUS.OPEN, STATUS.ACKNOWLEDGED, STATUS.RESPONDED, STATUS.PROPOSAL_SENT, STATUS.BOOKING_PENDING]);
const TERMINAL = new Set([STATUS.CONVERTED, STATUS.CLOSED, STATUS.EXPIRED, STATUS.BLOCKED]);
/* Allowed transitions — the only moves the server will make. */
const NEXT = Object.freeze({
  OPEN: ['ACKNOWLEDGED', 'RESPONDED', 'PROPOSAL_SENT', 'CLOSED', 'EXPIRED', 'BLOCKED'],
  ACKNOWLEDGED: ['RESPONDED', 'PROPOSAL_SENT', 'CLOSED', 'EXPIRED', 'BLOCKED'],
  RESPONDED: ['RESPONDED', 'PROPOSAL_SENT', 'CLOSED', 'EXPIRED', 'BLOCKED'],
  PROPOSAL_SENT: ['PROPOSAL_SENT', 'RESPONDED', 'BOOKING_PENDING', 'CLOSED', 'EXPIRED', 'BLOCKED'],
  BOOKING_PENDING: ['CONVERTED', 'PROPOSAL_SENT', 'CLOSED', 'BLOCKED'],
});
const CATEGORIES = Object.freeze(['AVAILABILITY', 'PRICING', 'SERVICE_DETAILS', 'LOCATION', 'CUSTOM_REQUEST', 'EVENT_QUESTION', 'COLLABORATION', 'OTHER']);
const WHO = Object.freeze(['ANYONE', 'VERIFIED', 'PURCHASED', 'ACTIVE_BOOKING', 'NOBODY']);
const RESPONSE_TIMES = Object.freeze(['WITHIN_15_MIN', 'WITHIN_1_HOUR', 'SAME_DAY', 'WITHIN_24_HOURS', 'CUSTOM']);
const TEMPLATE_KEYS = Object.freeze(['WELCOME', 'AWAY', 'BOOKING_CONFIRMATION', 'PAYMENT_INSTRUCTION', 'LOCATION', 'FAQ', 'REFUND_POLICY']);
/* Anti-spam limits (server-side; the client limit is only a courtesy). */
const LIMITS = Object.freeze({ perBuyerPerDay: 10, openPerPair: 3, pairCooldownMs: 2 * 60000, perProviderPerDay: 300,
  dedupWindowMs: 24 * 3600000, enquiryTtlMs: 14 * 86400000, msgPerHour: 30, callsPerPairPerDay: 3 });
/* An automated message may never CLAIM a money or booking outcome — only the backend state can. */
const CLAIM_RE = /(payment|paid)\s*(is\s*|has\s*been\s*)?(complete|completed|received|confirmed|successful)|booking\s*(is\s*|has\s*been\s*)?confirmed|refund(ed)?\s*(is\s*|has\s*been\s*)?(complete|completed|processed|sent|issued)|you\s*have\s*been\s*refunded/i;

const _db = () => admin.firestore();
const _FV = () => admin.firestore.FieldValue;
let _now = () => Date.now();
const fail = (code, msg, details) => { throw new HttpsError(code, msg, details); };
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n || 200);
const _need = (req) => { const u = req && req.auth && req.auth.uid; if (!u) fail('unauthenticated', 'Sign in required.'); return u; };
const _tok = (req) => (req && req.auth && req.auth.token) || {};
const _isAdmin = (req) => { const t = _tok(req); return t.admin === true || t.superAdmin === true || t.role === 'admin' || t.role === 'superAdmin'; };
const _isSuper = (req) => { const t = _tok(req); return t.superAdmin === true || t.role === 'superAdmin'; };
const _day = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 10);
const _hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function _audit(entry) {
  try { await _db().collection(COL.AUDIT).add(Object.assign({ at: _now(), createdAt: _FV().serverTimestamp() }, entry)); }
  catch (e) { console.error('[ent-enquiries] audit failed', e.message); }
}

/* ── settings ──────────────────────────────────────────────────────────────────────────── */
const DEFAULT_SETTINGS = Object.freeze({ whoCanMessage: 'ANYONE', enquiriesEnabled: true, enquiryCategories: CATEGORIES.slice(),
  callRequests: 'DISABLED', businessHours: null, outsideHoursAcceptEnquiries: true, responseTime: null, responseTimeCustom: null,
  publicInfo: {}, templates: {} });
async function settingsOf(uid) {
  const s = await _db().collection(COL.SETTINGS).doc(uid).get();
  return Object.assign({}, DEFAULT_SETTINGS, s.exists ? s.data() : {});
}
function _hours(h) {
  if (!h || !Array.isArray(h.weekly)) return null;
  const weekly = [];
  for (let i = 0; i < 7; i++) {
    const p = (h.weekly[i] || []).filter((x) => x && /^\d{2}:\d{2}$/.test(x.open) && /^\d{2}:\d{2}$/.test(x.close) && x.close > x.open).slice(0, 3)
      .map((x) => ({ open: x.open, close: x.close }));
    weekly.push(p);
  }
  return { timezone: 'Africa/Nairobi', weekly };
}
function openNow(hours, nowMs) {
  if (!hours) return null;                                       /* not published → unknown, never "online" */
  const d = new Date(nowMs + 3 * 3600000);
  const dow = d.getUTCDay(); const t = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  return (hours.weekly[dow] || []).some((p) => p.open <= t && t < p.close);
}
function validTemplate(key, text) {
  if (!TEMPLATE_KEYS.includes(key)) return 'Unknown template.';
  if (CLAIM_RE.test(text)) return 'A template may not claim that a payment, booking or refund is complete — SOKONI sends those confirmations from the real state.';
  return null;
}

/* Who is the provider behind a calendar, and may the PUBLIC contact them now? */
async function _providerGate(providerUid) {
  const AV = require('./ent-availability');
  let cal = null;
  try { cal = await AV.loadCalendar('svc_' + providerUid); } catch (_) { cal = null; }
  if (!cal) return { ok: false, code: 'NOT_FOUND' };
  const code = cal.bookable.code;
  /* Enquiries are allowed while a provider is simply not configured / not accepting bookings, but
     never for an unverified, unapproved or suspended one. */
  if (['NOT_VERIFIED', 'NOT_APPROVED', 'SUSPENDED'].includes(code)) return { ok: false, code, cal };
  return { ok: true, cal };
}
/* Venue owners enquire through their own uid too; the venue says who owns it. */
async function _resolveProvider(d) {
  if (d.venueId) {
    const v = await _db().collection('venues').doc(String(d.venueId)).get();
    if (!v.exists) fail('not-found', 'Not found.');
    if (v.data().status !== 'active') fail('failed-precondition', 'This venue is not taking enquiries.');
    return { providerUid: v.data().ownerId, calKey: 'ven_' + v.id, name: v.data().name || 'Venue' };
  }
  const uid = _san(d.providerId, 128);
  if (!uid) fail('invalid-argument', 'Choose a provider.');
  const g = await _providerGate(uid);
  if (!g.ok) fail('failed-precondition', 'This provider is not taking enquiries right now.');
  return { providerUid: uid, calKey: g.cal.calKey, name: g.cal.name || 'Provider' };
}

/* Does the buyer satisfy the provider's "who can message me"? */
async function _allowedBy(who, buyerUid, providerUid, token) {
  if (who === 'ANYONE') return true;
  if (who === 'NOBODY') return false;
  if (who === 'VERIFIED') return token.email_verified === true || !!token.phone_number;
  const pb = await _db().collection('providerBookings').where('providerId', '==', providerUid).where('customerUid', '==', buyerUid).limit(20).get();
  const rows = pb.docs.map((x) => x.data());
  if (who === 'PURCHASED') return rows.some((b) => ['paid_held', 'settled'].includes(b.paymentStatus) || b.status === 'completed');
  if (who === 'ACTIVE_BOOKING') return rows.some((b) => ['pending', 'confirmed', 'in_progress'].includes(b.status));
  return false;
}

const _h = {};

/** Owner: read / write messaging settings. */
_h.entMessagingGetSettings = async (req) => {
  const uid = _need(req);
  const s = await settingsOf(uid);
  return { settings: s, openNow: openNow(s.businessHours, _now()) };
};
_h.entMessagingSetSettings = async (req) => {
  const uid = _need(req);
  const d = (req.data || {}).settings || {};
  const out = {};
  if (d.whoCanMessage != null) { if (!WHO.includes(d.whoCanMessage)) fail('invalid-argument', 'Unknown option.'); out.whoCanMessage = d.whoCanMessage; }
  if (d.enquiriesEnabled != null) out.enquiriesEnabled = d.enquiriesEnabled === true;
  if (Array.isArray(d.enquiryCategories)) out.enquiryCategories = d.enquiryCategories.filter((c) => CATEGORIES.includes(c));
  if (d.callRequests != null) { if (!['ENABLED', 'DISABLED'].includes(d.callRequests)) fail('invalid-argument', 'Unknown option.'); out.callRequests = d.callRequests; }
  if (d.businessHours !== undefined) out.businessHours = _hours(d.businessHours);
  if (d.outsideHoursAcceptEnquiries != null) out.outsideHoursAcceptEnquiries = d.outsideHoursAcceptEnquiries !== false;
  if (d.responseTime !== undefined) { if (d.responseTime !== null && !RESPONSE_TIMES.includes(d.responseTime)) fail('invalid-argument', 'Unknown response time.'); out.responseTime = d.responseTime; }
  if (d.responseTimeCustom !== undefined) out.responseTimeCustom = _san(d.responseTimeCustom, 80) || null;
  if (d.publicInfo) {
    const p = d.publicInfo; const pi = {};
    ['serviceDescription', 'location', 'availabilityPolicy', 'cancellationPolicy', 'bookingRequirements', 'minimumNotice'].forEach((k) => { if (p[k] != null) pi[k] = _san(p[k], 1000); });
    if (p.pricingFromCents != null) pi.pricingFromCents = Math.max(0, Math.round(Number(p.pricingFromCents) || 0));
    if (Array.isArray(p.faqs)) pi.faqs = p.faqs.slice(0, 20).map((f) => ({ q: _san(f && f.q, 200), a: _san(f && f.a, 1000) })).filter((f) => f.q && f.a);
    out.publicInfo = pi;
  }
  if (d.templates) {
    const t = {};
    for (const k of Object.keys(d.templates)) {
      const text = _san(d.templates[k], 1000);
      if (!text) continue;
      const bad = validTemplate(k, text);
      if (bad) fail('invalid-argument', bad, { code: 'TEMPLATE_CLAIM', key: k });
      t[k] = text;
    }
    out.templates = t;
  }
  out.updatedAt = _FV().serverTimestamp();
  await _db().collection(COL.SETTINGS).doc(uid).set(out, { merge: true });
  await _audit({ actor: uid, action: 'settings', fields: Object.keys(out) });
  return { ok: true };
};

/** PUBLIC: what a storefront shows before "Send enquiry". Never claims "online". */
_h.entMessagingPublic = async (req) => {
  const d = req.data || {};
  let providerUid = null; let bookable = false; let verifiedOk = false;
  if (d.venueId) {
    const v = await _db().collection('venues').doc(String(d.venueId)).get();
    if (!v.exists) fail('not-found', 'Not found.');
    providerUid = v.data().ownerId; verifiedOk = v.data().status === 'active'; bookable = verifiedOk;
  } else {
    providerUid = _san(d.providerId, 128);
    if (!providerUid) fail('invalid-argument', 'Choose a provider.');
    const g = await _providerGate(providerUid);
    verifiedOk = g.ok; bookable = !!(g.cal && g.cal.bookable.ok);
  }
  const s = await settingsOf(providerUid);
  const on = openNow(s.businessHours, _now());
  const viewer = req.auth && req.auth.uid;
  let blocked = false;
  if (viewer) blocked = (await _db().collection(COL.BLOCKS).doc(`${providerUid}_${viewer}`).get()).exists;
  const enquiriesOpen = verifiedOk && s.enquiriesEnabled !== false && s.whoCanMessage !== 'NOBODY' && !blocked && (on !== false || s.outsideHoursAcceptEnquiries !== false);
  return {
    bookable, enquiriesOpen, callRequestsOpen: verifiedOk && s.callRequests === 'ENABLED' && !blocked,
    whoCanMessage: s.whoCanMessage, enquiryCategories: s.enquiryCategories && s.enquiryCategories.length ? s.enquiryCategories : CATEGORIES,
    businessHours: s.businessHours, openNow: on, availabilityNote: on === false ? 'Provider is currently unavailable.' : null,
    responseTime: s.responseTime, responseTimeCustom: s.responseTimeCustom, publicInfo: s.publicInfo || {},
  };
};

/**
 * Send a structured enquiry. Server-side: provider gate, "who can message me", blocks, per-buyer /
 * per-pair / per-provider limits, cooldown, duplicate suppression. Creates the enquiry AND its
 * conversation (ent_enquiry_{id}) — the only way an enquiry conversation comes to exist.
 */
_h.entEnquirySend = async (req) => {
  const buyerUid = _need(req);
  if (_tok(req).deactivated === true) fail('permission-denied', 'Your account is deactivated.');
  const d = req.data || {};
  const prov = await _resolveProvider(d);
  if (prov.providerUid === buyerUid) fail('failed-precondition', 'You cannot enquire with yourself.');
  const s = await settingsOf(prov.providerUid);
  if (s.enquiriesEnabled === false || s.whoCanMessage === 'NOBODY') fail('failed-precondition', 'This provider is not taking public enquiries.', { code: 'ENQUIRIES_DISABLED' });
  if (openNow(s.businessHours, _now()) === false && s.outsideHoursAcceptEnquiries === false) fail('failed-precondition', 'Provider is currently unavailable. Try again during business hours.', { code: 'OUTSIDE_HOURS' });
  if (!(await _allowedBy(s.whoCanMessage, buyerUid, prov.providerUid, _tok(req)))) fail('permission-denied', 'This provider only accepts enquiries from certain customers.', { code: 'NOT_ALLOWED' });
  if ((await _db().collection(COL.BLOCKS).doc(`${prov.providerUid}_${buyerUid}`).get()).exists) fail('permission-denied', 'You cannot send enquiries to this provider.', { code: 'BLOCKED' });
  const category = CATEGORIES.includes(d.category) ? d.category : null;
  if (!category) fail('invalid-argument', 'Choose what your enquiry is about.');
  const cats = s.enquiryCategories && s.enquiryCategories.length ? s.enquiryCategories : CATEGORIES;
  if (!cats.includes(category)) fail('invalid-argument', 'This provider does not take that kind of enquiry.');
  const question = _san(d.question, 1500);
  if (question.length < 10) fail('invalid-argument', 'Write your question (at least 10 characters).');
  const CORE = require('./shared/ent-availability-core');
  const desiredDate = d.desiredDate && CORE.isDate(d.desiredDate) ? d.desiredDate : null;
  const preferredTime = /^\d{2}:\d{2}$/.test(String(d.preferredTime || '')) ? d.preferredTime : null;
  const budgetCents = d.budgetCents != null ? Math.max(0, Math.min(100000000, Math.round(Number(d.budgetCents) || 0))) : null;
  let serviceId = null; let serviceName = null;
  if (d.serviceId) {
    const sv = await _db().collection('providerServices').doc(_san(d.serviceId, 128)).get();
    if (!sv.exists || sv.data().providerId !== prov.providerUid) fail('invalid-argument', 'That service is not offered here.');
    serviceId = sv.id; serviceName = _san(sv.data().name, 120);
  }
  /* The open-count for the pair — bounded query, read BEFORE the limits transaction. */
  const openPair = await _db().collection(COL.ENQ).where('providerUid', '==', prov.providerUid).where('buyerUid', '==', buyerUid).limit(50).get();
  if (openPair.docs.filter((x) => OPEN_STATES.has(x.data().status)).length >= LIMITS.openPerPair) {
    fail('resource-exhausted', 'You already have open enquiries with this provider. Continue in those conversations.', { code: 'TOO_MANY_OPEN' });
  }
  const now = _now(); const day = _day(now);
  const hash = _hash(`${_norm(question)}|${category}|${serviceId || ''}|${desiredDate || ''}`);
  const buyerRef = _db().collection(COL.LIMITS).doc('b_' + buyerUid);
  const provRef = _db().collection(COL.LIMITS).doc('p_' + prov.providerUid);
  const dedupRef = _db().collection(COL.DEDUP).doc(`${prov.providerUid}_${buyerUid}_${hash}`);
  const enqRef = _db().collection(COL.ENQ).doc();
  await _db().runTransaction(async (txn) => {
    const [b, p, dd] = [await txn.get(buyerRef), await txn.get(provRef), await txn.get(dedupRef)];
    const bd = b.exists ? b.data() : {}; const pd = p.exists ? p.data() : {};
    if (dd.exists && now - (Number(dd.data().at) || 0) < LIMITS.dedupWindowMs) fail('already-exists', 'You already sent this enquiry. The provider will reply in the conversation.', { code: 'DUPLICATE' });
    const bCount = bd.day === day ? Number(bd.count) || 0 : 0;
    if (bCount >= LIMITS.perBuyerPerDay) fail('resource-exhausted', 'You have sent the maximum number of enquiries for today.', { code: 'RATE_LIMITED' });
    const last = (bd.last || {})[prov.providerUid] || 0;
    if (now - last < LIMITS.pairCooldownMs) fail('resource-exhausted', 'Please wait a moment before sending another enquiry to this provider.', { code: 'COOLDOWN' });
    const pCount = pd.day === day ? Number(pd.count) || 0 : 0;
    if (pCount >= LIMITS.perProviderPerDay) fail('resource-exhausted', 'This provider is receiving too many enquiries right now. Please try later.', { code: 'PROVIDER_LIMIT' });
    txn.set(buyerRef, { day, count: bCount + 1, last: Object.assign({}, bd.last || {}, { [prov.providerUid]: now }), updatedAt: now });
    txn.set(provRef, { day, count: pCount + 1, updatedAt: now });
    txn.set(dedupRef, { at: now, enquiryId: enqRef.id });
    txn.set(enqRef, { enquiryId: enqRef.id, providerUid: prov.providerUid, buyerUid, calKey: prov.calKey, category, question, serviceId, serviceName,
      desiredDate, preferredTime, budgetCents, status: STATUS.OPEN, conversationId: `ent_enquiry_${enqRef.id}`, hash,
      history: [{ status: STATUS.OPEN, at: now, by: buyerUid }], expiresAt: now + LIMITS.enquiryTtlMs, createdAt: _FV().serverTimestamp(), updatedAt: _FV().serverTimestamp() });
  });
  const MSG = require('./messages');
  const title = `Enquiry · ${category.replace(/_/g, ' ').toLowerCase()}${serviceName ? ' · ' + serviceName : ''}`;
  await MSG.ensureAnchoredConversation(_db(), { transactionType: 'ent_enquiry', transactionId: enqRef.id, title, participants: [buyerUid, prov.providerUid],
    metadata: { enquiryId: enqRef.id, category, serviceId, desiredDate, mode: 'PUBLIC' } });
  const summary = [`ENQUIRY ${enqRef.id.slice(0, 8).toUpperCase()} · ${category.replace(/_/g, ' ')}`, serviceName ? `Service: ${serviceName}` : null,
    desiredDate ? `Date: ${desiredDate}${preferredTime ? ' ' + preferredTime : ''}` : null, budgetCents != null ? `Budget: KES ${(budgetCents / 100).toLocaleString('en-KE')}` : null,
    `Question: ${question}`].filter(Boolean).join('\n');
  await MSG.postSystemMessage(_db(), `ent_enquiry_${enqRef.id}`, 'enquiry_open', summary, { kind: 'enquiry', status: STATUS.OPEN, tag: 'enquiry' });
  if (s.templates && s.templates.WELCOME) await MSG.postSystemMessage(_db(), `ent_enquiry_${enqRef.id}`, 'welcome', s.templates.WELCOME, { kind: 'template', tag: 'enquiry' });
  if (openNow(s.businessHours, now) === false && s.templates && s.templates.AWAY) await MSG.postSystemMessage(_db(), `ent_enquiry_${enqRef.id}`, 'away', s.templates.AWAY, { kind: 'template', tag: 'enquiry' });
  try {
    await require('./notify').notify({ uid: prov.providerUid, type: 'ent_enquiry_new', title: 'New enquiry', body: `${category.replace(/_/g, ' ').toLowerCase()}${serviceName ? ' — ' + serviceName : ''}`,
      deepLink: `/chat.html?id=ent_enquiry_${enqRef.id}`, dedupeKey: `ent_enquiry_new_${enqRef.id}`, awaitDelivery: false, anchorType: 'enquiry', anchorId: enqRef.id });
  } catch (_) { /* notification is best-effort */ }
  return { ok: true, enquiryId: enqRef.id, conversationId: `ent_enquiry_${enqRef.id}` };
};

/** Server-only state move (also used by quotes and the booking identity). */
async function transition(enquiryId, to, opts) {
  const o = opts || {};
  const ref = _db().collection(COL.ENQ).doc(String(enquiryId));
  let from = null; let conv = null;
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) fail('not-found', 'Enquiry not found.');
    const e = s.data(); from = e.status; conv = e.conversationId;
    if (from === to && !['RESPONDED', 'PROPOSAL_SENT'].includes(to)) return;
    if (!(NEXT[from] || []).includes(to)) fail('failed-precondition', `An enquiry cannot move from ${from} to ${to}.`);
    const patch = { status: to, updatedAt: _FV().serverTimestamp(), history: _FV().arrayUnion({ status: to, at: _now(), by: o.by || 'system' }) };
    if (o.quoteId) patch.quoteId = o.quoteId;
    if (o.bookingId) patch.bookingId = o.bookingId;
    if (TERMINAL.has(to)) patch.closedAt = _now();
    txn.update(ref, patch);
  });
  if (conv && from !== to && o.note !== false) {
    await require('./messages').postSystemMessage(_db(), conv, `enq_${to.toLowerCase()}_${_now()}`, o.note || `Enquiry ${to.replace(/_/g, ' ').toLowerCase()}.`, { kind: 'enquiry', status: to, tag: 'enquiry' }).catch(() => {});
  }
  return { from, to };
}

async function _ownEnquiry(req, asProvider) {
  const uid = _need(req);
  const id = _san((req.data || {}).enquiryId, 128);
  const s = await _db().collection(COL.ENQ).doc(id).get();
  if (!s.exists) fail('not-found', 'Enquiry not found.');
  const e = s.data();
  const isProv = e.providerUid === uid; const isBuyer = e.buyerUid === uid;
  if (asProvider === true && !isProv) fail('permission-denied', 'Only the provider can do that.');
  if (!isProv && !isBuyer) fail('not-found', 'Enquiry not found.');
  return { uid, id, e, isProv, isBuyer };
}
_h.entEnquiryAcknowledge = async (req) => { const { uid, id } = await _ownEnquiry(req, true); return transition(id, STATUS.ACKNOWLEDGED, { by: uid, note: 'The provider has seen your enquiry.' }); };
/** Provider reply from a TEMPLATE (validated) — free-text replies go through the normal chat. */
_h.entEnquiryReply = async (req) => {
  const { uid, id, e } = await _ownEnquiry(req, true);
  if (TERMINAL.has(e.status)) fail('failed-precondition', 'This enquiry is closed.');
  const key = String((req.data || {}).template || '');
  const s = await settingsOf(uid);
  const text = s.templates && s.templates[key];
  if (!text) fail('invalid-argument', 'That template is not set up.');
  const bad = validTemplate(key, text);
  if (bad) fail('failed-precondition', bad);
  await require('./messages').postSystemMessage(_db(), e.conversationId, `tpl_${key}_${_now()}`, text, { kind: 'template', tag: 'enquiry' });
  return transition(id, STATUS.RESPONDED, { by: uid, note: false });
};
_h.entEnquiryClose = async (req) => { const { uid, id } = await _ownEnquiry(req); return transition(id, STATUS.CLOSED, { by: uid, note: 'The enquiry was closed.' }); };
_h.entEnquiryGet = async (req) => {
  const { e, isProv, id } = await _ownEnquiry(req);
  return { enquiry: { id, status: e.status, category: e.category, question: e.question, serviceId: e.serviceId, serviceName: e.serviceName, desiredDate: e.desiredDate,
    preferredTime: e.preferredTime, budgetCents: e.budgetCents, conversationId: e.conversationId, quoteId: e.quoteId || null, bookingId: e.bookingId || null,
    role: isProv ? 'provider' : 'buyer', counterparty: isProv ? e.buyerUid : e.providerUid, calKey: e.calKey, createdAt: e.createdAt || null } };
};
/** Provider / buyer lists — scoped to the caller; filterable; no cross-provider search. */
_h.entEnquiryList = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const asProv = d.as === 'provider';
  const s = await _db().collection(COL.ENQ).where(asProv ? 'providerUid' : 'buyerUid', '==', uid).limit(200).get();
  const now = _now();
  let rows = s.docs.map((x) => { const e = x.data(); const st = OPEN_STATES.has(e.status) && e.expiresAt && e.expiresAt <= now && e.status === STATUS.OPEN ? STATUS.EXPIRED : e.status;
    return { id: x.id, status: st, category: e.category, serviceId: e.serviceId, serviceName: e.serviceName, desiredDate: e.desiredDate, conversationId: e.conversationId,
      quoteId: e.quoteId || null, bookingId: e.bookingId || null, createdAtMs: (e.history && e.history[0] && e.history[0].at) || null, counterparty: asProv ? e.buyerUid : e.providerUid }; });
  if (d.status) rows = rows.filter((r) => r.status === d.status);
  if (d.serviceId) rows = rows.filter((r) => r.serviceId === d.serviceId);
  rows.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return { enquiries: rows };
};

/* Blocks (PUBLIC enquiries only) and reports. */
_h.entEnquiryBlockUser = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const target = _san(d.uid, 128);
  if (!target || target === uid) fail('invalid-argument', 'Choose a user.');
  const ref = _db().collection(COL.BLOCKS).doc(`${uid}_${target}`);
  if (d.unblock) await ref.delete();
  else await ref.set({ providerUid: uid, userUid: target, scope: 'PUBLIC_ENQUIRIES', reason: _san(d.reason, 300) || null, createdAt: _FV().serverTimestamp() });
  if (!d.unblock) {
    const open = await _db().collection(COL.ENQ).where('providerUid', '==', uid).where('buyerUid', '==', target).limit(50).get();
    for (const x of open.docs) if (OPEN_STATES.has(x.data().status)) await transition(x.id, STATUS.BLOCKED, { by: uid, note: 'This enquiry is closed.' }).catch(() => {});
  }
  await _audit({ actor: uid, action: d.unblock ? 'unblock' : 'block', target });
  return { ok: true };
};
_h.entReportProvider = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const providerUid = _san(d.providerUid, 128);
  const reason = _san(d.reason, 500);
  if (!providerUid || reason.length < 5) fail('invalid-argument', 'Tell us what happened.');
  const day = _day(_now());
  const ref = _db().collection(COL.REPORTS).doc(`ent_report_${uid}_${providerUid}_${day}`);
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (s.exists) fail('already-exists', 'You already reported this provider today.');
    txn.set(ref, { type: 'ent_provider_report', reporterUid: uid, subjectUid: providerUid, reason, conversationId: _san(d.conversationId, 160) || null,
      status: 'pending', createdAt: _FV().serverTimestamp() });
  });
  if (d.block) await _db().collection(COL.BLOCKS).doc(`b_${uid}_${providerUid}`).set({ buyerUid: uid, providerUid, scope: 'BUYER_HIDES_PROVIDER_ENQUIRIES', createdAt: _FV().serverTimestamp() });
  return { ok: true };
};

/**
 * Gate for sending in an ENQUIRY conversation (called by messages.sendMessage). Booking
 * conversations never reach this — they are transactional. Refusals are explicit errors; a
 * legitimate message is never silently dropped.
 */
async function assertCanSend(db, conv, uid, text) {
  if (!conv || conv.transactionType !== 'ent_enquiry') return;
  const e = await _db().collection(COL.ENQ).doc(String(conv.transactionId)).get();
  if (!e.exists) fail('failed-precondition', 'This enquiry no longer exists.');
  const x = e.data();
  if (TERMINAL.has(x.status) || x.status === STATUS.BLOCKED) fail('failed-precondition', 'This enquiry is closed. Send a new enquiry or book to continue.');
  if (uid === x.buyerUid && (await _db().collection(COL.BLOCKS).doc(`${x.providerUid}_${uid}`).get()).exists) fail('permission-denied', 'You cannot message this provider.');
  if (uid === x.providerUid && (await _db().collection(COL.BLOCKS).doc(`b_${x.buyerUid}_${uid}`).get()).exists) fail('permission-denied', 'This customer is not accepting messages from you.');
  const ref = _db().collection(COL.LIMITS).doc(`m_${conv.transactionId}_${uid}`);
  const now = _now(); const hour = Math.floor(now / 3600000); const h = _hash(_norm(text || ''));
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    const cur = s.exists ? s.data() : {};
    const count = cur.hour === hour ? Number(cur.count) || 0 : 0;
    if (count >= LIMITS.msgPerHour) fail('resource-exhausted', 'You are sending messages too quickly. Please wait a little.', { code: 'RATE_LIMITED' });
    if (text && cur.lastHash === h && now - (Number(cur.lastAt) || 0) < 60000) fail('already-exists', 'You just sent that message.', { code: 'DUPLICATE' });
    txn.set(ref, { hour, count: count + 1, lastHash: text ? h : cur.lastHash || null, lastAt: now });
  });
  /* The provider's first human reply marks the enquiry RESPONDED. */
  if (uid === x.providerUid && [STATUS.OPEN, STATUS.ACKNOWLEDGED].includes(x.status)) await transition(e.id, STATUS.RESPONDED, { by: uid, note: false }).catch(() => {});
}

/* ── call requests ─────────────────────────────────────────────────────────────────────── */
/**
 * REQUEST CALL. Public (an enquiry) only if the provider enabled call requests; private (an active
 * booking) always, because it is transactional. Never rings anyone — the provider accepts,
 * declines or schedules; the call itself is carried by SOKONI Connect (no phone numbers).
 */
_h.entCallRequest = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const ctx = d.context || {};
  let providerUid = null; let buyerUid = uid; let mode = null; let contextId = _san(ctx.id, 160);
  if (ctx.type === 'enquiry') {
    const e = await _db().collection(COL.ENQ).doc(contextId).get();
    if (!e.exists || e.data().buyerUid !== uid) fail('not-found', 'Enquiry not found.');
    if (TERMINAL.has(e.data().status)) fail('failed-precondition', 'This enquiry is closed.');
    providerUid = e.data().providerUid; mode = 'PUBLIC';
    const s = await settingsOf(providerUid);
    if (s.callRequests !== 'ENABLED') fail('failed-precondition', 'This provider does not take call requests.', { code: 'CALLS_DISABLED' });
    if ((await _db().collection(COL.BLOCKS).doc(`${providerUid}_${uid}`).get()).exists) fail('permission-denied', 'You cannot contact this provider.');
  } else if (ctx.type === 'booking') {
    const env = await _db().collection('entBookings').doc(contextId).get();
    if (!env.exists) fail('not-found', 'Booking not found.');
    const b = env.data();
    if (b.buyerUid !== uid && b.providerUid !== uid) fail('not-found', 'Booking not found.');
    if (['CANCELLED', 'REFUNDED', 'EXPIRED', 'COMPLETED'].includes(String(b.status || '').toUpperCase())) fail('failed-precondition', 'This booking is closed.');
    providerUid = b.providerUid; buyerUid = b.buyerUid; mode = 'PRIVATE';
  } else fail('invalid-argument', 'A call request belongs to an enquiry or a booking.');
  const requester = uid; const recipient = uid === providerUid ? buyerUid : providerUid;
  const day = _day(_now());
  const limRef = _db().collection(COL.LIMITS).doc(`c_${requester}_${recipient}_${day}`);
  const ref = _db().collection(COL.CALLS).doc();
  const openQ = await _db().collection(COL.CALLS).where('requesterUid', '==', requester).where('recipientUid', '==', recipient).limit(20).get();
  if (openQ.docs.some((x) => ['REQUESTED', 'ACCEPTED', 'SCHEDULED'].includes(x.data().status))) fail('already-exists', 'You already have a call request waiting.', { code: 'OPEN_REQUEST' });
  await _db().runTransaction(async (txn) => {
    const l = await txn.get(limRef);
    const n = l.exists ? Number(l.data().count) || 0 : 0;
    if (n >= LIMITS.callsPerPairPerDay) fail('resource-exhausted', 'You have reached today\'s call requests for this provider.', { code: 'RATE_LIMITED' });
    txn.set(limRef, { count: n + 1, updatedAt: _now() });
    txn.set(ref, { requestId: ref.id, mode, context: { type: ctx.type, id: contextId }, requesterUid: requester, recipientUid: recipient, providerUid, buyerUid,
      note: _san(d.note, 300) || null, status: 'REQUESTED', createdAt: _FV().serverTimestamp(), updatedAt: _FV().serverTimestamp(), createdAtMs: _now() });
  });
  try { await require('./notify').notify({ uid: recipient, type: 'ent_call_request', title: 'Call request', body: 'A customer asked for a call.', deepLink: '/chat.html', dedupeKey: `ent_call_${ref.id}`, awaitDelivery: false, anchorType: ctx.type, anchorId: contextId }); } catch (_) { /* best-effort */ }
  return { ok: true, requestId: ref.id, status: 'REQUESTED' };
};
_h.entCallRespond = async (req) => {
  const uid = _need(req);
  const d = req.data || {};
  const ref = _db().collection(COL.CALLS).doc(_san(d.requestId, 128));
  const action = String(d.action || '');
  let out = null;
  let scheduleMs = null;
  if (action === 'schedule') {
    scheduleMs = Number(d.atMs);
    if (!Number.isFinite(scheduleMs) || scheduleMs < _now() + 5 * 60000 || scheduleMs > _now() + 30 * 86400000) fail('invalid-argument', 'Choose a time from 5 minutes to 30 days ahead.');
    const s = await settingsOf(uid);
    if (s.businessHours && openNow(s.businessHours, scheduleMs) === false) fail('failed-precondition', 'Schedule the call inside your business hours.');
  }
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) fail('not-found', 'Call request not found.');
    const c = s.data();
    if (action === 'cancel') {
      if (c.requesterUid !== uid) fail('permission-denied', 'Only the requester can cancel.');
      if (!['REQUESTED', 'ACCEPTED', 'SCHEDULED'].includes(c.status)) fail('failed-precondition', 'This request is closed.');
      txn.update(ref, { status: 'CANCELLED', updatedAt: _FV().serverTimestamp() }); out = 'CANCELLED'; return;
    }
    if (c.recipientUid !== uid) fail('permission-denied', 'Only the person asked can answer.');
    if (c.status !== 'REQUESTED') fail('failed-precondition', 'This request has already been answered.');
    if (action === 'accept') { txn.update(ref, { status: 'ACCEPTED', windowFrom: _now(), windowTo: _now() + 30 * 60000, updatedAt: _FV().serverTimestamp() }); out = 'ACCEPTED'; }
    else if (action === 'decline') { txn.update(ref, { status: 'DECLINED', updatedAt: _FV().serverTimestamp() }); out = 'DECLINED'; }
    else if (action === 'schedule') { txn.update(ref, { status: 'SCHEDULED', scheduledFor: scheduleMs, windowFrom: scheduleMs - 10 * 60000, windowTo: scheduleMs + 60 * 60000, updatedAt: _FV().serverTimestamp() }); out = 'SCHEDULED'; }
    else fail('invalid-argument', 'Unknown action.');
  });
  return { ok: true, status: out };
};
_h.entCallList = async (req) => {
  const uid = _need(req);
  const [a, b] = await Promise.all([
    _db().collection(COL.CALLS).where('requesterUid', '==', uid).limit(50).get(),
    _db().collection(COL.CALLS).where('recipientUid', '==', uid).limit(50).get()]);
  const rows = [...a.docs, ...b.docs].map((x) => { const c = x.data(); return { id: x.id, mode: c.mode, context: c.context, status: c.status, scheduledFor: c.scheduledFor || null,
    windowFrom: c.windowFrom || null, windowTo: c.windowTo || null, incoming: c.recipientUid === uid, note: c.note || null, createdAtMs: c.createdAtMs || null }; });
  rows.sort((p, q) => (q.createdAtMs || 0) - (p.createdAtMs || 0));
  return { requests: rows };
};
/**
 * Connect's authorization hook for a PUBLIC enquiry call: only an accepted / scheduled request,
 * inside its window, between exactly its two parties. Returns the two uids or null.
 */
async function authorizeEnquiryCall(requestId, callerUid) {
  const s = await _db().collection(COL.CALLS).doc(String(requestId || '')).get();
  if (!s.exists) return null;
  const c = s.data();
  if (!['ACCEPTED', 'SCHEDULED'].includes(c.status)) return null;
  if (![c.requesterUid, c.recipientUid].includes(callerUid)) return null;
  const now = _now();
  if (!(c.windowFrom <= now && now <= c.windowTo)) return null;
  return { parties: [c.requesterUid, c.recipientUid], mode: c.mode, context: c.context };
}

/* ── expiry (called from the existing 5-minute maintenance job) ─────────────────────────── */
async function sweepExpired(limit) {
  const s = await _db().collection(COL.ENQ).where('expiresAt', '<', _now()).limit(limit || 200).get().catch(() => ({ docs: [] }));
  let n = 0;
  for (const x of s.docs) if (x.data().status === STATUS.OPEN || x.data().status === STATUS.ACKNOWLEDGED) { await transition(x.id, STATUS.EXPIRED, { by: 'system', note: 'This enquiry expired without a reply.' }).catch(() => {}); n++; }
  return n;
}

/* ── AdminOS › Entertainment › Communications ─────────────────────────────────────────── */
const _adminH = {};
_adminH.entAdminCommunications = async (req) => {
  if (!_isAdmin(req)) fail('permission-denied', 'Admin only.');
  const d = req.data || {};
  let q = _db().collection(COL.ENQ);
  if (d.providerUid) q = q.where('providerUid', '==', _san(d.providerUid, 128));
  else if (d.buyerUid) q = q.where('buyerUid', '==', _san(d.buyerUid, 128));
  else if (d.status) q = q.where('status', '==', _san(d.status, 30));
  const s = await q.limit(100).get();
  /* Metadata only: no question text, no message content. */
  const enquiries = s.docs.map((x) => { const e = x.data(); return { id: x.id, status: e.status, category: e.category, providerUid: e.providerUid, buyerUid: e.buyerUid,
    conversationId: e.conversationId, quoteId: e.quoteId || null, bookingId: e.bookingId || null, createdAtMs: (e.history && e.history[0] && e.history[0].at) || null }; });
  const reports = await _db().collection(COL.REPORTS).where('type', '==', 'ent_provider_report').limit(50).get().catch(() => ({ docs: [] }));
  let policy = null;
  if (d.providerUid) { const st = await settingsOf(_san(d.providerUid, 128)); policy = { whoCanMessage: st.whoCanMessage, enquiriesEnabled: st.enquiriesEnabled, callRequests: st.callRequests, businessHours: st.businessHours, responseTime: st.responseTime }; }
  return { enquiries, reports: reports.docs.map((x) => { const r = x.data(); return { id: x.id, reporterUid: r.reporterUid, subjectUid: r.subjectUid, reason: r.reason, status: r.status, conversationId: r.conversationId }; }), policy };
};
/** Message CONTENT of an enquiry conversation: super admin, stated reason, audited. */
_adminH.entAdminEnquiryConversation = async (req) => {
  if (!_isSuper(req)) fail('permission-denied', 'Super admin only.');
  const d = req.data || {};
  const reason = _san(d.reason, 500);
  if (reason.length < 5) fail('invalid-argument', 'A reason is required.');
  const id = _san(d.enquiryId, 128);
  const e = await _db().collection(COL.ENQ).doc(id).get();
  if (!e.exists) fail('not-found', 'Enquiry not found.');
  await _db().collection('adminAudit').add({ action: 'ent_enquiry_conversation_read', actor: req.auth.uid, enquiryId: id, reason, at: _now() });
  const m = await _db().collection('conversations').doc(e.data().conversationId).collection('messages').limit(200).get();
  return { enquiry: Object.assign({ id }, e.data()), messages: m.docs.map((x) => { const v = x.data(); return { id: x.id, senderId: v.senderId, type: v.type, text: v.text || null, timestamp: v.timestamp || null }; }) };
};

module.exports = { COL, STATUS, CATEGORIES, WHO, LIMITS, TEMPLATE_KEYS, CLAIM_RE, _h, _adminH,
  settingsOf, openNow, validTemplate, transition, assertCanSend, authorizeEnquiryCall, sweepExpired,
  _setClock: (fn) => { _now = fn || (() => Date.now()); } };
