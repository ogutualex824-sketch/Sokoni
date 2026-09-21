/* sokoni-pos-receipt-gate.js — a final receipt means a completed sale.

   THE INVARIANT

     A final receipt represents a completed financial sale,
     not merely an attempted payment.

   Two failure directions, both expensive, both tested:

     too permissive  a receipt prints for money that never arrived — the live
                     defect, reachable today via the `qr` fallthrough
     too strict      a cash sale stops printing, which breaks every ordinary
                     shop on the platform

   So every DENY is paired with an ALLOW, and vice versa.
*/
'use strict';
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const G = require(path.join(root, 'sokoni-pos-receipt-gate.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 74) + ']' : ''));
  ok ? pass++ : fail++;
};
const e = (p, o) => G.receiptEligibility(p, o);

console.log('\n── CASH is settled at the till ──');
ck('cash prints a final receipt', e({ method: 'cash', amountPaid: 500 }, { total: 500 }).final);
ck('cash with change prints', e({ method: 'cash', amountPaid: 1000, change: 500 }, { total: 500 }).final);
ck('cash with no total supplied still prints', e({ method: 'cash', amountPaid: 500 }).final);
ck('cash SHORT of the total does NOT print',
   !e({ method: 'cash', amountPaid: 400 }, { total: 500 }).final);
ck('…and offers a slip instead', e({ method: 'cash', amountPaid: 400 }, { total: 500 }).slip);
ck('exact cash is not treated as short (float safety)',
   e({ method: 'cash', amountPaid: 0.1 + 0.2 }, { total: 0.3 }).final);

console.log('\n── CARD needs a terminal approval ON THE RECORD ──');
ck('card with an auth code prints',
   e({ method: 'card', cardAuthCode: 'A1B2C3' }).final);
ck('card with only a reference prints', e({ method: 'card', cardRef: 'ref_9' }).final);
ck('card with NEITHER does not print', !e({ method: 'card' }).final);
ck('…and says why', /No terminal approval/.test(e({ method: 'card' }).reason));
/* The old code printed for ANY card payInfo. This is the removal of that. */
ck('the method name alone no longer grants a card receipt',
   !e({ method: 'card', amountPaid: 500 }).final);

console.log('\n── M-PESA TILL is cashier-attested, and that IS its authority ──');
ck('a till code prints', e({ method: 'mpesa_till_manual', mpesaRef: 'SGH7X2K9QQ' }).final);
ck('no code does NOT print', !e({ method: 'mpesa_till_manual' }).final);
ck('…and says the code is missing',
   /confirmation code/.test(e({ method: 'mpesa_till_manual' }).reason));

console.log('\n── QR prints only on a SERVER-VERIFIED completion ──');
{
  /* An UNVERIFIED qr payInfo is the old fallthrough shape — completed through
     the cash tail with nothing confirmed. Still refused. */
  const r = e({ method: 'qr', amountPaid: 1600 }, { total: 1600 });
  ck('unverified qr does NOT print a final receipt', !r.final);
  ck('…it offers a slip', r.slip);
  ck('…and says it is unverified', /not verified/.test(r.reason), r.reason);

  /* Verified only via payment.completeQR(), which re-asks the server. */
  ck('qr WITH a verified server round-trip prints',
     e({ method: 'qr', amountPaid: 1600, qrVerified: true, qrTxnId: 'abc123' }).final);
  /* Both are required — a bare boolean is assertable by anything that can
     build a payInfo, and the id is what ties the receipt to the payment. */
  ck('qrVerified WITHOUT a txn id does not print',
     !e({ method: 'qr', qrVerified: true }).final);
  ck('a txn id WITHOUT verification does not print',
     !e({ method: 'qr', qrTxnId: 'abc123' }).final);
  ck('a truthy non-true qrVerified does not print',
     !e({ method: 'qr', qrVerified: 'yes', qrTxnId: 'abc123' }).final);
}

console.log('\n── Unknown methods DENY by default ──');
for (const m of ['mpesa', 'bank', 'crypto', 'voucher', 'multi', '']) {
  ck(`"${m || '(empty)'}" does not print`, !e({ method: m, amountPaid: 100 }).final);
}
/* Inverting control — the gate is not a blanket refusal. */
ck('…while cash still does (inverting control)', e({ method: 'cash', amountPaid: 100 }).final);

