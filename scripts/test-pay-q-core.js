#!/usr/bin/env node
/* SOKONI Till payment page — client-side pure-core certification (Q8).
 *
 * No DOM, no Firebase, no network, no browser — certifies
 * sokoni-pay-q-core.js directly, the same pure-core methodology as every
 * other slice in this programme (Q5-Q7). The one thing this file MUST
 * prove is stated in the source's own header: for a dynamic QR, the amount
 * sent to initiateSTKPush is always the server-resolved figure, never a
 * buyer-typed one — proven here by construction, not by inspection.
 *
 * Carries its own negative control and a sabotage control, per this
 * session's standing rule.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const Core = require('../sokoni-pay-q-core.js');

let pass = 0, fail = 0;
function ok(label, cond, note) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}

console.log('');
console.log('  SOKONI TILL PAYMENT PAGE (Q8) — client-side pure core certification');
console.log('');

/* ── 1. Token parsing ──────────────────────────────────────────────────── */
console.log('  -- token parsing (/pay/q/{token}) --');
{
  ok('parses a normal token', Core.parseToken('/pay/q/intent.SKNABC123.abcdef0123456789abcdef0123456789') === 'intent.SKNABC123.abcdef0123456789abcdef0123456789');
  ok('parses a till token', Core.parseToken('/pay/q/till.SK-KASSAB12-0001.' + 'a'.repeat(32)) === 'till.SK-KASSAB12-0001.' + 'a'.repeat(32));
  ok('trailing slash does not swallow the token', Core.parseToken('/pay/q/abc123/') === 'abc123');
  ok('no token segment -> null', Core.parseToken('/pay/q/') === null);
  ok('unrelated path -> null', Core.parseToken('/pay.html') === null);
  ok('empty path -> null', Core.parseToken('') === null);
  ok('null path -> null', Core.parseToken(null) === null);
}

/* ── 2. Phone validation/normalisation ────────────────────────────────── */
console.log('  -- phone validation --');
{
  ok('254 format accepted verbatim', Core.validPhone('254712345678') === '254712345678');
  ok('0-prefixed format normalised to 254', Core.validPhone('0712345678') === '254712345678');
  ok('spaces are stripped', Core.validPhone('0712 345 678') === '254712345678');
  ok('landline-shaped (0-prefixed but wrong carrier digit) is rejected', Core.validPhone('0212345678') === null);
  ok('too short is rejected', Core.validPhone('071234') === null);
  ok('non-numeric is rejected', Core.validPhone('not-a-phone') === null);
  ok('empty is rejected', Core.validPhone('') === null);
  ok('null is rejected', Core.validPhone(null) === null);
}

/* ── 3. THE invariant: dynamic-QR amount is NEVER the buyer's input ─────── */
console.log('  -- decidePaymentAction: dynamic QR amount is server-only, by construction --');
{
  const resolved = { type: 'intent', ref: 'SKNABC123', amount: 500, currency: 'KES', status: 'created', shopName: 'Kass Traders' };

  const normal = Core.decidePaymentAction({ resolved, rawAmountInput: '' });
  ok('normal case: mode is use_existing', normal.ok === true && normal.mode === 'use_existing');
  ok('normal case: amount is exactly the resolved (server) amount', normal.amount === 500);
  ok('normal case: ref is exactly the resolved (server) ref', normal.ref === 'SKNABC123');

  /* The DOM does not even expose an amount field for the dynamic-QR case
     (pay-q.html hides #amountInputWrap), but prove the DECISION LOGIC
     itself ignores a hostile value even if one were somehow supplied —
     defence in depth, not reliance on the DOM being correctly wired. */
  const tampered = Core.decidePaymentAction({ resolved, rawAmountInput: '1' });
  ok('TAMPERED rawAmountInput ("1") is completely ignored for an intent-type resolve', tampered.amount === 500);
  const tamperedHuge = Core.decidePaymentAction({ resolved, rawAmountInput: '999999999' });
  ok('TAMPERED rawAmountInput (huge) is completely ignored for an intent-type resolve', tamperedHuge.amount === 500);

  const alreadyPaid = Core.decidePaymentAction({ resolved: { ...resolved, status: 'paid' }, rawAmountInput: '' });
  ok('already-paid intent -> refused, not re-payable from this page', alreadyPaid.ok === false);

  const noRef = Core.decidePaymentAction({ resolved: { ...resolved, ref: null }, rawAmountInput: '' });
  ok('intent resolve missing its own ref -> refused', noRef.ok === false);

  const noAmount = Core.decidePaymentAction({ resolved: { ...resolved, amount: 0 }, rawAmountInput: '' });
  ok('intent resolve with a zero amount -> refused (not silently paid for KES 0)', noAmount.ok === false);
}

