'use strict';
/**
 * SOKONI — Healthcare booking conversations  (CHANGELOG 231 · owner-authorized Comms amendment 2026-09-28)
 * ============================================================================================
 * A patient and a provider talk privately ONLY inside an authorized clinical relationship: a canonical
 * providerBookings row that is a healthcare consultation (commissionHub 'healthcare' — server-stamped
 * from the provider's decided AdminOS application), CONFIRMED or COMPLETED, and PAID (paid_held |
 * settled). The same predicate gates clinical records (healthcare-hub._clinicalBasis) — ONE definition.
 *
 * Nothing here is a second chat system. It uses the existing Comms authority:
 *   · messages.ensureAnchoredConversation — the SERVER opens `hc_booking_{bookingId}` with the booking's
 *     own two parties (never a client list; `hc_booking` is SERVER_ANCHORED, so createConversation refuses
 *     it and the rules refuse any client create);
 *   · messages.sendMessage calls assertCanSend() below for hc_booking — the relationship is RE-READ on
 *     every message (a cancelled / refunded / declined / no-show booking makes the chat read-only), and a
 *     server-side limit + duplicate suppression apply (stored in hcMessageLimits, rules: no client access);
 *   · messages.onMessageCreated sends a GENERIC push for hc_booking — never message text on a lock screen.
 * A public question before any booking is an ENQUIRY (ent-enquiries.entEnquirySend) — chat-only, never
 * this. Calls are not anchored here (the Connect call authority is frozen and no TURN relay exists).
 */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

const REGION = 'us-central1';
const CONV_TYPE = 'hc_booking';
const CLINICAL_STATUSES = Object.freeze(['confirmed', 'completed']);
const CLINICAL_PAID = Object.freeze(['paid_held', 'settled']);
const TERMINAL_STATUSES = Object.freeze(['cancelled', 'declined', 'no_show', 'expired']);
/* Per sender, per conversation. A consultation chat is a conversation between two people with a paid
   booking — generous for real use, a hard ceiling for a flood. */
const LIMITS = Object.freeze({ perHour: 30, duplicateWindowMs: 60 * 1000 });

const _db = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();

/** THE clinical relationship (healthcare, confirmed|completed, paid). */
function isClinicalBooking(b) {
  return !!b && b.commissionHub === 'healthcare' && CLINICAL_STATUSES.includes(b.status) && CLINICAL_PAID.includes(b.paymentStatus);
}
function isEnded(b) {
  return !b || TERMINAL_STATUSES.includes(b.status) || b.paymentStatus === 'refunded';
}
const conversationIdFor = (bookingId) => CONV_TYPE + '_' + bookingId;

async function _readOnly(db, convId, reason) {
  const ref = db.collection('conversations').doc(convId);
  const s = await ref.get();
  if (!s.exists || s.data().status === 'read_only') return false;
  await ref.update({ status: 'read_only', readOnlyAt: _ts(), readOnlyReason: reason, updatedAt: _ts() });
  const M = require('./messages');
  await M.postSystemMessage(db, convId, 'readonly_' + reason, 'This consultation is no longer active, so this conversation is now read-only.').catch(() => {});
  return true;
}

/**
 * React to a providerBookings write. Opens the conversation for a qualifying healthcare booking;
 * makes it read-only when the relationship ends. Idempotent.
 */
async function onProviderBookingWritten(db, bookingId, after) {
  if (!after || after.commissionHub !== 'healthcare') return { skipped: 'not_healthcare' };
  const convId = conversationIdFor(bookingId);
  if (isEnded(after)) return { readOnly: await _readOnly(db, convId, after.paymentStatus === 'refunded' ? 'refunded' : String(after.status)) };
  if (!isClinicalBooking(after)) return { skipped: 'not_confirmed_or_unpaid' };
  const patient = after.customerUid; const provider = after.providerId;
  if (!patient || !provider || patient === provider) return { skipped: 'no_parties' };
  const M = require('./messages');
  const r = await M.ensureAnchoredConversation(db, {
    transactionType: CONV_TYPE, transactionId: bookingId,
    title: 'Consultation' + (after.serviceName ? ' — ' + String(after.serviceName).slice(0, 80) : ''),
    participants: [patient, provider],
    /* no clinical content, no amount, no notes — only what identifies the anchor */
    metadata: { anchorType: 'providerBooking', anchorId: bookingId, hub: 'healthcare' },
  });
  if (r.created) await M.postSystemMessage(db, r.conversationId, 'opened', 'Your consultation is confirmed. You can message each other here.').catch(() => {});
  return { conversationId: r.conversationId, created: r.created };
}

/**
 * Called by messages.sendMessage for every hc_booking message, BEFORE the write.
 * Refusals are explicit errors — a legitimate message is never silently dropped.
 */
async function assertCanSend(db, conv, uid, text) {
  const bookingId = String(conv.transactionId || '');
  const b = bookingId ? await db.collection('providerBookings').doc(bookingId).get() : null;
  const booking = b && b.exists ? b.data() : null;
  if (!isClinicalBooking(booking)) {
    await _readOnly(db, conversationIdFor(bookingId), booking ? (booking.paymentStatus === 'refunded' ? 'refunded' : String(booking.status)) : 'missing');
    throw new HttpsError('failed-precondition', 'This consultation is no longer active, so new messages cannot be sent.', { code: 'RELATIONSHIP_ENDED' });
  }
  /* the sender must be one of the BOOKING's parties, not merely a listed participant */
  if (uid !== booking.customerUid && uid !== booking.providerId) {
    throw new HttpsError('permission-denied', 'Not a party to this consultation.');
  }
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const rateRef = db.collection('hcMessageLimits').doc(`m_${bookingId}_${uid}_${hour}`.slice(0, 300));
  const hash = text ? crypto.createHash('sha256').update(String(text).trim().toLowerCase()).digest('hex').slice(0, 24) : null;
  const dupRef = hash ? db.collection('hcMessageLimits').doc(`d_${bookingId}_${uid}_${hash}`.slice(0, 300)) : null;
  await db.runTransaction(async (t) => {
    const [r, d] = await Promise.all([t.get(rateRef), dupRef ? t.get(dupRef) : Promise.resolve(null)]);
    const count = r.exists ? Number(r.data().count) || 0 : 0;
    if (count >= LIMITS.perHour) {
      throw new HttpsError('resource-exhausted', 'You have sent a lot of messages in this consultation. Please wait a little before sending more.', { code: 'RATE_LIMITED', retryAfterMs: (hour + 1) * 3600000 - now });
    }
    if (d && d.exists && now - (Number(d.data().atMs) || 0) < LIMITS.duplicateWindowMs) {
      throw new HttpsError('already-exists', 'You just sent that message.', { code: 'DUPLICATE' });
    }
    t.set(rateRef, { count: count + 1, bookingId, uid, hour, updatedAt: _ts() });
    if (dupRef) t.set(dupRef, { atMs: now, bookingId, uid });
  });
}

/* Trigger: every providerBookings write (create, confirm, pay, complete, cancel, refund). */
exports.hcBookingConversationOnProviderBooking = onDocumentWritten(
  { document: 'providerBookings/{bookingId}', region: REGION, timeoutSeconds: 60 },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    return onProviderBookingWritten(_db(), event.params.bookingId, after);
  });

module.exports = {
  hcBookingConversationOnProviderBooking: exports.hcBookingConversationOnProviderBooking,
  onProviderBookingWritten, assertCanSend, isClinicalBooking, isEnded, conversationIdFor,
  CONV_TYPE, CLINICAL_STATUSES, CLINICAL_PAID, LIMITS,
};
