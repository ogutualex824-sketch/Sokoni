'use strict';
/**
 * SOKONI Communication Engine — the admin send path and provider health.
 * ============================================================================================
 * Two callables, both platform-admin only:
 *
 *     communicationPlan     what WOULD happen, and why — nothing is sent
 *     communicationSend     send it, through notify.js, anchored to the business event
 *     communicationHealth   which providers are actually provisioned
 *
 * ── THIS IS THE ROUTER'S FIRST PRODUCTION CALLER ───────────────────────────────────────────
 * Until now `communication-router.js` was a policy module nothing consulted — a table with no
 * reader, which is the defect this codebase has paid for twice. `communicationPlan` and
 * `communicationSend` both route through it, so the policy is now load-bearing: if it says a
 * commerce message may not go by SMS, no SMS is sent.
 *
 * ── IT DOES NOT SEND. notify.js SENDS ──────────────────────────────────────────────────────
 * This resolves WHO, WHAT and WHICH CHANNEL, then hands the result to `notify.js`, which owns
 * tokens, preferences, quiet hours, dedupe and the audit log. Nothing here touches a provider
 * SDK. A second sender is the thing the whole engine exists to prevent.
 *
 * ── PLAN BEFORE SEND, ON PURPOSE ───────────────────────────────────────────────────────────
 * `communicationPlan` exists so an operator sees the channel decision BEFORE committing —
 * including every channel that was ruled out and why. "Why didn't we text them?" is a question
 * someone asks about a bill, and the answer should be on the screen where the decision was
 * made, not reconstructed from code afterwards.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const ENV = require('./shared/communication-envelope');
const ROUTER = require('./shared/communication-router');
const PROVIDERS = require('./shared/communication-providers');
const TPL = require('./shared/communication-templates');

const REGION = 'us-central1';

function _db() { return admin.firestore(); }

function _requireAdmin(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  const t = req.auth.token || {};
  if (t.admin !== true && t.superAdmin !== true) {
    throw new HttpsError('permission-denied', 'Platform admin only');
  }
  return req.auth.uid;
}

function _str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }

/**
 * _reachabilityOf(uid) -> { present, hasPushTarget, hasEmail, hasPhone }
 *
 * Read, never assumed. Every absent signal reads as FALSE: a router asked to plan for someone
 * whose record could not be read must not invent a channel for them.
 *
 * `present` comes from the same `presence` document Connect uses, so "is this person looking
 * at SOKONI" has one answer across the platform rather than two.
 */
async function _reachabilityOf(uid) {
  const db = _db();
  const [userSnap, presenceSnap] = await Promise.all([
    db.collection('users').doc(uid).get().catch(() => null),
    db.collection('presence').doc(uid).get().catch(() => null),
  ]);
  const u = (userSnap && userSnap.exists && userSnap.data()) || {};
  const p = (presenceSnap && presenceSnap.exists && presenceSnap.data()) || {};

  /* Tokens come from the ONE notification engine, which is the only thing that knows where a
     push can land. Asking it rather than reading a field keeps a second token source from
     existing — three ideas about where a token lives already cost this codebase a silent
     production failure. */
  let hasPushTarget = false;
  try {
    const notify = require('./notify');
    if (typeof notify.collectTokens === 'function') {
      const tokens = await notify.collectTokens(uid);
      hasPushTarget = Array.isArray(tokens) && tokens.length > 0;
    }
  } catch (e) {
    logger.warn('[communication-send] token lookup failed — treating as unreachable',
      { uid, err: e && e.message });
  }

  return {
    present: p.online === true,
    hasPushTarget,
    hasEmail: !!(u.email && String(u.email).includes('@')),
    hasPhone: !!(u.phone || u.phoneNumber || u.msisdn),
  };
}

/**
 * _resolveContent({ templateId, channel, vars, subject, body })
 *
 * A template if one is named, a clearly-marked custom message otherwise. Both throw rather
 * than producing copy with a blank in it.
 */
