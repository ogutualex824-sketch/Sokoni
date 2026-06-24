/* functions/manager-auth.js — Manager Authorization Cloud Functions
 * ─────────────────────────────────────────────────────────────────
 * managerAuthNotify   : onDocumentCreated → push notification to manager's phone
 * cleanupAuthRequests : onSchedule (every 10 min) → delete expired requests
 */
'use strict';

const { onDocumentCreated }      = require('firebase-functions/v2/firestore');
const { onSchedule }             = require('firebase-functions/v2/scheduler');
const { getFirestore }           = require('firebase-admin/firestore');
const { getMessaging }           = require('firebase-admin/messaging');
const logger                     = require('firebase-functions/logger');

/* ─── Push notification to manager when a request arrives ─── */
exports.managerAuthNotify = onDocumentCreated(
  { document: 'managerAuthRequests/{reqId}', region: 'us-central1' },
  async (event) => {
    const req = event.data.data();
    if (!req || req.status !== 'pending') return;

    const db       = getFirestore();
    const reqId    = event.params.reqId;
    const opLabel  = req.operationLabel || req.operation || 'Authorization';
    const cashier  = req.cashierName || 'Cashier';
    const shopId   = req.shopId || 'unknown';

    /* Log the incoming request */
    logger.info('Manager auth request received', { reqId, operation: req.operation, managerId: req.managerId, shopId });

    /* Look up manager's FCM token from their profile document */
    let fcmToken = null;
    try {
      const mgrSnap = await db.collection('managerFCMTokens').doc(req.managerId).get();
      if (mgrSnap.exists) fcmToken = mgrSnap.data()?.token;
    } catch (e) {
      logger.warn('Could not fetch manager FCM token', { managerId: req.managerId, error: e.message });
    }

    if (!fcmToken) {
      logger.info('No FCM token for manager — notification skipped', { managerId: req.managerId });
      return;
    }

    /* Build context summary for notification body */
    const ctxParts = [];
    if (req.context?.amount)  ctxParts.push('KES ' + Number(req.context.amount).toLocaleString());
    if (req.context?.product) ctxParts.push(req.context.product);
    const ctxStr = ctxParts.join(' · ');

    const message = {
      token: fcmToken,
      notification: {
        title: `🔐 ${opLabel} — Authorization Required`,
        body: `From: ${cashier}${ctxStr ? ' · ' + ctxStr : ''}`,
      },
      data: {
        type:        'manager_auth_request',
        reqId,
        shopId,
        operation:   req.operation,
        cashierName: cashier,
        expiresAt:   String(req.expiresAt || 0),
        click_action:'manager-auth.html',
      },
      android: {
        priority:    'high',
        notification: { channelId: 'manager_auth', priority: 'max', defaultSound: true },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1, interruptionLevel: 'timeSensitive' } },
      },
      webpush: {
        notification: {
          title:  `🔐 ${opLabel}`,
          body:   `From: ${cashier}${ctxStr ? ' · ' + ctxStr : ''}`,
          icon:   '/icons/icon-192.png',
          badge:  '/icons/badge-72.png',
          requireInteraction: true,
          data:   { url: 'manager-auth.html?req=' + reqId },
        },
        fcmOptions: { link: 'manager-auth.html?req=' + reqId },
      },
    };

    try {
      const resp = await getMessaging().send(message);
      logger.info('Manager auth notification sent', { reqId, response: resp });
    } catch (e) {
      logger.error('Failed to send manager auth notification', { reqId, error: e.message });
      /* Remove stale token */
      if (e.code === 'messaging/registration-token-not-registered') {
        await db.collection('managerFCMTokens').doc(req.managerId).delete().catch(() => {});
      }
    }
  }
);

/* ─── Cleanup expired auth requests (runs every 10 minutes) ─── */
exports.cleanupAuthRequests = onSchedule(
  { schedule: 'every 10 minutes', region: 'us-central1' },
  async () => {
    const db  = getFirestore();
    const now = Date.now();

    const snap = await db.collection('managerAuthRequests')
      .where('status', '==', 'pending')
      .where('expiresAt', '<', now)
      .limit(100)
      .get();

    if (snap.empty) {
      logger.info('No expired auth requests to clean up');
      return;
    }

    const batch = db.batch();
    snap.docs.forEach(doc => {
      batch.update(doc.ref, {
        status:     'expired',
        expiredAt:  now,
      });
    });
    await batch.commit();
    logger.info(`Marked ${snap.docs.length} auth request(s) as expired`);
  }
);

/* ─── Register manager FCM token (callable, from manager-auth.html PWA) ─── */
const { onCall, HttpsError } = require('firebase-functions/v2/https');

exports.registerManagerFCMToken = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in');

    const { managerId, token } = request.data;
    if (!managerId || typeof managerId !== 'string') throw new HttpsError('invalid-argument', 'managerId required');
    if (!token || typeof token !== 'string')         throw new HttpsError('invalid-argument', 'token required');

    const db = getFirestore();
    await db.collection('managerFCMTokens').doc(managerId).set({
      token,
      uid:       request.auth.uid,
      updatedAt: Date.now(),
    });

    logger.info('Manager FCM token registered', { managerId, uid: request.auth.uid });
    return { success: true };
  }
);
