# Repair 2 — one canonical identity for a dispute

**Branch:** `repair-2/canonical-identity-fields` (from main line `8c1e88f`) · **NOT landed, NOT deployed**
**Programme:** Refund + Seller Accountability, repair 2 of 5 · **Related:** [[R1-dispute-settlement-hold]] · [[Orders]]

## The defect

One dispute, four vocabularies. None of them agreed with the orders or with the rules.

| where | buyer | seller | reason |
|---|---|---|---|
| `createDispute` ownership check | `buyerId`/`userId`/`customerId` | — | — |
| `createDispute` writer | `buyerId` | `sellerId` | `reason` |
| served Firestore rules | `uid` / `buyerUid` | `sellerUid` | — |
| `impact.js` | — | `sellerUid` | — |
| `wallet.js` `_hasOpenDispute` | — | `sellerId` | — |
| `automation-engine.js` | `buyerId` | `sellerId` | **`type`** (never exists) |
| `email-triggers.js` | **`customerId`** (never exists) | — | — |

**Production (read-only, 2026-09-26):** all 10 orders carry `buyerUid` and `uid`, and **none** carries `buyerId`,
`userId` or `customerId`. So **no real buyer could open a dispute**. The served rules never matched a real dispute
either, so a buyer or seller could not read their own. Dispute emails had no recipient, and automation's
seller-wins branch could never fire.

## The canonical names

A dispute carries **`buyerUid` · `sellerUid` · `shopId` · `reason`**. These are the names the orders already use
(10/10 in production) and the names the served rules already check, so **the writer converged on the rules and no
rule changed**. Production holds **0 disputes**, so there is no legacy document to migrate and no legacy name
is read.

**One buyer, by precedence** (`functions/dispute-identity.js`): `buyerUid → buyerId → userId → customerId → uid`.
The seller resolves the same way: `sellerUid → sellerId → vendorId`. This is not "any field that matches":
after the KASS account merge, orders could carry `uid` = a **deprecated** account and `buyerUid` = the canonical
one. Order data is **not** rewritten; only the aliases orders actually carry are read.

**Converged:** `disputes.js` (ownership, writer, all 8 reads and queries), `wallet.js`, `automation-engine.js`
(reason, notifications, prompts), `email-triggers.js` (both dispute emails), `trust-safety.html` (admin list),
and the `sokoni-merchant-disputes.js` header, which no longer claims a dead rules path.

## Evidence — `scripts/test-dispute-identity.js`

Built on `scripts/fixtures/prod-order-identity-shapes-20260926.json`: **all 10 production orders**, uids
pseudonymised, with field presence and agreement exact. Dates are rebased to now so the 30-day window, which is
not under test, does not interfere.

| target | result |
|---|---|
| repaired | **26 / 0**. **10/10** legitimate buyers open a dispute. **30** cross-identity attempts (the other outside buyer, the seller, a stranger) are all `permission-denied`, with **nothing written**. Only canonical fields are written; list, detail, evidence, respond and cancel all honour the same identities. The precedence case refuses the deprecated account and accepts the canonical buyer (synthetic, because production has no disagreement today). Under the **served** rules, buyer and seller can now read their own dispute; the control shows the old field names never matched |
| **old code** (`8c1e88f`) | **14 / 12 FAIL**: **0/10** legitimate buyers can open a dispute (`permission-denied` on every one) |

**Production shape, stated plainly:** 3 identities across 10 orders. 8 are the KASS account buying from itself;
only **2** (`ORD02`, `ORD04`) have an outside buyer.

**Regressions: none.**
- Repair 1 39/0, `test-settled-case-guard` 66/0, `test-refund-authority` 55/0, `test-refund-escrow-binding` 13/0.
- `test-merchant-disputes` 60/0: H2 and H4 now read the canonical fields; they assert the same authorities.
- 18 related static suites have identical failing sets vs `8c1e88f`. Two can only run with git history, so
  they pass on the branch and cannot run on the plain export.
- One static check of this suite was **tightened** after it passed on the old code by matching an unrelated
  `payoutRequests` query. It now fails on old code and passes on new.

## Not covered

- `sokoni-trust.js` writes `refundRequested` directly onto a dispute, which the rules deny. That dead client write
  belongs to **Repair 4** (the returns and request path).
- `initiateRefund` still accepts any of `uid`/`userId`/`buyerId`/`buyerUid` as the order owner. Converging it on
  `dispute-identity.orderBuyerUid` is a behaviour change in the refund path, left for H2.
- `wallet.js` `_hasOpenDispute` still treats only `status === 'open'` as open. Aligning it with the one open list
  in `dispute-hold.js` changes the withdrawal block, so it is recorded for review, not changed silently.
- Disputes where buyer == seller (8 of 10 production orders) are allowed, as before.
