#!/usr/bin/env node
/* SLICE 0 — the ONE service-capability engine (owner 2026-10-03). Part A runs the pure engine; Part B EXECUTES the real
 * business-workspace.workspaceFor in-process on an in-memory Firestore (deciders' admin status injected through the
 * function's own opts.approval.getUser seam — no Firebase Auth, no network).
 *   node scripts/test-service-capabilities.js        BASE=95ff9e8 node scripts/test-service-capabilities.js (must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths();
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {   /* the base tree, extracted, so the SAME rows run against the live lineage */
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc0-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\nService capabilities (Slice 0)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

let SC = null; try { SC = require(path.join(FN, 'shared', 'service-capabilities.js')); } catch (_) { SC = null; }
console.log('PART A — the pure engine');
if (!SC) { ck('A-0', false, 'shared/service-capabilities.js exists'); } else {
  const V = (id, category, extra) => Object.assign({ id, app: { category }, valid: true, why: 'admin_account' }, extra || {});
  let r = SC.compose([V('a1', 'phone-repair'), V('a2', 'laptop-repair'), V('a3', 'it-support')]);
  ck('A-1', ['DEVICE_REPAIR', 'IT_SUPPORT', 'REMOTE_SUPPORT', 'ONSITE_SUPPORT', 'QUOTE_REQUEST', 'DIRECT_BOOKING', 'WORKSHOP', 'PICKUP_DROP_OFF'].every((c) => r.capabilities.includes(c)) && r.sources.DEVICE_REPAIR.join() === 'a1,a2',
    'phone repair + laptop repair + IT support COMPOSE into one union, with the approvals that grant each capability', r);
  r = SC.compose([V('a1', 'phone-repair'), Object.assign(V('a2', 'cctv'), { valid: false, why: 'self_decision' }), Object.assign(V('a3', 'networking'), { valid: false, why: 'not_approved' })]);
  ck('A-2', !r.capabilities.includes('CCTV_SECURITY') && !r.capabilities.includes('NETWORKING') && r.ignored.map((x) => x.why).join() === 'self_decision,not_approved',
    'an application that is not a VALID approval (self-decided, pending) grants NOTHING', r);
  r = SC.compose([V('a1', 'Phone-Repair ')]);
  ck('A-3', r.capabilities.includes('DEVICE_REPAIR'), 'business ids are matched exactly after normalisation (case / spacing), as business-category does');
  r = SC.compose([V('a1', 'salon'), V('a2', 'not-a-business')]);
  ck('A-4', r.capabilities.length === 0 && r.ignored.every((x) => x.why === 'no_capability_mapping'), 'an id with no capability mapping grants none (its category still routes as before)', r);
  { /* A-8 — Legal (L9): a valid legal approval → quotes + direct booking; an invalid one → nothing */
    const L1 = SC.compose([V('legal_u1', 'legal')]);
    const L2 = SC.compose([Object.assign(V('legal_u2', 'legal'), { valid: false, why: 'self_decision' })]);
    const mods = SC.modulesFor(L1.capabilities, 'provider');
    ck('A-8', JSON.stringify(L1.capabilities) === JSON.stringify(['DIRECT_BOOKING', 'QUOTE_REQUEST']) && mods.includes('leads') && mods.includes('quotes') && mods.includes('bookings')
      && L2.capabilities.length === 0, 'Legal: a VALID approval of a legal application switches on leads/quotes + bookings; a self/invalid decision switches on nothing', { L1, L2, mods });
  }
  ck('A-5', Object.values(SC.FROM_BUSINESS_ID).every((caps) => caps.every(SC.isCapability)) && Object.keys(SC.MODULES_OF).every(SC.isCapability),
    'every mapped capability and every module rule names a real capability');
  ck('A-6', SC.modulesFor(['DEVICE_REPAIR', 'WORKSHOP'], 'provider').join() === 'diagnostics,repairs,supportedDevices' && SC.modulesFor(['FOOD_MENU', 'BAKERY', 'KITCHEN'], 'merchant').join() === 'kitchen,menu',
    'modules are the UNION per workspace kind (no duplicates)');
  ck('A-7', SC.modulesFor(['FORGED_CAPABILITY'], 'provider').length === 0, 'an unknown capability string switches nothing on');
}

