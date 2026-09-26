'use strict';
/**
 * CERTIFICATION — Repair 3: ONE reason authority for disputes, returns and refunds.
 *
 * Part S (static): the authority is well-formed; which reasons each surface accepts is PRESERVED
 * EXACTLY from before (only the spelling is unified); the browser mirror, the three pages and the
 * merchant labels all agree with the authority to the letter; and no second reason enum survives.
 * Part E (emulator, REAL callables): createDispute, submitReturn and the refund authority store the
 * CANONICAL code, accept old spellings as aliases, and refuse what they refused before.
 * Refuses to run without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const fs = require('fs');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const FN = process.env.REFUND_FUNCTIONS_DIR || path.join(__dirname, '..', 'functions');
const ROOT = process.env.REPAIR_ROOT || path.join(__dirname, '..');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-refund-reasons' });
const db = admin.firestore();
const TS = admin.firestore.Timestamp;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
let RR = null;
try { RR = require(path.join(FN, 'refund-reasons.js')); } catch (_) { /* absent on pre-Repair-3 code: its checks FAIL, not crash */ }
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* The surfaces' reason sets BEFORE this repair, as they were in the code — mapped through the aliases. */
const OLD_DISPUTE = ['not_received', 'wrong_item', 'not_as_described', 'counterfeit', 'damaged', 'defective', 'overcharged', 'other'];
const OLD_RETURN = ['defective', 'wrong_item', 'changed_mind', 'not_as_described', 'damaged_in_transit', 'other'];
const optionPairs = (html, selectId) => {
  const m = html.match(new RegExp('<select[^>]*id="' + selectId + '"[\\s\\S]*?</select>'));
  if (!m) return [];
  return [...m[0].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((x) => [x[1], x[2]]).filter((x) => x[0]);
};

function partS() {
  console.log('[S1] the authority is well-formed');
  if (!RR) {
    ok(false, 'functions/refund-reasons.js exists');
    /* Counterproof mode (pre-Repair-3 tree): judge the OLD surfaces against the CURRENT authority, so every
       drift check below is actually evaluated — not skipped because the module under test is absent. */
    RR = require(path.join(__dirname, '..', 'functions', 'refund-reasons.js'));
  }
  const codes = RR.REASONS.map((r) => r.code);
  ok(new Set(codes).size === codes.length && RR.REASONS.every((r) => r.label && typeof r.dispute === 'boolean' && typeof r.return === 'boolean' && typeof r.refund === 'boolean'),
    `${codes.length} unique codes, each with a label and a flag per surface`);
  ok(Object.entries(RR.ALIASES).every(([a, t]) => codes.includes(t) && !codes.includes(a)), 'every alias points at a canonical code and is not itself a code');
  ok(RR.REASONS.every((r) => r.refund), 'every reason is a valid refund reason');

  console.log('\n[S2] what each surface accepts is PRESERVED (spelling unified only)');
  const mapped = (xs) => [...new Set(xs.map((x) => RR.canonical(x)))].sort().join(',');
  ok(RR.allowedFor('dispute').slice().sort().join(',') === mapped(OLD_DISPUTE), `dispute set = the old dispute set, canonicalised (${RR.allowedFor('dispute').length})`);
  ok(RR.allowedFor('return').slice().sort().join(',') === mapped(OLD_RETURN), `return set = the old return set, canonicalised (${RR.allowedFor('return').length})`);
  ok(RR.canonical('overcharged') === 'billing_error' && RR.canonical('changed_mind') === 'buyer_request' && RR.canonical('damaged_in_transit') === 'damaged',
    'old spellings resolve to their canonical codes');
  ok(!RR.canonical('late_delivery') && !RR.canonical('Defective'), 'phantom / display-string "reasons" are not reasons');

  console.log('\n[S3] everything that names a reason agrees with the authority, to the letter');
  let mirror = null;
  try { mirror = require(path.join(ROOT, 'sokoni-refund-reasons.js')); } catch (_) {}
  ok(mirror && JSON.stringify(mirror.REASONS) === JSON.stringify(RR.REASONS.map((r) => Object.assign({}, r))) && JSON.stringify(mirror.ALIASES) === JSON.stringify(RR.ALIASES),
    'browser mirror sokoni-refund-reasons.js is identical to the authority');
  /* Anchored on the reason <select id="reason"> — the page has a second select (evidence type) that also
     offers "other", and an unanchored scan counted it as a ninth reason. */
  const dp = optionPairs(read('dispute-portal.html'), 'reason');
  ok(dp.length === RR.allowedFor('dispute').length && dp.every(([v, l]) => RR.allowedFor('dispute').includes(v) && RR.labelOf(v) === l),
    `dispute-portal offers exactly the dispute set, canonical codes and labels (${dp.map((x) => x[0]).join(',')})`);
  const rt = optionPairs(read('returns.html'), 'r-reason');
  ok(rt.length > 0 && rt.every(([v, l]) => RR.allowedFor('return').includes(v) && RR.labelOf(v) === l),
    `returns.html offers canonical return codes and labels (${rt.map((x) => x[0]).join(',')})`);
  let DP = null;
  try { DP = require(path.join(ROOT, 'sokoni-merchant-disputes.js')); } catch (_) {}
  const merchantLabels = (() => { const m = read('sokoni-merchant-disputes.js').match(/var REASON_LABELS = \{([\s\S]*?)\};/); if (!m) return {};
    return Object.fromEntries([...m[1].matchAll(/(\w+):\s*'([^']*)'/g)].map((x) => [x[1], x[2]])); })();
  ok(Object.keys(merchantLabels).sort().join(',') === RR.REASONS.map((r) => r.code).sort().join(',') &&
     Object.entries(merchantLabels).every(([c, l]) => RR.labelOf(c) === l), 'merchant dispute labels = every canonical code with its canonical label (no phantom late_delivery)');

  console.log('\n[S4] no second reason enum survives on the server');
  const offenders = fs.readdirSync(FN).filter((f) => f.endsWith('.js') && f !== 'refund-reasons.js')
    .filter((f) => /VALID_REASONS|['"]changed_mind['"]|['"]damaged_in_transit['"]|['"]overcharged['"]/.test(fs.readFileSync(path.join(FN, f), 'utf8')));
  ok(offenders.length === 0, `no server module keeps its own reason list (${offenders.join(', ') || 'none'})`);
  ok(/refund-reasons'\)\.CODE\.NOT_RECEIVED/.test(fs.readFileSync(path.join(FN, 'automation-engine.js'), 'utf8')), 'automation reads the canonical constant');
}

async function partE() {
  const wipe = async () => { for (const c of ['orders', 'disputes', 'returns', 'payments', 'wallets', 'walletTransactions', 'refundAuthority']) {
    const s = await db.collection(c).get();
    for (const d of s.docs) { for (const sub of await d.ref.listCollections()) { const ss = await sub.get(); await Promise.all(ss.docs.map((x) => x.ref.delete())); } await d.ref.delete(); } } };
  const run = async (fn, uid, data, token) => { try { return { ok: true, v: await fn.run({ auth: { uid, token: token || {} }, data }) }; } catch (e) { return { ok: false, code: e.code || e.message }; } };
  const D = require(path.join(FN, 'disputes.js'));
  const R = require(path.join(FN, 'returns-engine.js'));

  console.log('\n[E1] disputes store the canonical code');
  await wipe();
  const order = (id) => db.doc(`orders/${id}`).set({ buyerUid: 'B', buyerId: 'B', uid: 'B', sellerUid: 'S', status: 'delivered', total: 97, createdAt: TS.now() });
  await order('D1');
  const d1 = await run(D.createDispute, 'B', { orderId: 'D1', reason: 'overcharged', description: 'I was charged twice for this.' });
  ok(d1.ok && ((await db.doc('disputes/dp_D1').get()).data() || {}).reason === 'billing_error', 'old spelling "overcharged" accepted and STORED as billing_error');
  await order('D2');
  ok(!(await run(D.createDispute, 'B', { orderId: 'D2', reason: 'changed_mind', description: 'I do not want it any more.' })).ok, 'a return-only reason is still not a dispute reason (unchanged)');
  ok(!(await run(D.createDispute, 'B', { orderId: 'D2', reason: 'late_delivery', description: 'It came a week late.' })).ok, 'the phantom late_delivery is refused (as it always was server-side)');

  console.log('\n[E2] returns store the canonical code');
  await order('R1'); await order('R2'); await order('R3');
  const item = [{ productId: 'p', name: 'Thing', qty: 1, price: 97 }];
  const r1 = await run(R.submitReturn, 'B', { orderId: 'R1', items: item, reason: 'changed_mind', resolution: 'refund' });
  ok(r1.ok && ((await db.doc('returns/ret_R1_B').get()).data() || {}).reason === 'buyer_request', 'changed_mind accepted and STORED as buyer_request');
  const r2 = await run(R.submitReturn, 'B', { orderId: 'R2', items: item, reason: 'damaged_in_transit', resolution: 'refund' });
  ok(r2.ok && ((await db.doc('returns/ret_R2_B').get()).data() || {}).reason === 'damaged', 'damaged_in_transit accepted and STORED as damaged');
  ok(!(await run(R.submitReturn, 'B', { orderId: 'R3', items: item, reason: 'counterfeit', resolution: 'refund' })).ok, 'a dispute-only reason is still not a return reason (unchanged)');

  console.log('\n[E3] the refund authority validates and stores a canonical reason code');
  let RA = null;
  try { RA = require(path.join(FN, 'refund-authority.js')); } catch (_) {}
  const seed = async (ref) => {
    await db.doc(`payments/${ref}`).set({ status: 'COMPLETE', amount: 97, uid: 'B', meta: { orderId: ref }, walletCreditedAt: TS.now(), walletCreditCents: 8700, walletCreditedTo: 'S' });
    await db.doc(`orders/${ref}`).set({ sellerUid: 'S', buyerUid: 'B', settlementStatus: 'settled' });
    await db.collection('wallets').doc('S').collection('transactions').add({ type: 'sale', direction: 'credit', amountCents: 8700, orderId: ref });
    await db.doc('wallets/S').set({ availableBalance: 8700, withdrawableBalance: 8700, lifetimeEarnings: 8700, balance: 0 });
  };
  if (!RA) ok(false, 'refund-authority present');
  else {
    await wipe(); await seed('P1');
    let bad = null; try { await RA.refundToBuyerWallet(db, { paymentRef: 'P1', requestedBy: 'admin', reasonCode: 'nonsense' }); } catch (e) { bad = e; }
    ok(bad && /reason/.test(String(bad.reason || bad.message)) && !(await db.doc('refundAuthority/P1').get()).exists, `an unknown reason code is refused before any write (${bad && bad.reason})`);
    let good = null; try { good = await RA.refundToBuyerWallet(db, { paymentRef: 'P1', requestedBy: 'admin', reasonCode: 'overcharged' }); } catch (e) { good = { e: e.message }; }
    ok(good && !good.e && ((await db.doc('refundAuthority/P1').get()).data() || {}).reasonCode === 'billing_error', 'a valid (aliased) reason code is stored canonical on the refund');
  }
}

(async () => {
  partS();
  await partE();
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a verdict):', e && e.stack || e); process.exit(3); });
