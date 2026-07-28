# SOKONI — Data Protection Compliance Certification Report

**Platform:** SOKONI (Firebase project `sokoni-aeb26`, production `mysokoni.co.ke`)
**Controller / Processor:** BRAVILEX INTERNATIONAL Co. Limited (Reg. CPR/2014/166272), Nairobi, Kenya
**Framework:** Kenya Data Protection Act, 2019 (KDPA) / Office of the Data Protection Commissioner (ODPC)
**Report type:** Internal engineering self-assessment — **NOT an official ODPC certificate**
**Date:** 2026-07-28
**Method:** Read-only evidence audit of the codebase (client, Cloud Functions, `firestore.rules`, `storage.rules`, `firebase.json`). Every VERIFIED finding carries a `file:line` citation.

> **Scope note.** This report assesses the **platform's implemented data-protection behavior**. It is *separate from* the ODPC **registration** status. The registration (Data Processor) is reported by the business as approved via the ODPC portal (approval email + downloadable certificate); see §14 for the reconciliation action needed in the codebase.

## Verdict legend
- **VERIFIED** — observed in code / testable behavior (cited).
- **DOCUMENTED** — present in policy/text but not code-validated end-to-end.
- **PARTIAL** — partially implemented.
- **GAP** — absent or non-functional.

---

## Overall compliance status: **ALL 4 MUST-FIXES REMEDIATED (2026-07-28) — see Addendum A**

> **Status update — 2026-07-28 (final):** MUST-FIX **#4 (ODPC registration reference)** is now **RESOLVED.** The business supplied the official ODPC Certificate of Registration; the reference is embedded in `functions/company-identity.js` (`COMPANY.dataProtection`) and reconciled across the go-live/readiness/operations docs. All four engineering/documentation must-fixes are complete. A targeted re-audit of the four remediated areas and the full remediation record are in **Addendum A** at the end of this report. **Note:** ODPC *registration* status (below) is distinct from the *platform compliance assessment* (this report's 14 areas) — registration does not by itself attest to ongoing technical compliance.

> **Remediation log — 2026-07-28 (later):** MUST-FIX **#2 (durable consent records)** and **#3 (data-rights enum)** are now **RESOLVED and deployed** too.
> - **#2:** signup now persists a latest-consent snapshot on `users/{uid}.consent` **and** an append-only `consentRecords` row (`uid` + `consentedAt` + `policyVersion` + `source`); `POLICY_VERSION` constant enables re-consent on notice changes; `firestore.rules` make consent records owner-create + immutable. Proof 5/5 rules-unit.
> - **#3:** `submitDataRightsRequest` now normalizes the KDPA-standard UI right-names (deletion/access/rectification/restriction/portability/objection) — all 6 accepted (verified) — so data-subject-rights requests reach the backend instead of failing.
> - **#4 (ODPC certificate reference)** is the **only remaining must-fix** — it is a documentation/config task **blocked on the official registration/certificate number**, which must be supplied by the business before it can be embedded in `company-identity.js` and the docs. Until then the status is presented conservatively (registered-status per external portal evidence, not asserted in code).
>
> **Remediation log — 2026-07-28 (earlier):** MUST-FIX #1 (right to erasure) is **RESOLVED and deployed.** The two deletion systems were converged onto one authority; `deleteMyAccount` now schedules on the fields the working purge worker consumes (`status:'pending_deletion'` + `deletionScheduledAt`, 30-day cancellable grace, immediate Auth lockout); `finaliseExpiredDeletions` now performs a full spec-driven cross-collection purge (`functions/account-purge-spec.js`) — DELETE personal data, ANONYMIZE statutorily-retained financial/tax records (7-yr, Income Tax Act), RETAIN ledgers — writes an immutable `erasureLog` audit event, then `auth.deleteUser`; and `privacy.html` was rewritten to describe the actual lifecycle. Proof: 14/14 emulator (delete-vs-anonymize per spec, other users untouched, idempotent). See §6/§10 (now VERIFIED). **3 must-fix items remain (#2 consent records, #3 data-rights enum, #4 ODPC cert reference).**

SOKONI demonstrates a **mature security and transparency posture** — owner-scoped access control with anti-privilege-escalation, App Check + a full CSP/HSTS header stack, secrets in Secret Manager, append-only audit logs, substantive KDPA-structured privacy/terms/cookie notices naming Bravilex, a **working self-service data export**, and two documented 72-hour breach playbooks.

However, **it is not yet certifiable as fully KDPA-compliant** because of four material gaps — most seriously, the **right to erasure is not actually delivered** (the live account-deletion path disables but does not delete, and purges no sub-collection PII), and **consent is not durably recorded**. These are honest blockers, not paperwork.

