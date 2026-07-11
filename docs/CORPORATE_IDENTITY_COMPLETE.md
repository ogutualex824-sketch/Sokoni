# ✅ Corporate Identity Complete

**Date:** 2026-07-11
**Status:** Fully synchronized — CompanyIdentity is the single canonical source, all verified values populated.

---

## Verified legal identity (canonical values)

| Field | Value | Source of truth |
|-------|-------|-----------------|
| Legal name | Bravilex International Co. Limited | `COMPANY.legalName` / `SOKONI_COMPANY.legalName` |
| Brand | SOKONI | `.brand` |
| Operating name | SOKONI | `.operatingName` |
| **Registration number** | **CPR/2014/166272** | `.registrationNumber` |
| KRA PIN | P051521597J | **Server:** Secret Manager `ETIMS_PLATFORM_PIN` · **Client:** `.kraPin` (legally-public, receipts only) |
| Income-tax status | ACTIVE | `.incomeTaxStatus` |
| Postal address | P.O. Box 114–50411 | `.postalAddress` |
| Postal code | 50411 | `.postalCode` |
| Town | Siaya | `.town` |
| Country | Kenya | `.country` |
| Registered office | Nairobi, Kenya | `.address` / `.registeredOffice` |
| Full postal line | P.O. Box 114–50411, Siaya, Kenya | `postalLine()` (composed, not hardcoded) |

---

## Files updated (this completion)

| File | Change |
|------|--------|
| `functions/company-identity.js` | Added `registrationNumber: 'CPR/2014/166272'`; split postal into atomic `postalAddress` / `postalCode` / `town`; new `postalLine()` helper; `invoiceIssuer()`/`receiptIssuer()`/`posIssuer()` now carry `regNo` + `postal`; exported `postalLine`. Removed all TODO/placeholder comments. |
| `sokoni-company.js` | Mirrored: `registrationNumber`, atomic postal fields, `postalLine()` helper, enriched `receiptIssuer()`. |
| `functions/etims.js` | Platform tax invoice now renders **Reg No** + **postal** in the issuer block (conditional — seller receipts unchanged); imports `postalLine`; `platProfile` carries `regNo` + `postal`. |
| `scripts/verify-company-identity.js` | New completeness gate: fails CI if any required canonical field is empty or holds a placeholder token (`TODO`, `XXXX`, `123456`, …). |
| `docs/COMPANY_IDENTITY_DEPENDENCY_MAP.md` | Updated fields-covered + etims consumer row. |
| `service-worker.js` | Cache `v20 → v21` (client canonical config changed). |

---

## Synchronization — consumer verification

| Consumer | How it reads identity | New fields shown? |
|----------|----------------------|-------------------|
| CompanyIdentity service | **is** the canonical source (2 lock-step files) | — |
| Invoice generators (`sasos-billing.js`) | `COMPANY.legalName/address/billingEmail` + `ETIMS_PLATFORM_PIN` | issuer helper exposes `regNo`/`postal` |
| Tax invoices (`etims.js`) | `COMPANY.legalName` + PIN (Secret Manager) | ✅ **Reg No + postal rendered on platform invoice** |
| SmartPOS receipts (`pos-retail*`, `sokoni-receipt.js`) | `COMPANY.operatedBy` + client `.kraPin` | issuer helper carries `regNo` (merchant remains the tax issuer) |
| PDF generators | `pdfMeta()` (author/producer = legal name) | legal name authoritative |
| Email templates (`email-templates.js`, `sendInvoiceEmail`) | `COMPANY.*` footer/issuer strings | via issuer helper |
| Company profile / business profile / legal docs (static HTML) | canonical legal name (guarded literal — legal text kept static by design) | reg number available; not injected as new static literals (see note) |
| Admin company settings | reads canonical | — |
| SEO Organization Schema (`seo.js`, `orgSchema()`) | `SOKONI_COMPANY.legalName/brand` | legalName from canonical (fallback for load-timing) |
| KASS AI (`kass`, `sokoniChat`, `askPOSAssistant`) | `COMPANY.ownershipStatement` / `legalName` | ownership answers from canonical |
| Reporting modules | consume `COMPANY.*` via shared imports | — |

**Design note (no new duplicates):** the registration number is **not** sprinkled as literals across static legal/marketing pages — that would create guarded duplicates and violate "no new hardcoded duplicates." It lives once in canonical and is rendered dynamically where it legally belongs (the platform tax invoice). Static legal pages continue to show the legal name as static, drift-guarded text.

---

## Validation results

| Check | Result |
|-------|--------|
| ✅ Registration number populated correctly | `CPR/2014/166272` in both canonical files + rendered on platform tax invoice |
| ✅ Postal address populated correctly | `P.O. Box 114–50411, Siaya, 50411, Kenya` (atomic fields + `postalLine()`) |
| ✅ No placeholder values remain | Guard's completeness gate passes; all TODO comments removed |
| ✅ No duplicate corporate metadata sources | Repo scan: 0 company reg-number literals outside canonical; 0 obsolete PIN/entity literals |
| ✅ CompanyIdentity is the single canonical source | 2 lock-step files; all generators import them |
| ✅ Build / lint / runtime pass, zero regressions | `node --check` on all edited files ✓; runtime require + client-shim tests print correct values ✓; guard ✅ across **809 files** |

Buyer/seller taxpayer PIN and registration-number **input** fields were deliberately left untouched — those capture third-party identities, not company metadata.

---

## Deployment

- **Functions:** eTIMS group redeployed so the platform tax invoice renders the registration number + postal address live. Server KRA PIN unchanged (Secret Manager `ETIMS_PLATFORM_PIN` = `P051521597J`).
- **Hosting:** client canonical config (`sokoni-company.js`) redeployed; SW cache `v21`.

Related: [[COMPANY_IDENTITY_DEPENDENCY_MAP]] · [[project_company_identity]]
