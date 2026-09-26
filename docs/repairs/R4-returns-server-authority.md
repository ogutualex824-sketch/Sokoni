# Repair 4 — a return is a request the server creates

**Branch:** `repair-4/returns-server-authority` (from main line `e28a873`) · **NOT landed, NOT deployed**
**Programme:** Refund + Seller Accountability, repair 4 of 5 · **Related:** [[R2-canonical-dispute-identity]] · [[R3-canonical-reason-authority]]

## The defect

- **`returns.html` wrote return records straight from the browser** (create, reject, request-info), which the
  served rules deny (`write: false`). Approve called **`processReturn`, which does not exist**, and then
  announced **"Return approved — refund initiated"** although nothing initiates a refund.
- **`submitReturn` trusted the client's items, prices and quantities.** A buyer could declare any price.
- **No eligibility:** unpaid, undelivered and out-of-window orders were all accepted, contrary to the
  published 7-day policy.
- **The identity defect Repair 2 fixed for disputes:** ownership was checked on `buyerId`/`userId`, which no
  production order carries, so **no real buyer could submit a return**.
- The seller list and review depended on a `seller` claim that is not minted for every merchant.
- `sokoni-trust.js` `requestRefund` wrote a **client-chosen `refundAmount`** onto a dispute. The rules deny
  it, and nothing calls it.

## What the server now decides — `submitReturn`

The browser sends only: `orderId`, `reason`, `description`, the requested outcome, an optional `itemNote`, and
optionally **which** of the order's items (`productIds`).

| decided by the server | from |
|---|---|
| the buyer, and ownership | `dispute-identity.isOrderBuyer`: ONE uid by precedence (Repair 2) |
| the reason | `refund-reasons.resolve('return')`: stored canonical (Repair 3) |
| payment, delivery, 7-day window | `returns-eligibility.js`, quoting the **published** returns policy |
| evidence requirement | "For defective or wrong items ... photos ... are required" → `defective`, `wrong_item` (recorded; upload is later work) |
| items, names, prices, quantities | the **order** (`productIds` may narrow the selection; an item not on the order is refused) |

It stores `buyerUid`/`sellerUid`/`shopId`, the `policyId`, `deliveredAt`/`windowEndsAt` and `evidenceRequired`.
Refusals are proper callable errors with a reason, not a bare `internal`.

**It moves no money and decides no refund, fee, liability, rider payment, wallet credit or chargeback. That is H2.**

**Page:** every read and write goes through `submitReturn`, `getMyReturns`, `getSellerReturns`, `reviewReturn`
and `adminForceReturn`. Messages are truthful: "Any refund is decided and issued separately."
**Seller scope** is by data (`sellerUid == caller`), not by claim. Buyer names stay masked for every non-admin.
**`sokoni-trust.js requestRefund`** writes nothing: the dispute is the request.

## Evidence — `scripts/test-returns-server-authority.js`

Runs over the 10 real production order shapes (pseudonymised), with the real callables and the **served** rules.

| target | result |
|---|---|
| repaired | **33 / 0**. 10/10 legitimate buyers; 30 cross-identity refusals with nothing written; unpaid, undelivered and window-closed refusals with nothing written; client items and a 999,999 price ignored (the order's items stored); subset by productId; unknown item refused; canonical reason and evidence flags; canonical identity, list, seller-without-claim, review boundaries; **no write to any money collection**; served rules deny direct create and approve (an allow-all counterproof allows both); page and `sokoni-trust.js` write nothing |
| **old code** (`e28a873`) | **9 / 24 FAIL**. 0/10 buyers; the page makes all its direct writes and the false "refund initiated" claim |
| **old code, past identity** (legacy `buyerId` supplied) | **11 / 22 FAIL**. Accepts **unpaid, undelivered and out-of-window** orders; **stores a client price of 999,999**; stores reasons uncanonicalised; no evidence flag. Each defect is shown independently of identity |

**Regressions: none.**
- R1 39/0, R2 26/0, R3 21/0, `test-settled-case-guard` 66/0, `test-refund-authority` 55/0,
  `test-refund-escrow-binding` 13/0.
- R3's fixture order is now an **eligible** order (paid, delivered, itemised), because returns apply the policy.
  Its reason assertions are unchanged and it still fails 12 on the pre-R3 tree.
- An invented "description ≥ 10 characters" rule I first added was **removed**. The engine and the policy never
  required it.
- Static suites are unchanged vs `e28a873`. `test-auth-verify-gate` shows the pre-existing
  `realtime-harness.html` failure, which also reproduces on the main line.

## Found, not changed

- **`markReturnProcessed` has no ownership or status check.** Any seller can mark any return processed. This is a
  lifecycle and authorization defect beyond request creation; reported for review.
- **`reviewReturn` stores a seller-supplied `refundAmount`** on approval. It moves no money, but H2 must derive
  refund amounts from the payment records and never adopt that field.
- **The served rules gate return reads on `buyerId`/`sellerId`.** The page now reads through the server, so direct
  reads are denied, which fails closed. Moving the rules source onto canonical names belongs to the rules
  workstream (a rules deploy).
- **The policy page promises "Sellers may set their own extended return policies" — no such setting exists in
  code.** Every request is held to the published 7 days.
