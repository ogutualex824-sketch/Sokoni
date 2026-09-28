'use strict';
/**
 * CERTIFICATION — Q0c-2: posSendSMS sends only to the PROVEN merchant's own customers, within server-enforced
 * limits (100 per request, 500 per merchant per day), and audits every request without raw phone numbers.
 *
 * NOTHING IS SENT. Africa's Talking is replaced IN-PROCESS before any handler loads: `sokoni-at`'s atSendSMS /
 * atSendSMSWithRetry / resolveAtCredentials are stubs that record the would-be send; the suite REFUSES to run if the
 * stub is not the function the handler will call.
 *
 * The handler under test:
 *   · this tree — functions/pos-merchant-sms.js `_h.posSendSMS` (the deployed export `posSendSMS` re-exports it);
 *   · the pre-Q0c-2 tree (REPAIR_ROOT = export of 85e71a1) — the REAL inline `exports.posSendSMS` handler, parsed
 *     out of that tree's index.js and run with the same stubbed sender.
 * Firestore is the EMULATOR.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0c2';
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

/* ── the sender stub — installed before ANY handler is loaded ── */
const SENT = [];
const AT = require(path.join(FN, 'sokoni-at.js'));
const stubSend = async (to, message) => { SENT.push({ to: String(to), message: String(message) }); return { ok: true, results: [{ messageId: 'stub' }] }; };
AT.atSendSMS = stubSend;
AT.atSendSMSWithRetry = stubSend;
AT.resolveAtCredentials = () => ({ username: 'stub', apiKey: 'stub' });
if (require(path.join(FN, 'sokoni-at.js')).atSendSMS !== stubSend) { process.stdout.write('  ✖ SETUP — the sender stub is not installed; refusing to run\n'); process.exit(2); }

