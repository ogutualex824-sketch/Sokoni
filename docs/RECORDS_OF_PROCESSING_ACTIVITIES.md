# SOKONI — Records of Processing Activities (RoPA) & Processor / DPA Register

**Data Controller / Processor:** Bravilex International Co. Limited (Reg. CPR/2014/166272), Nairobi, Kenya
**ODPC registration:** Registered Data Processor — Reg. No. **630-8669-F056**, valid 28 Jul 2026 – 28 Jul 2028
**Platform:** SOKONI (`mysokoni.co.ke`, Firebase project `sokoni-aeb26`)
**Framework:** Kenya Data Protection Act, 2019 (KDPA) — this record supports the accountability duty and mirrors the Art. 30 (GDPR) RoPA structure.
**Maintained by:** privacy@mysokoni.co.ke · **Last updated:** 2026-07-29 · **Review cadence:** at least annually and on any material processing change.

> **Purpose of this document.** A living inventory of *what* personal data SOKONI processes, *why*, on *what legal basis*, *who* receives it, *how long* it is kept, and *what safeguards* apply — the ODPC follow-through to registration (registration alone is not an accountability record). It is sourced from the compliance audit (`docs/ODPC_COMPLIANCE_CERTIFICATION.md`) and the live privacy notice, and reflects the **post-remediation** state (durable consent records + right-to-erasure are implemented).

---

## Part A — Data subject categories
- **Buyers / customers** — individuals purchasing goods/services.
- **Sellers / merchants / providers** — individuals or businesses listing on the platform (incl. sole traders, i.e. natural persons).
- **Riders / drivers** — delivery personnel.
- **Visitors** — unauthenticated users of public pages.

## Part B — Personal data categories processed
| Category | Examples | Sensitivity |
|---|---|---|
| Identity & contact | Name, email, phone (`phoneNumber` +254…), date of birth, profile photo | Standard |
| Account & security | UID, hashed credentials (Firebase Auth), sessions, `ipHash` (pseudonymised IP) | Standard |
| **KYC / high-sensitivity identifiers** | **National ID, KRA PIN**, payout/bank/mobile-money details, KYC document images | **High** — see safeguards + open item #7 |
| Marketplace activity | Orders, cart, wishlist, wallet balance & transactions, reviews, follows | Standard |
| Location | Delivery address; GPS pickup/dropoff coordinates (explicit-permission only) | Standard–High |
| Communications | Email/SMS/push content & preferences (`emailPreferences`) | Standard |
| Usage/analytics | GA4 events, device/technical metadata | Standard (pseudonymised) |

## Part C — Processing activities (RoPA)

| # | Activity | Purpose | Data subjects | Data categories | Lawful basis (KDPA) | Recipients / processors | Retention | Cross-border | Safeguards |
|---|----------|---------|---------------|-----------------|---------------------|-------------------------|-----------|--------------|------------|
| 1 | Account creation & authentication | Create/secure accounts | Buyers, sellers, riders | Identity & contact, account & security | Contract; Consent (signup) | Google/Firebase Auth | Until erasure (30-day cancellable grace, then purged) | Yes (Google US) | Consent recorded (`consentRecords`, immutable); TLS/AES-256; owner-scoped rules |
| 2 | Marketplace transactions | Orders, payments, settlement | Buyers, sellers | Marketplace activity, payout details, address | Contract; Legal obligation (tax) | IntaSend (M-Pesa/card), Firestore | Financial/tax records **anonymised + retained 7 yrs** (Income Tax Act Cap. 470); non-financial purged with account | Yes (Google US) | Server-authoritative settlement; ledgers Admin-SDK-only; erasure anonymises buyer PII, retains ledger |
| 3 | KYC / seller & provider verification | Verify identity for onboarding, tax, payouts | Sellers, providers | **National ID, KRA PIN**, KYC docs, payout details | Legal obligation; Contract | KRA eTIMS (tax), internal review | Statutory retention (tax); KYC docs in restricted Storage | Partial | National ID: hashed (`age-verification.js`), stored as document URL in restricted Storage (`provider-onboarding.js`), AES-256-GCM encrypted in payroll, excluded from search index + redacted from logs. eTIMS creds encrypted + Secret Manager. Business KRA PIN kept plaintext by design (semi-public invoice/tax identifier). |
| 4 | Delivery & logistics | Route, assign, track deliveries | Buyers, riders | Address, GPS coordinates | Contract; Consent (location) | Assigned rider, Nominatim/OSRM (geocode/route) | Purged with account; coordinates redacted on erasure | Yes (OSRM/Nominatim) | GPS explicit-permission; dropoff coords redacted at erasure |
| 5 | Communications | Transactional + (opt-in) marketing email/SMS/push | All | Contact, comms content & preferences | Contract (transactional); Consent (marketing) | SendGrid (email), FCM, SMS gateway | Preferences until change; logs per policy | Yes (SendGrid US) | **Marketing opt-in by default** (fixed); per-category preference gate at send time |
| 6 | Analytics | Understand usage, improve service | All | Usage/analytics, device | Consent; Legitimate interest | Google Analytics 4 | GA4 **26 months** | Yes (Google US) | Pseudonymised; cookie consent banner |
| 7 | Search | Product/provider discovery | All | Marketplace activity (indexed) | Legitimate interest | Algolia / Typesense (as configured) | Index lifetime | Possible (US/EU) | Only listing/discovery fields indexed |
| 8 | Tax compliance (eTIMS) | Statutory tax reporting | Sellers, buyers | Transaction data, KRA PIN | Legal obligation | KRA eTIMS | Statutory (7 yrs) | No (Kenya) | AES-256-GCM credential storage; legal obligation basis |
| 9 | Trust & safety / fraud | Detect fraud, oversell, abuse | All | Activity, `ipHash`, security events | Legitimate interest; Legal obligation | Internal; law enforcement on valid demand | Security logs per policy | Within Google US | Append-only `securityEvents`/`auditLog`; disclosure only on valid Kenyan legal demand |

