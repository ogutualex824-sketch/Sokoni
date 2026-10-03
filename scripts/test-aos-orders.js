#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════════
   ADMINOS ORDERS — states, server-only figures, honest omissions (no browser)
   ------------------------------------------------------------------------------
   Runs sokoni-aos-orders.js in a VM against a fake element and fake callables, and
   statically checks how sokoni-aos.js / admin-os.html mount it.

   Fixture shapes are copied from the SERVING code (adminosdispatch-00025-muh, source
   generation 1788271885523075; getordertrends-00015-yuw), not invented:
     adminGetOrders            → { orders:[{ id, ...doc, createdAt: ISO }] } — no total,
                                 no counts, no cursor; other Timestamps as {_seconds,_nanoseconds}
     adminGetExecutiveDashboard → { totalOrders, activeOrders, ordersToday, revenueToday, … }
     adminGetFinance            → { reconciliation:{ window:'30d', productRevenue, … }, … }
     getOrderTrends             → { days, trends:[{ date, orders, gmv, failed }] }
     adminUpdateOrderStatus     → { success:true }

   NEGATIVE CONTROLS — each mutant must fail the NAMED row and leave a control row green:
     (a) Gross revenue computed by summing the loaded page
     (b) a Request-refund button that writes refundRequests directly
     (c) a status tab that filters the loaded page client-side instead of asking the server

     node scripts/test-aos-orders.js
   Exit: 0 all passed · 1 a row failed
   ═══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('sokoni-aos-orders.js');
const DASH = '—';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail && !ok ? '   [' + String(detail).slice(0, 200) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); }
};

/* ── fixtures (serving shapes) ─────────────────────────────────────────────────── */
const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const letters = (i) => L[Math.floor(i / 676) % 26] + L[Math.floor(i / 26) % 26] + L[i % 26];
const STATUSES = ['paid', 'pending_payment', 'processing', 'delivered', 'cancelled'];
function mkOrder(i) {
  return {
    id: 'SKN' + letters(i),
    uid: 'uid' + letters(i), buyerUid: 'uid' + letters(i),
    buyerName: 'Buyer ' + letters(i), buyerPhone: '+254700' + String(100000 + i),
    hub: 'marketplace', status: STATUSES[i % STATUSES.length],
    paymentStatus: i % 2 ? 'paid' : 'pending', paymentMethod: 'mpesa',
    paymentVerified: i % 2 === 1, paidAt: i % 2 ? { _seconds: 1790000000 + i * 60, _nanoseconds: 0 } : undefined,
    paidAmount: i % 2 ? 1000 + i * 7 : undefined, mpesaCode: i % 2 ? 'QX' + letters(i) : undefined,
    subtotal: 900 + i * 7, deliveryFee: 100, total: 1000 + i * 7,
    items: [{ name: 'Item ' + letters(i), qty: 1 + (i % 3), price: 300 + i }],
    createdAt: new Date(Date.UTC(2026, 8, 30, 12, 0, 0) - i * 3600000).toISOString(),
  };
}
const POOL = Array.from({ length: 260 }, (_, i) => mkOrder(i));
const EXEC = { totalOrders: 1834, activeOrders: 57, ordersToday: 13, revenueToday: 77777, newUsersToday: 4 };
const FIN = { reconciliation: { window: '30d', productRevenue: 482350.5, refunds: 1200, grossRevenue: 999111 }, currency: 'KES' };
const TRENDS = { days: 30, trends: Array.from({ length: 30 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), orders: 20 + (i % 7) * 3, gmv: 0, failed: 0 })) };

