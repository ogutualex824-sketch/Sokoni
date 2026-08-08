/* ════════════════════════════════════════════════════════════════════════
   SOKONI AnalyticsEngine (R1.1 Phase 4) — ONE aggregation layer.

     OrderService (unified event stream)
            │
            ▼
     AnalyticsEngine.compute(range)
            │
     ┌──────┼───────┬────────┐
     ▼      ▼       ▼        ▼
  Dashboard Reports Finance Analytics   ← all call the SAME functions

   No screen calculates revenue independently. Every metric is traceable:
     source → event → normalization (OrderService) → aggregation (here) → UI.
   Loaded by merchant.html; exposes window.SokoniAnalyticsEngine.
   ════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  function _num (n) { return Number(n || 0); }

  /* Aggregate a set of UnifiedOrderView rows into the canonical metric bundle. */
  function aggregate (orders) {
    var a = {
      revenue: 0, orders: orders.length, aov: 0,
      pos:    { count: 0, revenue: 0 },
      online: { count: 0, revenue: 0 },
      channels: { in_store: 0, online: 0, delivery: 0, pickup: 0 },
      pending: 0, completed: 0, cancelled: 0, refunded: 0, returned: 0,
      tax: 0, discount: 0, deliveryFees: 0,
      paymentMethods: {}, products: {}, customers: {},
      netRevenue: 0, grossProfit: null,   /* profit needs cost data → null (never fabricated) */
    };
    orders.forEach(function (o) {
      var live = o.status !== 'cancelled';
      if (live) a.revenue += o.total;
      if (o.source === 'pos') { a.pos.count++; if (live) a.pos.revenue += o.total; }
      else                    { a.online.count++; if (live) a.online.revenue += o.total; }
      if (a.channels[o.channel] != null) a.channels[o.channel]++;
      if (o.status === 'pending')   a.pending++;
      if (o.status === 'completed') a.completed++;
      if (o.status === 'cancelled') a.cancelled++;
      if (o.status === 'refunded')  a.refunded++;
      if (o.status === 'returned')  a.returned++;
      a.tax += o.tax; a.discount += o.discount; a.deliveryFees += o.deliveryFee;
      var pm = String(o.paymentMethod || 'other').toLowerCase();
      a.paymentMethods[pm] = _num(a.paymentMethods[pm]) + (live ? o.total : 0);
      (o.items || []).forEach(function (i) {
        var k = i.name || 'Item'; var p = a.products[k] || { qty: 0, revenue: 0 };
        p.qty += _num(i.qty || 1); p.revenue += _num(i.price) * _num(i.qty || 1); a.products[k] = p;
      });
      var c = o.customer || 'Walk-in'; var cc = a.customers[c] || { orders: 0, spend: 0 };
      cc.orders++; cc.spend += (live ? o.total : 0); a.customers[c] = cc;
    });
    var paid = a.orders - a.cancelled;
    a.aov = paid ? Math.round(a.revenue / paid) : 0;
    a.netRevenue = a.revenue;               /* net of platform fee is applied downstream; here = gross sales */
    a.topProducts = Object.keys(a.products).map(function (k) { return { name: k, qty: a.products[k].qty, revenue: a.products[k].revenue }; })
      .sort(function (x, y) { return y.revenue - x.revenue; }).slice(0, 10);
    a.topCustomers = Object.keys(a.customers).map(function (k) { return { name: k, orders: a.customers[k].orders, spend: a.customers[k].spend }; })
      .sort(function (x, y) { return y.spend - x.spend; }).slice(0, 10);
    a.slowMovers = a.topProducts.slice().sort(function (x, y) { return x.qty - y.qty; }).slice(0, 5);
    return a;
  }

  /* Compute for a range ('today' | 'week' | 'month' | 'all') from the ONE OrderService. */
  async function compute (opts) {
    opts = opts || {};
    var OS = root.SokoniOrderService;
    if (!OS || !OS.query) return null;
    var orders = await OS.query({ range: opts.range || 'today', tab: 'all' });
    var out = aggregate(orders);
    out.range = opts.range || 'today';
    out._orders = orders;                   /* traceability: which rows produced these numbers */
    return out;
  }

  root.SokoniAnalyticsEngine = { compute: compute, aggregate: aggregate };
})(typeof window !== 'undefined' ? window : this);
