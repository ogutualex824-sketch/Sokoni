/* ══════════════════════════════════════════════════════════════════════════════
   DEPLOYED CHECKOUT — verify what production actually SERVES
   ══════════════════════════════════════════════════════════════════════════════
   Run AFTER the hosting deploy and BEFORE any real payment.

   This fetches the live pages over HTTPS with a cache-buster and asserts the
   shipped markup. It is deliberately honest about its own limits: the parts of
   the checklist that need an AUTHENTICATED merchant session with a live App
   Check token (wallet balance, trial eligibility, the disabled Confirm & Pay
   state) cannot be reached by an anonymous fetch, and are reported UNPROVEN
   rather than quietly skipped or — worse — asserted from the markup as if the
   runtime had been observed.

   What it CAN prove authoritatively: the deployed bytes contain the bootstrap,
   the cycle-selection step, the payment disclosure, the CHK reference, and that
   the price is not hardcoded. Those are exactly the things that were wrong
   before.

     node scripts/verify-deployed-checkout.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const https = require('https');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

const HOST = 'https://mysokoni.co.ke';
const cb = () => '?cb=' + Math.floor(Math.random() * 1e9);

function fetch(p) {
  return new Promise((resolve, reject) => {
    https.get(HOST + p, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        /* cleanUrls 301s .html -> extensionless; follow once */
        const loc = res.headers.location.replace(HOST, '');
        res.resume();
        return resolve(fetch(loc));
      }
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

console.log('\nDEPLOYED CHECKOUT — what production serves');
console.log('='.repeat(76));

(async () => {
  head('0 - which build is live');
  const v = await fetch('/version.json' + cb());
  let ver = {};
  try { ver = JSON.parse(v.body); } catch (_) {}
  console.log('  commit       : ' + (ver.commitShort || '?'));
  console.log('  branch       : ' + (ver.branch || '?'));
  console.log('  cacheVersion : ' + (ver.cacheVersion || '?'));
  console.log('  dirtyTree    : ' + ver.dirtyWorkingTree);
  ck('the live build has a CLEAN working tree', ver.dirtyWorkingTree === false,
     String(ver.dirtyWorkingTree));

  head('1 - the checkout ships its bootstrap (the defect that blocked the last purchase)');
  const co = await fetch('/subscription-checkout.html' + cb());
  ck('the page is served', co.status === 200, 'HTTP ' + co.status);
  ck('security.js', co.body.indexOf('security.js') > -1);
  ck('sokoni-init.js as a MODULE',
     /<script[^>]*type="module"[^>]*src="sokoni-init\.js"|<script[^>]*src="sokoni-init\.js"[^>]*type="module"/.test(co.body));
  ck('auth-guard.js', co.body.indexOf('auth-guard.js') > -1);
  ck('sokoni-subscription-checkout.js', co.body.indexOf('sokoni-subscription-checkout.js') > -1);
  ck('it WAITS for the async bootstrap', co.body.indexOf('function whenReady(') > -1);

  head('2 - the billing cycle is chosen before money is committed');
  ck('a cycle phase exists', co.body.indexOf("S.phase === 'cycle'") > -1);
  ck('nothing is minted until the merchant confirms',
     co.body.indexOf('if (hasBoth && !S.cycleConfirmed)') > -1);
  ck('prices come from the catalogue, not a constant',
     co.body.indexOf("callable('subGetPlans')") > -1 && co.body.indexOf('99900') === -1);
  ck('the URL only PRESELECTS the cycle',
     co.body.indexOf('preselected from the URL, not decided') > -1);

  head('3 - the merchant is told when money moves');
  ck('the cycle screen states it', co.body.indexOf('-day trial starts immediately') > -1);
  ck('the payment screen restates it',
     co.body.indexOf("esc(S.trialDays) + '-day trial starts immediately") > -1);

  head('4 - a failure is traceable, not raw');
  ck('every attempt carries a CHK reference', /var CHK = 'CHK-'/.test(co.body));
  ck('the merchant sees the reference', co.body.indexOf('Reference: ') > -1);
  ck('...and NOT a raw internal message', co.body.indexOf("esc(S.error || '')") === -1);

  head('5 - one purchase, one intent, across a reload');
  ck('the attempt is persisted', co.body.indexOf('sessionStorage') > -1);
  ck('a stored intent is REUSED, never re-minted',
     co.body.indexOf('RECOVER before minting') > -1);

  head('6 - the plans page offers BUY separately from the free trial');
  const pl = await fetch('/plans.html' + cb());
  ck('the page is served', pl.status === 200, 'HTTP ' + pl.status);
  ck('a paid plan always renders Subscribe',
     pl.body.indexOf("openModal(${planArg},'buy')") > -1);
  ck('the trial button is gated on ELIGIBILITY only',
     pl.body.indexOf('const offerTrial = trialDays > 0 && trialEligible;') > -1);
  ck('eligibility defaults to FALSE when unresolved',
     pl.body.indexOf('let trialEligible = false;') > -1);
  /* SCOPED to confirmSubscribe. A page-wide search for "if (plan.trialDays > 0)"
     also matches the harmless "} else if (plan.trialDays > 0) {" in openModal,
     which only chooses the trial NOTE text — and it reported THE ORIGINAL DEFECT
     IS LIVE against a correct deployment. A regression detector that cries wolf
     on the fix is worse than no detector: the next real failure gets waved past. */
  const liveConfirm = (() => {
    const i = pl.body.indexOf('async function confirmSubscribe');
    if (i < 0) return '';
    const j = pl.body.indexOf("document.getElementById('modal-overlay').addEventListener", i);
    return pl.body.slice(i, j > i ? j : i + 3000);
  })();
  ck('confirmSubscribe is present in the deployed page', liveConfirm.length > 200,
     liveConfirm.length + ' chars');
  ck('it branches on the ACTION the merchant chose',
     liveConfirm.indexOf("_pendingAction === 'trial'") > -1);
  ck('REGRESSION: purchase no longer branches on the plan having trial days',
     liveConfirm.indexOf('if (plan.trialDays > 0)') === -1,
     liveConfirm.indexOf('if (plan.trialDays > 0)') > -1 ? 'THE ORIGINAL DEFECT IS LIVE' : 'gone');

  head('7 - the merchant route is unchanged');
  const me = await fetch('/sokoni-merchant-entry.js' + cb());
  ck("MERCHANT_URL is '/merchant'", /var MERCHANT_URL = '\/merchant'/.test(me.body),
     (me.body.match(/var MERCHANT_URL = '[^']*'/) || ['?'])[0]);
  ck('NOT /merchant-v2 (cutover is not authorised)',
     me.body.indexOf("MERCHANT_URL = '/merchant-v2'") === -1);

  head('8 - what an anonymous fetch CANNOT prove');
  un('the wallet balance renders correctly', 'needs an authenticated merchant session');
  un('wallet is unavailable when the balance is insufficient', 'needs a real balance');
  un('trial eligibility displays correctly for THIS merchant', 'needs the signed-in uid');
  un('Confirm & Pay stays disabled until the phone number is valid',
     'needs a live App Check token + rendered DOM');
  un('Airtel renders visible-but-unavailable', 'server-driven; needs the live methods call');
  un('a real M-PESA STK prompt', 'needs a handset');
  un('a genuine IntaSend webhook', 'needs a real payment');
  console.log('\n  These are NOT skipped — they are the human checklist. They must be');
  console.log('  observed in a signed-in browser BEFORE the first real payment.');

  console.log('\n' + '='.repeat(76));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(76) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  Verification aborted: ' + (e && e.message) + '\n'); process.exit(1); });
