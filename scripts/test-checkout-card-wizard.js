#!/usr/bin/env node
/* test-checkout-card-wizard.js — card checkout runs through IntaSend's own form and the server-verified path
 *
 *   node scripts/test-checkout-card-wizard.js
 *
 * Checks checkout.html statically (the money path is in one inline script), then runs each check against a
 * deliberately broken copy: every check must turn red on its sabotage, or it proves nothing.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const fnBody = (code, name) => {
  const i = code.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, open = false;
  for (let j = code.indexOf('{', i); j < code.length; j++) {
    if (code[j] === '{') { d++; open = true; } else if (code[j] === '}') { d--; if (open && !d) return code.slice(i, j + 1); }
  }
  return '';
};

const CHECKS = [
  ['C1  card is no longer blocked as unintegrated', (c) => {
    const m = /UNINTEGRATED_PAYMENTS\s*=\s*\[([^\]]*)\]/.exec(c); return !!m && !/["']card["']/.test(m[1]); }],
  ['C2  no card field exists on SOKONI\'s page (number, expiry, CVV, cc-* autocomplete)', (c) =>
    !/id="card(Num|Cvv|Exp|Name)"/.test(c) && !/autocomplete="cc-/.test(c) && !/placeholder="[^"]*(CVV|Card Number)/i.test(c)],
  ['C3  the wizard pays through the shared server-verified path', (c) => /id="cardPayBtn"[^>]*onclick="sendStkPush\('card'\)"/.test(c)],
  ['C4  the card path prices on the server before IntaSend runs', (c) => {
    const b = fnBody(c, 'sendStkPush'); const k = b.indexOf('httpsCallable(getFunctions(undefined, "us-central1"), "createCheckoutSession")'); return k > -1 && /stkAmount\s*=\s*sessionRes\.data\.serverTotal/.test(b) && k < b.indexOf('new window.IntaSend'); }],
  ['C5  the order is confirmed by verifyIntasendPayment with the session id', (c) => {
    const b = fnBody(c, 'sendStkPush'); return /verifyIntasendPayment/.test(b) && /sessionId:\s*_sessionId/.test(b); }],
  ['C6  a card order carries a server orderId only in the verified branch', (c) => {
    const b = fnBody(c, 'sendStkPush');
    return /if \(verifyRes\.ok && verifyData\.verified && verifyData\.orderId\)[\s\S]{0,900}saveAndRedirect\([^)]*_card \? "card" : "mpesa", verifyData\.orderId/.test(b); }],
  ['C7  IntaSend opens its CARD form for card and the STK prompt for M-Pesa', (c) =>
    /\.\.\.\(_card \? \{ method: "CARD-PAYMENT" \} : \{ phone_number: phone \}\)/.test(fnBody(c, 'sendStkPush'))],
  ['C8  no client-priced IntaSend charge() remains', (c) => !/\.charge\(\s*\{/.test(c)],
  ['C9  without a processor key, card fails closed (never the demo simulation)', (c) => {
    const b = fnBody(c, 'sendStkPush');
    return /if\(!INTASEND_PUBLIC_KEY\)\{\s*if\(_card\)\{[\s\S]{0,300}return;\s*\}\s*_runDemoStkPush/.test(b); }],
  ['C10 the wizard has three labelled steps and a live status region', (c) =>
    (c.match(/class="cw-step[^"]*" data-step="[123]"/g) || []).length === 3 && /id="cardWizBody"[^>]*aria-live="polite"/.test(c)
      && /role="dialog" aria-modal="true" aria-labelledby="cardWizTitle"/.test(c)],
  ['C11 M-Pesa keeps its phone validation', (c) => /if\(!_card\)\{\s*if\(!num \|\| num\.length < 9\)/.test(fnBody(c, 'sendStkPush'))],
  ['C12 the removed raw-card helpers are not still exported', (c) => !/window\.(formatCardNum|formatCardExp|updateCardDisplay)\s*=/.test(c)],
];

/* Each sabotage reintroduces the defect its check exists to catch. */
const SABOTAGE = {
  'C1':  (s) => s.replace('const UNINTEGRATED_PAYMENTS = ["airtel","tkash","equity","mtn","ecocash","chipper"];', 'const UNINTEGRATED_PAYMENTS = ["airtel","tkash","equity","mtn","ecocash","chipper","card"];'),
  'C2':  (s) => s.replace('<div class="cw-body"', '<input class="card-input" type="text" id="cardNum" placeholder="Card Number (16 digits)"><div class="cw-body"'),
  'C3':  (s) => s.replace(`onclick="sendStkPush('card')"`, 'onclick="processCardPayment()"'),
  'C4':  (s) => s.replace('"createCheckoutSession"', '"noSession"'),
  'C5':  (s) => s.replace('sessionId:       _sessionId || null,', 'sessionId: null,'),
  'C6':  (s) => s.replace('_card ? "card" : "mpesa", verifyData.orderId', '"mpesa", verifyData.orderId'),
  'C7':  (s) => s.replace('...(_card ? { method: "CARD-PAYMENT" } : { phone_number: phone }),', 'phone_number: phone,'),
  'C8':  (s) => s.replace('function processCardPayment(){', 'function processCardPayment(){ new window.IntaSend({}).charge({ amount: orderTotal });'),
  'C9':  (s) => s.replace(/if\(!INTASEND_PUBLIC_KEY\)\{\s*if\(_card\)\{/, 'if(!INTASEND_PUBLIC_KEY){ if(false){'),
  'C10': (s) => s.replace('data-step="3"', 'data-step="9"'),
  'C11': (s) => s.replace('if(!_card){\n    if(!num || num.length < 9)', 'if(false){\n    if(!num || num.length < 9)'),
  'C12': (s) => s.replace('function processCardPayment(){', 'window.formatCardNum = function(){};\nfunction processCardPayment(){'),
};

let pass = 0, fail = 0;
console.log('\nCHECKOUT CARD WIZARD — IntaSend form, server-verified\n');
const code = strip(SRC);
for (const [label, fn] of CHECKS) {
  const ok = !!fn(code);
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label);
  ok ? pass++ : fail++;
}
console.log('\n  [sabotage — each check must catch its defect]');
let caught = 0;
for (const [label, fn] of CHECKS) {
  const key = label.split(' ')[0];
  const sab = SABOTAGE[key];
  const broken = sab ? sab(SRC) : SRC;
  if (broken === SRC) { console.log('  FAIL  ' + key + ' sabotage anchor missing'); fail++; continue; }
  const red = !fn(strip(broken));
  console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + key);
  red ? caught++ : fail++;
}
console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + caught + '/' + CHECKS.length + ' sabotages caught');
console.log('  NOT proven here: a real card payment in a browser, or that card is enabled on the SOKONI IntaSend account.\n');
process.exit(fail ? 1 : 0);
