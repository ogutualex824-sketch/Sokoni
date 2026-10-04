#!/usr/bin/env node
'use strict';
require('./lib/net-firewall').install();   /* money suite: FAIL CLOSED on any call to a payment host */
/* invoice payment purpose — canonical invoice (owner 2026-10-04, H15; contract with sokoni-f3 / sokoni-5b)
     I1  amount = invoices/{id}.balanceCents (server); any client amount ignored; metadata carries invoiceId + invoiceNumber
     I2  partially_paid pays the REMAINING balance; the ref follows the balance (INV-<id>-<balanceCents>)
     I3  refused: draft · void · paid · non-canonical (no modelVersion / no source) · zero balance · balance ≠ total − paid ·
         non-KES · bad invoiceId · unknown invoice
     I4  source gate: only 'manual' — order / booking / quote / commission / subscription invoices are refused
     I5  payer: clientUid set → only that customer; the issuing merchant (shop owner or createdBy) can never pay its own invoice
     I6  payee = shops/{shopId}.ownerId, else shopId; business wallet; commission snapshot on the balance
     I7  the REAL engine prices merchant_invoice from its explicit 15% row (owner 2026-10-04); without the row it refuses (mutant)
     I8  ONE open intent per balance: same payer replays the ref; another payer refused while open; expired / cancelled /
         stale-created attempts stepped past (-r1); a paid intent at this balance → "just received"
     I9  invoice is SELF-SETTLING (no generic payment-time credit)
     I10 receipts: kind 'invoice' accepted, one receipt per PAYMENT (two partial payments → two receipts), links.invoiceId kept
     I11 shared/invoice-model.js is byte-identical to the canonical model (f3 91ad504)
   NODE_PATH=<functions/node_modules> node scripts/test-invoice-purpose.js */
const path = require('path'), Module = require('module'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 260))); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor (code, message, details) { super(message); this.code = code; this.details = details; } }
let DOCS = {};
const snapOf = (k) => { const d = DOCS[k]; return { exists: !!d, data: () => d && Object.assign({}, d) }; };
const emptyQ = () => ({ where: () => emptyQ(), orderBy: () => emptyQ(), limit: () => emptyQ(), get: async () => ({ empty: true, docs: [], size: 0, forEach () {} }) });
const db = { collection: (c) => Object.assign(emptyQ(), { doc: (id) => ({ _k: c + '/' + id, get: async () => snapOf(c + '/' + id) }) }) };
let RATE = 5;           /* null → use the REAL commission engine (no merchant_invoice rate configured) */
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldPath: { documentId: () => '__name__' } };
  if (id === 'firebase-functions/v2/https') return { HttpsError, onCall: (o, h) => h };
  if (id === 'firebase-functions/logger') return { info () {}, warn () {}, error () {} };
  if (id === './finos-utils' && RATE !== null) return { calculateCommission: async (_db, o) => ({ effectiveRate: RATE, category: o.category, commissionCents: Math.round(o.orderAmountCents * RATE / 100), pricingSource: 'test_rate' }) };
  return orig.apply(this, arguments);
};
const P = require(path.join(FN, 'payment-purposes.js'));
const SS = require(path.join(FN, 'shared/self-settling-purposes.js'));
const TR = require(path.join(FN, 'transaction-receipts.js'));
const price = (uid, data) => P.PURPOSES.invoice.price(uid, data).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, msg: e.message, dcode: e.details && e.details.code }));
const INV = (over) => Object.assign({ shopId: 'shop1', invoiceNumber: 'INV-SHOP-000007', modelVersion: 1, source: 'manual', status: 'issued', currency: 'KES',
  totalCents: 1250000, paidCents: 0, balanceCents: 1250000, createdBy: 'owner1', clientName: 'Acme Ltd' }, over || {});
function reset (over, shop) { DOCS = { 'invoices/INV00001': INV(over) }; if (shop !== null) DOCS['shops/shop1'] = shop || { ownerId: 'owner1' }; }

