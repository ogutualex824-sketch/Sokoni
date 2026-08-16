#!/usr/bin/env node
/* orderAdvance — the IDOR fix (2D-2 security stage).
 *
 *   node scripts/test-order-advance-authority.js
 *
 * THE DEFECT
 * orderAdvance was the only authority over an order's status, it was deployed,
 * and its entire check was that the caller was signed in. Any account could name
 * any orderId and advance a stranger's order. The `accepted` stage also sets
 * status 'confirmed', which onOrderStatusChange watches to fire RIDER
 * AUTO-ASSIGNMENT — so this was not a data-integrity bug, it was a way to put a
 * real rider on the road for somebody else's order.
 *
 * FIXTURE — non-degenerate by construction:
 *     SELLER_A   owns SHOP_B and is the seller on ORDER_B
 *     SHOP_C     a shop SELLER_A does not own, with its own order ORDER_C
 *     BUYER      the buyer on ORDER_B — a party, but never an advancer
 *     RIDER      the assigned rider on ORDER_B
 *     STRANGER   a signed-in account with no relationship to anything
 *
 * The decisive assertion is not "denied" — it is that a denied request performs
 * NO WRITE: no timeline entry, no status:'confirmed', and therefore nothing for
 * rider auto-assignment to react to.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OA = require(path.join(ROOT, 'functions', 'order-advance-authority.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B   = 'SHOP_B_shop_91c';
const SHOP_C   = 'SHOP_C_shop_42x';
const BUYER    = 'BUYER_uid_11';
const RIDER    = 'RIDER_uid_22';
const STRANGER = 'STRANGER_uid_99';

const ORDER_B = { id: 'ORDER_B', sellerUid: SELLER_A, shopId: SHOP_B, buyerId: BUYER, riderId: RIDER, status: 'paid', timelineStage: 'paid' };
const ORDER_C = { id: 'ORDER_C', sellerUid: 'OTHER_SELLER', shopId: SHOP_C, buyerId: 'OTHER_BUYER', status: 'paid', timelineStage: 'paid' };

/* Shop access resolver mirroring the canonical contract: only SELLER_A owns SHOP_B. */
const shopAccess = async (uid, shopId) => {
  if (shopId === SHOP_B && uid === SELLER_A) return 'owner';
  const e = new Error('You do not have access to this shop.'); e.code = 'permission-denied'; throw e;
};

const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