/* ── the handler under test ── */
let H = null, OLD = false;
if (fs.existsSync(path.join(FN, 'pos-merchant-sms.js'))) {
  H = require(path.join(FN, 'pos-merchant-sms.js'))._h.posSendSMS;
} else {
  OLD = true;
  const parser = require(require.resolve('@babel/parser', { paths: [FN, 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules'] }));
  const src = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  const ast = parser.parse(src, { sourceType: 'script' });
  const st = ast.program.body.find((s) => s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' &&
    s.expression.left.object && s.expression.left.object.name === 'exports' && s.expression.left.property.name === 'posSendSMS');
  const fnNode = st && st.expression.right.arguments.find((a) => /Function/.test(a.type));
  if (!fnNode) { process.stdout.write('  ✖ SETUP — old inline posSendSMS not found\n'); process.exit(2); }
  const { HttpsError } = require(require.resolve('firebase-functions/v2/https', { paths: [FN] }));
  const sendSms = (to, message) => AT.atSendSMS(to, message);
  /* eslint-disable-next-line no-new-func */
  H = new Function('HttpsError', 'sokoniAt', 'sendSms', 'db', 'admin', 'return (' + src.slice(fnNode.start, fnNode.end) + ');')(HttpsError, AT, sendSms, db, admin);
}

const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const send = (uid, data, token) => res(quiet(() => H({ data, auth: uid ? { uid, token: Object.assign({ uid }, token || {}) } : null })));
const why = (r) => (r.ok ? 'SENT ' + JSON.stringify(r.out) : 'refused [' + r.code + ']: ' + r.msg.slice(0, 60));
const nothingSent = async (fn) => { const n0 = SENT.length; const r = await fn(); return { r, none: SENT.length === n0, delta: SENT.length - n0 }; };
const keyOf = (owners) => crypto.createHash('sha256').update([...owners].sort().join('|')).digest('hex').slice(0, 32);
const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const quotaCount = async (owners) => { const s = await db.doc(`smsMerchantQuota/${keyOf(owners)}_${day}`).get(); return s.exists ? s.data().count : 0; };

(async () => {
  process.stdout.write(`\nQ0c-2 — posSendSMS: own customers only, bounded, audited   (tree: ${ROOT}${OLD ? ', OLD inline handler' : ''})\n\n`);
  const A = 'q2c-a', B = 'q2c-b', ABIZ = 'Q2C-ABIZ', BIZ = 'Q2C-BIZ', BO = 'q2c-bizowner', Q = 'q2c-quota';
  const set = (p, d) => db.doc(p).set(d);
  for (const [u, n] of [[A, 'Alice A'], [B, 'Bob B'], [BO, 'Biz Owner'], [Q, 'Quinn Q']]) await set(`users/${u}`, { name: n });
  await set(`shops/${A}`, { ownerId: A, storeName: 'A Shop' });
  await set(`shops/${B}`, { ownerId: B, storeName: 'B Shop' });
  await set(`shops/${Q}`, { ownerId: Q, storeName: 'Q Shop' });
  await set(`businesses/${ABIZ}`, { ownerId: A, name: "A's business" });
  await set(`businesses/${BIZ}`, { ownerId: BO, name: 'Biz' });
  await set(`workspaceMemberships/q2c-mem-cust_${BIZ}`, { uid: 'q2c-mem-cust', businessId: BIZ, status: 'active', permissions: ['pos', 'customers'] });
  await set(`workspaceMemberships/q2c-mem-pos_${BIZ}`, { uid: 'q2c-mem-pos', businessId: BIZ, status: 'active', permissions: ['pos'] });
  await set('posCustomers/A1', { sellerId: A, phone: '254711000001', name: 'A one' });
  await set(`posCustomers/${A}_254711000002`, { phone: '254711000002', name: 'A composite' });
  await set('posCustomers/A3', { sellerId: A, name: 'A no phone' });
  await set('posCustomers/B1', { sellerId: B, phone: '254711000009', name: 'B one' });
  await set('posCustomers/BZ1', { sellerId: BO, phone: '254711000004', name: 'Biz customer' });
  for (let i = 0; i < 60; i++) await set(`posCustomers/QC${i}`, { sellerId: Q, phone: '2547220' + String(100 + i).padStart(5, '0'), name: 'Q' + i });
  const RAW = '+254799999999';

  process.stdout.write('[R] no arbitrary numbers, no foreign customers, no unproven merchant — nothing sent\n');
  { const { r, none } = await nothingSent(() => send(null, { merchantId: A, customerIds: ['A1'], message: 'hi' }));
    ok(!r.ok && r.code === 'unauthenticated' && none, 'R-0', 'anonymous: ' + why(r)); }
  { const { r, none, delta } = await nothingSent(() => send(A, { to: RAW, message: 'Your SOKONI code is 123456' }));
    ok(!r.ok && none, 'R-1', 'a RAW phone number (`to`) is not a recipient — nothing sent (' + delta + '): ' + why(r)); }
  { const { r, none, delta } = await nothingSent(() => send('q2c-stranger', { to: RAW, message: 'Your SOKONI code is 654321' }));
    ok(!r.ok && none, 'R-1b', 'ANY signed-in account (no shop at all) with a raw number — nothing sent (' + delta + '): ' + why(r)); }
  { const { r, none, delta } = await nothingSent(() => send(A, { bulk: [RAW, '+254788888888', '+254777777777'], message: 'promo' }));
    ok(!r.ok && none, 'R-2', 'a BULK list of raw numbers is not accepted — nothing sent (' + delta + '): ' + why(r)); }
  { const { r, none } = await nothingSent(() => send(A, { merchantId: A, customerIds: ['B1'], message: 'hi' }));
    ok(!r.ok && r.code === 'permission-denied' && /your customers/.test(r.msg) && none, 'R-3', "another merchant's customer: " + why(r)); }
  { const { r, none } = await nothingSent(() => send(A, { merchantId: A, customerIds: ['A1', 'B1'], message: 'hi' }));
    ok(!r.ok && r.code === 'permission-denied' && none, 'R-4', 'one foreign customer in the list refuses the WHOLE request — not even A1 is sent: ' + why(r)); }
  { const { r, none } = await nothingSent(() => send(A, { merchantId: A, customerIds: ['NO_SUCH'], message: 'hi' }));
    ok(!r.ok && r.code === 'permission-denied' && none, 'R-5', 'a missing customer gets the same refusal: ' + why(r)); }
  { const { r, none } = await nothingSent(() => send('q2c-stranger', { merchantId: A, customerIds: ['A1'], message: 'hi' }));
    ok(!r.ok && r.code === 'permission-denied' && none, 'R-6', 'a stranger claiming a real shop: ' + why(r)); }
  { const { r, none } = await nothingSent(() => send(A, { merchantId: B, customerIds: ['B1'], message: 'hi' }));
    ok(!r.ok && r.code === 'permission-denied' && none, 'R-7', "A claiming merchant B (to reach B's customer): " + why(r)); }
  { const { r, none } = await nothingSent(() => send('q2c-mem-pos', { merchantId: BIZ, customerIds: ['BZ1'], message: 'hi' }));
    ok(!r.ok && r.code === 'permission-denied' && none, 'R-8', 'a business member WITHOUT `customers`: ' + why(r)); }
  { const many = Array.from({ length: 101 }, (_, i) => 'A1');
    const { r, none } = await nothingSent(() => send(A, { merchantId: A, customerIds: many.map((x, i) => (i ? 'QC' + (i % 60) : x)), message: 'hi' }));
    ok(!r.ok && r.code === 'invalid-argument' && none, 'R-9', '101 recipients in one request: ' + why(r)); }
  { const { r, none } = await nothingSent(() => send(A, { merchantId: A, customerIds: ['A1'], message: '' }));
    ok(!r.ok && r.code === 'invalid-argument' && none, 'R-10', 'an empty message: ' + why(r)); }

  process.stdout.write('\n[S] the proven merchant reaches its own customers, at the numbers on record\n');
  { const { r, delta } = await nothingSent(() => send(A, { merchantId: A, customerIds: ['A1', `${A}_254711000002`], message: 'Sale today' }));
    const tos = SENT.slice(-2).map((s) => s.to).sort().join(',');
    ok(r.ok && r.out.sent === 2 && delta === 2 && tos === '254711000001,254711000002', 'S-1',
      'the shop owner → two own customers (field-owned and composite): sent to the numbers ON RECORD: ' + tos); }
  { const { r, delta } = await nothingSent(() => send(A, { merchantId: A, customerIds: ['A1', 'A3'], message: 'x' }));
    ok(r.ok && r.out.accepted === 1 && r.out.rejected === 1 && delta === 1, 'S-2', 'an own customer with no phone on record is counted as rejected, the other is sent: ' + why(r)); }
  { const { r, delta } = await nothingSent(() => send(A, { merchantId: A, customerIds: ['A1', 'A1', 'A1'], message: 'x' }));
    ok(r.ok && delta === 1, 'S-3', 'a repeated customer id is sent to once: ' + why(r)); }
  { const { r, delta } = await nothingSent(() => send('q2c-mem-cust', { merchantId: BIZ, customerIds: ['BZ1'], message: 'x' }));
    ok(r.ok && delta === 1 && SENT[SENT.length - 1].to === '254711000004', 'S-4', "a business member WITH `customers` reaches the business's customer: " + why(r)); }
  { const long = 'y'.repeat(300);
    const { r } = await nothingSent(() => send(A, { merchantId: A, customerIds: ['A1'], message: long }));
    ok(r.ok && SENT[SENT.length - 1].message.length === 160, 'S-5', 'the message is capped at 160 characters: ' + (SENT[SENT.length - 1] || {}).message.length); }

  process.stdout.write('\n[Q] 500 per merchant per day — server-side, merchant-scoped, atomic\n');
  { const owners = new Set([A, ABIZ]);
    await set(`smsMerchantQuota/${keyOf(owners)}_${day}`, { count: 499, merchantKey: keyOf(owners), day });
    const two = await nothingSent(() => send(A, { merchantId: A, customerIds: ['A1', `${A}_254711000002`], message: 'x' }));
    const c1 = await quotaCount(owners);
    const one = await nothingSent(() => send(A, { merchantId: ABIZ, customerIds: ['A1'], message: 'x' }));
    const c2 = await quotaCount(owners);
    const again = await nothingSent(() => send(A, { merchantId: A, customerIds: ['A1'], message: 'x' }));
    ok(!two.r.ok && two.r.code === 'resource-exhausted' && two.none && c1 === 499 && one.r.ok && one.delta === 1 && c2 === 500 && !again.r.ok && again.none, 'Q-1',
      'at 499: 2 more refused (nothing sent, count stays 499); 1 more via the BUSINESS claim uses the SAME quota → 500; then refused: ' +
      [why(two.r), why(one.r), why(again.r)].join(' | ')); }
  { const owners = new Set([Q]);
    await set(`smsMerchantQuota/${keyOf(owners)}_${day}`, { count: 450, merchantKey: keyOf(owners), day });
    const n0 = SENT.length;
    const idsA = Array.from({ length: 30 }, (_, i) => 'QC' + i), idsB = Array.from({ length: 30 }, (_, i) => 'QC' + (30 + i));
    const [r1, r2] = await Promise.all([send(Q, { merchantId: Q, customerIds: idsA, message: 'x' }), send(Q, { merchantId: Q, customerIds: idsB, message: 'x' })]);
    const okCount = [r1, r2].filter((r) => r.ok).length, exhausted = [r1, r2].filter((r) => !r.ok && r.code === 'resource-exhausted').length;
    const final = await quotaCount(owners), delta = SENT.length - n0;
    ok(okCount === 1 && exhausted === 1 && final === 480 && delta === 30, 'Q-2',
      'CONCURRENT: two requests of 30 at 450/500 — one is served, the other refused; the day ends at 480 (never 510) and 30 sends, not 60: ' +
      `served=${okCount} refused=${exhausted} count=${final} sent=${delta}`); }

  process.stdout.write('\n[A] every request is audited — without raw phone numbers\n');
  { const logs = (await db.collection('auditLogs').where('type', '==', 'posSendSMS').get()).docs.map((d) => d.data());
    const sentLog = logs.find((l) => l.outcome === 'sent' && l.requested === 2 && l.sent === 2);
    const refusals = new Set(logs.map((l) => l.outcome));
    const raw = JSON.stringify(logs);
    ok(!!sentLog && sentLog.callerUid === A && typeof sentLog.merchantKey === 'string' && Array.isArray(sentLog.recipientRefs) && sentLog.recipientRefs.length === 2 &&
      refusals.has('refused_not_your_customer') && refusals.has('refused_unproven_merchant') && refusals.has('refused_daily_limit') &&
      !/2547\d{8}/.test(raw), 'A-1',
      'audit records caller, merchant, hashed recipient refs, counts and each outcome (sent / not-your-customer / unproven / daily-limit) — and contains NO phone number');
  }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
