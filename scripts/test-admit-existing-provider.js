#!/usr/bin/env node
'use strict';
/* applicationAdmitExistingProvider (owner 2026-10-03): an ADMIN approves an already-live provider/seller that has no
   application, writing the application + decision record the ONE approval authority reads. Runs the REAL handler on an
   in-memory store (transactions with reads-before-writes and create()), then asks the REAL isAuthoritativelyApproved. */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const data = {}; let seq = 0;
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const snapOf = (p) => ({ exists: p in data, id: p.split('/').pop(), data: () => clone(data[p]) });
function ref(p) { return { _p: p, id: p.split('/').pop(), get: async () => snapOf(p), set: async (v, o) => { data[p] = Object.assign({}, o && o.merge ? data[p] : {}, v); }, collection: (c) => col(p + '/' + c) }; }
function col(c, filters = [], lim = null) {
  return { doc: (id) => ref(c + '/' + (id || ('auto' + (++seq)))), add: async (v) => { const r = ref(c + '/auto' + (++seq)); await r.set(v); return r; },
    where: (f, op, v) => col(c, filters.concat([[f, op, v]]), lim), limit: (n) => col(c, filters, n), _q: true,
    get: async () => { let ds = Object.keys(data).filter((p) => p.startsWith(c + '/') && p.split('/').length === c.split('/').length + 1);
      for (const [f, op, v] of filters) ds = ds.filter((p) => (op === '==' ? data[p][f] === v : op === 'in' ? v.includes(data[p][f]) : false));
      if (lim != null) ds = ds.slice(0, lim); const docs = ds.map(snapOf); return { empty: !docs.length, size: docs.length, docs }; } };
}
let TXN_FAIL_AFTER_WRITES = false;
const db = { collection: (c) => col(c), doc: ref,
  runTransaction: async (fn) => { const w = []; let wrote = false;
    const t = { get: async (x) => { if (wrote) throw new Error('reads after writes'); return x.get(); },
      create: (x, v) => { wrote = true; w.push(() => { if (x._p in data) throw Object.assign(new Error('ALREADY_EXISTS ' + x._p), { code: 6 }); data[x._p] = clone(v); }); },
      set: (x, v, o) => { wrote = true; w.push(() => { data[x._p] = Object.assign({}, o && o.merge ? data[x._p] : {}, clone(v)); }); },
      update: (x, v) => { wrote = true; w.push(() => { data[x._p] = Object.assign({}, data[x._p], clone(v)); }); } };
    const r = await fn(t); if (TXN_FAIL_AFTER_WRITES) throw new Error('txn aborted'); for (const f of w) f(); return r; } };
