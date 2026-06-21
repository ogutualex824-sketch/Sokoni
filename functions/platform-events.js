/* ================================================================
   SOKONI PLATFORM EVENT BUS  v1.0.0  |  2026-06-21
   functions/platform-events.js

   Server-side persistent event bus for domain events.
   Bridges the gap between the client-side sokoni-event-bus.js
   (in-memory, browser-only) and Cloud Functions, which need
   to react to domain events without tight coupling.

   Design:
     - All domain events are persisted in `platformEvents` (immutable)
     - Firestore trigger fans out to registered CF subscribers
     - Subscribers are stored in `platformSubscriptions`
     - Events are published with correlationId for tracing
     - Admin replay for debugging failed event handlers

   Domain Event Types (aligned with sokoni-event-bus.js definitions):
     Order.*       Payment.*      Escrow.*     Wallet.*
     Commission.*  Settlement.*   Delivery.*   Ride.*
     Ticket.*      SmartPOS.*     User.*       Business.*
     Fraud.*       Subscription.* System.*     AI.*
     Platform.*    Entitlement.*  Risk.*       License.*

   Exports:
     platformPublishEvent     — onCall: publish a domain event
     platformGetEventLog      — onCall: paginated audit trail
     platformRegisterSub      — onCall: register a CF subscriber
     platformGetSubscriptions — onCall: list subscribers
     platformReplayEvents     — onCall: admin replay
     onPlatformEventCreated   — Firestore trigger: fan-out
================================================================ */
'use strict';

const { onCall, HttpsError }   = require('firebase-functions/v2/https');
const { onDocumentCreated }    = require('firebase-functions/v2/firestore');
const { logger }               = require('firebase-functions');
const admin                    = require('firebase-admin');
const crypto                   = require('crypto');
const FieldValue               = admin.firestore.FieldValue;

const { assertAuth, assertAdmin, sanitize } = require('./shared/errors');

const db  = () => admin.firestore();
const san = (s, n = 200) => sanitize(s, n);

/* ── Event domain prefixes ───────────────────────────────── */
const VALID_DOMAINS = [
  'Order','Payment','Escrow','Wallet','Commission','Settlement',
  'Delivery','Ride','Ticket','SmartPOS','User','Business','Fraud',
  'Subscription','System','AI','Platform','Entitlement','Risk',
  'License','Seat','Organization','Invoice','Credit','Storage',
  'Feature','Workflow','Search','Analytics','Media','Property',
  'Vehicle','Event','Healthcare','Education','Finance',
];

function _validateEventType(type) {
  if (!type || !type.includes('.')) return false;
  const domain = type.split('.')[0];
  return VALID_DOMAINS.includes(domain);
}

/* ================================================================
   platformPublishEvent
   Core event publishing endpoint.
   Any authenticated service can publish domain events.
   Events are persisted immutably — they cannot be updated or deleted.
================================================================ */
const platformPublishEvent = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const publisherUid = assertAuth(req);

    const eventType      = san(req.data.type, 100);
    const payload        = req.data.payload || {};
    const sourceService  = san(req.data.sourceService || '', 80);
    const correlationId  = san(req.data.correlationId || '', 64) || crypto.randomUUID();
    const idempotencyKey = san(req.data.idempotencyKey || '', 128);

    if (!_validateEventType(eventType))
      throw new HttpsError('invalid-argument', `Invalid event type: ${eventType}. Must be Domain.Action format.`);

    /* Idempotency check */
    if (idempotencyKey) {
      const existing = await db().collection('platformEvents')
        .where('idempotencyKey', '==', idempotencyKey).limit(1).get();
      if (!existing.empty) {
        return { success: true, eventId: existing.docs[0].id, duplicate: true };
      }
    }

    const now     = Date.now();
    const eventId = crypto.randomUUID();

    await db().collection('platformEvents').doc(eventId).set({
      eventId,
      type:           eventType,
      domain:         eventType.split('.')[0],
      action:         eventType.split('.').slice(1).join('.'),
      payload,
      sourceService:  sourceService || null,
      publisherUid,
      correlationId,
      idempotencyKey: idempotencyKey || null,
      publishedAt:    now,
      ts:             FieldValue.serverTimestamp(),
      fanOutStatus:   'pending',
      fanOutCount:    0,
    });

    return { success: true, eventId, correlationId };
  }
);

