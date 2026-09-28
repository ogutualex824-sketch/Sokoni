# POS Q0b-2a — `recordPOSSale`: a named customer must be the bound seller's own (main line)

**Branch:** `pos-safety/q0b2a-recordpossale` (from main `287bf37`) · **not deployed** · served lineage NOT changed
**Owner authorization (2026-09-27):** Q0b-2 is split and ordered 2a → 2b → 2c → 2d; this is 2a.
- Use the Q0b-1 customer-scope authority, with owners = the already-bound `_sellerId`.
- A foreign, unowned, malformed or switched-owner customer **refuses the sale** (`permission-denied`), and is never
  silently turned into a walk-in.
- A sale that names no customer stays a walk-in.

**Related:** [[POS-Q0b1-customer-scope]] · [[POS-Q0a-loyalty-redemption]]

## The defect

`recordPOSSale` is reachable directly and through `smartPosDispatch({op:'recordPOSSale'})`, and the dispatch route is
the one deployed. Its seller was already bound (non-admin → own uid). Its **customer** lookup was collection-wide, by
phone or by document id. A sale naming another merchant's customer therefore:
1. copied that customer's **name, phone, points total and tier** into this merchant's `posSales` and `receipts`;
2. **credited that customer** with loyalty points, total spend, a visit and the receipt, through a plain `update()`
   after commit that re-checked nothing.

## The repair (`functions/pos-retail-engine.js`, `recordPOSSale` only)

1. **A named customer** (by `customerPhone` or `customerId`) is resolved through `pos-customer-scope`, with owners
   `{_sellerId}`:
   - `findOwnedByPhone` for a phone, `getOwnedIn` for an id;
   - every query carries the owner filter, so another merchant's customer is never loaded.
   - Foreign, unowned, malformed and **missing** customers all get **one** `permission-denied`, "That customer is not one
     of your customers…". A refusal never reveals whether another merchant's customer exists.
   - A path-shaped id, or an unreadable phone with no id, is `invalid-argument`.
2. **The stock transaction re-reads the customer and re-checks ownership.** A customer whose owner changed after the
   lookup refuses the sale **before anything is written**. The transaction therefore also runs for a customer sale with
   no stock items.
3. **Points are awarded in a transaction that re-checks ownership.** The sale has committed by then and cannot be
   refused, but a customer whose owner changed since is **not credited**.

No other part of `recordPOSSale` changed: seller binding, commission gate, product ownership, the sale/receipt batch,
and the liability.

## Evidence — `scripts/test-q0b2a-recordpossale-customer.js` (real `_h.recordPOSSale`, Firestore emulator)

| tree | result |
|---|---|
| new | **23 / 0** |
| old (`287bf37`) | **7 / 16 FAIL** |

**Old-tree failures:**
- Every foreign case **sold** and returned the foreign customer's inflated points total (for example 787 = B's 777
  plus 10):
  - B's customer by phone and by id;
  - B's composite id, by id and by phone;
  - a legacy ownerless customer;
  - our prefix with a malformed owner;
  - our prefix with B's owner.
- A missing customer, a path-shaped id and an unreadable phone became walk-ins.
- Both owner switches credited a customer that was no longer the shop's.
- **N-1:** B's name and phone were found in A's `posSales`.
- **N-2:** four foreign customers' points rose.
- **N-4:** the read spy shows `B1R`, B's composite customer and `LEGR` being loaded.

**New tree:**

| Area | Result |
|---|---|
| **Controls** | a walk-in; own customers by phone, by composite id (phone) and by document id, each credited; an admin recording for seller B with B's own customer |
| **Refusals** | each is `permission-denied` with no sale, no receipt, unchanged stock, and the named document **byte-unchanged** (data and `updateTime`) |
| **Missing customer** | the same refusal text as a foreign one |
| **Forged `sellerId`** | still refused by the existing binding |
| **S-1** | an owner switched before the stock transaction → refused inside it, with nothing written |
| **S-3** | the same for a **service** sale with no stock items |
| **S-2** | an owner switched after the sale committed → the sale stands and the customer is **not credited** |
| **N-1** | no foreign name, phone or points total in any of the written sale and receipt documents |
| **N-2** | foreign points unchanged |
| **N-3** | the 5 existing `posRetailSales` records (the production shape) byte-unchanged |
| **N-4** | none of B's documents is loaded during the refused attempts |

