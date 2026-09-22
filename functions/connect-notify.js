'use strict';
/**
 * SOKONI Connect — the notification dispatcher (Gate C1).
 * ============================================================================================
 * ONE job: given an authorized session, tell the server-chosen callee that a call is waiting,
 * and move the session to `ringing` through the existing transition mechanism.
 *
 * ── THE DISPATCHER IS NOT AN AUTHORITY ─────────────────────────────────────────────────────
 * FCM decides nothing. This module decides nothing. It DELIVERS.
 *
 *     Identity → Authority → Session → Notification → Client → Media
 *
 * By the time a document exists in `connectSessions`, the question "may these two parties
 * speak" has already been answered by connect-authority and the parties have already been
 * derived from the anchor. This dispatcher never re-decides that, never resolves a recipient
 * of its own, and never writes a status directly: it reads `calleeUid` off the session the
 * server wrote, and asks `canTransition` for the move like everybody else.
 *
 * A notification layer that decided who may receive a call would be a second authority, and
 * the first thing it would get wrong is the thing that matters — who the phone belongs to.
 *
 * ── IT DOES NOT SEND PUSH EITHER ───────────────────────────────────────────────────────────
 * `notify.js` is the platform's one notification engine and owns the token source, the
 * channel routing, preferences, quiet hours, dedupe and the audit log. Three different ideas
 * about where a push token lives already cost this codebase a silent production failure. This
 * module calls `notify()` and names an INTENT (`connect_incoming_call`); it does not name a
 * channel, a provider or a token.
 *
 * ── UNDELIVERED IS NOT RINGING ─────────────────────────────────────────────────────────────
 * If nothing was delivered — no token, preferences off, quiet hours — the session STAYS
 * `authorized` and the sweep expires it. It is never marked `ringing` on the strength of
 * having tried. A caller must be able to tell "their phone never rang" from "they did not
 * answer", and those two are the same record if a dispatcher claims success on dispatch.
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const CA = require('./shared/connect-authority');

const REGION = 'us-central1';

function _db() { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

/**
 * shouldDispatchRing(session) -> { ring, reason }
 *
 * PURE. Exported and tested directly, because "did we decide to ring" is the one judgement in
 * this module and it must be answerable without an emulator.
 *
 * Returns `ring: false` with a stated reason rather than throwing: a trigger that throws is
 * retried by the platform, and retrying a decision that will never change is how a chat
 * session gets re-examined for ever.
 */
function shouldDispatchRing(session) {
  const s = session || {};
  const channel = String(s.channel || '');
  const status = String(s.status || '');

  /* Chat has nobody to ring. It is a session so that a conversation carries the same business
     context as a call, not because it alerts anyone. */
  if (channel === 'chat') return { ring: false, reason: 'chat_does_not_ring' };
  if (!CHANNELS_THAT_RING.includes(channel)) return { ring: false, reason: 'unknown_channel' };

  /* Only from the initial state. A trigger can fire twice, and a session someone has already
     answered, declined or cancelled must not be rung again. */
  if (status !== CA.INITIAL_STATE) return { ring: false, reason: 'not_in_initial_state' };

  if (!s.calleeUid) return { ring: false, reason: 'no_callee' };
  if (!s.callerUid) return { ring: false, reason: 'no_caller' };
  if (String(s.calleeUid) === String(s.callerUid)) return { ring: false, reason: 'self_call' };

  /* The server must have authorized a route. A session with no transport plan has nothing to
     carry the call, and ringing someone for a call that cannot connect wastes their time. */
  if (!Array.isArray(s.transportPlan) || !s.transportPlan.length) {
    return { ring: false, reason: 'no_transport_plan' };
  }

  /* And the move must be legal. Asked of the same table every client obeys — the dispatcher
     holds no privilege over it. */
  const move = CA.canTransition({ from: status, to: 'ringing', actor: 'server' });
  if (!move.ok) return { ring: false, reason: move.reason };

  return { ring: true, reason: 'ring' };
}

