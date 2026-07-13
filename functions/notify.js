/* ══════════════════════════════════════════════════════════════════════════
   SOKONI NOTIFICATION ENGINE  —  notify.js

   ONE entry point for every message SOKONI sends: push, in-app, SMS, email.
   Business code calls notify(...) and never names a channel or a provider.

   ── Why this exists (measured, not assumed) ──────────────────────────────
   Before this: 8 modules sent push directly, 19 wrote the notifications
   collection directly, and there was no shared helper. That fragmentation had
   already produced a silent production failure:

     the client WRITES    users/{uid}.fcmToken      ← a FIELD on the user doc
     loyalty.js READ      collection('fcmTokens')   ← a top-level COLLECTION
     redis-jobs.js READ   users/{uid}/fcmTokens     ← a SUBCOLLECTION

   Nothing ever wrote either collection (redis-jobs only ever *deactivated* rows in
   one). So both queries always came back EMPTY, and push from those two modules
   never reached a single user — silently, for as long as they have existed.

   Three different ideas about where a push token lives, in one codebase, is what a
   missing seam costs. This engine is the ONE token source: it reads the user-doc
   field and tolerates the array shape, so nobody is unreachable.

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
const emailSvc = require('./email-service');
const emailTpl = require('./email-templates');

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
  /* Loyalty & rewards. These reach the user through the engine now, so they get an
     IN-APP notification as well as a push. Previously loyalty.js pushed directly and
     wrote no in-app row at all — so when push failed (and it always did: see the
     fcmTokens note above), the user was told nothing whatsoever. Points arrived in
     total silence. An unannounced reward is not a reward; it is a database entry. */
  loyalty_earned:       { priority: 'commerce',  category: 'loyalty',       smsTemplate: null },
  loyalty_welcome:      { priority: 'commerce',  category: 'loyalty',       smsTemplate: null },
  birthday_bonus:       { priority: 'marketing', category: 'loyalty',       smsTemplate: null },
  cashback_received:    { priority: 'commerce',  category: 'loyalty',       smsTemplate: null },
  /* Procurement. A supplier receiving a purchase order is commerce, not marketing — it is
     an order for goods, and it must not be suppressible by a preference toggle. */
  po_sent:              { priority: 'commerce',  category: 'procurement',   smsTemplate: 'po_sent' },
  po_accepted:          { priority: 'commerce',  category: 'procurement',   smsTemplate: null },
  po_rejected:          { priority: 'commerce',  category: 'procurement',   smsTemplate: null },
  goods_received:       { priority: 'commerce',  category: 'procurement',   smsTemplate: null },
  support_reply:        { priority: 'commerce',  category: 'support',       smsTemplate: null },
  kass_reply:           { priority: 'commerce',  category: 'ai',            smsTemplate: null },
  system_update:        { priority: 'commerce',  category: 'system',        smsTemplate: null },

  /* ── marketing: opt-in, quiet-hour respecting ── */
  promotion:            { priority: 'marketing', category: 'promotions', smsTemplate: 'promotion' },
  flash_sale:           { priority: 'marketing', category: 'promotions', smsTemplate: 'promotion' },
  recommendation:       { priority: 'marketing', category: 'promotions', smsTemplate: null },
};

const CATEGORIES = [...new Set(Object.values(TYPES).map(t => t.category))];

/* Duplicate-suppression window for callers that supply no dedupeKey. 60s is long
   enough to swallow a double-fired trigger and short enough that a user who
   legitimately triggers the same message twice (re-requesting an OTP, say) is not
   left waiting on a notification that was silently dropped. */
const DEDUPE_WINDOW_MS = 60 * 1000;

/* FNV-1a. Not a security hash — a content fingerprint, so that "same message twice in
   a minute" can be recognised without storing the message. Collisions are harmless
   here: the worst case is one duplicate notification suppressed, never a wrong one
   sent, because the key also carries the type and the uid. */
