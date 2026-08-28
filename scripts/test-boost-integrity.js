'use strict';
/* Slice 5 — Boost money-integrity test.
   Proves the server derives the boost price (client cannot set it), and that buyBoost() now
   routes through the server-minted payment intent instead of a client-held amount + toast.
   The boost pricer is pure (no Firestore), so no emulator is needed.
   Run: node scripts/test-boost-integrity.js
*/
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'functions', 'payment-purposes.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  [PASS] ' + n); };
const no = (n, d) => { fail++; console.log('  [FAIL] ' + n + (d ? '  -> ' + d : '')); };
const threw = async (fn, code) => { try { await fn(); return false; } catch (e) { return code ? (e && e.code) === code : true; } };

(async () => {
  /* boost is a registered purpose (createPaymentIntent can now mint a boost intent). */
  (P.isRegistered('boost')) ? ok('`boost` is a registered payment purpose') : no('boost not registered');

  /* Server price per key — authoritative, from the server map. */
  const want = { basic: 200, premium: 500, homepage: 2000, urgent: 100 };
  let priceOk = true, detail = [];
  for (const k of Object.keys(want)) {
    const q = await P.priceFor('boost', 'u1', { boostKey: k });
    if (q.amount !== want[k] || q.purpose !== 'boost' || q.resourceType !== 'listingBoost') { priceOk = false; detail.push(`${k}:${q.amount}`); }
  }
  priceOk ? ok('server derives the price per boost key (basic 200 / premium 500 / homepage 2000 / urgent 100)') : no('boost price map wrong', detail.join(','));

  /* THE money hole: a client-supplied amount is IGNORED — the server price wins. */
  const forged = await P.priceFor('boost', 'u1', { boostKey: 'premium', amount: 1, depositAmount: 1, amountCents: 1, price: 1 });
  (forged.amount === 500) ? ok('forged client amount is IGNORED — server price (500) is used, not the request (1)') : no('client amount leaked', JSON.stringify(forged));

  /* Unknown / missing boost key is refused (no silent default price). */
  (await threw(() => P.priceFor('boost', 'u1', { boostKey: 'mega-forge' }), 'invalid-argument')) ? ok('unknown boost key -> invalid-argument (no default price)') : no('unknown key not rejected');
  (await threw(() => P.priceFor('boost', 'u1', {}), 'invalid-argument')) ? ok('missing boost key -> invalid-argument') : no('missing key not rejected');

  /* resourceId links the paid intent to the listing when supplied. */
  const withListing = await P.priceFor('boost', 'u1', { boostKey: 'basic', listingId: 'PROD123' });
  (withListing.resourceId === 'PROD123') ? ok('resourceId records the boosted listing') : no('resourceId not recorded', JSON.stringify(withListing));

  /* Client contract: buyBoost now routes through the server intent, not a client price table. */
  const sub = read('subscriptions.html');
  const fn = (sub.match(/async function buyBoost\([\s\S]*?\n\}/) || sub.match(/function buyBoost\([\s\S]*?\n\}/) || [''])[0];
  (/createPaymentIntent'\)[\s\S]*purpose:\s*'boost'/.test(fn)) ? ok('buyBoost calls createPaymentIntent({purpose:boost})') : no('buyBoost not routed through the intent');
  (/paymentIntentId:\s*_intent\.ref/.test(fn) && /depositAmount:\s*_intent\.amount/.test(fn)) ? ok('buyBoost passes the SERVER ref + amount to SokoniPay.gateway') : no('buyBoost not using server figures');
  (!/const prices\s*=\s*\{/.test(fn) && !/prices\[key\]/.test(fn)) ? ok('the client-held boost price map is GONE from buyBoost') : no('client price table still in buyBoost');
  (!/activated!.*5 minutes|will be boosted within 5 minutes/.test(fn)) ? ok('the fabricated "activated in 5 minutes" claim is removed (success reflects settled payment only)') : no('still claims activation without a server grant');

  /* ── Slice 5A: the other two entry points ── */

  /* marketing_boost purpose — distinct product, server price per plan. */
  (P.isRegistered('marketing_boost')) ? ok('`marketing_boost` is a registered payment purpose') : no('marketing_boost not registered');
  const mkt = { pro: 500, vip: 1500 };
  let mktOk = true, mdetail = [];
  for (const k of Object.keys(mkt)) { const q = await P.priceFor('marketing_boost', 'u1', { plan: k }); if (q.amount !== mkt[k] || q.resourceType !== 'marketingBoost') { mktOk = false; mdetail.push(`${k}:${q.amount}`); } }
  mktOk ? ok('server derives the marketing boost price per plan (pro 500 / vip 1500)') : no('marketing_boost price wrong', mdetail.join(','));
  const mForged = await P.priceFor('marketing_boost', 'u1', { plan: 'vip', amount: 1, serviceTotal: 1, amountCents: 1 });
  (mForged.amount === 1500) ? ok('marketing_boost: forged client amount IGNORED (server 1500 wins)') : no('marketing amount leaked', JSON.stringify(mForged));
  (await threw(() => P.priceFor('marketing_boost', 'u1', { plan: 'forge' }), 'invalid-argument')) ? ok('marketing_boost unknown plan -> invalid-argument') : no('marketing unknown plan not rejected');

  /* boostListing (sokoni-pay.js) contract. */
  const pay = read('sokoni-pay.js');
  const bl = (pay.match(/async function boostListing\([\s\S]*?\n\}/) || pay.match(/function boostListing\([\s\S]*?\n\}/) || [''])[0];
  (/createPaymentIntent'\)\([\s\S]*purpose:\s*'boost'/.test(bl) && /paymentIntentId:\s*_intent\.ref/.test(bl) && /depositAmount:\s*_intent\.amount/.test(bl))
    ? ok('boostListing routes through the server intent (purpose:boost, server ref+amount)') : no('boostListing not routed through the intent');
  (!/localStorage\.setItem\("sokoniListingBoosts"/.test(bl)) ? ok('boostListing no longer writes a client "boost active" localStorage grant') : no('boostListing still grants via localStorage');

  /* submitBoost (marketing.html) PAID path contract. */
  const mk = read('marketing.html');
  const paid = (mk.match(/Paid plans[\s\S]*?\n  \}\)\(\);/) || [''])[0];
  (/createPaymentIntent'\)\([\s\S]*purpose:\s*'marketing_boost'/.test(paid) && /paymentIntentId:\s*_intent\.ref/.test(paid) && /depositAmount:\s*_intent\.amount/.test(paid))
    ? ok('submitBoost paid path routes through the server intent (purpose:marketing_boost, server ref+amount)') : no('submitBoost not routed through the intent');
  (!/_saveBoostRecord\(/.test(paid) && !/saveCommission\(/.test(paid) && !/serviceTotal:\s*planPrices/.test(paid))
    ? ok('submitBoost paid path no longer client-records the boost (no _saveBoostRecord/saveCommission/client price)') : no('submitBoost still client-establishes the purchase');

  console.log('\n' + (fail === 0 ? `boost-integrity: PASS ${pass}/${pass}` : `boost-integrity: ${fail} FAIL of ${pass + fail}`));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e && e.stack || e); process.exit(1); });
