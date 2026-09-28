# Commission Invoice — Spec and Implementation

> **R-48H — RETIRED (owner ruling 2026-09-28).** The 48-hour per-sale marketplace commission this document describes (`billingModel: PER_SALE_48H`, a 48 h `dueAt`, a 46 h reminder, the hourly `sweepCommissionDue`, penalties and `sellerRestrictions`) is REMOVED from source. All commission is billed MONTHLY via `generateMonthlyInvoices`; the commission rate authority is unchanged. Production held 0 PER_SALE_48H rows and 0 restrictions at retirement. The deployed `sweepCommissionDue` / `getCommissionBalance` / `getSellerRestriction` are deleted only by a separately authorized production operation. Kept as history. `issueCommissionInvoice` (which invoiced only PER_SALE_48H rows) is no longer exported; `functions/commission-invoice.js` stays in the tree solely as the RESOLVED module recorded in `docs/DEPLOY_TREE_DISPOSITIONS.json`.

**Status:** **BUILT 52/0 · NOT DEPLOYED · NO INVOICE CAN ISSUE** — see §9
**Date:** 2026-08-27 (§0–§8 written as a read-only design pass; §9 records the build)

> The generator exists and is certified. **Issuing is impossible** while
> `revenueConfig/commission_vat` is unset — verified absent in production (404). Decisions
> **#2** and **#3** also remain unresolved and block issuance independently of the code.
**Related:** [[COMMISSION_ENFORCEMENT_CONTRACT]] · [[MERCHANT_OWNED_PAYMENTS]] · [[POS_MANUAL_TILL_PAYMENT]]

---

## 0. The finding that changes the plan

> **Do NOT create a `commissionInvoices` collection.**
> A SOKONI→merchant commission invoice already exists, is deployed, and is KRA-fiscalised.

`etimsPlatformInvoice` (`functions/etims.js:924`, exported `index.js:11278`) is **ACTIVE in
production**. It already implements almost everything the proposed collection would:

| Requirement | Already built |
|---|---|
| Invoice number `SOKONI-000001` | `nextSeq('_platform_sokoni')` — transactional counter |
| Merchant / Shop | `billToSellerUid`, buyer resolved from `shops` + `etimsProfiles` |
| Gross / rate / amount | `lineItems` → `calcLine` → `calcTotals` |
| Tax & adjustments | full KRA VAT computation, `vatStatus: 'registered'` |
| Amount due | `totals` |
| Payment reference | `orderId: reference` |
| Idempotency | `platform-{feeType}-{reference}` + duplicate pre-check |
| Fee type | `FEE_LABELS.commission` = "Platform Commission Fee" |
| Collection | `etimsInvoices`, `isPlatformInvoice: true` |

Both required secrets (`ETIMS_PLATFORM_PIN`, `ETIMS_PLATFORM_SECRET`) exist in Secret Manager.

Creating `commissionInvoices` would make this the **fifth** parallel financial system in a
platform that already paid for nine disagreeing commission tables, three POS sale
collections, and three incompatible schemas inside one `invoices` collection.

## 1. What is actually missing

Three gaps, all about **linkage and authority** — not about the invoice document.

### Gap A — the amount comes from the caller, not the ledger

```js
const { sellerUid, feeType, amount, reference, description } = req.data;   // etims.js:927
```

`etims.js` contains **zero** references to `commissionLedger`. An admin types an amount. So
today the invoice *can* disagree with the receivable, which is precisely the failure the
"invoice must not become a second source of truth" rule exists to prevent.

**Required:** the generator reads `commissionLedger/{id}` and derives the amount from
`totalOwed` / `totalOutstanding`. The caller may identify the receivable; it may never state
the amount.

### Gap B — no automatic generation from a 48-hour receivable

`etimsPlatformInvoice` is `onCall` + `isAdmin` — manual, one at a time. Nothing connects it
to `billingModel: 'PER_SALE_48H'`. The monthly generator (`index.js:5393`) explicitly skips
those rows.

### Gap C — no write-back

**The linkage field already exists.** Every `commissionLedger` row is written with
`invoiceId: null` (`index.js`, in the same object as `billingModel` and `collectionStatus`).
The monthly path populates it. The 48-hour path never does.

So the extension is: populate a field that is already there.

## 2. The smallest extension

