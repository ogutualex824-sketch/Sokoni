#!/usr/bin/env node
/* MARKETING HUB MK1 + MK2 — ONE taxonomy; three SEPARATE application types; the shared AdminOS review with PARTIAL
 * category approval; a rejected marketing application never touches the applicant's other services; a directory that is
 * a filtered view of approved marketers only.
 * Executes the REAL marketing-hub.js ops + application-lifecycle.js applicationDecide/applicationList on an in-memory
 * Firestore.
 *   node scripts/test-marketing-hub.js              this tree
 *   SABOTAGE=1 node scripts/test-marketing-hub.js   every mutation must turn its named row FAIL */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  /* [row, file, find, replace] — each removes ONE control; the named row must FAIL. */
  const M = [
    ['D2', 'application-lifecycle.js', 'if (outside.length) throw', 'if (false) throw'],
    ['D4', 'application-lifecycle.js', 'marketingCategories: approvedCats,', 'marketingCategories: requested,'],
    /* R1 / R2 anchors follow the ONE applicant-type registry (5b, 2026-10-03): the marketing entry's projection + role rule */
    ['R1', 'application-lifecycle.js', "project: () => (db, app, uid, approved, status) => projectMarketing(db, app, uid, approved, status),", "project: () => null,"],
    ['R2', 'application-lifecycle.js', "grantsRole: (m, approved) => approved,", 'grantsRole: () => true,'],
    ['L1', 'marketing-hub.js', 'uid: id, name: _s(p.name, 160),', 'uid: id, phone: p.phone, name: _s(p.name, 160),'],
    ['A2', 'shared/marketing-taxonomy.js', "specialist: { label: 'Specialist (one service)', minCategories: 1, maxCategories: 1 }", "specialist: { label: 'Specialist (one service)', minCategories: 1, maxCategories: 12 }"],
    ['A6', 'marketing-hub.js', 'if (c && LIVE.indexOf(st) >= 0) throw', 'if (false) throw'],
    /* S1 removes BOTH layers (retraction empties the categories AND the card filter checks listed/status). */
    ['S1', 'marketing-hub.js', "p.marketingListed === true && p.marketingStatus === 'active' &&", 'true &&',
      'application-lifecycle.js', 'marketingCategories: [], marketingGroups: [],\n      marketingListed: false,', 'marketingListed: false,'],
    ['A7', 'marketing-hub.js', "status: 'pending', reviewStage: 'submitted',", "status: d.status || 'pending', reviewStage: 'submitted',"],
    ['O1', 'marketing-hub.js', 'async marketingAdminOverview(req) {\n    _admin(req);', 'async marketingAdminOverview(req) {'],
  ];
  let caught = 0;
  for (const [row, file, a, b, file2, a2, b2] of M) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkts-'));
    const FN = path.join(tmp, 'functions');
    fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (fs.statSync(p).isFile() && f.endsWith('.js')) fs.copyFileSync(p, path.join(FN, f)); }
    for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
    const target = path.join(FN, file);
    const src = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (src.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor not unique/absent in ' + file); continue; }
    fs.writeFileSync(target, src.replace(a, () => b));
    if (file2) {
      const t2 = path.join(FN, file2), s2 = fs.readFileSync(t2, 'utf8').replace(/\r\n/g, '\n');
      if (s2.split(a2).length !== 2) { console.log('  BROKEN ' + row + ' second anchor not unique/absent in ' + file2); continue; }
      fs.writeFileSync(t2, s2.replace(a2, () => b2));
    }
    let out = '';
    try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: FN, TREE_DIR: ROOT }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out);
    console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row + '  (' + file + ')');
    if (hit) caught++;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
  process.exit(caught === M.length ? 0 : 1);
}

