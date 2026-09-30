# VAT policy for SOKONI platform charges — applicability by transaction type (2026-09-30)

**Status:** POLICY FRAMEWORK + IMPLEMENTATION READY · **APPLICABILITY DECISIONS: OPEN (owner + tax adviser)** · production `revenueConfig/commission_vat` and `revenueConfig/subscription_vat` **not written** (a production write; not authorized).
**Rule this document enforces:** VAT appears on a SOKONI invoice only for a **taxable supply by a VAT-registered supplier**, at the rate and treatment the business has decided against KRA's rules. Code never infers it: unresolved ⇒ commission invoices **refuse**, subscription invoices **defer** (sweep issues once the policy exists). Nothing here turns "KRA's general rate is 16%" into "16% on every SOKONI transaction".

Related: [[COMMISSION_INVOICE_SPEC]] · [[COMMERCIAL_CONVERGENCE_2026-09-30]] · [[ETIMS_REQUIREMENTS_MATRIX]] · [[ETIMS_CERTIFICATION_READINESS]]

## 1 · KRA references the decisions must be made against

| ref | what it settles | how it reaches the code |
|---|---|---|
| VAT Act 2013 (Kenya), s.5 & First/Second Schedules (as amended) — general rate **16%**, zero-rated and exempt supplies | whether a given supply is taxable, zero-rated or exempt | `revenueConfig/*_vat.applicability` = `taxable` \| `zero_rated` \| `exempt` → `etims-tax-engine` categories A / B / C |
| VAT Act 2013 s.34 (registration threshold) and the supplier's registration status | whether **the supplier** may charge VAT at all | `applicability` decision (per supplier); the platform profile's `vatStatus` is set from the decision, not hard-coded |
| VAT Act 2013 s.42 + VAT (Electronic Tax Invoice) Regulations 2020 / Tax Procedures (Electronic Tax Invoice) Regulations 2023 — tax-invoice contents, eTIMS obligation, OSCU/VSCU integration | that a platform invoice must be an electronic tax invoice with the prescribed particulars, transmitted through eTIMS | `etims._issuePlatformInvoice` (VSCU device `SOKONI-VSCU-001`, KRA payload built by `buildKraPayload`), the existing OSCU/VSCU work in [[ETIMS_REQUIREMENTS_MATRIX]] |
| KRA guidance: VAT-inclusive vs VAT-exclusive pricing is a presentation decision on a **taxable** supply | how a stated fee is split | `inclusive: true|false` on a `taxable` policy only |

> The adviser's written reference (advice number / date) goes in each policy document's `reference` field and is echoed on every claim (`vatDecidedBy`, `invoiceVatDecidedBy`).

## 2 · Applicability matrix — decisions required

Columns: supplier → recipient · taxable supply? · VAT-registered supplier? · VAT applicable? · rate/source · invoice owner · eTIMS obligation · effective date · policy reference. **UNRESOLVED** = not decidable from the repository; owner/adviser must decide. Nothing UNRESOLVED produces VAT.

| transaction | supplier → recipient | taxable supply? | supplier VAT-registered? | VAT applicable? | rate / source | invoice owner | eTIMS / e-invoice obligation | effective | policy doc |
|---|---|---|---|---|---|---|---|---|---|
| **SOKONI commission** (marketplace 15%, POS 5%, provider ladder, hub rates, KES 5,000 property flat, KES 2,000 vehicle flat) | SOKONI → merchant/provider | a platform service fee is a supply of services in Kenya — **taxable in nature**; confirm against the adviser | **UNRESOLVED** — SOKONI's registration status is not in the repository (`ETIMS_PLATFORM_PIN` is a secret; `etims.js` *assumes* `vatStatus: "registered"` for the platform profile) | **UNRESOLVED** → today: refuse | if taxable: 16% (VAT Act s.5), treatment `inclusive` per `terms.html:255` ("SOKONI deducts and remits 16% VAT on platform fees") vs `legal-hub.html:3228` (exclusive) — the two live pages disagree; the decision must pick one and fix the other page | SOKONI (`etims._issuePlatformInvoice`, fee type `commission`, via `commission-invoice.js` from the ledger row) | yes when taxable and registered — electronic tax invoice through eTIMS (VSCU) | date the adviser confirms | `revenueConfig/commission_vat` |
| **SOKONI subscription** (`PLANS` prices, e.g. seller_basic KES 999/mo) | SOKONI → subscriber | supply of services — **taxable in nature**; confirm | **UNRESOLVED** (same fact as above) | **UNRESOLVED** → today: defer + sweep | if taxable: 16%; treatment is a SEPARATE decision from commission — advertised plan prices read as consumer prices, i.e. likely `inclusive`; not assumed | SOKONI (`subscription-invoice.js` → `_issuePlatformInvoice`, fee type `subscription`) | yes when taxable and registered | adviser date | `revenueConfig/subscription_vat` |
| **merchant / property transaction** (goods or services sold by a merchant to a buyer through SOKONI) | merchant → buyer | depends on the goods/services and the **merchant's** registration | per merchant (`etimsProfiles/{sellerUid}.vatStatus`: registered / zero_rated / exempt) | per merchant profile — **already modelled**, not a SOKONI decision | merchant's profile status → categories A/B/C | **merchant** (`etimsOnOrderCompleted` → merchant eTIMS invoice; SOKONI issues none for the sale itself) | merchant's own obligation; SOKONI transmits on the merchant's behalf only where the merchant is registered in eTIMS through SOKONI | in force | none (profile) |
| **BnB booking** (hotel/bnb 15% commission) | host → guest (accommodation) ; SOKONI → host (commission) | accommodation: **UNRESOLVED per host** (short-stay accommodation is generally standard-rated when the host is registered); commission: as row 1 | host: per profile; SOKONI: row 1 | guest invoice: host's status; commission invoice: `commission_vat` | as above | host for the stay (if issued); SOKONI for the commission | host's obligation for the stay; SOKONI's for the commission | — | `commission_vat` (commission only) |
| **property sale** (KES 5,000 flat commission) | agent/owner → buyer (property); SOKONI → agent (commission) | the property transfer itself is **outside SOKONI's invoicing** (sale of land/buildings is exempt or outside scope — adviser to confirm; SOKONI does not invoice it) | n/a for the sale; SOKONI: row 1 | only the KES 5,000 commission is SOKONI's supply → `commission_vat` | as row 1 | SOKONI for the commission only | commission only | — | `commission_vat` |
| **tenant rent record** (landlord/tenant records kept in SOKONI; no SOKONI charge) | landlord → tenant | residential rent is **exempt** (VAT Act First Schedule); commercial rent is taxable per landlord registration — **landlord's matter** | landlord | **not a SOKONI supply — no SOKONI VAT, no SOKONI invoice** | — | landlord (outside SOKONI) | landlord's | — | none |
| **water / utility charge** (recorded/passed through) | utility → tenant/landlord (SOKONI records; no SOKONI fee) | water supply is generally **exempt**; other utilities per supplier | utility | **not a SOKONI supply — no SOKONI VAT** unless SOKONI charges a fee for the service, in which case row 1 applies to that fee only | — | utility / landlord | theirs | — | none |

