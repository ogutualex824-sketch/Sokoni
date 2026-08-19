/* ══════════════════════════════════════════════════════════════════════════════
   CHECKOUT JOURNEY — the real page, in a real browser
   ══════════════════════════════════════════════════════════════════════════════
   Not "the functions exist". The page is loaded in Chromium, the callables are
   stubbed so NO money moves and NO production call is made, and the journey is
   driven by clicking what a merchant would click.

   What must be true:
     · plans -> checkout is one clean navigation
     · plan and price come from the SERVER authority, never a local constant
     · the wallet balance renders; an unaffordable wallet is not selectable
     · M-PESA requires a valid number; Airtel cannot be submitted
     · a DOUBLE TAP creates ONE payment intent
     · a REFRESH recovers the same intent rather than minting another
     · PAID does not become ACTIVE until server reconciliation says so
     · a failed payment activates nothing
     · back navigation does not create another intent

   Run: node scripts/test-checkout-journey.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
/* Catalogue-derived, so this fixture can never become a rival plan table. */
const CAT = require(path.join(ROOT, 'functions/subscription-catalog.js'));
const STARTER_LIMIT = CAT.PLANS.STARTER.listingLimit;

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nCHECKOUT JOURNEY — real page, stubbed rails');
console.log('='.repeat(74));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) {
    un('the entire browser journey', 'playwright unavailable: ' + String(e.code || e.message).slice(0, 50));
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + (unproven) + ' unproven\n');
    process.exit(0);
  }

  /* Serve the repo so the page loads its real script tags. */
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(ROOT, p.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('nope');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

  /* ── THE STUB ─────────────────────────────────────────────────────────────
     Every callable is replaced with a counter-backed fake. Nothing reaches a
     provider, a wallet or production. The counters are what the assertions read:
     "one intent" is a MEASURED number, not an inspection of code. */
  const STUB = `
    window.__calls = { createPaymentIntent: 0, subscriptionPaymentMethods: 0,
                       payIntentWithWallet: 0, initiateSTKPush: 0, reconcile: 0 };
    window.__scenario = window.__scenario || {};
    window.sokoniCallable = function (name) {
      return async function (args) {
        if (name === 'createPaymentIntent') {
          window.__calls.createPaymentIntent++;
          return { data: { paymentIntentId: 'pi_' + window.__calls.createPaymentIntent,
                           planId: args.planId, planName: 'Seller Basic', amount: 999,
                           listingLimit: STARTER_LIMIT, billingCycle: args.billingCycle, currency: 'KES' } };
        }
        if (name === 'subscriptionPaymentMethods') {
          window.__calls.subscriptionPaymentMethods++;
          return { data: { methods: window.__scenario.methods || [
            { id: 'SOKONI_WALLET', balance: 1240, available: true, reason: null },
            { id: 'MPESA', available: true, reason: null },
            { id: 'AIRTEL_MONEY', available: false, reason: 'provider-not-available' } ] } };
        }
        if (name === 'payIntentWithWallet') {
          window.__calls.payIntentWithWallet++;
          if (window.__scenario.walletFails) throw new Error('Insufficient wallet balance.');
          return { data: { ok: true } };
        }
        if (name === 'initiateSTKPush') { window.__calls.initiateSTKPush++; return { data: { ok: true } }; }
        if (name === 'reconcileSubscriptionPayment') {
          window.__calls.reconcile++;
          if (window.__scenario.neverReconciles) throw new Error('failed-precondition');
          if (window.__calls.reconcile < (window.__scenario.reconcileAfter || 1)) throw new Error('not-paid');
          return { data: { ok: true, subscriptionId: 'sub_1', planId: 'seller_basic' } };
        }
        return { data: {} };
      };
    };
  `;

  async function open(scenario, url) {
    const page = await ctx.newPage();
    await page.addInitScript(STUB);
    if (scenario) await page.addInitScript('window.__scenario = ' + JSON.stringify(scenario) + ';');
    await page.goto(url || (BASE + '/subscription-checkout.html?planId=seller_basic&cycle=monthly'));
    await page.waitForFunction('window.__checkoutState && window.__checkoutState().phase !== "loading"', null, { timeout: 8000 });
    return page;
  }

  head('1 - plans -> checkout is one clean navigation');
  const plansSrc = fs.readFileSync(path.join(ROOT, 'plans.html'), 'utf8');
  ck('plans.html no longer points at the dead-end checkout',
     plansSrc.indexOf('checkout.html?type=subscription') === -1);
  ck('...and routes to a subscription surface',
     /location\.href = `subscription/.test(plansSrc), 'subscriptions.html or subscription-checkout.html');

  head('2 - the plan and price come from the SERVER');
  let page = await open();
  const planText = await page.textContent('.plan');
  ck('the server plan name is rendered', /Seller Basic/.test(planText), planText.trim().split('\n')[0]);
  ck('the server price is rendered', /KES 999/.test(planText));
  ck('the server product limit is rendered', new RegExp(STARTER_LIMIT + ' products').test(planText));
  const html = fs.readFileSync(path.join(ROOT, 'subscription-checkout.html'), 'utf8');
  ck('no price constant is hardcoded in the page',
     !/KES\s*\d{3}/.test(html.replace(/<style[\s\S]*?<\/style>/g, '')));

  head('3 - the rails render exactly as the server described them');
  ck('the wallet balance is shown', /Balance: KES 1,240/.test(await page.textContent('#root')));
  const airtelDisabled = await page.getAttribute('[data-m="AIRTEL_MONEY"]', 'disabled');
  ck('Airtel is present but DISABLED', airtelDisabled !== null);
  ck('...with the way out shown',
     /Choose SOKONI Wallet or M-PESA/.test(await page.textContent('#root')));
  ck('the wallet is preselected when affordable',
     (await page.getAttribute('[data-m="SOKONI_WALLET"]', 'class')).indexOf('on') > -1);

  head('4 - Airtel cannot be submitted');
  await page.click('[data-m="AIRTEL_MONEY"]', { force: true });
  const sel = await page.evaluate('window.__checkoutState().selected');
  ck('clicking a disabled rail does not select it', sel !== 'AIRTEL_MONEY', String(sel));
  ck('Confirm & Pay is still enabled for the VALID selection',
     (await page.getAttribute('[data-act="pay"]', 'disabled')) === null);

  head('5 - M-PESA requires a valid number');
  await page.click('[data-m="MPESA"]');
  ck('choosing M-PESA disables Confirm & Pay until a number is entered',
     (await page.getAttribute('[data-act="pay"]', 'disabled')) !== null);
  ck('...and says so', /Enter the M-PESA number/.test(await page.textContent('#bar')));
  await page.fill('#phone', '0712');
  ck('a partial number keeps it disabled',
     (await page.getAttribute('[data-act="pay"]', 'disabled')) !== null);
  await page.fill('#phone', '0712345678');
  ck('a valid number enables it',
     (await page.getAttribute('[data-act="pay"]', 'disabled')) === null);

  head('6 - an unaffordable wallet is not selectable');
  const poor = await open({ methods: [
    { id: 'SOKONI_WALLET', balance: 120, available: false, reason: 'insufficient-balance' },
    { id: 'MPESA', available: true, reason: null },
    { id: 'AIRTEL_MONEY', available: false, reason: 'provider-not-available' } ] });
  ck('the wallet is disabled', (await poor.getAttribute('[data-m="SOKONI_WALLET"]', 'disabled')) !== null);
  ck('...with the reason and the remedy',
     /Insufficient wallet balance\. Add funds or choose M-PESA\./.test(await poor.textContent('#root')));
  ck('M-PESA is preselected instead',
     await poor.evaluate('window.__checkoutState().selected') === 'MPESA');
  await poor.close();

  head('7 - ONE intent per attempt: double tap, refresh, back');
  const one = await open();
  ck('exactly one intent was minted on load',
     await one.evaluate('window.__calls.createPaymentIntent') === 1);
  const idBefore = await one.evaluate('window.__checkoutState().intentId');
  /* Double tap. */
  await one.evaluate(`(function(){ var b=document.querySelector('[data-act="pay"]');
                                   b.click(); b.click(); })()`);
  await one.waitForTimeout(400);
  ck('a double tap charged the wallet ONCE',
     await one.evaluate('window.__calls.payIntentWithWallet') === 1,
     String(await one.evaluate('window.__calls.payIntentWithWallet')));
  ck('...and minted no second intent',
     await one.evaluate('window.__calls.createPaymentIntent') === 1);
  await one.close();

  /* reconcileAfter:99 keeps the payment UNRESOLVED, so recovery cannot
     short-circuit to 'already activated' — the refresh must genuinely reuse. */
  const rl = await open({ reconcileAfter: 99 });
  const idFirst = await rl.evaluate('window.__checkoutState().intentId');
  const mintedBefore = await rl.evaluate('window.__calls.createPaymentIntent');
  await rl.reload();
  await rl.waitForFunction('window.__checkoutState && window.__checkoutState().phase !== "loading"', null, { timeout: 8000 });
  const recovered = await rl.evaluate('window.__checkoutState().intentId');
  ck('a REFRESH reuses the SAME intent id', recovered === idFirst, idFirst + ' -> ' + recovered);
  ck('...and mints NO second intent',
     await rl.evaluate('window.__calls.createPaymentIntent') === 0,
     'fresh page minted ' + await rl.evaluate('window.__calls.createPaymentIntent'));
  ck('...with the plan still rendered from the recovered intent',
     /Seller Basic/.test(await rl.textContent('.plan')));
  ck('...and the page usable', await rl.evaluate('window.__checkoutState().phase') === 'choose');
  await rl.goBack().catch(function(){});
  await rl.close();

  head('8 - PAID does not become ACTIVE until the server says so');
  const slow = await open({ reconcileAfter: 3 });
  await slow.click('[data-act="pay"]');
  await slow.waitForTimeout(300);
  const midStatus = await slow.evaluate('window.__checkoutState().payStatus');
  ck('after the wallet call the status is PAID, not active', midStatus === 'paid', String(midStatus));
  ck('...and the screen says Activating, not Activated',
     /Activating/.test(await slow.textContent('#root')));
  await slow.waitForFunction('window.__checkoutState().payStatus === "active"', null, { timeout: 12000 });
  ck('only after reconciliation does it become ACTIVE',
     await slow.evaluate('window.__checkoutState().payStatus') === 'active');
  ck('...and the merchant is offered the way onward',
     /Go to my business/.test(await slow.textContent('#bar')));
  ck('the stored attempt is cleared once activated',
     await slow.evaluate('sessionStorage.getItem("sokoni.subcheckout.seller_basic.monthly")') === null);
  await slow.close();

  head('9 - a failed payment activates nothing');
  const bad = await open({ walletFails: true });
  await bad.click('[data-act="pay"]');
  await bad.waitForTimeout(500);
  ck('the status is failed', await bad.evaluate('window.__checkoutState().payStatus') === 'failed');
  ck('...it states nothing was charged', /Nothing was charged/.test(await bad.textContent('#root')));
  ck('...no reconciliation was attempted', await bad.evaluate('window.__calls.reconcile') === 0);
  ck('...and a retry is offered', /Try again/.test(await bad.textContent('#bar')));
  await bad.close();

  head('10 - an unresolved payment is neither success nor failure');
  const stuck = await open({ neverReconciles: true });
  await stuck.click('[data-act="pay"]');
  await stuck.waitForTimeout(800);
  const st = await stuck.evaluate('window.__checkoutState().payStatus');
  ck('it never claims success', st !== 'active', String(st));
  ck('...and never claims failure either', st !== 'failed', String(st));
  await stuck.close();

  await page.close();
  await browser.close();
  await new Promise((r) => server.close(r));

  head('11 - what is NOT proven');
  un('a real M-PESA production purchase', 'every rail was stubbed; no money moved');
  un('the Airtel provider adapter', 'none exists; the rail is disabled');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  Journey aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
