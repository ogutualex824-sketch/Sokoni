# Complete Application surface + shell gate on the derived approval state — implemented and tested (no deploy, no production write)

**Date:** 2026-09-29 · **Branch** `slice/c4-capability-consumer` · Implements the first two steps of the owner's remediation order on top of [[REAPPLICATION_REQUIRED_DESIGN]]. AdminOS wiring and per-identity manifests remain separate. Kasindi remains separate.

## 1 · Shell gate — the ONE workspace authority answers approval first

`functions/business-workspace.js`:

- `approvalStateFor(db, uid, opts)` reads users, sellers, providers, businesses (by `ownerId` and by uid), shops (by `ownerId`), applications (by uid), resolves every decider's admin claim **once** through Firebase Auth (injectable), takes the caller's claims from the callable token, and hands the pure derivation (`shared/approval-remediation.js`) a synchronous predicate plus the **static copy** of the cleanup-manifest ids (`shared/cleanup-claimed-ids.json`, 34 ids, digest `028299e7…`, asserted identical to the release-gate manifest).
- `workspaceFor(db, uid, opts)` now gates **before** any category/capability routing:

| Derived state | Answer |
|---|---|
| `VALID_APPROVAL` | proceeds exactly as before (R2 category × capability routing) |
| `BUYER_ONLY` | `found:false`, `NO_APPROVED_BUSINESS`, no route — buyer stays buyer |
| `PENDING_APPROVAL` | `PENDING_APPROVAL / NOT_APPROVED`, no route, `remediation.applicationPath` (continue / select_among_pending) |
| `REFUSED` | state `REFUSED`, no route, the server's message |
| `INVALID_LEGACY_APPROVAL` / `NO_APPROVAL`, ownership remediation | **`REAPPLICATION_REQUIRED`**, route **`complete-application.html`** only, `remediation { applicationPath, agreement, preserve }` |
| same, ownership cleanup | `REMEDIATION_WITHHELD / CLEANUP_OWNED`, no route |
| evidence unreadable | `APPROVAL_UNREADABLE`, no route (fail closed) |

Every answer carries `approval { state, subtype, transition, ownership, applicationPath, agreement }`. `homeFor` applies the same gate to shop homes: a shop live by status alone gets no merchant-v2 home. Role/claim/status-only routing is gone from the authority; the derivation is the only judge, and it is never stored.

Client consumer `sokoni-business-workspace.js` (provider-dashboard shell): `REAPPLICATION_REQUIRED` → `location.replace` to the server-named route; `REFUSED / CLEANUP_OWNED / APPROVAL_UNREADABLE` → the server's explanation; it decides nothing.

## 2 · Complete Application surface

`complete-application.html` + `sokoni-complete-application.js` (UMD: pure `decide(w)` + `mount`). It asks `providerDispatch {op:'businessWorkspace'}` and renders the answer:

