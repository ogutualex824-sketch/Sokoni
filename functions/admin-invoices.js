/* ════════════════════════════════════════════════════════════════════════════════════════════════════════
   Admin Invoices — READ-ONLY server reads for AdminOS / Super Admin (owner 2026-10-04)
   ────────────────────────────────────────────────────────────────────────────────────────────────────────
   Source of truth: the CANONICAL `invoices` store (owner decision). A document counts only when it is canonical —
   `modelVersion == 1` (stamped by canonical writers and by the legacy migration). Legacy documents the migration
   could not classify carry `classification: 'unknown'` and are EXCLUDED from every authoritative total (shown as a
   separate count). Not-yet-migrated documents are reported as a count, never summed.

   Money truth: paid = the sum of VERIFIED allocations (paidCents, written only by invoice-allocation.js from a
   verified payment event). A merchant / client reference is a payment CLAIM (paymentClaim.status 'unverified') —
   counted separately, never in confirmed paid, revenue, settlement, wallet or commission figures.

     adminInvoicesList   { tab, limit, cursor, withSummary }  → { invoices, cursor, summary }
     adminInvoicesExport { tab }                               → { csv, rows, truncated }  (AUDITED before returning)
   Admin / superAdmin claim + App Check. No writes except the export's audit row. Every summary figure is a Firestore
   aggregate over the whole canonical set; one the database cannot compute is null + reason, never 0.
   ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, AggregateField, FieldValue, Timestamp } = require('firebase-admin/firestore');
const M = require('./shared/invoice-model');

const COL = 'invoices';
const TABS = Object.freeze(['all', 'draft', 'issued', 'partially_paid', 'overdue', 'paid', 'void', 'unverified', 'unclassified']);
const OPEN = ['issued', 'partially_paid'];
const PAGE_MAX = 100, EXPORT_MAX = 5000, DAY = 86400000;

let _now = () => Date.now();
const _db = () => getFirestore();
function _requireAdmin(req) {
  if (!req || !req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const t = req.auth.token || {};
  if (t.admin !== true && t.superAdmin !== true) throw new HttpsError('permission-denied', 'Administrator access required.');
}
const _ms = (v) => { if (!v) return null; if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; } if (typeof v === 'number') return v; if (typeof v.toMillis === 'function') return v.toMillis(); return null; };
const _iso = (v) => { const t = _ms(v); return t ? new Date(t).toISOString() : null; };
const _int = (v) => (Number.isInteger(v) ? v : null);
const _str = (v, n) => (v == null ? null : String(v).slice(0, n || 200));

/* one place that turns a tab into a query on the canonical store */
function queryFor(db, tab, nowIso) {
  const c = db.collection(COL);
  if (tab === 'unclassified') return { q: c.where('classification', '==', 'unknown'), order: ['createdAt', 'desc'] };
  const canon = c.where('modelVersion', '==', M.MODEL_VERSION);
  if (tab === 'all') return { q: canon, order: ['createdAt', 'desc'] };
  if (tab === 'overdue') return { q: canon.where('status', 'in', OPEN).where('dueDate', '<', nowIso), order: ['dueDate', 'asc'] };
  if (tab === 'unverified') return { q: canon.where('paymentClaim.status', '==', 'unverified'), order: ['createdAt', 'desc'] };
  return { q: canon.where('status', '==', tab), order: ['createdAt', 'desc'] };
}

function shape(d, shopName, nowMs) {
  const x = d.data() || {};
  const items = Array.isArray(x.items) ? x.items : [];
  const claim = x.paymentClaim && typeof x.paymentClaim === 'object' ? x.paymentClaim : null;
  const tr = x.transactionRef && typeof x.transactionRef === 'object' ? x.transactionRef : null;
  return Object.assign({
    id: d.id, invoiceNumber: _str(x.invoiceNumber, 60),
    source: M.SOURCES.includes(x.source) ? x.source : null,
    classification: x.classification === 'unknown' ? 'unknown' : (x.modelVersion === M.MODEL_VERSION ? 'canonical' : 'unmigrated'),
    transactionRef: tr ? { kind: _str(tr.kind, 30), id: _str(tr.id, 128) } : null,
    shopId: _str(x.shopId, 128), sellerUid: _str(x.sellerUid, 128), shopName: shopName || null,
    clientName: _str(x.clientName, 160), clientEmail: _str(x.clientEmail, 200),
    currency: _str(x.currency || 'KES', 8),
    totalCents: _int(x.totalCents), paidCents: _int(x.paidCents), balanceCents: _int(x.balanceCents),
    subtotal: Number.isFinite(Number(x.subtotal)) ? Number(x.subtotal) : null, taxRate: Number.isFinite(Number(x.taxRate)) ? Number(x.taxRate) : null, tax: Number.isFinite(Number(x.tax)) ? Number(x.tax) : null,
    status: _str(x.status, 30), paymentStatus: _str(x.paymentStatus, 30),
    paymentClaim: claim ? { status: _str(claim.status, 20), reference: _str(claim.reference, 64), method: _str(claim.method, 20), source: _str(claim.source, 40) } : null,
    allocationCount: _int(x.allocationCount) || 0, reviewFlag: _str(x.reviewFlag, 40),
    dueDate: _iso(x.dueDate), createdAt: _iso(x.createdAt), issuedAt: _iso(x.issuedAt || x.sentAt), paidAt: _iso(x.paidAt), voidedAt: _iso(x.voidedAt),
    createdBy: _str(x.createdBy, 128), updatedAt: _iso(x.updatedAt), migratedAt: _iso(x.migratedAt),
    legacy: x.legacy && typeof x.legacy === 'object' ? { status: _str(x.legacy.status, 30), markedPaidAt: _iso(x.legacy.paidAt) } : null,
    itemCount: items.length,
    items: items.slice(0, 50).map((i) => ({ description: _str(i && i.description, 200), quantity: Number.isFinite(Number(i && i.quantity)) ? Number(i.quantity) : null, total: Number.isFinite(Number(i && i.total)) ? Number(i.total) : null })),
    notes: _str(x.notes, 1000),
  }, M.displayOf(x, nowMs));
}

