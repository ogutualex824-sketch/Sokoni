/* ================================================================
   SOKONI — Business Communication System  v1.0
   11 Cloud Functions: transaction-gated messaging, moderation,
   lifecycle management, admin controls.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated }  = require('firebase-functions/v2/firestore');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';

function _db()     { return admin.firestore(); }
function _now()    { return admin.firestore.FieldValue.serverTimestamp(); }
function _bucket() { return admin.storage().bucket(); }
function _inc(n)   { return admin.firestore.FieldValue.increment(n || 1); }
function _union(v) { return admin.firestore.FieldValue.arrayUnion(v); }

/* ── Transaction type → Firestore collection ──────────────────── */
const TX_COLLECTIONS = {
  order:                    'orders',
  service_booking:          'bookings',
  food_order:               'foodOrders',
  pharmacy_order:           'pharmacyOrders',
  property_inquiry:         'propertyInquiries',
  vehicle_inquiry:          'vehicleInquiries',
  job_application:          'jobApplications',
  freelancer_engagement:    'freelancerEngagements',
  event_booking:            'eventBookings',
  hotel_reservation:        'hotelReservations',
  financial_request:        'financialRequests',
  healthcare_appointment:   'healthcareAppointments',
  legal_consultation:       'legalConsultations',
  insurance_request:        'insuranceRequests',
  logistics_request:        'packageRequests',
  support_ticket:           'supportTickets',
  rfq:                      'rfqs',
};

/* ── Spam / fraud detection patterns ─────────────────────────── */
const SPAM_PATTERNS = [
  /\b(whatsapp|wa\.me|t\.me|telegram)\b/i,
  /\b(pay outside|pay direct|avoid fees?|bypass sokoni)\b/i,
  /\b(send money to|mpesa directly|bank transfer direct)\b/i,
  /\b(bit\.ly|tinyurl|shorturl|rebrand\.ly)\b/i,
  /(.)\1{8,}/,
  /\b(click here|free money|you (have )?won|congratulations you)\b/i,
];
function _isSpam(text) { return text && SPAM_PATTERNS.some(p => p.test(text)); }

/* ── Load retention policy ────────────────────────────────────── */
async function _getPolicy() {
  const snap = await _db().collection('chatPolicies').doc('default').get().catch(() => null);
  const data = snap?.data() || {};
  return {
    maxImageSizeMB:    data.maxImageSizeMB    ?? 10,
    maxPdfSizeMB:      data.maxPdfSizeMB      ?? 20,
    maxVoiceSeconds:   data.maxVoiceSeconds   ?? 300,
    readOnlyAfterDays: data.readOnlyAfterDays ?? 30,
    voiceRetentionDays:data.voiceRetentionDays ?? 90,
    imageRetentionDays:data.imageRetentionDays ?? 180,
    tempRetentionDays: data.tempRetentionDays  ?? 30,
    allowedMimeTypes:  data.allowedMimeTypes  ?? ['image/jpeg','image/png','image/webp','image/gif','application/pdf','audio/webm','audio/mp4','audio/mpeg','audio/ogg'],
  };
}

/* ── Helpers ──────────────────────────────────────────────────── */
function _titleFor(type, txId) {
  const label = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `${label} #${String(txId).slice(0,8).toUpperCase()}`;
}

async function _sendFcm(token, title, body, data) {
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: data || {},
      android: { priority: 'high' },
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
    });
  } catch(e) { console.warn('[messages] FCM failed', e.message); }
}

