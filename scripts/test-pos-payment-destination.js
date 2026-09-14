#!/usr/bin/env node
/* POS setup step-7 payment-destination card.
 *
 * TWO THINGS THIS SUITE GUARDS.
 *
 * 1. THE PROVISIONING FLOW IS UNTOUCHED. Steps 1-6 (Network -> Sign In ->
 *    Businesses -> Branch -> Provisioning) are the workflow we were told not to
 *    disturb, so the suite asserts every one of them still exists, that no new
 *    step or dot was added, and that the card lives strictly inside step-7 and
 *    ahead of nothing except the Open POS button.
 *
 * 2. THE CARD CANNOT MIS-SCOPE A SAVE. POS setup selects a business by
 *    `merchantId`; the payment backend resolves auth.uid -> activeShopId. Those
 *    are different identities. If the selected business is not this account's
 *    own shop, saving would write the destination for the WRONG business —
 *    silently, and financially. The card must refuse in that case, and the
 *    suite asserts the guard rather than trusting it.
 *
 *   node scripts/test-pos-payment-destination.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const H = fs.readFileSync(path.join(ROOT, 'pos-setup.html'), 'utf8');

/* ══ A. The existing provisioning workflow is intact ══════════════════════ */
console.log('\nA. Steps 1-6 and the provisioning flow are untouched\n');
{
  for (let i = 1; i <= 7; i++) {
    ck('step-' + i + ' panel still present', new RegExp('id="step-' + i + '"').test(H));
  }
  ck('exactly 7 step panels — none added', (H.match(/class="step-panel/g) || []).length === 7,
     (H.match(/class="step-panel/g) || []).length + ' panels');
  ck('exactly 7 step dots — none added', (H.match(/class="step-dot/g) || []).length === 7);
  for (const t of ['Network Check', 'Sign In', 'Your Businesses', 'Select Branch', 'Provisioning Device']) {
    ck('"' + t + '" heading still present', H.includes(t));
  }
  ck('still exactly one POS setup page (no second wizard shell)',
     (H.match(/id="step-viewport"/g) || []).length <= 1);
}

/* ══ B. The card is confined to step-7 ═══════════════════════════════════ */
console.log('\nB. The card lives only in step-7, before Open POS\n');
{
  const s7 = H.indexOf('id="step-7"');
  const wrap = H.indexOf('id="pd-card-wrap"');
  const openPos = H.indexOf('id="btn-open-pos"');
  const s6 = H.indexOf('id="step-6"');
  ck('card markup is inside step-7', wrap > s7, 'step7@' + s7 + ' card@' + wrap);
  ck('  ...and after step-6 closes', wrap > s6);
  ck('  ...and before the Open POS button', wrap < openPos);
  ck('checklist still precedes the card',
     H.indexOf('id="setup-checklist-wrap"') < wrap);
  ck('Open POS button unchanged and still present', /id="btn-open-pos"/.test(H));
  ck('Configure Hardware button still present', /id="btn-configure-hw"/.test(H));
  ck('Payment Methods tile still present', /id="ready-payments"/.test(H));
}

/* ══ C. Scope guard — the mis-scope defence ══════════════════════════════ */
console.log('\nC. Cannot save against the wrong business\n');
{
  ck('selected business is compared against the resolved shopId',
     /String\(selected\) !== String\(d\.shopId\)/.test(H));
  ck('  ...and a mismatch drops to read-only rather than saving',
     /String\(selected\) !== String\(d\.shopId\)\)\s*\{[\s\S]{0,200}?mode = 'readonly'/.test(H));
  ck('merchantId is NOT passed to the payment backend',
     !/savePaymentDestination'\)\(\{[\s\S]{0,220}?merchantId/.test(H));
  ck('  ...the save sends only destination fields',
     /savePaymentDestination'\)\(\{\s*\n\s*destinationType[\s\S]{0,160}?accountName:\s+PD\.draftName,\s*\n\s*\}\)/.test(H));
  ck('a non-owner gets the owner-required notice',
     /Business owner required to change payment details/.test(H));
  ck('  ...triggered by permission-denied / failed-precondition',
     /permission-denied\|failed-precondition\|not-found/.test(H));
}

/* ══ D. Server is the only authority on status ═══════════════════════════ */
console.log('\nD. No client-side VERIFIED\n');
{
  ck('status is read from the server response', /PD\.status\s*=\s*d\.status/.test(H));
  ck('activeDestination comes from the server', /PD\.active\s*=\s*d\.activeDestination/.test(H));
  ck('productionAuthorized comes from the server',
     /PD\.productionAuthorized\s*=\s*d\.productionAuthorized === true/.test(H));
  ck('the card never assigns VERIFIED itself',
     !/PD\.status\s*=\s*'VERIFIED'/.test(H) && !/status:\s*'VERIFIED'/.test(H));
  ck('save only STAGES — no local promotion to active',
     !/PD\.active\s*=\s*\{/.test(H));
}

/* ══ E. Replacement never displaces a working destination ════════════════ */
console.log('\nE. Existing destination keeps collecting during a change\n');
{
  ck('active destination is rendered as currently collecting',
     /Currently collecting/.test(H));
  ck('pending is labelled as not yet active', /Replacement — not yet active/.test(H));
  ck('  ...with the reassurance that the old one still collects',
     /keeps collecting until the new one is verified/.test(H));
}

/* ══ F. Daraja gate untouched ════════════════════════════════════════════ */
console.log('\nF. Daraja authorization gate respected\n');
{
  ck('test button disabled while productionAuthorized is false',
     /if \(!PD\.productionAuthorized\) \{[\s\S]{0,700}?Test payment — unavailable/.test(H));
  /* The phrase is split across a string concatenation in source, so match its
     two halves rather than the contiguous rendered sentence. */
  ck('  ...using the established wording',
     /awaiting payment-provider/.test(H) && /authorization before verification can be activated/.test(H));
  ck('  ...identical to the Business Setup wording',
     (() => {
       const other = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-store-ui.js'), 'utf8');
       return /Payment verification unavailable/.test(H) && /Payment verification unavailable/.test(other);
     })());
  ck('no new STK endpoint is called from this page',
     !/stkpush|initiateSTKPush|darajaSTKPush/i.test(H));
  ck('only the two existing destination callables are used',
     /CF\('getPaymentDestination'\)/.test(H) && /CF\('savePaymentDestination'\)/.test(H));
  ck('  ...and no other new callable was introduced',
     !/CF\('(confirmDestination|verifyDestination|markDestination)/.test(H));
}

/* ══ G. Both destination types ═══════════════════════════════════════════ */
console.log('\nG. Till and PayBill both supported\n');
{
  ck('Buy Goods Till option present', /data-v="TILL"/.test(H));
  ck('PayBill option present', /data-v="PAYBILL"/.test(H));
  ck('the field label follows the selected type',
     /PD\.draftType === 'PAYBILL' \? 'PayBill number' : 'Till number'/.test(H));
  ck('both render a human label on the saved card',
     /destinationType === 'PAYBILL' \? 'M-PESA PayBill' : 'M-PESA Till'/.test(H));
  ck('number validated as 5-7 digits before save is enabled',
     /\^\\d\{5,7\}\$/.test(H));
}

/* ══ H. Responsive + a11y properties that must hold ══════════════════════ */
console.log('\nH. Responsive and accessibility invariants\n');
{
  ck('inputs are 16px+ (below that iOS zooms on focus)',
     /\.pd-in\s*\{[\s\S]{0,320}?font-size:\s*16px/.test(H));
  ck('buttons meet the 44px minimum target', /\.pd-seg button\s*\{[\s\S]{0,220}?min-height:\s*44px/.test(H));
  ck('  ...and the primary actions are 48px', /\.pd-btn\s*\{[\s\S]{0,160}?min-height:\s*48px/.test(H));
  ck('type selector wraps rather than squeezing', /\.pd-seg\s*\{[\s\S]{0,120}?flex-wrap:\s*wrap/.test(H));
  ck('  ...with min-width:0 so long text cannot force overflow',
     /\.pd-seg button\s*\{[\s\S]{0,200}?min-width:\s*0/.test(H));
  ck('long account names wrap instead of overflowing',
     /\.pd-sub\s*\{[\s\S]{0,160}?overflow-wrap:\s*anywhere/.test(H));
  ck('inputs are border-box (no padding overflow)', /\.pd-in\s*\{[\s\S]{0,160}?box-sizing:\s*border-box/.test(H));
  ck('numbers use tabular figures', /\.pd-num\s*\{[\s\S]{0,200}?tabular-nums/.test(H));
  ck('focus is visible for keyboard users', /:focus-visible\s*\{[\s\S]{0,120}?outline:/.test(H));
  ck('type selector is a labelled radiogroup', /role="radiogroup" aria-label="Destination type"/.test(H));
  ck('  ...with aria-checked tracking the selection', /aria-checked="' \+ \(PD\.draftType === 'TILL'/.test(H));
  ck('disabled test button carries aria-disabled', /disabled aria-disabled="true"/.test(H));
  ck('desktop breakpoint lets the segments share the row', /@media \(min-width: 600px\)[\s\S]{0,80}?\.pd-seg button/.test(H));
}

/* ══ I. XSS — the page mandates esc() for dynamic HTML ═══════════════════ */
console.log('\nI. Output escaping\n');
{
  const card = H.slice(H.indexOf('function _pdDestCard'), H.indexOf('function _pdSyncReadyTile'));
  const interp = card.match(/'\s*\+\s*(?!esc\()[A-Za-z_][\w.]*\s*\+\s*'/g) || [];
  const suspicious = interp.filter(s => !/PD_TONE|PD_LABEL|st\b/.test(s));
  ck('every dynamic value in the card markup goes through esc()',
     suspicious.length === 0, suspicious.join(' ') || 'none unescaped');
  ck('destination number is escaped', /esc\(d\.destinationNumber/.test(H));
  ck('account name is escaped', /esc\(d\.accountName/.test(H));
  ck('server error text is escaped', /esc\(PD\.err\)/.test(H));
}

/* ══ J. Till approval acknowledgement ════════════════════════════════════
   Added after the destination card: an explicit approval that gates SAVE.
   It is an ACKNOWLEDGEMENT, not a commercial agreement — the 5% terms are
   accepted once via SokoniLegalGate, and a second agreement state would leave
   nobody able to say which is authoritative. */
console.log('\nJ. Till approval acknowledgement\n');
{
  ck('approval checkbox exists', /id="pd-approve"/.test(H));
  ck('  ...with the agreed wording',
     /I confirm this ' \+ esc\(typeWord\) \+ ' belongs to this business and approve it/.test(H));
  ck('  ...naming Till or PayBill, not a generic "destination"',
     /const typeWord = PD\.draftType === 'PAYBILL' \? 'PayBill' : 'Till';/.test(H));
  ck('  ...and states approval does NOT verify',
     /stays <strong>Awaiting verification<\/strong> until SOKONI verifies it/.test(H));

  /* Every path that decides the Save button's enabled-ness must require it.
     There are THREE and they are not written identically: the render path uses
     the pre-computed `numberOk`, while the two live-update handlers inline the
     regex. Counting only one spelling would leave a path unguarded and green. */
  const inlineForm = (H.match(/PD\.draftName\.trim\(\)\.length > 0 && PD\.approved/g) || []).length;
  const renderForm = (H.match(/const canSave = numberOk && PD\.approved && !PD\.busy;/g) || []).length;
  const unguarded  = (H.match(/PD\.draftName\.trim\(\)\.length > 0 && !PD\.busy/g) || []).length
                   + (H.match(/const canSave = numberOk && !PD\.busy;/g) || []).length;
  ck('ALL THREE save-enable paths require approval',
     inlineForm === 2 && renderForm === 1 && unguarded === 0,
     inlineForm + ' inline + ' + renderForm + ' render, ' + unguarded + ' unguarded');

  ck('approval is withdrawn when Till/PayBill type changes',
     /PD\.draftType = el\.getAttribute\('data-v'\)[\s\S]{0,120}?PD\.approved = false;/.test(H));
  ck('approval is consumed by a successful save',
     /PD\.busy = false;\s*\n\s*PD\.approved = false;\s*\n\s*await renderPaymentDestination\(\);/.test(H));
  ck('no second 5% agreement was introduced',
     !/agreementAccepted|agreementVersion|5% per-sale commission\.<\/span>/.test(H));
  ck('SokoniLegalGate left exactly as it was',
     /window\.SokoniLegalGate\.mount\(wrap, \{\s*\n\s*role: 'merchant',/.test(H));
}

/* ══ K. Open POS requires BOTH conditions ════════════════════════════════ */
console.log('\nK. Open POS gate\n');
{
  ck('gate requires legal acceptance AND a saved destination',
     /const ok = _legalOk && _destinationSaved;/.test(H));
  ck('  ...and the click handler blocks on the destination too',
     /if \(!_destinationSaved\) \{[\s\S]{0,220}?scrollIntoView/.test(H));
  ck('  ...pointing at the payment card, not the legal gate',
     /if \(!_destinationSaved\)[\s\S]{0,200}?getElementById\('pd-card-wrap'\)/.test(H));

  /* THE ASSERTION THAT MATTERS: the gate is server-derived. A checkbox that
     could unlock the POS would be a client-side authority over setup state. */
  ck('_destinationSaved comes from the SERVER response, never the checkbox',
     /_destinationSaved = !!\(PD\.active \|\| PD\.pending\);/.test(H));
  ck('  ...and PD.approved never feeds the Open POS gate',
     !/_destinationSaved\s*=\s*PD\.approved/.test(H)
     && !/_legalOk && PD\.approved/.test(H));

  /* Fail-open: a cashier cannot READ paymentDestinations (owner/admin only),
     so gating on it would lock every till operator out of the POS. */
  const failOpen = (H.match(/_destinationSaved = true;/g) || []).length;
  ck('fails OPEN for non-owner and read failure (staff not locked out)', failOpen === 2,
     failOpen + ' fail-open branches (expect 2: permission-denied, business mismatch)');
}

/* ══ L. The security boundary is unchanged ═══════════════════════════════ */
console.log('\nL. Approval grants nothing\n');
{
  ck('the checkbox never sets VERIFIED', !/PD\.approved[\s\S]{0,120}?VERIFIED/.test(H));
  ck('the checkbox never sets productionAuthorized',
     !/PD\.approved[\s\S]{0,120}?productionAuthorized\s*=/.test(H));
  ck('save still only STAGES via savePaymentDestination',
     /CF\('savePaymentDestination'\)/.test(H) && !/CF\('confirmVerified'\)/.test(H));
  ck('PENDING_TEST / Awaiting verification semantics preserved',
     /PENDING_TEST: 'Awaiting verification'/.test(H));
  ck('Daraja gate wording untouched', /awaiting payment-provider/.test(H));
}

/* ══ M. Responsive/a11y for the new control ══════════════════════════════ */
console.log('\nM. Approval control — responsive and accessible\n');
{
  ck('approval row meets the 44px target', /\.pd-approve \{[\s\S]{0,260}?min-height: 44px;/.test(H));
  ck('checkbox itself is 20px with its own hit area',
     /\.pd-approve input\[type="checkbox"\] \{[\s\S]{0,120}?width: 20px; height: 20px;/.test(H));
  ck('label text wraps instead of overflowing',
     /\.pd-approve span \{ min-width: 0; overflow-wrap: anywhere; \}/.test(H));
  ck('focus is visible on the checkbox', /\.pd-approve input:focus-visible/.test(H));
  ck('checked state is visually distinct', /\.pd-approve:has\(input:checked\)/.test(H));
  ck('label is bound to the input', /<label class="pd-approve" for="pd-approve">/.test(H));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
