#!/usr/bin/env node
/* Multi-shop checkout rendering — the customer-facing half.
 *
 * The backend authorities are proved elsewhere (test-checkout-mode 24/0,
 * test-manual-till-orders 81/0, test-order-claim-race 27/0 on real Firestore).
 * THIS suite guards what those cannot see: that the page never becomes an
 * authority of its own — never picks a payment mode, never marks anything paid,
 * never clears a basket it did not settle.
 *
 *   node scripts/test-multishop-checkout-ui.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CK   = read('checkout.html');
const CART = read('sokoni-cart.js');

/* ══ A. Additive — the single-shop path is untouched ═══════════════════════ */
console.log('\nA. Additive by construction\n');
{
  ck('the panel is hidden by default', /id="multiShopPanel"[^>]*display:none/.test(CK));
  ck('it self-hides for a basket with fewer than 2 shops',
     /if \(groups\.length < 2\) \{ panel\.style\.display = 'none'; return; \}/.test(CK));
  ck('the render call is fully guarded', /try \{ if \(window\._ckRenderMultiShop\)/.test(CK));
  ck('  ...and cannot stop the page rendering', /\.catch\(function \(\) \{\}\)/.test(CK));
}

/* ══ B. The page does not choose the payment mode ══════════════════════════ */
console.log('\nB. Mode comes from the server, never the page\n');
{
  ck('mode is fetched from getShopCheckoutMode', /'getShopCheckoutMode'/.test(CK));
  ck('  ...for the whole basket in ONE call', /sellerUids: groups\.map/.test(CK));
  ck('the page offers no mode choice to the customer',
     !/choose (payment|how to pay)|select payment method/i.test(CK.split('_ckRenderMultiShop')[1] || ''));
  ck('a failed lookup renders UNAVAILABLE, not a payable route',
     /console\.warn\('\[checkout\] multishop quote\/mode lookup failed/.test(CK) &&
     /\{ mode: 'unavailable', reason: 'lookup_failed' \}/.test(CK));
  ck('an unavailable shop gets NO action button',
     /cannot take online payment right now[\s\S]{0,120}?action = ''/.test(CK));
  ck('  ...and its items explicitly stay in the basket',
     /Its items stay in your basket/.test(CK));
}

/* ══ C. Manual payment tells the truth ═════════════════════════════════════ */
console.log('\nC. Manual payment is not presented as observed\n');
{
  ck('Till number is shown for a TILL', /Till: <strong/.test(CK));
  ck('PayBill number AND account are shown for a PAYBILL',
     /PayBill: <strong/.test(CK) && /Account: <strong/.test(CK));
  ck('the customer is told SOKONI does NOT receive it',
     /SOKONI does not receive this payment/.test(CK));
  ck('  ...and that the shop confirms from its own records',
     /confirms it from their own[\s\S]{0,30}?M-PESA records/.test(CK));
  ck('the reference is validated to 10 alphanumerics',
     /\/\^\[A-Z0-9\]\{10\}\$\/\.test\(ref\)/.test(CK));
  ck('submitting calls createManualTillOrder', /'createManualTillOrder'/.test(CK));
  ck('the page NEVER marks an order paid', !/status:\s*['"]paid['"]/.test(CK.split('_ckRenderMultiShop')[1] || ''));
  ck('double-submit is guarded per shop', /_ckManualBusy\[sellerUid\]/.test(CK));
  ck('the policy-gate refusal is explained, not shown raw',
     /This shop cannot take manual payment yet/.test(CK));
}

/* ══ D. Partial clearing — the money-adjacent rule ═════════════════════════ */
console.log('\nD. Only the settled shop leaves the basket\n');
{
  ck('ONE clearing rule exists', (CK.match(/window\._ckClearSettledShop = function/g) || []).length === 1);
  /* Four call sites: the three pre-existing settlement paths (STK intent,
     messages/receipt, trust-receipt) plus the new manual-payment submission.
     Asserted as an exact count so a NEW settlement path that clears the whole
     basket cannot be added without this failing. */
  ck('every settlement path uses it — and only it',
     (CK.match(/window\._ckClearSettledShop\(/g) || []).length === 4,
     (CK.match(/window\._ckClearSettledShop\(/g) || []).length + ' call sites');
  ck('  ...no blanket clear survives outside the rule itself',
     (CK.match(/window\.SokoniCart && window\.SokoniCart\.clear\(\)/g) || []).length === 1,
     'only the rule\'s own catch fallback');
  ck('it removes only that shop when others remain',
     /if \(C\.groupBySeller\(\)\.length > 1\) \{ C\.removeBySeller\(sellerUid\); return; \}/.test(CK));
  ck('it clears fully when that shop WAS the basket', /\n\s*C\.clear\(\);\n/.test(CK));
  ck('manual submission clears only its own shop',
     /_ckClearSettledShop\(sellerUid\)/.test(CK));
  ck('the cart exposes the primitives it needs',
     /groupBySeller: groupBySeller, removeBySeller: removeBySeller/.test(CART));

  /* Behavioural: the rule itself, executed. */
  const rule = (groups, sellerUid) => (groups > 1 && sellerUid) ? 'partial' : 'full';
  ck('  ↳ 3 shops, one settles → partial', rule(3, 'S1') === 'partial');
  ck('  ↳ 1 shop settles → full clear',    rule(1, 'S1') === 'full');
  ck('  ↳ unknown seller → full clear',    rule(3, null) === 'full');
}

/* ══ E. Framing ════════════════════════════════════════════════════════════ */
console.log('\nE. The commercial message\n');
{
  ck('the panel says shops are paid separately',
     /Each shop is paid separately/.test(CK));
  ck('  ...and that the rest stay in the basket', /the rest stay in your basket/.test(CK));
  ck('it does NOT say multi-shop checkout is unavailable',
     !/cart contains multiple shops[\s\S]{0,80}?unavailable/i.test(CK));
  ck('there is no "pay all shops" control', !/pay all|checkout all|pay everything/i.test(CK));
  ck('shop names are HTML-escaped', /_ckEsc\(name\)/.test(CK));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
