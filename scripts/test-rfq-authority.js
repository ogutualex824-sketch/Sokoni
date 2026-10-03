#!/usr/bin/env node
/* test-rfq-authority.js — the REAL functions/rfq.js against an in-memory Firestore stand-in. firebase-admin,
 * firebase-functions, ./procurement (the authority helpers) and ./notify are module-stubbed; no network.
 *   A  authority: acts only for an authorized, ACTIVE business; payload never names the caller
 *   C  consent: an RFQ reaches a supplier only with supply.enabled AND supply.acceptsLeads; never self; caps
 *   L  leads: exactly one b2bLeads row per (rfq, supplier) with the month; no price written here
 *   Q  quote: supplier-priced, totals computed server-side, VAT declared (0/16) never inferred, re-quote = version+1
 *   R  respond: accept → ONE canonical procPurchaseOrders doc priced from the quote (VAT from the quote), RFQ converted,
 *      other recipients closed, quote/recipient accepted; double accept refused; expired / stale version refused
 *   V  visibility: a non-recipient cannot read or quote; supplier sees viewed; buyer sees quotes in listMine
 *   N  notifications: received / quoted / accepted sent to the right owner uid
 * Run: node scripts/test-rfq-authority.js
 */
'use strict';
const path = require('path'), Module = require('module');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 220) + ']')); ok ? pass++ : fail++; };

/* ── in-memory Firestore ── */
const store = new Map(); let auto = 0; const TS = { __ts: true };
const ref = (col, id) => ({ id, path: col + '/' + id, _col: col,
  get: async () => ({ exists: store.has(col + '/' + id), id, data: () => store.get(col + '/' + id) }),
  set: async (d, o) => { store.set(col + '/' + id, Object.assign({}, o && o.merge ? store.get(col + '/' + id) || {} : {}, d)); },
  update: async (d) => { if (!store.has(col + '/' + id)) throw new Error('no doc ' + col + '/' + id); store.set(col + '/' + id, Object.assign({}, store.get(col + '/' + id), d)); },
  create: async (d) => { if (store.has(col + '/' + id)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(col + '/' + id, d); } });
const query = (col, f, lim) => ({ _q: true, where: (a, op, v) => query(col, f.concat([[a, v]]), lim), limit: (n) => query(col, f, n), orderBy: () => query(col, f, lim),
  get: async () => { const get = (o, k) => k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);
    let docs = [...store.entries()].filter(([k]) => k.startsWith(col + '/') && k.split('/').length === 2).map(([k, d]) => ({ id: k.slice(col.length + 1), data: () => d }));
    for (const [a, v] of f) docs = docs.filter((x) => get(x.data(), a) === v);
    if (lim) docs = docs.slice(0, lim); return { docs, empty: !docs.length }; } });
const db = { collection: (col) => Object.assign(query(col, [], 0), { doc: (id) => ref(col, id || ('auto' + (++auto))) }),
  batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), create: (r, d) => ops.push(() => r.create(d)),
    commit: async () => { for (const r of ops.filter(() => true)) await r(); } }; },
  runTransaction: async (fn) => { const writes = []; const out = await fn({ get: (r) => r.get(), set: (r, d, o) => writes.push(() => r.set(d, o)), update: (r, d) => writes.push(() => r.update(d)), create: (r, d) => writes.push(() => r.create(d)) }); for (const w of writes) await w(); return out; } };
