/* ================================================================
   SOKONI Currency Engine v1.0
   5 Cloud Functions:
     currencyGetRates             — public: current exchange rates + stale flag
     currencyConvert              — public: convert between any two supported currencies
     currencyUpdateRates          — admin:  manually set rates (KES-relative)
     currencyGetHistory           — admin:  historical rate snapshots for charting
     currencyScheduledRateRefresh — scheduled (every 6 h): stale-rate alerting
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const logger                 = require('firebase-functions/logger');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { initializeApp, getApps }  = require('firebase-admin/app');

if (!getApps().length) initializeApp();
const db = getFirestore();

// ── Constants ─────────────────────────────────────────────────────────────────

const REGION = 'us-central1';

/**
 * All rates are stored relative to KES (the base currency).
 * rates[X] = how much 1 KES is worth in currency X.
 * Example: rates.USD = 0.0077  →  1 KES = 0.0077 USD  →  1 USD ≈ 129.87 KES
 */
const SUPPORTED_CURRENCIES = new Set([
  'KES', 'USD', 'EUR', 'GBP', 'UGX', 'TZS', 'ETB', 'NGN', 'ZAR', 'AED', 'CNY', 'INR',
]);

const RATES_COL      = 'exchangeRates';
const LATEST_DOC     = 'latest';
const HISTORY_SUBCOL = 'history';

/** 1 hour in ms — marks rates as stale in API responses */
const STALE_WARN_MS  = 60 * 60 * 1000;
/** 5 hours in ms — triggers systemAlerts/rateRefresh via scheduled job */
const STALE_ALERT_MS = 5 * 60 * 60 * 1000;

// ── Private helpers ───────────────────────────────────────────────────────────

function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/**
 * Validates that `code` is a member of SUPPORTED_CURRENCIES.
 * Expects the code to already be upper-cased by the caller.
 */
function _assertValidCurrency(code) {
  if (!code || typeof code !== 'string')
    throw new HttpsError('invalid-argument', 'Currency code must be a non-empty string');
  if (!SUPPORTED_CURRENCIES.has(code))
    throw new HttpsError(
      'invalid-argument',
      `Unsupported currency: "${code}". Supported currencies: ${[...SUPPORTED_CURRENCIES].join(', ')}`,
    );
}

/** Returns YYYY-MM-DD string for the given Unix ms timestamp (UTC). */
function _dateKey(ms) {
  return new Date(ms).toISOString().split('T')[0];
}

/**
 * Reads exchangeRates/latest from Firestore.
 * Throws `not-found` if no rates document has been set yet.
 */
async function _fetchLatest() {
  const snap = await db.collection(RATES_COL).doc(LATEST_DOC).get();
  if (!snap.exists)
    throw new HttpsError(
      'not-found',
      'Exchange rates have not been configured yet. '
      + 'An admin must call currencyUpdateRates first.',
    );
  return snap.data();
}

// ── CF 1: currencyGetRates ────────────────────────────────────────────────────
/**
 * Public — no authentication required.
 * Returns current exchange rates from `exchangeRates/latest`.
 * Sets staleWarning: true if the rates document is older than 1 hour.
 *
 * Response shape:
 *   { base: 'KES', rates: { USD, EUR, ... }, updatedAt: <ms>, staleWarning: <bool> }
 */
exports.currencyGetRates = onCall(
  { region: REGION, timeoutSeconds: 15, memory: '128MiB' },
  async (_req) => {
    const data = await _fetchLatest();

    const updatedAtMs  = data.updatedAt?.toMillis?.() ?? 0;
    const staleWarning = (Date.now() - updatedAtMs) > STALE_WARN_MS;

    logger.info('[currency] getRates', { staleWarning, ageMs: Date.now() - updatedAtMs });

    return {
      base:         data.base  || 'KES',
      rates:        data.rates || {},
      updatedAt:    updatedAtMs,
      staleWarning,
    };
  },
);

// ── CF 2: currencyConvert ─────────────────────────────────────────────────────
/**
 * Public — no authentication required.
 * Converts `amount` from one supported currency to another.
 *
 * Conversion logic (all rates are KES-relative):
 *   crossRate = rates[to] / rates[from]
 *   converted = round(amount × crossRate, 2)
 *
 * KES itself has an implicit rate of 1 (1 KES = 1 KES).
 *
 * Input:  { amount: number, from: string, to: string }
 * Output: { from, to, amount, converted, rate, updatedAt }
 */