async function _agg(label, q, spec, out, reasons) {
  try { const d = (await q.aggregate(spec).get()).data(); out[label] = {}; for (const k of Object.keys(spec)) out[label][k] = d[k] == null ? 0 : Number(d[k]); }
  catch (e) { out[label] = null; reasons[label] = /index/i.test(String(e && e.message)) ? 'index_missing' : 'unavailable'; }
}
async function summary(db, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const ago = (d) => new Date(nowMs - d * DAY).toISOString();
  const c = db.collection(COL), canon = c.where('modelVersion', '==', M.MODEL_VERSION);
  const cnt = { n: AggregateField.count() };
  const out = {}, why = {};
  const bal = { n: AggregateField.count(), bal: AggregateField.sum('balanceCents') };
  await Promise.all([
    _agg('everything', c, cnt, out, why),
    _agg('canonical', canon, cnt, out, why),
    _agg('unknown', c.where('classification', '==', 'unknown'), cnt, out, why),
    ...['draft', 'issued', 'partially_paid', 'paid', 'void'].map((s) => _agg('s_' + s, canon.where('status', '==', s), cnt, out, why)),
    _agg('invoiced', canon.where('status', 'in', ['issued', 'partially_paid', 'paid']), { sum: AggregateField.sum('totalCents') }, out, why),
    _agg('confirmedPaid', canon, { sum: AggregateField.sum('paidCents') }, out, why),
    _agg('open', canon.where('status', 'in', OPEN), bal, out, why),
    _agg('overdue', canon.where('status', 'in', OPEN).where('dueDate', '<', nowIso), bal, out, why),
    _agg('claims', canon.where('paymentClaim.status', '==', 'unverified'), cnt, out, why),
    _agg('a_current', canon.where('status', 'in', OPEN).where('dueDate', '>=', nowIso), bal, out, why),
    _agg('a_1_30', canon.where('status', 'in', OPEN).where('dueDate', '<', nowIso).where('dueDate', '>=', ago(30)), bal, out, why),
    _agg('a_31_60', canon.where('status', 'in', OPEN).where('dueDate', '<', ago(30)).where('dueDate', '>=', ago(60)), bal, out, why),
    _agg('a_61_90', canon.where('status', 'in', OPEN).where('dueDate', '<', ago(60)).where('dueDate', '>=', ago(90)), bal, out, why),
    _agg('a_91', canon.where('status', 'in', OPEN).where('dueDate', '<', ago(90)), bal, out, why),
  ]);
  const n = (k) => (out[k] ? out[k].n : null), s = (k, f) => (out[k] ? out[k][f || 'sum'] : null);
  const buckets = ['a_current', 'a_1_30', 'a_31_60', 'a_61_90', 'a_91'].map((k) => s(k, 'bal'));
  const undated = buckets.every((v) => v !== null) && s('open', 'bal') !== null ? Math.max(0, s('open', 'bal') - buckets.reduce((a, b) => a + b, 0)) : null;
  const unmigrated = n('everything') !== null && n('canonical') !== null && n('unknown') !== null ? Math.max(0, n('everything') - n('canonical') - n('unknown')) : null;
  return {
    asOf: nowIso, currency: 'KES', unit: 'cents',
    counts: { all: n('canonical'), draft: n('s_draft'), issued: n('s_issued'), partially_paid: n('s_partially_paid'), overdue: n('overdue'), paid: n('s_paid'), void: n('s_void'), unverified: n('claims'), unclassified: n('unknown') },
    totalInvoicedCents: s('invoiced'), confirmedPaidCents: s('confirmedPaid'), openBalanceCents: s('open', 'bal'), overdueBalanceCents: s('overdue', 'bal'),
    unverifiedClaims: n('claims'),
    aging: { current: buckets[0], d1_30: buckets[1], d31_60: buckets[2], d61_90: buckets[3], d91plus: buckets[4], undated },
    excluded: { unclassified: n('unknown'), unmigrated },
    unavailable: why,
  };
}

