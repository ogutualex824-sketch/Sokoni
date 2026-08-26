/* Receipts is a NATIVE merchant-v2 module.
 *
 *   node scripts/test-merchant-receipts-native.js
 *
 * The rule that matters here: a receipt shown in the workspace must be the SAME document the
 * till prints. Two receipt layouts is two answers to "what did the customer buy", and the
 * divergence would only surface on a printed slip a customer is holding.
 *
 * So this module renders through SokoniReceiptDoc — the locked contract — over the shell's one
 * canonical order reader, and writes nothing at all. It is handed neither a db adapter nor a
 * callable, by design.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. ROUTE ─────────────────────────────────────────────────────────────── */
console.log('\n1. The route is native, and the legacy address still resolves');
const API = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const r = API.get('receipts');
ok(!!r, 'CONTROL: the receipts route exists');
ok(r.kind === 'native', 'receipts is kind:native (was kind:seller -> seller.html in a frame)',
   'kind is "' + r.kind + '"');
ok(r.sec === 'receipts', 'sec:"receipts" is RETAINED as the legacy inbound key');
ok(API.resolve('receipts') === 'receipts', 'the legacy section key still resolves');

/* ── 2. THE SHELL MOUNTS IT ───────────────────────────────────────────────── */
console.log('\n2. merchant-v2 can mount it');
const v2 = R('merchant-v2.html');
ok(/<script src="sokoni-merchant-receipts\.js"><\/script>/.test(v2), 'the module script is loaded');
/* It renders through the locked contract, so that must load FIRST. */
ok(v2.indexOf('sokoni-receipt.js') < v2.indexOf('sokoni-merchant-receipts.js'),
   'the receipt contract loads BEFORE the surface that renders through it');

/* Bounded to THIS entry, not a fixed character window. A 600-char slice ran past the end of
   the receipts entry into the next one, which legitimately holds callables — and the
   "handed no callable" assertion failed against a neighbour's ctx. Same mistake shape as an
   over-wide function slice: a window that is too generous tests the wrong code. */
const entry = (function () {
  const i = v2.indexOf("receipts:   { global:");
  if (i < 0) return '';
  const end = v2.indexOf('}; } },', i);
  return end < 0 ? '' : v2.slice(i, end);
})();
ok(entry.length > 150, 'CONTROL: the MODULES entry was located (' + entry.length + ' chars)');
ok(/global:\s*'SokoniMerchantReceipts'/.test(entry), 'MODULES.receipts names the module global');
ok(/orders: function \(\) \{ return loadOrders\(false\); \}/.test(entry),
   'it reads the shell\'s ONE canonical order reader');

/* ── 3. IT WRITES NOTHING ─────────────────────────────────────────────────── */
console.log('\n3. It is a read surface, and is not even given the means to write');
/* No db adapter and no callable in its ctx — the absence IS the design. */
ok(!/db:\s*_mdb/.test(entry), 'it is handed NO db adapter');
ok(!/_callable\(/.test(entry), 'it is handed NO server callable');
const mod = R('sokoni-merchant-receipts.js');
const CODE = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/setDoc|addDoc|updateDoc|deleteDoc|writeProduct/.test(CODE),
   'the module performs no Firestore write of its own');
/* posReceipts is Cloud-Function-only by rule: a client read would be denied and swallowed,
   which is the silent-empty-surface failure this codebase keeps hitting. */
ok(!/collection\([^)]*posReceipts/.test(CODE),
   'it does not read posReceipts — CF-only by the served rule');

/* ── 4. ONE RECEIPT DOCUMENT ──────────────────────────────────────────────── */
console.log('\n4. The same document the till prints');
ok(/SokoniReceiptDoc/.test(CODE), 'it renders through SokoniReceiptDoc');
/* NOT SokoniReceipt: that global belongs to the POS print path, and claiming it would break
   printing on any page loading both — invisibly, until someone pressed Print. */
ok(!/window\.SokoniReceipt\b(?!Doc)/.test(CODE),
   'it does NOT claim the SokoniReceipt global that the POS print path owns');
const contract = R('sokoni-receipt.js');
ok(/global\.SokoniReceiptDoc = \{/.test(contract), 'CONTROL: the contract defines that global');
['render', 'toText'].forEach((fn) => {
  ok(new RegExp('\\b' + fn + ':').test(contract.slice(contract.indexOf('global.SokoniReceiptDoc'))),
     'the contract exposes ' + fn + '(), which the module calls');
});

/* ── 5. NO ESCAPE FROM THE SHELL ──────────────────────────────────────────── */
console.log('\n5. Navigation stays in merchant-v2');
ok(!/seller\.html/.test(CODE), 'the module never references seller.html');
ok(!/location\s*\.\s*(href|assign|replace)/.test(CODE), 'it never sets location');
const stillLegacy = API.SELLER_SECTIONS
  .map((s) => API.get(API.resolve(s)))
  .filter((x) => x && x.kind === 'seller')
  .map((x) => x.id);
ok(stillLegacy.indexOf('receipts') === -1, 'receipts is NOT among the routes seller.html still renders');
ok(stillLegacy.length > 0,
   'CONTROL: other routes ARE still legacy (' + stillLegacy.join(', ') + ') — the check discriminates');

/* ── 6. v1 KEEPS THE ROUTE ────────────────────────────────────────────────── */
console.log('\n6. Making it native must not delete it from the v1 shell');
const CAP = require(path.join(ROOT, 'sokoni-merchant-capability.js'));
const legacyMap = R('sokoni-merchant-capability.js');
ok(/receipts:\s*'receipts'/.test(legacyMap),
   'the capability layer can DOWNGRADE receipts to the seller.js section');
/* Without that entry the route withholds, and withholding strips it from every nav
   projection — a v1 merchant would open their shell and find Receipts simply gone. */
const v1 = CAP.negotiate(r, { native: { dashboard: true } });
ok(v1.outcome === 'downgrade', 'a shell without a native renderer DOWNGRADES rather than withholds',
   'outcome was ' + v1.outcome);
ok(v1.sec === 'receipts', '...to a section seller.js actually has');

/* ── 7. THE FINANCIAL GUARD IS UNDISTURBED ────────────────────────────────── */
console.log('\n7. Receipts did not wake the Dashboard financial KPIs');
ok(/var\s+POS_SALES_READABLE\s*=\s*false/.test(v2), 'POS_SALES_READABLE is still false');
ok(!/SokoniOrderService/.test(v2), 'the PENDING-SLICE MARKER still holds');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
