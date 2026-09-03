#!/usr/bin/env node
/* SOKONI TILL/QR — Q5 certification of the pure core.
 *
 * No Firestore, no network, no deployment, no emulator — certifies
 * functions/sokoni-qr-authority.js directly, the same methodology
 * scripts/test-money-authority.js already uses for functions/money-authority.js.
 * The onCall layer (functions/sokoni-till.js) is I/O-only around this core, so
 * certifying the core certifies every decision that matters: token forgery,
 * Till lifecycle gating, intent-resolution state, and — the highest-stakes
 * property in the whole Q5 slice — that a hostile client can never make the
 * server attribute a sale to a merchant/shop/branch other than the one the
 * Till or intent itself carries.
 *
 * IT CARRIES ITS OWN CONTROLS, per this session's standing rule:
 *   - a NEGATIVE control that must itself fail (proves the harness can fail)
 *   - a SABOTAGE control: the "client-altered merchant" checks are re-run
 *     against a deliberately-weakened COPY of the source (the merchantUid
 *     authorization check removed) and MUST be caught failing there — proving
 *     these specific assertions would have caught the vulnerability if it
 *     existed, not merely that they pass against correct code today.
 * If either misbehaves the run is BLOCKED, regardless of how many tests passed.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const QA = require('../functions/sokoni-qr-authority');

let pass = 0, fail = 0;
const failures = [];

function ok(label, cond, note) {
  if (cond) { pass++; }
  else { fail++; failures.push(label + (note ? '   [' + note + ']' : '')); console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}

/** assert that `fn` throws, and with the expected code — a throw for the
    wrong reason is a failure, not a pass. */
function throwsWith(label, code, fn) {
  try { fn(); ok(label, false, 'did not throw; expected ' + code); }
  catch (e) { ok(label, e.code === code, e.code ? ('threw ' + e.code + ', expected ' + code) : 'threw without a .code'); }
}

function doesNotThrow(label, fn) {
  try { fn(); ok(label, true); }
  catch (e) { ok(label, false, 'threw ' + (e.code || e.message)); }
}

console.log('');
console.log('  SOKONI TILL/QR (Q5) — pure core certification');
console.log('');

const SECRET = 'test-secret-do-not-use-in-prod';
const OTHER_SECRET = 'a-different-secret-an-attacker-might-guess';

/* ── 1. Token minting/verification round trip ─────────────────────────── */
console.log('  -- token mint/verify --');
{
  const tTok = QA.mintToken('till', 'SK-KASSAB12-0001', SECRET);
  const parsed = QA.verifyToken(tTok, SECRET);
  ok('valid till token resolves to the correct id/type',
    parsed && parsed.type === 'till' && parsed.id === 'SK-KASSAB12-0001');

  const iTok = QA.mintToken('intent', 'SKNABC123DEF', SECRET);
  const parsedI = QA.verifyToken(iTok, SECRET);
  ok('valid intent token resolves to the correct id/type',
    parsedI && parsedI.type === 'intent' && parsedI.id === 'SKNABC123DEF');
}

/* ── 2. Forgery / tampering — must all be denied ───────────────────────── */
console.log('  -- forged / foreign / malformed / tampered tokens (all must be denied) --');
{
  const legit = QA.mintToken('till', 'SK-REAL0001-0007', SECRET);

  ok('token signed with the WRONG secret is denied',
    QA.verifyToken(legit.replace(/\.[0-9a-f]{32}$/, '.' + '0'.repeat(32)), SECRET) === null);

  ok('token signed by a DIFFERENT secret entirely is denied (foreign token)',
    QA.verifyToken(QA.mintToken('till', 'SK-REAL0001-0007', OTHER_SECRET), SECRET) === null);

  // Attacker knows the id, does not know the secret — cannot forge a valid signature.
  const forged = 'till.SK-REAL0001-0007.' + 'a'.repeat(32);
  ok('hand-forged signature (attacker without the secret) is denied', QA.verifyToken(forged, SECRET) === null);

  // Attacker takes a REAL, validly-signed till token and tries to relabel it as an intent token.
  const [, id, sig] = legit.split('.');
  ok('type-confusion (till token relabeled as intent) is denied',
    QA.verifyToken(`intent.${id}.${sig}`, SECRET) === null);

  ok('malformed token — too few segments — is denied', QA.verifyToken('till.SK-REAL0001-0007', SECRET) === null);
  ok('malformed token — too many segments — is denied', QA.verifyToken('till.a.b.c', SECRET) === null);
  ok('malformed token — empty string — is denied', QA.verifyToken('', SECRET) === null);
  ok('malformed token — non-string — is denied', QA.verifyToken(null, SECRET) === null);
  ok('malformed token — unknown type — is denied', QA.verifyToken('bogus.SK-REAL0001-0007.' + 'a'.repeat(32), SECRET) === null);
  ok('malformed token — id with illegal characters — is denied', QA.verifyToken('till.<script>.' + 'a'.repeat(32), SECRET) === null);
  ok('malformed token — short/invalid signature — is denied', QA.verifyToken('till.SK-REAL0001-0007.abc', SECRET) === null);
  ok('malformed token — oversized string — is denied', QA.verifyToken('till.' + 'x'.repeat(400) + '.' + 'a'.repeat(32), SECRET) === null);

  // Truncated-by-one-character replay of a real signature — proves the comparison isn't a loose prefix match.
  ok('truncated real signature is denied', QA.verifyToken(legit.slice(0, -1), SECRET) === null);
}

