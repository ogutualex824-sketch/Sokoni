#!/usr/bin/env node
/**
 * SOKONI STORE — OPERATOR-ONLY authority (hermetic; no emulator, no network, no production)
 *
 * Adapted from 526f330's admin-only suite to the 2026-10-01 owner decision:
 *   · the store stays OWNED by the company account;
 *   · ONE named operator, from the server-only record firstPartyStoreOperators/{storeId};
 *   · admin / superAdmin claims alone are REFUSED with reason 'not-store-operator'.
 *
 * Drives the REAL handlers (functions/first-party-store-workspace.js `_h`), the REAL gate
 * (first-party-store-operator.js), the REAL tenant-identity resolver and the REAL
 * shop-employees.resolveShopAccess, over an in-memory Firestore that records every read.
 * firebase-admin is replaced in require.cache BEFORE any module under test loads, so no
 * code path can reach a live project.
 *
 *   node scripts/test-sokoni-first-party-store.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
};

/* ── In-memory Firestore (only what the code under test uses) ─────────────────────── */
function makeDb() {
  const store = new Map();            // "col/id" -> data
  const reads = [];                   // collection names read (doc gets + queries)
  const writes = [];                  // { op, path }
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, function (k, x) { const o = this[k]; return o instanceof Date ? { __date: o.getTime() } : x; })));
  const snapOf = (col, id) => {
    const key = col + '/' + id;
    const has = store.has(key);
    return { id, exists: has, ref: docRef(col, id), data: () => (has ? clone(store.get(key)) : undefined) };
  };
  /* FieldValue sentinels (increment / arrayUnion) applied the way Firestore applies them. */
  function applyPatch(base, patch) {
    const out = Object.assign({}, base || {});
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && typeof v === 'object' && '__inc' in v) out[k] = (Number(out[k]) || 0) + v.__inc;
      else if (v && typeof v === 'object' && '__union' in v) out[k] = (Array.isArray(out[k]) ? out[k] : []).concat(v.__union);
      else out[k] = v;
    }
    return out;
  }
  function docRef(col, id) {
    return {
      id, path: col + '/' + id,
      async get() { reads.push(col); return snapOf(col, id); },
      async create(d) {
        const key = col + '/' + id;
        if (store.has(key)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
        writes.push({ op: 'create', path: key }); store.set(key, clone(d));
      },
      async set(d, o) {
        const key = col + '/' + id; writes.push({ op: 'set', path: key });
        store.set(key, applyPatch(o && o.merge ? (store.get(key) || {}) : {}, clone(d)));
      },
      async update(d) {
        const key = col + '/' + id;
        if (!store.has(key)) { const e = new Error('NOT_FOUND'); e.code = 5; throw e; }
        writes.push({ op: 'update', path: key }); store.set(key, applyPatch(store.get(key), clone(d)));
      },
    };
  }
  function query(col, filters, order, lim) {
    return {
      where(f, op, v) { if (op !== '==') throw new Error('fake: only =='); return query(col, filters.concat([[f, v]]), order, lim); },
      orderBy(f, dir) { return query(col, filters, [f, dir], lim); },
      limit(n) { return query(col, filters, order, n); },
      async get() {
        reads.push(col);
        let docs = [];
        for (const [key, d] of store) {
          const [c, id] = key.split('/');
          if (c !== col) continue;
          if (filters.every(([f, v]) => d[f] === v)) docs.push(snapOf(c, id));
        }
        if (order) {
          const [f, dir] = order;
          const val = (s) => { const x = s.data()[f]; return x && x.__date ? x.__date : (typeof x === 'number' ? x : 0); };
          docs.sort((a, b) => (dir === 'desc' ? val(b) - val(a) : val(a) - val(b)));
        }
        if (lim != null) docs = docs.slice(0, lim);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }
  let autoId = 0;
  const db = {
    collection(col) {
      const q = query(col, [], null, null);
      return Object.assign(q, {
        doc: (id) => docRef(col, id),
        async add(d) { const id = 'auto' + (++autoId); await docRef(col, id).set(d); return docRef(col, id); },
      });
    },
    async runTransaction(fn) {
      const tx = {
        get: (ref) => ref.get(),
        update: (ref, d) => ref.update(d),
        set: (ref, d, o) => ref.set(d, o),
        create: (ref, d) => ref.create(d),
      };
      return fn(tx);
    },
    _store: store, _reads: reads, _writes: writes,
    _put(col, id, d) { store.set(col + '/' + id, clone(d)); },
    _get(col, id) { return store.get(col + '/' + id); },
  };
  return db;
}

/* ── Replace firebase-admin BEFORE anything under test loads ──────────────────────── */
let DB = makeDb();
const fnRequire = require('module').createRequire(path.join(FN, 'package.json'));
function stub(spec, exportsObj) {
  const p = fnRequire.resolve(spec);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
stub('firebase-admin', { apps: [1], initializeApp() {}, firestore: () => DB });
stub('firebase-admin/firestore', {
  getFirestore: () => DB,
  FieldValue: { serverTimestamp: () => new Date(), increment: (n) => ({ __inc: n }), arrayUnion: (...a) => ({ __union: a }), delete: () => null },
  Timestamp: { now: () => new Date(), fromMillis: (m) => new Date(m) },
});
const AUTH_USERS = {};
require.cache[path.join(FN, 'notify.js')] = { id: 'nt', filename: path.join(FN, 'notify.js'), loaded: true, exports: { notify: async () => {} } };
require.cache[path.join(FN, 'redis-rate-limiter.js')] = { id: 'rl', filename: path.join(FN, 'redis-rate-limiter.js'), loaded: true, exports: { checkRateLimit: async () => {} } };
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (uid) => { if (!AUTH_USERS[uid]) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; } return AUTH_USERS[uid]; } }) });

const OP = require(path.join(FN, 'first-party-store-operator.js'));
const WS = require(path.join(FN, 'first-party-store-workspace.js'));
const SE = require(path.join(FN, 'shop-employees.js'));
const PAY = require(path.join(FN, 'first-party-store-payout.js'));

