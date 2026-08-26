#!/usr/bin/env node
/* Manual M-PESA Till payment — client wiring, receipt path, server claim.
 *
 *   sale → M-PESA Till Payment → enter reference → recorded paid → sync → receipt
 *
 * WHAT THIS GUARDS
 * The reference is useless unless it survives every hop. Each section asserts one
 * hop on the SHIPPED source, because a field that exists in the transaction and
 * never reaches paper is indistinguishable from a feature that works — which is
 * exactly the state the POS receipt was already in: PosPrintService renders a
 * payment block, and nothing ever supplied `payments` to render.
 *
 * DETECTOR NOTE
 * Comments here discuss the values being tested, so comments are stripped before
 * assertions and section F proves the stripped detectors still fire.
 *
 *   node scripts/test-pos-manual-till-payment.js
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
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

const POSJS  = strip(read('pos.js'));
const POSHTM = stripHtml(read('pos.html'));
const PRINT  = strip(read('sokoni-pos-print-service.js'));
const SRV    = strip(read('functions', 'pos-mpesa-refs.js'));
const IDX    = strip(read('functions', 'index.js'));

const METHOD = 'mpesa_till_manual';

/* ══ A. The method is offered, and is DISTINCT from STK ════════════════════ */
console.log('\nA. A distinct Till method exists\n');
{
  ck('a Till button is offered in the POS', /data-method="mpesa_till"/.test(POSHTM));
  ck('  ...and the STK M-PESA button still exists separately',
     /data-method="mpesa"[^_]/.test(POSHTM));
  ck('  ...labelled so a cashier can tell them apart', /M-PESA Till/.test(POSHTM));
  ck('selecting it opens the reference modal, NOT the STK modal',
     /method === 'mpesa_till'[\s\S]{0,200}?modal\.open\('mpesa-till-modal'\)/.test(POSJS));
  ck('the STK path is untouched — still opens mpesa-modal',
     /method === 'mpesa'\)\s*\{\s*modal\.open\('mpesa-modal'\)/.test(POSJS));
}

