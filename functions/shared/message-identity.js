/* ============================================================================
   SOKONI — message identity                functions/shared/message-identity.js
   ============================================================================
   Turns a client-minted idempotency key into the Firestore document id a
   message will occupy, so that sending the same message twice writes the same
   document twice — which `create()` refuses — instead of writing two messages.

   WHY THIS IS NOT JUST `doc(clientMessageId)`
   -------------------------------------------
   A client chooses its own key. If the key WERE the document id, one user could
   choose a key another user's message already occupies and the second, honest
   send would be rejected as a duplicate — a denial-of-service on someone else's
   conversation, available to anyone who can guess a string. So the id is
   DERIVED from the sender and the conversation as well as the key. Two senders
   using the identical key collide with nobody: the namespaces are disjoint by
   construction, because the sender component comes from the verified token and
   never from the request body.

   PURE
   ----
   No require, no clock, no environment. The same input gives the same id in a
   test, in the emulator and in production — which is the only reason the id can
   be relied on to be stable across a retry at all.
   ========================================================================= */
'use strict';

/* A key travels through a document id, so it is restricted to characters that
   are unambiguous there. This is a VALIDATION, not a sanitisation: a key with
   anything else is refused, never quietly rewritten — rewriting two different
   keys into the same string would merge two distinct messages. */
const CLIENT_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function isValidClientMessageId(v) {
  return typeof v === 'string' && CLIENT_KEY_PATTERN.test(v);
}

/* FNV-1a, 64-bit, expressed in two 32-bit halves so it never touches a float.
   A hash is used rather than concatenation because the three components are
   caller-influenced and of unbounded length; hashing gives a fixed-width id and
   removes any delimiter-injection question entirely. */
function _fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (str.charCodeAt(i) >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function _hex(n) { return ('00000000' + n.toString(16)).slice(-8); }

/**
 * messageDocIdFor(senderUid, conversationId, clientMessageId) -> string
 *
 * DETERMINISTIC. The sender component MUST come from the verified auth token,
 * never from the request body — that is what makes the namespaces disjoint.
 * Throws rather than returning a fallback: a fallback id would be a random id
 * under another name, and would silently reinstate duplicate delivery.
 */
function messageDocIdFor(senderUid, conversationId, clientMessageId) {
  if (!senderUid || typeof senderUid !== 'string') {
    throw new Error('message-identity: senderUid is required');
  }
  if (!conversationId || typeof conversationId !== 'string') {
    throw new Error('message-identity: conversationId is required');
  }
  if (!isValidClientMessageId(clientMessageId)) {
    throw new Error('message-identity: clientMessageId is missing or malformed');
  }
  /* NUL separators cannot occur in any of the three components, so distinct
     triples cannot produce the same pre-image. */
  const material = senderUid + '\u0000' + conversationId + '\u0000' + clientMessageId;
  const a = _fnv1a32(material, 0x811c9dc5);
  const b = _fnv1a32(material + '\u0001', 0x9e3779b9);
  const c = _fnv1a32(material + '\u0002', 0x85ebca6b);
  const d = _fnv1a32(material + '\u0003', 0xc2b2ae35);
  /* The `m_` prefix keeps the id clear of Firestore's reserved `__…__` form. */
  return 'm_' + _hex(a) + _hex(b) + _hex(c) + _hex(d);
}

const API_CONTRACT = Object.freeze([
  'API_CONTRACT', 'CLIENT_KEY_PATTERN', 'isValidClientMessageId', 'messageDocIdFor',
]);

module.exports = {
  API_CONTRACT,
  CLIENT_KEY_PATTERN,
  isValidClientMessageId,
  messageDocIdFor,
};
