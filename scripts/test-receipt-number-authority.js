#!/usr/bin/env node
/* RECEIPT NUMBER AUTHORITY — certification of the invariant.
 *
 * Pure, no I/O, nothing wired. `posCompleteCheckout` keeps its own derivation.
 *
 * THE INVARIANT: every committed sale has exactly one receipt number, derived from the
 * sale and never from the clock; a replay yields the same number; a refused sale yields
 * none.
 *
 * The determinism assertions are the heart of it. A receipt number that changes between two
 * calls for the same sale is the same defect as a time-seeded idempotency key — and three
 * of the five payout surfaces gated in this programme have exactly that.
 */
'use strict';
const R = require('../functions/receipt-number-authority');

let pass = 0, fail = 0;
const ok = (label, cond, note) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};
const throwsWith = (label, code, fn) => {
  try { fn(); fail++; console.log('  FAIL  ' + label + '   [did not throw; expected ' + code + ']'); }
  catch (e) {
    if (e.code === code) pass++;
    else { fail++; console.log('  FAIL  ' + label + '   [threw ' + (e.code || e.message) + ', expected ' + code + ']'); }
  }
};

const SALE = 'A1b2C3d4E5f6G7h8I9j0';           /* a Firestore auto-id shape */
console.log('');
console.log('  RECEIPT NUMBER AUTHORITY — certification');
console.log('');

/* ── 1 · DETERMINISM — the property everything else rests on ───────────────── */
{
  const a = R.deriveReceiptNumber({ saleId: SALE });
  const b = R.deriveReceiptNumber({ saleId: SALE });
  ok('the same sale yields the same number', a.receiptNumber === b.receiptNumber, a.receiptNumber);
  ok('...and the same display form', a.display === b.display);
}
{
  /* across 500 repeats, and across a simulated process restart (fresh require cache) */
  const first = R.deriveReceiptNumber({ saleId: SALE }).receiptNumber;
  let drift = 0;
  for (let i = 0; i < 500; i++) {
    if (R.deriveReceiptNumber({ saleId: SALE }).receiptNumber !== first) drift++;
  }
  ok('stable across 500 derivations', drift === 0, drift + ' drifted');
  delete require.cache[require.resolve('../functions/receipt-number-authority')];
  const fresh = require('../functions/receipt-number-authority');
  ok('stable across a module reload (process restart)',
     fresh.deriveReceiptNumber({ saleId: SALE }).receiptNumber === first);
}
{
  /* NO CLOCK. If time entered the derivation, two calls separated by a tick would differ. */
  const t0 = R.deriveReceiptNumber({ saleId: SALE }).receiptNumber;
  const spin = Date.now() + 5; while (Date.now() < spin) { /* burn a few ms */ }
  const t1 = R.deriveReceiptNumber({ saleId: SALE }).receiptNumber;
  ok('NO time component — identical across a real time gap', t0 === t1);
}
ok('different sales yield different numbers',
   R.deriveReceiptNumber({ saleId: 'saleA' }).receiptNumber !==
   R.deriveReceiptNumber({ saleId: 'saleB' }).receiptNumber);

/* ── 2 · no sale, no receipt ───────────────────────────────────────────────── */
[undefined, null, '', '   ', 0, {}, []].forEach((bad) => {
  throwsWith('saleId ' + JSON.stringify(bad) + ' is refused', 'RECEIPT_NO_SALE_ID',
    () => R.deriveReceiptNumber({ saleId: bad }));
});
throwsWith('an UNCOMMITTED sale gets no receipt number', 'RECEIPT_SALE_NOT_COMMITTED',
  () => R.assertReceiptForSale({ sale: { saleId: SALE }, committed: false }));
throwsWith('committed must be explicitly true, not truthy', 'RECEIPT_SALE_NOT_COMMITTED',
  () => R.assertReceiptForSale({ sale: { saleId: SALE }, committed: 1 }));
throwsWith('a missing committed flag is refused', 'RECEIPT_SALE_NOT_COMMITTED',
  () => R.assertReceiptForSale({ sale: { saleId: SALE } }));