/* ── 2b. The token carries ONLY the opaque type+id+signature payload ──── */
console.log('  -- token payload contains nothing but the opaque reference --');
{
  const tillId = 'SK-KASSAB12-0001';
  const tok = QA.mintToken('till', tillId, SECRET);
  const parts = tok.split('.');
  ok('token is exactly 3 dot-separated segments (type, id, signature)', parts.length === 3);
  ok('segment 1 is exactly the type', parts[0] === 'till');
  ok('segment 2 is exactly the id — nothing appended or prepended', parts[1] === tillId);
  ok('segment 3 is a 32-hex-char signature and nothing else', /^[0-9a-f]{32}$/.test(parts[2]));
  ok('mintToken\'s signature is a two-argument function of (type,id) only — cannot accept business data',
    QA.mintToken.length === 3 /* type, id, secret */);
  // mintToken has no parameter through which an amount, merchantUid or shop name could
  // enter the token even if a caller tried — the function signature itself is the proof.
}

/* ── 3. Replay — same reference resolves deterministically, not denied ─── */
console.log('  -- replay (same token minted/verified repeatedly) --');
{
  const tok1 = QA.mintToken('till', 'SK-REAL0001-0007', SECRET);
  const tok2 = QA.mintToken('till', 'SK-REAL0001-0007', SECRET);
  ok('minting the same Till id twice is deterministic (HMAC, not random)', tok1 === tok2);
  ok('a permanent Till token verifies identically on repeated "scans"',
    QA.verifyToken(tok1, SECRET) !== null && QA.verifyToken(tok1, SECRET).id === 'SK-REAL0001-0007');
}

/* ── 4. Till payability (Q2 Q7 / Q4 Q6) ────────────────────────────────── */
console.log('  -- Till status gating --');
{
  ok('ACTIVE Till is payable', QA.checkTillPayable({ status: 'ACTIVE' }).ok === true);
  const disabled = QA.checkTillPayable({ status: 'DISABLED' });
  ok('DISABLED Till is denied', disabled.ok === false && disabled.code === 'failed-precondition');
  const retired = QA.checkTillPayable({ status: 'RETIRED' });
  ok('RETIRED Till is denied', retired.ok === false && retired.code === 'failed-precondition');
  const missing = QA.checkTillPayable(null);
  ok('missing/unknown Till is not-found, not silently allowed', missing.ok === false && missing.code === 'not-found');
}

/* ── 5. Dynamic-intent resolution state (Q4 Q4/Q5) ─────────────────────── */
console.log('  -- dynamic-intent resolution state --');
{
  const NOW = 1_700_000_000_000;
  const payable = QA.classifyIntentResolution({ purpose: 'pos_till_sale', status: 'created', expiresAtMs: NOW + 60_000 }, NOW);
  ok('created, not-expired intent resolves', payable.ok === true);

  const wrongPurpose = QA.classifyIntentResolution({ purpose: 'subscription', status: 'created', expiresAtMs: NOW + 60_000 }, NOW);
  ok('a non-pos_till_sale intent is refused (no cross-purpose resolution)', wrongPurpose.ok === false && wrongPurpose.code === 'failed-precondition');

  for (const status of ['paid', 'completed', 'cancelled', 'expired']) {
    const terminal = QA.classifyIntentResolution({ purpose: 'pos_till_sale', status, expiresAtMs: NOW + 60_000 }, NOW);
    ok(`terminal status "${status}" is refused, not re-offered`, terminal.ok === false && terminal.code === 'failed-precondition');
  }

  const expired = QA.classifyIntentResolution({ purpose: 'pos_till_sale', status: 'created', expiresAtMs: NOW - 1 }, NOW);
  ok('expired (by timestamp, still status=created) intent is refused', expired.ok === false && expired.code === 'failed-precondition');

  const notFound = QA.classifyIntentResolution(null, NOW);
  ok('unknown intent id is not-found', notFound.ok === false && notFound.code === 'not-found');
}

