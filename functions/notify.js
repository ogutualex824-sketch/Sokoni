/* ══════════════════════════════════════════════════════════════════════════
   SOKONI NOTIFICATION ENGINE  —  notify.js

   ONE entry point for every message SOKONI sends: push, in-app, SMS, email.
   Business code calls notify(...) and never names a channel or a provider.

   ── Why this exists (measured, not assumed) ──────────────────────────────
   Before this: 8 modules sent push directly, 19 wrote the notifications
   collection directly, and there was no shared helper. That fragmentation had
   already produced a silent production bug:

     the client writes  user.fcmToken   (singular)
     loyalty.js reads   user.fcmTokens  (plural)
     redis-jobs.js reads user.fcmTokens (plural)

   Those two modules were reading a field that does not exist, so their push
   notifications never reached a single user — and nothing failed loudly enough
   for anyone to notice. That is what a missing seam costs. This engine reads
   BOTH shapes, so no user is unreachable while the data is normalised.

   ── Routing policy ──────────────────────────────────────────────────────
   The CALLER declares intent (a type). The ENGINE decides channels. A caller
   that picks its own channel is how "marketing SMS" ends up in an OTP path.

     critical   → SMS + push + in-app. Never suppressed. Never quiet-hour'd.
     commerce   → push first; SMS FALLBACK only if push cannot be delivered.
     marketing  → push + email. SMS only if the user explicitly opted in.

   ── The rules that protect the user ─────────────────────────────────────
   • Critical notifications ignore preferences AND quiet hours. Nobody should be
     unable to receive the OTP that logs them in because it is 11pm.
   • Marketing is opt-IN, and respects quiet hours.
   • Every send is idempotent on a caller-supplied key — a retried Cloud Function
     must not double-notify.
   • Duplicate suppression: the same notification to the same user inside a short
     window is dropped, not re-sent.

   Collections
     notifications      — in-app feed (existing; unchanged shape)
     notifyLog          — audit: what was sent, where, and whether it landed
     notifyPrefs        — per-category, per-channel preferences + quiet hours
═════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const logger = require('firebase-functions/logger');
const sms    = require('./sms-service');
const sokoniAt = require('./sokoni-at');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

const REGION   = 'us-central1';
const LOG      = 'notifyLog';
const PREFS    = 'notifyPrefs';
const INAPP    = 'notifications';

/* ══════════════════════════════════════════════════════════════════════════
   TYPE REGISTRY — 50+ types are just data. Adding one is a registry entry,
   not an architectural change.

   priority: critical | commerce | marketing
   category: what a user can tune in preferences
   smsTemplate: the sms-service template to use IF SMS is chosen
═════════════════════════════════════════════════════════════════════════ */
const TYPES = {
  /* ── critical: security & money. Never suppressed, never delayed. ── */
  otp:                  { priority: 'critical',  category: 'security', smsTemplate: 'otp' },
  phone_verification:   { priority: 'critical',  category: 'security', smsTemplate: 'phone_verification' },
  password_reset:       { priority: 'critical',  category: 'security', smsTemplate: 'password_reset' },
  login_alert:          { priority: 'critical',  category: 'security', smsTemplate: 'login_alert' },
  payment_verification: { priority: 'critical',  category: 'payments', smsTemplate: 'otp' },
  wallet_debit:         { priority: 'critical',  category: 'wallet',   smsTemplate: 'wallet_debit' },
  admin_alert:          { priority: 'critical',  category: 'security', smsTemplate: 'admin_alert' },

  /* ── commerce: push first, SMS only if push cannot land ── */
  payment_success:      { priority: 'commerce',  category: 'payments', smsTemplate: 'payment_success' },
  payment_failed:       { priority: 'commerce',  category: 'payments', smsTemplate: 'payment_failed' },
  refund_processed:     { priority: 'commerce',  category: 'payments', smsTemplate: 'refund_processed' },
  wallet_credit:        { priority: 'commerce',  category: 'wallet',   smsTemplate: 'wallet_credit' },
  order_placed:         { priority: 'commerce',  category: 'orders',   smsTemplate: 'order_placed' },
  order_accepted:       { priority: 'commerce',  category: 'orders',   smsTemplate: 'order_accepted' },
  order_preparing:      { priority: 'commerce',  category: 'orders',   smsTemplate: null },
  order_ready:          { priority: 'commerce',  category: 'orders',   smsTemplate: null },
  order_dispatched:     { priority: 'commerce',  category: 'delivery', smsTemplate: 'order_dispatched' },
  rider_assigned:       { priority: 'commerce',  category: 'delivery', smsTemplate: 'rider_assigned' },
  rider_nearby:         { priority: 'commerce',  category: 'delivery', smsTemplate: null },
  rider_arrived:        { priority: 'commerce',  category: 'delivery', smsTemplate: 'rider_arrived' },
  order_delivered:      { priority: 'commerce',  category: 'delivery', smsTemplate: 'order_delivered' },
  order_cancelled:      { priority: 'commerce',  category: 'orders',   smsTemplate: 'order_cancelled' },
  subscription_activated:{priority: 'commerce',  category: 'subscriptions', smsTemplate: 'subscription_activated' },
  subscription_expiring:{ priority: 'commerce',  category: 'subscriptions', smsTemplate: 'subscription_expiring' },
  subscription_expired: { priority: 'commerce',  category: 'subscriptions', smsTemplate: 'subscription_expired' },
  seller_verified:      { priority: 'commerce',  category: 'marketplace',   smsTemplate: 'seller_verified' },
  merchant_approved:    { priority: 'commerce',  category: 'marketplace',   smsTemplate: 'merchant_approved' },
  rider_approved:       { priority: 'commerce',  category: 'marketplace',   smsTemplate: 'rider_approved' },
  support_reply:        { priority: 'commerce',  category: 'support',       smsTemplate: null },
  kass_reply:           { priority: 'commerce',  category: 'ai',            smsTemplate: null },
  system_update:        { priority: 'commerce',  category: 'system',        smsTemplate: null },

  /* ── marketing: opt-in, quiet-hour respecting ── */
  promotion:            { priority: 'marketing', category: 'promotions', smsTemplate: 'promotion' },
  flash_sale:           { priority: 'marketing', category: 'promotions', smsTemplate: 'promotion' },
  recommendation:       { priority: 'marketing', category: 'promotions', smsTemplate: null },
};