const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const FN = process.env.FN_DIR || path.join(ROOT, 'functions');
const TREE = process.env.TREE_DIR || ROOT;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const { DOCS, CLAIMS } = H;
const ADM = { admin: true };
let nBlocked = 0;
const blocked = (id, why) => { console.log('  BLOCKED ' + id + ' ' + why); nBlocked++; };
const done = () => { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed' + (nBlocked ? ', ' + nBlocked + ' BLOCKED' : '')); process.exit(fail ? 1 : nBlocked ? 2 : 0); };
console.log('\nMarketing Hub MK1/MK2 — taxonomy, application types, partial approval, directory\n');

const OWNER_GROUPS = ['strategy', 'digital', 'content', 'creative', 'media', 'advertising', 'pr', 'creator', 'events', 'growth'];
const BASE_APP = { name: 'Achieng Creative', description: 'Brand identity and social campaigns for Nairobi SMEs since 2019.', county: 'Nairobi', phone: '0712345678', portfolio: ['https://example.com/work', 'javascript:alert(1)'] };

(async () => {
  const TAX = require(path.join(FN, 'shared', 'marketing-taxonomy.js'));
  const MH = require(path.join(FN, 'marketing-hub.js'));
  const AL = require(path.join(FN, 'application-lifecycle.js'));
  const D = (op, uid, data, token) => call((r) => MH.marketingDispatch.run(r), uid, Object.assign({ op }, data || {}), token);
  const decide = (uid, data, token) => call((r) => AL.applicationDecide.run(r), uid, data, token);

  /* ── T: taxonomy ── */
  const ids = TAX.AREA_IDS;
  ck('T1', JSON.stringify(TAX.GROUPS.map((g) => g.id)) === JSON.stringify(OWNER_GROUPS) && new Set(ids).size === ids.length && ids.length >= 60
    && ids.every((i) => TAX.MODELS.indexOf(TAX.AREA[i].model) >= 0), 'ten owner groups in order, unique service ids, every service has a buy model (booking | quote | project)', TAX.GROUPS.map((g) => g.id));
  let fresh = false; try { cp.execSync('node scripts/build-marketing-taxonomy.js --check', { cwd: TREE, stdio: 'pipe' }); fresh = true; } catch (_) { fresh = false; }
  let same = false;
  try { const vm = require('vm'); const w = {}; const c = { window: w }; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(TREE, 'sokoni-marketing-taxonomy.js'), 'utf8'), c);
    same = JSON.stringify(Object.keys(w.SokoniMarketingTaxonomy.AREA).sort()) === JSON.stringify(ids.slice().sort()) && w.SokoniMarketingTaxonomy.groupOf('seo') === 'digital'; } catch (_) { same = false; }
  ck('T2', fresh && same, 'generated browser copy sokoni-marketing-taxonomy.js is current and carries the same ids (one source)');
  ck('T3', TAX.LEGACY_TO_AREA.printing === null && TAX.LEGACY_TO_AREA['pr-firm'] === 'public-relations'
    && JSON.stringify(TAX.normalizeCategories(['SEO', 'bogus', 'seo', 'branding'])) === JSON.stringify(['seo', 'branding']),
    'legacy HubRegister rows map one-to-one (printing → nothing); unknown ids dropped, duplicates collapsed');

  /* ── A: application intake ── */
  H.reset();
  let r = await D('marketingApply', null, Object.assign({ marketingType: 'individual', categories: ['seo'] }, BASE_APP));
  ck('A0', r.code === 'unauthenticated', 'anonymous apply refused', r);
  r = await D('marketingApply', 'u1', Object.assign({ marketingType: 'individual', categories: ['branding', 'seo', 'logo-design'], status: 'approved', marketingApprovedCategories: ['branding'] }, BASE_APP));
  const a1 = DOCS.get('applications/marketing_u1') || {};
  ck('A1', r.ok && a1.hub === 'marketing' && a1.applicationType === 'marketing' && a1.marketingType === 'individual' && a1.requestedRole === 'provider'
    && JSON.stringify(a1.requestedCategories) === JSON.stringify(['branding', 'seo', 'logo-design']) && JSON.stringify(a1.requestedGroups) === JSON.stringify(['creative', 'digital'])
    && a1.phone === '+254712345678' && JSON.stringify(a1.portfolio) === JSON.stringify(['https://example.com/work']),
    'INDIVIDUAL application → applications/marketing_{uid}, typed, canonical categories + groups, E.164 phone, https-only portfolio', a1);
  ck('A7', a1.status === 'pending' && a1.marketingApprovedCategories === undefined, 'applicant cannot self-approve (sent status approved + approved categories → stored pending, none approved)', a1.status);
  r = await D('marketingApply', 'u3', Object.assign({ marketingType: 'specialist', categories: ['seo', 'branding'] }, BASE_APP));
  ck('A2', r.code === 'invalid-argument' && r.det && r.det.code === 'MKT_TOO_MANY', 'SPECIALIST is one service only (two → MKT_TOO_MANY)', r);
  r = await D('marketingApply', 'u4', Object.assign({ marketingType: 'agency', categories: ['seo'], teamSize: 8 }, BASE_APP));
  ck('A3', r.code === 'invalid-argument' && r.det && r.det.code === 'MKT_REG', 'AGENCY requires a business registration number', r);
  r = await D('marketingApply', 'u4', Object.assign({ marketingType: 'business', categories: ['seo'] }, BASE_APP));
  const r2 = await D('marketingApply', 'u4', Object.assign({ marketingType: 'individual', categories: ['not-a-thing'] }, BASE_APP));
  ck('A4', r.det && r.det.code === 'MKT_TYPE' && r2.det && r2.det.code === 'MKT_NO_CATEGORY', 'unknown type → MKT_TYPE; only unknown categories → MKT_NO_CATEGORY', [r, r2]);
  r = await D('marketingApply', 'u4', Object.assign({ marketingType: 'agency', categories: ['seo', 'public-relations'], teamSize: 8, registrationNumber: 'PVT-123' }, BASE_APP));
  ck('A5', r.ok && (DOCS.get('applications/marketing_u4') || {}).agency && DOCS.get('applications/marketing_u4').agency.teamSize === 8, 'AGENCY application carries its agency block', DOCS.get('applications/marketing_u4'));
  r = await D('marketingApply', 'u1', Object.assign({ marketingType: 'individual', categories: ['seo'] }, BASE_APP));
  ck('A6', r.code === 'already-exists' && r.det && r.det.code === 'MKT_LIVE', 'a second application while one is under review is refused', r);

  /* ── X: AdminOS sees it ── */
  r = await call((q) => AL.applicationList.run(q), 'admin1', {}, ADM);
  const li = r.ok ? r.ok.items.find((i) => i.id === 'marketing_u1') : null;
  ck('X1', li && li.hub === 'marketing' && li.marketingType === 'individual' && li.requestedCategories.length === 3 && li.status === 'pending',
    'the shared AdminOS application list shows the marketing application with its type and requested categories', li);

  /* ── D: decision with partial approval ── */
  r = await decide('u1', { applicationId: 'marketing_u1', decision: 'approve', approvedCategories: ['branding'] }, {});
  ck('D3', r.code === 'permission-denied', 'a non-admin cannot decide', r);
  r = await decide('admin1', { applicationId: 'marketing_u1', decision: 'approve' }, ADM);
  ck('D1', r.det && r.det.code === 'MKT_NO_CATEGORY' && (DOCS.get('applications/marketing_u1') || {}).status === 'pending', 'approval without choosing categories is refused (nothing activates by default)', r);
  r = await decide('admin1', { applicationId: 'marketing_u1', decision: 'approve', approvedCategories: ['branding', 'tv-advertising'] }, ADM);
  ck('D2', r.det && r.det.code === 'MKT_CATEGORY_NOT_REQUESTED', 'an admin cannot approve a category the applicant never requested', r);
  r = await decide('admin1', { applicationId: 'marketing_u1', decision: 'approve', approvedCategories: ['branding', 'logo-design'] }, ADM);
  const p1 = DOCS.get('providers/u1') || {}, a1b = DOCS.get('applications/marketing_u1') || {};
  ck('D4', r.ok && p1.marketingStatus === 'active' && p1.marketingListed === true && JSON.stringify(p1.marketingCategories) === JSON.stringify(['branding', 'logo-design'])
    && JSON.stringify(p1.marketingGroups) === JSON.stringify(['creative']) && p1.status === 'active' && JSON.stringify(a1b.marketingDeclinedCategories) === JSON.stringify(['seo'])
    && (CLAIMS.get('u1') || {}).provider === true,
    'approval activates ONLY the approved subset (seo declined, recorded), provider record live, provider claim granted', { p1, a1b });

  /* ── L: directory = filtered view of approved marketers ── */
  r = await D('marketingDirectory', null, { category: 'branding' });
  const card = r.ok && r.ok.items[0];
  const rs = await D('marketingDirectory', null, { category: 'seo' });
  ck('L1', card && card.uid === 'u1' && card.phone === undefined && card.email === undefined && rs.ok && rs.ok.items.length === 0,
    'directory lists u1 under an APPROVED category, not under the declined one; the public card carries no phone/email', { card, rs });
  r = await D('marketingProfile', null, { uid: 'u1' });
  const rn = await D('marketingProfile', null, { uid: 'u4' });
  ck('L2', r.ok && r.ok.profile.name === 'Achieng Creative' && rn.code === 'not-found', 'public profile for a listed marketer; an unapproved applicant is not-found', [r, rn]);

  /* ── R: a marketing decision never touches the applicant's other services ── */
  DOCS.set('providers/u2', { uid: 'u2', name: 'Kasindi Cleaning', category: 'cleaning', categories: ['cleaning'], status: 'active', isPublic: true, searchable: true, acceptsBookings: true });
  CLAIMS.set('u2', { provider: true });
  await D('marketingApply', 'u2', Object.assign({ marketingType: 'individual', categories: ['copywriting'] }, BASE_APP));
  r = await decide('admin1', { applicationId: 'marketing_u2', decision: 'reject', reason: 'Portfolio does not show copywriting' }, ADM);
  const p2 = DOCS.get('providers/u2') || {};
  ck('R1', r.ok && p2.status === 'active' && p2.acceptsBookings === true && p2.category === 'cleaning' && p2.marketingStatus === 'rejected' && p2.marketingListed === false,
    'REJECTING a cleaning company\'s marketing application leaves its cleaning listing live; only the marketing block is retracted', p2);
  ck('R2', (CLAIMS.get('u2') || {}).provider === true, 'the rejected marketing application does not strip the existing provider claim', CLAIMS.get('u2'));

  /* ── S: suspension unlists the marketer ── */
  r = await decide('admin1', { applicationId: 'marketing_u1', decision: 'suspend', reason: 'complaint' }, ADM);
  const ls = await D('marketingDirectory', null, { category: 'branding' });
  ck('S1', r.ok && (DOCS.get('providers/u1') || {}).marketingListed === false && ls.ok && ls.ok.items.length === 0, 'a suspended marketer disappears from the directory', ls);

  /* ── W: withdraw / needs-info / resubmit ── */
  r = await D('marketingWithdraw', 'u4');
  let rr = await D('marketingApply', 'u4', Object.assign({ marketingType: 'agency', categories: ['seo'], teamSize: 9, registrationNumber: 'PVT-123' }, BASE_APP));
  ck('W1', r.ok && rr.ok && rr.ok.resubmitted === true && DOCS.get('applications/marketing_u4').status === 'pending', 'withdraw, then resubmit, returns the application to review', [r, rr]);
  await D('marketingApply', 'u5', Object.assign({ marketingType: 'specialist', categories: ['seo'] }, BASE_APP));
  r = await decide('admin1', { applicationId: 'marketing_u5', decision: 'request_info', reason: 'Add an SEO case study' }, ADM);
  const ms = await D('marketingMyStatus', 'u5');
  rr = await D('marketingApply', 'u5', Object.assign({ marketingType: 'specialist', categories: ['seo'], portfolio: ['https://example.com/seo-case'] }, BASE_APP));
  ck('W2', ms.ok && ms.ok.application.status === 'info_requested' && ms.ok.application.reviewReason === 'Add an SEO case study' && rr.ok && rr.ok.resubmitted,
    'NEEDS-INFO: the applicant sees the reviewer\'s request and can resubmit', [ms, rr]);

  /* ── RS: review sub-states on the ONE engine (5b 5fec96f) ── */
  ck('RS1', (DOCS.get('applications/marketing_u5') || {}).reviewStage === 'submitted', 'intake (and resubmission) stamps reviewStage "submitted"', DOCS.get('applications/marketing_u5'));
  r = await decide('admin1', { applicationId: 'marketing_u5', decision: 'mark_under_review' }, ADM);
  const rs2 = await D('marketingMyStatus', 'u5');
  r = await decide('admin1', { applicationId: 'marketing_u5', decision: 'mark_verified' }, ADM);
  const rs3 = await D('marketingMyStatus', 'u5');
  ck('RS2', rs2.ok && rs2.ok.application.reviewStage === 'under_review' && rs3.ok.application.reviewStage === 'verified' && rs3.ok.application.status === 'pending'
    && !(DOCS.get('providers/u5') || {}).marketingListed, 'under review → verified is visible to the applicant; verified is NOT approved (nothing listed)', [rs2, rs3]);
  r = await decide('admin1', { applicationId: 'marketing_u5', decision: 'approve', approvedCategories: ['seo'] }, ADM);
  r = await decide('admin1', { applicationId: 'marketing_u5', decision: 'revoke', reason: 'Fake portfolio confirmed' }, ADM);
  rr = await D('marketingApply', 'u5', Object.assign({ marketingType: 'specialist', categories: ['seo'] }, BASE_APP));
  const rd = await D('marketingDirectory', null, { category: 'seo' });
  ck('RS3', r.ok && (DOCS.get('applications/marketing_u5') || {}).reviewStage === 'revoked' && rr.det && rr.det.code === 'MKT_LOCKED' && rd.ok && rd.ok.items.length === 0,
    'REVOKED is terminal: unlisted, and the applicant cannot resubmit', [r, rr, rd && rd.ok]);

  /* ── M / O: own status, AdminOS overview ── */
  const m1 = await D('marketingMyStatus', 'u1');
  ck('M1', m1.ok && JSON.stringify(m1.ok.application.approvedCategories) === JSON.stringify(['branding', 'logo-design']) && JSON.stringify(m1.ok.application.declinedCategories) === JSON.stringify(['seo'])
    && m1.ok.marketer && m1.ok.marketer.status === 'suspended', 'the marketer sees which categories were approved / declined and the live marketing state', m1);
  r = await D('marketingAdminOverview', 'u1', {}, {});
  const ro = await D('marketingAdminOverview', 'admin1', {}, ADM);
  ck('O1', r.code === 'permission-denied' && ro.ok && ro.ok.items.length === 4 && ro.ok.counts.byType.agency === 1 && ro.ok.counts.byType.specialist === 1,
    'AdminOS Marketing overview: admin-only; every marketing application with its type', [r, ro && ro.ok && ro.ok.counts]);

  /* ── O2–O4: AdminOS review + lists (read-only; the decision stays applicationDecide) ── */
  r = await D('marketingAdminApplication', 'u1', { applicationId: 'marketing_u1' }, {});
  const ra = await D('marketingAdminApplication', 'admin1', { applicationId: 'marketing_u1' }, ADM);
  const rb = await D('marketingAdminApplication', 'admin1', { applicationId: 'applications/../x' }, ADM);
  const A = ra.ok || {};
  ck('O2', r.code === 'permission-denied' && rb.code === 'invalid-argument' && A.application && A.application.marketingType === 'individual'
    && JSON.stringify(A.application.requestedCategories) === JSON.stringify(['branding', 'seo', 'logo-design']) && A.application.portfolio.length === 1
    && A.history.some((h) => /approve/.test(h.action)) && A.history.some((h) => /suspend/.test(h.action)),
    'review view: admin-only; submitted data + requested categories + the immutable audit history (approve → suspend)', { r, rb, A });
  /* The SERVER decision record is written by applicationDecide only on the K13-A lineage (7df7817, live). A tree without
     K13-A cannot pass this row — reported BLOCKED (never PASS) until K13-A is merged into the deploy tree. */
  if (A.decisionRecord && A.decisionRecord.decidedBy === 'admin1') ck('O2r', A.decisionRecord.status === 'suspended', 'the review view shows the SERVER decision record (current = suspended by admin1)', A.decisionRecord);
  else blocked('O2r', 'applicationDecide on this tree writes no applicationDecisions record (K13-A 7df7817 missing) — the review view shows decisionRecord null');
  DOCS.set('providerServices/svcA', { providerId: 'u1', name: 'Logo sprint', category: 'logo-design', serviceGroup: 'creative', hub: 'marketing', price: 1500000, active: true, marketing: { pricingModel: 'fixed', capabilities: { booking: true } } });
  DOCS.set('providerServices/svcB', { providerId: 'u2', name: 'Deep clean', category: 'cleaning', price: 300000, active: true });
  DOCS.set('providerBookings/bkA', { providerId: 'u1', customerUid: 'c1', service: 'Logo sprint', serviceHub: 'marketing', serviceCategory: 'logo-design', price: 1500000, status: 'confirmed', paymentStatus: 'paid_held' });
  DOCS.set('providerBookings/bkB', { providerId: 'u2', customerUid: 'c1', service: 'Deep clean', serviceHub: null, serviceCategory: 'cleaning', price: 300000 });
  const lp = await D('marketingAdminProviders', 'admin1', {}, ADM), ls2 = await D('marketingAdminServices', 'admin1', {}, ADM), lb = await D('marketingAdminBookings', 'admin1', {}, ADM);
  const deny = await Promise.all(['marketingAdminProviders', 'marketingAdminServices', 'marketingAdminBookings'].map((op) => D(op, 'u1', {}, {})));
  ck('O3', deny.every((x) => x.code === 'permission-denied') && lp.ok && lp.ok.items.some((i) => i.uid === 'u1' && i.marketingStatus === 'suspended') && lp.ok.items.some((i) => i.uid === 'u2' && i.marketingStatus === 'rejected')
    && ls2.ok && ls2.ok.items.length === 1 && ls2.ok.items[0].id === 'svcA' && lb.ok && lb.ok.items.length === 1 && lb.ok.items[0].id === 'bkA' && lb.ok.items[0].paymentStatus === 'paid_held',
    'marketers / services / bookings lists: admin-only; ONLY marketing records (a cleaning service or booking never appears)', { lp: lp.ok, ls2: ls2.ok, lb: lb.ok, deny });

  /* ── Z: dispatcher ── */
  r = await D('constructor', 'u1');
  const rz = await D('nope', 'u1');
  ck('Z1', r.code === 'not-found' && rz.code === 'not-found', 'unknown / prototype op names are not routed', [r, rz]);
  done();
})().catch((e) => { console.error(e); ck('CRASH', false, e.message); done(); });