(async () => {

/* ═══ A — who is this caller to this order ═══ */
console.log('\nPART A — the order names its own parties\n');
{
  ck('A1  the seller on the order is the seller',
    (await OA.resolveActor(ORDER_B, SELLER_A, {}, shopAccess)) === 'seller');
  ck('A2  the assigned rider is the rider',
    (await OA.resolveActor(ORDER_B, RIDER, {}, shopAccess)) === 'rider');
  ck('A3  the buyer is the buyer — a party, but a distinct one',
    (await OA.resolveActor(ORDER_B, BUYER, {}, shopAccess)) === 'buyer');
  ck('A4  a stranger is nobody',
    (await OA.resolveActor(ORDER_B, STRANGER, {}, shopAccess)) === null);
  ck('A5  a platform admin is an admin',
    (await OA.resolveActor(ORDER_B, STRANGER, { admin: true }, shopAccess)) === 'admin');

  /* Shop ownership counts even when the order records a different seller uid. */
  const shopOrder = { id: 'o', shopId: SHOP_B, sellerUid: 'SOME_STAFF_MEMBER', buyerId: BUYER };
  ck('A6  the shop OWNER acts on their shop\'s order',
    (await OA.resolveActor(shopOrder, SELLER_A, {}, shopAccess)) === 'seller');
  ck('A7  ...and someone who does not own that shop does not',
    (await OA.resolveActor(shopOrder, STRANGER, {}, shopAccess)) === null);
  ck('A8  SELLER_A is nobody on a SHOP_C order',
    (await OA.resolveActor(ORDER_C, SELLER_A, {}, shopAccess)) === null);

  ck('A9  the alternative seller vocabularies are all read',
    (await OA.resolveActor({ sellerId: SELLER_A }, SELLER_A, {})) === 'seller' &&
    (await OA.resolveActor({ vendorId: SELLER_A }, SELLER_A, {})) === 'seller');
  ck('A10 the alternative rider vocabularies are all read',
    (await OA.resolveActor({ driverId: RIDER }, RIDER, {})) === 'rider' &&
    (await OA.resolveActor({ riderUid: RIDER }, RIDER, {})) === 'rider' &&
    (await OA.resolveActor({ assignedRider: RIDER }, RIDER, {})) === 'rider');
  ck('A11 no uid is nobody', (await OA.resolveActor(ORDER_B, null, {})) === null);
}

/* ═══ B — may that actor set this stage ═══ */
console.log('\nPART B — a seller is not a rider\n');
{
  const may = (actor, stage) => { try { OA.assertMayAdvance(actor, stage); return true; } catch (_) { return false; } };

  ck('B1  a seller may accept', may('seller', 'accepted'));
  ck('B2  a seller may prepare and mark ready', may('seller', 'preparing') && may('seller', 'ready'));
  ck('B3  a seller may NOT mark delivered', !may('seller', 'delivered'));
  ck('B4  a seller may NOT mark picked up', !may('seller', 'picked_up'));
  ck('B5  a rider may pick up and deliver', may('rider', 'picked_up') && may('rider', 'delivered'));
  ck('B6  a rider may NOT accept the order on the seller\'s behalf', !may('rider', 'accepted'));
  ck('B7  a buyer may do NOTHING', ['accepted','preparing','ready','picked_up','delivered','completed']
    .every((s) => !may('buyer', s)));
  ck('B8  nobody may set `paid` — payment is the payment authority\'s word',
    !may('seller', 'paid') && !may('rider', 'paid') && !may('buyer', 'paid'));
  ck('B9  nobody may self-assign a rider', !may('seller', 'assigned') && !may('rider', 'assigned'));
  ck('B10 an admin may set any known stage',
    Object.keys(OA.STAGE_ACTORS).every((s) => may('admin', s)));
  ck('B11 an unknown stage is refused for everyone',
    !may('admin', 'teleported') && !may('seller', 'teleported'));
  ck('B12 a null actor is refused', !may(null, 'accepted'));
}

/* ═══ C — the four regression cases named in the fix ═══ */
console.log('\nPART C — the four cases\n');
{
  const advance = async (uid, order, stage, claims) =>
    err(OA.authorise({ order, uid, claims: claims || {}, stage, shopAccess }));

  ck('C1  SELLER_A on SHOP_B\'s order MAY advance it',
    (await advance(SELLER_A, ORDER_B, 'accepted')) === null);
  const c2 = await advance(SELLER_A, ORDER_C, 'accepted');
  ck('C2  SELLER_A on SHOP_C\'s order is DENIED', c2 && c2.code === 'permission-denied', c2 && c2.code);
  const c3 = await advance(BUYER, ORDER_B, 'accepted');
  ck('C3  the buyer — a real party — is DENIED', c3 && c3.code === 'permission-denied');
  const c4 = await advance(STRANGER, ORDER_B, 'accepted');
  ck('C4  an unrelated signed-in account is DENIED', c4 && c4.code === 'permission-denied');
  const c5 = await advance(null, ORDER_B, 'accepted');
  ck('C5  no uid at all is DENIED', c5 && c5.code === 'permission-denied');

  ck('C6  the refusal does not disclose which party the caller was mistaken for',
    c4 && !/buyer|seller|rider/i.test(c4.message), c4 && c4.message);
}

/* ═══ D — the decisive one: a denial writes NOTHING ═══ */
console.log('\nPART D — a denied request cannot confirm, and cannot dispatch\n');
{
  /* The real callable, captured as it registers, against a stubbed Firestore that
     records every write. Proving "denied" is not enough — the question is whether
     the order document moved. */
  const Module = require('module');
  const writes = [];
  const orders = { ORDER_B: Object.assign({}, ORDER_B), ORDER_C: Object.assign({}, ORDER_C) };

  /* The stub must cover everything the AUTHORISED path touches downstream —
     notify() writes a delivery log with .create(). An incomplete stub made the
     positive control fail on plumbing while the security assertions passed,
     which reads as "the fix broke the feature" when it had not. */
  const stubDb = {
    collection: (c) => ({
      doc: (id) => ({
        id,
        async get() { return { exists: !!orders[id], id, data: () => orders[id] }; },
        async update(patch) { writes.push({ coll: c, id, patch }); Object.assign(orders[id] || {}, patch); },
        async set(doc) { writes.push({ coll: c, id, doc }); },
        async create(doc) { writes.push({ coll: c, id, doc, op: 'create' }); },
        async delete() { writes.push({ coll: c, id, op: 'delete' }); },
      }),
      async add(doc) { writes.push({ coll: c, doc, op: 'add' }); return { id: 'gen' }; },
      where() { return { where() { return this; }, limit() { return this; },
        get: async () => ({ empty: true, size: 0, docs: [], forEach() {} }) }; },
    }),
  };

  let captured = null;
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin') {
      return { firestore: Object.assign(() => stubDb, {
        FieldValue: { serverTimestamp: () => ({ __s: 'ts' }), arrayUnion: (v) => ({ __s: 'arr', v }) },
      }), apps: [{}], initializeApp() {}, messaging: () => ({ sendEachForMulticast: async () => ({ responses: [] }) }) };
    }
    if (id === 'firebase-functions/v2/https') {
      /* onRequest and onCall are both needed: notify.js is loaded together with
         the modules it pulls in, and a missing export takes the whole load down
         — which is how PART D first "skipped" while looking like a green run. */
      return { onCall: (_o, h) => { captured = h; return h; },
        onRequest: (_o, h) => (h || _o),
        HttpsError: class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } } };
    }
    if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => (h || _o) };
    if (id === 'firebase-functions/v2/firestore') {
      return { onDocumentCreated: (_o, h) => (h || _o), onDocumentUpdated: (_o, h) => (h || _o),
        onDocumentWritten: (_o, h) => (h || _o), onDocumentDeleted: (_o, h) => (h || _o) };
    }
    /* notify.js pulls in sokoni-at, which declares both secrets and STRING
       params. A stub missing defineString made the whole module fail to load and
       PART D — the decisive part — silently skip. */
    if (id === 'firebase-functions/params') {
      const param = (name, opts) => ({ name, value: () => (opts && opts.default) || '' });
      return { defineSecret: param, defineString: param, defineInt: param, defineBoolean: param };
    }
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
    if (id === './shop-employees') return { assertShopAccess: shopAccess };
    return orig.apply(this, arguments);
  };

  let loaded = true;
  try {
    const f = path.join(ROOT, 'functions', 'notify.js');
    delete require.cache[require.resolve(f)];
    require(f);
  } catch (e) {
    loaded = false;
    console.log('  NOTE  notify.js could not be loaded in isolation (' + String(e.message).slice(0, 70) + ')');
  } finally { Module.prototype.require = orig; }

  if (loaded && captured) {
    const call = (uid, data) => captured({ auth: uid ? { uid, token: {} } : null, data });

    writes.length = 0;
    const denied = await err(call(STRANGER, { orderId: 'ORDER_B', stage: 'accepted' }));
    ck('D1  a stranger advancing a real order is DENIED', denied && denied.code === 'permission-denied');
    ck('D2  ...and NOTHING was written', writes.length === 0, JSON.stringify(writes).slice(0, 100));
    ck('D3  ...the order status is untouched', orders.ORDER_B.status === 'paid');
    ck('D4  ...it never became `confirmed`, so rider auto-assignment cannot fire',
      orders.ORDER_B.status !== 'confirmed' && orders.ORDER_B.confirmedAt === undefined);
    ck('D5  ...and no timeline entry was added', orders.ORDER_B.timelineStage === 'paid');

    writes.length = 0;
    const crossShop = await err(call(SELLER_A, { orderId: 'ORDER_C', stage: 'accepted' }));
    ck('D6  SELLER_A advancing a SHOP_C order is DENIED', crossShop && crossShop.code === 'permission-denied');
    ck('D7  ...and SHOP_C\'s order is untouched',
      writes.length === 0 && orders.ORDER_C.status === 'paid');

    writes.length = 0;
    const buyer = await err(call(BUYER, { orderId: 'ORDER_B', stage: 'accepted' }));
    ck('D8  the buyer is DENIED and writes nothing', buyer && buyer.code === 'permission-denied' && writes.length === 0);

    writes.length = 0;
    const anon = await err(call(null, { orderId: 'ORDER_B', stage: 'accepted' }));
    ck('D9  an unauthenticated caller is DENIED and writes nothing',
      anon && anon.code === 'unauthenticated' && writes.length === 0);

    writes.length = 0;
    const wrongStage = await err(call(SELLER_A, { orderId: 'ORDER_B', stage: 'delivered' }));
    ck('D10 the seller marking DELIVERED is denied — that is the rider\'s stage',
      wrongStage && wrongStage.code === 'permission-denied' && writes.length === 0);

    writes.length = 0;
    const missing = await err(call(SELLER_A, { orderId: 'NO_SUCH_ORDER', stage: 'accepted' }));
    ck('D11 an unknown order is not-found, and writes nothing',
      missing && missing.code === 'not-found' && writes.length === 0);

    /* The positive control: the authorised path must still work, or the fix has
       simply broken the feature. */
    writes.length = 0;
    const ok = await err(call(SELLER_A, { orderId: 'ORDER_B', stage: 'accepted' }));
    ck('D12 the ORDER\'S OWN SELLER may still advance it', ok === null, ok && ok.message);
    ck('D13 ...and that DOES write the confirmed transition',
      writes.some((w) => w.patch && w.patch.status === 'confirmed'), JSON.stringify(writes).slice(0, 120));
  } else {
    console.log('  SKIP  the callable could not be captured in this environment — PART D is UNVERIFIED here.');
    console.log('        PARTS A-C still prove the authority module itself. Do not read a skip as a pass.');
    fail++; /* a skipped decisive part must not report green */
  }
}