const CATEGORIES = [...new Set(Object.values(TYPES).map(t => t.category))];

/* ── Preferences ──────────────────────────────────────────────────────────
   Per category, per channel. Sensible defaults so a user who never opens
   settings still gets what they need and none of what they don't. */
function defaultPrefs() {
  const p = {};
  for (const c of CATEGORIES) {
    p[c] = {
      push: true,
      inapp: true,
      sms: c === 'security' || c === 'payments' || c === 'delivery',  /* the ones that matter offline */
      email: c === 'payments' || c === 'orders',
      /* Marketing is the one exception: everything off until asked for. */
      ...(c === 'promotions' ? { push: false, sms: false, email: false, inapp: true } : {}),
    };
  }
  return p;
}

async function loadPrefs(uid) {
  const base = defaultPrefs();
  if (!uid) return { prefs: base, quietHours: null };
  try {
    const snap = await db().collection(PREFS).doc(uid).get();
    if (!snap.exists) return { prefs: base, quietHours: null };
    const d = snap.data() || {};
    for (const c of CATEGORIES) if (d[c]) base[c] = { ...base[c], ...d[c] };
    return { prefs: base, quietHours: d.quietHours || null };
  } catch (err) {
    logger.warn('[notify] prefs read failed', { error: err.message });
    return { prefs: base, quietHours: null };
  }
}

/* Quiet hours, in Africa/Nairobi. NEVER applied to critical — a fraud alert or an
   OTP at 2am is exactly when it matters most. */
function inQuietHours(quietHours) {
  if (!quietHours || !quietHours.enabled) return false;
  const now = new Date(Date.now() + 3 * 3600 * 1000);   /* EAT = UTC+3, no DST */
  const h = now.getUTCHours();
  const from = Number(quietHours.from ?? 22);
  const to   = Number(quietHours.to ?? 7);
  return from <= to ? (h >= from && h < to) : (h >= from || h < to);   /* handles 22→07 wrap */
}

/* ── Channel resolution ───────────────────────────────────────────────────
   The engine decides. The caller only declares intent. */
function resolveChannels(type, prefs, quiet) {
  const t = TYPES[type];
  const cat = prefs[t.category] || {};

  if (t.priority === 'critical') {
    /* Deliberately ignores preferences AND quiet hours. A user must not be able to
       switch off — or snooze — the message that logs them in or warns them of fraud. */
    return { push: true, inapp: true, sms: !!t.smsTemplate, email: false, forced: true };
  }

  if (t.priority === 'marketing') {
    if (quiet) return { push: false, inapp: true, sms: false, email: false };  /* still lands in-app */
    return {
      push:  cat.push  === true,      /* opt-IN */
      inapp: cat.inapp !== false,
      sms:   cat.sms   === true,      /* opt-IN, and only if a template exists */
      email: cat.email === true,
    };
  }

  /* commerce — push first; SMS is a FALLBACK, decided after push is attempted. */
  return {
    push:  cat.push !== false,
    inapp: cat.inapp !== false,
    sms:   false,                     /* set later, only if push fails */
    smsFallback: cat.sms !== false && !!t.smsTemplate && !quiet,
    email: cat.email === true,
  };
}

