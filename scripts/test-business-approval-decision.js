#!/usr/bin/env node
/* test-business-approval-decision.js — the admin approval-decision authority (bizAdminApprovalDecide) on the
 * transactional fake store. No network. Fixture = the DJ Bvmbxno shape from the six-identity census: a provider record
 * live by a client-written `status` alone, NO application, with bookings / a service / wallet transactions.
 *
 * PROVES, one clause of the owner's contract each
 *   admin-only      unauthenticated → unauthenticated; the provider itself / a plain owner → permission-denied; in both
 *                   cases NOTHING is written (store byte-identical, no audit)
 *   real decision   the record names the calling admin uid, a server timestamp, the decision, the reason, the target;
 *                   the historical `status` is copied into `prior` — it is never read as the approval
 *   no fabrication  no `applications/*` document is created; an existing application (Kasindi shape, decidedBy
 *                   "reindex") is byte-identical after — decidedBy is never rewritten
 *   idempotent      the same decision repeated → repeated:true, no second audit, provider byte-identical;
 *                   a DIFFERENT decision afterwards → failed-precondition DECISION_EXISTS, history untouched
 *   isolation       providerBookings, providerServices, walletTransactions, wallets, products byte-identical
 *   semantics       approval does NOT classify: `business` stays absent; the R2 resolver still holds the identity at
 *                   PENDING_CLASSIFICATION (no route); the capability read model moves from CONFLICT to a live
 *                   provider with the `provider_status_without_approval` conflict cleared
 *   audit           exactly one adminAudit business_approval_decision with performedBy, previous {status, approvedAt},
 *                   next, reason, createdAt
 *   refuse path     refuse → status suspended, searchable/isPublic false, approvedAt NOT written, no role grant
 *   role            approve grants `provider` through the injected canonical grant (grantAccountRole signature),
 *                   refuse does not; no claim is written by this module itself
 *   boundaries      missing provider → not-found NO_PROVIDER (no record created); healthcare → HEALTHCARE_BOUNDARY;
 *                   bad decision / short reason / missing uid → invalid-argument, nothing written
 *
 *   node scripts/test-business-approval-decision.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-approval';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path'); const ROOT = Path.resolve(__dirname, '..'); const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => ({ setCustomUserClaims: async () => { throw new Error('claim write reached firebase-admin directly'); } }) });
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const AA = require(Path.join(FN, 'business-approval-admin.js'));
const CAPS = require(Path.join(FN, 'shared', 'business-capabilities.js'));
const BW = require(Path.join(FN, 'business-workspace.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const J = (x) => JSON.stringify(x);
const isTs = (v) => v instanceof Date || !!(v && typeof v._ms === 'number'); const msOf = (v) => (v instanceof Date ? v.getTime() : v._ms);
const dump = (prefix) => J(db._dump(prefix));
const err = async (p) => { try { const r = await p; return { ok: true, r }; } catch (e) { return { ok: false, code: e.code, details: e.details, message: e.message }; } };
const grants = []; const grantRole = async (dbx, uid, role, on, meta) => { grants.push({ uid, role, on, meta }); return { uid, role, approved: on, claimSynced: true }; };
const H = (auth, data) => AA._adminH.bizAdminApprovalDecide({ auth, data }, { grantRole });
const ADMIN = { uid: 'admin_D5', token: { admin: true } };
const DJ = 'dj_bvmbxno', KAS = 'kasindi', REASON = 'Owner-authorized approval decision: identity 3 of 6, business verified by the owner on 2026-09-29';
(async () => {
  /* DJ Bvmbxno shape: status-only provider, no application, real activity */
  await db.doc('providers/' + DJ).set({ name: 'DJ Bvmbxno', status: 'active', category: 'Entertainment Performer', categoryLabel: 'dj', acceptsBookings: true, searchable: true, isPublic: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await db.doc('users/' + DJ).set({ roles: ['buyer'], name: 'DJ Bvmbxno' });
  await db.doc('wallets/' + DJ).set({ balance: 1500 });
  for (let i = 1; i <= 3; i++) await db.doc('walletTransactions/wt' + i).set({ uid: DJ, type: 'receive', amount: 500, status: 'completed' });
  for (let i = 1; i <= 4; i++) await db.doc('providerBookings/b' + i).set({ providerId: DJ, status: 'confirmed', amount: 2000 });
  await db.doc('providerServices/s1').set({ providerId: DJ, name: 'Club set', price: 5000 });
  await db.doc('products/p1').set({ sellerUid: 'someone_else', name: 'unrelated' });
  /* Kasindi shape: an existing application decided by "reindex" — must stay byte-identical whatever this authority does */
  await db.doc('providers/' + KAS).set({ name: 'Kasindi holdings limited', status: 'active', approvedAt: '2026-07-30T15:13:13.000Z', sourceApplicationId: 'PRVMS7IACKG' });
  await db.doc('applications/PRVMS7IACKG').set({ uid: KAS, status: 'approved', decidedBy: 'reindex', decidedAt: '2026-07-30T15:11:12.000Z', type: 'Cleaning Company / Housekeeper' });
  await db.doc('providers/hc1').set({ name: 'Clinic', status: 'pending', healthcare: { licence: 'x' } });

  const frozen = () => ({ bookings: dump('providerBookings/'), services: dump('providerServices/'), wtx: dump('walletTransactions/'), wallets: dump('wallets/'), products: dump('products/'), apps: dump('applications/'), kas: dump('providers/' + KAS) });
  const before = frozen(); const providerBefore = J(await get('providers/' + DJ));

  say('\n── admin-only: refused BEFORE any mutation ──');
  let r = await err(H(null, { uid: DJ, decision: 'approve', reason: REASON }));
  ck('unauthenticated → unauthenticated', !r.ok && r.code === 'unauthenticated', r.code);
  r = await err(H({ uid: DJ, token: { provider: true } }, { uid: DJ, decision: 'approve', reason: REASON }));
  ck('the provider itself (no admin claim) → permission-denied', !r.ok && r.code === 'permission-denied', r.code);
  r = await err(H({ uid: 'owner_x', token: { seller: true } }, { uid: DJ, decision: 'approve', reason: REASON }));
  ck('a signed-in non-admin owner → permission-denied', !r.ok && r.code === 'permission-denied', r.code);
  ck('nothing written by the three refusals: provider byte-identical, no adminAudit, no role grant', J(await get('providers/' + DJ)) === providerBefore && db._dump('adminAudit/').length === 0 && grants.length === 0);

  say('\n── argument refusals (nothing written) ──');
  r = await err(H(ADMIN, { uid: DJ, decision: 'reinstate', reason: REASON })); ck('decision outside approve|refuse → invalid-argument', !r.ok && r.code === 'invalid-argument', r.code);
  r = await err(H(ADMIN, { uid: DJ, decision: 'approve', reason: 'ok' })); ck('reason shorter than 3 chars → invalid-argument', !r.ok && r.code === 'invalid-argument', r.code);
  r = await err(H(ADMIN, { decision: 'approve', reason: REASON })); ck('missing uid → invalid-argument', !r.ok && r.code === 'invalid-argument', r.code);
  r = await err(H(ADMIN, { uid: 'ghost', decision: 'approve', reason: REASON })); ck('no provider record → not-found NO_PROVIDER, and no record is created', !r.ok && r.code === 'not-found' && r.details && r.details.code === 'NO_PROVIDER' && (await get('providers/ghost')) === null, r.code);
  r = await err(H(ADMIN, { uid: 'hc1', decision: 'approve', reason: REASON })); ck('healthcare provider → failed-precondition HEALTHCARE_BOUNDARY', !r.ok && r.code === 'failed-precondition' && r.details.code === 'HEALTHCARE_BOUNDARY', r.code);
  ck('still nothing written', J(await get('providers/' + DJ)) === providerBefore && db._dump('adminAudit/').length === 0 && J(frozen()) === J(before));

  say('\n── real decision, today, by a named admin ──');
  r = await err(H(ADMIN, { uid: DJ, decision: 'approve', reason: REASON }));
  ck('approve → ok, repeated:false, decidedBy = the calling admin uid', r.ok && r.r.repeated === false && r.r.decidedBy === 'admin_D5', r);
  const p1 = await get('providers/' + DJ);
  const dec = p1.approvalDecision || {};
  ck('providers/{uid}.approvalDecision = {decision approve, decidedBy admin uid, decidedAt server ts, reason, source admin_decision}', dec.decision === 'approve' && dec.decidedBy === 'admin_D5' && isTs(dec.decidedAt) && dec.reason === REASON && dec.source === 'admin_decision', dec);
  ck('the historical status is recorded as `prior` — not interpreted as the approval (prior.approvedAt null, prior.decidedBy null)', dec.prior && dec.prior.status === 'active' && dec.prior.approvedAt === null && dec.prior.approvedBy === null && dec.prior.decidedBy === null, dec.prior);
  ck('approval evidence now written: status active, approvedAt = server ts (today), approvedBy admin uid, suspended false', p1.status === 'active' && isTs(p1.approvedAt) && (Date.now() - msOf(p1.approvedAt)) < 60000 && p1.approvedBy === 'admin_D5' && p1.suspended === false);
  ck('every other provider field byte-identical (name, category text, acceptsBookings, searchable, isPublic, createdAt)', ['name', 'category', 'categoryLabel', 'acceptsBookings', 'searchable', 'isPublic', 'createdAt'].every((k) => J(p1[k]) === J(JSON.parse(providerBefore)[k])));

  say('\n── audit: one authoritative record ──');
  const audits = db._dump('adminAudit/');
  const a = audits[0] || {};
  ck('exactly one adminAudit business_approval_decision', audits.length === 1 && a.action === 'business_approval_decision', audits.length);
  ck('audit carries targetUid, performedBy (admin uid), decision, previous {status active, approvedAt null}, next {status active}, reason, createdAt', a.targetUid === DJ && a.performedBy === 'admin_D5' && a.decision === 'approve' && a.previous && a.previous.status === 'active' && a.previous.approvedAt === null && a.next && a.next.status === 'active' && a.reason === REASON && isTs(a.createdAt) && isTs(a.next.approvedAt), a);

  say('\n── no fabricated application; history untouched ──');
  ck('no applications/* document was created for DJ Bvmbxno', db._dump('applications/').filter((x) => x.uid === DJ).length === 0);
  ck('Kasindi application byte-identical: decidedBy still "reindex" (never rewritten to look like an admin decision)', dump('applications/') === before.apps && (await get('applications/PRVMS7IACKG')).decidedBy === 'reindex');
  ck('Kasindi provider byte-identical (another identity is never touched)', dump('providers/' + KAS) === before.kas);

  say('\n── financial / activity isolation ──');
  const after = frozen();
  ck('providerBookings (4) byte-identical', after.bookings === before.bookings);
  ck('providerServices (1) byte-identical', after.services === before.services);
  ck('walletTransactions (3) + wallets byte-identical', after.wtx === before.wtx && after.wallets === before.wallets);
  ck('products byte-identical', after.products === before.products);

  say('\n── role through the ONE role authority ──');
  ck('approve granted `provider` via the injected canonical grant once (grantAccountRole signature: db, uid, role, true, meta)', grants.length === 1 && grants[0].uid === DJ && grants[0].role === 'provider' && grants[0].on === true && grants[0].meta.source === 'bizAdminApprovalDecide', grants);
  ck('the result carries the grant receipt; no claim was written by this module directly', r.r.role && r.r.role.claimSynced === true);

  say('\n── idempotent: repeat = same result, no duplicate audit ──');
  const snap1 = J(p1);
  r = await err(H(ADMIN, { uid: DJ, decision: 'approve', reason: 'a second reason that must not overwrite the first' }));
  ck('same decision repeated → ok, repeated:true, original decidedBy returned', r.ok && r.r.repeated === true && r.r.decidedBy === 'admin_D5', r);
  ck('provider byte-identical after the repeat (reason NOT overwritten, approvedAt NOT refreshed)', J(await get('providers/' + DJ)) === snap1);
  ck('still exactly one adminAudit; no second role grant', db._dump('adminAudit/').length === 1 && grants.length === 1);
  r = await err(H({ uid: 'admin_other', token: { admin: true } }, { uid: DJ, decision: 'approve', reason: REASON }));
  ck('same decision by a DIFFERENT admin → repeated:true, still names the ORIGINAL decider (history not re-attributed)', r.ok && r.r.repeated === true && r.r.decidedBy === 'admin_D5', r);

  say('\n── conflicting decision refuses, does not overwrite ──');
  r = await err(H(ADMIN, { uid: DJ, decision: 'refuse', reason: 'changed my mind' }));
  ck('refuse after approve → failed-precondition DECISION_EXISTS naming the existing decision', !r.ok && r.code === 'failed-precondition' && r.details.code === 'DECISION_EXISTS' && r.details.existing === 'approve', r.details);
  ck('provider byte-identical; one audit; no new grant', J(await get('providers/' + DJ)) === snap1 && db._dump('adminAudit/').length === 1 && grants.length === 1);

  say('\n── explicit decision semantics: approval ≠ classification ──');
  ck('no `business` (category) stamp was written — approval never classifies', (await get('providers/' + DJ)).business === undefined);
  const rm = CAPS.readModel({ seller: null, provider: await get('providers/' + DJ), business: null, applications: [], productCount: 0 });
  ck('capability read model: provider now live by evidence, `provider_status_without_approval` conflict cleared', rm.observed.provider !== 'status_live_no_approval_evidence' && !rm.conflicts.includes('provider_status_without_approval'), { observed: rm.observed.provider, conflicts: rm.conflicts, classification: rm.classification });
  const w = await BW.workspaceFor(db, DJ);
  ck('R2 resolver: PENDING_CLASSIFICATION / no route — DJ Bvmbxno does NOT become artist_creator because this authority exists', w.state === 'PENDING_CLASSIFICATION' && !w.route && !w.workspace, { state: w.state, reason: w.reason, route: w.route || w.workspace || null });

  say('\n── refuse path (fail closed) on a second status-only identity ──');
  await db.doc('providers/king_bruce').set({ name: 'King Bruce', status: 'active', searchable: true, isPublic: true, category: 'Entertainment Performer' });
  r = await err(H(ADMIN, { uid: 'king_bruce', decision: 'refuse', reason: 'Owner decision: dormant identity, no application, not approved to operate' }));
  const kb = await get('providers/king_bruce');
  ck('refuse → ok; status suspended, suspended true, searchable false, isPublic false', r.ok && kb.status === 'suspended' && kb.suspended === true && kb.searchable === false && kb.isPublic === false, kb);
  ck('refuse writes NO approval evidence (approvedAt / approvedBy absent) and grants no role', kb.approvedAt === undefined && kb.approvedBy === undefined && grants.length === 1);
  ck('refuse decision record + its own audit (previous status active, next suspended)', kb.approvalDecision.decision === 'refuse' && kb.approvalDecision.prior.status === 'active' && db._dump('adminAudit/').filter((x) => x.targetUid === 'king_bruce' && x.next.status === 'suspended').length === 1);
  r = await err(H(ADMIN, { uid: 'king_bruce', decision: 'approve', reason: REASON }));
  ck('approve after refuse → DECISION_EXISTS (a reversal is a separate authority, not an overwrite)', !r.ok && r.details && r.details.code === 'DECISION_EXISTS' && r.details.existing === 'refuse');
  ck('total adminAudit = 2 (one per identity, none duplicated)', db._dump('adminAudit/').length === 2);

  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('SUITE CRASH ' + (e.stack || e)); process.exit(2); });
