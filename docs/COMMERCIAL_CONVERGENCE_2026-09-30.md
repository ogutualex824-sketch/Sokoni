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


---

## 10 · Pre-deployment evidence (2026-09-30, late) — lineage gate per function, order corrected, hosting re-based

Nothing deployed, pushed, or written to production. Live hosting moved to `72dca56` / v649 (tip `3e8dd53`, snapshot unchanged at the old 3% file) by sokoni-32; sokoni-70 holds the deploy queue for B1 (`b026856`, `gate_error` now proven 32/0).

### 10.1 Hosting candidate re-based
`convergence/commercial-web-on-3e8dd53` @ **`358edee`** (`C:/temp/sok-conv-web2`; the old branch on `18e3711` is kept untouched). Cherry-picks applied cleanly (CHANGELOG merged by prepending). Gates: snapshot `--check` in sync and byte-identical to the functions branch · single-source PASS · `guard-no-rollback`: "local contains live 72dca56 — allowing" · JS syntax OK · syntax gate PASS · live entry-splash change (`72dca56`) intact · header snapshot injection present. `index.html`'s three inline "errors" are JSON-LD / module blocks identical on live. No `.env` blob in any of my commits (`functions/.env` is tracked and untouched by me).

### 10.2 The lineage gate, per function — what the LIVE function has that the candidate lacks (reachable set only)
Method: download each function's live source archive (they vanish from GCS), take the handler module and its static `require()` closure, compare comment-stripped line sets. Lines outside the closure are packaged but never run in that revision. Archives retained in the scratchpad `live-archives/` with the JSON report.

| function | live build | reachable delta | explanation |
|---|---|---|---|
| `getCommissionConfig` | 08-22 | 28 lines: schedule rows (3% → 15% etc.), `finos-utils` fixed-category/provider changes, `subscription-core` export line | **the intended change** (§2, §7) |
| `previewCommission` | 08-30 | 128 lines: schedule rows; `commission.js` `_COMMISSION_OPS` dispatch table (an 08-30 consolidation wrapper — its exported functions all still exist here) and `packageTier` / `packageRateApplied` response fields (no client reads them; the candidate returns `planId` / `planStatus` / `marketplacePlan` instead); `finos-utils` `settlementState` helper (a `createLedgerEntry` argument not on the preview path) | explained; **but see 10.3 — must not precede the charging path** |
| `subGetPlans`, `subActivate` | 09-09 (hosting) | 47: `merchant-identity` old employment predicate (the 09-20 fix removed it, §7.5), catalogue v1→v3 (§7.2), retired provider rows + one period copy (§8.2, §7.4) | intended |
| `subAutoActivateOnPayment` | 09-09 | 6: period arithmetic → `subscription-period.js`, grace table | intended |
| `onPaymentIntentPaid`, `reconcileSubscriptionPayment` | 09-09 | 42: as above + `product-limit` pre-`serverReserved` forms + `PERIOD_DAYS` (30/365 days → calendar month, §7.4) | intended |
| `getMerchantEntitlements` | 09-09 | 15: catalogue v1→v3 | intended |
| `canPublishProduct` (handler `product-limit.js`) | 09-09 | 39: as above | intended |
| `createPaymentIntent` | 09-09 | was 104 → **two real regressions found and fixed** (10.4); remaining 23+2: `event_ticket` now prices from an `eventOrders` document (c4 event hub contract, `orderId`) instead of raw `eventId/tier` — the **live client has no `event_ticket` caller at all** (grep of `3e8dd53`: none), so nothing in production calls the old contract; the c4 event hub will ship with its own client. `_mintRef` return-shape line is the points-aware intent (`_pointsOf`) | explained |
| `createCheckoutSession`, `onSellerPaymentCreated` | 08-22 / 08-30, **defined inline in `index.js`** | closure = the whole index tree: 4–6 modules missing (`verification-engine`, `verification-vocabulary`, `role-vocabulary`, `shared/product-authority`, `print-intents`, `shop-access`, `delivery-policy` — hosting-only modules, **never on the c4 line**) and ~3,300 removed lines, mostly in modules those two handlers do not call | **NOT explained at handler level** — needs a function-body call-graph, not a module closure. **Held out of the first deployment**; deploy only after that finer diff, or after the index-level convergence |

### 10.3 Order correction — the charging authority moves first
`webhookIntasend` (`00068-del`, 09-06 config) is what **charges** an online order (`calculateCommission` inside the webhook; marketplace 5%). Deploying `previewCommission` / `getCommissionConfig` first would make the server *quote* 15% while the webhook *charges* 5% — the same inconsistency the hosting snapshot rule prevents. So the first production step is the commission authority on the containment lineage:

**Unit 3 — `draft/commission-authority-on-68811e1` @ `a0fec85`** (`C:/temp/sok-whunit3`): ONE file, `functions/commission-config.js` byte-for-byte from the functions branch. `68811e1`'s own `finos-utils` already consumes `isFixedRateCategory` / `resolveRate`; under this file it prices **online 15% · POS absolute 5% (fixed_rate_category) · property KES 5,000 · hotel 15%** (proven with its own `calculateCommission`). P5, D1/Q6, atomic guard, stamp-PAID untouched. Same mechanics as B1: `--only functions:webhookIntasend`, `.env` parity, Ready=True before traffic, route by name, never `--to-latest`. **P0-4 gate — owner approval required; belongs in sokoni-70's webhook queue after B1.**

### 10.4 Two regressions the gate caught (fixed on the functions branch)
`createPaymentIntent`'s live purpose registry has **`boost`, `marketing_boost`, `commission_collection`** — all called by the shipped client (`marketing.html`, `sokoni-pay.js`, `subscriptions.html`) — and `commission-collection.computeOutstandingKES`. The c4 lineage never had them (13 c4 commits on the registry added event/venue/POS/product purposes instead). Deploying the candidate would have refused every boost payment and every commission collection as an unregistered purpose. Ported byte-for-byte from the live archive; `test-commercial-facts-invariants` 2d/2e now pin every live purpose (24/0); `test-payment-intents` 12/0.