---

## 1. Governance & Accountability — **VERIFIED**
- **Verified:** canonical controller identity — `functions/company-identity.js:27` `legalName: 'Bravilex International Co. Limited'`, `:45` `registrationNumber: 'CPR/2014/166272'`, `:51-52` `privacyEmail`/`complianceEmail`. Surfaced to users: `privacy.html:159-160` (Data Controller + DPO), `:354` ODPC escalation route.
- **Recommendation:** the "DPO" is a role mailbox (`privacy@mysokoni.co.ke`), not a named natural person — ODPC registration typically expects a named, contactable DPO.

## 2. Lawful Basis & Consent — **PARTIAL (consent enforced in UI, NOT persisted)**
- **Verified (UI gate):** mandatory signup consent `signup.html:99-101` enforced `auth.js:542-545`; cookie/KDPA banner in `security.js`.
- **GAP:** no durable consent record is written — the signup profile (`auth.js:568-585`) has no `consentAt`/`policyVersion`; the banner persists to **localStorage only** (`security.js` ~`sokoniPrivacyAccepted`). No auditable server-side proof of who consented, when, or to which version.
- **Documented:** per-field lawful basis is disclosed (`privacy.html:172-176`: Contract / Consent / Legal obligation).

## 3. Data Minimization — **PARTIAL / DOCUMENTED**
- **Documented:** collection disclosed (`privacy.html:172-206`) — name, email, phone, profile photo, **National ID + KRA PIN (KYC)**, payout details, delivery address, **GPS** (explicit-permission), IP.
- **Verified positives:** signup collects only name/email/DOB/phone (`auth.js:525-535`); client IP stored **pseudonymised** (`ipHash`, per `docs/ADR.md:204-206`); KYC docs in a restricted Storage path (§7).
- **Recommendation:** high-sensitivity identifiers (National ID, KRA PIN) are stored without evidence of masking/tokenisation at rest; retention depends on the (currently non-functional) purge — see §6/§10.

## 4. Purpose Limitation — **DOCUMENTED**
- **Documented:** purposes enumerated `privacy.html:248-256`; "we do not sell/rent/trade personal data … for marketing" `:316`; marketing consent-gated `:251`.
- **Recommendation (RESOLVED 2026-07-28):** `pos-customers.js:103` `marketingOptIn` previously **defaulted to true**; now defaults to **opt-in** (`data.marketingOptIn === true`, consent only when explicitly captured). Also fixed the related opt-out default in `functions/email-service.js` `getPreferences` (`marketing: false` by default; transactional categories orders/payments/security/account unchanged).

## 5. Transparency & Privacy Notices — **VERIFIED**
- **Verified:** `privacy.html` (429 lines; controller, data table, retention schedule `:322-335`, rights + 30-day response `:343-353`, ODPC complaint `:354`); `terms.html` (binds to Bravilex `:151`, Kenyan law); `cookie-policy.html` (categories + legal-basis badges, Bravilex named `:221`). `/privacy` linked in ~22 footers.
- **Recommendation:** signup + cookie banner deep-link to a combined `legal.html#…` rather than the canonical standalone pages — unify the entry point.

## 6. Data Subject Rights — Export **VERIFIED** · Deletion **PARTIAL (erasure GAP)**
- **Export — VERIFIED (self-service, server-authoritative):** `functions/data-export.js` `requestDataExport` (onCall, App Check, rate-limited `:144-209`) → collects users/orders/wallet/reviews/etc. (`:317-405`), strips secrets (`BLOCKED_FIELDS :44-49`), uploads private JSON, returns a 7-day signed URL (`:407-439`), stamps `legalBasis: … Kenya Data Protection Act Section 26` (`:393`).
- **Deletion — PARTIAL, erasure is a GAP:** the live UI (`data-deletion.html:604`) calls `deleteMyAccount` (`functions/facebook-data-deletion.js:246-310`), which disables Auth (`:271`), anonymises the **top-level** user doc (`:280-284`), and queues `accountDeletions` with `purgeAfter=+30d` (`:288`).
  - **GAP 6a — orphaned queue:** *no scheduled function consumes* `accountDeletions`/`purgeAfter`. The purge worker `finaliseExpiredDeletions` (`account-manager.js:232`) filters on `status=='pending_deletion'` (`:237`), which `deleteMyAccount` never sets (it sets `accountStatus:'deleted'`). **Result: the live path disables Auth but never deletes it, and never drains its own queue.**
  - **GAP 6b — no cross-collection purge:** neither path purges sub-collection PII — orders (`buyerUid`), `wallets/{uid}`, `walletTransactions`, `reviews`, `notifications`, delivery addresses, or Storage objects (photos, exports).
  - **Notice mismatch:** `privacy.html:332` / `data-deletion.html:315-320` promise permanent purge within 14/30 days that the code does not deliver — this **overstates** and must be reconciled.
  - **GAP 6c — broken data-rights form:** `data-deletion.html:392-397` sends `type` values (`deletion/access/rectification/portability`) that `submitDataRightsRequest` (`facebook-data-deletion.js:198-211`) rejects (`invalid-argument`) → every request silently falls back to "email us." One-line enum fix.

