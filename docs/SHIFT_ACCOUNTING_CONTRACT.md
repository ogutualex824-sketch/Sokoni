# Shift Accounting Contract

**Status:** PROPOSED — ratifies an existing formula; invents nothing
**Date:** 2026-09-01
**Suite:** `scripts/test-shift-cash.js` (61/0/1, now in the required gate)
**Related:** [[EMPLOYEE_AUTHORITY_MAP]] · [[POS_SHIFT_LIFECYCLE_AUDIT]] · [[RECEIPT_CONTRACT]]

---

## The contract already exists

The instruction was to produce one explicit accounting contract before wiring competing
implementations together, and **not** to invent another formula. Investigation found the
platform already has one, written down and implemented three times identically:

```
expected = openingFloat + cashSales − cashRefunds
         + cashIn − cashOut − safeDrops − cashPickups + adjustments

variance = countedCash − expected
```

- `functions/pos-cash-manager.js` → `_computeBalance()` — server, authoritative
- `pos-cash-manager.js` — client
- `sokoni-shift.js` — declares itself *"THE SHIFT / TILL AUTHORITY"* and states it takes the
  cash-manager formula **"character for character"**

This document therefore **ratifies** that formula rather than proposing a new one. Anything
that disagrees with it is a defect to be converged, not an alternative to be reconciled.

## Term definitions

| term | meaning | sign | source of truth |
|---|---|---|---|
| **opening float** | the merchant's own money placed in the drawer to make change. **Never revenue.** | + | `opening_float` / `register_open` |
| **cash sales** | the cash portion of a sale, **net of change given** | + | `cash_sale` |
| **cash refunds** | cash handed back to a customer | **−** | `cash_refund` |
| **cash in** | money added to the till (float top-up, petty-cash return, bank change) | + | `cash_in` |
| **cash out** | money paid out of the till (petty cash, supplier, expense) | − | `cash_out` |
| **safe drop** | cash moved from till to safe | − | `safe_drop` |
| **cash pickup** | cash collected from the till | **−** | `cash_pickup` |
| **float adjustment** | signed correction to the float | ± | `float_adjustment` |
| **closing count** | physically counted cash at close | n/a | cashier entry |
| **expected cash** | the formula above | — | server |
| **variance** | `counted − expected`; `> 0` over, `< 0` short | — | **server, never the client** |

Two invariants carry real money and are asserted with mutation controls in the suite:

1. **Opening cash is not revenue.** If the float reaches sales it inflates turnover,
   commission and merchant earnings — a platform-wide defect that would look like growth.
2. **M-PESA is not cash in the drawer.** A phone payment is revenue but not physical money;
   counting it makes every till reconcile "over" and gets cashiers accused of nothing.

## Implementation census

| # | implementation | expected / variance | verdict |
|---|---|---|---|
| 1 | `_computeBalance()` (server) | full formula | **CANONICAL** |
| 2 | `pos-cash-manager.js` (client) | full formula | agrees |
| 3 | `sokoni-shift.js` | full formula, "character for character" | agrees |
| 4 | `cdGetShiftSummary` (`pos-cash-drawer.js`) | was: no refunds, `+ cashPickup` | **CONVERGED — this change** |
| 5 | `closeShift` (`pos-staff-ops.js`) | **computes neither** | OPEN |
| 6 | `pos-db.js` `shifts.close` | `counted − (opening + totalCash)` | OPEN, client-side |
| — | `finance-os-sprint43.js` | `physicalCount − fund.balance` | out of scope: petty-cash fund, not a till |

## Fixed in this change

`cdGetShiftSummary` was the only dissenter, and it dissented twice — both in the direction of
overstating the drawer, i.e. making an honest cashier look short:

- **Cash refunds had no term.** `posDrawerLog` records `type: 'refund'` (a `DRAWER_OPEN_TYPE`)
  with an `amount` and an `outcome`. Those events existed all along and were simply excluded.
  Now summed with the same collection, shape and success filter as `sale`, opposite sign. On a
  KES 700 refund the report was 700 short.
- **`cashPickup` was ADDED where the canon SUBTRACTS.** On a KES 5,000 pickup the report read
  **10,000 over** the canonical figure — double the pickup. This was not a business judgement:
  three implementations and a written contract subtract it.

Both were already characterized by `test-shift-cash.js`, which failed the moment they were
repaired — the repair inverted the assertions, which is the intended behaviour of a
characterization test.

## Still divergent — deliberately not fixed

**`cdGetShiftSummary` remains structurally wrong in ways a sign change cannot repair**, and the
suite continues to assert each:

- **Its cash sales come from drawer-open events, not sales.** A phone till never opens a
  hardware drawer, so `posDrawerLog` is empty for it and cash sales sum to **zero** while the
  day's real cash sales are 8,000.
- **It reads `posTillEvents`; the canon reads `posCashEvents`.** Two collections, two
  vocabularies. `TILL_EVENT_TYPES` cannot express `float_adjustment` at all, which is why the
  `+ adjustments` term is still absent.
- **It requires manager claims**, which a solo merchant does not have.
- **It is deployed**, so all of the above is live behaviour.

Converging the collections is the real repair and is a larger change than a formula fix.

## Open — needs a decision, not an edit

1. **The client establishes the variance.** `cmRecordCashEvent` accepts `expectedCents` **and**
   `varianceCents` from the request body and only sanitizes them. The server has
   `_computeBalance` and could derive both. This contradicts the standing rule that a client
   cannot establish a financial fact — but changing it alters what a deployed client's
   payloads mean, so it is raised rather than done.
2. **`closeShift` reconciles nothing.** It records `closingCash` beside `cashSales` and never
   compares them. Giving it the canonical formula is the obvious repair; doing so requires
   deciding whether `posShifts` or `posCashEvents` is the event source for a shift.
3. **`pos-db.js` computes a client-side variance** from IndexedDB, ignoring refunds and every
   drawer movement. It is the figure printed on the shift receipt.
4. **Refund attribution across shifts.** A refund paid today for yesterday's sale reduces
   today's drawer. `closeShift` skips refunded sales entirely, so it is captured nowhere.
5. **`cashierId` is client-supplied** in `pos-cash-manager.js` (`cashierId || auth.uid`) — the
   same defaulting-is-not-binding pattern corrected in `recordPOSSale`. Tracked separately as
   a tenant-boundary finding, not bundled into accounting work.

## Drawer movements

They **do** have an authoritative record — `posCashEvents` with a closed vocabulary
(`VALID_TYPES`), validated categories (`VALID_IN_CATS`, `VALID_OUT_CATS`), witness and
approver fields. No new store is needed, and none was created.