| Server answer | View | Action |
|---|---|---|
| REAPPLICATION_REQUIRED · `fresh` | "Complete your business application" | **Start your application** → `HubRegister.open()` — the EXISTING intake modal (loaded on the page with its rate schedule); no parallel form |
| REAPPLICATION_REQUIRED · `redecide_existing` / `continue_existing`, agreement unsatisfied | "Acknowledge the current Seller Agreement" | link to `/agreement-acknowledge` (the proven surface) |
| same, agreement satisfied | "Your application is complete" | none — SOKONI decides |
| `select_among_pending` (PENDING_APPROVAL or REAPPLICATION_REQUIRED) | every candidate listed | **Withdraw** an extra (the page's ONLY write: own pending application → `status 'withdrawn'`, non-decisive, owner-permitted by the rules) · **Keep & acknowledge** → `/agreement-acknowledge`; nothing is chosen for the applicant, nothing created |
| PENDING_APPROVAL | "with SOKONI for review" | acknowledgement prompt only if the agreement is not at the current version |
| REFUSED | the server's message | **Submit a new application** → existing intake |
| REMEDIATION_WITHHELD | "under SOKONI review" | none |
| AVAILABLE (valid) | "Your business is approved" | link to the server-named route |
| `found:false` (buyer) | "No business application to complete" | Register a business (optional) |
| APPROVAL_UNREADABLE | retry text | none |

The browser never sets approval state, never creates an application itself, never touches wallet/bookings/services/products. Signed-out visitors get the sign-in note (auth resolved through `SokoniAuthState.whenResolved`, the fix proven on the acknowledgement surface). Self-updating (`shared-header.js`), `noindex`, 390 px without overflow.

## 3 · Fixture migration (FIXTURE ≠ CONTRACT)

Under the gate, an "approved" fixture that carried only `approvedAt` is INVALID_LEGACY_APPROVAL — exactly what the authority must refuse. `scripts/lib/approval-fixture.js` makes suites carry the decision the producer would have made: `stubAdminAuth` (admin_* uids resolve with the admin claim) and `autoApproveOnWrite` (a providers/sellers write with `approvedAt` also seeds `applications/{uid}-app` approved by `admin_1`). Twelve suites were migrated; five assertions changed contract and say so in their text: a record live by status alone is now answered by the gate (REAPPLICATION_REQUIRED, route = completion surface) before the capability read model would call it CAPABILITY_CONFLICT; an unreadable read may surface as APPROVAL_UNREADABLE; the completion route is not a workspace route in "no route on one authority".

## 4 · Suite results

| Suite | Result |
|---|---|
| `test-shell-approval-gate.js` (new) | 22 / 0 |
| `test-complete-application-browser.js` (new; real page, real handler, Chromium) | 18 / 0 |
| `test-approval-remediation-design.js` | 31 / 0 |
| `run-rules-suite test-agreement-reacknowledge-rules.js` (+ applicant withdraw allowed, decisive status refused) | 17 / 0 |
| `test-workspace-capability` 51/0 · `test-business-workspace` 30/0 · `test-business-workspace-gates` 24/0 · `test-workspace-routing` 33/0 · `test-healthcare-workspace` 51/0 · `test-accommodation-profile` 6/0 · `test-classify-identity` 20/0 · `test-migrate-capability-identity` 28/0 · `test-r3-classification-apply` 22/0 · `test-audit-category-dashboards` 6/0 · `test-business-capabilities` 46/0 · `test-catalogue-capabilities` 9/0 · `test-shop-writer-authority` 20/0 · `test-business-workspace-projection-browser` 29/0 · `test-provider-dashboard-sidebar-browser` 90/0 · `test-business-category-admin-shops-browser` 13/0 · `test-business-approval-decision` 40/0 · `test-approval-decision-manifest` 15/0 · `test-application-decision-preservation` 19/0 | all green |
| `test-entertainment-registry` | 64 / 1 — pre-existing at the branch base (dispatcher handler list), unrelated |

## 5 · Consequences for production, when this ships (not now)

On the live records, the gate would send **18 accounts** currently reaching a provider/business dashboard to the completion surface (the census population), hold Heights at PENDING with a selection, show King Bruce REFUSED, withhold the cleanup-claimed ones, and leave the five valid accounts and 64 buyers exactly where they are. Kasindi and Langa'ta mamafua see the acknowledgement path on their existing applications. This is a Functions + Hosting release (business-workspace.js, the two new pages, the consumer) — Functions deploys are still blocked on the self-mint hotfix provenance; hosting must ship from the live line (currently `ec452fb`). Separate gates, one identity at a time afterwards.

## 6 · Not built

AdminOS "Pending business applications" wiring to the derived state; per-identity manifests; any deploy. Classification stays C1's derivation at approval plus `bizAdminClassify`, untouched.

Related: [[APPROVAL_REMEDIATION_CENSUS]] · [[KASINDI_REPAIR_PRECONDITIONS]] · [[R2_ROUTING_RESOLVER]] · [[CAPABILITY_AUTHORITY_READ_MODEL]]