/* ── 4. Permanent-Till flow: buyer's amount is only a SEED for create_intent ── */
console.log('  -- decidePaymentAction: permanent Till, buyer amount seeds createPaymentIntent only --');
{
  const resolved = { type: 'till', sokoniTillId: 'SK-KASSAB12-0001', currency: 'KES', shopName: 'Kass Traders' };

  const ok1 = Core.decidePaymentAction({ resolved, rawAmountInput: '250' });
  ok('valid buyer amount -> mode create_intent, seeded with that amount', ok1.ok === true && ok1.mode === 'create_intent' && ok1.amount === 250);
  ok('sokoniTillId carried through from the resolved Till, not re-derived', ok1.sokoniTillId === 'SK-KASSAB12-0001');

  ok('zero amount -> refused', Core.decidePaymentAction({ resolved, rawAmountInput: '0' }).ok === false);
  ok('negative amount -> refused', Core.decidePaymentAction({ resolved, rawAmountInput: '-50' }).ok === false);
  ok('non-numeric amount -> refused', Core.decidePaymentAction({ resolved, rawAmountInput: 'abc' }).ok === false);
  ok('empty amount -> refused', Core.decidePaymentAction({ resolved, rawAmountInput: '' }).ok === false);

  const noTill = Core.decidePaymentAction({ resolved: { ...resolved, sokoniTillId: null }, rawAmountInput: '100' });
  ok('resolved Till with no sokoniTillId -> refused', noTill.ok === false);
}

/* ── 5. Unresolved / malformed resolve object -> always refused ─────────── */
console.log('  -- decidePaymentAction: no valid resolve -> always refused --');
{
  ok('resolved:null -> refused', Core.decidePaymentAction({ resolved: null, rawAmountInput: '100' }).ok === false);
  ok('unknown type -> refused', Core.decidePaymentAction({ resolved: { type: 'bogus' }, rawAmountInput: '100' }).ok === false);
}

/* ── 6. buildStkRequest — the actual initiateSTKPush payload shape ──────── */
console.log('  -- buildStkRequest --');
{
  const r = Core.buildStkRequest({ phone: '0712345678', ref: 'SKNABC123', amount: 500 });
  ok('valid inputs -> ok, phone normalised', r.ok === true && r.request.phone === '254712345678');
  ok('ref/amount passed through verbatim', r.request.ref === 'SKNABC123' && r.request.amount === 500);

  ok('invalid phone -> refused', Core.buildStkRequest({ phone: 'x', ref: 'SKNABC123', amount: 500 }).ok === false);
  ok('missing ref -> refused', Core.buildStkRequest({ phone: '0712345678', ref: null, amount: 500 }).ok === false);
  ok('zero amount -> refused', Core.buildStkRequest({ phone: '0712345678', ref: 'SKNABC123', amount: 0 }).ok === false);
}

/* ── 7. fmt — display formatting only, never used for money decisions ──── */
console.log('  -- fmt (display only) --');
{
  ok('formats with currency', Core.fmt(500, 'KES').indexOf('KES') === 0);
  ok('defaults to KES when currency omitted', Core.fmt(500).indexOf('KES') === 0);
  ok('formats zero without throwing', typeof Core.fmt(0, 'KES') === 'string');
}

/* ── NEGATIVE CONTROL ───────────────────────────────────────────────────── */
console.log('  -- negative control (must fail; proves the harness can detect failure) --');
{
  const before = fail;
  ok('deliberately false assertion', 1 === 2);
  ok('control recorded exactly one failure', fail === before + 1);
  fail--;
}

/* ── SABOTAGE CONTROL — the amount-tamper floor for dynamic QR ─────────── */
console.log('  -- sabotage control (letting rawAmountInput leak into the intent case must be CAUGHT) --');
{
  const realSrc = fs.readFileSync(path.join(__dirname, '..', 'sokoni-pay-q-core.js'), 'utf8');

  const sabotagedSrc = realSrc.replace(
    "/* rawAmountInput is intentionally NOT consulted here — see file header. */\n      return { ok: true, mode: 'use_existing', ref: resolved.ref, amount: amt };",
    "return { ok: true, mode: 'use_existing', ref: resolved.ref, amount: (Number(rawAmountInput) > 0 ? Number(rawAmountInput) : amt) }; // SABOTAGED"
  );
  if (sabotagedSrc === realSrc) {
    throw new Error('SABOTAGE CONTROL SETUP FAILED — the line to weaken was not found; ' +
      'the control cannot prove anything and the run must be blocked.');
  }

  const tmpFile = path.join(os.tmpdir(), `sokoni-pay-q-core.sabotaged.${process.pid}.js`);
  fs.writeFileSync(tmpFile, sabotagedSrc);
  let sabotaged;
  try {
    sabotaged = require(tmpFile);

    const resolved = { type: 'intent', ref: 'SKNABC123', amount: 500, currency: 'KES', status: 'created' };
    const sabotagedResult = sabotaged.decidePaymentAction({ resolved, rawAmountInput: '1' });
    ok('SABOTAGE: weakened code WRONGLY lets a tampered rawAmountInput override the server amount',
      sabotagedResult.amount === 1);

    const realResult = Core.decidePaymentAction({ resolved, rawAmountInput: '1' });
    ok('control: the REAL (unmodified) module still ignores it, amount stays 500',
      realResult.amount === 500);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* best-effort cleanup */ }
  }
}

/* ── Summary ────────────────────────────────────────────────────────────── */
console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');

if (fail > 0) {
  console.log('  BLOCKED — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('  CERTIFIED — Q8 client-side pure core (sokoni-pay-q-core.js).');
  process.exit(0);
}