(async () => {
  RATE = 5;
  reset(); let x = await price('buyer1', { invoiceId: 'INV00001', amount: 1, amountCents: 100, balanceCents: 1 });
  ck('I1 amount = server balanceCents 12,500.00; client amount ignored; invoiceId + invoiceNumber in metadata', x.ok && x.r.amountCents === 1250000
    && x.r.metadata.invoiceId === 'INV00001' && x.r.metadata.invoiceNumber === 'INV-SHOP-000007' && x.r.resourceType === 'invoice' && x.r.resourceId === 'INV00001', x);
  reset({ status: 'partially_paid', paidCents: 250000, balanceCents: 1000000 }); x = await price('buyer1', { invoiceId: 'INV00001' });
  ck('I2 partially_paid → pays the remaining 10,000.00; ref follows the balance', x.ok && x.r.amountCents === 1000000 && x.r.preferredRef === 'INV-INV00001-1000000', x);

  const bad = [
    ['draft', { status: 'draft' }, 'invoice_not_payable'], ['void', { status: 'void' }, 'invoice_not_payable'], ['paid', { status: 'paid', paidCents: 1250000, balanceCents: 0 }, 'invoice_not_payable'],
    ['no modelVersion', { modelVersion: undefined }, 'invoice_not_canonical'], ['no source', { source: undefined }, 'invoice_not_canonical'],
    ['zero balance', { balanceCents: 0, paidCents: 1250000 }, 'invoice_no_balance'], ['balance ≠ total − paid', { balanceCents: 999 }, 'invoice_inconsistent'],
    ['missing paidCents', { paidCents: undefined }, 'invoice_inconsistent'], ['USD', { currency: 'USD' }, 'invoice_currency'], ['no shop', { shopId: '' }, 'invoice_no_payee'],
  ];
  const r3 = []; for (const [n, o, code] of bad) { reset(o); const z = await price('buyer1', { invoiceId: 'INV00001' }); r3.push([n, z.ok ? 'PRICED' : z.dcode, code]); }
  reset(); const z1 = await price('buyer1', { invoiceId: 'x' }); const z2 = await price('buyer1', { invoiceId: 'NOPE0000' });
  ck('I3 refused: draft · void · paid · non-canonical · zero / inconsistent balance · non-KES · no payee · bad / unknown id', r3.every(([, got, want]) => got === want) && z1.code === 'invalid-argument' && z2.code === 'not-found', { r3, z1: z1.code, z2: z2.code });

  const r4 = []; for (const src of ['order', 'booking', 'quote', 'commission', 'subscription']) { reset({ source: src }); const z = await price('buyer1', { invoiceId: 'INV00001' }); r4.push([src, z.ok ? 'PRICED' : z.dcode]); }
  ck('I4 only manual invoices: order / booking / quote (own purpose) and commission / subscription (platform bills) refused', r4.every(([, c]) => c === 'invoice_source_not_payable'), r4);

  reset({ clientUid: 'cust1' }); const p1 = await price('stranger', { invoiceId: 'INV00001' }), p2 = await price('cust1', { invoiceId: 'INV00001' });
  reset(); const p3 = await price('owner1', { invoiceId: 'INV00001' });
  reset({ createdBy: 'clerk9' }); const p4 = await price('clerk9', { invoiceId: 'INV00001' });
  ck('I5 payer: named customer only when clientUid is set; the merchant (shop owner / issuer) cannot pay its own invoice', !p1.ok && p1.code === 'permission-denied' && p2.ok
    && !p3.ok && p3.code === 'failed-precondition' && !p4.ok && p4.code === 'failed-precondition', [p1.code, p2.ok, p3.code, p4.code]);

  reset(); x = await price('buyer1', { invoiceId: 'INV00001' }); reset({}, null); const y = await price('buyer1', { invoiceId: 'INV00001' });
  const cs = x.ok && x.r.metadata.commissionSnapshot;
  ck('I6 payee = shop owner (else shopId), business wallet; snapshot on the balance (category merchant_invoice)', x.ok && x.r.metadata.sellerUid === 'owner1' && x.r.metadata.payeeWallet === 'business'
    && y.ok && y.r.metadata.sellerUid === 'shop1' && cs && cs.commissionRate === 5 && cs.capturedOnCents === 1250000 && cs.commissionBase === 'invoice_balance' && cs.category === 'merchant_invoice', { meta: x.ok && x.r.metadata });

  RATE = null; reset(); const u = await price('buyer1', { invoiceId: 'INV00001' }); RATE = 5;
  const us = u.ok && u.r.metadata.commissionSnapshot;
  ck('I7 REAL engine: explicit merchant_invoice row = 15% (owner 2026-10-04) captured in the snapshot at payment start — 1,875.00 on 12,500.00',
    u.ok && us && us.commissionRate === 15 && us.category === 'merchant_invoice' && us.commissionCentsAtCapture === 187500 && /^merchant_invoice@/.test(us.commissionRuleId), u.ok ? us : u);

  reset(); const base = 'INV-INV00001-1250000';
  DOCS['paymentIntents/' + base] = { uid: 'buyer1', status: 'created', expiresAt: { toMillis: () => Date.now() + 600000 } };
  const o1 = await price('buyer1', { invoiceId: 'INV00001' }), o2 = await price('buyer2', { invoiceId: 'INV00001' });
  DOCS['paymentIntents/' + base] = { uid: 'buyer1', status: 'expired' }; const o3 = await price('buyer2', { invoiceId: 'INV00001' });
  DOCS['paymentIntents/' + base] = { uid: 'buyer1', status: 'created', expiresAt: { toMillis: () => Date.now() - 1000 } }; const o4 = await price('buyer2', { invoiceId: 'INV00001' });
  DOCS['paymentIntents/' + base] = { uid: 'buyer1', status: 'paid' }; const o5 = await price('buyer2', { invoiceId: 'INV00001' });
  for (let k = 0; k < 10; k++) DOCS['paymentIntents/' + (k ? base + '-r' + k : base)] = { uid: 'x', status: 'cancelled' }; const o6 = await price('buyer2', { invoiceId: 'INV00001' });
  ck('I8 one open intent per balance: replay same payer · other payer refused while open · expired / stale stepped past (-r1) · paid → just received · bounded attempts',
    o1.ok && o1.r.preferredRef === base && !o2.ok && o2.dcode === 'invoice_payment_in_progress' && o3.ok && o3.r.preferredRef === base + '-r1'
    && o4.ok && o4.r.preferredRef === base + '-r1' && !o5.ok && o5.dcode === 'invoice_payment_received' && !o6.ok && o6.code === 'resource-exhausted',
    [o1.ok && o1.r.preferredRef, o2.dcode, o3.ok && o3.r.preferredRef, o4.ok && o4.r.preferredRef, o5.dcode, o6.code]);

  ck('I9 invoice is SELF-SETTLING (no generic seller credit at payment time)', SS.isSelfSettling('invoice'));

  /* receipts: per payment */
  const RD = {}; let NUM = 0;
  const rdb = { collection: (c) => ({ doc: (id) => { const k = c + '/' + id; return { _k: k, collection: (c2) => ({ doc: (id2) => ({ _k: k + '/' + c2 + '/' + id2 }) }) }; } }),
    runTransaction: async (fn) => fn({ get: async (r) => ({ exists: !!RD[r._k], data: () => RD[r._k] }), create: (r, v) => { RD[r._k] = v; } }) };
  const deps = { serverTs: () => 'TS', nextNumber: async () => 'RCT-' + (++NUM) };
  const rp = (ref, cents) => TR.recordPaid(rdb, { kind: 'invoice', sourceId: ref, clientUid: 'buyer1', paymentRef: ref, paidCents: cents, counterpartyId: 'owner1', links: { invoiceId: 'INV00001' } }, deps);
  const a1 = await rp('INV-INV00001-1250000', 250000), a2 = await rp('INV-INV00001-1000000', 1000000), a3 = await rp('INV-INV00001-1000000', 1000000);
  const rec = RD['transactionReceipts/invoice_INV-INV00001-1000000'] || RD[Object.keys(RD).find((k) => /invoice_INV-INV00001-1000000$/.test(k))] || {};
  ck('I10 receipts: kind invoice accepted; two partial payments → TWO receipts; a replayed payment → none; links.invoiceId kept',
    a1.ok && a2.ok && a1.receiptId !== a2.receiptId && a3.ok && a3.replay === true && rec.links && rec.links.invoiceId === 'INV00001' && NUM === 2, { a1, a2, a3, links: rec.links });

  let same = false; try {
    const want = cp.execFileSync('git', ['rev-parse', 'origin/functions/admin-invoices-list-on-main:functions/shared/invoice-model.js'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const got = cp.execFileSync('git', ['hash-object', 'functions/shared/invoice-model.js'], { cwd: ROOT, encoding: 'utf8' }).trim();
    same = want === got && /^[0-9a-f]{40}$/.test(got);
  } catch (_) { same = false; }
  ck('I11 shared/invoice-model.js byte-identical to the canonical model (f3 91ad504)', same);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
