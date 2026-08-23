#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — the SALE TOTAL is the server's, and a payment is CONFIRMED before it
          is recorded as taken.
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-sale-authority.js

   WHY THIS IS A SERVER TEST AND NOT A TILL TEST
   The till can be made to show a discount and to wait for M-Pesa. None of that is
   worth anything if `posCompleteCheckout` accepts whatever total the caller sends,
   because the till is not the only caller — anything holding a signed-in session
   can reach the function. So the authority is asserted where the money is
   RECORDED, not where it is typed.

   WHY IT RUNS THE HANDLER INSTEAD OF READING IT
   A comment claiming "2. Verify payment (if M-Pesa, verify with IntaSend)" sat at
   the top of that file for a long time, above a body that did no such thing. A
   source-matching test would have passed on the strength of the comment. This
   loads the REAL functions/pos-zero-friction.js and the REAL merchant-identity
   authority against a mocked Firestore, and calls the REAL exported handler.

   BOTH HALVES ARE ASSERTED. Refusing everything is trivially "secure" and
   useless at a till, so every refusal below is paired with the permitted case:
   an owner CAN discount, a confirmed M-Pesa payment DOES complete, a failed sale
   CAN be retried.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });

/* ── A Firestore that records what the handler tried to write ──────────────── */
function makeStore() {
  const store = {
    products: {
      P1: { name: 'Sugar 2kg', price: 1000, stock: 50 },
      P2: { name: 'Rice 5kg',  price: 2000, stock: 50 },
    },
    merchants: { OWNER1: { name: 'Bravilex' } },

    /* shops/{uid} — the document id IS the owner's uid, so ownership cannot be
       forged by writing a field. */
    shops: { OWNER1: { name: 'Bravilex International Co. Limited' } },
    users: {
      OWNER1:   { name: 'Alex Ogutu' },
      CASHIER1: { name: 'Mary Wanjiku' },
      MANAGER1: { name: 'Peter Otieno' },
    },
    shopEmployees: {
      CASHIER1: { shopOwnerId: 'OWNER1', role: 'cashier', status: 'active', name: 'Mary Wanjiku' },
      MANAGER1: { shopOwnerId: 'OWNER1', role: 'manager', status: 'active', name: 'Peter Otieno' },
    },

    /* posPayments/{checkoutId} — written by darajaSTKPush, moved to 'completed'
       ONLY by darajaSTKCallback, the webhook Safaricom calls after the buyer
       enters their PIN. The client cannot write this. */
    posPayments: {
      STK_CONFIRMED: { status: 'completed', sellerUid: 'OWNER1', paidAmount: 2800,
                       mpesaCode: 'SFH4X9QK21', paidPhone: '254712000111' },
      STK_PENDING:   { status: 'pending',   sellerUid: 'OWNER1', amount: 2800 },
      STK_FAILED:    { status: 'failed',    sellerUid: 'OWNER1', amount: 2800 },
      STK_SMALL:     { status: 'completed', sellerUid: 'OWNER1', paidAmount: 10 },
    },
    posPaymentClaims: {},
    posIdempotency: {},
    coupons: {},
    writes: [],
  };

  function docApi(col, id) {
    const ref = {
      id, __col: col,
      get: async () => {
        const bag = store[col] || {};
        const has = Object.prototype.hasOwnProperty.call(bag, id);
        return { exists: has, id, ref, data: () => (has ? bag[id] : undefined) };
      },
      create: async (v) => {
        store[col] = store[col] || {};
        if (Object.prototype.hasOwnProperty.call(store[col], id)) {
          const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e;
        }
        store[col][id] = v;
      },
      set: async (v) => {
        store.writes.push({ col, id, v });
        store[col] = store[col] || {}; store[col][id] = v;
      },
      update: async (v) => {
        store.writes.push({ col, id, v, update: true });
        store[col] = store[col] || {};
        store[col][id] = Object.assign({}, store[col][id], v);
      },
      delete: async () => { if (store[col]) delete store[col][id]; },
    };
    return ref;
  }

  let autoN = 0;
  function colApi(col) {
    const q = {
      doc: (id) => docApi(col, id == null ? ('auto' + (++autoN)) : String(id)),
      add: async (v) => { store.writes.push({ col, id: null, v }); return { id: 'auto' + (++autoN) }; },
      where: () => q, orderBy: () => q, limit: () => q,
      get: async () => ({ empty: true, docs: [], size: 0 }),
    };
    return q;
  }

  const db = {
    collection: colApi,
    runTransaction: async (fn) => fn({
      get: async (ref) => ref.get(),
      set: (ref, v) => { store.writes.push({ col: ref.__col, id: ref.id, v, txn: true }); },
      update: (ref, v) => { store.writes.push({ col: ref.__col, id: ref.id, v, txn: true, update: true }); },
      create: (ref, v) => { store.writes.push({ col: ref.__col, id: ref.id, v, txn: true }); },
      delete: () => {},
    }),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }),
  };
  return { store, db };
}

