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

  console.log('\n' + (fail === 0 ? `boost-integrity: PASS ${pass}/${pass}` : `boost-integrity: ${fail} FAIL of ${pass + fail}`));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e && e.stack || e); process.exit(1); });