const CHANNELS_THAT_RING = Object.freeze(['voice', 'video']);

/** What the recipient is told. Business context, never a telephone number, never a uid. */
function ringPayload(session) {
  const s = session || {};
  const ctx = s.context || {};
  const isVideo = String(s.channel) === 'video';
  const isVerification = String(s.mode) === 'PLATFORM';

  const title = isVerification
    ? 'SOKONI verification call'
    : (isVideo ? 'Incoming SOKONI video call' : 'Incoming SOKONI business call');

  /* The anchor is what the call is ABOUT, and it is the only thing that makes an unknown
     caller answerable. "Order #SK-99420" tells a merchant why their phone is ringing;
     a uid tells them nothing. */
  const about = ctx.anchorId
    ? `${_label(ctx.relationship)} #${String(ctx.anchorId).slice(0, 12).toUpperCase()}`
    : _label(ctx.relationship);

  const body = isVerification
    ? `A SOKONI administrator has requested a video verification (${_label(ctx.purpose)}).`
    : `Someone is calling you about ${about}.`;

  return { title, body, about };
}

function _label(v) {
  return String(v || 'a SOKONI matter').replace(/_/g, ' ');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   The trigger
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.connectOnSessionCreated = onDocumentCreated(
  { region: REGION, document: 'connectSessions/{sessionId}', timeoutSeconds: 60 },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;
    const sessionId = event.params.sessionId;
    const session = snap.data() || {};

    const decision = shouldDispatchRing(session);
    if (!decision.ring) {
      logger.info('[connect-notify] not ringing', { sessionId, reason: decision.reason });
      return null;
    }

    const payload = ringPayload(session);
    let delivered = false;
    let deliveryReason = 'not_attempted';

    try {
      const notify = require('./notify');
      const res = await notify.notify({
        uid: String(session.calleeUid),
        type: 'connect_incoming_call',
        title: payload.title,
        body: payload.body,
        /* IDEMPOTENT ON THE SESSION. A re-fired trigger must not ring someone twice for the
           same call — the engine's own dedupe returns `{deduped:true}` and sends nothing. */
        dedupeKey: `connect_ring:${sessionId}`,
        /* THE ANCHOR. Connect already knows which order/delivery/case this call is about, so
           the push it sends joins the same timeline as the call and the chat. This is the
           first caller to pass one — every other notify() call site still records
           `anchored: false`, honestly, until it is given the same two lines. */
        anchorType: (session.context && session.context.relationship) || undefined,
        anchorId: (session.context && session.context.anchorId) || undefined,
        deepLink: `/connect.html?session=${encodeURIComponent(sessionId)}`,
        data: {
          kind: 'connect_call',
          sessionId,
          channel: String(session.channel || ''),
          /* A HANDLE, never a uid or a number — the same rule the session record follows. */
          callerHandle: String(session.callerHandle || ''),
          about: payload.about,
        },
        awaitDelivery: true,
      });

      /* `deduped` means an earlier run already delivered it, which is a success for this
         session — the phone was rung. Not re-sending is the point. */
      const push = (res && res.channels && res.channels.push) || null;
      delivered = !!(res && (res.deduped === true || (push && push.ok === true)));
      deliveryReason = res && res.deduped ? 'deduped'
        : (push ? (push.ok ? 'push_delivered' : String(push.reason || 'push_failed'))
          : 'no_push_channel');
    } catch (e) {
      /* A delivery failure is a RESULT, not a crash. Throwing would retry the trigger and,
         worse, would leave the session's record of what happened unwritten. */
      deliveryReason = 'notify_threw:' + String(e && e.message || e).slice(0, 120);
      logger.warn('[connect-notify] notify failed', { sessionId, err: deliveryReason });
    }

    const ref = _db().collection('connectSessions').doc(sessionId);

    /* UNDELIVERED IS NOT RINGING. Record the attempt either way; move the state only if the
       call actually reached a transport. */
    if (!delivered) {
      await ref.update({
        notifyAttemptedAt: _now(),
        notifyOutcome: deliveryReason,
        updatedAt: _now(),
      }).catch(() => {});
      logger.info('[connect-notify] not delivered — session stays authorized', {
        sessionId, reason: deliveryReason,
      });
      return null;
    }

    await _db().runTransaction(async (t) => {
      const cur = await t.get(ref);
      if (!cur.exists) return;
      const s = cur.data();
      /* Re-checked INSIDE the transaction: the callee may have answered from another device,
         or the caller cancelled, between the send and this write. */
      const move = CA.canTransition({ from: String(s.status), to: 'ringing', actor: 'server' });
      if (!move.ok) {
        logger.info('[connect-notify] delivered but no longer ringable', {
          sessionId, status: s.status, reason: move.reason,
        });
        t.update(ref, { notifiedAt: _now(), notifyOutcome: deliveryReason, updatedAt: _now() });
        return;
      }
      t.update(ref, {
        status: 'ringing',
        notifiedAt: _now(),
        notifyOutcome: deliveryReason,
        /* WHICH EVIDENCE moved it. `dispatch` means a push transport accepted the call;
           `device` means the recipient's app said it is actually alerting. The second is
           stronger, and the record must never let them be confused. */
        ringingBy: 'dispatch',
        updatedAt: _now(),
      });
    }).catch((e) => {
      logger.warn('[connect-notify] ring transition failed', { sessionId, err: e.message });
    });

    logger.info('[connect-notify] ringing', { sessionId, via: deliveryReason });
    return null;
  });