**Invariant:** the only supplies SOKONI itself invoices are its **own fees** (commission, subscription; the engine also knows `advertising`, `delivery`, `verification`, `premium` fee types — each would need its own applicability decision before use). Merchant-to-buyer supplies are invoiced by the merchant under the merchant's own VAT status, already modelled in `etimsProfiles`.

## 3 · What the implementation does (proven, `test-vat-policy.js` 19/0 · e2e 23/0)

```
revenueConfig/commission_vat | subscription_vat
  { enabled: true,
    applicability: 'taxable' | 'zero_rated' | 'exempt',
    inclusive: true|false          (taxable only — treatment of the stated fee),
    decidedBy: '<name>', decidedAt: <ts>, reference: '<advice ref>',
    effectiveFrom: <ts>            (optional; before this date the policy is not in force) }
```
* `taxable` + `inclusive` → engine category **A**, VAT at the engine rate (16% today, `etims-tax-engine.DEFAULTS.vatRate`), split inclusive/exclusive as stated; e.g. KES 500 inclusive → 431.03 + 68.97, exclusive → 500 + 80.
* `zero_rated` → category **B**, VAT 0; `exempt` → category **C**, no taxable amount, no VAT line.
* absent / `enabled:false` / unknown applicability / taxable without `inclusive` / no `decidedBy` / `effectiveFrom` in the future → **null** ⇒ `commission-invoice` refuses (`vat_policy_unset`), `subscription-invoice` defers and the daily sweep issues exactly once when the policy appears.
* The pre-2026-09-30 document shape (`{enabled, inclusive, decidedBy}`) still reads as `taxable` — backward compatible.
* Every issued invoice records `platformTaxCategory` and `platformVatInclusive`; every claim records `taxCategory` / `vatDecidedBy`.
* `etims._platformTaxStatusFor()` refuses any category it does not know; omitted = `standard` (the only meaning the function had before).

## 4 · How to arm (owner + adviser; a production write, not performed here)

1. Adviser confirms, in writing: SOKONI's VAT registration status; that commission and subscription fees are taxable supplies; the treatment (inclusive/exclusive) for each; the effective date; whether the stated prices on `terms.html` / `legal-hub.html` / plan pages need to change.
2. Fill `scripts/vat-policy-manifest.json` (both documents; `applicability`, `inclusive`, `decidedBy`, `reference`, `effectiveFrom`).
3. `node scripts/write-vat-policy.js --dry-run` — prints what would be written and refuses any null field.
4. With authorization: `node scripts/write-vat-policy.js --apply --authorized-by "<owner>"` (writes the two documents; refuses if `enabled` would be true with any unresolved field).
5. Verify: `test-vat-policy.js` semantics hold against the live documents (a read-only check prints the resolved policy); first invoice issued through the sweep; KRA acceptance visible on `etimsInvoices/{id}.status`.

## 5 · Still open

* SOKONI's registration status and the two decisions (§2 rows 1–2) — **owner/adviser**.
* The `terms.html` / `legal-hub.html` contradiction on inclusive vs exclusive — fix the losing page when the decision lands.
* `etimsPlatformInvoice` admin callable still defaults non-commission fee types to `vatInclusive: true` ("preserved prior behaviour") — it should read the same policy documents once they exist (follow-up; the automated paths do not use that default).
* eTIMS platform credentials (`ETIMS_PLATFORM_PIN`, `ETIMS_PLATFORM_SECRET`) must exist for any platform invoice to transmit (see [[ETIMS_CERTIFICATION_READINESS]]).