/* ── 6. pos_till_sale pricing decision — the money/authority core ──────── */
console.log('  -- pos_till_sale pricing: authorization, amount, merchant-tamper --');
{
  const till = {
    sokoniTillId: 'SK-KASSAB12-0001', shopId: 'shopUid1', branchId: 'shopUid1-main',
    merchantUid: 'shopUid1', currency: 'KES', status: 'ACTIVE',
  };

  // -- dynamic/cashier flow, correct operator --
  const cartQuote = QA.priceTillSale({
    till, callerUid: 'shopUid1',
    data: { items: [{ name: 'Bread', price: 60, qty: 2 }, { name: 'Milk', price: 55, qty: 1 }] },
  });
  ok('cashier cart prices to the server-summed subtotal (60*2+55=175 -> 17500 cents)', cartQuote.amountCents === 17500);
  ok('cart quote metadata.shopId is the TILL\'s own shopId', cartQuote.metadata.shopId === 'shopUid1');
  ok('cart quote metadata.merchantUid is the TILL\'s own merchantUid', cartQuote.metadata.merchantUid === 'shopUid1');
  ok('cart quote metadata.branchId is the TILL\'s own branchId', cartQuote.metadata.branchId === 'shopUid1-main');

  // -- CLIENT-ALTERED MERCHANT: a hostile data payload naming a different shop/merchant --
  const hostileData = {
    items: [{ name: 'Bread', price: 60, qty: 1 }],
    shopId: 'ATTACKER-SHOP', merchantUid: 'ATTACKER-UID', branchId: 'ATTACKER-BRANCH',
    sokoniTillId: 'SK-SOMEONE-ELSE-0099',
  };
  const hostileQuote = QA.priceTillSale({ till, callerUid: 'shopUid1', data: hostileData });
  ok('client-supplied shopId in the request is IGNORED — metadata still carries the Till\'s own', hostileQuote.metadata.shopId === 'shopUid1');
  ok('client-supplied merchantUid in the request is IGNORED', hostileQuote.metadata.merchantUid === 'shopUid1');
  ok('client-supplied branchId in the request is IGNORED', hostileQuote.metadata.branchId === 'shopUid1-main');
  ok('client-supplied sokoniTillId in the request body is IGNORED (the resolved Till decides)', hostileQuote.metadata.sokoniTillId === 'SK-KASSAB12-0001');

  // -- an operator who is NOT the Till's merchant tries to run a cart sale on it --
  throwsWith('a caller who is not the Till\'s own merchant is DENIED a cart sale', 'permission-denied', () => {
    QA.priceTillSale({ till, callerUid: 'SOME-OTHER-UID', data: { items: [{ name: 'Bread', price: 60, qty: 1 }] } });
  });

  // -- CLIENT-ALTERED AMOUNT: cashier cart ignores any client-sent total/amount field --
  const amountIgnored = QA.priceTillSale({
    till, callerUid: 'shopUid1',
    data: { items: [{ name: 'Bread', price: 60, qty: 1 }], amount: 1, amountCents: 1, total: 1 },
  });
  ok('a client-sent amount/total alongside items is ignored — server sums the items itself', amountIgnored.amountCents === 6000);

  // -- permanent-Till / buyer-entered flow — ANY authenticated buyer, no cart --
  const buyerQuote = QA.priceTillSale({ till, callerUid: 'random-buyer-uid', data: { amount: 250 } });
  ok('buyer-entered amount on a permanent Till is accepted from a non-operator caller', buyerQuote.amountCents === 25000);
  ok('buyer-entered quote metadata still carries the TILL\'s own merchant, not the buyer', buyerQuote.metadata.merchantUid === 'shopUid1');

  throwsWith('buyer-entered amount of zero is rejected', 'invalid-argument', () => {
    QA.priceTillSale({ till, callerUid: 'random-buyer-uid', data: { amount: 0 } });
  });
  throwsWith('buyer-entered negative amount is rejected', 'invalid-argument', () => {
    QA.priceTillSale({ till, callerUid: 'random-buyer-uid', data: { amount: -50 } });
  });
  throwsWith('non-numeric amount is rejected', 'invalid-argument', () => {
    QA.priceTillSale({ till, callerUid: 'random-buyer-uid', data: { amount: 'a lot' } });
  });
  throwsWith('neither items nor amount supplied is rejected', 'invalid-argument', () => {
    QA.priceTillSale({ till, callerUid: 'random-buyer-uid', data: {} });
  });
  throwsWith('amount above MAX_KES (150000) is rejected', 'failed-precondition', () => {
    QA.priceTillSale({ till, callerUid: 'random-buyer-uid', data: { amount: 999999 } });
  });
  throwsWith('a cart item with a non-positive price is rejected', 'invalid-argument', () => {
    QA.priceTillSale({ till, callerUid: 'shopUid1', data: { items: [{ name: 'Bad', price: 0, qty: 1 }] } });
  });

  // -- DISABLED/RETIRED Till refuses a new sale in either mode --
  throwsWith('DISABLED Till refuses a cashier cart sale', 'failed-precondition', () => {
    QA.priceTillSale({ till: { ...till, status: 'DISABLED' }, callerUid: 'shopUid1', data: { items: [{ name: 'x', price: 1, qty: 1 }] } });
  });
  throwsWith('RETIRED Till refuses a buyer-entered sale', 'failed-precondition', () => {
    QA.priceTillSale({ till: { ...till, status: 'RETIRED' }, callerUid: 'random-buyer-uid', data: { amount: 100 } });
  });

  // -- idempotency key (Q3: same cart -> same reference identity) --
  const q1 = QA.priceTillSale({ till, callerUid: 'shopUid1', data: { items: [{ name: 'x', price: 10, qty: 1 }], saleId: 'cart-abc' } });
  const q2 = QA.priceTillSale({ till, callerUid: 'shopUid1', data: { items: [{ name: 'x', price: 10, qty: 1 }], saleId: 'cart-abc' } });
  ok('same saleId -> identical preferredRef (double-tap resolves to the same intent)', q1.preferredRef === q2.preferredRef);
  ok('same saleId -> identical resourceId', q1.resourceId === q2.resourceId);
  const q3 = QA.priceTillSale({ till, callerUid: 'shopUid1', data: { items: [{ name: 'x', price: 10, qty: 1 }], saleId: 'cart-def' } });
  ok('a DIFFERENT saleId -> a DIFFERENT preferredRef (no accidental collision across sales)', q1.preferredRef !== q3.preferredRef);
}

