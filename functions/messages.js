/* ================================================================
   SOKONI — Business Communication System  v2.0
   15 Cloud Functions: transaction-gated messaging, context fetching,
   search, edit, status sync, moderation, lifecycle, admin controls.
================================================================ */
'use strict';

const { onCall, HttpsError }   = require('firebase-functions/v2/https');
const { onDocumentCreated,
        onDocumentUpdated }    = require('firebase-functions/v2/firestore');
const { onSchedule }           = require('firebase-functions/v2/scheduler');
const logger                   = require('firebase-functions/logger');
const admin                    = require('firebase-admin');

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

  /* Deterministic ID prevents duplicate docs for the same transaction.
     Legacy random-ID conversations remain unaffected. */
  const conversationId = `${transactionType}_${transactionId}`;
  const convRef        = db.collection('conversations').doc(conversationId);

  /* Fast path: already exists */
  const existingSnap = await convRef.get();
  if (existingSnap.exists) {
    return { conversationId, existing: true };
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

  const title = metadata?.title || _titleFor(transactionType, transactionId);

  /* Atomic create — transaction reads convRef inside; concurrent calls are serialised. */
  let isNew = false;
  await db.runTransaction(async (t) => {
    const snap = await t.get(convRef);
    if (snap.exists) { return; } /* Race lost — another concurrent call won */
    isNew = true;

    t.set(convRef, {
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

    /* User conversation index (inside transaction — consistent with conv doc) */
    for (const puid of participantUids) {
      const others      = participantUids.filter(p => p !== puid);
      const otherName   = others.map(o => participantNames[o]).join(', ');
      const otherAvatar = others.length === 1 ? (participantAvatars[others[0]] || null) : null;
      t.set(db.collection('userConversations').doc(puid).collection('items').doc(conversationId), {
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
  });

  if (isNew) logger.info('[messages] Conversation created', { conversationId, transactionType, transactionId });
  return { conversationId, existing: !isNew };
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
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new HttpsError('permission-denied', 'Admin only');
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
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new HttpsError('permission-denied', 'Admin only');
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
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new HttpsError('permission-denied', 'Admin only');
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
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new HttpsError('permission-denied', 'Admin only');
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

    /* Send FCM to non-senders — batch all user reads then fire pushes in parallel */
    const senderName = conv.participantNames?.[msg.senderId] || 'New message';
    const tokenSnaps = await Promise.all(
      others.map(puid => db.collection('users').doc(puid).get().catch(() => null))
    );
    await Promise.all(
      tokenSnaps.map((tokenSnap) => {
        const token = tokenSnap?.data()?.fcmToken;
        return _sendFcm(token, senderName, preview, {
          type:            'new_message',
          conversationId:  convId,
          messageId:       msgId,
          transactionType: conv.transactionType || '',
          transactionId:   conv.transactionId   || '',
        });
      })
    );

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


/* ═══════════════════════════════════════════════════════════════
   12. getConversationContext
   Reads the source transaction document and returns normalised
   context fields for the chat header (title, status, key metadata).
═══════════════════════════════════════════════════════════════ */
exports.getConversationContext = onCall({ region: REGION, timeoutSeconds: 20 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  const uid = req.auth.uid;
  const { conversationId } = req.data;
  if (!conversationId) throw new HttpsError('invalid-argument', 'conversationId required');

  const db       = _db();
  const convSnap = await db.collection('conversations').doc(conversationId).get();
  if (!convSnap.exists) throw new HttpsError('not-found', 'Conversation not found');
  const conv = convSnap.data();
  if (!conv.participants.includes(uid)) throw new HttpsError('permission-denied', 'Not a participant');

  const col = TX_COLLECTIONS[conv.transactionType];
  if (!col || !conv.transactionId) return { context: conv.metadata || {} };

  const txSnap = await db.collection(col).doc(conv.transactionId).get().catch(() => null);
  if (!txSnap?.exists) return { context: conv.metadata || {} };

  const tx = txSnap.data();

  /* Normalise common fields across all transaction types */
  const ctx = {
    status:        tx.status       || tx.orderStatus   || tx.bookingStatus || 'unknown',
    amount:        tx.amount       || tx.totalAmount    || tx.price         || tx.budget || null,
    currency:      tx.currency     || 'KES',
    reference:     tx.orderNumber  || tx.bookingNumber  || tx.ticketNumber  || conv.transactionId,
    title:         tx.title        || tx.productName    || tx.jobTitle       || tx.serviceName  || tx.propertyTitle || null,
    scheduledDate: tx.scheduledDate|| tx.appointmentDate|| tx.checkIn        || tx.eventDate     || null,
    buyerName:     tx.buyerName    || tx.customerName   || null,
    sellerName:    tx.sellerName   || tx.providerName   || tx.vendorName     || null,
    location:      tx.location     || tx.venue          || tx.address        || null,
    notes:         tx.notes        || tx.instructions   || null,
  };

  /* Merge in conversation metadata (set at creation) */
  Object.assign(ctx, conv.metadata || {});
  return { context: ctx };
});

/* ═══════════════════════════════════════════════════════════════
   13. searchConversations
   Searches a user's conversation index by title / participant name.
   Full-text search delegates to Firestore prefix match on title.
═══════════════════════════════════════════════════════════════ */
exports.searchConversations = onCall({ region: REGION, timeoutSeconds: 20 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  const uid   = req.auth.uid;
  const { query = '', transactionType, cursor } = req.data || {};

  const db    = _db();
  let   q     = db.collection('userConversations').doc(uid).collection('items')
                  .orderBy('lastMessageAt', 'desc')
                  .limit(30);
  if (transactionType) q = q.where('transactionType', '==', transactionType);
  if (cursor) q = q.startAfter(cursor);

  const snap  = await q.get();
  const term  = query.toLowerCase().trim();
  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(item => !term || [item.title, item.participantName, item.lastMessageText]
      .some(v => v && v.toLowerCase().includes(term))
    );

  return { items, hasMore: snap.size === 30 };
});

/* ═══════════════════════════════════════════════════════════════
   14. editMessage
   Allows a sender to edit their own text message within 15 minutes.
═══════════════════════════════════════════════════════════════ */
exports.editMessage = onCall({ region: REGION, timeoutSeconds: 15 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  const uid = req.auth.uid;
  const { conversationId, messageId, newText } = req.data;
  if (!conversationId || !messageId || !newText?.trim()) {
    throw new HttpsError('invalid-argument', 'conversationId, messageId, newText required');
  }

  const db     = _db();
  const msgRef = db.collection('conversations').doc(conversationId)
                   .collection('messages').doc(messageId);
  const snap   = await msgRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Message not found');

  const msg = snap.data();
  if (msg.senderId !== uid)       throw new HttpsError('permission-denied', 'Cannot edit another user\'s message');
  if (msg.type !== 'text')        throw new HttpsError('invalid-argument', 'Only text messages can be edited');
  if (msg.deleted)                throw new HttpsError('failed-precondition', 'Cannot edit a deleted message');

  const ageMs = msg.timestamp?.toMillis ? (Date.now() - msg.timestamp.toMillis()) : Infinity;
  if (ageMs > 15 * 60 * 1000)    throw new HttpsError('failed-precondition', 'Messages can only be edited within 15 minutes');

  await msgRef.update({
    text:     newText.trim().slice(0, 4000),
    edited:   true,
    editedAt: _now(),
  });
  return { edited: true };
});

/* ── Allowlist for updateConversationStatus — mirrors STATUS_MSGS keys ── */
const VALID_STATUSES = new Set([
  'pending','confirmed','processing','ready','shipped','out_for_delivery','delivered',
  'cancelled','refunded','disputed','completed','accepted','en_route','in_progress',
  'awaiting_provider','awaiting_pickup','closed',
]);

/* ═══════════════════════════════════════════════════════════════
   15. updateConversationStatus
   Called by order / booking Cloud Functions when a transaction
   status changes. Posts a system message and updates conversation.
═══════════════════════════════════════════════════════════════ */
exports.updateConversationStatus = onCall({ region: REGION, timeoutSeconds: 20 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  const { conversationId, newStatus, systemMessage } = req.data;
  if (!conversationId || !newStatus) {
    throw new HttpsError('invalid-argument', 'conversationId and newStatus required');
  }

  /* MSG-3: validate status against known allowlist */
  if (!VALID_STATUSES.has(String(newStatus))) {
    throw new HttpsError('invalid-argument', `Invalid status '${String(newStatus)}'`);
  }

  /* MSG-3: system message injection is admin-only to prevent participant forgery */
  const callerIsAdmin = req.auth.token?.admin === true || req.auth.token?.superAdmin === true;
  if (systemMessage && !callerIsAdmin) {
    throw new HttpsError('permission-denied', 'Only admins may post system messages');
  }

  const db       = _db();
  const convSnap = await db.collection('conversations').doc(conversationId).get();
  if (!convSnap.exists) throw new HttpsError('not-found', 'Conversation not found');
  if (!convSnap.data().participants.includes(req.auth.uid)) {
    throw new HttpsError('permission-denied', 'Not a participant');
  }

  const batch = db.batch();
  batch.update(convSnap.ref, { transactionStatus: newStatus, updatedAt: _now() });

  if (systemMessage) {
    const msgRef = convSnap.ref.collection('messages').doc();
    batch.set(msgRef, {
      senderId:   'system',
      senderName: 'SOKONI',
      timestamp:  _now(),
      type:       'system',
      text:       systemMessage,
      status:     'delivered',
      deleted:    false,
      edited:     false,
      flagged:    false,
    });
  }

  await batch.commit();
  return { updated: true };
});

/* ── Shared status-message text ──────────────────────────────────── */
const STATUS_MSGS = {
  pending:            'Order received — awaiting confirmation.',
  confirmed:          'Your order has been confirmed.',
  processing:         'Order is being prepared.',
  ready:              'Your order is ready for collection.',
  shipped:            'Your order has been shipped.',
  out_for_delivery:   'Your order is out for delivery.',
  delivered:          'Your order has been delivered.',
  cancelled:          'This order has been cancelled.',
  refunded:           'A refund has been processed.',
  disputed:           'A dispute has been opened. Our team will review.',
  completed:          'Transaction complete.',
  accepted:           'Your booking has been accepted.',
  en_route:           'Your provider is on the way.',
  in_progress:        'Service is now in progress.',
  awaiting_provider:  'Awaiting provider confirmation.',
  awaiting_pickup:    'Package is ready for pickup.',
  closed:             'This conversation has been closed.',
};

/* ═══════════════════════════════════════════════════════════════
   CF. sendMessage  (MSG-1 fix)
   Replaces direct Firestore client writes. Hard-codes senderId to
   req.auth.uid and server-resolves senderName so neither can be
   spoofed. For file messages, clients upload to chatAttachments/
   in Storage first, then pass the storageRef here.
═══════════════════════════════════════════════════════════════ */
const _ALLOWED_MSG_TYPES = new Set(['text','image','video','voice','audio','file','location']);

exports.sendMessage = onCall(
  { region: REGION, timeoutSeconds: 30, enforceAppCheck: true },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');

    const {
      conversationId, type = 'text',
      text, storageRef, thumbnailRef, fileName, fileSize, mimeType, duration,
      lat, lng, address,
      replyToId, replyToText, replyToSenderId,
    } = req.data || {};

    if (!conversationId || typeof conversationId !== 'string') {
      throw new HttpsError('invalid-argument', 'conversationId (string) is required');
    }
    if (!_ALLOWED_MSG_TYPES.has(type)) {
      throw new HttpsError('invalid-argument', `type must be one of: ${[..._ALLOWED_MSG_TYPES].join(', ')}`);
    }

    if (type === 'text') {
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        throw new HttpsError('invalid-argument', 'text is required for text messages');
      }
      if (text.length > 4000) throw new HttpsError('invalid-argument', 'text must be ≤ 4000 characters');
    } else if (type === 'location') {
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        throw new HttpsError('invalid-argument', 'lat and lng (numbers) are required for location messages');
      }
    } else {
      if (!storageRef || typeof storageRef !== 'string') {
        throw new HttpsError('invalid-argument', 'storageRef is required for file messages');
      }
      /* Verify storageRef is under caller's chatAttachments directory */
      if (!storageRef.startsWith(`chatAttachments/${req.auth.uid}/`)) {
        throw new HttpsError('permission-denied', 'storageRef must be owned by the caller');
      }
    }

    const db       = _db();
    const convRef  = db.collection('conversations').doc(String(conversationId));
    const convSnap = await convRef.get();
    if (!convSnap.exists) throw new HttpsError('not-found', 'Conversation not found');

    const conv = convSnap.data();
    if (!Array.isArray(conv.participants) || !conv.participants.includes(req.auth.uid)) {
      throw new HttpsError('permission-denied', 'Not a participant in this conversation');
    }
    if (['closed', 'suspended', 'read_only'].includes(conv.status)) {
      throw new HttpsError('failed-precondition', `Conversation is ${conv.status}`);
    }

    /* Server-resolve senderName so it cannot be forged by the client */
    const userSnap   = await db.collection('users').doc(req.auth.uid).get();
    const ud         = userSnap.exists ? userSnap.data() : {};
    const senderName = String(ud.displayName || ud.name || ud.email || 'User').slice(0, 100);

    const msgRef = convRef.collection('messages').doc();
    const now    = _now();

    const msgData = {
      senderId:   req.auth.uid,  // hard-coded — cannot be spoofed
      senderName,                 // server-resolved — cannot be spoofed
      timestamp:  now,
      type,
      status:     'sent',
      deleted:    false,
      edited:     false,
      flagged:    false,
    };

    if (replyToId)       msgData.replyToId       = String(replyToId).slice(0, 128);
    if (replyToText)     msgData.replyToText     = String(replyToText).slice(0, 100);
    if (replyToSenderId) msgData.replyToSenderId = String(replyToSenderId).slice(0, 128);

    if (type === 'text') {
      msgData.text = text.trim().slice(0, 4000);
    } else if (type === 'location') {
      msgData.lat     = Number(lat);
      msgData.lng     = Number(lng);
      msgData.address = address ? String(address).slice(0, 300) : null;
    } else {
      msgData.storageRef   = String(storageRef).slice(0, 500);
      msgData.thumbnailRef = thumbnailRef ? String(thumbnailRef).slice(0, 500) : null;
      msgData.fileName     = fileName  ? String(fileName).slice(0, 255)  : null;
      msgData.fileSize     = fileSize  ? Number(fileSize)                 : null;
      msgData.mimeType     = mimeType  ? String(mimeType).slice(0, 100)  : null;
      msgData.mediaType    = type;
      if (type === 'voice') msgData.duration = duration ? Number(duration) : 0;
    }

    const batch = db.batch();
    batch.set(msgRef, msgData);
    batch.update(convRef, {
      lastMessage:   type === 'text' ? (msgData.text || '') : `📎 ${type}`,
      lastMessageAt: now,
      lastSenderId:  req.auth.uid,
      unread:        _inc(1),
      updatedAt:     now,
    });
    await batch.commit();

    return { messageId: msgRef.id };
  }
);

async function _postStatusMessage(db, transactionType, transactionId, newStatus) {
  const snap = await db.collection('conversations')
    .where('transactionType', '==', transactionType)
    .where('transactionId',   '==', transactionId)
    .limit(1).get().catch(() => null);
  if (!snap || snap.empty) return null;
  const convRef = snap.docs[0].ref;
  const text    = STATUS_MSGS[String(newStatus).toLowerCase()] ||
    `Status updated to: ${String(newStatus).replace(/_/g, ' ')}`;
  const batch   = db.batch();
  batch.set(convRef.collection('messages').doc(), {
    senderId:   'system',
    senderName: 'SOKONI',
    timestamp:  _now(),
    type:       'system',
    text,
    status:     'delivered',
    deleted:    false,
    edited:     false,
    flagged:    false,
  });
  batch.update(convRef, { transactionStatus: newStatus, updatedAt: _now() });
  await batch.commit();
  return snap.docs[0].id;
}

/* ═══════════════════════════════════════════════════════════════
   16. onOrderStatusChanged
   Posts a system message whenever an order's status changes.
═══════════════════════════════════════════════════════════════ */
exports.onOrderStatusChanged = onDocumentUpdated(
  { document: 'orders/{orderId}', region: REGION, timeoutSeconds: 30 },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return null;
    const oldS = before.status || before.orderStatus;
    const newS = after.status  || after.orderStatus;
    if (!newS || oldS === newS) return null;
    await _postStatusMessage(_db(), 'order', event.params.orderId, newS)
      .catch(e => logger.warn('[messages] onOrderStatusChanged', { error: e.message }));
    return null;
  }
);

/* ═══════════════════════════════════════════════════════════════
   17. onBookingStatusChanged
   Posts a system message whenever a service booking status changes.
═══════════════════════════════════════════════════════════════ */
exports.onBookingStatusChanged = onDocumentUpdated(
  { document: 'bookings/{bookingId}', region: REGION, timeoutSeconds: 30 },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return null;
    const oldS = before.status || before.bookingStatus;
    const newS = after.status  || after.bookingStatus;
    if (!newS || oldS === newS) return null;
    await _postStatusMessage(_db(), 'service_booking', event.params.bookingId, newS)
      .catch(e => logger.warn('[messages] onBookingStatusChanged', { error: e.message }));
    return null;
  }
);

/* ═══════════════════════════════════════════════════════════════
   18. onFoodOrderStatusChanged
   Posts a system message whenever a food order status changes.
═══════════════════════════════════════════════════════════════ */
exports.onFoodOrderStatusChanged = onDocumentUpdated(
  { document: 'foodOrders/{orderId}', region: REGION, timeoutSeconds: 30 },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return null;
    if (before.status === after.status) return null;
    await _postStatusMessage(_db(), 'food_order', event.params.orderId, after.status)
      .catch(e => logger.warn('[messages] onFoodOrderStatusChanged', { error: e.message }));
    return null;
  }
);
