#!/usr/bin/env node
/* LEGAL HUB L1 + L2 — ONE taxonomy; lawyer vs law-firm applications; self-service profile; NEEDS-INFO resubmit.
 * Executes the REAL legal-hub.js callables + legalDispatch ops on an in-memory Firestore.
 *   node scripts/test-legal-profile.js        BASE=<ref> node scripts/test-legal-profile.js (pre-L1 must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = process.env.FN_DIR || path.join(ROOT, 'functions'), TREE = ROOT;
if (process.env.BASE) {
  TREE = fs.mkdtempSync(path.join(os.tmpdir(), 'lgp-'));
  cp.execSync('git archive ' + process.env.BASE + ' | tar -x -C "' + TREE.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(TREE, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const { DOCS } = H;
const run = (exp) => (r) => exp.run(r);
console.log('\nLegal Hub L1/L2 — taxonomy, lawyer vs firm, profile   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const BRIEF = {
  individuals: ['Family Law', 'Employment Law', 'Wills & Succession', 'Civil Matters', 'Debt Recovery'],
  businesses: ['Company Registration', 'Contracts & Agreements', 'Employment Policies', 'Regulatory Compliance', 'Intellectual Property'],
  'property-land': ['Title Search', 'Sale & Purchase Agreements', 'Leases & Tenancies', 'Land Disputes', 'Property Due Diligence'],
  'dispute-resolution': ['Mediation', 'Arbitration', 'Negotiation', 'Settlement Support', 'Litigation Support'],
  documents: ['NDAs', 'Power of Attorney', 'Contracts', 'Affidavits', 'Custom Documents'],
  'startups-sme': ['Business Structure', 'Shareholder Agreements', 'Term Sheets', 'Legal Advisory', 'Growth Support'],
};
const eligibleVerification = () => ({
  admin: { status: 'approved' },
  lsk: { status: 'verified', practiceStatus: 'Active', source: 'lsk_official_source_manual', checkedAtMs: Date.now() - 86400000, validUntilMs: Date.now() + 90 * 86400000 },
  providerLink: { status: 'linked' },
});

(async () => {
  let TAX = null, LH = null, LD = null, err = null;
  try { TAX = require(path.join(FN, 'shared', 'legal-taxonomy.js')); } catch (e) { err = e.message; }
  if (!TAX) { ck('T-0', false, 'functions/shared/legal-taxonomy.js loads', err); return done(); }
  LH = require(path.join(FN, 'legal-hub.js'));
  LD = require(path.join(FN, 'legal-dispatch.js'));
  const D = (op, uid, data) => call(run(LD.legalDispatch), uid, Object.assign({ op }, data || {}));

  /* ── T: taxonomy ── */
  const ids = TAX.AREA_IDS;
  const exact = TAX.GROUPS.length === 6 && TAX.GROUPS.every((g) => JSON.stringify(g.services.map((s) => s.label)) === JSON.stringify(BRIEF[g.id]));
  ck('T1', exact && ids.length === 30 && new Set(ids).size === 30, 'six groups × five services, labels exactly as the owner brief, 30 unique ids', TAX.GROUPS.map((g) => g.id));
  let fresh = null; try { cp.execSync('node scripts/build-legal-taxonomy.js --check', { cwd: TREE, stdio: 'pipe' }); fresh = true; } catch (_) { fresh = false; }
  let browserSame = false;
  try {
    const vm = require('vm'); const w = {}; const c = { window: w }; vm.createContext(c);
    vm.runInContext(fs.readFileSync(path.join(TREE, 'sokoni-legal-taxonomy.js'), 'utf8'), c);
    browserSame = JSON.stringify(Object.keys(w.SokoniLegalTaxonomy.AREA).sort()) === JSON.stringify(ids.slice().sort())
      && w.SokoniLegalTaxonomy.label('term-sheets') === 'Term Sheets' && w.SokoniLegalTaxonomy.groupOf('arbitration') === 'dispute-resolution';
  } catch (_) { browserSame = false; }
  ck('T2', fresh && browserSame, 'generated browser copy sokoni-legal-taxonomy.js is current and carries the same 30 ids (one source)');
  ck('T3', TAX.LEGACY_TO_AREA.family_law === 'family-law' && TAX.LEGACY_TO_AREA.criminal_law === null && TAX.LEGACY_TO_AREA.immigration === null
    && JSON.stringify(TAX.areasOfProfile({ specializations: ['family_law', 'criminal_law', 'litigation'] })) === JSON.stringify(['family-law', 'litigation-support'])
    && JSON.stringify(TAX.normalizeAreas(['term-sheets', 'bogus', 'TERM-SHEETS', 'mediation'])) === JSON.stringify(['term-sheets', 'mediation']),
    'legacy specialisations map one-to-one only (criminal/immigration → nothing, never a guess); unknown ids dropped');

  /* ── R: registration ── */
  H.reset();
  let r = await call(run(LH.registerLegalProvider), 'adv1', { name: 'Wanjiru K.', licenseNumber: 'P.105/1234/15', practiceAreas: ['family-law', 'wills-succession'], county: 'Nairobi', consultationFee: 3000, status: 'active', verification: { admin: { status: 'approved' } } });
  const p1 = DOCS.get('legalProviders/adv1') || {}, a1 = DOCS.get('applications/legal_adv1') || {};
  ck('R1', r.ok && p1.entityType === 'advocate' && JSON.stringify(p1.practiceAreas) === JSON.stringify(['family-law', 'wills-succession'])
    && a1.applicationType === 'lawyer' && a1.legalEntityType === 'advocate' && JSON.stringify(a1.practiceGroups) === JSON.stringify(['individuals']),
    'LAWYER application: entityType advocate, canonical practiceAreas, AdminOS item typed "lawyer" with groups', { r, p1, a1 });
  ck('R5', p1.status === 'pending_review' && p1.verification && p1.verification.admin.status === 'pending',
    'a registrant cannot self-set status/verification (sent active/approved → stored pending_review/pending)', p1.status);
  r = await call(run(LH.registerLegalProvider), 'firm1', { entityType: 'firm', name: 'Otieno A. (managing partner)', licenseNumber: 'P.105/9/02', firmName: 'Otieno & Co Advocates',
    firmRegistrationNumber: 'BN-123', firmDescription: 'Commercial practice', offices: [{ name: 'HQ', county: 'Nairobi', address: 'Upper Hill' }], team: [{ name: 'B. Mutua', lskNumber: 'P.105/2/19', role: 'Associate' }],
    practiceAreas: ['company-registration', 'term-sheets'] });
  const p2 = DOCS.get('legalProviders/firm1') || {}, a2 = DOCS.get('applications/legal_firm1') || {};
  ck('R2', r.ok && p2.entityType === 'firm' && p2.firm && p2.firm.offices.length === 1 && p2.firm.teamDeclared.length === 1 && p2.firm.teamVerified === false
    && a2.applicationType === 'law_firm' && JSON.stringify(a2.practiceGroups) === JSON.stringify(['businesses', 'startups-sme']),
    'LAW-FIRM application: organisation schema (registration no., offices, declared team NOT verified), AdminOS item typed "law_firm"', { r, p2, a2 });
  r = await call(run(LH.registerLegalProvider), 'firm2', { entityType: 'firm', name: 'X', licenseNumber: 'P.105/1/1', practiceAreas: ['mediation'] });
  const r3a = r;
  r = await call(run(LH.registerLegalProvider), 'x2', { entityType: 'company', name: 'X', licenseNumber: 'P', practiceAreas: ['mediation'] });
  const r3b = r;
  r = await call(run(LH.registerLegalProvider), 'x3', { name: 'X', licenseNumber: 'P', practiceAreas: ['bogus'] });
  ck('R3', r3a.code === 'invalid-argument' && r3b.code === 'invalid-argument' && r.code === 'invalid-argument' && !DOCS.has('legalProviders/firm2') && !DOCS.has('legalProviders/x3'),
    'firm without firmName, unknown entityType, only-unknown areas → refused, nothing written', [r3a.code, r3b.code, r.code]);
  r = await call(run(LH.registerLegalProvider), 'old1', { name: 'Legacy client', licenseNumber: 'P.105/7/07', specializations: ['conveyancing'] });
  ck('R4', r.ok && JSON.stringify((DOCS.get('legalProviders/old1') || {}).specializations) === JSON.stringify(['conveyancing']), 'older clients sending legacy specializations still register (backward compatible)', r);

  /* ── P: public directory ── */
  DOCS.set('legalProviders/adv1', Object.assign({}, DOCS.get('legalProviders/adv1'), { status: 'active', verification: eligibleVerification() }));
  DOCS.set('legalProviders/firm1', Object.assign({}, DOCS.get('legalProviders/firm1'), { status: 'active', verification: eligibleVerification() }));
  DOCS.set('legalProviders/fake', { providerId: 'fake', uid: 'fake', name: 'Self-activated', status: 'active', practiceAreas: ['family-law'], verification: { admin: { status: 'pending' } } });
  const list = async (q) => { const x = await call(run(LH.getLegalProviders), null, q || {}); return x.ok ? x.ok.providers.map((p) => p.providerId).sort() : x; };
  const all = await list(), fam = await list({ practiceArea: 'family-law' }), biz = await list({ practiceGroup: 'startups-sme' }), firms = await list({ entityType: 'firm' }), bad = await list({ practiceArea: 'bogus' });
  ck('P1', JSON.stringify(all) === JSON.stringify(['adv1', 'firm1']) && JSON.stringify(fam) === JSON.stringify(['adv1']) && JSON.stringify(biz) === JSON.stringify(['firm1'])
    && JSON.stringify(firms) === JSON.stringify(['firm1']) && JSON.stringify(bad) === JSON.stringify([]),
    'directory lists only eligible providers (status:active alone is not enough); area / group / entity filters; unknown area → nothing, not everyone', { all, fam, biz, firms, bad });
  const pub = (await call(run(LH.getLegalProviders), null, {})).ok.providers.find((p) => p.providerId === 'adv1');
  ck('P2', pub && pub.rating === null && pub.ratingCount === 0 && pub.entityType === 'advocate' && pub.licenseNumber === undefined && pub.phone === undefined,
    'unrated advocate shows NO rating (null, never 0 or a default 5); public view carries no licence number or phone', pub);

  /* ── U: self-service profile + NEEDS INFORMATION ── */
  r = await D('legalUpdateProfile', 'adv1', { bio: 'Family & succession practice', practiceAreas: ['family-law', 'civil-matters'], consultationFee: 3500 });
  const u1 = DOCS.get('legalProviders/adv1');
  ck('U1', r.ok && u1.bio === 'Family & succession practice' && JSON.stringify(u1.practiceAreas) === JSON.stringify(['family-law', 'civil-matters']) && u1.consultationFee === 3500,
    'lawyer edits bio / practice areas / fee through legalDispatch', r);
  const before = JSON.stringify(DOCS.get('legalProviders/adv1'));
  const pr1 = await D('legalUpdateProfile', 'adv1', { name: 'Someone Else', bio: 'x' });
  const pr2 = await D('legalUpdateProfile', 'adv1', { licenseNumber: 'P.105/0/0' });
  const pr3 = await D('legalUpdateProfile', 'adv1', { verification: { admin: { status: 'approved' } } });
  ck('U2', [pr1, pr2, pr3].every((x) => x.code === 'failed-precondition' && x.det && x.det.code === 'LEGAL_PROTECTED_FIELD') && JSON.stringify(DOCS.get('legalProviders/adv1')) === before,
    'verified identity (name, licence) and server state (verification) cannot be self-edited; the refused call changes NOTHING', [pr1.code, pr2.code, pr3.code]);
  const rs0 = await D('legalResubmitApplication', 'firm1', { note: 'here' });
  DOCS.set('applications/legal_firm1', Object.assign({}, DOCS.get('applications/legal_firm1'), { status: 'info_requested', reviewReason: 'Upload CR12' }));
  const mine = await D('legalMyProfile', 'firm1', {});
  const rs1 = await D('legalResubmitApplication', 'firm1', { note: 'CR12 attached', offices: [{ name: 'HQ', county: 'Nairobi', address: 'Upper Hill, 5th floor' }], status: 'approved' });
  const rs2 = await D('legalResubmitApplication', 'firm1', { note: 'CR12 attached', offices: [{ name: 'HQ', county: 'Nairobi', address: 'Upper Hill, 5th floor' }] });
  const a2b = DOCS.get('applications/legal_firm1');
  ck('U3', rs0.det && rs0.det.code === 'NOT_INFO_REQUESTED' && mine.ok && mine.ok.application.status === 'info_requested' && mine.ok.application.reviewReason === 'Upload CR12' && mine.ok.application.type === 'law_firm'
    && rs1.code === 'failed-precondition' && rs2.ok && a2b.status === 'pending' && a2b.applicantResponse === 'CR12 attached'
    && DOCS.get('legalProviders/firm1').firm.offices[0].address === 'Upper Hill, 5th floor',
    'NEEDS INFORMATION: applicant sees the reviewer reason, resubmits once asked (and only then); it returns to "pending" — never approved by the applicant', { rs0: rs0.det, rs1: rs1.code, a2b: a2b.status });
  const agreements = Object.keys(require(path.join(FN, 'legal-agreements.js'))._h), hub = Object.keys(LH._h || {});
  ck('D1', hub.length >= 4 && hub.every((k) => agreements.indexOf(k) < 0) && mine.ok && mine.ok.editable.indexOf('offices') > -1,
    'profile ops are routed by the EXISTING legalDispatch (no new Cloud Function); no name clash with agreement ops', hub);
  done();
})().catch((e) => { console.log('CRASH (fail closed): ' + (e && e.stack || e)); process.exit(2); });

function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); console.log('NOT proven here: rules/emulator, browser, a real AdminOS decision on a firm application.'); process.exit(fail ? 1 : 0); }
