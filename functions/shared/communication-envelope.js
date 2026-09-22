'use strict';
/**
 * SOKONI Communication Engine — the common envelope.
 * ============================================================================================
 * ONE shape for every communication SOKONI carries, whatever transport moved it:
 *
 *     chat · voice · video · email · sms · push · in_app
 *
 * ── WHY THIS EXISTS, MEASURED ──────────────────────────────────────────────────────────────
 * SOKONI already sends on every one of those channels. It does not connect them. The reason is
 * specific and checkable, not aesthetic:
 *
 *     conversations/{id}     carries transactionType + transactionId   -> ANCHORED
 *     connectSessions/{id}   carries context.anchorType + anchorId     -> ANCHORED
 *     notifyLog/{key}        carries uid, type, priority, category     -> NOT ANCHORED
 *
 * So a chat about order SK-99420 and a call about order SK-99420 can be joined today; the push
 * that told the seller about it cannot, because nothing recorded which order it was about.
 * That single missing field is the difference between five systems and one.
 *
 * This module defines the field, and the vocabulary around it, so anything that starts
 * recording an anchor lands in the same shape rather than a sixth one.
 *
 * ── IT IS NOT A TRANSPORT ──────────────────────────────────────────────────────────────────
 * Nothing here sends. `notify.js` is the platform's one notification engine and owns tokens,
 * channel routing, preferences, quiet hours, dedupe and the audit log; `messages.js` owns
 * conversations; Connect owns sessions. This module gives their records a common description
 * so they can be read together. A second sender is the thing it exists to prevent.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network, no require. `buildEnvelope` takes `at` as an argument.
 */

/** Every transport SOKONI can carry a business communication on. */
const CHANNELS = Object.freeze([
  'chat', 'voice', 'video', 'email', 'sms', 'push', 'in_app',
]);

/** Which channels are REAL-TIME (a person is present) versus delivered-and-left. The
 *  distinction matters to the router: an urgent message to someone who is not present is a
 *  different problem from one to someone who is. */
const REALTIME_CHANNELS = Object.freeze(['chat', 'voice', 'video']);

/** Priority is a statement about consequence, not about how loud to be. `critical` is
 *  security and money — the classes that must reach someone even at 3am. It mirrors
 *  notify.js's own vocabulary rather than inventing a second one. */
const PRIORITIES = Object.freeze(['critical', 'commerce', 'marketing']);

/** Delivery evidence. These are DISTINCT on purpose and must never be collapsed:
 *   queued     accepted by SOKONI, not yet handed to a provider
 *   sent       a provider accepted it
 *   delivered  the provider reported it reached the recipient's device
 *   read       the recipient's client reported it was seen
 *   failed     it will not arrive
 *   suppressed SOKONI chose not to send (preferences, quiet hours, opt-out)
 *
 * `sent` is not `delivered` and `delivered` is not `read`. A provider accepting a message is
 * the single most over-claimed fact in messaging systems, and the whole Connect programme has
 * already been careful about the same distinction for a ringing phone. */
const DELIVERY_STATES = Object.freeze([
  'queued', 'sent', 'delivered', 'read', 'failed', 'suppressed',
]);

/** A terminal state tells you the attempt is over. `sent` is NOT terminal — the provider may
 *  still report delivery or failure. */
const TERMINAL_DELIVERY = Object.freeze(['delivered', 'read', 'failed', 'suppressed']);

/** The business relationships a communication can be ABOUT. Mirrors the Connect anchor
 *  vocabulary exactly, because a call and a chat about the same order must join. */
const ANCHOR_TYPES = Object.freeze([
  'order', 'inquiry', 'booking', 'delivery', 'supply', 'support',
]);

/* A telephone number must never enter an envelope. The same rule Connect holds for sessions,
   for the same reason — an envelope is read by operators, logged, and shown in a timeline. */
const _E164 = /\+?\d[\d\s().-]{7,}\d/g;

