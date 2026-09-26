'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   initiateHostedCheckout — the canonical HOSTED IntaSend checkout for any
   server-minted payment intent. Sibling of initiateSTKPush (M-PESA only):
   same intent authority, same payments/{ref} document, same webhook.

   Why it exists: STK can only offer M-PESA. The hosted checkout, called with
   NO `method`, lets IntaSend present whatever the SOKONI account has enabled
   (card, Google/Apple Pay, PesaLink, …). SOKONI never lists methods itself.

   Contract, in order:
     1. OFF unless config/hostedCheckout.enabled and the intent's purpose is in
        config/hostedCheckout.purposes (set only after the capability probe
        has proven the live account — scripts/probe-intasend-capability.js).
     2. The intent is the authority: the caller must own it; amount and
        currency are the INTENT's (a client figure is never read); terminal or
        expired intents are refused.
     3. Single-flight: paymentAttempts/{ref}.create() BEFORE the gateway call
        (the reservation model pos-qr.js established). A retry after an
        accepted session returns the SAME url; a retry while the outcome is
        unknown is refused — never a second session for one intent.
     4. payments/{ref} is CREATED PENDING in the shape initiateSTKPush writes,
        so webhookIntasend settles it exactly like an STK payment. If an STK
        push already created it, this refuses (one rail per intent).
     5. The gateway answer is classified by shared/intasend-checkout: 4xx →
        rejected (reservation and PENDING doc released), 2xx → accepted,
        anything else / a throw → OUTCOME_UNKNOWN (both kept: the customer may
        already be on the page, and the webhook may still complete it).
   Access is NEVER granted here — only the webhook's COMPLETE does that.
   ═══════════════════════════════════════════════════════════════════════════ */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const IC = require('./shared/intasend-checkout');

const INTASEND_PUBLIC_KEY = defineSecret('INTASEND_PUBLIC_KEY');
const _db = () => getFirestore();
let _https = require('https');                         /* test seam */
let _clock = () => Date.now();
const SITE = 'https://mysokoni.co.ke';
const TERMINAL = new Set(['paid', 'completed', 'cancelled', 'expired', 'PAID', 'COMPLETED', 'CANCELLED', 'EXPIRED']);
const fail = (code, msg) => { throw new HttpsError(code, msg); };

