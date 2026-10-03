#!/usr/bin/env node
/* TECH HUB SLICE 4N — provider-onboarding.html converges onto the ONE application → AdminOS → capability path.
 * Executes the REAL providerPublish (with the OB-1 hotfix c853665 ported) and applicationDecide on an in-memory Firestore.
 *   node scripts/test-provider-onboarding-intake.js        BASE=faa2dd9 node scripts/test-provider-onboarding-intake.js */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
console.log('\nProvider onboarding intake (Tech Hub slice 4N)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const { DOCS } = H;
const draftFor = (sub) => ({ draft: { profile: { name: 'Net Pro', bio: 'Office networks', category: 'Technology', subcategory: sub, qualifications: [] },
  coverage: { city: 'Nairobi', area: 'Westlands' }, pricing: {} }, plan: 'free_trial' });

(async () => {
  let PI = null; try { PI = require(path.join(FN, 'shared', 'profession-intake.js')); } catch (_) { PI = null; }
  const BC = require(path.join(FN, 'business-category.js'));
  const SC = require(path.join(FN, 'shared', 'service-capabilities.js'));
  const PO = require(path.join(FN, 'provider-onboarding.js'))._h;
  const LC = require(path.join(FN, 'application-lifecycle.js'));

  /* N-1 every mapped job title names an EXISTING intake id (nothing invented) */
  if (!PI) ck('N-1', false, 'shared/profession-intake.js exists');
  else {
    const bad = Object.entries(PI.PROFESSION_TO_BUSINESS_ID).filter(([, id]) => !(Object.prototype.hasOwnProperty.call(BC.FROM_BUSINESS_ID, id) && BC.FROM_BUSINESS_ID[id]));
    ck('N-1', bad.length === 0 && PI.businessIdForProfession('Network Engineer') === 'networking' && PI.businessIdForProfession('Electrician') === 'electrical' && PI.businessIdForProfession('Doctor') === null,
      'every job-title mapping is an existing, classified intake id; regulated titles (Doctor) are not mapped here', bad);
  }

  /* N-2 a new "Network Engineer" publishes → closed registry row + a pending application in the ONE queue, no claim */
  H.reset();
  DOCS.set('providerProfiles/n1', draftFor('Network Engineer'));
  DOCS.set('users/n1', { displayName: 'Net Pro' });
  let r = await call(PO.providerPublish, 'n1', {});
  const p = DOCS.get('providers/n1') || {}, a = DOCS.get('applications/n1--provider') || {};
  ck('N-2', !!r.ok && p.status === 'pending_approval' && p.searchable === false && p.acceptsBookings === false
    && a.status === 'pending' && a.role === 'provider' && a.category === 'networking' && a.profession === 'Network Engineer' && !(H.CLAIMS.get('n1') || {}).provider,
    'publishing creates the registry row CLOSED and a pending provider application (category networking) — no claim, nothing public',
    r.code ? r : { status: p.status, searchable: p.searchable, app: { status: a.status, category: a.category, profession: a.profession } });

  /* N-3 AdminOS approves → capabilities come from that application (category stamp itself = sokoni-5b) */
  r = await call((req) => LC.applicationDecide.run(req), 'admin1', { applicationId: 'n1--provider', decision: 'approve' }, { admin: true });
  const p3 = DOCS.get('providers/n1') || {}, a3 = DOCS.get('applications/n1--provider') || {};
  const caps = SC.compose([{ id: 'n1--provider', app: a3, valid: a3.status === 'approved' }]).capabilities;
  ck('N-3', !!r.ok && ['active', 'approved'].includes(p3.status) && caps.includes('NETWORKING') && caps.includes('QUOTE_REQUEST'),
    'AdminOS approval activates the provider and the approved application yields the networking capabilities', { r: r.code || 'ok', status: p3.status, caps });

  /* N-4 re-publish by the approved provider: state + real counters untouched, the decided application not reopened */
  DOCS.set('providers/n1', Object.assign(DOCS.get('providers/n1'), { rating: 4.6, reviewCount: 12, jobsCompleted: 30 }));
  r = await call(PO.providerPublish, 'n1', {});
  const p4 = DOCS.get('providers/n1') || {}, a4 = DOCS.get('applications/n1--provider') || {};
  ck('N-4', !!r.ok && ['active', 'approved'].includes(p4.status) && p4.rating === 4.6 && p4.reviewCount === 12 && p4.jobsCompleted === 30 && a4.status === 'approved',
    're-publishing keeps the approved state, the REAL rating / reviews / jobs, and the decided application', { status: p4.status, rating: p4.rating, reviews: p4.reviewCount, jobs: p4.jobsCompleted, app: a4.status });

  /* N-5 a suspended provider re-publishes: still suspended, application not reopened */
  await call((req) => LC.applicationDecide.run(req), 'admin1', { applicationId: 'n1--provider', decision: 'suspend', reason: 'test' }, { admin: true });
  r = await call(PO.providerPublish, 'n1', {});
  ck('N-5', (DOCS.get('providers/n1') || {}).status === 'suspended' && (DOCS.get('applications/n1--provider') || {}).status === 'suspended',
    'a SUSPENDED provider cannot publish its way back, and its application stays suspended', { r: r.code || 'ok', p: (DOCS.get('providers/n1') || {}).status, a: (DOCS.get('applications/n1--provider') || {}).status });

  /* N-6 an unmapped title still enters the queue, labelled, with no invented category */
  H.reset();
  DOCS.set('providerProfiles/n2', draftFor('Data Analyst'));
  r = await call(PO.providerPublish, 'n2', {});
  const a6 = DOCS.get('applications/n2--provider') || {};
  ck('N-6', !!r.ok && a6.status === 'pending' && a6.category === '' && a6.profession === 'Data Analyst',
    'a title with no exact intake id still reaches AdminOS (profession recorded), with no invented category', r.code ? r : a6);
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