## Part D — Processor / Sub-processor & DPA register

| Processor | Function | Data shared | Location | Legal basis for transfer (KDPA Part VI) | DPA status |
|-----------|----------|-------------|----------|------------------------------------------|------------|
| Google / Firebase | Auth, Firestore, Storage, FCM, Hosting | Most categories | United States | Contract necessity + Google Cloud DPA / SCCs | On file (Google Cloud terms) — **confirm & archive** |
| IntaSend | Payments (M-Pesa/card) | Name, phone, amount | Kenya | Domestic (no cross-border) | **Obtain/confirm DPA** |
| SendGrid (Twilio) | Transactional/marketing email | Email, name, content | United States | Contract necessity + provider DPA | **Obtain/confirm DPA** |
| Google Analytics 4 | Usage analytics | Pseudonymised usage/device | United States | Consent + provider terms | Covered by Google terms — **confirm** |
| Nominatim / OSRM | Geocoding / routing | Coordinates | EU / community infra | Contract necessity; minimised | Community service — **assess & document** |
| Algolia / Typesense | Search index | Listing/discovery fields | US / EU (as configured) | Contract necessity + provider DPA | **Obtain/confirm DPA** |
| KRA eTIMS | Tax reporting | Transaction data, KRA PIN | Kenya | Legal obligation | Statutory — N/A |
| Meta (Facebook) | Social login + data-deletion callback | Auth identifiers | United States | Consent + provider terms | Covered by Meta terms — **confirm** |
| Redis | Rate-limit/cache (declared) | Ephemeral counters | Not currently reachable | N/A until live | N/A |

**DPA action list:** rows marked *Obtain/confirm* need an executed Data Processing Agreement (or reliance on the provider's standard DPA) archived in the compliance folder. Track completion here as each is confirmed.

## Part E — Cross-border transfers (KDPA Part VI)
Several processors above operate outside Kenya (chiefly Google Cloud `us-central1`, USA). Transfers rely on **contract necessity** and **appropriate safeguards** (provider DPAs/SCCs, TLS 1.2+ in transit, AES-256 at rest). Disclosed to data subjects in `privacy.html` §8.1 "International Data Transfers".

## Part F — Technical & organisational security measures
Owner-scoped Firestore/Storage rules with anti-privilege-escalation; App Check enforced; full CSP/HSTS header stack; secrets in Secret Manager (no plaintext); pseudonymised IP (`ipHash`); append-only audit logs; MFA + role-based admin access; 72-hour breach playbooks (`DISASTER_RECOVERY_PLAYBOOK.md`, `docs/deployment/INCIDENT_RESPONSE.md`).

## Part G — Open items feeding this record
- **#7 — Masking/tokenisation of National ID & KRA PIN at rest** (Activity 3) — **EVALUATED 2026-07-29:** high-sensitivity identifiers are already protected — National ID is hashed / stored as a restricted-Storage document URL / AES-256-GCM encrypted (payroll) / excluded from search index / redacted from logs; eTIMS credentials are encrypted + in Secret Manager. The only plaintext instance is the **business KRA PIN** (`businesses/{merchantId}`), a semi-public invoice/tax identifier where masking is inappropriate. No new masking change is warranted; revisit only if a raw National-ID *string* is ever persisted in a new flow.
- **DPA confirmations** — execute/confirm and archive the processor DPAs flagged in Part D.
- **Named DPO** (open item #8) — appoint a named natural person; update the contact throughout.

---
*Internal accountability record for Bravilex International Co. Limited. Not legal advice. A qualified data-protection practitioner should review before external filing. Keep synchronized with `privacy.html` and `docs/ODPC_COMPLIANCE_CERTIFICATION.md`.*
