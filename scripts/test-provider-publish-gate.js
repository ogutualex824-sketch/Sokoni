#!/usr/bin/env node
'use strict';
/* ============================================================================
   providerPublish — an ADMIN DECISION is the only path to a public, bookable provider
   ----------------------------------------------------------------------------
   Real module (functions/provider-onboarding.js, live providerDispatch lineage) with Firestore
   and Auth replaced at the SDK boundary by the in-memory fake (scripts/lib/fake-firestore-txn.js)
   and a recording Auth stub. Attack cases from the owner's 2026-10-01 brief §2 that this handler
   can reach:
     1  unauthenticated publish → denied
     2  signed-in, never approved → profile SAVED; registry row created CLOSED
        (pending_approval, not searchable/public/bookable), NO provider claim, approved:false
     3  a draft carrying status/searchable/verified/acceptsBookings is ignored (content only)
     4  approved (registry active) → claim (re)stamped, registry state untouched, approved:true,
        earned rating/jobs NOT reset by republishing
     5  suspended → refused;  6 rejected/deactivated → publish writes no state, no claim
     7  republish while pending → still pending, never promoted
     8  booking-service refuses pending_approval (ACTIVE_PROVIDER_STATES)
     9  providerActivateSubscription: priced plan refused (even with a paymentRef);
        free_trial activates;  sabotage: removing the gate makes case 2 fail
   node scripts/test-provider-publish-gate.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

/* ---- SDK boundary: firebase-admin/firestore + firebase-admin/auth + legal gate ---- */
const F = makeFakeFirestore();
const claims = new Map();
const authStub = {
  getUser: async (uid) => ({ uid, customClaims: claims.get(uid) || {} }),
  setCustomUserClaims: async (uid, c) => { claims.set(uid, { ...c }); },
};
const resolveFrom = (req) => Module._resolveFilename(req, { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
const stub = (req, exp) => { const f = resolveFrom(req); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => F.db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authStub });
stub(path.join(FN, 'legal-agreements.js'), { assertLegalCompliance: async () => ({ compliant: true }) });

function load(file) {
  const f = require.resolve(file);
  delete require.cache[f];
  return require(f);
}
const SRC = path.join(FN, 'provider-onboarding.js');
let M = load(SRC);
const H = M._h;

const req = (uid, data) => ({ auth: uid ? { uid, token: {} } : null, data: data || {} });
const draftFor = (extra) => ({
  plan: 'free_trial',
  draft: {
    profile: { name: 'Test Plumber', bio: 'Fixes pipes', category: 'plumbing', type: 'individual', ...(extra || {}) },
    coverage: { city: 'Nairobi', area: 'Westlands' },
    pricing: {},
  },
});
async function seed(uid, profile, registry) {
  await F.db.collection('providerProfiles').doc(uid).set(profile);
  if (registry) await F.db.collection('providers').doc(uid).set(registry);
}
const reg = async (uid) => { const s = await F.db.collection('providers').doc(uid).get(); return s.exists ? s.data() : null; };
const prof = async (uid) => { const s = await F.db.collection('providerProfiles').doc(uid).get(); return s.exists ? s.data() : null; };
async function tryCall(fn, r) { try { return { ok: true, v: await fn(r) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } }

(async () => {
  console.log('providerPublish — admin decision is the authority\n');

  /* 1 */
  const r1 = await tryCall(H.providerPublish, req(null));
  ck('1 unauthenticated publish → denied', !r1.ok && /unauth/i.test(String(r1.code) + r1.msg), r1);

  /* 2 */
  await seed('u_new', draftFor());
  const r2 = await tryCall(H.providerPublish, req('u_new'));
  const g2 = await reg('u_new'), p2 = await prof('u_new');
  ck('2a never-approved publish succeeds as a SAVE (profile content written)', r2.ok && p2 && p2.name === 'Test Plumber', r2);
  ck('2b registry row created CLOSED: pending_approval, not searchable/public/bookable/available',
    g2 && g2.status === 'pending_approval' && g2.searchable === false && g2.isPublic === false && g2.acceptsBookings === false && g2.available === false, g2);
  ck('2c providerProfiles.searchable is false (providerSearchProviders cannot list it)', p2 && p2.searchable === false, p2 && p2.searchable);
  ck('2d NO provider claim minted', !(claims.get('u_new') || {}).provider, claims.get('u_new'));
  ck('2e the result says approved:false, status pending_approval (the client can tell the truth)', r2.ok && r2.v.approved === false && r2.v.status === 'pending_approval', r2.v);

  /* 3 */
  await seed('u_forge', draftFor({ status: 'active', searchable: true, verified: true, acceptsBookings: true, approvedBy: 'admin1' }));
  await tryCall(H.providerPublish, req('u_forge'));
  const g3 = await reg('u_forge');
  ck('3 a draft carrying status/searchable/verified/acceptsBookings/approvedBy is ignored',
    g3 && g3.status === 'pending_approval' && g3.searchable === false && g3.acceptsBookings === false && !g3.verified && !g3.approvedBy && !(claims.get('u_forge') || {}).provider, g3);

  /* 4 */
  await seed('u_ok', draftFor(), { status: 'active', searchable: true, isPublic: true, acceptsBookings: true, available: true, rating: 4.7, reviewCount: 12, jobsCompleted: 30, providerId: 'PRV-1' });
  claims.set('u_ok', { someOther: true });
  const r4 = await tryCall(H.providerPublish, req('u_ok'));
  const g4 = await reg('u_ok');
  ck('4a approved provider: claim (re)stamped with providerId, other claims kept', r4.ok && claims.get('u_ok').provider === true && claims.get('u_ok').providerId === 'PRV-1' && claims.get('u_ok').someOther === true, claims.get('u_ok'));
  ck('4b registry state untouched (still active, bookable)', g4.status === 'active' && g4.acceptsBookings === true && g4.searchable === true, g4);
  ck('4c earned rating / reviews / jobs NOT reset by republishing', g4.rating === 4.7 && g4.reviewCount === 12 && g4.jobsCompleted === 30, g4);
  ck('4d result approved:true, status active', r4.ok && r4.v.approved === true && r4.v.status === 'active', r4.v);

  /* 5 */
  await seed('u_susp', draftFor(), { status: 'suspended', searchable: false, acceptsBookings: false });
  const r5 = await tryCall(H.providerPublish, req('u_susp'));
  ck('5 suspended provider → refused', !r5.ok && /permission-denied/.test(String(r5.code)), r5);

  /* 6 */
  for (const st of ['rejected', 'deactivated']) {
    await seed('u_' + st, draftFor(), { status: st, searchable: false, acceptsBookings: false });
    const r6 = await tryCall(H.providerPublish, req('u_' + st));
    const g6 = await reg('u_' + st);
    ck('6 ' + st + ' provider: publish writes no state (stays ' + st + '), no claim, approved:false',
      g6.status === st && g6.acceptsBookings === false && g6.searchable === false && !(claims.get('u_' + st) || {}).provider && (!r6.ok || r6.v.approved === false), { g6, r6 });
  }

  /* 7 */
  const r7 = await tryCall(H.providerPublish, req('u_new'));
  const g7 = await reg('u_new');
  ck('7 republishing while pending stays pending — never promoted', r7.ok && g7.status === 'pending_approval' && g7.acceptsBookings === false && !(claims.get('u_new') || {}).provider, g7);

  /* 8 */
  const bs = fs.readFileSync(path.join(FN, 'booking-service.js'), 'utf8');
  const act = (bs.match(/ACTIVE_PROVIDER_STATES\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  ck('8 booking-service refuses pending_approval (ACTIVE_PROVIDER_STATES = [' + act.trim() + '])', act && !/pending_approval/.test(act) && /active/.test(act));

  /* 9 */
  const r9a = await tryCall(H.providerActivateSubscription, req('u_pay', { plan: 'enterprise', billingCycle: 'monthly', paymentRef: 'FAKE-REF-123' }));
  const s9a = (await F.db.collection('providerSubscriptions').doc('u_pay').get());
  ck('9a priced plan with a client paymentRef → refused, nothing written', !r9a.ok && /failed-precondition/.test(String(r9a.code)) && !s9a.exists, r9a);
  const priced = Object.keys(M.PLANS || {}).length ? Object.keys(M.PLANS) : null;
  const r9b = await tryCall(H.providerActivateSubscription, req('u_pay', { plan: 'free_trial', billingCycle: 'monthly' }));
  const s9b = (await F.db.collection('providerSubscriptions').doc('u_pay').get());
  ck('9b free_trial still activates (onboarding keeps working)', r9b.ok && s9b.exists && s9b.data().plan === 'free_trial', r9b);

  /* sabotage: the same module with the approval gate removed must fail case 2 */
  const orig = fs.readFileSync(SRC, 'utf8');
  const sab = orig.replace("const approved = _regSnap.exists && ['active', 'approved'].includes(_regCur.status);", 'const approved = true;');
  if (sab === orig) { ck('S sabotage anchor present', false); }
  else {
    const tmp = path.join(FN, '.sabotage-provider-onboarding.js');
    fs.writeFileSync(tmp, sab);
    try {
      const MS = load(tmp);
      await seed('u_sab', draftFor());
      claims.delete('u_sab');
      await tryCall(MS._h.providerPublish, req('u_sab'));
      const gs = await reg('u_sab');
      ck('S sabotage (gate removed) → the suite WOULD catch it (claim minted / not pending)', (claims.get('u_sab') || {}).provider === true || (gs && gs.status !== 'pending_approval'), { gs, c: claims.get('u_sab') });
    } finally { fs.unlinkSync(tmp); delete require.cache[tmp]; }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
