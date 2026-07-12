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

## Pending
- **UI step** in the onboarding wizard (`onboarding.html` / `provider-onboarding.html`) — blocked on the concurrent agent's active edits; wire per the contract above once the tree is clean.
- Optionally seed real agreement text/versions via `legalPublishAgreement` (defaults to `1.0` until then).

Related: [[ONBOARDING_ARCHITECTURE_UPGRADE]] · [[DISPATCHER_REGISTRY]]
