/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT V2 — ORDER SHARE (WhatsApp) beside PRINT
   ══════════════════════════════════════════════════════════════════════════════
   The risk in this feature is not layout, it is ADDRESSING. Messaging the wrong
   person about someone else's order is a privacy breach, and a "helpful" fallback
   is exactly how that happens. So the rules under test are:

     · the number comes from the ORDER's own buyer contact and nowhere else
     · a number that is not a plausible Kenyan mobile yields NOTHING — never a
       silently "corrected" number that might belong to a real stranger
     · no phone on the order -> the button says so; it does not open a chat
     · a PICKUP order never gets an invented delivery address
     · the shell's containment rule still holds: no window.open, no target=_blank

   The functions are EXTRACTED FROM THE SHIPPED SHELL and executed, not
   re-implemented here — a re-implementation would test this file's idea of the
   rule rather than the code merchants actually run.

   Run: node scripts/test-merchant-order-share.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\nMERCHANT V2 — ORDER SHARE (WhatsApp)');
console.log('='.repeat(72));

/* ── extract the real functions ───────────────────────────────────────────── */
function grab (name) {
  const re = new RegExp('function ' + name + ' \\([^)]*\\) \\{');
  const at = SRC.search(re);
  if (at < 0) return null;
  let depth = 0;
  for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (!depth) return SRC.slice(at, i + 1); }
  }
  return null;
}

const srcWaPhone = grab('waPhone');
const srcDest = grab('orderDestination');
const srcWaMsg = grab('waMessage');
const srcWaBtn = grab('waButton');
ck('waPhone() extracted from the shell', !!srcWaPhone);
ck('orderDestination() extracted', !!srcDest);
ck('waMessage() extracted', !!srcWaMsg);
ck('waButton() extracted', !!srcWaBtn);
if (!srcWaPhone || !srcDest || !srcWaMsg || !srcWaBtn) {
  console.error('\n  Shell shape changed — refusing to assert against a guess.\n'); process.exit(2);
}

/* Minimal shims for what the extracted code touches. */
const sandbox = { esc: (s) => String(s), money: (n, c) => (c || 'KES') + ' ' + Number(n || 0).toLocaleString('en-KE'),
                  merchantDisplayName: () => "Alex's Store" };
const F = new Function('esc', 'money', 'merchantDisplayName',
  srcWaPhone + '\n' + srcDest + '\n' + srcWaMsg + '\n' + srcWaBtn +
  '\nreturn { waPhone: waPhone, orderDestination: orderDestination, waMessage: waMessage, waButton: waButton };'
)(sandbox.esc, sandbox.money, sandbox.merchantDisplayName);

/* ── 1. Kenyan normalisation ──────────────────────────────────────────────── */
console.log('\n1. Kenyan number normalisation');
[['0712 345 678', '254712345678'], ['0712345678', '254712345678'],
 ['+254712345678', '254712345678'], ['254712345678', '254712345678'],
 ['712345678', '254712345678'], ['+254 712 345 678', '254712345678'],
 ['0110123456', '254110123456'], ['(0712) 345-678', '254712345678'],
].forEach(([i, want]) => ck('"' + i + '" -> ' + want, F.waPhone(i) === want, String(F.waPhone(i))));

console.log('\n2. Refusals — never manufacture a recipient');
[['', 'empty'], [null, 'null'], [undefined, 'undefined'], ['abc', 'letters'],
 ['0712345', 'too short'], ['07123456789', 'too long'], ['+1 415 555 0123', 'non-KE'],
 ['0812345678', 'invalid KE prefix 8'], ['0', 'single zero'],
].forEach(([i, label]) => ck('rejects ' + label, F.waPhone(i) === null, String(F.waPhone(i))));

/* ── 3. Destination — read, never authored ────────────────────────────────── */
console.log('\n3. Delivery destination');
ck('pickup order gets NO address, even when one is present',
   F.orderDestination({ fulfilment: 'pickup', deliveryAddress: 'Langata, Nairobi' }) === null);
