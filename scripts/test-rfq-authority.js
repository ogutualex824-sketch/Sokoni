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
  if (req === './b2b-leads') { if (!global.__leadsStub) { const e = new Error('Cannot find module'); e.code = 'MODULE_NOT_FOUND'; throw e; } return global.__leadsStub; }
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
  ck('L2 without the commercial module no price is written on a lead (the invoice prices it at billing time)', leads.every(([, v]) => !('priceKES' in v) && !('amount' in v)));
  ck('L3 each lead records the supplier\'s consent evidence (consentAcceptsLeadsAt from supply.acceptsLeadsAt)', leads.every(([k, v]) => 'consentAcceptsLeadsAt' in v) && leads.find(([k]) => k.endsWith('__bizSupA'))[1].consentAcceptsLeadsAt === 'T-A', leads.map((x) => x[1].consentAcceptsLeadsAt));
  /* RACE: consent withdrawn between selection and the delivery transaction → that supplier is not billed */
  const realTxn = db.runTransaction;
  db.runTransaction = async (fn) => { const b = store.get('businesses/bizSupB'); store.set('businesses/bizSupB', Object.assign({}, b, { supply: Object.assign({}, b.supply, { acceptsLeads: false }) })); db.runTransaction = realTxn; return realTxn(fn); };
  r = await call('uBuyer', { op: 'create', items: ITEMS, open: { category: 'cement' }, deliveryLocation: 'Juja' });
  const raceLeads = r.ok ? [...store.keys()].filter((k) => k.startsWith('b2bLeads/' + r.r.rfqId + '__')) : [];
  ck('C7 a supplier who withdraws consent mid-delivery is NOT delivered or billed (only A gets the lead)', r.ok && raceLeads.length === 1 && raceLeads[0].endsWith('__bizSupA') && r.r.recipients.length === 1, { r, raceLeads });
  const bB = store.get('businesses/bizSupB'); store.set('businesses/bizSupB', Object.assign({}, bB, { supply: Object.assign({}, bB.supply, { acceptsLeads: true }) }));

  /* with the commercial authority present: the price SNAPSHOT is spread into each lead row (sokoni-2f contract) */
  global.__leadsStub = { monthOf: (d) => 'EAT-' + d.getUTCFullYear(), leadFields: async () => ({ priceKES: 200, priceSource: 'default' }),
    leadClaimWrite: (txn, d, c) => { (global.__claims = global.__claims || []).push(c); } };
  r = await call('uBuyer', { op: 'create', items: ITEMS, supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Kiambu' });
  const snapLead = r.ok && store.get('b2bLeads/' + r.r.rfqId + '__bizSupA');
  ck('L4 with b2b-leads present: each lead carries the price snapshot {priceKES 200, priceSource} and the authority\'s monthOf', !!snapLead && snapLead.priceKES === 200 && snapLead.priceSource === 'default' && /^EAT-/.test(snapLead.month), snapLead);
  global.__leadsStub = null;
  ck('L5 fallback lead month is EAT: 2026-09-30 22:30 UTC (= 01:30 EAT on 1 Oct) → 2026-10', RFQ._ym(new Date(Date.UTC(2026, 8, 30, 22, 30))) === '2026-10', RFQ._ym(new Date(Date.UTC(2026, 8, 30, 22, 30))));
  ck('L6 …and 2026-09-30 20:59 UTC (= 23:59 EAT) → 2026-09', RFQ._ym(new Date(Date.UTC(2026, 8, 30, 20, 59))) === '2026-09');

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
  ck('R4 ONE canonical procPurchaseOrders doc priced from the quote: total 80,880, VAT 16 from the quote, source rfq, unpaid draft', !!po && po.total === 80880 && po.vatRate === 16 && po.vatBasis === 'declared_on_quote' && po.commissionCategory === 'b2b_order' && po.source.kind === 'rfq' && po.status === 'draft' && po.paymentStatus === 'unpaid' && po.buyerBusinessId === 'bizBuyer' && po.supplierBusinessId === 'bizSupA', po);
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

  console.log('\n── I: individual buyers (owner 2026-10-03: one RFQ system, buyer-type agnostic) ──');
  const callT = async (uid, token, data) => { try { return { ok: true, r: await RFQ.rfqDispatch({ auth: { uid, token: token || {} }, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
  store.set('users/uInd', { displayName: 'Jane Homeowner', phoneVerified: true });
  store.set('users/uNoPhone', { displayName: 'Throwaway' });
  r = await callT('uNoPhone', {}, { op: 'create', buyerType: 'individual', items: ITEMS, supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Langata' });
  ck('I1 an individual without a verified phone cannot send paid RFQs', !r.ok && r.code === 'failed-precondition' && /Verify your phone/.test(r.msg), r);
  r = await callT('uInd', {}, { op: 'create', buyerType: 'individual', items: [{ name: 'Cement 50kg', qty: 500, unit: 'bag' }], supplierBusinessIds: ['bizSupA', 'bizSupB'], deliveryLocation: 'Langata', merchantId: 'bizSupA' });
  const iRfq = r.ok ? r.r.rfqId : 'x';
  const iDoc = store.get('rfqs/' + iRfq) || {};
  ck('I2 an individual (no business) sends an RFQ; recorded as buyerType individual, no business id, the caller as buyer', r.ok && iDoc.buyerType === 'individual' && iDoc.buyerBusinessId === null && iDoc.createdBy === 'uInd' && iDoc.buyerKey === 'u_uInd', iDoc);
  ck('I3 a merchantId in an individual payload is ignored (cannot act as / bill a business)', iDoc.buyerBusinessId === null && iDoc.buyerName === 'Jane Homeowner', iDoc);
  const iLead = store.get('b2bLeads/' + iRfq + '__bizSupA') || {};
  ck('I4 each supplier gets ONE lead with a commercialEventId (= its doc id), buyerType individual, tier standard', iLead.commercialEventId === 'rfq_' + iRfq + '__bizSupA' && iLead.buyerType === 'individual' && iLead.tier === 'standard', iLead);
  ck('I5 the recipient row carries buyerUid (messages PARTY for rfq) and no business', (store.get('rfqRecipients/' + iRfq + '__bizSupA') || {}).buyerUid === 'uInd', store.get('rfqRecipients/' + iRfq + '__bizSupA'));
  r = await callT('uInd', {}, { op: 'create', buyerType: 'individual', items: ITEMS, supplierBusinessIds: ['bizSupA', 'bizSupB', 'bizSupC', 'bizInactive', 'bizStranger', 'x6'], deliveryLocation: 'Langata' });
  ck('I6 individuals are capped at 5 direct suppliers per RFQ', !r.ok && /at most 5/.test(r.msg), r);
  r = await callT('uInd', {}, { op: 'listMine', buyerType: 'individual' });
  ck('I7 the individual lists their own RFQs', r.ok && r.r.rfqs.some((x) => x.rfqId === iRfq), r);
  r = await call('uBuyer', { op: 'listMine' });
  ck('I8 a business buyer does not see the individual\'s RFQ', r.ok && !r.r.rfqs.some((x) => x.rfqId === iRfq), r);
  r = await callT('uOther', { phone_number: '+254700000001' }, { op: 'get', buyerType: 'individual', rfqId: iRfq });
  ck('I9 another individual cannot open the RFQ (not-found)', !r.ok && r.code === 'not-found', r);
  await call('uSupA', { op: 'quote', rfqId: iRfq, lines: [{ name: 'Cement 50kg', qty: 500, unitPriceKES: 720 }], vatRate: 16, deliveryFeeKES: 3000, validDays: 7 });
  r = await callT('uInd', {}, { op: 'respond', buyerType: 'individual', rfqId: iRfq, supplierBusinessId: 'bizSupA', action: 'accept' });
  const iAfter = store.get('rfqs/' + iRfq) || {};
  ck('I10 accepting as an individual records the acceptance + price snapshot and points to checkout — NO purchase order', r.ok && r.r.next === 'checkout' && r.r.poId === null
    && iAfter.status === 'accepted' && iAfter.acceptedQuote && iAfter.acceptedQuote.totalKES === 500 * 720 * 1.16 + 3000
    && ![...store.keys()].some((k) => k.startsWith('procPurchaseOrders/po_rfq_' + iRfq)), { r, iAfter });
  r = await callT('uInd', {}, { op: 'respond', buyerType: 'individual', rfqId: iRfq, supplierBusinessId: 'bizSupB', action: 'accept' });
  ck('I11 a second acceptance is refused', !r.ok, r);
  r = await callT('uInd', {}, { op: 'quote', rfqId: iRfq, lines: [{ name: 'x', qty: 1, unitPriceKES: 1 }], vatRate: 0, validDays: 1 });
  ck('I12 an individual cannot act as a supplier (supplier ops stay business-only)', !r.ok, r);
  const r3 = await callT('uInd', {}, { op: 'create', buyerType: 'individual', items: ITEMS, supplierBusinessIds: ['bizSupB'], deliveryLocation: 'Karen' });
  r = await call('uBuyer', { op: 'cancel', rfqId: r3.r && r3.r.rfqId });
  ck('I13 a business cannot cancel an individual\'s RFQ', !r.ok && r.code === 'not-found', r);
  r = await callT('uInd', {}, { op: 'cancel', buyerType: 'individual', rfqId: r3.r && r3.r.rfqId });
  ck('I14 the individual cancels their own open RFQ', r.ok && r.r.status === 'cancelled', r);

  console.log('\n── G: hub-aware lead ledger (sokoni-2f §23) ──');
  global.__claims = []; const seenHubs = [];
  global.__leadsStub = { monthOf: (d) => 'EAT-' + d.getUTCFullYear(),
    leadFields: async (d, o) => { seenHubs.push(o && o.hub + '/' + o.tier); return o && o.hub === 'construction' ? { priceKES: 200, priceSource: 'construction.standard' } : { priceKES: 200, priceSource: 'b2b' }; },
    leadClaimWrite: (txn, d, c) => { global.__claims.push(c); } };
  store.set('businesses/bizSupA', Object.assign({}, store.get('businesses/bizSupA'), { supply: Object.assign({}, (store.get('businesses/bizSupA') || {}).supply, { categories: ['cement'] }) }));
  r = await callT('uInd', {}, { op: 'create', buyerType: 'individual', items: [{ name: 'Cement', qty: 100 }], supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Langata' });
  const gId = r.ok ? r.r.rfqId : 'x'; const gLead = store.get('b2bLeads/' + gId + '__bizSupA') || {};
  ck('G1 an individual cement RFQ is a CONSTRUCTION lead priced from the construction hub (standard)', gLead.hub === 'construction' && gLead.priceSource === 'construction.standard' && seenHubs.indexOf('construction/standard') !== -1, { gLead, seenHubs });
  ck('G2 the bill-once claim is written for the lead (commercialEventId, hub, leadId, supplier)', global.__claims.some((c) => c.commercialEventId === 'rfq_' + gId + '__bizSupA' && c.hub === 'construction' && c.leadId === gId + '__bizSupA' && c.supplierBusinessId === 'bizSupA'), global.__claims);
  global.__leadsStub.leadFields = async (d, o) => { if (o && o.hub === 'construction') { const e = new Error('no price'); e.code = 'failed-precondition'; throw e; } return { priceKES: 200 }; };
  r = await callT('uInd', {}, { op: 'create', buyerType: 'individual', items: [{ name: 'Cement', qty: 100 }], supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Karen' });
  ck('G3 a hub with no configured price REFUSES the RFQ (no unpriced lead, no default)', !r.ok && r.code === 'failed-precondition' && /not open/.test(r.msg), r);
  global.__leadsStub = null;

  console.log('\n── K: commission category stamp + enquiry → RFQ event (sokoni-2f) ──');
  /* G1 left bizSupA with categories ['cement'] */
  r = await callT('uInd', {}, { op: 'create', buyerType: 'individual', items: [{ name: 'Cement', qty: 50 }], supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Rongai' });
  const kId = r.r.rfqId;
  await call('uSupA', { op: 'quote', rfqId: kId, lines: [{ name: 'Cement', qty: 50, unitPriceKES: 700 }], vatRate: 16, validDays: 5 });
  r = await callT('uInd', {}, { op: 'respond', buyerType: 'individual', rfqId: kId, supplierBusinessId: 'bizSupA', action: 'accept' });
  ck('K1 accepting a materials supplier\'s quote stamps commissionCategory building-materials (server-side)', r.ok && (store.get('rfqs/' + kId) || {}).commissionCategory === 'building-materials', store.get('rfqs/' + kId));
  store.set('businesses/bizSupB', Object.assign({}, store.get('businesses/bizSupB'), { supply: Object.assign({}, (store.get('businesses/bizSupB') || {}).supply, { categories: ['stationery'] }) }));
  r = await callT('uInd', {}, { op: 'create', buyerType: 'individual', items: [{ name: 'Paper', qty: 5 }], supplierBusinessIds: ['bizSupB'], deliveryLocation: 'Rongai' });
  const k2 = r.r.rfqId;
  await call('uSupB', { op: 'quote', rfqId: k2, lines: [{ name: 'Paper', qty: 5, unitPriceKES: 100 }], vatRate: 0, validDays: 5 });
  r = await callT('uInd', {}, { op: 'respond', buyerType: 'individual', rfqId: k2, supplierBusinessId: 'bizSupB', action: 'accept' });
  ck('K2 an unrecognised category REFUSES the acceptance (no default commission, fail closed)', !r.ok && r.code === 'failed-precondition' && (store.get('rfqs/' + k2) || {}).status === 'submitted', r);
  store.set('users/uInd2', { displayName: 'Second Buyer', phoneVerified: true });   /* uInd has used its 5 RFQs/day cap above */
  store.set('contactRequests/cq1', { buyerUid: 'uInd2', sellerUid: 'uSupA', productId: 'p1', status: 'pending' });
  r = await callT('uInd2', {}, { op: 'create', buyerType: 'individual', items: [{ name: 'Cement', qty: 10 }], supplierBusinessIds: ['bizSupA', 'bizSupB'], deliveryLocation: 'Ngong', fromContactRequestId: 'cq1' });
  const k3 = r.ok ? r.r.rfqId : 'x';
  ck('K3 the enquiry\'s supplier keeps the enquiry\'s commercial event (cq_<id>); the other gets its own', (store.get('b2bLeads/' + k3 + '__bizSupA') || {}).commercialEventId === 'cq_cq1'
    && (store.get('b2bLeads/' + k3 + '__bizSupB') || {}).commercialEventId === 'rfq_' + k3 + '__bizSupB', [store.get('b2bLeads/' + k3 + '__bizSupA'), store.get('b2bLeads/' + k3 + '__bizSupB')]);
  r = await callT('uOther', { phone_number: '+254700000002' }, { op: 'create', buyerType: 'individual', items: [{ name: 'Cement', qty: 10 }], supplierBusinessIds: ['bizSupA'], deliveryLocation: 'Ngong', fromContactRequestId: 'cq1' });
  ck('K4 someone else\'s enquiry cannot be attached (not-found)', !r.ok && r.code === 'not-found', r);
  r = await callT('uInd2', {}, { op: 'create', buyerType: 'individual', items: [{ name: 'Cement', qty: 10 }], supplierBusinessIds: ['bizSupB'], deliveryLocation: 'Ngong', fromContactRequestId: 'cq1' });
  ck('K5 an enquiry to a different seller cannot be attached (refused for the MISMATCH, not consent)', !r.ok && r.code === 'failed-precondition' && /different seller/.test(r.msg), r);

  console.log('\n── N: notifications ──');
  ck('N1 rfq_received → each recipient owner (uSupA, uSupB) once per RFQ', notes.filter((n) => n.type === 'rfq_received' && n.data.rfqId === rfqId).map((n) => n.uid).sort().join() === 'uSupA,uSupB');
  ck('N2 rfq_quoted → the buyer who created it', notes.some((n) => n.type === 'rfq_quoted' && n.uid === 'uBuyer'));
  ck('N3 rfq_accepted → the winning supplier\'s owner', notes.some((n) => n.type === 'rfq_accepted' && n.uid === 'uSupA'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
