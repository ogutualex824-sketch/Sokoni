'use strict';

const _ac = require('./admin-claim');
/**
 * SOKONI SmartPOS — Printer Cloud Functions v5.0
 * Backend for Universal Printer Engine v5.0.
 *
 * CFs:
 *   posLogPrint          — Log a print job event + daily rollup
 *   getPrintHistory      — Seller's paginated print log + 7-day stats
 *   getPrinterConfig     — Read printer config from Firestore
 *   setPrinterConfig     — Write printer config to Firestore
 *   posGetPrintStats     — Admin: aggregate stats across all sellers
 *   posGetPrintTemplate  — Get a saved receipt template (admin or own)
 *   posSavePrintTemplate — Save a receipt template (admin or own)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

function db () { return admin.firestore(); }

const CF = { region: 'us-central1', enforceAppCheck: true };

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
  'booking', 'appointment', 'booking_confirmation', 'appointment_ticket',
  'service_confirmation', 'service_order', 'repair_ticket',
  'daily_summary', 'cash_report', 'shift_report',
  'monthly_summary', 'monthly_report',
  'invoice',
  'custom',
  'test',
]);

const VALID_TRANSPORTS = new Set(['bluetooth', 'usb', 'serial', 'network', 'browser', 'unknown']);
const VALID_WIDTHS     = new Set(['58mm', '76mm', '80mm']);

/* ──────────────────────────────────────────────────────────────
   posLogPrint
   Log a print job event; update daily rollup counter.
   Input: { docType, transport, success, errorCode?, copies,
            paperWidth, businessId?, durationMs? }
─────────────────────────────────────────────────────────────── */
exports.posLogPrint = onCall(CF, async (req) => {
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
    durationMs: typeof durationMs === 'number' ? Math.min(durationMs, 300_000) : null,
    day: today,
    ts:  admin.firestore.FieldValue.serverTimestamp(),
  };

  const batch = db().batch();

  batch.set(db().collection('posPrintLog').doc(), log);

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
   Paginated print log + 7-day rollup stats for the seller.
   Input: { limit?, startAfterTs?, docType? }
─────────────────────────────────────────────────────────────── */
exports.getPrintHistory = onCall(CF, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const { limit = 50, startAfterTs, docType } = req.data || {};
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  let q = db().collection('posPrintLog')
    .where('uid', '==', uid)
    .orderBy('ts', 'desc')
    .limit(safeLimit);

  if (docType && VALID_DOC_TYPES.has(docType)) q = q.where('docType', '==', docType);
  if (startAfterTs) {
    const cursor = new Date(startAfterTs);
    if (!isNaN(cursor.getTime())) q = q.startAfter(admin.firestore.Timestamp.fromDate(cursor));
  }

  const [logSnap, statsSnap] = await Promise.all([
    q.get(),
    db().collection('posPrintStats')
      .where('uid', '==', uid)
      .where('day', '>=', new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10))
      .orderBy('day', 'desc')
      .limit(7)
      .get(),
  ]);

  return {
    logs:    logSnap.docs.map(d => ({ id: d.id, ...d.data(), ts: d.data().ts?.toDate?.()?.toISOString() })),
    stats:   statsSnap.docs.map(d => d.data()),
    hasMore: logSnap.size === safeLimit,
  };
});


/* ──────────────────────────────────────────────────────────────
   getPrinterConfig
   Returns the seller's stored printer configuration.
─────────────────────────────────────────────────────────────── */
exports.getPrinterConfig = onCall(CF, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const snap = await db().collection('posPrinterConfig').doc(uid).get();
  if (!snap.exists) return { exists: false, config: _defaultConfig() };

  const data = snap.data();
  return {
    exists: true,
    config: { ..._defaultConfig(), ...(data.config || {}) },
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
  };
});


