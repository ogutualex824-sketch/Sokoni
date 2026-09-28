'use strict';
/**
 * CERTIFICATION — Q0b-2b: posGetCustomerInsights serves only the PROVEN merchant's customer history.
 *
 * Runs the REAL handler (`.run`) against the Firestore EMULATOR. The Anthropic SDK is replaced IN-PROCESS by a
 * stub that records every prompt and answers locally — nothing leaves the machine, and the test can prove what
 * the model would have been shown. Pointed at the pre-2b tree (REPAIR_ROOT = export of 3d03a70) any caller naming
 * another merchant must get that merchant's history (and the model its items); on this tree the claim must be
 * proven first — shop owner or its staff (resolveActor), or a business member holding `customers` — and an
 * unproven caller must be refused before anything is read.
 *
 *   The SAME customer id exists at two merchants, so an unscoped query returns the wrong history, not nothing.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0b2b';
process.env.ANTHROPIC_API_KEY = 'test-only-not-a-key';   /* the stub below answers; this is never sent anywhere */
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 180s\n'); process.exit(3); }, 180000);

/* ── the Anthropic stub: installed in the module cache BEFORE the handler loads ── */
const PROMPTS = [];
{
  const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [FN] });
  class StubAnthropic {
    constructor() { this.messages = { create: async (req) => { PROMPTS.push(String(req.messages[0].content)); return { content: [{ text: 'Offer a local stub suggestion' }] }; } }; }
  }
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: StubAnthropic };
}

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr),
  cw: console.warn, ce: console.error, cl: console.log };
async function quiet(fn) {
  process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; }
}

/* READ SPY: every posRetailSales document a query hands back */
const SPY = { on: false, seen: [] };
{
  const qProto = Object.getPrototypeOf(Object.getPrototypeOf(db.collection('x')));
  const _qGet = qProto.get;
  qProto.get = async function (...a) { const r = await _qGet.apply(this, a); if (SPY.on) for (const d of r.docs) if (d.ref.path.startsWith('posRetailSales/')) SPY.seen.push(d.data().merchantId); return r; };
}

