#!/usr/bin/env node
/* MARKETING BOOKING — commission follows the BOOKED SERVICE, and an accepted quote is locked (r2 integration, owner
 * 2026-10-03). Executes the REAL bookingCreateService (+ provider-hub / finos-utils / commission-config) in-process.
 *   B1 a marketing service booked from a provider whose hub is SERVICES captures the marketing lane (10%), not services
 *   B2 a booking from an ACCEPTED lead quote refuses a rate card / entertainment quote / coupon (LEAD_QUOTE_LOCKED)
 *   node scripts/test-marketing-booking-snapshot.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
require('./lib/net-firewall').install();
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
if (process.env.SABOTAGE) {
  const M = [
    ['B1', 'booking-service.js', "commissionSnapshotFor(db, providerId, { commissionHub, serviceHub: svcSnapshot.serviceHub, serviceCategory: svcSnapshot.serviceCategory }, price); }", "commissionSnapshotFor(db, providerId, { commissionHub }, price); }"],
    ['B2', 'booking-service.js', "  if (leadCtx && (rateCardId || quoteId || couponCode)) {", '  if (false) {'],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mbs-')); const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (f !== 'node_modules' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, f)); }
    for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
    const t = path.join(FN, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: FN }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out); console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught'); process.exit(caught === M.length ? 0 : 1);
}
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const FN = process.env.FN_DIR || path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 320) + ']')); ok ? pass++ : fail++; };
const { DOCS } = H;
console.log('\nMarketing booking — commission follows the booked service; accepted quotes are locked\n');
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const seed = () => {
  H.reset();
  /* a CLEANING provider (hub: services) who is ALSO an approved marketer for branding */
  DOCS.set('providers/mk', { uid: 'mk', status: 'active', acceptsBookings: true, category: 'cleaning', categories: ['cleaning'],
    marketingStatus: 'active', marketingListed: true, marketingCategories: ['branding'], marketingType: 'agency', approvedAt: '2026-09-01T00:00:00.000Z' });
  DOCS.set('applications/mk--a', { uid: 'mk', category: 'cleaning', role: 'provider', status: 'approved', decidedBy: 'admin1' });
  DOCS.set('applicationDecisions/mk--a', { status: 'approved', decidedBy: 'admin1' });
  DOCS.set('applicationDecisions/marketing_mk', { applicationId: 'marketing_mk', applicantUid: 'mk', status: 'approved', decidedBy: 'admin1', approvedCategories: ['branding'] });
  DOCS.set('applications/marketing_mk', { uid: 'mk', hub: 'marketing', applicationType: 'marketing', status: 'approved' });
  DOCS.set('providerSubscriptions/mk', { limits: { listings: -1 } });
  DOCS.set('providerAvailability/mk', { modes: ['open_24_7'], appt: {} });
  DOCS.set('users/mk', { displayName: 'mk', role: 'provider' }); DOCS.set('users/cust', { displayName: 'cust' });
  DOCS.set('providerServices/brand', { providerId: 'mk', name: 'Logo sprint', hub: 'marketing', category: 'branding', serviceGroup: 'creative', active: true, durationMins: 60, price: 2000000,
    marketing: { pricingModel: 'fixed', capabilities: { booking: true, quote: true }, deliverables: ['Logo'] } });
};

(async () => {
  const BS = require(path.join(FN, 'booking-service.js'))._h;
  /* B1 */
  seed();
  const r = await call(BS.bookingCreateService, 'cust', { providerId: 'mk', serviceId: 'brand', date: tomorrow(), startTime: '10:00' });
  const b = r.ok && DOCS.get('providerBookings/' + r.ok.bookingId);
  const cs = b && b.commissionSnapshot;
  ck('B1', !!(b && b.serviceHub === 'marketing' && b.serviceCategory === 'branding' && cs && Number(cs.commissionRate) === 10 && cs.category === 'marketing_services'),
    'a branding service booked from a cleaning (services-hub) provider captures the MARKETING lane at 10% on the booking snapshot — commission follows the booked service', r.code ? r : { hub: b && b.serviceHub, commissionHub: b && b.commissionHub, cs });

  /* B2 */
  seed();
  DOCS.set('serviceLeads/L1', { customerUid: 'cust', providerId: 'mk', serviceId: 'brand', status: 'quote_accepted', createdAtMs: Date.now(), history: [],
    quote: { amountCents: 1500000, version: 1, validUntil: Date.now() + 86400000, serviceId: 'brand', durationMins: 60 },
    acceptedQuote: { amountCents: 1500000, version: 1, validUntil: Date.now() + 86400000, serviceId: 'brand', durationMins: 60, acceptedAt: Date.now() } });
  const withCard = await call(BS.bookingCreateService, 'cust', { providerId: 'mk', serviceId: 'brand', date: tomorrow(), startTime: '11:00', leadId: 'L1', rateCardId: 'rc1' });
  const withCoupon = await call(BS.bookingCreateService, 'cust', { providerId: 'mk', serviceId: 'brand', date: tomorrow(), startTime: '12:00', leadId: 'L1', couponCode: 'SAVE50' });
  const plain = await call(BS.bookingCreateService, 'cust', { providerId: 'mk', serviceId: 'brand', date: tomorrow(), startTime: '13:00', leadId: 'L1' });
  const pb = plain.ok && DOCS.get('providerBookings/' + plain.ok.bookingId);
  ck('B2', /LEAD_QUOTE_LOCKED/.test(JSON.stringify(withCard)) && /LEAD_QUOTE_LOCKED/.test(JSON.stringify(withCoupon)) && !!(pb && pb.price === 1500000),
    'an accepted quote refuses a rate card or coupon (LEAD_QUOTE_LOCKED) and books at the frozen KES 15,000', { withCard: withCard.code, withCoupon: withCoupon.code, plain: plain.code || (pb && pb.price) });
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
