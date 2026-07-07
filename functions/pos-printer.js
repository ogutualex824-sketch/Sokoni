'use strict';

/**
 * SOKONI SmartPOS — Printer Cloud Functions v4.0
 * Backend support for Universal Printer Engine v4.0.
 *
 * CFs:
 *   posLogPrint          — Log a print job event to Firestore
 *   getPrintHistory      — Fetch a seller's print history (paginated)
 *   getPrinterConfig     — Read printer config from Firestore
 *   setPrinterConfig     — Write printer config to Firestore
 *
 * NOTE: The TCP relay CF (posPrint) lives inline in functions/index.js.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

function db () { return admin.firestore(); }

const REGION = 'us-central1';

const VALID_DOC_TYPES = new Set([
  'sale', 'receipt', 'sales_receipt',
  'refund', 'refund_receipt',
  'exchange', 'exchange_receipt',
  'kitchen', 'kitchen_ticket',
  'delivery', 'packing_slip', 'delivery_slip',
  'shipping_label', 'ship',
  'picking_slip', 'warehouse_pick',
  'label', 'inventory_label', 'barcode_label', 'qr_label',
  'queue_ticket', 'parking_ticket', 'parking',
  'booking', 'appointment', 'booking_confirmation',
  'service_confirmation', 'service_order', 'repair_ticket',
  'daily_summary', 'cash_report', 'shift_report',
  'monthly_summary', 'monthly_report',
  'test',
]);

const VALID_TRANSPORTS = new Set(['bluetooth', 'usb', 'serial', 'network', 'browser', 'unknown']);

/* ──────────────────────────────────────────────────────────────
   posLogPrint
   Called from the POS after each print job completes or fails.
   Writes to posPrintLog/{logId} and updates daily rollup.
   Input: { docType, transport, success, errorCode?, copies, paperWidth, businessId? }
─────────────────────────────────────────────────────────────── */
exports.posLogPrint = onCall({ region: REGION }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const {
    docType    = 'sale',
    transport  = 'unknown',
    success    = true,
    errorCode  = null,
    copies     = 1,
    paperWidth = '80mm',
    businessId = null,
    durationMs = null,
  } = req.data || {};

  if (!VALID_DOC_TYPES.has(docType))
    throw new HttpsError('invalid-argument', 'Unknown docType: ' + docType);
  if (!VALID_TRANSPORTS.has(transport))
    throw new HttpsError('invalid-argument', 'Unknown transport: ' + transport);
  if (typeof copies !== 'number' || copies < 1 || copies > 20)
    throw new HttpsError('invalid-argument', 'copies must be 1–20');

  const today = new Date().toISOString().slice(0, 10);

  const log = {
    uid, businessId,
    docType, transport, success,
    errorCode:  success ? null : (String(errorCode || 'UNKNOWN').slice(0, 64)),
    copies, paperWidth,
    durationMs: typeof durationMs === 'number' ? Math.min(durationMs, 300000) : null,
    day: today,
    ts:  admin.firestore.FieldValue.serverTimestamp(),
  };

  const batch = db().batch();

  /* Log entry */
  batch.set(db().collection('posPrintLog').doc(), log);

  /* Daily rollup: posPrintStats/{uid}_{day} */
  const rollupRef = db().collection('posPrintStats').doc(`${uid}_${today}`);
  batch.set(rollupRef, {
    uid, day: today,
    totalJobs:    admin.firestore.FieldValue.increment(1),
    successJobs:  admin.firestore.FieldValue.increment(success ? 1 : 0),
    failedJobs:   admin.firestore.FieldValue.increment(success ? 0 : 1),
    totalCopies:  admin.firestore.FieldValue.increment(copies),
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await batch.commit();
  return { logged: true, day: today };
});


/* ──────────────────────────────────────────────────────────────
   getPrintHistory
   Paginated print log for the authenticated seller.
   Input: { limit?, startAfterTs?, docType? }
─────────────────────────────────────────────────────────────── */
exports.getPrintHistory = onCall({ region: REGION }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const { limit = 50, startAfterTs, docType } = req.data || {};

  if (limit < 1 || limit > 200) throw new HttpsError('invalid-argument', 'limit must be 1–200');

  let q = db().collection('posPrintLog')
    .where('uid', '==', uid)
    .orderBy('ts', 'desc')
    .limit(limit);

  if (docType && VALID_DOC_TYPES.has(docType)) q = q.where('docType', '==', docType);
  if (startAfterTs) {
    const cursor = new Date(startAfterTs);
    if (!isNaN(cursor.getTime())) q = q.startAfter(admin.firestore.Timestamp.fromDate(cursor));
  }

  const snap = await q.get();
  const logs = snap.docs.map(d => ({ id: d.id, ...d.data(), ts: d.data().ts?.toDate?.()?.toISOString() }));

  /* Also return stats for the last 7 days */
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceDay = since.toISOString().slice(0, 10);
  const statsSnap = await db().collection('posPrintStats')
    .where('uid', '==', uid)
    .where('day', '>=', sinceDay)
    .orderBy('day', 'desc')
    .limit(7)
    .get();

  const stats = statsSnap.docs.map(d => d.data());

  return { logs, stats, hasMore: logs.length === limit };
});


