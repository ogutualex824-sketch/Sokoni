/* ══════════════════════════════════════════════════════════════════════════
   SOKONI SMS PLATFORM  —  sms-service.js

   Templates · queue · idempotency · dead-letter · preferences · delivery reports.

   Sits ON TOP of sokoni-at.js (the transport). This module owns WHAT is sent and
   WHETHER it should be; sokoni-at.js owns HOW it leaves the building. Keeping the
   provider behind that seam is what makes Twilio/Infobip a drop-in later —
   business logic never names a provider.

   ── Two rules that shape everything here ─────────────────────────────────

   1. AN SMS COSTS MONEY AND CANNOT BE UNSENT.
      So the queue is idempotent by construction: the caller supplies a dedupeKey
      (e.g. "otp:<uid>:<purpose>", "order-placed:<orderId>"), and the queue doc ID
      IS that key. A duplicate enqueue is a no-op write, not a second SMS. This is
      the difference between "we retry" and "we double-charge the user's patience".

   2. A TRANSACTIONAL SMS MUST NEVER BE SUPPRESSED BY A MARKETING PREFERENCE.
      Users can opt out of promotions. They cannot opt out of the OTP that logs
      them in, or the receipt for money they just spent. Categories are split, and
      preference checks apply ONLY to the optional ones. Getting this backwards
      locks people out of their own accounts.

   Collections
     smsQueue        — pending/sent/failed (doc id = dedupeKey → idempotency)
     smsDeadLetter   — permanently failed, kept for inspection
     smsPreferences  — per-user opt-outs (optional categories only)
     smsDelivery     — provider delivery reports (webhook)
═════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin  = require('firebase-admin');
const logger = require('firebase-functions/logger');
const sokoniAt = require('./sokoni-at');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

const REGION    = 'us-central1';
const Q         = 'smsQueue';
const DLQ       = 'smsDeadLetter';
const PREFS     = 'smsPreferences';
const DELIVERY  = 'smsDelivery';

const MAX_ATTEMPTS = 4;

/* ══════════════════════════════════════════════════════════════════════════
   TEMPLATES

   One place, one wording. A user who sees two different OTP formats from the same
   brand is being trained to trust a phishing SMS — consistency is a security
   property, not a style preference.

   `category`:
     transactional — always sent. Cannot be opted out of.
     optional      — subject to the user's preferences.
═════════════════════════════════════════════════════════════════════════ */
const TEMPLATES = {
  otp: {
    category: 'transactional', pref: 'otp',
    body: ({ code, minutes = 5 }) =>
`SOKONI

Your verification code is: ${code}

Expires in ${minutes} minutes.
Never share this code with anyone.

mysokoni.co.ke`,
  },
  phone_verification: {
    category: 'transactional', pref: 'otp',
    body: ({ code, minutes = 5 }) =>
`SOKONI

Phone verification code: ${code}

Expires in ${minutes} minutes.
Never share this code with anyone.`,
  },
  password_reset: {
    category: 'transactional', pref: 'otp',
    body: ({ code, minutes = 10 }) =>
`SOKONI

Password reset code: ${code}

Expires in ${minutes} minutes.
If you did not request this, ignore this message and secure your account.`,
  },
  login_alert: {
    category: 'transactional', pref: 'security',
    body: ({ device = 'a new device', when = 'just now' }) =>
`SOKONI

New sign-in from ${device}, ${when}.

If this was not you, change your password immediately at mysokoni.co.ke`,
  },
  welcome: {
    category: 'optional', pref: 'account',
    body: ({ name = 'there' }) =>
`SOKONI

Karibu, ${name}! Your account is ready.

Shop, sell and get paid — all in one place.
mysokoni.co.ke`,
  },
  payment_success: {
    category: 'transactional', pref: 'payments',
    body: ({ amount, ref, orderId }) =>
`SOKONI

Payment received: ${amount}
Ref: ${ref}${orderId ? `\nOrder: ${orderId}` : ''}

Thank you.`,
  },
  payment_failed: {
    category: 'transactional', pref: 'payments',
    body: ({ amount, reason = 'the payment was not completed' }) =>
`SOKONI

Payment of ${amount} failed — ${reason}.

No money has been taken. You can try again at mysokoni.co.ke`,
  },
  refund_processed: {
    category: 'transactional', pref: 'payments',
    body: ({ amount, orderId }) =>
`SOKONI

Refund processed: ${amount}${orderId ? `\nOrder: ${orderId}` : ''}

It has been credited to your SOKONI wallet.`,
  },
  wallet_credit: {
    category: 'transactional', pref: 'payments',
    body: ({ amount, balance }) =>
`SOKONI

Wallet credited: ${amount}${balance ? `\nNew balance: ${balance}` : ''}`,
  },
  wallet_debit: {
    category: 'transactional', pref: 'payments',
    body: ({ amount, balance }) =>
`SOKONI

Wallet debited: ${amount}${balance ? `\nNew balance: ${balance}` : ''}

If this was not you, contact support immediately.`,
  },
  order_placed: {
    category: 'transactional', pref: 'orders',
    body: ({ orderId, total }) =>
`SOKONI

Order ${orderId} placed${total ? ` — ${total}` : ''}.

We'll notify you when the seller accepts it.`,
  },
  order_accepted: {
    category: 'transactional', pref: 'orders',
    body: ({ orderId }) =>
`SOKONI

Good news — order ${orderId} has been accepted and is being prepared.`,
  },
  order_dispatched: {
    category: 'transactional', pref: 'delivery',
    body: ({ orderId, rider }) =>
`SOKONI

Order ${orderId} is on the way${rider ? ` with ${rider}` : ''}.

Track it at mysokoni.co.ke`,
  },
  order_delivered: {
    category: 'transactional', pref: 'delivery',
    body: ({ orderId }) =>
`SOKONI

Order ${orderId} has been delivered.

Not right? Raise it in the app and we'll sort it.`,
  },
  order_cancelled: {
    category: 'transactional', pref: 'orders',
    body: ({ orderId, reason }) =>
`SOKONI

Order ${orderId} was cancelled${reason ? ` — ${reason}` : ''}.

Any payment made will be refunded to your wallet.`,
  },
  rider_assigned: {
    category: 'transactional', pref: 'delivery',
    body: ({ rider, phone, orderId }) =>
`SOKONI

${rider} is delivering order ${orderId}${phone ? `\nRider: ${phone}` : ''}.`,
  },
  rider_arrived: {
    category: 'transactional', pref: 'delivery',
    body: ({ orderId, code }) =>
`SOKONI

Your rider has arrived with order ${orderId}.${code ? `\n\nDelivery code: ${code}\nShare it only when you receive your items.` : ''}`,
  },
  subscription_activated: {
    category: 'transactional', pref: 'subscription',
    body: ({ plan, until }) =>
`SOKONI

${plan} is active${until ? ` until ${until}` : ''}.

Thank you.`,
  },
  subscription_expiring: {
    category: 'optional', pref: 'subscription',
    body: ({ plan, days }) =>
`SOKONI

${plan} expires in ${days} day(s).

Renew at mysokoni.co.ke to avoid interruption.`,
  },
  subscription_expired: {
    category: 'transactional', pref: 'subscription',
    body: ({ plan }) =>
`SOKONI

${plan} has expired. Access is now limited.

Renew at mysokoni.co.ke`,
  },
  seller_verified: {
    category: 'transactional', pref: 'account',
    body: ({ name = 'Seller' }) =>
`SOKONI

Congratulations ${name} — your seller account is verified.

You can now list and sell on SOKONI.`,
  },
  merchant_approved: {
    category: 'transactional', pref: 'account',
    body: ({ merchantId }) =>
`SOKONI

Your merchant account is approved.${merchantId ? `\nMerchant ID: ${merchantId}` : ''}

You can now use SmartPOS.`,
  },
  rider_approved: {
    category: 'transactional', pref: 'account',
    body: ({ name = 'Rider' }) =>
`SOKONI

Welcome ${name} — your rider account is approved.

You can start accepting deliveries.`,
  },
  admin_alert: {
    category: 'transactional', pref: 'security',
    body: ({ subject, detail }) =>
`SOKONI ALERT

${subject}${detail ? `\n${detail}` : ''}`,
  },
  promotion: {
    category: 'optional', pref: 'promotions',
    body: ({ message }) =>
`SOKONI

${message}

Reply STOP to opt out.`,      /* an opt-out line is a legal requirement, not a courtesy */
  },
};