/* ──────────────────────────────────────────────────────────────
   setPrinterConfig
   Persists the seller's printer configuration to Firestore.
   Input: { config: { paperWidth, autoCut, copies, logoText,
            logoUrl, footer, promoMessage, returnPolicy,
            showCommission, showPreview, autoPrintAfterPayment,
            encoding, printDensity, imageThreshold } }
─────────────────────────────────────────────────────────────── */
exports.setPrinterConfig = onCall(CF, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const raw = req.data?.config;
  if (!raw || typeof raw !== 'object')
    throw new HttpsError('invalid-argument', 'config object required');

  const config = _sanitiseConfig(raw);

  await db().collection('posPrinterConfig').doc(uid).set(
    { uid, config, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: false }
  );

  return { saved: true, config };
});


/* ──────────────────────────────────────────────────────────────
   posGetPrintStats
   Admin: aggregate print stats across all sellers for a date range.
   Input: { startDay, endDay }
─────────────────────────────────────────────────────────────── */
exports.posGetPrintStats = onCall(CF, async (req) => {
  if (!_ac.isAdmin(req))
    throw new HttpsError('permission-denied', 'Admin access required');

  const { startDay, endDay } = req.data || {};
  if (!startDay || !endDay)
    throw new HttpsError('invalid-argument', 'startDay and endDay required (YYYY-MM-DD)');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay) || !/^\d{4}-\d{2}-\d{2}$/.test(endDay))
    throw new HttpsError('invalid-argument', 'Invalid date format — use YYYY-MM-DD');

  const snap = await db().collection('posPrintStats')
    .where('day', '>=', startDay)
    .where('day', '<=', endDay)
    .orderBy('day', 'desc')
    .limit(500)
    .get();

  /* Aggregate across all sellers */
  let totalJobs = 0, successJobs = 0, failedJobs = 0, totalCopies = 0;
  const byDay = {};
  const bySeller = {};

  for (const doc of snap.docs) {
    const d = doc.data();
    totalJobs   += d.totalJobs   || 0;
    successJobs += d.successJobs || 0;
    failedJobs  += d.failedJobs  || 0;
    totalCopies += d.totalCopies || 0;

    byDay[d.day] = byDay[d.day] || { day: d.day, totalJobs: 0, successJobs: 0, failedJobs: 0 };
    byDay[d.day].totalJobs   += d.totalJobs   || 0;
    byDay[d.day].successJobs += d.successJobs || 0;
    byDay[d.day].failedJobs  += d.failedJobs  || 0;

    bySeller[d.uid] = bySeller[d.uid] || { uid: d.uid, totalJobs: 0 };
    bySeller[d.uid].totalJobs += d.totalJobs || 0;
  }

  return {
    summary: { totalJobs, successJobs, failedJobs, totalCopies, successRate: totalJobs > 0 ? Math.round(successJobs / totalJobs * 100) : 0 },
    byDay:   Object.values(byDay).sort((a, b) => a.day > b.day ? -1 : 1),
    sellerCount: Object.keys(bySeller).length,
  };
});


/* ──────────────────────────────────────────────────────────────
   posGetPrintTemplate
   Get a saved receipt template.
   Input: { templateId? }  — omit for caller's own default template
─────────────────────────────────────────────────────────────── */
exports.posGetPrintTemplate = onCall(CF, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const { templateId } = req.data || {};
  const docId = templateId ? String(templateId).slice(0, 64) : `default_${uid}`;

  const snap = await db().collection('posPrintTemplates').doc(docId).get();
  if (!snap.exists) return { exists: false, template: null };

  const data = snap.data();

  /* Access control: caller must own the template or be admin */
  if (data.uid !== uid && !_ac.isAdmin(req))
    throw new HttpsError('permission-denied', 'Access denied');

  return {
    exists: true,
    templateId: docId,
    template:   data.template || {},
    updatedAt:  data.updatedAt?.toDate?.()?.toISOString() || null,
  };
});