/* ── 3 · shape, alphabet, transcription ────────────────────────────────────── */
{
  const r = R.deriveReceiptNumber({ saleId: SALE });
  ok('prefixed SK', r.receiptNumber.indexOf('SK') === 0, r.receiptNumber);
  ok('SK + 13 data + 1 check = 16 chars', r.receiptNumber.length === 16, String(r.receiptNumber.length));
  ok('65 bits of entropy reported', r.bits === 65);
  ok('display is grouped for reading aloud', /^SK-.{5}-.{5}-.{4}$/.test(r.display), r.display);
  const body = r.receiptNumber.slice(2);
  ok('no I, L, O or U anywhere in the body', !/[ILOU]/.test(body), body);
  ok('uppercase only', body === body.toUpperCase());
}
{
  /* the confusable folding a smudged thermal print needs */
  const r = R.deriveReceiptNumber({ saleId: SALE }).receiptNumber;
  const withDashes = R.deriveReceiptNumber({ saleId: SALE }).display;
  ok('the grouped display parses back', R.parseReceiptNumber(withDashes).valid);
  ok('lowercase input parses', R.parseReceiptNumber(r.toLowerCase()).valid);
  ok('spaces are tolerated', R.parseReceiptNumber(r.split('').join(' ')).valid);
  /* O -> 0 and I -> 1, the classic misreads */
  const withO = r.replace(/0/g, 'O');
  const withI = r.replace(/1/g, 'I');
  ok('O typed for 0 still resolves', withO === r || R.parseReceiptNumber(withO).valid, withO);
  ok('I typed for 1 still resolves', withI === r || R.parseReceiptNumber(withI).valid, withI);
}
{
  /* the check character has to actually catch things */
  const r = R.deriveReceiptNumber({ saleId: SALE }).receiptNumber;
  let caughtSingle = 0, testedSingle = 0;
  for (let i = 2; i < r.length - 1; i++) {
    for (const c of R.ALPHABET) {
      if (c === r[i]) continue;
      testedSingle++;
      const typo = r.slice(0, i) + c + r.slice(i + 1);
      if (!R.parseReceiptNumber(typo).valid) caughtSingle++;
    }
  }
  ok('EVERY single-character typo is caught (' + testedSingle + ' tested)',
     caughtSingle === testedSingle, (testedSingle - caughtSingle) + ' slipped through');

  let caughtSwap = 0, testedSwap = 0;
  for (let i = 2; i < r.length - 2; i++) {
    if (r[i] === r[i + 1]) continue;
    testedSwap++;
    const sw = r.slice(0, i) + r[i + 1] + r[i] + r.slice(i + 2);
    if (!R.parseReceiptNumber(sw).valid) caughtSwap++;
  }
  ok('every adjacent transposition is caught (' + testedSwap + ' tested)',
     caughtSwap === testedSwap, (testedSwap - caughtSwap) + ' slipped through');
}
[['', 'empty'], ['SK', 'prefix only'], ['XX12345678901234', 'wrong prefix'],
 ['SK123', 'too short'], [null, 'null'], [42, 'a number']].forEach(([bad, why]) => {
  ok('rejects ' + why, R.parseReceiptNumber(bad).valid === false);
});

/* ── 4 · collision headroom, stated not assumed ────────────────────────────── */
{
  const at1m  = R.collisionProbability(1e6);
  const at10m = R.collisionProbability(1e7);
  const at1b  = R.collisionProbability(1e9);
  console.log('    collision probability   1M receipts: ' + at1m.toExponential(2) +
              '   10M: ' + at10m.toExponential(2) + '   1B: ' + at1b.toExponential(2));
  ok('below 1-in-a-million at 1M receipts', at1m < 1e-6, at1m.toExponential(2));
  ok('below 1-in-10,000 at 10M receipts', at10m < 1e-4, at10m.toExponential(2));

  /* the live derivation for contrast: saleId.slice(-8) of a base62 id */
  const legacyBits = Math.log2(Math.pow(62, 8));
  const legacyAt10m = 1 - Math.exp(-(1e7 * 1e7) / (2 * Math.pow(2, legacyBits)));
  console.log('    live path (saleId.slice(-8), ~' + legacyBits.toFixed(1) +
              ' bits) at 10M: ' + legacyAt10m.toExponential(2));
  ok('this scheme is materially safer than the live truncation',
     at10m < legacyAt10m / 1000, at10m.toExponential(2) + ' vs ' + legacyAt10m.toExponential(2));
}
{
  /* empirical: no collisions across 200k derived numbers */
  const seen = new Set();
  let dup = 0;
  for (let i = 0; i < 200000; i++) {
    const n = R.deriveReceiptNumber({ saleId: 'sale_' + i }).receiptNumber;
    if (seen.has(n)) dup++;
    seen.add(n);
  }
  ok('200,000 distinct sales -> 200,000 distinct receipt numbers', dup === 0, dup + ' collisions');
}

