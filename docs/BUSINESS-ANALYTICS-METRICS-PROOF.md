# Business Analytics — fabricated-metrics before-proof

> **Base: `9de4f63`.** Read-only. **No product code changed. No source invented.**
> Scope: `business-analytics.html`, with `seller-analytics.html` as the comparison case.
> Verdict: **3 of 9 surfaces are HARDCODED and presented as real business metrics.**

Related: [[Role Contract Triage]] · [[Analytics lsFallback Proof]] · [[Platform Constitution]]

Standing rule (CLAUDE.md): *no UI component may fabricate business metrics. When canonical
data is unavailable, show a neutral state — `—`, `No data yet`, `Calculating…` — **not** `0`
and **not** an extrapolated guess.*

---

## The classification

| surface | source traced to | class |
|---|---|---|
| **Health score** (`healthNum`, gauge) | `metrics = [{val:92},{val:88},{val:74},{val:61}]` — literal array, averaged | **HARDCODED** |
| **Revenue chart** (6 months) | `actuals = [148000,162000,135000,178000,191000,205000]`<br>`targets = [150000,160000,165000,175000,190000,200000]` | **HARDCODED** |
| **CAC** (`cacVal`) | `spend / newCust` where `spend = 18800`, `newCust = 47` | **HARDCODED** (derived from literals) |
| **New customers** (`newCustVal`) | `newCust = 47` | **HARDCODED** |
| **Marketing spend** (`mktSpend`) | `spend = 18800` | **HARDCODED** |
| **Repeat rate** (`repeatRate`) | literal `'34%'` in the innerHTML | **HARDCODED** |
| **CAC trend** (`cacTrend`) | literal `'↓ 12%'` in the innerHTML | **HARDCODED** |
| Top products | renders *"Product ranking not available yet"* + why | **EMPTY — correct** |
| Staff performance | renders *"Staff performance not available yet"* + why | **EMPTY — correct** |
| B2B/B2C split | canvas hidden, *"Customer split not available yet"* | **EMPTY — correct** |
| Subscription plan | `getDoc(planSubscriptions/{uid})` → `renderSubStatus(plan)` | **REAL** |

**Nothing is UNSUPPORTED-but-sourced.** Every non-empty figure on the page except the
subscription plan is a literal typed into the file.

---

## Why this is worse than the `_lsFallback` finding

The fallback grants a forged *view* that contains nothing. This shows **a legitimate,
correctly-authorised seller** figures that look authoritative and came from nowhere:

```
Revenue    KES 205,000 this month     ← typed into line 491
CAC        KES 400                    ← 18800 / 47, both typed into 545-546
Health     79                         ← mean of 92, 88, 74, 61, all typed into 456
Repeat     34%                        ← typed into line 551
```

The revenue series is even shaped to look plausible — a dip in March, recovery through June,
targets tracking just above and below actuals. It reads as real data. It animates on load.

A seller could make a stocking or marketing decision on those numbers.

---

## The same page already knows how to do this correctly

Three of its own surfaces render an honest unavailable state **with the reason**:

> *"Product ranking not available yet — needs per-product units-sold and revenue totals
> aggregated from delivered orders. Product records alone cannot say what sold."*

So the remediation pattern is established **in this very file**. The three fabricated blocks
were simply not converted.

`seller-analytics.html` is the fully-remediated comparison case: it queries real orders
(`where('sellerUid','==',uid)`), uses a `NO_DATA` constant for what it cannot compute, and
carries the comment *"A merchant with no orders gets a flat, honest zero series — NOT a
[fabrication]"*.

---

## Secondary finding, recorded not fixed

`seller-analytics.html:913`

```js
if (!orders.length) orders = getOrdersFromStorage();   // localStorage 'sokoniOrders'
```

When the Firestore query returns nothing, it falls back to a **localStorage order cache** and
computes metrics from it. The standing rule names client-side computation over `localStorage`
explicitly. It is a weaker case than the hardcoded literals — a cache of the user's own real
orders is not invented data — but the failure mode is that an empty authoritative result gets
silently replaced by stale client state, which is indistinguishable from a real figure.

**Class: DERIVED-FROM-CACHE.** Needs its own decision; not part of this fix.

---

## Disposition

| item | disposition |
|---|---|
| Health score gauge | **FIX** — no source exists; render unavailable |
| Revenue chart (actuals + targets) | **FIX** — no source exists; render unavailable |
| CAC / new customers / spend / repeat rate / trend | **FIX** — no source exists; render unavailable |
| Top products · Staff · B2B | **KEEP** — already correct |
| Subscription plan | **KEEP** — REAL |
| `seller-analytics` localStorage order fallback | **DEFER** — own decision |

## The fix, when authorised

Convert the three blocks to the pattern the same file already uses: an explicit unavailable
state naming what would be required. **Do not invent a query or a Cloud Function to populate
them.** Revenue needs delivered-order aggregation, CAC needs a marketing-spend source that
does not exist in this platform, and the health score needs its four inputs defined before it
can mean anything.

Showing nothing is correct until those sources exist. Showing `0` would be equally wrong.
