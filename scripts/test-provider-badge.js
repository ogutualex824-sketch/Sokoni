#!/usr/bin/env node
/* TECH HUB SLICE 4P — the public "Verified" badge on a provider is a SERVER PROJECTION of the canonical, admin-decided,
 * audited verification facets — never a flag a provider (or a script) sets. Executes the REAL verificationDecide /
 * verificationRevoke / providerUpdateProfile and the search transformers on an in-memory Firestore.
 *   node scripts/test-provider-badge.js        BASE=12a6519 node scripts/test-provider-badge.js (must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
console.log('\nProvider verified badge (Tech Hub slice 4P)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const { DOCS } = H;
const ADMIN = { admin: true, email: 'ops@sokoni.test' };

(async () => {
  let B = null;
  try { B = require(path.join(FN, 'shared', 'provider-badge.js')); } catch (_) { B = null; }
  const VE = require(path.join(FN, 'verification-engine.js'));
  const PO = require(path.join(FN, 'provider-onboarding.js'))._h;
  const AI = require(path.join(FN, 'algolia-indexer.js'));
  const decide = (data, uid, token) => call((req) => VE.verificationDecide.run(req), uid || 'admin1', data, token || ADMIN);
  const revoke = (data, uid, token) => call((req) => VE.verificationRevoke.run(req), uid || 'admin1', data, token || ADMIN);
  const seed = () => { H.reset();
    DOCS.set('providers/p1', { uid: 'p1', name: 'Fix Ltd', status: 'active', searchable: true, category: 'Phone Repair' });
    DOCS.set('providerProfiles/p1', { uid: 'p1', name: 'Fix Ltd' });
    DOCS.set('users/p1', { role: 'provider' });
    DOCS.set('verificationRequests/r1', { applicantUid: 'p1', facet: 'identity', state: 'pending', status: 'pending' });
    DOCS.set('verificationRequests/r2', { applicantUid: 'p1', facet: 'business', state: 'pending', status: 'pending' }); };

  /* V-1 the pure rule */
  if (!B) ck('V-1', false, 'shared/provider-badge.js exists');
  else {
    const ok = B.computeBadge({ facets: { identity: { state: 'approved' } } }, { name: 'Fix Ltd' });
    const biz = B.computeBadge({ facets: { business: { state: 'approved' } } }, { name: 'Fix Ltd' });
    const exp = B.computeBadge({ facets: { identity: { state: 'approved', expiresAt: new Date(Date.now() - 1000).toISOString() } } }, { name: 'Fix Ltd' });
    ck('V-1', ok.verified === true && ok.verifiedName === 'Fix Ltd' && biz.verified === false && biz.verifiedFacets.join() === 'business' && exp.verified === false,
      'badge ⇔ identity facet active (business alone or an expired identity is not the badge); the verified name is snapshotted', { ok, biz, exp });
  }

  /* V-2 a non-admin cannot decide; the provider gets no badge */
  seed();
  let r = await decide({ requestId: 'r1', decision: 'approved' }, 'p1', {});
  ck('V-2', !!r.code && (DOCS.get('providers/p1') || {}).verified !== true, 'the provider (non-admin) cannot approve its own verification', r);

  /* V-3 admin approves identity → badge projected, audited */
  seed();
  r = await decide({ requestId: 'r1', decision: 'approved', reason: 'ID checked' });
  const p = DOCS.get('providers/p1') || {};
  const log = [...DOCS.entries()].filter(([k, v]) => k.startsWith('adminLog/') && /verification\.approved/.test(v.action || ''));
  ck('V-3', !!r.ok && p.verified === true && p.verifiedName === 'Fix Ltd' && (p.verifiedFacets || []).includes('identity') && log.length === 1 && r.ok.providerBadge === 'verified',
    'AdminOS approves identity → providers/{uid}.verified projected from the facet, name snapshotted, decision in adminLog', { r: r.ok || r, p, log: log.length });

  /* V-4 business approval alone does not create the badge */
  seed();
  await decide({ requestId: 'r2', decision: 'approved' });
  ck('V-4', (DOCS.get('providers/p1') || {}).verified === false, 'approving the business facet alone does not grant the identity badge', DOCS.get('providers/p1'));

  /* V-5 revoke removes it */
  seed();
  await decide({ requestId: 'r1', decision: 'approved' });
  r = await revoke({ uid: 'p1', facet: 'identity', reason: 'document withdrawn' });
  ck('V-5', !!r.ok && (DOCS.get('providers/p1') || {}).verified === false, 'revoking the identity facet removes the badge', { r: r.ok || r, p: DOCS.get('providers/p1') });

  /* V-6 renaming the verified listing drops the badge (re-verification); a phone edit does not */
  seed();
  await decide({ requestId: 'r1', decision: 'approved' });
  await call(PO.providerUpdateProfile, 'p1', { section: 'profile', data: { phone: '0712345678' } });
  const afterPhone = DOCS.get('providers/p1') || {};
  await call(PO.providerUpdateProfile, 'p1', { section: 'profile', data: { name: 'Totally Different Co' } });
  const afterName = DOCS.get('providers/p1') || {};
  ck('V-6', afterPhone.verified === true && afterName.verified === false && afterName.verificationReviewRequired === true,
    'a phone edit keeps the badge; renaming the verified listing drops it until an admin re-decides', { afterPhone: { v: afterPhone.verified }, afterName: { v: afterName.verified, rr: afterName.verificationReviewRequired, name: afterName.name } });

  /* V-7 the badge predicate (web + indexers): an owner-side rename through the rules path is not shown as verified */
  if (B) {
    ck('V-7', B.badgeValid({ verified: true, verifiedName: 'Fix Ltd', name: 'Fix Ltd' }) === true && B.badgeValid({ verified: true, verifiedName: 'Fix Ltd', name: 'Renamed' }) === false
      && B.badgeValid({ verified: true, name: 'Old' }) === true && B.badgeState({ verified: true, name: 'Old' }) === 'legacy' && B.badgeValid({ providerVerified: true, name: 'X' }) === false,
      'shown only while the verified name holds; a legacy flag is labelled legacy; providerVerified (owner-writable) never counts');
  } else ck('V-7', false, 'badge predicate exists');

  /* V-8 search no longer trusts the owner-writable providerVerified */
  const T = AI.TRANSFORMERS || (AI._internal && AI._internal.TRANSFORMERS);
  const rec = T && T.services ? T.services('p9', { name: 'Self Co', status: 'active', providerVerified: true }) : null;
  const rec2 = T && T.services ? T.services('p8', { name: 'Fix Ltd', status: 'active', verified: true, verifiedName: 'Fix Ltd' }) : null;
  ck('V-8', !!rec && rec.provider.verified === false && !!rec2 && rec2.provider.verified === true,
    'the search record is verified only from the projected badge, never from providerVerified', { rec: rec && rec.provider, rec2: rec2 && rec2.provider });
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
