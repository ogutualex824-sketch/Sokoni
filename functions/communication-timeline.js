'use strict';
/**
 * SOKONI Communication Engine — the unified timeline.
 * ============================================================================================
 * ONE callable: `communicationTimeline({ anchorType, anchorId })`.
 *
 * Everything SOKONI carried about one business relationship, in one order:
 *
 *     ORDER #SK-99420
 *     10:02  chat   buyer   "When will it arrive?"
 *     10:07  voice  buyer -> seller   02:31
 *     10:20  chat   seller  "Rider is on the way."
 *
 * ── IT READS. IT DOES NOT SEND, AND IT DOES NOT STORE ──────────────────────────────────────
 * There is no `communications` collection behind this. Copying every message into a second
 * store would make a duplicate of everything anyone has ever said, which then drifts from the
 * system that owns it. The timeline PROJECTS the canonical records into the common envelope at
 * read time, and names the source of every row so a reader can go to the authority.
 *
 * ── WHAT CAN BE JOINED, MEASURED ───────────────────────────────────────────────────────────
 *     conversations/{id}     transactionType + transactionId    -> joins
 *     connectSessions/{id}   context.relationship + anchorId     -> joins
 *     notifyLog/{key}        anchorType + anchorId               -> joins, SINCE 2026-09-22
 *     notifications/{id}     anchorType + anchorId               -> joins, SINCE 2026-09-22
 *     supportTickets/{id}    its OWN id, as anchorType 'support'  -> joins, SINCE 2026-09-22
 *
 * All three now. `notifyLog` carried uid, type, priority and category and no business anchor,
 * so every push, SMS and email SOKONI had ever sent could not be tied to the order it was
 * about — one missing field was the whole difference between five systems and one. `notify.js`
 * now records it.
 *
 * ── STILL INCOMPLETE, AND IT SAYS SO ON EVERY READ ─────────────────────────────────────────
 * Coverage is partial BY CONSTRUCTION and will be for a while:
 *
 *   1. every notifyLog row written BEFORE the anchor shipped has none, and never will
 *   2. every call site that has not yet been given the two lines still writes none
 *
 * Connect is the first caller wired. So `complete: false` and `anchorCoverage` travel with
 * every response: an operator reading a short timeline is TOLD it is partial rather than
 * concluding the relationship was quiet.
 *
 * UNKNOWN IS NOT ZERO. A source that could not be read is reported as unreadable, never as
 * empty.
 *
 * ── VOCABULARY, AND ONE REAL MISMATCH ──────────────────────────────────────────────────────
 * Connect stores `context.anchorType` as the COLLECTION it read (`orders`), and
 * `context.relationship` as the business kind (`order`). `conversations` stores the business
 * kind in `transactionType`. The envelope's `ANCHOR_TYPES` are business kinds, so this module
 * joins on `relationship` and never on the collection name. Joining on the collection would
 * silently return nothing for every anchor, and an empty timeline reads as "nothing happened".
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const ENV = require('./shared/communication-envelope');

const REGION = 'us-central1';
const PAGE = 100;

function _db() { return admin.firestore(); }

function _uid(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth.uid;
}

function _isPlatformAdmin(req) {
  const t = req.auth && req.auth.token;
  return !!(t && (t.admin === true || t.superAdmin === true));
}

function _ms(v) {
  if (!v) return null;
  try {
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    const d = new Date(v);
    const t = d.getTime();
    return isFinite(t) ? t : null;
  } catch (e) { return null; }
}

/** Sources that record a business anchor and can therefore be joined. Named so the response
 *  can list what was actually consulted rather than implying completeness. */
const JOINABLE_SOURCES = Object.freeze(['conversations', 'connectSessions', 'notifyLog',
  'notifications', 'supportTickets']);

/** Sources that carry communications and still cannot be joined. Empty today — `notifyLog`
 *  moved out of this list when `notify.js` began recording an anchor. Kept as a list rather
 *  than deleted, because the next transport SOKONI adds will arrive unanchored too and this
 *  is where it gets declared instead of quietly missing. */
const UNJOINABLE_SOURCES = Object.freeze([]);

/**
 * THE HISTORICAL GAP, which is NOT the same thing as an unjoinable source.
 *
 * `notify.js` now records an anchor, but only for callers that pass one — and only from the
 * moment it shipped. Two things therefore remain missing from any timeline and must be said
 * rather than left for an operator to infer from a short list:
 *
 *   1. every notification sent BEFORE this change, which has no anchor and never will
 *   2. every notification from a call site that has not yet been given the two lines
 *
 * Connect is the first caller wired. The rest report `anchored: false`, honestly.
 */
