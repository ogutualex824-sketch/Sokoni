#!/usr/bin/env node
/* test-shell-approval-gate.js — the ONE workspace authority (business-workspace.js) now answers the derived approval state
 * FIRST: only VALID_APPROVAL reaches category/capability routing. Transactional fake store, REAL module. No network.
 *
 * PROVES
 *   VALID_APPROVAL         → the normal route (provider-dashboard / merchant-v2), unchanged behaviour
 *   REAPPLICATION_REQUIRED → state REAPPLICATION_REQUIRED, route = complete-application.html ONLY, remediation payload
 *                            (applicationPath, agreement, preserve); DJ shape (fresh), Kasindi shape (redecide_existing,
 *                            agreement unsatisfied), role-only claim (role_without_registry), seller stub
 *   PENDING_APPROVAL       → PENDING_APPROVAL / NOT_APPROVED with select_among_pending for Heights (3 candidates, none chosen)
 *   REFUSED                → state REFUSED, no route
 *   cleanup-owned          → REMEDIATION_WITHHELD, no route (Shave 'n' Trims' real uid is in the static claimed-id copy)
 *   buyer                  → found:false / NO_APPROVED_BUSINESS (buyer stays buyer)
 *   unreadable             → APPROVAL_UNREADABLE, no route (fail closed)
 *   homeFor                → a shop live by status alone gets NO merchant-v2 home; DJ's primary is the completion surface
 *   handler                → businessWorkspace passes the caller's claims; a stranger's uid is never resolvable
 *   read-only              → the authority writes nothing while answering
 *   static copy            → shared/cleanup-claimed-ids.json carries the manifest digest 028299e7… and 34 ids
 *   client consumer        → sokoni-business-workspace.js redirects REAPPLICATION_REQUIRED to the server-named route
 *
 *   node scripts/test-shell-approval-gate.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-gate';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs'); const Path = require('path'); const ROOT = Path.resolve(__dirname, '..'); const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const AF = require('./lib/approval-fixture'); AF.stubAdminAuth(stub);
const BW = require(Path.join(FN, 'business-workspace.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const J = (x) => JSON.stringify(x);
const biz = (category) => ({ business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } });
const SHAVE = '13iuLZx63jN5evaNcUnx7bhDSfs1';
(async () => {
  /* fixtures */
  await db.doc('providers/valid1').set(Object.assign({ name: 'Plumb Co', status: 'active', approvedAt: '2026-09-01T09:00:00Z' }, biz('trades'))); await AF.seedApproved(db, 'valid1', 'provider');
  await db.doc('providers/dj').set({ name: 'DJ Bvmbxno', status: 'active', searchable: true, isPublic: true }); await db.doc('users/dj').set({ roles: ['provider', 'buyer'] });
  await db.doc('providers/kas').set({ name: 'Kasindi', status: 'active', approvedAt: '2026-07-30T15:13:13Z', searchable: true }); await db.doc('sellers/kas').set({ branches: [] });
  await db.doc('applications/PRVMS7IACKG').set({ uid: 'kas', role: 'provider', status: 'approved', statusCanonical: 'approved', decidedBy: 'reindex', decidedAt: '2026-07-30T15:11:12Z' });
  await db.doc('providers/hc').set({ name: 'Heights', status: 'pending' }); for (const id of ['A', 'B', 'C']) await db.doc('applications/' + id).set({ uid: 'hc', role: 'provider', status: 'pending' });
  await db.doc('providers/kb').set({ name: 'King Bruce', status: 'suspended', suspended: true, searchable: false, isPublic: false, approvalDecision: { decision: 'refuse', decidedBy: 'admin_D5', source: 'admin_decision' } }); await db.doc('users/kb').set({ roles: ['buyer', 'merchant', 'provider'] });
  await db.doc('providers/' + SHAVE).set({ name: "Shave 'n' Trims", status: 'active', searchable: true });
  await db.doc('users/buyer1').set({ roles: ['buyer'] });
  await db.doc('sellers/stub1').set({ branches: [] }); await db.doc('users/stub1').set({ roles: ['buyer'] });
  await db.doc('shops/S9').set({ ownerId: 'shopper', name: 'Duka', status: 'active' });
  const snapshotAll = () => J(db._dump(''));
  const before = snapshotAll();

  say('\n── the gate, state by state ──');
  const v = await BW.workspaceFor(db, 'valid1');
  ck('VALID_APPROVAL (application by admin account) → provider-dashboard, AVAILABLE; approval.state VALID_APPROVAL', v.route === 'provider-dashboard.html' && v.state === 'AVAILABLE' && v.approval.state === 'VALID_APPROVAL', { route: v.route, state: v.state, approval: v.approval.state });
  const d = await BW.workspaceFor(db, 'dj');
  ck('DJ shape (status only, no application) → REAPPLICATION_REQUIRED, route complete-application.html, path fresh, approval NO_APPROVAL/live_status_only', d.state === 'REAPPLICATION_REQUIRED' && d.route === 'complete-application.html' && d.remediation.applicationPath.mode === 'fresh' && d.approval.state === 'NO_APPROVAL' && d.approval.subtype === 'live_status_only' && d.reason === 'live_status_only', { state: d.state, route: d.route, path: d.remediation.applicationPath.mode });
  ck('   Overview + Settings only; every workspace module withheld; a message the user can act on', d.modules.overview.state === 'AVAILABLE' && d.modules.settings.state === 'AVAILABLE' && Object.keys(d.modules).filter((k) => !['overview', 'settings'].includes(k)).every((k) => d.modules[k].state !== 'AVAILABLE') && /completed/.test(d.message));
  const k = await BW.workspaceFor(db, 'kas');
  ck('Kasindi shape (approved by "reindex") → REAPPLICATION_REQUIRED, redecide_existing PRVMS7IACKG, agreement required + unsatisfied, preserve names the reindex decision', k.state === 'REAPPLICATION_REQUIRED' && k.remediation.applicationPath.mode === 'redecide_existing' && k.remediation.applicationPath.applicationId === 'PRVMS7IACKG' && k.remediation.agreement.required && !k.remediation.agreement.satisfied && k.remediation.preserve.some((p) => p.decidedBy === 'reindex'), k.remediation);
  const h = await BW.workspaceFor(db, 'hc');
  ck('Heights shape (3 pending) → PENDING_APPROVAL / NOT_APPROVED, no route, select_among_pending with 3 candidates and none chosen', h.state === 'PENDING_APPROVAL' && h.reason === 'NOT_APPROVED' && h.route === null && h.remediation.applicationPath.mode === 'select_among_pending' && h.remediation.applicationPath.candidates.length === 3 && !h.remediation.applicationPath.applicationId, h.remediation.applicationPath);
  const b = await BW.workspaceFor(db, 'kb');
  ck('King Bruce shape (admin refuse) → REFUSED, no route; residual roles do not route', b.state === 'REFUSED' && b.route === null && b.approval.state === 'REFUSED');
  const s = await BW.workspaceFor(db, SHAVE);
  ck("Shave 'n' Trims (claimed by the cleanup manifest, static copy) → REMEDIATION_WITHHELD / CLEANUP_OWNED, no route", s.state === 'REMEDIATION_WITHHELD' && s.reason === 'CLEANUP_OWNED' && s.route === null && s.approval.ownership === 'cleanup', { state: s.state, ownership: s.approval.ownership });
  const bu = await BW.workspaceFor(db, 'buyer1');
  ck('buyer → found:false, NO_APPROVED_BUSINESS, no route (buyer stays buyer)', bu.found === false && bu.reason === 'NO_APPROVED_BUSINESS' && bu.route === null && bu.approval.state === 'BUYER_ONLY');
  const st = await BW.workspaceFor(db, 'stub1');
  ck('seller stub (branches only) → REAPPLICATION_REQUIRED / registry_stub_not_live, path fresh', st.state === 'REAPPLICATION_REQUIRED' && st.approval.subtype === 'registry_stub_not_live' && st.remediation.applicationPath.mode === 'fresh');
  const ro = await BW.workspaceFor(db, 'roleonly', { claims: { seller: true } });
  ck('a seller CLAIM with no record and no application (RC Seller shape) → REAPPLICATION_REQUIRED / role_without_registry', ro.state === 'REAPPLICATION_REQUIRED' && ro.approval.subtype === 'role_without_registry');
  const shopper = await BW.workspaceFor(db, 'shopper');
  ck('a shop live by status alone (ownerId) → REAPPLICATION_REQUIRED, never merchant-v2', shopper.state === 'REAPPLICATION_REQUIRED' && shopper.route === 'complete-application.html');

  say('\n── fail closed ──');
  const brokenDb = { collection: (c) => c === 'applications' ? { where: () => ({ limit: () => ({ get: async () => { throw new Error('permission-denied'); } }) }) } : db.collection(c), doc: (p) => db.doc(p) };
  const u = await BW.workspaceFor(brokenDb, 'valid1');
  ck('an unreadable applications read → APPROVAL_UNREADABLE, no route, error carried', u.state === 'APPROVAL_UNREADABLE' && u.route === null && /permission-denied/.test(u.approval.error), { state: u.state, err: u.approval.error });

  say('\n── homeFor ──');
  const hd = await BW.homeFor(db, 'dj', {});
  ck('DJ home: one business entry routed to the completion surface; apply false; approval carried', hd.homes.length === 1 && hd.primary.route === 'complete-application.html' && hd.apply === false && hd.homes[0].approval === 'NO_APPROVAL');
  const hs = await BW.homeFor(db, 'shopper', {});
  ck('shop owner without approval: NO merchant-v2 shop home — only the completion entry', !hs.homes.some((x) => x.route === 'merchant-v2.html') && hs.primary.route === 'complete-application.html', hs.homes.map((x) => x.route));
  await AF.seedApproved(db, 'shopper', 'seller');
  const hs2 = await BW.homeFor(db, 'shopper', {});
  ck('CONTROL: once the seller decision exists the shop home routes to merchant-v2', hs2.homes.some((x) => x.route === 'merchant-v2.html'), hs2.homes.map((x) => x.route));
  const hv = await BW.homeFor(db, 'valid1', {});
  ck('valid provider home unchanged: provider-dashboard primary', hv.primary.route === 'provider-dashboard.html');

  say('\n── handler, read-only, static copy, client consumer ──');
  const viaHandler = await BW._h.businessWorkspace({ auth: { uid: 'roleonly', token: { seller: true } } });
  ck('businessWorkspace handler passes the caller\'s claims (role_without_registry through the callable)', viaHandler.approval.subtype === 'role_without_registry');
  let refused = false; try { await BW._h.businessWorkspace({ auth: null }); } catch (e) { refused = e.code === 'unauthenticated'; } ck('unauthenticated → refused', refused);
  const after = snapshotAll();
  ck('the authority wrote NOTHING while answering (store identical except the CONTROL seed)', J(db._dump('providers/')) === J(JSON.parse(before).filter((r) => r.path.startsWith('providers/'))) && db._dump('adminAudit/').length === 0);
  const C = require(Path.join(FN, 'shared', 'cleanup-claimed-ids.json')); const M = require('C:/Users/USER1/OneDrive/Desktop/SOKONI/docs/release-gates/c3-cleanup-manifest.json');
  ck('static cleanup copy: 34 ids, digest 028299e7…, identical to the release-gate manifest', C.count === 34 && C.digest === M.digest && J(C.ids) === J(M.ids), C.digest.slice(0, 16));
  /* the client consumer is a HOSTING asset; a Functions-only candidate tree may not carry it — then n/a, not a failure */
  const clientPath = Path.join(ROOT, 'sokoni-business-workspace.js');
  if (fs.existsSync(clientPath)) {
    const client = fs.readFileSync(clientPath, 'utf8');
    ck('client consumer redirects REAPPLICATION_REQUIRED to the server-named route and never decides a state itself', /REAPPLICATION_REQUIRED/.test(client) && /location\.replace\('\/' \+ String\(w\.route\)/.test(client) && !/approvedAt|isAdmin/.test(client));
  } else say('  n/a   client consumer (sokoni-business-workspace.js) is not in this tree — a hosting asset, checked on the hosting line');
  const src = fs.readFileSync(Path.join(FN, 'business-workspace.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ck('business-workspace.js still contains no Firestore write call', !/\.(set|update|add|delete)\(/.test(src));
  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('SUITE CRASH ' + (e.stack || e)); process.exit(2); });
