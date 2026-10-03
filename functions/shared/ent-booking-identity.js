/* ═══════════════════════════════════════════════════════════════════════════════════════════
   ENTERTAINMENT BOOKING IDENTITY — pure rules (no I/O). Used by functions/entertainment-bookings.js.

   ONE canonical identity per Entertainment booking, whatever engine took it:
     EVENT    an event order (eventOrders)            ref = the order's ticket numbers (SK-EVT-…)
     ARTIST   a performer booking (providerBookings)  ref = BK-ART-YYYY-NNNNNN
     SERVICE  an Entertainment service booking        ref = BK-SVC-YYYY-NNNNNN
     VENUE    a venue booking (bookings, booking core) ref = BK-VEN-YYYY-NNNNNN

   The source engines stay the authority for their own records (price, slot, status); the identity
   is an ENVELOPE that references the source and adds what no engine had: a human reference, a
   category booking PIN, the buyer↔provider conversation, and one trace for AdminOS.

   PIN MEANINGS ARE CATEGORY-SPECIFIC and never interchangeable:
     EVENT    "PIN YAKO NI TICKET YAKO"  — the per-TICKET admission PIN (event-ops, already live).
              An event order carries NO booking PIN: the ticket PIN is the credential.
     others   "PIN YAKO NI BOOKING YAKO" — one 4-digit PIN per BOOKING, HMAC-bound to that booking
              (`entbk|<envId>|<pin>`), so the same four digits can never verify another booking, and
              a ticket PIN (`evtpin|…`) can never verify a booking. Required for the category's
              protected action: a venue check-in, a service / performance start.
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const CATEGORY = Object.freeze({ EVENT: 'EVENT', ARTIST: 'ARTIST', SERVICE: 'SERVICE', VENUE: 'VENUE' });
const REF_PREFIX = Object.freeze({ ARTIST: 'BK-ART', SERVICE: 'BK-SVC', VENUE: 'BK-VEN' });
const REF_RE = /^BK-(ART|SVC|VEN)-\d{4}-\d{6}$/;
const SOURCES = Object.freeze({
  eventOrders: { key: 'evt', category: CATEGORY.EVENT },
  providerBookings: { key: 'svc', category: null },          /* ARTIST or SERVICE, from the classification */
  bookings: { key: 'ven', category: CATEGORY.VENUE },
});
const PHRASE = Object.freeze({
  EVENT: 'PIN YAKO NI TICKET YAKO',
  BOOKING: 'PIN YAKO NI BOOKING YAKO',
});
const TITLE = Object.freeze({ EVENT: 'Event booking', ARTIST: 'Artist booking', SERVICE: 'Service booking', VENUE: 'Venue booking' });

const STATUS = Object.freeze({
  PENDING: 'PENDING', CONFIRMED: 'CONFIRMED', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED', DECLINED: 'DECLINED', NO_SHOW: 'NO_SHOW', EXPIRED: 'EXPIRED',
});
const PAYMENT = Object.freeze({ NOT_REQUIRED: 'NOT_REQUIRED', PROCESSING: 'PROCESSING', CONFIRMED: 'CONFIRMED', FAILED: 'FAILED', REQUIRES_REVIEW: 'REQUIRES_REVIEW', REFUNDED: 'REFUNDED' });
const REFUND = Object.freeze({ NONE: 'NONE', REQUESTED: 'REQUESTED', UNDER_REVIEW: 'UNDER_REVIEW', APPROVED: 'APPROVED', PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED', DECLINED: 'DECLINED', OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN' });
const PIN_STATE = Object.freeze({ NONE: 'NONE', ISSUED: 'ISSUED', NOT_YET: 'NOT_YET', ACTIVE: 'ACTIVE', USED: 'USED', SUSPENDED: 'SUSPENDED', INVALID: 'INVALID', EXPIRED: 'EXPIRED' });
/* A booking PIN verifies the SHOW-UP, and the show-up SETTLES the booking (owner decision 2026-09-27):
   it opens 2 hours before the start, so a provider cannot "verify" days early and take the money
   before delivering. */
const SHOW_UP_OPENS_MS = 2 * 3600e3;

/* Performer types (entertainment-registry PERFORMER_TYPES) that are ARTISTS; the rest of the
   registry's types are Entertainment SERVICES. Keys are the registry's. */
const ARTIST_TYPES = new Set(['dj', 'mc', 'band', 'musician', 'singer', 'comedian', 'dancer', 'magician', 'influencer', 'voiceover', 'producer']);
const SERVICE_TYPES = new Set(['photographer', 'videographer', 'sound_engineer', 'lighting', 'event_planner', 'makeup', 'decorator', 'caterer']);
const LABEL_KEYS = Object.freeze({
  'live band': 'band', 'sound engineer': 'sound_engineer', 'lighting technician': 'lighting', 'voice-over artist': 'voiceover',
  'event planner': 'event_planner', 'make-up artist': 'makeup', 'makeup artist': 'makeup', 'content creator': 'influencer',
  photography: 'photographer', videography: 'videographer', 'live-band': 'band', planner: 'event_planner', 'event-planner': 'event_planner',
});
function _typeKey(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (ARTIST_TYPES.has(s) || SERVICE_TYPES.has(s)) return s;
  if (LABEL_KEYS[s]) return LABEL_KEYS[s];
  const u = s.replace(/[\s-]+/g, '_');
  return ARTIST_TYPES.has(u) || SERVICE_TYPES.has(u) ? u : null;
}
/**
 * Entertainment classification of a provider from their DECIDED application (the admin-approved
 * record — never the provider's self-editable profile). ARTIST | SERVICE | null (not Entertainment).
 */