const ANCHOR_COVERAGE = Object.freeze({
  wiredCallers: Object.freeze([
    'connect-notify (connect_incoming_call)',
    'communication-send (admin messages)',
    'booking-payment-sweep (booking notifications)',
    'financial-os (_notify -> notifications)',
    'automation-engine (_notify -> notifications)',
  ]),
  note: 'Rows written before the anchor shipped, or by a call site that passes none, record '
      + 'anchored:false and can never appear in any timeline. Five call sites are wired; the '
      + 'rest are not, and several events are genuinely context-free and never will be.',
});

/**
 * _conversationEnvelopes — chat.
 *
 * One envelope per CONVERSATION, not per message. A timeline is an index; pulling every
 * message body would both duplicate the message store and turn a summary into a transcript
 * an operator did not ask for.
 */
async function _conversationEnvelopes(db, anchorType, anchorId) {
  const snap = await db.collection('conversations')
    .where('transactionType', '==', anchorType)
    .where('transactionId', '==', anchorId)
    .limit(PAGE)
    .get();

  return snap.docs.map((d) => {
    const c = d.data() || {};
    const at = c.lastMessageAt || c.createdAt || null;
    const env = ENV.buildEnvelope({
      at: at || null,
      communicationId: 'conv:' + d.id,
      channel: 'chat',
      senderUid: c.lastMessageSenderId || null,
      recipientUid: null,
      anchorType,
      anchorId,
      relationship: anchorType,
      subject: c.transactionTitle || '',
      /* The last line only. Deliberately not the thread. */
      preview: typeof c.lastMessage === 'string' ? c.lastMessage : '',
      priority: 'commerce',
      status: 'delivered',
      source: 'conversations',
      sourceId: d.id,
    });
    env.atMillis = _ms(at);
    env.participants = Array.isArray(c.participants) ? c.participants.slice() : [];
    return env;
  });
}

/**
 * _sessionEnvelopes — voice and video.
 *
 * Joined on `context.relationship`, never on `context.anchorType` — see the header. The
 * session's own status becomes delivery evidence honestly: a session that was never answered
 * is NOT `delivered`.
 */
const SESSION_STATUS_TO_DELIVERY = Object.freeze({
  authorized: 'queued',
  ringing: 'sent',
  accepted: 'delivered',
  connecting: 'delivered',
  connected: 'read',      /* both parties were present — the strongest evidence there is */
  ended: 'read',
  declined: 'delivered',  /* it reached them; they declined it */
  cancelled: 'failed',
  expired: 'failed',
  failed: 'failed',
});

async function _sessionEnvelopes(db, anchorType, anchorId) {
  const snap = await db.collection('connectSessions')
    .where('context.anchorId', '==', anchorId)
    .limit(PAGE)
    .get();

  return snap.docs
    .filter((d) => {
      const c = (d.data() || {}).context || {};
      return String(c.relationship || '') === anchorType;
    })
    .map((d) => {
      const s = d.data() || {};
      const at = s.createdAt || null;
      const channel = String(s.channel || 'voice');
      const env = ENV.buildEnvelope({
        at: at || null,
        communicationId: 'sess:' + d.id,
        channel: ENV.CHANNELS.includes(channel) ? channel : 'voice',
        senderUid: s.callerUid || null,
        recipientUid: s.calleeUid || null,
        anchorType,
        anchorId,
        relationship: anchorType,
        subject: (s.context && s.context.purpose) ? String(s.context.purpose) : '',
        /* NO preview. A call has no text, and inventing one ("Call") would be a body this
           module made up. */
        preview: '',
        priority: 'commerce',
        status: SESSION_STATUS_TO_DELIVERY[String(s.status)] || 'queued',
        source: 'connectSessions',
        sourceId: d.id,
      });
      env.atMillis = _ms(at);
      env.participants = Array.isArray(s.participants) ? s.participants.slice() : [];
      /* Connect's own record, carried through rather than re-derived. */
      env.sessionStatus = String(s.status || '');
      env.mode = s.mode || null;
      return env;
    });
}

/**
 * _notifyEnvelopes — push, SMS and email.
 *
 * Joined on the anchor `notify.js` now records. The row's own `status` becomes delivery
 * evidence rather than being assumed: a notification that was suppressed by preferences or
 * quiet hours is `suppressed`, NOT `sent`, and `processing` means SOKONI accepted it and has
 * not yet handed it to a provider.
 *
 * A notifyLog row does NOT name a channel — the engine may have used several for one
 * notification. The envelope records `push` as the representative channel and the row's own
 * `type` as the subject, rather than inventing a per-channel breakdown that was never stored.
 */
const NOTIFY_STATUS_TO_DELIVERY = Object.freeze({
  processing: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  failed: 'failed',
  suppressed: 'suppressed',
  quiet: 'suppressed',
});

