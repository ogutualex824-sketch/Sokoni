'use strict';
/**
 * eTIMS invoice-lifecycle model — pure logic guard.
 *
 *   node scripts/test-etims-lifecycle.js
 *
 * Verifies the INTERNAL lifecycle model (no Firestore): state machine, tax-engine
 * reuse (credit note = negated sale, debit/amendment = positive), deterministic
 * idempotent ids, and that the KRA adapter returns PENDING for every doc type —
 * proving no KRA fields are fabricated before the spec is loaded.
 */
const L = require('../functions/etims-lifecycle');
const KraAdapter = require('../functions/etims-kra-adapter');

let pass = 0, fail = 0;
const near = (a, b) => Math.abs(a - b) < 0.005;
const check = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`); };

console.log('\n=== eTIMS lifecycle model — pure logic guard ===');

const accepted = { id: 'INV-1', invoiceNumber: 'SOK-000001', sellerUid: 'S1', status: 'accepted' };
const items    = [{ unitPrice: 116, quantity: 1, vatStatus: 'registered' }];  // 116 incl = 100 + 16 VAT

/* 1. State machine */
{
  check('1a credit_note valid only from accepted', L.canApply('credit_note', 'accepted') && !L.canApply('credit_note', 'pending_submission'));
  check('1b cancellation valid pre-accept + accept', L.canApply('cancellation', 'pending_submission') && L.canApply('cancellation', 'accepted'));
  check('1c reversal only from accepted', L.canApply('reversal', 'accepted') && !L.canApply('reversal', 'failed'));
  check('1d unknown status → false', !L.canApply('amendment', 'nonsense'));
}

/* 2. Credit note reuses the tax engine and is the NEGATION of the sale */
{
  const cn = L.buildCreditNote({ originalInvoice: accepted, items, reason: 'return' });
  check('2a credit note links to original', cn.origInvoiceId === 'INV-1' && cn.docType === 'credit_note');
  check('2b credit note total negative (−116)', near(cn.totals.totAmt, -116));
  check('2c credit note VAT negative (−16)', near(cn.totals.totTaxAmt, -16));
}

/* 3. Debit note is a POSITIVE adjustment via the same engine */
{
  const dn = L.buildDebitNote({ originalInvoice: accepted, items, reason: 'undercharge' });
  check('3 debit note positive (+116 / +16 VAT)', near(dn.totals.totAmt, 116) && near(dn.totals.totTaxAmt, 16));
}

/* 4. Amendment recomputes via the engine */
{
  const am = L.buildAmendment({ originalInvoice: accepted, items: [{ unitPrice: 232, quantity: 1, vatStatus: 'registered' }], reason: 'fix price' });
  check('4 amendment recomputed (232 incl → 200 + 32)', near(am.totals.totAmt, 232) && near(am.totals.totTaxAmt, 32));
}

/* 5. Cancellation & reversal carry the linkage, no amounts */
{
  const cx = L.buildCancellation({ originalInvoice: accepted, reason: 'duplicate' });
  const rv = L.buildReversal({ originalInvoice: accepted, reason: 'chargeback' });
  check('5 cancellation + reversal link to original, status pending_submission',
    cx.origInvoiceId === 'INV-1' && rv.origInvoiceId === 'INV-1' && cx.status === 'pending_submission');
}

/* 6. Deterministic idempotent ids */
{
  const a = L.docId('credit_note', 'INV-1', 'k1');
  const b = L.docId('credit_note', 'INV-1', 'k1');
  const c = L.docId('credit_note', 'INV-1', 'k2');
  const d = L.docId('debit_note',  'INV-1', 'k1');
  check('6a same op+invoice+key → same id', a === b);
  check('6b different key → different id', a !== c);
  check('6c different op → different id', a !== d);
  check('6d id is prefixed by op', a.startsWith('credit_note_'));
}

/* 7. KRA adapter returns PENDING for EVERY doc type — no fabricated fields */
{
  const types = ['invoice', 'credit_note', 'debit_note', 'cancellation', 'amendment', 'reversal'];
  const allPending = types.every((t) => { const p = KraAdapter.buildPayload(t, { docType: t }); return p.ready === false && p.reason === 'KRA_SPEC_PENDING'; });
  check('7a every KRA payload is PENDING (not fabricated)', allPending);
  check('7b nothing is transmittable pre-spec', KraAdapter.SPEC_LOADED === false && !KraAdapter.isTransmittable(KraAdapter.buildPayload('credit_note', {})));
}

console.log(`\n${fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'}`);
process.exitCode = fail ? 1 : 0;