/* ═══════════════════════════════════════════════════════════════
   1. createConversation
═══════════════════════════════════════════════════════════════ */
exports.createConversation = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  const uid = req.auth.uid;
  const { transactionType, transactionId, participantUids, metadata } = req.data;

  if (!transactionType || !transactionId || !Array.isArray(participantUids) || !participantUids.length) {
    throw new HttpsError('invalid-argument', 'transactionType, transactionId, and participantUids required');
  }
  if (!participantUids.includes(uid)) {
    throw new HttpsError('permission-denied', 'Caller must be listed as a participant');
  }
  if (!TX_COLLECTIONS[transactionType]) {
    throw new HttpsError('invalid-argument', `Unknown transactionType: ${transactionType}`);
  }

  const db = _db();

  /* Idempotency — return existing conversation */
  const existing = await db.collection('conversations')
    .where('transactionType', '==', transactionType)
    .where('transactionId',   '==', transactionId)
    .limit(1).get();
  if (!existing.empty) {
    return { conversationId: existing.docs[0].id, existing: true };
  }

  /* Verify transaction exists */
  const txSnap = await db.collection(TX_COLLECTIONS[transactionType]).doc(transactionId).get().catch(() => null);
  if (!txSnap?.exists) throw new HttpsError('not-found', `Transaction ${transactionId} not found in ${TX_COLLECTIONS[transactionType]}`);

  /* Fetch participant profiles */
  const profileSnaps = await Promise.all(participantUids.map(p =>
    db.collection('users').doc(p).get().catch(() => null)
  ));
  const participantNames   = {};
  const participantAvatars = {};
  profileSnaps.forEach((snap, i) => {
    const p    = participantUids[i];
    const data = snap?.data() || {};
    participantNames[p]   = data.displayName || data.name || 'User';
    participantAvatars[p] = data.photoURL || data.avatar || null;
  });

  const convRef        = db.collection('conversations').doc();
  const conversationId = convRef.id;
  const title          = metadata?.title || _titleFor(transactionType, transactionId);
  const batch          = db.batch();

  /* Conversation doc */
  batch.set(convRef, {
    transactionType,
    transactionId,
    transactionTitle: title,
    participants:      participantUids,
    participantNames,
    participantAvatars,
    status:            'active',
    lastMessage:       null,
    lastMessageAt:     null,
    unreadCounts:      Object.fromEntries(participantUids.map(p => [p, 0])),
    metadata:          metadata || {},
    moderationFlags:   [],
    reportCount:       0,
    readOnlyAt:        null,
    createdAt:         _now(),
    updatedAt:         _now(),
  });

  /* User conversation index */
  for (const puid of participantUids) {
    const others      = participantUids.filter(p => p !== puid);
    const otherName   = others.map(o => participantNames[o]).join(', ');
    const otherAvatar = others.length === 1 ? (participantAvatars[others[0]] || null) : null;
    batch.set(db.collection('userConversations').doc(puid).collection('items').doc(conversationId), {
      conversationId,
      transactionType,
      transactionId,
      title,
      participantName:       otherName,
      participantAvatar:     otherAvatar,
      lastMessageAt:         null,
      lastMessageText:       null,
      lastMessageSenderId:   null,
      unreadCount:           0,
      status:                'active',
      createdAt:             _now(),
      updatedAt:             _now(),
    });
  }

  await batch.commit();
  logger.info('[messages] Conversation created', { conversationId, transactionType, transactionId });
  return { conversationId, existing: false };
});

/* ═══════════════════════════════════════════════════════════════
   2. markRead
═══════════════════════════════════════════════════════════════ */
exports.markRead = onCall({ region: REGION, timeoutSeconds: 15 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  const uid  = req.auth.uid;
  const { conversationId } = req.data;
  if (!conversationId) throw new HttpsError('invalid-argument', 'conversationId required');

  const db       = _db();
  const convSnap = await db.collection('conversations').doc(conversationId).get();
  if (!convSnap.exists) throw new HttpsError('not-found', 'Conversation not found');
  if (!convSnap.data().participants.includes(uid)) throw new HttpsError('permission-denied', 'Not a participant');

  const batch = db.batch();
  batch.update(convSnap.ref, { [`unreadCounts.${uid}`]: 0, updatedAt: _now() });
  batch.update(
    db.collection('userConversations').doc(uid).collection('items').doc(conversationId),
    { unreadCount: 0 }
  );

  /* Mark messages from others as read (simple orderBy — no composite index needed) */
  const unreadSnap = await db.collection('conversations').doc(conversationId)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(50).get();
  unreadSnap.docs
    .filter(d => d.data().senderId !== uid && d.data().status !== 'read')
    .forEach(d => batch.update(d.ref, { status: 'read' }));

  await batch.commit();
  return { marked: unreadSnap.size };
});

