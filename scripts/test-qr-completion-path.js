/* POS QR completion — a QR sale completes only on server-verified payment.

   THE DEFECT THIS CLOSES (found during the receipt-gate preflight, HEAD 1a54da5)

   Two live routes from a QR attempt to a COMPLETED sale with no money:

     A. tap QR → close the modal → press Charge.
        SPosQR.close() reset the method to 'cash', so the sale completed as
        CASH — the one method the receipt gate trusts — and PRINTED.
     B. the success state's "Complete Sale" called SPos.payment.completeQR(),
        which did not exist anywhere, so it fell back to payment.process().
        With the method still 'qr' and no qr branch, that reached the cash
        tail and completed.

   These are SOURCE-CONTRACT assertions, not git-diff assertions: they stay
   true after this slice is committed. (Four diff-based checks in this
   workstream have already gone vacuous or false on commit.)
*/
'use strict';
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
                      .replace(/^\s*\/\/.*$/gm, '')
                      .replace(/<!--[\s\S]*?-->/g, '');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 74) + ']' : ''));
  ok ? pass++ : fail++;
};

const posJs   = read('pos.js');
const posCode = strip(posJs);
const posHtml = read('pos.html');
const qrCode  = strip(posHtml);
const G       = require(path.join(root, 'sokoni-pos-receipt-gate.js'));

