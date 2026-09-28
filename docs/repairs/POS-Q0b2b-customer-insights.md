# POS Q0b-2b — `posGetCustomerInsights` serves only the proven merchant's customer history (main line)

**Branch:** `pos-safety/q0b2b-customer-insights` (from main `3d03a70`) · **not deployed** · served lineage NOT changed
**Owner authorization (2026-09-27):** **bind** it (not retire). Retirement is a separate production and lifecycle
decision.
- Use the main till authority, `_proveCustomerMerchant(caller, merchantId)` with `customers`.
- Derive the sales query from the **proven** merchant, never the requested id.
- The Anthropic suggestion receives only the proven merchant's data.

**Related:** [[POS-Q0b1-customer-scope]] · [[POS-Q0b2a-recordpossale-customer]]

## The defect

`posGetCustomerInsights` is **deployed** (2026-09-09). No client calls it; the merchant surfaces deliberately do not bind
it. It checked only that the caller was signed in, then took `merchantId` and `customerId` from the request.

For any merchant and customer it returned 90 days of purchase history: recent receipts, top items, total spend, visit
count and average basket. It also sent the top items to the model (Anthropic) for an upsell suggestion.

## The repair

- **`pos-zero-friction.js`:** `exports._provenCustomerOwners(caller, merchantId)` runs the Q0b-1 till authority,
  `_proveCustomerMerchant`, then `_merchantOwnerSet`, and returns the proven owner set. It refuses exactly as
  `posLookupCustomer` does. It is internal: `index.js` re-exports this module by name only. No new proof logic was
  written.
- **`pos-intelligence.js`:** the claim is proven **before anything is read**. The sales query is keyed on
  `merchantId in [proven owners]`, which covers the business id and its owner's uid. The existing
  `merchantId + customerId + createdAt` index serves it. The model therefore only ever sees the proven merchant's
  items.
- Nothing else in the handler changed.

## Evidence — `scripts/test-q0b2b-customer-insights.js` (real handler, Firestore emulator)

The Anthropic SDK is replaced **in-process** by a stub that records every prompt and answers locally. **Nothing leaves
the machine.** The same customer id (`CUST1`) exists at two merchants, so an unscoped query returns the wrong merchant's
history rather than nothing.

| tree | result |
|---|---|
| new | **13 / 0** |
| old (`3d03a70`) | **5 / 8 FAIL** |

**Old-tree failures:**
- A's owner, a stranger, an admin and A's cashier each got **B's** `CUST1` history (whisky, cigars, 3 visits).
- A member without `customers` got the business's history.
- 13 sales were loaded, and **5 prompts carried B's items to the model**.
- The business's owner-keyed sale was missed.

**New tree:**

| Area | Result |
|---|---|
| **Allowed** | the shop owner and the shop's cashier see A's history only; a member with `customers` sees the business's history under **every** proven identity |
| **Refused** | A claiming B, a stranger, a member without `customers`, an admin who is not the shop, and A's cashier claiming B are each `permission-denied` |
| **N-1** | those refused calls loaded **no** sale and sent **no** prompt |
| **M-1 and M-2** | no prompt ever carried another merchant's items; the proven merchant's own items did reach the stub, so it is live |

**Mutation check:**

| Reverted | Red |
|---|---|
| proof skipped | C-3, X-1–X-5, N-1, M-1 |
| query on the requested merchant | C-3 |
| owner set = the claim only | C-3 |
| capability `pos` | X-3, N-1 |

**Regression floor** (vs `3d03a70`):
- 45 suites: the 40 main suites, the three `recordPOSSale` suites, `test-merchant-customers` 49/0 and
  `test-supplier-sync-authority`.
- **44 are identical.** The one difference is the `test-catalogue-canonical-migration` working-tree guard on the
  uncommitted `pos-zero-friction.js`, which clears on commit.

**Emulator suites at this tree:** Q0b-1 40/0, Q0a 26/0, 0b checkout 31/0, Q0b-2a 23/0.
**Gates:** `predeploy-syntax-gate` exit 0.

## Boundaries (NOT fixed here)

- **2c** `_resolveSellerId`, **2d** the CRM client, and the served adaptation.
- Whether this deployed, uncalled function should be **retired** stays a separate production decision.
- **Not deployed.**

## L-7 port onto the POS lineage (2026-09-28)

Q0b-2b (1cbd12f) is ported with Q0b-2a as reconciliation unit **L-7**, on base `52b9ed6`. See
[[POS-Q0b2a-recordpossale-customer]] and [[POS-Q0b1-customer-scope]].

- **Clean, line-for-line.** `pos-intelligence.js` is byte-identical on both lines before the patch. The change to
  `pos-zero-friction.js` is the source's 9-line `_provenCustomerOwners`, built on L-6's `_proveCustomerMerchant` and
  `_merchantOwnerSet`.
- **Not a new entry point.** `functions/index.js` on this lineage re-exports both modules by name only, so
  `_provenCustomerOwners` is never deployed as a function. `pos-zero-friction` is required lazily inside the
  handler, so module load order is unchanged.
- **Scope:** `posGetCustomerInsights` only. No CRM or customer-profile change is included.
- **Evidence:**
  - 13/0 on the port vs 5/8 on `52b9ed6`, the same profile as the main line. Every old red is a cross-merchant history
    read, including another merchant's items in the model prompt.
  - 4 of 4 mutants are caught.
- **Retirement** of this deployed, uncalled function stays a separate production decision.
- **Not deployed.**
