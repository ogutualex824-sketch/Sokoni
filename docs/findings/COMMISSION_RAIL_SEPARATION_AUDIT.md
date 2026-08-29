# Audit — commission model, payment rails and money ownership

**Read-only. No code, rules, IAM, indexes, providers or deployment config changed. Production frozen.**
Date 2026-08-28 · tree `rc/tenant-authority-live` · live `61f468e` (hosting since advanced)

> **The headline finding inverts the premise of the request.** Read §1 before authorising any
> commission change. "Restore the original package-based schedule" would, on today's base rates,
> **raise** seller commission roughly fivefold for free-tier sellers. That is not an argument
> against the change — it is a statement of what the change would actually do.

---

## 1. The commission model as it exists today — PROVEN

### 1.1 There is one authority, and it is enforced

`functions/commission-config.js` is the single source. `scripts/verify-commission-single-source.js`
runs in the functions predeploy chain and **fails the deploy** if a second table appears. It exists
because the platform previously had nine disagreeing tables, and which one applied depended on
**which payment rail the customer used** — a KES 10,000 legal consultation cost KES 500 on the
Daraja seller-till path and KES 1,200 on the FinOS path.

That history matters here: **rail-dependent pricing is the exact failure this architecture was
built to end.** Any change that reintroduces "marketplace prices one way, POS another" must do it
as an explicit, single-authority rule, not by letting two code paths diverge again.

### 1.2 Commission is CATEGORY-based, not package-based

`RATES` in `commission-config.js`, percentage of gross:

| category | pct | note |
|---|---|---|
| marketplace | **3** | was hub 3% / category 10% |
| food_delivery | 5 | |
| property | 2 | |
| vehicles | 0 | flat **KES 2000** |
| healthcare, legal, events, hotel | 5 | |
| digital_products | 10 | |
| event_tickets | 3 | was a bare literal in `event-hub.js:493` |
| ppv | 15 | was a bare literal in `entertainment-hub.js:215` |
| services, education, jobs | 15 | |
| classifieds | 8 | |
| **hub** (delivery) | **12** | platform 12 / rider 88 |
| subscriptions, advertising | 100 | platform revenue, not a marketplace sale |
| saas | 0 | |
| **default** | **5** | unknown hub/category |

`MIN_COMMISSION_KES = 10`.

### 1.3 Package/plan commission: capability SHIPPED, policy OFF — verified in production

`commission-config.js` implements plan adjustments with a master switch. Read live from Firestore
during this audit:

```
revenueConfig/plan_adjustments   EXISTS
  enabled : false
  plans   : {}          (empty map)
```

**So no package/plan commission is applied to any transaction today.** The switch fails closed:
absent document, failed read, empty config all mean "no adjustments", never "all adjustments".

### 1.4 The original package schedule — what it was, and why it was removed

