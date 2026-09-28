# C4a — Register My Business: authority and application-spine survey

> Convergence programme · C4a (read-only survey) · surveyed at `6dee0d4` on 2026-09-28
> Related: [[C3_DISCOVERY_CERTIFICATION]] · [[BUSINESS_CATEGORY_AUTHORITY]] · [[PROVIDER_REGISTRY]] · [[AdminOS]]

**Nothing was implemented, deployed or run against production.** This document maps who can create or elevate a
business, provider or application identity today, so that C4 implementation starts from evidence.

The C4 principle it is measured against: **the applicant expresses intent; the server and AdminOS determine the
authoritative business identity, category, approval state, workspace and public eligibility.**

## Method

Three independent census passes produced these results. Each claim marked ✔ was re-checked by hand against the code:
- **Server:** every `functions/` writer of an application, provider, business, shop, seller or user role/claim.
- **Browser:** every registration entry point, and what it submits.
- **Rules:** every Firestore and Storage match block for those paths. Duplicate blocks OR together, so all of them were
  read.

**Evidence boundary:**
- This is the repo at `6dee0d4`. Production is deployed from several lineages, and the rules source's own header says
  it diverges from production.
- **No gap below is claimed live** until the deployed functions and the served ruleset are checked, which needs owner
  authorization for a read-only production check.

## The canonical spine, as it exists

```
applications/{appId}  (browser-created, status 'pending' — rules: noApplicationDecision)
   ↓  AdminOS: applicationDecide (admin claim)  →  applicationDecisions/{appId}  (server-only)
   ↓  applicationLifecycle trigger / applicationReconcile  →  decisionAuthority (decision record + admin)
   ↓  applyDecision — routes by resolveRole(app):
        provider / health → projectProvider  → providers/{uid}: status, business{category (C1), lane}, healthcare
        seller           → projectSeller    → shops · sellers · businesses/{uid}
        driver           → projectDriver    → rideDrivers · drivers · driverVerification
        legal            → legal-verification.applyAdminDecision (+ LSK gate)
        event_organizer  → claim only
   ↓  grantAccountRole → users.roles[] + claims (role-authority.syncRoleClaim)
   ↓  C2 workspaceFor / workspace.html  →  C3 publicEligibility → discovery
```

Per-vertical lifecycles that are healthy and deliberately separate:
- **Lawyers:** `registerLegalProvider` → `applications/legal_{uid}` + the LSK gate.
- **Event organizers:** `applications`, with the claim gating access.
- **Creators:** `creatorVerifications/{uid}` + a document snapshot.
- **Venues:** `venueCreate` → pending → AdminOS listing decision (C3 approval gate).

## Browser entry points (24 found)

| # | Entry | Creates an application? | Verdict |
|---|---|---|---|
| A1 | `hub-register.js` "Register My Business" modal (30 pages) | yes: random id, applicant-picked `category`/`hub` | **Canonical label.** Paid-plan copy says "live immediately" before any decision |
| A2 | `onboarding-seller.html` → `sokoni-merchant-application.js` | yes: deterministic `applications/{uid}--merchant`, forbidden-field filter | **Canonical primitive**, but **✔ field mismatch**: the application reaches reviewers with no name, phone or description (the wizard sets `shopName` / `mpesa`, the submit reads `storeName` / `phone`) |
| A3 | `workspace.html` "Register my business" → `onboarding.html` | **no.** It writes `accountProfiles` / `accounts` that **✔ nothing reads** | **Duplicate, dead to AdminOS.** Says **✔ "You're live on SOKONI!"**. The canonical router's own button leads here |
| A4 | `seller.html` wizard (reached by "Start Selling" → `/offer`) | **no** | **✔ BYPASS**: the browser writes `businesses/{uid}` `status:'active'`; `saveShopProfile` creates an active, visible shop |
| A5 | `seller.js` "Submit Verification Application" | no (localStorage) | Dead. Still shows "Verified Seller" |
| A6 | `onboarding-professional.html` | yes | Duplicate; the browser also creates `providers/{uid}` |
| A7 | `provider-onboarding.html` "Become a Provider" | **no** (`providerPublish` creates a closed `providers` row; nothing enters the AdminOS queue) | **Bypass of the queue.** Says **✔ "now searchable… customers can discover and book you"**; the plan is activated before approval |
| A8 | `provider.html` setup overlay | yes | Duplicate + bypass: the browser writes `providers/{uid}` with `status:'available'` and `providers/{phoneDigits}.status` |
| A9 | `services.html` register provider | yes (fire-and-forget) | Duplicate; "Listed!" shown before any write |
| A10 | `onboarding-driver.html` | yes | **Canonical driver path** |
| A11 | `driver.html` registerDriver | yes (fire-and-forget) | Duplicate; the driver record and PIN are in localStorage |
| A12 | `signup.html` role checkboxes | — | Router: routes by the self-selected role (except seller) |
| A13 | `offer.html` | — | Router into A4 / A8 |
| A14 | `legal-hub.html` | via server | **Canonical (lawyer)**; `already-exists` treated as success |
| A15 | `event-manager.html` | yes | **Canonical (organizer)**; unordered `limit(1)` can pick the wrong application |
| A16 | `venue-manager.html` | venue listing | **Canonical (venue)**, own rail |
| A17 | `creator-studio.html` | creator verification | **Canonical (creator)**, own rail; the only real document upload |
| A18–A24 | `bnb-hub` List Your Stay, `bnb-manage`, `pos-onboard`, `businesses.html` → `business-os`, `tech-hub`, `seller-register.html` (missing), `providers.html` "Become a Provider" → `seller.html` | — | Dead, orphaned, false-success or mislinked |