## 7. Authentication & Access Control — **VERIFIED**
- **Verified:** Google/Facebook/Phone-OTP/Email (`firebase.js:307-323`); user docs owner-scoped `firestore.rules:259-274` (`delete: if isAdmin()`); custom-claim gates + anti-escalation guards `noSelfGrant`/`noPrivilegeEscalation` (`firestore.rules:142-194`); function gates (`admin-os.js:7-9`, `admin-claim.js:39-69`); Storage owner-scoped + `notExecutable()` blocklist + default-deny (`storage.rules:214-231`).

## 8. Security Safeguards — **VERIFIED** (one residual risk)
- **Verified:** App Check `enforceAppCheck:true` across callables (467 matches / 128 files); `firebase.json:477-531` HSTS `max-age=63072000; includeSubDomains; preload`, full CSP, XFO/XCTO/Referrer/Permissions-Policy/COOP/CORP; secrets via `defineSecret()` (IntaSend/SendGrid/Algolia/Anthropic) + CI secret-scan (`ci.yml:50-53`) — **no plaintext-secret finding** (the only hardcoded key is the public Firebase web `apiKey`, by design); XSS-safe rendering (`textContent`/`esc()`), lockout + idle auto-logout (`firebase.js:1157-1221`).
- **Residual risk (Recommendation):** Redis rate-limiter is unreachable (no VPC connector); security actions stay throttled via Firestore fallback, but non-security high-volume actions pass and `rateLimitsFallback` lacks a TTL (`functions/redis-rate-limiter.js:27-51`).

## 9. Audit Logging — **VERIFIED**
- **Verified:** append-only `auditLog` with actor uid + server time (`account-manager.js:97-289`; writer `firebase.js:1224-1235`); rules `firestore.rules:600-606` (`create` owner-stamped; `update,delete: if false`; `read: if isModerator()`); financial ledgers Admin-SDK-only (`firestore.rules:494-503`); `securityEvents`/`securityAlerts`.

## 10. Retention & Deletion — **PARTIAL**
- **Documented:** retention schedule `privacy.html:322-335` (orders/eTIMS 7 yrs per Income Tax Act; chat 90 days; audit 2 yrs; deleted-account 30-day then purge).
- **Verified worker (mis-wired):** `finaliseExpiredDeletions` (`account-manager.js:232-302`, daily) *does* hard-delete `status=='pending_deletion'` accounts — but the live UI deletion never sets that status (§6a).
- **GAPs:** live deletion queue has no consumer; no cross-collection/Storage PII purge; no TTL on `rateLimitsFallback`/ephemeral collections; Auth records of UI-deleted users retained indefinitely.

## 11. Cross-Border Processing / Data Residency — **PARTIAL (disclosure GAP)**
- **Verified:** region `us-central1` (USA) — Functions (`firebase.json:71-101`), Firestore/Auth/Storage (Google Cloud US). This is a cross-border transfer of Kenyan personal data. At-rest AES-256 (`privacy.html:364`).
- **GAP (RESOLVED 2026-07-29):** the privacy notice now carries an explicit KDPA Part VI cross-border transfer clause — `privacy.html` §8.1 "International Data Transfers" names the out-of-Kenya processing (Google Cloud `us-central1`, payment processor) and states the legal bases + safeguards (contract necessity, contractual data-protection terms, TLS 1.2+/AES-256, processor certifications) and an objection route.

## 12. Third-Party Processors — **VERIFIED (inventory)**
Evidenced by CSP allow-list (`firebase.json:485`) + code + notice: **Google/Firebase** (Auth/Firestore/Storage/FCM/Hosting), **IntaSend** (M-Pesa/card; name+phone+amount), **SendGrid** (email), **Google Analytics 4** (usage; 26-mo), **Nominatim/OSRM** (geocode/route; coordinates), **Algolia/Typesense** (search), **KRA eTIMS** (tax; legal obligation), **Meta** (login + deletion callback), **Redis** (declared, unreachable).
- **Recommendation (ADDRESSED 2026-07-29):** a formal Record of Processing Activities now exists — `docs/RECORDS_OF_PROCESSING_ACTIVITIES.md` (processing-activity register + processor/DPA register + cross-border basis). **Residual:** execute/confirm and archive the per-processor DPAs flagged in that document's Part D.

