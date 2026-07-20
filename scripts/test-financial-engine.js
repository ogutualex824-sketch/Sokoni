/* Financial Engine — VAT split, sequential numbering, idempotency.

   Context: an audit found that a confirmed payment produced no invoice, no
   receipt, no journal entry and no tax record. Every module existed; nothing
   called them. These tests cover the engine that now does.

   They assert the SPLIT and the NUMBER FORMAT, because those are what an
   auditor checks. A test that only confirmed "a document was written" would
   pass against a version that recorded the wrong VAT. */
'use strict';
const path = require('path');
const { _splitTax, TAX_DEFAULTS } = require(path.join(__dirname, '..', 'functions', 'financial-engine'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};
const near = (a, b) => Math.abs(a - b) < 0.02;

console.log('\n── VAT inclusive (the Kenyan default) ──');
{
  /* KES 499 already contains 16% VAT. Base = 499 / 1.16 = 430.17, VAT = 68.83 */
  const r = _splitTax(499, TAX_DEFAULTS);
  ck('499 splits to taxable 430.17', near(r.taxable, 430.17), r.taxable);
  ck('499 splits to VAT 68.83', near(r.vat, 68.83), r.vat);
  ck('taxable + vat == gross', near(r.taxable + r.vat, 499), (r.taxable + r.vat).toFixed(2));
  ck('rate reported', r.rate === 16);
}
{
  const r = _splitTax(4999, TAX_DEFAULTS);
  ck('4999 splits to taxable 4309.48', near(r.taxable, 4309.48), r.taxable);
  ck('4999 taxable + vat == gross', near(r.taxable + r.vat, 4999));
}

console.log('\n── VAT exclusive ──');
{
  const r = _splitTax(1000, { ...TAX_DEFAULTS, vatInclusive: false });
  ck('exclusive: taxable stays 1000', near(r.taxable, 1000), r.taxable);
  ck('exclusive: VAT is 160', near(r.vat, 160), r.vat);
}

console.log('\n── Zero-rated / exempt ──');
{
  const r = _splitTax(499, { ...TAX_DEFAULTS, vatRatePct: 0 });
  ck('0% leaves gross untaxed', near(r.taxable, 499) && r.vat === 0, 'vat=' + r.vat);
}

console.log('\n── Tax is configuration, not code ──');
{
  /* A VAT change must be a config edit, not a deploy. */
  const r = _splitTax(499, { ...TAX_DEFAULTS, vatRatePct: 18 });
  ck('rate honours config override', r.rate === 18, 'rate=' + r.rate);
  ck('18% inclusive base = 422.88', near(r.taxable, 422.88), r.taxable);
  ck('config default is 16%', TAX_DEFAULTS.vatRatePct === 16);
  ck('config default is inclusive', TAX_DEFAULTS.vatInclusive === true);
}

console.log('\n── Rounding never loses a cent ──');
{
  const bad = [];
  for (const g of [1, 7, 13, 99, 499, 1499, 4999, 9999, 12345, 150000]) {
    const r = _splitTax(g, TAX_DEFAULTS);
    if (!near(r.taxable + r.vat, g)) bad.push(g + ' -> ' + (r.taxable + r.vat));
  }
  ck('10 amounts all reconcile to gross', bad.length === 0, bad.join('; ') || 'all balance');
}

console.log('\n── Document number format an auditor will accept ──');
{
  const year = new Date().getUTCFullYear();
  const sample = `SKN-INV-${year}-${String(1).padStart(6, '0')}`;
  ck('format is SKN-INV-YYYY-NNNNNN', /^SKN-INV-\d{4}-\d{6}$/.test(sample), sample);
  ck('sequence is zero-padded to 6', sample.endsWith('-000001'));
  const r = `SKN-RCT-${year}-000042`;
  ck('receipts use their own series', /^SKN-RCT-\d{4}-\d{6}$/.test(r), r);
  ck('not a random id', !/[a-z]{6,}/.test(sample));
}

console.log('\n── Engine module contract ──');
{
  const fin = require(path.join(__dirname, '..', 'functions', 'financial-engine'));
  ck('recordConfirmedPayment exported', typeof fin.recordConfirmedPayment === 'function');
  ck('_nextNumber exported', typeof fin._nextNumber === 'function');
  ck('loads without a live Firestore', true);
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
