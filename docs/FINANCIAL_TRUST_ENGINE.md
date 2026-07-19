# Financial Trust Engine

**Status:** Analysis complete. No implementation started.
**Date:** 2026-07-19
**Rule Zero:** *No monetary calculation may depend on a client-authoritative value.*

Evidence classes: **VERIFIED** (repository inspection or runtime evidence) · **INFERRED** (logical conclusion from verified evidence) · **UNKNOWN** (insufficient evidence). UNKNOWN is never promoted.

---

## 1. Executive summary

**Rule Zero is violated systemically.** Of **105 monetary fields** audited across 8 money surfaces:

| Class | Count | Share |
|---|---|---|
| **CLIENT AUTHORITATIVE** | **58** | 55% |
| **MIXED** | 17 | 16% |
| **SERVER AUTHORITATIVE** | 26 | 25% |
| **UNKNOWN** | 4 | 4% |

The trust boundary does not exist as a boundary. It exists as roughly forty independent, inconsistent local checks.

**These are not 105 bugs. They are three architectural patterns** (§4).

**The window matters more than the count.** No payment has ever completed, all three `wallets/` documents are zero, no rider has been paid, no payroll disbursed. Every remediation below is a code-and-rules change with **no data to unwind**. That is true today and will not remain true after the first real payment.

---

## 2. The trust model

A monetary value is trustworthy only if **every input to its calculation** is trustworthy. Trust is a property of an input's origin, not of where the arithmetic runs. Moving a calculation server-side while its operands arrive from a browser buys nothing.

| Tier | Examples | Rule |
|---|---|---|
| **Trusted** | Server-derived route distance, server timestamps, config tables, prior server-written state | May determine money |
| **Advisory** | Client-reported distance, client-reported duration, device telemetry | Stored for comparison, **never priced** |
| **Rejected** | `earnings`, `fare`, `amount`, `commission`, `total`, `payout` on a request | Not ignored — **logged as a tampering signal** |

The engine is a **classifier at the boundary**, not a new calculation service. Every money-writing Cloud Function declares its inputs; each resolves through the tier table. An unclassified input is a build failure, not a runtime default — the discipline that makes the commission drift guard work, applied to inputs rather than tables.

---

## 3. Tier 0 — exploitable without a payment rail

"Zero payments have completed" is **not** mitigating for these. Selected highest-severity rows; full matrix in §6.

| # | Field | Evidence | Exploit |
|---|---|---|---|
| 0.1 | eTIMS invoice → live KRA | `rules:245`, `etims.js:754`, `.env:19` | See §5 — **latent, gate holds** |
| 0.2 | `orders.total`, `status:'paid'`, `escrow.held` | `rules:244-246`, `validOrderStatus():80-89` | Forge a paid order at any total. Money keys excluded from every update `hasOnly` list → **the forged figure is then immutable** |
| 0.3 | `cashbackBalance` | `loyalty-enterprise.js:24` `OPT` has **no auth predicate**; `awardCashback:728` | `awardCashback({uid:me, amount:1e9})` — **no `req.auth` check at all** |
| 0.5 | `escrows.sellerNetCents` | `rules:1495-1496` | Create requires only `buyerUid==auth.uid`, **zero field constraints**. Written direct from the browser |
| 0.6 | `posTransactions.total`, line `price`/`qty` | `rules:1765-1770`, `pos-sync.js:204` | Offline replay writes client-composed sales with **no server re-derivation on sync** |
| 0.7 | Manager override / discount authorization | `manager-auth.js` exports only notify/cleanup/token | The Manager Authorization Engine is a **UI gate only**. Skipping the modal is indistinguishable server-side |
| 0.9 | `subscriptions.isTrial` | `sub-billing.js:248,265` | `subActivate({planId:'seller_enterprise', isTrial:true})` skips the payment check on a **client boolean** |
| 0.13 | `withdrawals.amount` | `rules:870-874` | Client creates the doc directly, bypassing the balance check. `ade.js:664` auto-approves under KES 10,000 |

---

## 4. Root cause analysis — three patterns

