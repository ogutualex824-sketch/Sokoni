# Commission Engine — Production Acceptance Report

**Date:** 2026-07-14 · **Scope:** Commission Engine unification (provider, escrow, 4 hub paths)
**Governed by:** [[PLATFORM_CONSTITUTION]] · [[COMMISSION_ENGINE]] · [[FINANCIAL_TRANSACTION_STANDARD]]

> **DECISION: CONDITIONAL GO.**
> The code is certified. The **release is not**, and must not be, until one live transaction has
> completed in each migrated hub. The reason is stated plainly in §6 — it is not a formality.

---

## 1. Executive summary

Every platform commission on SOKONI is now computed by one engine, `calculateCommission()`.
The path audit reports **INDEPENDENT CALCULATION (0)**.

Getting there uncovered four defects that were not in the brief:

| | Found | Status |
|---|---|---|
| **P0** | Commission was **zero** on every FinOS payment — one missing `db` argument, silently swallowed | Fixed |
| **P0** | Escrow release would have **double-charged** commission and written **NaN** into the ledger | Fixed (never fired — collection empty) |
| **P0** | Provider bookings bypassed the engine entirely (flat 20%, no rules, no audit) | Migrated, price-neutral |
| **P1** | `event-hub` engine call referenced `event.organizerId` — **a ReferenceError on every ticket purchase** | Fixed before deploy |

The last one matters for how you read this report: it was caught by **reading the code**, not by a
test. Unit tests validated the arithmetic perfectly while the surrounding call would have thrown.
That is precisely why live validation is a release gate and not a nicety.

---

## 2. Phase 1 — every production flow

| Hub | Money path | Commission source | Evidence |
|---|---|---|---|
| Marketplace | `intasendWebhook`, `fosSecureWebhook`, `finos-router` | **Engine** | `index.js:5081`, `financial-os.js:304`, `finos-router.js:178` |
| Services / Provider | `providerCompleteBooking` | **Engine** (compatibility mode) | `provider-ops.js` |
| Digital Hub | `purchaseDigitalProduct` | **Engine** | `digital-hub.js` |
| Entertainment | `purchaseEntertainment` | **Engine** | `entertainment-hub.js` |
| Event Hub | `purchaseTickets` | **Engine** | `event-hub.js` |
| Delivery | `onOrderStatusChange` | **Engine** | `index.js` |
| Escrow | `releaseEscrow` | **Charges nothing** — taken at payment by `finos-router` | `index.js` |
| Wallet | `finos-utils` / `financial-os` | Credits only; computes no commission | — |
| POS | `darajaSTKCallback` → `sellerPayments` → `onSellerPaymentCreated` → `_resolveCommission` | **Engine** (adapter) | `index.js:3427` |
| Referrals | `settlement-engine` | Referral bonus is an **input cost**, not a platform take | `settlement-engine.js:105` |
| B2B / Wholesale | Marketplace rail | **No** commission computation of its own | `b2b-wholesale.js` — zero matches |

Also verified as *not* platform commission, each with a written reason in
`scripts/audit-commission-paths.js`: staff sales commission (what a cashier **earns**), subscription
and SaaS plan pricing, payroll bands, VAT/WHT/DST, rider revenue share, impact donations, score
weightings.

---

## 3. Phase 2 — price neutrality

Every migrated path was verified against **the old arithmetic as an oracle**, to the cent.

| Path | Old | New | Δ |
|---|---|---|---|
| Provider — Free Trial | 20% | 20% | **0** |
| Provider — Starter | 15% | 15% | **0** |
| Provider — Professional | 10% | 10% | **0** |
| Provider — Business | 7% | 7% | **0** |
| Provider — Enterprise | 5% | 5% | **0** |
| Provider — no subscription | 20% | 20% | **0** |
| Digital Hub | 10% | 10% | **0** |
| Entertainment (PPV) | 15% | 15% | **0** |
| Event Hub | 3% | 3% | **0** |
| Delivery split | 8% | 8% | **0** |
| Escrow release | 10% **(double charge)** | **0%** | **intentional — see below** |