/* Preference keys that a user MAY switch off. `otp` and `security` are absent on
   purpose: nobody should be able to lock themselves out of their own account or
   silence a fraud alert. */
const OPTIONAL_PREFS = new Set(['promotions', 'orders', 'delivery', 'payments', 'subscription', 'account']);

function render(templateKey, vars = {}) {
  const t = TEMPLATES[templateKey];
  if (!t) throw new HttpsError('invalid-argument', `Unknown SMS template "${templateKey}".`);
  return { body: t.body(vars || {}), category: t.category, pref: t.pref };
}

/* ── Preferences ──────────────────────────────────────────────────────────
   Default is ON for everything except promotions — marketing is opt-IN.
   Transactional templates skip this check entirely. */
async function allowed(uid, tpl) {
  const t = TEMPLATES[tpl];
  if (!t) return false;
  if (t.category === 'transactional') return true;      /* never suppressible */
  if (!uid) return true;
  if (!OPTIONAL_PREFS.has(t.pref)) return true;

  try {
    const snap = await db().collection(PREFS).doc(uid).get();
    const p = snap.exists ? snap.data() : {};
    if (t.pref === 'promotions') return p.promotions === true;   /* opt-IN */
    return p[t.pref] !== false;                                   /* opt-OUT */
  } catch (err) {
    /* If preferences are unreadable we send transactional-adjacent messages and
       suppress marketing — failing "quiet" on marketing is the safe direction. */
    logger.warn('[sms] preference read failed', { error: err.message });
    return t.pref !== 'promotions';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   QUEUE — idempotent by construction

   The doc ID IS the dedupeKey, so enqueueing the same logical message twice
   cannot create two sends. `create()` throws on collision; we swallow that and
   report deduped:true. There is no read-then-write race to lose.
═════════════════════════════════════════════════════════════════════════ */
async function enqueue({ to, template, vars, uid, dedupeKey, priority = 0 }) {
  if (!to || !template) throw new HttpsError('invalid-argument', 'to and template are required.');
  if (!TEMPLATES[template]) throw new HttpsError('invalid-argument', `Unknown template "${template}".`);

  if (!(await allowed(uid, template))) {
    logger.info('[sms] suppressed by user preference', { template, uid: uid ? uid.slice(0, 8) : null });
    return { ok: true, suppressed: true };
  }

  const key = dedupeKey || `${template}:${to}:${Date.now()}`;
  const ref = db().collection(Q).doc(key);

  const { body } = render(template, vars);

  try {
    await ref.create({
      to, template, body,
      uid: uid || null,
      priority: Number(priority) || 0,
      status: 'pending',
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      nextAttemptAt: Date.now(),
    });
    return { ok: true, queued: true, id: key };
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || '')) {
      /* Exactly the case this design exists for. Not an error. */
      return { ok: true, deduped: true, id: key };
    }
    throw err;
  }
}