async function _pageOf(db, tab, limit, cursor, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const { q: base, order } = queryFor(db, tab, nowIso);
  let q = base.orderBy(order[0], order[1]).orderBy('__name__', order[1]);
  if (typeof cursor === 'string' && cursor.length < 600) {
    let v, id;
    try { [v, id] = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')); } catch (_) { throw new HttpsError('invalid-argument', 'Invalid cursor.'); }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpsError('invalid-argument', 'Invalid cursor.');
    q = q.startAfter(order[0] === 'createdAt' && typeof v === 'number' ? Timestamp.fromMillis(v) : v, id);
  }
  let snap;
  try { snap = await q.limit(limit + 1).get(); }
  catch (e) { if (/index/i.test(String(e && e.message))) throw new HttpsError('failed-precondition', 'This view needs a database index that is not deployed yet.', { reason: 'INDEX_MISSING' }); throw new HttpsError('unavailable', 'Invoices could not be read.'); }
  const docs = snap.docs.slice(0, limit);
  let next = null;
  if (snap.docs.length > limit && docs.length) { const last = docs[docs.length - 1]; const lv = (last.data() || {})[order[0]]; next = Buffer.from(JSON.stringify([order[0] === 'createdAt' ? _ms(lv) : lv, last.id]), 'utf8').toString('base64'); }
  return { docs, next };
}
async function _shopNames(db, docs) {
  const ids = [...new Set(docs.map((x) => (x.data() || {}).shopId).filter((s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s)))];
  const names = {};
  if (ids.length) { try { (await db.getAll(...ids.map((id) => db.collection('shops').doc(id)))).forEach((s) => { if (s.exists) { const x = s.data() || {}; names[s.id] = _str(x.name || x.storeName || x.businessName, 160); } }); } catch (_) {} }
  return names;
}

async function list(req) {
  _requireAdmin(req);
  const d = req.data || {};
  const tab = TABS.includes(d.tab) ? d.tab : 'all';
  const limit = Math.max(1, Math.min(PAGE_MAX, parseInt(d.limit, 10) || 25));
  const db = _db(), nowMs = _now();
  const { docs, next } = await _pageOf(db, tab, limit, d.cursor, nowMs);
  const names = await _shopNames(db, docs);
  const out = { invoices: docs.map((x) => shape(x, names[(x.data() || {}).shopId], nowMs)), cursor: next, tab };
  if (d.withSummary !== false) out.summary = await summary(db, nowMs);
  return out;
}

/* CSV export — the SAME admin-authorised query (complete set up to EXPORT_MAX), sensitive fields restricted (no phone,
   no line items), formula-safe, and AUDITED before the data leaves the server. */
const CSV_COLS = ['id', 'invoiceNumber', 'source', 'classification', 'transactionKind', 'transactionId', 'shopId', 'clientName', 'clientEmail', 'status', 'display', 'paymentStatus', 'claimStatus', 'currency', 'totalCents', 'paidCents', 'balanceCents', 'dueDate', 'createdAt'];
const _cell = (v) => { const s = v == null ? '' : String(v); return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"'; };
async function exportCsv(req) {
  _requireAdmin(req);
  const tab = TABS.includes((req.data || {}).tab) ? req.data.tab : 'all';
  const db = _db(), nowMs = _now();
  const rows = []; let cursor = null, truncated = false;
  do {
    const { docs, next } = await _pageOf(db, tab, PAGE_MAX, cursor, nowMs);
    for (const d of docs) { if (rows.length >= EXPORT_MAX) { truncated = true; break; } rows.push(shape(d, null, nowMs)); }
    cursor = next;
  } while (cursor && !truncated);
  await db.collection('adminAudit').add({ action: 'invoices_export', tab, rows: rows.length, truncated, columns: CSV_COLS, performedBy: req.auth.uid, createdAt: FieldValue.serverTimestamp() });
  const csv = [CSV_COLS.join(',')].concat(rows.map((r) => [r.id, r.invoiceNumber, r.source, r.classification, r.transactionRef && r.transactionRef.kind, r.transactionRef && r.transactionRef.id, r.shopId, r.clientName, r.clientEmail, r.status, r.display, r.paymentStatus, r.paymentClaim && r.paymentClaim.status, r.currency, r.totalCents, r.paidCents, r.balanceCents, r.dueDate, r.createdAt].map(_cell).join(','))).join('\n');
  return { csv, rows: rows.length, truncated, tab };
}

const OPTS = { region: 'us-central1', maxInstances: 10, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 120 };
exports.adminInvoicesList = onCall(OPTS, list);
exports.adminInvoicesExport = onCall(OPTS, exportCsv);
exports._internal = { list, exportCsv, summary, shape, queryFor, TABS, _setClock: (fn) => { _now = fn || (() => Date.now()); } };
