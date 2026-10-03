/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — AdminOS Orders (Marketplace → Orders), owner reference layout 2026-10-04
   ------------------------------------------------------------------------------
   Mounted by sokoni-aos.js `_marketplaceTab('orders')` into #mktBody. Self-contained:
   its own scoped stylesheet (.aoo-*), its own states, no globals beyond
   window.SokoniAOSOrders. Style follows the Platform Health redesign (dark panels,
   header row, KPI cards, honest states). No sidebar, no brand block, no avatars.

   SERVER CONTRACT (serving archive adminosdispatch-00025-muh, source generation
   1788271885523075; getordertrends-00015-yuw, 1787384443385861). Census:
   docs/ADMINOS_ORDERS_REDESIGN.md.

     adminGetOrders (dispatch op, admin || superAdmin, App Check)
       in  { status?, limit? }        limit is capped at 200 by the server
       out { orders:[{ id, ...orderDoc, createdAt: ISO|null }] }
       NO total, NO counts, NO cursor. `status` is an exact equality filter.
       `hubType` is applied in memory AFTER the limit (a partial page) → not offered.
     adminGetExecutiveDashboard → totalOrders (orders.count()), activeOrders
       (count of status in pending|processing|confirmed). Each count is .catch(()=>0)
       on the server, so a 0 there is shown as an UNCONFIRMED zero.
     adminGetFinance → reconciliation.productRevenue, window '30d' (≤3,000 orders,
       paid|completed|delivered|fulfilled, `total` as recorded at checkout).
     getOrderTrends {days:30} → trends:[{date, orders, gmv, failed}], ≤2,000 orders,
       missing days filled with 0. Only `orders` is drawn: `gmv` sums `amount`, a field
       marketplace orders do not write. When the series sums to the cap the line is
       withheld (truncated by the server).
     adminUpdateOrderStatus { orderId, status } — the server writes adminAudit.

   UI DATA INTEGRITY (CLAUDE.md): every figure is a server field. No client sums,
   averages, counts or deltas. Unknown → "—". Paging walks the rows the server
   returned and says so ("of N loaded"); it never claims a total.

   NOT OFFERED (and why — see the census): Create Order / Duplicate Order (no
   canonical admin order creation), Export (no order export service), Request
   Refund (no live request-for-approval op; refundRequests EXECUTES a wallet credit
   on create and is never written from a UI), Resend Receipt (no order-receipt
   resend op), date/channel/carrier/payment filters (server cannot apply them).

   Plain IIFE: classic <script> (window.SokoniAOSOrders) and Node (module.exports)
   so scripts/test-aos-orders.js runs it without a browser.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var DASH = '—';
  var TIMEOUT_MS = 45000;
  var PAGE_SIZE = 10;
  var LIMIT_STEP = 50;
  var SERVER_LIMIT_CAP = 200;      /* adminGetOrders: Math.min(limit || 50, 200) */
  var TRENDS_DAYS = 30;
  var TRENDS_CAP = 2000;           /* getOrderTrends: .limit(2000) */
  var KPI_CACHE_MS = 5 * 60 * 1000;

  /* Exact server `status` equality values (firestore.rules validOrderStatus). No counts:
     the server returns none. */
  var TABS = [
    { id: '',                label: 'All' },
    { id: 'pending',         label: 'Pending' },
    { id: 'pending_payment', label: 'Pending payment' },
    { id: 'paid',            label: 'Paid' },
    { id: 'processing',      label: 'Processing' },
    { id: 'shipped',         label: 'Shipped' },
    { id: 'delivered',       label: 'Delivered' },
    { id: 'completed',       label: 'Completed' },
    { id: 'cancelled',       label: 'Cancelled' },
    { id: 'refunded',        label: 'Refunded' },
  ];
  /* What adminUpdateOrderStatus may be asked to set (rules vocabulary). */
  var STATUS_CHOICES = ['pending', 'processing', 'confirmed', 'shipped', 'out_for_delivery',
    'delivered', 'completed', 'cancelled', 'refunded'];

  var TONE = {
    paid: 'good', completed: 'good', delivered: 'good', confirmed: 'good',
    processing: 'info', shipped: 'info', out_for_delivery: 'info', in_transit: 'info',
    rider_assigned: 'info', rider_en_route: 'info', picked_up: 'info',
    pending: 'warn', pending_payment: 'warn', awaiting_confirmation: 'warn',
    cancelled: 'bad', refunded: 'bad', payment_failed: 'bad',
  };

  /* ── helpers ─────────────────────────────────────────────────────────────────── */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : ''; }
  function group(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtInt(v) {
    if (!isNum(v)) return DASH;
    var n = Math.round(v);
    return (n < 0 ? '-' : '') + group(String(Math.abs(n)));
  }
  /* KES with up to 2 decimals, thousands grouped. Never abbreviated (1.2K hides money). */
  function fmtKES(v) {
    if (!isNum(v)) return DASH;
    var neg = v < 0, a = Math.abs(v);
    var cents = Math.round(a * 100);
    var whole = Math.floor(cents / 100), frac = cents % 100;
    return (neg ? '-' : '') + 'KES ' + group(String(whole)) + (frac ? '.' + (frac < 10 ? '0' : '') + frac : '');
  }
  function label(s) {
    s = str(s);
    if (!s) return DASH;
    s = s.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  /* Accepts what the callable can send: ISO string, epoch ms, {_seconds}, {seconds}. */
  function tsMs(v) {
    if (v == null) return null;
    if (typeof v === 'string') { var p = Date.parse(v); return isNaN(p) ? null : p; }
    if (isNum(v)) return v > 1e11 ? v : v * 1000;
    if (typeof v === 'object') {
      if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return null; } }
      if (isNum(v._seconds)) return v._seconds * 1000;
      if (isNum(v.seconds)) return v.seconds * 1000;
    }
    return null;
  }
  function timeHtml(v, withTime) {
    var ms = tsMs(v);
    if (ms == null) return DASH;
    var d = new Date(ms), txt;
    try {
      txt = withTime ? d.toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                     : d.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (_) { txt = d.toISOString(); }
    return '<time datetime="' + esc(d.toISOString()) + '">' + esc(txt) + '</time>';
  }
  function first() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'string' ? v.trim() : (v != null)) return v;
    }
    return null;
  }
  function initials(name) {
    var parts = str(name).split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }

  function withTimeout(promise, ms, what) {
    var limit = isNum(ms) && ms > 0 ? ms : TIMEOUT_MS, timer;
    var t = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        var e = new Error((what || 'The request') + ' did not respond within ' + Math.round(limit / 1000) + 's.');
        e.code = 'deadline-exceeded';
        reject(e);
      }, limit);
    });
    return Promise.race([Promise.resolve(promise), t]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; });
  }
  function describeError(err) {
    var code = String((err && err.code) || 'unknown').replace(/^functions\//, '');
    var msg = String((err && err.message) || '').trim();
    var lead;
    if (code === 'permission-denied') lead = 'Admin or Super Admin access required.';
    else if (code === 'unauthenticated') lead = 'Your session has expired. Sign in again.';
    else if (code === 'deadline-exceeded') lead = 'The orders service timed out.';
    else if (code === 'unavailable') lead = 'The orders service is unreachable.';
    else if (code === 'failed-precondition') lead = 'The orders service could not run this query.';
    else lead = 'The orders service returned an error.';
    return { code: code, lead: lead, message: msg && msg !== lead ? msg : '' };
  }

  /* ── order field readers (order doc only; nothing composed from other collections) ── */
  function orderTotal(o) { var v = first(o.total, o.orderTotal, o.pricing && o.pricing.total); return isNum(v) ? v : null; }
  function orderSubtotal(o) { var v = first(o.subtotal, o.pricing && o.pricing.subtotal); return isNum(v) ? v : null; }
  function orderDeliveryFee(o) { var v = first(o.deliveryFee, o.pricing && o.pricing.deliveryFee); return isNum(v) ? v : null; }
  function orderChannel(o) { return str(first(o.hub, o.hubType, o.type, o.channel)); }
  function buyerName(o) { return str(first(o.buyerName, o.name)); }
  function buyerEmail(o) { return str(first(o.buyerEmail, o.email)); }
  function buyerPhone(o) { return str(first(o.buyerPhone, o.phone)); }
  function buyerUid(o) { return str(first(o.buyerUid, o.uid, o.userId, o.buyerId)); }
  function itemsOf(o) { return Array.isArray(o.items) ? o.items.filter(function (i) { return i && typeof i === 'object'; }) : null; }
  function verified(o) { return o.paymentVerified === true; }

  function pill(status) {
    var s = str(status);
    return '<span class="aoo-pill ' + (TONE[s] || 'neutral') + '">' + esc(label(s)) + '</span>';
  }

  /* ── CSS (scoped; Platform Health palette) ─────────────────────────────────────── */
  var CSS = [
    '.aoo-root{--o-bg:#0b0d17;--o-panel:#12152a;--o-panel-2:#171b33;--o-border:rgba(255,255,255,.08);--o-text:#f4f5fb;--o-muted:#9aa0b8;--o-faint:#8a90ab;--o-accent:#6d5dfc;--o-accent-2:#8b7dff;--o-good:#22c55e;--o-warn:#f59e0b;--o-bad:#ef4444;--o-info:#3b82f6;--o-radius:14px;',
    'color:var(--o-text);background:var(--o-bg);border-radius:var(--o-radius);padding:20px 16px 28px;font-family:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.45;min-width:0;max-width:100%;overflow-x:hidden;position:relative}',
    '.aoo-root *,.aoo-root *::before,.aoo-root *::after{box-sizing:border-box}',
    '.aoo-root :focus-visible{outline:2px solid var(--o-accent-2);outline-offset:2px;border-radius:6px}',
    '.aoo-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '.aoo-top{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px 20px;margin-bottom:18px}',
    '.aoo-top-main{flex:1 1 260px;min-width:0}',
    '.aoo-top h2{font-size:1.5rem;font-weight:700;letter-spacing:-.01em;margin:0;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
    '.aoo-count{font-size:.85rem;font-weight:600;color:var(--o-muted);background:var(--o-panel-2);border:1px solid var(--o-border);border-radius:999px;padding:2px 10px}',
    '.aoo-sub{color:var(--o-muted);font-size:.88rem;margin:4px 0 0}',
    '.aoo-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:8px 16px;border-radius:10px;border:1px solid var(--o-border);background:var(--o-panel-2);color:var(--o-text);font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}',
    '.aoo-btn.primary{background:var(--o-accent);border-color:var(--o-accent)}',
    '.aoo-btn.sm{min-height:34px;padding:5px 12px;font-size:.8rem}',
    '.aoo-btn:hover:not(:disabled){filter:brightness(1.12)}.aoo-btn:disabled{opacity:.55;cursor:not-allowed}',
    '.aoo-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;margin-bottom:18px}',
    '.aoo-kpi{background:var(--o-panel);border:1px solid var(--o-border);border-radius:var(--o-radius);padding:16px;display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.aoo-kpi h3{font-size:.8rem;font-weight:500;color:var(--o-muted);margin:0}',
    '.aoo-kpi-num{font-size:1.7rem;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
    '.aoo-kpi-note{font-size:.74rem;color:var(--o-faint)}.aoo-kpi-note.bad{color:#fca5a5}.aoo-kpi-note.warn{color:#fcd34d}',
    '.aoo-spark{width:100%;height:30px;display:block}.aoo-spark polyline{fill:none;stroke:var(--o-accent-2);stroke-width:1.5;vector-effect:non-scaling-stroke}',
    '.aoo-card{background:var(--o-panel);border:1px solid var(--o-border);border-radius:var(--o-radius);padding:16px;min-width:0}',
    '.aoo-tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:10px;scrollbar-width:thin}',
    '.aoo-tab{flex:0 0 auto;min-height:36px;padding:6px 14px;border-radius:999px;border:1px solid var(--o-border);background:transparent;color:var(--o-muted);font:inherit;font-size:.82rem;font-weight:600;cursor:pointer}',
    '.aoo-tab[aria-selected="true"]{background:var(--o-accent);border-color:var(--o-accent);color:#fff}',
    '.aoo-filter-note{font-size:.76rem;color:var(--o-faint);margin:0 0 12px}',
    '.aoo-table-wrap{overflow-x:auto;max-width:100%}',
    '.aoo-table{width:100%;border-collapse:collapse;font-size:.84rem;font-variant-numeric:tabular-nums}',
    '.aoo-table th{text-align:left;padding:10px 10px;font-size:.72rem;font-weight:600;color:var(--o-muted);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--o-border);white-space:nowrap}',
    '.aoo-table td{padding:11px 10px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}',
    '.aoo-table tr.sel td{background:rgba(109,93,252,.08)}',
    '.aoo-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;overflow-wrap:anywhere}',
    '.aoo-dim{color:var(--o-faint);font-size:.75rem;display:block}',
    '.aoo-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:.74rem;font-weight:600;border:1px solid var(--o-border);background:var(--o-panel-2);white-space:nowrap}',
    '.aoo-pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}',
    '.aoo-pill.good{color:var(--o-good)}.aoo-pill.warn{color:var(--o-warn)}.aoo-pill.bad{color:var(--o-bad)}.aoo-pill.info{color:#93c5fd}.aoo-pill.neutral{color:var(--o-muted)}',
    '.aoo-tag{display:inline-block;font-size:.68rem;font-weight:600;padding:1px 7px;border-radius:6px;background:rgba(34,197,94,.14);color:#86efac;margin-left:4px}',
    '.aoo-tag.no{background:rgba(255,255,255,.06);color:var(--o-faint)}',
    '.aoo-pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;font-size:.8rem;color:var(--o-muted)}',
    '.aoo-pager-btns{display:flex;gap:8px;flex-wrap:wrap}',
    '.aoo-state{border:1px dashed rgba(255,255,255,.14);border-radius:12px;padding:28px 18px;text-align:center;color:var(--o-muted);font-size:.86rem}',
    '.aoo-state strong{display:block;color:var(--o-text);font-size:.95rem;margin-bottom:6px}',
    '.aoo-state.err strong{color:#fca5a5}.aoo-state p{margin:0 auto 10px;max-width:560px}',
    '.aoo-skel{height:44px;border-radius:10px;margin-bottom:8px;background:linear-gradient(90deg,var(--o-panel) 25%,rgba(255,255,255,.05) 37%,var(--o-panel) 63%);background-size:400% 100%;animation:aoosk 1.2s ease infinite}',
    '@keyframes aoosk{0%{background-position:100% 50%}100%{background-position:0 50%}}',
    '@media (prefers-reduced-motion:reduce){.aoo-skel{animation:none}}',
    /* drawer */
    '.aoo-scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:900}',
    '.aoo-drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,100%);background:var(--o-panel);border-left:1px solid var(--o-border);z-index:901;display:flex;flex-direction:column;color:var(--o-text);box-shadow:-12px 0 40px rgba(0,0,0,.45)}',
    '.aoo-drawer-head{display:flex;align-items:flex-start;gap:10px;padding:18px 16px 12px;border-bottom:1px solid var(--o-border)}',
    '.aoo-drawer-head h3{font-size:1.05rem;margin:0 0 4px;overflow-wrap:anywhere}',
    '.aoo-drawer-body{overflow-y:auto;padding:14px 16px 24px;display:flex;flex-direction:column;gap:14px}',
    '.aoo-sec{background:var(--o-panel-2);border:1px solid var(--o-border);border-radius:12px;padding:12px 14px}',
    '.aoo-sec h4{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--o-muted);margin:0 0 8px}',
    '.aoo-kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:.84rem;border-bottom:1px solid rgba(255,255,255,.05)}',
    '.aoo-kv:last-child{border-bottom:none}.aoo-kv span:first-child{color:var(--o-muted)}.aoo-kv span:last-child{text-align:right;overflow-wrap:anywhere;min-width:0}',
    '.aoo-kv.total span{font-weight:700;color:var(--o-text)}',
    '.aoo-chip{width:36px;height:36px;border-radius:50%;background:rgba(109,93,252,.2);color:#c4bcff;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;flex-shrink:0}',
    '.aoo-cust{display:flex;align-items:center;gap:10px;margin-bottom:6px}',
    '.aoo-items{list-style:none;margin:0;padding:0}.aoo-items li{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:.84rem}',
    '.aoo-items li:last-child{border-bottom:none}',
    '.aoo-note{font-size:.76rem;color:var(--o-faint);margin:6px 0 0}',
    '.aoo-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.aoo-select{min-height:38px;border-radius:10px;border:1px solid var(--o-border);background:var(--o-bg);color:var(--o-text);font:inherit;font-size:.84rem;padding:6px 10px;max-width:100%}',
    '.aoo-x{margin-left:auto;width:40px;height:40px;border-radius:10px;border:1px solid var(--o-border);background:transparent;color:var(--o-text);font-size:1.2rem;cursor:pointer;flex-shrink:0}',
    /* mobile: table → cards, drawer → full-screen sheet */
    '@media (max-width:768px){',
    '.aoo-root{padding:16px 16px 24px;border-radius:12px}',
    '.aoo-kpis{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}',
    '.aoo-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
    '.aoo-table,.aoo-table tbody,.aoo-table tr,.aoo-table td{display:block;width:100%}',
    '.aoo-table tr{background:var(--o-panel-2);border:1px solid var(--o-border);border-radius:12px;padding:8px 12px;margin-bottom:10px}',
    '.aoo-table td{border-bottom:none;padding:5px 0;display:flex;justify-content:space-between;gap:12px}',
    '.aoo-table td::before{content:attr(data-label);color:var(--o-faint);font-size:.74rem;flex-shrink:0}',
    '.aoo-table td>div{text-align:right;min-width:0}',
    '.aoo-drawer{width:100%;border-left:none}',
    '}',
  ].join('\n');

  function ensureStyle(doc) {
    if (!doc || typeof doc.getElementById !== 'function' || doc.getElementById('aoo-style')) return;
    var s = doc.createElement('style');
    s.id = 'aoo-style';
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  /* ── KPI rendering (server fields only) ──────────────────────────────────────── */
  function sparkHtml(trends) {
    if (!trends || !Array.isArray(trends.trends)) return '';
    var pts = trends.trends.filter(function (t) { return t && typeof t.date === 'string' && isNum(t.orders); });
    if (pts.length < 2) return '';
    var sum = pts.reduce(function (s, t) { return s + t.orders; }, 0);
    if (sum >= TRENDS_CAP) return '<span class="aoo-kpi-note warn" data-spark="withheld">Daily line withheld: the server stops at ' +
      fmtInt(TRENDS_CAP) + ' orders, so some days are incomplete.</span>';
    var max = Math.max.apply(null, pts.map(function (t) { return t.orders; })) || 1;
    var w = 100, h = 30, pad = 2;
    var line = pts.map(function (t, i) {
      var x = pad + (i / (pts.length - 1)) * (w - 2 * pad);
      var y = pad + (1 - t.orders / max) * (h - 2 * pad);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg class="aoo-spark" data-spark="orders" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Orders per day, ' +
      esc(pts[0].date) + ' to ' + esc(pts[pts.length - 1].date) + ' (server daily counts)"><polyline points="' + line + '"/></svg>' +
      '<span class="aoo-kpi-note">Orders per day, last ' + pts.length + ' days</span>';
  }

  /* status: 'loading' | 'ok' | 'error' */
  function kpiValue(slot, pick) {
    if (!slot || slot.status === 'loading') return { html: '<span class="aoo-kpi-num" aria-busy="true">' + DASH + '</span>', note: 'Loading…', tone: '' };
    if (slot.status === 'error') return { html: '<span class="aoo-kpi-num">' + DASH + '</span>', note: 'Could not load: ' + slot.error.lead, tone: 'bad' };
    var v = pick(slot.data);
    return { value: v };
  }

  function kpiCard(id, title, slot, pick, fmt, baseNote, extra) {
    var r = kpiValue(slot, pick), num, note = baseNote, tone = '';
    if (r.html) { num = r.html; note = r.note; tone = r.tone; }
    else if (!isNum(r.value)) { num = '<span class="aoo-kpi-num">' + DASH + '</span>'; note = 'Not returned by the server'; }
    else {
      num = '<span class="aoo-kpi-num">' + esc(fmt(r.value)) + '</span>';
      if (r.value === 0) { note = baseNote + ' · the server reports 0 when its query fails, so this zero is unconfirmed'; tone = 'warn'; }
    }
    return '<article class="aoo-kpi" data-kpi="' + esc(id) + '"><h3>' + esc(title) + '</h3>' + num +
      '<span class="aoo-kpi-note' + (tone ? ' ' + tone : '') + '">' + esc(note) + '</span>' + (extra || '') + '</article>';
  }
  function kpiUnavailable(id, title, why) {
    return '<article class="aoo-kpi" data-kpi="' + esc(id) + '" data-known="false"><h3>' + esc(title) + '</h3>' +
      '<span class="aoo-kpi-num">' + DASH + '</span><span class="aoo-kpi-note">' + esc(why) + '</span></article>';
  }

  function kpisHtml(st) {
    var exec = st.kpi.exec, fin = st.kpi.finance, tr = st.kpi.trends;
    var spark = tr && tr.status === 'ok' ? sparkHtml(tr.data) : '';
    var win = fin && fin.status === 'ok' && fin.data && fin.data.reconciliation && str(fin.data.reconciliation.window);
    return '<section class="aoo-kpis" data-aoo-kpis aria-label="Order totals from the server">' +
      kpiCard('total', 'Total orders', exec, function (d) { return d && d.totalOrders; }, fmtInt, 'All time · server count', spark) +
      kpiCard('revenue', 'Gross revenue', fin, function (d) { return d && d.reconciliation && d.reconciliation.productRevenue; }, fmtKES,
        'Product GMV, last ' + (win === '30d' || !win ? '30 days' : win) + ' · paid, delivered and completed orders (server reconciliation)') +
      kpiUnavailable('aov', 'Average order value', 'Not computed server-side yet') +
      kpiUnavailable('shipped', 'Orders shipped', 'No server count for shipped orders yet') +
      kpiCard('active', 'Active orders', exec, function (d) { return d && d.activeOrders; }, fmtInt,
        'Pending, processing and confirmed · server count (paid orders are not included)') +
      '</section>';
  }

  /* ── list rendering ──────────────────────────────────────────────────────────── */
  function tabsHtml(st) {
    return '<div class="aoo-tabs" role="tablist" aria-label="Filter by order status">' + TABS.map(function (t) {
      var on = t.id === st.status;
      return '<button type="button" class="aoo-tab" role="tab" aria-selected="' + on + '" data-aoo="tab" data-status="' + esc(t.id) + '">' +
        esc(t.label) + '</button>';
    }).join('') + '</div>' +
      '<p class="aoo-filter-note">The orders service filters by status only. Date, channel, carrier and payment-method filters ' +
      'aren\'t offered because the server can\'t apply them, and filtering a loaded page here would hide orders it didn\'t load.</p>';
  }

  function rowHtml(o, selectedId) {
    var name = buyerName(o), email = buyerEmail(o), items = itemsOf(o), ch = orderChannel(o);
    var method = str(first(o.paymentMethod, o.method));
    return '<tr' + (o.id === selectedId ? ' class="sel"' : '') + ' data-order="' + esc(o.id) + '">' +
      '<td data-label="Order"><div><span class="aoo-id">' + esc(o.id || DASH) + '</span>' +
        '<span class="aoo-dim">' + esc(ch ? label(ch) : DASH) + '</span></div></td>' +
      '<td data-label="Customer"><div>' + esc(name || DASH) + (email ? '<span class="aoo-dim">' + esc(email) + '</span>' : '') + '</div></td>' +
      '<td data-label="Status"><div>' + pill(o.status) + '</div></td>' +
      '<td data-label="Payment"><div>' + esc(label(o.paymentStatus)) +
        (verified(o) ? '<span class="aoo-tag">Verified</span>' : '') +
        '<span class="aoo-dim">' + esc(method ? label(method) + ' (as recorded)' : DASH) + '</span></div></td>' +
      '<td data-label="Delivery"><div>' + esc(label(o.deliveryStatus)) + '</div></td>' +
      '<td data-label="Total"><div>' + esc(fmtKES(orderTotal(o))) +
        '<span class="aoo-dim">' + (items ? esc(fmtInt(items.length) + (items.length === 1 ? ' item' : ' items')) : DASH) + '</span></div></td>' +
      '<td data-label="Date"><div>' + timeHtml(o.createdAt) + '</div></td>' +
      '<td data-label="Details"><div><button type="button" class="aoo-btn sm" data-aoo="open" data-id="' + esc(o.id) + '" ' +
        'aria-label="View order ' + esc(o.id) + '">View</button></div></td></tr>';
  }

  function listHtml(st) {
    if (st.list === 'loading') {
      return '<div role="status" aria-live="polite"><span class="aoo-sr">Loading orders…</span>' +
        '<div class="aoo-skel"></div><div class="aoo-skel"></div><div class="aoo-skel"></div></div>';
    }
    if (st.list === 'error') {
      var e = st.error || {};
      return '<div class="aoo-state err" role="alert"><strong>' + esc(e.lead || 'Orders could not be loaded.') + '</strong>' +
        (e.message ? '<p>' + esc(e.message) + '</p>' : '') +
        '<button type="button" class="aoo-btn" data-aoo="retry">Retry</button></div>';
    }
    var rows = st.orders || [];
    if (!rows.length) {
      var tab = TABS.filter(function (t) { return t.id === st.status; })[0];
      return '<div class="aoo-state" role="status"><strong>No orders' + (st.status ? ' with status “' + esc(tab ? tab.label : st.status) + '”' : ' yet') + '</strong>' +
        '<p>The orders service returned none.</p></div>';
    }
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    var page = Math.min(Math.max(1, st.page || 1), pages);
    var from = (page - 1) * PAGE_SIZE, to = Math.min(rows.length, from + PAGE_SIZE);
    var capReached = st.limit >= SERVER_LIMIT_CAP && rows.length >= SERVER_LIMIT_CAP;
    var more = rows.length >= st.limit && !capReached;
    return '<div class="aoo-table-wrap"><table class="aoo-table"><caption class="aoo-sr">Orders, newest first</caption><thead><tr>' +
      ['Order', 'Customer', 'Status', 'Payment', 'Delivery', 'Total', 'Date', 'Details'].map(function (h) {
        return '<th scope="col">' + h + '</th>';
      }).join('') + '</tr></thead><tbody>' +
      rows.slice(from, to).map(function (o) { return rowHtml(o, st.selectedId); }).join('') + '</tbody></table></div>' +
      '<div class="aoo-pager"><span data-aoo-range>Showing ' + fmtInt(from + 1) + ' to ' + fmtInt(to) + ' of ' + fmtInt(rows.length) +
      ' loaded (newest first)' +
      (capReached ? ' · the orders service returns at most ' + fmtInt(SERVER_LIMIT_CAP) + ' per request; older orders aren\'t reachable here'
        : !more ? ' · end of list' : '') + '</span>' +
      '<span class="aoo-pager-btns">' +
      '<button type="button" class="aoo-btn sm" data-aoo="prev"' + (page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button type="button" class="aoo-btn sm" data-aoo="next"' + (page >= pages ? ' disabled' : '') + '>Next</button>' +
      (more ? '<button type="button" class="aoo-btn sm" data-aoo="more">Load more</button>' : '') +
      '</span></div>';
  }

  /* ── detail drawer ───────────────────────────────────────────────────────────── */
  function kv(k, vHtml, cls) {
    return '<div class="aoo-kv' + (cls ? ' ' + cls : '') + '"><span>' + esc(k) + '</span><span>' + vHtml + '</span></div>';
  }
  function drawerHtml(st) {
    var o = (st.orders || []).filter(function (x) { return x.id === st.selectedId; })[0];
    if (!o) return '';
    var name = buyerName(o), email = buyerEmail(o), phone = buyerPhone(o), uid = buyerUid(o);
    var items = itemsOf(o), ch = orderChannel(o);
    var method = str(first(o.paymentMethod, o.method));
    var promo = o.pricing && isNum(o.pricing.promoDiscount) ? o.pricing.promoDiscount : null;
    var paidAtOk = verified(o) && tsMs(o.paidAt) != null;
    var hasDelivery = !!(str(o.deliveryRef) || str(o.deliveryStatus) || str(o.trackingNo));

    var summary = kv('Subtotal', esc(fmtKES(orderSubtotal(o)))) +
      kv('Delivery fee', esc(fmtKES(orderDeliveryFee(o)))) +
      (promo != null ? kv('Promo discount', esc(fmtKES(promo))) : '') +
      (isNum(o.tax) ? kv('Tax', esc(fmtKES(o.tax))) : '') +
      kv('Total', esc(fmtKES(orderTotal(o))), 'total');
    var paidLine = paidAtOk
      ? '<p class="aoo-note" data-aoo-paid>Payment verified by the server on ' + timeHtml(o.paidAt, true) +
        (isNum(o.paidAmount) ? ' · amount received ' + esc(fmtKES(o.paidAmount)) : '') + '.</p>'
      : '<p class="aoo-note" data-aoo-paid="none">No server-verified payment is recorded on this order.</p>';

    var cust = '<div class="aoo-cust">' + (name ? '<span class="aoo-chip" aria-hidden="true">' + esc(initials(name)) + '</span>' : '') +
      '<div><strong>' + esc(name || DASH) + '</strong></div></div>' +
      kv('Email', esc(email || DASH)) + kv('Phone', esc(phone || DASH)) +
      (uid ? '<div class="aoo-actions" style="margin-top:8px"><button type="button" class="aoo-btn sm" data-aoo="profile" data-uid="' + esc(uid) + '">View profile</button></div>' : '');

    var pay = kv('Status', esc(label(o.paymentStatus))) +
      kv('Server verification', verified(o) ? '<span class="aoo-tag">Verified</span>' : '<span class="aoo-tag no">Not verified</span>') +
      kv('Method (as recorded)', esc(method ? label(method) : DASH)) +
      kv('Amount received', esc(verified(o) && isNum(o.paidAmount) ? fmtKES(o.paidAmount) : DASH)) +
      kv('Transaction ID', esc(str(o.mpesaCode) || DASH)) +
      '<p class="aoo-note">Receipts can\'t be resent from here: no order-receipt service is live.</p>';

    var ship = kv('Fulfilment', esc(label(first(o.fulfillmentType, o.deliveryMethod)))) +
      kv('Delivery status', esc(label(o.deliveryStatus))) +
      kv('Delivery reference', esc(str(o.deliveryRef) || DASH)) +
      kv('Tracking no. (entered by seller)', esc(str(o.trackingNo) || DASH)) +
      kv('Rider', esc(str(o.riderName) || DASH)) +
      kv('Delivered at', timeHtml(o.deliveredAt, true)) +
      (hasDelivery ? '<div class="aoo-actions" style="margin-top:8px"><a class="aoo-btn sm" href="track.html?order=' +
        encodeURIComponent(o.id) + '" target="_blank" rel="noopener">Open tracking page</a></div>' : '');

    var itemList = items === null ? '<p class="aoo-note">' + DASH + ' No items are recorded on this order.</p>'
      : !items.length ? '<p class="aoo-note">The order lists no items.</p>'
      : '<ul class="aoo-items">' + items.map(function (i) {
          return '<li><span>' + esc(str(i.name) || DASH) + ' <span class="aoo-dim">Qty ' + esc(fmtInt(isNum(i.qty) ? i.qty : null)) + '</span></span>' +
            '<span>' + esc(fmtKES(isNum(i.price) ? i.price : null)) + ' <span class="aoo-dim">each</span></span></li>';
        }).join('') + '</ul>';

    var act = st.action || {};
    var actions = '<label class="aoo-sr" for="aoo-status-sel">New status</label>' +
      '<div class="aoo-actions"><select id="aoo-status-sel" class="aoo-select" data-aoo="status-sel">' +
      '<option value="">Change status to…</option>' + STATUS_CHOICES.map(function (s) {
        return '<option value="' + esc(s) + '"' + (s === act.choice ? ' selected' : '') + '>' + esc(label(s)) + '</option>';
      }).join('') + '</select>' +
      '<button type="button" class="aoo-btn sm primary" data-aoo="apply-status"' + (act.busy ? ' disabled aria-busy="true"' : '') + '>' +
      (act.busy ? 'Saving…' : 'Update status') + '</button></div>' +
      '<div role="status" aria-live="polite" class="aoo-note" data-aoo-action-msg>' + (act.error ? '<span style="color:#fca5a5">' + esc(act.error) + '</span>' : '') + '</div>' +
      '<p class="aoo-note">Status changes are recorded in the admin audit log by the server and run the platform\'s order automation ' +
      '(notifications; settlement on delivered/completed).</p>' +
      '<p class="aoo-note">Refunds aren\'t requested from here: there is no live request-for-approval service for admins, and the ' +
      'refundRequests collection pays out automatically when written, so no button writes it. Use Financial → Disputes.</p>';

    return '<div class="aoo-scrim" data-aoo="close"></div>' +
      '<aside class="aoo-drawer" role="dialog" aria-modal="true" aria-labelledby="aoo-drawer-title">' +
      '<div class="aoo-drawer-head"><div style="min-width:0"><h3 id="aoo-drawer-title">Order ' + esc(o.id) + '</h3>' +
      '<div>' + pill(o.status) + '</div><p class="aoo-note">Placed ' + timeHtml(o.createdAt, true) + (ch ? ' · ' + esc(label(ch)) : '') + '</p></div>' +
      '<button type="button" class="aoo-x" data-aoo="close" aria-label="Close order details">&times;</button></div>' +
      '<div class="aoo-drawer-body">' +
      '<section class="aoo-sec"><h4>Order summary</h4>' + summary +
      '<p class="aoo-note">Amounts as recorded on the order at checkout.</p>' + paidLine + '</section>' +
      '<section class="aoo-sec"><h4>Customer</h4>' + cust + '</section>' +
      '<section class="aoo-sec"><h4>Payment</h4>' + pay + '</section>' +
      '<section class="aoo-sec"><h4>Delivery</h4>' + ship + '</section>' +
      '<section class="aoo-sec"><h4>Items</h4>' + itemList + '</section>' +
      '<section class="aoo-sec"><h4>Actions</h4>' + actions + '</section>' +
      '</div></aside>';
  }

  function viewHtml(st) {
    var n = st.list === 'ready' ? (st.orders || []).length : null;
    return '<div class="aoo-root" data-aoo-root>' +
      '<header class="aoo-top"><div class="aoo-top-main"><h2>Orders' +
      (n != null ? '<span class="aoo-count" data-aoo-loaded>' + esc(fmtInt(n)) + ' loaded</span>' : '') + '</h2>' +
      '<p class="aoo-sub">Marketplace orders, newest first, straight from the orders service.</p></div>' +
      '<div class="aoo-actions"><button type="button" class="aoo-btn" data-aoo="refresh"' +
      (st.list === 'loading' ? ' disabled' : '') + '>Refresh</button></div></header>' +
      kpisHtml(st) +
      '<section class="aoo-card" aria-label="Orders">' + tabsHtml(st) +
      '<div aria-live="polite" data-aoo-list>' + listHtml(st) + '</div></section>' +
      drawerHtml(st) + '</div>';
  }

  /* ── controller ──────────────────────────────────────────────────────────────── */
  var _kpiCache = null;   /* { at, exec, finance, trends } — shared across mounts, 5 min */
  var _current = null;

  function freshState() {
    return { status: '', limit: LIMIT_STEP, page: 1, list: 'loading', orders: [], error: null,
      selectedId: null, action: {}, kpi: { exec: { status: 'loading' }, finance: { status: 'loading' }, trends: { status: 'loading' } } };
  }

  function mount(el, deps) {
    if (!el) return null;
    deps = deps || {};
    if (_current) _current.alive = false;
    var call = deps.call;
    var timeoutMs = deps.timeoutMs || TIMEOUT_MS;
    var ctl = { alive: true, el: el, deps: deps, state: freshState(), seq: 0, lastFocusId: null };
    _current = ctl;
    var doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    ensureStyle(doc);

    function render() {
      if (!ctl.alive) return;
      el.innerHTML = viewHtml(ctl.state);
      if (ctl.state.selectedId && typeof el.querySelector === 'function') {
        var x = el.querySelector('.aoo-drawer .aoo-x');
        if (x && typeof x.focus === 'function' && ctl._focusDrawer) { ctl._focusDrawer = false; x.focus(); }
      }
    }

    /* A KPI answer repaints only the KPI row, so focus and an open select survive. */
    function renderKpis() {
      if (!ctl.alive) return;
      var sec = typeof el.querySelector === 'function' ? el.querySelector('[data-aoo-kpis]') : null;
      if (sec && 'outerHTML' in sec) sec.outerHTML = kpisHtml(ctl.state);
      else render();
    }

    function loadList() {
      var my = ++ctl.seq;
      ctl.state.list = 'loading';
      ctl.state.error = null;
      render();
      var args = { limit: ctl.state.limit };
      if (ctl.state.status) args.status = ctl.state.status;
      var p;
      try { p = call('adminGetOrders', args); } catch (e) { p = Promise.reject(e); }
      return withTimeout(p, timeoutMs, 'The orders service').then(function (res) {
        if (!ctl.alive || my !== ctl.seq) return;
        var list = res && Array.isArray(res.orders) ? res.orders.filter(function (o) { return o && typeof o === 'object' && o.id != null; }) : null;
        if (!list) { ctl.state.list = 'error'; ctl.state.error = { lead: 'The orders service returned an unexpected response.', message: '' }; }
        else {
          ctl.state.list = 'ready'; ctl.state.orders = list;
          if (ctl.state.selectedId && !list.some(function (o) { return o.id === ctl.state.selectedId; })) ctl.state.selectedId = null;
        }
        render();
      }, function (err) {
        if (!ctl.alive || my !== ctl.seq) return;
        ctl.state.list = 'error';
        ctl.state.error = describeError(err);
        render();
      });
    }

    function loadKpis(force) {
      if (!force && _kpiCache && Date.now() - _kpiCache.at < KPI_CACHE_MS) {
        ctl.state.kpi = { exec: _kpiCache.exec, finance: _kpiCache.finance, trends: _kpiCache.trends };
        return Promise.resolve();
      }
      ctl.state.kpi = { exec: { status: 'loading' }, finance: { status: 'loading' }, trends: { status: 'loading' } };
      function one(key, name, args) {
        var p;
        try { p = call(name, args || {}); } catch (e) { p = Promise.reject(e); }
        return withTimeout(p, timeoutMs, name).then(function (d) {
          return { status: 'ok', data: d || {} };
        }, function (e) { return { status: 'error', error: describeError(e) }; }).then(function (slot) {
          if (!ctl.alive) return slot;
          ctl.state.kpi[key] = slot;
          renderKpis();
          return slot;
        });
      }
      return Promise.all([
        one('exec', 'adminGetExecutiveDashboard'),
        one('finance', 'adminGetFinance'),
        one('trends', 'getOrderTrends', { days: TRENDS_DAYS }),
      ]).then(function (r) {
        /* cache only answers; an error is retried on the next mount */
        if (r.every(function (s) { return s.status === 'ok'; })) _kpiCache = { at: Date.now(), exec: r[0], finance: r[1], trends: r[2] };
      });
    }

    function setStatus(s) {
      if (TABS.every(function (t) { return t.id !== s; })) return null;
      ctl.state.status = s; ctl.state.page = 1; ctl.state.limit = LIMIT_STEP; ctl.state.selectedId = null; ctl.state.orders = [];
      return loadList();
    }
    function page(delta) {
      var pages = Math.max(1, Math.ceil((ctl.state.orders || []).length / PAGE_SIZE));
      ctl.state.page = Math.min(pages, Math.max(1, (ctl.state.page || 1) + delta));
      render();
    }
    function loadMore() {
      if (ctl.state.limit >= SERVER_LIMIT_CAP) return null;
      ctl.state.limit = Math.min(SERVER_LIMIT_CAP, ctl.state.limit + LIMIT_STEP);
      var keepPage = ctl.state.page;
      return loadList().then(function () {
        if (ctl.state.list === 'ready') { ctl.state.page = Math.min(keepPage + 1, Math.max(1, Math.ceil(ctl.state.orders.length / PAGE_SIZE))); render(); }
      });
    }
    function open(id) {
      if (!(ctl.state.orders || []).some(function (o) { return String(o.id) === String(id); })) return;
      ctl.state.selectedId = (ctl.state.orders.filter(function (o) { return String(o.id) === String(id); })[0]).id;
      ctl.state.action = {};
      ctl.lastFocusId = id;
      ctl._focusDrawer = true;
      render();
    }
    function close() {
      ctl.state.selectedId = null; ctl.state.action = {};
      render();
      if (ctl.lastFocusId != null && typeof el.querySelector === 'function') {
        var b = el.querySelector('[data-aoo="open"][data-id="' + String(ctl.lastFocusId).replace(/["\\]/g, '\\$&') + '"]');
        if (b && typeof b.focus === 'function') b.focus();
      }
    }
    function applyStatus(choice) {
      var o = (ctl.state.orders || []).filter(function (x) { return x.id === ctl.state.selectedId; })[0];
      if (!o) return Promise.resolve(false);
      if (STATUS_CHOICES.indexOf(choice) < 0) { ctl.state.action = { error: 'Choose a status first.' }; render(); return Promise.resolve(false); }
      var ask = deps.confirm ? deps.confirm('Set order ' + o.id + ' to “' + label(choice) + '”? This runs the platform\'s order automation.', { title: 'Change order status', confirmLabel: 'Update status' })
        : Promise.resolve(true);
      return Promise.resolve(ask).then(function (ok) {
        if (!ok || !ctl.alive) return false;
        ctl.state.action = { busy: true, choice: choice }; render();
        var p;
        try { p = call('adminUpdateOrderStatus', { orderId: o.id, status: choice }); } catch (e) { p = Promise.reject(e); }
        return withTimeout(p, timeoutMs, 'The order update').then(function () {
          if (!ctl.alive) return true;
          ctl.state.action = {};
          if (deps.toast) deps.toast('Order ' + o.id + ' updated to ' + label(choice), 'success');
          var keep = o.id;
          return loadList().then(function () { if (ctl.state.list === 'ready' && ctl.state.orders.some(function (x) { return x.id === keep; })) { ctl.state.selectedId = keep; render(); } return true; });
        }, function (err) {
          if (!ctl.alive) return false;
          var d = describeError(err);
          ctl.state.action = { choice: choice, error: 'Not updated. ' + (d.message || d.lead) };
          render();
          return false;
        });
      });
    }

    ctl.actions = { setStatus: setStatus, page: page, loadMore: loadMore, open: open, close: close, applyStatus: applyStatus,
      retry: loadList, refresh: function () { return Promise.all([loadKpis(true), loadList()]); } };

    /* One delegated listener per element; it always drives the CURRENT mount. */
    if (!el.__aooBound && typeof el.addEventListener === 'function') {
      el.__aooBound = true;
      el.addEventListener('click', function (ev) { dispatch(el, ev); });
      el.addEventListener('change', function (ev) {
        var c = _current, t = ev && ev.target;
        if (c && c.el === el && c.alive && t && t.getAttribute && t.getAttribute('data-aoo') === 'status-sel') c.state.action.choice = t.value;
      });
      el.addEventListener('keydown', function (ev) {
        var c = _current;
        if (c && c.el === el && c.alive && ev.key === 'Escape' && c.state.selectedId) { ev.preventDefault && ev.preventDefault(); c.actions.close(); }
      });
    }

    render();
    ctl.ready = Promise.all([loadKpis(false).then(renderKpis), loadList()]);
    return ctl;
  }

  function dispatch(el, ev) {
    var c = _current;
    if (!c || c.el !== el || !c.alive) return;
    var t = ev && ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-aoo]') : null;
    if (!t) return;
    var a = t.getAttribute('data-aoo');
    if (a === 'tab') c.actions.setStatus(t.getAttribute('data-status') || '');
    else if (a === 'open') c.actions.open(t.getAttribute('data-id'));
    else if (a === 'close') c.actions.close();
    else if (a === 'prev') c.actions.page(-1);
    else if (a === 'next') c.actions.page(1);
    else if (a === 'more') c.actions.loadMore();
    else if (a === 'retry') c.actions.retry();
    else if (a === 'refresh') c.actions.refresh();
    else if (a === 'profile') { var uid = t.getAttribute('data-uid'); if (uid && c.deps && c.deps.viewUser) c.deps.viewUser(uid); }
    else if (a === 'apply-status') {
      var sel = typeof el.querySelector === 'function' ? el.querySelector('[data-aoo="status-sel"]') : null;
      c.actions.applyStatus(sel ? sel.value : '');
    }
  }

  /* Called by sokoni-aos.js whenever the Marketplace tab changes: late responses from
     this mount must not paint over another tab's body. */
  function unmount() { if (_current) _current.alive = false; _current = null; }

  var api = {
    mount: mount,
    unmount: unmount,
    dispatch: dispatch,
    _internals: {
      viewHtml: viewHtml, kpisHtml: kpisHtml, listHtml: listHtml, drawerHtml: drawerHtml, rowHtml: rowHtml,
      sparkHtml: sparkHtml, fmtKES: fmtKES, fmtInt: fmtInt, tsMs: tsMs, esc: esc, describeError: describeError,
      TABS: TABS, STATUS_CHOICES: STATUS_CHOICES, PAGE_SIZE: PAGE_SIZE, LIMIT_STEP: LIMIT_STEP,
      SERVER_LIMIT_CAP: SERVER_LIMIT_CAP, TRENDS_CAP: TRENDS_CAP, CSS: CSS,
      resetCache: function () { _kpiCache = null; },
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SokoniAOSOrders = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