/* ── Load the real modules with mocked dependencies ────────────────────────── */
function loadModule(db) {
  const https = {
    onCall: (a, b) => (typeof a === 'function' ? a : b),
    HttpsError: class HttpsError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
  };
  const mocks = {
    'firebase-functions/v2/https': https,
    'firebase-functions/v2/scheduler': { onSchedule: (a, b) => (typeof a === 'function' ? a : b) },
    'firebase-functions/v2/firestore': { onDocumentCreated: () => {}, onDocumentWritten: () => {} },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: {
        increment: (n) => ({ __increment: n }),
        serverTimestamp: () => ({ __serverTimestamp: true }),
        arrayUnion: function () { return { __arrayUnion: [].slice.call(arguments) }; },
      },
    },
    /* merchant-identity reaches Firestore through the classic admin namespace. */
    'firebase-admin': { firestore: () => db, auth: () => ({ getUser: async () => null }) },
    './pos-audit': { writeAudit: async () => {} },
  };
  const origLoad = Module._load;
  Module._load = function (req) {
    if (Object.prototype.hasOwnProperty.call(mocks, req)) return mocks[req];
    return origLoad.apply(this, arguments);
  };
  try {
    for (const f of ['pos-zero-friction.js', 'merchant-identity.js']) {
      const p = path.join(ROOT, 'functions', f);
      try { delete require.cache[require.resolve(p)]; } catch (_) {}
    }
    return require(path.join(ROOT, 'functions', 'pos-zero-friction.js'));
  } finally { Module._load = origLoad; }
}

let keyN = 0;
const cart = (over) => Object.assign({
  idempotencyKey: 'key' + (++keyN),
  merchantId: 'OWNER1',
  items: [{ productId: 'P1', qty: 1, unitPrice: 1000 }, { productId: 'P2', qty: 1, unitPrice: 2000 }],
  subtotal: 3000,
  grandTotal: 3000,
  payments: [{ method: 'cash', amount: 3000 }],
}, over || {});

async function call(fn, data, uid) {
  try { return { ok: true, res: await fn({ data, auth: { uid: uid || 'OWNER1', token: {} } }) }; }
  catch (e) { return { ok: false, err: (e && e.message) || String(e), code: e && e.code }; }
}

