/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Client diagnostics intake

   WHY THIS EXISTS
   post-launch-monitor.js:228 already reads an `errorLog` collection and surfaces
   the top errors for a period. Nothing client-side has ever written to it, and
   `errorLog` has no Firestore rule — so it is default-deny and unreachable from
   a browser. The monitor has therefore been reporting zero client errors not
   because there are none, but because nothing reports.

   That is the worst kind of blind spot: a dashboard that looks healthy because
   it is empty.

   WHY A CLOUD FUNCTION RATHER THAN A RULE
   Opening errorLog to client writes would hand an abuse surface to any
   authenticated user and let a broken loop flood a monitoring collection. This
   validates, truncates, rate-limits and stamps server-side identity, so a client
   can report a problem but cannot forge who reported it or how much.

   The pilot directive asks that merchants never have to collect technical
   information by hand. This is that: the browser attaches device, version and
   order context automatically, and the merchant only ever sees a plain message.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');
const { checkRateLimit } = require('./redis-rate-limiter');

/* Bounded so a runaway client cannot write large documents. */
const MAX = { code: 80, message: 400, context: 1200, surface: 60 };
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

/* Only these are accepted. An unrecognised severity becomes 'error' rather than
   being stored verbatim, so the field stays queryable. */
const SEVERITIES = new Set(['info', 'warn', 'error', 'critical']);

exports.logClientDiagnostic = onCall(
  { cors: true, enforceAppCheck: true, region: 'us-central1' },
  async (request) => {
    const uid = request.auth && request.auth.uid;

    /* AUTH FAILURES ARE UNAUTHENTICATED BY DEFINITION.
       Requiring a uid here meant the one category of failure that most needs
       reporting could never be reported: a user whose sign-in fails has no uid,
       so every OAuth/OTP error was rejected by this function and died in that
       user's console. Measured 2026-07-24: errorLog, clientDiagnostics and
       _sokoniTelemetry were ALL empty, while "Google sign-in doesn't work on my
       phone" was an open, repeatedly-reported production issue with no server-side
       evidence of any kind to diagnose it from.

       Anonymous reports are accepted ONLY from auth surfaces, so this is not a
       general-purpose open logging endpoint. Three things still bound it:
         - enforceAppCheck is on, so the caller must pass attestation;
         - the rate limit below applies to anonymous callers on a tighter budget;
         - uid/email stay null and are never read from the payload, so an
           anonymous report can never be attributed to a real account.
       Everything else keeps requiring a signed-in caller. */
    const surface = String((request.data && request.data.surface) || '');
    const isAuthSurface = /^auth-/.test(surface);
    if (!uid && !isAuthSurface) throw new HttpsError('unauthenticated', 'Sign in required.');

    /* 'default' is deliberately NOT in _SECURITY_ACTIONS (redis-rate-limiter.js:37),
       so if Redis is down this fails OPEN. Telemetry must never break the app it
       is observing — a merchant losing the board because diagnostics were
       throttled would be a worse outcome than losing a log line. */
    /* Anonymous callers get a tighter budget than signed-in ones: they are
       identified only by App Check + IP, so the blast radius of a misbehaving
       client is wider. 10/min is far above what a real sign-in attempt needs. */
    try { await checkRateLimit(request, 'default', uid
            ? { maxRequests: 60, windowSeconds: 60 }
            : { maxRequests: 10, windowSeconds: 60 }); }
    catch (e) {
      if (e && e.code === 'resource-exhausted') return { ok: false, throttled: true };
      /* any other limiter failure is ignored — see above */
    }

    const d = request.data || {};
    const severity = SEVERITIES.has(d.severity) ? d.severity : 'error';

    const doc = {
      /* `timestamp` is the field post-launch-monitor.js:229 filters and orders
         on. Naming it anything else would write records the dashboard cannot see. */
      timestamp:  FieldValue.serverTimestamp(),
      severity,
      surface:    cut(d.surface, MAX.surface) || 'unknown',   /* e.g. seller-board */
      code:       cut(d.code, MAX.code),
      message:    cut(d.message, MAX.message),
      context:    cut(typeof d.context === 'string' ? d.context : JSON.stringify(d.context || {}), MAX.context),

      /* Identity is taken from the verified token, never from the payload — a
         client cannot attribute its errors to another merchant. Both are null for
         an anonymous auth-surface report, which is correct: there is no verified
         identity to record, and reading one from the payload would let a caller
         attribute a failure to somebody else's account. */
      uid:        uid || null,
      email:      (request.auth && request.auth.token && request.auth.token.email) || null,
      anonymous:  !uid,

      /* Merchant + order context, so a support case does not need the merchant
         to explain which order they were looking at. */
      merchantId: cut(d.merchantId, 120),
      orderId:    cut(d.orderId, 120),

      /* Environment, captured automatically. */
      userAgent:  cut(d.userAgent, 300),
      appVersion: cut(d.appVersion, 40),
      viewport:   cut(d.viewport, 20),
      online:     d.online === false ? false : true,
      url:        cut(d.url, 300),
    };

    try {
      await getFirestore().collection('errorLog').add(doc);
    } catch (e) {
      /* Never surface a telemetry failure to the caller. */
      logger.error('[diagnostics] write failed', { uid, err: e && e.message });
      return { ok: false };
    }

    /* Mirror critical events into Cloud Logging so they page without waiting for
       the daily monitor sweep. */
    if (severity === 'critical' || severity === 'error') {
      logger.error('[client] ' + doc.surface + ': ' + (doc.code || doc.message), {
        uid, merchantId: doc.merchantId, orderId: doc.orderId, context: doc.context,
      });
    }

    return { ok: true };
  });