/* ── The certified production chain, as data (ids from the owner's read, 2026-10-01) ── */
const OWNER = 'vbaSOKL4h8WWGqa6Xfi1eLaEPnS2';          /* company account — owns, does not operate */
const OPERATOR = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';       /* the named operator */
const OTHER_ADMIN = 'ochiIsaacAdminUid000000000';      /* an AdminOS admin, not the operator */
const SUPER = 'someSuperAdminUid0000000000';
const STORE = 'STR_147f5ce11b424ec4bb892519';
const BIZ = 'SOK-XX2338';

function seed(opts) {
  const o = opts || {};
  DB = makeDb();
  DB._put('shops', STORE, Object.assign({
    name: 'SOKONI Store', firstParty: true, ownerId: OWNER,
    ownerEmail: 'bravilexinternational@gmail.com', operatorEmail: 'alexochieng3030@gmail.com',
    phone: null, status: 'active',
  }, o.shop || {}));
  DB._put('businesses', BIZ, Object.assign({ ownerId: OWNER, businessType: 'SOKONI_FIRST_PARTY_STORE', status: 'active', name: 'SOKONI Store' }, o.business || {}));
  /* the operator's own, unrelated merchant life (KASS SHOP) — must never leak in */
  DB._put('shops', OPERATOR, { name: 'KASS SHOP', sellerUid: OPERATOR, ownerId: OPERATOR });
  DB._put('wallets', OPERATOR, { uid: OPERATOR, balance: 777 });
  /* an ordinary merchant */
  DB._put('shops', 'merchantShop1', { name: 'A Real Merchant', sellerUid: 'merchantUid1', ownerId: 'merchantUid1' });
  DB._put('products', 'p-store-1', { name: 'Store Mug', price: 500, shopId: STORE });
  DB._put('products', 'p-store-2', { name: 'Store Tee', price: 1200, sellerUid: BIZ, stock: 4 });
  DB._put('products', 'p-merchant', { name: 'Merchant Goods', price: 90, sellerUid: 'merchantUid1', shopId: 'merchantShop1' });
  DB._put('orders', 'o-store-1', { sellerUid: BIZ, status: 'paid', total: 500, createdAt: new Date(1000), buyerPhone: '+254700000001', items: [{}] });
  DB._put('orders', 'o-store-2', { sellerUid: BIZ, status: 'completed', total: 1200, createdAt: new Date(2000), items: [{}, {}] });
  DB._put('orders', 'o-merchant', { sellerUid: 'merchantUid1', status: 'paid', total: 90, createdAt: new Date(3000) });
  if (o.record !== null) {
    DB._put(OP.OPERATORS, STORE, Object.assign({ storeId: STORE, businessId: BIZ, ownerUid: OWNER, operatorUids: [OPERATOR] }, o.record || {}));
  }
}

const req = (uid, token, data) => (uid ? { auth: { uid, token: token || {} }, data: data || {} } : { data: data || {} });
async function refusal(fn) { try { await fn(); return null; } catch (e) { return { code: e.code, reason: e.details && e.details.reason, message: e.message }; } }

const CALLABLES = ['sokoniStoreGetContext', 'sokoniStoreSaveProfile', 'sokoniStoreListProducts', 'sokoniStoreListOrders', 'sokoniStoreGetWallet'];
const STORE_DATA_COLLECTIONS = ['products', 'orders', 'wallets', 'businessWallets', 'firstPartyStoreAudit'];

