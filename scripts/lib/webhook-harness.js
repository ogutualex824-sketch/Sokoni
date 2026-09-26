/* webhook-harness.js — execute the REAL `webhookIntasend` from a given tree.
 *
 *   node scripts/lib/webhook-harness.js <treeRoot> <scenario>
 *
 * Loads <treeRoot>/functions/index.js in THIS (fresh) process with firebase-admin
 * replaced wholesale by the transactional fake, secrets from env, and a dead
 * emulator host as a tripwire — so nothing can reach a real project. Seeds one
 * payment scenario the way createPaymentIntent + initiateSTKPush write it, posts
 * an IntaSend callback (then the SAME callback again, as a replay), and prints
 * the resulting store as JSON on the last line of stdout.
 *
 * Used by scripts/test-creator-callback.js to diff BASE vs BRANCH behaviour.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-callback-harness';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'harness-challenge';
for (const k of ['INTASEND_PRIVATE_KEY', 'INTASEND_PUBLIC_KEY', 'INTASEND_SECRET_KEY', 'ANTHROPIC_API_KEY', 'SENDGRID_API_KEY', 'GEMINI_API_KEY']) process.env[k] = process.env[k] || 'harness-' + k.toLowerCase();
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const path = require('path');
const [, , ROOT, SCENARIO] = process.argv;
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./fake-firestore-txn');
const T0 = Date.UTC(2026, 7, 15, 9, 0, 0);
const F = makeFakeFirestore({ clock: () => T0, deterministicIds: true });
const db = F.db;
/* FAIL_INTENT_READ_AT=n: the n-th paymentIntents read (1-based) throws — used to
   make the webhook's EARLY film branch lose its intent read (read #2: #1 is the
   service-booking hold check). The suite proves which exit fired from the logs. */
const failAt = Number(process.env.FAIL_INTENT_READ_AT || 0);
let intentReads = 0;
const realCollection = db.collection;
db.collection = (c) => {
  const col = realCollection(c);
  if (c !== 'paymentIntents') return col;
  const realDoc = col.doc;
  return { ...col, doc: (id) => { const d = realDoc(id); const g = d.get; return { ...d, get: async () => { intentReads++; if (intentReads === failAt) throw new Error('simulated intent read failure'); return g(); } }; } };
};

/* Silence the handler's own logging; keep our JSON line clean. */
const out = process.stdout.write.bind(process.stdout);
const logs = [];
const grab = (...a) => { try { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 300)); } catch (_) { /* ignore */ } };
console.log = console.info = console.warn = console.error = console.debug = grab;

/* Network tripwire: any outbound HTTP from the handler is recorded, never sent. */
const outbound = [];
const realFetch = global.fetch;
global.fetch = async (u) => { outbound.push(String(u)); return { ok: false, status: 599, json: async () => ({}), text: async () => '' }; };
void realFetch;

const noop = () => ({});
const adminNs = {
  apps: [{}], initializeApp: noop, app: noop, credential: { applicationDefault: noop },
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }), setCustomUserClaims: async () => {}, verifyIdToken: async () => ({}) }),
  messaging: () => ({ send: async () => 'm', sendEachForMulticast: async () => ({ responses: [] }), sendMulticast: async () => ({ responses: [] }) }),
  storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
  database: () => ({ ref: () => ({ set: async () => {}, update: async () => {} }) }),
};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { try { require.cache[resolveIn(m)] = { id: m, filename: m, loaded: true, exports: exp }; } catch (_) { /* module absent in this tree */ } };
stub('firebase-admin', adminNs);
stub('firebase-admin/app', { initializeApp: noop, getApps: () => [{}], getApp: noop, applicationDefault: noop });
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => adminNs.auth() });
stub('firebase-admin/messaging', { getMessaging: () => adminNs.messaging() });
stub('firebase-admin/storage', { getStorage: () => adminNs.storage() });