## 13. Incident Response & Breach Readiness — **VERIFIED / DOCUMENTED**
- **Documented plans:** `docs/deployment/INCIDENT_RESPONSE.md:155-171` ("INC-006 Data Breach": maintenance mode, secret rotation, `revokeRefreshTokens`, **notify affected users within 72 h**); `DISASTER_RECOVERY_PLAYBOOK.md:201-239` (KDPA 2019 + GDPR Art.33, **ODPC notification within 72 h**).
- **Verified live detection:** `fraudAlerts`, `oversoldAlerts` (in stock txn, `index.js:2767`), `securityAlerts`/`rateLimitViolations` (`enterprise-health.js:659-697`).

## 14. Operational Evidence / ODPC Registration Reconciliation — **VERIFIED** *(remediated 2026-07-28 — see Addendum A)*
- **Verified:** rules/Storage deployed + predeploy security gates (`firebase.json:534-559`); App Check live; admin claims enforced; `version.json` production marker.
- **✅ Resolved — registration reference embedded.** The business supplied the official ODPC Certificate of Registration: **Registration/Identification No. 630-8669-F056**, certificate serial **24670**, category **Data Processor**, registered entity **Bravilex International Co. Limited**, valid **28/07/2026 – 28/07/2028**. Now recorded as the canonical `COMPANY.dataProtection` block in `functions/company-identity.js:52-62` and reconciled across `docs/GO_LIVE_CHECKLIST.md`, `docs/LAUNCH_READINESS_REVIEW.md`, `docs/PRODUCTION_OPERATIONS_MANUAL.md`, and `security-compliance.html`. Per the distinction adopted below, the code and docs state the **registration** status explicitly and keep it separate from the **platform compliance assessment**.

---

# Gap Summary (ranked)

## MUST-FIX before certification
1. **Right to erasure is not delivered (§6/§10).** Live `deleteMyAccount` queues `accountDeletions` with no consumer, and the existing purge worker matches a status the UI never sets → Auth disabled-not-deleted, sub-collection + Storage PII never purged, and the notice **overstates** the outcome. *Fix:* wire the UI path to a working purge worker; extend purge to orders/wallet/reviews/addresses/Storage + `auth.deleteUser`; align the notice to actual behavior.
2. **No stored consent records (§2).** Signup + cookie consent are UI-only (checkbox + localStorage). *Fix:* persist `{uid, consentedAt, policyVersion, source}` server-side at signup and for cookie consent.
3. **Broken data-rights form (§6c).** `submitDataRightsRequest` rejects every `type` the UI sends. *Fix:* one-line enum alignment so access/rectification/portability/objection requests actually reach the backend.
4. **ODPC registration reference absent from the codebase (§14).** Embed the certificate/number; reconcile docs from "pending"/"paid" to "registered."

## SHOULD-FIX / Recommendations
5. ~~Add an explicit **cross-border transfer clause** (KDPA Part VI) to the privacy notice (§11).~~ **RESOLVED 2026-07-29** — `privacy.html` §8.1 International Data Transfers.
6. Restore **Redis rate limiting** (VPC connector) or add a TTL on `rateLimitsFallback` (§8).
7. ~~**Marketing opt-in defaults to true** — change to opt-out-by-default (§4).~~ **RESOLVED 2026-07-28** — marketing now opt-in by default in `pos-customers.js` + `email-service.js`.
8. ~~Reconcile the **duplicate `requestDataExport`** definitions so the signed-URL implementation is exported (§6).~~ **RESOLVED 2026-07-28** — the older shadowed duplicate in `functions/account-manager.js` was removed; `functions/data-export.js` (signed-URL, App Check, dataExportQueue worker) is now the single definition and the deployed entry point.
9. Appoint a **named DPO** rather than a role mailbox (§1).
10. Unify the **consent/privacy entry point** (canonical `privacy.html`/`terms.html`, not `legal.html#…`) (§5).
11. ~~Maintain a formal **RoPA + DPAs** per processor (§12).~~ **RoPA DONE 2026-07-29** (`docs/RECORDS_OF_PROCESSING_ACTIVITIES.md`); residual = execute/archive per-processor DPAs (Part D).
12. Evaluate **masking/tokenisation of National ID / KRA PIN** at rest (§3).

