#!/usr/bin/env node
/* test-provider-profile-mirror.js — approval / suspension mirror onto providerProfiles only when a profile EXISTS.
 *
 *   node scripts/test-provider-profile-mirror.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-provider-profile-mirror.js  # application-lifecycle.js @ 4e9607b
 *
 * Drives the REAL applicationLifecycle trigger (SDKs stubbed; update() on a missing doc throws NOT_FOUND, as Firestore
 * does). The search sync indexes providerProfiles into the SAME object as the provider (objectID = uid), so an EMPTY
 * profile created by the mirror can overwrite a real provider record in the index with a blank one.
 *
 * PROVES
 *   M1  approving a provider who never onboarded creates NO providerProfiles doc
 *   M2  approving a provider WITH a profile sets searchable:true and keeps every existing field (control)
 *   M3  rejecting / suspending a provider with no profile creates NO providerProfiles doc
 *   M4  rejecting / suspending a provider WITH a profile sets searchable:false and keeps its content (control)
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
    async update(d) { if (!data[coll + '/' + id]) { const e = new Error('NOT_FOUND: ' + coll + '/' + id); e.code = 5; throw e; } log.push({ op: 'update', coll, id, data: d }); data[coll + '/' + id] = Object.assign({}, data[coll + '/' + id], d); },
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

const UID = 'PRO_1', ADMIN = 'ADMIN_1';
const app = (extra = {}) => ({ uid: UID, name: 'Pipe Pro', category: 'plumbing', categoryLabel: 'Plumber', hub: 'services', type: 'business',
  status: 'pending', plan: 'free', agreementAccepted: true, agreementVersion: 'v1', phone: '0712000000', location: 'Nairobi', ...extra });
async function fire(appId, a, docs) {
  ENV = makeEnv({ accounts: { [UID]: {}, [ADMIN]: { admin: true } }, docs: Object.assign({}, docs) });
  const ref = { async set(patch) { ENV.data['applications/' + appId] = Object.assign({}, ENV.data['applications/' + appId] || {}, patch); } };
  await TRIGGER({ params: { appId }, data: { before: { exists: false }, after: { exists: true, ref, data: () => a } } });
}
/* normalise first (stamps the role), then decide with the server decision record */
async function decide(appId, status, docs) {
  await fire(appId, app(), docs);
  const norm = ENV.data['applications/' + appId] || {};
  await fire(appId, Object.assign({}, app(), norm, { status, decidedBy: ADMIN }),
    Object.assign({ ['applicationDecisions/' + appId]: { status, decidedBy: ADMIN } }, docs));
  return ENV.data['providerProfiles/' + UID];
}
const PROFILE = { draft: { bio: 'Licensed plumber', pricing: { callout: 1500 } }, status: 'published', portfolio: ['a.jpg'] };

(async () => {
  loadTrigger();
  console.log('\nSOURCE: application-lifecycle.js @ ' + (CPM ? BASE + ' (before) — failures below ARE the defects' : 'working tree (fix)'));
  const m1 = await decide('app_m1', 'approved', {});
  ck('M1  approving a provider with no profile creates NO providerProfiles doc', m1 === undefined, m1);
  const m2 = await decide('app_m2', 'approved', { ['providerProfiles/' + UID]: Object.assign({}, PROFILE) });
  ck('M2  approving a provider WITH a profile: searchable:true, content kept (control)', !!m2 && m2.searchable === true && m2.draft && m2.draft.bio === 'Licensed plumber' && m2.status === 'published', m2 && { searchable: m2.searchable, bio: m2.draft && m2.draft.bio });
  const m3 = await decide('app_m3', 'rejected', { ['providers/' + UID]: { status: 'active', name: 'Pipe Pro' } });
  ck('M3  rejecting a provider with no profile creates NO providerProfiles doc', m3 === undefined, m3);
  const m4 = await decide('app_m4', 'rejected', { ['providers/' + UID]: { status: 'active', name: 'Pipe Pro' }, ['providerProfiles/' + UID]: Object.assign({}, PROFILE, { searchable: true }) });
  ck('M4  rejecting a provider WITH a profile: searchable:false, content kept (control)', !!m4 && m4.searchable === false && m4.draft && m4.draft.bio === 'Licensed plumber', m4 && { searchable: m4.searchable });
  Module.prototype.require = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (CPM) console.log('(counter-proof: M1/M3 failing ARE the defect; M2/M4 are controls and must pass in both modes)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { Module.prototype.require = orig; console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