async function _notifyEnvelopes(db, anchorType, anchorId) {
  const snap = await db.collection('notifyLog')
    .where('anchorType', '==', anchorType)
    .where('anchorId', '==', anchorId)
    .limit(PAGE)
    .get();

  return snap.docs.map((d) => {
    const n = d.data() || {};
    const at = n.createdAt || null;
    const env = ENV.buildEnvelope({
      at: at || null,
      communicationId: 'notif:' + d.id,
      channel: 'push',
      senderUid: null,
      recipientUid: n.uid || null,
      anchorType,
      anchorId,
      relationship: anchorType,
      subject: String(n.type || '').replace(/_/g, ' '),
      /* NO preview. The body is not stored on the log row, and inventing one would be text
         this module made up. */
      preview: '',
      priority: ENV.PRIORITIES.includes(String(n.priority)) ? String(n.priority) : 'commerce',
      status: NOTIFY_STATUS_TO_DELIVERY[String(n.status)] || 'queued',
      source: 'notifyLog',
      sourceId: d.id,
    });
    env.atMillis = _ms(at);
    /* The recipient is the only party a notification has. Used for the same participant
       authorization every other row goes through. */
    env.participants = n.uid ? [String(n.uid)] : [];
    env.notifyType = String(n.type || '');
    return env;
  });
}

/**
 * _inAppEnvelopes — the in-app notification feed.
 *
 * `notifications` is written DIRECTLY by several modules through their own `_notify` helpers,
 * bypassing notify.js entirely. Those rows now carry an anchor too, so the feed joins rather
 * than being a third disconnected store.
 *
 * The recipient field is spelled TWO WAYS in that collection — `uid` in some writers, `userId`
 * in others. Both are read. Choosing one would silently drop every row from the other half of
 * the platform, and an empty timeline reads as "nothing happened".
 */
async function _inAppEnvelopes(db, anchorType, anchorId) {
  const snap = await db.collection('notifications')
    .where('anchorType', '==', anchorType)
    .where('anchorId', '==', anchorId)
    .limit(PAGE)
    .get();

  return snap.docs.map((d) => {
    const n = d.data() || {};
    const at = n.createdAt || null;
    const env = ENV.buildEnvelope({
      at: at || null,
      communicationId: 'inapp:' + d.id,
      channel: 'in_app',
      senderUid: null,
      recipientUid: n.uid || n.userId || null,
      anchorType,
      anchorId,
      relationship: anchorType,
      subject: String(n.title || n.type || '').slice(0, 200),
      preview: typeof n.body === 'string' ? n.body : '',
      priority: ENV.PRIORITIES.includes(String(n.priority)) ? String(n.priority) : 'commerce',
      /* An in-app row IS the delivery: it is written into a feed the person opens. `read` is
         tracked on the row itself, so the evidence is real rather than assumed. */
      status: n.read === true ? 'read' : 'delivered',
      source: 'notifications',
      sourceId: d.id,
    });
    env.atMillis = _ms(at);
    const who = n.uid || n.userId;
    env.participants = who ? [String(who)] : [];
    return env;
  });
}

/**
 * _supportEnvelopes — the support case itself.
 *
 * A case is business communication: somebody wrote to SOKONI and SOKONI answered. It joins on
 * its OWN id under `anchorType: 'support'`, so `support` / `CASE-2218` gathers the case, any
 * chat about it, any call, and any notification anchored to it.
 *
 * NO SECOND MESSAGE STORE. The case document already holds the opening message and the
 * resolution; this projects them and copies nothing.
 */
