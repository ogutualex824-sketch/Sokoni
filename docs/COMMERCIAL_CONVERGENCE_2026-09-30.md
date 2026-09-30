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