/* ── PART B: the real workspaceFor ── */
console.log('\nPART B — business-workspace.workspaceFor, executed');
const DOCS = new Map();
const snap = (k, id) => ({ exists: DOCS.has(k), id, data: () => (DOCS.has(k) ? JSON.parse(JSON.stringify(DOCS.get(k))) : undefined) });
const coll = (c, filters, lim) => ({
  doc: (id) => ({ get: async () => snap(c + '/' + id, id) }),
  where: (f, op, v) => coll(c, (filters || []).concat([[f, v]]), lim), limit: (n) => coll(c, filters, n), orderBy: () => coll(c, filters, lim),
  get: async () => { const docs = [...DOCS.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2)
    .filter((k) => (filters || []).every(([f, v]) => (DOCS.get(k) || {})[f] === v)).slice(0, lim || 1e9).map((k) => snap(k, k.split('/')[1]));
    return { docs, empty: !docs.length, size: docs.length }; },
});
const db = { collection: (c) => coll(c, [], 0) };
const ADMINS = new Set(['admin1']);
const OPTS = { claims: {}, approval: { getUser: async (u) => ({ customClaims: ADMINS.has(u) ? { admin: true } : {} }), cleanupIds: new Set() } };
const APPROVED_AT = '2026-09-01T00:00:00.000Z';
const reset = () => DOCS.clear();
const provider = (uid, category) => { DOCS.set('providers/' + uid, { status: 'active', approvedAt: APPROVED_AT, searchable: true, business: { category, source: 'application' } }); DOCS.set('users/' + uid, { role: 'provider' }); };
const seller = (uid) => DOCS.set('sellers/' + uid, { status: 'active', active: true, approvedAt: APPROVED_AT });
/* P0 (5b 0cb93bd): an admin decision also writes the server record applicationDecide writes — the application doc alone is a request. */
const app = (id, uid, category, role, status, decidedBy) => { const by = decidedBy === undefined ? 'admin1' : decidedBy; DOCS.set('applications/' + id, { uid, category, role, status, decidedBy: by }); if (by === 'admin1') DOCS.set('applicationDecisions/' + id, { status: status === 'approved' ? 'approved' : status, decidedBy: by }); };
let BW = null, loadErr = null;
try { BW = require(path.join(FN, 'business-workspace.js')); } catch (e) { loadErr = e.message; }
(async () => {
  if (!BW) { ck('B-0', false, 'business-workspace loads', loadErr); return done(); }
  let w;
  /* B-1 composition: one tech provider approved for phone repair + IT support */
  reset(); provider('t1', 'it_services'); app('ap1', 't1', 'phone-repair', 'provider', 'approved'); app('ap2', 't1', 'it-support', 'provider', 'approved');
  w = await BW.workspaceFor(db, 't1', OPTS);
  ck('B-1', w.route === 'provider-dashboard.html' && ['DEVICE_REPAIR', 'IT_SUPPORT', 'REMOTE_SUPPORT'].every((c) => (w.serviceCapabilities || []).includes(c)),
    'an APPROVED tech provider (phone repair + IT support) gets ONE provider dashboard with the UNION of capabilities', { route: w.route, state: w.state, reason: w.reason, caps: w.serviceCapabilities });
  ck('B-2', /* Tech slice 4b (sokoni-b2) shipped repairs + supportedDevices; diagnostics is still pending, so the honesty rule is asserted on it */
    w.modules && w.modules.diagnostics && w.modules.diagnostics.state === 'NOT_IMPLEMENTED' && w.modules.diagnostics.reason === 'TECH_HUB_PENDING' && (w.modules.supportTickets || {}).state === 'NOT_IMPLEMENTED'
    && (w.modules.repairs || {}).state === 'AVAILABLE',
    'capability modules whose screens do not exist yet are NOT_IMPLEMENTED with the reason — never shown as working', w.modules && { diagnostics: w.modules.diagnostics, repairs: w.modules.repairs, supportTickets: w.modules.supportTickets });
  ck('B-3', w.modules && w.modules.quotes && w.modules.quotes.state === 'AVAILABLE' && (w.modules.overview || {}).state === 'AVAILABLE' && (w.modules.cctvInstallations || {}).state === 'NOT_APPLICABLE',
    'existing profile modules are unchanged; a capability the business was NOT approved for stays NOT_APPLICABLE', w.modules && { quotes: w.modules.quotes, cctv: w.modules.cctvInstallations });
  /* B-4 approval first: same provider record, application still pending */
  reset(); provider('t2', 'it_services'); app('ap3', 't2', 'phone-repair', 'provider', 'pending', '');
  w = await BW.workspaceFor(db, 't2', OPTS);
  ck('B-4', !w.route || w.route === 'complete-application.html' ? (w.serviceCapabilities || []).length === 0 : false,
    'APPROVAL FIRST: an unapproved application opens no workspace and grants no capability', { route: w.route, state: w.state, caps: w.serviceCapabilities });
  /* B-5 self-decided / non-admin decisions grant nothing */
  reset(); provider('t3', 'it_services'); app('ap4', 't3', 'phone-repair', 'provider', 'approved'); app('ap5', 't3', 'cctv', 'provider', 'approved', 't3'); app('ap6', 't3', 'networking', 'provider', 'approved', 'notAnAdmin');
  w = await BW.workspaceFor(db, 't3', OPTS);
  ck('B-5', (w.serviceCapabilities || []).includes('DEVICE_REPAIR') && !(w.serviceCapabilities || []).includes('CCTV_SECURITY') && !(w.serviceCapabilities || []).includes('NETWORKING'),
    'a SELF-decided approval and a NON-ADMIN decision add no capability; the valid one still counts', { caps: w.serviceCapabilities, src: w.capabilitySources });
  /* B-6 food: restaurant + catering on merchant-v2 */
  reset(); provider('f1', 'restaurant'); DOCS.get('providers/f1').status = 'pending'; delete DOCS.get('providers/f1').approvedAt; delete DOCS.get('providers/f1').searchable; seller('f1');
  app('ap7', 'f1', 'restaurant', 'seller', 'approved'); app('ap8', 'f1', 'catering', 'seller', 'approved');
  w = await BW.workspaceFor(db, 'f1', OPTS);
  const mm = w.merchantModules || {};
  ck('B-6', w.route === 'merchant-v2.html' && ['menu', 'kitchen', 'drinks', 'catering'].every((k) => mm[k] && mm[k].state === 'NOT_IMPLEMENTED' && mm[k].reason === 'FOOD_HUB_PENDING'),
    'an APPROVED food business (restaurant + catering) routes to merchant-v2 with menu / kitchen / drinks / catering, NOT_IMPLEMENTED until built', { route: w.route, state: w.state, reason: w.reason, mm, caps: w.serviceCapabilities });
  /* B-7 a browser-written category on the provider record without any approval opens nothing */
  reset(); DOCS.set('providers/x1', { status: 'pending', business: { category: 'it_services', source: 'browser' } }); DOCS.set('users/x1', { role: 'buyer' });
  w = await BW.workspaceFor(db, 'x1', OPTS);
  /* no WORKSPACE route: either none, or the re-application page the approval gate sends unapproved records to */
  ck('B-7', (!w.route || w.route === 'complete-application.html') && w.state !== 'AVAILABLE' && (w.serviceCapabilities || []).length === 0,
    'a category on the record with no valid approval opens no workspace and grants no capability', { route: w.route, state: w.state, caps: w.serviceCapabilities });
  /* B-8 the override guard */
  if (typeof BW._applyServiceCaps === 'function') {
    const x = BW._applyServiceCaps({ route: 'provider-dashboard.html', modules: { quotes: { state: 'LOCKED', reason: 'PLAN' }, leads: { state: 'NOT_APPLICABLE', reason: null } } }, { capabilities: ['QUOTE_REQUEST'], sources: {} });
    ck('B-8', x.modules.quotes.state === 'LOCKED' && x.modules.leads.state === 'AVAILABLE' /* leads implemented by Tech 4F (sokoni-b2); the invariant is LOCKED untouched + NOT_APPLICABLE switched on */, 'a capability never overrides a LOCKED / plan state; it only switches on NOT_APPLICABLE modules', x.modules);
  } else ck('B-8', false, '_applyServiceCaps exported for this guard');
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