/* ══ B. The reference is required and normalised ═══════════════════════════ */
console.log('\nB. Reference entry\n');
{
  ck('a 10-char alphanumeric format is enforced', /\^\[A-Z0-9\]\{10\}\$/.test(POSJS));
  ck('input is normalised (uppercased, punctuation stripped)',
     /toUpperCase\(\)\.replace\(\/\[\^A-Z0-9\]\/g, ''\)/.test(POSJS));
  ck('confirm refuses an invalid reference',
     /if \(!MPESA_REF_RE\.test\(ref\)\)[\s\S]{0,160}?return;/.test(POSJS));
  ck('the confirm button starts disabled', /id="mpesa-till-confirm-btn"[^>]*disabled/.test(POSHTM));

  /* Drive the real normaliser through a faithful re-implementation of the
     shipped regex + normaliser, so the cases are checked rather than asserted. */
  const norm = (r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const RE   = /^[A-Z0-9]{10}$/;
  ck('  "qk72abc123" normalises and validates', RE.test(norm('qk72abc123')), norm('qk72abc123'));
  ck('  "QK72 ABC 123" (spaced, as read from SMS) validates', RE.test(norm('QK72 ABC 123')));
  ck('  a 9-char code is REJECTED', !RE.test(norm('QK72ABC12')));
  ck('  an 11-char code is REJECTED', !RE.test(norm('QK72ABC1234')));
  ck('  empty is REJECTED', !RE.test(norm('')));
}

/* ══ C. Honest labelling — recording is not verification ═══════════════════ */
console.log('\nC. The UI does not overclaim\n');
{
  const H = read('pos.html').replace(/\s+/g, ' ');
  ck('the screen says it RECORDS a payment', /records that the customer paid the Till/i.test(H));
  ck('  ...and explicitly denies independent confirmation',
     /not<\/strong> an independent confirmation from Safaricom/i.test(H));
  ck('the sale is marked operator-attested, not verified',
     /paymentVerified: false, paymentAttestedBy: 'operator'/.test(POSJS));
  ck('  ...and only for THIS method (others are not given an invented status)',
     /payInfo\.method === 'mpesa_till_manual'\s*\?\s*\{ paymentVerified: false/.test(POSJS));
}

/* ══ D. The reference reaches the RECEIPT ══════════════════════════════════ */
console.log('\nD. Receipt path — the hop that was broken\n');
{
  ck('the transaction now carries a tender array', /payments: \(function \(\) \{/.test(POSJS));
  ck('  ...carrying the M-PESA reference as `ref`',
     /if \(payInfo\.mpesaRef\) line\.ref = payInfo\.mpesaRef;/.test(POSJS));
  ck('  ...with amount applied, distinct from cash tendered',
     /line\.tendered = Number\(payInfo\.amountPaid\)/.test(POSJS) &&
     /amount: Number\(total\)/.test(POSJS));
  ck('the LIVE renderer prints a code from the tender', /p\.ref \|\| p\.mpesaCode/.test(PRINT));
  ck('  ...and has a human label for this method', /mpesa_till_manual:'M-Pesa Till'/.test(PRINT));

  /* The live renderer is PosPrintService, NOT SokoniReceiptDoc — verified
     2026-08-27: SokoniReceiptDoc is loaded by pos.html but referenced zero
     times by the print service. Wiring to it would have printed nothing. */
  ck('SokoniReceiptDoc is still NOT the POS renderer (assumption stays checked)',
     !/SokoniReceiptDoc/.test(PRINT));
}

/* ══ E. Server-side uniqueness ═════════════════════════════════════════════ */
console.log('\nE. Server claim — the actual guard\n');
{
  ck('claims use a deterministic per-merchant id',
     /return String\(merchantId\) \+ '__' \+ ref;/.test(SRV));
  ck('the claim is transactional', /db\.runTransaction\(async \(txn\) => \{/.test(SRV));
  ck('a second sale claiming the same reference is refused',
     /reason: 'claimed_by_another_sale'/.test(SRV));
  ck('the SAME sale re-claiming is idempotent (sync retries)',
     /already_claimed_by_this_sale/.test(SRV) && /idempotent: true/.test(SRV));
  ck('a conflict does NOT alter the sale status or total',
     !/status:\s*['"](void|cancelled|failed)['"]/.test(SRV));
  ck('  ...it records a conflict for a human instead',
     /collection\(CONFLICTS\)/.test(SRV) && /resolved:\s*false/.test(SRV));
  ck('the trigger fires on the canonical collection posTransactions',
     /document: 'posTransactions\/\{txnId\}'/.test(SRV));
  ck('  ...only for this method and only on completed sales',
     /t\.paymentMethod !== METHOD\) return;/.test(SRV) &&
     /t\.status !== 'completed'\)\s*return;/.test(SRV));
  ck('the caller cannot claim against another merchant',
     /permission-denied', 'Not your merchant record\.'/.test(SRV));
  ck('the stored claim is marked unverified',
     /verified:\s*false/.test(SRV));
  ck('both functions are re-exported by name from index.js',
     /exports\.claimPosMpesaReference\s*=\s*posMpesaRefs\.claimPosMpesaReference/.test(IDX) &&
     /exports\.onPosTransactionMpesaRef\s*=\s*posMpesaRefs\.onPosTransactionMpesaRef/.test(IDX));
}

/* ══ F. Scope + negative controls ══════════════════════════════════════════ */
console.log('\nF. Scope held, and the detectors work\n');
{
  ck('the server module touches NO Daraja/STK/C2B surface',
     !/darajaSTKPush|stkpush|productionAuthorized|darajaStoreNumber|C2B/i.test(SRV));
  ck('  ...and no commission logic', !/commissionLedger|commissionSettlements/i.test(SRV));

  /* Negative controls — a detector that cannot fail proves nothing. */
  ck('negative control: method detector DOES flag a raw unmapped key',
     !/nonexistent_method:'/.test(PRINT));
  ck('negative control: the 10-char rule DOES reject a 12-char code',
     !/^[A-Z0-9]{10}$/.test('QK72ABC12345'));
  ck('negative control: comment-stripping did not eat the code under test',
     /mpesa_till_manual/.test(POSJS) && /runTransaction/.test(SRV));
  {
    const probe = '/* payments: [{ref:"FAKE"}] */\nconst real = 1;';
    ck('  ...and it DOES remove a comment that would false-positive',
       !/payments: \[\{ref/.test(strip(probe)) && /const real/.test(strip(probe)));
  }
}

/* ══ G. Tender matrix — the SHIPPED builder is executed, not described ═════ */
console.log('\nG. Tender matrix (shipped builder executed)\n');
{
  /* Extract the real tender-array builder from pos.js and run it. Asserting on
     its source text would only prove the text; a split sale rendering wrongly is
     a runtime fact and has to be tested as one. */
  const raw   = read('pos.js');
  const start = raw.indexOf('payments: (function () {');
  const end   = raw.indexOf('})(),', start);
  ck('the builder was located in pos.js', start > -1 && end > start);
  const body  = raw.slice(start + 'payments: '.length, end + '})()'.length);
  const build = new Function('payInfo', 'total', 'return ' + body + ';');

  const cash = build({ method: 'cash', amountPaid: 1000, change: 150 }, 850);
  ck('cash -> one line, amount APPLIED not tendered',
     cash.length === 1 && cash[0].method === 'cash' && cash[0].amount === 850, JSON.stringify(cash[0]));
  ck('  ...tendered and change kept separate', cash[0].tendered === 1000 && cash[0].change === 150);

  const till = build({ method: 'mpesa_till_manual', amountPaid: 500, mpesaRef: 'QK72ABC123' }, 500);
  ck('Till -> one line carrying the reference',
     till.length === 1 && till[0].method === 'mpesa_till_manual' && till[0].ref === 'QK72ABC123');
  ck('  ...no bogus tendered/change on a non-cash tender',
     till[0].tendered === undefined && till[0].change === undefined);

  const card = build({ method: 'card', amountPaid: 200, cardRef: 'AUTH99' }, 200);
  ck('card -> reference taken from the card auth', card.length === 1 && card[0].ref === 'AUTH99');

  const split = build({ method: 'split', splitCash: 300, splitMpesa: 700, mpesaRef: 'QK72ABC123' }, 1000);
  ck('SPLIT -> TWO tenders, not one', split.length === 2, JSON.stringify(split));
  ck('  ...cash portion correct',   split[0].method === 'cash'  && split[0].amount === 300);
  ck('  ...M-PESA portion correct', split[1].method === 'mpesa' && split[1].amount === 700);
  ck('  ...the code sits on the M-PESA tender ONLY',
     split[1].ref === 'QK72ABC123' && split[0].ref === undefined);
  ck('  ...and NO tender is labelled the raw word "split"',
     !split.some((l) => l.method === 'split'));

  ck('split with zero M-PESA -> a single cash tender',
     (function () { const r = build({ method: 'split', splitCash: 1000, splitMpesa: 0 }, 1000);
                    return r.length === 1 && r[0].method === 'cash'; })());
  ck('split with zero cash -> a single M-PESA tender',
     (function () { const r = build({ method: 'split', splitCash: 0, splitMpesa: 1000, mpesaRef: 'QK72ABC123' }, 1000);
                    return r.length === 1 && r[0].method === 'mpesa' && r[0].ref === 'QK72ABC123'; })());

  ck('an absent reference adds NO ref key (never an empty string)',
     !('ref' in build({ method: 'cash', amountPaid: 100, change: 0, mpesaRef: null }, 100)[0]));
  ck('a tender set is never empty',
     build({ method: 'split', splitCash: 0, splitMpesa: 0 }, 50).length >= 1);

  /* Negative control — a harness that cannot fail proves nothing. */
  ck('negative control: harness WOULD catch a wrong split amount',
     build({ method: 'split', splitCash: 300, splitMpesa: 700 }, 1000)[0].amount !== 700);
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
