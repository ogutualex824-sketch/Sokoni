'use strict';
/**
 * READ-ONLY probe: marketplace double credit (webhook FinOS credit + settleOrder balance credit).
 * See docs/MARKETPLACE_DOUBLE_CREDIT_MEASUREMENT.md. Issues only GET and :runQuery — no write verbs.
 * Requires gcloud user auth (CLOUDSDK_PYTHON on Windows). Exit 2 = probe failure, never a verdict.
 */
/* READ-ONLY Firestore REST helper. Only GET and :runQuery are issued — no write verbs exist here. */
const { execSync } = require('child_process');
const PROJECT = 'sokoni-aeb26';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
let TOKEN = null;
function token() {
  if (!TOKEN) {
    TOKEN = execSync('gcloud auth print-access-token', { env: process.env, encoding: 'utf8' }).trim();
  }
  return TOKEN;
}
function hdr() {
  return { Authorization: 'Bearer ' + token(), 'x-goog-user-project': PROJECT, 'Content-Type': 'application/json' };
}
function val(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('mapValue' in v) return obj(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  return v;
}
function obj(fields) { const o = {}; for (const k of Object.keys(fields || {})) o[k] = val(fields[k]); return o; }
function enc(x) {
  if (x === null) return { nullValue: null };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  return { stringValue: String(x) };
}
async function get(path) {
  const r = await fetch(`${BASE}/${path}`, { headers: hdr() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  const d = await r.json();
  return Object.assign({ _id: d.name.split('/').pop(), _path: d.name.split('/documents/')[1], _updateTime: d.updateTime }, obj(d.fields));
}
/* where: [[field, op, value], ...]  op in EQUAL, IN, GREATER_THAN ... ; parent: '' or 'wallets/uid' */
async function query(collection, where, opts) {
  opts = opts || {};
  const sq = { from: [{ collectionId: collection, allDescendants: !!opts.group }], limit: opts.limit || 1000 };
  if (where && where.length) {
    const fs = where.map(([f, op, v]) => ({ fieldFilter: { field: { fieldPath: f }, op,
      value: Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : enc(v) } }));
    sq.where = fs.length === 1 ? fs[0] : { compositeFilter: { op: 'AND', filters: fs } };
  }
  const url = opts.parent ? `${BASE}/${opts.parent}:runQuery` : `${BASE}:runQuery`;
  const r = await fetch(url, { method: 'POST', headers: hdr(), body: JSON.stringify({ structuredQuery: sq }) });
  if (!r.ok) throw new Error(`runQuery ${collection} -> ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows.filter((x) => x.document).map((x) => Object.assign({
    _id: x.document.name.split('/').pop(), _path: x.document.name.split('/documents/')[1],
    _createTime: x.document.createTime }, obj(x.document.fields)));
}



(async () => {
  const out = {};

  /* Direction A — every settleOrder credit (deterministic walletTransactions rows). */
  const settleRows = await query('walletTransactions', [['type', 'EQUAL', 'order_settlement']]);
  out.settleOrderCredits = settleRows.length;

  /* Direction B — every webhook marketplace credit (payments stamped walletCreditedAt, non-booking). */
  const credited = await query('payments', [['walletCreditCents', 'GREATER_THAN', 0]]);
  out.paymentsWithWalletCredit = credited.length;

  /* Positive controls: the collections are readable and non-empty where expected. */
  out.control_settlements = (await query('settlements', [], { limit: 1000 })).length;
  out.control_ordersSettledLower = (await query('orders', [['settlementStatus', 'EQUAL', 'settled']])).length;
  out.control_ordersSettledUpper = (await query('orders', [['settlementStatus', 'EQUAL', 'SETTLED']])).length;
  out.control_ordersCompleted = (await query('orders', [['status', 'EQUAL', 'completed']])).length;

  /* Join from B: webhook-credited payment -> its order -> did settleOrder ALSO credit? */
  const both = [];
  const bRows = [];
  for (const p of credited) {
    const meta = p.meta || {};
    const orderId = meta.orderId || null;
    const booking = meta.type === 'booking' || meta.type === 'service-booking';
    const seller = p.walletCreditedTo || null;
    let order = null, settleTx = null, settlement = null;
    if (orderId) {
      order = await get(`orders/${orderId}`);
      if (seller) settleTx = await get(`walletTransactions/${seller}_${orderId}_ordersettle`);
      settlement = await get(`settlements/${orderId}`);
    }
    const row = {
      apiRef: p._id, orderId, booking, seller,
      webhookCreditCents: p.walletCreditCents, webhookCreditedAt: p.walletCreditedAt,
      paymentStatus: p.status || p.state || null, amount: p.amount || null,
      orderStatus: order ? order.status : (orderId ? 'ORDER_MISSING' : null),
      orderSettlementStatus: order ? (order.settlementStatus ?? null) : null,
      settleTxAmountShillings: settleTx ? settleTx.amount : null,
      settleTxAppliedToDebt: settleTx ? (settleTx.appliedToDebt ?? null) : null,
      settleTxCreatedAt: settleTx ? settleTx.createdAt : null,
      settlementDoc: !!settlement,
      settlementSellerUid: settlement ? (settlement.sellerId || settlement.sellerUid || null) : null,
      refundStatus: order ? (order.refundStatus || null) : null,
    };
    bRows.push(row);
    if (settleTx) both.push(row);
  }

  /* Join from A: settleOrder credit -> is there a webhook credit for the same order? */
  const aRows = [];
  for (const s of settleRows) {
    const m = /^(.+)_(.+)_ordersettle$/.exec(s._id);
    const orderId = s.orderId || (m ? m[2] : null);
    const pays = orderId ? await query('payments', [['meta.orderId', 'EQUAL', orderId]]) : [];
    const order = orderId ? await get(`orders/${orderId}`) : null;
    aRows.push({
      settleTxId: s._id, uid: s.uid, orderId, amountShillings: s.amount,
      appliedToDebt: s.appliedToDebt ?? null, createdAt: s.createdAt,
      orderStatus: order ? order.status : 'ORDER_MISSING',
      orderSettlementStatus: order ? (order.settlementStatus ?? null) : null,
      orderPaymentMethod: order ? (order.paymentMethod || null) : null,
      paymentsForOrder: pays.map((p) => ({ apiRef: p._id, walletCreditCents: p.walletCreditCents ?? null,
        walletCreditedTo: p.walletCreditedTo ?? null, status: p.status || p.state || null })),
    });
  }

  out.doubleCreditedFromB = both.length;
  out.doubleCreditedFromA = aRows.filter((r) => r.paymentsForOrder.some((p) => (p.walletCreditCents || 0) > 0)).length;
  console.log(JSON.stringify({ summary: out, both, aRows, bRows }, null, 2));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(2); });
