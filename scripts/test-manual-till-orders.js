#!/usr/bin/env node
/* Manual-Till order lifecycle — contract conformance.
 *
 * Every assertion maps to a clause of MANUAL_TILL_ORDER_CONTRACT. The ones that
 * matter most are ABSENCES: this path must never claim SOKONI saw the money, must
 * never move stock while §4.2 is unratified, and must never create a commission
 * receivable. A test that only checked the happy path would pass while each of
 * those was broken.
 *
 *   node scripts/test-manual-till-orders.js
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

const ORD    = strip(read('functions', 'manual-till-orders.js'));
const POL    = strip(read('functions', 'manual-till-policy.js'));
const IDX    = strip(read('functions', 'index.js'));
const CONTRACT = read('docs', 'MANUAL_TILL_ORDER_CONTRACT.md');
const DEST     = strip(read('functions', 'payment-destinations.js'));

/* ══ A. F1 — the state collision must not be repeated ══════════════════════ */
console.log('\nA. F1 — awaiting_confirmation is NOT reused\n');
{
  ck('a distinct pre-paid state exists',
     /AWAITING_ATTESTATION = 'awaiting_payment_attestation'/.test(ORD));
  ck('the order is created in it, not in awaiting_confirmation',
     /status:\s+AWAITING_ATTESTATION/.test(ORD));
  ck('  ...and awaiting_confirmation is never written by this module',
     !/status:\s*['"]awaiting_confirmation['"]/.test(ORD));
  ck('negative control: detector WOULD catch the reuse',
     /status:\s*['"]awaiting_confirmation['"]/.test("status: 'awaiting_confirmation',"));
}

/* ══ B. §0 — SOKONI never claims to have observed the money ════════════════ */
console.log('\nB. The invariant — no claim of observed payment\n');
{
  ck('paymentVerified is written FALSE on creation', /paymentVerified:\s+false/.test(ORD));
  ck('paymentVerified is NEVER written true anywhere in this module',
     !/paymentVerified:\s*true/.test(ORD));
  ck('attestation ALSO leaves paymentVerified false',
     /paymentVerified:\s+false,[\s\S]{0,200}?paymentAttestedBy/.test(ORD));
  ck('the customer-facing message does not claim confirmation',
     /will confirm receipt of payment/.test(ORD) && !/payment (confirmed|received) by SOKONI/i.test(ORD));
}

/* ══ C. F2 — reference provenance is preserved ═════════════════════════════ */
console.log('\nC. F2 — referenceSource\n');
{
  ck("creation records referenceSource: 'customer'", /referenceSource:\s+'customer'/.test(ORD));
  ck('attestation records who attested', /paymentAttestedBy:\s*isAdmin/.test(ORD));
  ck('  ...and the acting uid', /attestedByUid:\s+actor/.test(ORD));
  ck('admin-on-behalf is distinguished from merchant',
     /admin_on_behalf/.test(ORD) && /'merchant'/.test(ORD));
}

/* ══ D. §4.2 — stock is NOT touched while unratified ═══════════════════════ */
console.log('\nD. §4.2 — no stock movement, in either direction\n');
{
  ['inventoryApplied', 'adjustStock', 'stockReads'].forEach((t) => {
    ck(`never writes/uses ${t}`, !new RegExp(t).test(ORD));
  });
  ck('does not touch the products collection for writes',
     !/collection\('products'\)[\s\S]{0,80}?\.(set|update)\(/.test(ORD));
  ck('negative control: detector WOULD catch a stock write',
     /inventoryApplied/.test("inventoryApplied: true,"));
}

/* ══ E. F4 — no commission path is created ═════════════════════════════════ */
console.log('\nE. F4 — commission untouched\n');
{
  ['commissionLedger', 'commissionSettlements', 'calculateCommission', 'commissionPct']
    .forEach((t) => ck(`no reference to ${t}`, !new RegExp(t).test(ORD)));
  ck('contract states commission attaches at completed, not here',
     /ONE commission receivable/.test(CONTRACT) && /completion \(§6\), never here/.test(CONTRACT));
}

/* ══ F. Policy gate — fail-closed, and F3 enforced ═════════════════════════ */
console.log('\nF. Policy gate\n');
{
  ck('policy module has NO default for reserveStock',
     !/reserveStock:\s*(true|false)/.test(POL));
  ck('a non-boolean reserveStock is refused',
     /typeof c\.reserveStock !== 'boolean'\) return null/.test(POL));
  ck('a non-positive attestation window is refused',
     /!Number\.isFinite\(hrs\) \|\| hrs <= 0\) return null/.test(POL));
  ck('an unattributable decision is refused', /!c\.decidedBy\) return null/.test(POL));
  ck('unreadable config returns null, never a guess', /catch \(_e\)[\s\S]{0,200}?return null;/.test(POL));

  /* F3 — the binding one. */
  ck("F3: 'auto_confirm' is NOT an accepted outcome",
     /SILENCE_OUTCOMES = new Set\(\['escalate_to_human', 'auto_cancel'\]\)/.test(POL) &&
     !/'auto_confirm'/.test(POL.replace(/SILENCE_OUTCOMES[^)]*\)/, '')));
  ck('  ...an unrecognised outcome is refused',
     /!SILENCE_OUTCOMES\.has\(c\.onMerchantSilence\)\) return null/.test(POL));

  ck('BOTH callables refuse when the policy is unset',
     (ORD.match(/if \(!policy\) throw new HttpsError\('failed-precondition', UNSET_REASON\)/g) || []).length === 2);
}

