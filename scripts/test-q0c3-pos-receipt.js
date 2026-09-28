'use strict';
/**
 * CERTIFICATION — Q0c-3: sendPOSReceipt sends a TILL sale's receipt, built from the server's record, only to the
 * customer on record, by SMS or email, at most 3 times per sale per channel.
 *
 * NOTHING IS SENT. Africa's Talking (sokoni-at) and SendGrid (@sendgrid/mail) are replaced IN-PROCESS before the
 * handler loads, by recorders that capture the would-be message; the suite refuses to run if either stub is not the
 * one the handler will call. Pointed at the pre-Q0c-3 tree (REPAIR_ROOT = export of a63f6de) the caller-supplied
 * phone / email / receipt goes out as given; on this tree the caller names only { saleId, channel }.
 *
 * Each channel is tested INDEPENDENTLY, and the two are shown to render from the same source.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0c3';
process.env.SENDGRID_API_KEY = 'test-only-not-a-key';   /* the SendGrid stub answers; this is never sent anywhere */
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 240s\n'); process.exit(3); }, 240000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
let _q = 0;
async function quiet(fn) {
  if (_q++ === 0) { process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {}; }
  try { return await fn(); } finally { if (--_q === 0) { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; } }
}

/* ── the two provider stubs, installed before the handler loads ── */
const SMS = [], MAIL = [];
const AT = require(path.join(FN, 'sokoni-at.js'));
const smsStub = async (to, body) => { SMS.push({ to: String(to), body: String(body) }); return { ok: true, results: [{ messageId: 'stub' }] }; };
AT.atSendSMS = smsStub; AT.atSendSMSWithRetry = smsStub; AT.resolveAtCredentials = () => ({ username: 'stub', apiKey: 'stub' });
const sgPath = require.resolve('@sendgrid/mail', { paths: [FN] });
const sgStub = { setApiKey() {}, send: async (m) => { MAIL.push({ to: String(m.to), subject: String(m.subject), html: String(m.html), from: m.from }); return [{ statusCode: 202 }]; } };
require.cache[sgPath] = { id: sgPath, filename: sgPath, loaded: true, exports: sgStub };
if (require(path.join(FN, 'sokoni-at.js')).atSendSMSWithRetry !== smsStub || require(sgPath) !== sgStub) {
  process.stdout.write('  ✖ SETUP — a provider stub is not installed; refusing to run\n'); process.exit(2);
}