/* ── harness ───────────────────────────────────────────────────────────────────── */
function loadModule(src) {
  const writes = [];
  const fakeFirestore = { collection: (c) => ({ add: (d) => { writes.push({ c, d }); return Promise.resolve({ id: 'x' }); },
    doc: () => ({ set: (d) => { writes.push({ c, d }); return Promise.resolve(); } }) }) };
  const sandbox = { setTimeout, clearTimeout, Promise, Math, Date, String, Array, Object, isFinite, console, JSON,
    encodeURIComponent, firebase: { firestore: () => fakeFirestore } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'sokoni-aos-orders.js' }).runInContext(sandbox);
  sandbox.SokoniAOSOrders._internals.resetCache();
  return { M: sandbox.SokoniAOSOrders, writes };
}
function fakeDoc() {
  const styles = [];
  return { styles, getElementById: (id) => styles.find((s) => s.id === id) || null,
    createElement: () => ({ id: '', textContent: '' }), head: { appendChild: (s) => styles.push(s) } };
}
function fakeEl() {
  const el = { innerHTML: '', handlers: {}, _selValue: '', ownerDocument: fakeDoc(),
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
    querySelector(q) { return q === '[data-aoo="status-sel"]' ? { value: this._selValue } : null; } };
  return el;
}
function node(attrs) { return { closest: () => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) }) }; }
function click(el, attrs) { (el.handlers.click || []).forEach((f) => f({ target: node(attrs) })); }
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
function text(html) {
  return html.replace(/<time\b[^>]*>[\s\S]*?<\/time>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
}

/* Fake server. `opts` tweaks each callable. Records every call. */
function server(opts = {}) {
  const calls = [];
  const call = (name, data) => {
    calls.push({ name, data: JSON.parse(JSON.stringify(data || {})) });
    const o = opts[name];
    if (typeof o === 'function') return o(data);
    if (o !== undefined) return Promise.resolve(o);
    if (name === 'adminGetOrders') {
      let rows = POOL.slice();
      if (data && data.status) rows = rows.filter((r) => r.status === data.status);
      return Promise.resolve({ orders: rows.slice(0, Math.min((data && data.limit) || 50, 200)) });
    }
    if (name === 'adminGetExecutiveDashboard') return Promise.resolve(EXEC);
    if (name === 'adminGetFinance') return Promise.resolve(FIN);
    if (name === 'getOrderTrends') return Promise.resolve(TRENDS);
    if (name === 'adminUpdateOrderStatus') return Promise.resolve({ success: true });
    return Promise.reject(Object.assign(new Error('unknown op ' + name), { code: 'not-found' }));
  };
  return { call, calls };
}

/* Every digit run in the visible text must come from a fixture field, a row count, a
   pager bound, or a documented constant. Dates are checked separately (<time>). */
function fmtPlain(n) {
  const [w, f] = (Math.round(n * 100) / 100).toFixed(2).split('.');
  const g = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return [g, g + '.' + f, String(n)];
}
function allowedNumbers(fixtures, extras) {
  const set = new Set(extras.map(String));
  const walk = (v) => {
    if (typeof v === 'number') fmtPlain(v).forEach((s) => set.add(s));
    else if (typeof v === 'string') (v.match(/\d[\d,]*(?:\.\d+)?/g) || []).forEach((s) => set.add(s));
    else if (Array.isArray(v)) { set.add(String(v.length)); v.forEach(walk); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  fixtures.forEach(walk);
  return set;
}
function untraced(html, allowed) {
  return (text(html).match(/\d[\d,]*(?:\.\d+)?/g) || []).filter((t) => !allowed.has(t));
}

/* ── the rows (run against the real module and against each mutant) ──────────── */
async function runRows(src, quiet) {
  const rows = {};
  const row = (name, ok, detail) => { rows[name] = !!ok; if (!quiet) ck(name, ok, detail); };

  /* success */
  {
    const { M } = loadModule(src);
    const s = server();
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 });
    row('loading: list shows an aria-live status before the server answers', /role="status" aria-live="polite"[\s\S]*Loading orders/.test(el.innerHTML));
    row('loading: KPIs show — while loading (no 0)', /data-kpi="total"[\s\S]*?aoo-kpi-num" aria-busy="true">—/.test(el.innerHTML));
    await c.ready; await flush();
    const h = el.innerHTML, t = text(h);
    row('style injected once into the document', el.ownerDocument.styles.length === 1 && el.ownerDocument.styles[0].id === 'aoo-style');
    row('data: first page renders 10 rows', (h.match(/<tr data-order=/g) || []).length === 10);
    row('data: pager says "Showing 1 to 10 of 50 loaded"', t.includes('Showing 1 to 10 of 50 loaded (newest first)'), t.slice(0, 0));
    row('data: never claims a server total in the pager', !/of 1,834/.test(t) && !/of\s+\d[\d,]*\s+orders/i.test(t));
    row('KPI Total orders = server totalOrders 1,834', /data-kpi="total"[\s\S]*?aoo-kpi-num">1,834</.test(h));
    row('KPI Gross revenue = server reconciliation.productRevenue (never a page sum)', /data-kpi="revenue"[\s\S]*?aoo-kpi-num">KES 482,350\.50</.test(h));
    row('KPI Active orders = server activeOrders 57', /data-kpi="active"[\s\S]*?aoo-kpi-num">57</.test(h));
    row('KPI Average order value shows — (not computed server-side)', /data-kpi="aov"[\s\S]*?aoo-kpi-num">—<[\s\S]*?Not computed server-side/.test(h));
    row('KPI Orders shipped shows — (no server count)', /data-kpi="shipped"[\s\S]*?aoo-kpi-num">—</.test(h));
    row('decoy server fields never rendered (revenueToday, grossRevenue, ordersToday)', !t.includes('77,777') && !t.includes('999,111') && !/\b13\b/.test(t));
    row('sparkline drawn from getOrderTrends.orders only', /data-spark="orders"/.test(h) && /Orders per day, last 30 days/.test(t));
    row('no delta rendered (server returns no comparison)', !/vs last month|vs previous|▲|▼/.test(t));
    row('status tabs carry no counts', (h.match(/<button[^>]*data-aoo="tab"[^>]*>([^<]*)</g) || []).every((b) => !/\d/.test(b.replace(/<[^>]*>/, ''))));
    row('filters: only status tabs (no date/channel/carrier/payment controls)', !/type="date"|Channels|Carriers|Payment methods|More filters/i.test(h));
    const allowed = allowedNumbers([POOL.slice(0, 50), EXEC.totalOrders, EXEC.activeOrders, FIN.reconciliation.productRevenue, TRENDS],
      [1, 10, 50, 30]);
    const bad = untraced(h, allowed);
    row('every rendered number traces to a fixture field (success)', bad.length === 0, bad.join(' '));
    row('tracer positive control: the walk sees the rendered figures', ['1,834', '482,350.50', '57'].every((n) => (text(h).match(/\d[\d,]*(?:\.\d+)?/g) || []).includes(n)));
    row('dates carry the server ISO in <time datetime>', h.includes('datetime="' + POOL[0].createdAt + '"'));
    row('a11y: column headers have scope="col"', (h.match(/<th scope="col">/g) || []).length === 8 && !/<th>/.test(h));
    row('a11y: every cell has a data-label (mobile cards)', (h.match(/<td(?![^>]*data-label)/g) || []).length === 0);
    row('a11y: row action is a real button with an accessible name', /<button type="button" class="aoo-btn sm" data-aoo="open" data-id="SKNAAA" aria-label="View order SKNAAA">/.test(h));
    row('first request is { limit:50 } only — no cursor, no hubType, no dates', JSON.stringify(s.calls.find((x) => x.name === 'adminGetOrders').data) === '{"limit":50}');

    /* pagination */
    click(el, { 'data-aoo': 'next' });
    row('pager: Next shows 11 to 20', text(el.innerHTML).includes('Showing 11 to 20 of 50 loaded'));
    click(el, { 'data-aoo': 'prev' });
    row('pager: Previous returns to 1 to 10', text(el.innerHTML).includes('Showing 1 to 10 of 50 loaded'));
    click(el, { 'data-aoo': 'more' }); await flush();
    const more = s.calls.filter((x) => x.name === 'adminGetOrders').pop().data;
    row('Load more re-asks the server with a larger limit (100)', more.limit === 100 && !('cursor' in more) && !('startAfter' in more));
    click(el, { 'data-aoo': 'more' }); await flush(); click(el, { 'data-aoo': 'more' }); await flush();
    const capped = el.innerHTML;
    row('Load more stops at the server cap (200) and says so', s.calls.filter((x) => x.name === 'adminGetOrders').pop().data.limit === 200 &&
      !/data-aoo="more"/.test(capped) && /at most 200 per request/.test(text(capped)));

    /* status tab → server */
    click(el, { 'data-aoo': 'tab', 'data-status': 'paid' }); await flush();
    const last = s.calls.filter((x) => x.name === 'adminGetOrders').pop().data;
    row('status filter is applied by the server (adminGetOrders called with status)', last.status === 'paid' && last.limit === 50);
    const shown = (el.innerHTML.match(/<tr data-order="([^"]+)"/g) || []).length;
    row('status tab shows exactly what the server returned', shown === 10 && /aria-selected="true" data-aoo="tab" data-status="paid"/.test(el.innerHTML));

    /* drawer */
    /* SKNAAF: status paid (in this tab), paymentVerified, paidAmount 1,035 */
    click(el, { 'data-aoo': 'open', 'data-id': 'SKNAAF' });
    const d = el.innerHTML, dt = text(d);
    row('drawer: dialog with aria-modal and a labelled title', /role="dialog" aria-modal="true" aria-labelledby="aoo-drawer-title"/.test(d) && /id="aoo-drawer-title">Order SKNAAF</.test(d));
    row('drawer: verified payment line from paymentVerified + paidAt', /data-aoo-paid>Payment verified by the server on <time datetime="2026-/.test(d) && dt.includes('amount received KES 1,035'));
    row('drawer: method labelled "as recorded"', dt.includes('Method (as recorded) Mpesa'));
    row('drawer: no Request refund / Resend receipt / Duplicate controls', !/Request refund<\/button>|Resend receipt<\/button>|Duplicate order/i.test(d));
    row('drawer: initials chip from the server name, no image', /aoo-chip" aria-hidden="true">BA</.test(d) && !/<img/i.test(d));
    click(el, { 'data-aoo': 'close' });
    row('drawer closes', !/role="dialog"/.test(el.innerHTML));
  }

  /* unknowns in the drawer */
  {
    const { M } = loadModule(src);
    const bare = { id: 'SKNBARE', createdAt: null, paidAt: { _seconds: 1790000000 }, paymentStatus: 'paid' };
    const s = server({ adminGetOrders: { orders: [bare] } });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 }); await c.ready; await flush();
    c.actions.open('SKNBARE');
    const d = el.innerHTML, dt = text(d);
    row('drawer: unknown fields render — (never 0)', /Subtotal<\/span><span>—/.test(d) && /Total<\/span><span>—/.test(d) &&
      /Email<\/span><span>—/.test(d) && /Delivered at<\/span><span>—/.test(d) && !/KES 0\b/.test(dt));
    row('drawer: paidAt without paymentVerified is NOT shown as paid', /data-aoo-paid="none"/.test(d) && !/Payment verified by the server/.test(d) && /Not verified/.test(d));
    row('drawer: no "Signed by" (no proof-of-delivery field on orders)', !/Signed by/i.test(d));
    row('drawer: no tracking link without delivery fields', !/track\.html/.test(d));
    row('drawer: no View profile without a buyer uid', !/data-aoo="profile"/.test(d));
    row('table: unknown total renders — (never KES 0)', !/KES 0/.test(text(el.innerHTML)));
  }

  /* empty */
  {
    const { M } = loadModule(src);
    const s = server({ adminGetOrders: { orders: [] } });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 }); await c.ready; await flush();
    row('empty: "No orders yet" + the service returned none', /No orders yet/.test(el.innerHTML) && /returned none/.test(el.innerHTML));
  }

  /* error + retry */
  {
    const { M } = loadModule(src);
    let n = 0;
    const s = server({ adminGetOrders: () => (++n === 1
      ? Promise.reject(Object.assign(new Error('admin required'), { code: 'functions/permission-denied' }))
      : Promise.resolve({ orders: POOL.slice(0, 3) })) });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 }); await c.ready; await flush();
    row('error: role=alert with the lead and the server message verbatim', /role="alert"[\s\S]*Admin or Super Admin access required\.[\s\S]*admin required/.test(el.innerHTML));
    row('error: never rendered as empty', !/No orders/.test(el.innerHTML));
    click(el, { 'data-aoo': 'retry' }); await flush();
    row('retry: asks the server again and recovers', n === 2 && (el.innerHTML.match(/<tr data-order=/g) || []).length === 3);
  }

  /* unexpected shape */
  {
    const { M } = loadModule(src);
    const s = server({ adminGetOrders: { items: [] } });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 }); await c.ready; await flush();
    row('unexpected response shape is an error, not "No orders"', /unexpected response/.test(el.innerHTML) && !/No orders/.test(el.innerHTML));
  }

  /* timeout */
  {
    const { M } = loadModule(src);
    const s = server({ adminGetOrders: () => new Promise(() => {}) });
    const el = fakeEl();
    M.mount(el, { call: s.call, timeoutMs: 40 });
    await new Promise((r) => setTimeout(r, 90)); await flush();
    row('timeout: a hung call ends in the timed-out error state', /The orders service timed out\./.test(el.innerHTML) && /data-aoo="retry"/.test(el.innerHTML));
  }

  /* KPI failures and zeros */
  {
    const { M } = loadModule(src);
    const s = server({ adminGetExecutiveDashboard: () => Promise.reject(Object.assign(new Error('boom'), { code: 'internal' })),
      adminGetFinance: { reconciliation: {} }, getOrderTrends: () => Promise.reject(new Error('x')) });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 }); await c.ready; await flush();
    const h = el.innerHTML;
    row('KPI error renders — with "Could not load" (no 0)', /data-kpi="total"[\s\S]*?aoo-kpi-num">—<[\s\S]*?Could not load/.test(h) && /data-kpi="active"[\s\S]*?aoo-kpi-num">—</.test(h));
    row('KPI missing field renders — "Not returned by the server"', /data-kpi="revenue"[\s\S]*?aoo-kpi-num">—<[\s\S]*?Not returned by the server/.test(h));
    row('no sparkline when the trends call fails', !/data-spark=/.test(h));
  }
  {
    const { M } = loadModule(src);
    const big = { days: 30, trends: TRENDS.trends.map((t) => Object.assign({}, t, { orders: 80 })) }; /* sums to 2,400 ≥ cap */
    const s = server({ adminGetExecutiveDashboard: { totalOrders: 0, activeOrders: 3 }, getOrderTrends: big });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 }); await c.ready; await flush();
    const h = el.innerHTML;
    row('server 0 renders 0 marked unconfirmed (server masks failures as 0)', /data-kpi="total"[\s\S]*?aoo-kpi-num">0<[\s\S]*?this zero is unconfirmed/.test(h));
    row('sparkline withheld when the server series hits its 2,000 cap', /data-spark="withheld"/.test(h) && !/data-spark="orders"/.test(h));
  }

  /* status update: confirm, call, refusal verbatim, toast only after success */
  {
    const { M } = loadModule(src);
    const toasts = [];
    let confirmAnswer = false;
    let refuse = true;
    const s = server({ adminUpdateOrderStatus: () => (refuse
      ? Promise.reject(Object.assign(new Error('orderId and status required'), { code: 'internal' }))
      : Promise.resolve({ success: true })) });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000, toast: (m, k) => toasts.push([m, k]), confirm: () => Promise.resolve(confirmAnswer) });
    await c.ready; await flush();
    c.actions.open('SKNAAA');
    el._selValue = 'delivered';
    click(el, { 'data-aoo': 'apply-status' }); await flush();
    row('update: declined confirm makes no call', !s.calls.some((x) => x.name === 'adminUpdateOrderStatus'));
    confirmAnswer = true;
    click(el, { 'data-aoo': 'apply-status' }); await flush();
    const up = s.calls.filter((x) => x.name === 'adminUpdateOrderStatus');
    row('update: calls adminUpdateOrderStatus { orderId, status } only', up.length === 1 && JSON.stringify(up[0].data) === '{"orderId":"SKNAAA","status":"delivered"}');
    row('update: server refusal shown verbatim, no success toast', /Not updated\. orderId and status required/.test(el.innerHTML) && toasts.length === 0);
    refuse = false;
    click(el, { 'data-aoo': 'apply-status' }); await flush();
    row('update: success toast only after the server resolved, list re-read', toasts.length === 1 && toasts[0][1] === 'success' &&
      s.calls.filter((x) => x.name === 'adminGetOrders').length === 2);
    el._selValue = 'paid';
    click(el, { 'data-aoo': 'apply-status' }); await flush();
    row('update: a status outside the vocabulary is refused before any call', s.calls.filter((x) => x.name === 'adminUpdateOrderStatus').length === 2 && /Choose a status first/.test(el.innerHTML));
  }

  /* refund: never written, never called */
  {
    const { M, writes } = loadModule(src);
    const s = server();
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000, confirm: () => Promise.resolve(true), toast: () => {} });
    await c.ready; await flush();
    c.actions.open('SKNAAB');
    const acts = (el.innerHTML.match(/data-aoo="([a-z-]+)"/g) || []).map((m) => m.slice(10, -1));
    for (const a of new Set(acts)) if (!['close', 'apply-status', 'refresh', 'more'].includes(a)) { click(el, { 'data-aoo': a, 'data-id': 'SKNAAB', 'data-uid': 'uidAAB', 'data-status': '' }); await flush(); c.actions.open('SKNAAB'); }
    row('refund: no Firestore write, no refund op called, from any drawer control', writes.length === 0 && !s.calls.some((x) => /refund/i.test(x.name)), JSON.stringify(writes));
  }

  /* escaping */
  {
    const { M } = loadModule(src);
    const evil = Object.assign(mkOrder(1), { id: 'SKN"><svg onload=x>', buyerName: '<img src=x onerror=alert(1)>',
      items: [{ name: '<script>bad()</script>', qty: 1, price: 5 }], status: '"><b>x' });
    const s = server({ adminGetOrders: { orders: [evil] } });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 }); await c.ready; await flush();
    c.actions.open(evil.id);
    const h = el.innerHTML;
    row('escaping: server strings never become markup', !/<img|<script|<svg onload|<b>x/i.test(h) && /&lt;img src=x/.test(h));
  }

  /* stale responses */
  {
    const { M } = loadModule(src);
    let releaseFirst;
    let n = 0;
    const s = server({ adminGetOrders: (d) => (++n === 1
      ? new Promise((r) => { releaseFirst = () => r({ orders: POOL.slice(0, 2) }); })
      : Promise.resolve({ orders: POOL.filter((o) => o.status === d.status).slice(0, 4) })) });
    const el = fakeEl();
    const c = M.mount(el, { call: s.call, timeoutMs: 2000 });
    c.actions.setStatus('cancelled'); await flush();
    releaseFirst(); await flush();
    row('a late response for an old tab never repaints the new one', (el.innerHTML.match(/<tr data-order=/g) || []).length === 4);
    M.unmount();
    el.innerHTML = 'OTHER TAB';
    c.actions.retry(); await flush();
    row('after unmount nothing paints over another tab', el.innerHTML === 'OTHER TAB');
  }

  return rows;
}