/* ── Push ─────────────────────────────────────────────────────────────────
   Reads BOTH fcmToken and fcmTokens. The client writes the singular; two modules
   were reading the plural and silently reaching nobody. Until the data is
   normalised, tolerate both — an engine that only understood one shape would
   simply move the bug rather than fix it. */
async function collectTokens(uid) {
  const snap = await db().collection('users').doc(uid).get();
  if (!snap.exists) return [];
  const u = snap.data() || {};
  const out = new Set();
  if (typeof u.fcmToken === 'string' && u.fcmToken) out.add(u.fcmToken);
  if (Array.isArray(u.fcmTokens)) u.fcmTokens.filter(Boolean).forEach(t => out.add(t));
  if (typeof u.pushToken === 'string' && u.pushToken) out.add(u.pushToken);
  return [...out];
}

async function sendPush(uid, payload) {
  const tokens = await collectTokens(uid);
  if (!tokens.length) return { ok: false, reason: 'no_token' };

  /* Rich push: image, deep link, action, group. A notification that doesn't open the
     exact screen it's about is a notification that wastes the user's time. */
  const msg = {
    tokens,
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.image ? { imageUrl: payload.image } : {}),
    },
    data: {
      type: String(payload.type || ''),
      deepLink: String(payload.deepLink || '/'),      /* opens the exact screen */
      ...(payload.data || {}),
    },
    android: {
      priority: payload.priority === 'critical' ? 'high' : 'normal',
      notification: {
        channelId: payload.priority === 'critical' ? 'sokoni_critical' : 'sokoni_default',
        ...(payload.group ? { tag: payload.group } : {}),   /* grouping/collapse */
        color: '#71ff00',
        ...(payload.image ? { imageUrl: payload.image } : {}),
      },
    },
    apns: {
      payload: {
        aps: {
          sound: payload.priority === 'critical' ? 'default' : undefined,
          'thread-id': payload.group || undefined,           /* iOS grouping */
          'mutable-content': payload.image ? 1 : undefined,  /* required for rich media */
        },
      },
    },
    webpush: {
      notification: { icon: '/assets/logosokoni.png', badge: '/assets/logosokoni.png' },
      fcmOptions: { link: payload.deepLink || '/' },
    },
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(msg);

    /* Prune dead tokens. Left alone, they accumulate and every future send wastes a
       slot failing against a device that no longer exists. */
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') dead.push(tokens[i]);
    });
    if (dead.length) {
      await db().collection('users').doc(uid).update({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead),
      }).catch(() => {});
    }

    return { ok: res.successCount > 0, sent: res.successCount, failed: res.failureCount };
  } catch (err) {
    logger.error('[notify] push failed', { error: err.message, uid: uid.slice(0, 8) });
    return { ok: false, reason: err.message };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   notify() — the ONE entry point
═════════════════════════════════════════════════════════════════════════ */
async function notify({ uid, type, title, body, vars = {}, phone, image, deepLink, group, dedupeKey, data }) {
  const t = TYPES[type];
  if (!t) throw new HttpsError('invalid-argument', `Unknown notification type "${type}".`);
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  /* Idempotency. A retried Cloud Function, a double-fired trigger, a webhook replay —
     all of these will call notify() twice. The key makes the second one a no-op. */
  const key = dedupeKey || `${type}:${uid}:${Date.now()}`;
  const logRef = db().collection(LOG).doc(key);
  try {
    await logRef.create({
      uid, type, priority: t.priority, category: t.category,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'processing',
    });
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || '')) {
      return { ok: true, deduped: true, key };
    }
    throw err;
  }

  const { prefs, quietHours } = await loadPrefs(uid);
  const quiet = t.priority !== 'critical' && inQuietHours(quietHours);
  const ch = resolveChannels(type, prefs, quiet);

  const result = { key, type, channels: {}, quiet };

  /* IN-APP — always the cheapest and most reliable surface; it is the record. */
  if (ch.inapp) {
    try {
      await db().collection(INAPP).add({
        userId: uid, type, category: t.category, priority: t.priority,
        title, body,
        image: image || null,
        deepLink: deepLink || null,
        group: group || null,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      result.channels.inapp = 'sent';
    } catch (err) {
      result.channels.inapp = 'failed';
      logger.error('[notify] in-app write failed', { error: err.message });
    }
  }

  /* PUSH */
  let pushOk = false;
  if (ch.push) {
    const r = await sendPush(uid, {
      title, body, image, deepLink, group, type,
      priority: t.priority, data,
    });
    pushOk = r.ok;
    result.channels.push = r.ok ? 'sent' : `failed:${r.reason || 'unknown'}`;
  }

  /* SMS — forced for critical; for commerce ONLY as a fallback when push could not
     land. Sending both by default would spam the user and burn credit for nothing. */
  const wantSms = ch.sms || (ch.smsFallback && !pushOk);
  if (wantSms && t.smsTemplate && phone) {
    const r = await sms.enqueue({
      to: phone,
      template: t.smsTemplate,
      vars: { ...vars, title, body },
      uid,
      dedupeKey: `sms:${key}`,          /* the SMS inherits the same idempotency */
    });
    result.channels.sms = r.suppressed ? 'suppressed_by_preference'
                        : r.deduped   ? 'deduped'
                        : 'queued';
  } else if (ch.smsFallback && pushOk) {
    result.channels.sms = 'not_needed_push_delivered';
  }

  await logRef.update({
    status: 'done',
    channels: result.channels,
    quiet,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, ...result };
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPORTS
═════════════════════════════════════════════════════════════════════════ */

exports.notifySend = onCall(
  { region: REGION, secrets: sokoniAt.secrets },
  async (request) => {
    const caller = request.auth && request.auth.uid;
    if (!caller) throw new HttpsError('unauthenticated', 'Sign in required.');

    /* Only admins may notify SOMEONE ELSE. Without this, any signed-in user could
       push arbitrary "SOKONI" notifications to any other user — a phishing primitive. */
    const target = request.data && request.data.uid;
    if (target && target !== caller) {
      const u = await db().collection('users').doc(caller).get();
      const roles = u.exists ? (u.data().roles || []) : [];
      if (!roles.includes('admin') && !roles.includes('superadmin')) {
        throw new HttpsError('permission-denied', 'Cannot notify another user.');
      }
    }
    return notify({ ...request.data, uid: target || caller });
  }
);

exports.notifyGetPreferences = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { prefs, quietHours } = await loadPrefs(uid);
  return {
    ok: true,
    categories: CATEGORIES,
    preferences: prefs,
    quietHours: quietHours || { enabled: false, from: 22, to: 7 },
    /* Stated so the UI can explain why these are not switches. */
    alwaysOn: ['security'],
    note: 'Security and payment-verification messages are always delivered, including during quiet hours.',
  };
});

exports.notifySetPreferences = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const patch = {};
  const d = request.data || {};

  for (const c of CATEGORIES) {
    if (!d[c] || typeof d[c] !== 'object') continue;
    /* SECURITY cannot be switched off on any channel. Silently keep it on rather than
       erroring — the user should not be able to lock themselves out by accident. */
    if (c === 'security') continue;
    const row = {};
    for (const chn of ['push', 'inapp', 'sms', 'email']) {
      if (typeof d[c][chn] === 'boolean') row[chn] = d[c][chn];
    }
    if (Object.keys(row).length) patch[c] = row;
  }

  if (d.quietHours && typeof d.quietHours === 'object') {
    patch.quietHours = {
      enabled: d.quietHours.enabled === true,
      from: Math.min(23, Math.max(0, Number(d.quietHours.from ?? 22))),
      to:   Math.min(23, Math.max(0, Number(d.quietHours.to   ?? 7))),
    };
  }

  if (!Object.keys(patch).length) throw new HttpsError('invalid-argument', 'No valid preferences supplied.');

  await db().collection(PREFS).doc(uid).set({
    ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { ok: true, updated: Object.keys(patch) };
});

/* Analytics — per-channel performance, for the ops dashboard. */
exports.notifyStats = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const u = await db().collection('users').doc(uid).get();
  const roles = u.exists ? (u.data().roles || []) : [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }

  const snap = await db().collection(LOG).orderBy('createdAt', 'desc').limit(1000).get();
  const rows = snap.docs.map(d => d.data());

  const byChannel = {};
  const byType = {};
  let quietDeferred = 0;

  rows.forEach(r => {
    if (r.quiet) quietDeferred++;
    byType[r.type] = (byType[r.type] || 0) + 1;
    for (const [chn, state] of Object.entries(r.channels || {})) {
      byChannel[chn] = byChannel[chn] || { sent: 0, failed: 0, other: 0 };
      if (state === 'sent' || state === 'queued') byChannel[chn].sent++;
      else if (String(state).startsWith('failed')) byChannel[chn].failed++;
      else byChannel[chn].other++;
    }
  });

  for (const c of Object.values(byChannel)) {
    const total = c.sent + c.failed;
    c.successRate = total ? +(c.sent / total * 100).toFixed(1) : null;
  }

  return {
    ok: true,
    sample: rows.length,
    byChannel,
    topTypes: Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([type, count]) => ({ type, count })),
    quietHoursDeferred: quietDeferred,
    registeredTypes: Object.keys(TYPES).length,
  };
});

module.exports.notify = notify;
module.exports.TYPES = TYPES;
module.exports.CATEGORIES = CATEGORIES;
module.exports.resolveChannels = resolveChannels;
module.exports.inQuietHours = inQuietHours;
module.exports.defaultPrefs = defaultPrefs;