/**
 * evaluateReachability({ transportPlan, hasPushTarget }) -> { reachable, reason }
 *
 * PURE. Answers "can this call be made to ring at all", so the CALLER can be told the truth at
 * the moment they press Call instead of watching a session sit silent until it expires.
 *
 * ── IT IS NOT A CLAIM THAT A PHONE RANG ────────────────────────────────────────────────────
 * `reachable: true` means nothing is known to prevent a ring — there is a route and the callee
 * has somewhere a push could land. It is a PRE-CHECK, not a delivery receipt, and it must
 * never be rendered as "ringing". Preferences and quiet hours are decided by notify.js at
 * dispatch time and are deliberately not second-guessed here; a second copy of that policy is
 * how two answers to one question begin.
 *
 * The authoritative record of what actually happened stays `notifyOutcome` and `ringingBy` on
 * the session, written by the dispatcher.
 */
function evaluateReachability(input) {
  const i = input || {};
  const plan = Array.isArray(i.transportPlan) ? i.transportPlan : [];
  if (!plan.length) return { reachable: false, reason: 'no_route' };
  if (i.hasPushTarget !== true) return { reachable: false, reason: 'no_push_target' };
  return { reachable: true, reason: 'reachable' };
}

/**
 * hasPushTarget(uid) -> boolean
 *
 * Asks the ONE notification engine whether this account has anywhere a push could land.
 * FAILS CLOSED: an unreadable token set reads as "no target", so a caller is told the person
 * may be unreachable rather than being shown a hopeful "calling…" that never rings.
 */
async function hasPushTarget(uid) {
  if (!uid) return false;
  try {
    const notify = require('./notify');
    if (typeof notify.collectTokens !== 'function') return false;
    const tokens = await notify.collectTokens(String(uid));
    return Array.isArray(tokens) && tokens.length > 0;
  } catch (e) {
    logger.warn('[connect-notify] token lookup failed — treating as unreachable', {
      err: e && e.message,
    });
    return false;
  }
}

exports.evaluateReachability = evaluateReachability;
exports.hasPushTarget = hasPushTarget;
exports._internals = {
  shouldDispatchRing, ringPayload, CHANNELS_THAT_RING, evaluateReachability,
};
