#!/usr/bin/env node
/* WORK/JOB ENGINE WE2 — milestone money on the canonical booking path. Executes the REAL work-engine.js + provider-ops.js
 * from this tree TOGETHER WITH sokoni-2f's REAL commercial selector (provider-hub.js + commission-config.js @ 0a949db,
 * extracted with git show — not a fixture), in-process on an in-memory Firestore.
 *   node scripts/test-work-milestones.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const COMMERCIAL = process.env.COMMERCIAL_SHA || '0a949db';

function buildTree(mut) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wkm-'));
  const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (f !== 'node_modules' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, f)); }
  for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
  if (!process.env.NO_COMMERCIAL) for (const f of ['provider-hub.js', 'commission-config.js']) {
    fs.writeFileSync(path.join(FN, f), cp.execSync('git show ' + COMMERCIAL + ':functions/' + f, { cwd: ROOT, maxBuffer: 1 << 26 }));
  }
  if (mut) { const [file, a, b] = mut; const t = path.join(FN, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n'); if (s.split(a).length !== 2) return { d, FN, broken: true }; fs.writeFileSync(t, s.replace(a, () => b)); }
  return { d, FN };
}

if (process.env.SABOTAGE) {
  const M = [
    ['M2', 'work-engine.js', "    if (_actor(req, p, false) !== 'customer') throw new HttpsError('permission-denied', 'Only the customer pays a milestone.'", "    if (false) throw new HttpsError('permission-denied', 'Only the customer pays a milestone.'"],
    ['M3', 'work-engine.js', "        if (!dead) return { bookingId: pay.bookingId, resumed: true };", ''],
    ['M4', 'work-engine.js', "        if (b && ['paid_held', 'settled', 'released'].indexOf(b.paymentStatus) >= 0) throw", "        if (false) throw"],
    ['M5', 'provider-ops.js', "  if (data && data.kind === 'work_milestone' && data.paymentStatus === 'paid_held') {", '  if (false) {'],
    ['M6', 'work-engine.js', "    if (rule.refused) throw", '    if (false) throw'],
    ['M1', 'work-engine.js', "        service: _s(m.title, 200) || 'Milestone', price: amount,", "        service: _s(m.title, 200) || 'Milestone', price: Math.round(Number(d.amountCents) || amount),"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const t = buildTree([file, a, b]);
    if (t.broken) { console.log('  BROKEN ' + row + ' anchor in ' + file); fs.rmSync(t.d, { recursive: true, force: true }); continue; }
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: t.FN }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out);
    console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row + '  (' + file + ')'); if (hit) caught++;
    fs.rmSync(t.d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
  process.exit(caught === M.length ? 0 : 1);
}

let tree = null;
const FN = process.env.FN_DIR || (tree = buildTree(null)).FN;
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const done = () => { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); if (tree) fs.rmSync(tree.d, { recursive: true, force: true }); process.exit(fail ? 1 : 0); };
const { DOCS } = H;
console.log('\nWork/Job Engine WE2 — milestone money (with sokoni-2f commercial selector @ ' + COMMERCIAL + ')\n');

(async () => {
  const WE = require(path.join(FN, 'work-engine.js'));
  const PO = require(path.join(FN, 'provider-ops.js'))._h;
  const D = (op, uid, data) => call((r) => WE.workDispatch.run(r), uid, Object.assign({ op }, data || {}));
  if (process.env.NO_COMMERCIAL) {
    /* M8: on a tree WITHOUT sokoni-2f's selector (e.g. this capability line alone) nothing is ever minted */
    H.reset();
    DOCS.set('workProjects/P1', { skin: 'marketing', kind: 'campaign', status: 'active', customerUid: 'cust', providerUid: 'mk', parties: ['mk', 'cust'], scope: { milestones: [{ id: 'm1', title: 'x', amountCents: 2000000, status: 'planned' }] }, history: [] });
    const r8 = await D('workPayMilestone', 'cust', { projectId: 'P1', milestoneId: 'm1' });
    ck('M8', r8.det && r8.det.code === 'WORK_COMMISSION_UNPRICED' && r8.det.reason === 'commission_selector_unavailable' && ![...DOCS.keys()].some((k) => k.startsWith('providerBookings/')),
      'FAIL CLOSED: without the commercial selector on the tree, a milestone payment is refused and nothing is minted', r8);
    return done();
  }
  const PH = require(path.join(FN, 'provider-hub.js'));
  H.reset();
  DOCS.set('providers/mk', { uid: 'mk', status: 'active', marketingStatus: 'active', marketingListed: true, marketingCategories: ['branding'] });
  DOCS.set('applicationDecisions/marketing_mk', { status: 'approved', decidedBy: 'admin1', approvedCategories: ['branding'] });
  ['mk', 'cust', 'x'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
  DOCS.set('workProjects/P1', { skin: 'marketing', kind: 'campaign', status: 'active', customerUid: 'cust', providerUid: 'mk', parties: ['mk', 'cust'], origin: { type: 'direct' },
    scope: { title: 'Campaign', lines: [{ lineId: 'l1', kind: 'other', description: 'x', qty: 1, rateCents: 5000000, amountCents: 5000000 }],
      milestones: [{ id: 'm1', title: 'Month 1', amountCents: 2000000, status: 'planned' }, { id: 'm2', title: 'Month 2', amountCents: 3000000, status: 'planned' }] }, totalCents: 5000000, history: [] });
  DOCS.set('workProjects/P2', { skin: 'events', kind: 'project', status: 'active', customerUid: 'cust', providerUid: 'mk', parties: ['mk', 'cust'], scope: { milestones: [{ id: 'm1', title: 'x', amountCents: 100, status: 'planned' }] }, history: [] });
  const B = (id) => DOCS.get('providerBookings/' + id);

  /* M1: the booking is priced from the LOCKED milestone; stamped lane + catalogue rule snapshot (10% marketing) */
  let r = await D('workPayMilestone', 'cust', { projectId: 'P1', milestoneId: 'm1', amountCents: 1 });
  const id1 = r.ok && r.ok.bookingId, b1 = id1 ? B(id1) : {};
  ck('M1', r.ok && id1 === 'wm_P1_m1_1' && b1.kind === 'work_milestone' && b1.price === 2000000 && b1.fee === 0 && b1.paymentStatus === 'pending' && b1.providerId === 'mk' && b1.customerUid === 'cust'
    && b1.workCommissionCategory === 'marketing_services' && b1.commissionRuleSnapshot.pct === 10 && b1.commissionRuleSnapshot.category === 'marketing_services' && !b1.slotKey && !b1.startTs,
    'pay mints a slot-less providerBookings doc priced from the LOCKED milestone (client amount ignored), stamped marketing_services + the 10% catalogue rule snapshot', b1);
  ck('M1b', PH.commissionArgsForBooking(b1).category === 'marketing_services', 'sokoni-2f\'s settlement selector reads the stamped lane → marketing_services (10%)');

  /* M2: only the customer pays */
  const rp = await D('workPayMilestone', 'mk', { projectId: 'P1', milestoneId: 'm2' }), rx = await D('workPayMilestone', 'x', { projectId: 'P1', milestoneId: 'm2' });
  ck('M2', rp.code === 'permission-denied' && rx.code === 'permission-denied' && !B('wm_P1_m2_1'), 'the provider (or a stranger) cannot start a milestone payment', [rp, rx]);

  /* M3: an open attempt is RESUMED (no duplicate booking) */
  r = await D('workPayMilestone', 'cust', { projectId: 'P1', milestoneId: 'm1' });
  ck('M3', r.ok && r.ok.bookingId === id1 && r.ok.resumed === true && !B('wm_P1_m1_2'), 'paying again while the attempt is open resumes it — no second booking', r);

  /* M3b: a LAPSED attempt allows a new one (…_2) */
  DOCS.set('providerBookings/' + id1, Object.assign(B(id1), { expiresAt: Date.now() - 1000 }));
  r = await D('workPayMilestone', 'cust', { projectId: 'P1', milestoneId: 'm1' });
  ck('M3b', r.ok && r.ok.bookingId === 'wm_P1_m1_2' && B('wm_P1_m1_2').price === 2000000, 'an expired unpaid attempt does not lock the milestone: a fresh attempt (_2) is minted', r);

  /* M4: once paid, no further attempt */
  DOCS.set('providerBookings/wm_P1_m1_2', Object.assign(B('wm_P1_m1_2'), { paymentStatus: 'paid_held' }));
  r = await D('workPayMilestone', 'cust', { projectId: 'P1', milestoneId: 'm1' });
  ck('M4', r.det && r.det.code === 'WORK_MILESTONE_PAID' && !B('wm_P1_m1_3'), 'a paid (held) milestone cannot be paid twice', r);

  /* M5: a held milestone cannot be cancelled / declined / no-showed into an automatic refund */
  const c1 = await call(PO.providerCancelBooking, 'cust', { bookingId: 'wm_P1_m1_2' });
  const c2 = await call(PO.providerCancelBooking, 'mk', { bookingId: 'wm_P1_m1_2' });
  const c3 = await call(PO.providerDeclineBooking, 'mk', { bookingId: 'wm_P1_m1_2' });
  ck('M5', [c1, c2, c3].every((x) => x.det && x.det.code === 'WORK_MILESTONE_HELD') && B('wm_P1_m1_2').paymentStatus === 'paid_held' && B('wm_P1_m1_2').status === 'confirmed',
    'cancel (either side) / decline of a PAID milestone is refused — no automatic full refund of delivered work', [c1, c2, c3]);

  /* M6: a skin with no priced lane is refused BEFORE anything is minted */
  r = await D('workPayMilestone', 'cust', { projectId: 'P2', milestoneId: 'm1' });
  ck('M6', r.det && r.det.code === 'WORK_COMMISSION_UNPRICED' && ![...DOCS.keys()].some((k) => k.startsWith('providerBookings/wm_P2')), 'a project whose skin has no priced commission lane cannot be paid — refused before any booking exists', r);

  /* M7: deliver */
  const dv = await D('workMilestoneDeliver', 'cust', { projectId: 'P1', milestoneId: 'm2' });
  const dp = await D('workMilestoneDeliver', 'mk', { projectId: 'P1', milestoneId: 'm2' });
  ck('M7', dv.code === 'permission-denied' && dp.ok && DOCS.get('workProjects/P1').scope.milestones[1].status === 'delivered', 'only the provider marks a milestone delivered', [dv, dp]);
  done();
})().catch((e) => { console.error(e); ck('CRASH', false, e.message); done(); });