async function hostedCheckout(req, publicKey) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const d = req.data || {};
  const ref = String(d.ref || '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(ref)) fail('invalid-argument', 'Invalid payment reference.');
  /* Return path: same-site only — never an open redirect. */
  const returnPath = String(d.returnPath || '/');
  if (!/^\/[A-Za-z0-9/_.?=&%-]{0,300}$/.test(returnPath) || returnPath.startsWith('//')) fail('invalid-argument', 'Invalid return path.');

  const db = _db();
  const cfgSnap = await db.collection('config').doc('hostedCheckout').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const iSnap = await db.collection('paymentIntents').doc(ref).get();
  if (!iSnap.exists) fail('not-found', 'Payment not found.');
  const intent = iSnap.data();
  if (!(cfg.enabled === true && Array.isArray(cfg.purposes) && cfg.purposes.includes(intent.purpose))) {
    fail('failed-precondition', 'Card and other payment methods are not available for this payment yet.');
  }
  if (intent.uid !== uid) fail('permission-denied', 'This payment does not belong to you.');
  if (TERMINAL.has(String(intent.status || ''))) fail('failed-precondition', 'This payment is no longer open.');
  const exp = intent.expiresAt && intent.expiresAt.toMillis ? intent.expiresAt.toMillis() : null;
  if (exp != null && _clock() >= exp) fail('failed-precondition', 'This payment has expired. Start again.');
  const amountKES = Number(intent.amount);
  if (!(Number.isSafeInteger(amountKES) && amountKES >= 1)) fail('failed-precondition', 'This payment has no payable amount.');
  const currency = String(intent.currency || 'KES').toUpperCase();

  /* ── single-flight reservation + PENDING payment, one transaction ── */
  const attRef = db.collection('paymentAttempts').doc(ref);
  const payRef = db.collection('payments').doc(ref);
  const pre = await db.runTransaction(async (txn) => {
    const [att, pay] = [await txn.get(attRef), await txn.get(payRef)];
    if (att.exists) {
      const a = att.data();
      if (a.rail === 'hosted_checkout' && a.state === 'GATEWAY_ACCEPTED' && a.checkoutUrl) return { reuse: a };
      fail('failed-precondition', 'A payment for this order is already in progress.');
    }
    if (pay.exists) fail('failed-precondition', 'A payment for this order is already in progress.');
    txn.create(attRef, { transactionId: ref, rail: 'hosted_checkout', uid, amount: amountKES, currency, state: 'RESERVED', createdAt: FieldValue.serverTimestamp() });
    txn.create(payRef, { ref, amount: amountKES, currency, status: 'PENDING', uid, intentRef: ref, rail: 'hosted_checkout',
      meta: { type: intent.purpose, uid }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { reserved: true };
  });
  if (pre.reuse) return { url: pre.reuse.checkoutUrl, methods: pre.reuse.methods || null, reused: true };

  let res;
  try {
    const payload = IC.buildPayload({ amountKES, apiRef: ref, publicKey, currency, email: d.email || undefined,
      narrative: String(intent.metadata && intent.metadata.title ? intent.metadata.title : 'SOKONI').slice(0, 60),
      redirectUrl: SITE + returnPath });
    res = await IC.createCheckout({ payload, publicKey, sandbox: false, https: _https });
  } catch (e) {
    await attRef.update({ state: 'OUTCOME_UNKNOWN', heldAt: FieldValue.serverTimestamp(), error: String(e.message).slice(0, 200) }).catch(() => {});
    logger.error('[hostedCheckout] no answer — OUTCOME UNKNOWN, reservation kept', { ref, err: e.message });
    fail('unavailable', 'We could not confirm the checkout. Do not pay twice — check back in a few minutes.');
  }
  const verdict = IC.classifyOutcome(res.status);
  if (verdict === 'GATEWAY_ACCEPTED') {
    const url = IC.checkoutUrlOf(res.data);
    const invoiceId = IC.invoiceIdOf(res.data);
    const methods = IC.methodsOf(res.data);
    let safe = null;
    try { const u = new URL(url); if (u.protocol === 'https:' && /(^|\.)intasend\.com$/.test(u.hostname)) safe = u.href; } catch (_) { /* invalid */ }
    if (!safe) {
      await attRef.update({ state: 'OUTCOME_UNKNOWN', heldAt: FieldValue.serverTimestamp(), error: 'accepted without a trusted checkout url' }).catch(() => {});
      fail('unavailable', 'We could not confirm the checkout. Do not pay twice — check back in a few minutes.');
    }
    await attRef.update({ state: 'GATEWAY_ACCEPTED', checkoutUrl: safe, invoiceId, methods, acceptedAt: FieldValue.serverTimestamp() });
    await payRef.update({ checkoutId: invoiceId, updatedAt: FieldValue.serverTimestamp() });
    return { url: safe, methods };
  }
  if (verdict === 'GATEWAY_REJECTED') {
    /* The gateway answered no: nothing exists on its side. Release both so the
       buyer can try again (or use M-PESA). */
    await db.runTransaction(async (txn) => {
      const p = await txn.get(payRef);
      txn.delete(attRef);
      if (p.exists && p.data().status === 'PENDING' && p.data().rail === 'hosted_checkout') txn.delete(payRef);
    }).catch(() => {});
    logger.warn('[hostedCheckout] rejected by gateway', { ref, status: res.status });
    fail('failed-precondition', 'The payment provider declined to open a checkout for this payment.');
  }
  await attRef.update({ state: 'OUTCOME_UNKNOWN', heldAt: FieldValue.serverTimestamp(), httpStatus: res.status }).catch(() => {});
  fail('unavailable', 'We could not confirm the checkout. Do not pay twice — check back in a few minutes.');
}

exports.initiateHostedCheckout = onCall(
  { region: 'us-central1', enforceAppCheck: true, secrets: [INTASEND_PUBLIC_KEY], timeoutSeconds: 30 },
  (req) => hostedCheckout(req, INTASEND_PUBLIC_KEY.value()),
);
exports._internal = { hostedCheckout, _setHttps: (h) => { _https = h; }, _setClock: (c) => { _clock = c; } };