(async () => {
  console.log('SOKONI STORE — operator-only authority (hermetic)\n');

  /* ── A. the gate ─────────────────────────────────────────────────────────── */
  seed();
  let ctx = await WS._h.sokoniStoreGetContext(req(OPERATOR, {}));
  ok('A1 operator WITHOUT admin claims is served', ctx.ok === true && ctx.operator === true);
  ok('A2 context names the certified store + business', ctx.storeId === STORE && ctx.businessId === BIZ);
  ctx = await WS._h.sokoniStoreGetContext(req(OPERATOR, { admin: true, superAdmin: true }));
  ok('A3 operator WITH admin+superAdmin claims is served (claims neither help nor hurt)', ctx.ok === true);

  let r = await refusal(() => WS._h.sokoniStoreGetContext(req(OTHER_ADMIN, { admin: true })));
  ok('A4 admin-not-operator refused: permission-denied / not-store-operator', r && r.code === 'permission-denied' && r.reason === 'not-store-operator', JSON.stringify(r));
  ok('A5 refusal text is the owner\'s wording', r && /Access denied — the SOKONI Store is operated by its owner/.test(r.message));
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(SUPER, { admin: true, superAdmin: true })));
  ok('A6 superAdmin-not-operator refused: not-store-operator', r && r.code === 'permission-denied' && r.reason === 'not-store-operator');
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(null)));
  ok('A7 unauthenticated refused', r && r.code === 'unauthenticated');
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OWNER, {})));
  ok('A8 the company OWNER account is not the operator either (only the record grants)', r && r.reason === 'not-store-operator');

  /* ── B. forgeries have no effect ─────────────────────────────────────────── */
  seed();
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OTHER_ADMIN, { admin: true },
    { operatorUids: [OTHER_ADMIN], operator: true, storeId: STORE, businessId: BIZ, uid: OPERATOR })));
  ok('B1 client-sent operator fields are ignored (admin still refused)', r && r.reason === 'not-store-operator');
  seed({ shop: { operatorEmail: 'ochiisaac@gmail.com', operatorUids: [OTHER_ADMIN] } });
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OTHER_ADMIN, { admin: true, email: 'ochiisaac@gmail.com' })));
  ok('B2 operatorEmail / operatorUids ON THE SHOP DOC grant nothing', r && r.reason === 'not-store-operator');
  seed({ record: { businessId: 'SOK-OTHER' } });
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OPERATOR, {})));
  ok('B3 a STALE record (names another business) grants nothing', r && r.reason === 'not-store-operator');
  seed({ record: { operatorUids: OPERATOR } });
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OPERATOR, {})));
  ok('B4 malformed operatorUids (string, not array) grants nothing', r && r.reason === 'not-store-operator');
  seed({ record: null });
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OPERATOR, { admin: true, superAdmin: true })));
  ok('B5 no record written yet → even the intended operator is refused (fail closed)', r && r.reason === 'not-store-operator');

  /* ── C. the chain fails closed ──────────────────────────────────────────── */
  seed(); DB._put('shops', 'STR_second', { firstParty: true, ownerId: OWNER });
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OPERATOR)));
  ok('C1 two firstParty shops → refused (ambiguous), operator included', r && r.code === 'failed-precondition' && r.reason === 'store-designation-ambiguous');
  seed({ shop: { sellerUid: OPERATOR } });
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OPERATOR)));
  ok('C2 store doc carrying sellerUid → refused', r && r.reason === 'store-carries-sellerUid');
  seed({ business: { businessType: 'Electronics' } });
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OPERATOR)));
  ok('C3 business label missing → refused (label must agree with the chain)', r && r.reason === 'store-business-not-first-party');
  seed(); DB._put('businesses', 'SOK-SECOND', { ownerId: OWNER, businessType: 'SOKONI_FIRST_PARTY_STORE', status: 'active' });
  r = await refusal(() => WS._h.sokoniStoreGetContext(req(OPERATOR)));
  ok('C4 owner with two businesses → refused (ambiguous chain)', r && r.reason === 'store-owner-has-multiple-businesses');
  seed(); DB._put('businesses', 'SOK-FORGED', { ownerId: 'strangerUid', businessType: 'SOKONI_FIRST_PARTY_STORE', status: 'active' });
  ctx = await WS._h.sokoniStoreGetContext(req(OPERATOR));
  ok('C5 a stranger\'s forged SOKONI_FIRST_PARTY_STORE business does not displace the chain', ctx.businessId === BIZ);

  /* ── D. every callable refuses a non-operator BEFORE any store-data read ── */
  for (const name of CALLABLES) {
    seed();
    const before = DB._reads.length;
    const rr = await refusal(() => WS._h[name](req(OTHER_ADMIN, { admin: true, superAdmin: true }, { profile: { phone: '0700000000' } })));
    const touched = DB._reads.slice(before).filter((c) => STORE_DATA_COLLECTIONS.includes(c));
    ok(`D ${name}: admin refused, zero store-data reads, zero writes`,
      rr && rr.reason === 'not-store-operator' && touched.length === 0 && DB._writes.length === 0,
      JSON.stringify({ rr, touched, writes: DB._writes }));
  }
  ok('D6 no callable accepts a shopId/businessId/uid parameter (source)',
    !/req\.data\s*\|\|\s*\{\}\)\.(shopId|businessId|uid|storeId)|data\.(shopId|businessId|storeId)/.test(fs.readFileSync(path.join(FN, 'first-party-store-workspace.js'), 'utf8')));

  /* ── E. profile / contact phone ─────────────────────────────────────────── */
  seed();
  const sv = await WS._h.sokoniStoreSaveProfile(req(OPERATOR, {}, { profile: { phone: '0705 726 803', tagline: '<b>Official</b> SOKONI goods' } }));
  const shopAfter = DB._get('shops', STORE);
  ok('E1 operator saves the contact phone → stored E.164', sv.ok && shopAfter.phone === '+254705726803');
  ok('E2 HTML stripped by kasshop\'s own sanitiser', shopAfter.tagline === 'Official SOKONI goods');
  ok('E3 ownership untouched: ownerId, firstParty kept; NO sellerUid written', shopAfter.ownerId === OWNER && shopAfter.firstParty === true && !('sellerUid' in shopAfter));
  ok('E4 the operator\'s own KASS SHOP is untouched', DB._get('shops', OPERATOR).phone === undefined);
  ok('E5 audit row written to the server-only audit collection', [...DB._store.keys()].some((k) => k.startsWith('firstPartyStoreAudit/')));
  r = await refusal(() => WS._h.sokoniStoreSaveProfile(req(OPERATOR, {}, { profile: { phone: '12345' } })));
  ok('E6 invalid phone refused (invalid-phone)', r && r.code === 'invalid-argument' && r.reason === 'invalid-phone');
  r = await refusal(() => WS._h.sokoniStoreSaveProfile(req(OPERATOR, {}, { profile: { sellerUid: OPERATOR, ownerId: OPERATOR, firstParty: false, status: 'suspended' } })));
  ok('E7 identity/standing fields are not writable (nothing to save)', r && r.reason === 'empty-patch');
  ok('E8 …and the shop still names the company owner', DB._get('shops', STORE).ownerId === OWNER && DB._get('shops', STORE).firstParty === true);
  seed();
  r = await refusal(() => WS._h.sokoniStoreSaveProfile(req(OTHER_ADMIN, { admin: true }, { profile: { phone: '0711111111' } })));
  ok('E9 admin cannot save the store profile; phone unchanged', r && r.reason === 'not-store-operator' && DB._get('shops', STORE).phone === null);
  ok('E10 +254 / 254 / 07 / 01 forms normalise; landline refused',
    WS._internal.normalizeKePhone('+254705726803') === '+254705726803' &&
    WS._internal.normalizeKePhone('254105726803') === '+254105726803' &&
    WS._internal.normalizeKePhone('0205726803') === null);

  /* ── F. products / orders / wallet ──────────────────────────────────────── */
  seed();
  const pr = await WS._h.sokoniStoreListProducts(req(OPERATOR));
  const ids = pr.products.map((p) => p.id).sort().join(',');
  ok('F1 store products by shopId AND by business sellerUid; merchant goods excluded', ids === 'p-store-1,p-store-2', ids);
  ok('F2 absent stock is UNMETERED (null), never 0', pr.products.find((p) => p.id === 'p-store-1').stock === null && pr.products.find((p) => p.id === 'p-store-2').stock === 4);
  const or = await WS._h.sokoniStoreListOrders(req(OPERATOR));
  ok('F3 store orders = sellerUid SOK-XX2338 only, newest first', or.orders.map((o) => o.id).join(',') === 'o-store-2,o-store-1');
  ok('F4 no buyer PII in the order list', !JSON.stringify(or).includes('+254700000001'));
  const wl = await WS._h.sokoniStoreGetWallet(req(OPERATOR));
  ok('F5 store wallet = wallets/SOK-XX2338; absent → "no-sale-settled-yet", balance null (never 0)', wl.storeWallet.walletId === BIZ && wl.storeWallet.exists === false && wl.storeWallet.state === 'no-sale-settled-yet' && wl.storeWallet.balance === null);
  ok('F6 the operator\'s PERSONAL wallet is never read into the store view', !JSON.stringify(wl).includes('777'));
  ok('F7 destination "not-set" and payouts OFF by default (flag absent)', wl.payoutDestination.status === 'not-set' && wl.payoutsEnabled === false);
  seed(); DB._put('wallets', BIZ, { balance: 0 });
  const wl2 = await WS._h.sokoniStoreGetWallet(req(OPERATOR));
  ok('F8 once settlement created it, a real 0 reads as 0 (canonical zero is fine)', wl2.storeWallet.exists === true && wl2.storeWallet.balance === 0);
  ok('F9 the company-account wallet is NOT the store wallet (not read)', !DB._reads.includes('businessWallets'));

  /* ── G. no money write path in the workspace ────────────────────────────── */
  const wsSrc = fs.readFileSync(path.join(FN, 'first-party-store-workspace.js'), 'utf8');
  ok('G1 workspace never writes wallets / businessWallets / payoutRequests / destination',
    !/collection\('(wallets|businessWallets|payoutRequests)'\)[^;]*\.(set|update|create|add)\(/.test(wsSrc) && !/payoutDestination\s*:\s*\{\s*msisdn/.test(wsSrc));
  ok('G2 workspace exports no payout callable (they live in first-party-store-payout.js)', !Object.keys(WS).some((k) => /payout/i.test(k)));
  const wctx = await WS._h.sokoniStoreGetContext(req(OPERATOR));
  ok('G3 context: no destination recorded → { status:"not-set" }', JSON.stringify(wctx.payoutDestination) === '{"status":"not-set"}');
  seed({ record: { payoutDestination: { msisdn: '+254705726803' } } });
  const wctx2 = await WS._h.sokoniStoreGetContext(req(OPERATOR));
  ok('G4 …set destination renders as { status:"set", last3:"803" } and nothing more', JSON.stringify(wctx2.payoutDestination) === '{"status":"set","last3":"803"}' && !JSON.stringify(wctx2).includes('705726803') && wctx.ok);

  /* ── H. shop-employees.resolveShopAccess carve-out ──────────────────────── */
  seed();
  AUTH_USERS[OTHER_ADMIN] = { uid: OTHER_ADMIN, customClaims: { admin: true } };
  AUTH_USERS[SUPER] = { uid: SUPER, customClaims: { admin: true, superAdmin: true } };
  r = await refusal(() => SE.resolveShopAccess(OTHER_ADMIN, STORE));
  ok('H1 merchantIdentity path: admin on the store → permission-denied not-store-operator', r && r.code === 'permission-denied' && r.reason === 'not-store-operator');
  r = await refusal(() => SE.resolveShopAccess(SUPER, STORE));
  ok('H2 …superAdmin likewise', r && r.reason === 'not-store-operator');
  const opAccess = await SE.resolveShopAccess(OPERATOR, STORE);
  ok('H3 the operator resolves via:"operator"', opAccess.via === 'operator');
  const ownAccess = await SE.resolveShopAccess(OWNER, STORE);
  ok('H4 the company owner still resolves via:"owner" (ownership unchanged)', ownAccess.via === 'owner');
  const mAccess = await SE.resolveShopAccess(OTHER_ADMIN, 'merchantShop1');
  ok('H5 ordinary shops: the admin arm is unchanged', mAccess.via === 'admin');
  r = await refusal(() => SE.assertShopOwner(OPERATOR, STORE));
  ok('H6 staff management of the store stays owner-only (operator refused)', r && r.code === 'permission-denied');

  /* ── I. the one-off script (not executed against anything) ──────────────── */
  const SCRIPT = path.join(ROOT, 'scripts', 'infra', 'set-first-party-store-operator.js');
  const sSrc = fs.readFileSync(SCRIPT, 'utf8');
  const code = sSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const { operatorRecord } = require(SCRIPT);
  ok('I1 script creates NO wallet (company wallet plan withdrawn; settlement creates wallets/SOK-XX2338)', !/walletV2Shape|collection\('wallets'\)\.doc\([^)]*\)\.create|wRef\.create/.test(code));
  ok('I2 script writes exactly one thing: the operator record, with create()', (code.match(/\.create\(/g) || []).length === 1 && /recRef\.create\(/.test(code));
  ok('I3 script never uses set()/update()', !/\.(set|update)\(/.test(code));
  ok('I4 script is dry-run by default (--apply gates the write)', /const APPLY = process\.argv\.includes\('--apply'\)/.test(code) && code.indexOf('if (!APPLY)') < code.indexOf('recRef.create('));
  ok('I5 script never writes shops / businesses / claims / payout destination', !/collection\('(shops|businesses)'\)\.doc\([^)]*\)\.(create|set|update)|setCustomUserClaims|payoutDestination/.test(code));
  seed();
  const chainNow = await OP.resolveStoreChain(DB);
  ok('I6 the record the script writes is exactly what the gate accepts', OP.recordAuthorises(operatorRecord(chainNow, OPERATOR, new Date()), chainNow, OPERATOR));

  /* ── J. settlement / money code unchanged except two read-only seams ────── */
  const gitDiff = (f) => { try { return execSync('git diff a545818 -- ' + f, { cwd: ROOT }).toString(); } catch (_) { return 'git-unavailable'; } };
  ok('J1 order-settlement / settlement-engine / commission untouched vs a545818',
    ['functions/order-settlement.js', 'functions/settlement-engine.js', 'functions/commission.js'].every((f) => gitDiff(f) === ''));
  for (const f of ['functions/wallet.js', 'functions/wallet-engine.js']) {
    const body = gitDiff(f).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    const removed = body.filter((l) => l.startsWith('-'));
    const addedCode = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    /* wallet.js also carries the store-payout guard (owner decision 2026-10-01): the guard
       function itself, ONE call to it, and the seam — nothing else, nothing removed. */
    let rest = addedCode;
    const gs = rest.indexOf('async function _assertStorePayoutActor(db, request, payout, rid) {');
    if (gs >= 0) { const ge = rest.indexOf('}', gs + 1); const end = rest.slice(gs).findIndex((l, i) => i > 0 && l === '}'); rest = rest.slice(0, gs).concat(rest.slice(gs + end + 1)); void ge; }
    const expected = f === 'functions/wallet.js'
      ? ['await _assertStorePayoutActor(db, request, payout, rid);', 'exports._internal = Object.freeze({ payoutEvent: _payoutEvent, eatDay: _eatDay, getPayoutConfig: _getPayoutConfig });']
      : ['exports._internal = Object.freeze({ assertPinOk: _assertPinOk });'];
    ok(`J ${f}: additive only vs a545818 (= LIVE) — ${f.endsWith('wallet.js') ? 'store guard + one call + seam' : 'one seam'}; nothing removed`,
      removed.length === 0 && JSON.stringify(rest) === JSON.stringify(expected) && (f !== 'functions/wallet.js' || gs >= 0), JSON.stringify({ removed: removed.length, rest }));
  }
  const wSrcJ = fs.readFileSync(path.join(FN, 'wallet.js'), 'utf8');
  ok('J3 the guard call sits immediately after the payout is loaded, before every action branch',
    /const payout = reqSnap\.data\(\);\n\n  \/\*[\s\S]*?\*\/\n  await _assertStorePayoutActor\(db, request, payout, rid\);\n\n  \/\/ ── PAID/.test(wSrcJ.replace(/\r/g, '')));
  ok('J2 store orders settle where they did: order-settlement keys the credit by order.sellerUid (= SOK-XX2338)',
    /const sellerId = order\.sellerUid \|\| order\.sellerId/.test(fs.readFileSync(path.join(FN, 'order-settlement.js'), 'utf8')));

  /* ── P. operator payout (HELD behind firstPartyStoreConfig/payouts.enabled) ── */
  const crypto = require('crypto');
  const pinHash = (pin, uid) => crypto.createHash('sha256').update(String(pin + uid), 'utf8').digest('hex');
  const flagOn = () => DB._put('firstPartyStoreConfig', 'payouts', { enabled: true });
  const PHONE = '+254705726803';
  AUTH_USERS[OPERATOR] = { uid: OPERATOR, phoneNumber: PHONE };
  const withPin = () => DB._put('wallets', OPERATOR, { uid: OPERATOR, balance: 777, pinHash: pinHash('1234', OPERATOR), pinLocked: false });
  const setDest = (uid, token, data) => PAY._h.sokoniStoreSetPayoutDestination(req(uid, token, data));
  const payReq = (uid, token, data) => PAY._h.sokoniStorePayoutRequest(req(uid, token, data));
  const writesTo = (col) => DB._writes.filter((w) => w.path.startsWith(col + '/')).length;

  for (const [label, fn] of [['setDestination', setDest], ['payoutRequest', payReq]]) {
    seed(); flagOn(); withPin();
    let rr = await refusal(() => fn(OTHER_ADMIN, { admin: true, superAdmin: true }, { pin: '1234', msisdn: PHONE, amount: 500, requestId: 'req-admin-0001' }));
    ok(`P1 ${label}: admin/superAdmin (not operator) refused not-store-operator, nothing written`, rr && rr.reason === 'not-store-operator' && DB._writes.length === 0, JSON.stringify(rr));
    rr = await refusal(() => fn(null, {}, {}));
    ok(`P1b ${label}: unauthenticated refused`, rr && rr.code === 'unauthenticated');
    seed(); withPin();
    rr = await refusal(() => fn(OPERATOR, {}, { pin: '1234', msisdn: PHONE, amount: 500, requestId: 'req-flagoff-01' }));
    ok(`P2 ${label}: flag absent → store-payouts-not-enabled`, rr && rr.reason === 'store-payouts-not-enabled' && DB._writes.length === 0);
    seed(); withPin(); DB._put('firstPartyStoreConfig', 'payouts', { enabled: 'true' });
    rr = await refusal(() => fn(OPERATOR, {}, { pin: '1234', msisdn: PHONE, amount: 500, requestId: 'req-flagstr-01' }));
    ok(`P2b ${label}: flag must be boolean true ("true" string stays OFF)`, rr && rr.reason === 'store-payouts-not-enabled');
    seed(); flagOn(); DB._put('wallets', OPERATOR, { uid: OPERATOR, balance: 777, pinHash: null });
    rr = await refusal(() => fn(OPERATOR, {}, { pin: '1234', msisdn: PHONE, amount: 500, requestId: 'req-nopin-0001' }));
    ok(`P3 ${label}: operator wallet has no PIN → pin-not-set ("Set your wallet PIN first")`, rr && rr.reason === 'pin-not-set' && /Set your wallet PIN first/.test(rr.message));
    seed(); flagOn(); withPin();
    rr = await refusal(() => fn(OPERATOR, {}, { msisdn: PHONE, amount: 500, requestId: 'req-nopin-0002' }));
    ok(`P4 ${label}: PIN omitted → pin-required`, rr && rr.reason === 'pin-required');
    rr = await refusal(() => fn(OPERATOR, {}, { pin: '9999', msisdn: PHONE, amount: 500, requestId: 'req-badpin-001' }));
    ok(`P5 ${label}: wrong PIN refused (permission-denied), not routed to review`, rr && rr.code === 'permission-denied' && writesTo('payoutRequests') === 0);
    ok(`P5b ${label}: wrong PIN counted by the existing attempt counter`, !!DB._get('walletPinAttempts', OPERATOR));
  }

  seed(); flagOn(); withPin();
  let pr2 = await refusal(() => setDest(OPERATOR, {}, { pin: '1234', msisdn: '0711111111' }));
  ok('P6 destination ≠ operator\'s verified Auth phone → refused', pr2 && pr2.reason === 'destination-not-operator-verified-phone' && !(DB._get(OP.OPERATORS, STORE) || {}).payoutDestination);
  pr2 = await refusal(() => setDest(OPERATOR, { phone_number: '+254711111111' }, { pin: '1234', msisdn: '+254711111111' }));
  ok('P6b a forged token phone_number is ignored — the server reads Auth itself', pr2 && pr2.reason === 'destination-not-operator-verified-phone');
  AUTH_USERS[OPERATOR] = { uid: OPERATOR };
  pr2 = await refusal(() => setDest(OPERATOR, {}, { pin: '1234', msisdn: PHONE }));
  ok('P7 operator with no verified phone → operator-phone-not-verified', pr2 && pr2.reason === 'operator-phone-not-verified');
  AUTH_USERS[OPERATOR] = { uid: OPERATOR, phoneNumber: PHONE };
  let r0 = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 500, requestId: 'req-nodest-001', accountNumber: '0711111111' }));
  ok('P8 request before a destination is set → payout-destination-not-set (client number NOT used)', r0 && r0.reason === 'payout-destination-not-set' && writesTo('payoutRequests') === 0);
  const sd = await setDest(OPERATOR, {}, { pin: '1234', msisdn: '0705 726 803' });
  const recAfter = DB._get(OP.OPERATORS, STORE);
  ok('P9 destination = verified phone → stored server-side as E.164, response shows last 3 only',
    sd.ok && recAfter.payoutDestination.msisdn === PHONE && recAfter.payoutDestination.setBy === OPERATOR && JSON.stringify(sd).indexOf('705726803') < 0);
  ok('P9b the operator grant fields are untouched by set-destination', JSON.stringify(recAfter.operatorUids) === JSON.stringify([OPERATOR]) && recAfter.businessId === BIZ);
  const auditRows = () => [...DB._store.entries()].filter(([k]) => k.startsWith('firstPartyStoreAudit/')).map(([, v]) => v);
  ok('P9c set-destination audited: who, action, destination last 3', auditRows().some((a) => a.action === 'sokoniStore.setPayoutDestination' && a.operatorUid === OPERATOR && a.destinationLast3 === '803'));

  r0 = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 500, requestId: 'req-nowallet-1' }));
  ok('P10 no settled sale (wallets/SOK-XX2338 absent) → no-store-sale-settled-yet; wallet NOT created', r0 && r0.reason === 'no-store-sale-settled-yet' && !DB._get('wallets', BIZ));

  DB._put('wallets', BIZ, { balance: 2000, pendingPayout: 0 });
  const res1 = await payReq(OPERATOR, {}, { pin: '1234', amount: 1500, requestId: 'req-store-0001', accountNumber: '0711111111', msisdn: '0722222222', phone: '0733333333', destination: '0744444444' });
  const pdoc = DB._get('payoutRequests', 'pout_req-store-0001');
  ok('P11 request pays ONLY the stored destination (every client-sent number ignored)', pdoc && pdoc.accountNumber === PHONE);
  ok('P12 request is on wallets/SOK-XX2338 (sellerUid = business id), status pending, mode review',
    pdoc.sellerUid === BIZ && pdoc.status === 'pending' && pdoc.mode === 'review' && pdoc.method === 'mpesa' && pdoc.amount === 1500 && pdoc.netAmount === 1500 && pdoc.fee === 0);
  const wAfter = DB._get('wallets', BIZ);
  ok('P13 reserve in the same transaction: balance 2000→500, pendingPayout 0→1500', wAfter.balance === 500 && wAfter.pendingPayout === 1500);
  ok('P13b the operator\'s personal wallet balance is untouched', DB._get('wallets', OPERATOR).balance === 777);
  ok('P13c response shows destination last 3 only', res1.destinationLast3 === '803' && JSON.stringify(res1).indexOf('705726803') < 0);
  const res2 = await payReq(OPERATOR, {}, { pin: '1234', amount: 1500, requestId: 'req-store-0001' });
  ok('P14 duplicate requestId → deduplicated, no second reserve', res2.deduplicated === true && DB._get('wallets', BIZ).balance === 500 && DB._get('wallets', BIZ).pendingPayout === 1500);
  r0 = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 501, requestId: 'req-over-00001' }));
  ok('P15 over balance → insufficient-store-balance; wallet unchanged; no request doc', r0 && r0.reason === 'insufficient-store-balance' && DB._get('wallets', BIZ).balance === 500 && !DB._get('payoutRequests', 'pout_req-over-00001'));
  r0 = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 99, requestId: 'req-small-0001' }));
  const r0b = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 150.5, requestId: 'req-frac-00001' }));
  const r0c = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: -5, requestId: 'req-neg-000001' }));
  ok('P16 amount < 100, fractional or negative refused (invalid-amount)', [r0, r0b, r0c].every((x) => x && x.reason === 'invalid-amount'));
  r0 = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 100 }));
  const r0d = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 100, requestId: '../evil' }));
  ok('P16b missing / malformed requestId refused (no random-id fallback)', r0 && r0.reason === 'invalid-request-id' && r0d && r0d.reason === 'invalid-request-id');
  ok('P17 audit row for the request: who, amount, destination last 3, request id', auditRows().some((a) => a.action === 'sokoniStore.payoutRequest' && a.operatorUid === OPERATOR && a.amount === 1500 && a.destinationLast3 === '803' && a.requestId === 'pout_req-store-0001'));

  /* velocity: same cap as sellers (config/payouts.maxPayoutsPerDay, default 3) */
  seed(); flagOn(); withPin(); DB._put('wallets', BIZ, { balance: 10000, pendingPayout: 0 });
  DB._put(OP.OPERATORS, STORE, { storeId: STORE, businessId: BIZ, ownerUid: OWNER, operatorUids: [OPERATOR], payoutDestination: { msisdn: PHONE } });
  for (let i = 1; i <= 3; i++) await payReq(OPERATOR, {}, { pin: '1234', amount: 100, requestId: 'req-vel-000' + i });
  r0 = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 100, requestId: 'req-vel-0004' }));
  ok('P18 4th request in one EAT day → daily-payout-limit (the seller velocity cap)', r0 && r0.reason === 'daily-payout-limit' && DB._get('wallets', BIZ).balance === 9700);

  DB._put('wallets', BIZ, { balance: 9700, pendingPayout: 300, frozen: true });
  DB._put('payoutVelocity', BIZ, { date: 'other-day', count: 0 });
  r0 = await refusal(() => payReq(OPERATOR, {}, { pin: '1234', amount: 100, requestId: 'req-frozen-001' }));
  ok('P18b frozen store wallet → store-wallet-frozen; nothing reserved', r0 && r0.reason === 'store-wallet-frozen' && DB._get('wallets', BIZ).balance === 9700);

  /* shape: derived from wallet.js requestSellerPayout's own t.set(reqRef, {...}) */
  const wSrc = fs.readFileSync(path.join(FN, 'wallet.js'), 'utf8');
  const rsp = wSrc.slice(wSrc.indexOf('exports.requestSellerPayout'));
  const bStart = rsp.indexOf('t.set(reqRef, {');
  const block = rsp.slice(bStart, rsp.indexOf('\n    });', bStart));
  const sellerKeys = block.split('\n').map((l) => (l.match(/^\s{6}([A-Za-z0-9_]+)\s*[:,]/) || [])[1]).filter(Boolean).sort();
  const storeKeys = Object.keys(DB._get('payoutRequests', 'pout_req-vel-0001')).sort();
  ok('P19 store request == requestSellerPayout request, field for field (derived from source)', sellerKeys.length >= 15 && sellerKeys.join() === storeKeys.join(), sellerKeys.join() + ' | ' + storeKeys.join());
  const sh = DB._get('payoutRequests', 'pout_req-vel-0001').statusHistory;
  ok('P19b statusHistory built by wallet.js\'s own payoutEvent (requested → pending)', Array.isArray(sh) && sh[0].status === 'requested' && sh[1].status === 'pending' && 'at' in sh[0]);

  /* no second execution rail */
  const pSrc = fs.readFileSync(path.join(FN, 'first-party-store-payout.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('P20 payout module never calls a gateway, never marks paid, has no instant path',
    !/intasend(?!Ref)|payment-adapters|_disburseB2C|sendMoneyB2C|settlePayoutPaid|'paid'|'instant'|'approved'/i.test(pSrc));
  ok('P21 the existing admin path keys execution on payout.sellerUid (so it pays wallets/SOK-XX2338)',
    /db\.collection\('wallets'\)\.doc\(payout\.sellerUid\)/.test(wSrc) && /exports\.adminProcessPayout/.test(wSrc));
  ok('P22 the flag lives in a server-only collection and defaults OFF', PAY._internal.FLAG.collection === 'firstPartyStoreConfig' && PAY._internal.FLAG.doc === 'payouts');

  /* ── Q. adminProcessPayout: store withdrawals are actioned by the store operator ONLY ── */
  const WALLET = require(path.join(FN, 'wallet.js'));
  const apx = (uid, token, data) => WALLET.adminProcessPayout.run({ auth: { uid, token }, data, rawRequest: {} });
  const seedQ = () => {
    seed();
    DB._put('payoutRequests', 'pout_store1', { sellerUid: BIZ, amount: 500, netAmount: 500, fee: 0, method: 'mpesa', accountNumber: PHONE, status: 'pending', statusHistory: [], createdAt: new Date() });
    DB._put('payoutRequests', 'pout_store2', { sellerUid: BIZ, amount: 300, netAmount: 300, fee: 0, method: 'mpesa', accountNumber: PHONE, status: 'pending', statusHistory: [], createdAt: new Date() });
    DB._put('wallets', BIZ, { balance: 1000, pendingPayout: 800 });
    DB._put('businesses', 'merchantUid1', { ownerId: 'merchantUid1', businessType: 'Electronics', status: 'active' });   /* a legacy businesses/{uid} row */
    DB._put('payoutRequests', 'pout_m1', { sellerUid: 'merchantUid1', amount: 200, netAmount: 200, fee: 0, method: 'mpesa', accountNumber: '+254711111111', status: 'pending', statusHistory: [], createdAt: new Date() });
    DB._put('payoutRequests', 'pout_m2', { sellerUid: 'merchantUid1', amount: 100, netAmount: 100, fee: 0, method: 'mpesa', accountNumber: '+254711111111', status: 'pending', statusHistory: [], createdAt: new Date() });
    DB._put('wallets', 'merchantUid1', { balance: 0, pendingPayout: 300 });
  };
  const PAID = { status: 'paid', externalReference: 'QWE123RTY', attestation: 'Sent by M-PESA from the company till' };
  seedQ();
  for (const [label, tok, uid] of [['admin', { admin: true }, OTHER_ADMIN], ['superAdmin', { admin: true, superAdmin: true }, SUPER]]) {
    for (const [act, data] of [['approve', { status: 'approved' }], ['reject', { status: 'rejected', note: 'x' }], ['mark paid', PAID]]) {
      const before = JSON.stringify([DB._get('payoutRequests', 'pout_store1'), DB._get('wallets', BIZ)]);
      const rq = await refusal(() => apx(uid, tok, Object.assign({ requestId: 'pout_store1' }, data)));
      const after = JSON.stringify([DB._get('payoutRequests', 'pout_store1'), DB._get('wallets', BIZ)]);
      ok(`Q1 ${label} (not operator) → ${act} on a STORE request refused: permission-denied / store-payout-operator-only; request + wallet unchanged`,
        rq && rq.code === 'permission-denied' && rq.reason === 'store-payout-operator-only' && before === after, JSON.stringify(rq));
    }
  }
  const refusedAudits = [...DB._store.entries()].filter(([k, v]) => k.startsWith('firstPartyStoreAudit/') && v.action === 'sokoniStore.payoutAction.refused');
  ok('Q2 every refused action is audited (who, request, attempted status)', refusedAudits.length === 6 && refusedAudits.every(([, v]) => v.requestId === 'pout_store1' && v.adminUid && v.attemptedStatus));

  const OPTOK = { admin: true, superAdmin: true };   /* the operator's real claims */
  const ap = await apx(OPERATOR, OPTOK, { requestId: 'pout_store1', status: 'approved' }).catch((e) => ({ error: e.message }));
  ok('Q3 the store operator approves → approved for MANUAL disbursement (autoB2C off — existing behaviour, no new path)',
    ap.status === 'approved' && ap.autoB2C === false && DB._get('payoutRequests', 'pout_store1').status === 'approved');
  let rq2 = await refusal(() => apx(OPERATOR, OPTOK, { requestId: 'pout_store1', status: 'paid' }));
  ok('Q4 operator Mark Paid without externalReference + attestation → refused (existing guard holds)', rq2 && rq2.code === 'failed-precondition');
  const pd = await apx(OPERATOR, OPTOK, Object.assign({ requestId: 'pout_store1' }, PAID)).catch((e) => ({ error: e.message }));
  ok('Q5 operator Mark Paid with reference + attestation → settled_manually; hold released 800→300',
    pd.status === 'settled_manually' && DB._get('payoutRequests', 'pout_store1').status === 'settled_manually' && DB._get('wallets', BIZ).pendingPayout === 300 && DB._get('wallets', BIZ).balance === 1000);
  await apx(OPERATOR, OPTOK, Object.assign({ requestId: 'pout_store1' }, PAID)).catch(() => {});
  ok('Q6 a second Mark Paid is a no-op (idempotent settlement — hold not released twice)', DB._get('wallets', BIZ).pendingPayout === 300);
  rq2 = await refusal(() => apx(OPERATOR, OPTOK, { requestId: 'pout_store1', status: 'rejected', note: 'late' }));
  ok('Q7 rejecting a settled request is refused (existing disbursed-state guard)', rq2 && rq2.code === 'failed-precondition' && DB._get('wallets', BIZ).balance === 1000);
  const rj = await apx(OPERATOR, OPTOK, { requestId: 'pout_store2', status: 'rejected', note: 'operator cancelled' }).catch((e) => ({ error: e.message }));
  ok('Q8 operator rejects a pending store request → rejected; funds returned to wallets/SOK-XX2338',
    rj.status === 'rejected' && DB._get('wallets', BIZ).balance === 1300 && DB._get('wallets', BIZ).pendingPayout === 0);
  rq2 = await refusal(() => apx(OPERATOR, {}, { requestId: 'pout_store2', status: 'approved' }));
  ok('Q9 the operator still needs the admin claim adminProcessPayout always required (no new authority path)', rq2 && rq2.code === 'permission-denied' && rq2.reason !== 'store-payout-operator-only');

  /* ordinary requests: unchanged */
  const auditCount = () => [...DB._store.keys()].filter((k) => k.startsWith('firstPartyStoreAudit/')).length;
  const ac0 = auditCount();
  const m1 = await apx(OTHER_ADMIN, { admin: true }, { requestId: 'pout_m1', status: 'approved' }).catch((e) => ({ error: e.message }));
  ok('Q10 an ordinary admin approves an ORDINARY request exactly as before', m1.status === 'approved' && DB._get('payoutRequests', 'pout_m1').status === 'approved');
  const m2 = await apx(OTHER_ADMIN, { admin: true }, { requestId: 'pout_m2', status: 'rejected', note: 'n' }).catch((e) => ({ error: e.message }));
  ok('Q11 …and rejects one exactly as before (refund to the seller)', m2.status === 'rejected' && DB._get('wallets', 'merchantUid1').balance === 100);
  ok('Q12 ordinary actions write no store audit row', auditCount() === ac0);

  seedQ();
  DB._put('businesses', 'strangerUid', { ownerId: 'strangerUid', businessType: 'SOKONI_FIRST_PARTY_STORE', status: 'active' });
  DB._put('payoutRequests', 'pout_forged', { sellerUid: 'strangerUid', amount: 50, method: 'mpesa', accountNumber: '+254722222222', status: 'pending', statusHistory: [], createdAt: new Date() });
  DB._put('wallets', 'strangerUid', { balance: 0, pendingPayout: 50 });
  const fg = await apx(OTHER_ADMIN, { admin: true }, { requestId: 'pout_forged', status: 'approved' }).catch((e) => ({ error: e.message }));
  ok('Q13 a forged SOKONI_FIRST_PARTY_STORE label the chain does not resolve to is NOT the store (ordinary flow)', fg.status === 'approved');
  DB._put('shops', 'STR_second', { firstParty: true, ownerId: OWNER });
  rq2 = await refusal(() => apx(OPERATOR, OPTOK, { requestId: 'pout_store2', status: 'approved' }));
  ok('Q14 store request with an unresolvable chain → refused for EVERYONE, operator included (fail closed)', rq2 && rq2.reason === 'store-payout-operator-only' && DB._get('payoutRequests', 'pout_store2').status === 'pending');

  /* ── K. registration ─────────────────────────────────────────────────────── */
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  for (const n of ['sokoniStoreSetPayoutDestination', 'sokoniStorePayoutRequest']) ok(`K ${n} exported by name in index.js`, new RegExp('exports\\.' + n + '\\s*=\\s*_sokoniStorePayout\\.' + n + ';').test(idx));
  for (const n of CALLABLES) ok(`K ${n} exported by name in index.js`, new RegExp('exports\\.' + n + '\\s*=\\s*_sokoniStore\\.' + n + ';').test(idx));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a pass):', e && (e.stack || e)); process.exit(2); });