```
commissionLedger/{id}            ← AUTHORITATIVE. amount lives here.
  billingModel: PER_SALE_48H
  collectionStatus: DUE
  invoiceId: null                ← field already exists
        │
        │  generator: reads the row, derives the amount
        ▼
etimsPlatformInvoice (existing, KRA-fiscalised)
  feeType: 'commission'
  reference: <ledgerRowId>       ← makes the existing idempotency key deterministic
        │
        ▼
etimsInvoices/{invoiceId}
        │
        ▼
commissionLedger.invoiceId = invoiceId    ← write-back, the only ledger mutation
```

Merchant pays → `commissionSettlements/{paymentRef}` (**unchanged**, single writer, already
idempotent) → `collectionStatus: PAID`.

**One new function. No new collection. No new settlement engine. No new calculator.**

### Invariants

1. **The invoice never states an amount of its own.** Derived from the ledger row at
   generation, and the row remains authoritative if they ever disagree.
2. **The invoice references the receivable; it does not create one.** A commission
   obligation arises from order completion (§6a), never from an invoicing run.
3. **Immutable once issued.** `etimsInvoices` rows are KRA-fiscalised; a change is a credit
   note, never an edit. This is already how eTIMS works.
4. **Idempotent per receivable.** Using `reference = <ledgerRowId>` makes the existing
   `platform-commission-{reference}` key deterministic — one invoice per receivable, and a
   retry returns the existing one.
5. **`commissionSettlements` is untouched.**

## 3. Escrow is rail-specific — and the merchant-owned rail has none

| Rail | Custody | Correct vocabulary |
|---|---|---|
| Merchant-owned M-PESA | **SOKONI holds nothing** | `DUE / OVERDUE / PAID / WAIVED / DISPUTED` — a receivable |
| IntaSend / platform | SOKONI genuinely holds funds | hold / release — FinOS `holdWalletTxn` / `releaseHoldTxn`, already built |

> Calling the merchant-owned flow "escrow" would state that SOKONI custodies money it never
> receives. `HELD` and `RELEASED` are claims about possession, and on that rail they would be
> false.

**No new escrow state machine.** The 48-hour vocabulary is already correct for the rail that
lacks custody, and FinOS already implements hold/release for the rail that has it.

## 4. ⚠️ Open question with money attached — VAT

The existing platform-invoice path runs full KRA VAT computation (`calcLine(..., 'registered')`).
Nothing in the commission modules carries VAT handling. So on a KES 10,000 sale at 5%:

| If the KES 500 is… | SOKONI nets | Merchant owes |
|---|---|---|
| **VAT-inclusive** | ~431 | 500 |
| **VAT-exclusive** | 500 | 580 |

That is a ~16% difference in platform revenue, and it changes what merchants are billed.

**This is a commercial decision, not a technical one.** It must be stated explicitly before
any invoice is issued, because an issued fiscal invoice cannot be quietly corrected — only
credit-noted. The seller agreement's "5% (minimum KES 10)" wording does not currently say
which it is.

## 5. Other open questions

* **Does a 48-hour receivable need a fiscal invoice at all, or a rendered statement?** A KRA
  invoice per sale, at marketplace volume, is a large fiscalisation load. A monthly
  *statement* summarising receivables is a different, cheaper instrument. The answer decides
  whether the generator runs per-sale or per-period.
* **Merchant KRA PIN is optional.** Buyer resolution falls back to `{name: "Platform Client"}`
  when `etimsProfiles/{uid}` has no PIN. Whether a commission invoice may be issued without
  the merchant's PIN is a compliance question.
* **eTIMS certification status.** The project record notes eTIMS certification blocked on a
  KRA document. Issuing live fiscal invoices may be gated on that independently of this work.
* **Failure mode.** If KRA submission fails, the receivable must remain valid and unchanged —
  the obligation exists whether or not a document was successfully fiscalised. The generator
  must never alter `collectionStatus` on an invoicing failure.

## 5b. IMPLEMENTATION FROZEN — four decisions must land first

Frozen 2026-08-27. The architecture is agreed and contained; it does not proceed until
these are answered, because three of them change what a merchant owes.

| # | Decision | State |
|---|---|---|
| 1 | Is the 5% commission VAT-inclusive or VAT-exclusive? | **OPEN — blocking** |
| 2 | Invoice per sale, or aggregate into a periodic statement? | OPEN |
| 3 | May a commission invoice be fiscalised with no merchant KRA PIN? | OPEN |
| 4 | If KRA fiscalisation fails, does the receivable remain DUE? | **DECIDED: yes** |

