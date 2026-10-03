#!/usr/bin/env node
'use strict';
/* rfq_quote payment purpose (accepted RFQ quote → normal SOKONI order) — owner 2026-10-03, contract with f3 / 5b
     Q1  the buyer pays EXACTLY acceptedQuote.totalKES read on the server (subtotal + declared VAT + delivery); client amount ignored
     Q2  ONE live intent per (rfq, quote version): deterministic preferredRef RFQ-<id>-v<version>
     Q3  refused: another user · a business buyer · not accepted / already paid · inconsistent lines / VAT / total · no
         server-stamped commissionCategory · supplier unknown · paying your own quote
     Q4  metadata carries payee (supplier owner), commissionCategory, VAT as declared
     Q5  rfq_quote is self-settling (no generic credit at payment time — 5b's hold path settles it)
   NODE_PATH=<functions/node_modules> node scripts/test-rfq-quote-purpose.js */
const path = require('path'), Module = require('module');
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 220))); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor (code, message) { super(message); this.code = code; } }
let DOCS = {};
const db = { collection: (c) => ({ doc: (id) => ({ get: async () => { const d = DOCS[c + '/' + id]; return { exists: !!d, data: () => d && JSON.parse(JSON.stringify(d)) }; } }) }) };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldPath: { documentId: () => '__name__' } };
  if (id === 'firebase-functions/v2/https') return { HttpsError, onCall: (o, h) => h };
  if (id === 'firebase-functions/logger') return { info () {}, warn () {}, error () {} };
  return orig.apply(this, arguments);
};
const P = require(path.join(FN, 'payment-purposes.js'));
Module.prototype.require = orig;
const SS = require(path.join(FN, 'shared/self-settling-purposes.js'));
const price = (uid, data) => P.PURPOSES.rfq_quote.price(uid, data).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, msg: e.message }));
const QUOTE = { lines: [{ name: 'Cement 50kg', qty: 10, unitPriceKES: 800, lineTotalKES: 8000 }, { name: 'Sand (tonne)', qty: 2, unitPriceKES: 1500, lineTotalKES: 3000 }],
  subtotalKES: 11000, vatRate: 16, vatKES: 1760, deliveryFeeKES: 500, totalKES: 13260, version: 2, supplierBusinessId: 'biz1', supplierName: 'Mjengo Supplies' };
function reset (over, quoteOver) {
  DOCS = { 'rfqs/RFQ0001': Object.assign({ createdBy: 'buyer1', buyerType: 'individual', status: 'accepted', checkout: 'pending', commissionCategory: 'building-materials',
    acceptedQuote: Object.assign({}, QUOTE, quoteOver || {}) }, over || {}), 'businesses/biz1': { ownerId: 'supplier1' } };
}

(async () => {
  reset();
  let x = await price('buyer1', { rfqId: 'RFQ0001', amount: 1 });
  ck('Q1 amount = acceptedQuote.totalKES on the server (13,260 incl. 16% VAT + delivery); the client amount is ignored', x.ok && x.r.amountCents === 1326000, x);
  ck('Q2 one live intent per quote version: preferredRef RFQ-RFQ0001-v2', x.ok && x.r.preferredRef === 'RFQ-RFQ0001-v2');
  ck('Q4 metadata: payee = supplier owner, commissionCategory, VAT as declared', x.ok && x.r.metadata.sellerUid === 'supplier1' && x.r.metadata.commissionCategory === 'building-materials'
    && x.r.metadata.vatBasis === 'declared_on_quote' && x.r.metadata.vatKES === 1760);
  const refusals = [];
  const tryCase = async (label, setup, uid) => { setup(); const r = await price(uid || 'buyer1', { rfqId: 'RFQ0001' }); refusals.push([label, r.ok ? 'PRICED' : r.code]); };
  await tryCase('another user', () => reset(), 'mallory');
  await tryCase('business buyer', () => reset({ buyerType: 'business' }));
  await tryCase('not accepted', () => reset({ status: 'quoted' }));
  await tryCase('already paid', () => reset({ checkout: 'paid' }));
  await tryCase('lines do not add up', () => reset({}, { subtotalKES: 10000 }));
  await tryCase('VAT inconsistent', () => reset({}, { vatKES: 999 }));
  await tryCase('VAT rate not 0|16', () => reset({}, { vatRate: 8, vatKES: 880 }));
  await tryCase('total inconsistent', () => reset({}, { totalKES: 1 }));
  await tryCase('no server commissionCategory', () => reset({ commissionCategory: undefined }));
  await tryCase('unknown commissionCategory', () => reset({ commissionCategory: 'default' }));
  await tryCase('supplier unknown', () => { reset(); delete DOCS['businesses/biz1']; });
  await tryCase('paying your own quote', () => { reset(); DOCS['businesses/biz1'].ownerId = 'buyer1'; });
  ck('Q3 every unsafe case is refused (never priced)', refusals.every(([, c]) => c !== 'PRICED'), refusals);
  reset({ commissionCategory: 'construction_service' }, { vatRate: 0, vatKES: 0, totalKES: 11500 });
  x = await price('buyer1', { rfqId: 'RFQ0001' });
  ck('Q3b a contractor quote (construction_service, VAT 0) prices at 11,500', x.ok && x.r.amountCents === 1150000 && x.r.metadata.commissionCategory === 'construction_service');
  reset({ commissionCategory: 'equipment-rental' }, { vatRate: 0, vatKES: 0, totalKES: 11500 });
  x = await price('buyer1', { rfqId: 'RFQ0001' });
  ck('Q3c an equipment-rental quote is accepted and carries equipment-rental (→ 10% row)', x.ok && x.r.metadata.commissionCategory === 'equipment-rental');
  ck('Q5 rfq_quote is self-settling (5b\'s hold path settles; no generic credit at payment)', SS.isSelfSettling('rfq_quote'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
