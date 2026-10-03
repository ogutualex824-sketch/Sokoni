'use strict';
/**
 * CERTIFICATION — POS/Till convergence, SERVER half (owner 2026-09-30).
 *
 *   P-*  the Till's M-PESA is the EXISTING IntaSend STK rail (posInitiateIntasendPayment →
 *        webhookIntasend finalizeFromWebhook → posPaymentIntents + posPaymentStatus), and a paid
 *        prompt now settles a sale through the SAME certified module and the SAME spent-once claim.
 *        Before this, the checkout looked for the payment in posPayments (the QR rail) and refused
 *        every paid till prompt. Nothing unpaid, foreign, mismatched or replayed becomes a sale.
 *   T-*  Business Pulse takings (merchantTillTakings): the Nairobi day, from the canonical sale
 *        record, owner/admin/manager only; a browser-mirrored row is never revenue.
 *
 * Runs the REAL posCompleteCheckout and the REAL callable against the Firestore emulator.
 *   firebase emulators:exec --only firestore,auth --project demo-till "node scripts/test-pos-till-convergence-server.js"
 * REPAIR_ROOT: tree under test (default this repo). Point it at the parent (8183694): P-1/P-2/T-* must FAIL there.
 */
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-till';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 240s\n'); process.exit(3); }, 240000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const { onCall, HttpsError } = require(require.resolve('firebase-functions/v2/https', { paths: [FN] }));

let pass = 0, fail = 0;
const ok = (c, id, m, got) => { c ? pass++ : fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (c || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']') + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), cw: console.warn, ce: console.error, cl: console.log };
async function quiet(fn) { process.stdout.write = () => true; console.warn = console.error = console.log = () => {};
  try { return await fn(); } finally { process.stdout.write = _REAL.so; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; } }

const PZF = require(path.join(FN, 'pos-zero-friction.js'));
let TK = null; try { TK = require(path.join(FN, 'merchant-till-takings.js')); } catch (_) { TK = null; }
const REQ = (uid, data) => ({ data, auth: uid ? { uid, token: { uid } } : null, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
async function checkout(uid, data) {
  try { const r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, data))); return { ok: true, r: r || {} }; }
  catch (e) { return { ok: false, code: e.code, msg: String(e.message || '') }; }
}
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const stockOf = async (id) => Number(((await get('products', id)) || {}).stock);
const salesByKey = async (key) => (await db.collection('posRetailSales').where('idempotencyKey', '==', key).get()).size;
const sale = (m, key, pid, amount, payments) => ({ idempotencyKey: key, merchantId: m,
  items: [{ productId: pid, qty: 1, unitPrice: amount, name: pid }], payments, subtotal: amount, discountTotal: 0, taxTotal: 0, grandTotal: amount });

/* The two server-only records the STK rail writes (initiator + webhook), seeded as they would be. */
async function stk(ref, o) {
  await db.collection('posPaymentIntents').doc(ref).set(Object.assign({ ref, provider: 'intasend', currency: 'KES', state: o.status || 'completed',
    merchantId: o.merchantId, idempotencyKey: o.key, amountCents: o.amountCents }, o.intentExtra || {}));
  /* confirmedAmountKES = IntaSend's own paid figure, as webhookIntasend finalizeFromWebhook writes it (2026-10-03: the gate
     settles on THIS, never the requested amountCents). Default: a full payment; o.confirmedKES overrides (partial / absent). */
  if (o.status !== null) await db.collection('posPaymentStatus').doc(ref).set({ ref, status: o.status || 'completed', merchantId: o.merchantId,
    amountCents: o.amountCents, transactionRef: ref,
    confirmedAmountKES: Object.prototype.hasOwnProperty.call(o, 'confirmedKES') ? o.confirmedKES : (o.amountCents == null ? null : o.amountCents / 100) });
}