function _contentHash(title, body) {
  const s = String(title || '') + '\u0000' + String(body || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

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
    /* FCM data values must be STRINGS. `url` is carried alongside `deepLink` because
       the service workers have always read `url` — sending only `deepLink` would have
       silently opened the homepage for every push. Same shape of bug as the
       fcmToken/fcmTokens mismatch above: a key name nobody re-checked. */
    data: {
      type: String(payload.type || ''),
      deepLink: String(payload.deepLink || '/'),      /* opens the exact screen */
      url: String(payload.deepLink || '/'),
      ...(payload.group ? { group: String(payload.group) } : {}),
      ...(payload.image ? { image: String(payload.image) } : {}),
      ...(payload.data || {}),
    },
    android: {
      priority: payload.priority === 'critical' ? 'high' : 'normal',
      notification: {
        channelId: payload.priority === 'critical' ? 'sokoni_critical' : `sokoni_${payload.category || 'default'}`,
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
      notification: {
        /* The official icon set, generated from assets/logosokoni.png. The badge is the
           monochrome-able silhouette Android draws in the status bar — it must be small and
           square, so it is NOT the same file as the icon. */
        icon: '/assets/icons/icon-192.png',
        badge: '/assets/icons/icon-96.png',
        ...(payload.image ? { image: payload.image } : {}),
        /* tag collapses successive updates for the same order into ONE notification
           instead of stacking eleven. renotify still alerts on each change. */
        ...(payload.group ? { tag: payload.group, renotify: true } : {}),
      },
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
async function notify({ uid, type, title, body, vars = {}, phone, email, image, deepLink, group, dedupeKey, data }) {
  const t = TYPES[type];
  if (!t) throw new HttpsError('invalid-argument', `Unknown notification type "${type}".`);
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  /* Idempotency AND duplicate suppression — two different guarantees.

     IDEMPOTENCY is what a caller asks for explicitly with dedupeKey: "this event has a
     natural identity (order X reached stage Y), send it at most once, ever." A retried
     Cloud Function, a double-fired trigger or a webhook replay becomes a no-op.

     DUPLICATE SUPPRESSION is the safety net for callers who pass no key. The fallback
     key used to be `${type}:${uid}:${Date.now()}`, which is unique by construction — so
     it deduplicated NOTHING, while the comment above it claimed a short-window drop.
     A dedupe key containing a timestamp is not a dedupe key.

     The fallback now hashes the CONTENT and buckets it into a 60-second window, which
     is what "duplicate" actually means: the same message, to the same person, twice in
     a moment. Two DIFFERENT messages of the same type still both arrive — suppressing
     those would silently swallow a real notification, which is a worse failure than
     showing a duplicate. When in doubt, deliver. */
  const key = dedupeKey || `${type}:${uid}:${_contentHash(title, body)}:${Math.floor(Date.now() / DEDUPE_WINDOW_MS)}`;
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
      /* BOTH ownership fields, deliberately.

         The notification CENTER queries where('targetUid','==',uid). Writing only
         `userId` — as this engine originally did, and as ~19 other modules still do —
         means the notification is stored correctly and is never seen by anyone: it
         simply does not match the feed's query. Third instance of the same failure in
         this subsystem (fcmToken/fcmTokens, deepLink/url, and now userId/targetUid):
         two names for one thing, and no test that would notice.

         Writing both is not redundancy, it is the migration: every caller routed
         through this engine becomes visible in the feed without touching the caller. */
      await db().collection(INAPP).add({
        userId: uid, targetUid: uid,
        type, category: t.category, priority: t.priority,
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
      priority: t.priority, category: t.category, data,
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

  /* EMAIL — queued asynchronously so a slow SendGrid call never blocks the CF.
     Requires either a caller-supplied `email` address or a Firebase Auth lookup.
     Never sent for critical types (OTP etc.) — those use SMS for immediate delivery.
     Respects ch.email which is already preference-checked via resolveChannels(). */
  if (ch.email) {
    try {
      let toEmail = email;
      if (!toEmail) {
        const authUser = await admin.auth().getUser(uid).catch(() => null);
        toEmail = authUser && authUser.email ? authUser.email : null;
      }
      if (toEmail) {
        const catSender = {
          payments: emailSvc.FROM.payments,
          orders:   emailSvc.FROM.notifications,
          delivery: emailSvc.FROM.notifications,
          loyalty:  emailSvc.FROM.notifications,
          marketplace: emailSvc.FROM.marketplace,
        };
        const from = catSender[t.category] || emailSvc.FROM.notifications;
        const ctaUrl = deepLink ? `https://mysokoni.co.ke${deepLink.startsWith('/') ? '' : '/'}${deepLink}` : 'https://mysokoni.co.ke';
        const html = emailTpl.base({
          title,
          preheader: body,
          cta: 'Open SOKONI',
          ctaUrl,
          body: `<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#374151;line-height:1.6;">${body}</p>`,
        });
        await emailSvc.queue({
          to:       toEmail,
          from,
          subject:  title,
          html,
          text:     emailTpl.toPlainText(html),
          uid,
          category: t.category,
          emailId:  `email:${key}`,
        });
        result.channels.email = 'queued';
      } else {
        result.channels.email = 'no_address';
      }
    } catch (err) {
      result.channels.email = 'failed';
      logger.error('[notify] email queue failed', { error: err.message, uid: uid.slice(0, 8) });
    }
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

/* ══════════════════════════════════════════════════════════════════════════
   ORDER TIMELINE — the 11 customer-facing stages of an order.

   Stages are DATA. Adding one is a registry entry, not a code change.

   Two properties the customer actually feels:

   MONOTONIC — advancing to a stage already passed is a no-op. A retried Cloud
   Function or a duplicate courier webhook must never rewind "Delivered" back to
   "On The Way". An order that jumps backwards is worse than one that says nothing.

   QUIET WHERE IT SHOULD BE — a stage with type:null updates the timeline and the
   map but does not buzz the phone. Eleven pushes per order is how a premium
   experience becomes a muted app.
═════════════════════════════════════════════════════════════════════════ */
const ORDER_TIMELINE = [
  { key: 'received',  label: 'Order Received',    type: 'order_placed',     milestone: true  },
  { key: 'paid',      label: 'Payment Confirmed', type: 'payment_success',  milestone: true  },
  { key: 'accepted',  label: 'Seller Accepted',   type: 'order_accepted',   milestone: true  },
  { key: 'preparing', label: 'Preparing Order',   type: 'order_preparing',  milestone: false },
  { key: 'ready',     label: 'Package Ready',     type: 'order_ready',      milestone: false },
  { key: 'assigned',  label: 'Rider Assigned',    type: 'rider_assigned',   milestone: true  },
  { key: 'picked_up', label: 'Picked Up',         type: 'order_dispatched', milestone: true  },
  { key: 'halfway',   label: 'On The Way',        type: null,               milestone: false },
  { key: 'near',      label: 'Near You',          type: 'rider_nearby',     milestone: false },
  { key: 'delivered', label: 'Delivered',         type: 'order_delivered',  milestone: true  },
  { key: 'completed', label: 'Completed',         type: null,               milestone: false },
];
const STAGE_INDEX = Object.fromEntries(ORDER_TIMELINE.map((s, i) => [s.key, i]));

async function advanceOrder({ orderId, stage, uid, phone, title, body, image, deepLink, vars }) {
  const idx = STAGE_INDEX[stage];
  if (idx === undefined) throw new HttpsError('invalid-argument', 'Unknown order stage: ' + stage);

  const ref  = db().collection('orders').doc(String(orderId));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found.');

  const order   = snap.data() || {};
  const current = STAGE_INDEX[order.timelineStage];
  const at      = (current === undefined) ? -1 : current;

  if (idx <= at) return { ok: true, unchanged: true, stage: order.timelineStage };

  const st  = ORDER_TIMELINE[idx];
  const who = uid || order.uid || order.buyerId;

  await ref.update({
    timelineStage: st.key,
    timelineIndex: idx,
    timeline: admin.firestore.FieldValue.arrayUnion({ key: st.key, label: st.label, at: Date.now() }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  let notified = null;
  if (st.type && who) {
    notified = await notify({
      uid: who,
      type: st.type,
      phone,
      title: title || st.label,
      body:  body  || ('Order ' + orderId + ': ' + st.label.toLowerCase() + '.'),
      image,
      deepLink:  deepLink || ('/track?order=' + orderId),
      group:     'order:' + orderId,              /* every update for one order collapses into one thread */
      dedupeKey: 'order:' + orderId + ':' + st.key, /* one notification per stage, ever */
      vars: vars || {},
      data: { orderId: String(orderId), stage: st.key },
    });
  }

  return { ok: true, stage: st.key, index: idx, milestone: st.milestone, notified };
}

/* Callable form. Only the seller/rider/admin side advances an order, so this
   requires auth; the buyer's client only ever READS the timeline. */
exports.orderAdvance = onCall(
  { region: REGION, secrets: sokoniAt.secrets },
  async (request) => {
    if (!(request.auth && request.auth.uid)) throw new HttpsError('unauthenticated', 'Sign in required.');
    return advanceOrder(request.data || {});
  }
);

/* Exported so legacy push senders can migrate onto the ONE token source without a
   full rewrite. loyalty.js and redis-jobs.js were each querying an fcmTokens
   COLLECTION that nothing ever writes — the client writes users/{uid}.fcmToken, a
   FIELD. Both therefore pushed to nobody, silently. */
module.exports.collectTokens = collectTokens;
module.exports.sendPush = sendPush;
module.exports.notify = notify;
module.exports.advanceOrder = advanceOrder;
module.exports.ORDER_TIMELINE = ORDER_TIMELINE;
module.exports.TYPES = TYPES;
module.exports.CATEGORIES = CATEGORIES;
module.exports.resolveChannels = resolveChannels;
module.exports.inQuietHours = inQuietHours;
module.exports.defaultPrefs = defaultPrefs;
