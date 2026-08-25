#!/usr/bin/env node
/* Commission & Penalties merchant surface.
 *
 * THE ONE THING THIS SUITE EXISTS TO PROVE: the browser is not an authority on
 * money. Not on the balance, not on the penalty, not on whether the account is
 * restricted, and not on whether anything has been paid.
 *
 * The trap it is built to catch is a surface that "helpfully" sums the line
 * items to produce a total. That looks correct in every demo and then disagrees
 * with commissionLedger the first time a row is settled, waived, or paginated
 * away — and the merchant is looking at a number nobody will ever bill them.
 * So the suite asserts the total is RENDERED FROM THE SERVER FIELD, and carries
 * a negative control proving the detector would catch a client-side sum.
 *
 * A second trap: an unknown figure rendered as 0. "You owe nothing" is a very
 * specific and very wrong thing to tell a merchant who owes money.
 *
 *   node scripts/test-commission-balance-ui.js
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
const UI   = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-store-ui.js'), 'utf8');
const V2   = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const CCOL = fs.readFileSync(path.join(ROOT, 'functions', 'commission-collection.js'), 'utf8');

/* ══ A. The browser is not an authority on money ══════════════════════════ */
console.log('\nA. No client-side financial authority\n');
{
  ck('total is rendered from the SERVER field, not summed locally',
     /money\(CB\.totalOutstanding\)/.test(UI));
  ck('commission is rendered from the server field', /money\(CB\.commissionKES\)/.test(UI));
  ck('penalty is rendered from the server field', /money\(CB\.penaltyKES\)/.test(UI));

  /* The detector: no reduce/loop that accumulates a money field into a total. */
  const sums = /\.reduce\(\s*function\s*\([^)]*\)\s*\{[^}]*(commissionKES|penaltyKES|totalOutstanding)[^}]*\+/.test(UI)
            || /(total|sum)\s*\+=\s*[^;]*(commissionKES|penaltyKES)/.test(UI);
  ck('no local accumulation of a money field into a total', !sums);
  /* Negative control — the detector must be able to see a client-side sum. */
  const planted = 'var total = 0; items.forEach(function(i){ total += i.commissionKES; });';
  ck('  negative control: detector DOES flag a client-side sum',
     /(total|sum)\s*\+=\s*[^;]*(commissionKES|penaltyKES)/.test(planted));

  ck('restriction comes from the server response, not computed here',
     /CB\.restricted\s*=\s*d\.restricted === true/.test(UI));
  ck('  ...and no local overdue calculation drives it',
     !/Date\.now\(\)\s*>\s*[^;]*dueAt[\s\S]{0,80}restricted\s*=/.test(UI));
  ck('the surface never writes a payment/settlement state',
     !/collectionStatus\s*[:=]\s*['"]PAID/.test(UI));
}

/* ══ B. Unknown is not zero ══════════════════════════════════════════════ */
console.log('\nB. Unknown figures render as —, never 0\n');
{
  ck('server figures are captured as null when absent, not defaulted to 0',
     /typeof d\.commissionKES === 'number'\) \? d\.commissionKES : null/.test(UI));
  ck('  ...same for penalty', /typeof d\.penaltyKES === 'number'\) \? d\.penaltyKES : null/.test(UI));
  ck('  ...same for the total', /typeof d\.totalOutstanding === 'number'\) \? d\.totalOutstanding : null/.test(UI));
  ck('money() renders a non-number as an em dash',
     /if \(typeof n !== 'number' \|\| !isFinite\(n\)\) return '—';/.test(UI));
  ck('no `|| 0` fallback on a money field',
     !/(commissionKES|penaltyKES|totalOutstanding)\s*\|\|\s*0/.test(UI));
  ck('"Nothing outstanding" requires an explicit server zero, not absence',
     /CB\.totalOutstanding === 0/.test(UI));
}

