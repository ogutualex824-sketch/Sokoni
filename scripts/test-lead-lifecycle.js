#!/usr/bin/env node
/* G7 — the brief's LEAD and QUOTE lifecycles on the ONE lead engine (functions/service-leads.js; docs/SERVICE_LEADS.md).
 * Executes the REAL ops in-process on the in-memory Firestore, plus bookingCreateService({ leadId }) for the lock.
 *   lead   new → contacted → qualified → quote_requested → quote_sent → negotiating → won | lost · cancelled · expired
 *   quote  draft → sent → customer_viewed → negotiating → accepted | declined · expired · cancelled
 * Proves: stages are derived from server state; an itemised quote's total is computed by the server (a client total is
 * only compared; taxes are never inferred); a draft never reaches the customer; acceptance names the version seen and
 * freezes it — the booking prices from the frozen copy; stale leads expire and stop blocking; a marketing quote needs
 * the server marketing approval.
 *   node scripts/test-lead-lifecycle.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
if (process.env.SABOTAGE) {
  const M = [
    ['G2', 'service-leads.js', '  if (itemised && d.amountCents != null && int(d.amountCents) !== amountCents) {', '  if (false) {'],
    ['G3', 'service-leads.js', "  if (role === 'provider') v.quoteDraft = l.quoteDraft || null;", '  v.quoteDraft = l.quoteDraft || null;'],
    ['G4', 'service-leads.js', '  if (!cur.quote || cur.quote.viewedVersion === cur.quote.version) return null;', '  if (!cur.quote) return null;'],
    ['G5', 'service-leads.js', '      if (seen !== cur.quote.version) throw', '      if (false) throw'],
    ['G6', 'service-leads.js', '  const q = lead.acceptedQuote || lead.quote || {};', '  const q = lead.quote || {};'],
    ['G7', 'service-leads.js', '  status: STATUS.QUALIFIED, quote: Object.assign({}, cur.quote || {}, { cancelledAt: Date.now() }),', '  status: STATUS.QUALIFIED, quote: cur.quote,'],
    ['G9', 'service-leads.js', '    if (!(opts && opts.allowExpired) && _ttlExpired(cur, Date.now())) {', '    if (false) {'],
    ['G10', 'service-leads.js', "  if (svc.hub === 'marketing') {\n    /* the same server authority", "  if (false) {\n    /* the same server authority"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llc-')); const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
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
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const { DOCS } = H;
console.log('\nG7 — lead & quote lifecycle (one lead engine)\n');

const seed = () => {
  H.reset();
  DOCS.set('providers/prov', { status: 'active', approvedAt: '2026-09-01T00:00:00.000Z', searchable: true, business: { category: 'it_services', source: 'application' } });
  DOCS.set('users/prov', { role: 'provider', displayName: 'prov' });
  DOCS.set('providerSubscriptions/prov', { limits: { listings: -1 } });
  DOCS.set('applications/prov--a', { uid: 'prov', category: 'phone-repair', role: 'provider', status: 'approved', decidedBy: 'admin1' });
  DOCS.set('applicationDecisions/prov--a', { status: 'approved', decidedBy: 'admin1' });
  DOCS.set('providerAvailability/prov', { modes: ['open_24_7'], appt: {} });
  DOCS.set('users/cust', { displayName: 'cust' });
  DOCS.set('providerServices/s1', { providerId: 'prov', name: 'Screen repair', priceType: 'quotation', price: 0, active: true, durationMins: 60 });
  /* a marketing service the provider is NOT (yet) approved for */
  DOCS.set('providerServices/sm', { providerId: 'prov', name: 'Brand identity', hub: 'marketing', category: 'branding', serviceGroup: 'creative',
    active: true, durationMins: 60, marketing: { pricingModel: 'project', capabilities: { booking: false, quote: true }, deliverables: ['Logo'] } });
};
const lead = (id) => DOCS.get('serviceLeads/' + id);
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const viewOf = async (uid, id, fn) => { const r = await call(fn, uid, {}); return r.ok && r.ok.leads.find((l) => l.id === id); };
const ITEMS = { serviceId: 's1', quantity: 3, unitRateCents: 50000, adjustments: [{ label: 'Returning customer', amountCents: -10000 }],
  taxes: [{ label: 'VAT', ratePct: 16 }], scope: 'Replace 3 screens', paymentTermsNote: 'Collect within 7 days', validDays: 5 };

