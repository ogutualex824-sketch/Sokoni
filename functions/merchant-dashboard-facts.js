/* merchant-dashboard-facts.js — the ONE server-authoritative source for the merchant dashboard's
 * Business Pulse and for the Customers list.
 *
 *   merchantDashboardFacts({ op: 'facts' })      → today's takings / orders / customers / 7-day series
 *   merchantDashboardFacts({ op: 'customers' })  → the merchant's customers, derived from real sales
 *
 * WHY THIS EXISTS (census 2026-09-30, docs/MERCHANT_DASHBOARD_FACTS.md). The dashboard rendered
 * dashes for Sales/Deliveries and "0" for Customers although the shop had sales:
 *   · till sales live in `posRetailSales`, whose served rule is isAdmin() only — no client can read them;
 *   · `crmCustomerProfiles`, the only source the Customers route read, is EMPTY project-wide (nothing
 *     builds it), while the shop's `orders` carry 3 distinct buyers and its 5 till sales are cash walk-ins;
 *   · `posDailySummary` has no rule at all.
 * A client cannot see the merchant's own money, so the figures have to be computed HERE, with the
 * Admin SDK, for the AUTHENTICATED merchant only.
 *
 * AUTHORITY. Every read is scoped by `sellerUid == request.auth.uid`. No client-supplied id is
 * accepted (so no tenant guard is needed and no third guard is invented — see
 * project_merchant_authority_adoption_gap). App Check is enforced like every POS money callable.
 *
 * HONESTY. Figures are stated with their source and their completeness:
 *   known    — computed from a complete read (the sample was under its page limit)
 *   partial  — computed, but the sample hit its limit or a source could not be read; the note says which
 *   unknown  — no source (e.g. deliveries: no server writer stamps senderUid — unchanged finding)
 * Nothing is extrapolated. A truncated sum is refused, never rendered as a total.
 * Money is returned in KES as numbers; the client formats. No PII beyond the merchant's own customers
 * (name/phone they already collected) is returned, and only to that merchant.
 */
'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const REGION = 'us-central1';
const CFG = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 };
const LIMIT = 500;                 /* per source; over this the figure is PARTIAL, never a wrong total */
const OPEN_ORDER = ['pending', 'paid', 'confirmed', 'processing'];
const COMPLETED_SALE = ['completed'];
const PAID_ORDER = ['paid', 'confirmed', 'processing', 'shipped', 'delivered', 'completed'];

const known   = (value, note) => ({ state: 'known',   value, note: note || null });
const partial = (value, note) => ({ state: 'partial', value, note: note || null });
const unknown = (note)        => ({ state: 'unknown', value: null, note: note || null });

/* Timestamp → ms. Accepts Firestore Timestamp, number, ISO string; anything else is null (not counted). */
function millis(v) {
  if (v == null) return null;
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return isFinite(t) ? t : null; }
  if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
  return null;
}
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);

/* ── pure computation (exported for tests) ──────────────────────────────────────────────────────── */
/* THE SHOP'S DAY (2026-10-01). "Today" used to be the SERVER's day: setHours(0) on a Cloud Functions
   instance is midnight UTC, i.e. 03:00 in Kenya, so between midnight and 03:00 a merchant's "today" still
   held last night's sales. Kenya keeps UTC+3 all year (no DST), so the boundary is fixed arithmetic. */
const SHOP_TZ_OFFSET_MS = 3 * 3600 * 1000;
const DAY_MS = 86400 * 1000;
function dayStart(now, offsetDays) {
  const local = Number(now) + SHOP_TZ_OFFSET_MS;
  return Math.floor(local / DAY_MS) * DAY_MS - SHOP_TZ_OFFSET_MS - (offsetDays || 0) * DAY_MS;
}
/* A sale's instant: its own timestamp when present (exact), else its saleDate read as noon on that day in
   the shop's zone. saleDate alone is not trusted first because at least one writer stamps it with
   toISOString() — a UTC date — which files a 01:00 sale under the previous day. */
function saleMillis(s) {
  const m = millis(s && (s.createdAt || s.checkoutStartedAt));
  if (m !== null) return m;
  if (s && typeof s.saleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.saleDate)) {
    const [y, mo, d] = s.saleDate.split('-').map(Number);
    const t = Date.UTC(y, mo - 1, d, 12, 0, 0) - SHOP_TZ_OFFSET_MS;
    if (isFinite(t)) return t;
  }
  return null;
}
function customerKeyOf(o) {
  const uid = o.buyerUid || o.buyerId || o.customerUid || (o.customer && (o.customer.uid || o.customer.id));
  if (uid) return 'uid:' + String(uid);
  const phone = o.buyerPhone || o.phone || o.paidPhone || o.customerPhone || (o.customer && o.customer.phone);
  if (phone) return 'phone:' + String(phone).replace(/\s+/g, '');
  return null;                        /* a walk-in cash sale with no identity is a sale, not a customer */
}