/* ================================================================
   platformGetEventLog
   Paginated event log browser for admin and service owners.
================================================================ */
const platformGetEventLog = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const isAdmin      = req.auth.token?.admin || req.auth.token?.superAdmin;
    const domain       = san(req.data.domain || '', 50);
    const type         = san(req.data.type   || '', 100);
    const correlationId = san(req.data.correlationId || '', 64);
    const pageSize     = Math.min(req.data.pageSize || 25, 100);
    const since        = req.data.since ? Number(req.data.since) : (Date.now() - 86400000);

    /* Non-admins can only see events they published */
    if (!isAdmin) {
      const snap = await db().collection('platformEvents')
        .where('publisherUid', '==', req.auth.uid)
        .where('publishedAt', '>=', since)
        .orderBy('publishedAt', 'desc').limit(pageSize).get();
      return { events: snap.docs.map(d => ({ id: d.id, ...d.data() })), total: snap.docs.length };
    }

    /* Admin: full access with filters */
    let q = db().collection('platformEvents').orderBy('publishedAt', 'desc');

    if (correlationId) {
      const snap = await db().collection('platformEvents')
        .where('correlationId', '==', correlationId).orderBy('publishedAt','desc').get();
      return { events: snap.docs.map(d => ({ id: d.id, ...d.data() })), total: snap.docs.length };
    }

    if (type) {
      q = db().collection('platformEvents')
        .where('type', '==', type).where('publishedAt', '>=', since).orderBy('publishedAt','desc');
    } else if (domain) {
      q = db().collection('platformEvents')
        .where('domain', '==', domain).where('publishedAt', '>=', since).orderBy('publishedAt','desc');
    } else {
      q = db().collection('platformEvents')
        .where('publishedAt', '>=', since).orderBy('publishedAt','desc');
    }

    const snap = await q.limit(pageSize).get();
    return { events: snap.docs.map(d => ({ id: d.id, ...d.data() })), total: snap.docs.length };
  }
);

/* ================================================================
   platformRegisterSub
   Register a CF subscriber for a domain event pattern.
   When a matching event is published, the fan-out trigger
   creates a task in `platformFanOut` which the subscriber CF
   can poll, or the registered webhook URL is called.
================================================================ */
const platformRegisterSub = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const serviceId   = san(req.data.serviceId, 80);
    const eventPattern = san(req.data.eventPattern, 100);  /* e.g. 'Subscription.*' or 'Subscription.Created' */
    const handler     = san(req.data.handler || '', 100);  /* CF name or webhook URL */
    const description = san(req.data.description || '', 200);

    if (!serviceId || !eventPattern)
      throw new HttpsError('invalid-argument', 'serviceId and eventPattern required.');

    const subId = `${serviceId}_${eventPattern.replace(/\./g,'_').replace(/\*/g,'STAR')}`;
    await db().collection('platformSubscriptions').doc(subId).set({
      subId, serviceId, eventPattern, handler, description,
      registeredBy: req.auth.uid,
      active: true,
      registeredAt: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { success: true, subId };
  }
);

/* ================================================================
   platformGetSubscriptions
   List all registered event subscribers.
================================================================ */
const platformGetSubscriptions = onCall(
  { region: 'us-central1', timeoutSeconds: 10, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const serviceId = san(req.data.serviceId || '', 80);

    let q = db().collection('platformSubscriptions').where('active', '==', true).limit(200);
    if (serviceId) q = db().collection('platformSubscriptions')
      .where('serviceId', '==', serviceId).where('active', '==', true).limit(50);

    const snap = await q.get();
    return { subscriptions: snap.docs.map(d => ({ id: d.id, ...d.data() })), total: snap.docs.length };
  }
);

