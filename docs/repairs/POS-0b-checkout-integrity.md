# POS batch 0b — checkout integrity (main line)

**Branch:** `pos-safety/0b-checkout-integrity` (from main `f3c6630`) · **not deployed** · served lineage NOT changed
**Owner authorization (2026-09-27):** R1–R5 on main; R4 narrowed to the merchant proven for the sale; tax policy
untouched. The served lineage follows as: merchant-binding repair → then served 0b R4 (served R1/R2/R3/R5 separately).
**Related:** [[POS-0a-card-fabrication]] · census `docs` in the 0b decision packet (2026-09-27)

## Defects (proven by code and by the old-tree run)

| # | Defect | Effect |
|---|---|---|
| R1 | The sale id was random (`uid()`). The sale, the receipt and the daily summary were written AFTER the stock transaction, and a `failed` key was re-claimed and re-run in full. | A late failure followed by a retry produced a second sale and a second stock deduction. Two concurrent re-claims did the same. |
| R2 | The catch released `posPaymentClaims` even after the stock transaction had committed. | One confirmed M-PESA payment could fund a second sale under a new key. |
| R3 | `taxTotal` was taken from the caller with no sign or type check. | A negative tax was an unauthorised discount (a 300 cart sold at 10). A non-number failed AFTER stock had moved. |
| R4 | No product was compared to the merchant the sale was proven for. | A till could price and deduct another shop's stock (single or mixed carts, ownerless products). |
| R5 | `pos-checkout.html` built `merchant_cashier_${Date.now()}` on every press of Pay. | Every retry was a new sale. |

## The repair

- **R1:**
  - `saleId = 'ps_' + sha256(merchantId | idempotencyKey)`.
  - The sale, its receipt and the base daily counters are **created inside** the stock transaction. It first reads the sale document; if the sale already exists it writes nothing.
  - Everything after commit is one resumable step, `_completeCommittedSale`, run by both the first attempt and every retry:
    - the financial trace posts once (the ledger key is unchanged, and the sale is updated in place);
    - the liability is idempotent on the sale id;
    - the money-position counters are applied exactly once, behind a flag on the sale;
    - the metric uses a deterministic id;
    - the receipt is only read.
  - A retry of a committed key, **by the same cashier**, completes that sale before any re-validation.
- **R2:** claims are released **only if nothing committed**.
- **R3:** `taxTotal` must be a finite number ≥ 0.
  - This is not a tax-policy change. It does not decide inclusive versus exclusive, whether 16% applies, which store is the authority, eTIMS, or the VAT-engine `qty` defect. All of those are a separate tax repair.
