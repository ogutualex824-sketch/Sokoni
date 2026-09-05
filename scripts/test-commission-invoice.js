#!/usr/bin/env node
/* 48-hour commission invoice generator — authority, fail-closed VAT, failure safety.
 *
 * WHAT THIS GUARDS
 * The generator connects an existing receivable to an existing invoice engine.
 * Every assertion here is about a boundary that, if crossed, would recreate a
 * defect this platform has already paid for:
 *
 *   • an amount taken from a caller  → invoice disagrees with the receivable
 *   • a VAT treatment inferred       → a library default settles a tax question
 *   • a receivable mutated on failure→ a real debt erased by a failed document
 *   • a second invoice implementation→ the fifth parallel financial system
 *
 * The VAT arithmetic is driven through the REAL TaxEngine, because "inclusive vs
 * exclusive" is a number, and a comment asserting it proves nothing.
 *
 *   node scripts/test-commission-invoice.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT  = path.join(__dirname, '..');
const read  = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const GEN    = strip(read('functions', 'commission-invoice.js'));
const POLICY = strip(read('functions', 'commission-vat-policy.js'));
const ETIMS  = strip(read('functions', 'etims.js'));
const IDX    = strip(read('functions', 'index.js'));

/* ══ A. The ledger is authoritative for the amount ═════════════════════════ */
console.log('\nA. Amount authority\n');
{
  ck('the amount is READ from the receivable',
     /amountKES = Number\(d\.totalOutstanding \?\? d\.totalOwed \?\? 0\)/.test(GEN));
  ck('  ...outstanding preferred over bare commission (penalty included)',
     GEN.indexOf('totalOutstanding') < GEN.indexOf('totalOwed'));
  ck('a zero/absent amount is REFUSED, not invoiced as zero',
     /if \(!\(amountKES > 0\)\) return \{ ok: false, reason: 'no_amount_on_receivable' \}/.test(GEN));
  ck('the admin callable accepts NO amount parameter',
     /const \{ ledgerRowId \} = request\.data \|\| \{\}/.test(GEN) &&
     !/request\.data\.amount|const \{[^}]*amount[^}]*\} = request\.data/.test(GEN));
  ck('the engine is called with the ledger-derived amount',
     /amount:\s+amountKES,/.test(GEN));
}

