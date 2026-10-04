#!/usr/bin/env node
/* AdminOS Orders — server summary, paginated list, status authority, no fail-to-0 (2026-10-04).
 *   node scripts/test-admin-orders-summary.js
 * Hermetic: runs the REAL functions/admin-os.js handlers on the in-memory Firestore (scripts/lib/fake-firestore.js)
 * through scripts/lib/aos-harness.js. No network, no emulator, no browser. Safe under block-admin.js.
 * Owner matrix (ORDERS E2E CLOSURE 10-04): real summary · genuinely empty · unreadable bucket · verified vs unverified ·
 * fake client paid · buyer total never revenue · cancelled · cancelled+PV · unpaid · authz · malformed · cursor ·
 * status-update refusals. Row ids are stable — scripts/sabotage-admin-orders-summary.js names them. */
'use strict';
const path = require('path');
const { fakeDb } = require('./lib/fake-firestore');
const { loadAdminOs } = require('./lib/aos-harness');

const H = loadAdminOs(process.env.AOS_MODULE ? { modulePath: path.resolve(process.env.AOS_MODULE) } : undefined);
const AOS = H.aos;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const ADMIN = { uid: 'ops', token: { admin: true } };
const SUPER = { uid: 'boss', token: { superAdmin: true } };
const call = async (op, data, auth) => { try { return { r: await AOS._h[op]({ auth: auth === undefined ? ADMIN : auth, data }) }; } catch (e) { return { err: e.code || 'error', msg: e.message, details: e.details }; } };
const T = (ms) => ({ __ts: ms });
const BASE_MS = Date.UTC(2026, 9, 1);
const isNull = (v) => v === null;

/* Production-shaped fixture (read-only prod counts 2026-10-04: 10 orders; pending_payment 2, paid 1, confirmed 5,
   in_transit 1, delivered 1; 8 paymentVerified). Money values are synthetic. */
function prodShaped() {
  return {
    o01: { status: 'pending_payment', total: 5000, orderTotal: 5000, hub: 'marketplace', createdAt: T(BASE_MS + 1000) },
    o02: { status: 'pending_payment', total: 250, paymentStatus: 'paid', createdAt: T(BASE_MS + 2000) },        /* buyer-written paymentStatus */
    o03: { status: 'paid', paymentVerified: true, paidAmount: 1500, total: 1500, createdAt: T(BASE_MS + 3000) },
    o04: { status: 'confirmed', paymentVerified: true, paidAmount: 2000, total: 2000, createdAt: T(BASE_MS + 4000) },
    o05: { status: 'confirmed', paymentVerified: true, paidAmount: 999.5, total: 999.5, createdAt: T(BASE_MS + 5000) },
    o06: { status: 'confirmed', paymentVerified: true, sessionId: 'sess6', total: 3000, settlementStatus: 'HELD', createdAt: T(BASE_MS + 6000) },   /* VIP (server-created) */
    o07: { status: 'confirmed', paymentVerified: true, paidAmount: 500, total: 99999, createdAt: T(BASE_MS + 7000) },   /* buyer total ≠ provider amount */
    o08: { status: 'confirmed', paymentVerified: true, total: 7000, createdAt: T(BASE_MS + 8000) },                     /* PV, no paidAmount, not server-created */
    o09: { status: 'in_transit', paymentVerified: true, paidAmount: 1200, total: 1200, createdAt: T(BASE_MS + 9000) },
    o10: { status: 'delivered', paymentVerified: true, paidAmount: 800, total: 800, createdAt: T(BASE_MS + 10000) },
  };
}
const ZERO_BUCKETS = ['total', 'placed', 'awaitingPayment', 'paidStatusUnverified', 'outstanding', 'acceptedProcessing',
  'paidNotYetAccepted', 'completed', 'cancelled', 'cancelledRefundDue', 'refundedLabelled', 'other'];