- **R4:** every product must name an owner, and every owner field must resolve to **the merchant proven for this sale**. The check runs in the pricing read and again inside the stock transaction. Ownerless, malformed and foreign products are refused (fail closed).
  - **shop_actor:** the shop id (which is the owner's uid), plus the business that resolves **from that proven uid**. A stray `businesses/{merchantId}` record grants nothing.
  - **workspace_membership:** the business proven by the membership, plus that business's owner.
  - **Production measurement (read-only, 2026-09-27):** 102/102 products owned; 0 absent, malformed or conflicting; 97/97 have `shopId == sellerUid`; 3 have been sold at the POS, all owned. No product was modified.
- **R5:** `pos-checkout.html` mints one key per sale, keeps it in sessionStorage (the served Merchant V2 pattern) and clears it in `_resetSale()`, which runs on sale finished, voided or parked.

**Database:**
- The sale id is now deterministic.
- Sales carry the new fields `changeDue`, `tendered` and `dailyFinancialsApplied`. `financialPosting` is `pending` until posted.
- `posCheckoutMetrics/{saleId}` replaces a random id.
- There is no migration and no historical document is rewritten.

**API:** callable signatures are unchanged. The new refusals are:
- `taxTotal` not finite or negative (`invalid-argument`);
- a product with no owner, an unreadable owner, or another shop as owner (`permission-denied`);
- resuming another cashier's sale (`permission-denied`).

## Evidence — `scripts/test-0b-checkout-integrity.js`

The suite runs the **real** `posCompleteCheckout` on the Firestore emulator (real transactions and increments), with a clean database for every run. Late failures are **injected**: the real write that marks the key complete throws once. The suite confirms the injection fired after the sale committed. The race is **forced**: a barrier holds both callers past the pre-transaction check.

| tree | result |
|---|---|
| new | **31 / 0** |
| old (`f3c6630`) | **14 / 17 FAIL** |

**Old-tree failures, each for its own reason:**
- a late-failure retry makes 2 sales, with stock 14 instead of 17;
- a forced race makes 2 sales;
- a committed claim is released, and the same M-PESA payment funds a second sale;
- a negative tax sells 300 at 10;
- `true` and NaN tax fail after a sale was written;
- foreign, mixed, ownerless and switched-owner products all sell, as does a product owned by a stray `businesses/{shopId}` owner;
- the membership path sells another merchant's product;
- the Pay key changes on every press.

**Old-tree passes** are the controls, plus the properties that were already true:
- a normal sale;
- a replay of a completed key;
- a genuinely failed transaction releases its claim, and that payment then pays;
- positive tax;
- a liability exists only for committed sales;
- the membership path sells its own products;
- own-product carts;
- a new sale gets a new key.

**Mutation check** (one fix reverted at a time, in scratch copies):

| Reverted | Red |
|---|---|
| deterministic id | R1-b, R1-c, R1-c2 |
| in-transaction existing-sale guard | R1-c2 (the losing concurrent caller no longer receives the committed sale) |
| claim kept after commit | R2-a, R2-b |
| tax bound | R3-a (non-number tax is also stopped inside the transaction) |
| in-transaction ownership check | R4-d |
| both ownership checks | R4-a–d, R4-f, R4-W2 |
| R4 narrowing (re-accepting the owner named by `businesses/{merchantId}`) | R4-f |
| stable key | R5-a |
| pricing-read ownership check | none: defence in depth; the in-transaction check produces the same refusal |

## Regression floor (40 local suites, new vs old)

Six suites were excluded because they reference gcloud, Google APIs or production: `certify-d1d2-daraja-retirement`, `certify-intasend-webhook-retirement`, `merchant-launch-gate`, `rc1-production-verify`, `test-merchant-v2-ecosystem-runtime` and `test-receipt-contract`.

**39 of 40 are identical to old.** The one difference is the expected tripwire below.

**Five former regressions, now resolved under owner authorization.** The tests were changed to encode the new invariants, not weakened:
1. **`test-pos-gate-behavioural`:** fixture `P1` now names its owner (the merchant under test). The gate assertions are unchanged. **32/0 on new, and 32/0 on old with the owned fixture**, so the change does not depend on 0b.
2. **`test-cashier-identity-map` (control):** now asserts the transactional form: deterministic `_saleIdFor`, `posRetailSales/{saleId}` created via `txn.create(saleRef,…)`, and the existing-sale guard.
3. **`test-merchant-ecosystem-convergence` ("TILL creates posRetailSales"):** the same invariant.
4. **`test-pos-gate-enforcement` C3:** "later in the file" is replaced by the property itself: the liability is recorded ONLY in `_completeCommittedSale`, and every call of it is behind `_committed = true` after the sale-creating transaction, or after `_prior.exists`. The runtime counterpart is C-L1/C-L2.
5. **`test-catalogue-canonical-migration`:** **not edited.** Its "pos-zero-friction … untouched" check is the **expected tripwire** for this authorized change, the same treatment as 0a's D4-1.

**Validity of the updated checks:**
- Run against **old** code, checks 2, 3 and 4 **fail**, because old code lacks the invariant.
- Against mutated new code they turn red whenever the guard, the in-transaction create, the deterministic id or the commit gate is removed, or the liability is moved before commit.

**Other observations:**
- `certify-pos-payment-ownership` shows one fewer failure line on new (T5-6). T5-6 inspects the *uncommitted* diff of `pos-zero-friction.js` for another agent's historical pending block, and the uncommitted 0b diff happens to satisfy it. It returns to its old result once the tree is clean. T5-1 ("not staged") reads differently only while the file is staged. Neither concerns behavior.
- Suites failing on both trees fail on **identical lines**: daraja-ui 2, p3a 5, function-registration-provenance 1, employee-authority-map 5, ecosystem-convergence 1, merchant-routes 2, pos-customer-scope 18, pos-sale-attribution 1 and receipt-number-authority 1.

**Gates:**
- `predeploy-syntax-gate`: "2092 JavaScript files and 465 inline <script> blocks parse cleanly", exit 0.
- `gate-functions-require-closure`: "391 modules reachable, unresolved NONE, PASS", exit 0. This gate reads the HEAD tree, so it must be re-run after the commit. 0b adds no new local require, only the builtin `crypto`.

## Boundaries

- **Not done here:**
  - the served lineage, whose merchant-binding repair must precede served R4;
  - tax policy, the VAT `qty` defect and coupon reconciliation;
  - `pos-v2`'s offline classification, the stale-processing TTL and `PosSales.park`.
- **Not deployed.**
- The idle `sok-fn-cand` and `sok-printer` changes to `pos-zero-friction.js` (another agent's uncommitted authority work) are untouched and will conflict textually if landed.

## L-4 port onto the POS lineage (2026-09-28)

Batch 0b was certified on the main line (96d31e4). This section records its port onto the POS
lineage that descends from the live build (53ff924 → P0 → M0-1 → M0-2 → M0-3 → R-48H → L-1 → L-2 →
L-3, base `c7b8d39`). It is reconciliation unit **L-4** — see [[FINANCIAL_CORE_ARCHITECTURE]] (the
reconciliation order is recorded with the L-units in CHANGELOG 159–162) and [[POS_CHECKOUT_CONVERGENCE_DESIGN]].

- **How it was ported.** The 0b changes to `functions/pos-zero-friction.js`, `pos-checkout.html` and
  the four tripwire suites apply to this lineage **three-way, without conflict**: P0 and M0-1 touched
  regions of `pos-zero-friction.js` that 0b does not rewrite. Nothing from the Q0 chain was carried.
- **The served-R4 precondition holds here.** The boundary above says the merchant binding must
  precede R4. This lineage already has it: before `merchantId` is used, the caller is proven through
  `resolveActor` (`shop_actor`) or a canonical `sales` membership (`workspace_membership`), or refused.
  R4 builds its owner set from exactly that `_provenBy`.
- **Preserved, and re-proved by their own suites:**
  - P0: `enforceSaleGate`, `GATE_ENFORCED=false`;
  - M0-1: one debt per sale, `posCommissionLiabilities/poscomm_<saleId>`, and its ledger projection written
    with it. **Checkout posts no ledger entry of its own.** The stale 0b comment claiming a
    `'poscomm_'+idempotencyKey` ledger entry was corrected. That was never true on this lineage;
  - M0-2 and M0-3;
  - the live `assertConfirmable` payment check;
  - L-1, L-2 and L-3.
- **Test fixtures adapted to this lineage.** The assertions are unchanged:
  - C-L1 reads the debt at `poscomm_<saleId>` (M0-1's key);
  - R2's `posPayments` fixtures are the IntaSend QR shape that `pos-qr.js` writes: `transactionId` equal to the doc id,
    `sellerId`, and `status: 'paid'`. This lineage refuses a Daraja `completed` document outright.
    Before this change, R2-c passed for the wrong reason (`unknown_shape`). It now fails on "Insufficient stock", as designed.
- **Evidence:** 31/0 on the port vs 14/17 on `c7b8d39`, the same profile as the main-line
  certification. The mutant results match the main line, and `R1-random-id` now also turns R1-b2 red. The only survivor is
  still the pricing-read ownership check (defence in depth, above).
- **Not deployed.**

### L-4 floor: 112 suites, `c7b8d39` vs the port

The summary lines are identical except for `test-merchant-sell-ui`. Every full-log difference is classified:

- **Caused by L-4, analysed:**
  - **`audit-financial-safety`:** 1 new V3 at `pos-zero-friction.js:394` (12 → 13 non-baselined; the rest of the
    file is unchanged). **This is a false positive.** V3 is a 7-line text window, and here it sees `idemRef`, the
    *receipt* read's `get()`/`exists` and the completion marker
    `idemRef.set({status:'complete'})`. The key claim is the atomic `idemRef.create()`, and a
    repeated completion writes the same values. The base's one `@financial-safe` site (the counters
    guarded by that claim) is gone, because those counters now run in a transaction behind
    `dailyFinancialsApplied`. That is why the count moved from protected 79 to 80 and annotated from 2 to 1. `--ci` exits 1 on both trees.
    **Owner adjudication (2026-09-28): observed by auditor; adjudicated false positive; no
    production-code weakening and no baseline mutation.**
  - **`test-pos-sale-attribution`:** the check still passes, but its extractor has lost its scope. It slices from `const sale = {`
    to the next `db.collection('posRetailSales')`, and 0b removed that call. The slice now runs to the end of the file
    (3,497 → 35,291 chars), so its positional checks no longer isolate the sale literal. Every property was
    re-checked on the brace-matched literal and holds on both trees:
    - `sellerId` is derived from `merchantId`;
    - it is written after `...metadata`;
    - no identity field is read from metadata;
    - the shift is derived.

    The detector is **not** edited (it is a tripwire).
    **FOLLOW-UP (owner, 2026-09-28):** restore the extractor's scope to the sale literal as a separate
    test-harness unit, outside L-4.
  - **`test-pos-gate-behavioural`:**
    - the owned fixture sales now reach `completed`, where the base reached `internal`;
    - the gate assertions and results are identical.
- **Intentional 0b tripwire changes:**
  - `test-cashier-identity-map` (CONTROL relabelled, passes);
  - `test-pos-gate-enforcement` C3 (property form, passes), with A5/G1 byte offsets moved;
  - `test-merchant-ecosystem-convergence` (identical output).
- **Expected catalogue-migration tripwire:** **not applicable on this lineage.**
  `scripts/test-catalogue-canonical-migration.js` does not exist here (ABSENT on both trees), so the
  main line's expected red cannot occur. Its absence is recorded here, not treated as a pass.
- **Artifacts of the uncommitted tree** (they clear after a commit):
  - `merchant-launch-gate`: "working tree clean", 8 paths;
  - `rc-manifest`: changed paths listed;
  - `certify-pos-payment-ownership` T5-6: reads the uncommitted diff, as on the main line.
- **Flaky or environmental:**
  - `test-merchant-sell-ui`: the old run crashed launching WebKit; rerun on old, 108/0, identical to new;
  - `certify-stk-narrative`: known flaky on both trees, with different failing checks;
  - `test-merchant-v2-ecosystem-runtime`: known browser/network FAIL on both; new adds a `gstatic generate_204` page error;
  - `test-approval-activates-shop`, `test-healthcare-admin-approval`, `test-healthcare-provisioning`: random ids and temp paths only.
- **Unexplained:** none.