### 10.5 Corrected deployment order (for approval — nothing executed)
0. sokoni-70: B1 on `webhookIntasend` (unchanged 5%). *(their queue)*
1. **Unit 3** on `webhookIntasend` (owner P0-4 approval) → online 15% / POS 5% / property 5,000 charged. Verify by content diff of the new archive vs `a0fec85` and `previewCommission`-style calculation on the emulator.
2. `getCommissionConfig`, `previewCommission` — now consistent with the charging path.
3. subscription set (`sub*`, `adminSub*`), intent rail (`createPaymentIntent`, `subscriptionPaymentMethods`, `payIntentWithWallet`, `onPaymentIntentPaid`, `reconcileSubscriptionPayment`, `activateSubscription`), entitlement (`getMerchantEntitlements`, `onSubscriptionChangedSyncEntitlements`, `onSubscriptionChangedSyncLimit`, `onAiSubscriptionChangedSyncLimit`, `canPublishProduct`, `recountMarketplaceProducts`, `onMarketplaceProductCreated/Deleted`), invoices (`subIssuePendingInvoices`, `subIssueInvoice`, `issueCommissionInvoice`), `runDailyReconciliation` — each: live-archive reachable diff (done above), Ready=True, named route.
4. **Held:** `createCheckoutSession`, `onSellerPaymentCreated` until the handler-level diff explains their index-tree delta.
5. VAT documents (when the adviser's reference exists) · FREE-50 backfill (when authorized) — separate changes.
6. Hosting from `convergence/commercial-web-on-3e8dd53` @ `358edee` — only after step 2 is verified live; then parity: `SokoniCommission.pct('marketplace') === getCommissionConfig().rates.marketplace.pct`.

### 10.6 Still open before Gate C can close
Owner approval for Unit 3 (P0-4) · the four Gate B items (§9) · the `terms.html` / `legal-hub.html` VAT-treatment contradiction (hosting blocker) · handler-level diff for the two held functions.

## 11 · Hub plan entitlements — every vertical in the ONE catalogue (2026-10-03)

**Defect.**
- `subscription-catalog.js` knew only the seller and AI plans, plus the generic ids.
- Every other `sub-billing.js` plan resolved to the seller **FREE** allowance when paid: restaurant_*, hotel_*, pharmacy_*, driver_*, property_*, recruiter_*, freelancer_*, car_dealer_* and buyer_premium.
- Reported by sokoni-5b (Food Gate 5). Fitness (sokoni-e3) waits on the same contract.

**Contract** (`functions/subscription-catalog.js`; prices, tiers and limits stay in `sub-billing.js` PLANS, so there is no second table):

| Export | Answer |
|---|---|
| `hubPlan(id)` | `{planId, billingHubType, hubType, tier, name, isActive, features}`, or null for seller / provider / generic ids |
| `hubPlansOf(hubType)` | the hub's active plans, cheapest first. Accepts the vertical (`food`) or the billing name (`restaurant`) |
| `entitlementFor(sub).hub` | that plan. A lapsed plan becomes **the hub's free plan** (a known state), with `subscribedPlanId` kept. The seller fields are unchanged |
| `requireFeature(sub, {hubType, feature, capability?, needed?})` | `{allowed:true, limit, tier, planId}`, or `{allowed:false, reason:'upgrade_required', upgradeRequired:{capability, feature, hubType, currentTier, currentLimit, minTier, minPlanId}}` |

**Rules.**
- `minPlanId` is the cheapest ACTIVE plan of that hub that satisfies the feature. It is null when no plan offers it.
- `-1` means unlimited. `needed` is compared with the limit.
- An unknown feature, hub or capability is **refused with a reason**.
- Another hub's plan grants nothing.
- No subscription means the hub's free plan.

**Hubs and capabilities.**
- `HUB_VERTICAL = {restaurant: 'food'}`. Only verticals the capability engine defines are mapped; the other hubs keep their billing name.
- Capabilities (FOOD_MENU, KITCHEN, DRINKS, CATERING, BAKERY, from `shared/service-capabilities.js` on feat/capability-engine-on-c7e26b6 @ 13f74f3) are **not** plan features. The caller names the capability whose feature it is gating. It is validated against the engine when present and echoed in `upgradeRequired`. Nothing is granted here.

**Tests.**
- `scripts/test-hub-plan-entitlements.js`: 17/0.
- Sabotage (hub lookup disabled): 7 FAIL.
- `catalogue-canonical-migration` 47/0; `commercial-facts-invariants` 24/0.

**Status.** NOT deployed. It ships with this branch's functions slice. Callers wire it in themselves: Food Gate 5 (sokoni-5b), Fitness (sokoni-e3).

**Open.**
- No `fitness_*` plans exist. Add them to `sub-billing.js` PLANS (with an owner-set price) and they appear automatically.
- `adminSubCreatePlan` / `adminSubUpdatePlan` overrides stored in Firestore are not read here. That is the same static table as `subGetPlans`.

## 12 · Fitness bookings — 5% per booking (owner, 2026-10-03)

**Decision (verbatim):** "5% commission per booking fo the bookings". Given with the Fitness Hub business model the same day.

**Authority:** `functions/commission-config.js`.
- `RATES.fitness = {pct: 5, fixedKES: 0}`.
- `fitness` was an alias of `services`. It is now its own row and a **fixed-rate category** (`FIXED_RATE_CATEGORIES = ['pos', 'fitness']`).
- The provider plan ladder (20/15/10/7/5), `commissionRules` and `revenueConfig` are bypassed and recorded (`fixedRateCategory`, `overrideIgnored`).
- **No KES 10 floor** (`FIXED_RATE_FLOOR_EXEMPT = ['fitness']`): provider bookings never had one, and the owner set 5% per booking. A KES 100 session pays KES 5.
- POS keeps its floor.
- Aliases: `gym`, `fitness_hub`, `fitness-hub`, `personal_training`.
- The browser snapshot (`sokoni-commission-rates.js`) was regenerated.

**Scope.** The rate covers paid fitness BOOKINGS (sessions, classes, consultations, packages, Quick Pay) AND, per the owner via sokoni-e3 on 2026-10-03, **memberships and packages at the same 5%**. Membership money is released **pro-rata per period**; on cancellation only the unused part is refunded. That release mechanism is not built yet (it extends the provider-ops settlement, see §13 when built). It does not cover:
- booking fees
- memberships
- marketing
- Marketplace equipment and clothing (existing marketplace commission)

**A caller must price with `category: 'fitness'`.** A fitness booking sent as `services` takes the provider ladder. Wiring this is the Fitness lane's job (sokoni-e3).

**Tests:** `test-pos-fixed-rate-bypass.js` 27/0 (+F1–F4); sabotage (floor exemption removed) → F3 FAIL. `test-commission-schedule.js` 25/0.

**Status:** NOT deployed. It ships with this branch's functions slice, together with every function that bundles commission-config / finos-utils.

## 13 · Membership settlement — hold until first attendance, then monthly (owner, 2026-10-03)

**Decisions (owner, 2026-10-03):**
- Memberships and packages pay the same 5% as fitness bookings.
- "IF ATTENDED_SESSIONS = 0 → membership may be refundable … IF ATTENDED_SESSIONS >= 1 → membership becomes NON-REFUNDABLE".
- "VALID QR CHECK-IN → … NORMAL REFUND ELIGIBILITY LOCKED".
- "DO NOT automatically calculate a proportional refund after the member attends".
- "Attendance QR scanning is NOT a payment".
- **Payout (owner's choice):**
  - Hold everything until the first attendance.
  - Then release every month already passed at once, and monthly after that.
  - If the member never attended and the membership ended → the gym is settled at expiry.
- Supersedes the earlier "unused part refunded on cancel" answer.

**Authority:** `functions/membership-settlement.js` on `providerMemberships/{id}`.
- It is one more trigger on the provider settlement: same engine, same `providerPayouts`, same wallet / `walletTransactions` shape.
- Each month is claimed with `create()` at `providerMemberships/{id}/releases/{index}`.
- `membershipReleaseSweep` runs daily at 06:00 Africa/Nairobi.
- `membershipRequestRefund` (callable) is for the buyer or an admin.
- `initialSettlementFields(m)` is for the payment webhook.
- It READS the Fitness lane's attendance fields (`attendedSessions`, `firstAttendedAt`, `refundEligible`; any one means used) and never writes them.

**Refund.** A refund is a REQUEST only:
- zero attendance, before the end, once
- it freezes releases
- nothing is paid out
- `refundRequests` is never written

Execution belongs to the canonical refund authority (B9.31), which is **not built**. The AdminOS exception path is the same.

**Tests:** `scripts/test-membership-settlement.js` 23/0. Sabotage (hold-until-used and the used-lock removed) → 5 FAIL.

**Open / blocked:**
- The webhook purpose and hold for memberships (sokoni-5b) is not built.
- Rules: `providerMemberships` has no client rules (default deny). Buyer and gym read access is the Fitness lane's.
- The refund execution authority is not built.
- Emulator / runtime proof is UNPROVEN (memory floor).

### 13.1 · Payment intake, refund approval + execution, AdminOS exception (2026-10-03, later)

The money-side gaps from the owner's "MEMBERSHIP FULL END-TO-END GREEN" brief:

- **Payment.**
  - `payment-purposes.fitness_membership` (resourceType `providerMembership`) is priced from `providerMemberships/{id}.priceCents`. It is buyer-bound and payable only when `paymentStatus 'pending'` + `status 'pending_payment'`.
  - The webhook decides on its EXISTING early intent read (no extra read). For `resourceType providerMembership` it calls `holdMembershipPayment`, which binds intent → membership → buyer → amount → currency (KES) and treats a replay as a no-op.
  - On success: `paid_held` + `active` + `initialSettlementFields`. Any mismatch → `payment_review`; it is never activated.
  - `fitness_membership` is also a **self-settling** purpose (`shared/self-settling-purposes.js`), so the webhook's second exit refuses any seller credit if the early read fails.
- **Refund decision** (`membershipDecideRefund`, admin only).
  - The decider must differ from the requester, the buyer and the provider.
  - **Approve:** inside the transaction it re-checks attendance (non-exception requests), the amount ≤ the still-held balance and a verified `paymentRef`. It then executes through the **canonical held-money refund destination**: the buyer's SOKONI wallet (`users/{uid}.walletBalance`) plus a deterministic `ledger/{buyer}_{id}_membership_refund` row via `create()`, exactly as `provider-ops._disburseHeldFunds` / the late-payment refund do. A replay is refused.
  - **Reject:** the schedule resumes.
- **AdminOS exception** (`membershipRequestException`, admin only).
  - It needs a written reason (≥10 characters). Attendance is preserved (the record says `used: true`).
  - It refunds only the unreleased held balance and still needs a SECOND admin's decision, via the same execution.
- **Audit:** `providerMemberships/{id}/events`, append-only: payment_held / payment_review / settlement_released / refund_requested / refund_exception_requested / refund_rejected / refund_executed.

**Tests:** `test-membership-settlement.js` 45/0, covering:
- M1–M10 settlement
- P1–P8 payment: valid, replay, wrong amount, wrong buyer, intent priced differently, non-membership intent, fake reference, purpose registered
- R1–R7 refund: separation (buyer, gym), execution, replay, no gym payout after refund, reject resumes, check-in-vs-approval race, approval-vs-payout race
- X1–X6 exception

**Mutants:** each of the five requested breakages makes a named test fail:
- hold-until-first-visit → M3
- refund lock → M8 ×4
- payment binding → P3–P5
- approval attendance re-check → R6
- settlement idempotency → M5b

**Regressions:** creator-callback has only its 4 pre-existing FAILs (identical on HEAD). entertainment-bookings 95/0, event-settlement 111/0, commission-schedule 25/0, fixed-rate 27/0, hub plans 17/0.

**Refund destination note.** The canonical destination for held booking money is the SOKONI wallet; the member withdraws to M-PESA through the existing wallet payout. A direct IntaSend B2C reversal is NOT used: it is field-proven only at KES 10 and a failed payout strands the chargeback. Switching to B2C would be an owner decision.

**Still UNPROVEN / BLOCKED:**
- Emulator + browser runs (memory floor).
- Port of the webhook hook onto the LIVE webhookIntasend lineage (sokoni-5b).
- Rules for buyer / gym reads (sokoni-e3's rules lane).
- Attendance / check-in (sokoni-e3).
- Gym, member and AdminOS screens (sokoni-e3).

## 14 · Service bookings: flat 5% for every provider, replacing the plan ladder (owner, 2026-10-03)

**Decision.** Relayed via sokoni-f3, then asked and answered directly ("Yes, flat 5% for all"): "SOKONI takes 5% of the service amount, PAID BY THE PROVIDER (deducted at settlement). The buyer pays the service amount only. Charged once per booking, from commercial config … No lead, registration, listing, withdrawal or messaging fees."

**Change** (one place: `provider-hub.commissionArgsForHub`, the settlement inputs for every provider booking):
- The generic path now prices from `RATES.services` (5%). It no longer passes `subscriptionRole`, which made the plan rate absolute (Free 20 / Starter 15 / Pro 10 / Business 7 / Enterprise 5).
- There is no KES 10 floor (this lane never had one).
- An admin may still adjust the rate through `commissionRules` / `revenueConfig(hub_provider)`, like every category.
- The `fitness` hub routes to its fixed 5% lane.
- Entertainment is unchanged (already 5%). **Correction (same day):** healthcare BOOKINGS are 12% (owner schedule 2026-09-28), NOT 5% as first written here; the owner then CONFIRMED healthcare bookings are 5% too ("Yes, 5% for healthcare too") — see §14.2.
- `PROVIDER_PLAN_RATES` stays in place, but service bookings no longer read it. Plans unlock features only.

**Tests updated to the decision:**
- `test-healthcare-payment-convergence` B5/B6/B8/C10 → 40/0
- `test-entertainment-bookings` → 95/0
- the e2e PIN test expects 5% (emulator: UNPROVEN)
- `provider-plan-ladder` 38/0 and `commission-schedule` 25/0 are unaffected

**UI still claiming plan rates** (sokoni-b2's lane):
- `provider-onboarding.html` PLANS `c:'20%'…'5%'`
- `provider-dashboard.html` "Commission rate: X%" from `sub.commissionRate`
These must show the canonical rate (`SokoniCommission.pct('services')` = 5%) for every plan. The "Leads/month" items are plan limits, not fees, and stay.

### 14.1 · Reversal after settlement + snapshot cleanup (2026-10-03, later)

**Reversal.** Owner, via sokoni-f3 / sokoni-5b: "a service-booking refund AFTER settlement must claw back through the canonical ledger, reversing the provider allocation and SOKONI's 5%, with no second commission".

Built `provider-ops.reverseServiceSettlement(bookingId, {decision:'refund_full', actor, reason})`; sokoni-5b owns the trigger. It writes:
- `providerPayouts/{id}_reversal`, negating gross / commission / net, with the original row marked `reversed`
- a provider business wallet debit of exactly `netShillingsCredited`, with a deterministic walletTransaction
- a buyer refund of what the booking paid (price + fee snapshot) to the SOKONI wallet, plus a deterministic ledger row
- booking → `refunded_after_settlement`

It only reverses settled bookings, full reversals only (partial is not decided), and a replay reverses nothing twice. If the provider already withdrew, the balance goes negative and `clawbackShortfallShillings` is recorded. Payouts are refused while the balance is below the amount, and later settlements repay it. **That debt policy needs owner confirmation.**

**Tests:** `scripts/test-service-settlement-reversal.js` 7/0.

**Snapshot** (sokoni-b2's findings):
- `home_services` 14% → **5%** (owner: every service booking).
- The browser snapshot no longer publishes `PROVIDER_PLAN_PCT` / `providerPct()`, which would have advertised a commission nobody is charged.
- New `providerBookingPct()` = `RATES.services`.
- `test-provider-plan-ladder` F1 is inverted accordingly (38/0). `test-commission-schedule` S1 home services = 5 (25/0).

**Open:** `car_rental` (16%) is a vehicle hire on the car hub, not a provider service booking. It is left as-is pending the owner.

### 13.2 · Start at payment, pay-by, notifications (2026-10-03, later; gaps found with sokoni-e3)

- **Start at payment.** The months run from PAYMENT, not from record creation. A future `startAt` chosen by the creation path is kept, and `requestedStartAt` preserves the original.
- **Pay-by.** `payment-purposes.fitness_membership` refuses a new intent once `payBy` (set by the creation path's TTL) has passed. A payment already in flight is still honoured.
- **Notifications.** All go through the one sender (`notify.js`, existing types, no WhatsApp):
  - member: payment confirmed / active (`subscription_activated`), refund request received, refund declined with reason, refunded (`refund_processed`), membership ended (`subscription_expired`)
  - gym: new membership (`booking_new`), refund requested, earnings released (`wallet_credit`)
- **Tests:** 53/0 (+S1–S3, N1–N5). The 5 mutants were re-run and each is still detected.

### 14.2 · Owner answers: clawback debt, car rental, healthcare (2026-10-03, later)

- **Clawback shortfall:** "Provider owes it".
  - The reversal's negative balance is the policy; it is repaid from later settlements, and payouts are refused until then.
  - `reverseServiceSettlement` comment updated: confirmed.
- **Car rental:** 16% → **5%** ("Make it 5%").
- **Healthcare bookings:** 12% → **5%** ("Yes, 5% for healthcare too"). Healthcare PRODUCT sales stay at 15% (not a booking).
- **`seller-terms.html` fee table:**
  - Healthcare bookings 5%.
  - "Service bookings (home services, fitness, car rental and all other services): 5% of the service amount, deducted from the provider's payout at settlement — the same on every plan".
  - **Flag for the owner (legal wording, not edited):** the paragraph "How commission is collected … SOKONI does not deduct commission from the customer's payment" describes marketplace sales. Held service bookings and memberships ARE settled net of commission by SOKONI. The owner or an adviser should reword it.
- **Cleanup** (sokoni-b2's finding):
  - The dead `provider-ops._commissionRate()` plan lookup is removed.
  - The `_settlementMath` comment now states the flat 5%.
- **Snapshot** regenerated: services / home_services / car_rental / healthcare all 5.
- **Tests:** commission-schedule 25/0 (S1, S6, S8 updated), healthcare-payment-convergence 40/0, healthcare-subscription-foundation 120/0, provider-plan-ladder 38/0, entertainment 95/0, reversal 7/0, membership 53/0.

### 14.3 · No plan may move a service booking (2026-10-03, sokoni-b2's census finding)

- **Finding.** `sub-billing.js` provider plans still carry `features.commission_pct`, and seller plans carry `commission_discount_pct`.
  - `commission_pct` has NO reader; it appears only in comments in commission-config and money-authority.
  - `commission_discount_pct` IS read by `finos-utils._resolveSellerPlan` in the plan-adjustment step. That step is off today (`revenueConfig/plan_adjustments.enabled` absent → `rollout_disabled`). If switched on, it could discount a provider's service booking below 5%: a ladder by the back door.
- **Fix.**
  - `commission-config.FLAT_BOOKING_CATEGORIES` = services, home_services, car_rental, healthcare, entertainment_bookings, fitness. `isFlatBookingCategory()` follows aliases.
  - In `finos-utils` the plan step stands down for them, recording `planSkipped: 'flat_booking_rate'`, before any subscription lookup.
- **Tests.** `test-pos-fixed-rate-bypass` B1–B2 (32/0), with plan discounts switched ON: services / home_services / healthcare / car-rental all stay KES 50 on KES 1,000.
  - Sabotage (services dropped from the list) → B1 and B2 FAIL.
  - Marketplace / product / POS are not flat (B1).

### 13.3 · Remaining notifications (2026-10-03, sokoni-e3's brief audit)

- **Member:** "Payment under review" when a payment is parked (`payment_failed` type, with wording that makes clear there is no double charge).
- **Exception filed:** member "Refund review opened" + gym "Membership refund under review".
- **Refund executed:** the gym is now told too ("Membership refunded", remaining payouts cancelled).
- **Ops:** a failed refund execution leaves nothing half-done (the wallet credit is inside the decision transaction). It returns "nothing was changed" to the deciding admin and logs `REFUND_EXECUTION_FAILED` as a structured error for monitoring. No admin recipient list exists to notify, and none is invented.
- **Tests:** 57/0 (+N6–N9); mutants re-run, all detected.

### 13.4 · Integration closure on the money side (2026-10-03, "MEMBERSHIP FINAL INTEGRATION")

**Late payment vs the five-minute unpaid expiry.**
- A payment landing after `payBy`, or on a record with `status 'expired'`, is NEVER activated.
- Like a late booking payment (`booking-payment-sweep`), it is refunded to the buyer's SOKONI wallet: deterministic ledger row `{buyer}_{apiRef}_membership_latepay_refund` via `create()`, then `paymentStatus 'refunded_late'`, `status 'expired'`, intent `'refunded'`, and member notice "Payment refunded".
- A replay refunds nothing twice, and the gym is never settled.
- Tests L1–L6 cover the 1-second boundary on both sides.

**Refund atomicity under a real failure.** An injected commit failure on the wallet write (A1–A5) leaves nothing changed:
- refund still `requested`
- no ledger row, no wallet credit
- no "refund paid" notice to the member or the gym
- payouts still frozen
The callable answers "nothing was changed, please retry" and logs `REFUND_EXECUTION_FAILED`. A retry completes the refund exactly once.

**Sales switch** (defence in depth with sokoni-e3's `fitnessCreateMembership`). The `fitness_membership` purpose refuses unless `featureFlags/fitness_membership_sales.enabled === true` (`SALES_DISABLED`). The check runs before the membership is read, and a read error fails closed (F1–F2 are static; runtime proof needs the emulator).

**Mutants** (`scratchpad ms-mutants.js`, 8). Each newly fails a named row:

| Breakage | Failing rows |
|---|---|
| hold-until-first-visit | M3 |
| refund lock | M8 ×3 + M8b |
| payment binding | P3 / P4 / P5 (+1) |
| approval attendance re-check | R6 |
| settlement idempotency | M5b |
| late-payment guard | L2 / L3 |
| refund approval separation | R1 / R1b / X3 (+) |
| refund atomicity (wallet credit outside the transaction) | A2 (+) |

**Notification matrix (money side).** All go through `notify.js`; none are triggered by browser state.

| Event | Authority (server function) | Recipient(s) | Condition |
|---|---|---|---|
| Payment confirmed / membership active | `holdMembershipPayment` | member | verified intent, buyer, amount and currency match, before `payBy` |
| New membership | `holdMembershipPayment` | gym | same |
| Payment under review | `holdMembershipPayment` | member | intent / amount binding mismatch |
| Payment refunded (late) | `holdMembershipPayment` | member | payment after `payBy` / on an expired record |
| Refund request received | `requestRefund` | member + gym | zero attendance, before the end, once |
| Exception refund opened | `requestException` | member + gym | admin, written reason, held balance > 0 |
| Refund declined (with reason) | `decideRefund` (reject) | member | second admin |
| Membership refunded | `decideRefund` (approve) | member + gym | transaction COMMITTED (never on failure) |
| Earnings released | `releaseDueSlices` | gym | ≥1 month released |
| Membership ended | `releaseDueSlices` | member | last month released |

Attendance notifications are sokoni-e3's.

**Tests:** `test-membership-settlement` 70/0. Regressions: creator-callback only its 4 pre-existing FAILs, entertainment 95/0, events 111/0, schedule 25/0, fixed-rate 32/0, reversal 7/0.

**Money-side status against the owner's 36 GREEN criteria.**
- **PROVEN at unit level (in-memory Firestore):** 2–4, 11, 14–27 (money parts).
- **UNPROVEN:** emulator and browser runs (RAM about 270 MB, below the 512 MB floor).
- **BLOCKED:** the live webhook hook (sokoni-5b's port, after their P0 + REVIEW slices).
- **Not mine:** QR, scanner, staff/business linkage, attendance, access rules, AdminOS/Super Admin screens (sokoni-e3).

### 13.5 · User-ready gap closure, money side (2026-10-03): prices, short passes, one sales predicate, terms

**Owner decisions (asked and answered):**
- The Fitness price list is "Defaults gyms can edit". Each gym publishes its own offer, and the member pays the offer price as snapshotted at creation.
- Daily / Weekly passes pay "At first visit or expiry", as one slice.

**What changed:**
- **Default catalogue (one place):** `functions/shared/fitness-offer-defaults.js` → Daily 500, Weekly 1,500, Monthly 5,000, 3 Months 14,000, 6 Months 26,000, Annual 48,000 (KES, stored in cents). `withSavings()` computes 3M 7% / 6M 13% / Annual 20% from the same list. The gym offer editor (sokoni-e3) pre-fills from it; nothing charges from it.
- **Short passes:** `membership-settlement.slicesOf` accepts `periodUnit 'day' | 'week'` as ONE slice ending at the pass end (subscription-period.addDays, the one period copy). The hold-until-first-check-in, refund-lock and expiry rules are unchanged.
- **One sales predicate:** `functions/shared/fitness-sales-switch.js` `salesEnabled(db)` (boolean `true` only; 'true', 1, missing or a read error → off). It is used by the payment purpose. sokoni-e3's `fitnessCreateMembership` should import it rather than keep its own copy.
- **`seller-terms.html` "How commission is collected"** is replaced with the owner's wording, widened to seller, gym or provider: "SOKONI may deduct the applicable platform commission and other disclosed transaction charges from amounts payable to the seller, gym or provider … determined by the applicable pricing, commission, payment and refund rules, including the rates set out above". The old claim "the seller receives the full sale amount … invoiced separately" is gone.
- **`opportunity.html`:** the mechanic perk "No commission on direct bookings" became "One flat commission per booking — the same on every plan" (no hardcoded number).
- **Left alone:** `launch-readiness.html` (admin-only tip "90-day zero commission") is not a customer promise. It is flagged, not edited.

**Tests:** `test-membership-settlement` 77/0 (+D1–D7 catalogue / short passes; F1 runtime predicate matrix; F2 single copy). 8 mutants each detected. commission-schedule 25/0.

**Authority map (Fitness memberships):**

| Concern | Authority | Owner |
|---|---|---|
| Offer prices (defaults) | `shared/fitness-offer-defaults.js` | 2f |
| Published offer | `providerServices` kind 'membership' | e3 |
| Membership creation + price snapshot + `payBy` | `fitness-membership-create.js` | e3 |
| Sales switch | `shared/fitness-sales-switch.js` (flag written by AdminOS `adminUpdateFeatureFlag`) | 2f predicate / AdminOS writer |
| Payment intent | `payment-purposes.fitness_membership` | 2f |
| Webhook hold | `membership-settlement.holdMembershipPayment` via webhookIntasend's early intent read | 2f code / 5b live port |
| Attendance / QR / staff / entitlements | `fitness-attendance.js` | e3 |
| Refund request / decision / exception / execution | `membership-settlement` | 2f |
| Monthly / expiry payouts | `membership-settlement.releaseDueSlices` + daily sweep | 2f |
| Commission | `commission-config` RATES.fitness 5% fixed (`provider-hub` for bookings) | 2f |
| Wallets / ledger | existing `wallets` / `walletTransactions` / `providerPayouts` / `users.walletBalance` + `ledger` | existing |
| Notifications | `notify.js` (money: 2f; attendance: e3) | existing |
| Rules / AdminOS / Super Admin screens | e3 rules lane / e3 AdminOS view; `adminUpdateFeatureFlag` = AdminOS | e3 / AdminOS |

No duplicate authority was found on the money side.

**Acceptance matrix (money side; full GREEN needs e3's half + emulator/browser):**

| Area | Current authority | Test | Result | Evidence | Status |
|---|---|---|---|---|---|
| Server-priced payment, held | purpose + hold | P1, P8 | pass | test-membership-settlement | PROVEN (unit) |
| Mismatch → review, no activation | hold | P3–P7, N6 | pass | same | PROVEN (unit) |
| 5-min expiry / late payment | hold + payBy | L1–L6, S3 | pass | same | PROVEN (unit) |
| First visit locks refund | refundDecision/isUsed | M8 ×3, M8b | pass | same | PROVEN (unit) |
| Refund request → second person → execution | requestRefund / decideRefund | R1–R7, M7 | pass | same | PROVEN (unit) |
| Refund atomic under failure | decideRefund txn | A1–A5 | pass | same | PROVEN (unit) |
| Exception refund | requestException | X1–X6, N7 | pass | same | PROVEN (unit) |
| Payout freeze / months not reversed | releaseDueSlices | M7b, R4, R7, X4 | pass | same | PROVEN (unit) |
| Monthly / expiry / short-pass payouts, once | releaseDueSlices | M4–M6, M5b, D5–D7 | pass | same | PROVEN (unit) |
| Notifications from committed state | `_notify` after commit | N1–N9, L3, A3 | pass | same | PROVEN (unit) |
| Sales switch fail-closed | fitness-sales-switch | F1, F2 | pass | same | PROVEN (unit) |
| Pricing single source | fitness-offer-defaults | D1–D3 | pass | same | PROVEN (unit) |
| Commission 5% | commission-config | M4b, pos-fixed-rate | pass | suites | PROVEN (unit) |
| Live webhook hook | webhookIntasend (5b lineage) | — | — | port requested | BLOCKED (5b) |
| Rules / emulator | e3 rules lane | — | — | RAM 297 MB < 512 | BLOCKED (memory) |
| Browser flows (member / gym / AdminOS) | e3 screens | — | — | RAM | BLOCKED (memory) |
| Webhook suite | creator-callback | 4 FAIL | pre-existing | identical on HEAD | PRE-EXISTING FAILURE |

### 14.4 · Car Hub vehicle sales 2% (owner 2026-10-03, via sokoni-f3) + regression sweep

- **Rate.** `RATES.vehicles` changes from KES 2,000 flat to **2% of the sale price** (fixedKES 0), deducted from the seller's settlement. Aliases `car_hub` / `car_dealer` follow it.
  - Launch is marketplace-first, with no online vehicle checkout, so the rate has **no live trigger** until an online sale path exists.
  - Listings are free. Dealer plans and featured listings are unpriced (owner) and are not seeded.
  - Subscription ≠ sale commission: never both on one economic event unless the owner says so.
- **`seller-terms.html` row:** "2% of the sale price, deducted from the seller's settlement when the sale is completed through SOKONI". The snapshot is regenerated.
- **Missed regression, now fixed.** `test-commission-5pct-agreement` had pinned healthcare at 12% since 03ecbe9; I had not run that suite then. Its table now reflects the 2026-10-03 amendments (healthcare 5, vehicles 2%): 62/0.
- **Full commission sweep:**
  - 48h 87/0 · invoice 52/0 · lane separation 22/0 (2 UNPROVEN, pre-existing) · settlement authority 53/0 · healthcare plan 16/0 · KASS 7/0 · POS lane 92/0 · POS rail 80/0 · subscription classification 21/0 · single-source verify PASS · schedule 25/0 · fixed-rate 32/0 · ladder 38/0 · pos-sale 78/0
  - `commission-balance-ui`: 2 FAIL, **pre-existing**. Identical on 6be1561, before today; these are page / callable checks, not rates.
- **Sales switch.** `shared/fitness-sales-switch` logs `FLAG_UNREADABLE` (warn) on a read error and still fails closed (sokoni-e3's suggestion).

## 15 · Car Hub paid products (owner 2026-10-03, via sokoni-f3): one catalogue, configurable prices

**Plans** live in `sub-billing.js` PLANS and are read by `subscription-catalog`. They are monthly only (annual unpriced, so annual billing is refused). Prices are editable without a deploy through AdminOS `adminSubUpdatePlan` (`subscriptionPlans/{id}` overrides, read by `createPaymentIntent` at payment time).

- **Dealer plans** (`hubType 'car_dealer'`):

  | Plan | KES / month | Listings | Featured credits / month |
  |---|---|---|---|
  | Free (kept) | 0 | — | — |
  | Starter | 1,500 | 10 | 2 |
  | Growth | 3,000 | 30 | 5 |
  | Pro | 5,000 | 75 | 10 |
  | Business | 8,000 | 150 | 20 |
  | Enterprise | 15,000 | 300 | 40 |

  Every paid tier has `in_app_leads` (no WhatsApp hand-offs). The `car_dealer_pro` id is reused for the new Pro; production held 0 subscriptions on the old KES 2,499 Pro (read-only count, positive control: subscriptions total 7).
- **Vehicle tracking** (`hubType 'vehicle_tracking'`):

  | Plan | KES / month | Vehicles |
  |---|---|---|
  | Basic | 300 | 1 |
  | Standard | 500 | 1 |
  | Pro | 800 | 1 |
  | Fleet5 | 2,000 | 5 |
  | Fleet10 | 3,500 | 10 |
  | Fleet25 | 7,500 | 25 |

  Every tier has location + trip history + vehicle status. No further per-tier features are invented: Standard and Pro differ by price until the owner says otherwise.
- **Entitlement names for Car Hub:**
  - `listings_limit`, `featured_credits_monthly`, `in_app_leads` (`car_dealer`)
  - `vehicle_limit`, `location_tracking`, `trip_history`, `vehicle_status` (`vehicle_tracking`)

  Gates call `requireFeature(sub, {hubType, feature, needed})`.
- **Payment:** the existing subscription path, `createPaymentIntent({planId, billingCycle:'monthly'})` → `reconcilePaidIntent`. No new purpose.

**Boosts** (`functions/vehicle-boosts.js`):
- **Seed prices:** Quick 24h 50 · Standard 3d 100 · Featured 7d 200 · Premium 14d 350 · Top Spotlight 30d 600 · bundles 5×7d 800, 10×7d 1,500, 20×7d 2,500.
- **Overrides:** an override in `revenueConfig/vehicle_boosts.prices` is set via `adminSetVehicleBoostPrices` (Super Admin only, whole KES 1–100,000, audited in `adminAudit`). An invalid override is ignored and the seed stands. `vehicleBoostCatalogue` is the read.
- **Purpose** `vehicle_boost` (resourceType `vehicleBoost`) is priced from the catalogue, never the request. It is **self-settling**.
- **Fulfilment:** the webhook fulfils on the existing early intent read (`fulfilVehicleBoost`, idempotent on the payment ref).
  - A single boost writes `listingBoosts/{ref}` (listing, placement, startsAt, endsAt).
  - A bundle writes `boostCredits/{uid}.credits7d` + `boostCreditLedger`.
  - `consumeBoostCredit` turns one credit into a 7-day boost. Car Hub must verify listing ownership first.

**Finding:** the pre-existing generic `boost` purpose (marketplace listings, prices hard-coded) has **no fulfilment anywhere**. Paid boosts activate nothing. It is left as-is, flagged.

**Not mine / open:**
- sokoni-5b ports the webhook hook (same shape as the membership hold).
- Car Hub reads `listingBoosts` for placement and consumes credits.
- Vehicle sale stays 2% with no trigger.
- Subscription ≠ sale commission.

**Tests:** `scripts/test-carhub-catalogue.js` 16/0. hub-plan-entitlements 17/0 (all new plan ids resolve; none to FREE by accident). membership 77/0, schedule 25/0. creator-callback still has only its 4 pre-existing failures.

## 16 · B2B Hub: lead fee + 0% on wholesale orders (owner 2026-10-03, via sokoni-f3)

**Owner decisions:**
- **Earning model:** a lead fee, with **no % cut on wholesale orders**. A lead is each RFQ/enquiry a supplier receives through SOKONI.
- **Price:** KES 200 per lead + 16% VAT. VAT was chosen explicitly, so the treatment is standard-rated and stated exclusive of VAT.
- **Billing:** per supplier, per calendar month (Africa/Nairobi), invoiced at month end as a SOKONI → supplier platform invoice.
- **Price changes:** admin-editable.

**Order exemption** (`commission-config`):
- **New row:** `RATES.b2b_order` is 0%, a **fixed, floor-exempt** lane.
- **Aliases:** `b2b`, `wholesale`, `b2b_wholesale` and `rfq` all resolve to it. `b2b` was an alias of `marketplace`, which would have charged a wholesale order 15%.
- **Ladder:** `b2b` is removed from `MARKETPLACE_SELLER_CATEGORIES`.
- **Router:** `finos-router` maps hub `b2b` to `b2b_order`.
- **Why fixed:** a fixed lane means no commissionRule, revenueConfig override, plan ladder or KES 10 minimum can reprice it. A mutant proved this: without the fixed lane, a seller's 12% override charged KES 60,000 on a KES 500,000 order.
- **Billing term:** `b2b` is no longer on the 48-hour per-sale commission term (nothing is owed).

**Lead fee** (`functions/b2b-leads.js`): one writer per collection.
- **Lead rows:** `b2bLeads/{rfqId}__{supplierBusinessId}` is written **only by rfq.js** (sokoni-f3, `functions/b2b-rfq-on-e61c73e @ 38ab5a8`), after it re-reads supplier consent. This module never writes a lead.
- **Price snapshot:** rfq.js should spread `leadFields(db)` (`priceKES`, `priceSource`) into each row, so a price change applies only to later leads. A row without a snapshot is priced at invoice time and counted in `unsnapshottedLeads`.
- **Month end:** `b2bLeadMonthlyInvoices` runs on the 1st at 07:00 EAT. It reads the previous month's ledger (paged, once), groups it by supplier and drops self-RFQs.
  - It claims `b2bLeadMonths/{sup}__{month}` with the totals stored at first claim.
  - It issues **one** invoice through `etims._issuePlatformInvoice` (`feeType 'lead'`, `taxCategory 'standard'`, `vatInclusive false`; billed to `supplierOwnerUid`).
  - A failed or stale claim is retried by `b2bLeadInvoiceSweep` (daily) at the **stored** total, never a recount.
  - Both schedulers bind the eTIMS secrets (now exported as `etims._ALL_SECRETS`).
- **Price callables:** `b2bLeadPrice` is the public read. `b2bLeadStatement` is the supplier's own statement (caller = billToUid; invoiced months + month in progress; VAT via the tax engine; no internal claim fields). Rules keep `b2bLeadMonths` admin-read. `adminSetB2bLeadPrice` is Super Admin only, whole KES 1–100,000, and audited.

**Open (owner):**
- How a supplier **pays** the lead invoice (wallet debit, IntaSend link, or offset against B2B settlements). The invoice is the receivable; collection is not invented.
- The held B2B order payment purpose (IntaSend, held until delivery, settled to the business wallet, priced under `b2b_order`) is still to be defined with 5b.

**Finding (not changed):** `subscription-invoice.subIssuePendingInvoices` binds **no** eTIMS secrets. A v2 scheduled run that reaches `_issuePlatformInvoice` cannot read `ETIMS_PLATFORM_PIN`, so the sweep can only record `failed`. This needs its own commit.

**Tests:**
- `scripts/test-b2b-lead-fee.js` 21/0, including the real VAT engine (600 + 96 = 696) and the real `calculateCommission` with a live control.
- Amended for the owner decision: 48h-destinations 87/0, 5pct-agreement 62/0, schedule 26/0 (client snapshot `sokoni-commission-rates.js` rebuilt).
- commercial-facts 1c amended for vehicles 2% (stale since 9cab901).
- Failures identical on base `09964a2`: commercial-facts 3b, commission-balance-ui ×2.

## 17 · B2B lead invoice recovery: settlement deduction, Pay Now, overdue gate (owner 2026-10-03; agreed with sokoni-f3 / sokoni-5b)

**When an invoice becomes owed.** The receivable opens at the **successful** issue:
- `b2bLeadMonths.outstandingKES` = net + 16% VAT (tax engine), `paidKES` = 0.
- A failed or deferred eTIMS attempt opens nothing, so the 2-day clock starts at `issuedAtMs` of the real issue.

**One recovery path, two callers** (claims in `b2bLeadRecoveries`):
- **Settlement deduction:** at release of a buyer-paid B2B order (5b owns hold/release and supplies the hook), the supplier payout is reduced by min(outstanding, settlement), oldest invoice first. The buyer is never touched. Claim `leaddeduct_<settlementId>_<invoiceKey>`.
- **Pay Now:** purpose `b2b_lead_invoice`, priced from `payNowAmount` (the server balance), self-settling, platform revenue. The verified webhook applies it on the early intent read. Claim `leadpay_<ref>_<invoiceKey>`. A surplus (balance recovered meanwhile) goes to `b2bLeadOverpayments` for admin review and is never auto-credited.

**Read/write split** (Firestore: all reads before writes):
- `prepareLeadDeduction(t, db, {settlementId, billToUid, settlementKES})` (or `preparePayment`): discovers candidate invoice ids outside the transaction, then `t.get()`s every invoice **and** this operation's claim inside it. Amounts come only from those reads.
- `commitLeadDeduction(t, state)`: `create()` per claim, decrement `outstandingKES`, set status `paid` at 0. Returns `{deductedKES, replayedKES, totalRecoveredKES, netKES, lines}`.
- **Retries:** the **operation** is the idempotency unit. Every commit, zero lines included, creates `b2bLeadRecoveries/<opKey>` with its totals. `prepare` reads it first and, if present, returns a pure replay: 0 more and the **same** net, even if a new invoice was issued between runs (defect found in sokoni-f3's review, fixed). The same holds for a replayed Pay Now webhook.
- **Late changes:** a Pay Now that commits between discovery and the release is re-read as 0. An invoice issued after discovery carries forward.
- **Reversals:** a refund or void of the B2B order after a deduction does **not** reverse it (owner policy required).

**Gate:** `leadInvoiceGate(db, uid, nowMs)` → `{overdue, overdueKES, invoiceKeys, since, enforce:false}`.
- **Overdue:** issued more than 2 days ago and still outstanding.
- **One definition:** the predicate lives in `functions/shared/lead-invoice-gate.js`, byte-identical on the gated POS line (`fix/pos-restock-on-approval-on-d4a167c @ 9db13df`), where `pos-commission-rail` consumes it.
- **Owner of both ends:** 2f owns the producer and the consumer (a second reason inside evaluateMerchantGate/assertGateOpen on the gated POS line, with its own card).
- **Enforcement:** it starts enforcing only after the Pay Now is certified.

**Tests:** `scripts/test-b2b-lead-recovery.js` 21/0 (adds D3c/D3d/D3e and P1e).
- **Mutants:** dropping the claim read fails D3; trusting discovery amounts instead of the in-transaction re-read fails D4.

## 18 · Education commission (owner 2026-10-03, via sokoni-5b)

- **Rate:** `RATES.education` is 5% (was 15%, "category only", never owner-set), paid by the teacher or institution once per sale and never added on top for the learner.
- **Plan discounts:** education is added to `FLAT_BOOKING_CATEGORIES`, so no plan moves it.
- **Plans:** education plans arrive from 5b with the owner's prices (`hubType 'education'`).
- **Snapshot:** client snapshot rebuilt.

## 19 · Jobs: 0% commission (owner 2026-10-03, via sokoni-f3) · Legal free-plan cap (owner 2026-10-03)

**Jobs**
- **Rate:** `RATES.jobs` is 0% (was 15%, "category only", never owner-set). It is a FIXED, floor-exempt lane, so no override, plan or KES 10 minimum applies.
- **Aliases:** `freelance`, `freelancer`, `gig` and `gigs` resolve to it. There is deliberately no bare `job` alias, because the work engine's "job" is a service job.
- **Earning model:** applications are free. SOKONI earns from Jobs only through employer products (subscriptions, paid/featured listings, promotion, enterprise). These are built **unpriced** and switched off until the owner sets prices; f3 sends catalogue rows then.

**Legal free plan:** the consultation card that SOKONI's legal-verification projection creates does not count toward the active-service cap.
- **Scope:** exactly `providerServices/legal_consult_{uid}` with `createdBy 'legal-verification'`, in `provider-ops` add, duplicate and re-activation.
- **Copies:** a duplicate of the card counts like any other service.
- **Test:** `scripts/test-legal-auto-card-cap.js` 9/0.