const summary = async (orders, opts, auth) => { H.setDb(fakeDb({ orders }, opts)); return call('adminOrdersSummary', { op: 'adminOrdersSummary' }, auth); };
const failWhen = (pred, code) => ({ fail: (d) => (pred(d) ? (code || 9) : 0) });
const hasFilter = (d, f, op, v) => d.filters.some(([a, o, b]) => a === f && o === op && (v === undefined || b === v));

(async () => {
  console.log('\nAdminOS Orders server contract\n');

  /* ── S-1 real summary on the production shape ───────────────────────────────────────── */
  {
    const { r, err } = await summary(prodShaped());
    const b = r && r.buckets;
    ck('S-1a', !err && b && b.total === 10 && b.placed === 8, 'real summary: total 10, placed (PV) 8', r || err);
    ck('S-1b', b && b.awaitingPayment === 2 && b.outstanding === 2 && b.paidStatusUnverified === 0, 'pending_payment ×2 → awaitingPayment 2 = outstanding 2', b);
    ck('S-1c', b && b.acceptedProcessing === 8 && b.paidNotYetAccepted === 1, 'paid/confirmed/in_transit/delivered → acceptedProcessing 8 (paid 1 of them)', b);
    ck('S-1d', b && b.completed === 0 && b.cancelled === 0 && b.cancelledRefundDue === 0 && b.refundedLabelled === 0 && b.other === 0, 'empty buckets are REAL zeros from successful aggregates', b);
    ck('S-1e', r && r.revenue.kes === 9999.5 && r.revenue.pricedCount === 7 && r.revenue.unpricedCount === 1,
      'revenue = Σ paidAmount (7000... incl. 999.5) + VIP server total 3000 = 9999.5 KES; 7 priced, 1 unpriced', r && r.revenue);
    ck('S-1f', r && r.errors && Object.keys(r.errors).length === 0 && r.currency === 'KES' && typeof r.asOf === 'string' && r.scope.foreignKindCount === 0,
      'no errors, KES, asOf, scope foreignKindCount 0', r && { errors: r.errors, scope: r.scope });
    ck('S-1g', b && b.total === b.outstanding + b.cancelled + b.refundedLabelled + b.acceptedProcessing + b.completed + b.other,
      'buckets partition Total exactly (outstanding+cancelled+refunded+accepted+completed+other)', b);
    const r2 = await summary(prodShaped(), undefined, SUPER);
    ck('S-1h', !r2.err && r2.r.buckets.total === 10, 'superAdmin is admitted (same gate as siblings)', r2.err);
  }

  /* ── S-2 genuinely empty ───────────────────────────────────────────────────────────────── */
  {
    const { r, err } = await summary({});
    ck('S-2', !err && ZERO_BUCKETS.every((k) => r.buckets[k] === 0) && r.revenue.kes === 0 && r.revenue.pricedCount === 0 && r.revenue.unpricedCount === 0 && Object.keys(r.errors).length === 0,
      'genuinely empty collection → every bucket a real 0, no errors', r || err);
  }

  /* ── S-3 unreadable bucket → null + reason, NEVER 0 ───────────────────────────────────── */
  {
    const { r, err } = await summary(prodShaped(), failWhen((d) => d.kind === 'count' && hasFilter(d, 'status', '==', 'cancelled') && !hasFilter(d, 'paymentVerified', '==')));
    ck('S-3a', !err && isNull(r.buckets.cancelled) && /UNREADABLE/.test(r.errors.cancelled || '') && /FAILED_PRECONDITION/.test(r.errors.cancelled || ''),
      'a failed status count → cancelled = null with reason (not 0)', r && { b: r.buckets, e: r.errors });
    ck('S-3b', r && isNull(r.buckets.outstanding) && !!r.errors.outstanding, 'a bucket DERIVED from the failed count is null too', r && r.buckets);
    ck('S-3c', r && r.buckets.total === 10 && r.buckets.acceptedProcessing === 8 && r.buckets.awaitingPayment === 2, 'unaffected buckets still answer', r && r.buckets);
    ck('S-3d', r && Object.values(r.buckets).every((v) => v === null || (typeof v === 'number' && v >= 0)) && !Object.entries(r.buckets).some(([k, v]) => v === 0 && r.errors[k]),
      'no bucket is 0 while carrying an error', r && r.buckets);
  }
  {
    const { r } = await summary(prodShaped(), failWhen((d) => d.kind === 'aggregate', 14));
    ck('S-3e', r && isNull(r.buckets.placed) && isNull(r.revenue.kes) && isNull(r.revenue.pricedCount) && /UNAVAILABLE/.test(r.errors.revenue || '') && isNull(r.buckets.other),
      'PV aggregate unavailable → placed, revenue, other all null with reasons', r && { b: r.buckets, rev: r.revenue, e: r.errors });
    const t = await summary(prodShaped(), failWhen((d) => d.kind === 'count' && d.filters.length === 0 && d.orders.length === 0, 4));
    ck('S-3f', t.r && isNull(t.r.buckets.total) && /DEADLINE_EXCEEDED/.test(t.r.errors.total || '') && isNull(t.r.buckets.outstanding),
      'total count timed out → total null + reason; outstanding null', t.r && { b: t.r.buckets, e: t.r.errors });
    const all = await summary(prodShaped(), { fail: () => 14 });
    ck('S-3g', all.r && Object.values(all.r.buckets).every(isNull) && isNull(all.r.revenue.kes) && Object.keys(all.r.errors).length >= ZERO_BUCKETS.length,
      'every read failing → every figure null (never a dashboard of zeros)', all.r && all.r.buckets);
    const fb = await summary(prodShaped(), failWhen((d) => d.kind === 'get' && hasFilter(d, 'sessionId', '>'), 14));
    ck('S-3h', fb.r && fb.r.revenue.kes === 6999.5 && fb.r.revenue.unpricedCount === 2 && !!fb.r.errors.revenueFallback,
      'fallback read failing → VIP order counted as UNPRICED (kes 6999.5, unpriced 2) with reason — not dropped silently', fb.r && { rev: fb.r.revenue, e: fb.r.errors });
  }

  /* ── S-4 verified vs unverified / fake client paid ────────────────────────────────────── */
  {
    const o = prodShaped();
    o.f1 = { status: 'paid', paymentStatus: 'paid', paidAmount: 50000, total: 50000, paidAt: T(1), createdAt: T(BASE_MS + 11000) };   /* seller/buyer-forged paid, no PV */
    const { r } = await summary(o);
    ck('S-5', r && r.revenue.kes === 9999.5 && r.buckets.placed === 8, 'fake client paid (status paid, paidAmount, no PV) adds NOTHING to revenue or placed', r && { rev: r.revenue, b: r.buckets });
    ck('S-5b', r && r.buckets.paidStatusUnverified === 1 && r.buckets.outstanding === 3 && r.buckets.acceptedProcessing === 8,
      "status 'paid' && !PV → paidStatusUnverified 1, counted as outstanding, NOT accepted", r && r.buckets);
  }

  /* ── S-6 buyer-written total never revenue ─────────────────────────────────────────────── */
  {
    const o = {
      b1: { status: 'confirmed', paymentVerified: true, paidAmount: 10, total: 10000, createdAt: T(1) },           /* KES 1→10k class: paidAmount is truth */
      b2: { status: 'confirmed', paymentVerified: true, total: 8000, createdAt: T(2) },                           /* no paidAmount, no sessionId */
      b3: { status: 'pending_payment', sessionId: 'forged', total: 9000, createdAt: T(3) },                       /* forged sessionId, not PV */
      b4: { status: 'confirmed', paymentVerified: true, sessionId: 's', paidAmount: 20, total: 70000, createdAt: T(4) },   /* has paidAmount → never the fallback */
    };
    const { r } = await summary(o);
    ck('S-6', r && r.revenue.kes === 30 && r.revenue.pricedCount === 2 && r.revenue.unpricedCount === 1,
      'only paidAmount (10+20) is revenue; buyer totals 10000/8000/9000/70000 never counted; 1 unpriced', r && r.revenue);
  }

  /* ── S-7 / S-8 cancelled, cancelled + PV ───────────────────────────────────────────────── */
  {
    const o = { c1: { status: 'cancelled', total: 400, createdAt: T(1) }, c2: { status: 'cancelled', paymentVerified: true, paidAmount: 700, createdAt: T(2) },
      c3: { status: 'canceled', createdAt: T(3) } };
    const { r } = await summary(o);
    ck('S-7', r && r.buckets.cancelled === 3 && r.buckets.outstanding === 0 && r.buckets.awaitingPayment === 0, 'cancelled (both spellings) → cancelled 3, not outstanding', r && r.buckets);
    ck('S-8', r && r.buckets.cancelledRefundDue === 1 && r.buckets.acceptedProcessing === 0 && r.buckets.other === 0 && r.revenue.kes === 700,
      'cancelled && PV → cancelledRefundDue 1 (money held; revenue not netted, O-5)', r && { b: r.buckets, rev: r.revenue });
  }

  /* ── S-9 unpaid order / refunded label ─────────────────────────────────────────────────── */
  {
    const o = { u1: { status: 'pending', createdAt: T(1) }, u2: { status: 'payment_failed', createdAt: T(2) }, u3: { status: 'confirmed', createdAt: T(3) },
      r1: { status: 'refunded', paymentVerified: true, paidAmount: 90, createdAt: T(4) }, r2: { status: 'refunded', createdAt: T(5) } };
    const { r } = await summary(o);
    ck('S-9', r && r.buckets.awaitingPayment === 2 && r.buckets.outstanding === 3 && r.buckets.acceptedProcessing === 0,
      'unpaid orders → awaitingPayment 2; an UNPAID "confirmed" (seller-forged) is outstanding, never accepted', r && r.buckets);
    ck('S-9b', r && r.buckets.refundedLabelled === 2 && r.buckets.other === 0 && r.buckets.total === 5, 'refunded → refundedLabelled (label bucket)', r && r.buckets);
  }

  /* ── S-15 scope (O-2) ──────────────────────────────────────────────────────────────────── */
  {
    const o = prodShaped(); o.o03.kind = 'product'; o.o04.kind = null;
    const ok = await summary(o);
    ck('S-15a', ok.r && ok.r.buckets.total === 10 && ok.r.scope.foreignKindCount === 0, "kind 'product' and kind null stay in scope", ok.r && ok.r.scope);
    o.x1 = { status: 'confirmed', kind: 'booking', paymentVerified: true, paidAmount: 5, createdAt: T(1) };
    const bad = await summary(o);
    ck('S-15b', bad.r && Object.values(bad.r.buckets).every(isNull) && isNull(bad.r.revenue.kes) && /SCOPE_FOREIGN_KIND/.test(bad.r.errors.total || '') && bad.r.scope.foreignKindCount === 1,
      'a foreign kind in orders → every figure withheld with SCOPE_FOREIGN_KIND (never mixed in)', bad.r && { b: bad.r.buckets, s: bad.r.scope });
  }

  /* ── S-10 authorization before any read ───────────────────────────────────────────────── */
  {
    for (const [id, auth, label] of [['S-10', { uid: 'u1', token: {} }, 'signed-in non-admin'], ['S-10b', null, 'unauthenticated'], ['S-10c', { uid: 'u2', token: { seller: true, admin: false } }, 'seller']]) {
      const db = fakeDb({ orders: prodShaped() }); H.setDb(db);
      const res = await call('adminOrdersSummary', {}, auth);
      ck(id, res.err === 'permission-denied' && db._reads.length === 0, label + ' → permission-denied before ANY read', { err: res.err, reads: db._reads.length });
    }
    const db = fakeDb({ orders: prodShaped() }); H.setDb(db);
    const g = await call('adminGetOrders', {}, { uid: 'u1', token: {} });
    ck('S-10d', g.err === 'permission-denied' && db._reads.length === 0, 'adminGetOrders: non-admin → permission-denied before any read', g);
    const u = await call('adminUpdateOrderStatus', { orderId: 'o03', status: 'confirmed' }, { uid: 'u1', token: {} });
    ck('S-10e', u.err === 'permission-denied' && db._reads.length === 0 && db._writes.length === 0, 'adminUpdateOrderStatus: non-admin → permission-denied, nothing read or written', u);
  }

  /* ── S-11 malformed requests ───────────────────────────────────────────────────────────── */
  {
    H.setDb(fakeDb({ orders: prodShaped() }));
    const rows = [
      ['S-11a', 'adminOrdersSummary', { since: '2026-01-01' }, 'summary takes no parameters'],
      ['S-11b', 'adminOrdersSummary', [1, 2], 'summary: array payload'],
      ['S-11c', 'adminGetOrders', { limit: 'abc' }, 'list: non-numeric limit'],
      ['S-11d', 'adminGetOrders', { limit: 0 }, 'list: limit 0'],
      ['S-11e', 'adminGetOrders', { status: 'banana' }, 'list: unknown status filter'],
      ['S-11f', 'adminGetOrders', { status: { $ne: 1 } }, 'list: object as status'],
      ['S-11g', 'adminGetOrders', { cursor: 'not-a-cursor' }, 'list: malformed cursor'],
      ['S-11h', 'adminGetOrders', { cursor: Buffer.from(JSON.stringify({ v: 1, id: 'a/b' })).toString('base64url') }, 'list: cursor with a path'],
      ['S-11i', 'adminGetOrders', { hubType: 'food' }, 'list: hubType (was a partial in-memory filter) refused'],
      ['S-11j', 'adminUpdateOrderStatus', { orderId: 'o03' }, 'update: missing status'],
      ['S-11k', 'adminUpdateOrderStatus', { orderId: ['o03'], status: 'shipped' }, 'update: non-string orderId'],
      ['S-11l', 'adminUpdateOrderStatus', { orderId: 'o03', status: 'shipped', note: { x: 1 } }, 'update: non-string note'],
    ];
    for (const [id, op, data, label] of rows) { const res = await call(op, data); ck(id, res.err === 'invalid-argument', label + ' → invalid-argument', res); }
  }

  /* ── S-12 cursor pagination ────────────────────────────────────────────────────────────── */
  {
    const o = {};
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    ids.forEach((id, i) => { o[id] = { status: 'confirmed', paymentVerified: true, createdAt: T(BASE_MS + (i < 4 ? 5000 : i * 1000)) }; });   /* p1..p4 share a timestamp */
    o.nots = { status: 'confirmed' };   /* no createdAt — not listable */
    H.setDb(fakeDb({ orders: o }));
    const seen = []; let cursor = null, pages = 0, okShape = true, last = null;
    do {
      const res = await call('adminGetOrders', cursor ? { limit: 3, cursor } : { limit: 3 });
      if (res.err) { okShape = false; last = res; break; }
      pages++; seen.push(...res.r.orders.map((x) => x.id)); cursor = res.r.nextCursor;
      okShape = okShape && Array.isArray(res.r.orders) && res.r.scope && res.r.scope.collection === 'orders' && res.r.orders.length <= 3;
    } while (cursor && pages < 10);
    const expect = ['p7', 'p6', 'p4', 'p3', 'p2', 'p1', 'p5'];   /* createdAt desc (p7 6000 > p1-p4,p6 5000 > p5 4000), id desc on ties */
    ck('S-12a', okShape && pages === 3 && JSON.stringify(seen) === JSON.stringify(expect), 'cursor walks every listable order exactly once, createdAt desc + id desc (ties included)', { seen, pages, last });
    const legacy = await call('adminGetOrders', {});
    ck('S-12b', !legacy.err && Array.isArray(legacy.r.orders) && legacy.r.orders.length === 7 && legacy.r.nextCursor === null && typeof legacy.r.orders[0].createdAt === 'string',
      'back-compat: no cursor → first page {orders[...ISO createdAt]}, nextCursor null at the end', legacy.err || legacy.r.nextCursor);
    const first = await call('adminGetOrders', { limit: 2 });
    H.getDb()._store.orders[first.r.orders[1].id] && delete H.getDb()._store.orders[first.r.orders[1].id];
    const stale = await call('adminGetOrders', { limit: 2, cursor: first.r.nextCursor });
    ck('S-12c', stale.err === 'failed-precondition' && stale.details && stale.details.reason === 'CURSOR_STALE', 'a cursor whose order was deleted → failed-precondition CURSOR_STALE', stale);
    const big = await call('adminGetOrders', { limit: 5000 });
    ck('S-12d', !big.err && big.r.scope.pageSize === 200, 'limit above 200 is clamped to 200 (as before)', big.err || big.r.scope);
  }

  /* ── S-13 status filter: missing index → clear FAILED_PRECONDITION ─────────────────────── */
  {
    const needsIdx = failWhen((d) => d.kind === 'get' && hasFilter(d, 'status', '==') && d.orders.some(([f, dir]) => f === 'createdAt' && dir === 'desc'), 9);
    H.setDb(fakeDb({ orders: prodShaped() }, needsIdx));
    const res = await call('adminGetOrders', { status: 'confirmed' });
    ck('S-13a', res.err === 'failed-precondition' && res.details && res.details.reason === 'INDEX_REQUIRED' && /status ASC, createdAt DESC/.test(res.msg),
      'status filter without the (status ASC, createdAt DESC) index → failed-precondition naming the index (not internal)', res);
    const unf = await call('adminGetOrders', {});
    ck('S-13b', !unf.err && unf.r.orders.length === 10, 'the unfiltered list still works without the index', unf.err);
    H.setDb(fakeDb({ orders: prodShaped() }));
    const withIdx = await call('adminGetOrders', { status: 'confirmed' });
    ck('S-13c', !withIdx.err && withIdx.r.orders.length === 5 && withIdx.r.orders.every((x) => x.status === 'confirmed') && withIdx.r.scope.status === 'confirmed',
      'with the index present the filter is applied IN the query (5 confirmed, scope.status)', withIdx.err || withIdx.r.scope);
    H.setDb(fakeDb({ orders: prodShaped() }, { fail: (d) => (d.kind === 'get' ? 14 : 0) }));
    const down = await call('adminGetOrders', {});
    ck('S-13d', down.err === 'unavailable', 'any other read failure → unavailable (never an empty list)', down);
  }

  /* ── S-14 status update refusals (O-13 + payment/refund authority) ─────────────────────── */
  {
    const set = async (order, status) => {
      const db = fakeDb({ orders: { O: order } }); H.setDb(db);
      const res = await call('adminUpdateOrderStatus', { orderId: 'O', status });
      return { res, after: db._store.orders.O.status, db };
    };
    let x = await set({ status: 'confirmed', paymentVerified: true }, 'banana');
    ck('S-14a', x.res.err === 'invalid-argument' && Array.isArray(x.res.details && x.res.details.allowed) && x.after === 'confirmed' && !x.db._reads.some((r) => r.col === 'orders'),
      'unknown status → invalid-argument with the allowed list, order not even read', x.res);
    ck('S-14b', Object.values(x.db._store.adminAudit || {}).some((a) => a.action === 'order_status_refused' && a.reason === 'UNKNOWN_STATUS'), 'the unknown-status refusal is audited');
    x = await set({ status: 'pending_payment' }, 'paid');
    ck('S-14c', x.res.err === 'failed-precondition' && x.res.details.reason === 'PAYMENT_AUTHORITY_ONLY' && x.after === 'pending_payment', "'paid' is refused (webhook/verify only), order unchanged", x.res);
    x = await set({ status: 'delivered', paymentVerified: true, deliveredAt: 1, settlementStatus: 'REFUNDED' }, 'refunded');
    ck('S-14d', x.res.err === 'failed-precondition' && x.res.details.reason === 'REFUND_AUTHORITY_ONLY' && x.after === 'delivered', "'refunded' is refused even with refund evidence (refund authority only)", x.res);
    x = await set({ status: 'pending_payment', paymentStatus: 'paid' }, 'confirmed');
    ck('S-14e', x.res.err === 'failed-precondition' && x.res.details.reason === 'NOT_PAID' && x.after === 'pending_payment', 'buyer-written paymentStatus "paid" (no PV) does NOT unlock fulfilment', x.res);
    x = await set({ status: 'pending_payment' }, 'awaiting_payment_attestation');
    ck('S-14f', x.res.err === 'failed-precondition' && x.res.details.reason === 'NOT_ADMIN_SETTABLE', 'a known status owned by another authority → NOT_ADMIN_SETTABLE', x.res);
    x = await set({ status: 'confirmed', paymentVerified: true }, ' Shipped ');
    ck('S-14g', !x.res.err && x.after === 'shipped', 'CONTROL: a verified-paid order moves forward (confirmed → shipped)', x.res);
  }

  /* ── S-16 executive dashboard + finance: order figures null on failure, never 0 ────────── */
  {
    H.setDb(fakeDb({ orders: prodShaped() }, failWhen((d) => d.col === 'orders' && (d.kind === 'count' || d.kind === 'get'), 14)));
    const ex = await call('adminGetExecutiveDashboard', {});
    ck('S-16a', !ex.err && ['totalOrders', 'activeOrders', 'ordersToday', 'activeDeliveries'].every((k) => ex.r[k] === null && /UNREADABLE/.test(ex.r.errors[k] || '')),
      'exec dashboard: failed order counts → null + errors[field] (was 0)', ex.err || ex.r);
    const fin = await call('adminGetFinance', {});
    ck('S-16b', !fin.err && fin.r.reconciliation.productRevenue === null && fin.r.reconciliation.grossRevenue === null && fin.r.reconciliation.netPlatformRevenue === null && fin.r.capped.orders === null && /UNREADABLE/.test(fin.r.errors.orders || ''),
      'finance: failed orders read → productRevenue/grossRevenue/net null + errors.orders (was KES 0)', fin.err || fin.r.reconciliation);
    H.setDb(fakeDb({ orders: prodShaped() }));
    const ok = await call('adminGetExecutiveDashboard', {});
    ck('S-16c', !ok.err && ok.r.totalOrders === 10 && ok.r.activeOrders === 5 && Object.keys(ok.r.errors).length === 0, 'CONTROL: exec dashboard answers real counts (activeOrders legacy definition kept, O-8)', ok.err || ok.r);
    const okf = await call('adminGetFinance', {});
    ck('S-16d', !okf.err && typeof okf.r.reconciliation.productRevenue === 'number' && Object.keys(okf.r.errors).length === 0, 'CONTROL: finance answers a number when the read succeeds', okf.err || okf.r.errors);
  }

  /* ── S-17 dispatcher surface ───────────────────────────────────────────────────────────── */
  ck('S-17', typeof AOS._h.adminOrdersSummary === 'function' && AOS.adminOrdersSummary === undefined,
    'adminOrdersSummary is a dispatcher op only (no new standalone Cloud Function export)');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