(async () => {
  
  process.stdout.write(`\nPOS/Till convergence — server   (tree: ${ROOT})\n\n`);
  const A = 'tc-shop-a', B = 'tc-shop-b', MGR = 'tc-manager', CASH = 'tc-cashier', STR = 'tc-stranger';
  for (const m of [A, B]) {
    await db.collection('shops').doc(m).set({ name: 'Shop ' + m, ownerId: m });
    await db.collection('users').doc(m).set({ name: m }); await db.collection('sellers').doc(m).set({ name: m });
    for (let i = 1; i <= 12; i++) await db.collection('products').doc(m + '_P' + i).set({ name: m + '_P' + i, price: 100, stock: 50, trackInventory: true, sellerUid: m, shopId: m });
  }
  for (const [uid, role] of [[MGR, 'manager'], [CASH, 'cashier']]) {
    await db.collection('users').doc(uid).set({ name: uid });
    await db.collection('shopEmployees').doc(A + '_' + uid).set({ shopId: A, uid, role, active: true, shopOwnerId: A });
  }
  await db.collection('users').doc(STR).set({ name: STR });

  /* ── P: the Till's M-PESA through the certified STK rail ── */
  process.stdout.write('[P] a paid IntaSend M-PESA prompt settles exactly one sale; nothing else does\n');
  const c0 = await checkout(A, sale(A, 'tc-cash-0', A + '_P1', 100, [{ method: 'cash', amount: 100 }]));
  ok(c0.ok, 'P-0', 'control: a cash sale completes on this fixture', c0.ok ? undefined : c0);

  { const key = 'tc-k1', ref = 'postill_' + A + '_' + key, pid = A + '_P2';
    await stk(ref, { merchantId: A, key, amountCents: 10000 });
    const r = await checkout(A, sale(A, key, pid, 100, [{ method: 'mpesa', amount: 100, ref }]));
    const claim = await get('posPaymentClaims', ref);
    ok(r.ok && (await salesByKey(key)) === 1 && (await stockOf(pid)) === 49 && !!claim,
      'P-1', 'completed prompt for THIS shop and THIS sale → one sale, stock −1 once, reference claimed', r.ok ? { sales: await salesByKey(key), stock: await stockOf(pid), claim: !!claim } : r);
    const again = await checkout(A, sale(A, key, pid, 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(again.ok && (await salesByKey(key)) === 1 && (await stockOf(pid)) === 49 && (again.r.saleId || null) === (r.r && r.r.saleId || null),
      'P-2', 'replaying the same sale key returns the original sale — no second sale, no second stock move', { ok: again.ok, sales: await salesByKey(key), stock: await stockOf(pid) });
    const other = await checkout(A, sale(A, 'tc-k1-other', A + '_P3', 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(!other.ok && /different sale/.test(other.msg) && (await salesByKey('tc-k1-other')) === 0 && (await stockOf(A + '_P3')) === 50,
      'P-3', 'the same paid prompt cannot settle a DIFFERENT sale (wrong sale key) — no sale, no stock', other.ok ? 'completed' : other.msg);
  }
  for (const [id, status, label] of [['P-4', 'pending', 'still pending'], ['P-5', 'failed', 'failed at the provider']]) {
    const key = 'tc-' + status, ref = 'postill_' + A + '_' + key, pid = A + (status === 'pending' ? '_P4' : '_P5');
    await stk(ref, { merchantId: A, key, amountCents: 10000, status });
    const r = await checkout(A, sale(A, key, pid, 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(!r.ok && (status === 'failed' ? /did not go through/ : /not completed this M-PESA/).test(r.msg) && (await salesByKey(key)) === 0 && (await stockOf(pid)) === 50 && !(await get('posPaymentClaims', ref)),
      id, 'a prompt ' + label + ' → refused; no sale, no stock move, no claim', r.ok ? 'completed' : r.msg);
  }
  { const key = 'tc-foreign', ref = 'postill_' + B + '_' + key;
    await stk(ref, { merchantId: B, key, amountCents: 10000 });
    const r = await checkout(A, sale(A, key, A + '_P6', 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(!r.ok && r.code === 'permission-denied' && /different shop/.test(r.msg) && (await salesByKey(key)) === 0, 'P-6', "another shop's paid prompt is refused (permission-denied)", r.ok ? 'completed' : r.code);
  }
  { const key = 'tc-short', ref = 'postill_' + A + '_' + key;
    await stk(ref, { merchantId: A, key, amountCents: 1000 });
    const r = await checkout(A, sale(A, key, A + '_P7', 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(!r.ok && /confirmed payment is 10 but/.test(r.msg) && (await salesByKey(key)) === 0 && (await stockOf(A + '_P7')) === 50, 'P-7', 'a KES 10 prompt cannot settle a KES 100 sale', r.ok ? 'completed' : r.msg);
  }
  { const key = 'tc-none', ref = 'postill_' + A + '_' + key;
    const r = await checkout(A, sale(A, key, A + '_P8', 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(!r.ok && r.code === 'not-found' && (await salesByKey(key)) === 0, 'P-8', 'no prompt on record → not-found, nothing charged', r.ok ? 'completed' : r.code);
  }
  { const key = 'tc-notintasend', ref = 'postill_' + A + '_' + key;
    await stk(ref, { merchantId: A, key, amountCents: 10000, intentExtra: { provider: 'daraja' } });
    const r = await checkout(A, sale(A, key, A + '_P9', 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(!r.ok && /cannot be identified/.test(r.msg) && (await salesByKey(key)) === 0, 'P-9', 'a non-IntaSend intent is refused', r.ok ? 'completed' : r.code);
  }
  { const key = 'tc-noowner', ref = 'postill_' + A + '_' + key;
    await stk(ref, { merchantId: A, key, amountCents: 10000, intentExtra: { merchantId: null } });
    const r = await checkout(A, sale(A, key, A + '_P11', 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(!r.ok && /does not identify its shop/.test(r.msg) && (await salesByKey(key)) === 0, 'P-11', 'a prompt whose intent names no shop is refused', r.ok ? 'completed' : r.msg);
  }
  { const key = 'tc-daraja', ref = 'ws_CO_legacy_1';
    await db.collection('posPayments').doc(ref).set({ checkoutId: ref, status: 'completed', sellerUid: A, amount: 100 });
    const r = await checkout(A, sale(A, key, A + '_P10', 100, [{ method: 'mpesa', amount: 100, ref }]));
    ok(!r.ok && /retired M-PESA Daraja/.test(r.msg) && (await salesByKey(key)) === 0, 'P-10', 'unchanged: a legacy Daraja record still cannot settle a sale', r.ok ? 'completed' : r.code);
  }

  /* ── T: Business Pulse takings ── */
  process.stdout.write('\n[T] Business Pulse reads the canonical sale, for the Nairobi day, for the shop\'s money roles only\n');
  if (!TK) { ok(false, 'T-0', 'merchant-till-takings.js exists', 'missing'); }
  else {
    const NOW = Date.UTC(2026, 8, 30, 10, 0, 0);           /* 13:00 in Nairobi */
    const TS = (ms) => admin.firestore.Timestamp.fromMillis(ms);
    const T = 'tc-shop-t';
    await db.collection('shops').doc(T).set({ name: 'Shop T', ownerId: T });
    const row = (id, o) => db.collection('posRetailSales').doc(id).set(Object.assign({ merchantId: T, sellerId: T, status: 'completed',
      idempotencyKey: 'k_' + id, items: [{ productId: 'pA', name: 'Soda', qty: 1 }] }, o));
    await row('t1', { saleDate: '2026-09-30', createdAt: TS(NOW - 3600000), grandTotal: 250, items: [{ productId: 'pA', name: 'Soda', qty: 2 }],
      position: { cashCents: 25000, electronicCents: 0, byMethod: { cash: 25000 } }, commission: { amountCents: 1250 } });
    await row('t2', { saleDate: '2026-09-29', createdAt: TS(Date.UTC(2026, 8, 29, 21, 30)), grandTotal: 100,       /* 00:30 Nairobi TODAY */
      position: { cashCents: 0, electronicCents: 10000, byMethod: { mpesa: 10000 } }, commission: { amountCents: 500 } });
    await row('t3', { saleDate: '2026-09-29', createdAt: TS(Date.UTC(2026, 8, 29, 12, 0)), grandTotal: 70 });      /* yesterday */
    await row('t4', { createdAt: TS(NOW - 600000), grandTotal: 9999, idempotencyKey: null });                     /* browser mirror */
    await row('t5', { saleDate: '2026-09-30', createdAt: TS(NOW - 60000), grandTotal: 500, status: 'refunded' });
    await db.collection('posRetailSales').doc('t6').set({ merchantId: B, sellerId: B, status: 'completed', idempotencyKey: 'k_t6', saleDate: '2026-09-30', createdAt: TS(NOW - 60000), grandTotal: 777 });
    for (const [uid, role] of [[MGR, 'manager'], [CASH, 'cashier']]) await db.collection('shopEmployees').doc(T + '_' + uid).set({ shopId: T, uid, role, active: true, shopOwnerId: T });

    const fixed = TK.makeMerchantTillTakings({ onCall, HttpsError, db, now: () => NOW });
    const call = async (fnc, uid, shopId) => { try { return { ok: true, r: await quiet(() => fnc.run(REQ(uid, { shopId }))) }; } catch (e) { return { ok: false, code: e.code }; } };
    const o = await call(fixed, T, T);
    const td = o.ok ? o.r.today : {};
    ok(o.ok && td.sales === 2 && td.revenueCents === 35000, 'T-1', 'today = the two checkout sales of the Nairobi day (KES 350), incl. one at 00:30 that sits on the previous UTC date', o.ok ? { sales: td.sales, rev: td.revenueCents } : o);
    ok(o.ok && td.cashCents === 25000 && td.electronicCents === 10000 && td.byMethodCents.mpesa === 10000 && td.commissionCents === 1750,
      'T-2', 'tender split and commission are the checkout\'s own figures', o.ok ? { cash: td.cashCents, el: td.electronicCents, by: td.byMethodCents, com: td.commissionCents } : o);
    ok(o.ok && td.refunds === 1 && td.itemsSold === 3 && td.topProducts[0] && td.topProducts[0].name === 'Soda', 'T-3', 'a refund is counted as a refund, not revenue; items sold and top product', o.ok ? { ref: td.refunds, items: td.itemsSold } : o);
    ok(o.ok && o.r.yesterday.sales === 1 && o.r.yesterday.revenueCents === 7000, 'T-4', 'yesterday is its own window', o.ok ? o.r.yesterday : o);
    ok(o.ok && td.revenueCents !== 35000 + 999900 && o.r.truncated === false, 'T-5', 'a browser-mirrored row (no server saleDate / key) is never revenue; another shop\'s sale is not counted', o.ok ? td.revenueCents : o);
    const m = await call(fixed, MGR, T), c = await call(fixed, CASH, T), s = await call(fixed, STR, T), u = await call(fixed, null, T);
    ok(m.ok, 'T-6', 'a shop manager may see takings', m.ok ? undefined : m.code);
    ok(!c.ok && c.code === 'permission-denied', 'T-7', 'a cashier may not', c.ok ? 'allowed' : c.code);
    ok(!s.ok && s.code === 'permission-denied' && !u.ok && u.code === 'unauthenticated', 'T-8', 'a stranger and a signed-out caller may not', { s: s.code, u: u.code });

    /* the Pulse sees a REAL checkout sale, end to end (real clock) */
    const live = TK.makeMerchantTillTakings({ onCall, HttpsError, db });
    const l = await call(live, A, A);
    ok(l.ok && l.r.today.sales >= 2 && l.r.today.revenueCents >= 20000, 'T-9', 'the Pulse sees the sales P-0/P-1 just made through posCompleteCheckout', l.ok ? { sales: l.r.today.sales, rev: l.r.today.revenueCents } : l);
    const d = TK.nairobiDay(Date.UTC(2026, 8, 29, 21, 0), 0), d2 = TK.nairobiDay(Date.UTC(2026, 8, 29, 20, 59, 59), 0);
    ok(d.label === '2026-09-30' && d2.label === '2026-09-29', 'T-10', 'the Nairobi day turns at 21:00 UTC', { d: d.label, d2: d2.label });
  }

  /* ── Owner P0 2026-10-03 (sokoni-pos): POS-01..POS-15 on the real posCompleteCheckout ─────────────── */
  {
    const prod = async (id, price) => { await db.collection('products').doc(id).set({ name: id, price, stock: 50, trackInventory: true, sellerUid: A, shopId: A }   /* same shape as the suite's own fixture */); };
    let n = 0;
    const tryPay = async (payments, amount, keySuffix) => { n++; const pid = A + '_POS' + n; await prod(pid, amount); const key = 'tc-pos-' + keySuffix + '-' + n; const r = await checkout(A, sale(A, key, pid, amount, payments)); return { r, key }; };
    /* POS-01 valid */
    { await stk('postill_pos01', { merchantId: A, key: 'tc-pos-01-' + (n + 1), amountCents: 10000 });
      const { r, key } = await tryPay([{ method: 'mpesa', amount: 100, ref: 'postill_pos01' }], 100, '01');
      ok(r.ok && (await salesByKey(key)) === 1, 'POS-01', 'confirmed IntaSend payment (provider confirmed KES 100) → sale completes', r.ok ? undefined : r); }
    /* POS-05 partial: requested 100, provider confirmed only 10 */
    { await stk('postill_pos05', { merchantId: A, key: 'tc-pos-05-' + (n + 1), amountCents: 10000, confirmedKES: 10 });
      const { r, key } = await tryPay([{ method: 'mpesa', amount: 100, ref: 'postill_pos05' }], 100, '05');
      ok(!r.ok && /confirmed payment is 10 but/.test(r.msg) && (await salesByKey(key)) === 0, 'POS-05', 'PARTIAL: provider confirmed KES 10 of a KES 100 prompt → refused (gate uses the provider figure)', r.ok ? 'completed' : r.msg); }
    /* POS-05b provider reported no amount */
    { await stk('postill_pos05b', { merchantId: A, key: 'tc-pos-05b-' + (n + 1), amountCents: 10000, confirmedKES: null });
      const { r, key } = await tryPay([{ method: 'mpesa', amount: 100, ref: 'postill_pos05b' }], 100, '05b');
      ok(!r.ok && /did not report an amount/.test(r.msg) && (await salesByKey(key)) === 0, 'POS-05b', 'provider reported no amount → refused', r.ok ? 'completed' : r.msg); }
    /* POS-08 currency */
    { await stk('postill_pos08', { merchantId: A, key: 'tc-pos-08-' + (n + 1), amountCents: 10000, intentExtra: { currency: 'USD' } });
      const { r, key } = await tryPay([{ method: 'mpesa', amount: 100, ref: 'postill_pos08' }], 100, '08');
      ok(!r.ok && /Kenya shillings/.test(r.msg) && (await salesByKey(key)) === 0, 'POS-08', 'non-KES payment → refused', r.ok ? 'completed' : r.msg); }
    /* POS-03 pending / POS-04 failed */
    { await stk('postill_pos03', { merchantId: A, key: 'tc-pos-03-' + (n + 1), amountCents: 10000, status: 'pending' });
      const a3 = await tryPay([{ method: 'mpesa', amount: 100, ref: 'postill_pos03' }], 100, '03');
      await stk('postill_pos04', { merchantId: A, key: 'tc-pos-04-' + (n + 1), amountCents: 10000, status: 'failed' });
      const a4 = await tryPay([{ method: 'mpesa', amount: 100, ref: 'postill_pos04' }], 100, '04');
      ok(!a3.r.ok && !a4.r.ok && (await salesByKey(a3.key)) === 0 && (await salesByKey(a4.key)) === 0, 'POS-03/04', 'pending and failed payments → refused', [a3.r.msg, a4.r.msg]); }
    /* POS-10 / POS-09 / POS-11: SIMULATED_ / fake / browser-success without a provider record */
    { const a10 = await tryPay([{ method: 'mpesa', amount: 100, ref: 'SIMULATED_1791000000000' }], 100, '10');
      const a9 = await tryPay([{ method: 'mpesa', amount: 100, ref: 'postill_doesnotexist' }], 100, '09');
      const a11 = await tryPay([{ method: 'mpesa', amount: 100 }], 100, '11');
      ok(!a10.r.ok && !a9.r.ok && !a11.r.ok && (await salesByKey(a10.key)) + (await salesByKey(a9.key)) + (await salesByKey(a11.key)) === 0, 'POS-09/10/11', 'SIMULATED_ ref, unknown ref and a reference-less "paid" line → refused', [a10.r.msg, a9.r.msg, a11.r.msg]); }
    /* POS-15 method mismatch + unknown tenders */
    { await stk('postill_pos15', { merchantId: A, key: 'tc-pos-15-' + (n + 1), amountCents: 10000 });
      const a15 = await tryPay([{ method: 'card', amount: 100, ref: 'postill_pos15' }], 100, '15');
      const aT = await tryPay([{ method: 'mpesa_till_manual', amount: 100, ref: 'QK12AB34CD' }], 100, 'T1');
      const aB = await tryPay([{ method: 'bank', amount: 100 }], 100, 'T2');
      const aG = await tryPay([{ method: 'gift_card', amount: 100 }], 100, 'T3');
      ok(!a15.r.ok && /only settle an M-PESA payment/.test(a15.r.msg) && !aT.r.ok && !aB.r.ok && !aG.r.ok && /cannot settle a sale|cannot be accepted at the till/.test(aB.r.msg)   /* the earlier 6b _TENDERS loop may refuse first */
        && (await salesByKey(a15.key)) + (await salesByKey(aT.key)) + (await salesByKey(aB.key)) + (await salesByKey(aG.key)) === 0,
        'POS-15', 'an M-PESA prompt used as card, manual till code, bank and gift card → refused (closed tender list)', [a15.r.msg, aT.r.msg, aB.r.msg, aG.r.msg]); }
    /* POS-12 / POS-14: replay the POS-01 payment on another sale */
    { const a12 = await tryPay([{ method: 'mpesa', amount: 100, ref: 'postill_pos01' }], 100, '12');
      ok(!a12.r.ok && (await salesByKey(a12.key)) === 0, 'POS-12/14', 'a payment already confirmed for another sale cannot settle this one', a12.r.ok ? 'completed' : a12.r.msg); }
    /* GC-16 (owner P0 gift-card brief, sokoni-5b): two tills race to spend ONE KES 100 card on two KES 100 sales.
       Real Firestore transaction contention — the reason this row lives in the emulator suite. Exactly one sale
       completes; the card ends at 0 with ONE redemption and ONE payment record; the loser leaves no sale. */
    { await db.collection('giftCards').doc('RACE-0016').set({ code: 'RACE-0016', shopId: A, balance: 100, initialBalance: 100, status: 'active',
        expiryDate: admin.firestore.Timestamp.fromMillis(Date.now() + 864e5), redemptions: [] });
      const [g1, g2] = await Promise.all([
        tryPay([{ method: 'gift_card', code: 'RACE-0016', amount: 100 }], 100, 'GC16a'),
        tryPay([{ method: 'gift_card', code: 'RACE-0016', amount: 100 }], 100, 'GC16b'),
      ]);
      const c = (await get('giftCards', 'RACE-0016')) || {};
      const recs = (await db.collection('posGiftCardRedemptions').where('code', '==', 'RACE-0016').get()).size;
      const won = [g1, g2].filter((x) => x.r.ok).length;
      const salesMade = (await salesByKey(g1.key)) + (await salesByKey(g2.key));
      ok(won === 1 && salesMade === 1 && c.balance === 0 && (c.redemptions || []).length === 1 && recs === 1,
        'GC-16', 'two tills spending the same KES 100 card at once → exactly one sale, card 0, one redemption, one payment record',
        { won, salesMade, balance: c.balance, redemptions: (c.redemptions || []).length, recs, msgs: [g1.r.msg, g2.r.msg] }); }
  }

  clearTimeout(WATCHDOG);
  process.stdout.write('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { clearTimeout(WATCHDOG); process.stdout.write('\n  ✖ CRASH ' + (e && e.stack || e) + '\n'); process.exit(5); });