console.log('\n── SPLIT is final only when every part is settled ──');
ck('cash-only split prints', e({ method: 'split', splitCash: 1000, splitMpesa: 0 }).final);
ck('split with an UNCONFIRMED M-PESA part does not print',
   !e({ method: 'split', splitCash: 300, splitMpesa: 700 }).final);
ck('split with a confirmed M-PESA code prints',
   e({ method: 'split', splitCash: 300, splitMpesa: 700, mpesaRef: 'SGH7X2K9QQ' }).final);

console.log('\n── autoPrint can SUPPRESS, never AUTHORISE ──');
{
  const eligible   = { method: 'cash', amountPaid: 500 };
  const ineligible = { method: 'qr', amountPaid: 500 };
  ck('eligible + autoPrint on  → print',  G.shouldPrintFinal(eligible,   { autoPrint: true  }).print);
  ck('eligible + autoPrint off → no print', !G.shouldPrintFinal(eligible, { autoPrint: false }).print);
  ck('INELIGIBLE + autoPrint on → still NO print',
     !G.shouldPrintFinal(ineligible, { autoPrint: true }).print);
  ck('…and the eligibility reason survives for the cashier',
     /not verified/.test(G.shouldPrintFinal(ineligible, { autoPrint: true }).eligibility.reason));
}

console.log('\n── Garbage in ──');
ck('null payInfo does not throw', e(null).final === false);
ck('no method reports it', /No payment method/.test(e({}).reason));

console.log('\n── The wiring in pos.js ──');
{
  const js = fs.readFileSync(path.join(root, 'pos.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'pos.html'), 'utf8');
  /* Scoped to CODE. The replacement documents what it replaced ("Was: …"),
     so a whole-file scan reads the new comment as the old defect — the same
     self-reading trap that has bitten this workstream three times now. */
  const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('the card shortcut is GONE from the code',
     !/autoPrint \|\| payInfo\.method === 'card'/.test(jsCode));
  ck('…and the comment still records what it replaced',
     /Was: `state\.settings\.autoPrint \|\| payInfo\.method === 'card'`/.test(js));
  /* Positive control: the stripper did not blank the file. */
  ck('…the stripped source still has the new gate',
     /shouldPrintFinal\(payInfo/.test(jsCode), jsCode.length + ' chars');
  ck('the gate is consulted', /SPosReceiptGate/.test(js));
  ck('…via shouldPrintFinal', /shouldPrintFinal\(payInfo/.test(js));
  ck('the module is loaded by the till', /src="sokoni-pos-receipt-gate\.js"/.test(html));
  ck('…before pos.js runs',
     html.indexOf('src="sokoni-pos-receipt-gate.js"') < html.indexOf('src="pos.js"'));
  ck('an ineligible sale tells the cashier why', /No sale receipt: /.test(js));
  /* A till that cannot load the gate must not silently stop printing. */
  ck('it fails OPEN to the old behaviour if the module is absent',
     /_rg\s*\?[\s\S]{0,200}: \{ print: !!state\.settings\.autoPrint/.test(js));
}

console.log('\n── Scope: nothing else was touched ──');
{
  const gate = fs.readFileSync(path.join(root, 'sokoni-pos-receipt-gate.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  ck('the gate is pure — no DOM', !/document\./.test(gate));
  ck('…no network', !/fetch|firebase|firestore/i.test(gate));
  ck('…no multi-tender engine', !/SPosTender|completeMultiTender/.test(gate));
  ck('…no retailSettlements', !/retailSettlements/.test(gate));
  ck('…and the stripped source still has real code',
     /function receiptEligibility/.test(gate), gate.length + ' chars');

  /* This was a `git diff HEAD --name-only` check and would have gone vacuous
     the moment the slice committed — the fourth time that pattern appeared in
     this workstream. The durable property is that the RECEIPT GATE does not
     reach into the settlement or payment machinery at all, which stays true
     regardless of what is committed. */
  ck('the gate names no server sale writer', !/recordPOSSale|posSales/.test(gate));
  ck('…no webhook', !/webhookIntasend|webhook/i.test(gate));
  ck('…no payment purpose', !/payment-purposes|pos_service_sale/.test(gate));
  ck('…and it reads ONLY the payInfo it is handed',
     !/require\(|import |window\./.test(gate.replace(/^\(function[\s\S]*?\{/, '')));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  NOT asserted (needs a browser): that the toast shows and the');
console.log('  printer stays silent. Verify visually before deploy.\n');
process.exit(fail ? 1 : 0);