ck('delivery order with an address returns it',
   F.orderDestination({ fulfilment: 'delivery', deliveryAddress: 'Langata, Nairobi' }) === 'Langata, Nairobi');
ck('delivery order with NO address returns null (nothing invented)',
   F.orderDestination({ fulfilment: 'delivery' }) === null);
ck('blank address is not treated as an address',
   F.orderDestination({ fulfilment: 'delivery', deliveryAddress: '   ' }) === null);

/* ── 4. Message ───────────────────────────────────────────────────────────── */
console.log('\n4. Message content');
const del = { ref: 'SO-1048', customer: 'Alex O.', total: 1850, currency: 'KES', fulfilment: 'delivery', deliveryAddress: 'Langata, Nairobi' };
const pick = { ref: 'SO-1049', customer: 'Alex O.', total: 1850, currency: 'KES', fulfilment: 'pickup', deliveryAddress: 'Langata, Nairobi' };
const mDel = F.waMessage(del, "Alex's Store");
const mPick = F.waMessage(pick, "Alex's Store");
ck('names the customer', mDel.indexOf('Alex O.') > -1);
ck('names the shop', mDel.indexOf("Alex's Store") > -1);
ck('names the order', mDel.indexOf('#SO-1048') > -1);
ck('states the total', mDel.indexOf('1,850') > -1, mDel.split('\n').filter((l) => /total/i.test(l))[0]);
ck('delivery order includes the location', mDel.indexOf('Langata, Nairobi') > -1);
ck('PICKUP order does NOT include a location', mPick.indexOf('Langata') === -1);
ck('walk-in customer is not greeted by the placeholder name',
   F.waMessage({ ref: 'X', customer: 'Walk-in', total: 1, currency: 'KES' }, 'S').indexOf('Walk-in') === -1);

/* ── 5. The button ────────────────────────────────────────────────────────── */
console.log('\n5. The rendered control');
const btnOk = F.waButton(Object.assign({ phone: '0712345678' }, del));
const btnNo = F.waButton(Object.assign({ phone: '' }, del));
ck('with a number -> a real wa.me anchor', /href="https:\/\/wa\.me\/254712345678\?text=/.test(btnOk), btnOk.slice(0, 60));
ck('...message is URL-encoded', /text=[^"]*%20|text=[^"]*%0A/.test(btnOk));
ck('...and carries rel="noopener"', /rel="noopener"/.test(btnOk));
ck('without a number -> NOT a link', btnNo.indexOf('href') === -1, btnNo);
ck('...and it explains itself', /data-wa-none/.test(btnNo) && /No buyer phone/i.test(btnNo));
ck('...and no number appears anywhere in it', !/\d{9,}/.test(btnNo), btnNo);

/* ── 6. Containment still holds ───────────────────────────────────────────── */
console.log('\n6. The shell containment rule is not evaded');
const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
ck('Share does not use window.open', !/window\.open\s*\(/.test(stripped));
ck('Share does not use target="_blank"', !/target\s*=\s*["']_blank/.test(stripped));
ck('Print and Share are adjacent in the action bar, not under More',
   /data-print-order[\s\S]{0,80}waButton\(o\)/.test(SRC));
ck('Print routes through the shell device layer (no second printer authority)',
   /data-print-order[\s\S]{0,400}printerEngine\(\)/.test(SRC));

/* ── 7. Negative controls ─────────────────────────────────────────────────── */
console.log('\n7. Negative controls');
ck('NC a bad number would be caught', F.waPhone('0812345678') !== '254812345678');
ck('NC the encoder is real (a space does not survive raw)', btnOk.indexOf('text=Hello ') === -1);
ck('NC pickup suppression is not vacuous — delivery DOES include it',
   F.orderDestination({ fulfilment: 'delivery', deliveryAddress: 'X' }) === 'X');
ck('NC waPhone actually returns something for a valid number', F.waPhone('0712345678') === '254712345678');

console.log('\n' + '='.repeat(72));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(72) + '\n');
process.exit(fail ? 1 : 0);
