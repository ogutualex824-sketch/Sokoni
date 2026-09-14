# POS commission lane — D3 / D4 implementation

**Date:** 2026-09-02
**Status:** BUILT AND CERTIFIED (`scripts/test-pos-commission-lane.js` **87/0**).
**NOT WIRED.** Live pricing and live settlement terms are unchanged.

---

## The decision

**D4 = Option A.** POS is an independently priced lane inside the existing single commission
authority, `functions/commission-config.js`.

**Amendment to the authority contract**, recorded rather than made by quietly editing the
rule it qualifies:

> Marketplace plans continue to **adjust** the marketplace base rate and never replace it.
> POS is an **independently defined lane**. Its rates are **absolute lane rates** and are
> **not** interpreted as discounts against the marketplace base.

This does not reopen the defect that killed the legacy PLANS table. That table advertised
absolute rates (free 15%, business 4%) *as marketplace rates*, so when the base moved from
~15% to 3% the "discount" became a penalty. These rates reference nothing, so they cannot
drift when the marketplace base moves.

**D3 = Enterprise is genuinely 0%**, `floorExempt: true`. `MIN_COMMISSION_KES` must not turn
an advertised 0% into KES 10 a sale.

| plan | rate | floorExempt |
|---|---|---|
| `seller_free` | **0.15** | false |
| `seller_basic` | **0.10** | false |
| `seller_pro` | **0.05** | false |
| `seller_enterprise` | **0** | **true** |

Unknown plans resolve to **Free — the highest rate**, never the lowest. An unrecognised plan
must not become a free pass; undercharging is the failure that stays invisible until
reconciliation.

## COMMERCIAL CHANGE — recorded, not buried

Live today POS resolves through `ALIASES` to marketplace: **5% for every merchant.**

| plan | POS today | after | effect |
|---|---|---|---|
| Free | 5% | **15%** | **3× increase** |
| Basic | 5% | **10%** | **2× increase** |
| Pro | 5% | 5% | unchanged |
| Enterprise | 5% | **0%** | removed |

**Free and Basic POS merchants will pay more.** This is a pricing-policy decision, not a
refactor, and it needs merchant communication before it takes effect.

`resolvePosRate()` returns `source`, `plan` and `lane` alongside the rate, so a receipt,
merchant UI, reconciliation or audit can explain **why** a sale was charged what it was.

## Why the alias is still in place

`pos: 'marketplace'` does **two** jobs, and only one is pricing:

| # | job | mechanism |
|---|---|---|
| 1 | pricing | `resolveRate('pos')` → marketplace 5% |
| 2 | **settlement term** | `index.js:4852` `_is48hCommission()` — any hub resolving to `marketplace` is subject to the **48-hour** commission deadline; everything else keeps **monthly** invoicing |

Removing the alias — **or adding a `pos` key to `RATES`, since `RATES` is checked before
`ALIASES`** — would move POS from a 48-hour obligation to monthly billing as a *side effect
of a pricing change*.

So the lane is exported for the resolver and is **not reachable through `resolveRate()`**.
Certified: `resolveRate('pos')` still returns marketplace/5%, and `categoryForHub('pos')`
still returns `'marketplace'`.

> **OPEN DECISION D4b:** when the alias is broken, does POS keep the 48-hour settlement
> deadline or move to monthly? This must be decided *with* the alias removal, never as a
> consequence of it.

## Finding: the single-source guard has a blind spot

`verify-commission-single-source.js` enumerates files via **`git ls-files`** — **tracked
files only**.

An **untracked** second commission table is invisible to it. The first version of the
sabotage control planted an untracked file, the guard passed, and the control reported
itself broken — which is how this was found.

**This matters here specifically:** hosting publishes the working tree (`public: "."`) and
functions deploy from the working directory. An untracked commission table would **ship
while passing the guard.** This repo routinely carries 180+ dirty files, many untracked.

Not fixed here — it is a change to a deploy gate and belongs in its own slice. The sabotage
control now uses `git add -N` so it tests the guard's real detector rather than its file
list.

## Certification — 87/0

- all four plans: rate, floor policy, provenance, fraction-not-percentage
- unknown plan (6 forms incl. `null`/`undefined`) → Free, never zero
- **floor boundary**: Free crosses at KES 66 → 67 (KES 10.00 → 10.05); `floorApplied` truthful
- **three outcomes, not two**: below ~KES 66 the floor binds, but at or under KES 10 the
  commission is **capped at the sale** — a KES 1 sale is charged KES 1, never KES 10. The
  first version of this test modelled only floor/rate and failed here; the test expectation
  was the defect, not the code
- Enterprise pays **zero at every amount** including 0.01, and the contrast case proves a 0%
  rate *without* `floorExempt` would charge KES 10
- full chain `resolvePosRate` → `planSaleAccounting`, both custody modes, all four plans
- the 95%-cash day: 95k cash → liability 14,250 and **credit 0**; 5k electronic → credit
  4,250; total commission 15,000 on 100k of sales
- marketplace, every other alias, and the 48-hour gate all unchanged
- **sabotage**: a planted second commission table makes the guard FAIL, and it is green
  again after cleanup

## Not done

Not wired to POS, not exported to any callable, not deployed. `sub-billing.js` untouched —
it is not allow-listed, so a rate there would violate the authority boundary.

Still open: **D4b** (settlement term), D5/D6 (IntaSend), D-W2 (buyer approval channel), and
the undiagnosed `requestWithdrawal` failure.