/* 1 */
console.log('\n── 1. QR cannot reach the cash completion branch ──');
{
  ck('process() now has a qr branch', /if \(method === 'qr'\)/.test(posCode));
  /* It must come BEFORE the cash tail, or it is decorative. */
  const qrAt   = posCode.indexOf("if (method === 'qr')");
  const cashAt = posCode.indexOf("const tendered = parseFloat(state.numpadStr)");
  ck('…and it precedes the cash tail', qrAt > 0 && cashAt > 0 && qrAt < cashAt,
     qrAt + ' < ' + cashAt);
  /* The branch must RETURN — falling through would change nothing. */
  const branch = posCode.slice(qrAt, cashAt);
  ck('…and it returns rather than falling through', /\breturn;/.test(branch));
  ck('…without calling complete()', !/payment\.complete\(|complete\(\{/.test(branch));
}

/* 2 */
console.log('\n── 2. Closing the QR modal cannot complete the sale ──');
{
  /* Scoped to close() itself. A whole-file scan matches the legitimate Cash
     tile button (pos.html:615), which must keep calling setMethod('cash'). */
  const closeFn = qrCode.slice(qrCode.indexOf('function close()'), qrCode.indexOf('function cancel()'));
  ck('close() no longer resets the method to cash',
     !/setMethod\('cash'\)/.test(closeFn), closeFn.length + ' chars scanned');
  ck('…and the scan really read close() (positive control)', /posQrModal/.test(closeFn));
  /* Inverting control: the Cash tile still sets it, so the absence above is
     about close(), not about setMethod vanishing. */
  ck('…while the Cash tile still calls it', /setMethod\('cash'\)/.test(qrCode));
  ck('a closed-then-Charge lands in the qr branch, which refuses',
     /if \(method === 'qr'\)[\s\S]{0,400}return;/.test(posCode));
}

/* 3-5 */
console.log('\n── 3/4/5. Pending, failed and cancelled cannot complete ──');
{
  const cq = posCode.slice(posCode.indexOf('async completeQR'));
  ck('completeQR requires status === "paid"', /details\.status !== 'paid'/.test(cq));
  ck('…and returns without completing otherwise',
     /details\.status !== 'paid'\)[\s\S]{0,200}return;/.test(cq));
  /* cancelled / expired are thrown by getPOSPaymentDetails, so they arrive as
     an error — which must also not complete. */
  ck('a thrown provider answer does not complete', /catch \(err\)[\s\S]{0,300}return;/.test(cq));
  ck('…and a non-answer is reported as NOT completed, not as failure',
     /was NOT completed/.test(cq));
}

/* 6 */
console.log('\n── 6. An unverified browser event cannot complete the sale ──');
{
  const cq = posCode.slice(posCode.indexOf('async completeQR'));
  /* The poll's success state is a UI state. completeQR must re-ask. */
  ck('completeQR re-asks the server', /getPOSPaymentDetails/.test(cq));
  ck('…and does not trust the poll/UI state',
     !/qrStateSuccess|_setState/.test(cq));
  /* The id is captured BEFORE close(), which nulls _txnId — so the call site
     passes the captured variable, not _txnId. Asserting the old spelling
     would have demanded the bug back. */
  ck('SPosQR.complete() routes to completeQR', /SPos\.payment\.completeQR\(txn\)/.test(qrCode));
  ck('…with the id captured BEFORE close() nulls it',
     /var txn = _txnId;[\s\S]{0,40}close\(\);/.test(qrCode));
  /* The old fallback to process() is what made the button unsafe. */
  ck('…and no longer falls back to process()',
     !/completeQR[\s\S]{0,200}SPos\.payment\.process\(\)/.test(qrCode));
}

/* 7 */
console.log('\n── 7. The server verification is the ONLY confirmation source ──');
{
  const cq = posCode.slice(posCode.indexOf('async completeQR'));
  ck('qrVerified is set only after the round-trip',
     cq.indexOf('getPOSPaymentDetails') < cq.indexOf('qrVerified:'));
  ck('the amount charged comes from the SERVER, not the cart',
     /Number\(details\.total\)/.test(cq));
  ck('…and a mismatch refuses rather than reconciles',
     /does not match this sale[\s\S]{0,160}return;/.test(cq));

  /* The receipt gate must require BOTH markers. */
  ck('the gate accepts a verified qr', G.receiptEligibility({ method: 'qr', qrVerified: true, qrTxnId: 't1' }).final);
  ck('…refuses a bare qr', !G.receiptEligibility({ method: 'qr' }).final);
  ck('…refuses qrVerified without an id', !G.receiptEligibility({ method: 'qr', qrVerified: true }).final);
  ck('…refuses a forged truthy flag',
     !G.receiptEligibility({ method: 'qr', qrVerified: 1, qrTxnId: 't1' }).final);
}

/* 8 + 9 */
console.log('\n── 8/9. Cash and card are unchanged ──');
{
  ck('the cash tail is intact', /const tendered = parseFloat\(state\.numpadStr\) \|\| total;/.test(posCode));
  ck('…and still refuses a short tender', /method === 'cash' && tendered < total/.test(posCode));
  ck('the card terminal path is intact', /result\.status === 'approved'/.test(posCode));
  ck('…still passing its auth code', /cardAuthCode: result\.authCode/.test(posCode));
  ck('cash still prints', G.receiptEligibility({ method: 'cash', amountPaid: 500 }, { total: 500 }).final);
  ck('approved card still prints', G.receiptEligibility({ method: 'card', cardAuthCode: 'A1' }).final);
}

console.log('\n── M-PESA STK stays retired ──');
ck('sendSTK still only toasts', /M-PESA by phone number has been retired/.test(posJs));
ck('…and does not complete', !/sendSTK[\s\S]{0,400}payment\.complete\(/.test(posCode));

/* 10 + 11 */
console.log('\n── 10/11. No settlement programme was started here ──');
{
  ck('10. no completeMultiTender implementation',
     !/completeMultiTender\s*[:(]|function completeMultiTender/.test(posCode));
  ck('11. no new financial collection', !/retailSettlements|posMultiTender/.test(posCode + qrCode));
  ck('…and posSales is not written from the till', !/collection\('posSales'\)/.test(posCode));
  /* Positive control: the scan reads real code. */
  ck('…the scan saw the till source', /async completeQR/.test(posCode), posCode.length + ' chars');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  NOT asserted (needs a browser): that the refusal toast shows and');
console.log('  that Complete Sale round-trips. Verify visually before deploy.\n');
process.exit(fail ? 1 : 0);
