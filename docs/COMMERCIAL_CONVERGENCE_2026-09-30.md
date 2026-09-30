# SOKONI Commercial Convergence — subscriptions · commission · invoices (2026-09-30)

**Status:** BUILT LOCALLY, CERTIFIED LOCALLY, **NOT DEPLOYED**. Production traffic is unchanged: `webhookintasend-00068-del` (containment floor, 5% schedule) still serves; live hosting still serves the 3% snapshot.
**Branches:** functions — `convergence/commercial-fn-on-ef1e992` (`C:/temp/sok-conv-fn`, base = `slice/c4-category-matrix` @ `ef1e992`, the lineage that holds the 2026-09-28 commission authority `5db1540`); hosting — `convergence/commercial-web-on-18e3711` (`C:/temp/sok-conv-web`, descends from live `b108ae3`/v647).
**Containment:** frozen and untouched — see `docs/backups/incident-2026-09-30/EVIDENCE-PACKAGE.md`. Nothing here modifies `recovery/webhookintasend-on-2026-09-06`.

Related: [[COMMISSION_ENGINE]] · [[COMMISSION_INVOICE_SPEC]] · [[SUBSCRIPTION-WRITERS]] · [[SUBSCRIPTION_STATE_MACHINE]] · [[CANONICAL_MONEY_VERSION_DECISIONS]] · [[POS_WALLET_COMMISSION_CONTRACT]]

---

## 1 · What the census found (read-only, before any code)