**R1 — Ownership-only create rules.** `claimsOwner()` (`rules:29-31`) proves *who* is writing, never *what*. Applied to money docs at `orders:245`, `escrows:1496`, `packageRequests:1076`, `deliveries:1183`, `bookings:142`, `entTickets:1125`, `withdrawals:870`, `bookingFees:945`, `posShifts:1794`, `legalCommissions:3810`. `noAdminFields():45-51` blocks `commissionRate` and **no other money key** — it was never a financial control.

**R2 — Cloud Functions that trust the request instead of the record.** A CF-only collection is worthless if the CF took the number from the browser. `recordPayment` (`finos.js:38-47`) reads no order doc. `awardCashback` has no auth check. `processSettlement` (`commission.js:518`) takes settlement amounts from `req.data`. **`allow write: if false` created false confidence platform-wide.**

**R3 — Deny-lists where allow-lists belong.** `hasOnly()` is sound and used correctly on most updates. `hasAny()` at `deliveries:1188` fails open on every field nobody enumerated — `driverNet`, `platformCut`, `distanceKm`.

### Accidental mitigations — undocumented and untested

Three dangerous paths are blocked **by schema mismatch, not design**: client overwrite of server orders (server doc omits `uid`); `sokoni-orders.js:227` persisting `commissionPct ?? 12` — a **fourth commission rate at 4× canonical**, blocked only because its doc omits `uid`; forged `withdrawals` carrying `amount` while `approveWithdrawal` reads `amountCents`. **Each is one field-rename from going live.**

### Corrections to earlier session claims

- `RIDER_EARNINGS_AUTHORITY.md` §7 Q2 says no `driverShare` config exists. **It exists — hardcoded at 88% in two places**: `finos.js:59`, `finos-router.js:183`.
- The commission drift guard's blind spot is worse than recorded: the three inline `* 0.12` sites are display-only as stated, but `sokoni-orders.js:227` is a **fourth site that is persisted**. WHT `* 0.05` is inline in three more (`index.js:619,666,714`).

---

## 5. eTIMS incident — closed as LATENT

| Link | Finding | Class |
|---|---|---|
| Client can create `orders` with `status:'completed'` | `rules:245`, `validOrderStatus():86` | **VERIFIED** |
| `etimsOnOrderCompleted` deployed | `firestore.document.v1.written`, runtime check | **VERIFIED (runtime)** |
| `ETIMS_ENV=production` | `functions/.env:19` | **VERIFIED** |
| Merchant identity from client `sellerUid` | `etims.js` | **VERIFIED** |
| **Authorization gate** | `etims.js:778-779` — returns unless `etimsProfiles/{sellerUid}.status === "active"` | **VERIFIED** |
| **Active profiles in production** | **0 documents, 0 active** — live Firestore query 2026-07-19 | **VERIFIED (runtime)** |

**Verdict: LATENT. The gate holds. Containment is not urgent.** The defect is real — merchant identity is client-supplied, the trigger is live, the environment is live KRA — and it arms the moment the first seller completes eTIMS onboarding. Fix it before that happens, not before the next deploy.

> **Process note.** This was escalated as live third-party legal exposure before the gate at `etims.js:778` was read. Severity must be verified, not assumed — the charter's own evidence standard. Recorded so the error is not repeated.

---

## 6. Required architectural changes

Each extends an existing module. **No parallel systems.**

**A. Close the rules layer** — hours, no code, no migration, highest value per hour. Money-bearing collections to CF-only create: `orders`, `escrows`, `withdrawals`, `bookings`, `entTickets`, `legalCommissions`, `bookingFees`, `posTransactions`, `posShifts`. Convert `deliveries:1188` from `hasAny` to `hasOnly`. Add a `noMoneyFields()` helper beside `noAdminFields():45`. Strip `'paid'`/`'completed'` from `validOrderStatus()` for client creates.

**B. One Order Authority** — a `createOrder` CF re-deriving every line from `products/{id}`, extending `createCheckoutSession` (`index.js:2143-2202`), which already does this correctly for M-Pesa.

