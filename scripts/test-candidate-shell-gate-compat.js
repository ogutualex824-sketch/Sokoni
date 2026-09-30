#!/usr/bin/env node
/* test-candidate-shell-gate-compat.js — the shell gate (business-workspace.js + its 11-module closure) running against the
 * DEPLOYED ARCHIVE's own subscription-core.js / subscription-catalog.js, unstubbed, on the transactional fake store.
 * Run from the candidate tree (functions/ = archive + gate). Proves the gate needs nothing the archive lacks.
 *
 *   node scripts/test-candidate-shell-gate-compat.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-cand';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs'); const Path = require('path'); const ROOT = Path.resolve(__dirname, '..'); const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
const AF = require('./lib/approval-fixture'); AF.stubAdminAuth(stub);
/* NO stub of ./subscription-core or ./subscription-catalog: the archive versions load for real */
const SC = require(Path.join(FN, 'subscription-core.js')); const CAT = require(Path.join(FN, 'subscription-catalog.js'));
const BW = require(Path.join(FN, 'business-workspace.js'));
const PD = fs.readFileSync(Path.join(FN, 'provider-dispatch.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const biz = (category) => ({ business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } });
(async () => {
  ck('archive subscription-core exports what capability-authority calls (resolveSubscription, getCommissionRate)', typeof SC.resolveSubscription === 'function' && typeof SC.getCommissionRate === 'function');
  ck('archive subscription-catalog exports entitlementFor', typeof CAT.entitlementFor === 'function');
  ck('dispatcher merges business-workspace._h and routes businessWorkspace + workspaceHome; does NOT route healthcareWorkspace / providerDirectory / providerRequestShop', /require\('\.\/business-workspace'\)\._h/.test(PD) && /'businessWorkspace'/.test(PD) && /'workspaceHome'/.test(PD) && !/'healthcareWorkspace'/.test(PD) && !/'providerDirectory'/.test(PD) && !/'providerRequestShop'/.test(PD) && !/provider-shop|provider-directory|healthcare-workspace'\)\._h/.test(PD));
  await db.doc('providers/valid1').set(Object.assign({ name: 'Plumb Co', status: 'active', approvedAt: '2026-09-01T09:00:00Z', acceptsBookings: true }, biz('trades'))); await AF.seedApproved(db, 'valid1', 'provider');
  await db.doc('providers/dj').set({ name: 'DJ', status: 'active', searchable: true }); await db.doc('users/dj').set({ roles: ['provider'] });
  await db.doc('users/buyer1').set({ roles: ['buyer'] });
  await db.doc('providers/kb').set({ name: 'KB', status: 'suspended', approvalDecision: { decision: 'refuse', decidedBy: 'admin_D5', source: 'admin_decision' } });
  const v = await BW.workspaceFor(db, 'valid1');
  ck('valid provider (archive subscription modules answering the plan lookup) → provider-dashboard AVAILABLE', v.state === 'AVAILABLE' && v.route === 'provider-dashboard.html' && v.approval.state === 'VALID_APPROVAL', { state: v.state, route: v.route, sub: v.entitlement });
  const d = await BW.workspaceFor(db, 'dj');
  ck('status-only provider → REAPPLICATION_REQUIRED, route complete-application.html', d.state === 'REAPPLICATION_REQUIRED' && d.route === 'complete-application.html');
  const b = await BW.workspaceFor(db, 'buyer1'); ck('buyer → found:false', b.found === false && b.approval.state === 'BUYER_ONLY');
  const k = await BW.workspaceFor(db, 'kb'); ck('refused → REFUSED, no route', k.state === 'REFUSED' && k.route === null);
  const h = await BW._h.businessWorkspace({ auth: { uid: 'dj', token: {} } }); ck('handler through the dispatcher-merged _h answers the same', h.state === 'REAPPLICATION_REQUIRED');
  ck('no adminAudit / no write made by any answer', db._dump('adminAudit/').length === 0);
  say('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { say('SUITE CRASH ' + (e.stack || e)); process.exit(2); });