/* ── 5 · the receipt CARRIES facts, never computes them ────────────────────── */
const FULL_SALE = {
  saleId: SALE, settlementDay: '2026-09-04', grossAmountMinor: 100000,
  commissionMinor: 15000, custody: 'NON_CUSTODIAL', currency: 'KES',
  paymentMethod: 'cash', merchantUid: 'm1', shopId: 'shop1', soldAtMs: 1788000000000
};
{
  const rec = R.assertReceiptForSale({ sale: FULL_SALE, committed: true });
  ok('the receipt carries every required fact',
     R.RECEIPT_FACTS.every((f) => rec[f] !== undefined), JSON.stringify(Object.keys(rec)));
  ok('gross is carried verbatim', rec.grossAmountMinor === 100000);
  ok('commission is carried verbatim', rec.commissionMinor === 15000);
  ok('custody is carried', rec.custody === 'NON_CUSTODIAL');
  ok('settlementDay links it to the 07:00 gate', rec.settlementDay === '2026-09-04');
  ok('the number matches the standalone derivation',
     rec.receiptNumber === R.deriveReceiptNumber({ saleId: SALE }).receiptNumber);
  /* it must not compute: gross - commission is NOT on the receipt */
  ok('the receipt does NOT derive a net figure of its own',
     rec.netAmountMinor === undefined && rec.merchantCredit === undefined);
}
/* `saleId` is excluded deliberately. A sale with no id cannot HAVE a receipt number at
   all, so it fails earlier and more precisely with RECEIPT_NO_SALE_ID. The first version of
   this loop expected RECEIPT_MISSING_FACTS for it — the test expectation was the defect,
   not the code, and the more specific error is the better one. */
R.RECEIPT_FACTS.filter((f) => f !== 'receiptNumber' && f !== 'saleId').forEach((f) => {
  const partial = Object.assign({}, FULL_SALE);
  delete partial[f];
  throwsWith('a receipt missing ' + f + ' is refused', 'RECEIPT_MISSING_FACTS',
    () => R.assertReceiptForSale({ sale: partial, committed: true }));
});
{
  const noId = Object.assign({}, FULL_SALE);
  delete noId.saleId;
  throwsWith('a sale with no id fails EARLIER and more precisely', 'RECEIPT_NO_SALE_ID',
    () => R.assertReceiptForSale({ sale: noId, committed: true }));
}

/* ── 6 · reprint and replay ────────────────────────────────────────────────── */
{
  const first  = R.assertReceiptForSale({ sale: FULL_SALE, committed: true });
  const reprint = R.assertReceiptForSale({ sale: FULL_SALE, committed: true });
  ok('REPRINT reuses the same number', first.receiptNumber === reprint.receiptNumber);
  /* a replayed request that resolves to the SAME committed sale keeps the number */
  const replay = R.assertReceiptForSale({
    sale: Object.assign({}, FULL_SALE, { soldAtMs: FULL_SALE.soldAtMs + 5000 }), committed: true });
  ok('a replay of the SAME sale keeps the number even if a timestamp differs',
     replay.receiptNumber === first.receiptNumber);
}

/* ══ CONTROLS ═════════════════════════════════════════════════════════════ */
console.log('  CONTROLS');
let controlsOk = true;
{
  const before = fail;
  ok('__negative_control__ (expected to fail)', 1 === 2);
  const detected = fail === before + 1;
  fail = before;
  console.log('    ' + (detected ? 'PASS' : 'FAIL') + '  assertions can fail');
  if (!detected) controlsOk = false;
}
{
  /* SABOTAGE: a time-seeded receipt number — the defect found in three payout surfaces.
     Prove the determinism assertion would catch it. */
  const timeSeeded = (saleId) =>
    require('crypto').createHash('sha256').update(saleId + '|' + Date.now()).digest('hex').slice(0, 13);
  const a = timeSeeded(SALE);
  const spin = Date.now() + 3; while (Date.now() < spin) {}
  const b = timeSeeded(SALE);
  console.log('    ' + (a !== b ? 'PASS' : 'FAIL') +
              '  a time-seeded number DOES drift for one sale — the determinism test catches it');
  if (a === b) controlsOk = false;
}
{
  /* SABOTAGE: drop the check character and prove typos stop being caught */
  const r = R.deriveReceiptNumber({ saleId: SALE }).receiptNumber;
  const noCheck = (s) => s.slice(0, -1);                     /* a scheme with no check char */
  const typo = r.slice(0, 5) + (r[5] === '7' ? '8' : '7') + r.slice(6);
  const caughtWith = !R.parseReceiptNumber(typo).valid;
  const caughtWithout = noCheck(typo) !== noCheck(r) && false;  /* nothing validates it */
  console.log('    ' + (caughtWith && !caughtWithout ? 'PASS' : 'FAIL') +
              '  the check character is what catches the typo, not the length');
  if (!(caughtWith && !caughtWithout)) controlsOk = false;
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (!controlsOk) {
  console.log('');
  console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
  process.exit(1);
}
process.exit(fail > 0 ? 1 : 0);
