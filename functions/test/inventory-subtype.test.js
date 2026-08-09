/* Inventory subtypes — returnable-unit balance contract.
 *
 * These test the PURE definitions and the transfer's guard logic. The
 * transactional behaviour (the oversell race) needs the Firestore emulator,
 * which needs JDK 21 — see the note at the bottom. It is listed, not skipped
 * silently, because a suite that quietly omits its most important case reads as
 * greener than it is.
 */
'use strict';

const engine = require('../inventory-engine');
const { sellableOf, onHandOf, SUBTYPES, SUBTYPE_MOVEMENTS } = engine;

const level = (o = {}) => Object.assign(
  { available: 0, reserved: 0, allocated: 0, incoming: 0,
    damaged: 0, expired: 0, onHand: 0, empty: 0, onLoan: 0 }, o);

describe('sellable', () => {
  test('is available minus what is already promised', () => {
    expect(sellableOf(level({ available: 10, reserved: 3 }))).toBe(7);
  });

  test('never goes negative when reservations exceed stock', () => {
    expect(sellableOf(level({ available: 2, reserved: 5 }))).toBe(0);
  });

  test('damaged stock is never sellable', () => {
    /* The one that matters: a damaged bottle must not be offered for sale. */
    expect(sellableOf(level({ available: 0, damaged: 40 }))).toBe(0);
  });

  test('empty and on-loan bottles are never sellable', () => {
    expect(sellableOf(level({ available: 0, empty: 60, onLoan: 90 }))).toBe(0);
  });

  test('handles a missing level', () => {
    expect(sellableOf(undefined)).toBe(0);
    expect(sellableOf({})).toBe(0);
  });
});

describe('on-hand', () => {
  test('counts available, reserved, incoming and damaged', () => {
    expect(onHandOf(level({ available: 10, reserved: 3, incoming: 2, damaged: 1 }))).toBe(16);
  });

  test('EXCLUDES empty and on-loan', () => {
    /* An empty bottle is not sellable stock, and a bottle in a customer's
       kitchen is not on hand at all. Counting either overstates what the
       merchant can sell — the exact failure the shared POS/marketplace
       inventory exists to prevent. */
    const withReturnables = level({ available: 10, reserved: 3, incoming: 2, damaged: 1,
                                    empty: 500, onLoan: 900 });
    expect(onHandOf(withReturnables)).toBe(16);
  });

  test('a warehouse holding only empties reports zero on hand', () => {
    expect(onHandOf(level({ empty: 250 }))).toBe(0);
  });
});

describe('subtype vocabulary', () => {
  test('the six buckets are exactly the ones a transfer may move between', () => {
    expect(SUBTYPES).toEqual(['available', 'reserved', 'incoming', 'damaged', 'empty', 'onLoan']);
  });

  test('"exchanged" is a movement, never a bucket', () => {
    /* Stock does not sit in "exchanged"; it moves through it. Modelling it as a
       balance would create a bucket that can only ever grow. */
    expect(SUBTYPES).not.toContain('exchanged');
    expect(SUBTYPE_MOVEMENTS).toContain('exchange');
  });

  test('the returnable movement vocabulary is closed', () => {
    expect(SUBTYPE_MOVEMENTS).toEqual(['sale', 'exchange', 'return', 'loan', 'return_from_loan']);
  });
});

describe('bottle workflows preserve totals', () => {
  /* Pure arithmetic over the same definitions the transfer applies, so the
     conservation property is asserted independently of Firestore. */
  const move = (l, from, to, qty) =>
    Object.assign({}, l, { [from]: l[from] - qty, [to]: l[to] + qty });

  const totalUnits = (l) =>
    l.available + l.reserved + l.incoming + l.damaged + l.empty + l.onLoan;

  test('a refill conserves total units', () => {
    const before = level({ available: 10, empty: 0, onLoan: 5 });
    const after  = move(move(before, 'onLoan', 'empty', 1), 'available', 'onLoan', 1);
    expect(totalUnits(after)).toBe(totalUnits(before));
    expect(after.available).toBe(9);
    expect(after.empty).toBe(1);
    expect(after.onLoan).toBe(5);
  });

  test('loan then return restores the original balances', () => {
    const before = level({ available: 10, onLoan: 0, empty: 0 });
    const lent     = move(before, 'available', 'onLoan', 3);
    const returned = move(lent, 'onLoan', 'empty', 3);
    const refilled = move(returned, 'empty', 'available', 3);
    expect(refilled.available).toBe(before.available);
    expect(refilled.onLoan).toBe(0);
    expect(refilled.empty).toBe(0);
    expect(totalUnits(refilled)).toBe(totalUnits(before));
  });

  test('damaging a bottle removes it from sellable but not from the count', () => {
    const before = level({ available: 10 });
    const after  = move(before, 'available', 'damaged', 1);
    expect(sellableOf(after)).toBe(9);
    expect(onHandOf(after)).toBe(onHandOf(before));   /* damaged is still held */
    expect(totalUnits(after)).toBe(totalUnits(before));
  });

  test('selling a new bottle moves it to the customer, not out of existence', () => {
    const before = level({ available: 10, onLoan: 0 });
    const after  = move(before, 'available', 'onLoan', 1);
    expect(sellableOf(after)).toBe(9);
    expect(onHandOf(after)).toBe(9);          /* no longer the merchant's to sell */
    expect(totalUnits(after)).toBe(totalUnits(before));
  });
});

describe('the transfer primitive is registered', () => {
  test('exported from the engine', () => {
    expect(typeof engine.inventoryTransferSubtype).toBe('function');
  });
});

/* ── NOT COVERED HERE, and deliberately named rather than omitted ───────────
 *
 *   1. Two concurrent tills selling the last bottle — exactly one succeeds.
 *   2. Every balance change appends exactly one movement.
 *   3. `reason` is required and short reasons are rejected.
 *
 * All three need the Firestore emulator, which firebase-tools runs only on
 * JDK 21; this host has 17. The transfer reads the level INSIDE
 * db.runTransaction, so Firestore's optimistic concurrency gives (1) — but that
 * is an argument, not a test, and it is recorded as untested until it runs.
 *
 * Same gate as scripts/test-landlord-rules.js.
 */