/* ═══════════════════════════════════════════════════════════════
   3. reportConversation
═══════════════════════════════════════════════════════════════ */
exports.reportConversation = onCall({ region: REGION, timeoutSeconds: 15 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  const uid = req.auth.uid;
  const { conversationId, reason, details } = req.data;
  if (!conversationId || !reason) throw new HttpsError('invalid-argument', 'conversationId and reason required');

  const db       = _db();
  const convSnap = await db.collection('conversations').doc(conversationId).get();
  if (!convSnap.exists) throw new HttpsError('not-found', 'Conversation not found');
  if (!convSnap.data().participants.includes(uid)) throw new HttpsError('permission-denied', 'Not a participant');

  const batch = db.batch();
  batch.set(db.collection('moderationQueue').doc(), {
    conversationId, messageId: null,
    reportedBy: uid, reason,
    details: details || null,
    status: 'pending',
    createdAt: _now(),
    reviewedBy: null, reviewedAt: null, action: null,
  });
  batch.update(convSnap.ref, { reportCount: _inc(), updatedAt: _now() });
  await batch.commit();
  return { reported: true };
});

/* ═══════════════════════════════════════════════════════════════
   4. adminGetReports
═══════════════════════════════════════════════════════════════ */
exports.adminGetReports = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  if (!req.auth?.token?.isAdmin) throw new HttpsError('permission-denied', 'Admin only');
  const { status = 'pending', cursor } = req.data || {};
  let q = _db().collection('moderationQueue')
    .where('status', '==', status)
    .orderBy('createdAt', 'desc')
    .limit(20);
  if (cursor) q = q.startAfter(cursor);
  const snap = await q.get();
  return { reports: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ═══════════════════════════════════════════════════════════════
   5. adminReviewReport
═══════════════════════════════════════════════════════════════ */
exports.adminReviewReport = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  if (!req.auth?.token?.isAdmin) throw new HttpsError('permission-denied', 'Admin only');
  const { reportId, action, note } = req.data;
  if (!reportId || !action) throw new HttpsError('invalid-argument', 'reportId and action required');

  const db         = _db();
  const reportSnap = await db.collection('moderationQueue').doc(reportId).get();
  if (!reportSnap.exists) throw new HttpsError('not-found', 'Report not found');
  const report = reportSnap.data();

  const batch = db.batch();
  batch.update(reportSnap.ref, {
    status:     'reviewed',
    action,
    reviewNote: note || null,
    reviewedBy: req.auth.uid,
    reviewedAt: _now(),
  });

  if (action === 'suspend') {
    batch.update(db.collection('conversations').doc(report.conversationId), {
      status:      'suspended',
      suspendedAt: _now(),
      suspendedBy: req.auth.uid,
      updatedAt:   _now(),
    });
  } else if (action === 'warn') {
    const msgRef = db.collection('conversations').doc(report.conversationId).collection('messages').doc();
    batch.set(msgRef, {
      senderId:   'system',
      senderName: 'SOKONI',
      timestamp:  _now(),
      type:       'system',
      text:       'This conversation has been reviewed. Please ensure all communication complies with SOKONI policies.',
      status:     'delivered',
      deleted:    false,
      edited:     false,
      flagged:    false,
    });
  }

  await batch.commit();
  return { reviewed: true };
});