let PI;
try { PI = require(path.join(FN, 'pos-intelligence.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const A = 'q2b-a', B = 'q2b-b', A_EMP = 'q2b-a-cashier', BIZ = 'Q2B-BIZ', BIZ_OWNER = 'q2b-bizowner';
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const insights = (uid, data, token) => res(quiet(() => PI.posGetCustomerInsights.run({ data, auth: uid ? { uid, token: Object.assign({ uid }, token || {}) } : null,
  rawRequest: { headers: {} }, acceptsStreaming: false })));
const why = (r) => (r.ok ? JSON.stringify({ visits: r.out.visitCount, top: (r.out.topItems || []).map((i) => i.name) }) : 'refused [' + r.code + ']: ' + r.msg.slice(0, 60));
const refused = (r) => !r.ok && r.code === 'permission-denied' && /not authorised to look up/.test(r.msg);
const topNames = (r) => (r.ok ? (r.out.topItems || []).map((i) => i.name) : []);

(async () => {
  process.stdout.write(`\nQ0b-2b — posGetCustomerInsights merchant binding   (tree: ${ROOT})\n\n`);
  const set = (p, d) => db.doc(p).set(d);
  for (const [uid, name] of [[A, 'Alice A'], [B, 'Bob B'], [A_EMP, 'Carl Cashier'], [BIZ_OWNER, 'Biz Owner']]) await set(`users/${uid}`, { name });
  await set(`shops/${A}`, { ownerId: A, storeName: 'A Shop' });
  await set(`shops/${B}`, { ownerId: B, storeName: 'B Shop' });
  await set(`shopEmployees/${A}_${A_EMP}`, { uid: A_EMP, name: 'Carl Cashier', role: 'cashier', shopId: A, shopOwnerId: A, shopName: 'A Shop', active: true });
  await set(`businesses/${BIZ}`, { ownerId: BIZ_OWNER, name: 'Q2B Biz' });
  await set(`workspaceMemberships/q2b-mem-cust_${BIZ}`, { uid: 'q2b-mem-cust', businessId: BIZ, status: 'active', permissions: ['pos', 'customers'] });
  await set(`workspaceMemberships/q2b-mem-pos_${BIZ}`, { uid: 'q2b-mem-pos', businessId: BIZ, status: 'active', permissions: ['pos'] });
  const day = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 86400000));
  const S = (id, merchantId, customerId, item, total) => set(`posRetailSales/${id}`, { merchantId, customerId, grandTotal: total, receiptNo: id,
    items: [{ productId: item, name: item, qty: 1 }], createdAt: day });
  /* the SAME customer id 'CUST1' at A and at B */
  await S('sa1', A, 'CUST1', 'A-Maize', 100); await S('sa2', A, 'CUST1', 'A-Maize', 120);
  await S('sb1', B, 'CUST1', 'B-SECRET-Whisky', 5000); await S('sb2', B, 'CUST1', 'B-SECRET-Whisky', 5000); await S('sb3', B, 'CUST1', 'B-SECRET-Cigar', 900);
  await S('sz1', BIZ, 'CUST2', 'Biz-Rice', 300);
  /* the same business's sale, recorded under its OWNER's id (the shop path keys sales by the owner uid) */
  await S('sz2', BIZ_OWNER, 'CUST2', 'Biz-Beans', 200);

  process.stdout.write('[C] the proven merchant sees its own customer history\n');
  { const r = await insights(A, { merchantId: A, customerId: 'CUST1' });
    ok(r.ok && r.out.visitCount === 2 && r.out.totalSpend === 220 && topNames(r).join() === 'A-Maize', 'C-1', "the shop owner, A's history of CUST1 only: " + why(r)); }
  { const r = await insights(A_EMP, { merchantId: A, customerId: 'CUST1' });
    ok(r.ok && r.out.visitCount === 2 && topNames(r).join() === 'A-Maize', 'C-2', "the shop's cashier (resolveActor): " + why(r)); }
  { const r = await insights('q2b-mem-cust', { merchantId: BIZ, customerId: 'CUST2' });
    ok(r.ok && r.out.visitCount === 2 && topNames(r).sort().join() === 'Biz-Beans,Biz-Rice', 'C-3',
      "a business member holding `customers` sees the business's history under EVERY proven identity (business id and its owner's uid): " + why(r)); }

  process.stdout.write('\n[X] an unproven claim is refused before anything is read\n');
  const promptsBefore = PROMPTS.length;
  SPY.on = true; SPY.seen = [];
  { const r = await insights(A, { merchantId: B, customerId: 'CUST1' }); ok(refused(r), 'X-1', "A's owner claims merchant B: " + why(r)); }
  { const r = await insights('q2b-stranger', { merchantId: B, customerId: 'CUST1' }); ok(refused(r), 'X-2', 'a stranger claims merchant B: ' + why(r)); }
  { const r = await insights('q2b-mem-pos', { merchantId: BIZ, customerId: 'CUST2' }); ok(refused(r), 'X-3', 'a business member WITHOUT `customers`: ' + why(r)); }
  { const r = await insights('q2b-admin', { merchantId: B, customerId: 'CUST1' }, { admin: true }); ok(refused(r), 'X-4', 'no NEW admin capability here (an admin who is not the shop): ' + why(r)); }
  { const r = await insights(A_EMP, { merchantId: B, customerId: 'CUST1' }); ok(refused(r), 'X-5', "A's cashier claims merchant B: " + why(r)); }
  SPY.on = false;
  const loaded = SPY.seen.length, promptsDuring = PROMPTS.length - promptsBefore;
  ok(loaded === 0 && promptsDuring === 0, 'N-1', 'the refused calls loaded NO sale and prompted the model NOTHING: ' + loaded + ' sale(s) loaded, ' + promptsDuring + ' prompt(s)');
  { const r = await insights(null, { merchantId: A, customerId: 'CUST1' }); ok(!r.ok && r.code === 'unauthenticated', 'X-6', 'unauthenticated: ' + why(r)); }
  { const r = await insights(A, { customerId: 'CUST1' }); ok(!r.ok && r.code === 'invalid-argument', 'X-7', 'no merchant claim: ' + why(r)); }

  process.stdout.write('\n[M] what the model was shown\n');
  ok(PROMPTS.length >= 3 && PROMPTS.every((p) => p.indexOf('B-SECRET') === -1), 'M-1',
    'across every call, no prompt carried another merchant\'s items (' + PROMPTS.length + ' prompts): ' + (PROMPTS.find((p) => p.indexOf('B-SECRET') !== -1) || 'none leaked').slice(0, 80));
  ok(PROMPTS.some((p) => p.indexOf('A-Maize') !== -1), 'M-2', "the model WAS shown the proven merchant's own items (control — the stub is live)");

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
