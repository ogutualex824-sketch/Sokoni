#!/usr/bin/env node
/* MARKETING HUB MK4 — marketing services on the ONE provider-services authority + the booking snapshot that commission keys on.
 * Executes the REAL provider-ops.js service ops, service-leads.js quote ops and booking-service.js bookingCreateService
 * in-process on an in-memory Firestore.
 *   node scripts/test-marketing-services.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['S2', 'shared/marketing-services.js', "  if (!approvedFor(provider, category)) {\n    throw new MarketingServiceError('MKT_SERVICE_NOT_APPROVED',", "  if (false) {\n    throw new MarketingServiceError('MKT_SERVICE_NOT_APPROVED',"],
    ['S3', 'provider-ops.js', "    ...(mkt || {}),                              /* marketing: server-written hub/category/serviceGroup/marketing */", "    ...(mkt || {}), ...(d.hub ? { hub: d.hub } : {}),"],
    ['S4', 'provider-ops.js', "  const mkt = await _marketingFields(uid, d, snap.data());", '  const mkt = null;'],
    ['S5', 'provider-ops.js', "  if (next && cur.hub === 'marketing') await _marketingFields(uid, {}, cur);", ''],
    ['B1', 'booking-service.js', "      ...svcSnapshot,", "      ...svcSnapshot, serviceCategory: _san(d.serviceCategory, 120) || svcSnapshot.serviceCategory,"],
    ['B2', 'booking-service.js', "    if (!MSVC.approvedFor(MA.effectiveProvider(prov, mAuth), svc.category)) throw", "    if (false) throw"],
    ['B3', 'booking-service.js', "    if (!leadCtx && !(svc.marketing && svc.marketing.capabilities && svc.marketing.capabilities.booking === true)) {", "    if (false) {"],
    ['S6', 'shared/marketing-services.js', "    booking: (modelIn === 'fixed' || modelIn === 'hourly') && capsIn.booking !== false,", "    booking: capsIn.booking !== false,"],
    /* F1: the adapter trusts the provider's own fields when THE predicate refuses (no record) */
    ['F1', 'shared/marketing-authority.js', "  if (!v.approved) return { active: false, categories: [], type: null, why: v.reason || 'NOT_APPROVED' };", "  if (!v.approved) return { active: p.marketingStatus === 'active', categories: p.marketingCategories || [], type: null, why: 'forged' };"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mks-'));
    const FN = path.join(d, 'functions');
    fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (f !== 'node_modules' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, f)); }
    for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
    const t = path.join(FN, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor in ' + file); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: FN }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out);
    console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row + '  (' + file + ')'); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
  process.exit(caught === M.length ? 0 : 1);
}

const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const FN = process.env.FN_DIR || path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const done = () => { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); };
const { DOCS } = H;
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
console.log('\nMarketing Hub MK4 — services on the ONE authority + booking snapshot\n');

/* An approved marketer (who is ALSO a cleaning provider) — approved for branding + seo, not influencer-marketing. */
const seed = () => {
  H.reset();
  DOCS.set('providers/mk', { uid: 'mk', status: 'active', acceptsBookings: true, category: 'cleaning', categories: ['cleaning'],
    marketingStatus: 'active', marketingListed: true, marketingCategories: ['branding', 'seo'], marketingType: 'agency' });
  /* the SERVER decision record (applicationDecide) — the marketing authority intersects the provider's fields with it */
  DOCS.set('applicationDecisions/marketing_mk', { applicationId: 'marketing_mk', applicantUid: 'mk', status: 'approved', decidedBy: 'admin1', approvedCategories: ['branding', 'seo'] });
  DOCS.set('applications/marketing_mk', { uid: 'mk', hub: 'marketing', applicationType: 'marketing', status: 'approved' });
  DOCS.set('providerSubscriptions/mk', { limits: { listings: -1 } });
  DOCS.set('providerAvailability/mk', { modes: ['open_24_7'], appt: {} });
  DOCS.set('users/mk', { displayName: 'mk', role: 'provider' }); DOCS.set('users/cust', { displayName: 'cust' });
  DOCS.set('providers/plain', { uid: 'plain', status: 'active', acceptsBookings: true, category: 'cleaning' });
  DOCS.set('providerSubscriptions/plain', { limits: { listings: -1 } });
};
const svcs = () => [...DOCS.keys()].filter((k) => k.startsWith('providerServices/')).map((k) => Object.assign({ id: k.split('/')[1] }, DOCS.get(k)));
const bookings = () => [...DOCS.keys()].filter((k) => k.startsWith('providerBookings/')).map((k) => Object.assign({ id: k.split('/')[1] }, DOCS.get(k)));

