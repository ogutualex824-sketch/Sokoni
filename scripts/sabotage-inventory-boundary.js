/* Sabotage runner for the inventory boundary.
   The headline requirement: RESTORING DIRECT STOCK MUTATION MUST FAIL THE SUITE.
   Every edit asserts it matched exactly once; every verdict is the EXIT CODE. */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SUITE = 'scripts/test-inventory-authority-boundary.js';

const CASES = [
  /* ── THE ONE THAT MATTERS: put stock back into product metadata ─────────── */
  ['RESTORE direct stock mutation (metadata allowlist)', 'sokoni-merchant-data.js',
   "    var errs = _validate(fields, { creating: true });",
   "    if (o.product && o.product.stock !== undefined) fields.stock = Number(o.product.stock);\n    var errs = _validate(fields, { creating: true });"],

  ['RESTORE stock on the EDIT path', 'sokoni-merchant-data.js',
   "    if (o.patch && (o.patch.stock !== undefined ||",
   "    if (false && (o.patch.stock !== undefined ||"],

  ['RESTORE the variant->metadata stock leak', 'sokoni-merchant-data.js',
   "      Object.keys(built.patch).forEach(function (k) { if (k !== 'stock') out[k] = built.patch[k]; });",
   "      Object.keys(built.patch).forEach(function (k) { out[k] = built.patch[k]; });"],

  /* ── the authority route ────────────────────────────────────────────────── */
  ['opening stock stops reaching the authority', 'sokoni-merchant-data.js',
   "    if (opening !== null && opening > 0) {", "    if (false) {"],

  ['the adjustment id becomes random', 'sokoni-merchant-data.js',
   "            adjustmentId: 'open_' + id,",
   "            adjustmentId: 'open_' + id + '_' + String(opening),"],

  ['a failed adjustment is swallowed', 'sokoni-merchant-data.js',
   "          stockResult = { ok: false, opening: opening,\n                          reason: (err && (err.message || err.code)) || 'adjust-failed' };",
   "          stockResult = { ok: true, opening: opening };"],

  /* ── validation ─────────────────────────────────────────────────────────── */
  ['negative opening stock is accepted', 'sokoni-merchant-data.js',
   "    if (n < 0) throw new Error('Opening stock cannot be negative.');", "    if (false) {}"],

  ['fractional opening stock is accepted', 'sokoni-merchant-data.js',
   "    if (!Number.isInteger(n)) throw new Error('Opening stock must be a whole number.');", "    if (false) {}"],

  ['validation moves AFTER the write', 'sokoni-merchant-data.js',
   "    var opening = openingStockOf(o.product);\n\n    var fields = _productFields(o.product);",
   "    var fields = _productFields(o.product);"],

  /* ── the editor must not offer a control the writer refuses ─────────────── */
  ['the editor renders a stock input on EDIT too', 'sokoni-merchant-products.js',
   "          (creating\n            ? fld('stock', 'Opening stock', 'type=\"number\" inputmode=\"numeric\" min=\"0\" step=\"1\"', p.stock)\n            : stockReadHTML(p)) +",
   "          fld('stock', 'Stock', 'type=\"number\" inputmode=\"numeric\" min=\"0\" step=\"1\"', p.stock) +"],

  ['the read-only block gains a data-pf (so it can patch)', 'sokoni-merchant-products.js',
   "        '<div class=\"pr-i pr-ro\" aria-readonly=\"true\">' +",
   "        '<div class=\"pr-i pr-ro\" data-pf=\"stock\" aria-readonly=\"true\">' +"],

  ['unknown stock renders as 0', 'sokoni-merchant-products.js',
   "          (known ? esc(String(Number(raw))) : '—') +",
   "          (known ? esc(String(Number(raw))) : '0') +"],

  /* ── the guard the register entry rests on ─────────────────────────────── */
  ['REMOVE the write-site authority guard', 'merchant-v2.html',
   "        self._refuseAuthorityFields(o && o.data, 'writeProduct');", "        void 0;"],

  ['the guard strips instead of throwing', 'merchant-v2.html',
   "        throw new Error('Stock is changed in Inventory, not here (' + where + ' tried to write ' +\n                        bad.join(', ') + ').');",
   "        bad.forEach(function (k) { delete data[k]; });"],

  ['the detector is blinded instead', 'scripts/gate-inventory-writers.js',
   "const AUTHORITY_FIELDS = ['stock', 'sold', 'inventoryVersion', 'stockQty'];",
   "const AUTHORITY_FIELDS = ['sold'];"],
];

let caught = 0, missed = 0;
for (const [label, file, find, repl] of CASES) {
  const p = path.join(ROOT, file);
  const orig = fs.readFileSync(p, 'utf8');
  const n = orig.split(find).length - 1;
  if (n !== 1) {
    console.log('  BROKEN PROBE  ' + label + '  (matched ' + n + 'x in ' + file + ')');
    missed++; continue;
  }
  fs.writeFileSync(p, orig.replace(find, repl));
  let code = 0, out = '';
  try { out = execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status === undefined ? 1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }
  fs.writeFileSync(p, orig);

  const fails = (out.match(/^ {2}FAIL/gm) || []).length;
  console.log('  ' + (code ? 'CAUGHT ' : 'MISSED ') + label.padEnd(52)
    + 'exit=' + code + ' fails=' + fails + (/^ {2}aborted/m.test(out) ? ' (aborted)' : ''));
  if (code) caught++; else missed++;
}

console.log('\n  ' + caught + ' caught, ' + missed + ' missed / not proven');
process.exit(missed ? 1 : 0);