const FieldValue = { serverTimestamp: () => 'TS', delete: () => ({ __op: 'delete' }), arrayUnion: (...v) => v, arrayRemove: () => [], increment: (n) => n };
const CLAIMS = { admin1: { admin: true }, admin2: { superAdmin: true } };
const auth = { getUser: async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} }), setCustomUserClaims: async () => {} };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue };
  if (id === 'firebase-admin/auth') return { getAuth: () => auth };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
  if (id === './search-terms') return { buildSearchTerms: () => [] };
  if (id === './business-bootstrap') return { _ensureBusinessForOwner: async () => ({}) };
  if (id === './notify') return { notify: async () => ({}) };
  return orig.apply(this, arguments);
};
const L = require(path.join(ROOT, 'functions', 'application-lifecycle.js'));
const AUTH = require(path.join(ROOT, 'functions', 'shared', 'approval-authority.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '   [' + JSON.stringify(d).slice(0, 200) + ']')); ok ? pass++ : fail++; };
const MFA = { firebase: { sign_in_second_factor: 'totp' } };
const as = (uid, token, d) => ({ auth: { uid, token: Object.assign({}, token, MFA) }, data: d });
const call = async (r) => { try { return await L.applicationAdmitExistingProvider(r); } catch (e) { return { err: e.code, reason: e.details && (e.details.reason || e.details.code) }; } };
const reset = () => { for (const k of Object.keys(data)) delete data[k]; };
const seedProv = (uid, x) => { data['providers/' + uid] = Object.assign({ uid, status: 'active', name: 'Shave n Trims', category: 'hair-beauty', providerId: 'PRV-1' }, x || {}); };
const AD = { uid: 'u_barber1', role: 'provider', category: 'salon', reason: 'Live barber onboarded by script; owner approved 2026-10-03' };
const isAdmin = async (u) => !!(CLAIMS[u] && (CLAIMS[u].admin || CLAIMS[u].superAdmin));

(async () => {
  if (typeof L.applicationAdmitExistingProvider !== 'function') { console.log('  FAIL  LOAD applicationAdmitExistingProvider is not exported\n\nRESULT: 0 passed, 1 failed'); process.exit(1); }
  reset(); seedProv('u_barber1');
  let before = await AUTH.isAuthoritativelyApproved(db, 'ADM_u_barber1', { isAdmin });
  let r = await call(as('admin1', { admin: true }, AD));
  const app = data['applications/ADM_u_barber1'] || {}, dec = data['applicationDecisions/ADM_u_barber1'] || {}, prof = data['providerProfiles/u_barber1'];
  const aud = Object.values(data).find((v) => v && v.action === 'application_admit_existing');
  let after = await AUTH.isAuthoritativelyApproved(db, 'ADM_u_barber1', { isAdmin });
  ck('E-1 an admin admits a live provider with no application: application + decision record + audit; the ONE authority now says APPROVED',
    r.ok && !r.replay && !before.approved && after.approved && app.status === 'approved' && app.uid === 'u_barber1' && app.category === 'salon' && dec.decidedBy === 'admin1' && dec.applicantUid === 'u_barber1' && aud && aud.before.application === null,
    { r, before: before.reason, after: after.reason, app, dec });
  ck('E-2 providerProfiles is provisioned from the SERVER providers record when absent (provider-dashboard can load)', prof && prof.name === 'Shave n Trims' && prof.providerId === 'PRV-1' && prof.provisionedBy === 'admin_existing_provider' && r.providerProfileProvisioned === true, prof);
  ck('E-3 status / discoverability are NOT changed', data['providers/u_barber1'].status === 'active' && !('searchable' in data['providers/u_barber1']), data['providers/u_barber1']);
  const n = Object.keys(data).length; r = await call(as('admin2', { superAdmin: true }, AD));
  ck('E-4 idempotent: a second call (another admin) changes NOTHING', r.ok && r.replay === true && Object.keys(data).length === n && (data['applicationDecisions/ADM_u_barber1'] || {}).decidedBy === 'admin1', r);

  reset(); seedProv('u_dj0001', { name: 'DJ Bambi', category: 'dj' }); data['providerProfiles/u_dj0001'] = { uid: 'u_dj0001', name: 'DJ Bambi (own profile)', rating: 4.8 };
  r = await call(as('admin1', { admin: true }, { uid: 'u_dj0001', role: 'provider', category: 'artist_creator', reason: 'Trading DJ with live bookings; owner approved' }));
  ck('E-5 an EXISTING providerProfiles is never overwritten (DJ Bambi)', r.ok && r.providerProfileProvisioned === false && data['providerProfiles/u_dj0001'].name === 'DJ Bambi (own profile)' && data['providerProfiles/u_dj0001'].rating === 4.8, data['providerProfiles/u_dj0001']);

  reset(); seedProv('admin1');
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'admin1' })));
  ck('E-6 an administrator can NEVER admit their own business (separation of duties)', r.err === 'permission-denied' && r.reason === 'SELF_DECISION' && !data['applications/ADM_admin1'], r);
  reset(); seedProv('u_barber1');
  r = await call({ auth: { uid: 'u_x', token: Object.assign({}, MFA) }, data: AD });
  ck('E-7 a non-admin (incl. the provider) is refused', r.err === 'permission-denied' && !data['applications/ADM_u_barber1'], r);
  r = await call({ auth: { uid: 'admin1', token: { admin: true } }, data: AD });
  ck('E-8 an admin WITHOUT a satisfied second factor is refused', r.err === 'unauthenticated' && r.reason === 'MFA_REQUIRED' && !data['applications/ADM_u_barber1'], r);
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { reason: 'ok' })));
  ck('E-9 a reason is required', r.err === 'invalid-argument' && r.reason === 'REASON_REQUIRED', r);
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { category: '' })));
  ck('E-10 a category is required', r.err === 'invalid-argument' && r.reason === 'CATEGORY_REQUIRED', r);

  reset(); seedProv('u_p0002', { status: 'suspended' });
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_p0002' })));
  ck('E-11 a suspended / not-live record cannot be admitted this way', r.err === 'failed-precondition' && r.reason === 'NOT_LIVE' && !data['applications/ADM_u_p0002'], r);
  reset(); r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_none1' })));
  ck('E-12 no provider record → not-found (this op never creates a provider)', r.err === 'not-found' && r.reason === 'NO_RECORD' && Object.keys(data).length === 0, r);
  reset(); seedProv('u_p0003'); data['applications/realApp1'] = { uid: 'u_p0003', status: 'pending' };
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_p0003' })));
  ck('E-13 an account that HAS an application is refused (decide it in Applications) — existing applications are never touched', r.err === 'failed-precondition' && r.reason === 'HAS_APPLICATION' && data['applications/realApp1'].status === 'pending' && !data['applications/ADM_u_p0003'], r);

  reset(); data['sellers/u_shop1'] = { uid: 'u_shop1', status: 'active', name: 'Maina Groceries' };
  r = await call(as('admin1', { admin: true }, { uid: 'u_shop1', role: 'seller', category: 'supermarket', reason: 'Seller onboarded by script; owner approved' }));
  ck('E-14 a SELLER can be admitted (role seller); no providerProfiles is created for a seller', r.ok && (data['applications/ADM_u_shop1'] || {}).role === 'seller' && !data['providerProfiles/u_shop1'] && (await AUTH.isAuthoritativelyApproved(db, 'ADM_u_shop1', { isAdmin })).approved, r);
  reset(); seedProv('u_p0004'); TXN_FAIL_AFTER_WRITES = true; r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_p0004' }))); TXN_FAIL_AFTER_WRITES = false;
  ck('E-15 ONE transaction: if it aborts, NOTHING is written (no application without its decision, no orphan audit, no category stamp)', !data['applications/ADM_u_p0004'] && !data['applicationDecisions/ADM_u_p0004'] && !Object.values(data).some((v) => v && v.action === 'application_admit_existing') && !(data['providers/u_p0004'] || {}).business, Object.keys(data));

  /* ══ H1 (owner E2E gate 2026-10-03): the category is assigned INSIDE the authoritative approval ═══════════════════ */
  reset(); seedProv('u_barber1');
  r = await call(as('admin1', { admin: true }, AD));
  let pb = (data['providers/u_barber1'] || {}).business || {};
  let dc = data['applicationDecisions/ADM_u_barber1'] || {};
  ck('H1-1 admit stamps providers.business {salon, source admin, setBy, applicationId} IN the approval transaction', r.ok && pb.category === 'salon' && pb.source === 'admin' && pb.setBy === 'admin1' && pb.applicationId === 'ADM_u_barber1' && r.category === 'salon', pb);
  ck('H1-1b the capability is activated in the same txn: approvedAt (protected evidence) + sourceApplicationId on the provider', data['providers/u_barber1'].approvedAt === 'TS' && data['providers/u_barber1'].sourceApplicationId === 'ADM_u_barber1', data['providers/u_barber1']);
  ck('H1-2 the decision record carries businessCategory + approvedCategories — the authority answers a CATEGORY-scoped question', dc.businessCategory === 'salon' && (await AUTH.isAuthoritativelyApproved(db, 'ADM_u_barber1', { isAdmin, category: 'salon' })).approved && !(await AUTH.isAuthoritativelyApproved(db, 'ADM_u_barber1', { isAdmin, category: 'artist_creator' })).approved, dc);
  const aud2 = Object.values(data).find((v) => v && v.action === 'application_admit_existing') || {};
  ck('H1-3 the audit row records the category before → after', aud2.before && aud2.before.business === null && aud2.after && aud2.after.business && aud2.after.business.category === 'salon', aud2);
  const n2 = JSON.stringify(data); r = await call(as('admin2', { superAdmin: true }, AD));
  ck('H1-4 a repeat admit is a no-op: no duplicate decision, category not corrupted', r.ok && r.replay === true && JSON.stringify(data) === n2, r);

  reset(); seedProv('u_p0010');
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_p0010', category: 'barbershop' })));
  ck('H1-5 a category that is not a SOKONI category is refused, nothing written', r.err === 'invalid-argument' && r.reason === 'CATEGORY_UNKNOWN' && !data['applications/ADM_u_p0010'], r);
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_p0010', category: 'supermarket' })));
  ck('H1-6 a seller category on a provider (and vice versa) is refused', r.err === 'invalid-argument' && r.reason === 'CATEGORY_ROLE_MISMATCH', r);
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_p0010', category: 'lawyer' })));
  ck('H1-7 a specialised-authority category (legal / healthcare) is refused here', r.err === 'failed-precondition' && r.reason === 'SPECIALISED_AUTHORITY', r);

  reset(); seedProv('u_p0011', { business: { category: 'artist_creator', source: 'admin', setBy: 'admin2' } });
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_p0011' })));
  ck('H1-8 an existing ADMIN category is never silently re-categorised — refused, nothing written', r.err === 'failed-precondition' && r.reason === 'CATEGORY_CONFLICT' && data['providers/u_p0011'].business.category === 'artist_creator' && !data['applications/ADM_u_p0011'], r);
  reset(); seedProv('u_p0012', { business: { category: 'service_business', source: 'application' } });
  r = await call(as('admin1', { admin: true }, Object.assign({}, AD, { uid: 'u_p0012' })));
  ck('H1-9 an APPLICATION-sourced category may be set by the admin decision (source admin)', r.ok && data['providers/u_p0012'].business.category === 'salon' && data['providers/u_p0012'].business.source === 'admin', data['providers/u_p0012'].business);

  /* applicationDecide approvals */
  const decide = async (rq) => { try { return await L.applicationDecide(rq); } catch (e) { return { err: e.code, reason: e.details && (e.details.reason || e.details.code) }; } };
  reset(); data['applications/appDJ1'] = { uid: 'u_dj0002', status: 'pending', agreementAccepted: true, agreementVersion: 'test-seller-agreement', requestedRole: 'provider', category: 'dj', name: 'DJ Bambi', phone: '0700000000' };
  r = await decide({ auth: { uid: 'admin1', token: { admin: true } }, data: { applicationId: 'appDJ1', decision: 'approve', reason: 'ok', category: 'salon' } });
  pb = (data['providers/u_dj0002'] || {}).business || {};
  dc = data['applicationDecisions/appDJ1'] || {};
  ck('H1-10 applicationDecide approve: the category comes from the APPLICATION (dj → artist_creator), a client-sent category is IGNORED (break B)', dc.businessCategory === 'artist_creator' && pb.category === 'artist_creator' && pb.source === 'application', { r, dc, pb });
  ck('H1-11 the stamp lands in the SAME write that makes the provider active (never active-but-uncategorized)', data['providers/u_dj0002'] && data['providers/u_dj0002'].status === 'active' && pb.category === 'artist_creator', data['providers/u_dj0002']);
  reset(); data['applications/appX1'] = { uid: 'u_px001', status: 'pending', agreementAccepted: true, agreementVersion: 'test-seller-agreement', requestedRole: 'provider', category: 'Service Provider', name: 'Vague Co' };
  r = await decide({ auth: { uid: 'admin1', token: { admin: true } }, data: { applicationId: 'appX1', decision: 'approve', reason: 'ok' } });
  ck('H1-12 an approval whose category resolves to nothing is REFUSED: no decision record, no provider', r.err === 'failed-precondition' && r.reason === 'CATEGORY_UNRESOLVED' && !data['applicationDecisions/appX1'] && !data['providers/u_px001'], r);
  reset(); seedProv('u_dj0003', { name: 'DJ', business: { category: 'event_services', source: 'admin', setBy: 'admin2' } });
  data['applications/appDJ3'] = { uid: 'u_dj0003', status: 'pending', agreementAccepted: true, agreementVersion: 'test-seller-agreement', requestedRole: 'provider', category: 'dj', name: 'DJ' };
  r = await decide({ auth: { uid: 'admin1', token: { admin: true } }, data: { applicationId: 'appDJ3', decision: 'approve', reason: 'ok' } });
  ck('H1-13 re-approval never overwrites an ADMIN category (kept, reported)', data['providers/u_dj0003'].business.category === 'event_services' && data['providers/u_dj0003'].business.source === 'admin', data['providers/u_dj0003'].business);
  reset(); data['applications/appR1'] = { uid: 'u_px002', status: 'pending', requestedRole: 'provider', category: 'Service Provider', name: 'Vague Co' };
  r = await decide({ auth: { uid: 'admin1', token: { admin: true } }, data: { applicationId: 'appR1', decision: 'reject', reason: 'not eligible' } });
  ck('H1-14 a REJECT never needs a category (only approvals are gated)', r.ok === true && (data['applicationDecisions/appR1'] || {}).status === 'rejected', r);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