**The only intentional change is escrow**, and it is a defect being removed, not a repricing:
commission is charged once, at payment, by the engine. The old code took a second 10% at release.
On a KES 10,000 marketplace order the seller would have received **KES 8,500 instead of KES 9,700**.
The `escrows` collection is **empty in production** (verified against Firestore), so no one was
ever mis-charged.

Coverage: 30 provider tier×amount combinations, 24 hub amount×path combinations, all exact.

---

## 4. Phase 4 — exception register

**No hidden exceptions.** These are the only ones, and each is listed by the audit tooling.

### 4.1 `skipMinimum` — suppresses the KES 10 platform floor

**Why it exists.** `MIN_COMMISSION_KES` stops a tiny marketplace sale costing more to process than
it earns. Four flows never had it. Introducing one during a migration is a repricing:

> a KES 50 event ticket at 3%: KES 1.50 → **KES 10** (+567%)
> a KES 20 delivery fee at 8%: KES 1.60 → **KES 10** (+525%)
> a KES 20 provider booking at 20%: KES 4 → **KES 10** (+150%)

**Why it is safe.** It only ever *reduces* commission, never increases it; it cannot produce a
negative or zero-by-accident charge; and it is opt-in per call site, so no flow acquires it silently.

**Who approves a change.** Business/pricing owner — removing it **raises prices on small
transactions**. It is not an engineering decision.

**Recommended migration.** None required. If the platform later wants a floor on these flows, drop
the flag deliberately and announce it.

### 4.2 `subscriptionRole` — provider plan rates are authoritative

**Why it exists.** Provider plans price **absolutely** (Free 20% → Enterprise 5%): a higher plan buys
a *lower* rate. The engine's `services` category is a flat 15%. Flattening one into the other would
have charged Enterprise providers **15% instead of 5%** — KES 1,000 more on a KES 10,000 booking,
and every paid tier would pay *more* the more they had paid for their plan.

**Why it is safe.** The rate comes from the **same** `subscription-core.getCommissionRate()` call the
old code used, so pricing is identical by construction. `commissionRules` and `revenueConfig`
**outrank** it — governance now reaches provider bookings for the first time.

**Who approves a change.** Business. Retire it by writing `revenueConfig/hub_provider` — **no deploy**.

### 4.3 `@commission-safe` — the tax analytic

`index.js` `get_tax_stats` aggregates gross across many orders and applies the default rate.

**Why it exists.** It is a **report**, not a charge. It debits nobody. Per-order engine calls would
mean one Firestore read per order for a figure no one is billed.

**Why it is safe.** Moves no money. The rate comes from the single config, so it cannot drift — but
it cannot reflect a per-seller rule or plan benefit either. It is knowingly an approximation.

**Recommended migration.** **Yes, eventually:** sum the commission now *recorded* on each order.
Every hub writes it after this sprint. Low priority; no money at risk.

### 4.4 Plan discounts — capability shipped, policy OFF

`revenueConfig/plan_adjustments` is **absent/disabled** in production (verified). Subscription
commission discounts are built, tested and **switched off**. Enabling them is a commercial decision
requiring no deploy.

---

## 5. Financial invariants verified

| Invariant | Result |
|---|---|
| Exactly one authoritative commission engine | **PASS** — path audit: 0 independent |
| No duplicate rate table | **PASS** — single-source guard, deploy-blocking |
| Migrated paths price-neutral | **PASS** — to the cent, 54 combinations |
| Every commission auditable | **PASS** — base rate, plan, adjustment, rule, source, timestamp, engine version |
| Idempotency (`FINANCIAL_TRANSACTION_STANDARD`) | **PASS** — 25/25 |
| Payment integrity (no client may assert payment) | **PASS** — 17/17 |
| Unit tests | **PASS** — 19/19 |
| Static financial safety | **Unchanged** at the documented residual baseline (V2=11, V3=5). **None** in any file touched by this migration. |
| Commission cannot be negative / zero by accident | **PASS** |
| Escrow cannot be double-charged | **PASS** |

