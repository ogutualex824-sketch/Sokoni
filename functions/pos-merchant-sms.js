'use strict';
/**
 * posSendSMS — a merchant's SMS to THEIR OWN customers (Q0c-2).
 *
 * THE DEFECT
 * This callable (previously inline in index.js) sent any text, up to 160 characters, to any phone number the
 * caller named — `{to}` or a `bulk` array of up to 100 numbers per call — with nothing but a sign-in, no merchant,
 * no customer relationship and no volume limit: a public SMS relay under SOKONI's sender. Its only client
 * (pos-modules.js) sends a payload this handler never read, so no legitimate path used it.
 *
 * THE AUTHORITY
 *   · the merchant is PROVEN, never taken from the request: pos-zero-friction _provenCustomerOwners — the till's
 *     customer authority (shop owner or its staff via resolveActor, or a business member holding `customers`) —
 *     returning the proven owner set;
 *   · recipients are CUSTOMER IDS, never phone numbers. Every one must be a posCustomers record owned by that set
 *     (pos-customer-scope getOwnedIn); a foreign, unowned, malformed or missing customer refuses the WHOLE request
 *     before anything is sent — one message, so a refusal never reveals whether another merchant's customer exists;
 *   · the phone is the one on the customer's record (canonical 254…), never supplied;
 *   · at most 100 recipients per request, and 500 per merchant per calendar day (Africa/Nairobi). The day's
 *     count is reserved in a Firestore TRANSACTION before any send, so concurrent requests cannot each see the
 *     same remaining quota and together exceed it. The merchant key is the proven owner SET, so claiming the same
 *     merchant by shop id or by business id draws on ONE quota;
 *   · every request after sign-in is audited (auditLogs, type posSendSMS): caller, claimed and proven merchant,
 *     HASHED recipient references (customer ids can embed phone digits), counts, outcome — no raw phone number.
 *
 * Nothing about delivery is claimed here: `sent` counts provider acceptances, not handset delivery.
 */
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const sokoniAt = require('./sokoni-at');
const custScope = require('./pos-customer-scope');

const MAX_PER_REQUEST = 100;
const MAX_PER_DAY = 500;
const MAX_LEN = 160;
const QUOTA = 'smsMerchantQuota';

const db = () => admin.firestore();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/* the calendar day in Africa/Nairobi (UTC+3, no DST) as YYYYMMDD */
function nairobiDay(ms) {
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

function audit(entry) {
  return db().collection('auditLogs').add(Object.assign({ type: 'posSendSMS', ts: admin.firestore.FieldValue.serverTimestamp() }, entry))
    .catch(() => {});
}

async function handler(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const callerUid = request.auth.uid;
  const { merchantId, customerIds, message } = request.data || {};

  if (!merchantId || typeof merchantId !== 'string') {
    throw new HttpsError('invalid-argument', 'merchantId is required.');
  }
  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    throw new HttpsError('invalid-argument', 'customerIds is required — messages go to your customers, not to phone numbers.');
  }
  if (customerIds.length > MAX_PER_REQUEST) {
    throw new HttpsError('invalid-argument', `At most ${MAX_PER_REQUEST} customers per request.`);
  }
  if (!customerIds.every((id) => custScope.isCustomerDocId(id))) {
    throw new HttpsError('invalid-argument', 'Every customer must be a customer record id.');
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new HttpsError('invalid-argument', 'message is required.');
  }
  const msg = message.slice(0, MAX_LEN);
  const ids = [...new Set(customerIds)];

  /* 1. the merchant, proven (refuses an unproven claim) */
  let owners;
  try {
    owners = await require('./pos-zero-friction')._provenCustomerOwners(callerUid, merchantId);
  } catch (e) {
    audit({ callerUid, merchantClaim: String(merchantId).slice(0, 64), requested: ids.length, outcome: 'refused_unproven_merchant' });
    throw e;
  }
  const merchantKey = sha([...owners].sort().join('|')).slice(0, 32);

  /* 2. every recipient is one of THIS merchant's customers — or nothing is sent */
  const snaps = await Promise.all(ids.map((id) => custScope.getOwnedIn(db(), owners, id)));
  if (snaps.some((s) => !s)) {
    audit({ callerUid, merchantClaim: String(merchantId).slice(0, 64), merchantKey, requested: ids.length, outcome: 'refused_not_your_customer' });
    throw new HttpsError('permission-denied', 'Every recipient must be one of your customers. Nothing was sent.');
  }
  const recipients = [], rejected = [];
  for (const s of snaps) {
    const phone = custScope.canonicalPhone((s.data() || {}).phone);
    (phone ? recipients : rejected).push({ ref: sha(s.id).slice(0, 16), phone });
  }

  /* 3. the day's quota, reserved atomically BEFORE any send */
  const day = nairobiDay(Date.now());
  const quotaRef = db().collection(QUOTA).doc(`${merchantKey}_${day}`);
  const n = recipients.length;
  if (n > 0) {
    try {
      await db().runTransaction(async (t) => {
        const q = await t.get(quotaRef);
        const used = (q.exists && Number(q.data().count)) || 0;
        if (used + n > MAX_PER_DAY) {
          throw new HttpsError('resource-exhausted',
            `Daily SMS limit reached: ${used} of ${MAX_PER_DAY} used today, ${n} requested. Nothing was sent.`);
        }
        t.set(quotaRef, { merchantKey, day, count: used + n, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
    } catch (e) {
      audit({ callerUid, merchantClaim: String(merchantId).slice(0, 64), merchantKey, requested: ids.length, accepted: n,
        outcome: e && e.code === 'resource-exhausted' ? 'refused_daily_limit' : 'refused_quota_unavailable' });
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('unavailable', 'The daily SMS limit could not be checked, so nothing was sent.');
    }
  }

  /* 4. send to the numbers on record */
  const results = await Promise.allSettled(recipients.map((r) => sokoniAt.atSendSMS(r.phone, msg)));
  const sent = results.filter((x) => x.status === 'fulfilled' && x.value && x.value.ok).length;
  await audit({
    callerUid, merchantClaim: String(merchantId).slice(0, 64), merchantKey, day,
    requested: ids.length, accepted: n, rejected: rejected.length, sent, failed: n - sent,
    recipientRefs: recipients.map((r) => r.ref), rejectedRefs: rejected.map((r) => r.ref),
    outcome: 'sent',
  });
  return { success: true, requested: ids.length, accepted: n, rejected: rejected.length, sent, failed: n - sent };
}

exports._h = { posSendSMS: handler };
exports.posSendSMS = onCall({ secrets: [...sokoniAt.secrets], timeoutSeconds: 60, cors: true }, handler);