function classifyApplication(app) {
  if (!app) return null;
  const cands = [app.subcategory, app.category, app.performerType, ...(Array.isArray(app.categories) ? app.categories : [])];
  let k = null;
  for (const c of cands) { k = _typeKey(c); if (k) break; }
  if (!k && String(app.hub || '').toLowerCase() === 'entertainment') return CATEGORY.SERVICE;
  if (!k) return null;
  return ARTIST_TYPES.has(k) ? CATEGORY.ARTIST : CATEGORY.SERVICE;
}

function envIdFor(sourceCollection, sourceId) {
  const s = SOURCES[sourceCollection];
  if (!s) throw new Error('unknown booking source ' + sourceCollection);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(sourceId || ''))) throw new Error('invalid source id');
  return `${s.key}_${sourceId}`;
}

function normalizePin(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s-]/g, '');
  return /^\d{4}$/.test(s) ? s : null;
}

/** Status of each source engine → one vocabulary. */
function statusOf(sourceCollection, d) {
  const s = String((d && d.status) || '').toLowerCase();
  if (sourceCollection === 'eventOrders') {
    if (s === 'paid') return STATUS.CONFIRMED;
    if (s === 'refunded' || s === 'pending_refund' || s === 'cancelled') return STATUS.CANCELLED;
    if (s === 'expired') return STATUS.EXPIRED;
    return STATUS.PENDING;
  }
  if (sourceCollection === 'bookings') {
    return ({ pending: 'PENDING', confirmed: 'CONFIRMED', active: 'IN_PROGRESS', completed: 'COMPLETED', cancelled: 'CANCELLED', no_show: 'NO_SHOW', rejected: 'DECLINED' })[s] || STATUS.PENDING;
  }
  return ({ pending: 'PENDING', requested: 'PENDING', confirmed: 'CONFIRMED', in_progress: 'IN_PROGRESS', completed: 'COMPLETED',
    cancelled: 'CANCELLED', declined: 'DECLINED', no_show: 'NO_SHOW', expired: 'EXPIRED' })[s] || STATUS.PENDING;
}

/** Payment of each source → one vocabulary. Never CONFIRMED without the canonical paid state. */
function paymentOf(sourceCollection, d) {
  if (sourceCollection === 'eventOrders') {
    const s = String(d.status || '');
    if (s === 'paid') return Number(d.totalAmount) > 0 ? PAYMENT.CONFIRMED : PAYMENT.NOT_REQUIRED;
    if (s === 'refunded') return PAYMENT.REFUNDED;
    return PAYMENT.PROCESSING;
  }
  if (sourceCollection === 'providerBookings') {
    return ({ paid_held: 'CONFIRMED', settled: 'CONFIRMED', refunded: 'REFUNDED', pending: 'PROCESSING' })[String(d.paymentStatus || 'pending')] || PAYMENT.PROCESSING;
  }
  /* venue booking core: payment is verified server-side (paymentStatus 'paid') or not required */
  const ps = String(d.paymentStatus || '');
  if (ps === 'paid') return PAYMENT.CONFIRMED;
  if (ps === 'refunded') return PAYMENT.REFUNDED;
  return d.requiresPayment === true ? PAYMENT.PROCESSING : PAYMENT.NOT_REQUIRED;
}

const TERMINAL = new Set([STATUS.CANCELLED, STATUS.DECLINED, STATUS.NO_SHOW, STATUS.EXPIRED]);
/** Can this booking's PIN be used NOW? Derived — never stored as a free-form flag. */
function pinState(env, nowMs) {
  if (!env || env.category === CATEGORY.EVENT || !env.pin || !env.pin.hash) return PIN_STATE.NONE;
  if (TERMINAL.has(env.status)) return PIN_STATE.INVALID;
  if (env.refund && [REFUND.COMPLETED].includes(env.refund.state)) return PIN_STATE.INVALID;
  if (env.refund && [REFUND.REQUESTED, REFUND.UNDER_REVIEW, REFUND.APPROVED, REFUND.PROCESSING, REFUND.OUTCOME_UNKNOWN].includes(env.refund.state)) return PIN_STATE.SUSPENDED;
  if (env.verification && env.verification.state === 'VERIFIED') return PIN_STATE.USED;
  if (env.status === STATUS.COMPLETED) return PIN_STATE.EXPIRED;
  const payOk = !env.payment || [PAYMENT.CONFIRMED, PAYMENT.NOT_REQUIRED].includes(env.payment.state);
  if (![STATUS.CONFIRMED, STATUS.IN_PROGRESS].includes(env.status) || !payOk) return PIN_STATE.ISSUED;
  const endMs = env.when && Number(env.when.endMs);
  if (Number.isFinite(endMs) && nowMs > endMs + 12 * 3600e3) return PIN_STATE.EXPIRED;
  const startMs = env.when && Number(env.when.startMs);
  if (Number.isFinite(startMs) && nowMs < startMs - SHOW_UP_OPENS_MS) return PIN_STATE.NOT_YET;
  return PIN_STATE.ACTIVE;
}

function phraseFor(category) { return category === CATEGORY.EVENT ? PHRASE.EVENT : PHRASE.BOOKING; }
function titleFor(category, ref) { return `${TITLE[category] || 'Booking'} — ${ref}`; }
function initials(name) {
  const n = String(name || '').trim();
  return n ? n.split(/\s+/).map((p) => p[0].toUpperCase()).slice(0, 3).join('') : null;
}

module.exports = {
  SHOW_UP_OPENS_MS, CATEGORY, REF_PREFIX, REF_RE, SOURCES, PHRASE, TITLE, STATUS, PAYMENT, REFUND, PIN_STATE, ARTIST_TYPES, SERVICE_TYPES,
  classifyApplication, envIdFor, normalizePin, statusOf, paymentOf, pinState, phraseFor, titleFor, initials, TERMINAL,
};