/* ═══════════════════════════════════════════════════════════════
   6. adminUpdateChatPolicy
═══════════════════════════════════════════════════════════════ */
exports.adminUpdateChatPolicy = onCall({ region: REGION, timeoutSeconds: 15 }, async (req) => {
  if (!req.auth?.token?.isAdmin) throw new HttpsError('permission-denied', 'Admin only');
  const allowed  = ['maxImageSizeMB','maxPdfSizeMB','maxVoiceSeconds','readOnlyAfterDays','voiceRetentionDays','imageRetentionDays','tempRetentionDays','allowedMimeTypes'];
  const filtered = Object.fromEntries(Object.entries(req.data || {}).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(filtered).length) throw new HttpsError('invalid-argument', 'No valid policy fields provided');
  await _db().collection('chatPolicies').doc('default').set(filtered, { merge: true });
  return { updated: true };
});

/* ═══════════════════════════════════════════════════════════════
   7. adminGetChatStats
═══════════════════════════════════════════════════════════════ */
exports.adminGetChatStats = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  if (!req.auth?.token?.isAdmin) throw new HttpsError('permission-denied', 'Admin only');
  const db = _db();
  const [active, pending, flagged] = await Promise.all([
    db.collection('conversations').where('status', '==', 'active').count().get(),
    db.collection('moderationQueue').where('status', '==', 'pending').count().get(),
    db.collection('conversations').where('reportCount', '>', 0).count().get(),
  ]);
  return {
    activeConversations: active.data().count,
    pendingReports:      pending.data().count,
    flaggedConversations: flagged.data().count,
  };
});

/* ═══════════════════════════════════════════════════════════════
   8. onMessageCreated — update index + push notifications
═══════════════════════════════════════════════════════════════ */
exports.onMessageCreated = onDocumentCreated(
  { document: 'conversations/{convId}/messages/{msgId}', region: REGION, timeoutSeconds: 30 },
  async (event) => {
    const msg = event.data?.data();
    if (!msg || msg.senderId === 'system') return null;

    const db      = _db();
    const convId  = event.params.convId;
    const msgId   = event.params.msgId;
    const convRef = db.collection('conversations').doc(convId);
    const convSnap = await convRef.get();
    if (!convSnap.exists) return null;
    const conv = convSnap.data();

    const preview = msg.type === 'text'
      ? (msg.text || '').slice(0, 100)
      : msg.type === 'image' ? '[Image]'
      : msg.type === 'pdf'   ? `[Document] ${msg.fileName || ''}`
      : msg.type === 'voice' ? '[Voice note]'
      : `[${msg.type}]`;

    const others = conv.participants.filter(p => p !== msg.senderId);
    const batch  = db.batch();

    /* Update conversation summary */
    const unreadIncrement = {};
    others.forEach(p => { unreadIncrement[`unreadCounts.${p}`] = _inc(); });
    batch.update(convRef, {
      lastMessage: { text: preview, senderId: msg.senderId, timestamp: msg.timestamp, type: msg.type },
      lastMessageAt: msg.timestamp,
      ...unreadIncrement,
      updatedAt: _now(),
    });

    /* Update each participant's conversation index */
    for (const puid of conv.participants) {
      const isSender  = puid === msg.senderId;
      const itemRef   = db.collection('userConversations').doc(puid).collection('items').doc(convId);
      const itemUpdate = {
        lastMessageAt:       msg.timestamp,
        lastMessageText:     preview,
        lastMessageSenderId: msg.senderId,
        updatedAt:           _now(),
      };
      if (!isSender) itemUpdate.unreadCount = _inc();
      batch.update(itemRef, itemUpdate);
    }

    await batch.commit();

    /* Send FCM to non-senders */
    const senderName = conv.participantNames?.[msg.senderId] || 'New message';
    for (const puid of others) {
      const tokenSnap = await db.collection('users').doc(puid).get().catch(() => null);
      const token = tokenSnap?.data()?.fcmToken;
      await _sendFcm(token, senderName, preview, {
        type:            'new_message',
        conversationId:  convId,
        messageId:       msgId,
        transactionType: conv.transactionType || '',
        transactionId:   conv.transactionId   || '',
      });
    }

    logger.info('[messages] Conversation index updated', { convId, msgId });
    return null;
  }
);