**No single "Register My Business" exists.** Four intakes carry the label (A1, A2, A3, A4) and do four different
things. The canonical router's button (A3) creates no application at all.

## Server-side bypasses of the spine (K1–K12)

| # | Path | What it does | Severity |
|---|---|---|---|
| **K2** | `account-status.accountReactivate` (any signed-in user) | **✔ no "was it deactivated" check**: restores `providers.status` to the stash or **`'active'` when there is none**. A `pending_approval` self-publisher, or an admin-suspended provider (that path never stashes), self-activates. That unlocks the legacy full workspace, the provider claim on the next publish, and `providerRequestShop` | **P0 candidate.** Present in ≥7 local lineages including `deploy/merchant-pipeline-pin-hotfix` and `candidate/p9-entry-reconciled`; absent on `main`; **live status unknown** |
| K8 | `kasshop.saveShopProfile`; `smartPosDispatch createBusiness` | **✔ any user creates an active, visible `shops/{uid}`**; `_createBusiness` creates `businesses/SOK-*` + `merchants` active, unguarded, honouring a caller-supplied `__provisionedBy` | High |
| K1 | `providerPublish` | mints `claims.provider` whenever `providers.status` is active by ANY path (chains with K2) | High, with K2 |
| K3 | Kass `approve_seller` (admin + MFA) | writes `providers.status` directly: no decision record, no C1 stamp, no audit | C8 (recorded in C3) |
| K4 | `automation-engine.autoOnSellerApplication` | a second, non-admin seller approval (role + claim + active shop), **on by default**, currently starved (nothing writes `sellerApplications`) | Latent |
| K5 | WAP `seller.activate` | seller role + claim through a workflow step whose admin check uses `claims.role/eccRole`, not `token.admin` | Medium |
| K6 | `grantPlatformRole` | adds seller/driver/business to `users.roles` with no claim or registry | Medium |
| K7 | `adminUpdateUserRole`, `super-admin.setUserRole` | replace the WHOLE claim set (dropping provider / rider / event_organizer) and write `users.role`, not `roles[]` | Medium |
| K9 | `providerRequestShop` | merchant identity + seller role from a provider approval (documented as an intentional extension) | By design; confirm |
| K10 | `registerHealthProvider` | still exported; writes the retired `healthProviders` registry with no application | Low |
| **K11** | `projectProvider(approved=false)` / `projectSeller` | **✔ rejection == suspension**: rejecting ANY later application from the same uid suspends their LIVE provider / shop and revokes the role and claim | **High** (a correct decision on a duplicate breaks a live business) |
| K12 | applicant rules on `applications` | reset a decided application to `pending`, edit a rejected one's classification, delete an approved one; nothing retracts, so the queue and the registries disagree | High |

**Role authority:** `resolveRole` derives the granted role from applicant fields (`type`, then keyword guesses over
`category` / `hub`), and `applicationDecide` accepts only `{approve | reject}`. **An admin cannot correct the role at
decision time.** The applicant's selection picks the role.

**Category:** `business.category` is written only by `projectProvider` (C1 `categoryFromApplication`, exact match or
null) and the two AdminOS classify callables. ✅ Free-text `category` is still stored in `providers` / `shops` /
`businesses`, but C1 / C3 never read it as authority.

## Rules gaps, repo source (✔ = verified)

1. **✔ `businesses`, `sellers`, `stores`, `mechanics`, `homeServiceProviders`, `constructProviders`,
   `marketingProviders`, `rideDrivers`:** a browser creates a publicly readable record with ANY `status` and can
   re-activate it. `noAdminFields()` does not cover `status` / `active` / `isPublic` / `category`. `stores.ownerId` is
   mutable.