/* ── 7. NEGATIVE CONTROL — must itself fail ────────────────────────────── */
console.log('  -- negative control (must fail; proves the harness can detect failure) --');
{
  const before = fail;
  ok('deliberately false assertion', 1 === 2);
  ok('control recorded exactly one failure', fail === before + 1);
  fail--; failures.pop(); // the deliberate failure above is not a real defect — do not count it
}

/* ── 8. SABOTAGE CONTROL — merchant-tamper checks run against weakened code ── */
console.log('  -- sabotage control (weakened merchant-authorization must be CAUGHT failing) --');
{
  const realSrc = fs.readFileSync(path.join(__dirname, '..', 'functions', 'sokoni-qr-authority.js'), 'utf8');

  // Remove the ONE line that stops a non-operator from pricing a cart sale.
  const sabotagedSrc = realSrc.replace(
    /if \(String\(callerUid\) !== String\(till\.merchantUid\)\) \{[\s\S]*?\}\n/,
    ''
  );
  if (sabotagedSrc === realSrc) {
    throw new Error('SABOTAGE CONTROL SETUP FAILED — the authorization line to remove was not found; ' +
      'the control cannot prove anything and the run must be blocked.');
  }

  const tmpFile = path.join(os.tmpdir(), `sokoni-qr-authority.sabotaged.${process.pid}.js`);
  fs.writeFileSync(tmpFile, sabotagedSrc);
  let sabotaged;
  try {
    sabotaged = require(tmpFile);

    const till = {
      sokoniTillId: 'SK-KASSAB12-0001', shopId: 'shopUid1', branchId: 'shopUid1-main',
      merchantUid: 'shopUid1', currency: 'KES', status: 'ACTIVE',
    };

    let sabotagedAllowedTheAttack = false;
    try {
      sabotaged.priceTillSale({ till, callerUid: 'SOME-OTHER-UID', data: { items: [{ name: 'Bread', price: 60, qty: 1 }] } });
      sabotagedAllowedTheAttack = true; // did not throw -> the sabotaged code let the attacker through
    } catch (e) {
      sabotagedAllowedTheAttack = false; // sabotage didn't remove the real protection somehow
    }

    ok('SABOTAGE: weakened code WRONGLY allows a non-operator cart sale (proves the real check matters)',
      sabotagedAllowedTheAttack === true);

    // And prove the REAL module still denies the identical attack, side by side.
    throwsWith('control: the REAL (unmodified) module still denies the same attack', 'permission-denied', () => {
      QA.priceTillSale({ till, callerUid: 'SOME-OTHER-UID', data: { items: [{ name: 'Bread', price: 60, qty: 1 }] } });
    });
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
  console.log('  CERTIFIED — Q5 pure core (functions/sokoni-qr-authority.js).');
  process.exit(0);
}
