/* ══════════════════════════════════════════════════════════════════════════════
   CF SLICE SELECTOR — which module is SAFE to consolidate next
   ══════════════════════════════════════════════════════════════════════════════
   Ranking by "yield per client file touched" picked `impact` as slice 1. Reading
   the module before writing any code showed why that ranking was insufficient:

     * impactAuthorizeDisbursement executes a real IntaSend M-PESA B2C payout
     * it declares secrets: [INTASEND_PRIVATE_KEY]
     * it implements a four-eyes control — the approver must differ from the
       initiator, and the final authorizer from the approver

   A dispatcher must declare the UNION of its operations' secrets. Consolidating
   impact would therefore make the live payout key available to the code path
   that also serves the public dashboard read. That is a security regression
   PRODUCED BY consolidation, and no amount of behavioural test coverage makes it
   acceptable.

   A module is DISQUALIFIED if it:
     - contains a protected payment/subscription authority
     - declares any secret            (dispatcher would widen secret exposure)
     - moves money                    (payout / B2C / provider APIs)
     - implements segregation of duties (collapsing entry points weakens it)
     - is named for money or subscriptions

   Remaining modules are ranked by yield per client file touched.

   READ ONLY.
     node scripts/cf-slice-selector.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

const CLASS = path.join(ROOT, 'docs/cf-removal-classification.json');
if (!fs.existsSync(CLASS)) {
  console.error('\n  Run scripts/cf-removal-classify.js first.\n');
  process.exit(2);
}
const cls = JSON.parse(fs.readFileSync(CLASS, 'utf8'));
const PROTECTED = new Set(cls.protectedAuthorities);

const DISQUALIFY = [
  { key: 'secrets',   re: /secrets:\s*\[/,
    why: 'declares a secret — a dispatcher must declare the UNION, widening exposure' },
  { key: 'payout',    re: /payment\.intasend\.com|sandbox\.intasend\.com|\/payouts\/|B2C|stkpush|daraja|mpesa/i,
    why: 'moves money or calls a payment provider' },
  { key: 'four-eyes', re: /must (?:be )?differ(?:ent)? from|must be different from|approvedBy === uid|initiatedBy === uid/i,
    why: 'implements segregation of duties — separate entry points are part of the control' },
  { key: 'name',      re: null, nameRe: /wallet|sfos|finos|commission|payment|payout|settle|subscri|sub-|billing|escrow|ledger|procurement|loyalty|entitle|product-limit|merchant-identity|impact|donat/i,
    why: 'named for money, subscriptions or an authority boundary' },
];

const byMod = {};
cls.records.forEach((r) => { (byMod[r.module] = byMod[r.module] || []).push(r); });

const rows = [];
for (const [mod, list] of Object.entries(byMod)) {
  if (list.length < 2) continue;                     /* nothing to consolidate */
  let src = '';
  try { src = fs.readFileSync(path.join(FN, mod + '.js'), 'utf8'); } catch (_) { continue; }

  const reasons = [];
  if (list.some((r) => PROTECTED.has(r.name))) reasons.push('contains a protected authority');
  for (const d of DISQUALIFY) {
    if (d.nameRe) { if (d.nameRe.test(mod)) reasons.push(d.why); }
    else if (d.re.test(src)) reasons.push(d.why);
  }

  rows.push({
    mod,
    n: list.length,
    save: list.length - 1,
    clients: list.filter((r) => r.referencedByClient).length,
    invoked: list.filter((r) => r.invocationsInWindow > 0).length,
    disqualified: reasons.length > 0,
    reasons,
  });
}

const ok = rows.filter((r) => !r.disqualified)
  .sort((a, b) => (b.save / (b.clients + 1)) - (a.save / (a.clients + 1)));
const no = rows.filter((r) => r.disqualified).sort((a, b) => b.save - a.save);

console.log('\nCF SLICE SELECTOR');
console.log('='.repeat(80));
console.log('  window: ' + cls.coverage.startTime + ' -> ' + cls.coverage.endTime +
            ' (' + cls.coverage.requestedDays + 'd)\n');

console.log('  ELIGIBLE — ranked by yield per client file touched');
console.log('  ' + 'MODULE'.padEnd(30) + 'onCall  saves  clientFiles  invoked  CUM');
console.log('  ' + '-'.repeat(74));
let cum = 0;
ok.slice(0, 16).forEach((r) => {
  cum += r.save;
  console.log('  ' + r.mod.padEnd(30) + String(r.n).padStart(5) + String(r.save).padStart(7) +
    String(r.clients).padStart(12) + String(r.invoked).padStart(9) + String(cum).padStart(6));
});
const total = ok.reduce((a, r) => a + r.save, 0);
console.log('\n  eligible modules: ' + ok.length + '   total achievable saving: ' + total +
            '   (target 212)');
if (total < 212) {
  console.log('  SHORT BY ' + (212 - total) + ' — the target cannot be met from eligible modules alone.');
}

console.log('\n  DISQUALIFIED (largest first)');
console.log('  ' + '-'.repeat(74));
no.slice(0, 12).forEach((r) =>
  console.log('  ' + r.mod.padEnd(30) + String(r.save).padStart(4) + '  ' + r.reasons[0]));
console.log('='.repeat(80) + '\n');