function computeFacts({ orders, sales, ordersTruncated, salesTruncated, ordersReadable, salesReadable, now }) {
  const t = now || Date.now();
  const today = dayStart(t, 0);
  const out = {};

  /* TILL TAKINGS (posRetailSales, completed) */
  if (!salesReadable) {
    out.tillToday = unknown('Till sales could not be read');
  } else {
    const done = sales.filter((s) => COMPLETED_SALE.includes(String(s.status || 'completed')));
    const todayS = done.filter((s) => { const m = saleMillis(s); return m !== null && m >= today; });
    let sum = 0, bad = 0;
    todayS.forEach((s) => { const g = num(s.grandTotal); if (g === null) bad++; else sum += g; });
    const note = salesTruncated ? 'Till sample hit its limit — treat as a floor' : (bad ? bad + ' sale(s) had no readable total' : null);
    out.tillToday = (salesTruncated || bad) ? partial(sum, note) : known(sum, 'Completed till sales today');
    out.tillCountToday = todayS.length;
  }

  /* ONLINE ORDERS (orders where sellerUid == uid) */
  if (!ordersReadable) {
    out.ordersToday = unknown('Orders could not be read');
    out.onlineToday = unknown('Orders could not be read');
    out.needsAttention = null;
  } else {
    const todayO = orders.filter((o) => { const m = millis(o.createdAt); return m !== null && m >= today; });
    out.ordersToday = ordersTruncated ? partial(todayO.length, 'Order sample hit its limit') : known(todayO.length, 'Online orders today');
    let sum = 0, bad = 0;
    todayO.filter((o) => PAID_ORDER.includes(String(o.status))).forEach((o) => { const v = num(o.total != null ? o.total : o.amount); if (v === null) bad++; else sum += v; });
    out.onlineToday = (ordersTruncated || bad) ? partial(sum, ordersTruncated ? 'Order sample hit its limit' : bad + ' order(s) had no readable total') : known(sum, 'Paid online orders today');
    out.needsAttention = orders.filter((o) => OPEN_ORDER.includes(String(o.status))).length;
  }

  /* TAKINGS = till + online, each already honest; combined state is the weaker of the two */
  const parts = [out.tillToday, out.onlineToday];
  if (parts.every((p) => p.state === 'unknown')) out.takings = unknown('No sales source could be read');
  else {
    const v = parts.reduce((a, p) => a + (p.state === 'unknown' ? 0 : p.value), 0);
    const st = parts.some((p) => p.state !== 'known') ? 'partial' : 'known';
    const notes = parts.filter((p) => p.state !== 'known').map((p) => p.note).filter(Boolean);
    out.takings = st === 'known' ? known(v, 'Till + online, today') : partial(v, notes.join(' · ') || 'Some sources incomplete');
  }
  /* TREND vs yesterday, only when both days are fully known */
  if (out.takings.state === 'known' && salesReadable && ordersReadable && !salesTruncated && !ordersTruncated) {
    const y0 = dayStart(t, 1), y1 = today;
    let y = 0;
    sales.filter((s) => COMPLETED_SALE.includes(String(s.status || 'completed'))).forEach((s) => { const m = saleMillis(s); const g = num(s.grandTotal); if (m !== null && m >= y0 && m < y1 && g !== null) y += g; });
    orders.filter((o) => PAID_ORDER.includes(String(o.status))).forEach((o) => { const m = millis(o.createdAt); const v = num(o.total != null ? o.total : o.amount); if (m !== null && m >= y0 && m < y1 && v !== null) y += v; });
    out.trend = y > 0 ? known(((out.takings.value - y) / y) * 100, 'vs yesterday') : unknown('No takings yesterday');
  } else out.trend = unknown('Needs a complete read of both days');

  /* CUSTOMERS = distinct identities across orders + identified till sales (walk-ins are not customers) */
  const ids = new Set();
  if (ordersReadable) orders.forEach((o) => { const k = customerKeyOf(o); if (k) ids.add(k); });
  if (salesReadable) sales.forEach((s) => { const k = customerKeyOf(s); if (k) ids.add(k); });
  if (!ordersReadable && !salesReadable) out.customers = unknown('No sales source could be read');
  else out.customers = (ordersTruncated || salesTruncated || !ordersReadable || !salesReadable) ? partial(ids.size, 'Some sources incomplete') : known(ids.size, 'Identified buyers, all time');

  /* 7-DAY SERIES, oldest first, till + online; null when nothing real to draw or a sample was truncated */
  if (salesReadable && ordersReadable && !salesTruncated && !ordersTruncated) {
    const days = []; for (let i = 6; i >= 0; i--) days.push({ from: dayStart(t, i), to: dayStart(t, i) + 86400000, total: 0 });
    let any = false;
    const add = (m, v) => { if (m === null || v === null) return; for (const d of days) if (m >= d.from && m < d.to) { d.total += v; any = true; break; } };
    sales.filter((s) => COMPLETED_SALE.includes(String(s.status || 'completed'))).forEach((s) => add(saleMillis(s), num(s.grandTotal)));
    orders.filter((o) => PAID_ORDER.includes(String(o.status))).forEach((o) => add(millis(o.createdAt), num(o.total != null ? o.total : o.amount)));
    out.series = any ? days.map((d) => d.total) : null;
  } else out.series = null;

  out.deliveries = unknown('Delivery totals need the dispatch authority');   /* unchanged finding */
  out.sources = { orders: { readable: !!ordersReadable, count: orders.length, truncated: !!ordersTruncated }, tillSales: { readable: !!salesReadable, count: sales.length, truncated: !!salesTruncated } };
  return out;
}

