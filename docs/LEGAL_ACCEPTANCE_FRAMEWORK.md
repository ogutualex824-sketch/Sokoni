# Legal Agreements & Digital Acceptance Framework

**Date:** 2026-07-12 · **Commit:** `3ce32d8` · **Backend:** live (`legalDispatch`). **UI:** pending (agent-active wizard files).

## What it does
Records legally-binding, **versioned, auditable, server-enforced** acceptance of the correct agreements per role during onboarding — append-only, never deleted, no client-trusted data.

## Backend (via `legalDispatch` — 1 Cloud Run service)
| Op | Auth | Purpose |
|----|------|---------|
| `legalGetAgreements({role})` | user | Required agreements for a role (core + role-specific) at current versions |
| `legalGetMyAcceptances()` | user | Everything the user has accepted |
| `legalCheckCompliance({role})` | user | **Enforcement** — returns `{compliant, missing:[{agreementId,version,reason}]}` |
| `legalAccept({role, acceptances:[{agreementId,version}], meta})` | user | Record acceptance (server captures IP+timestamp+hash) |
| `legalPublishAgreement({agreementId,version,name,effectiveDate,text?})` | admin | Publish a new version |
| `legalArchiveAgreement({agreementId})` | admin | Archive |
| `legalVersionHistory({agreementId})` | admin | Append-only version history |
| `legalSearchAcceptances({userId?|agreementId?,role?,version?})` | admin | Audit search |
| `legalGetStats({agreementId?})` | admin | Acceptance statistics |

## Agreement catalogue
- **Core (all users):** Terms of Service, Privacy Policy, Cookie Policy, Community Standards, Acceptable Use Policy.
- **Role-specific:** merchant (8), provider (8), driver/rider (5, shared), property (3), hotel (1), restaurant (2), healthcare (2), employer (2).
- Default version `1.0`; admin `legalPublishAgreement` overrides per agreement via `legalAgreements/{id}` (+ `versions` subcollection).

## Firestore
- `legalAgreements/{agreementId}` — current version metadata (+ `versions/{version}` history). Additive.
- `legalAcceptances/{uid_agreementId_version}` — **immutable** record: `userId, role, agreementId, agreementName, version, accepted, acceptedAt, acceptedFrom(IP), device, browser, language, country, agreementHash, acceptanceMethod`. Deterministic id → idempotent, never deleted. Index-free queries.

## Frontend integration contract (for the onboarding wizard)
Add a **Legal Acceptance step** (or modal) before the final "Ready"/publish step of each role flow:
```js
const legal = (op) => (data) => firebase.functions().httpsCallable('legalDispatch')({ op, ...data }).then(r => r.data);

// 1. Fetch what this role must accept
const { core, roleSpecific } = await legal('legalGetAgreements')({ role });

// 2. Render one UNCHECKED checkbox per agreement (no pre-checked boxes).
//    "Continue" stays disabled until every required box is checked.
//    Each label links to the existing doc page (terms.html, privacy.html, …) with
//    Read More / download / print — reuse existing legal pages, no redesign.

// 3. On Continue — explicit action recorded:
await legal('legalAccept')({
  role,
  acceptances: [...core, ...roleSpecific].map(a => ({ agreementId: a.id, version: a.version })),
  meta: { device: navigator.userAgent, browser: navigator.userAgent,
          language: navigator.language, country: /* from profile/geo */ '' },
});

// 4. Gate protected actions / re-acceptance on version bump:
const { compliant, missing } = await legal('legalCheckCompliance')({ role });
if (!compliant) { /* show only `missing` agreements — never re-ask accepted current versions */ }
```

## Security
- Every op authenticated; **IP captured server-side** (`req.rawRequest.ip` / `x-forwarded-for`), never client-trusted.
- `legalAccept` validates each `agreementId` + `version` against the live catalogue → clients cannot fabricate acceptances or accept stale versions.
- Admin ops gated on the `admin`/`superAdmin` claim. Records are append-only (audit-safe).

## Compatibility & rollback
Purely additive — no existing collection/flow touched. Reuses existing legal doc pages for the readable text. Rollback: `git revert 3ce32d8` + remove `legalDispatch` (no data migration; acceptance records remain valid).

## Universal Legal Compliance Engine (2026-07-12, `60312b3`)

### Reusable component — `sokoni-legal-gate.js` (the `<LegalAcceptanceGate>`)
One browser component every role/page uses (no framework; compat or modular Firebase):
- `SokoniLegalGate.mount(el, { role, onComplete })` — accept-to-continue gate (no pre-checked boxes; Continue disabled until all checked; non-blocking if the service is down).
- `SokoniLegalGate.settings(el, { role })` — **Account → Legal & Agreements** view (accepted agreements + versions + dates + pending updates).
- `SokoniLegalGate.check(role)` — compliance helper for gating any client action.
- Reuses existing legal pages; inherits page tokens (`--sk-green`/`--sk-accent`/`--sk-border`) — no redesign.
- **`pos-setup.html` retrofitted** to use it (inline logic removed — DRY).

### Server-side enforcement (dark-launched — non-breaking)
`assertLegalCompliance(uid, role)` (exported from `legal-agreements.js`) is the reusable guard other modules call to protect sensitive ops (payouts, publish, go-online, listings, jobs). **OFF by default per role** (`legalConfig/enforcement`); flip on with `legalSetEnforcement({role,enabled})` once a role's acceptance UI is rolled out — so existing users are never suddenly locked out. Wired (dark) into `provider-ops` `providerRequestPayout` + `providerAddService`.

**Wire it into any sensitive op:** `const legal = require('./legal-agreements'); await legal.assertLegalCompliance(uid, role);`

### `legalAccept` verification (all 5 properties hold)
- **Idempotent:** deterministic doc id `{uid}_{agreementId}_{version}` + `merge` → re-accepting the same version is a no-op overwrite.
- **Version-aware:** rejects any version ≠ current catalogue version (`failed-precondition`).
- **Audit-logged:** immutable `legalAuditLog` entry written in the same batch (append-only).
- **Transaction-safe:** single atomic `batch.commit()`.
- **Duplicate-safe:** deterministic id → one record per (user, agreement, version), never duplicated.

### Admin
`legalComplianceReport` (acceptance rate, distinct users, version adoption, by role, enforcement state) · `legalSetEnforcement` · plus existing `legalGetStats`/`legalSearchAcceptances`/`legalVersionHistory`. New collection `legalAuditLog` (append-only). New config `legalConfig/enforcement`.

## Pending
- **Provider/unified wizard UI** — drop `SokoniLegalGate.mount(el, { role })` into `onboarding.html` / `provider-onboarding.html` (blocked on the agent's active edits; one-line integration now that the component exists).
- **Account Settings page** — mount `SokoniLegalGate.settings(el, { role })` (component ready; host page is the agent's).
- **Enable enforcement per role** via `legalSetEnforcement` once each role's UI is live and existing users prompted.
- Optionally seed real agreement text/versions via `legalPublishAgreement` (defaults to `1.0`).

Related: [[ONBOARDING_ARCHITECTURE_UPGRADE]] · [[DISPATCHER_REGISTRY]]