| question | finding | evidence |
|---|---|---|
| Where do the subscription plans live? | **One executable authority:** `functions/sub-billing.js` `PLANS` (31 plans, prices in cents). `subscriptionPlans/*` Firestore docs: **0 in production** (`_resolvePlan()` merges them if present). `subscription-catalog.js` is the *entitlement* catalogue (4 packages), not a second price list. | prod read 2026-09-30; `sub-billing.js:48` |
| Which lineage is production for subscriptions? | **Hosting** (`18e3711` side). Every live `sub*`, `adminSub*`, `subscriptionPaymentMethods`, `payIntentWithWallet`, `onPaymentIntentPaid`, `reconcileSubscriptionPayment`, `onAiSubscriptionChangedSyncLimit`, `merchantIdentity` was built 2026-09-09 from it. c4 (`ef1e992`) had 0 commits on `sub-billing.js`, `subscription-os.js`, `subscription-pay-methods.js` since the merge-base `3dcf572`; c4's `index.js` never exported four of the live functions. | `gcloud functions list`; `git rev-list` per file |
| Which lineage is authoritative for commission? | **c4** — `5db1540` (2026-09-28, owner schedule) + `shared/commercial-policy.js`; `creator-commercial.js` **exists** on the c4 tip (the earlier "missing on every lineage" was true of `5db1540` alone). | `functions/commission-config.js`, `functions/shared/*` |
| Does c4's table equal the owner's 2026-09-28 table? | 20 of 22 rows yes. **`property` 2% (owner: KES 5,000 flat)** — left "unchanged" by the 09-28 implementer and pinned by `test-commission-5pct-agreement.js`. **`hub`/`delivery` 12%** — a second, stale authority; `delivery-quote-authority.js` already settles 17–25%. | `resolveRate()` comparison |
| Is the POS contract recorded? | **Yes — ABSOLUTE.** 2026-09-06 `932ee22` ("immune to per-seller overrides"), 2026-09-26 `CANONICAL_MONEY_VERSION_DECISIONS.md` ("fixed-rate bypass of every override and plan adjustment, `pricingSource: 'fixed_rate_category'`"), 2026-09-28 `5db1540` ("POS decoupled from online sales", flat 5% on every plan, the 15/10/5/0 ladder "COUNTERMANDED"). The 2026-09-15 `POS_WALLET_COMMISSION_CONTRACT.md` D2 ladder is the superseded record. c4 had the flat lane but **had dropped the bypass guard** (`isFixedRateCategory`), so `commissionRules` / `revenueConfig` could still re-price a till sale through `finos-utils.calculateCommission`. | code + docs |
| Provider-booking plan ladder 20/15/10/7/5? | **No executable authority exists on any branch.** Only comments (`finos-utils.js:365`, `provider-ops.js:120`: Free 20 / Starter 15 / Professional 10 / Business 7 / Enterprise 5). `subscription-core.ROLE_DEFAULT_COMMISSION.provider = 0.20`; production subscription docs carry **no** `commissionRate`; `PLANS.features.commission_pct` on c4 said 10/7/**4**. Two records, two mappings → **conflict, not encoded** (§4). | grep all branches; prod read |
| Subscription → invoice? | **Nothing produced one, on any lineage.** The only platform-invoice implementation is `etims._issuePlatformInvoice` (KRA-fiscalised, fee type `subscription` supported, reachable only via the admin callable). `revenueConfig/commission_vat` **absent** in production; `platformInvoices` empty. | `etims.js:1113`, prod read |
| Client copy | 21 hard-coded rate lines in 12 hosting files; `subscriptions.html` (41 inbound links) carried its own plan table and a 26-row rate table matching no authority. | grep on `18e3711` |

## 2 · What was built (functions branch)

**`67810a0` — commission authority.** `FIXED_RATE_CATEGORIES = ['pos']` + `isFixedRateCategory()` restored in `commission-config.js`; `finos-utils.calculateCommission` takes `RATES.pos` and nothing else for the lane (rules / revenueConfig / subscription rate / marketplace ladder / plan adjustment bypassed **and not read**), recording `fixedRateCategory`, `overrideIgnored`, `planSkipped: 'fixed_rate_category'`, `pricingSource: 'fixed_rate_category (universal rule, overrides bypassed)'`. `property → { pct: 0, fixedKES: 5000 }`. `hub → 17` (floor of the quote authority's 17–25%; test pins `SHARE_MIN_PCT === RATES.hub.pct`). Snapshot regenerated (local).

**`843bd17` — subscription authority + subscription invoice.** Hosting's files taken where c4 never moved (`sub-billing`, `entitlement-authority` (new here), `subscription-pay-methods` (new here), `subscription-os`); clean three-way merges where both moved (`product-limit`, `payment-intents`, `ai-subscriptions`, `automation-engine`); `subscription-catalog` merged by hand (see §3). `index.js` registers the four live payment-methods functions. New `subscription-invoice.js` (§2.1). Hooks in the three activation writers. `commission-vat-policy.js` parameterised.

**`5fcaf50` — snapshot binding.** `sokoni-commission-rates.js` renders `[data-sokoni-rate]` from the authority (`—` when unknown); re-runs after `refresh()`.

### 2.1 The subscription invoice authority

```
payments/{ref} COMPLETE, meta.purpose 'subscription'      (webhook path → subAutoActivateOnPayment, subActivate)
paymentIntents/{ref} 'paid', purpose 'subscription'        (intent rails  → reconcilePaidIntent)
        │  amount READ from the finalized record — never recomputed, never from a caller
        ▼
finosIdempotency/sub_invoice_{ref}   transactional claim: issuing → issued | deferred | failed (retryable, stale after 10 min)
        ▼
etims._issuePlatformInvoice({ feeType:'subscription', reference: ref, vatInclusive: <policy> })   engine key platform-subscription-{ref}
        ▼
etimsInvoices/{id} → platformInvoiceId on the source record and on billingHistory
```
Invariants: amount from the record; **invoicing never gates entitlement** (a failure leaves the subscription active and the claim retryable); **VAT never inferred** — `revenueConfig/subscription_vat` unset ⇒ `deferred`; `subIssuePendingInvoices` (daily) retries deferred/failed claims; `subIssueInvoice` (admin) re-issues one reference; one invoice per reference under concurrent writers.

## 3 · Decisions applied vs decisions surfaced

**Applied because the record exists**

| decision | record followed |
|---|---|
| POS absolute (bypass restored) | 09-06 `932ee22` · 09-26 canonical decisions · 09-28 `5db1540` |
| property KES 5,000 flat; delivery 17–25% | owner schedule 2026-09-28 (the brief) + `delivery-quote-authority.js` |
| catalogue vocabulary `FREE / PROFESSIONAL / BUSINESS / ENTERPRISE` | owner 2026-09-13 canonical packages (`commission-config.js`), consumed by 25 modules; production's `STARTER/GROWTH` ids kept as aliases, AI family mapped (`ai_starter → PROFESSIONAL`, `ai_pro → BUSINESS`), `trial → FREE` |
| subscription revenue = platform revenue, never marketplace commission | `RATES.subscriptions = 100`, `subscription`/`healthcare_subscription` aliases; a subscription buys capabilities (marketplace rate is flat 15%, POS flat 5%) |
| `booking_cycle` fail-closed (c4) and paid-vs-promotional trial (hosting) both kept | both are money fixes; neither lineage had both |

**Surfaced — owner decision required before deployment**

1. **FREE listing allowance:** production/hosting **10**, c4 catalogue v3 **50** (its own comment records production counters at 10 and an owed backfill). Kept 50 locally; ported suites read the catalogue value rather than a literal. Deploying either number changes what free merchants may list.
2. **Provider-booking plan ladder:** owner says 20/15/10/7/5 "continue"; no executable table exists; two recorded mappings disagree (comments: Starter 15 / Professional 10 / Business 7 / Enterprise 5 vs `PLANS.features`: starter 10 / pro 7 / business 4). Today providers pay the role default (20%) unless a subscription doc carries `commissionRate` — none in production does. **Not encoded.** Needs the plan-id → rate mapping in writing.
3. **VAT treatment** for commission (`revenueConfig/commission_vat`) **and** subscriptions (`revenueConfig/subscription_vat`): both unset; both invoice paths defer/refuse until written `{ enabled: true, inclusive: <bool>, decidedBy }`. (The admin callable `etimsPlatformInvoice` defaults non-commission fee types to inclusive — "preserved prior behaviour"; the automated path deliberately does not inherit that default.)
4. **eTIMS platform credentials** (`ETIMS_PLATFORM_PIN/SECRET`) must be present for any platform invoice to issue; the e2e stubs the engine at exactly this boundary.
5. **Rival subscription writer in this index:** on c4's `index.js`, `intasendWebhook` / `webhookMpesa` still activate subscriptions directly; the hosting/production line stamps the intent PAID and lets `reconcilePaidIntent` be the writer. Porting that hunk is a deployed-money-path change on a P0-4-gated function — not done here (`test-subscription-pay-methods` 67/71, the 4 are exactly these text checks).
6. **`merchant-identity.js`:** two lineages, 7 conflicts, an open provenance gap (`docs/PROVENANCE_GAP_MERCHANT_IDENTITY.md`). Not merged; c4's copy already exposes `_internal.linkedUids`, so `entitlement-authority`'s cross-account resolution works.

## 4 · Parity matrix (what must be equal before publication)

| surface | value now | after this release |
|---|---|---|
| `webhookIntasend` (00068-del) | 09-06 config: marketplace 5, POS 5 absolute | unchanged until its own gated redeploy from the converged tree |
| `previewCommission` (08-30) / `getCommissionConfig` (08-22) | 5% / **3%** | 15% / 15% (same file) |
| `functions/commission-config.js` on both branches | identical | identical |
| `sokoni-commission-rates.js` on both branches | **byte-identical**, `--check` in sync on both trees | published with hosting **only after** functions |
| client copy | reads `SokoniCommission` / `data-sokoni-rate` | — |
| `subscriptions.html` plans | `subGetPlans` | — |

**Publication rule (brief §12):** deploy order is functions first (`getCommissionConfig`, `previewCommission`, `createCheckoutSession`, `onSellerPaymentCreated`, the `sub*` set, `subIssuePendingInvoices`, `subIssueInvoice`), each through the per-function live-archive content diff (`reference_functions_lineage_gate`), then hosting. Hosting first would advertise 15% while the server returns 3%.

## 5 · Evidence (all local, 2026-09-30)

Commission: `test-pos-fixed-rate-bypass` **20/0** (new) · schedule 25/0 · agreement 62/0 · lane-separation 22/0 · pos-lane 92/0 · pos-sale 78/0 · KASS 7/0 · settlement 53/0 · healthcare-plan 16/0 · single-source PASS (both trees) · delivery-engine-sync PASS · snapshot `--check` PASS (both trees).
Subscriptions (Firestore emulator, real handlers): **`test-subscription-invoice-e2e` 23/0** — duplicate callback → 1 activation, 1 invoice, 0 extra engine calls; VAT unset → active + deferred, sweep issues once armed, second sweep issues nothing; intent rail 1 invoice, replay no-op; two writers racing → 1 invoice · entitlement-authority 79/0 · trial-activation 43/0 · paid-trial-boundary 82/0 · writers 24/0 · pay-methods 67/4 (§3 item 5) · identity-chain 23/0 · entitlement-adapter-period 36/0 · entitlement-digital 15/0 · entitlement-subscription 45/0 · free-entitlement 100/0 · healthcare-subscription-foundation 120/0 · payment-intents 12/0 · product-counter-reconciliation 34/0 · product-payment-authority 25/0 · catalogue-canonical-migration 47/0 · connect-authority 858/0.
Pre-existing on pristine `ef1e992`, unchanged: `test-commission-48h-destinations` (3), `test-subscription-commission-classification` (fixture predates `5db1540`), `test-marketplace-plan-ladder` (17) and `test-merchant-package-convergence` (10) — both pin the retired 16/12/8/4 ladder, `test-post-pin-money-chain` (7), `audit-commission-paths` (2 independent calculations in `money-authority` / `creator-royalty`).

## 6 · Not done, deliberately

Business End / merchant workspace subscription entry (`merchant-v2.html` reads `getMerchantEntitlements`; no plan purchase surface exists there — the purchase surfaces are `plans.html` and `subscriptions.html`, both now on the authority); Marketing Hub boosts already price server-side (`createPaymentIntent` purpose `marketing_boost`) and record no commission — no change; refunds of subscriptions (`adminSubProcessRefund`) untouched — a refund does not credit-note the fiscal invoice automatically (KRA credit notes are a separate eTIMS flow); `intasendWebhook` retirement, Daraja, POS release, provider settlement — out of scope by the brief.


---

## 7 · Second pass (2026-09-30, later) — gap closure before any deployment

Owner brief: close the commercial decisions and test-contract mismatches; rewrite historical tests to the current contract, never weaken the authority; no deploy. Both branches remain unpublished.

### 7.1 Provider commission ladder — ENCODED, keyed by plan id

`commission-config.PROVIDER_PLAN_RATES` (owner schedule 2026-09-28, 20 / 15 / 10 / 7 / 5):

| plan id (`sub-billing.PLANS`) | display | rate | note |
|---|---|---|---|
| `provider_free` | Provider Free / Free Trial | **20%** | default for unknown, inactive or absent plans (highest, fail-closed) |
| `starter` | Starter | **15%** | |
| `pro` | Pro / Professional | **10%** | |
| `business` | Business | **7%** | |
| `enterprise` | Enterprise | **5%** | |
| `provider_basic`, `provider_pro` | legacy ids | 20%, **flagged `legacyUnmapped`** | no row in the owner schedule, **0 production subscriptions**; owner mapping required before either is sold |

Alternate mappings removed: `subscription-core.getCommissionRate(uid,{role:'provider'})` now delegates to `resolveProviderRate(planId)` — a subscription document's `commissionRate` field and `ROLE_DEFAULT_COMMISSION.provider` no longer price a provider booking; `PLANS.features.commission_pct` (10/7/4) no longer exists on the merged `sub-billing.js`; the prose ladders in `finos-utils` / `provider-ops` are now descriptions of this table, not sources. Provenance on every engine result: `providerPlan`, `providerPlanMatched`, `providerPlanLegacyUnmapped`, `providerRateSource`. Snapshot exposes `providerPct(planId)`.
Chain proven (`test-provider-plan-ladder.js` 26/0): plan id → authority → `calculateCommission` (the function `previewCommission` and the webhook use) → ledger row → `commission-invoice.issueForReceivable` issues **exactly** the engine amount (never recomputed) → invoice description states the plan rate. No KES 10 floor on the lane (KES 20 booking at 5% = KES 1), unchanged.

### 7.2 FREE listing allowance — RESOLVED by record: 50

Owner ruling **2026-09-08, commit `c1d8ea1`**: "FREE 50 / STARTER 100 / GROWTH unlimited / ENTERPRISE unlimited (was 10 originally, 100 for the beta, settled at 50)". The c4 catalogue (`CATALOG_VERSION 3`: FREE 50 / PROFESSIONAL 100 / BUSINESS −1 / ENTERPRISE −1) **is** that ruling; production's 10 is the v1 value the backfill never moved past. Catalogue, `entitlement-authority`, `product-limit` and the ported suites all read the catalogue value (no literal). Deployment consequence: `productCounters` at 10 rise to 50 on the next subscription change per account or via `scripts/backfill-product-counters.js` (owed since 09-07; not run here — a production write).

### 7.3 VAT — production prerequisite, deliberately not invented

Both `revenueConfig/commission_vat` and `revenueConfig/subscription_vat` are absent in production. Nothing in either branch supplies a default: `commission-invoice` **refuses**, `subscription-invoice` **defers** and the daily sweep issues once the policy exists. Proven: VAT configured → issued (e2e A, D); VAT absent → active + deferred → sweep issues **exactly once** and a second sweep issues nothing (e2e C). The two documents `{ enabled: true, inclusive: <bool>, decidedBy, decidedAt, reference }` are an owner/tax decision to be written before the first invoice — the effective source should be the advisory reference recorded in `reference`. Note for that decision: the admin-only `etimsPlatformInvoice` callable still defaults non-commission fee types to inclusive ("preserved prior behaviour"); the automated path does not inherit it.

### 7.4 Subscription writer matrix — ONE state transition

| writer | file | operation | can activate | can renew / extend | authority after this pass |
|---|---|---|---|---|---|
| `reconcilePaidIntent` | `subscription-pay-methods.js` | paid intent → `subscriptions/{uid}` | **yes** | no | **THE activation authority** (transaction, exactly-once, period via `subscription-period`) |
| `onPaymentIntentPaid` (trigger) | same | fires the above on `paymentIntents/{ref}` → paid | via authority | — | caller |
| `payIntentWithWallet` | same | wallet debit → intent paid | via authority | — | caller |
| `webhookIntasend` (this index) | `index.js` | **now stamps the intent PAID only** | ~~yes~~ → via authority | — | caller (was rival #1) |
| `activateSubscription` (legacy callable, live 08-22) | `index.js` | **now stamps + calls `reconcilePaidIntent`** | ~~yes~~ → via authority | — | caller (was rival #2) |
| `healSubscriptionEntitlement` (reconciliation backstop) | `payment-reconciliation.js` | **now stamps + calls `reconcilePaidIntent`** | ~~yes~~ → via authority | — | caller (was rival #3) |
| `subActivate` | `sub-billing.js` | client-initiated purchase / upgrade after verified payment → `subscriptions/{subId}` (hub-scoped document model) | yes | upgrade | **second document model** — the Subscription Engine's own store; period via `subscription-period`; trial claim via `entitlement-authority` |
| `subAutoActivateOnPayment` | `sub-engine.js` | renewal payment COMPLETE → extend `subscriptions/{subId}` | no (needs existing doc) | **yes** | renewal authority for the engine's store; period + grace via `subscription-period` |
| `subScheduleRenewals` / `subRetryFailedPayments` / `subProcessExpirations` / `subSendRenewalReminders` | `sub-engine.js`, `sub-billing.js` | status transitions (past_due, grace, expired), renewal payment creation | no | no (state only) | engine lifecycle |
| `adminSubManualAction` | `sub-billing.js` | admin activate / expire / extend | admin | admin | operator path, audited |
| `entitlement-adapters` (`activate`, `revoke`) | `entitlement-adapters.js` | shadow / healthcare adapter | shadow-only for subscriptions | — | not a live writer for subscriptions (comment: SHADOW-ONLY) |

Result: the intent rail has **one** writer (`reconcilePaidIntent`); every other intent-based path is a caller. `test-subscription-pay-methods` 71/0 (was 67/4). What remains is the **two document models** (`subscriptions/{uid}` intent rail vs `subscriptions/{subId}` engine store) — a pre-existing architecture, out of this pass; both now share one period arithmetic and one invoice authority.

**Period arithmetic** — one copy, `functions/subscription-period.js` (calendar month / year, grace 14/7/5/3). Six writers had six copies; `subscription-pay-methods` alone counted 30/365 **days** (a February purchase got 30 days, a leap-year annual got one day less). Converged on calendar months, what the plan is sold as; the pay-methods suites' 30-day assertions now read the module.

### 7.5 merchant-identity.js — converged by evidence: c4 is the authority, hosting's copy excluded

| question | answer |
|---|---|
| production implementation | hosting-side file, built 2026-09-09 (`merchantIdentity`, `employeeSaleAuthorize`, `adminLinkMerchantAccounts` all live from it) |
| c4 implementation | same three exports; 3 later commits: **`1ce3fcd` 2026-09-20 "a removed shop employee could still sell — the till now consumes the contract"**, `3edaa5b` 09-29 availability, `2f4fc20` 09-15 |
| behavioural difference | hosting keeps a private `ACTIVE_EMPLOYMENT`/`_employmentActive` predicate over a `status` field **no writer writes** (so a removed employee remained active); c4 removed it and consumes `shop-employees.employeeRecordReasons` — the recorded security fix ([[project_shop_employee_removal_fails_open]]) |
| consumers | `entitlement-authority` (`_internal.linkedUids`, optional), `kasshop.js`, `pos-zero-friction.js` — all satisfied by c4's superset `_internal` (`resolveActor`, `shopIdentity`, `linkedUids`, `merchantLink`, capabilities) |
| security implication | production is **behind** the 09-20 fix; deploying c4's file closes it. Merging hosting's older predicate back would reopen it |
| final authority | **c4's `merchant-identity.js`** (this branch). The `PROVENANCE_GAP` doc's rule stands: the callables are registered by this index (`exports.merchantIdentity = _shopEmployees.merchantIdentity`) — no export was hand-added |

### 7.6 Historical suites — disposition (rewritten to the current contract, none skipped, none weakened)

| suite | failure | old contract | current contract | disposition | now |
|---|---|---|---|---|---|
| `test-commission-48h-destinations` | 3 | Daraja STK (`processrequest` ×2), `CENTRAL_MOR` credential branch, a literal `status: VERIFIED` form | Daraja outbound **retired**, IntaSend is the rail; staging never promotes `activeDestination` | asserts **zero** STK calls + IntaSend present, no `CENTRAL_MOR`, staging body has `PENDING_TEST` and no promotion | 87/0 |
| `test-marketplace-plan-ladder` | 17 | 15/10/5/0 ladder | flat 15% every package; POS own category; services own rate | tables → 15; lane (till vs online) is the live-harness control | 40/0 |
| `test-merchant-package-convergence` | 10 | 16/12/8/4 ladder, healthcare 5, marketplace fallback 5 | flat 15; healthcare 12; category == package rate | expectations + sabotage anchor updated | 77/0 |
| `test-post-pin-money-chain` | 7 | ladder | flat 15; lane moves settlement | tables + F1 control rewritten | 39/0 |
| `test-subscription-commission-classification` | 3 | "exactly one key changed since `659a350`" | C2 change in force; **no key lost** to default | fixture assertion → durable contract | 21/0 |
| `test-subscription-writers` | 1 | `PERIOD_DAYS` literal | one period module | rewritten | 24/0 |
| `test-subscription-pay-methods` | 4 → 2 → 0 | two hosting webhook names | every subscription-capable webhook stamps; zero activation sites | name-agnostic | 71/0 |

### 7.7 audit-commission-paths — every occurrence classified

| site | class | why |
|---|---|---|
| `money-authority.js` `planSaleAccounting` | **legitimate calculation** (annotated `@commission-safe`) | `rateFraction` is supplied by `commission-config.resolvePosRate / resolveMarketplaceRate`; it holds no percentage |
| `shared/creator-royalty.js` split | **legitimate calculation** (annotated) | basis points from `shared/creator-commercial` (Creator Hub 30/70 policy), exposed to the authority via `shared/commercial-policy.creator_ppv` |
| `index.js:796` analytics estimate | annotated exception (pre-existing) | moves no money |
| 10 allow-listed tables (`verify-commission-single-source`) | non-commission rate tables | tax constants, plan catalogue, subscription-core seam |
| `subscription-core.ROLE_DEFAULT_COMMISSION` | **stale for `provider`** (unreachable: provider now resolves via the authority); other roles unconsumed | documented; removal is a follow-up, not a live path |

`audit-commission-paths`: 0 independent calculations remain. `test-commercial-facts-invariants.js` (new, 22/0) asserts the closed set: one rate table, no provider table outside the authority, one period module, invoice modules never compute, index webhooks/callable hold no `subscriptions/{uid}` writer.

### 7.8 Hosting gate (evidence only)

`predeploy-syntax-gate` on `convergence/commercial-web-on-18e3711`: 1,795 JS files + 454 inline blocks parse cleanly. Not deployed.

### 7.9 Final invariants (release gate §9) — proven locally

* **payment amount = finalized transaction amount = invoice amount**: e2e A/D (999 → `lastPaymentAmountCents` 99900 → `billingHistory.amountCents` 99900 → engine `amount` 999); facts 1a–1c for every commission lane (engine → ledger → invoice equal to the cent, flat fees carried as fees).
* **commission in finalized transaction = commission on invoice = commission in reporting**: the ledger row is the reporting record (`commissionPct`, `commissionCents`, `grossAmount`) and the invoice module reads it without arithmetic (facts 1b, provider D1–D3).
* **subscription payment = platform revenue = subscription invoice = entitlement activation amount**: `RATES.subscriptions = 100`; e2e A (activation and invoice from the same record); `createPaymentIntent` prices only from `PLANS` (facts 2a–2c).

### 7.10 Deployment matrix — for approval, nothing executed

| step | what | gate | state |
|---|---|---|---|
| 0 | owner writes `revenueConfig/commission_vat` + `subscription_vat`; confirms `provider_basic`/`provider_pro` mapping (or retires the ids); confirms FREE 50 rollout (backfill) | decisions | **OPEN — owner** |
| 1 | Functions, from `convergence/commercial-fn-on-ef1e992`, **one at a time, scoped `--only functions:NAME`**, each after the live-archive content diff: `getCommissionConfig`, `previewCommission`, `createCheckoutSession`, `onSellerPaymentCreated`, the `sub*` / `adminSub*` set, `subscriptionPaymentMethods`, `payIntentWithWallet`, `onPaymentIntentPaid`, `reconcileSubscriptionPayment`, `activateSubscription`, `onAiSubscriptionChangedSyncLimit`, `subIssuePendingInvoices`, `subIssueInvoice`, `runDailyReconciliation` | `reference_functions_lineage_gate`; Ready=True per revision; peers hold browser suites | ready, **not authorized** |
| 2 | `webhookIntasend` — **not from this branch**. The converged tree's webhook hunk (stamp-PAID + 09-28 schedule) must be ported onto `recovery/webhookintasend-on-2026-09-06` (68811e1) together with sokoni-70's B1 gate, content-diffed against the 09-06 archive | P0-4 lifecycle gate + owner go | **separate change** |
| 3 | verify live: `getCommissionConfig` returns 15 / POS 5 / property 5000 flat; `previewCommission` agrees; one subscription payment on the emulator-proven path | post-deploy script | — |
| 4 | Hosting from `convergence/commercial-web-on-18e3711` (`a5fa3d9`+): publishes the snapshot **only now** | `guard-no-rollback`, syntax gate (passed), single-source (passed) | ready, **not authorized** |
| 5 | verify client/server parity: `SokoniCommission.pct('marketplace') === getCommissionConfig().rates.marketplace.pct` on the live site; `subscriptions.html` renders `subGetPlans` | curl + browser | — |

**HARD STOP honoured:** no production traffic change. Open for the owner: step 0 items; the two-document-model question (7.4); `ROLE_DEFAULT_COMMISSION` retirement.


---

## 8 · Final gap closure (2026-09-30, third pass) — the four blockers

### 8.1 VAT — closed with a policy framework; the applicability decision stays with the owner/adviser

Record: [[VAT_POLICY_2026-09-30]] (KRA references; the seven-row applicability matrix; how to arm). Implementation: `revenueConfig/*_vat` now carries `applicability: taxable | zero_rated | exempt` (+ `inclusive` for taxable, `effectiveFrom`), the loader is fail-closed on anything unresolved, `etims._issuePlatformInvoice` takes `taxCategory` and refuses an unknown one, both invoice modules pass and record it. Proven: `test-vat-policy.js` 19/0 (taxable inclusive 500 → 431.03 + 68.97; exclusive → +80; zero-rated B / VAT 0; exempt C / no VAT; seven unresolved shapes → null), e2e 23/0 (configured → issued; absent → deferred → sweep issues exactly once). `scripts/write-vat-policy.js --dry-run` **refuses** the manifest as it stands (every decision field null) — that refusal is the intended state until the adviser's reference exists; `--read` shows both production documents **absent** (invoices refuse / defer). **No production write made.**

Decisions the matrix leaves to the owner/adviser (§2 of the policy doc): SOKONI's VAT registration status (not in the repository); commission and subscription applicability + treatment (the two live pages `terms.html:255` / `legal-hub.html:3228` disagree on inclusive vs exclusive — one must be corrected when the decision lands). Merchant→buyer, BnB stays, property transfers, rent and utilities are **not SOKONI supplies**: SOKONI invoices only its own fee on them (commission), and merchant VAT is already modelled per `etimsProfiles`.

### 8.2 provider_basic / provider_pro — retired, fail-closed

Evidence: production `providerSubscriptions` 5 docs, all `plan: free_trial`; subscription intents `starter` 9 / `business` 1 / `seller_basic` 1; **no** `provider_basic` or `provider_pro` anywhere in production, checkout, entitlement, reconciliation or tests — only the `PLANS` rows, an entitlement alias, and `plans.html`'s "popular" marker. `provider_pro` (KES 2,499, "Provider Pro") is **not** the canonical `pro` (KES 1,499): a different price is a different plan → retired, not aliased. Done: `PLANS.provider_basic/provider_pro` → `isActive:false, retired:'2026-09-30'` (hidden by `subGetPlans`, refused by `createPaymentIntent`); `plans.html` popular → `pro`; `PROVIDER_PLAN_ALIASES = { free_trial → provider_free }` (the production spelling, the "Free Trial 20%" tier); `PROVIDER_RETIRED_IDS`; `resolveProviderRate`: known → rate, alias → rate, **no plan → Free 20% (a known state)**, retired/unknown → `refused` (pct null); `subscription-core` throws `provider_plan_refused`; `finos-utils` **rethrows** (the booking is held, never priced at the category default); the snapshot's `providerPct()` returns `null` for retired/unknown. `test-provider-plan-ladder.js` **38/0** (A5/A6 retired & unknown refused; C6 engine throws; E1–E4 not for sale; F1 client mirrors). Note: the owner's brief named canonical ids `provider_starter/_pro/_business/_enterprise`; the immutable ids in `PLANS` are `starter`, `pro`, `business` and the cross-hub `enterprise` — kept as they are (renaming an id is what breaks stored documents).

### 8.3 FREE-50 — catalogue/entitlement/UI/tests agree; production backfill prepared, NOT executed

Catalogue v3 = owner ruling `c1d8ea1` (FREE 50 / PROFESSIONAL 100 / BUSINESS, ENTERPRISE unlimited); `entitlement-authority`, `product-limit` and every suite read the catalogue value; client copy that stated "10 products" (`sokoni-trust.js` ×2, `subscriptions.html` FAQ) now points at the plan panel instead of a literal. Tool: `scripts/backfill-product-counters-v3.js` — dry-run by default, `--apply` only with `--authorized-by`, `--rollback <evidence>`; never reduces a ceiling, never writes `count`, grandfathers a merchant above the ceiling, idempotent by `migrationVersion`, evidence JSON per run.
**Dry-run against production (reads only, evidence `docs/backups/free50-dryrun-2026-09-30T13-30-40-241Z.json`):** 12 counters, all `maxProducts: 10` (v1), all resolve INACTIVE → catalogue 50. Eleven are test/QA identities (`MERCHANT_A_uid`, `SELLER_A*`, `_qa_*`, `rc-not-this*`, `zzz_*`, two zero-product uids) → 50. **One real merchant** (`D5Ql2E…`, the KASS shop): **102 products by `sellerUid` / 97 by `shopId`, stored `count: −24`, ceiling 10** → target **102 with `grandfatheredFloor: 102`** (nothing removed; cannot add until under the ceiling — the floor is a floor). Count drift on 2 counters is reported, not written (`recount-product-counters.js` is the separate operation). 0 sellers hold products without a counter. **Authorization to apply is not given; the write has not happened.** After apply, the chain to verify: catalogue → `resolveEffective` → `productCounters.maxProducts` → `canPublishProduct` → plan panel.

### 8.4 Webhook stamp-PAID on 68811e1 — nothing to port; the chain is proven on the containment tree

`68811e1` already carries the stamp-PAID block in both webhooks (`index.js` 7381–7409 `intasendWebhook`, 8976–9004 `webhookIntasend`) and exports `onPaymentIntentPaid`; it has **zero** `subData.paymentRef !== apiRef` activation guards. The rival writer existed only on the c4 index (converted in §7). sokoni-70 was told to port nothing and to assert presence instead. Proof on the containment tree (`scripts/test-webhook-stamp-paid-chain.js`, `FN_DIR=C:/temp/sok-recovery/functions`, Firestore emulator, synthetic challenge, log `docs/backups/webhook-stamp-paid-proof-68811e1-2026-09-30.log`): **10/0** — valid COMPLETE callback → 200, `payments/{ref}` COMPLETE, intent `paid` + `activationPending` by the webhook, no subscription written by the webhook; `reconcilePaidIntent` → `subscriptions/{uid}` active from the intent's plan, `reconciledAt` + `subscriptionId` recorded; replayed callback → nothing changes; replayed reconcile → `replayed:true`, one subscription document. The B1 gate (`gate_error` branch) belongs to sokoni-70's draft; its status is theirs to report — it is **not** part of this proof and not claimed here.

### 8.5 Final commercial matrix

| area | authority | tests | production evidence | status |
|---|---|---|---|---|
| Commission | `commission-config.js` (`5db1540` + 09-30: POS bypass, property flat, delivery floor, provider lane) | schedule 25/0 · agreement 62/0 · lane-sep 22/0 · pos-lane 92/0 · pos-sale 78/0 · settlement 53/0 · KASS 7/0 · healthcare-plan 16/0 · facts 22/0 · single-source PASS · audit 0 independent | live serves the 09-06 config (5%) via `webhookintasend-00068-del`; `getCommissionConfig` 3% (08-22) | **READY — not deployed** |
| POS | `FIXED_RATE_CATEGORIES=['pos']`, absolute 5%, overrides bypassed and not read | fixed-rate-bypass 20/0 (rule + revenueConfig cannot reprice a till sale) | 00068-del already absolute 5% | **READY (unchanged live)** |
| Provider plans | `PROVIDER_PLAN_RATES` by plan id; alias `free_trial`; retired ids refused | provider-plan-ladder 38/0 · facts 3a–3c | prod: 5 provider subs all `free_trial` → 20%; no retired ids in use | **READY — not deployed** |
| Subscriptions | `PLANS` (sub-billing) · activation = `reconcilePaidIntent` · period = `subscription-period.js` | pay-methods 71/0 · writers 24/0 · paid-trial 82/0 · trial-activation 43/0 · entitlement-authority 79/0 · adapter-period 36/0 | live functions are the hosting lineage (09-09); 7 subs, none active | **READY — not deployed** |
| Invoices | `etims._issuePlatformInvoice` consumed by `commission-invoice` (ledger) and `subscription-invoice` (finalized payment) | commission-invoice 52/0 · e2e 23/0 (dup callback, racing writers, deferred → sweep once) | `platformInvoices` empty; `etimsInvoices` platform none | **READY — blocked on VAT + eTIMS creds (by design)** |
| VAT | `revenueConfig/commission_vat`, `subscription_vat` with applicability; loader fail-closed | vat-policy 19/0 · e2e C | both documents **absent** (`--read`) | **OWNER/ADVISER decision — code fail-closed** |
| Property | `RATES.property = KES 5,000 flat` | schedule / agreement / facts 1c | live 2% (09-06) | **READY — not deployed** |
| BnB | `RATES.hotel 15%` (alias `bnb`); host VAT per `etimsProfiles`; SOKONI invoices commission only | schedule (hotel row) · VAT matrix row | live 5% | **READY — not deployed** |
| Payment webhook | `68811e1` containment (P5, D1/Q6, atomic guard, stamp-PAID, absolute POS) | stamp-paid chain 10/0 · verify-candidate 48/48 · smoke-postill | serving `00068-del`, no real callback since 09-14 | **LIVE; B1 gate candidate with sokoni-70 (gate_error branch: theirs to prove)** |
| Free listing limits | catalogue v3 50/100/∞/∞ (`c1d8ea1`) | entitlement-authority 79/0 · free-entitlement 100/0 · counter-reconciliation 34/0 | 12 counters at 10; dry-run computed; **backfill not applied** | **READY — backfill awaits authorization** |
| Hosting snapshot | generated from the same `commission-config.js`; byte-identical on both branches | `--check` PASS both trees · single-source PASS both · syntax gate PASS | live serves the 3% file | **READY — publish after Functions only** |

No UNKNOWN. No PARTIAL. UNPROVEN on a live money path: none in this scope (the B1 `gate_error` branch is outside it and not claimed).

### 8.6 Deployment order (for approval — nothing executed)

**Functions** (`convergence/commercial-fn-on-ef1e992`), one at a time, each after the per-function live-archive content diff and `Ready=True`, peers holding browser suites:
1. `getCommissionConfig`, `previewCommission` (the 3% / 5% contradiction ends here)
2. `createCheckoutSession`, `onSellerPaymentCreated`
3. subscription set: `subGetPlans`, `subGetStatus`, `subActivate`, `subCancel`, `subReactivate`, `subGetBillingHistory`, `adminSub*` (7), `subProcessExpirations`, `subSendRenewalReminders`, `subScheduleRenewals`, `subAutoActivateOnPayment`, `subUpgradeWithProration`, `subCheckFeature`, `subRetryFailedPayments`, `subDowngrade`
4. intent rail: `createPaymentIntent`, `subscriptionPaymentMethods`, `payIntentWithWallet`, `onPaymentIntentPaid`, `reconcileSubscriptionPayment`, `activateSubscription`
5. entitlement: `getMerchantEntitlements`, `onSubscriptionChangedSyncEntitlements`, `onSubscriptionChangedSyncLimit`, `onAiSubscriptionChangedSyncLimit`, `canPublishProduct`, `recountMarketplaceProducts`, `onMarketplaceProductCreated/Deleted`
6. invoices: `subIssuePendingInvoices`, `subIssueInvoice`, `issueCommissionInvoice`; reconciliation: `runDailyReconciliation`
7. **not from this branch:** `webhookIntasend` stays on `68811e1` (B1 candidate via sokoni-70, P0-4 gate)
Then: `write-vat-policy.js --apply` (when the adviser's reference exists) · `backfill-product-counters-v3.js --apply --authorized-by` · verify `getCommissionConfig` 15 / POS 5 / property 5000; one subscription on the proven path.

**Hosting** (`convergence/commercial-web-on-18e3711`): only after step 6 verified — `guard-no-rollback`, syntax gate (PASS), single-source (PASS), then curl parity `SokoniCommission.pct('marketplace') === getCommissionConfig().rates.marketplace.pct`, `subscriptions.html` renders `subGetPlans`.

### 8.7 Remaining blockers (all outside code)
VAT applicability + registration facts (owner/adviser) · eTIMS platform credentials · FREE-50 backfill authorization · B1 `gate_error` proof (sokoni-70) · production deployment approval.


---

## 9 · Release gates and the FREE-50 authorization packet (2026-09-30, later)

**Gate A — engineering: GREEN.** **Gate B — business/fiscal: OPEN** (VAT applicability + SOKONI registration facts + adviser reference; eTIMS platform credentials; FREE-50 production authorization). **Gate C — deployment: OPEN** (explicit approval). Added Gate B blocker: the UI states two VAT treatments — `terms.html:255` (16% VAT *deducted* from platform fees = inclusive) vs `legal-hub.html:3228` (VAT *charged at the prevailing rate* = exclusive). **Do not deploy hosting while both statements stand**; the losing page changes with the VAT decision.

### 9.1 FREE-50 — authorization packet (production write NOT performed)

| requirement | evidence |
|---|---|
| dry-run artifact retained | `docs/backups/free50-dryrun-2026-09-30T13-30-40-241Z.json` (committed) |
| exact identities | 12, listed below (from the artifact) |
| KASS 102 → ceiling ≥ 102 | target 102 with `grandfatheredFloor 102`; live re-check 2026-09-30: `shops/D5Ql2E…` = **KASS SHOP**, products 102 by `sellerUid` / 97 by `shopId`, counter `maxProducts 10, count −24, catalogVersion 1` |
| no counter decreases | 12/12 targets ≥ current; the script exits 3 before writing if any row would reduce |
| idempotence / version guard | `migrationVersion: catalog-v3-free50-2026-09-30`; second apply = 12 skip / 0 writes |
| `--authorized-by` recorded | written to `migratedBy`, echoed in the evidence file |
| post-write readback | every counter read back after the write; `--verify <evidence>` re-checks live vs expected at any time |
| rollback tested / available | `--rollback <apply-evidence>` restores the recorded before-values, writes its own readback evidence, `--verify` confirms |
| rehearsal | `scripts/test-backfill-v3-emulator.js` **16/0** on the emulator with the production shape: dry-run → refused apply without auth → apply (12 written, 12 readback) → verify → idempotent re-apply → never-reduce guard (500 stays 500) → rollback → verify |

| identity | classification | current max | actual products | stored count | target | floor |
|---|---|---|---|---|---|---|
| `D5Ql2EYr95bt79IpcGTmOMTK0P83` | KASS SHOP (real merchant) | 10 | 102 | -24 | 102 | 102 |
| `MERCHANT_A_uid_11` | test / QA identity (0 products) | 10 | 0 | — | 50 | — |
| `SELLER_A` | test / QA identity (0 products) | 10 | 0 | — | 50 | — |
| `SELLER_A_uid_7f3` | test / QA identity (0 products) | 10 | 0 | — | 50 | — |
| `_qa_seller_1786036746494` | test / QA identity (0 products) | 10 | 0 | 0 | 50 | — |
| `oXrgbq2oBwadJSfsk0NypDCAXVT2` | test / QA identity (0 products) | 10 | 0 | 0 | 50 | — |
| `rc-not-this-seller-uid` | test / QA identity (0 products) | 10 | 0 | 0 | 50 | — |
| `xrH21J5GFbW8PluCZ2ny5nIuf602` | test / QA identity (0 products) | 10 | 0 | 10 | 50 | — |
| `zzz_diag_merchant` | test / QA identity (0 products) | 10 | 0 | — | 50 | — |
| `zzz_release_verify_synthetic` | test / QA identity (0 products) | 10 | 0 | — | 50 | — |
| `zzz_verify_annual` | test / QA identity (0 products) | 10 | 0 | — | 50 | — |
| `zzz_verify_monthly` | test / QA identity (0 products) | 10 | 0 | — | 50 | — |

Eleven of the twelve are test/QA residue (see [[project_prod_cert_account_residue]]); writing 50 to them is harmless and keeps the run uniform, but they are candidates for deletion in that separate cleanup — not here. The stored **count −24** on KASS is counter drift; the backfill never writes `count` (that is `recount-product-counters.js`, a separate operation to authorize separately).

**Command, when authorized (a separate change from the code deployment):**
```
node scripts/backfill-product-counters-v3.js                                   # dry-run again immediately before
node scripts/backfill-product-counters-v3.js --apply --authorized-by "<owner name>"
node scripts/backfill-product-counters-v3.js --verify docs/backups/free50-apply-<ts>.json
```
Then verify the chain on KASS: `canPublishProduct` (ceiling 102, at limit), the plan panel (`getMerchantEntitlements` → 50 for new usage, 102 held), and that nothing was removed.