/* ═══ E — the boundary is in the callable, not the primitive ═══ */
console.log('\nPART E — the trusted primitive is unchanged\n');
{
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'notify.js'), 'utf8');
  const callable = src.slice(src.indexOf('exports.orderAdvance'));
  ck('E1  the callable authorises BEFORE advanceOrder is reached',
    callable.indexOf('_orderAuth.authorise') < callable.indexOf('return advanceOrder'),
    'authorise at ' + callable.indexOf('_orderAuth.authorise') + ', advance at ' + callable.indexOf('return advanceOrder'));
  ck('E2  the callable reads the order to decide, rather than trusting the request',
    /collection\('orders'\)\.doc\(String\(orderId\)\)/.test(callable));
  ck('E3  advanceOrder() itself is untouched — it is the trusted internal path',
    /async function advanceOrder\(\{ orderId, stage, uid, phone/.test(src));
  ck('E4  the old "signed in is enough" check is gone',
    !/if \(!\(request\.auth && request\.auth\.uid\)\) throw new HttpsError\('unauthenticated', 'Sign in required\.'\);\s*\n\s*return advanceOrder/.test(src));

  /* Mutation control: removing the authorise call must let the stranger through. */
  ck('E5  the authorise call is a real line that can be removed (control)',
    callable.replace(/await _orderAuth\.authorise\(\{[\s\S]*?\}\);/, '') !== callable);
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