/* Worker — drains the queue. Exponential backoff; permanent failures go to the DLQ
   rather than retrying forever and burning credit on a number that will never work. */
async function drain(limit = 50) {
  const now = Date.now();
  const snap = await db().collection(Q)
    .where('status', '==', 'pending')
    .where('nextAttemptAt', '<=', now)
    .limit(limit)
    .get();

  let sent = 0, failed = 0, dead = 0;

  for (const doc of snap.docs) {
    const m = doc.data();
    const attempts = (m.attempts || 0) + 1;

    const res = await sokoniAt.atSendSMS(m.to, m.body);

    if (res && res.ok) {
      const r = (res.results || [])[0] || {};
      await doc.ref.update({
        status: 'sent', attempts,
        messageId: r.messageId || null,
        cost: r.cost || null,                       /* cost recorded per message */
        providerStatus: r.status || null,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      sent++;
      continue;
    }

    const retryable = !!(res && res.retryable);
    if (!retryable || attempts >= MAX_ATTEMPTS) {
      /* Dead-letter: keep the message so a human can see WHAT failed and why.
         Deleting it would destroy the only evidence. */
      await db().collection(DLQ).doc(doc.id).set({
        ...m, attempts,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: (res && res.error) || 'unknown',
        lastStatus: (res && res.status) || null,
      });
      await doc.ref.update({ status: 'dead', attempts });
      logger.error('[sms] dead-lettered', { id: doc.id, template: m.template, status: res && res.status });
      dead++;
      continue;
    }

    const backoff = Math.min(60_000 * Math.pow(2, attempts - 1), 15 * 60_000);  /* 1m,2m,4m… cap 15m */
    await doc.ref.update({ attempts, nextAttemptAt: Date.now() + backoff });
    failed++;
  }

  return { sent, retrying: failed, dead, scanned: snap.size };
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPORTS
═════════════════════════════════════════════════════════════════════════ */

/* Scheduled worker — every minute. */
exports.smsQueueWorker = onSchedule(
  { schedule: 'every 1 minutes', region: REGION, memory: '256MiB', secrets: sokoniAt.secrets },
  async () => {
    const r = await drain(50);
    if (r.sent || r.dead) logger.info('[sms] queue drained', r);
  }
);

/* Admin/system enqueue. */
exports.smsEnqueue = onCall({ region: REGION, secrets: sokoniAt.secrets }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { to, template, vars, dedupeKey, targetUid } = request.data || {};
  return enqueue({ to, template, vars, uid: targetUid || uid, dedupeKey });
});

/* ── Preferences API ───────────────────────────────────────────────────── */
exports.smsGetPreferences = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await db().collection(PREFS).doc(uid).get();
  const p = snap.exists ? snap.data() : {};
  return {
    ok: true,
    preferences: {
      promotions:   p.promotions === true,      /* opt-IN */
      orders:       p.orders !== false,
      delivery:     p.delivery !== false,
      payments:     p.payments !== false,
      subscription: p.subscription !== false,
      account:      p.account !== false,
    },
    /* Stated explicitly so the UI can explain WHY these are not switches. */
    alwaysOn: ['otp', 'security'],
  };
});

