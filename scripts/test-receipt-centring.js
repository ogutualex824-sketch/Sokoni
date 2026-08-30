#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST-RECEIPT CENTRING

   Reported: the Test Print header and footer leaned RIGHT instead of centring.

   Cause: the template turns on ESC/POS centre alignment with .ac() AND ALSO
   prepended spaces via center(). The printer centred an already-padded string, so
   the visible text sat right of centre by half the pad.

   The fix removes the manual padding. That is only correct while every center()
   call sits inside a hardware-centred region — so THAT invariant, not the absence
   of padding, is what this suite mainly guards. If someone later uses center() in
   a left-aligned block, the padding removal becomes a defect and section 2 fails.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-universal-printer.js'), 'utf8');
let pass = 0, fail = 0, invalid = 0;
const ok = (l, d) => { pass++; console.log('  PASS       ' + l + (d ? '   [' + d + ']' : '')); };
const no = (l, d) => { fail++; console.log('  FAIL       ' + l + (d ? '   [' + d + ']' : '')); };
const ck = (l, c, d) => (c ? ok(l, d) : no(l, d));
const iv = (l, d) => { invalid++; console.log('  HARNESS-INVALID  ' + l + (d ? '   [' + d + ']' : '')); };
const head = (t) => console.log('\n-- ' + t + ' --');

head('0 - harness integrity');
const m = SRC.match(/const center = \(s\) => ([^\n\r;]+);/);
if (!m) { iv('center() implementation located', 'cannot evaluate it'); }
else ok('center() implementation located', m[1].trim());

head('1 - center() must NOT pad (the printer does the centring)');
if (m) {
  let center;
  try { center = new Function('W', 'return (s) => ' + m[1] + ';')(32); }
  catch (e) { iv('center() is evaluable', e.message); }
  if (center) {
    ck('a short line comes back UNPADDED', center('SOKONI POS') === 'SOKONI POS',
       JSON.stringify(center('SOKONI POS')));
    ck('...no leading space at all', center('X').charAt(0) !== ' ');
    ck('TRUNCATION is retained', center('B'.repeat(40)).length === 32,
       'a 34-char legal name must not overrun a 32-char line');
    ck('an exactly-full line is unchanged', center('Y'.repeat(32)).length === 32);
    /* CONTROL: prove the OLD behaviour would fail this suite. */
    const old = (s) => { const t = String(s).slice(0, 32);
                         return ' '.repeat(Math.max(0, Math.floor((32 - t.length) / 2))) + t; };
    ck('CONTROL the old padding implementation WOULD fail', old('SOKONI POS') !== 'SOKONI POS',
       JSON.stringify(old('SOKONI POS')) + ' - this is what printed right of centre');
  }
}

head('2 - THE INVARIANT: every center() call sits in a hardware-centred region');
/* Walk the fallback template, tracking the last alignment command seen. A center()
   under .al() would be a real defect once padding is gone. */
const startIdx = SRC.indexOf('Fallback for printers reached without the P58E profile');
if (startIdx === -1) { iv('fallback template located', 'anchor text changed'); }
else {
  const region = SRC.slice(startIdx, startIdx + 4000);
  const tokens = region.match(/\.ac\(\)|\.al\(\)|\.ar\(\)|center\(|\.map\(center\)/g) || [];
  let align = 'left', centred = 0, misaligned = 0, seen = 0;
  tokens.forEach(function (t) {
    if (t === '.ac()') { align = 'centre'; return; }
    if (t === '.al()') { align = 'left';   return; }
    if (t === '.ar()') { align = 'right';  return; }
    seen++;
    if (align === 'centre') centred++; else misaligned++;
  });
  ck('the template was found and walked', seen > 0, seen + ' center() uses');
  ck('EVERY center() use is inside .ac()', misaligned === 0,
     centred + ' centred, ' + misaligned + ' NOT centred');
  ck('...and there are several of them', centred >= 10,
     'header and footer both rely on this');
}

head('2b - THE SAME DEFECT IN THE SALE RECEIPT (second template)');
/* RawReceiptBuilder pushes CMD.ALIGN_CENTER and _center() also padded, so order and
   sale receipts were double-centred exactly like the test receipt. Different file,
   different builder, same mistake — which is why this is asserted per template. */
const PPS = fs.readFileSync(path.join(ROOT, 'sokoni-pos-print-service.js'), 'utf8');
ck('sale builder _center does NOT pad',
   PPS.indexOf('const pad = Math.max(0, Math.floor((w - s.length) / 2));') === -1);
ck('...and still truncates', PPS.indexOf('return this._ln(String(txt).slice(0, w));') > -1);
ck('CONTROL it really does use hardware centring', PPS.indexOf('CMD.ALIGN_CENTER') > -1,
   'if it did not, removing the padding would be the defect');
ck('CONTROL _col2 still pads (left-aligned columns need it)',
   PPS.indexOf("return this._ln(gap > 0 ? l + ' '.repeat(gap) + r") > -1);
/* Walk the builder: every _center must sit inside an ALIGN_CENTER region. */
(function () {
  const src = PPS.split('\n');
  const start = src.findIndex((l) => l.indexOf('class RawReceiptBuilder') > -1);
  let end = src.findIndex((l, i) => i > start && /^class /.test(l));
  if (end < 0) end = start + 400;
  let align = 'left', centred = 0, mis = 0;
  for (let i = start; i < end; i++) {
    const l = src[i];
    if (l.indexOf('CMD.ALIGN_CENTER') > -1) align = 'centre';
    else if (l.indexOf('CMD.ALIGN_LEFT') > -1) align = 'left';
    if (/this\._center\(/.test(l)) { if (align === 'centre') centred++; else mis++; }
  }
  ck('every _center call is inside ALIGN_CENTER', mis === 0, centred + ' centred, ' + mis + ' not');
  ck('...and there are several', centred >= 5);
})();

head('2c - every receipt carries its ORDER NUMBER');
ck('Order No row exists', PPS.indexOf("this._col2('Order No:', String(_orderNo));") > -1);
ck('accepts ref, which is what the Orders list sends',
   PPS.indexOf('r.orderNo || r.orderNumber || r.orderId || r.ref') > -1);
ck('the sale builder forwards it',
   PPS.indexOf('orderNo:      receipt.orderNo || receipt.orderNumber') > -1,
   'receiptMeta is called with a CONSTRUCTED object, so an unlisted field is invisible');
ck('CONTROL nothing is printed when there is no order',
   PPS.indexOf('if (_orderNo) this._col2') > -1,
   'an absent order must not render an empty or invented row');

head('3 - CONTROL: the manual-padding expression is gone from the file');
ck('no residual pad arithmetic in center()',
   SRC.indexOf("' '.repeat(Math.max(0, Math.floor((W - t.length) / 2))) + t") === -1);
ck('exactly one center() definition', (SRC.split('const center = (s)').length - 1) === 1,
   'a second one could reintroduce padding unnoticed');

head('what this suite does NOT prove');
console.log('  UNPROVEN   that the physical paper is visually centred   [needs the P58E]');

console.log('\n' + '-'.repeat(62));
console.log('  PASS ' + pass + '   FAIL ' + fail + '   HARNESS-INVALID ' + invalid);
process.exit((fail || invalid) ? 1 : 0);