(async () => {
  const SL = require(path.join(FN, 'service-leads.js'));
  const L = SL._h, BS = require(path.join(FN, 'booking-service.js'))._h;

  /* G1 lead stages new → contacted → qualified → quote_requested (and Request-a-quote from the start) */
  seed();
  let r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 's1', message: 'Three cracked screens at the office' });
  const id = r.ok && r.ok.leadId;
  const st = [];
  st.push((await viewOf('prov', id, L.leadListForProvider)).stage);
  await call(L.leadMarkViewed, 'prov', { leadId: id }); st.push((await viewOf('prov', id, L.leadListForProvider)).stage);
  await call(L.leadQualify, 'prov', { leadId: id, note: 'office, 3 units' }); st.push((await viewOf('prov', id, L.leadListForProvider)).stage);
  const custQualify = await call(L.leadQualify, 'cust', { leadId: id });
  await call(L.leadRequestQuote, 'cust', { leadId: id, message: 'Price please' }); st.push((await viewOf('cust', id, L.leadListMine)).stage);
  const rq = await call(L.leadCreate, 'cust', { providerId: 'prov', message: 'Quote for one screen please', requestQuote: true });
  ck('G1', st.join('>') === 'new>contacted>qualified>quote_requested' && custQualify.code === 'permission-denied' && rq.ok && rq.ok.status === 'quote_requested',
    'lead stages new → contacted → qualified → quote_requested (provider qualifies, customer requests); Request-a-quote starts at quote_requested', { st, custQualify: custQualify.code, rq });

  /* G2 itemised quote — the SERVER computes every figure; a wrong client total is refused; no tax is inferred */
  const mismatch = await call(L.leadSendQuote, 'prov', Object.assign({ leadId: id, amountCents: 150000 }, ITEMS));
  const badTax = await call(L.leadSendQuote, 'prov', Object.assign({}, ITEMS, { leadId: id, taxes: [{ label: 'VAT', ratePct: 50 }] }));
  const badAdj = await call(L.leadSendQuote, 'prov', Object.assign({}, ITEMS, { leadId: id, adjustments: [{ label: 'x', amountCents: -200000 }] }));
  r = await call(L.leadSendQuote, 'prov', Object.assign({ leadId: id, amountCents: 162400 }, ITEMS));
  const q = lead(id).quote || {};
  const noTax = SL.buildQuote({ amountCents: 50000 }, { name: 'X' }, 's1');
  ck('G2', mismatch.code === 'failed-precondition' && /QUOTE_TOTAL_MISMATCH|does not match/.test(JSON.stringify(mismatch)) && badTax.code === 'invalid-argument' && badAdj.code === 'invalid-argument'
    && r.ok && q.subtotalCents === 150000 && q.taxCents === 22400 && q.amountCents === 162400 && q.quantity === 3 && q.scope === 'Replace 3 screens'
    && q.paymentTerms.code === 'paid_on_booking_held_until_pin' && q.paymentTerms.note === 'Collect within 7 days' && q.serviceSnapshot.name === 'Screen repair'
    && q.breakdown.reduce((t, b) => t + b.amount, 0) === 162400 && noTax.taxCents === 0 && noTax.taxes.length === 0 && noTax.amountCents === 50000,
    'itemised quote: 3 × 500 − 100 + VAT 16% = KES 1,624 computed server-side; a client total of 1,500 is refused; 50% tax / sub-KES-1 refused; no tax unless stated', { mismatch: mismatch.code, badTax: badTax.code, badAdj: badAdj.code, q });

  /* G3 a DRAFT is the provider's only */
  seed();
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 's1', message: 'Need a battery replaced' });
  const d3 = r.ok.leadId;
  const dr = await call(L.leadSaveQuoteDraft, 'prov', { leadId: d3, serviceId: 's1', amountCents: 80000 });
  const pv = await viewOf('prov', d3, L.leadListForProvider), cv = await viewOf('cust', d3, L.leadListMine);
  const bookDraft = await call(BS.bookingCreateService, 'cust', { providerId: 'prov', serviceId: 's1', date: tomorrow(), startTime: '10:00', leadId: d3 });
  ck('G3', dr.ok && pv.quoteStage === 'draft' && pv.quoteDraft && pv.quoteDraft.amountCents === 80000 && cv.quoteStage === null && !('quoteDraft' in cv) && cv.quote === null
    && bookDraft.code === 'failed-precondition' && lead(d3).status === 'created',
    'a saved DRAFT shows to the provider (stage draft) and never to the customer; it is not bookable and does not move the lead', { pv: pv && pv.quoteStage, cv, bookDraft: bookDraft.code });

  /* G4 sent → customer_viewed, idempotent per version */
  await call(L.leadSendQuote, 'prov', { leadId: d3, serviceId: 's1', amountCents: 80000 });
  const sentStage = (await viewOf('cust', d3, L.leadListMine)).quoteStage;
  const draftGone = lead(d3).quoteDraft === null;
  await call(L.leadViewQuote, 'cust', { leadId: d3 });
  const h1 = lead(d3).history.length;
  const again = await call(L.leadViewQuote, 'cust', { leadId: d3 });
  const provView = await call(L.leadViewQuote, 'prov', { leadId: d3 });
  ck('G4', sentStage === 'sent' && draftGone && (await viewOf('prov', d3, L.leadListForProvider)).quoteStage === 'customer_viewed' && again.ok && again.ok.unchanged === true
    && lead(d3).history.length === h1 && provView.code === 'permission-denied',
    'quote sent → customer_viewed when the customer opens it (once per version, no duplicate event); sending consumes the draft; a provider cannot mark it viewed', { sentStage, h1, after: lead(d3).history.length, again: again.ok, provView: provView.code });

  /* G5 acceptance names the version SEEN: a re-quote in between is never accepted unseen */
  await call(L.leadSendQuote, 'prov', { leadId: d3, serviceId: 's1', amountCents: 95000 });
  const reStage = (await viewOf('cust', d3, L.leadListMine)).quoteStage;
  const stale = await call(L.leadRespond, 'cust', { leadId: d3, action: 'accept', quoteVersion: 1 });
  const none = await call(L.leadRespond, 'cust', { leadId: d3, action: 'accept' });
  const okAcc = await call(L.leadRespond, 'cust', { leadId: d3, action: 'accept', quoteVersion: 2 });
  ck('G5', reStage === 'sent' && stale.code === 'failed-precondition' && /LEAD_QUOTE_CHANGED|updated this quote/.test(JSON.stringify(stale)) && none.code === 'failed-precondition'
    && okAcc.ok && lead(d3).status === 'quote_accepted' && lead(d3).acceptedQuote && lead(d3).acceptedQuote.version === 2 && lead(d3).acceptedQuote.amountCents === 95000,
    'a re-quote resets to sent; accepting v1 (or no version) after v2 was sent is refused; accepting v2 freezes acceptedQuote', { reStage, stale: stale.code, none: none.code, acc: lead(d3).acceptedQuote });

  /* G6 acceptance LOCKS the terms: no re-quote; the booking prices from the frozen copy */
  const requote = await call(L.leadSendQuote, 'prov', { leadId: d3, serviceId: 's1', amountCents: 10 * 95000 });
  DOCS.set('serviceLeads/' + d3, Object.assign(lead(d3), { quote: Object.assign({}, lead(d3).quote, { amountCents: 1 }) }));   /* a corrupted live quote */
  const bk = await call(BS.bookingCreateService, 'cust', { providerId: 'prov', serviceId: 's1', date: tomorrow(), startTime: '10:00', leadId: d3 });
  const booking = bk.ok && DOCS.get('providerBookings/' + bk.ok.bookingId);
  const v6 = await viewOf('cust', d3, L.leadListMine);
  ck('G6', requote.code === 'failed-precondition' && booking && booking.price === 95000 && booking.pricingSnapshot.quoteVersion === 2 && v6.stage === 'won' && v6.quoteStage === 'accepted',
    'after acceptance the provider cannot re-quote, and the booking prices from acceptedQuote (KES 950), not the live quote field; stage won / accepted', { requote: requote.code, price: booking && booking.price, bk: bk.code, v6: v6 && [v6.stage, v6.quoteStage] });

  /* G6b an itemised accepted quote carries its lines into the booking's pricing snapshot */
  seed();
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 's1', message: 'Three screens again' });
  const i6 = r.ok.leadId;
  await call(L.leadSendQuote, 'prov', Object.assign({ leadId: i6 }, ITEMS));
  await call(L.leadRespond, 'cust', { leadId: i6, action: 'accept', quoteVersion: 1 });
  const bk6 = await call(BS.bookingCreateService, 'cust', { providerId: 'prov', serviceId: 's1', date: tomorrow(), startTime: '11:00', leadId: i6 });
  const b6 = bk6.ok && DOCS.get('providerBookings/' + bk6.ok.bookingId);
  ck('G6b', b6 && b6.price === 162400 && b6.pricingSnapshot.breakdown.length === 3 && b6.pricingSnapshot.breakdown.some((x) => x.type === 'tax' && x.amount === 22400),
    'the booking of an itemised quote is KES 1,624 with line / adjustment / tax rows that sum to the price', bk6.code ? bk6 : b6 && b6.pricingSnapshot);

  /* G7 negotiating + withdraw (the withdrawn quote can never be accepted) */
  seed();
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 's1', message: 'Can you do a discount?' });
  const n7 = r.ok.leadId;
  await call(L.leadSendQuote, 'prov', { leadId: n7, serviceId: 's1', amountCents: 70000 });
  await call(L.leadRespond, 'cust', { leadId: n7, action: 'clarify', message: 'Lower?' });
  const neg = await viewOf('cust', n7, L.leadListMine);
  const wd = await call(L.leadWithdrawQuote, 'prov', { leadId: n7 });
  const afterW = await viewOf('cust', n7, L.leadListMine);
  const accW = await call(L.leadRespond, 'cust', { leadId: n7, action: 'accept', quoteVersion: 1 });
  const v2 = await call(L.leadSendQuote, 'prov', { leadId: n7, serviceId: 's1', amountCents: 60000 });
  ck('G7', neg.stage === 'negotiating' && neg.quoteStage === 'negotiating' && wd.ok && afterW.stage === 'qualified' && afterW.quoteStage === 'cancelled' && accW.code === 'failed-precondition'
    && v2.ok && lead(n7).quote.version === 2 && !lead(n7).quote.cancelledAt && (await viewOf('cust', n7, L.leadListMine)).quoteStage === 'sent',
    'clarification = negotiating; a withdrawn quote shows cancelled and cannot be accepted; the provider can then send v2', { neg: neg && [neg.stage, neg.quoteStage], afterW: afterW && [afterW.stage, afterW.quoteStage], accW: accW.code });

  /* G8 lost (provider) / cancelled (customer) / declined */
  const custLost = await call(L.leadMarkLost, 'cust', { leadId: n7 });
  await call(L.leadMarkLost, 'prov', { leadId: n7, reason: 'went with another agency' });
  const lostV = await viewOf('cust', n7, L.leadListMine);
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', message: 'Never mind later' });
  await call(L.leadClose, 'cust', { leadId: r.ok.leadId, reason: 'found one' });
  const canc = await viewOf('cust', r.ok.leadId, L.leadListMine);
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 's1', message: 'One more screen' });
  await call(L.leadSendQuote, 'prov', { leadId: r.ok.leadId, serviceId: 's1', amountCents: 50000 });
  await call(L.leadRespond, 'cust', { leadId: r.ok.leadId, action: 'decline' });
  const decl = await viewOf('cust', r.ok.leadId, L.leadListMine);
  ck('G8', custLost.code === 'permission-denied' && lostV.stage === 'lost' && lostV.quoteStage === 'cancelled' && canc.stage === 'cancelled' && decl.stage === 'lost' && decl.quoteStage === 'declined',
    'provider marks lost (customer cannot) → lost / quote cancelled; customer cancel → cancelled; customer declines the quote → lost / declined', { custLost: custLost.code, lost: lostV && [lostV.stage, lostV.quoteStage], canc: canc && canc.stage, decl: decl && [decl.stage, decl.quoteStage] });

  /* G9 expired: a lapsed quote, and a lead untouched for 30 days — which then stops blocking new requests */
  seed();
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 's1', message: 'Quote that will lapse' });
  const e1 = r.ok.leadId;
  await call(L.leadSendQuote, 'prov', { leadId: e1, serviceId: 's1', amountCents: 50000 });
  DOCS.set('serviceLeads/' + e1, Object.assign(lead(e1), { quote: Object.assign({}, lead(e1).quote, { validUntil: Date.now() - 1000 }) }));
  const ev = await viewOf('cust', e1, L.leadListMine);
  const old = Date.now() - 31 * 86400000;
  const stale9 = [];
  for (let i = 0; i < 2; i++) { const x = await call(L.leadCreate, 'cust', { providerId: 'prov', message: 'stale request ' + i }); stale9.push(x.ok.leadId); }
  stale9.forEach((sid) => DOCS.set('serviceLeads/' + sid, Object.assign(lead(sid), { createdAtMs: old, history: [{ at: old, by: 'customer', event: 'created' }] })));
  const sv = await viewOf('prov', stale9[0], L.leadListForProvider);
  const qual = await call(L.leadQualify, 'prov', { leadId: stale9[0] });
  const lostOk = await call(L.leadMarkLost, 'prov', { leadId: stale9[1] });
  const fresh = await call(L.leadCreate, 'cust', { providerId: 'prov', message: 'a fresh request now' });
  ck('G9', ev.stage === 'expired' && ev.quoteStage === 'expired' && sv.stage === 'expired' && qual.code === 'failed-precondition' && /LEAD_EXPIRED|expired/.test(JSON.stringify(qual))
    && lostOk.ok && fresh.ok,
    'a lapsed quote → expired / expired; a lead idle 30 days → expired, refuses progress (can still be marked lost) and no longer counts toward the 3-open limit', { ev: ev && [ev.stage, ev.quoteStage], sv: sv && sv.stage, qual: qual.code, lostOk: lostOk.code || 'ok', fresh: fresh.code || 'ok' });

  /* G10 a marketing quote needs the SERVER marketing approval (owner-writable provider fields are not enough) */
  seed();
  DOCS.set('providers/prov', Object.assign(DOCS.get('providers/prov'), { marketingStatus: 'active', marketingListed: true, marketingCategories: ['branding'] }));
  r = await call(L.leadCreate, 'cust', { providerId: 'prov', serviceId: 'sm', message: 'Need a brand identity' });
  const m10 = r.ok.leadId;
  const forged = await call(L.leadSendQuote, 'prov', { leadId: m10, serviceId: 'sm', amountCents: 2000000 });
  DOCS.set('applicationDecisions/marketing_prov', { applicationId: 'marketing_prov', applicantUid: 'prov', status: 'approved', decidedBy: 'admin1', approvedCategories: ['branding'] });
  DOCS.set('applications/marketing_prov', { uid: 'prov', hub: 'marketing', applicationType: 'marketing', status: 'approved' });
  const real = await call(L.leadSendQuote, 'prov', { leadId: m10, serviceId: 'sm', amountCents: 2000000 });
  ck('G10', forged.code === 'failed-precondition' && /MKT_SERVICE_NOT_APPROVED|not currently approved/.test(JSON.stringify(forged)) && real.ok
    && lead(m10).quote.serviceHub === 'marketing' && lead(m10).quote.serviceCategory === 'branding',
    'a marketing quote is refused on self-written marketing fields alone, allowed once the server decision approves the category, and snapshots hub + category', { forged: forged.code, real: real.code || 'ok' });

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