---

## 6. Known limitations — read before shipping

1. **No migrated path has executed in production.** All verification is unit-level, against the old
   arithmetic. **The `event-hub` ReferenceError was found by reading code, not by a passing test** —
   the tests were green while the call would have thrown on the first real ticket purchase. Treat
   that as the calibration for how much unit-green is worth here.
2. **`escrows` is empty.** The release fix is therefore unexercised. It will start receiving
   documents: escrow is **on by default** in the settlement rules.
3. **Tax analytic remains an estimate** (§4.3).
4. **Physical-device and live-payment validation is outside what engineering can self-certify.**

---

## 7. Go / No-Go

**CONDITIONAL GO.**

Certified: one engine, price-neutral, fully auditable, exceptions documented, **no P0 or P1 open**.

**Blocking condition:** one live transaction in each migrated hub — **Event Hub first**, because it
is the one that carried a fatal runtime bug. Until then this is *code* certified, not a *release*
certified.

Run the checklist in §8. If a purchase completes and the ledger, payout, receipt and audit record
all agree, this becomes an unconditional GO.

---

## 8. Live purchase checklist

Do **one real purchase per hub**. For each, record the result.

### Before you start
- [ ] Note the seller/organizer UID and their subscription tier.
- [ ] Note the expected rate: digital **10%**, PPV **15%**, event ticket **3%**, delivery **8%**,
      provider = **their plan rate** (Free 20 / Starter 15 / Pro 10 / Business 7 / Enterprise 5).

### For every transaction
1. **Payment succeeds** — confirm the provider callback, not a client message.
2. **Commission matches** — `gross × expected rate`. Small purchase: confirm **no KES 10 floor** was
   applied (a KES 50 ticket must charge **KES 1.50**, not KES 10).
3. **Seller payout correct** — `net == gross − commission`, to the cent.
4. **Receipt generated** — and the commission line matches the ledger.
5. **Ledger entry exists** — one row, deterministic id, **no duplicate** on retry.
6. **Audit trail present** — the record carries `baseRate`, `pricingSource`, `ruleId`, `planId`,
   `calculatedAt`, `engineVersion`. **`pricingSource` must not be blank.**
7. **Analytics updated** — daily rollup increments once.
8. **Notifications sent** — buyer and seller.
9. **Refund path valid** — a refund reverses commission **and** VAT, and nets the wallet back.

### Hub-specific
- **Event Hub (do this first).** A ticket purchase exercises `ev.organizerUid`. If the fix is wrong
  it throws immediately. Verify `eventOrders` + the organizer payout. Buy a **cheap** ticket to
  prove the floor is suppressed.
- **Digital Hub.** Verify `digitalPurchases`, the licence key, and `product.sellerUid` on the fee.
- **Entertainment.** Verify `entertainmentPurchases` and `listing.creatorUid`.
- **Delivery.** Complete an order to `delivered`; verify `deliveryFees` splits 8% / 92%.
- **Provider booking.** Complete a booking; verify `providerPayouts.commissionRate` equals the
  **plan** rate, and that `pricingSource` reads `subscription_plan_rate (compatibility mode)`.
- **Escrow.** Once a FinOS escrow exists, release it: commission charged at release must be **0**,
  and `commissionAlreadyCharged` must show what was taken at payment.

### Stop immediately if
- any commission is **KES 10** on a small purchase (the floor leaked);
- `pricingSource` is blank (the flow bypassed the engine);
- two ledger rows appear for one payment;
- a seller net does not equal gross − commission.

---

*Prepared by the engineering team. Certification of the release itself requires §8 to be completed
by an operator with production access.*
