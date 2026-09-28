#!/usr/bin/env node
/* test-category-merchant-approval.js — a business the category authority places in a merchant-v2 category is
 * APPROVED INTO A SHOP (owner, 2026-09-28: food → merchant-v2; merchant categories must land with a shop).
 *
 *   node scripts/test-category-merchant-approval.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-category-merchant-approval.js  # application-lifecycle.js @ 4e9607b
 *
 * Drives the REAL applicationLifecycle trigger (firebase-admin / firebase-functions stubbed; every write recorded),
 * in the two steps production takes:
 *   1. intake — the trigger NORMALISES a raw hub-register.js application and stamps its role (resolveRole)
 *   2. decision — the same application, approved through applicationDecide (a server applicationDecisions record +
 *      an admin decidedBy), is PROJECTED: seller → a live shop; provider → a provider record
 *
 * PROVES
 *   T1  a hub-register "Supermarket / Minimart" is stamped SELLER (by category:supermarket — its own seller category since 2026-09-28)
 *   T2  a hub-register "Restaurant / Hotel" and a "Bakery" are stamped SELLER (by category:restaurant)
 *   T3  approving the supermarket creates its LIVE SHOP (shops/{uid} active, ownerId) + activeShopId + seller claim
 *   T4  approving the restaurant creates its live shop too — merchant-v2 has something behind it
 *   T5  control: a hub-register plumber stays a PROVIDER (provider record, no shop)
 *   T6  control: a DECLARED provider intake is never overridden by its category (type:'provider', category:'supermarket')
 *   T7  control: health keywords still win ("Pharmacy / Chemist" → health)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;
const BASE = '4e9607b';

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };

const S = (kind, extra = {}) => ({ __sentinel: kind, ...extra });
const FieldValue = { serverTimestamp: () => S('ts'), arrayUnion: (...v) => S('arrayUnion', { v }), arrayRemove: (...v) => S('arrayRemove', { v }), increment: (by) => S('inc', { by }), delete: () => S('delete') };

let ENV;
function makeEnv({ accounts = {}, docs = {} } = {}) {
  const log = [];
  const data = Object.assign({}, docs);
  const put = (coll, id, d, opts) => { log.push({ op: 'set', coll, id, data: d, opts }); data[coll + '/' + id] = Object.assign({}, (opts && opts.merge) ? data[coll + '/' + id] : {}, d); };
  const mkDoc = (coll, id) => ({
    id, _coll: coll,
    async get() { const d = data[coll + '/' + id]; return { exists: !!d, id, data: () => d }; },
    async set(d, opts) { put(coll, id, d, opts); },
    async update(d) { log.push({ op: 'update', coll, id, data: d }); data[coll + '/' + id] = Object.assign({}, data[coll + '/' + id], d); },
    async delete() { log.push({ op: 'delete', coll, id }); delete data[coll + '/' + id]; },
    collection: (sub) => mkColl(coll + '/' + id + '/' + sub),
  });
  const mkColl = (coll) => ({
    doc: (id) => mkDoc(coll, id || 'gen'),
    async add(d) { log.push({ op: 'add', coll, data: d }); return { id: 'gen' }; },
    where() { return this; }, limit() { return this; }, orderBy() { return this; },
    async get() { return { docs: [], empty: true, size: 0, forEach() {} }; },
  });
  const batch = () => { const ops = []; return { set(ref, d, opts) { ops.push(() => put(ref._coll, ref.id, d, opts)); }, update(ref, d) { ops.push(() => ref.update(d)); }, delete(ref) { ops.push(() => ref.delete()); }, async commit() { ops.forEach((f) => f()); } }; };
  return {
    log, data,
    db: { collection: mkColl, batch, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), update: (r, d) => r.update(d) }) },
    auth: {
      async getUser(uid) { if (!accounts[uid]) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; } return { uid, customClaims: accounts[uid] }; },
      async setCustomUserClaims(uid, claims) { log.push({ op: 'MINT_CLAIM', uid, claims }); },
    },
  };
}

let TRIGGER = null;
const orig = Module.prototype.require;
function loadTrigger() {
  let file = path.join(FUNCTIONS_DIR, 'application-lifecycle.js');
  let tmpDir = null;
  if (CPM) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catmerch-'));
    file = path.join(tmpDir, 'application-lifecycle.js');
    fs.writeFileSync(file, cp.execFileSync('git', ['show', BASE + ':functions/application-lifecycle.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  }
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => { TRIGGER = h; return h; } };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'x' }) };
    if (id === './notify' || id === './search-terms') return { notify: async () => {}, buildSearchTerms: () => [], searchTerms: () => [] };
    /* the counterproof copy lives in a temp dir: its sibling requires resolve to the real functions/ */
    if (tmpDir && id.startsWith('./')) return orig.call(this, path.join(FUNCTIONS_DIR, id));
    return orig.apply(this, arguments);
  };
  delete require.cache[require.resolve(file)];
  require(file);
  if (!TRIGGER) throw new Error('trigger not registered');
  return TRIGGER;
}