**C. Money CFs read the record, not the request** — `recordPayment`, `finosCreateEscrow`, `processRefund`, `createPayment`, `spendFromWallet`, `processSettlement`, `subActivate`, `impactCheckoutDonate` take identifiers only. Reuse `finosIdempotency` and `finos-utils.createLedgerEntry`.

**D. Authorization primitives** — add `_requireAuth`/`_requireRole` to `loyalty-enterprise.js` (currently **zero** in a module that mints value). Tenant-scope all claims. Make Manager Authorization issue a short-TTL signed grant.

**E. Server-derived pricing** — move `sokoni-delivery-pricing.js` server-side as a generated mirror with a drift guard checking **tables and inline arithmetic**. Server clock, server surge, server-measured wait. **Server-derived distance is the prerequisite** — see [[RIDER_EARNINGS_AUTHORITY]].

**F. One Tax Authority** — VAT/WHT constants are duplicated **≥12 times in two units (`0.16` vs `16`) with two incompatible semantics**: `etims.js:173` treats price VAT-*inclusive*, `hub-etims.js:524` VAT-*exclusive*. The same order yields ~16% different tax by route. One effective-dated `tax-tables.js` modelled on `commission-config.js`.

**G. Immutability latch** — no invoice or receipt is protected against post-acceptance mutation server-side.

---

## 7. Implementation sequence

| # | Action | Why here |
|---|---|---|
| 1 | Confirm `invoker:'private'` via `gcloud run services get-iam-policy` | Appears in 4 files of 2,149 `onCall` declarations. Either it neutralises the `recordPayment` mint paths **or** `recordPayment` is dead code. Load-bearing and unproven |
| 2 | **Rules hardening (A)** | Hours, no migration. Closes most of Tier 0 |
| 3 | Auth gates on `loyalty-enterprise.js`; tenant-scope claims (D) | Small, local, no schema change |
| 4 | Payment preconditions: `isTrial`, `providerActivateSubscription`, `impactCheckoutDonate`, `digitalProductPurchase` | Independent of 5 |
| 5 | **Order Authority (B)** | Everything downstream inherits order integrity |
| 6 | Money CFs read the record (C) | Needs 5 for a trustworthy record |
| 7 | Tax Authority (F) + immutability latch (G) | Before any invoice is filed for real |
| 8 | Server pricing + **server distance** (E) | Prerequisite for rider earnings |
| 9 | Rider Earnings Authority | Blocked until 8 |
| 10 | **Repoint IntaSend webhook** | Every Tier-1 row arms at this moment. Last, deliberately |

---

## 8. Unknowns — must not be promoted

- `providerPayouts.amount` producer — `provider-onboarding.js:359` reads it; no writer found.
- `leadFees` / `b2bFees` payload — `rules:1371,1379`; no client write site in repo.
- `posVoids` amount authority.
- ~~Whether `invoker:'private'` is applied at deploy~~ — **RESOLVED 2026-07-19, VERIFIED (runtime).** It is **NOT** applied. Cloud Run Admin API reports `roles/run.invoker` granted to **`allUsers`** on `recordPayment`, `finosCreateEscrow`, `processRefund`, `subActivate` and `intasendWebhook`. Repository and runtime disagree: source declares `invoker:'private'` in 4 files; runtime grants public invoker.

  > `allUsers` on `run.invoker` is the **normal** posture for Firebase callables — the callable protocol validates the Firebase ID token in-code, so this is not unauthenticated access. The consequence is narrower but still decisive: **the mint paths are reachable by any signed-in user, and are NOT mitigated by invoker configuration.** `recordPayment` (`finos.js:38-47`) carries only `_assertAuth` and reads no order document. Its matrix row stands as CLIENT AUTHORITATIVE and reachable.
  >
  > This also answers the second half of the dilemma: `recordPayment` is **not** dead code — it is live and callable.
- Runtime behaviour of every finding — **all are source-read. No exploit was executed.**
- Deployment snapshot for the matrix is 2026-07-12; the 1,446-function figure is 2026-07-19.

---

## Related

[[PRODUCTION_READINESS]] · [[RIDER_EARNINGS_AUTHORITY]] · [[PLATFORM_CONSTITUTION]] · [[RELEASE_VALIDATION_STANDARD]]
