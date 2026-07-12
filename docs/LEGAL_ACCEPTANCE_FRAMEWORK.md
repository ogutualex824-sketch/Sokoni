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

---

# Compliance Hardening Sprint (v1.0.0) — `685b700`

## API reference

| API | Auth | Contract |
|-----|------|----------|
| `legalAccept({role, acceptances:[{agreementId,version}], meta})` | user | Records acceptance. **Idempotent** (deterministic id `{uid}_{agreementId}_{version}` + merge), **version-aware** (rejects any version ≠ current → `failed-precondition`), **duplicate-safe**, **atomic** (single batch), **audit-logged** (`legalAuditLog`). Server captures IP + timestamp + hash; client meta sanitized. Returns `{recorded[], count}`. |
| `legalCheckCompliance({role})` | user | `{compliant, missing:[{agreementId,name,version,reason}], requiredCount}`. `reason` = `never`\|`outdated`. |
| `assertLegalCompliance(uid, role)` | **backend library** | The guard for sensitive ops. Throws `failed-precondition` listing missing agreements **only when enforcement is enabled for that role**; otherwise returns `{enforced:false}` (dark-launch → non-breaking). Import: `require('./legal-agreements').assertLegalCompliance`. |
| `legalComplianceReport()` | admin | `{totalAcceptanceRecords, distinctUsers, byAgreement, byRole, versionAdoption, latestVersionAdoption:{id:{currentVersion,onCurrent,total,adoptionPct}}, enforcement}`. |
| `legalSetEnforcement({role, enabled})` | admin | Flips server enforcement per role (`legalConfig/enforcement`); busts the flag cache. Instant rollback by setting `enabled:false`. |

Also: `legalGetAgreements`, `legalGetMyAcceptances`, `legalGetPendingUpdates`, `legalPublishAgreement`, `legalArchiveAgreement`, `legalVersionHistory`, `legalSearchAcceptances`, `legalGetStats`, `legalExportAcceptances` (CSV). **13 ops via `legalDispatch`.**

## Enforced sensitive operations (server-side, dark-launched)
| Role | Operation | Handler |
|------|-----------|---------|
| Provider | Publish profile | `providerPublish` |
| Provider | Receive booking | `providerConfirmBooking` |
| Provider | Receive settlement | `providerCompleteBooking` |
| Provider | Withdraw funds | `providerRequestPayout` |
| Provider | Publish listing | `providerAddService` |

**To protect any other op:** `await require('./legal-agreements').assertLegalCompliance(uid, role);` — one line. Merchant/driver/property/etc. ops get the same call as their role UIs roll out.

## Legal Centre — `legal-centre.html` (new page; no existing page modified)
Accepted / Pending · current version · acceptance date · role selector · search · download record. Mounts the **same** `SokoniLegalGate` to resolve pending updates.

## Version-upgrade workflow
`legalGetPendingUpdates({role})` → `{hasPending, pending:[{agreementId, currentVersion, acceptedVersion, reason}]}` where `reason` = `version_updated` \| `never_accepted`. A new version creates a **new record** — prior acceptance history is never erased. No re-registration.

## Performance
- **5-min agreement-version cache** (busted on publish/archive) — removes repeated `legalAgreements` reads on every compliance check.
- **60s enforcement-flag cache** (busted on `legalSetEnforcement`) — flag changes propagate within ≤60s across instances.
- All queries **index-free** (single-field equality + in-memory filter) → no composite indexes.

## Security (verified by tests)
No client can forge acceptance (agreement id **and** version validated against the live catalogue server-side) · **server timestamps only** (`serverTimestamp`) · IP captured server-side (never client-supplied) · **immutable append-only** audit log + acceptance records · admin ops gated on `admin`/`superAdmin` claim · role ownership verified.

## Test report — `node scripts/test-legal-compliance.js`
**29/29 PASS** (in-memory Firestore stub; runs in CI, no emulator): catalogue (core 5 / merchant 8 / provider 8 / rider=driver 5) · auth + admin gating · version-awareness (rejects fabricated versions) · idempotency (no duplicate records on re-accept) · audit log written · server timestamp + IP + hash recorded · version-upgrade detection (`version_updated`) · history preservation · dark-launch enforcement OFF→allows, ON→blocks non-compliant, ON→passes compliant, rollback to OFF.

## 🔴 Release readiness — Legal Compliance is **NOT COMPLETE** for v1.0.0
Per the sprint's own gate, all six criteria must pass. Current state:

| Criterion | Status |
|---|---|
| All sensitive backend operations enforce compliance | ⚠️ **Partial** — all 5 **provider** ops enforced; merchant/driver/property/hotel/restaurant/healthcare/employer ops still need the one-line guard (several of those role ops don't exist yet) |
| Admin reporting verified | ✅ |
| Version migration verified | ✅ (tested) |
| Regression tests pass | ✅ 29/29 |
| Documentation updated | ✅ |
| **All onboarding flows use SokoniLegalGate** | ❌ **BLOCKED** — only **merchant** (`pos-setup.html`) is integrated. Buyer/Provider/Driver/Rider/Property/Hotel/Restaurant/Pharmacy/Healthcare/Employer/Admin flows live in `onboarding.html` / `provider-onboarding.html`, which the concurrent agent has held uncommitted (163 dirty files) for the whole sprint. |

**Verdict: do NOT mark Legal Compliance complete in the v1.0.0 Release Report.** The engine, enforcement, audit, tests, and Legal Centre are production-ready; the blocker is purely the per-role wizard integration, which is a **one-line drop-in per flow** (`SokoniLegalGate.mount(el, { role })`) the moment the agent's tree is clean.

Related: [[ONBOARDING_ARCHITECTURE_UPGRADE]] · [[DISPATCHER_REGISTRY]]

Related: [[ONBOARDING_ARCHITECTURE_UPGRADE]] · [[DISPATCHER_REGISTRY]]