/* ──────────────────────────────────────────────────────────────
   posSavePrintTemplate
   Save a receipt template for the caller.
   Input: { templateId?, template: { ... } }
─────────────────────────────────────────────────────────────── */
exports.posSavePrintTemplate = onCall(CF, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');

  const { templateId, template } = req.data || {};
  if (!template || typeof template !== 'object')
    throw new HttpsError('invalid-argument', 'template object required');

  const docId = templateId ? String(templateId).slice(0, 64) : `default_${uid}`;

  /* If templateId provided, verify ownership before overwriting */
  if (templateId) {
    const existing = await db().collection('posPrintTemplates').doc(docId).get();
    if (existing.exists && existing.data().uid !== uid && !_ac.isAdmin(req))
      throw new HttpsError('permission-denied', 'Cannot overwrite another seller\'s template');
  }

  const sanitised = _sanitiseTemplate(template);

  await db().collection('posPrintTemplates').doc(docId).set({
    uid,
    templateId: docId,
    template:   sanitised,
    updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: false });

  return { saved: true, templateId: docId, template: sanitised };
});


/* ── Helpers ───────────────────────────────────────────────── */

function _defaultConfig () {
  return {
    paperWidth:           '80mm',
    autoCut:              true,
    copies:               1,
    logoText:             '',
    logoUrl:              '',
    footer:               '',
    promoMessage:         '',
    returnPolicy:         '',
    showCommission:       false,
    showPreview:          false,
    autoPrintAfterPayment: false,
    encoding:             'PC437',
    printDensity:         0,
    imageThreshold:       128,
  };
}

function _sanitiseConfig (raw) {
  const out = {};

  if (VALID_WIDTHS.has(raw.paperWidth))                                  out.paperWidth  = raw.paperWidth;
  if (typeof raw.autoCut === 'boolean')                                  out.autoCut     = raw.autoCut;
  if (typeof raw.copies === 'number' && raw.copies >= 1 && raw.copies <= 10)
    out.copies = Math.floor(raw.copies);
  if (typeof raw.logoText === 'string')       out.logoText       = raw.logoText.slice(0, 128);
  if (typeof raw.logoUrl  === 'string')       out.logoUrl        = raw.logoUrl.startsWith('https://') ? raw.logoUrl.slice(0, 512) : '';
  if (typeof raw.footer   === 'string')       out.footer         = raw.footer.slice(0, 256);
  if (typeof raw.promoMessage === 'string')   out.promoMessage   = raw.promoMessage.slice(0, 256);
  if (typeof raw.returnPolicy === 'string')   out.returnPolicy   = raw.returnPolicy.slice(0, 256);
  if (typeof raw.showCommission === 'boolean')      out.showCommission      = raw.showCommission;
  if (typeof raw.showPreview === 'boolean')          out.showPreview         = raw.showPreview;
  if (typeof raw.autoPrintAfterPayment === 'boolean') out.autoPrintAfterPayment = raw.autoPrintAfterPayment;

  const VALID_ENC = new Set(['PC437', 'PC850', 'PC858', 'UTF8']);
  if (VALID_ENC.has(raw.encoding))            out.encoding        = raw.encoding;

  if (typeof raw.printDensity === 'number' && raw.printDensity >= -3 && raw.printDensity <= 3)
    out.printDensity = Math.round(raw.printDensity);
  if (typeof raw.imageThreshold === 'number' && raw.imageThreshold >= 50 && raw.imageThreshold <= 250)
    out.imageThreshold = Math.floor(raw.imageThreshold);

  return { ..._defaultConfig(), ...out };
}

function _sanitiseTemplate (raw) {
  const out = {};
  const STR = (v, max) => typeof v === 'string' ? v.slice(0, max) : undefined;
  const BOOL = v => typeof v === 'boolean' ? v : undefined;

  const fields = [
    ['businessName', 128], ['tagline', 128], ['address', 256],
    ['phone', 32], ['email', 128], ['website', 256],
    ['taxId', 64], ['vatNumber', 64],
    ['headerNote', 256], ['footerNote', 256],
    ['returnPolicy', 256], ['warrantyNote', 256],
    ['promoMessage', 256],
  ];
  for (const [k, max] of fields) { const v = STR(raw[k], max); if (v !== undefined) out[k] = v; }

  const bools = ['showLogo', 'showBarcode', 'showQR', 'showTaxBreakdown', 'showCashier', 'showCommission', 'showDigitalRef'];
  for (const k of bools) { const v = BOOL(raw[k]); if (v !== undefined) out[k] = v; }

  return out;
}