const adminStub = { firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => TS } }) };
class HttpsError extends Error { constructor(code, m) { super(m); this.code = code; } }
const notes = [];
/* authority stub: uid → the business it may act for (owner); a requested id other than one's own is refused */
const OWNS = { uBuyer: 'bizBuyer', uSupA: 'bizSupA', uSupB: 'bizSupB', uSupC: 'bizSupC', uStranger: 'bizStranger', uInactive: 'bizInactive' };
const procStub = {
  _assertMerchantAuthority: async (req, requested) => { const own = OWNS[req.auth.uid]; if (!own) throw new HttpsError('permission-denied', 'no business'); if (requested && requested !== own) throw new HttpsError('permission-denied', 'not yours'); return own; },
  _assertActiveBusinessAudience: async (id, m1, m2) => { const d = store.get('businesses/' + id); if (!d) throw new HttpsError('failed-precondition', m1); if (d.status !== 'active') throw new HttpsError('failed-precondition', m2); return d; },
};
const _load = Module._load;
Module._load = function (req) {
  if (req === 'firebase-admin') return adminStub;
  if (req === 'firebase-functions/v2/https') return { onCall: (o, h) => h, HttpsError };
  if (req === './procurement') return procStub;
  if (req === './notify') return { notify: async (n) => { notes.push(n); } };
  return _load.apply(this, arguments);
};
const RFQ = require(path.join(ROOT, 'functions', 'rfq.js'));   /* stubs stay installed: rfq.js requires ./procurement and ./notify lazily */
const call = async (uid, data) => { try { return { ok: true, r: await RFQ.rfqDispatch({ auth: uid ? { uid, token: {} } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const biz = (id, owner, extra) => store.set('businesses/' + id, Object.assign({ name: id, ownerId: owner, status: 'active', county: 'Nairobi' }, extra || {}));
biz('bizBuyer', 'uBuyer');
biz('bizSupA', 'uSupA', { supply: { enabled: true, acceptsLeads: true, acceptsLeadsAt: 'T-A', discoverable: true, categories: ['cement'], displayName: 'Supplier A' } });
biz('bizSupB', 'uSupB', { supply: { enabled: true, acceptsLeads: true, discoverable: true, categories: ['cement'] } });
biz('bizSupC', 'uSupC', { supply: { enabled: true, discoverable: true, categories: ['cement'] } });   /* no lead consent */
biz('bizStranger', 'uStranger', { supply: { enabled: true, acceptsLeads: true, discoverable: true, categories: ['steel'] } });
biz('bizInactive', 'uInactive', { status: 'pending' });
const ITEMS = [{ name: 'Cement 50kg', qty: 100, unit: 'bag', targetPriceKES: 700 }];

(async () => {
  console.log('\n── A: authority ──');
  let r = await call(null, { op: 'listMine' });
  ck('A1 signed out → unauthenticated', !r.ok && r.code === 'unauthenticated', r);
  r = await call('uNobody', { op: 'create', items: ITEMS, supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Ruiru' });
  ck('A2 an account with no business cannot send an RFQ', !r.ok && r.code === 'permission-denied', r);
  r = await call('uInactive', { op: 'create', items: ITEMS, supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Ruiru' });
  ck('A3 an inactive business cannot send an RFQ', !r.ok && r.code === 'failed-precondition', r);
  r = await call('uBuyer', { op: 'create', merchantId: 'bizSupA', items: ITEMS, supplierBusinessIds: ['bizSupB'], deliveryLocation: 'Ruiru' });
  ck('A4 naming someone else\'s business in the payload is refused', !r.ok && r.code === 'permission-denied', r);

  console.log('\n── C: consent + caps ──');
  r = await call('uBuyer', { op: 'create', items: ITEMS, supplierBusinessIds: ['bizSupC'], deliveryLocation: 'Ruiru' });
  ck('C1 a supplier without supply.acceptsLeads cannot be sent an RFQ (a lead costs money)', !r.ok && /not accepting RFQs/.test(r.msg), r);
  r = await call('uBuyer', { op: 'create', items: ITEMS, supplierBusinessIds: ['bizBuyer'], deliveryLocation: 'Ruiru' });
  ck('C2 never to one\'s own business', !r.ok, r);
  r = await call('uBuyer', { op: 'create', items: ITEMS, supplierBusinessIds: Array.from({ length: 11 }, (_, i) => 'x' + i), deliveryLocation: 'Ruiru' });
  ck('C3 at most 10 named suppliers', !r.ok && /at most 10/.test(r.msg), r);
  r = await call('uBuyer', { op: 'create', items: [], supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Ruiru' });
  ck('C4 at least one item', !r.ok, r);
  r = await call('uBuyer', { op: 'create', items: ITEMS, open: { category: 'cement' }, deliveryLocation: 'Ruiru', title: 'Cement for site' });
  const openR = r;
  ck('C5 open RFQ reaches only discoverable + consenting suppliers in the category (A, B — not C, not steel)', r.ok && r.r.mode === 'open' && r.r.recipients.map((x) => x.supplierBusinessId).sort().join() === 'bizSupA,bizSupB', r);
  r = await call('uBuyer', { op: 'create', items: ITEMS, open: { category: 'glass' }, deliveryLocation: 'Ruiru' });
  ck('C6 open RFQ with no consenting supplier → honest refusal (nothing created)', !r.ok && /No supplier/.test(r.msg), r);

  console.log('\n── L: leads ──');
  const rfqId = openR.r.rfqId;
  const leads = [...store.entries()].filter(([k]) => k.startsWith('b2bLeads/' + rfqId + '__'));
  ck('L1 exactly one lead per recipient, with supplier, rfq, buyer and month', leads.length === 2 && leads.every(([, v]) => v.rfqId === rfqId && v.buyerBusinessId === 'bizBuyer' && /^\d{4}-\d{2}$/.test(v.month)), leads.map((x) => x[1]));
  ck('L2 no price / amount written on a lead (the commercial authority prices the monthly invoice)', leads.every(([, v]) => !('priceKES' in v) && !('amount' in v)));
  ck('L3 each lead records the supplier\'s consent evidence (consentAcceptsLeadsAt from supply.acceptsLeadsAt)', leads.every(([k, v]) => 'consentAcceptsLeadsAt' in v) && leads.find(([k]) => k.endsWith('__bizSupA'))[1].consentAcceptsLeadsAt === 'T-A', leads.map((x) => x[1].consentAcceptsLeadsAt));
  /* RACE: consent withdrawn between selection and the delivery transaction → that supplier is not billed */
  const realTxn = db.runTransaction;
  db.runTransaction = async (fn) => { const b = store.get('businesses/bizSupB'); store.set('businesses/bizSupB', Object.assign({}, b, { supply: Object.assign({}, b.supply, { acceptsLeads: false }) })); db.runTransaction = realTxn; return realTxn(fn); };
  r = await call('uBuyer', { op: 'create', items: ITEMS, open: { category: 'cement' }, deliveryLocation: 'Juja' });
  const raceLeads = r.ok ? [...store.keys()].filter((k) => k.startsWith('b2bLeads/' + r.r.rfqId + '__')) : [];
  ck('C7 a supplier who withdraws consent mid-delivery is NOT delivered or billed (only A gets the lead)', r.ok && raceLeads.length === 1 && raceLeads[0].endsWith('__bizSupA') && r.r.recipients.length === 1, { r, raceLeads });
  const bB = store.get('businesses/bizSupB'); store.set('businesses/bizSupB', Object.assign({}, bB, { supply: Object.assign({}, bB.supply, { acceptsLeads: true }) }));

  console.log('\n── V / Q: supplier side ──');
  r = await call('uStranger', { op: 'get', rfqId });
  ck('V1 a non-recipient cannot read the RFQ (same answer as missing)', !r.ok && r.code === 'not-found', r);
  r = await call('uSupA', { op: 'get', rfqId });
  ck('V2 a recipient reads it; opening marks it viewed; the buyer\'s contact details are not exposed', r.ok && r.r.status === 'viewed' && !JSON.stringify(r.r).match(/phone|email|uBuyer/), r.r);
  r = await call('uSupA', { op: 'quote', rfqId, lines: [{ name: 'Cement 50kg', qty: 100, unitPriceKES: 690 }], validDays: 7 });
  ck('Q1 a quote without a VAT declaration is refused (never inferred)', !r.ok && /VAT/.test(r.msg), r);
  r = await call('uSupA', { op: 'quote', rfqId, lines: [{ name: 'Cement 50kg', qty: 100, unitPriceKES: 690 }], vatRate: 16, deliveryFeeKES: 2000, validDays: 7 });
  ck('Q2 supplier quotes: subtotal 69,000 + VAT 11,040 + delivery 2,000 = 82,040 computed server-side', r.ok && r.r.totalKES === 82040 && r.r.version === 1, r);
  r = await call('uSupA', { op: 'quote', rfqId, lines: [{ name: 'Cement 50kg', qty: 100, unitPriceKES: 680 }], vatRate: 16, deliveryFeeKES: 2000, validDays: 7 });
  ck('Q3 re-quote (negotiation) → version 2, new total', r.ok && r.r.version === 2 && r.r.totalKES === 80880, r);
  r = await call('uSupB', { op: 'quote', rfqId, lines: [{ name: 'Cement 50kg', qty: 100, unitPriceKES: 700 }], vatRate: 0, validDays: 3 });
  ck('Q4 a non-VAT supplier declares 0 — no VAT added', r.ok && r.r.totalKES === 70000, r);
  r = await call('uStranger', { op: 'quote', rfqId, lines: [{ name: 'x', qty: 1, unitPriceKES: 1 }], vatRate: 0, validDays: 3 });
  ck('Q5 a non-recipient cannot quote', !r.ok && r.code === 'not-found', r);
  r = await call('uBuyer', { op: 'listMine' });
  const mine = r.ok && r.r.rfqs.find((x) => x.rfqId === rfqId);
  ck('V3 the buyer sees both quotations in My RFQs (with version and totals)', !!mine && mine.recipients.filter((x) => x.quote).length === 2 && mine.recipients.find((x) => x.supplierBusinessId === 'bizSupA').quote.version === 2, mine);
  r = await call('uSupA', { op: 'listReceived' });
  ck('V4 the supplier sees the RFQ in its inbox with status quoted', r.ok && r.r.rfqs.some((x) => x.rfqId === rfqId && x.status === 'quoted'), r.r);

  console.log('\n── R: respond ──');
  r = await call('uBuyer', { op: 'respond', rfqId, supplierBusinessId: 'bizSupA', action: 'accept', expectedVersion: 1 });
  ck('R1 accepting a stale version is refused (supplier re-quoted)', !r.ok && r.code === 'aborted', r);
  r = await call('uSupA', { op: 'respond', rfqId, supplierBusinessId: 'bizSupA', action: 'accept' });
  ck('R2 the supplier cannot accept its own quote (buyer only)', !r.ok, r);
  r = await call('uBuyer', { op: 'respond', rfqId, supplierBusinessId: 'bizSupA', action: 'accept', expectedVersion: 2 });
  ck('R3 the buyer accepts v2 → a purchase order id', r.ok && /^po_rfq_/.test(r.r.poId), r);
  const po = r.ok && store.get('procPurchaseOrders/' + r.r.poId);
  ck('R4 ONE canonical procPurchaseOrders doc priced from the quote: total 80,880, VAT 16 from the quote, source rfq, unpaid draft', !!po && po.total === 80880 && po.vatRate === 16 && po.source.kind === 'rfq' && po.status === 'draft' && po.paymentStatus === 'unpaid' && po.buyerBusinessId === 'bizBuyer' && po.supplierBusinessId === 'bizSupA', po);
  const link = [...store.entries()].find(([k, v]) => k.startsWith('procSuppliers/') && v.merchantId === 'bizBuyer' && v.supplierBusinessId === 'bizSupA');
  ck('R5 the buyer\'s supplier link exists in the procurement authority (procSuppliers, createdVia rfq) and the PO points at it', !!link && po.supplierId === link[1].supplierId, link && link[1]);
  ck('R6 RFQ converted; A accepted; B closed', store.get('rfqs/' + rfqId).status === 'converted' && store.get('rfqRecipients/' + rfqId + '__bizSupA').status === 'accepted' && store.get('rfqRecipients/' + rfqId + '__bizSupB').status === 'closed');
  r = await call('uBuyer', { op: 'respond', rfqId, supplierBusinessId: 'bizSupB', action: 'accept' });
  ck('R7 a second acceptance on a converted RFQ is refused', !r.ok && r.code === 'failed-precondition', r);
  r = await call('uSupB', { op: 'quote', rfqId, lines: [{ name: 'Cement', qty: 1, unitPriceKES: 1 }], vatRate: 0, validDays: 3 });
  ck('R8 quoting on a converted RFQ is refused', !r.ok, r);

  /* expired quote */
  r = await call('uBuyer', { op: 'create', items: ITEMS, supplierBusinessIds: ['bizSupB'], deliveryLocation: 'Thika' });
  const r2 = r.r.rfqId;
  await call('uSupB', { op: 'quote', rfqId: r2, lines: [{ name: 'Cement', qty: 100, unitPriceKES: 700 }], vatRate: 0, validDays: 3 });
  store.set('rfqQuotes/' + r2 + '__bizSupB', Object.assign({}, store.get('rfqQuotes/' + r2 + '__bizSupB'), { validUntilMs: Date.now() - 1000 }));
  r = await call('uBuyer', { op: 'respond', rfqId: r2, supplierBusinessId: 'bizSupB', action: 'accept' });
  ck('R9 an expired quotation cannot be accepted', !r.ok && /expired/.test(r.msg), r);
  r = await call('uBuyer', { op: 'respond', rfqId: r2, supplierBusinessId: 'bizSupB', action: 'reject' });
  ck('R10 the buyer can reject a quotation', r.ok && store.get('rfqQuotes/' + r2 + '__bizSupB').status === 'rejected', r);
  r = await call('uBuyer', { op: 'cancel', rfqId: r2 });
  ck('R11 the buyer cancels an open RFQ; recipients closed', r.ok && store.get('rfqs/' + r2).status === 'cancelled' && store.get('rfqRecipients/' + r2 + '__bizSupB').status === 'closed', r);

  console.log('\n── N: notifications ──');
  ck('N1 rfq_received → each recipient owner (uSupA, uSupB) once per RFQ', notes.filter((n) => n.type === 'rfq_received' && n.data.rfqId === rfqId).map((n) => n.uid).sort().join() === 'uSupA,uSupB');
  ck('N2 rfq_quoted → the buyer who created it', notes.some((n) => n.type === 'rfq_quoted' && n.uid === 'uBuyer'));
  ck('N3 rfq_accepted → the winning supplier\'s owner', notes.some((n) => n.type === 'rfq_accepted' && n.uid === 'uSupA'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
