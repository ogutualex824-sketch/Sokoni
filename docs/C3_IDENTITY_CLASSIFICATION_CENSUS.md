# C3 — existing-identity classification census, and the exact cleanup manifest

**Date:** 2026-09-29T16:47Z · **Production project** `sokoni-aeb26` · **READ ONLY** (owner-authorized, read-only scope) · nothing created, updated, deleted, stamped, migrated or deployed.
Script: `scripts/census-c3-identities.js` (re-runnable; needs application-default credentials with read access). Model: [[CAPABILITY_AUTHORITY_READ_MODEL]] (C2). Prior: [[CLASSIFICATION_STOREFRONT_CENSUS]].

Two outputs, deliberately kept apart: **A** classifies every business identity through the C2 read model; **B** lists only records positively identified by an evidence rule. Emails are redacted throughout; uids are the identifiers.

## Populations

| Auth | users | sellers | providers | businesses | shops | merchants | products | applications | posProducts | inventory_products | listings | providerServices | services |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 77 | 85 | 8 | 11 | 10 | 3 | 8 | 102 | 13 | 0 | 0 | 0 | 1 | 0 |

The second Firestore database (`sokoni-ops`) holds **no identity collection** (no users / businesses / shops / sellers / providers / products / applications). "Both databases" for user counts therefore means **Firebase Auth (77) and Firestore `users` (85)**; the earlier identical-count listing was the default-database fallback of a wrong handle, now verified.

## A · Classification census (26 identities; 0 PRODUCTS · 7 SERVICES · 12 UNCLASSIFIED · 7 CONFLICT)

Every row is `readModel({seller, provider, applications, business, shop, productCount})`. Authority status is **NOT_YET_STAMPED for all 26** — no stamp exists anywhere, as expected before the stamping slice.

| uid | Auth | name | classification | observed | conflicts / notes |
|---|---|---|---|---|---|
| `D5Ql2EYr95bt79IpcGTmOMTK0P83` | present · claims admin, superAdmin, seller, driver, rider | KASS SHOP | **CONFLICT** | seller status live, **no approval evidence**; 3 businesses, 1 shop, **102 products** (all products in the platform) | `seller_status_without_approval`, `products_without_products_capability` |
| `xrH21J5GFbW8PluCZ2ny5nIuf602` | present | KASS SHOP | CONFLICT | seller status live, no approval evidence | `seller_status_without_approval` |
| `Bxd4Lc4DQYaa3LabmJDfWtmTiN22` | present | John wa Pork | CONFLICT | seller status live, no approval evidence | `seller_status_without_approval` |
| `zewfgP9OpcSTc34x07UCecTo0Mh2` | present · `@sokoni-seller.invalid` | Maina Groceries | CONFLICT | seller status live, no approval evidence | synthetic — manifest R1/R6 |
| `13iuLZx63jN5evaNcUnx7bhDSfs1` | present · `@sokoni-provider.invalid` | Shave 'n' Trims | CONFLICT | provider status live, no approval evidence | synthetic — manifest R1/R6 |
| `AiJp5yzTnRZZIZKZEepNUKn8NuI2` | present | DJ Bvmbxno | CONFLICT | provider status live, no approval evidence | `provider_status_without_approval` |
| `aOdQxmUGLCO4hOYsdHMhWuwYV9D2` | present | King Bruce | CONFLICT | provider status live, no approval evidence | `provider_status_without_approval` |
| `Ohg9HrtGpCXBUSzbRfaUifOPWQ32` | present · claim provider | **DG wines and spirits** | **SERVICES** | provider live; approved SERVICES application; no seller, business, shop; **0 products in every product-bearing collection** | — |
| `IaOBkEJYcCXk23UDWk0OPp7XXeD3` | present · claim provider | **Latomi gadgets** | **SERVICES** | same shape as DG Wine | — |
| `WLt0VowwtFcFADIJDIxXu3e6H1p1` | present · claim provider | Kasindi holdings limited | SERVICES | provider live; seller present-not-live; approved SERVICES | — |
| `3SkVHLqJXzfeQlQ4PfBx5DFR4at2` | present · claim provider | k Riss | SERVICES | provider live; approved SERVICES | — |
| `FqmCT4t4KehQD6EJR4m3dLVbHBo1` | present · claim provider | Julian's Closet | SERVICES | provider live; approved SERVICES | — |
| `H7p6ktBHogM5GcBy6mz8negKVbG2` | present · claim provider | Langa'ta mamafua | SERVICES | provider live; approved SERVICES | — |
| `X7KZGTy3ouYmGESePPxKVlC3j613` | present · claim provider | Hometown Movers kenya | SERVICES | provider live; approved SERVICES | — |
| `28vznyvnLyNFXAJqL2wf6PjbqrK2` | present | Heights Creations | UNCLASSIFIED | provider present-not-live; **pending PRODUCTS and SERVICES applications** | proposed pending/pending |
| `FVolUQUwrWTYrlg79EG84ygS75p1` | present | — | UNCLASSIFIED | seller present-not-live | — |
| `LDBKlzIUJMQPN4iSVksszKXtsaw1` | present | — | UNCLASSIFIED | seller present-not-live | — |
| `TuOa5Ju5kXWJKzTIMosmv1a06tO2` | present | — | UNCLASSIFIED | seller present-not-live | — |
| `vbaSOKL4h8WWGqa6Xfi1eLaEPnS2` | present · never signed in | SOKONI Store (first-party) | UNCLASSIFIED | business + shop present; no sellers/providers doc | first-party identity is a designated chain, not a registry doc — see the first-party memory |
| `uwpD5gx3pvPusUz3FNohykg6vch2` | present · claims admin, superAdmin | WOODLANDS | UNCLASSIFIED | 1 business, nothing else | — |
| `EmV3RXLmPmVE8TWRBlg3u7WKopp1` | present · `@sokoni-probe.invalid` | ZZ Probe Shop 11711416 | UNCLASSIFIED | 1 shop | synthetic — manifest R1/R6 |
| `uid1`, `uid2`, `SELLER_A`, `SELLER_A_uid_7f3`, `MERCHANT_A_uid_11` | **ABSENT** | FRED, Rider, Shop B Traders ×2, Merchant A Traders | UNCLASSIFIED | one orphaned `businesses/SOK-*` + `merchants/SOK-*` pair each | synthetic — manifest R2/R4 |