/* ══ B. VAT is never inferred — fail-closed ════════════════════════════════ */
console.log('\nB. VAT policy is fail-closed\n');
{
  ck('the policy module has NO default treatment',
     !/inclusive:\s*true|inclusive:\s*false|inclusive\s*=\s*true/.test(POLICY));
  ck('a non-boolean `inclusive` is refused (no truthy coercion)',
     /typeof c\.inclusive !== 'boolean'\) return null/.test(POLICY));
  ck('a disabled policy returns null', /c\.enabled !== true\) return null/.test(POLICY));
  ck('an unattributable decision is refused', /!c\.decidedBy\) return null/.test(POLICY));
  ck('an unreadable config returns null, never a guess', /catch \(_e\) \{[\s\S]{0,220}?return null;/.test(POLICY));
  ck('the generator refuses to issue with no policy',
     /if \(!policy\) return \{ ok: false, reason: 'vat_policy_unset'/.test(GEN));
  ck('the treatment is passed EXPLICITLY to the engine',
     /vatInclusive: policy\.inclusive/.test(GEN));
  ck('the engine REFUSES a non-boolean treatment',
     /typeof vatInclusive !== "boolean"[\s\S]{0,220}?failed-precondition/.test(ETIMS));
  ck('  ...with a message naming the rule',
     /a VAT treatment may not be inferred/.test(ETIMS));
  ck('the live admin callable is gated for commission',
     /VAT_GATED_FEE_TYPES\.has\(feeType\)\)[\s\S]{0,200}?throw new HttpsError\("failed-precondition", UNSET_REASON\)/.test(ETIMS));
  ck('  ...the gate is SCOPED to commission, not all platform fees',
     /VAT_GATED_FEE_TYPES = new Set\(\["commission"\]\)/.test(ETIMS));
  ck('  ...subscription/advertising/etc keep their prior behaviour (no regression)',
     /let vatInclusive = true;/.test(ETIMS) &&
     !/VAT_GATED_FEE_TYPES = new Set\(\[[^\]]*subscription/.test(ETIMS));
  ck('  negative control: detector WOULD see a widened gate',
     /VAT_GATED_FEE_TYPES = new Set\(\[[^\]]*subscription/
       .test('const VAT_GATED_FEE_TYPES = new Set(["commission","subscription"]);'));
}

/* ══ C. Failure must not alter the obligation ══════════════════════════════ */
console.log('\nC. A failed document never erases a real debt\n');
{
  const forbidden = ['collectionStatus', 'totalOwed', 'totalOutstanding', 'dueAt', 'penaltyKES'];
  forbidden.forEach((f) => {
    /* The generator may READ these; it must never WRITE them. */
    const writes = new RegExp('(txn\\.update|\\.update|\\.set)\\([^)]*' + f + '\\s*:', 'm').test(GEN);
    ck(`never writes ${f}`, !writes);
  });
  ck('an engine failure returns receivableUnchanged',
     /reason: 'invoice_engine_failed'[\s\S]{0,120}?receivableUnchanged: true/.test(GEN));
  ck('a missing invoiceId also leaves the receivable unchanged',
     /reason: 'no_invoice_id_returned', receivableUnchanged: true/.test(GEN));
  ck('the only ledger write is the invoice linkage',
     /txn\.update\(ref, \{\s*invoiceId,/.test(GEN));
}

/* ══ D. Idempotency and eligibility ════════════════════════════════════════ */
console.log('\nD. One invoice per receivable\n');
{
  ck('an already-invoiced row is a no-op, not a second invoice',
     /if \(d\.invoiceId\)\s+return \{ ok: true,\s+reason: 'already_invoiced'/.test(GEN));
  ck('the engine idempotency key is made deterministic by the row id',
     /reference:\s+String\(ledgerRowId\)/.test(GEN));
  ck('the write-back re-checks inside a transaction',
     /runTransaction\(async \(txn\) => \{[\s\S]{0,220}?if \(cur\.data\(\)\.invoiceId\) return false/.test(GEN));
  ck('PAID and WAIVED are NOT invoiceable',
     /INVOICEABLE = \['DUE', 'REMINDED', 'OVERDUE'\]/.test(GEN) &&
     !/INVOICEABLE[^\]]*PAID/.test(GEN) && !/INVOICEABLE[^\]]*WAIVED/.test(GEN));
  ck('only PER_SALE_48H rows are handled',
     /d\.billingModel !== BILLING\)\s+return \{ ok: false, reason: 'not_48h_billing_model' \}/.test(GEN));
}

/* ══ E. No second invoice system ═══════════════════════════════════════════ */
console.log('\nE. Reuse, not duplication\n');
{
  ck('the generator creates NO new collection',
     !/collection\('commissionInvoices'\)|collection\("commissionInvoices"\)/.test(GEN));
  ck('  ...and does not write etimsInvoices directly',
     !/collection\('etimsInvoices'\)|collection\("etimsInvoices"\)/.test(GEN));
  ck('it delegates to the ONE platform-invoice implementation',
     /etims\._issuePlatformInvoice\(\{/.test(GEN));
  ck('that implementation is exported for reuse', /_issuePlatformInvoice,/.test(ETIMS));
  ck('the generator never writes commissionSettlements',
     !/commissionSettlements/.test(GEN));
  ck('no commission rate or minimum is defined here',
     !/0\.05|MIN_COMMISSION|commissionPct\s*=/.test(GEN));
  ck('no escrow vocabulary on this rail',
     !/\bHELD\b|\bRELEASED\b|RELEASE_ELIGIBLE/.test(GEN));
  ck('re-exported by name from index.js',
     /exports\.issueCommissionInvoice = commissionInvoice\.issueCommissionInvoice/.test(IDX));
}

/* ══ F. The VAT arithmetic, driven through the REAL engine ═════════════════ */
console.log('\nF. Real TaxEngine arithmetic — the money, not the prose\n');
{
  const TaxEngine = require(path.join(ROOT, 'functions', 'etims-tax-engine.js'));
  const line = (amount, inclusive) =>
    TaxEngine.computeLine({ name: 'Platform Commission Fee', quantity: 1, unitPrice: amount, discountRate: 0, seq: 1 },
                          'registered', { inclusive });

  const inc = line(500, true);
  const exc = line(500, false);

  ck('INCLUSIVE: merchant owes 500', inc.totAmt === 500, 'totAmt=' + inc.totAmt);
  ck('  ...VAT extracted from within (68.97)', inc.taxAmt === 68.97, 'tax=' + inc.taxAmt);
  ck('  ...SOKONI recognises 431.03', inc.taxblAmt === 431.03, 'net=' + inc.taxblAmt);

  ck('EXCLUSIVE: merchant owes 580', exc.totAmt === 580, 'totAmt=' + exc.totAmt);
  ck('  ...VAT added on top (80)', exc.taxAmt === 80, 'tax=' + exc.taxAmt);
  ck('  ...SOKONI recognises 500', exc.taxblAmt === 500, 'net=' + exc.taxblAmt);

  ck('the two treatments genuinely differ', inc.totAmt !== exc.totAmt,
     inc.totAmt + ' vs ' + exc.totAmt);

  /* The finding that started this: an absent config silently picks inclusive. */
  const dflt = TaxEngine.computeLine({ name: 'x', quantity: 1, unitPrice: 500, discountRate: 0, seq: 1 }, 'registered');
  ck('CONTROL: an absent config still defaults to INCLUSIVE (the original defect)',
     dflt.totAmt === inc.totAmt, 'default totAmt=' + dflt.totAmt);
  ck('  ...which is exactly why the generator must state it explicitly',
     /vatInclusive: policy\.inclusive/.test(GEN));
}

/* ══ G. Negative controls ══════════════════════════════════════════════════ */
console.log('\nG. Negative controls\n');
{
  ck('detector WOULD catch a caller-supplied amount',
     /const \{[^}]*amount[^}]*\} = request\.data/.test('const { ledgerRowId, amount } = request.data;'));
  ck('detector WOULD catch a defaulted VAT treatment',
     /inclusive:\s*true/.test('const cfg = { inclusive: true };'));
  ck('detector WOULD catch a forbidden ledger write',
     /(\.update|\.set)\([^)]*collectionStatus\s*:/.test(".update({ collectionStatus: 'PAID' })"));
  ck('comment-stripping kept the code under test',
     /issueForReceivable/.test(GEN) && /loadVatPolicy/.test(POLICY));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