const UID = 'BIZ_1', ADMIN = 'ADMIN_1';
const hubApp = (id, label, hub, extra = {}) => ({ uid: UID, name: 'Mama Pendo ' + label, category: id, categoryLabel: label, hub, type: 'business',
  status: 'pending', plan: 'free', agreementAccepted: true, agreementVersion: 'v1', phone: '0712000000', location: 'Nairobi', ...extra });

async function fire(appId, app) {
  const ref = { async set(patch, opts) { ENV.log.push({ op: 'set', coll: 'applications', id: appId, data: patch, opts }); ENV.data['applications/' + appId] = Object.assign({}, ENV.data['applications/' + appId] || {}, patch); } };
  await TRIGGER({ params: { appId }, data: { before: { exists: false }, after: { exists: true, ref, data: () => app } } });
}
/* step 1: intake normalisation → the stamped role */
async function intake(appId, app) {
  ENV = makeEnv({ accounts: { [UID]: {} } });
  await fire(appId, app);
  const p = ENV.log.filter((w) => w.coll === 'applications' && w.id === appId && w.data && w.data.role).pop();
  return p ? p.data : {};
}
/* step 2: the admin decision (server record + admin decidedBy) on the normalised application → projection */
async function approve(appId, app) {
  const norm = await intake(appId, app);
  const decided = Object.assign({}, app, norm, { status: 'approved', decidedBy: ADMIN });
  ENV = makeEnv({ accounts: { [UID]: {}, [ADMIN]: { admin: true } }, docs: { ['applicationDecisions/' + appId]: { status: 'approved', decidedBy: ADMIN } } });
  await fire(appId, decided);
  const claim = ENV.log.filter((w) => w.op === 'MINT_CLAIM' && w.uid === UID).pop();
  return { role: norm.role, by: norm.roleResolvedBy, shop: ENV.data['shops/' + UID], provider: ENV.data['providers/' + UID], user: ENV.data['users/' + UID] || {}, claims: claim ? claim.claims : null };
}

(async () => {
  loadTrigger();
  console.log('\nSOURCE: application-lifecycle.js @ ' + (CPM ? BASE + ' (before) — failures below ARE the defects' : 'working tree (fix)'));

  const sup = await intake('app_sup', hubApp('supermarket', 'Supermarket / Minimart', 'shopping'));
  ck('T1  "Supermarket / Minimart" is stamped SELLER by its category', sup.role === 'seller' && /category:supermarket/.test(sup.roleResolvedBy || '') /* 2026-09-28: supermarket is its own seller category (was retail_store); still SELLER by category */, { role: sup.role, by: sup.roleResolvedBy });
  const rest = await intake('app_rest', hubApp('restaurant', 'Restaurant / Hotel', 'food'));
  const bak = await intake('app_bak', hubApp('bakery', 'Bakery / Confectionery', 'food'));
  ck('T2  "Restaurant / Hotel" and "Bakery" are stamped SELLER by category:restaurant', rest.role === 'seller' && bak.role === 'seller' && /category:restaurant/.test(rest.roleResolvedBy || ''), { restaurant: rest.role + '/' + rest.roleResolvedBy, bakery: bak.role });

  const a = await approve('app_sup', hubApp('supermarket', 'Supermarket / Minimart', 'shopping'));
  ck('T3  approving the supermarket creates its LIVE SHOP + activeShopId + seller claim',
    !!a.shop && a.shop.status === 'active' && a.shop.ownerId === UID && a.user.activeShopId === UID && !!a.claims && a.claims.seller === true,
    { shop: a.shop && a.shop.status, owner: a.shop && a.shop.ownerId, active: a.user.activeShopId, seller: a.claims && a.claims.seller, provider: !!a.provider });
  const b = await approve('app_rest', hubApp('restaurant', 'Restaurant / Hotel', 'food'));
  ck('T4  approving the restaurant creates its live shop (merchant-v2 has something behind it)', !!b.shop && b.shop.status === 'active' && !!b.claims && b.claims.seller === true,
    { shop: b.shop && b.shop.status, seller: b.claims && b.claims.seller, provider: !!b.provider });

  const c = await approve('app_plumb', hubApp('plumbing', 'Plumber', 'services'));
  ck('T5  control: a hub-register plumber stays a PROVIDER (provider record, no shop)', c.role === 'provider' && !!c.provider && !c.shop, { role: c.role, provider: !!c.provider, shop: !!c.shop });
  const d = await intake('app_decl', hubApp('supermarket', 'Supermarket / Minimart', 'shopping', { type: 'provider' }));
  ck('T6  control: a DECLARED provider intake is never overridden by its category', d.role === 'provider' && d.roleResolvedBy === 'declared', { role: d.role, by: d.roleResolvedBy });
  const e = await intake('app_ph', hubApp('pharmacy', 'Pharmacy / Chemist', 'health'));
  ck('T7  control: health keywords still win ("Pharmacy / Chemist" → health)', e.role === 'health', { role: e.role, by: e.roleResolvedBy });

  Module.prototype.require = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (CPM) console.log('(counter-proof: T1–T4 failing ARE the defect; T5–T7 are controls and must pass in both modes)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { Module.prototype.require = orig; console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
