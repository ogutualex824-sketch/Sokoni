# 6a — The POS checkout authority is proven first, and owns its sale identity

**Status:** built on the POS lineage (base `8cc8ce9`, M0-4-DR-R) 2026-09-28. **Not deployed.**
**Related:** [[FINANCIAL_CORE_ARCHITECTURE]], [[POS-M0-4-DR-A-atomic-debt]], [[POS-M0-4-DR-R-reconciliation]],
[[POS_COMMISSION_RAIL]], [[SECURITY]]. Precondition for **6b** (SmartPOS convergence).

## The invariant

> No idempotency claim, replay, resume or financial side effect happens before the caller is proven authorised for the
> named merchant. The proven merchant is the one identity that then feeds the scoped idempotency key, the sale id, the
> resume check, the stock and debt authority, and the receipt and summary.

## What was wrong (census 2026-09-28, emulator-proven on `8cc8ce9`)

`posCompleteCheckout` ran in this order: **claim key → cached replay → resume → … → prove merchant**.

| Case | Result on `8cc8ce9` |
|---|---|
| A merchant pre-claims its own sale id through the SmartPOS mirror (a client-chosen `posTransactions` id) | the checkout **adopts** the mirror record: `ok`, **no debt, no stock movement**, key `complete`. DR-R classes the record `OUT_OF_SCOPE`, so it is never flagged. |
| X1: an unrelated account names a victim merchant and pre-claims the victim's id | `ok`; the victim's `posDailySummary` is written; the key is `complete` |
| X2: an unrelated account replays the victim's key | receives the **victim's `saleId` and receipt** (`posIdempotency/{raw key}` was one global namespace) |
| The M-PESA trigger | claimed `mpesaReferenceClaims/{merchantId}__{ref}` with the merchant taken from **unbound** `merchantId`/`sellerUid`/`shopId`, so any signed-in account could squat a victim's reference |

## What changed

- **`functions/pos-zero-friction.js`**
  - **Order.** The existing merchant proof (`resolveActor`, or business membership with `sales`) is **moved, unchanged**
    (76 lines, verified identical), to just after the dry-run return and before the idempotency claim. It is not
    duplicated: there is one predicate.
  - **Scoped idempotency.** `_idemIdFor(merchantId, key)` = `pi_` + sha256(`merchant|key`)[:40], exported. The record
    stores `merchantId` and `idempotencyKey`. A completed record is returned only if it names the proven merchant (the
    second, independent check). The cached-replay line itself is textually unchanged, so the tripwire in
    `test-pos-confirmation-vocabulary.js` is untouched.
  - **Resume.** A record at the sale id is resumed only when all of the following hold:
    - `source !== 'pos-mirror'`;
    - `merchantId` equals the proven merchant;
    - `idempotencyKey` equals the key;
    - `merchantProvenBy` is `shop_actor` or `workspace_membership`;
    - `soldAtMs` is an integer.

    None of these can come from the mirror, whose mapper is a fixed whitelist. Anything else fails closed with
    `failed-precondition`, a SECURITY log line and the key marked failed; nothing is adopted, charged, moved or summarised.
    The cashier check is kept.
  - **Accepted consequence:** a cashier who no longer holds the merchant authority cannot resume a committed sale. A
    recovery workflow, if ever needed, is a separate authorised capability.
- **`functions/pos-retail-mirror.js`** refuses a transaction id in the checkout's reserved `ps_` namespace. It logs and
  does nothing else: no mirror, adoption, rewrite, checkout, debt, stock or conflict record. This control is independent
  of the resume check; either alone holds the boundary.
- **`functions/pos-mpesa-refs.js`** (`onPosTransactionMpesaRef`):
  - the merchant is taken **only** from the rule-bound `sellerId` (the same uid namespace as `claimPosMpesaReference`);
  - a `merchantId`/`sellerUid`/`shopId` that names anyone else is refused, with no claim and no conflict, only
    `mpesaRefClaim: 'refused'`, `mpesaRefIssue: 'merchant_mismatch'` on the transaction;
  - a seller who is not a merchant is refused (`not_a_merchant`). "Merchant" is decided by the same authorities the
    checkout uses: `resolveActor`, then the owner of a canonical business. An authority that cannot answer is refused
    (`merchant_unverified`).
  - **Behaviour change (flagged):** the old trigger ignored any transaction without a body `merchantId`, and SmartPOS never
    sends one, so it never claimed a real SmartPOS reference. It now claims them under the seller.
- **`scripts/test-0b-checkout-integrity.js`** (owner-approved fixture sync): the R1-c failed-attempt fixture's id is derived
  through `_idemIdFor`, never hand-written.

**Unchanged:**
- `firestore.rules`, the mirror's mapping, DR-R, `RATE_ERA`;
- wallets, collection, the till gate, payment rails;
- dry-run;
- `test-pos-confirmation-vocabulary.js`.

**Migration:**
- Production holds no `ps_` sales, and this lineage's idempotency records aren't deployed.
- After a deploy, a retry of a pre-deploy key finds no scoped record and falls back to the sale-id resume, which is now checked.

## Evidence

**`scripts/test-pos-6a-checkout-authority.js`** runs the real checkout, mirror trigger and M-PESA trigger on the emulator.
**28/0 new** vs **10/18 old** (`8cc8ce9`). Each attack asserts the refusal, the absence of side effects, and the named
safeguard's own message.

| Family | Checks |
|---|---|
| O (ordering) | an unproven caller cannot claim (no record exists), replay (no sale, no receipt) or resume (no summary, no completed key) |
| I (isolation) | merchant A with V's raw key gets its own sale; V still gets its original; the same raw key gives two scoped records and no global one; a completed record naming another merchant is never returned |
| P (provenance) | mirror record; mirror-sourced record with every checkout field; foreign merchant; foreign key; no proof; non-numeric `soldAtMs` — each refused with no debt, stock, summary or completed key. **Control:** the checkout's own interrupted sale still resumes once, with one debt. |
| R (race) | concurrent same key → one sale, one debt; a failed attempt by one merchant, or by an unproven caller, does not block another |
| M (M-PESA) | the named assertion: *a SmartPOS transaction containing another merchant's merchantId cannot create that merchant's M-PESA reference claim*; nor alter it or write a conflict against it; a non-merchant cannot claim. **Controls:** a genuine claim and a genuine duplicate (conflict). |
| N (namespace) | the mirror mirrors ordinary ids, refuses `ps_` ids, and a refused id is never adopted: the checkout records a real sale there, with debt and stock |
| B (boundaries) | dry-run unchanged; no wallet; gate OFF |

The old tree passes only the controls and the boundaries. Its reds are the defect. M-5 and M-2 are also red there because
the old trigger never claimed a sale without a body `merchantId` (the behaviour change above).

- **Mutants:** 13/13 caught, one per safeguard, each turning its own check red (CHANGELOG 173).
- **Floor:** no summary-line difference across 112 suites; earlier units green (CHANGELOG 173).