/* ══ C. Itemised sales ═══════════════════════════════════════════════════ */
console.log('\nC. Itemised sales\n');
{
  ck('each row shows its sale reference', /esc\(i\.reference \|\| i\.id \|\| '—'\)/.test(UI));
  ck('each row shows its own commission', /esc\(money\(i\.commissionKES\)\)/.test(UI));
  ck('each row shows its own penalty when there is one', /i\.penaltyKES \?/.test(UI));
  ck('each row shows its due time', /esc\(when\(i\.dueAt\)\)/.test(UI));
  ck('each row shows its lifecycle state', /CB_LABEL\[i\.status\]/.test(UI));
  ck('all five states are labelled',
     /DUE: 'Due'[\s\S]{0,140}REMINDED[\s\S]{0,60}OVERDUE[\s\S]{0,60}PAID[\s\S]{0,60}WAIVED/.test(UI));
  ck('settled rows are excluded from the outstanding list',
     /i\.status !== 'PAID' && i\.status !== 'WAIVED'/.test(UI));
  ck('a truncated list SAYS it was truncated (no silent cap)',
     /more not shown/.test(UI) && /open\.length > 50/.test(UI));
  ck('the deadline shown is the OLDEST due — the one that expires first',
     /b\.dueAt < a\.dueAt \? b : a/.test(UI));
}

/* ══ D. Payment is gated on the backend, not on the UI ═══════════════════ */
console.log('\nD. Payment availability follows the backend gate\n');
{
  ck('pay button is gated on productionAuthorized',
     /if \(!PD\.productionAuthorized\) \{[\s\S]{0,700}?Pay outstanding balance — unavailable/.test(UI));
  ck('  ...and is genuinely disabled, not just styled',
     /disabled aria-disabled="true"[\s\S]{0,140}?Pay outstanding balance — unavailable/.test(UI));
  ck('  ...with an honest reason rather than "coming soon"',
     /awaiting payment-provider authorization/.test(UI));
  ck('no STK is initiated from this surface', !/stkpush|initiateSTK|darajaSTKPush/i.test(UI));
  ck('the balance callable is READ-only — no settle/clear callable is wired',
     /callCommissionBalance/.test(V2) && !/callSettleCommission|callClearRestriction/.test(V2));
}

/* ══ E. The gate clears only on server-confirmed settlement ══════════════ */
console.log('\nE. Restriction clearance authority (server side)\n');
{
  ck('settlement is not callable from a browser',
     !/exports\.settleConfirmedPayment\s*=\s*onCall/.test(CCOL));
  ck('restriction lifts only when nothing is outstanding',
     /if \(stillOwed === 0\) \{[\s\S]{0,300}?restricted: false/.test(CCOL));
  ck('a partial payment leaves the row open and the gate closed',
     /partialPaidKES: admin\.firestore\.FieldValue\.increment\(remaining\)/.test(CCOL));
  ck('the premium gate reads server restriction state',
     /getSellerRestriction/.test(V2) && /d\.restricted === true/.test(V2));
  ck('the gate cannot be cleared by the page itself',
     !/skCommissionGate[\s\S]{0,600}?\.remove\(\)/.test(V2));
}

/* ══ F. Layout containment ══════════════════════════════════════════════ */
console.log('\nF. Layout\n');
{
  ck('the balance box renders INSIDE .mst-body (so it inherits the max-width)',
     /return h \+ balanceHTML\(\) \+ '<\/div>';/.test(UI));
  ck('  ...and not appended after the body closes',
     !/return h \+ '<\/div>' \+ balanceHTML\(\);/.test(UI));
  ck('money cells can wrap rather than overflow', /\.mst-cb-cell \.v\{[^}]*overflow-wrap:anywhere/.test(UI));
  ck('the grid has a min() floor so cells cannot be squeezed',
     /\.mst-cb-grid\{[^}]*minmax\(min\(150px,100%\),1fr\)/.test(UI));
  ck('the itemised list restacks below 360px instead of scrolling sideways',
     /@media \(max-width:359px\)/.test(UI));
  ck('amounts use tabular figures so columns do not jitter',
     /\.mst-cb-tr \.amt\{[\s\S]{0,140}?font-variant-numeric:tabular-nums/.test(UI));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