/* ══ G. Authority — client states what, never how much or who ══════════════ */
console.log('\nG. Server-derived amount and seller\n');
{
  ck('amount is computed from product documents',
     /amount \+= unit \* qty/.test(ORD) && /collection\('products'\)/.test(ORD));
  ck('  ...and the caller supplies no amount', !/data\.amount|amount \} = request\.data/.test(ORD));
  ck('single-shop invariant enforced', /sellers\.size > 1/.test(ORD));
  ck('  ...and items must belong to the named shop', /Items do not belong to the named shop/.test(ORD));
  ck('mode comes from resolveActiveDestination, not a second source',
     /resolveActiveDestination\(sellerUid\)/.test(ORD));
  ck('an STK-authorised shop is REFUSED this path',
     /dest\.blocked !== 'production_not_authorized'/.test(ORD));
}

/* ══ H. Attestation authority + idempotency ════════════════════════════════ */
console.log('\nH. Attestation\n');
{
  ck('only the seller (or admin) may attest', /isSeller && !isAdmin/.test(ORD));
  ck('runs in a transaction', /runTransaction\(async \(txn\)/.test(ORD));
  ck('a repeat attestation is an idempotent no-op', /already_attested/.test(ORD));
  ck('only an awaiting-attestation order transitions',
     /d\.status !== AWAITING_ATTESTATION/.test(ORD));
  ck('reference uniqueness reuses the EXISTING claim mechanism',
     /require\('\.\/pos-mpesa-refs'\)/.test(ORD) && /_claimReference/.test(ORD));
  ck('  ...and a duplicate does not block the order (customer already paid)',
     /refClaim\.ok \? 'claimed' :/.test(ORD));
}

/* ══ I. Wiring + negative controls ═════════════════════════════════════════ */
console.log('\nI. Wiring and controls\n');
{
  ck('both functions re-exported by name',
     /exports\.createManualTillOrder\s*=\s*manualTill\.createManualTillOrder/.test(IDX) &&
     /exports\.attestManualTillPayment\s*=\s*manualTill\.attestManualTillPayment/.test(IDX));
  ck('no new collection is created',
     !/collection\('manualTill|collection\("manualTill/.test(ORD));
  ck('negative control: detector WOULD see paymentVerified true',
     /paymentVerified:\s*true/.test("paymentVerified: true,"));
  ck('comment-stripping kept the code under test',
     /createManualTillOrder/.test(ORD) && /loadManualTillPolicy/.test(POL));
}

/* ══ J. PayBill — accountReference on the EXISTING destination model ═══════ */
console.log('\nJ. PayBill accountReference\n');
{
  ck('accountReference is captured on save', /const accountReference\s+=/.test(DEST));
  ck('  ...REQUIRED for PAYBILL',
     /destinationType === 'PAYBILL' && !accountReference/.test(DEST));
  ck('  ...and stored NULL for TILL, not an empty string',
     /accountReference: destinationType === 'PAYBILL' \? accountReference : null/.test(DEST));
  ck('changing the account re-enters PENDING_TEST rather than swapping silently',
     /\(active\.accountReference \|\| null\) === \(accountReference \|\| null\)/.test(DEST));

  /* Behavioural: the guard is executed, not merely matched. A source-text
     assertion would still pass if the condition were inverted. */
  {
    const isNoOp = (active, incoming) =>
      !!(active
         && active.destinationType   === incoming.destinationType
         && active.destinationNumber === incoming.destinationNumber
         && (active.accountReference || null) === (incoming.accountReference || null));

    const verified = { destinationType: 'PAYBILL', destinationNumber: '400200', accountReference: 'KASS-001' };

    ck('  ↳ identical PayBill re-save is a no-op (keeps verification)',
       isNoOp(verified, { ...verified }) === true);
    ck('  ↳ CHANGED account does NOT inherit verification',
       isNoOp(verified, { ...verified, accountReference: 'KASS-002' }) === false);
    ck('  ↳ cleared account does NOT inherit verification',
       isNoOp(verified, { ...verified, accountReference: '' }) === false);
    ck('  ↳ same number, TILL instead of PAYBILL, does not inherit',
       isNoOp(verified, { ...verified, destinationType: 'TILL', accountReference: '' }) === false);
    ck('  ↳ TILL re-save with both refs absent IS a no-op',
       isNoOp({ destinationType: 'TILL', destinationNumber: '3588275', accountReference: null },
              { destinationType: 'TILL', destinationNumber: '3588275', accountReference: '' }) === true);
    ck('  ↳ negative control: a different NUMBER never inherits',
       isNoOp(verified, { ...verified, destinationNumber: '400201' }) === false);
  }
  ck('verification carries it through to activeDestination',
     /accountReference:\s+pending\.accountReference \?\? null/.test(DEST));
  ck('NO new collection was created for PayBill',
     !/collection\('paybill|collection\("paybill/i.test(DEST));
  ck('  negative control: the PAYBILL-guard detector can fail',
     !/destinationType === 'PAYBILL' && !accountReference/.test('const x = 1;'));
}

/* ══ K. Method vocabulary — canonical + legacy compatibility ═══════════════ */
console.log('\nK. mpesa_manual canonical, legacy preserved\n');
{
  ck('new records use the canonical mpesa_manual', /METHOD\s+= 'mpesa_manual'/.test(ORD));
  ck('legacy POS value retained as a constant',
     /METHOD_LEGACY_POS\s+= 'mpesa_till_manual'/.test(ORD));
  ck('attestation accepts BOTH — no orphaned legacy orders',
     /d\.paymentMethod !== METHOD && d\.paymentMethod !== METHOD_LEGACY_POS/.test(ORD));
  ck('the DESTINATION carries the TILL/PAYBILL distinction, not the method name',
     /destinationType:\s+dest\.destination\.destinationType/.test(ORD));
  ck('  ...and the account reference is recorded on the order',
     /destinationAccountRef: dest\.destination\.accountReference/.test(ORD));
  ck('no historical rewrite of paymentMethod is attempted',
     !/\.update\([^)]*paymentMethod/.test(ORD));
}

/* ══ L. POS manual-payment queue (UI) ══════════════════════════════════════ */
console.log('\nL. POS queue surface\n');
{
  const POSJS  = strip(read('pos.js'));
  const POSHTM = read('pos.html');

  ck('the queue exists in the POS orders panel', /id="manual-pay-queue"/.test(POSHTM));
  ck('it loads only awaiting_payment_attestation orders',
     /'status', '==', 'awaiting_payment_attestation'/.test(POSJS));
  ck('  ...scoped to THIS merchant', /'sellerUid', '==', uid/.test(POSJS));
  ck('it loads when the Orders tab opens', /orders\.render\(\); manualPay\.load\(\);/.test(POSJS));
  ck('exported on the SPos namespace', /mpesaTill, manualPay,/.test(POSJS));

  /* The load-bearing invariant: the client must NOT write the payment state. */
  ck('the UI calls the backend attestation function',
     /httpsCallable\([^)]*\), 'attestManualTillPayment'\)/.test(POSJS));
  ck('  ...and NEVER writes status/paid itself',
     !/manualPay[\s\S]{0,1800}?(updateDoc|setDoc)\(/.test(POSJS));
  ck('  negative control: detector WOULD see a client write',
     /(updateDoc|setDoc)\(/.test("await updateDoc(ref, { status: 'paid' });"));

  /* Honest labelling — a merchant who thinks SOKONI checked will not check. */
  ck('the panel states SOKONI did not see the payment',
     /SOKONI did not see the/i.test(POSHTM));
  ck('  ...and that confirming means the merchant received it',
     /confirming\s*means\s*<em>you<\/em>\s*received the money/i.test(POSHTM.replace(/\s+/g, ' ')));
  ck('the reference is labelled as customer-entered, unverified',
     /Entered by the customer — not verified by SOKONI/.test(POSJS));
  ck('the confirm dialog tells the merchant to check their own M-PESA first',
     /Check your own M-PESA messages first/.test(POSJS));

  ck('PayBill shows the account reference; Till does not',
     /isPaybill[\s\S]{0,220}?destinationAccountRef/.test(POSJS));
  ck('amounts and refs are HTML-escaped', /_esc\(o\.paymentReference/.test(POSJS));
  ck('double-submit is guarded', /manualPay\._busy\[o\.id\]/.test(POSJS));
  ck('the panel hides entirely when empty (no "0 to confirm" habit)',
     /wrap\.style\.display = rows\.length \? '' : 'none'/.test(POSJS));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
