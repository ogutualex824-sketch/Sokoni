# Data Lineage Register — Release B

**Status:** first pass, READ-ONLY. Nothing here has been changed.
**Tool:** `scripts/census-data-lineage.js` (5/5 controls passing)

This register records what is *established*, what is *flagged*, and what is
*explicitly not known*. An empty cell is a real answer. See [[project_platform_constitution]]
and [[feedback_no_fabricated_metrics]].

---

## 1. Population model

The question is not "why does a page say 80-something". It is **what does "users" mean**,
and there is more than one legitimate answer.

| Counter | Value | Source |
|---|---:|---|
| Firebase Auth accounts | 103 | Auth `listUsers()` |
| `users/{uid}` profiles | 82 | Firestore |
| Auth ↔ `users` matched | 71 | reconciliation |
| Auth-only (no profile) | 21 | reconciliation |
| `users`-only (no Auth) | 8 | reconciliation |
| UNCLASSIFIED | 3 | reconciliation |

All six are legitimate figures. **"103 users with profiles" would not be** — that
sentence is true of 71.

### Deliberately NOT in this register

A figure of *"fewer than 20 emails"* has been referred to but **is not sourced**. It does
not correspond to any measurement recorded here, and 20 vs 82 is a large enough gap that
it changes what the audit is looking for. It stays out until the exact
collection/query/page that produced it is identified — at which point it is either a
seventh legitimate counter or a defect, and we will know which.

---

## 2. Defect register

### D1 — `_costEfficiency()` returns fabricated constants

**File:** `functions/platform-health.js`
**Classification:** `HARDCODED` / `FABRICATED`
**Status:** RECORDED, NOT FIXED — deliberately.

```js
const indexCount     = 192;   // "Firestore Index Budget"
const indexMax       = 200;
const scheduledCount = 8;     // "known constant from deployed functions"
const heavyCFs       = 4;     // "getMarketplaceQualityReport, getSearchInsights, + 2 more"
score += 20;                  // "Region Concentration — All CFs in us-central1"
return { ..., dataComplete: true };
```

Every input is a literal. It is **5% of the platform health score**, and it reports
`dataComplete: true`, which is the part that makes it actively misleading rather than
merely stale: it asserts the figures were obtained.

**Not to be "fixed" by swapping in live queries.** First establish what each number is
supposed to *mean* and which authority can legitimately provide it:

| Figure | Candidate authority | Established? |
|---|---|---|
| index count / max | `firestore.indexes.json` + the deployed index list | no |
| scheduled CF count | the deployed function inventory | no |
| heavy CFs (≥512 MiB) | function deployment config | no |
| region concentration | function deployment config | no |

Related: `getPlatformHealthScores` also returns a hardcoded
`indexBudget: { used: 192, max: 200 }` alongside the real dimensions.

### D2 — commission read from `localStorage` on three surfaces

Money-named client-store keys reached by pages that render money:

| Page | Key |
|---|---|
| `admin.html` | `sokoniCommissionLedger`, `sokoniCommissions` |
| `landlord.html` | `sokoniCommissionLedger` |
| `legal-hub.html` | `sokoniCommissionObligation` |

**Classification:** `MIRROR` candidate — commission is a canonical concept
(`commissionLedger`, see [[reference_canonical_collections]]) and a client store is not
an authority for it. **Not yet adjudicated**: reaching the key is not proof it feeds a
displayed figure. Next step is to establish, per page, whether the value is *rendered*
or merely cached.

### D3 — `ops_reports` descending-`__name__` index (FIXED, undeployed)

Traced from the deployed function log to `_operationalHealth`; fix committed as
`f4422b4`, **not deployed**. Held deliberately: deploying it alone would turn `INTERNAL`
into a screen that looks healthy while D1 still supplies 5% of the score from constants.

---

## 3. Census coverage

```
330 pages scanned
159 render a money figure in their own markup or inline code
  0 render money with no canonical collection and no callable reachable
158 UNADJUDICATED
  1 CLIENT-DERIVED-CANDIDATE
```

`UNADJUDICATED` is the honest majority: the tool establishes that a canonical source is
*reachable* from the page's script graph. It does **not** establish that the displayed
figure came from it. That link is the work of the next pass.

### What the tool establishes, and what it refuses to

| Column | Filled? |
|---|---|
| PAGE | yes |
| SOURCE FILES (script graph incl. injected) | yes |
| COLLECTION / CALLABLE reachable | yes |
| localStorage keys read | yes |
| literal candidates | flagged only |
| DISPLAYED METRIC → its source | **no** |
| CALCULATION | **no** |
| AUTHORITATIVE? | **no** |
| WRITER | **no** |

The last four are adjudications. A tool that guessed them would produce a matrix that
looks complete and cannot be trusted — the exact failure this programme exists to remove.

### Detector defects found while building it

Recorded because each one produced a confident, wrong finding list:

1. **`collection(db, "orders")` was invisible.** The first regex required the name as the
   *first* argument, so it missed every modular-SDK call — including
   `seller-analytics.html:459`. The census reported that page as reaching no canonical
   collection at all.
2. **Graph-wide money detection made all 330 pages money surfaces.** `shared-header`
   renders a cart total and is on nearly every page; that is the module's property, not
   the page's. Detection is now the page's own markup and inline code.
3. **`/KES/i` matched "Li‑kes"** in `sokoniStoreLikes`, and `net` matched inside
   `spp_net_printers`, seeding the finding list with a store-likes key and a printer
   config. Then over-correcting to a single case-sensitive expression matched **nothing**
   — the list dropped from 7 rows to 0 and looked like good news.

The pattern in all three: **a detector that cannot see the dominant shape reports a
platform-wide absence.** Every list in this register carries a control that proves the
detector can still find a known instance.

---

## 4. Next — financial lineage

Highest priority, per the chain:

```
Order → Payment → Settlement eligibility → Gross → Commission → Fees
      → Seller net → Platform revenue → Ledger → Analytics
```

The question is **not** "do two pages show the same number". It is: *can one
authoritative recorded fact be identified, from which every displayed version is
derived?* Two pages that independently compute the same financial concept are
`DUPLICATE-AUTHORITY` **even when they currently agree** — agreement without a shared
source is a coincidence with a schedule.