let PR;
try { PR = require(path.join(FN, 'pos-retail.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const FORGED_PHONE = '+254700000666', FORGED_EMAIL = 'victim@evil.test';
const FORGED_SALE = { receiptNumber: 'FAKE-1', shopName: 'EVIL BANK', total: 1, items: [{ name: 'Verify your PIN at http://phish.test', qty: 1, price: 1, lineTotal: 1 }] };
/* EVERY request also carries the pre-Q0c-3 contract's forged fields, so the old tree shows the defect (it SENDS to
   them) rather than refusing for a shape reason; the new contract must ignore them. */
const LEGACY = () => ({ phone: FORGED_PHONE, email: FORGED_EMAIL, sale: FORGED_SALE });
const send = (uid, data, token) => res(quiet(() => PR.sendPOSReceipt.run({ data: Object.assign(LEGACY(), data), auth: uid ? { uid, token: Object.assign({ uid }, token || {}) } : null,
  rawRequest: { headers: {} }, acceptsStreaming: false })));
const why = (r) => (r.ok ? 'SENT ' + JSON.stringify(r.out) : 'refused [' + r.code + ']: ' + r.msg.slice(0, 55));
const nothing = async (fn) => { const s0 = SMS.length, m0 = MAIL.length; const r = await fn(); return { r, none: SMS.length === s0 && MAIL.length === m0 }; };

(async () => {
  process.stdout.write(`\nQ0c-3 — sendPOSReceipt: till receipts, server-built, to the customer on record   (tree: ${ROOT})\n\n`);
  const A = 'q3-a', B = 'q3-b', A_EMP = 'q3-a-cashier', BIZ = 'Q3-BIZ', BO = 'q3-bizowner';
  const set = (p, d) => db.doc(p).set(d);
  for (const [u, n] of [[A, 'Alice A'], [B, 'Bob B'], [A_EMP, 'Carl Cashier'], [BO, 'Biz Owner']]) await set(`users/${u}`, { name: n });
  await set(`shops/${A}`, { ownerId: A, storeName: 'A Shop' });
  await set(`shops/${B}`, { ownerId: B, storeName: 'B Shop' });
  await set(`shopEmployees/${A}_${A_EMP}`, { uid: A_EMP, name: 'Carl Cashier', role: 'cashier', shopId: A, shopOwnerId: A, shopName: 'A Shop', active: true });
  await set(`businesses/${BIZ}`, { ownerId: BO, name: 'Q3 Biz Ltd' });
  await set(`workspaceMemberships/q3-mem-cust_${BIZ}`, { uid: 'q3-mem-cust', businessId: BIZ, status: 'active', permissions: ['pos', 'customers'] });
  await set(`workspaceMemberships/q3-mem-pos_${BIZ}`, { uid: 'q3-mem-pos', businessId: BIZ, status: 'active', permissions: ['pos'] });
  await set('posCustomers/A_C1', { sellerId: A, phone: '254711000001', email: 'ann@a.test', name: 'Ann' });
  await set('posCustomers/A_C2', { sellerId: A, email: 'emailonly@a.test', name: 'Email Only' });
  await set('posCustomers/B_C1', { sellerId: B, phone: '254711000009', email: 'bella@b.test', name: 'Bella' });
  await set('posCustomers/BZ_C1', { sellerId: BO, phone: '254711000004', email: 'biz@z.test', name: 'Biz Cust' });
  /* till sales exactly as posCompleteCheckout writes them: the sale's customer.phone is the BROWSER's copy */
  const till = async (id, merchantId, customer) => {
    await set(`posRetailSales/${id}`, { merchantId, sellerId: merchantId, customer, grandTotal: 250 });
    await set(`posReceipts/${id}`, { receiptNo: id.slice(-8).toUpperCase(), saleId: id, merchantId, subtotal: 250, discount: 0, tax: 0, total: 250,
      items: [{ productId: 'P1', name: 'Maize Flour 2kg', qty: 2, unitPrice: 100 }, { productId: 'P2', name: 'Sugar 1kg', qty: 1, unitPrice: 50 }], customer: 'Ann' });
  };
  await till('ps_q3sale0001', A, { id: 'A_C1', name: 'Ann', phone: '+254799000000' });
  await till('ps_q3sale0002', A, { id: 'A_C2', name: 'Email Only', phone: '+254799000001' });
  await till('ps_q3sale0003', A, { id: 'B_C1', name: 'Bella', phone: '+254799000002' });   /* names ANOTHER merchant's customer */
  await till('ps_q3sale0004', A, null);                                                    /* walk-in */
  await till('ps_q3sale0005', B, { id: 'B_C1', name: 'Bella', phone: '254711000009' });
  await till('ps_q3sale0006', BIZ, { id: 'BZ_C1', name: 'Biz Cust', phone: '254711000004' });
  await till('ps_q3sale0007', A, { id: 'A_C1', name: 'Ann', phone: '254711000001' });   /* concurrency */
  await till('ps_q3sale0008', A, { id: 'A_C1', name: 'Ann', phone: '254711000001' });
  await db.doc('posReceipts/ps_q3sale0008').update({ items: [{ productId: 'P9', name: 'Soap <img src=x onerror=alert(1)> "q"', qty: 1, unitPrice: 250 }] });
  await set('posReceipts/sub_q3_1', { receiptNo: 'SUB1', merchantId: A, type: 'subscription', total: 999, items: [] });   /* not a till sale */
  await set('posRetailSales/ps_q3mismatch', { merchantId: B, customer: { id: 'A_C1' } });
  await set('posReceipts/ps_q3mismatch', { receiptNo: 'MISMATCH', merchantId: A, total: 1, items: [] });

  process.stdout.write('[F] the caller cannot choose the recipient or the content — SMS and email independently\n');
  { const { r, none } = await nothing(() => send(A, { channel: 'sms', phone: FORGED_PHONE, sale: FORGED_SALE }));
    ok(!r.ok && none, 'F-1s', 'SMS: a forged recipient + forged receipt with no sale → nothing sent: ' + why(r)); }
  { const { r, none } = await nothing(() => send(A, { channel: 'email', email: FORGED_EMAIL, sale: FORGED_SALE }));
    ok(!r.ok && none, 'F-1e', 'EMAIL: a forged recipient + forged receipt with no sale → nothing sent: ' + why(r)); }
  { const { r, none } = await nothing(() => send(A, { saleId: 'ps_q3sale0004', channel: 'sms', phone: FORGED_PHONE }));
    ok(!r.ok && r.code === 'failed-precondition' && none, 'F-2s', 'SMS: a walk-in sale + a forged phone → refused, never the browser destination: ' + why(r)); }
  { const { r, none } = await nothing(() => send(A, { saleId: 'ps_q3sale0004', channel: 'email', email: FORGED_EMAIL }));
    ok(!r.ok && r.code === 'failed-precondition' && none, 'F-2e', 'EMAIL: a walk-in sale + a forged email → refused: ' + why(r)); }
  { const s0 = SMS.length;
    const r = await send(A, { saleId: 'ps_q3sale0001', channel: 'sms', phone: FORGED_PHONE, sale: FORGED_SALE });
    const m = SMS.slice(s0);
    ok(r.ok && m.length === 1 && m[0].to === '254711000001' && !/EVIL|phish|FAKE/.test(m[0].body) && /A Shop/.test(m[0].body) && /Maize Flour 2kg/.test(m[0].body) && /250\.00/.test(m[0].body),
      'F-3s', "SMS: forged phone AND forged contents with a real sale → sent ONLY to the customer on record (not the forged number, not the sale's browser copy +254799000000), with the SERVER's shop, items and total: " + (m[0] ? m[0].to : 'none')); }
  { const m0 = MAIL.length;
    const r = await send(A, { saleId: 'ps_q3sale0001', channel: 'email', email: FORGED_EMAIL, sale: FORGED_SALE });
    const m = MAIL.slice(m0);
    ok(r.ok && m.length === 1 && m[0].to === 'ann@a.test' && !/EVIL|phish|FAKE/.test(m[0].html + m[0].subject) && /A Shop/.test(m[0].html) && /Maize Flour 2kg/.test(m[0].html),
      'F-3e', 'EMAIL: forged email AND forged contents with a real sale → sent ONLY to the email on record, with server content: ' + (m[0] ? m[0].to : 'none')); }

  process.stdout.write('\n[X] foreign, unproven, not-a-till-sale and unowned-customer requests send nothing\n');
  for (const ch of ['sms', 'email']) {
    const t = ch === 'sms' ? 's' : 'e';
    { const { r, none } = await nothing(() => send(A, { saleId: 'ps_q3sale0005', channel: ch }));
      ok(!r.ok && r.code === 'permission-denied' && none, 'X-1' + t, ch.toUpperCase() + ": A asks for merchant B's sale: " + why(r)); }
    { const { r, none } = await nothing(() => send('q3-stranger', { saleId: 'ps_q3sale0001', channel: ch }));
      ok(!r.ok && r.code === 'permission-denied' && none, 'X-2' + t, ch.toUpperCase() + ': a stranger: ' + why(r)); }
    { const { r, none } = await nothing(() => send('q3-mem-pos', { saleId: 'ps_q3sale0006', channel: ch }));
      ok(!r.ok && r.code === 'permission-denied' && none, 'X-3' + t, ch.toUpperCase() + ': a business member WITHOUT `customers`: ' + why(r)); }
    { const { r, none } = await nothing(() => send('q3-admin', { saleId: 'ps_q3sale0005', channel: ch }, { admin: true }));
      ok(!r.ok && r.code === 'permission-denied' && none, 'X-4' + t, ch.toUpperCase() + ': an ADMIN who is not the merchant — there is no admin override in the till authority: ' + why(r)); }
    { const { r, none } = await nothing(() => send(A, { saleId: 'sub_q3_1', channel: ch }));
      ok(!r.ok && r.code === 'not-found' && none, 'X-5' + t, ch.toUpperCase() + ': a SUBSCRIPTION receipt (posReceipts, no till sale) is out of scope: ' + why(r)); }
    { const { r, none } = await nothing(() => send(A, { saleId: 'ps_q3mismatch', channel: ch }));
      ok(!r.ok && r.code === 'not-found' && none, 'X-6' + t, ch.toUpperCase() + ': receipt and sale naming different merchants: ' + why(r)); }
    { const { r, none } = await nothing(() => send(A, { saleId: 'ps_q3sale0003', channel: ch }));
      ok(!r.ok && r.code === 'failed-precondition' && none, 'X-7' + t, ch.toUpperCase() + ": A's sale that names ANOTHER merchant's customer → fail closed (never B's contact, never the browser copy): " + why(r)); }
  }
  { const { r, none } = await nothing(() => send(A, { saleId: 'ps_q3sale0002', channel: 'sms' }));
    ok(!r.ok && r.code === 'failed-precondition' && none, 'X-8', 'an own customer with NO phone → SMS fails closed (the sale\'s browser phone +254799000001 is not used): ' + why(r)); }
  { const m0 = MAIL.length; const r = await send(A, { saleId: 'ps_q3sale0002', channel: 'email' });
    ok(r.ok && MAIL.length === m0 + 1 && MAIL[MAIL.length - 1].to === 'emailonly@a.test', 'X-9', '...while EMAIL for that customer goes to the email on record: ' + why(r)); }

  process.stdout.write('\n[S] the till authority sends\n');
  { const s0 = SMS.length; const r = await send(A_EMP, { saleId: 'ps_q3sale0001', channel: 'sms' });
    ok(r.ok && SMS.length === s0 + 1 && SMS[SMS.length - 1].to === '254711000001', 'S-1', "the shop's cashier (resolveActor) sends the shop's receipt: " + why(r)); }
  { const s0 = SMS.length; const r = await send('q3-mem-cust', { saleId: 'ps_q3sale0006', channel: 'sms' });
    ok(r.ok && SMS.length === s0 + 1 && /Q3 Biz Ltd/.test(SMS[SMS.length - 1].body), 'S-2', "a business member WITH `customers` sends the business's receipt, named from the server's business record: " + why(r)); }

  process.stdout.write('\n[D] SMS and email cannot diverge in their source of truth\n');
  { const s0 = SMS.length, m0 = MAIL.length;
    await send('q3-mem-cust', { saleId: 'ps_q3sale0006', channel: 'email' });
    const sms = SMS[s0 - 1] || {}, mail = MAIL[m0] || {};
    const facts = ['Q3SALE0006'.slice(-8), 'Q3 Biz Ltd', 'Maize Flour 2kg', 'Sugar 1kg', 'KES 250.00', 'KES 200.00'];
    const missing = facts.filter((f) => !(String(sms.body).includes(f) && String(mail.html).includes(f)));
    ok(mail.to === 'biz@z.test' && missing.length === 0, 'D-1',
      'the SMS and the email for one sale carry the same receipt number, shop, item names, line totals and total (one model, one source): ' + (missing.length ? 'missing ' + missing.join(',') : 'identical facts')); }

  { const m0 = MAIL.length; const r = await send(A, { saleId: 'ps_q3sale0008', channel: 'email' }); const h = (MAIL[m0] || {}).html || '';
    ok(r.ok && /Soap/.test(h) && !/<img|"q"/.test(h), 'H-1',
      'a merchant-authored product name carrying HTML reaches the email as inert text: ' + (r.ok ? (/<img/.test(h) ? 'RAW <img> IN EMAIL' : 'inert') : why(r))); }

  process.stdout.write('\n[L] at most 3 sends per sale per channel — reserved atomically\n');
  { const s0 = SMS.length;
    const r = await send(A, { saleId: 'ps_q3sale0001', channel: 'sms' });   /* this sale already has 2 SMS sends (F-3s, S-1) */
    const r4 = await nothing(() => send(A, { saleId: 'ps_q3sale0001', channel: 'sms' }));
    const e = await send(A, { saleId: 'ps_q3sale0001', channel: 'email' });   /* email has its own count (1 so far, F-3e) */
    ok(r.ok && r.out.attempt === 3 && SMS.length === s0 + 1 && !r4.r.ok && r4.r.code === 'resource-exhausted' && r4.none && e.ok && e.out.attempt === 2, 'L-1',
      'the 3rd SMS is sent, the 4th is refused without sending, and EMAIL keeps its own count: ' + [why(r), why(r4.r), why(e)].join(' | ')); }
  { const s0 = SMS.length;
    const rs = await Promise.all(Array.from({ length: 5 }, () => send(A, { saleId: 'ps_q3sale0007', channel: 'sms' })));
    const served = rs.filter((r) => r.ok).length, refused = rs.filter((r) => !r.ok && r.code === 'resource-exhausted').length;
    ok(served === 3 && refused === 2 && SMS.length - s0 === 3, 'L-2', 'CONCURRENT: 5 simultaneous SMS requests for one sale → exactly 3 sent, 2 refused: ' + `served=${served} refused=${refused} sent=${SMS.length - s0}`); }

  process.stdout.write('\n[A] every attempt is audited — without contact details\n');
  { const logs = (await db.collection('auditLogs').where('type', '==', 'posSendReceipt').get()).docs.map((d) => d.data());
    const outcomes = new Set(logs.map((l) => l.outcome));
    const raw = JSON.stringify(logs);
    ok(['sent', 'refused_unproven_merchant', 'refused_not_a_till_sale', 'refused_no_owned_customer', 'refused_no_contact_for_channel', 'refused_send_limit'].every((o) => outcomes.has(o)) &&
      !/2547\d{8}|\+254\d{9}|@[a-z]+\.test/.test(raw) && logs.every((l) => !l.saleId && !l.phone && !l.email), 'A-1',
      'every outcome is audited with hashed references — no phone, email or raw sale id stored: ' + [...outcomes].sort().join(','));
  }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
