/* ════════════════════════════════════════════════════════════════════════════════════════════════════════
   adminInvoicesList — the admin Invoices page's ONE read (owner 2026-10-04: "merchant invoices only")
   ────────────────────────────────────────────────────────────────────────────────────────────────────────
   Source: the `invoices` collection — the merchant invoice store written by finance-os invoiceCreate / Send /
   MarkPaid / Void. Other invoice stores (etimsInvoices, hubInvoices, procSupplierInvoices, sasos/fos) are NOT mixed
   in: the owner's "one document system" has not yet named its canonical store, and presenting six systems as one
   would be a fabricated catalogue.

   READ-ONLY. Admin / superAdmin custom claim + App Check. Returns:
     invoices  one page (≤ 100), newest first or by due date, with a SERVER-derived display status
               (sent + due date passed ⇒ overdue, with days overdue) and the shop's name;
     summary   catalogue-wide figures computed by the DATABASE (count() / sum() aggregations), each independently:
               a figure the database cannot compute (missing composite index, error) is returned as null with its
               reason — the page renders "—", never 0 and never an estimate.
     cursor    an opaque cursor for the next page, or null.
   Money stays in the store's unit (KES, the invoice's `total`). Nothing here moves money; there is no write.
   ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, AggregateField, Timestamp } = require('firebase-admin/firestore');

const COL = 'invoices';
const TABS = Object.freeze(['all', 'draft', 'open', 'overdue', 'paid', 'void']);
const STORE_STATUS = Object.freeze({ draft: 'draft', open: 'sent', paid: 'paid', void: 'void' });
const PAGE_MAX = 100;
const DAY = 86400000;

let _now = () => Date.now();
const _db = () => getFirestore();

function _requireAdmin(req) {
  const t = (req && req.auth && req.auth.token) || {};
  if (!req || !req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (t.admin !== true && t.superAdmin !== true) throw new HttpsError('permission-denied', 'Administrator access required.');
}
const _ms = (v) => { if (!v) return null; if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; } if (typeof v === 'number') return v; if (typeof v.toMillis === 'function') return v.toMillis(); if (v._seconds) return v._seconds * 1000; return null; };
const _iso = (v) => { const t = _ms(v); return t ? new Date(t).toISOString() : null; };
const _num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const _str = (v, n) => (v == null ? null : String(v).slice(0, n || 200));

/* the display status is DERIVED on the server from stored facts only */
function displayOf(inv, nowMs) {
  const st = String(inv.status || '');
  const due = _ms(inv.dueDate);
  if (st === 'sent' && due !== null && due < nowMs) return { display: 'overdue', daysOverdue: Math.floor((nowMs - due) / DAY) };
  if (st === 'sent') return { display: 'open', daysLeft: due !== null ? Math.ceil((due - nowMs) / DAY) : null };
  if (st === 'draft' || st === 'paid' || st === 'void') return { display: st };
  return { display: st || 'unknown' };
}

function shape(d, shopName, nowMs) {
  const x = d.data() || {};
  const items = Array.isArray(x.items) ? x.items : [];
  const total = _num(x.total);
  const st = String(x.status || '');
  return Object.assign({
    id: d.id,
    invoiceNumber: _str(x.invoiceNumber, 60),
    shopId: _str(x.shopId, 128), shopName: shopName || null,
    clientName: _str(x.clientName, 160), clientEmail: _str(x.clientEmail, 200), clientPhone: _str(x.clientPhone, 30),
    currency: _str(x.currency || 'KES', 8),
    subtotal: _num(x.subtotal), taxRate: _num(x.taxRate), tax: _num(x.tax), total,
    /* balance due is a fact of the status: paid/void owe nothing; sent/draft owe the total */
    balanceDue: total === null ? null : (st === 'paid' || st === 'void' ? 0 : total),
    status: st || null,
    dueDate: _iso(x.dueDate), createdAt: _iso(x.createdAt), sentAt: _iso(x.sentAt), paidAt: _iso(x.paidAt), voidedAt: _iso(x.voidedAt),
    paymentMethod: _str(x.paymentMethod, 40),
    paymentReferenced: !!x.paymentRef,                 /* presence only — a client-supplied reference is not proof */
    itemCount: items.length,
    items: items.slice(0, 50).map((i) => ({ description: _str(i && i.description, 200), quantity: _num(i && i.quantity), unitPrice: _num(i && i.unitPrice), total: _num(i && i.total) })),
    notes: _str(x.notes, 1000),
    recurring: x.recurring === true ? true : (x.billingType ? _str(x.billingType, 30) : null),
  }, displayOf(x, nowMs));
}

