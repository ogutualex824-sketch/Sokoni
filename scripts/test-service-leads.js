#!/usr/bin/env node
/* TECH HUB SLICE 4F — service leads & quotes (docs/SERVICE_LEADS.md), executed: the REAL service-leads.js ops,
 * bookingCreateService({ leadId }) and createConversation(service_lead), in-process on an in-memory Firestore.
 *   node scripts/test-service-leads.js        BASE=95f2ef6 node scripts/test-service-leads.js (must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
console.log('\nService leads & quotes (Tech Hub slice 4F)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const { DOCS } = H;
const APPROVED_AT = '2026-09-01T00:00:00.000Z';
const provider = (uid, appCategory, status, decidedBy) => {
  DOCS.set('providers/' + uid, { status: 'active', approvedAt: APPROVED_AT, searchable: true, business: { category: 'it_services', source: 'application' } });
  DOCS.set('users/' + uid, { role: 'provider', displayName: uid });
  DOCS.set('providerSubscriptions/' + uid, { limits: { listings: -1 } });
  DOCS.set('applications/' + uid + '--a', { uid, category: appCategory, role: 'provider', status: status || 'approved', decidedBy: decidedBy === undefined ? 'admin1' : decidedBy });
  DOCS.set('providerAvailability/' + uid, { modes: ['open_24_7'], appt: {} });
};
const service = (id, providerId, extra) => DOCS.set('providerServices/' + id, Object.assign({ providerId, name: 'Screen repair', priceType: 'quotation', price: 0, active: true, durationMins: 60 }, extra || {}));
const seed = () => { H.reset(); provider('prov', 'phone-repair'); provider('pend', 'phone-repair', 'pending'); DOCS.set('users/cust', { displayName: 'cust' }); DOCS.set('users/x', { displayName: 'x' }); service('s1', 'prov'); };
const lead = (id) => DOCS.get('serviceLeads/' + id);
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

(async () => {
  let L = null, BS = null, M = null, loadErr = null;
  try { L = require(path.join(FN, 'service-leads.js'))._h; } catch (e) { loadErr = e.message; }
  if (!L) { ck('L-0', false, 'functions/service-leads.js loads', loadErr); return done(); }
  BS = require(path.join(FN, 'booking-service.js'))._h;
  M = require(path.join(FN, 'messages.js'))._h;
  const PD = fs.readFileSync(path.join(FN, 'provider-dispatch.js'), 'utf8');

  /* L-1 create */
  seed();
  let r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 's1', message: 'My phone screen is cracked, can you fix it?' });
  const id = r.ok && r.ok.leadId;
  ck('L-1', !!(id && lead(id).status === 'created' && lead(id).customerUid === 'cust' && lead(id).monetization.status === 'not_configured' && lead(id).quote === null),
    'a customer asks an APPROVED provider; the lead is server-written, created, and records "Lead monetization not configured"', r.code ? r : lead(id));
  /* L-2 a provider who cannot take leads */
  r = await call(L.leadCreate, 'cust', { providerId: 'pend', message: 'Hello there, need help' });
  const r2b = await call(L.leadCreate, 'prov', { providerId: 'prov', message: 'Hello myself please' });
  ck('L-2', r.code === 'failed-precondition' && r2b.code === 'failed-precondition', 'no lead to a PENDING provider, none to yourself', { pend: r.code, self: r2b.code });
  /* L-3 abuse limit */
  await call(L.leadCreate, 'cust', { providerId: 'prov', message: 'second request here' });
  await call(L.leadCreate, 'cust', { providerId: 'prov', message: 'third request here' });
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', message: 'fourth request here' });
  ck('L-3', r.code === 'resource-exhausted', 'at most 3 open leads per customer per provider', r);

  /* L-4 parties */
  seed();
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 's1', message: 'Battery drains fast' });
  const lid = r.ok.leadId;
  const xs = await call(L.leadMarkViewed, 'x', { leadId: lid });
  const cq = await call(L.leadSendQuote, 'cust', { leadId: lid, amountCents: 100000, serviceId: 's1' });
  const xa = await call(L.leadRespond, 'x', { leadId: lid, action: 'accept' });
  ck('L-4', xs.code === 'permission-denied' && cq.code && xa.code === 'permission-denied', 'a stranger cannot view or accept; the customer cannot quote their own lead', { stranger: xs.code, custQuote: cq.code, strangerAccept: xa.code });

  /* L-5 quote validation */
  const bad1 = await call(L.leadSendQuote, 'prov', { leadId: lid, amountCents: 0, serviceId: 's1' });
  const bad2 = await call(L.leadSendQuote, 'prov', { leadId: lid, amountCents: 150000, serviceId: 's1', serviceMode: 'ONSITE_SUPPORT' });
  const bad3 = await call(L.leadSendQuote, 'prov', { leadId: lid, amountCents: 150000, serviceId: 'nope' });
  r = await call(L.leadSendQuote, 'prov', { leadId: lid, amountCents: 150000, serviceId: 's1', serviceMode: 'WORKSHOP', durationMins: 90, validDays: 3, description: 'Battery replacement' });
  ck('L-5', bad1.code === 'invalid-argument' && bad2.code === 'failed-precondition' && bad3.code === 'failed-precondition' && lead(lid).status === 'quote_sent'
    && lead(lid).quote.amountCents === 150000 && lead(lid).quote.version === 1,
    'a quote needs a valid amount, one of the provider\'s services and a GRANTED mode; a valid quote is sent (v1)', { bad1: bad1.code, bad2: bad2.code, bad3: bad3.code, lead: lead(lid) && lead(lid).quote });

  /* L-6 a quote cannot be booked before acceptance; expired cannot be accepted */
  r = await call(BS.bookingCreateService, 'cust', { providerId: 'prov', serviceId: 's1', date: tomorrow(), startTime: '10:00', leadId: lid });
  ck('L-6a', r.code === 'failed-precondition' && ![...DOCS.keys()].some((k) => k.startsWith('providerBookings/')), 'booking an UNACCEPTED quote is refused and writes nothing', r);
  const saved = lead(lid).quote.validUntil;
  DOCS.set('serviceLeads/' + lid, Object.assign(lead(lid), { quote: Object.assign(lead(lid).quote, { validUntil: Date.now() - 1000 }) }));
  r = await call(L.leadRespond, 'cust', { leadId: lid, action: 'accept' });
  ck('L-6b', r.code === 'failed-precondition' && lead(lid).status === 'quote_sent', 'an EXPIRED quote cannot be accepted', r);
  DOCS.set('serviceLeads/' + lid, Object.assign(lead(lid), { quote: Object.assign(lead(lid).quote, { validUntil: saved }) }));

  /* L-7 accept → book at the QUOTED price; the lead converts in the same transaction */
  r = await call(L.leadRespond, 'cust', { leadId: lid, action: 'accept' });
  const bk = await call(BS.bookingCreateService, 'cust', { providerId: 'prov', serviceId: 's1', date: tomorrow(), startTime: '10:00', leadId: lid, price: 1, amount: 1 });
  const booking = bk.ok && DOCS.get('providerBookings/' + bk.ok.bookingId);
  ck('L-7', !!(booking && booking.price === 150000 && booking.leadId === lid && booking.pricingSnapshot.source === 'quote' && booking.durationMins === 90
    && lead(lid).status === 'converted' && lead(lid).bookingId === bk.ok.bookingId),
    'an ACCEPTED quote books at the quoted price (request amounts ignored), and the lead converts with the booking id', bk.code ? bk : { price: booking && booking.price, lead: lead(lid) && lead(lid).status });

  /* L-8 one conversion: a second booking of the same quote (live hold) is refused and writes nothing */
  const before = [...DOCS.keys()].filter((k) => k.startsWith('providerBookings/')).length;
  r = await call(BS.bookingCreateService, 'cust', { providerId: 'prov', serviceId: 's1', date: tomorrow(), startTime: '14:00', leadId: lid });
  ck('L-8', r.code === 'failed-precondition' && [...DOCS.keys()].filter((k) => k.startsWith('providerBookings/')).length === before,
    'the same quote cannot be booked twice while its booking is live', r);

  /* L-9 an abandoned (expired, unpaid) hold frees the accepted quote to be booked again */
  const bkId = lead(lid).bookingId;
  DOCS.set('providerBookings/' + bkId, Object.assign(DOCS.get('providerBookings/' + bkId), { status: 'expired', paymentStatus: 'pending' }));
  r = await call(BS.bookingCreateService, 'cust', { providerId: 'prov', serviceId: 's1', date: tomorrow(), startTime: '15:00', leadId: lid });
  ck('L-9', !!(r.ok && lead(lid).bookingId === r.ok.bookingId && lead(lid).bookingId !== bkId), 'an abandoned unpaid hold does not strand the accepted quote — it can be booked again', r.code ? r : lead(lid));

  /* L-10 a conversation hangs on the lead before any booking */
  seed();
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', message: 'Do you fix Samsung TVs?' });
  const lid2 = r.ok.leadId;
  const cv = await call(M.createConversation, 'cust', { transactionType: 'service_lead', transactionId: lid2 });
  const cvx = await call(M.createConversation, 'x', { transactionType: 'service_lead', transactionId: lid2 });
  const conv = DOCS.get('conversations/service_lead_' + lid2);
  ck('L-10', !!(cv.ok && conv && conv.participants.includes('cust') && conv.participants.includes('prov')) && cvx.code === 'permission-denied',
    'a pre-booking conversation opens on the lead for its two parties only', { ok: cv.code || 'ok', stranger: cvx.code });

  /* L-11 provider list is gated; the routes are registered */
  const lp = await call(L.leadListForProvider, 'prov', {});
  const lpp = await call(L.leadListForProvider, 'pend', {});
  ck('L-11', !!(lp.ok && lp.ok.leads.length === 1) && lpp.code === 'failed-precondition'
    && ['leadCreate', 'leadListMine', 'leadListForProvider', 'leadMarkViewed', 'leadDecline', 'leadSendQuote', 'leadRespond', 'leadClose'].every((op) => PD.includes("'" + op + "'")),
    'the provider lists its leads (a pending provider cannot); every op is a providerDispatch route', { list: lp.code || lp.ok.leads.length, pend: lpp.code });
  /* L-12 AdminOS sees the leads (read-only); a non-admin does not */
  const AO = require(path.join(FN, 'admin-os.js'))._h;
  if (!AO.adminGetServiceLeads) ck('L-12', false, 'admin-os adminGetServiceLeads exists');
  else {
    const ad = await call(AO.adminGetServiceLeads, 'admin1', {}, { admin: true });
    const na = await call(AO.adminGetServiceLeads, 'cust', {}, {});
    ck('L-12', !!(ad.ok && ad.ok.items.length >= 1 && ad.ok.items.every((i) => i.monetization === 'not_configured')) && !na.ok && (!!na.code || /admin required/.test(na.msg || '')),   /* admin-os _requireAdmin throws a plain Error (pre-existing) */
      'AdminOS lists service leads (monetization not_configured); a non-admin is refused', { admin: ad.ok && { n: ad.ok.items.length, open: ad.ok.open }, nonAdmin: na.code || na.msg });
  }
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
