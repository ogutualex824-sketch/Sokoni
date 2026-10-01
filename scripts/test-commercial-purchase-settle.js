'use strict';
/* webhookIntasend × partner plans / promotion purchases (owner 2026-10-01). Runs the REAL commercial-purchase-settle.js
   with the REAL commercial-entitlements.js (ported byte-identical from 764cb66) on a serialised in-memory Firestore.
     node scripts/test-commercial-purchase-settle.js */
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'functions', 'commercial-purchase-settle.js'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
const DOCS = new Map();
const TSv = (ms) => ({ __ts: ms, toMillis: () => ms });
const apply = (prev, d, merge) => { const o = merge ? Object.assign({}, prev || {}) : {}; for (const [k, v] of Object.entries(d)) o[k] = v; return o; };
const ref = (p) => ({ path: p, get: async () => ({ exists: DOCS.has(p), data: () => DOCS.get(p) }), set: async (d, o) => { DOCS.set(p, apply(DOCS.get(p), d, o && o.merge)); } });
let chain = Promise.resolve();
const db = { collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
  runTransaction: (fn) => { const run = chain.then(async () => { const w = [];
    const t = { get: async (r) => ({ exists: DOCS.has(r.path), data: () => DOCS.get(r.path) }),
      set: (r, d, o) => w.push(() => DOCS.set(r.path, apply(DOCS.get(r.path), d, o && o.merge))),
      update: (r, d) => w.push(() => DOCS.set(r.path, apply(DOCS.get(r.path), d, true))),
      create: (r, d) => w.push(() => { if (DOCS.has(r.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }); DOCS.set(r.path, d); }) };
    const out = await fn(t); w.forEach((f) => f()); return out; }); chain = run.catch(() => {}); return run; } };
const admin = { firestore: { FieldValue: { serverTimestamp: () => 'TS' }, Timestamp: { fromMillis: TSv } } };
const intent = (ref, o) => DOCS.set('paymentIntents/' + ref, Object.assign({ uid: 'partnerA', purpose: 'partner_subscription', amount: 2500,
  metadata: { type: 'partner_subscription', ceMeta: { domain: 'partner', planId: 'starter' } } }, o));
const pay = (ref, o) => S.settleCommercialPayment(db, admin, Object.assign({ apiRef: ref, intentRef: ref, state: 'COMPLETE', gross: 2500, currency: 'KES', payerUid: 'partnerA' }, o));
DOCS.set('financialProviders/partnerA', { listingStatus: 'approved' });

(async () => {
  console.log('\nCommercial purchase settlement\n');
  const ceA = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'functions', 'commercial-entitlements.js'))).digest('hex');
  ck('B-0', ceA.slice(0, 16) === '5c2eb235026ddb13', 'commercial-entitlements.js is byte-identical to sokoni-4d\'s 764cb66', ceA.slice(0, 16));
  intent('pi_1');
  let r = await pay('pi_1');
  const ent = DOCS.get('entitlements/partnerA__partner'), rec = DOCS.get('commercialFulfilments/pi_1');
  ck('S-1', r.outcome === 'fulfilled' && ent && ent.planId === 'starter' && ent.status === 'active' && rec && rec.outcome === 'fulfilled' && DOCS.get('paymentIntents/pi_1').status === 'paid',
    'verified KES 2,500 → Starter entitlement active, one fulfilment receipt, intent paid', { r, ent, rec });
  ck('S-2', !DOCS.has('subscriptions/partnerA') && ![...DOCS.keys()].some((k) => /^wallets\//.test(k)), 'never subscriptions/{uid}, never a wallet');
  const snap = JSON.stringify([...DOCS.entries()]);
  r = await pay('pi_1');
  ck('I-1', r.outcome === 'replay' && JSON.stringify([...DOCS.entries()]) === snap, 'a REPLAYED callback has no second effect', r);
  intent('pi_2');
  const three = await Promise.all([pay('pi_2'), pay('pi_2'), pay('pi_2')]);
  ck('I-2', three.filter((x) => x.outcome === 'fulfilled').length === 1, 'three concurrent callbacks → ONE fulfilment', three.map((x) => x.outcome));
  intent('pi_3', { uid: 'partnerB' }); DOCS.set('financialProviders/partnerB', { listingStatus: 'approved' });
  r = await pay('pi_3', { gross: 2000, payerUid: 'partnerB' });
  ck('R-1', r.outcome === 'review' && !DOCS.has('entitlements/partnerB__partner') && DOCS.get('commercialFulfilments/pi_3').outcome === 'review',
    'a SHORT payment (2,000 for a 2,500 plan) buys nothing — held for review', r);
  intent('pi_4', { uid: 'partnerC' });
  r = await pay('pi_4', { currency: 'USD', payerUid: 'partnerC' });
  ck('R-2', r.outcome === 'review' && r.reason === 'currency_not_kes' && !DOCS.has('entitlements/partnerC__partner'), 'non-KES → review, nothing granted', r);
  intent('pi_5', { uid: 'partnerD' });
  r = await pay('pi_5', { payerUid: 'someoneElse' });
  ck('R-3', r.outcome === 'review' && r.reason === 'payer_not_owner', 'a payment by someone other than the intent owner → review', r);
  intent('pi_6', { uid: 'partnerE' });
  r = await pay('pi_6', { state: 'FAILED', payerUid: 'partnerE' });
  ck('F-1', r.outcome === 'failed' && DOCS.get('paymentIntents/pi_6').status === 'failed' && !DOCS.has('entitlements/partnerE__partner'), 'a FAILED payment grants nothing', r);
  intent('pi_7', { purpose: 'promotion_purchase', amount: 12000, metadata: { type: 'promotion_purchase', ceMeta: { domain: 'promotion', productId: 'homepage_spotlight_7d', days: 7, placement: 'homepage' } } });
  r = await pay('pi_7', { gross: 12000 });
  const camp = DOCS.get('promotionCampaigns/pi_7');
  ck('P-1', r.outcome === 'fulfilled' && camp && camp.status === 'active' && camp.targetId === 'partnerA', 'a verified Homepage Spotlight purchase activates the campaign on the buyer\'s OWN listing', camp);
  DOCS.set('paymentIntents/x1', { purpose: 'donation' });
  r = await S.settleCommercialPayment(db, admin, { apiRef: 'x1', intentRef: 'x1', state: 'COMPLETE', gross: 10 });
  ck('N-1', r === false, 'any other purpose is NOT handled here (the caller continues)');
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const seg = idx.slice(idx.indexOf('exports.webhookIntasend = onRequest('));
  ck('W-1', seg.indexOf("require('./commercial-purchase-settle')") > 0 && seg.indexOf("require('./commercial-purchase-settle')") < seg.indexOf('_holdServiceBookingPayment(db, admin')
    && /settleCommercialPayment\(db, admin, \{[\s\S]{0,300}gross: +invoice\.value/.test(seg), 'webhookIntasend settles these on GROSS, before every wallet/commission branch');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