/* ── catalogue figures: each aggregation stands alone; a failure is null + reason, never 0 ─────────────────── */
async function _agg(label, q, spec, out, reasons) {
  try {
    const snap = await q.aggregate(spec).get();
    const d = snap.data();
    out[label] = {};
    for (const k of Object.keys(spec)) out[label][k] = d[k] == null ? 0 : Number(d[k]);   /* a real aggregate of zero docs IS 0 */
  } catch (e) {
    out[label] = null;
    reasons[label] = /index/i.test(String(e && e.message)) ? 'index_missing' : 'unavailable';
  }
}
async function summary(db, nowMs) {
  const c = db.collection(COL);
  const nowIso = new Date(nowMs).toISOString();
  const iso = (offsetDays) => new Date(nowMs - offsetDays * DAY).toISOString();
  const out = {}, reasons = {};
  const cnt = { n: AggregateField.count() }, cs = { n: AggregateField.count(), sum: AggregateField.sum('total') };
  await Promise.all([
    _agg('all', c, cnt, out, reasons),
    _agg('draft', c.where('status', '==', 'draft'), cnt, out, reasons),
    _agg('open', c.where('status', '==', 'sent'), cs, out, reasons),
    _agg('paid', c.where('status', '==', 'paid'), cnt, out, reasons),
    _agg('void', c.where('status', '==', 'void'), cnt, out, reasons),
    _agg('invoiced', c.where('status', 'in', ['sent', 'paid']), cs, out, reasons),
    _agg('paid30', c.where('status', '==', 'paid').where('paidAt', '>=', Timestamp.fromMillis(nowMs - 30 * DAY)), cs, out, reasons),
    _agg('overdue', c.where('status', '==', 'sent').where('dueDate', '<', nowIso), cs, out, reasons),
    _agg('agingCurrent', c.where('status', '==', 'sent').where('dueDate', '>=', nowIso), cs, out, reasons),
    _agg('aging1_30', c.where('status', '==', 'sent').where('dueDate', '<', nowIso).where('dueDate', '>=', iso(30)), cs, out, reasons),
    _agg('aging31_60', c.where('status', '==', 'sent').where('dueDate', '<', iso(30)).where('dueDate', '>=', iso(60)), cs, out, reasons),
    _agg('aging61_90', c.where('status', '==', 'sent').where('dueDate', '<', iso(60)).where('dueDate', '>=', iso(90)), cs, out, reasons),
    _agg('aging91', c.where('status', '==', 'sent').where('dueDate', '<', iso(90)), cs, out, reasons),
  ]);
  const n = (k) => (out[k] ? out[k].n : null), s = (k) => (out[k] ? out[k].sum : null);
  /* "no due date" open invoices are in `open` but in no aging bucket — reported so the buckets never silently miss money */
  const bucketSum = ['agingCurrent', 'aging1_30', 'aging31_60', 'aging61_90', 'aging91'].map(s);
  const undated = bucketSum.every((v) => v !== null) && s('open') !== null ? Math.max(0, Math.round((s('open') - bucketSum.reduce((a, b) => a + b, 0)) * 100) / 100) : null;
  return {
    asOf: nowIso,
    counts: { all: n('all'), draft: n('draft'), open: n('open'), overdue: n('overdue'), paid: n('paid'), void: n('void') },
    totalInvoiced: s('invoiced'), paidLast30Days: s('paid30'), openAmount: s('open'), overdueAmount: s('overdue'),
    aging: { current: s('agingCurrent'), d1_30: s('aging1_30'), d31_60: s('aging31_60'), d61_90: s('aging61_90'), d91plus: s('aging91'), undated },
    unavailable: reasons,   /* label → 'index_missing' | 'unavailable' */
  };
}

async function list(req) {
  _requireAdmin(req);
  const d = req.data || {};
  const tab = TABS.includes(d.tab) ? d.tab : 'all';
  const limit = Math.max(1, Math.min(PAGE_MAX, parseInt(d.limit, 10) || 25));
  const db = _db();
  const nowMs = _now();
  const nowIso = new Date(nowMs).toISOString();
  let q = db.collection(COL);
  let orderField = 'createdAt', dir = 'desc';
  if (tab === 'overdue') { q = q.where('status', '==', 'sent').where('dueDate', '<', nowIso); orderField = 'dueDate'; dir = 'asc'; }
  else if (tab !== 'all') q = q.where('status', '==', STORE_STATUS[tab]);
  q = q.orderBy(orderField, dir).orderBy('__name__', dir);
  /* cursor = [orderValue, docId], opaque base64 JSON — never a client-chosen query */
  if (typeof d.cursor === 'string' && d.cursor.length < 600) {
    try {
      const [v, id] = JSON.parse(Buffer.from(d.cursor, 'base64').toString('utf8'));
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        const val = orderField === 'createdAt' && typeof v === 'number' ? Timestamp.fromMillis(v) : v;
        q = q.startAfter(val, id);
      }
    } catch (_) { throw new HttpsError('invalid-argument', 'Invalid cursor.'); }
  }
  let snap;
  try { snap = await q.limit(limit + 1).get(); }
  catch (e) {
    if (/index/i.test(String(e && e.message))) throw new HttpsError('failed-precondition', 'This view needs a database index that is not deployed yet.', { reason: 'INDEX_MISSING' });
    throw new HttpsError('unavailable', 'Invoices could not be read.');
  }
  const docs = snap.docs.slice(0, limit);
  const more = snap.docs.length > limit;
  const shopIds = [...new Set(docs.map((x) => (x.data() || {}).shopId).filter((s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s)))];
  const names = {};
  if (shopIds.length) {
    try {
      const shops = await db.getAll(...shopIds.map((id) => db.collection('shops').doc(id)));
      shops.forEach((s) => { if (s.exists) { const x = s.data() || {}; names[s.id] = _str(x.name || x.storeName || x.businessName, 160); } });
    } catch (_) { /* names are a convenience — the invoice still lists with its shopId */ }
  }
  const rows = docs.map((x) => shape(x, names[(x.data() || {}).shopId], nowMs));
  let cursor = null;
  if (more && docs.length) {
    const last = docs[docs.length - 1]; const lv = (last.data() || {})[orderField];
    cursor = Buffer.from(JSON.stringify([orderField === 'createdAt' ? _ms(lv) : lv, last.id]), 'utf8').toString('base64');
  }
  const out = { invoices: rows, cursor, tab };
  if (d.withSummary !== false) out.summary = await summary(db, nowMs);
  return out;
}

exports.adminInvoicesList = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 }, list);
exports._internal = { list, summary, displayOf, shape, TABS, _setClock: (fn) => { _now = fn || (() => Date.now()); } };