**What A establishes.** No identity in production is PRODUCTS today by the approved-fact rule: the only product-bearing identity (KASS SHOP, 102 products, the account holding admin and superAdmin claims) has a seller record whose live status carries **no protected approval evidence**, so under the model it is CONFLICT until an admin decision stamps it. Seven real providers are cleanly SERVICES. Four provider/seller records were made "live" by a client-writable status alone. DG Wine and Latomi Gadgets are confirmed provider-only across `products`, `posProducts`, `inventory_products`, `listings`, `providerServices` and `services`: **zero rows** each.

## B · Exact cleanup manifest — 34 records, digest `028299e7442516d93f3a6a2ed1555bda09f548b4ee0dd0cfbbdcc1eebbad13e2`

Machine copy: `docs/release-gates/c3-cleanup-manifest.json` (ids + rule + redacted reason; the digest is SHA-256 over the sorted `collection/id` list).

| Rule | Evidence | Records |
|---|---|---|
| **R1** | Auth account on an RFC 2606 reserved `.invalid` domain (can never be a real mailbox), plus its own `users` doc | 4 accounts: `13iuLZx6…` (`@sokoni-provider.invalid`), `EmV3RXLm…` (`@sokoni-probe.invalid`), `MtexojeA…` (`@sokoni-probe.invalid`), `zewfgP9O…` (`@sokoni-seller.invalid`); 3 users docs |
| **R2** | `users/{uid}` with no Auth account | 14 docs: `GF07atbC…`, `rBAh3v1L…`, `sHyNYc8m…`, `uwlaFShG…`, `xXGMP1XI…`, `MERCHANT_A_uid_11`, `SELLER_A`, `SELLER_A_uid_7f3`, `zzz_annual`, `zzz_diag_merchant`, `zzz_release_verify_synthetic`, `zzz_skew_1/2/3` |
| **R3** | `sellers`/`providers` doc with no Auth account | none |
| **R4** | `businesses`/`merchants`/`shops` whose owner uid has no Auth account | 10 docs: businesses and merchants `SOK-84YM4L` (uid2), `SOK-ALM49S` (SELLER_A_uid_7f3), `SOK-LZMNWQ` (MERCHANT_A_uid_11), `SOK-RAH2MR` (uid1), `SOK-UHE9XA` (SELLER_A) |
| **R5** | `products` whose sellerUid has no Auth account | none |
| **R6** | registry/business/shop/product records owned by an R1 account | `sellers/zewfgP9O…`, `providers/13iuLZx6…`, `shops/EmV3RXLm…` |

Five of the R2 docs (`GF07…`, `rBAh…`, `sHyN…`, `uwla…`, `xXGM…`) are orphaned profiles of accounts that no longer exist; they are positively orphaned (rule R2) but were not necessarily test data — the rule is orphan, not fake, and the manifest says which.

### The deletion protocol (not started, not authorized by this document)

```
manifest (this digest)
   ↓ re-census with the same script
   ↓ exact-set equality on collection/id — any difference → ABORT, nothing deleted
   ↓ explicit deletion authorization from the owner, naming the digest
   ↓ deletion, one record class at a time, re-verified per record immediately before removal
```

## C · Candidates needing the owner's judgement (NOT in the manifest — inference, not evidence)

- `products/QATEST100` "SOKONI QA Test Product", owned by the KASS SHOP admin account. Named like a test, owned by a real account.
- Auth account `6Cnsq1SQ…`: no email, no phone, no provider, created and last signed in within the same second (2026-09-09). Anonymous-shaped; not positively synthetic.
- Three Auth accounts with real mailboxes and no `users` doc (`OvkHsvTd…`, `Q33rsdUw…`, `UI4IeP1c…`, Aug 2026, each signed in once): real people whose profile was never written. Not fake; a data-integrity gap, not a cleanup item.
- The KASS SHOP identity (`D5Ql2…`) and its 102 products: the platform's only product catalogue, on an account carrying admin and superAdmin claims. Real or seed is the owner's call; the read model reports CONFLICT because approval evidence is absent, nothing more.

## D · The user-count discrepancy, restated with the exact sets

Auth 77 · Firestore users 85 · **6** Auth accounts without a users doc (4 real-looking, 1 probe `.invalid`, 1 first-party store owner) · **14** users docs without an Auth account (all in manifest R2). After the manifest, if authorized in full: Auth 73, users 68; still 5 Auth-without-doc. The admin-console stat must show all four numbers, unknown as a dash, and never reconcile silently.

## E · Consequences for the track

- The DG Wine / Latomi migration cases are deterministic: row = SERVICES / NOT_YET_STAMPED / no conflicts; create the business identity under the existing uid, stamp **SERVICES only**, keep the provider record, connect a branch — no PRODUCTS stamp, because there are none.
- Stamping PRODUCTS for KASS SHOP is an admin decision the model cannot make; it is the one identity whose products exist today.
- The four `*_status_without_approval` conflicts (two synthetic, two real: DJ Bvmbxno, King Bruce; plus John wa Pork and the second KASS SHOP seller) are exactly the client-writable-status defect the model was built to expose; they must be resolved by an admin decision, never by relaxing the rule.
