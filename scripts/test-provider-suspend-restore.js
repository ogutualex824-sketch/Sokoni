#!/usr/bin/env node
/* TECH HUB SLICE 4O — AdminOS suspend / reinstate a provider, executed end to end through the EXISTING authority:
 * applicationDecide (suspend | approve) → applyDecision → projectProvider → every public / operational path refuses a
 * suspended provider (workspace, leads, bookings), and a reinstated one is eligible again. Plus adminGetProviders
 * honesty (unknown ≠ 0, suspended ≠ pending, sourceApplicationId exposed for the AdminOS buttons).
 *   node scripts/test-provider-suspend-restore.js        BASE=906bd2f node scripts/test-provider-suspend-restore.js */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sus-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
console.log('\nProvider suspend / reinstate (Tech Hub slice 4O)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const { DOCS } = H;
const ADMIN_TOKEN = { admin: true };
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

(async () => {
  const LC = require(path.join(FN, 'application-lifecycle.js'));
  const AO = require(path.join(FN, 'admin-os.js'));
  const L = require(path.join(FN, 'service-leads.js'))._h;
  const BS = require(path.join(FN, 'booking-service.js'))._h;
  const BW = require(path.join(FN, 'business-workspace.js'));
  const decide = (data, uid, token) => call((req) => LC.applicationDecide.run(req), uid || 'admin1', data, token || ADMIN_TOKEN);

  /* an applicant approved through the real decision path */
  H.reset();
  DOCS.set('users/tech1', { role: 'buyer', displayName: 'Tech One', email: 't@x.co' });
  DOCS.set('users/cust', { displayName: 'cust' });
  DOCS.set('providerProfiles/tech1', { draft: { profile: { name: 'Tech One' }, coverage: { areas: ['Nairobi'] } }, plan: 'free' });
  DOCS.set('applications/APP1', { uid: 'tech1', applicationId: 'APP1', role: 'provider', category: 'phone-repair', name: 'Tech One Repairs', status: 'pending', phone: '0712345678', location: 'Nairobi' });
  let r = await decide({ applicationId: 'APP1', decision: 'approve' });
  const p1 = DOCS.get('providers/tech1') || {};
  ck('S-1', !!r.ok && ['active', 'approved'].includes(p1.status) && p1.sourceApplicationId === 'APP1',
    'AdminOS approval projects the provider (active) and records sourceApplicationId', r.code ? r : { status: p1.status, src: p1.sourceApplicationId });

  /* the category stamp is sokoni-5b's slice — set it here so the workspace can route (documented dependency) */
  DOCS.set('providers/tech1', Object.assign(DOCS.get('providers/tech1') || {}, { business: { category: 'it_services', source: 'application' } }));
  DOCS.set('providerSubscriptions/tech1', { limits: { listings: -1 } });
  DOCS.set('providerAvailability/tech1', { modes: ['open_24_7'], appt: {} });
  DOCS.set('providerServices/s1', { providerId: 'tech1', name: 'Screen', priceType: 'fixed', price: 250000, active: true, durationMins: 60 });
  const wA = await BW.workspaceFor(H.db, 'tech1');
  const leadOk = await call(L.leadCreate, 'cust', { providerId: 'tech1', message: 'Can you fix my phone?' });
  ck('S-2', wA.state === 'AVAILABLE' && !!leadOk.ok, 'an approved provider has a working workspace and takes leads', { ws: wA.state, reason: wA.reason, lead: leadOk.code || 'ok' });

  /* a non-admin cannot suspend */
  r = await decide({ applicationId: 'APP1', decision: 'suspend' }, 'tech1', {});
  ck('S-3', r.code === 'permission-denied' && ['active', 'approved'].includes((DOCS.get('providers/tech1') || {}).status), 'the provider (non-admin) cannot suspend or decide anything', r);

  /* AdminOS suspends */
  r = await decide({ applicationId: 'APP1', decision: 'suspend', reason: 'Fraud report under review' });
  const p2 = DOCS.get('providers/tech1') || {};
  const audit = [...DOCS.entries()].filter(([k, v]) => k.startsWith('adminAudit/') && v.action === 'application_suspend');
  ck('S-4', !!r.ok && p2.status === 'suspended' && p2.searchable === false && p2.acceptsBookings === false && audit.length === 1 && audit[0][1].performedBy === 'admin1',
    'AdminOS suspend: provider suspended, unsearchable, not bookable; audited with the admin and reason', { status: p2.status, searchable: p2.searchable, accepts: p2.acceptsBookings, audit: audit.length, by: audit[0] && audit[0][1].performedBy, r });

  const wS = await BW.workspaceFor(H.db, 'tech1');
  const leadS = await call(L.leadCreate, 'cust', { providerId: 'tech1', message: 'Are you open today?' });
  const bookS = await call(BS.bookingCreateService, 'cust', { providerId: 'tech1', serviceId: 's1', date: tomorrow(), startTime: '10:00' });
  const svcS = await call(require(path.join(FN, 'provider-ops.js'))._h.providerAddService, 'tech1', { name: 'X', techProfile: { deviceTypes: ['phone'] } });
  ck('S-5', wS.state !== 'AVAILABLE' && leadS.code === 'failed-precondition' && bookS.code === 'failed-precondition' && svcS.code === 'failed-precondition',
    'a SUSPENDED provider: no workspace, no new leads, no bookings, cannot publish Tech services', { ws: wS.state, lead: leadS.code, book: bookS.code, svc: svcS.code });

  /* the provider cannot un-suspend through publishing */
  const PO = require(path.join(FN, 'provider-onboarding.js'))._h;
  if (PO && PO.providerPublish) {
    const pub = await call(PO.providerPublish, 'tech1', { draft: { profile: {}, coverage: {} }, plan: 'free' });
    ck('S-6', pub.code === 'permission-denied' && (DOCS.get('providers/tech1') || {}).status === 'suspended', 'the provider cannot re-publish itself out of a suspension', pub);
  } else ck('S-6', false, 'providerPublish handler found');

  /* AdminOS reinstates */
  r = await decide({ applicationId: 'APP1', decision: 'approve', reason: 'Cleared' });
  DOCS.set('providers/tech1', Object.assign(DOCS.get('providers/tech1') || {}, { business: { category: 'it_services', source: 'application' } }));
  const p3 = DOCS.get('providers/tech1') || {};
  const wR = await BW.workspaceFor(H.db, 'tech1');
  const leadR = await call(L.leadCreate, 'cust', { providerId: 'tech1', message: 'Back again — can you help?' });
  ck('S-7', !!r.ok && ['active', 'approved'].includes(p3.status) && p3.searchable === true && wR.state === 'AVAILABLE' && !!leadR.ok,
    'AdminOS reinstate (approve): eligible again — searchable, workspace, leads', { status: p3.status, searchable: p3.searchable, ws: wR.state, lead: leadR.code || 'ok' });

  /* adminGetProviders honesty */
  DOCS.set('providers/noRating', { name: 'New Co', status: 'suspended' });
  const ag = await call(AO._h.adminGetProviders, 'admin1', {}, ADMIN_TOKEN);
  const row = ag.ok && ag.ok.items.find((x) => x.uid === 'noRating');
  const t1 = ag.ok && ag.ok.items.find((x) => x.uid === 'tech1');
  ck('S-8', !!(row && row.rating === null && row.jobsCompleted === null && t1 && t1.sourceApplicationId === 'APP1' && ag.ok.suspended === 1 && ag.ok.pending === 0),
    'adminGetProviders: unknown rating / jobs are null (not 0); suspended counted as suspended, not pending; sourceApplicationId exposed',
    ag.code ? ag : { row, t1: t1 && t1.sourceApplicationId, suspended: ag.ok.suspended, pending: ag.ok.pending });
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