### 4 — DECIDED 2026-08-27

> **Fiscalisation failure must not erase or alter the underlying obligation.**

The receivable arises from order completion (§6a), not from a document. A KRA submission
failure is a documentation failure, not a commercial one. The generator must never touch
`collectionStatus`, `totalOwed`, `totalOutstanding` or `dueAt` on any failure path. It may
only ever write `invoiceId` on success.

### 1 — ⚠️ THE CODE HAS ALREADY CHOSEN, AS A LIBRARY DEFAULT

```js
const inclusive = cfg.inclusive !== false;   // etims-tax-engine.js — absent config ⇒ INCLUSIVE
```

`etims.js:172` calls `TaxEngine.computeLine(item, vatStatus)` with **no config argument**, and
**no caller anywhere passes one**. So an admin invoking the live `etimsPlatformInvoice` today
with `feeType:commission, amount:500` produces:

| | |
|---|---|
| merchant owes | **500.00** |
| VAT (extracted from within) | 68.97 |
| SOKONI recognises | **431.03** |

That is **VAT-inclusive**, matching `terms.html:255` — **by coincidence, not by decision.**
Flipping one library default silently reprices every commission invoice to KES 580, with no
code review anywhere near the commission modules.

> **Live exposure:** `etimsPlatformInvoice` is ACTIVE, both eTIMS secrets are configured, and
> nothing blocks an admin from issuing a commission invoice today at a VAT treatment nobody
> signed off. Admin-only and manual, so it will not fire by itself — but it is not gated.

**Requirement when implementation resumes:** the generator must pass `inclusive` **explicitly**,
whichever way the decision goes — even if the answer is inclusive and behaviour is unchanged.
Relying on a default that happens to be correct is how this became invisible.

### 1 — the evidence, which does not agree with itself

**SOKONI is VAT-registered.** Its own eTIMS profile is `vatStatus: "registered"`
(`etims.js:949`), so the commission is a taxable supply. This is not optional.

Two **live, published** statements conflict:

| Source | Text | Reads as |
|---|---|---|
| `terms.html:255` | "SOKONI **deducts** and remits 16% VAT on platform fees" | VAT-**inclusive** |
| `legal-hub.html:3228` | "VAT (if applicable) shall be **charged** at the prevailing rate" | VAT-**exclusive** |

Both pages are live on `mysokoni.co.ke`. The seller-agreement acknowledgement gate
(`application-lifecycle.js:972`) records only "5% per-sale commission (minimum KES 10)" and
says nothing about VAT at all.

> ⚠️ **This is now a legal question as much as a commercial one.** Merchants have been shown
> both statements. Whichever treatment is chosen, **one published page is wrong and must be
> corrected**, and merchants approved under the current agreement acknowledged neither
> treatment explicitly.

Restating the money, since it is the point:

| KES 10,000 sale @ 5% | SOKONI recognises | Merchant owes |
|---|---|---|
| VAT-inclusive (`terms.html` reading) | ~431 | 500 |
| VAT-exclusive (`legal-hub` reading) | 500 | 580 |

**No invoice may be issued until this is decided.** An issued fiscal invoice cannot be
quietly corrected — only credit-noted — so an error here is durable and visible to KRA.

## 6. What this spec does NOT change

`commission-config.js` (rate authority, predeploy-guarded) · FinOS `ledger` + reversals ·
`commissionLedger` state machine · `commissionSettlements` · hold/release on the IntaSend
rail · `productionAuthorized` (closed) · Daraja / STK / C2B (frozen) · the held POS release
`233ac4d`.

## 7. Certification before implementation

Per the agreed sequence, the schema is certified against the existing authorities first:

- [ ] the generator derives its amount from `commissionLedger`, never from a caller
- [ ] `reference = ledgerRowId` yields one invoice per receivable, and a retry is a no-op
- [ ] `commissionLedger.invoiceId` is populated, and nothing else on the row is mutated
- [ ] an invoicing failure leaves `collectionStatus` untouched
- [ ] `commissionSettlements` is not written by the generator
- [ ] no new commission rate or minimum appears anywhere (predeploy guard must still pass)
- [ ] the merchant-owned rail produces no `HELD` / `RELEASED` state
- [ ] VAT treatment matches the recorded commercial decision (§4) — **blocked until decided**

