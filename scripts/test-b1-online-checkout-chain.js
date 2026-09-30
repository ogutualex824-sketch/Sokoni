'use strict';
/**
 * CERTIFICATION — owner repair #1 (2026-09-30): ONLINE PRODUCT CHECKOUT AUTHORITY, units 1–3 + 4b.
 * (Unit 4b copy: row C-1 — which asserted the pre-4b legacy settlement — is replaced by C-1a/C-1r/C-2 and the C-3 controls.)
 *
 * The whole chain, with the REAL code on each side:
 *   Unit 1  createPaymentIntent (CPI_ROOT, default this tree = live 7d115bc + the product_order port)
 *           prices the cart from the catalogue and resolves the seller from each product's record;
 *   ——      payments/{ref} is written in the EXACT shape the live initiateSTKPush (47bc9eb + diffs)
 *           writes: { ref, amount, currency:'KES', status:'PENDING', uid, intentRef: ref, meta };
 *   Unit 2  webhookIntasend (WH_ROOT, default C:/temp/sok-whdraft = 68811e1 + the product_order gate),
 *           called over HTTP with the real challenge, a real-shaped IntaSend invoice (value, net_amount,
 *           charges, currency — the shape measured in production logs 2026-09-30);
 *   Unit 3  checkout.html (CLIENT, default C:/temp/sok-b1web) — static: it asks the server for the
 *           price and never names the seller.
 *
 *   firebase emulators:exec --only firestore,auth --project demo-b1 "node scripts/test-b1-online-checkout-chain.js"
 * Baseline: CPI_ROOT=<7d115bc tree> WH_ROOT=<68811e1 tree> CLIENT=<18e3711 tree> — the repair rows must FAIL.
 */
const path = require('path'), fs = require('fs');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
if (!/^demo-/.test(process.env.GCLOUD_PROJECT || '')) { console.error('REFUSED: needs a demo-* project'); process.exit(2); }
process.env.FUNCTIONS_EMULATOR = 'true';
const CHALLENGE = 'b1-chain-test-challenge';
process.env.INTASEND_WEBHOOK_CHALLENGE = CHALLENGE;
const CPI = path.resolve(process.env.CPI_ROOT || 'C:/temp/sok-cpi', 'functions');   /* Unit 1 lives on the createPaymentIntent lineage, not this one */
const WH = path.resolve(process.env.WH_ROOT || path.join(__dirname, '..'), 'functions');
const CLIENT = path.resolve(process.env.CLIENT || 'C:/temp/sok-b1web');
const WATCHDOG = setTimeout(() => { console.log('\n  ✖ WATCHDOG 280s'); process.exit(3); }, 280000);

let pass = 0, fail = 0;
const ok = (c, id, m, got) => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (c || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); };
const _R = { so: process.stdout.write.bind(process.stdout), cw: console.warn, ce: console.error, cl: console.log, ci: console.info };
async function quiet(fn) { process.stdout.write = () => true; console.warn = console.error = console.log = console.info = () => {};
  try { return await fn(); } finally { process.stdout.write = _R.so; console.warn = _R.cw; console.error = _R.ce; console.log = _R.cl; console.info = _R.ci; } }