The legacy table advertised **ABSOLUTE** rates — `free 15%`, `business 4%` — from an era when the
base rate was ~15%. It is **gone from code**; it survives in `commission-config.js` prose and in
git history (`a58afc2` *"commission decoupling — subscriptions pay for capabilities, flat rate pays
for the sale"*, and `7800b60` Commission Engine v1.0).

The current model replaced absolute plan rates with **adjustments to the base rate**, and the file
states the reason explicitly:

> A plan ADJUSTS the base rate; it never replaces it. … the legacy PLANS table advertised ABSOLUTE
> rates (free 15%, business 4%) from an era when the base was ~15%. Against today's 3% marketplace
> base, enforcing them would RAISE commission for every seller. The "discount" was a penalty.

**Consequence for the intended model:** reinstating the original package schedule as absolute rates
means a free-tier marketplace seller goes from **3% → 15%**. If the intent is tiered pricing, the
supported path is the adjustment mechanism already built (`deltaPct` / `discountPct` per plan, with
`maxDiscountPct`, `minEffectivePct`, `allowZero` safety rails) — enabled by operator config, **no
deployment required**. What the plan tiers currently carry is a *relative* `commission_discount_pct`
in `functions/sub-billing.js` (top tier 15).

---

## 2. MISMATCH — POS and marketplace are the SAME commission rule

**This is the sharpest gap against the intended model.**

```js
// functions/commission-config.js — ALIASES
shopping: 'marketplace',  pos: 'marketplace',  b2b: 'marketplace',
```

`pos` is an **alias of `marketplace`**. A POS sale therefore prices at the **marketplace 3%**, not
5%. `functions/pos-zero-friction.js:167` calls `FU.calculateCommission(db, …)`, the same authority
as marketplace.

Implications:

* The intended "POS 5% / marketplace package-based" separation **does not exist in code**. There is
  one rate for both.
* Changing the marketplace rate silently changes the POS rate, and vice versa. They cannot move
  independently until `pos` becomes its own category.
* Memory recorded the commercial rule as "5% (3→5 on 2026-08-25)". **The deployed authority says
  `marketplace: 3`.** Either the change was never applied to this file, or it was applied
  elsewhere. **UNRESOLVED — see §6.**

**Smallest correct shape** (not implemented, not authorised): give `pos` its own `RATES` entry and
remove it from `ALIASES`. That is a one-line separation in the single authority — the design already
supports it, and it keeps the rule in the one place the drift guard protects.

---

## 3. MISMATCH — a second rate table exists outside the authority

`functions/platform-core.js` carries a hub registry whose entries include `config.commissionRate`:

```
vehicles    commissionRate: 2      authority: 0% + flat KES 2000
healthcare  commissionRate: 8      authority: 5%
…           8 / 10 / 15 values     several disagree with commission-config
```

* Written into registry documents at `platform-core.js:231` — `config.commissionRate || 5`.
* **Displayed to users**: `functions/email-triggers.js:98` renders `after.commissionRate` as
  `"{n}%"` in email.
* A grep of `scripts/verify-commission-single-source.js` for `platform-core` / `registry` found
  **no allow-list entry**, yet the guard passes. Why it does not trip is **UNVERIFIED** — either the
  pattern does not match its shape, or it is exempt by a rule I did not locate.

**Risk classification:** if nothing charges from these values, it is a misleading duplicate that can
show a seller a rate they are not charged. If anything charges from them, it is live rate divergence
of exactly the kind the authority was created to end. **Which one it is remains UNPROVEN.**

---

## 4. MISMATCH — the rider share is a hardcoded literal, decoupled from its authority

The authority sets `hub: { pct: 12 }` — platform 12, rider 88. But the rider side is a literal in
two places:

```
functions/finos.js:59          Math.round(deliveryCents * 0.88)
functions/finos-router.js:183  Math.round(deliveryCents * 0.88)
```

Changing `hub` to any value other than 12 leaves the rider on 88% and the split no longer sums to
100. The delivery accounting the intended model requires (commissions, returns, refunds) rests on a
constant that does not track its own authority.

---

## 5. Rails — where IntaSend and Daraja actually live

| rail | modules |
|---|---|
| IntaSend | `financial-os.js`, `finos.js`, `finos-utils.js`, `finos-admin.js`, `finos-automation.js`, `commerce-dispatch.js`, `booking-events.js`, `booking-payment-sweep.js`, `admin-os.js`, `impact.js` |
| Daraja / STK | `index.js`, `payment-config.js`, `payment-intents.js`, `finos-router.js`, `financial-os.js`, `pos-qr.js`, `pos-zero-friction.js` |

**`financial-os.js` and `finos-router.js` appear on BOTH rails.** That shared surface is where a
marketplace/POS crossover would live, and it is the first place to look when separating them.

Seller proceeds are recorded to **`sellerPayments`** from `functions/index.js` (`:3932`, `:4208`) —
i.e. on the **Daraja/STK** path. Whether the IntaSend marketplace path credits the seller wallet
through the same collection is **NOT ESTABLISHED** (§6).

---

## 6. What this audit does NOT yet establish — stated, not glossed

The request asked for eight full transaction traces. This pass establishes the commission model,
the POS/marketplace collision, the second table, the rider literal and the rail map. It does **not**
yet establish:

1. **The 3→5 change.** Memory says the commercial rule became 5% on 2026-08-25; the authority says
   `marketplace: 3`. Unreconciled. **This must be settled before any rate work** — it decides
   whether the target is 3, 5, or per-category.
2. **Whether refunds reverse commission.** No reversal logic was found in
   `functions/commission-collection.js`. Absence in a grep is not proof of absence in behaviour.
   Until traced, treat "returns reverse seller proceeds and commission correctly" as **unproven**.
3. **The marketplace IntaSend → seller wallet credit path**, and whether it shares `sellerPayments`
   with the Daraja path.
4. **Withdrawal path** from seller wallet (`payoutRequests` per the canonical collections note).
5. **Idempotency keys and ledger entries per flow** — named per transaction class.
6. **Whether `platform-core` rates charge anything** (§3).

Eight traces × (rail, buyer, seller, gross, commission, net, wallet, rider, reversal, documents,
authorization, idempotency, ledger) is a second pass of comparable size. It should be done, and it
should be done against **live documents**, not source reading alone — this workstream has already
produced two conclusions from source that live data contradicted.

---

## 7. Sequence I would propose (nothing authorised, nothing done)

1. **Settle the intended rates first** — resolve the 3-vs-5 question and decide whether POS is a
   distinct category. No code moves until the commercial rule is written down unambiguously.
2. **Separate `pos` from `marketplace`** in the single authority (§2). One-line change, inside the
   guarded file, no rail logic touched.
3. **Decide the package model**: adjustments (built, off) versus absolute rates (removed, and a
   price rise). If adjustments, this is operator config — **no deployment**.
4. **Resolve `platform-core` rates** (§3) — delete, or allow-list with a stated reason, per the
   guard's own convention.
5. **Bind the rider share to its authority** (§4) — derive 88 from `100 - hub.pct`.
6. **Then** trace the eight transactions against live data, and only then touch refund/return
   reversal, which is the highest-risk area because it moves money backwards.

## 8. Files that must NOT be touched during this work

* `functions/merchant-authority.js`, `functions/pos-zero-friction.js` guards,
  `functions/business-health-score.js`, `functions/pos-peripherals.js`, `functions/crm.js` —
  the deployed tenant-authority release, certified 26/0 · 49/0 · 24/0.
* `firestore.rules.release-minimal` and the served ruleset — the deployed `shopEmployees` anchor fix.
* **The wallet backend** — frozen (`wallet-backend-v1.0-frozen`).
* Anyone's `admin` / `superAdmin` claims.
* `scripts/verify-commission-single-source.js` — the guard is not the thing to edit when it
  complains.

## 9. Certification gates required before any commission change deploys

* `verify-commission-single-source` green **without** a new allow-list entry added to silence it.
* A rate-change test proving the effective rate for each category **before and after**, including
  `MIN_COMMISSION_KES` and the `default` path.
* A POS sale and a marketplace sale priced in the same run, proving they are now **independent**.
* Refund reversal proven to return both seller proceeds **and** commission, with zero net drift.
* Rider split proven to sum to 100 after any `hub` rate change.
* Reconciliation against live before deploy, per the existing release-path gates.