async function _supportEnvelopes(db, anchorType, anchorId) {
  if (anchorType !== 'support') return [];
  const snap = await db.collection('supportTickets').doc(anchorId).get();
  if (!snap.exists) return [];
  const t = snap.data() || {};
  const out = [];

  const opened = ENV.buildEnvelope({
    at: t.createdAt || null,
    communicationId: 'case:' + anchorId,
    channel: 'in_app',
    senderUid: t.uid || null,
    anchorType: 'support',
    anchorId,
    relationship: 'support',
    subject: String(t.subject || '').slice(0, 200),
    preview: typeof t.message === 'string' ? t.message : '',
    priority: String(t.priority) === 'high' ? 'critical' : 'commerce',
    status: 'delivered',
    source: 'supportTickets',
    sourceId: anchorId,
  });
  opened.atMillis = _ms(t.createdAt);
  opened.participants = t.uid ? [String(t.uid)] : [];
  opened.caseStatus = String(t.status || '');
  out.push(opened);

  /* The resolution is a SECOND communication, not a field on the first. It happened later, by
     somebody else, and collapsing the two would lose both facts. */
  if (t.resolution && t.resolvedAt) {
    const resolved = ENV.buildEnvelope({
      at: t.resolvedAt,
      communicationId: 'case:' + anchorId + ':resolution',
      channel: 'in_app',
      senderUid: t.resolvedBy || null,
      recipientUid: t.uid || null,
      anchorType: 'support',
      anchorId,
      relationship: 'support',
      subject: 'Case resolved',
      preview: String(t.resolution).slice(0, 280),
      priority: 'commerce',
      status: 'delivered',
      source: 'supportTickets',
      sourceId: anchorId,
    });
    resolved.atMillis = _ms(t.resolvedAt);
    resolved.participants = t.uid ? [String(t.uid)] : [];
    out.push(resolved);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   The callable
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.communicationTimeline = onCall({ region: REGION, timeoutSeconds: 30 },
  async (req) => {
    const uid = _uid(req);
    const isAdmin = _isPlatformAdmin(req);
    const d = req.data || {};
    const anchorType = String(d.anchorType || '').trim();
    const anchorId = String(d.anchorId || '').trim().slice(0, 200);

    if (!ENV.ANCHOR_TYPES.includes(anchorType)) {
      throw new HttpsError('invalid-argument',
        `anchorType must be one of: ${ENV.ANCHOR_TYPES.join(', ')}`);
    }
    if (!anchorId) throw new HttpsError('invalid-argument', 'anchorId required');

    const db = _db();
    const unreadable = [];

    const [chat, calls, notifs, inapp, cases] = await Promise.all([
      _conversationEnvelopes(db, anchorType, anchorId).catch((e) => {
        /* UNKNOWN IS NOT ZERO. A source that failed is named; it never reads as silence. */
        unreadable.push({ source: 'conversations', reason: e.message });
        return null;
      }),
      _sessionEnvelopes(db, anchorType, anchorId).catch((e) => {
        unreadable.push({ source: 'connectSessions', reason: e.message });
        return null;
      }),
      _notifyEnvelopes(db, anchorType, anchorId).catch((e) => {
        unreadable.push({ source: 'notifyLog', reason: e.message });
        return null;
      }),
      _inAppEnvelopes(db, anchorType, anchorId).catch((e) => {
        unreadable.push({ source: 'notifications', reason: e.message });
        return null;
      }),
      _supportEnvelopes(db, anchorType, anchorId).catch((e) => {
        unreadable.push({ source: 'supportTickets', reason: e.message });
        return null;
      }),
    ]);

    const all = [].concat(chat || [], calls || [], notifs || [], inapp || [], cases || []);

    /* AUTHORIZATION. An admin sees the timeline; anyone else must be a participant in at
       least one row, and then sees only the rows they were party to. A business relationship
       is not a licence to read everything about it — a rider on a delivery is not entitled to
       the buyer's support case. */
    let rows = all;
    if (!isAdmin) {
      rows = all.filter((e) => Array.isArray(e.participants) && e.participants.includes(uid));
      if (!rows.length) {
        throw new HttpsError('permission-denied',
          'You are not party to any communication about this.');
      }
    }

    /* Participants are an authorization input, not output. Dropped before returning so the
       timeline does not hand out a membership list of every conversation. */
    const timeline = ENV.sortTimeline(rows).map((e) => {
      const out = Object.assign({}, e);
      delete out.participants;
      return out;
    });

    logger.info('[communication-timeline] read', {
      anchorType, anchorId, rows: timeline.length, isAdmin, unreadable: unreadable.length,
    });

    return {
      anchorType,
      anchorId,
      timeline,
      /* Told, never implied. */
      sourcesRead: JOINABLE_SOURCES.filter((s) => !unreadable.some((u) => u.source === s)),
      sourcesUnreadable: unreadable,
      unjoinableSources: UNJOINABLE_SOURCES,
      /* THE HONEST GAP, restated at every read. All three stores can now be joined, but
         coverage is partial by construction: rows written before the anchor shipped, and rows
         from call sites not yet wired, record `anchored: false` and can never appear here.
         An operator reading a short timeline must be told that rather than conclude it was
         quiet. */
      anchorCoverage: ANCHOR_COVERAGE,
      complete: false,
      completeReason: 'notifyLog rows written before the anchor shipped, or by a caller that '
        + 'passes none, record anchored:false and cannot be joined',
    };
  });

exports._internals = {
  NOTIFY_STATUS_TO_DELIVERY, ANCHOR_COVERAGE, _notifyEnvelopes,
  _inAppEnvelopes, _supportEnvelopes,
  JOINABLE_SOURCES, UNJOINABLE_SOURCES, SESSION_STATUS_TO_DELIVERY,
  _conversationEnvelopes, _sessionEnvelopes,
};