function _resolveContent(d, channel) {
  if (d.templateId) {
    return TPL.render({ templateId: _str(d.templateId, 64), channel, vars: d.vars || {} });
  }
  return TPL.describeCustom(d.subject, d.body);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   1. communicationPlan — what WOULD happen. Nothing is sent.
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.communicationPlan = onCall({ region: REGION, timeoutSeconds: 20 }, async (req) => {
  _requireAdmin(req);
  const d = req.data || {};
  const recipientUid = _str(d.recipientUid, 128);
  const priority = _str(d.priority, 20) || 'commerce';
  if (!recipientUid) throw new HttpsError('invalid-argument', 'recipientUid required');

  const reach = await _reachabilityOf(recipientUid);
  const route = ROUTER.routeFor({
    priority,
    present: reach.present,
    hasPushTarget: reach.hasPushTarget,
    hasEmail: reach.hasEmail,
    hasPhone: reach.hasPhone,
    requiresRecord: d.requiresRecord === true,
  });

  return {
    recipientUid,
    priority,
    /* Reachability is reported as booleans — never an address or a number. An operator needs
       to know a channel is available, not what the value is. */
    reachability: reach,
    plan: route.plan,
    considered: route.considered,
    reason: route.reason,
    /* Rendered so the operator reads the actual words before committing. */
    explain: ROUTER.explain(route),
    sent: false,
  };
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   2. communicationSend — hand it to notify.js, anchored
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.communicationSend = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  const adminUid = _requireAdmin(req);
  const d = req.data || {};
  const recipientUid = _str(d.recipientUid, 128);
  const anchorType = d.anchorType ? _str(d.anchorType, 32) : null;
  const anchorId = d.anchorId ? _str(d.anchorId, 200) : null;

  if (!recipientUid) throw new HttpsError('invalid-argument', 'recipientUid required');
  if (recipientUid === adminUid) {
    throw new HttpsError('failed-precondition', 'That would send a message to yourself');
  }
  /* An anchor is not mandatory — some messages genuinely are about the account itself — but a
     MALFORMED one is refused rather than silently dropped, because a message recorded as
     unanchored when the operator thought they anchored it disappears from the timeline they
     will go looking in. */
  if ((anchorType || anchorId) && !(anchorType && anchorId)) {
    throw new HttpsError('invalid-argument', 'an anchor needs both anchorType and anchorId');
  }
  if (anchorType && !ENV.ANCHOR_TYPES.includes(anchorType)) {
    throw new HttpsError('invalid-argument',
      `anchorType must be one of: ${ENV.ANCHOR_TYPES.join(', ')}`);
  }

  const reach = await _reachabilityOf(recipientUid);

  /* Content first: if the copy cannot be rendered, nothing is routed and nothing is sent. */
  let content;
  try {
    /* Rendered against the channel the router will lead with. A template not approved for
       that channel is a refusal — see communication-templates. */
    const probe = ROUTER.routeFor({
      priority: d.templateId ? (TPL.TEMPLATES[_str(d.templateId, 64)] || {}).priority || 'commerce'
        : 'commerce',
      present: reach.present, hasPushTarget: reach.hasPushTarget,
      hasEmail: reach.hasEmail, hasPhone: reach.hasPhone,
      requiresRecord: d.requiresRecord === true,
    });
    const lead = probe.plan[0];
    if (!lead) {
      throw new HttpsError('failed-precondition',
        `Nothing can reach this person right now (${probe.reason}).`);
    }
    content = _resolveContent(d, lead);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('invalid-argument', e.message);
  }

  const route = ROUTER.routeFor({
    priority: content.priority,
    present: reach.present,
    hasPushTarget: reach.hasPushTarget,
    hasEmail: reach.hasEmail,
    hasPhone: reach.hasPhone,
    requiresRecord: d.requiresRecord === true,
  });
  if (!route.plan.length) {
    throw new HttpsError('failed-precondition',
      `Nothing can reach this person right now (${route.reason}).`);
  }

  /* notify.js maps an INTENT to channels of its own. The router's plan is recorded as the
     platform's reachability view and is NOT forced onto it — two systems fighting over the
     channel is exactly the second-authority problem. The one thing the router does decide,
     and notify.js honours by type, is that a non-critical message never becomes an SMS. */
  const type = content.priority === 'critical' ? 'admin_alert' : 'case_updated';

  let result;
  try {
    const notify = require('./notify');
    result = await notify.notify({
      uid: recipientUid,
      type: TPL.TEMPLATES[content.templateId || ''] ? _notifyTypeFor(content) : type,
      title: content.subject || 'A message from SOKONI',
      body: content.body,
      anchorType: anchorType || undefined,
      anchorId: anchorId || undefined,
      dedupeKey: `admin_msg:${adminUid}:${recipientUid}:${Date.now()}`,
      awaitDelivery: true,
    });
  } catch (e) {
    /* A send failure is a RESULT. Reporting success here would tell an operator a customer
       was told something they were never told. */
    logger.warn('[communication-send] notify failed', { recipientUid, err: e && e.message });
    throw new HttpsError('internal', 'Nothing was sent: ' + (e && e.message || 'the send failed'));
  }

  logger.info('[communication-send] sent', {
    adminUid, recipientUid, templateId: content.templateId, anchored: !!anchorType,
    plan: route.plan.join(','),
  });

  return {
    recipientUid,
    templateId: content.templateId,
    source: content.source,
    plan: route.plan,
    considered: route.considered,
    anchored: !!(anchorType && anchorId),
    /* Straight from the engine. `deduped` means an identical message was already sent and
       this one was not — reported, never smoothed into "sent". */
    deduped: !!(result && result.deduped),
    notifyKey: (result && result.key) || null,
    sent: true,
  };
});

/* Templates whose names match a registered notify type keep it; everything else is a support
   update. Mapping by name rather than by a second table means a new template that matches an
   existing intent needs no wiring. */
function _notifyTypeFor(content) {
  const id = String(content.templateId || '');
  return id === 'payment_received' ? 'payment_success'
    : id === 'payment_failed' ? 'payment_failed'
      : id === 'refund_processed' ? 'refund_processed'
        : id === 'order_cancelled' ? 'order_cancelled'
          : id === 'rider_assigned' ? 'rider_assigned'
            : content.priority === 'critical' ? 'admin_alert' : 'case_updated';
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   3. communicationHealth — which providers are actually provisioned
══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * PROVISIONING, NOT LIVENESS, and the distinction is the whole value.
 *
 * This reports whether a credential EXISTS. It does not report whether the provider works —
 * nothing here has sent anything. A dashboard that renders "operational" over an expired API
 * key is worse than one that renders nothing, because it is consulted during an incident.
 *
 * NO SECRET VALUE IS EVER RETURNED, or logged, or length-reported. Presence is a boolean.
 */
function _configuredFromEnv() {
  const env = process.env || {};
  const has = (k) => typeof env[k] === 'string' && env[k].trim().length > 0;
  return {
    sendgrid: has('SENDGRID_API_KEY'),
    smtp: has('MAIL_HOST') && has('MAIL_USER') && has('MAIL_PASS'),
    /* No Workspace credential is provisioned in this repository. Reported as absent rather
       than omitted, so "we have no human mailbox transport" is visible. */
    google_workspace: has('GOOGLE_WORKSPACE_KEY'),
    africas_talking: has('AFRICASTALKING_API_KEY') && has('AFRICASTALKING_USERNAME'),
    /* FCM needs no key — the Admin SDK carries platform credentials. */
    fcm: true,
    /* Connect relays signalling itself; TURN is genuinely unprovisioned. */
    webrtc: true,
    turn: has('TURN_URL') && has('TURN_CREDENTIAL'),
  };
}

exports.communicationHealth = onCall({ region: REGION, timeoutSeconds: 20 }, async (req) => {
  _requireAdmin(req);
  const configured = _configuredFromEnv();
  const rows = PROVIDERS.healthRowsFor(configured);

  /* Chains are reported with what is SKIPPED, so an operator can see that email would fall
     back to SMTP — or that it has nowhere to fall back to. */
  const chains = {};
  Object.keys(PROVIDERS.CHAINS).forEach((ch) => {
    chains[ch] = PROVIDERS.chainFor({ channel: ch, configured });
  });

  return {
    rows,
    chains,
    /* Said in the response so a console cannot render this as uptime. */
    measures: 'provisioning',
    doesNotMeasure: 'liveness, delivery rate, or latency — nothing here has sent anything',
    failoverPolicy: Object.keys(PROVIDERS.FAILURE_CLASSES).map((k) => ({
      failureClass: k,
      failsOver: PROVIDERS.FAILURE_CLASSES[k].failover,
      describe: PROVIDERS.FAILURE_CLASSES[k].describe,
    })),
  };
});

exports._internals = { _configuredFromEnv, _notifyTypeFor, _resolveContent };