const S = {
  filmIntentReadFails: null,
  film: {
    intent: { purpose: 'film_access', resourceType: 'film', resourceId: 'film1', uid: 'buyer1', ownerUid: 'buyer1', amount: 500, amountCents: 50000, currency: 'KES', status: 'created',
      metadata: { type: 'film_access', filmId: 'film1', creatorUid: 'creator1', accessType: 'purchase', rentalDays: null, priceCents: 50000, currency: 'KES' } },
    payment: { uid: 'buyer1', amount: 500, meta: { category: 'ppv', type: 'film_access', uid: 'buyer1' } },
  },
  marketplace: {
    intent: { purpose: 'product_order', resourceType: 'order', resourceId: 'ORD1', uid: 'buyer1', ownerUid: 'buyer1', amount: 1000, amountCents: 100000, currency: 'KES', status: 'created',
      metadata: { orderId: 'ORD1', sellerUid: 'seller1', category: 'marketplace', items: [{ productId: 'p1', qty: 1, unitPrice: 1000, sellerUid: 'seller1' }] } },
    payment: { uid: 'buyer1', amount: 1000, meta: { category: 'marketplace', sellerUid: 'seller1', orderId: 'ORD1', uid: 'buyer1' } },
    seed: { 'orders/ORD1': { orderId: 'ORD1', buyerUid: 'buyer1', sellerUid: 'seller1', status: 'pending_payment', total: 1000, items: [{ productId: 'p1', qty: 1, price: 1000, sellerUid: 'seller1' }] },
            'products/p1': { sellerUid: 'seller1', price: 1000, stock: 5, inventoryVersion: 1 } },
  },
  pos: {
    intent: { purpose: 'pos_till_sale', resourceType: 'posSale', resourceId: 'SALE1', uid: 'buyer1', ownerUid: 'buyer1', amount: 300, amountCents: 30000, currency: 'KES', status: 'created',
      metadata: { sokoniTillId: 'SK-SHOP1-0001', merchantUid: 'merchant1', shopId: 'shop1', category: 'pos' } },
    payment: { uid: 'buyer1', amount: 300, meta: { category: 'pos', uid: 'buyer1' } },
  },
  subscription: {
    intent: { purpose: 'subscription', uid: 'merchant1', ownerUid: 'merchant1', amount: 999, amountCents: 99900, currency: 'KES', status: 'created', planId: 'pro', metadata: { plan: 'pro' } },
    payment: { uid: 'merchant1', amount: 999, meta: { category: 'subscription', uid: 'merchant1' } },
  },
  topup: { ref: 'wtop_user1_1', topup: true, payment: { uid: 'user1', amount: 200 },
    /* production shape: a pending walletTransactions/{wtop_…} row, NO payments doc */
    seed: { 'walletTransactions/wtop_user1_1': { uid: 'user1', amount: 200, status: 'pending', type: 'topup', ref: 'wtop_user1_1' }, 'wallets/user1': { balance: 50 } } },
};

(async () => {
  S.filmIntentReadFails = S.film;
  const sc = S[SCENARIO];
  if (!sc) throw new Error('unknown scenario ' + SCENARIO);
  const idx = require(path.join(FN, 'index.js'));
  const hook = idx.webhookIntasend;
  if (typeof hook !== 'function') throw new Error('webhookIntasend not exported as a handler');
  const ref = sc.ref || ('REF' + SCENARIO.toUpperCase());
  for (const [p, d] of Object.entries(sc.seed || {})) await db.doc(p).set(d);
  if (sc.intent) await db.doc('paymentIntents/' + ref).set({ ref, ...sc.intent });
  if (!sc.topup) await db.doc('payments/' + ref).set({ ref, checkoutId: 'CHK' + ref, status: 'PENDING', currency: 'KES', intentRef: ref, createdAt: F.Timestamp.fromMillis(T0), ...sc.payment });
  const body = { challenge: 'harness-challenge', api_ref: ref, invoice_id: 'INV' + ref, state: 'COMPLETE',
    value: sc.payment.amount, net_amount: sc.payment.amount - 15, charges: 15, currency: 'KES' };
  const calls = [];
  for (let i = 0; i < 2; i++) {       /* original + replay */
    const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, send() { calls.push(this.statusCode); return this; }, json() { calls.push(this.statusCode); return this; }, set() { return this; }, end() { calls.push(this.statusCode); } };
    try { await hook({ method: 'POST', body: JSON.parse(JSON.stringify(body)), headers: {}, get: () => '' }, res); }
    catch (e) { calls.push('THREW:' + e.message.slice(0, 80)); }
    await new Promise((r) => setTimeout(r, 30));
  }
  /* Creator royalty step (branch trees only): what the payments trigger does next. */
  let royalty = null;
  if (SCENARIO.startsWith('film') && require('fs').existsSync(path.join(FN, 'creator-hub.js'))) {
    const H = require(path.join(FN, 'creator-hub.js'));
    H._internal._setClock(() => T0);
    await db.doc('entertainmentListings/film1').set({ creatorHub: true, creatorUid: 'creator1', pubState: 'PUBLISHED', status: 'active', title: 'F', priceCents: 50000, currency: 'KES', accessType: 'purchase' });
    await db.doc('royaltyAgreements/film1/versions/1').set({ version: 1, status: 'LOCKED', effectiveFrom: T0 - 1000, effectiveUntil: null,
      participants: [{ participantId: 'creator', participantType: 'creator', uid: 'creator1', bps: 7000 }, { participantId: 'actor', participantType: 'actor', uid: 'actor1', bps: 3000 }] });
    royalty = await H._internal.processFilmPayment(ref, { source: 'harness' });
    royalty.replay = await H._internal.processFilmPayment(ref, { source: 'harness-replay' });
  }
  const dump = {};
  for (const [p, e] of db._store) dump[p] = JSON.parse(JSON.stringify(e.data));
  out(JSON.stringify({ scenario: SCENARIO, ref, calls, outbound, royalty, intentReads, logs: logs.filter((l) => /film_access|webhookIntasend\]/.test(l)).slice(0, 40), store: dump }) + '\n');
  process.exit(0);
})().catch((e) => { out(JSON.stringify({ scenario: SCENARIO, crashed: String(e && e.stack || e).slice(0, 800) }) + '\n'); process.exit(3); });