## Verified strengths (support certification)
Owner-scoped Firestore/Storage rules with anti-privilege-escalation; append-only audit logs; App Check + full CSP/HSTS stack; secrets in Secret Manager (no plaintext); pseudonymised IP storage; **working self-service data export** with signed URLs; two documented 72-hour breach playbooks citing KDPA; live fraud/oversell/security anomaly alerting; substantive KDPA-structured privacy/terms/cookie notices naming Bravilex.

---

## Certification statement
On the evidence audited, SOKONI's data-protection **implementation meets a strong standard**: the security, access-control, transparency, audit, breach-readiness, and data-export controls are code-verified, and **all four MUST-FIX items originally identified have been remediated and re-verified** (see Addendum A) — genuine right-to-erasure with an immutable audit trail, durable consent records, a working data-rights intake, and the ODPC registration reference embedded. The platform is now well-positioned for external certification, subject to the SHOULD-FIX recommendations and independent legal review below.

Two statuses remain deliberately distinct and should never be conflated:
- **ODPC registration:** Bravilex is a **Registered Data Processor** — Registration No. 630-8669-F056, valid 28 Jul 2026 – 28 Jul 2028. This is an external, authority-issued fact.
- **Platform compliance assessment:** this document — an **internal engineering self-assessment** of implemented technical/organisational controls. Registration does not by itself attest to ongoing technical compliance, and this assessment does not substitute for the ODPC registration.

*This is an internal engineering self-assessment for Bravilex International Co. Limited, not legal advice and not an official ODPC determination. A qualified data-protection practitioner should review before any external certification or filing.*

---

# Addendum A — Must-Fix Remediation Record & Targeted Re-Audit (2026-07-28)

This addendum records the closure of all four MUST-FIX items and a **targeted re-audit of only the four remediated areas** (not a regeneration of the 14-area assessment above, which stands as originally written except for the status markers on §14 and the overall banner). Each area was re-verified against the current working tree with `file:line` evidence.

| # | Must-fix | State | Evidence (current tree) | Proof |
|---|----------|-------|-------------------------|-------|
| 1 | Right to erasure | ✅ RESOLVED | One deletion authority: `deleteMyAccount` schedules on `status:'pending_deletion'`+`deletionScheduledAt` (`facebook-data-deletion.js:291-297`); `finaliseExpiredDeletions` runs the spec-driven purge (`account-manager.js:283-286`) then writes an **immutable `erasureLog`** *before* the irreversible `auth.deleteUser` (`account-manager.js:287-302`). Purge policy is explicit per collection in `account-purge-spec.js` (`PURGE_WORKER_VERSION='1.0.0'`; delete personal / anonymize 7-yr tax records / retain ledgers). Notice aligned (`privacy.html`). | 14/14 emulator |
| 2 | Durable consent records | ✅ RESOLVED | Signup writes a latest-consent snapshot `users/{uid}.consent` **and** an append-only row `consentRecords` `{uid, consentedAt, policyVersion, source}` (`auth.js:589,597-599`); `POLICY_VERSION='2026-06'` (`auth.js:561`) distinguishes historical vs renewed consent; rules make records **owner-create + immutable** — `allow update, delete: if false` (`firestore.rules:610-616`). | 5/5 rules-unit |
| 3 | Data-rights intake | ✅ RESOLVED | `submitDataRightsRequest` normalizes the 6 KDPA UI right-names to a canonical enum and stores both `type` (canonical) and `requestedRight` (as selected) (`facebook-data-deletion.js:203-213,229-230`). | 6/6 accepted |
| 4 | ODPC registration reference | ✅ RESOLVED | Canonical `COMPANY.dataProtection` block — Reg. No. **630-8669-F056**, serial 24670, Data Processor, valid 28/07/2026–28/07/2028 (`company-identity.js:52-62`); docs reconciled from "pending"/"paid" to "registered" across go-live/readiness/operations/security-compliance. | Static verify |

**Re-audit method.** Read-only inspection of the current working tree on 2026-07-28 (post-remediation); artifacts for #1–#3 are unchanged since their emulator/rules-unit proofs and remain deployed; #4 is a config/documentation embed verified statically. No new gaps were introduced by the remediations (erasure matches on the target `uid` only and anonymizes — never deletes — ambiguously-keyed financial records, so a worst-case mismatch is a no-op, not data loss).

**Residual items (unchanged, non-blocking).** The SHOULD-FIX recommendations (5–12) above remain open and are not certification-blocking. The **production QA gate** (a real end-to-end transaction across both delivery-dispatch branches) is an operational validation owned by the business and is tracked outside this compliance report.
