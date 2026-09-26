# Canonical money-version decisions

**Status:** 2026-09-26. **Documentation only. No runtime code changed, nothing deployed.**

This is the decision register for the commercial money modules that production runs in more than
one version. It covers **three modules only**: `commission-config.js`, `finos-utils.js`
(money-relevant behaviour) and `commission-collection.js`. The other 10 modules in
[[PRODUCTION_PAYMENT_LINEAGE_MAP]] are **not decided here**.

Related: [[PRODUCTION_COMMISSION_MISMATCH]], [[PRODUCTION_PAYMENT_LINEAGE_MAP]],
[[CREATOR_PAYMENT_ARCHITECTURE]].

**Method.** Read-only census of the serving archives of all **1,721** functions (41 distinct
archives):

```
gcloud functions list --v2 --format=json                          # serving source object + generation
gcloud storage objects list gs://gcf-v2-sources-24799054989-us-central1/**   # md5 per generation
gcloud storage cp <object#generation>                             # one copy per distinct archive
node scripts/commission-version-extract.js <censusDir> <fn-archive.json>
```

Versions are git blob ids, so `git log --all --find-object=<blob>` finds the commit that introduced
each one.

> **Correction to [[PRODUCTION_PAYMENT_LINEAGE_MAP]].** That map sampled 6 payment functions and
> found 4 / 3 / 2 versions of these modules. The full census finds **9 / 7 / 4**.

---

## Module 1 — `commission-config.js` (rate tables)

### A. Serving versions