exports.currencyConvert = onCall(
  { region: REGION, timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const { amount, from, to } = req.data || {};

    // ── Validate inputs ──────────────────────────────────────────────────────
    if (amount === undefined || amount === null)
      throw new HttpsError('invalid-argument', 'amount is required');
    if (typeof amount !== 'number' || !isFinite(amount) || amount < 0)
      throw new HttpsError('invalid-argument', 'amount must be a non-negative finite number');

    const fromCode = (typeof from === 'string' ? from.toUpperCase() : '');
    const toCode   = (typeof to   === 'string' ? to.toUpperCase()   : '');

    _assertValidCurrency(fromCode);
    _assertValidCurrency(toCode);

    // ── Fetch rates ──────────────────────────────────────────────────────────
    const data  = await _fetchLatest();
    const rates = data.rates || {};

    // KES itself always has rate 1 (base currency)
    const rateFrom = fromCode === 'KES' ? 1 : rates[fromCode];
    const rateTo   = toCode   === 'KES' ? 1 : rates[toCode];

    if (rateFrom == null)
      throw new HttpsError(
        'failed-precondition',
        `No rate available for ${fromCode}. Ask an admin to update rates.`,
      );
    if (rateTo == null)
      throw new HttpsError(
        'failed-precondition',
        `No rate available for ${toCode}. Ask an admin to update rates.`,
      );

    // ── Convert ──────────────────────────────────────────────────────────────
    // amount (FROM) → KES → TO
    // crossRate = rates[TO] / rates[FROM]
    const crossRate = rateTo / rateFrom;
    const converted = Math.round(amount * crossRate * 100) / 100;

    const updatedAtMs = data.updatedAt?.toMillis?.() ?? 0;

    logger.info('[currency] convert', { fromCode, toCode, amount, converted, crossRate });

    return {
      from:      fromCode,
      to:        toCode,
      amount,
      converted,
      rate:      Math.round(crossRate * 1e8) / 1e8,   // 8 d.p. for cross-rate precision
      updatedAt: updatedAtMs,
    };
  },
);

// ── CF 3: currencyUpdateRates ─────────────────────────────────────────────────
/**
 * Admin only.
 * Accepts a map of KES-relative rates and persists them to:
 *   - exchangeRates/latest          (overwrites the live document)
 *   - exchangeRates/latest/history/{YYYY-MM-DD}  (audit snapshot)
 *
 * Also clears the systemAlerts/rateRefresh stale alert if it was set.
 *
 * Input:  { rates: { USD: 0.0077, EUR: 0.0071, ... } }
 * Output: { updated: true, currenciesUpdated: N }
 */
exports.currencyUpdateRates = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    _assertAdmin(req);

    const { rates } = req.data || {};

    if (!rates || typeof rates !== 'object' || Array.isArray(rates))
      throw new HttpsError('invalid-argument', 'rates must be a non-null plain object');

    const entries = Object.entries(rates);
    if (entries.length === 0)
      throw new HttpsError('invalid-argument', 'rates must contain at least one currency entry');

    // ── Validate each entry ──────────────────────────────────────────────────
    const sanitised = {};
    for (const [code, value] of entries) {
      const upper = (typeof code === 'string' ? code.toUpperCase() : '');
      _assertValidCurrency(upper);

      if (typeof value !== 'number' || !isFinite(value) || value <= 0)
        throw new HttpsError(
          'invalid-argument',
          `Rate for ${upper} must be a positive finite number (got ${value})`,
        );

      // KES is the base currency — its rate must always be 1
      if (upper === 'KES' && value !== 1)
        throw new HttpsError(
          'invalid-argument',
          'KES is the base currency; its rate must be 1 and cannot be overridden',
        );

      sanitised[upper] = value;
    }

    // ── Persist ──────────────────────────────────────────────────────────────
    const now     = Timestamp.now();
    const dateKey = _dateKey(Date.now());

    const payload = {
      base:      'KES',
      rates:     sanitised,
      updatedAt: now,
      updatedBy: req.auth.uid,
    };

    const historyPayload = { ...payload, date: dateKey };

    const latestRef  = db.collection(RATES_COL).doc(LATEST_DOC);
    const historyRef = latestRef.collection(HISTORY_SUBCOL).doc(dateKey);

    const batch = db.batch();
    batch.set(latestRef,  payload,        { merge: false });
    batch.set(historyRef, historyPayload, { merge: false });   // same-day update overwrites
    await batch.commit();

    // Clear stale-rate alert (non-critical — ignore failure)
    db.collection('systemAlerts').doc('rateRefresh')
      .set({ rateRefreshNeeded: false, clearedAt: now, clearedBy: req.auth.uid }, { merge: true })
      .catch(err => logger.warn('[currency] Failed to clear rateRefresh alert', { error: err.message }));

    const currenciesUpdated = Object.keys(sanitised).length;
    logger.info('[currency] rates updated', { currenciesUpdated, adminUid: req.auth.uid, dateKey });

    return { updated: true, currenciesUpdated };
  },
);

