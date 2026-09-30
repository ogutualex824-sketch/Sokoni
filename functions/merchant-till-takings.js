'use strict';
/**
 * merchant-till-takings.js — Business Pulse "today's takings" from the CANONICAL sale record
 * (POS/Till convergence, owner 2026-09-30).
 *
 * WHY A CALLABLE. merchant-v2's Pulse said "Till sales are not readable yet", honestly: the only
 * server aggregate, posDailySummary, has no read rule, and is keyed by the UTC date — a Nairobi
 * sale between 00:00 and 03:00 lands on "yesterday". The per-sale record posRetailSales is written
 * by posCompleteCheckout with the server's own figures (grandTotal, the money position per tender,
 * commission), so this reads THAT, for the Nairobi day, after proving the caller may see the shop's
 * money. Nothing here is written, and nothing is re-priced.
 *
 * WHAT COUNTS. Only sales the checkout authorised: rows carrying a server `saleDate` and an
 * `idempotencyKey`. The legacy browser mirror (mirrorPosTransactionToRetail) writes neither, so a
 * client-declared sale is never counted as revenue. Refunded sales are excluded from revenue and
 * reported as a count.
 *
 * WHO. shop-employees.resolveShopAccess (the guard posInitiateIntasendPayment uses): the owner,
 * a platform admin, or a shop MANAGER. A cashier sees the till, not the shop's money.
 *
 * TRUNCATION. Each UTC-date query is bounded; if any bound is hit the result says `truncated:true`
 * and the page must show the figure as partial, never as the day's total.
 */

const DAY_MS = 86400000;
const NAIROBI_OFFSET_MS = 3 * 3600000;   /* EAT = UTC+3, no daylight saving */
const PER_DATE_LIMIT = 2000;
const MONEY_ROLES_EMPLOYEE = new Set(['manager']);

/** [startMs, endMs) of the Nairobi calendar day containing `nowMs`, shifted by `dayOffset` days. */
function nairobiDay(nowMs, dayOffset) {
  const local = nowMs + NAIROBI_OFFSET_MS;
  const startLocal = Math.floor(local / DAY_MS) * DAY_MS + (dayOffset || 0) * DAY_MS;
  const start = startLocal - NAIROBI_OFFSET_MS;
  return { start, end: start + DAY_MS, label: new Date(startLocal).toISOString().slice(0, 10) };
}

/** The UTC `saleDate` strings a [start, end) window touches (posCompleteCheckout writes UTC dates). */
function utcDatesBetween(start, end) {
  const out = [];
  for (let t = Math.floor(start / DAY_MS) * DAY_MS; t < end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function _ms(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}
const _c = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : 0);

/** Pure: fold canonical sale rows into the Pulse figures for one window. */
function aggregate(rows, window) {
  const agg = { sales: 0, revenueCents: 0, refunds: 0, itemsSold: 0, cashCents: 0, electronicCents: 0,
    byMethodCents: {}, commissionCents: 0, products: {} };
  for (const r of rows) {
    const at = _ms(r.createdAt);
    if (at === null || at < window.start || at >= window.end) continue;
    if (!r.saleDate || !r.idempotencyKey) continue;             /* not checkout-authorised */
    if (r.status === 'refunded') { agg.refunds++; continue; }
    if (r.status !== 'completed') continue;
    agg.sales++;
    agg.revenueCents += Math.round(Number(r.grandTotal || 0) * 100);
    const pos = r.position || {};
    agg.cashCents += _c(pos.cashCents);
    agg.electronicCents += _c(pos.electronicCents);
    for (const [m, c] of Object.entries(pos.byMethod || {})) agg.byMethodCents[m] = (agg.byMethodCents[m] || 0) + _c(c);
    agg.commissionCents += _c(r.commission && r.commission.amountCents);
    for (const it of (Array.isArray(r.items) ? r.items : [])) {
      const q = Number(it && it.qty) || 0; if (q <= 0) continue;
      agg.itemsSold += q;
      const k = String((it && (it.productId || it.name)) || 'unknown');
      const p = agg.products[k] || (agg.products[k] = { productId: it.productId || null, name: String(it.name || k).slice(0, 80), qty: 0 });
      p.qty += q;
    }
  }
  agg.topProducts = Object.values(agg.products).sort((a, b) => b.qty - a.qty).slice(0, 5);
  delete agg.products;
  return agg;
}

async function readWindow(db, shopId, window) {
  const rows = []; let truncated = false;
  for (const d of utcDatesBetween(window.start, window.end)) {
    const snap = await db.collection('posRetailSales')
      .where('sellerId', '==', String(shopId)).where('saleDate', '==', d).limit(PER_DATE_LIMIT).get();
    if (snap.size >= PER_DATE_LIMIT) truncated = true;
    snap.forEach((doc) => rows.push(doc.data()));
  }
  return { rows, truncated };
}

function makeMerchantTillTakings({ onCall, HttpsError, db, now }) {
  const clock = now || (() => Date.now());
  return onCall({ region: 'us-central1', timeoutSeconds: 30, memory: '256MiB' }, async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const shopId = String((req.data && req.data.shopId) || '').trim();
    if (!shopId || shopId.length > 128) throw new HttpsError('invalid-argument', 'shopId is required.');
    const { resolveShopAccess } = require('./shop-employees');
    const access = await resolveShopAccess(uid, shopId);   /* throws permission-denied when none */
    const mayMoney = access.via === 'owner' || access.via === 'admin' ||
      (access.via === 'employee' && MONEY_ROLES_EMPLOYEE.has(access.role));
    if (!mayMoney) throw new HttpsError('permission-denied', 'Only the shop owner or a manager can see takings.');

    const t = clock();
    const today = nairobiDay(t, 0), yesterday = nairobiDay(t, -1);
    const [a, b] = await Promise.all([readWindow(db, shopId, today), readWindow(db, shopId, yesterday)]);
    return {
      ok: true, shopId, source: 'posRetailSales', timeZone: 'Africa/Nairobi',
      today: Object.assign({ day: today.label }, aggregate(a.rows, today)),
      yesterday: Object.assign({ day: yesterday.label }, aggregate(b.rows, yesterday)),
      truncated: a.truncated || b.truncated,
      asOfMs: t,
    };
  });
}

module.exports = { makeMerchantTillTakings, aggregate, nairobiDay, utcDatesBetween };
