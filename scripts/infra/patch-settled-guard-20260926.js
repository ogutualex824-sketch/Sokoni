'use strict';
/* Applies the case-insensitive "already settled" guard to ONE order-settlement.js.
   Identical edits for the branch source and the deployed-lineage tree. Refuses unless every
   anchor matches EXACTLY once, so a drifted file is a STOP rather than a partial patch. */
const fs = require('fs');
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');

const HELPER = `
/* ── ONE ANSWER TO "IS THIS ORDER ALREADY SETTLED?" ─────────────────────────────────────
   The IntaSend webhook credits the seller at payment time and marks the order
   \`settlementStatus: "settled"\` — LOWERCASE — so that this module does not credit again.
   Comparing against 'SETTLED' with === never saw that marker: completing a webhook-paid order
   credited the seller a SECOND time (docs/MARKETPLACE_DOUBLE_CREDIT_MEASUREMENT.md).

   Both "already settled" decisions that gate a credit — settleOrder and the auto-confirm
   sweep — go through this one predicate, case- and whitespace-insensitive, so they cannot
   disagree about the same order. Only a STRING can be a status: a non-string value is not
   a known state and is not read as one.

   Deliberately NOT applied to the refund routing: a webhook-credited order has no
   settlements/{orderId} record for reverseSettledOrder to reverse, so widening that path is
   a separate decision. */
function isAlreadySettled(status) {
  return typeof status === 'string' && status.trim().toUpperCase() === STATES.SETTLED;
}
`;

const edits = [
  { name: 'helper after STATES',
    find: /^const STATES = \{[^\n]*\};\n/m,
    replace: (m) => m + HELPER },
  { name: 'settleOrder guard',
    find: /^    if \(st === STATES\.SETTLED\)  return \{ outcome: 'already-settled' \};   \/\* replay no-op \*\/$/m,
    replace: () => "    if (isAlreadySettled(st))   return { outcome: 'already-settled' };   /* replay no-op — any case, see isAlreadySettled */" },
  { name: 'auto-confirm guard',
    find: /^    if \(o\.settlementStatus === STATES\.SETTLED \|\| o\.settlementStatus === STATES\.REFUNDED\) continue;$/m,
    replace: () => '    if (isAlreadySettled(o.settlementStatus) || o.settlementStatus === STATES.REFUNDED) continue;' },
  { name: 'export',
    find: /^module\.exports = \{ STATES, /m,
    replace: () => 'module.exports = { STATES, isAlreadySettled, ' },
];

for (const e of edits) {
  const g = new RegExp(e.find.source, 'gm');
  const n = (src.match(g) || []).length;
  if (n !== 1) { console.error(`STOP: anchor "${e.name}" matched ${n} times in ${file}`); process.exit(3); }
  src = src.replace(e.find, e.replace);
}
if (/isAlreadySettled/.test(fs.readFileSync(file, 'utf8'))) { console.error('STOP: already patched'); process.exit(3); }
fs.writeFileSync(file, src);
console.log('patched', file);