// ── CF 4: currencyGetHistory ──────────────────────────────────────────────────
/**
 * Admin only.
 * Returns historical rate snapshots from exchangeRates/latest/history,
 * ordered newest-first, limited to `days` entries.
 *
 * Input:  { days?: number }  (default 30, max 365)
 * Output: { days, history: [...], total: N }
 */
exports.currencyGetHistory = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    _assertAdmin(req);

    const { days = 30 } = req.data || {};

    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365)
      throw new HttpsError('invalid-argument', 'days must be an integer between 1 and 365');

    const snap = await db
      .collection(RATES_COL).doc(LATEST_DOC)
      .collection(HISTORY_SUBCOL)
      .orderBy('date', 'desc')
      .limit(days)
      .get();

    const history = snap.docs.map(d => {
      const entry = d.data();
      return {
        id:        d.id,
        date:      entry.date      || d.id,
        base:      entry.base      || 'KES',
        rates:     entry.rates     || {},
        updatedAt: entry.updatedAt?.toMillis?.() ?? null,
        updatedBy: entry.updatedBy || null,
      };
    });

    logger.info('[currency] getHistory', { days, records: history.length });

    return { days, history, total: history.length };
  },
);

// ── CF 5: currencyScheduledRateRefresh ───────────────────────────────────────
/**
 * Runs every 6 hours.
 * Checks whether exchange rates are older than 5 hours.
 * If stale — writes rateRefreshNeeded: true to systemAlerts/rateRefresh
 * so the admin notification pipeline can pick it up.
 *
 * NOTE: This function does NOT fetch rates from any external API.
 * Rates are exclusively managed by admins via currencyUpdateRates.
 */
exports.currencyScheduledRateRefresh = onSchedule(
  { schedule: '0 */6 * * *', region: REGION, timeoutSeconds: 60 },
  async (_event) => {
    try {
      const snap = await db.collection(RATES_COL).doc(LATEST_DOC).get();

      if (!snap.exists) {
        logger.warn('[currency] scheduledRateRefresh — no rates document exists; alerting admin');
        await db.collection('systemAlerts').doc('rateRefresh').set({
          rateRefreshNeeded: true,
          reason:            'No exchange rates document exists. Call currencyUpdateRates.',
          checkedAt:         Timestamp.now(),
        }, { merge: true });
        return;
      }

      const data        = snap.data();
      const updatedAtMs = data.updatedAt?.toMillis?.() ?? 0;
      const ageMs       = Date.now() - updatedAtMs;
      const ageHours    = parseFloat((ageMs / 3_600_000).toFixed(2));

      if (ageMs > STALE_ALERT_MS) {
        logger.warn('[currency] Exchange rates are STALE — alerting admin', { ageHours });

        await db.collection('systemAlerts').doc('rateRefresh').set({
          rateRefreshNeeded: true,
          ageHours,
          lastUpdatedAt:     data.updatedAt || null,
          checkedAt:         Timestamp.now(),
        }, { merge: true });
      } else {
        logger.info('[currency] Exchange rates are fresh', { ageHours });
      }
    } catch (err) {
      logger.error('[currency] scheduledRateRefresh error', { error: err.message, stack: err.stack });
    }
  },
);
