# Application Agreements Audit — the versioned authority already exists; the intake is fragmented off it (READ-ONLY)

**Status:** AUDIT ONLY. No code changed. three read-only tracers (intake inventory,
terms/commission/acceptance infra, premium). Separate isolated workstream — must NOT touch POS
Gate 1 / settlement, and is NOT a reason to deploy the staged Merchant Entry Authz RC.

Related: [[project_application_lifecycle]] · [[project_legal_release_gate]] · [[project_commission_commercial_rule]] ·
[[project_sub_billing]] · [[project_merchant_promotion_2d_blocked]] · [[project_odpc_compliance]].

---

## Headline
The platform-wide versioned agreement authority you described **already exists** — the **Legal
Compliance Engine** (`functions/legal-agreements.js`): a versioned registry, per-role agreement
mapping, and immutable signed acceptance records. The defect is that **the application intake is
fragmented across TWO disjoint systems** and most surfaces use **neither**. The task is to
**converge the intake onto the engine and make approval depend on it — not build a new registry.**

## Two disjoint agreement systems (they do not reference each other)
- **System A — the `applications.agreementAccepted` boolean.** Written by `hub-register.js` only,
  knows exactly **one** agreement (the 5% Seller Agreement, hard-coded version
  `hub-register.js:313 = '2026-08-25-commission-5pct'`). It is the **only** thing the server
  approval gate checks: `application-lifecycle.js:990` refuses `approve` unless
  `agreementAccepted === true` (re-stamps `agreementVerifiedAt/Version` `:1014-1017`). A single
  boolean — no signature, no per-version record, no per-agreement granularity.
- **System B — the Legal Compliance Engine** (`functions/legal-agreements.js`, `legalDispatch`;
  client `sokoni-legal-sign.js`/`sokoni-legal-gate.js`). **Versioned registry** (`CORE` 5 +
  `ROLE_AGREEMENTS` per role: merchant 8, provider 8, driver/rider 5, property/hotel/restaurant/
  healthcare/employer — `:34-89`), append-only `versions/` + content hash, admin-registerable via
  `legalRegistry`. **Immutable signed acceptance** → `legalAcceptances/{uid_agreementId_version}`
  + `legalAuditLog` + `legalCertificates` (`:358-403`, deterministic ids, IP/timestamp/hash,
  signature). Rules-locked CF-only (`firestore.rules:4640-4663`). Enforcement guard
  `assertLegalCompliance(uid, role)` exists but is **dark-launched OFF for merchant** (only
  provider ops wired on).

**The break:** `applicationDecide` **never consults System B**. So an applicant who signs
everything via System B still lacks `agreementAccepted` → approval refused; an applicant who ticks
System A's single agreement has **no record** for System B's role agreements.

## Per-application intake inventory
| Application | Intake file | Writes to | Agreement shown? | Recorded (app doc) | Submit blocked? |
|---|---|---|---|---|---|
| **Business/merchant/provider/legal/health (generic)** | `hub-register.js` (31 hub pages) | `applications` type:'business' | ✅ Seller Agreement + checkbox `sreg_agree` | ✅ `agreementAccepted/Version/At` | ✅ client + server gate |
| **Seller (canonical marketplace)** | `onboarding-seller.html` → `sokoni-merchant-application.js` | `applications/{uid}--merchant` type:'seller' | ❌ none | ❌ none | ❌ — and `applicationDecide` would then **refuse approval** (no flag) |
| **Professional** | `onboarding-professional.html` | `applications` + `providers` | System-B gate (role:provider); static text only | ❌ app doc; ✅ `legalAcceptances` | ⚠ client `_legalOk`; **weak fallback `_legalOk=true` if gate script absent** (`:407`) |
| **Driver/rider** | `onboarding-driver.html` | `applications` | System-B gate (role:driver) | ❌ app doc; ✅ `legalAcceptances` | ⚠ weak fallback (`:453`) |
| **Provider (self-setup)** | `provider.html` | `applications` | ❌ none | ❌ none | ❌ |
| **Healthcare (facility + pharmacy)** | `healthcare.html` | `applications` + `providers` | ❌ feature checkboxes only | ❌ none | ❌ |
| **Sports coach/venue** | `sports-hub.html` | `applications` | ❌ none (and **no `uid`**) | ❌ none | ❌ |
| **Provider publish** | `provider-onboarding.html` | `providers` (callable) | System-B gate | ✅ `legalAcceptances` | ⚠ weak fallback (`:704`) |

Server role resolution for all: `resolveRole()` `application-lifecycle.js:185-209` → `driver|legal|health|seller|provider`.