/* ═══════════════════════════════════════════════════════════════
   9. moderateMessage — spam / fraud detection
═══════════════════════════════════════════════════════════════ */
exports.moderateMessage = onDocumentCreated(
  { document: 'conversations/{convId}/messages/{msgId}', region: REGION, timeoutSeconds: 15 },
  async (event) => {
    const msg = event.data?.data();
    if (!msg || msg.type !== 'text' || !msg.text) return null;
    if (!_isSpam(msg.text)) return null;

    const db    = _db();
    const batch = db.batch();
    batch.update(event.data.ref, { flagged: true, flaggedAt: _now() });
    batch.update(db.collection('conversations').doc(event.params.convId), {
      moderationFlags: _union('spam'),
      updatedAt:       _now(),
    });
    batch.set(db.collection('moderationQueue').doc(), {
      conversationId: event.params.convId,
      messageId:      event.params.msgId,
      reportedBy:     'system',
      reason:         'auto_spam_detection',
      details:        `Flagged: "${msg.text.slice(0, 120)}"`,
      status:         'pending',
      createdAt:      _now(),
      reviewedBy:     null, reviewedAt: null, action: null,
    });
    await batch.commit();
    logger.warn('[messages] Message flagged', { convId: event.params.convId, msgId: event.params.msgId });
    return null;
  }
);

/* ═══════════════════════════════════════════════════════════════
   10. archiveCompletedConversations — scheduled daily
═══════════════════════════════════════════════════════════════ */
exports.archiveCompletedConversations = onSchedule(
  { schedule: 'every 24 hours', region: REGION, timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const policy = await _getPolicy();
    const cutoff = new Date(Date.now() - policy.readOnlyAfterDays * 86400000);
    const db     = _db();
    /* Single equality filter — no composite index; date filter in memory */
    const snap   = await db.collection('conversations')
      .where('status', '==', 'active')
      .limit(200).get();
    if (snap.empty) return;
    const toArchive = snap.docs.filter(doc => {
      const ts = doc.data().lastMessageAt;
      return ts && ts.toMillis() <= cutoff.getTime();
    });
    if (!toArchive.length) return;
    const batch = db.batch();
    toArchive.forEach(doc => batch.update(doc.ref, {
      status:     'read_only',
      readOnlyAt: _now(),
      updatedAt:  _now(),
    }));
    await batch.commit();
    logger.info('[messages] Archived conversations', { count: toArchive.length });
  }
);

/* ═══════════════════════════════════════════════════════════════
   11. cleanupChatStorage — scheduled weekly
═══════════════════════════════════════════════════════════════ */
exports.cleanupChatStorage = onSchedule(
  { schedule: 'every 168 hours', region: REGION, timeoutSeconds: 540, memory: '256MiB' },
  async () => {
    const policy  = await _getPolicy();
    const bucket  = _bucket();
    const db      = _db();
    const cutoffs = {
      voice: new Date(Date.now() - policy.voiceRetentionDays  * 86400000),
      image: new Date(Date.now() - policy.imageRetentionDays  * 86400000),
      temp:  new Date(Date.now() - policy.tempRetentionDays   * 86400000),
    };

    for (const [mediaType, cutoff] of Object.entries(cutoffs)) {
      const snap = await db.collectionGroup('messages')
        .where('mediaType',  '==', mediaType)
        .where('timestamp',  '<=', cutoff)
        .where('storageRef', '!=', null)
        .limit(200).get();

      for (const doc of snap.docs) {
        const data = doc.data();
        try {
          if (data.storageRef)   await bucket.file(data.storageRef).delete().catch(() => {});
          if (data.thumbnailRef) await bucket.file(data.thumbnailRef).delete().catch(() => {});
          await doc.ref.update({ storageRef: null, thumbnailRef: null, storageExpired: true });
        } catch(e) { console.warn('[messages] Storage cleanup error', e.message); }
      }
      logger.info('[messages] Cleaned media', { type: mediaType, count: snap.size });
    }
  }
);
