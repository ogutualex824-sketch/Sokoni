# CompanyIdentity — Governance Dependency Map

**Status:** ✅ Centralized & verified
**Date:** 2026-07-11
**Scope:** Final Enterprise Governance Audit — single canonical source for all corporate metadata.

> Legal owner: **Bravilex International Co. Limited** · Consumer brand: **SOKONI** (customer-facing, unchanged).

---

## 1. Canonical sources (the *only* two places corporate metadata is defined)

| Layer | File | Export | Consumed by |
|-------|------|--------|-------------|
| **Server** | [`functions/company-identity.js`](../functions/company-identity.js) | `COMPANY` (frozen), `ETIMS_PLATFORM_PIN`, `getKraPin()`, `invoiceIssuer()`, `receiptIssuer()`, `posIssuer()`, `pdfMeta()`, `orgSchema()`, `emailFooter()` | All Cloud Functions |
| **Client** | [`sokoni-company.js`](../sokoni-company.js) | `window.SOKONI_COMPANY` (+ `orgSchema()`, `receiptIssuer()`) | Browser/PWA runtime |

The two files are kept in **lock-step** (identical field values). The server never ships the KRA PIN in source — it reads it from **Secret Manager (`ETIMS_PLATFORM_PIN`)** via `getKraPin()`. The client copy carries the KRA PIN only because it is a **legally-public** identifier printed on tax receipts and needs to render on offline/on-device SmartPOS receipts.

### Fields covered
Legal entity name · Brand name · Operating name · KRA PIN (secret on server) · Income-tax status · Registered office address · Postal address¹ · Official company email · Billing email · Support email · Official phone numbers · Website · Domain · Copyright text · "Powered by" / "Operated by" text · Ownership statement · Organization JSON-LD schema · Invoice issuer block · Receipt issuer block · SmartPOS issuer block · PDF metadata · Email-footer metadata.

¹ `postalAddress` and `registrationNumber` are present but empty (`''`) — flagged **TODO**, pending verified P.O. Box and company registration number.

---

## 2. Dynamic consumers (import/read the canonical source — enforced)

These modules generate documents/output at runtime and now consume CompanyIdentity instead of literals.

### Server (`require('./company-identity')`)
| File | What it consumes |
|------|------------------|
| `functions/index.js` | `COMPANY.footerCopyright` (2 generated footers); `COMPANY.ownershipStatement` (KASS admin + marketplace prompts) |
| `functions/sasos-billing.js` | `COMPANY.legalName`, `COMPANY.address`, `COMPANY.billingEmail`; `ETIMS_PLATFORM_PIN` secret handle (invoice issuer) |
| `functions/etims.js` | `COMPANY.legalName` (platform tax-invoice taxpayer name — must match PIN owner), `COMPANY.operatedBy`, `COMPANY.poweredBy`, `COMPANY.address`, `COMPANY.supportEmail`, `COMPANY.website`; `ETIMS_PLATFORM_PIN.value()` |
| `functions/hub-etims.js` | `COMPANY.legalName`, `COMPANY.operatedBy`, `COMPANY.poweredBy` |
| `functions/pos-retail.js` | `COMPANY.legalName`, `COMPANY.operatedBy`, `COMPANY.poweredBy` (POS receipts) |
| `functions/pos-retail-engine.js` | `COMPANY.*` issuer/footer strings |
| `functions/pos-ai-assistant.js` | `COMPANY.legalName`, `COMPANY.ownershipStatement` (KASS SmartPOS prompt) |
| `functions/email-templates.js` | `COMPANY.*` footer / issuer strings |

### Client (`window.SOKONI_COMPANY`)
| File | What it consumes |
|------|------------------|
| `security.js` | Injects `sokoni-company.js` globally on every page (single bootstrap) |
| `seo.js` | `SOKONI_COMPANY.brand`, `SOKONI_COMPANY.legalName` for Organization JSON-LD (literal fallback for load-timing resilience) |
| `sokoni-receipt.js` | `SOKONI_COMPANY.kraPin`, `SOKONI_COMPANY.operatedBy` (SmartPOS/offline receipts) |
| `age-gate.js` | `SOKONI_COMPANY.footerCopyright` (access-denied footer, literal fallback) |

---

## 3. Static legal/marketing artifacts (intentionally literal — guarded, not injected)

27 static HTML files carry the legal-entity literal in **legal prose**, **page footer copyrights**, and **per-page JSON-LD** (e.g. `terms.html`, `privacy.html`, `legal.html`, `cookie-policy.html`, `about.html`, `contact.html`, `careers.html`, `press.html`, and all policy pages).

**Design decision:** these are **not** converted to runtime JS injection. A legal notice or copyright line must never render blank because a script failed to load — static text is the correct, auditable artifact for compliance. Instead, drift is prevented by a **consistency guard**:

- [`scripts/verify-company-identity.js`](../scripts/verify-company-identity.js) loads the canonical `sokoni-company.js` and **fails CI** if any file:
  - contains an **obsolete literal** (old entity spellings, `SOKONI Ltd`, retired KRA-PIN placeholders `P051999999K` / `P051234567X`), or
  - mentions "Bravilex" **without** the current canonical legal name (catches drift/typos).

Run: `node scripts/verify-company-identity.js` → currently **✅ consistent across 809 files.**

---

## 4. No duplicate metadata sources remaining — verification

| Check | Result |
|-------|--------|
| Obsolete KRA-PIN placeholders (`P051999999K`, `P051234567X`) in source | **0** |
| Verified KRA PIN `P051521597J` in source | **1** — only `sokoni-company.js` (legally-public receipt copy); server uses Secret Manager |
| `SOKONI Ltd` / legacy entity literals | **0** (last one in `etims.js:1088` fixed) |
| "Bravilex" references not matching canonical legal name | **0** |
| Consistency guard | **✅ pass (809 files)** |

**Buyer/seller KRA PIN fields were deliberately not touched** — those are third-party taxpayer identifiers, not company metadata.

---

## 5. Deployment status (blocked — requires user action)

The refactor is code-complete and validated (`node --check` passes on all edited files). Deployment is **blocked by GCP billing being disabled** on project `sokoni-aeb26`:

1. **Re-enable billing** → https://console.cloud.google.com/billing/enable?project=sokoni-aeb26
2. Set the secret: `firebase functions:secrets:set ETIMS_PLATFORM_PIN` → value `P051521597J`
3. Deploy functions (Cloud Run quota permitting) + hosting.

Until then, server `getKraPin()` returns `''` and document generators omit the PIN gracefully (no crash); the client receipt copy already renders the correct PIN.

---

## 6. Maintenance rule

> **To change any corporate metadata:** edit `sokoni-company.js` **and** `functions/company-identity.js` (keep them identical), then run `node scripts/verify-company-identity.js`. Never hardcode corporate literals in a new generator — import the canonical source. For a new static legal page, use the exact canonical strings so the guard passes.

Related: [[project_launch_cert_v1]] · [[BRAVILEX_INTEGRATION_REPORT]] · [[PHASE_4_ARCHITECTURE_AUDIT]]
