#!/usr/bin/env node
/* test-r3-classification-manifest.js — the R3 planner classifies from APPROVAL EVIDENCE only, and separates its outputs.
 *
 * PROVES (pure, no store)
 *   evidence     the category comes from the APPROVED APPLICATION through the real C1 classifier; providers.category /
 *                categoryLabel text is NEVER used — a provider whose text says "tailor" but whose approved application
 *                says "cleaning" is classified cleaning
 *   eligibility  refused (UNRESOLVED, reason named): provider not live by evidence (status only) · no approved application ·
 *                two approved applications · uid mismatch · sourceApplicationId mismatch · no decider · C1 no exact match ·
 *                already stamped · healthcare-owned
 *   separation   an identity whose stamp would make the resolver CONFLICT (products-lane category × SERVICES) goes to the
 *                DISAGREEMENT set, never the primary set; the two digests differ
 *   mutation     the proposed write is exactly projectProvider's stamp shape on providers/{uid}.business — no
 *                capabilities, no businesses write, no shop, no PRODUCTS — plus one audit record naming the evidence
 *   expected     the post-R2 route is computed from lane × capability (services+SERVICES → the category's route)
 *   digest       stable for the same rows; changes when a mutation changes
 *
 *   node scripts/test-r3-classification-manifest.js
 */