function computeCustomers({ orders, sales, ordersReadable, salesReadable, ordersTruncated, salesTruncated }) {
  const map = new Map();
  const touch = (key, row, amount, when, source, identity) => {
    const c = map.get(key) || { key, uid: identity.uid || null, name: identity.name || '', phone: identity.phone || '', orderCount: 0, totalSpend: 0, firstOrderAt: null, lastOrderAt: null, sources: {} };
    c.orderCount++;
    if (amount !== null) c.totalSpend += amount;
    if (when !== null) { if (c.firstOrderAt === null || when < c.firstOrderAt) c.firstOrderAt = when; if (c.lastOrderAt === null || when > c.lastOrderAt) c.lastOrderAt = when; }
    if (!c.name && identity.name) c.name = identity.name;
    if (!c.phone && identity.phone) c.phone = identity.phone;
    c.sources[source] = (c.sources[source] || 0) + 1;
    map.set(key, c);
  };
  if (ordersReadable) orders.forEach((o) => {
    const k = customerKeyOf(o); if (!k) return;
    touch(k, o, num(o.total != null ? o.total : o.amount), millis(o.createdAt), 'online', { uid: o.buyerUid || o.buyerId || null, name: o.buyerName || o.name || '', phone: o.buyerPhone || o.phone || o.paidPhone || '' });
  });
  if (salesReadable) sales.forEach((s) => {
    const k = customerKeyOf(s); if (!k) return;
    const c = s.customer || {};
    touch(k, s, num(s.grandTotal), saleMillis(s), 'till', { uid: c.uid || c.id || null, name: c.name || '', phone: c.phone || '' });
  });
  const customers = [...map.values()].map((c) => ({ ...c, avgOrderValue: c.orderCount ? c.totalSpend / c.orderCount : null })).sort((a, b) => b.totalSpend - a.totalSpend);
  /* Walk-ins: COMPLETED till sales with no identity — a voided sale is neither a sale nor a customer. */
  const walkIns = salesReadable ? sales.filter((s) => COMPLETED_SALE.includes(String(s.status || 'completed')) && !customerKeyOf(s)).length : null;
  return {
    customers,
    count: customers.length,
    completeness: (!ordersReadable || !salesReadable || ordersTruncated || salesTruncated) ? 'partial' : 'complete',
    note: [!ordersReadable && 'orders unreadable', !salesReadable && 'till sales unreadable', ordersTruncated && 'orders truncated', salesTruncated && 'till sales truncated', walkIns ? walkIns + ' till sale(s) were walk-ins with no identity' : null].filter(Boolean).join(' · ') || null,
  };
}

/* ── reads ──────────────────────────────────────────────────────────────────────────────────────── */
async function readScoped(db, col, uid) {
  try {
    const snap = await db.collection(col).where('sellerUid', '==', uid).limit(LIMIT).get();
    const rows = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    return { readable: true, rows, truncated: rows.length >= LIMIT };
  } catch (e) {
    return { readable: false, rows: [], truncated: false, error: e && e.message };
  }
}

async function handler(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to see your business.');
  const op = String((req.data && req.data.op) || 'facts');
  if (op !== 'facts' && op !== 'customers') throw new HttpsError('invalid-argument', 'Unknown op.');
  const db = admin.firestore();
  const [orders, sales] = await Promise.all([readScoped(db, 'orders', uid), readScoped(db, 'posRetailSales', uid)]);
  const input = { orders: orders.rows, sales: sales.rows, ordersReadable: orders.readable, salesReadable: sales.readable, ordersTruncated: orders.truncated, salesTruncated: sales.truncated, now: Date.now() };
  if (op === 'customers') return { ok: true, ...computeCustomers(input), generatedAt: new Date().toISOString() };
  return { ok: true, facts: computeFacts(input), generatedAt: new Date().toISOString() };
}

exports.merchantDashboardFacts = onCall(CFG, handler);
exports._internal = { computeFacts, computeCustomers, customerKeyOf, saleMillis, millis, handler, dayStart, SHOP_TZ_OFFSET_MS };