/* ── static checks ─────────────────────────────────────────────────────────────── */
function staticRows() {
  console.log('\nStatic — module, wiring, forbidden strings, mobile');
  const aos = read('sokoni-aos.js'), page = read('admin-os.html');
  const visible = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('forbidden strings absent from the module (Nexora, Upgrade to Pro, Create Order, Duplicate Order)',
    !/Nexora|Upgrade to Pro|Create Order|Duplicate Order/i.test(visible));
  ck('no dollar currency in module strings (currency is KES)', !/['"`][^'"`\n]*\$\s?\d/.test(visible) && !/USD/.test(visible));
  ck('module never touches Firestore or refundRequests (code, not prose)',
    !/firestore\(|\.collection\(|\.add\(|\.set\(|\.update\(|['"]refundRequests['"]/.test(visible));
  ck('module calls only the five census ops', (() => {
    const ops = new Set((visible.match(/call\('([A-Za-z]+)'/g) || []).map((m) => m.slice(6, -1)));
    const one = new Set((visible.match(/one\('[a-z]+', '([A-Za-z]+)'/g) || []).map((m) => m.split("'")[3]));
    const all = new Set([...ops, ...one]);
    return [...all].sort().join(',') === 'adminGetExecutiveDashboard,adminGetFinance,adminGetOrders,adminUpdateOrderStatus,getOrderTrends';
  })());
  ck('mobile: table becomes cards and the drawer a full-screen sheet at ≤768px',
    /@media \(max-width:768px\)/.test(SRC) && /\.aoo-table tr\{background/.test(SRC) && /\.aoo-drawer\{width:100%/.test(SRC));
  ck('mobile: 16px gutters and no horizontal page scroll', /padding:16px 16px 24px/.test(SRC) && /overflow-x:hidden/.test(SRC) && /\.aoo-table-wrap\{overflow-x:auto/.test(SRC));
  ck('wiring: orders tab mounts SokoniAOSOrders', /tab === "orders"\)[\s\S]{0,600}window\.SokoniAOSOrders\.mount\(body, \{\s*call: _call/.test(aos));
  ck('wiring: the old swallow-to-empty orders read is gone', !/adminGetOrders", \{ limit: 30 \}\)\.catch\(\(\) => \(\{ orders: \[\] \}\)\)/.test(aos));
  ck('wiring: every Marketplace tab change unmounts the Orders view', /function _marketplaceTab[\s\S]{0,500}SokoniAOSOrders\.unmount\(\)/.test(aos));
  ck('wiring: script tag loads before sokoni-aos.js', page.indexOf('<script src="sokoni-aos-orders.js">') > 0 &&
    page.indexOf('<script src="sokoni-aos-orders.js">') < page.indexOf('<script src="sokoni-aos.js">'));
  ck('navigation hierarchy unchanged (Marketplace → Orders child, tab button)', /data-section="marketplace" data-tab="orders"/.test(page) &&
    /<button class="tab-btn" data-tab="orders" onclick="SokoniAOS.marketplaceTab\('orders'\)">Orders<\/button>/.test(page));
  ck('admin-os.html self-updates (shared-header.js present)', /<script src="shared-header.js"/.test(page));
}

/* ── mutants ───────────────────────────────────────────────────────────────────── */
function mutate(from, to) {
  if (SRC.split(from).length !== 2) throw new Error('mutation anchor not unique: ' + from.slice(0, 60));
  return SRC.replace(from, to);
}

(async () => {
  console.log('AdminOS Orders — real module');
  const real = await runRows(SRC, false);
  staticRows();

  console.log('\nNegative control (a) — Gross revenue summed from the loaded page');
  const A_FROM = "function (d) { return d && d.reconciliation && d.reconciliation.productRevenue; }";
  const a = await runRows(mutate(A_FROM,
    "function () { return (_current && _current.state.orders || []).reduce(function (s, o) { return s + (o.total || 0); }, 0); }"), true);
  ck('control (a): row "KPI Gross revenue = server reconciliation.productRevenue (never a page sum)" FAILS', a['KPI Gross revenue = server reconciliation.productRevenue (never a page sum)'] === false);
  ck('control (a): unrelated row still passes', a['KPI Total orders = server totalOrders 1,834'] === true);

  console.log('\nNegative control (b) — Request refund writes refundRequests');
  const B_FROM = "'<section class=\"aoo-sec\"><h4>Actions</h4>' + actions";
  const B_DISPATCH = "else if (a === 'retry') c.actions.retry();";
  let bsrc = mutate(B_FROM, "'<section class=\"aoo-sec\"><h4>Actions</h4><button type=\"button\" data-aoo=\"refund\">Request refund</button>' + actions");
  bsrc = bsrc.replace(B_DISPATCH, B_DISPATCH + " else if (a === 'refund') { root.firebase.firestore().collection('refundRequests').add({ orderId: t.getAttribute('data-id') }); }");
  const b = await runRows(bsrc, true);
  ck('control (b): row "refund: no Firestore write, no refund op called, from any drawer control" FAILS', b['refund: no Firestore write, no refund op called, from any drawer control'] === false);
  ck('control (b): row "drawer: no Request refund / Resend receipt / Duplicate controls" FAILS', b['drawer: no Request refund / Resend receipt / Duplicate controls'] === false);
  ck('control (b): unrelated row still passes', b['KPI Total orders = server totalOrders 1,834'] === true);

  console.log('\nNegative control (c) — status tab filters the loaded page client-side');
  const C_FROM = "ctl.state.status = s; ctl.state.page = 1; ctl.state.limit = LIMIT_STEP; ctl.state.selectedId = null; ctl.state.orders = [];\n      return loadList();";
  const c = await runRows(mutate(C_FROM,
    "ctl.state.status = s; ctl.state.page = 1; ctl.state.selectedId = null; ctl.state.orders = (ctl.state._all = ctl.state._all || ctl.state.orders).filter(function (o) { return !s || o.status === s; }); render(); return Promise.resolve();"), true);
  ck('control (c): row "status filter is applied by the server (adminGetOrders called with status)" FAILS', c['status filter is applied by the server (adminGetOrders called with status)'] === false);
  ck('control (c): unrelated row still passes', c['KPI Total orders = server totalOrders 1,834'] === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\nFailures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
  void real;
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