(async () => {
  const PO = require(path.join(FN, 'provider-ops.js'))._h;
  const BS = require(path.join(FN, 'booking-service.js'))._h;
  seed();

  /* ── S: service editor authority ── */
  let r = await call(PO.providerAddService, 'mk', { name: 'Brand identity sprint', category: 'branding', pricingModel: 'fixed', price: 5000000, durationMins: 120,
    deliverables: ['Logo', 'Brand guide', '<script>x</script>'], leadTimeDays: 7, serviceArea: 'Nairobi', capabilities: { campaign: true } });
  const s1 = r.ok ? DOCS.get('providerServices/' + r.ok.serviceId) : null;
  ck('S1', s1 && s1.hub === 'marketing' && s1.category === 'branding' && s1.serviceGroup === 'creative' && s1.marketing.pricingModel === 'fixed'
    && s1.marketing.capabilities.booking === true && s1.marketing.capabilities.quote === true && s1.marketing.capabilities.campaign === true
    && s1.marketing.leadTimeDays === 7 && s1.marketing.deliverables.length === 3 && !/</.test(s1.marketing.deliverables.join('')),
    'a service in an APPROVED category: server writes hub marketing + group + capabilities; text sanitised', s1);
  /* ── F: SECURITY — providers.marketing* is owner-writable on the served rules; only the server decision record counts ── */
  DOCS.set('providers/forger', { uid: 'forger', status: 'active', acceptsBookings: true, marketingStatus: 'active', marketingListed: true, marketingCategories: ['seo', 'branding'] });
  DOCS.set('providerSubscriptions/forger', { limits: { listings: -1 } }); DOCS.set('providerAvailability/forger', { modes: ['open_24_7'], appt: {} });
  DOCS.set('providers/mk2', { uid: 'mk2', status: 'active', marketingStatus: 'active', marketingListed: true, marketingCategories: ['branding', 'seo'] });
  DOCS.set('applicationDecisions/marketing_mk2', { applicationId: 'marketing_mk2', applicantUid: 'mk2', status: 'approved', decidedBy: 'admin1', approvedCategories: ['branding'] });
  DOCS.set('applications/marketing_mk2', { uid: 'mk2', hub: 'marketing', applicationType: 'marketing', status: 'approved' });
  DOCS.set('providerSubscriptions/mk2', { limits: { listings: -1 } });
  const f1 = await call(PO.providerAddService, 'forger', { name: 'SEO', category: 'seo', price: 100000 });
  const f2 = await call(PO.providerAddService, 'mk2', { name: 'SEO', category: 'seo', price: 100000 });
  const f2ok = await call(PO.providerAddService, 'mk2', { name: 'Brand', category: 'branding', price: 100000 });
  DOCS.set('providerServices/planted', { providerId: 'forger', name: 'Planted', category: 'seo', hub: 'marketing', price: 100000, active: true, durationMins: 60, marketing: { pricingModel: 'fixed', capabilities: { booking: true } } });
  const f3 = await call(BS.bookingCreateService, 'cust', { providerId: 'forger', serviceId: 'planted', date: tomorrow(), startTime: '09:00' });
  ck('F1', f1.det && f1.det.code === 'MKT_SERVICE_NOT_APPROVED' && f2.det && f2.det.code === 'MKT_SERVICE_NOT_APPROVED' && f2ok.ok && f3.det && f3.det.code === 'MKT_SERVICE_NOT_APPROVED'
    && !bookings().some((b) => b.providerId === 'forger'),
    'SECURITY: self-written marketing fields (no record) cannot list or be booked; fields claiming MORE than the record approves are cut to the record (seo refused, branding ok)', { f1, f2, f2ok: !!f2ok.ok, f3 });
  DOCS.delete('providerServices/' + f2ok.ok.serviceId); DOCS.delete('providerServices/planted');
  r = await call(PO.providerAddService, 'mk', { name: 'Influencer push', category: 'influencer-marketing', price: 100000 });
  const r2 = await call(PO.providerAddService, 'plain', { name: 'SEO', category: 'seo', price: 100000 });
  ck('S2', r.code === 'permission-denied' && r.det && r.det.code === 'MKT_SERVICE_NOT_APPROVED' && r2.det && r2.det.code === 'MKT_SERVICE_NOT_APPROVED' && svcs().length === 1,
    'a category the marketer is NOT approved for, or a provider who is not a marketer, is refused — nothing written', [r, r2]);
  r = await call(PO.providerAddService, 'mk', { name: 'Deep clean', category: 'cleaning', price: 300000, hub: 'marketing', marketing: { capabilities: { booking: true } } });
  const s3 = r.ok ? DOCS.get('providerServices/' + r.ok.serviceId) : null;
  ck('S3', s3 && s3.hub === undefined && s3.marketing === undefined && s3.category === 'cleaning',
    'the request cannot make a service "marketing": hub / marketing fields from the client are ignored for a non-marketing category', s3);
  const sId = svcs().find((s) => s.hub === 'marketing').id;
  r = await call(PO.providerUpdateService, 'mk', { serviceId: sId, category: 'influencer-marketing' });
  const r4 = await call(PO.providerUpdateService, 'mk', { serviceId: sId, category: 'cleaning' });
  ck('S4', r.det && r.det.code === 'MKT_SERVICE_NOT_APPROVED' && r4.det && r4.det.code === 'MKT_HUB_LOCKED' && DOCS.get('providerServices/' + sId).category === 'branding',
    'editing a marketing service into an unapproved category, or out of marketing, is refused', [r, r4]);
  r = await call(PO.providerAddService, 'mk', { name: 'SEO retainer', category: 'seo', pricingModel: 'project', capabilities: { booking: true } });
  const qId = r.ok && r.ok.serviceId;
  const q = qId ? DOCS.get('providerServices/' + qId) : {};
  ck('S6', q.marketing && q.marketing.capabilities.booking === false && q.marketing.capabilities.quote === true && q.marketing.capabilities.project === true,
    'a project / quote-priced service can never be directly booked (booking capability forced off), only quoted', q.marketing);

  /* ── B: booking snapshot — commission follows the BOOKED service ── */
  r = await call(BS.bookingCreateService, 'cust', { providerId: 'mk', serviceId: sId, date: tomorrow(), startTime: '10:00', hubType: 'cleaning', serviceCategory: 'cleaning', price: 1 });
  const b1 = r.ok ? bookings().find((b) => b.serviceId === sId) : null;
  ck('B1', b1 && b1.serviceHub === 'marketing' && b1.serviceCategory === 'branding' && b1.serviceSnapshot && b1.serviceSnapshot.category === 'branding'
    && b1.serviceSnapshot.pricingModel === 'fixed' && b1.price === 5000000,
    'the booking snapshots hub + category + price from the SERVER service; request hubType / serviceCategory / price are ignored', b1 || r);
  r = await call(BS.bookingCreateService, 'cust', { providerId: 'mk', serviceId: qId, date: tomorrow(), startTime: '13:00' });
  ck('B3', r.det && r.det.code === 'MKT_QUOTE_ONLY', 'a quote-only marketing service cannot be booked without an accepted quote', r);
  const clean = svcs().find((s) => s.category === 'cleaning');
  r = await call(BS.bookingCreateService, 'cust', { providerId: 'mk', serviceId: clean.id, date: tomorrow(), startTime: '15:00', hubType: 'marketing' });
  const bc = r.ok ? bookings().find((b) => b.serviceId === clean.id) : null;
  ck('B4', bc && bc.serviceHub === null && bc.serviceCategory === 'cleaning', 'the SAME provider\'s cleaning booking is snapshotted as cleaning — never marketing (the provider does not decide the lane)', bc || r);

  /* ── H: historical integrity ── */
  await call(PO.providerUpdateService, 'mk', { serviceId: sId, price: 9900000 });
  DOCS.set('providers/mk', Object.assign(DOCS.get('providers/mk'), { marketingCategories: ['seo'] }));
  const b1b = DOCS.get('providerBookings/' + b1.id);
  ck('H1', b1b.price === 5000000 && b1b.serviceCategory === 'branding' && b1b.serviceHub === 'marketing',
    'a later rate change and a later category change never rewrite the existing booking (price + commission key stay)', b1b);
  r = await call(BS.bookingCreateService, 'cust', { providerId: 'mk', serviceId: sId, date: tomorrow(), startTime: '17:00' });
  ck('B2', r.det && r.det.code === 'MKT_SERVICE_NOT_APPROVED', 'once branding is no longer approved, a NEW booking of that service is refused', r);
  await call(PO.providerToggleService, 'mk', { serviceId: sId, active: false });
  r = await call(PO.providerToggleService, 'mk', { serviceId: sId, active: true });
  ck('S5', r.det && r.det.code === 'MKT_SERVICE_NOT_APPROVED' && DOCS.get('providerServices/' + sId).active === false, 're-activating a marketing service needs a CURRENT approval', r);
  /* ── WS: the ONE server flag merchant-v2's provider session reads (businessWorkspace.marketing) ── */
  const BW = require(path.join(FN, 'business-workspace.js'))._h;
  const wm = await call(BW.businessWorkspace, 'mk', {}), wf = await call(BW.businessWorkspace, 'forger', {}), w2 = await call(BW.businessWorkspace, 'mk2', {});
  ck('WS', wm.ok && wm.ok.marketing === true && JSON.stringify(wm.ok.marketingCategories) === JSON.stringify(['seo'])
    && wf.ok && wf.ok.marketing === false && wf.ok.marketingCategories.length === 0 && w2.ok && JSON.stringify(w2.ok.marketingCategories) === JSON.stringify(['branding']),
    'businessWorkspace carries a server-computed marketing flag: genuine marketer true (current approved set); self-written fields false; claim cut to the record', { mk: wm.ok && [wm.ok.marketing, wm.ok.marketingCategories], forger: wf.ok && wf.ok.marketing, mk2: w2.ok && w2.ok.marketingCategories });
  done();
})().catch((e) => { console.error(e); ck('CRASH', false, e.message); done(); });
