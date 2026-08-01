#!/usr/bin/env node
/* ============================================================================
   Receipt identifier naming — one canonical field, ratcheted
   ============================================================================
   ADR-009 decision:

     receiptNumber   canonical receipt identifier
     invoiceNumber   canonical invoice identifier   (a different document)
     receiptNo       DEPRECATED alias
     invoiceNo       DEPRECATED alias

   Measured 2026-08-02: **zero production documents carry any of these fields**
   (`receipts` 1 doc, `payments` 8 docs, `orders`/`posSales`/`invoices` empty).
   So there is nothing to migrate and no compatibility layer is needed — the
   deprecated names exist only in code.

   A correction worth keeping: the split was first reported as "63 vs 45 uses".
   That conflated LOCAL VARIABLE names with FIELD names — finos-router.js declares
   `const receiptNo` and writes the field as `receiptNumber`. Measured as fields,
   it is 20 vs 19 writes. The smaller number is the real one, and the difference
   mattered: it is the gap between "a sprawling inconsistency" and "a contained
   rename".

   This is a RATCHET. The deprecated names may not spread while the rename is
   scheduled. When the count reaches zero, switch to --strict and the alias is
   gone for good.

   Usage:
     node scripts/verify-receipt-naming.js                  ratchet
     node scripts/verify-receipt-naming.js --strict         fail on any use
     node scripts/verify-receipt-naming.js --update-baseline
   ========================================================================= */

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');

const SKIP_DIR = new Set(['node_modules', '.git', 'docs', 'scripts', 'coverage', 'dist']);
const DEPRECATED = [
  { field: 'receiptNo',  canonical: 'receiptNumber' },
  { field: 'invoiceNo',  canonical: 'invoiceNumber' },
];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { walk(fp, out); continue; }
    if (/\.(js|html)$/.test(e.name)) out.push(fp);
  }
  return out;
}

const hits = [];
for (const fp of walk(ROOT, [])) {
  const rel = path.relative(ROOT, fp).replace(/\\/g, '/');
  const lines = fs.readFileSync(fp, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const d of DEPRECATED) {
      /* Field usage only: an object key `receiptNo:` or a property read
         `.receiptNo`. A local variable of the same name is not a schema
         problem and is deliberately not counted — counting it is what produced
         the wrong number the first time. */
      const asKey  = new RegExp('(^|[{,\\s])' + d.field + '\\s*:');
      const asRead = new RegExp('\\.' + d.field + '\\b');
      if (asKey.test(line) || asRead.test(line)) {
        hits.push({ file: rel, line: i + 1, field: d.field, canonical: d.canonical });
      }
    }
  });
}

const byField = {};
hits.forEach(h => { (byField[h.field] = byField[h.field] || []).push(h); });

console.log('\nReceipt identifier naming');
console.log('─────────────────────────');
for (const d of DEPRECATED) {
  const n = (byField[d.field] || []).length;
  const files = new Set((byField[d.field] || []).map(h => h.file)).size;
  console.log(`  ${d.field.padEnd(14)} ${String(n).padStart(3)} field use(s) in ${files} file(s)  →  ${d.canonical}`);
}

const total = hits.length;
console.log(`\n  ${total} deprecated field use(s) total.`);

const BASELINE = path.join(__dirname, 'receipt-naming-baseline.json');
if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(BASELINE, JSON.stringify({ total }, null, 2) + '\n');
  console.log('  baseline written: ' + total + '\n');
  process.exit(0);
}

if (STRICT) {
  if (total) {
    console.log('\nFAIL (--strict): the deprecated aliases must be gone.\n');
    process.exit(1);
  }
  console.log('  Only canonical identifiers remain.\n');
  process.exit(0);
}

let base = null;
try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) {}
if (base && total > base.total) {
  console.log(`\nREGRESSION: ${base.total} -> ${total}. The deprecated alias is spreading.`);
  console.log('New code writes receiptNumber / invoiceNumber. See ADR-009.\n');
  process.exit(1);
}
if (base && total < base.total) {
  console.log(`  improved: ${base.total} -> ${total}; run --update-baseline to lock it in\n`);
} else {
  console.log('  no regression.\n');
}
process.exit(0);
