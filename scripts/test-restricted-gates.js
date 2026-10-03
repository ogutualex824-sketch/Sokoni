#!/usr/bin/env node
/* RESTRICTED CATEGORIES at the Marketing / services gates (owner 2026-10-03; shared/restricted-categories.js = the ONE
 * policy). Executes the REAL service-leads / booking-service / provider-ops handlers in-process on the in-memory Firestore.
 * vape / tobacco-nicotine / alcohol / adult — and ambiguous combinations ("Beer & Wine") — are refused (category_restricted)
 * at lead creation, quoting, quote acceptance, booking, service publish / update / re-activation; nothing is written.
 *   node scripts/test-restricted-gates.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
require('./lib/net-firewall').install();
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
if (process.env.SABOTAGE) {
  const M = [
    ['R1', 'service-leads.js', "    _assertSellable(s.data(), 'lead');", ''],
    ['R2', 'service-leads.js', "  _assertSellable(svc, 'quote');", ''],
    ['R3', 'service-leads.js', "      _assertSellable({ serviceCategory: cur.quote.serviceCategory, category: cur.quote.serviceSnapshot && cur.quote.serviceSnapshot.category }, 'quote acceptance');", ''],
    ['R4', 'booking-service.js', "  try { require('./shared/restricted-categories').assertNotRestricted(svc, 'booking'); }", '  try { }'],
    ['R5', 'provider-ops.js', "  _assertSellable({ category: d.category, subcategory: d.subcategory, categories: d.categories }, 'service');", ''],
    ['R6', 'provider-ops.js', "  if (d.category !== undefined)    { _assertSellable({ category: d.category }, 'service'); patch.category = _san(d.category, 120); }", "  if (d.category !== undefined)    { patch.category = _san(d.category, 120); }"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rcg-')); const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
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
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
const { DOCS } = H;
console.log('\nRestricted categories at the services gates\n');
const restricted = (r) => r && r.code === 'failed-precondition' && /category_restricted/.test(JSON.stringify(r.det || {}));
const seed = () => {
  H.reset();
  DOCS.set('providers/prov', { status: 'active', approvedAt: '2026-09-01T00:00:00.000Z', searchable: true, business: { category: 'it_services', source: 'application' } });
  DOCS.set('users/prov', { role: 'provider', displayName: 'prov' });
  DOCS.set('providerSubscriptions/prov', { limits: { listings: -1 } });
  DOCS.set('applications/prov--a', { uid: 'prov', category: 'phone-repair', role: 'provider', status: 'approved', decidedBy: 'admin1' });
  DOCS.set('applicationDecisions/prov--a', { status: 'approved', decidedBy: 'admin1' });
  DOCS.set('providerAvailability/prov', { modes: ['open_24_7'], appt: {} });
  DOCS.set('users/cust', { displayName: 'cust' });
  DOCS.set('providerServices/ok', { providerId: 'prov', name: 'Screen repair', category: 'phone-repair', active: true, durationMins: 60, price: 0, priceType: 'quotation' });
  DOCS.set('providerServices/vape', { providerId: 'prov', name: 'Vape refills', category: 'vape', active: true, durationMins: 60, price: 1000 });
  DOCS.set('providerServices/booze', { providerId: 'prov', name: 'Bar service', category: 'Beer & Wine', active: true, durationMins: 60, price: 1000 });
};
const writes = (prefix) => [...DOCS.keys()].filter((k) => k.startsWith(prefix)).length;
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

(async () => {
  const L = require(path.join(FN, 'service-leads.js'))._h, BS = require(path.join(FN, 'booking-service.js'))._h, PO = require(path.join(FN, 'provider-ops.js'))._h;

  /* R1 lead creation */
  seed();
  const okLead = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 'ok', message: 'Screen is cracked please' });
  const v = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 'vape', message: 'Need refills please' });
  const b = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 'booze', message: 'Bar for a party please' });
  ck('R1', !!okLead.ok && restricted(v) && restricted(b) && writes('serviceLeads/') === 1,
    'a lead on a restricted service (vape, and the ambiguous "Beer & Wine") is refused and written nowhere; an allowed service still works', { ok: !!okLead.ok, v, b });

  /* R2 quoting a restricted service (a legacy lead seeded directly) */
  DOCS.set('serviceLeads/legacy', { customerUid: 'cust', providerId: 'prov', serviceId: 'vape', status: 'viewed', message: 'x', history: [{ at: Date.now(), by: 'customer', event: 'created' }], createdAtMs: Date.now() });
  const q = await call(L.leadSendQuote, 'prov', { leadId: 'legacy', serviceId: 'vape', amountCents: 50000 });
  ck('R2', restricted(q) && !DOCS.get('serviceLeads/legacy').quote, 'a provider cannot quote a restricted service (even on a legacy lead)', q);

  /* R3 accepting a quote whose frozen service is restricted */
  DOCS.set('serviceLeads/legacyq', { customerUid: 'cust', providerId: 'prov', serviceId: 'vape', status: 'quote_sent', message: 'x', createdAtMs: Date.now(), history: [{ at: Date.now(), by: 'provider', event: 'quote_sent' }],
    quote: { amountCents: 50000, version: 1, validUntil: Date.now() + 86400000, serviceId: 'vape', serviceCategory: 'vape', serviceSnapshot: { name: 'Vape refills', category: 'vape' } } });
  const a = await call(L.leadRespond, 'cust', { leadId: 'legacyq', action: 'accept', quoteVersion: 1 });
  ck('R3', restricted(a) && DOCS.get('serviceLeads/legacyq').status === 'quote_sent', 'accepting a quote for a restricted service is refused; the lead is unchanged', a);

  /* R4 booking a restricted service */
  const bk = await call(BS.bookingCreateService, 'cust', { providerId: 'prov', serviceId: 'vape', date: tomorrow(), startTime: '10:00' });
  ck('R4', restricted(bk) && writes('providerBookings/') === 0, 'booking a restricted service is refused and writes no booking', bk);

  /* R5 publishing a restricted service */
  const add = await call(PO.providerAddService, 'prov', { name: 'Shisha lounge', category: 'tobacco' });
  const add2 = await call(PO.providerAddService, 'prov', { name: 'Adult shop', categories: ['gifts', 'adult'] });
  ck('R5', restricted(add) && restricted(add2) && writes('providerServices/') === 3, 'publishing a service in a restricted category (or with one among several) is refused; nothing is written', { add, add2 });

  /* R6 re-categorising / re-activating into a restricted category */
  const upd = await call(PO.providerUpdateService, 'prov', { serviceId: 'ok', category: 'alcohol' });
  ck('R6', restricted(upd) && DOCS.get('providerServices/ok').category === 'phone-repair', 'changing a service to a restricted category is refused; the service keeps its category', upd);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