**The mapping (per-application → required agreements) exists ONLY in System B** (`ROLE_AGREEMENTS`)
and is **not wired to `applications`/`applicationDecide`.** Which agreements an application requires
is effectively ad-hoc per page.

## Premium — the worst case (no informed consent, real money on a bare click)
- **No single Premium Merchant Application.** Three disconnected paths, **none** with an agreement,
  checkbox, or consent record:
  - `seller.html` "Sokoni Premium Seller" → `activatePlan()` (`seller.js:4790`) = **bare click,
    `localStorage` only, no backend/payment/record** ("Beta FREE").
  - `subscriptions.html` "Upgrade" → `subscribePlan()` = **immediate real M-PESA STK push**
    (`:359-366`) → `activateSubscription` (flat 30-day, **not** a trial) + localStorage. No trial/
    renewal/cancellation/refund shown, no consent.
- **Four divergent price tables that disagree:** `seller.js:4739` (KES 500), `subscriptions.html:271`
  (KES 499), `sub-billing.js:48` (99900 cents), `subscription-catalog.js:65` — the unresolved
  "~10 catalogues" problem.
- **Boost money-defect live:** `subscriptions.html buyBoost()` → **KES 500 real STK → `onSuccess`
  only an alert, no backend record** (`:479-490`).
- Premium bypasses `applications` (writes `subscriptions/{uid}` + audit log, **no agreement/terms version**).

## Commission
`functions/commission-config.js` is the single truth (`marketplace 5%` `:50`, `MIN_COMMISSION_KES=10`
`:116`, 3→5 on 2026-08-25). But applicant-facing disclosures are **hard-coded strings** (`seller.html:1584`,
`merchant-v2.html:1081`, `seller-terms.html:151`) — **not bound to the constant or a versioned
`commission-agreement`**; a rate change needs manual copy edits.

## Signup consent
`consentRecords` write is **best-effort with a silent catch** (`auth.js:697`) — can resolve empty;
an open ODPC item ([[project_odpc_compliance]]).

---

## The fix shape (for a LATER isolated candidate — not done here)
1. **Make System B the single authority.** `applicationDecide` gates approval on the required
   `ROLE_AGREEMENTS` for the resolved role being present in `legalAcceptances` (signed, current
   version) — not the single `agreementAccepted` boolean. **Fail closed:** remove the weak
   `_legalOk=true` fallbacks.
2. **Wire `SokoniLegalGate`/`SokoniLegalSign` into EVERY intake** with the correct role →
   `ROLE_AGREEMENTS`: `onboarding-seller.html`, `provider.html`, `healthcare.html`, `sports-hub.html`,
   and converge `hub-register.js`'s System-A modal onto the engine.
3. **Bind commission disclosure to `commission-config`** — a versioned `commission-agreement`
   record showing 5% / KES 10 from the constant; the acceptance stores rate+min+effectiveDate.
4. **Premium becomes an informed-consent application:** full material terms (features in/out, price,
   trial, when billing starts, renewal, cancellation, refunds, limits, obligations, commission that
   still applies, suspension/termination, data/privacy, support, effective date + version) BEFORE an
   **unchecked-by-default** checkbox; submit disabled until all required agreements accepted; record
   via System B. Collapse the four price tables to **one catalogue** (`subscription-catalog.js`
   already claims canonical). Stop the bare-click localStorage grant and the consent-less immediate
   STK; fix the boost-no-backend record.
5. **Immutable acceptance records** — already provided by System B (`legalAcceptances` +
   `legalAuditLog` + `legalCertificates`), rules-locked. Extend, don't add a parallel store.
6. **Enable enforcement** (`assertLegalCompliance`) per role once each intake records against the engine.

## Acceptance criteria (the finished candidate must prove)
- No application (seller, provider, healthcare, sports, driver, professional, **premium**) can SUBMIT
  without its required agreements accepted (each, unchecked-by-default, submit disabled).
- Approval is REFUSED unless the required `ROLE_AGREEMENTS` are signed in `legalAcceptances` for the
  current version — the weak client fallbacks are gone.
- The merchant application shows **5% / KES 10 from the config**, and the acceptance record captures
  agreement name+version, commission rate+min, effective date, applicant/app id, timestamp, exact terms.
- Premium shows the full material terms and records a signed acceptance; **no real money moves on a
  bare click without consent**; one price catalogue.
- Existing signed acceptances remain immutable; a version bump makes NEW applications use the new
  version while old records are untouched.
- Separate isolated candidate; POS Gate 1 / settlement untouched; not a reason to deploy the Merchant Authz RC.