(async () => {
  console.log(`\nB1 online checkout chain   CPI=${CPI}\n                            WH=${WH}\n                            CLIENT=${CLIENT}\n`);
  const admin = require(require.resolve('firebase-admin', { paths: [WH] }));
  const WHMOD = await quiet(async () => require(path.join(WH, 'index.js')));
  const db = admin.firestore();
  let PI = null; try { PI = require(path.join(CPI, 'payment-intents.js')); } catch (e) { PI = null; }
  /* Isolation: every run starts from an EMPTY emulator, so a run never inherits another run's intents,
     payments or wallets (runs are chained in one emulator session for mutants and baselines). */
  for (const c of await db.listCollections()) { const snap = await c.get(); await Promise.all(snap.docs.map((d) => d.ref.delete())); }
  const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
  const wallet = async (uid) => { const w = await get('wallets', uid) || {}; return Number(w.availableBalance || 0); };
  const stock = async (id) => Number(((await get('products', id)) || {}).stock);

  /* ── fixtures: two sellers, their products (the canonical seller is ON the product) ── */
  const S1 = 'b1-seller-1', S2 = 'b1-seller-2', BUYER = 'b1-buyer', ATTACKER = 'b1-attacker-wallet';
  for (const s of [S1, S2]) {
    await db.collection('sellers').doc(s).set({ name: 'Shop ' + s });
    await db.collection('shops').doc(s).set({ name: 'Shop ' + s, ownerId: s, sellerUid: s });
    await db.collection('users').doc(s).set({ name: s });
  }
  await db.collection('users').doc(BUYER).set({ name: 'Buyer' });
  const P = (id, seller, price) => db.collection('products').doc(id).set({ name: id, price, stock: 20, sellerUid: seller, shopId: seller, status: 'active', trackInventory: true });
  await P('b1-soda', S1, 390); await P('b1-cake', S1, 250); await P('b1-other', S2, 100);

  async function mint(items, extra) {
    if (!PI || !PI.createPaymentIntent) return { ok: false, code: 'NO_CREATE_PAYMENT_INTENT' };
    try {
      const r = await quiet(() => PI.createPaymentIntent.run({ auth: { uid: BUYER, token: { uid: BUYER } },
        data: Object.assign({ purpose: 'product_order', items, fulfillmentType: 'pickup', phone: '254700000001' }, extra || {}),
        rawRequest: { headers: {}, ip: '127.0.0.1' } }));
      return { ok: true, r };
    } catch (e) { return { ok: false, code: e.code, msg: String(e.message || '') }; }
  }
  /* exactly what the live initiateSTKPush writes (47bc9eb index ~6417) */
  async function stk(ref, amountKES, meta, intentRef) {
    await db.collection('payments').doc(ref).set({ ref, checkoutId: 'INV-' + ref, phone: '254700000001', amount: amountKES, currency: 'KES',
      status: 'PENDING', uid: BUYER, intentRef: intentRef || ref, meta: meta || {} });
  }
  /* the browser's pending order (checkout.html _ckPersistPendingOrder) */
  async function clientOrder(ref, sellerUid, total, items) {
    await db.collection('orders').doc(ref).set({ id: ref, uid: BUYER, buyerUid: BUYER, sellerUid, status: 'pending_payment', total, items });
  }
  function hook(ref, value, opt) {
    const o = opt || {};
    const invoice = { invoice_id: 'INV-' + ref, api_ref: ref, state: o.state || 'COMPLETE', provider: o.provider || 'M-PESA',
      value: value, net_amount: o.net !== undefined ? o.net : value, charges: o.charges || 0, currency: o.currency === undefined ? 'KES' : o.currency };
    if (o.dropValue) delete invoice.value;
    if (o.dropCurrency) delete invoice.currency;
    return new Promise((resolve) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, set() { return this; }, setHeader() {},
        send(b) { resolve({ code: this.statusCode, body: b }); return this; }, json(b) { resolve({ code: this.statusCode, body: b }); return this; }, end(b) { resolve({ code: this.statusCode, body: b }); return this; } };
      /* IntaSend's collection webhook body is FLAT (measured in production logs 2026-09-30): invoice_id, api_ref,
         state, value, net_amount, charges, currency, provider at the top level — no `invoice` wrapper. */
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: Object.assign({ challenge: CHALLENGE }, invoice), query: {}, get() { return undefined; } };
      quiet(() => Promise.resolve(WHMOD.webhookIntasend(req, res))).catch((e) => resolve({ code: 'THREW', body: String(e && e.message || e) }));
      setTimeout(() => resolve({ code: 'TIMEOUT' }), 60000);
    });
  }
  const items1 = [{ productId: 'b1-soda', qty: 1, price: 1 }, { productId: 'b1-cake', qty: 2, price: 1 }];   /* client prices are lies */
  const EXPECT = 390 + 2 * 250;                                                                            /* 890 */

  /* ── U: Unit 1 — the server prices and owns the seller ── */
  console.log('[U] Unit 1 — createPaymentIntent product_order');
  const m1 = await mint(items1, { orderId: 'b1-ord-1', amount: 5, sellerUid: ATTACKER });
  ok(m1.ok && m1.r.ref === 'b1-ord-1' && m1.r.amount === EXPECT, 'U-1', 'intent minted AT the order id for the CATALOGUE total (client amount 5 and client prices ignored)', m1.ok ? m1.r : m1);
  const i1 = await get('paymentIntents', 'b1-ord-1');
  ok(!!i1 && i1.metadata && i1.metadata.sellerUid === S1 && i1.amountCents === EXPECT * 100, 'U-2', 'the intent\'s seller is the product\'s seller — the browser-supplied sellerUid is ignored', i1 && i1.metadata);
  const m2 = await mint([{ productId: 'b1-soda', qty: 1, price: 99999 }], { orderId: 'b1-ord-inflate', amount: 99999 });
  ok(m2.ok && m2.r.amount === 390, 'U-3', 'an INFLATED browser price is replaced by the catalogue price', m2.ok ? m2.r.amount : m2);
  const m3 = await mint([{ productId: 'b1-soda', qty: 1 }, { productId: 'b1-other', qty: 1 }], { orderId: 'b1-ord-cross' });
  ok(!m3.ok && /multiple sellers/i.test(m3.msg || ''), 'U-4', 'a cross-seller cart is refused', m3.ok ? 'minted' : m3.msg);
  await db.collection('products').doc('b1-orphan').set({ name: 'orphan', price: 100, stock: 5, status: 'active' });   /* no seller on record */
  const m7 = await mint([{ productId: 'b1-orphan', qty: 1 }], { orderId: 'b1-ord-orphan', sellerUid: ATTACKER });
  ok(!m7.ok && /no seller on record/i.test(m7.msg || ''), 'U-7', 'a product with no seller on record is REFUSED — a browser-supplied sellerUid never fills the gap', m7.ok ? m7.r : m7.msg);
  const m4 = await mint(items1, { orderId: 'b1-ord-1' });
  ok(m4.ok && m4.r.replay === true && m4.r.amount === EXPECT, 'U-5', 'a retry replays the SAME intent (no second identity)', m4.ok ? m4.r : m4);
  await db.collection('products').doc('b1-soda').set({ price: 400 }, { merge: true });
  const m5 = await mint(items1, { orderId: 'b1-ord-1' });
  ok(!m5.ok && /cart has changed/i.test(m5.msg || ''), 'U-6', 'a re-priced replay of a quoted order FAILS CLOSED (never re-priced silently)', m5.ok ? m5.r : m5.msg);
  await db.collection('products').doc('b1-soda').set({ price: 390 }, { merge: true });

  /* ── W: Units 1+2 — the webhook settles only exact, bound evidence ── */
  console.log('\n[W] Units 1+2 — webhook settlement');
  const w0 = await wallet(S1), wa0 = await wallet(ATTACKER), s0 = await stock('b1-soda');
  await clientOrder('b1-ord-1', ATTACKER, 5, items1);                           /* the browser lies about seller + total */
  await stk('b1-ord-1', EXPECT, { orderId: 'b1-ord-1', sellerUid: ATTACKER, items: items1, category: 'product', fulfillmentType: 'pickup' });
  let h = await hook('b1-ord-1', EXPECT, { net: EXPECT - 1.81, charges: 1.8 });   /* real-world: a fee was charged */
  const pay1 = await get('payments', 'b1-ord-1'), ord1 = await get('orders', 'b1-ord-1');
  const w1 = await wallet(S1), wa1 = await wallet(ATTACKER), s1 = await stock('b1-soda');
  ok(h.code === 200 && pay1.status === 'COMPLETE' && ord1 && /paid|confirmed|processing/i.test(String(ord1.status || ord1.paymentStatus)),
    'W-1', 'exact gross (with an IntaSend fee, net < gross) → the order settles', { code: h.code, pay: pay1.status, ord: ord1 && (ord1.status || ord1.paymentStatus) });
  ok(w1 > w0 && wa1 === wa0, 'W-2', 'the SERVER seller is credited; the browser-named wallet gets nothing', { seller: w1 - w0, attacker: wa1 - wa0 });
  ok(s1 === s0 - 1, 'W-3', 'stock moves once', { before: s0, after: s1 });
  h = await hook('b1-ord-1', EXPECT, { net: EXPECT - 1.81, charges: 1.8 });
  ok(h.code === 200 && (await wallet(S1)) === w1 && (await stock('b1-soda')) === s1, 'W-4', 'a duplicate webhook has exactly one financial effect', { wallet: (await wallet(S1)) - w1, stock: await stock('b1-soda') });

  async function refused(id, label, ref, items, value, opt, payExtra) {
    const r = await mint(items, { orderId: ref });
    if (!r.ok) { ok(false, id, label + ' (fixture mint failed)', r); return; }
    const wB = await wallet(S1), sB = await stock('b1-cake');
    await clientOrder(ref, S1, r.r.amount, items);
    await stk(ref, r.r.amount, { orderId: ref, sellerUid: S1, items, category: 'product' }, payExtra && payExtra.intentRef);
    const hh = await hook(ref, value === 'EXACT' ? r.r.amount : value, opt);
    const p = (await get('payments', ref)) || {}, o = (await get('orders', ref)) || {};
    ok(hh.code === 200 && p.status !== 'COMPLETE' && (await wallet(S1)) === wB && (await stock('b1-cake')) === sB && o.status === 'pending_payment',
      id, label + ' → not paid, no credit, no stock move, order not finalised' + (p.reviewReason ? ' [' + p.reviewReason + ']' : ''),
      { code: hh.code, pay: p.status, reason: p.reviewReason, wallet: (await wallet(S1)) - wB, order: o.status });
    return p;
  }
  const cake = [{ productId: 'b1-cake', qty: 1 }];
  await refused('W-5', 'gross short by KES 0.01', 'b1-ord-cent', cake, 249.99);
  await refused('W-6', 'gross over by KES 0.40 (fractional)', 'b1-ord-frac', cake, 250.4);
  await refused('W-7', 'the old whole-shilling hole: 249.60 against 250', 'b1-ord-round', cake, 249.6);
  /* payment for ANOTHER order: this order's payment doc points at a different (cheaper) order's intent */
  await mint([{ productId: 'b1-cake', qty: 1 }], { orderId: 'b1-ord-cheap' });
  await refused('W-8', 'a payment bound to another order\'s intent', 'b1-ord-big', [{ productId: 'b1-cake', qty: 3 }], 250, {}, { intentRef: 'b1-ord-cheap' });
  await refused('W-9', 'provider evidence without a gross amount', 'b1-ord-nov', cake, 'EXACT', { dropValue: true });
  await refused('W-10', 'provider evidence without a currency', 'b1-ord-nocur', cake, 'EXACT', { dropCurrency: true });
  await refused('W-11', 'a non-KES currency', 'b1-ord-usd', cake, 'EXACT', { currency: 'USD' });
  const again = await hook('b1-ord-cent', 249.99);
  const pc = (await get('payments', 'b1-ord-cent')) || {};
  ok(again.code === 200 && pc.status === 'REVIEW', 'W-12', 'a replayed refused delivery stays REVIEW (no financial effect)', pc.status);

  /* ── G: the gate cannot read the intent → parked, never settled; a later delivery settles ── */
  console.log('\n[G] gate_error — the intent read fails');
  {
    const probe = db.collection('paymentIntents').doc('probe');
    const DocProto = Object.getPrototypeOf(probe);
    const realGet = DocProto.get;
    let failIntentRead = false;
    DocProto.get = function () {
      if (failIntentRead && typeof this.path === 'string' && this.path.indexOf('paymentIntents/') === 0) {
        return Promise.reject(Object.assign(new Error('UNAVAILABLE: simulated intent read failure'), { code: 14 }));
      }
      return realGet.apply(this, arguments);
    };
    try {
      const rG = await mint(cake, { orderId: 'b1-ord-gerr' });
      const wG = await wallet(S1), sG = await stock('b1-cake');
      await clientOrder('b1-ord-gerr', S1, rG.ok ? rG.r.amount : 0, cake);
      await stk('b1-ord-gerr', rG.ok ? rG.r.amount : 0, { orderId: 'b1-ord-gerr', sellerUid: S1, items: cake, category: 'product' });
      failIntentRead = true;
      const hg = await hook('b1-ord-gerr', rG.ok ? rG.r.amount : 0);
      failIntentRead = false;
      const pg = (await get('payments', 'b1-ord-gerr')) || {}, og = (await get('orders', 'b1-ord-gerr')) || {};
      const ledger = await get('commissionLedger', 'b1-ord-gerr');
      ok(rG.ok && hg.code === 200 && pg.status === 'REVIEW' && pg.reviewReason === 'gate_error' && !ledger &&
         (await wallet(S1)) === wG && (await stock('b1-cake')) === sG && og.status === 'pending_payment',
        'G-1', 'intent unreadable → parked REVIEW(gate_error), HTTP 200, no commission, no credit, no stock, order not finalised',
        { code: hg.code, pay: pg.status, reason: pg.reviewReason, ledger: !!ledger, wallet: (await wallet(S1)) - wG, order: og.status });
      const hg2 = await hook('b1-ord-gerr', rG.ok ? rG.r.amount : 0);
      const pg2 = (await get('payments', 'b1-ord-gerr')) || {}, og2 = (await get('orders', 'b1-ord-gerr')) || {};
      ok(hg2.code === 200 && pg2.status === 'COMPLETE' && (await wallet(S1)) > wG && (await stock('b1-cake')) === sG - 1 && og2.status !== 'pending_payment',
        'G-2', 'a later delivery with the read restored settles normally (exactly once)', { code: hg2.code, pay: pg2.status, order: og2.status });
    } finally { DocProto.get = realGet; }
  }

  /* ── S: subscription intents — ONE activation authority (stamp PAID; the reconciler activates) ── */
  console.log('\n[S] subscription intent — the webhook stamps PAID and never activates');
  {
    const idxSrc = fs.readFileSync(path.join(WH, 'index.js'), 'utf8');
    ok((idxSrc.match(/intent stamped PAID; reconciler owns activation/g) || []).length === 2 && !/subData\.paymentRef !== apiRef/.test(idxSrc) && /exports\.onPaymentIntentPaid\s*=/.test(idxSrc),
      'S-1', 'both stamp-PAID blocks present, no rival activation guard, onPaymentIntentPaid exported', null);
    const SUB = 'b1-sub-1', SUBUSER = 'b1-sub-user';
    await db.collection('paymentIntents').doc(SUB).set({ ref: SUB, purpose: 'subscription', planId: 'pro', uid: SUBUSER, amount: 500, amountCents: 50000, currency: 'KES', status: 'pending' });
    await db.collection('payments').doc(SUB).set({ ref: SUB, checkoutId: 'INV-' + SUB, phone: '254700000002', amount: 500, currency: 'KES', status: 'PENDING', uid: SUBUSER, intentRef: SUB, meta: { category: 'subscription' } });
    let hs = await hook(SUB, 500, { net: 498.2, charges: 1.8 });
    const iS = (await get('paymentIntents', SUB)) || {}, pS = (await get('payments', SUB)) || {}, subDoc = await get('subscriptions', SUBUSER);
    ok(hs.code === 200 && iS.status === 'paid' && iS.activationPending === true && iS.paidVia === 'webhookIntasend', 'S-2',
      'a paid subscription stamps its intent PAID + activationPending', { code: hs.code, status: iS.status, pending: iS.activationPending });
    ok(!subDoc && pS.status === 'COMPLETE', 'S-3', 'the webhook does NOT write the subscription itself (the reconciler is the one activator) and the product gate does not touch it', { sub: !!subDoc, pay: pS.status });
    hs = await hook(SUB, 500, { net: 498.2, charges: 1.8 });
    const iS2 = (await get('paymentIntents', SUB)) || {};
    ok(hs.code === 200 && iS2.status === 'paid' && !(await get('subscriptions', SUBUSER)), 'S-4', 'a redelivered subscription webhook changes nothing', { status: iS2.status });
  }

  /* ── CD: card-shaped confirmations — the gate is method-agnostic, the EVIDENCE decides ── */
  console.log('\n[CD] card evidence controls');
  {
    const rc = await mint(cake, { orderId: 'b1-ord-card' });
    const wc = await wallet(S1);
    await clientOrder('b1-ord-card', S1, rc.ok ? rc.r.amount : 0, cake);
    await stk('b1-ord-card', rc.ok ? rc.r.amount : 0, { orderId: 'b1-ord-card', sellerUid: S1, items: cake, category: 'product' });
    const hc = await hook('b1-ord-card', rc.ok ? rc.r.amount : 0, { net: (rc.ok ? rc.r.amount : 0) - 7.5, charges: 7.5, provider: 'CARD-PAYMENT' });
    ok(rc.ok && hc.code === 200 && ((await get('payments', 'b1-ord-card')) || {}).status === 'COMPLETE' && (await wallet(S1)) > wc,
      'CD-1', 'a card-style confirmation carrying gross value + KES settles exactly like M-PESA (method is metadata, evidence is the gate)', null);
    await refused('CD-2', 'a card-style confirmation WITHOUT value (unverified card payload shape)', 'b1-ord-card2', cake, 'EXACT', { dropValue: true, provider: 'CARD-PAYMENT' });
  }

  /* ── B: the browser alone cannot pay ── */
  console.log('\n[B] the browser alone');
  const mb = await mint(cake, { orderId: 'b1-ord-browser' });
  await clientOrder('b1-ord-browser', S1, mb.ok ? mb.r.amount : 0, cake);
  await stk('b1-ord-browser', 250, { orderId: 'b1-ord-browser', sellerUid: S1, items: cake });
  const pb = (await get('payments', 'b1-ord-browser')) || {}, ob = (await get('orders', 'b1-ord-browser')) || {};   /* null-safe: a row fails, never crashes */
  ok(pb.status === 'PENDING' && ob.status === 'pending_payment', 'B-1', 'the browser "succeeding" without provider confirmation leaves the order unpaid', { pay: pb.status, order: ob.status });

  /* ── C: Unit 4b — an intent-less payment that would FINALISE an order parks; nothing else changes ── */
  console.log('\n[C] Unit 4b — intent-less payments');
  const wC = await wallet(S1), sC = await stock('b1-cake');
  await clientOrder('b1-ord-legacy', S1, 250, cake);
  await stk('b1-ord-legacy', 250, { orderId: 'b1-ord-legacy', sellerUid: S1, items: cake, category: 'product' });
  h = await hook('b1-ord-legacy', 250);
  const pl = (await get('payments', 'b1-ord-legacy')) || {}, ol = (await get('orders', 'b1-ord-legacy')) || {};
  const lL = await get('commissionLedger', 'b1-ord-legacy');
  ok(h.code === 200 && pl.status === 'REVIEW' && pl.reviewReason === 'missing_intent' && !lL &&
     (await wallet(S1)) === wC && (await stock('b1-cake')) === sC && ol.status === 'pending_payment',
    'C-1a', 'intent-less PRODUCT payment → parked REVIEW(missing_intent), HTTP 200, no commission, no credit, no stock, order not finalised',
    { code: h.code, pay: pl.status, reason: pl.reviewReason, ledger: !!lL, credit: (await wallet(S1)) - wC, stock: (await stock('b1-cake')) - sC, order: ol.status });
  const hR = await hook('b1-ord-legacy', 250);
  const pR = (await get('payments', 'b1-ord-legacy')) || {};
  ok(hR.code === 200 && pR.status === 'REVIEW' && (await wallet(S1)) === wC, 'C-1r', 'a replayed delivery re-parks — still no credit', { code: hR.code, pay: pR.status });
  /* The rule is keyed on the EFFECT (would this finalise an order?), not the browser's label: dropping
     the category but keeping orderId must not dodge it. */
  const wX = await wallet(S1), sX = await stock('b1-cake');
  await clientOrder('b1-ord-relabel', S1, 250, cake);
  await stk('b1-ord-relabel', 250, { orderId: 'b1-ord-relabel', sellerUid: S1, items: cake, category: 'default' });
  const hX = await hook('b1-ord-relabel', 250);
  const pX = (await get('payments', 'b1-ord-relabel')) || {}, oX = (await get('orders', 'b1-ord-relabel')) || {};
  const lX = await get('commissionLedger', 'b1-ord-relabel');
  ok(hX.code === 200 && pX.status === 'REVIEW' && pX.reviewReason === 'missing_intent' && !lX &&
     (await wallet(S1)) === wX && (await stock('b1-cake')) === sX && oX.status === 'pending_payment',
    'C-2', 'relabelled (category "default") intent-less order payment → parked too, zero money effects',
    { code: hX.code, pay: pX.status, reason: pX.reviewReason, ledger: !!lX, credit: (await wallet(S1)) - wX, stock: (await stock('b1-cake')) - sX, order: oX.status });

  /* CONTROLS — every intent-less caller that finalises no order settles exactly as before 4b. Metas are
     the shapes the live callers send (census 2026-09-30, hosting b108ae3). */
  const CONTROLS = [
    ['C-3a', 'b1-ctl-sokonipay-product', { providerName: 'Shop S1', serviceDesc: 'Product inquiry: cake', category: 'product', commissionPct: 10 }, 'SokoniPay deposit labelled "product" by product.js (no orderId)'],
    ['C-3b', 'b1-ctl-booknow', { providerName: 'Pro', serviceDesc: 'Service Booking', category: 'cleaning', type: 'booking', providerId: S2 }, 'SokoniPay bookNow booking'],
    ['C-3c', 'b1-ctl-pos', { providerName: '', serviceDesc: 'POS sale', category: 'pos_checkout' }, 'pos-checkout.html'],
    ['C-3d', 'b1-ctl-food', { providerName: 'Kitchen', serviceDesc: 'Food order', category: 'food' }, 'food hub'],
  ];
  for (const [id, ref, meta, label] of CONTROLS) {
    await stk(ref, 250, meta);
    const hc = await hook(ref, 250);
    const pc = (await get('payments', ref)) || {};
    ok(hc.code === 200 && pc.status === 'COMPLETE' && !pc.reviewReason, id,
      'CONTROL intent-less ' + label + ' settles COMPLETE, never missing_intent', { code: hc.code, pay: pc.status, reason: pc.reviewReason });
  }

  /* ── K: Unit 3 — the client asks the server and never names the seller ── */
  console.log('\n[K] Unit 3 — checkout.html (static)');
  const html = fs.readFileSync(path.join(CLIENT, 'checkout.html'), 'utf8');
  /* code only — a comment that names sellerUid is not a field */
  const call = ((html.match(/_mkIntent\(\{[\s\S]*?\}\);/) || [''])[0]).replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/purpose:\s*'product_order'/.test(call) && /orderId:\s*_ordId/.test(call), 'K-1', 'checkout mints a product_order intent at the order id', call.slice(0, 120));
  ok(!!call && !/sellerUid\s*:/.test(call) && !/\bamount\s*:/.test(call), 'K-2', 'the intent request carries NO seller and NO amount', call.slice(0, 200));
  ok(/initiateSTKPush\(phone,\s*_authTotal,\s*_ordId/.test(html) && !/initiateSTKPush\(phone,\s*orderTotal,/.test(html), 'K-3', 'STK charges the SERVER total on the order identity', null);

  clearTimeout(WATCHDOG);
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { clearTimeout(WATCHDOG); console.log('\n  ✖ CRASH ' + (e && e.stack || e)); process.exit(5); });