(async function main() {
  const { store, db } = makeStore();
  const M = loadModule(db);
  const F = M.posCompleteCheckout;

  ck('S0  the real handler loaded and is callable',
    typeof F === 'function', 'if this fails, every result below is meaningless');

  /* ══ CONTROLS — refusing everything would be trivially "secure" and useless ══ */
  const honest = await call(F, cart());
  ck('S1  CONTROL an honest 3,000 cash sale completes',
    honest.ok, honest.ok ? ('total ' + honest.res.receipt.total) : honest.err);

  const empty = await call(F, cart({ items: [] }));
  ck('S2  CONTROL the probe detects a refusal when one genuinely happens',
    !empty.ok, 'an empty cart must be refused: ' + (empty.ok ? 'IT WAS NOT' : empty.err));

  /* ══ 1. CASH — the change is the server's arithmetic ════════════════════════ */
  const mgrDisc = await call(F, cart({
    discountTotal: 200, grandTotal: 2800, payments: [{ method: 'cash', amount: 3000 }],
  }), 'MANAGER1');
  const R = mgrDisc.ok ? mgrDisc.res.receipt : null;
  ck('S3  cash: 3,000 tendered on a 2,800 sale returns 200 change',
    !!R && R.total === 2800 && R.amountPaid === 3000 && R.changeDue === 200,
    R ? ('total=' + R.total + ' paid=' + R.amountPaid + ' change=' + R.changeDue)
      : ('refused: ' + mgrDisc.err));

  ck('S4  cash: the SALE records 2,800, not the 3,000 handed over',
    !!R && R.total === 2800 && R.subtotal === 3000 && R.discount === 200,
    R ? ('subtotal=' + R.subtotal + ' discount=' + R.discount + ' total=' + R.total) : 'no receipt');

  const shortPay = await call(F, cart({ payments: [{ method: 'cash', amount: 2000 }] }));
  ck('S5  cash: a tender below the amount due cannot complete the sale',
    !shortPay.ok, shortPay.ok ? 'ACCEPTED — goods left against too little money'
                              : ('refused: ' + shortPay.err));

  const exact = await call(F, cart({ payments: [{ method: 'cash', amount: 3000 }] }));
  ck('S6  cash: paid exactly due gives zero change',
    exact.ok && exact.res.receipt.changeDue === 0,
    exact.ok ? ('change=' + exact.res.receipt.changeDue) : exact.err);

  /* ══ 2. DISCOUNT — authorised against the actor's real role ═════════════════ */
  const ownerDisc = await call(F, cart({ discountTotal: 200, grandTotal: 2800 }), 'OWNER1');
  ck('S7  discount: an OWNER may give one, and it enters the server total',
    ownerDisc.ok && ownerDisc.res.receipt.total === 2800,
    ownerDisc.ok ? ('total=' + ownerDisc.res.receipt.total) : ('refused: ' + ownerDisc.err));

  const cashierDisc = await call(F, cart({ discountTotal: 200, grandTotal: 2800 }), 'CASHIER1');
  ck('S8  discount: a CASHIER may not — the role model already says so',
    !cashierDisc.ok && cashierDisc.code === 'permission-denied',
    cashierDisc.ok ? 'ACCEPTED — any cashier could discount to zero'
                   : ('refused: ' + cashierDisc.err));

  const cashierSells = await call(F, cart(), 'CASHIER1');
  ck('S9  CONTROL a cashier can still SELL — only the discount is gated',
    cashierSells.ok, cashierSells.ok ? 'sale completed' : ('WRONGLY refused: ' + cashierSells.err));

  const stranger = await call(F, cart({ discountTotal: 200, grandTotal: 2800 }), 'NOBODY');
  ck('S10 discount: someone with no employment here cannot give one',
    !stranger.ok, stranger.ok ? 'ACCEPTED from a non-employee' : ('refused: ' + stranger.err));

  const overDisc = await call(F, cart({ discountTotal: 5000, grandTotal: 1 }), 'OWNER1');
  ck('S11 discount: cannot exceed the sale, so a total can never go negative',
    !overDisc.ok, overDisc.ok ? 'ACCEPTED a discount larger than the cart' : ('refused: ' + overDisc.err));

  const poisoned = await call(F, cart({ grandTotal: 1 }), 'OWNER1');
  ck('S12 total: a 3,000 cart cannot be recorded as a 1 shilling sale',
    !poisoned.ok, poisoned.ok ? 'ACCEPTED — revenue recorded as 1' : ('refused: ' + poisoned.err));

  /* ══ 3. M-PESA — the server's confirmation is the authority ═════════════════ */
  const noRef = await call(F, cart({
    grandTotal: 2800, discountTotal: 200, payments: [{ method: 'mpesa', amount: 2800 }],
  }), 'OWNER1');
  ck('S13 m-pesa: selecting the method does not complete the sale',
    !noRef.ok, noRef.ok ? 'ACCEPTED — "requested" was treated as "paid"' : ('refused: ' + noRef.err));

  const pending = await call(F, cart({
    grandTotal: 2800, discountTotal: 200,
    payments: [{ method: 'mpesa', amount: 2800, reference: 'STK_PENDING' }],
  }), 'OWNER1');
  ck('S14 m-pesa: a push the buyer has not answered yet does not complete',
    !pending.ok, pending.ok ? 'ACCEPTED while still pending' : ('refused: ' + pending.err));

  const failed = await call(F, cart({
    grandTotal: 2800, discountTotal: 200,
    payments: [{ method: 'mpesa', amount: 2800, reference: 'STK_FAILED' }],
  }), 'OWNER1');
  ck('S15 m-pesa: cancelled / rejected / timed out leaves the sale uncommitted',
    !failed.ok, failed.ok ? 'ACCEPTED a failed payment' : ('refused: ' + failed.err));

  const unknown = await call(F, cart({
    grandTotal: 2800, discountTotal: 200,
    payments: [{ method: 'mpesa', amount: 2800, reference: 'MADE-UP-CODE' }],
  }), 'OWNER1');
  ck('S16 m-pesa: an invented reference finds nothing and is refused',
    !unknown.ok, unknown.ok ? 'ACCEPTED an invented code' : ('refused: ' + unknown.err));

  const tooSmall = await call(F, cart({
    grandTotal: 2800, discountTotal: 200,
    payments: [{ method: 'mpesa', amount: 2800, reference: 'STK_SMALL' }],
  }), 'OWNER1');
  ck('S17 m-pesa: a confirmed 10 shillings cannot settle a 2,800 sale',
    !tooSmall.ok, tooSmall.ok ? 'ACCEPTED a short payment' : ('refused: ' + tooSmall.err));

  /* THE PERMITTED CASE — without this every refusal above proves nothing. */
  const confirmed = await call(F, cart({
    grandTotal: 2800, discountTotal: 200,
    payments: [{ method: 'mpesa', amount: 2800, reference: 'STK_CONFIRMED' }],
  }), 'OWNER1');
  ck('S18 m-pesa: a payment the SERVER confirmed does complete the sale',
    confirmed.ok, confirmed.ok ? ('total=' + confirmed.res.receipt.total) : ('WRONGLY refused: ' + confirmed.err));

  ck('S19 m-pesa: the receipt carries the real M-Pesa code, not the client\'s guess',
    confirmed.ok && confirmed.res.receipt.payments[0].mpesaCode === 'SFH4X9QK21',
    confirmed.ok ? String(confirmed.res.receipt.payments[0].mpesaCode) : 'no receipt');

  /* Replay: the strongest confirmation is worthless if its result is reusable. */
  const replay = await call(F, cart({
    grandTotal: 2800, discountTotal: 200,
    payments: [{ method: 'mpesa', amount: 2800, reference: 'STK_CONFIRMED' }],
  }), 'OWNER1');
  ck('S20 m-pesa: one confirmed payment cannot settle a SECOND sale',
    !replay.ok, replay.ok ? 'ACCEPTED — one payment, two sales' : ('refused: ' + replay.err));

  /* ══ 3b. MIXED TENDER — part M-Pesa, part cash ══════════════════════════════
     The rule that matters: the M-Pesa portion must be CONFIRMED before anything
     commits. Entering the cash half does not make the electronic half real, and
     a shop must never be able to hand over goods because the drawer part was
     keyed in while the customer's payment failed. */
  store.posPayments.MIX_4000 = { status: 'completed', sellerUid: 'OWNER1',
                                 paidAmount: 4000, mpesaCode: 'MIX4000CODE' };
  store.posPayments.MIX_PENDING = { status: 'pending', sellerUid: 'OWNER1', amount: 4000 };
  store.posPayments.MIX_FAILED = { status: 'failed', sellerUid: 'OWNER1', amount: 4000 };

  const big = (over) => cart(Object.assign({
    items: [{ productId: 'P3', qty: 1, unitPrice: 6000 }],
    subtotal: 6000, grandTotal: 6000,
  }, over || {}));
  store.products.P3 = { name: 'Gas cylinder', price: 6000, stock: 20 };

  const mix = await call(F, big({
    payments: [{ method: 'mpesa', amount: 4000, ref: 'MIX_4000' }, { method: 'cash', amount: 2000 }],
  }), 'OWNER1');
  const mixR = mix.ok ? mix.res.receipt : null;
  ck('S26 mixed: 4,000 confirmed M-Pesa + 2,000 cash completes a 6,000 sale',
    !!mixR && mixR.total === 6000 && mixR.amountPaid === 6000 && mixR.changeDue === 0,
    mixR ? ('total=' + mixR.total + ' paid=' + mixR.amountPaid + ' balance=' + mixR.changeDue)
         : ('refused: ' + mix.err));

  ck('S27 mixed: the receipt keeps BOTH tenders, not a single merged figure',
    !!mixR && mixR.payments.length === 2 &&
    mixR.payments.some((p) => p.method === 'mpesa' && p.amount === 4000) &&
    mixR.payments.some((p) => p.method === 'cash' && p.amount === 2000),
    mixR ? mixR.payments.map((p) => p.method + ':' + p.amount).join(' + ') : 'no receipt');

  const mixPending = await call(F, big({
    payments: [{ method: 'mpesa', amount: 4000, ref: 'MIX_PENDING' }, { method: 'cash', amount: 2000 }],
  }), 'OWNER1');
  ck('S28 mixed: cash entered does NOT make an unconfirmed M-Pesa half real',
    !mixPending.ok,
    mixPending.ok ? 'ACCEPTED — goods left on a payment still waiting for a PIN'
                  : ('refused: ' + mixPending.err));

  const mixFailed = await call(F, big({
    payments: [{ method: 'mpesa', amount: 4000, ref: 'MIX_FAILED' }, { method: 'cash', amount: 2000 }],
  }), 'OWNER1');
  ck('S29 mixed: if the M-Pesa half FAILS the sale does not complete',
    !mixFailed.ok, mixFailed.ok ? 'ACCEPTED with a failed electronic half'
                                : ('refused: ' + mixFailed.err));

  const mixShort = await call(F, big({
    payments: [{ method: 'mpesa', amount: 4000, ref: 'MIX_4000' }, { method: 'cash', amount: 500 }],
  }), 'OWNER1');
  ck('S30 mixed: the two halves must still COVER the total',
    !mixShort.ok, mixShort.ok ? 'ACCEPTED 4,500 against a 6,000 sale'
                              : ('refused: ' + mixShort.err));

  /* The reverse split, so the pass is not an artefact of one particular ordering. */
  store.posPayments.MIX_2000 = { status: 'completed', sellerUid: 'OWNER1',
                                 paidAmount: 2000, mpesaCode: 'MIX2000CODE' };
  const mixRev = await call(F, big({
    payments: [{ method: 'cash', amount: 4000 }, { method: 'mpesa', amount: 2000, ref: 'MIX_2000' }],
  }), 'OWNER1');
  ck('S31 mixed: 2,000 M-Pesa + 4,000 cash works too, in either order',
    mixRev.ok && mixRev.res.receipt.total === 6000,
    mixRev.ok ? ('total=' + mixRev.res.receipt.total) : ('refused: ' + mixRev.err));

  /* Overpaying the CASH half is change. Overpaying the electronic half is not,
     because nothing can be handed back through it. */
  store.posPayments.MIX_4000B = { status: 'completed', sellerUid: 'OWNER1', paidAmount: 4000 };
  const mixOver = await call(F, big({
    payments: [{ method: 'mpesa', amount: 4000, ref: 'MIX_4000B' }, { method: 'cash', amount: 2500 }],
  }), 'OWNER1');
  ck('S32 mixed: overpaying the CASH half returns change',
    mixOver.ok && mixOver.res.receipt.changeDue === 500,
    mixOver.ok ? ('change=' + mixOver.res.receipt.changeDue) : ('refused: ' + mixOver.err));

  store.posPayments.MIX_BIG = { status: 'completed', sellerUid: 'OWNER1', paidAmount: 7000 };
  const eOver = await call(F, big({
    payments: [{ method: 'mpesa', amount: 7000, ref: 'MIX_BIG' }],
  }), 'OWNER1');
  ck('S33 an M-Pesa OVERPAYMENT cannot produce change — nothing hands it back',
    !eOver.ok, eOver.ok ? ('ACCEPTED with change=' + eOver.res.receipt.changeDue +
                           ' that no drawer could pay') : ('refused: ' + eOver.err));

  /* ══ 4. A refusal must be recoverable ═══════════════════════════════════════ */
  const k = 'retrykey1';
  const bad = await call(F, cart({ idempotencyKey: k, grandTotal: 1 }), 'OWNER1');
  const good = await call(F, cart({ idempotencyKey: k }), 'OWNER1');
  ck('S21 a sale refused for a correctable reason can be corrected and retried',
    !bad.ok && good.ok,
    'first=' + (bad.ok ? 'accepted' : 'refused') + ' retry=' + (good.ok ? 'completed' : good.err));

  const burned = await call(F, cart({
    idempotencyKey: 'burn1', grandTotal: 2800, discountTotal: 200,
    payments: [{ method: 'mpesa', amount: 2800, reference: 'STK_SMALL' }],
  }), 'OWNER1');
  ck('S22 a refused sale RELEASES the payment it claimed, so money is not stranded',
    !burned.ok && !store.posPaymentClaims.STK_SMALL,
    'claim left behind = ' + (store.posPaymentClaims.STK_SMALL ? 'YES — the customer could not reuse their own money' : 'no'));

  /* ══ 5. SERVED BY — resolved by the server, never typed ═════════════════════ */
  const sb = ownerDisc.ok ? ownerDisc.res.receipt.servedBy : null;
  ck('S23 receipt: Served by / Role come from the employment record',
    !!sb && sb.name === 'Alex Ogutu' && sb.role === 'owner',
    sb ? (sb.name + ' / ' + sb.label) : 'absent');

  const mgrSb = mgrDisc.ok ? mgrDisc.res.receipt.servedBy : null;
  ck('S24 receipt: an employee is named as THEMSELVES, not as the shop owner',
    !!mgrSb && mgrSb.name === 'Peter Otieno' && mgrSb.role === 'manager',
    mgrSb ? (mgrSb.name + ' / ' + mgrSb.label) : 'absent');

  const spoof = await call(F, cart({
    servedBy: { name: 'Alex', role: 'manager', label: 'Manager' },
    metadata: { servedBy: { name: 'Alex', role: 'manager' } },
  }), 'CASHIER1');
  const spoofSb = spoof.ok ? spoof.res.receipt.servedBy : null;
  ck('S25 receipt: a cashier cannot type themselves onto it as a Manager',
    spoof.ok && !!spoofSb && spoofSb.name === 'Mary Wanjiku' && spoofSb.role === 'cashier',
    spoofSb ? (spoofSb.name + ' / ' + spoofSb.label + ' — the client sent "Alex / Manager"') : 'absent');

  const passed = rows.filter((r) => r.ok).length;
  console.log('');
  console.log('  SALE AUTHORITY — the total is the server\'s, and money must be confirmed');
  console.log('  ' + '='.repeat(70));
  console.log('');
  for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
  console.log('');
  console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
  console.log('');
  process.exit(passed === rows.length ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