**Superseded by §9 (2026-08-27): the generator IS built and certified 52/0.** What that
section said still holds where it matters — **§4 must be answered before any invoice can be
issued** — but it is now enforced by code rather than by convention: with the VAT policy
unset, every issuing path refuses.

---

## 9. IMPLEMENTATION — BUILT 2026-08-27 · 52/0 · **NOT DEPLOYED**

> **No commission invoice can be issued.** The VAT policy is unset, and unset means
> refuse. This is enforced by code, not by remembering.

### Certification

`scripts/test-commission-invoice.js` — **52 passed, 0 failed**.
Regressions: `test-etims-tax-engine` 22/22 (**incl. 5,100 fuzz cases**) ·
`test-commission-5pct-agreement` 51/0 · `test-commission-48h-destinations` 87/0 ·
`test-commission-balance-ui` 39/0 · commission single-source predeploy gate **PASS**.

### The twelve recorded points

| # | Point | Where enforced |
|---|---|---|
| 1 | 52/0 implementation certification | `scripts/test-commission-invoice.js` |
| 2 | `revenueConfig/commission_vat` has **no implicit default** | `commission-vat-policy.js` — no literal `inclusive: true/false` exists in the file |
| 3 | **No VAT policy → no commission invoice** | `loadVatPolicy` returns `null`; every caller refuses |
| 4 | Amount comes **exclusively** from `commissionLedger`; caller cannot supply one | callable takes `ledgerRowId` only — there is no `amount` parameter |
| 5 | Failed fiscalisation **cannot** modify the receivable's financial state | tested as *absence*: no write of `collectionStatus`, `totalOwed`, `totalOutstanding`, `dueAt`, `penaltyKES` on any path |
| 6 | `etimsPlatformInvoice` remains the **single** invoice engine | `_issuePlatformInvoice` extracted and reused; generator writes no invoice collection |
| 7 | `reference = ledgerRowId` gives deterministic idempotency | engine key becomes `platform-commission-{ledgerRowId}` |
| 8 | Concurrent attempts cannot produce two invoices | transactional re-check of `invoiceId` before write-back |
| 9 | Real TaxEngine behaviour tested for **both** interpretations | §F drives the engine: 500/68.97/431.03 vs 580/80/500 |
| 10 | Decisions **#2** (frequency) and **#3** (KRA PIN) remain **unresolved and block issuance** | §5b |
| 11 | Decision **#4** (KRA failure ≠ debt erased) is **decided** | §5b, enforced by point 5 |
| 12 | **No deployment, no production invoice issuance** | nothing deployed; policy unset |

### Fail-closed conditions — any one refuses

`revenueConfig/commission_vat` absent · `enabled !== true` · `inclusive` not a boolean
(no truthy coercion) · `decidedBy` missing — *an unattributable tax decision is not a
decision* · document unreadable.

### The VAT gate is scoped to `commission`

```js
const VAT_GATED_FEE_TYPES = new Set(["commission"]);
```

The dispute on record is about the 5% commission specifically. Subscription, advertising,
delivery, verification and premium are separate commercial instruments with no such
conflict, and they keep **exactly** the behaviour they already had.

> Gating every platform fee on the commission decision would take working billing offline
> to protect a question that does not apply to it — an unrelated production regression.

`vatInclusive: true` for the others is **not a new decision**: it is what TaxEngine has
always applied via `cfg.inclusive !== false`, now stated out loud instead of inherited. If
another fee type is found to have its own unresolved position, it needs **its own gate** —
not this one widened.

### To arm, once the tax position is formally decided

```
revenueConfig/commission_vat
  { enabled: true, inclusive: <true|false>,
    decidedBy: '<name>', decidedAt: <ts>, reference: '<advice ref>' }
```

Decisions **#2 and #3 must also be answered** — arming the VAT policy alone does not make
issuance correct, only possible.

### Files

`functions/commission-vat-policy.js` (new) · `functions/commission-invoice.js` (new) ·
`functions/etims.js` (taxConfig threaded; `_issuePlatformInvoice` extracted; scoped gate) ·
`functions/index.js` (re-export) · `scripts/test-commission-invoice.js` (new, 52/0)

**Not deployed. `issueCommissionInvoice` does not exist in production.**