exports.smsSetPreferences = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const patch = {};
  for (const [k, v] of Object.entries(request.data || {})) {
    if (OPTIONAL_PREFS.has(k) && typeof v === 'boolean') patch[k] = v;
    /* Anything else — including any attempt to disable otp/security — is dropped.
       A user must not be able to switch off the message that logs them in. */
  }
  if (!Object.keys(patch).length) throw new HttpsError('invalid-argument', 'No valid preferences supplied.');

  await db().collection(PREFS).doc(uid).set({
    ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, updated: Object.keys(patch) };
});

/* ── Delivery-report webhook (Africa's Talking) ───────────────────────────
   AT posts a delivery report per message. Idempotent: keyed by the provider's own
   message id, so a redelivered webhook cannot double-count.

   AT does not sign these callbacks, so the URL is the only secret. Guarded with a
   shared token that must match SMS_WEBHOOK_TOKEN — an unauthenticated public
   endpoint that writes to Firestore is an open door. */
const { defineSecret } = require('firebase-functions/params');
const SMS_WEBHOOK_TOKEN = defineSecret('SMS_WEBHOOK_TOKEN');

exports.smsDeliveryWebhook = onRequest(
  { region: REGION, secrets: [SMS_WEBHOOK_TOKEN], cors: false },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

    const token = req.query.token || req.get('x-sms-token');
    const expected = SMS_WEBHOOK_TOKEN.value();
    if (!expected || token !== expected) {
      logger.warn('[sms] delivery webhook rejected — bad token');
      res.status(403).send('Forbidden');
      return;
    }

    const { id, status, networkCode, failureReason, phoneNumber } = req.body || {};
    if (!id) { res.status(400).send('missing id'); return; }

    try {
      /* Doc id = provider message id → replaying the webhook overwrites, never duplicates. */
      await db().collection(DELIVERY).doc(String(id)).set({
        messageId: String(id),
        status: status || null,                 /* Success | Failed | Rejected … */
        networkCode: networkCode || null,
        failureReason: failureReason || null,
        phoneTail: phoneNumber ? String(phoneNumber).slice(-4) : null,  /* never store the full number here */
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      if (status && status !== 'Success') {
        logger.error('[sms] delivery failed at provider', { messageId: id, status, failureReason });
      }
      res.status(200).send('ok');
    } catch (err) {
      logger.error('[sms] delivery webhook error', { error: err.message });
      res.status(500).send('error');
    }
  }
);

/* ── Admin dashboard data ─────────────────────────────────────────────────
   One call, everything the ops screen needs. */
exports.smsStats = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const u = await db().collection('users').doc(uid).get();
  const roles = u.exists ? (u.data().roles || []) : [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const [pending, dead, recent, delivery] = await Promise.all([
    db().collection(Q).where('status', '==', 'pending').limit(500).get(),
    db().collection(DLQ).limit(200).get(),
    db().collection(Q).where('status', '==', 'sent').limit(500).get(),
    db().collection(DELIVERY).limit(500).get(),
  ]);

  /* Cost is reported by the provider as "KES 0.8000" — parse, don't guess. */
  let cost = 0;
  recent.docs.forEach(d => {
    const c = String(d.data().cost || '');
    const m = c.match(/([\d.]+)/);
    if (m) cost += parseFloat(m[1]) || 0;
  });

  const reports = delivery.docs.map(d => d.data());
  const delivered = reports.filter(r => r.status === 'Success').length;

  return {
    ok: true,
    sender: (sokoniAt.AT_SENDER_ID && sokoniAt.AT_SENDER_ID.value()) || '(shared shortcode — SOKONI pending approval)',
    queuePending: pending.size,
    deadLetter: dead.size,
    sent24h: recent.size,
    estimatedCostKES: +cost.toFixed(2),
    deliveryReports: reports.length,
    deliverySuccessRate: reports.length ? +(delivered / reports.length * 100).toFixed(1) : null,
    failuresByReason: reports.filter(r => r.status !== 'Success')
      .reduce((a, r) => { const k = r.failureReason || r.status || 'unknown'; a[k] = (a[k] || 0) + 1; return a; }, {}),
  };
});

module.exports.TEMPLATES = TEMPLATES;
module.exports.OPTIONAL_PREFS = OPTIONAL_PREFS;
module.exports.render = render;
module.exports.enqueue = enqueue;
module.exports.allowed = allowed;