| Blob | Functions | Introduced by | Branches carrying it |
|---|---:|---|---:|
| `ca10c86` | **1,682** | `017918b` 2026-08-07 — hub 8 → 12 % | 151 |
| `8ed1a0d` | 10 (`fos*`, `adminOsDispatch`, `autoOnRefundRequest`, `setUserRole`) | `2aedda9` 2026-07-13 | 197 |
| `407481d` | 9 (`posCompleteCheckout`, `completePOSQRPayment`, supply) | `e1e35e3` 2026-09-22 — marketplace flat 15 % | 15 (**incl. this branch's HEAD**) |
| `ea13f09` | 7 (`onOrderStatusChange`, `expireOldEscrows`, `initiateRefund` …) | `b0b5154` 2026-08-30 — package take rates | 2 |
| `c646856` | 5 (`initiateSTKPush`, dispatch …) | `79e69cd` 2026-08-26 | 37 |
| `2a4a70e` | 3 (`webhookIntasend`, `intasendWebhook`, `posInitiateIntasendPayment`) | `932ee22` 2026-09-06 — POS universal 5 % | 7 |
| `26da697` | 3 (`onSellerPaymentCreated`, `releaseEscrow`, `previewCommission`) | `19a313c` 2026-08-30 | 1 |
| `1f30c65` | 1 (`loyaltyDispatch`) | `e44f5b9` 2026-09-10 | 2 |
| `a5f5178` | 1 (`processTypesenseQueue`) | `2d7ed4e` 2026-09-20 | 16 |

Neither release branch (`618aadd`, `61912dd`) contains `e1e35e3`.

### B. Semantic money differences

The full per-rail table is in [[PRODUCTION_COMMISSION_MISMATCH]] §2.

| Dimension | What differs between versions |
|---|---|
| Marketplace rate | 3 % (`ca10c86`, `8ed1a0d`); 5 % (`c646856`, `2a4a70e`, `1f30c65`); package tier 5 / 4 / 3 / 2 % (`ea13f09`, `26da697`); **15 % flat** marketplace-seller lane (`407481d`); 16 % Free lane (`a5f5178`) |
| Hub / delivery | 8 % (`8ed1a0d`), 12 % (all others) |
| POS | aliased to marketplace, 3 % or 5 %; its own category at 5 %; **fixed** 5 % bypassing overrides (`2a4a70e`, `1f30c65`); flat 5 % POS lane (`407481d`, `a5f5178`) |
| Services | 15 %, or package tier with Free = 5 % (`ea13f09`, `26da697`) |
| `products` | resolves to marketplace 5 % in the newer versions; falls back to the default 5 % in the older ones |
| Minimum / bps / plan bounds | **identical**: `MIN_COMMISSION_KES` 10, `PLAN_MIN_PCT` 0.5, `PLAN_MAX_DISCOUNT` 50 |
| Unknown category | default 5 %, or the caller throws (the `ea13f09` / `26da697` families, via their `finos-utils`) |
| Pending pricing | only `26da697` refuses `car_rental` |
| Fee treatment, seller treatment, refunds | not in this module (see Modules 2 and 3 and [[PRODUCTION_COMMISSION_MISMATCH]]) |

### C. Money flows affected

Every commission charge on every rail: marketplace, POS / Till (including Quick Charge lines,
which are POS lines — `functions/shared/pos-service-pricing.js`), delivery, services / bookings,
events, digital, the 48 h receivable, and escrow release.

### D. Cross-module dependencies

- It is read only through `finos-utils.calculateCommission` (Module 2), plus direct
  `resolveRate` reads in `commission.js`, `digital-hub.js`, `index.js` and `subscription-catalog`.
- The marketplace and POS lanes of `407481d` are **only reachable** through `finos-utils`
  `1886dc3` (`resolveMarketplaceRate` / `resolvePosRate`).
- Pairing `407481d` with any other `finos-utils` silently drops the 15 % lane.

### E. Production impact per version

If one version becomes canonical for all rails:

| Canonical version | Effect on live charges |
|---|---|
| `ca10c86` | Marketplace would fall to 3 % on `webhookIntasend`, `posCompleteCheckout` and `onSellerPaymentCreated`, and POS to 3 %. |
| `8ed1a0d` | Additionally, delivery falls 12 → 8 % everywhere. |
| `2a4a70e` or `c646856` | Marketplace 5 % everywhere, POS 5 %. The FOS and majority rails rise 3 → 5 %. |
| `ea13f09` / `26da697` | Marketplace and services go on package tiers. Services Free tier falls 15 → 5 %. Unknown categories stop being charged at all (they fail). |
| `407481d` | Marketplace-seller sales with a `sellerId` go to **15 %** everywhere (rising from 3 or 5 %). POS 5 %, events 3 %, services 15 %, hub 12 %. |

### OWNER DECISION — `commission-config.js`

| Field | Value |
|---|---|
| Decided rates | **Recorded 2026-09-26, owner (in-session, in writing):** marketplace online sale **15 %** · POS / Till **5 %** per completed sale · Quick Charge / service provider **5 %** per completed charge · Events **3 %** per ticket · Creator Hub **30 % SOKONI / 70 % creator** (a separate royalty authority, `creator-hub.js`, not this table) · other hubs keep their own configured rates. |
| Canonical version | [UNDECIDED] — engineering note: `407481d` is the only serving version whose marketplace lane (15 %), POS lane (5 %) and `event_tickets` (3 %) match the decided rates. It is also this branch's HEAD blob. Adopting it is the owner's call. |
| Package-tier model (`ea13f09` / `26da697`) retained or retired | [UNDECIDED] |
| Services rate (15 % vs package tier) | [UNDECIDED] |
| Hub / delivery rate (12 % vs 8 %) | [UNDECIDED] |
| Unknown-category behaviour (default 5 % vs fail closed) | [UNDECIDED] |
| Quick Charge outside a POS sale (a standalone service-provider flow) | [OWNER TO COMPLETE] — no standalone Quick Charge rail was located; today a quick charge is a POS line. |
| Effective date / treatment of past sales | [OWNER TO COMPLETE] |
| Approved by / date | [OWNER TO COMPLETE] |

---

## Module 2 — `finos-utils.js` (money-relevant behaviour: `calculateCommission`)

### A. Serving versions

| Blob | Functions | `calculateCommission` AST | Introduced by |
|---|---:|---|---|
| `36a0da1` | 1,687 | `6199c86f19` | `f2ce0e7` 2026-08-03 |
| `a02aaa4` | 10 (`fos*`, `adminOsDispatch` …) | `6199c86f19` (**identical**) | `299b433` 2026-07-19 |
| `1886dc3` | 10 (`posCompleteCheckout` family + `processTypesenseQueue`) | `64d4f8df94` | `2f4fc20` 2026-09-15 (this branch's HEAD blob) |
| `266a159` | 7 (`onOrderStatusChange`, `initiateRefund` …) | `da517dee1b` | `b0b5154` 2026-08-30 |
| `0c31966` | 3 (`webhookIntasend` …) | `485278cc06` | `932ee22` 2026-09-06 |
| `9e60e98` | 3 (`onSellerPaymentCreated` …) | `570937e399` | `f3d6a36` 2026-08-30 |
| `d6f8a0f` | 1 (`loyaltyDispatch`) | `115535bce0` | `5b807b9` 2026-09-07 |

### B. Semantic money differences (inside `calculateCommission`)

| Behaviour | Versions |
|---|---|
| Precedence rules → `revenueConfig` (seller / hub / global) → subscription rate → category base → plan adjustment | all |
| POS **fixed-rate bypass** of every override and plan adjustment, recorded as `pricingSource: 'fixed_rate_category'` | `0c31966`, `d6f8a0f` |
| Marketplace-seller **15 % lane**, keyed on the raw category, with a `sellerId`; an inactive plan is charged Free | `1886dc3` |
| **Package-tier rates** for marketplace and services; plan adjustment skipped | `266a159`, `9e60e98` |
| **Unknown category throws** `COMMISSION_CATEGORY_UNRESOLVED` | `266a159`, `9e60e98` |
| `car_rental` throws `COMMISSION_CATEGORY_PENDING_PRICING` | `9e60e98` |
| Rounding, minimum and the `db` argument guard | `Math.round(amountCents * rate / 100)`; floor `MIN_COMMISSION_KES * 100`; throws when `db` is missing — **all** |
| `intasendB2C` (payout helper, not commercial) | differs between versions; out of scope here |

### C. Money flows affected

The same flows as Module 1; this is the single pricing entry point for every rail.

### D. Cross-module dependencies

- It must be paired with the matching `commission-config` (see Module 1 D).
- `266a159` / `9e60e98` read package tiers through `_resolveSellerPlan` (the subscription engine).
- `1886dc3` also calls `_resolveSellerPlan` for the marketplace lane.

### E. Production impact per version

It follows Module 1 E. In addition:

- Choosing a fail-closed version (`266a159` / `9e60e98`) turns every currently uncategorised sale
  from "charged 5 %" into "**not settled**". That is a settlement-availability change, not only a
  rate change.
- Choosing a version without the POS bypass lets a future `commissionRules` or `revenueConfig`
  override move POS pricing.

### OWNER DECISION — `finos-utils.js`

| Field | Value |
|---|---|
| Canonical version | [UNDECIDED] — engineering note: the decided marketplace 15 % / POS 5 % rates are reachable only through `1886dc3` (paired with `407481d`). |
| May an override (`commissionRules` / `revenueConfig`) move POS pricing? (the fixed-rate bypass) | [UNDECIDED] |
| Unknown category: charge the default, or refuse to settle? | [UNDECIDED] |
| `intasendB2C` version (payout) | [UNDECIDED] — governed by the wallet-freeze acceptance, not this register |
| Approved by / date | [OWNER TO COMPLETE] |

---

## Module 3 — `commission-collection.js` (48 h per-sale receivable)

### A. Serving versions

| Blob | Functions | `settleConfirmedPayment` | `computeOutstandingKES` | Introduced by |
|---|---|---|---|---|
| (absent) | 1,697 | — | — | — |
| `20a0889` | 10 (`posCompleteCheckout` family) | `1f876e6eee`, paymentRef **claim** | absent | `2f4fc20` 2026-09-15 |
| `4dd6343` | 8 (`webhookIntasend`, `initiateSTKPush` …) | `a2227d5387`, **no claim** | absent | `79e69cd` 2026-08-26 |
| `c5fa7e8` | 5 (`mpesaC2BConfirmation`, `createPaymentIntent`, `sweepCommissionDue`, `getCommissionBalance`, `getSellerRestriction`) | `1f876e6eee`, **claim** | present | `7d115bc` 2026-08-29 |
| `2648e91` | 1 (`loyaltyDispatch`) | `a2227d5387`, no claim | absent | `307693c` 2026-09-11 |

### B. Semantic money differences

| Dimension | Finding |
|---|---|
| Idempotency | `c5fa7e8` / `20a0889` claim `commissionSettlements/{paymentRef}` in a transaction before settling, and refuse when there is no `paymentRef`. `4dd6343` / `2648e91` settle open rows **by amount with no reference lookup**, so a redelivered payment settles a second tranche. That defect is described in `c5fa7e8`'s own comment. |
| Outstanding amount | only `c5fa7e8` has the server-authoritative `computeOutstandingKES` (`totalOwed + penaltyKES` over DUE / REMINDED / OVERDUE rows) |
| Penalty | `computePenalty` is identical where present: `round2(commissionKES * penaltyPct / 100 + penaltyFixedKES)`, config-driven, fails closed without a policy |
| Rate / minimum | none — the receivable **never recomputes** `commissionPct`, `commissionKES` or `totalOwed`; the amounts come from the ledger row written at sale time |
| Due window | `DUE_HOURS` 48, `REMINDER_HOURS` 46 (`2648e91` exports neither) |

### C. Money flows affected

Merchant-collected sales billed `PER_SALE_48H` (rows written by `onSellerPaymentCreated`),
commission settlement by C2B (`mpesaC2BConfirmation` → `settleConfirmedPayment`, running
`c5fa7e8`), seller restriction / unlock, and the seller balance view.

### D. Cross-module dependencies

- It reads `commissionLedger` rows priced by Modules 1 and 2 on `onSellerPaymentCreated`
  (`26da697` / `9e60e98`).
- The **only observed production caller** of `settleConfirmedPayment` is `mpesaC2BConfirmation`,
  which runs `c5fa7e8` (the claim version).
- The `webhookIntasend` archive loads `4dd6343` only to re-export `sweepCommissionDue`,
  `getCommissionBalance` and `getSellerRestriction`. Those three functions are themselves served
  from the `c5fa7e8` archive.

### E. Production impact per version

- Canonical `c5fa7e8`: no charge changes. The idempotent settlement and the server-priced
  outstanding amount become universal.
- Canonical `4dd6343`: this would **reintroduce the double settlement on redelivery** on the C2B
  path that is currently protected.

### OWNER DECISION — `commission-collection.js`

| Field | Value |
|---|---|
| Canonical version | [UNDECIDED] |
| Penalty policy values (`penaltyPct`, `penaltyFixedKES`) | [OWNER TO COMPLETE] — config-driven; not decided by code |
| Does the 48 h receivable apply to the decided POS 5 % rail? | [UNDECIDED] |
| Approved by / date | [OWNER TO COMPLETE] |

---

## Decision table

| Module | Versions | Serving functions | Money differences | Owner decision |
|---|---:|---|---|---|
| `commission-config.js` | 9 | 1,682 / 10 / 9 / 7 / 5 / 3 / 3 / 1 / 1 | marketplace 3 / 5 / tiered / 15 / 16 %; hub 8 / 12 %; POS 3 / 5 %, fixed or aliased; services 15 % vs tier | **Rates DECIDED 2026-09-26** (15 / 5 / 5 / 3, Creator 30/70); version and other fields UNDECIDED |
| `finos-utils.js` | 7 (6 distinct `calculateCommission`) | 1,687 / 10 / 10 / 7 / 3 / 3 / 1 | POS bypass; 15 % lane; package tiers; fail-closed unknown category | UNDECIDED |
| `commission-collection.js` | 4 (+ absent) | 10 / 8 / 5 / 1 | paymentRef claim vs none; `computeOutstandingKES` | UNDECIDED |