/* ──────────────────────────────────────────────────────────────
   getPrinterConfig
   Returns the seller's stored printer configuration.
   No input required.
─────────────────────────────────────────────────────────────── */
exports.getPrinterConfig = onCall({ region: REGION }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const snap = await db().collection('posPrinterConfig').doc(uid).get();
  if (!snap.exists) return { exists: false, config: _defaultConfig() };

  const data = snap.data();
  return {
    exists: true,
    config: data.config || _defaultConfig(),
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
  };
});


/* ──────────────────────────────────────────────────────────────
   setPrinterConfig
   Persists the seller's printer configuration to Firestore.
   Input: { config: { paperWidth, autoCut, copies, logoText,
                      footer, promoMessage, returnPolicy,
                      showCommission, imageThreshold } }
─────────────────────────────────────────────────────────────── */
exports.setPrinterConfig = onCall({ region: REGION }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const raw = req.data?.config;
  if (!raw || typeof raw !== 'object')
    throw new HttpsError('invalid-argument', 'config object required');

  const VALID_WIDTHS = new Set(['58mm', '76mm', '80mm']);
  const config = _sanitiseConfig(raw, VALID_WIDTHS);

  await db().collection('posPrinterConfig').doc(uid).set({
    uid,
    config,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: false });

  return { saved: true, config };
});


/* ── Helpers ── */
function _defaultConfig () {
  return {
    paperWidth:    '80mm',
    autoCut:       true,
    copies:        1,
    logoText:      '',
    footer:        '',
    promoMessage:  '',
    returnPolicy:  '',
    showCommission: false,
    imageThreshold: 128,
  };
}

function _sanitiseConfig (raw, validWidths) {
  const out = {};
  if (validWidths.has(raw.paperWidth)) out.paperWidth = raw.paperWidth;
  if (typeof raw.autoCut === 'boolean') out.autoCut = raw.autoCut;
  if (typeof raw.copies === 'number' && raw.copies >= 1 && raw.copies <= 10) out.copies = Math.floor(raw.copies);
  if (typeof raw.logoText === 'string')     out.logoText     = raw.logoText.slice(0, 128);
  if (typeof raw.footer === 'string')       out.footer       = raw.footer.slice(0, 256);
  if (typeof raw.promoMessage === 'string') out.promoMessage = raw.promoMessage.slice(0, 256);
  if (typeof raw.returnPolicy === 'string') out.returnPolicy = raw.returnPolicy.slice(0, 256);
  if (typeof raw.showCommission === 'boolean') out.showCommission = raw.showCommission;
  if (typeof raw.imageThreshold === 'number' && raw.imageThreshold >= 50 && raw.imageThreshold <= 250)
    out.imageThreshold = Math.floor(raw.imageThreshold);
  return { ..._defaultConfig(), ...out };
}