function findPhoneNumbers(value) {
  const found = [];
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      const m = v.match(_E164);
      if (m) found.push(...m.map((s) => s.trim()));
      return;
    }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    Object.keys(v).forEach((k) => { walk(k); walk(v[k]); });
  };
  walk(value);
  return found;
}

/**
 * isAnchored(envelopeOrRecord) -> boolean
 *
 * The one question that decides whether a record can join a timeline. Exported because
 * "which of our channels are anchored" is a fact about the platform that should be asked of
 * code rather than remembered.
 */
function isAnchored(rec) {
  const r = rec || {};
  const a = r.anchor || r;
  return !!(a && ANCHOR_TYPES.includes(String(a.anchorType || ''))
    && String(a.anchorId || '').length > 0);
}

/* Which id field names a which anchor. ONE table, because the alternative is the same
   conditional written at every call site and spelled slightly differently at one of them.
   Ordered: the FIRST match wins, so a record carrying both an orderId and a deliveryId anchors
   to the order it belongs to rather than the leg that happens to be moving it. */
const ANCHOR_ID_FIELDS = Object.freeze([
  ['orderId', 'order'],
  ['bookingId', 'booking'],
  ['deliveryId', 'delivery'],
  ['supplierId', 'supply'],
  ['ticketId', 'support'],
  ['caseId', 'support'],
  ['productId', 'inquiry'],
]);

/**
 * anchorFrom(source) -> { anchorType, anchorId } | null
 *
 * Reads an anchor out of a metadata-shaped object. Returns NULL rather than guessing when
 * nothing matches — an absent anchor is a true fact about a notification, and inventing one to
 * make a record joinable is worse than leaving it out: it would put a real communication under
 * the wrong business relationship, where somebody would later read it as evidence.
 *
 * Only the fields above are recognised. A payment reference is deliberately NOT among them: it
 * identifies a transaction with a provider, not a SOKONI business relationship, and anchoring
 * to it would create a timeline nobody can look up.
 */
function anchorFrom(source) {
  const s = source || {};
  for (const [field, type] of ANCHOR_ID_FIELDS) {
    const v = s[field];
    if (v === undefined || v === null) continue;
    const id = String(v).trim();
    if (!id) continue;
    return { anchorType: type, anchorId: id.slice(0, 200) };
  }
  return null;
}

/**
 * buildEnvelope({ at, ... }) -> the common shape
 *
 * THROWS on an unknown channel, priority or delivery state, and on a telephone number. An
 * envelope is a record an operator reads and an auditor trusts; a field this function had to
 * guess is a field nobody can stand behind.
 *
 * `anchor` is OPTIONAL and its absence is recorded as `anchored: false` rather than refused —
 * most of what the platform sends today is unanchored, and refusing it would simply mean the
 * timeline never sees it. Absence is reported, never hidden.
 */