2. **`providers` owner update lacks `noAdminFields()`.** The owner can set `featured`, `adminApproved`,
   `commissionRate`, `role`, `isAdmin`, clear `flagged`, and set `isPublic` / `searchable` / `acceptsBookings`.
   `{providerId}` is not bound to the uid on create (squatting another uid's id before it exists).
3. **✔ `applications`:**
   - no uniqueness;
   - decided state is re-openable (any non-decisive status);
   - two-step bypass of the classification freeze;
   - `business` / `healthcare` / `isPublic` keys not forbidden;
   - an applicant may delete a decided application.
4. **`verifications`, `verificationRequests`:** `verified` / `approved` can ride along on a pending create.
5. **✔ `propertyListings` duplicate block:** `allow create: if isAuthed() && noAdminFields()` voids the other block's
   `write: false`. There is no owner binding.
6. **`users.roles`:** self-add any role except the four staff roles.
7. **✔ Storage `/documents/{uid}/…` and `/kyc-documents/{uid}/…`:** keyed by uid only, with no application id, and
   **overwritable after review**. `/documents` read omits superAdmin.

## Documents and verification

- No application links to a document.
- `providerVerification` stores server-built uid paths, with no existence check.
- `adminDecideProviderVerification` records `documentsReviewed` from legacy `*Url` keys, so the list is **empty** for
  current submissions.
- Only creator verification snapshots its files (md5 / generation).
- `onboarding.html` and `provider-onboarding.html` show "Uploaded ✓" but upload nothing.

## Rejection and resubmission

- A rejection is recorded (status, reason, `decidedBy`). `applicationDecisions` is overwritten on a re-decision, so
  history lives only in `adminAudit`.
- Random-id intakes (A1, A6, A10) create a NEW application on every resubmit, with no status UI.
- A2 resubmits deterministically but never shows the rejection reason.
- Combined with K11, a rejected duplicate can take down a live business.

## Owner decisions (2026-09-28) — the C4 contract

The survey's open questions, as decided by the owner. **The unified intake is NOT built before the read-only production
check and the highest-risk remediation slices are resolved.**

1. **P0 candidates and the production check: YES.**
   - A **read-only** production check is authorized of:
     - the deployed `accountReactivate`;
     - the live Firestore and Storage rules;
     - the active application / approval paths;
     - the automatic seller approval and workflow writers;
     - the eight business collections with client-controlled `status`;
     - the provider fields `adminApproved` / `featured` / `commissionRate`.
   - No production writes, deploys, migrations or rule changes.
   - Remediation priority: **K2 → K8 / self-activation → rules authority gaps**, each in its own slice. None is merged
     into C4a.
   - **The slices are set by what the production check proves is deployed.** Seven branches are not fixed merely
     because K2 exists there.
2. **One Register My Business intake: YES.** Built on the merchant-application pattern:
   Register My Business → what are you offering? → one application → AdminOS `applicationDecide` → C1 category → C2
   workspace → role grant.
   - All four competing "Register My Business" entry points converge on it.
   - Dead and duplicate paths are retired, not maintained alongside it.
   - The healthy vertical paths (legal, organizer, creator, venue, driver) stay where their specialized workflow is
     legitimate.
3. **One live application per user per business type, and rejection ≠ suspension: YES.**
   - A rejected application never suspends, deactivates or revokes an already-approved business (closes K11).
   - Decided applications are read-only to the applicant (closes K12).
   - A resubmission creates the appropriate new application; it never reopens the decided record.
   - Approval and rejection stay an AdminOS / server decision.
4. **Role and category: AdminOS explicitly confirms or overrides: YES.**
   - The applicant states intent. At decision time AdminOS determines the authoritative category and business model /
     role.
   - C1 remains the source of the final category. AdminOS supplies the authorized decision and creates no competing
     category registry.
   - The server no longer guesses the authoritative role from applicant text.
5. **Documents belong to the application and are locked after submission: YES.**
   - Lifecycle: draft → submitted → locked → AdminOS review.
   - No silent replacement or overwrite of evidence after submit, and the original evidence is never deleted.
   - Additional evidence comes through an explicit, server-authorized, audited additional-document / resubmission
     mechanism.
6. **Non-canonical approvers are routed through `applicationDecide`: YES.**
   - `applicationDecide` is the one approval decision.
   - Automatic seller approval (`autoOnSellerApplication`) is **retired**.
   - Automation, workflow and admin-role writers may trigger or assist the workflow, but never independently manufacture
     the authoritative approval state.

**Order of work:**

```
C4a survey (this document)
   ↓  READ-ONLY PRODUCTION CHECK
   ↓  K2 remediation
   ↓  K8 / self-activation remediation
   ↓  rules authority hardening
   ↓  C4b canonical Register My Business
   ↓  C4c AdminOS decision + category / role projection
   ↓  C4d documents / submission lifecycle
   ↓  C4 certification
```

## Carried forward from C3 (unchanged)

N1 (the ungated Typesense backfill), N2 (the Kass discovery bypass), C8 `approve_seller`, C3 follow-ups 1–3, and
Algolia A1–A2.