/* ================================================================
   platformReplayEvents
   Admin-only. Replays events from a correlationId or time range
   by marking them with a replay flag, triggering a re-fan-out.
================================================================ */
const platformReplayEvents = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const adminUid     = assertAdmin(req);
    const correlationId = san(req.data.correlationId || '', 64);
    const eventIds     = Array.isArray(req.data.eventIds) ? req.data.eventIds.slice(0, 10) : [];
    const reason       = san(req.data.reason || '', 200);

    if (!correlationId && !eventIds.length)
      throw new HttpsError('invalid-argument', 'correlationId or eventIds required.');

    let events = [];
    if (correlationId) {
      const snap = await db().collection('platformEvents')
        .where('correlationId', '==', correlationId).limit(50).get();
      events = snap.docs;
    } else {
      events = await Promise.all(eventIds.map(id => db().collection('platformEvents').doc(id).get()));
    }

    const batch = db().batch();
    let replayed = 0;
    for (const doc of events) {
      if (!doc.exists) continue;
      /* Write a replay copy — triggers onPlatformEventCreated again */
      const replayRef = db().collection('platformEvents').doc();
      batch.set(replayRef, {
        ...doc.data(),
        eventId:      replayRef.id,
        replayOf:     doc.id,
        replayedBy:   adminUid,
        replayReason: reason,
        fanOutStatus: 'pending',
        fanOutCount:  0,
        publishedAt:  Date.now(),
        ts:           FieldValue.serverTimestamp(),
      });
      replayed++;
    }
    await batch.commit();

    /* Audit */
    db().collection('sasosAuditLog').add({
      type: 'platform_events_replayed', adminUid, correlationId: correlationId || null,
      replayCount: replayed, reason, ts: FieldValue.serverTimestamp(), server: true,
    }).catch(() => {});

    return { success: true, replayed };
  }
);

/* ================================================================
   onPlatformEventCreated  [Firestore trigger]
   Fires whenever a new event document is created in platformEvents.
   Looks up active subscribers matching the event type pattern
   and creates fan-out tasks in platformFanOut for each subscriber.
================================================================ */
const onPlatformEventCreated = onDocumentCreated(
  'platformEvents/{eventId}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const eventType = data.type || '';
    const domain    = data.domain || '';
    const eventId   = event.params.eventId;

    /* Load subscribers matching this event type */
    const [exactSnap, wildcardSnap] = await Promise.all([
      db().collection('platformSubscriptions')
        .where('eventPattern', '==', eventType)
        .where('active', '==', true).limit(100).get(),
      db().collection('platformSubscriptions')
        .where('eventPattern', '==', `${domain}.*`)
        .where('active', '==', true).limit(100).get(),
    ]);

    const allSubs = [...exactSnap.docs, ...wildcardSnap.docs];
    if (!allSubs.length) {
      /* No subscribers — just update the status */
      await db().collection('platformEvents').doc(eventId).update({
        fanOutStatus: 'no_subscribers', fanOutCount: 0,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    /* Create fan-out tasks */
    const batch = db().batch();
    for (const sub of allSubs) {
      const s = sub.data();
      const taskRef = db().collection('platformFanOut').doc();
      batch.set(taskRef, {
        eventId,
        eventType,
        correlationId: data.correlationId,
        subscriberId:  s.subId,
        serviceId:     s.serviceId,
        handler:       s.handler || null,
        payload:       data.payload || {},
        status:        'pending',
        attempts:      0,
        maxAttempts:   3,
        createdAt:     Date.now(),
        ts:            FieldValue.serverTimestamp(),
      });
    }

    /* Update event with fan-out count */
    batch.update(db().collection('platformEvents').doc(eventId), {
      fanOutStatus: 'dispatched',
      fanOutCount:  allSubs.length,
      updatedAt:    FieldValue.serverTimestamp(),
    });

    await batch.commit();
    logger.info(`[Platform] Event ${eventId} (${eventType}) fanned out to ${allSubs.length} subscribers`);
  }
);

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  platformPublishEvent,
  platformGetEventLog,
  platformRegisterSub,
  platformGetSubscriptions,
  platformReplayEvents,
  onPlatformEventCreated,
};