'use strict';
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const R3 = require(Path.join(ROOT, 'scripts', 'r3-classification-manifest.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const APP = (over) => Object.assign({ __id: 'app1', uid: 'u1', role: 'provider', status: 'approved', statusCanonical: 'approved', category: 'cleaning', categoryLabel: 'Cleaning', hub: 'service', decidedBy: 'admin_1', decidedAt: '2026-09-03T00:00:00Z' }, over || {});
const PROV = (over) => Object.assign({ __id: 'u1', name: 'P', status: 'active', approvedAt: 1, category: 'tailor', categoryLabel: 'Tailor', sourceApplicationId: 'app1' }, over || {});
const S = (over) => Object.assign({ uid: 'u1', provider: PROV(), seller: null, business: null, applications: [APP()], productCount: 0 }, over || {});

console.log('\n── evidence: the approved application, never the provider text ──');
let r = R3.classify(S());
ck('provider text "tailor" vs approved application "cleaning" → C1 cleaning (from the application), eligible, primary', r.eligible && !r.disagreement && r.mutation.set.business.category === 'cleaning' && r.evidence.c1.reason === 'exact', { cat: r.mutation && r.mutation.set.business.category, reasons: r.reasons });
ck('the mutation is exactly projectProvider\'s stamp shape: business { category, lane, source: application, applicationId, setAt }', JSON.stringify(Object.keys(r.mutation.set.business).sort()) === JSON.stringify(['applicationId', 'category', 'lane', 'setAt', 'source']) && r.mutation.set.business.source === 'application' && r.mutation.set.business.applicationId === 'app1' && r.mutation.set.business.lane && 'hub' in r.mutation.set.business.lane);
ck('the mutation touches ONLY providers/{uid}.business — no capabilities, no businesses/shops/sellers, no PRODUCTS', r.mutation.path === 'providers/u1' && Object.keys(r.mutation.set).join() === 'business' && !JSON.stringify(r.mutation).includes('capabilities') && !JSON.stringify(r.mutation).includes('PRODUCTS'));
ck('the audit names the evidence (application id, decider, decision time, C1 reason)', /app1/.test(r.mutation.audit.evidence) && /admin_1/.test(r.mutation.audit.evidence) && /exact/.test(r.mutation.audit.evidence));
ck('expected post-R2 route: services lane + SERVICES → the category\'s route (provider-dashboard), AVAILABLE', r.expected.lane === 'services' && r.expected.route === 'provider-dashboard.html' && r.expected.state === 'AVAILABLE', r.expected);

console.log('\n── eligibility: every refusal is named ──');
const R = (over) => R3.classify(S(over)).reasons;
ck('provider live by status alone → provider_not_live_by_evidence', R({ provider: PROV({ approvedAt: undefined }) }).includes('provider_not_live_by_evidence'));
ck('no approved application → no_approved_application', R({ applications: [APP({ status: 'pending', statusCanonical: 'pending' })] }).includes('no_approved_application'));
ck('two approved applications → multiple_approved_applications', R({ applications: [APP(), APP({ __id: 'app2' })] }).some((x) => x.startsWith('multiple_approved_applications')));
ck('application for another uid → application_uid_mismatch', R({ applications: [APP({ uid: 'zz' })] }).includes('application_uid_mismatch'));
ck('provider.sourceApplicationId naming another application → provider_source_application_mismatch', R({ provider: PROV({ sourceApplicationId: 'other' }) }).includes('provider_source_application_mismatch'));
ck('no decider → application_without_decider', R({ applications: [APP({ decidedBy: null })] }).includes('application_without_decider'));
ck('C1 has no exact match ("Service Provider") → c1_cannot_classify, UNRESOLVED', R({ applications: [APP({ category: 'Service Provider', categoryLabel: 'Service Provider' })] }).some((x) => x.startsWith('c1_cannot_classify')));
ck('already stamped → already_stamped (idempotent skip)', R({ provider: PROV({ business: { category: 'cleaning', source: 'application' } }) }).some((x) => x.startsWith('already_stamped')));
ck('healthcare-owned provider → healthcare_authority_owns_it', R({ provider: PROV({ healthcare: { category: 'facility', source: 'admin' } }) }).includes('healthcare_authority_owns_it'));
ck('an UNRESOLVED identity carries no mutation', R3.classify(S({ applications: [] })).mutation === null);

console.log('\n── separation: disagreement never enters the primary set ──');
const dg = R3.classify(S({ uid: 'dg', provider: PROV({ __id: 'dg', name: 'DG', category: 'wholesaler', sourceApplicationId: 'appdg' }), business: { capabilities: { version: 1, SERVICES: { state: 'approved', decidedBy: 'a', decidedAt: 1, applicationId: 'appdg', source: 'application_approval' } } }, applications: [APP({ __id: 'appdg', uid: 'dg', category: 'wholesaler' })] }));
ck('DG Wine shape: approved application "wholesaler" → C1 wholesale (products lane), capability SERVICES/STAMPED → eligible by evidence BUT disagreement', dg.eligible && dg.disagreement && dg.mutation.set.business.category === 'wholesale' && dg.current.capability === 'SERVICES' && dg.current.authorityStatus === 'STAMPED', { cat: dg.mutation && dg.mutation.set.business.category, exp: dg.expected });
ck('   its expected post-R2 state is CAPABILITY_CONFLICT (CATEGORY_CAPABILITY_DISAGREEMENT products/SERVICES), no route', /DISAGREEMENT products\/SERVICES/.test(dg.expected.state) && dg.expected.route === null);
const m = R3.buildManifests([S(), S({ uid: 'dg', provider: PROV({ __id: 'dg', category: 'wholesaler', sourceApplicationId: 'appdg' }), business: { capabilities: { version: 1, SERVICES: { state: 'approved', decidedBy: 'a', decidedAt: 1, applicationId: 'appdg', source: 'application_approval' } } }, applications: [APP({ __id: 'appdg', uid: 'dg', category: 'wholesaler' })] }), S({ uid: 'u3', provider: PROV({ __id: 'u3', approvedAt: undefined }), applications: [] })]);
ck('buildManifests: 1 primary, 1 disagreement, 1 unresolved; the two digests differ', m.primary.length === 1 && m.disagree.length === 1 && m.unresolved.length === 1 && m.digests.primary !== m.digests.disagreement);
ck('no identity appears in two sets', new Set([...m.primary, ...m.disagree, ...m.unresolved].map((x) => x.uid)).size === 3);

console.log('\n── digest ──');
const d1 = R3.digestOf(m.primary), d2 = R3.digestOf(R3.buildManifests([S()]).primary);
ck('the digest is stable for the same rows', d1 === d2);
const changed = R3.buildManifests([S({ applications: [APP({ category: 'plumbing' })] })]).primary;
ck('the digest changes when a mutation changes (plumbing → trades)', changed[0].mutation.set.business.category === 'trades' && R3.digestOf(changed) !== d1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
