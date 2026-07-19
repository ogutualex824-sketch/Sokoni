/* ═══════════════════════════════════════════════════════════════════════════
   ENTITLEMENT VERIFIER — Gate 1, Financial Entitlement Boundary
   ═══════════════════════════════════════════════════════════════════════════

   Makes the Financial Trust Matrix classification MECHANICAL rather than judged.

   THE RULE
   ────────
   A money-writing operation is SERVER AUTHORITATIVE if and only if no monetary
   field enters it from the request payload.

   Rationale (Constitution, Identity != Authority != Entitlement): if the caller
   supplies the amount, then no control at any layer proves the amount is correct
   for this operation. Identity controls (Firebase Auth, _assertAuth) prove WHO.
   Authority controls (roles, claims) prove PERMISSION. Neither proves CORRECTNESS.
   A function that reads its amount from request.data has no entitlement control
   by construction, regardless of how strong its identity and authority controls are.

   The reference implementation is provider-ops.js:138-149 — it derives gross,
   commission and net from server state via the canonical commission engine and
   writes with a deterministic doc id. It reads NO monetary field from the request.

   WHAT THIS DOES NOT PROVE
   ────────────────────────
   A PASS here means no client-supplied amount reaches the function. It does NOT
   prove the server derivation is correct, nor that the write is atomic or
   idempotent — those are Gates 4A/5. This verifier answers exactly one question,
   mechanically, and nothing more. Do not read it as a financial-correctness proof.

   Run: node scripts/verify-entitlement.js            (exit 1 if regressions)
        node scripts/verify-entitlement.js --list     (full classification)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';
const fs   = require('fs');
const path = require('path');
const FN   = path.join(__dirname, '..', 'functions');

/* Monetary field names. A value that determines money, not an identifier. */
const MONEY = [
  'amount', 'amountCents', 'amountKES', 'total', 'totalAmount', 'subtotal',
  'fare', 'earnings', 'commission', 'commissionCents', 'commissionPct',
  'commissionRate', 'price', 'unitPrice', 'fee', 'deliveryFee', 'deliveryFeeCents',
  'tip', 'tipCents', 'discount', 'discountAmount', 'net', 'netAmount',
  'sellerNetCents', 'orderAmountCents', 'grossRevenue', 'payout', 'payoutAmount',
  'balance', 'credit', 'debit', 'refundAmount', 'value', 'vatAmount', 'vatRate',
  'taxAmount', 'driverNet', 'platformCut', 'subsidyKES', 'distanceKm',
  'demandMultiplier', 'waitTimeMin',
];

/* Request payload sources. */
const REQ = /\b(?:request|req)\s*\.\s*(?:data|body)\b/;

/* Known-good: the reference implementation and pure-config modules. */
const EXEMPT = new Set(['commission-config.js', 'payment-status.js', 'tax-tables.js']);

function fnFiles() {
  return fs.readdirSync(FN).filter(f => f.endsWith('.js') && !EXEMPT.has(f));
}

/* Extract every `const { ... } = request.data` style destructure plus direct
   member reads, and report which monetary names appear. */
function scan(src, file) {
  const hits = [];
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;   /* comments */
    if (!REQ.test(line)) return;

    /* destructured:  const { a, b, c } = request.data  */
    /* [^{}]* — not [^}]* — so this binds to the INNERMOST brace pair. With [^}]*
       an inline arrow body like `=> { const { amount } = request.data; }` matched
       the OUTER brace and captured "const { amount", which is not a field name, so
       the read went undetected. Caught by the verifier's own falsifiability test. */
    const d = line.match(/\{([^{}]*)\}\s*=\s*(?:request|req)\s*\.\s*(?:data|body)/);
    if (d) {
      d[1].split(',').map(s => s.split(':')[0].split('=')[0].trim())
        .filter(Boolean)
        .filter(n => MONEY.includes(n))
        .forEach(n => hits.push({ file, line: i + 1, field: n, form: 'destructured' }));
    }

    /* member access:  request.data.amount  */
    const m = line.match(/(?:request|req)\s*\.\s*(?:data|body)\s*\.\s*([A-Za-z_$][\w$]*)/g) || [];
    m.forEach(expr => {
      const name = expr.split('.').pop().trim();
      if (MONEY.includes(name)) hits.push({ file, line: i + 1, field: name, form: 'member' });
    });
  });
  return hits;
}

const all = [];
fnFiles().forEach(f => {
  let src; try { src = fs.readFileSync(path.join(FN, f), 'utf8'); } catch (e) { return; }
  all.push(...scan(src, f));
});

/* Group by file. */
const byFile = {};
all.forEach(h => { (byFile[h.file] = byFile[h.file] || []).push(h); });
const files = Object.keys(byFile).sort((a, b) => byFile[b].length - byFile[a].length);

const LIST = process.argv.includes('--list');

console.log('\nEntitlement verifier — Gate 1\n');
console.log('  RULE: a monetary field reaching a Cloud Function from the request payload');
console.log('        means NO entitlement control exists for that operation.\n');

console.log('  modules scanned                 : ' + fnFiles().length);
console.log('  modules taking client money     : ' + files.length);
console.log('  client-supplied monetary reads  : ' + all.length);

const distinct = [...new Set(all.map(h => h.field))].sort();
console.log('  distinct monetary fields        : ' + distinct.length);
console.log('    ' + distinct.join(', ') + '\n');

console.log('  ── modules by client-money reads ──');
files.slice(0, LIST ? files.length : 15).forEach(f => {
  const fields = [...new Set(byFile[f].map(h => h.field))].sort();
  console.log('    ' + String(byFile[f].length).padStart(3) + '  ' + f.padEnd(30) + fields.slice(0, 6).join(', ') +
              (fields.length > 6 ? ' …' : ''));
});
if (!LIST && files.length > 15) console.log('    … ' + (files.length - 15) + ' more (use --list)');

if (LIST) {
  console.log('\n  ── every occurrence ──');
  all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
     .forEach(h => console.log('    ' + (h.file + ':' + h.line).padEnd(42) + h.field));
}

/* ── Baseline gate ────────────────────────────────────────────────────────
   Gate 1 does not require zero — remediation is Gates 2-8. It requires the
   number never to RISE. A new client-supplied monetary read is a regression
   against the Constitution and must fail the build. */
const BASELINE = Number(process.env.ENTITLEMENT_BASELINE || 0) ||
                 (function () {
                   const p = path.join(__dirname, '.entitlement-baseline');
                   try { return Number(fs.readFileSync(p, 'utf8').trim()); } catch (e) { return null; }
                 })();

console.log('');
if (BASELINE === null) {
  console.log('  No baseline recorded. Write ' + all.length + ' to scripts/.entitlement-baseline to lock it in.\n');
  process.exit(0);
}
if (all.length > BASELINE) {
  console.log('  FAIL — client-supplied monetary reads rose ' + BASELINE + ' -> ' + all.length + '.');
  console.log('  A new monetary field now enters from the request payload. That operation has');
  console.log('  no entitlement control. Derive it from server state instead.\n');
  process.exit(1);
}
console.log('  PASS — ' + all.length + ' client-supplied monetary reads (baseline ' + BASELINE + ').' +
            (all.length < BASELINE ? '  Improved by ' + (BASELINE - all.length) + '.' : ''));
console.log('  Lower the baseline as Gates 2-8 remediate.\n');
process.exit(0);