function buildEnvelope(input) {
  const i = input || {};
  if (!i.at) throw new Error('communication-envelope: buildEnvelope requires an explicit `at`');

  const channel = String(i.channel || '');
  if (!CHANNELS.includes(channel)) {
    throw new Error(`communication-envelope: unknown channel "${channel}"`);
  }
  const priority = String(i.priority || 'commerce');
  if (!PRIORITIES.includes(priority)) {
    throw new Error(`communication-envelope: unknown priority "${priority}"`);
  }
  const status = String(i.status || 'queued');
  if (!DELIVERY_STATES.includes(status)) {
    throw new Error(`communication-envelope: unknown delivery state "${status}"`);
  }

  const anchorType = i.anchorType ? String(i.anchorType) : null;
  const anchorId = i.anchorId ? String(i.anchorId) : null;
  if (anchorType && !ANCHOR_TYPES.includes(anchorType)) {
    throw new Error(`communication-envelope: unknown anchorType "${anchorType}"`);
  }

  const envelope = {
    communicationId: String(i.communicationId || ''),
    channel,
    realtime: REALTIME_CHANNELS.includes(channel),
    /* HANDLES, not addresses. An envelope names WHO by uid and never carries a telephone
       number or a raw email address — the transport resolves those and keeps them. */
    senderUid: i.senderUid ? String(i.senderUid) : null,
    recipientUid: i.recipientUid ? String(i.recipientUid) : null,
    anchor: {
      anchorType,
      anchorId,
      relationship: i.relationship ? String(i.relationship) : null,
    },
    /* Stated rather than derived at read time, so a timeline can filter on it and an audit can
       see which records could never have joined. */
    anchored: !!(anchorType && anchorId),
    subject: String(i.subject || '').slice(0, 200),
    /* A PREVIEW, never the body. An envelope is an index entry; the message lives in the
       system that owns it. Copying bodies here would make a second store of everything
       anyone has ever said. */
    preview: String(i.preview || '').slice(0, 280),
    priority,
    status,
    /* The system that owns the underlying record, so a reader can go to the authority rather
       than treating the envelope as one. */
    source: String(i.source || ''),
    sourceId: String(i.sourceId || ''),
    at: i.at,
  };

  const leaked = findPhoneNumbers(envelope);
  if (leaked.length) {
    throw new Error('communication-envelope: refusing to build an envelope containing a telephone number');
  }
  return envelope;
}

/**
 * sortTimeline(envelopes) -> a stable chronological order.
 *
 * Sorts on a NUMERIC millisecond value the caller supplies as `atMillis`, because envelopes
 * arrive carrying Firestore Timestamps, Dates and ISO strings from three different systems and
 * comparing those directly is how a timeline silently interleaves wrongly. An envelope with no
 * comparable time sorts LAST and keeps its place, rather than being dropped.
 */
function sortTimeline(envelopes) {
  const list = Array.isArray(envelopes) ? envelopes.slice() : [];
  return list
    .map((e, idx) => ({ e, idx, ms: _millis(e) }))
    .sort((a, b) => {
      if (a.ms === null && b.ms === null) return a.idx - b.idx;
      if (a.ms === null) return 1;
      if (b.ms === null) return -1;
      if (a.ms !== b.ms) return a.ms - b.ms;
      return a.idx - b.idx;
    })
    .map((x) => x.e);
}

function _millis(envelope) {
  const e = envelope || {};
  if (typeof e.atMillis === 'number' && isFinite(e.atMillis)) return e.atMillis;
  return null;
}

/* ── THE FROZEN CONTRACT ──────────────────────────────────────────────────────────────────
 * Frozen 2026-09-22. The anchor resolver in particular is a REFUSAL-BASED contract and its
 * behaviour is the part that must not drift:
 *
 *   · canonical business ids only — the table above, nothing inferred
 *   · a payment reference is NEVER an anchor (it names a provider transaction)
 *   · no guessing: unmatched input returns NULL, not a best effort
 *   · an empty or whitespace id is not an anchor
 *
 * Loosening any of those files a real communication under a business relationship that does
 * not exist, where somebody later reads it as evidence. Declared so the suite can assert the
 * surface both ways — every declared name exported, every export declared. */
const CONTRACT = Object.freeze([
  'CHANNELS', 'REALTIME_CHANNELS', 'PRIORITIES', 'DELIVERY_STATES', 'TERMINAL_DELIVERY',
  'ANCHOR_TYPES', 'ANCHOR_ID_FIELDS', 'anchorFrom', 'isAnchored', 'buildEnvelope',
  'sortTimeline', 'findPhoneNumbers',
]);

module.exports = {
  CONTRACT,
  CHANNELS,
  REALTIME_CHANNELS,
  PRIORITIES,
  DELIVERY_STATES,
  TERMINAL_DELIVERY,
  ANCHOR_TYPES,
  ANCHOR_ID_FIELDS,
  anchorFrom,
  isAnchored,
  buildEnvelope,
  sortTimeline,
  findPhoneNumbers,
};