**Mutation check** (one safeguard at a time, in scratch copies):

| Reverted | Red |
|---|---|
| phone lookup unscoped | N-4 |
| id lookup unscoped | N-4 |
| refusal becomes a walk-in | R-1–R-8 |
| path-id check | R-9 |
| unreadable phone becomes a walk-in | R-10 |
| in-transaction re-check | S-1, S-3 |
| transaction skipped without stock items | S-3 |
| points re-check | S-2 |

For both unscoped lookups, the in-transaction re-check still refuses the sale, so the read spy is what catches them.

**Regression floor:** **43/43 identical** to `287bf37`. That is the 40 main suites plus the three `recordPOSSale`
suites: `test-recordpossale-money-provenance` 28/0, `test-void-tenant-atomicity` 49/0, `test-receipt-gate` 55/0.

**Emulator suites at this tree:** Q0b-1 40/0, Q0a 26/0, 0b checkout 31/0.
**Gates:** `predeploy-syntax-gate` exit 0.
**Callers:** the only client, `pos-onboard.html`'s demo sale, names no customer.

## Boundaries (NOT fixed here)

- **2b** `posGetCustomerInsights`, **2c** `_resolveSellerId`, **2d** the CRM client.
- The served adaptation of 2a. There, `recordPOSSale`'s **seller** is also unbound (`sellerId || auth.uid`), a served
  finding recorded at served Q0b-1.
- **Not deployed.**

## L-7 port onto the POS lineage (2026-09-28)

Q0b-2a was certified on the main line (3d03a70). This section records its port onto the POS lineage descended from
the live build, as reconciliation unit **L-7** (with Q0b-2b), on base `52b9ed6` (L-6). See
[[POS-Q0b1-customer-scope]], [[POS-Q0b2b-customer-insights]] and [[FINANCIAL_CORE_ARCHITECTURE]].

- **One conflict, resolved against M0-2.** On this lineage M0-2 already moved `recordPOSSale`'s stock
  reservation into `_reserveStockInTxn(t)`, which runs inside the **one** sale transaction (claim · stock · sale ·
  receipt). Q0b-2a expected a separate `runTransaction`, widened to run whenever a customer is named.
  - The resolution keeps M0-2's single transaction and applies Q0b-2a's widening to the helper's guard
    (`stockItems.length > 0 || customerDocRef`), so the ownership re-read runs inside M0-2's transaction.
  - Every read (claim, products, customer) still precedes every write.
  - The rest of the source patch applies unmodified: the scoped lookup and the ownership-checked points award.
- **M0-2 is intact:**
  - the M0-2 suite is 13/0;
  - a replay returns before the points award, so a replay never credits a customer;
  - the claim fingerprint already covers `customerId` and `customerPhone`.
- **New: `scripts/test-l7-replay-customer-binding.js`** proves the two authorities compose. It passes 6/0 on the port
  and 5/1 on `52b9ed6`, where P-4 sells to another merchant's customer:
  - same-key replay: the original sale, with no second credit;
  - the same key naming another merchant's customer: refused, nothing written;
  - a customer whose owner changed: never re-credited by a replay;
  - concurrent same-key calls: one sale, credited once.

  P-2/P-3/P-5/P-6 hold on both trees (M0-2 not weakened). On the port, P-3 is refused by the customer authority
  before the fingerprint check is reached.
- **Fixture adapted to this lineage, assertions unchanged:**
  - every call carries an `idempotencyKey`, as M0-2 requires;
  - S-2's "after the sale committed" injection hooks the resolution of M0-2's sale transaction, where the
    main line committed a batch.

  The injections fire on both trees.
- **The seller is bound here.** A non-admin's `sellerId` must equal `auth.uid`, and R-11 passes on both trees. The
  unbound-seller note above concerns the served lineage, not this one.
- **Evidence:**
  - 23/0 on the port vs 7/16 on `52b9ed6`, the same profile as the main line.
  - 8 of 8 mutants are caught. Each also runs against the replay suite and the M0-2 suite; M0-2 stays 13/0 under every one.
  - Floor: see CHANGELOG 165.
- **Not deployed.**
