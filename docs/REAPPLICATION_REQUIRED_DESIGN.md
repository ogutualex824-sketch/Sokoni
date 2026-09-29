# REAPPLICATION_REQUIRED — state / authority design and test manifest (read-only design; not a migration)

**Date:** 2026-09-29 · **Branch** `slice/c4-capability-consumer` · **Status:** design proven on the fake store, **31 / 0** (`scripts/test-approval-remediation-design.js`); two small hardenings applied to existing authorities (self-approval refusal; a stamp is never nulled by a failed derivation); **no production write, no Kasindi write, no application created.** Baseline: [[APPROVAL_REMEDIATION_CENSUS]] (91 accounts, digest `fc1c154f…`).

## 1 · The derived state (never stored, never client-writable)

`functions/shared/approval-remediation.js` — pure `deriveApprovalState(input)` over exactly the census evidence (Auth claims, users roles, provider / seller / businesses / shops records, applications, `isAdminAccount(uid)`, the cleanup-manifest id set, the current agreement version). Surfaces and authorities compute it on read; nothing persists it, so no client can choose its own state.

| State | Predicate (evaluated in this order) |
|---|---|
| **REFUSED** | `providers.approvalDecision = { refuse, source admin_decision }`; or only rejected applications and no registry record |
| **VALID_APPROVAL** | an application passing the **validity test**, or `approvalDecision = { approve, admin_decision }` not self-decided |
| **INVALID_LEGACY_APPROVAL** | an approval *artefact* exists (application approved, or `approvedAt / approved / adminApproved / approvedBy` on a record) but no decision passes the test |
| **NO_APPROVAL** | a registry record live by status alone (`live_status_only`), a stub that is not live (`registry_stub_not_live`), or a provider/seller role or claim with no record and no application (`role_without_registry`) |
| **PENDING_APPROVAL** | undecided application(s), no live record |
| **BUYER_ONLY** | no record, no application, roles ⊆ {buyer}; extra rider role or admin claim does not change this |

**Validity test** (`decisionValidity`): status approved **and** `decidedBy` is a resolvable Auth account holding admin or superAdmin **and** `decidedBy !== applicant uid` **and** the application's role approves the kind of record present (`KIND_OF_ROLE`: a driver application never approves a seller record).

**Transition predicate** — exactly: `state ∈ { INVALID_LEGACY_APPROVAL, NO_APPROVAL } ∧ ownership = remediation ⇒ transition = REAPPLICATION_REQUIRED`. BUYER_ONLY, VALID_APPROVAL (both `protected: true`), PENDING_APPROVAL and REFUSED never transition.

**Ownership** — if the cleanup manifest (digest `028299e7…`) claims the account or any of its registry records, `ownership = 'cleanup'` and the transition is **withheld**; the state is still reported. *Assertion: an identity claimed by the cleanup manifest cannot be mutated by REAPPLICATION_REQUIRED until the cleanup slice releases or transfers ownership.*

## 2 · Application path (never invents, never auto-selects)

| Situation | `applicationPath.mode` | Behaviour |
|---|---|---|
| one undecided application | `continue_existing` | the surface resumes it |
| several undecided (Heights Creations: 3) | `select_among_pending` | candidates listed, `requiresSelection: true`; the applicant continues **one** and withdraws the others; nothing is chosen for them; no fourth application |
| an approved artefact failing the test (Kasindi, Langa'ta) | `redecide_existing` | acknowledge on that application, then a fresh admin decision; the prior decision goes to `priorDecisions` |
| none reusable (DJ Bvmbxno, King Bruce if he ever applies, stubs, role-only) | `fresh` | submission through the **existing** intake schema and agreement version; `status pending`, applicant uid, `submittedAt` server, current `agreementVersion`; no role, no dashboard, no classification, no wallet/bookings/services/products change |

**Agreement** — `agreement.required` for every transitioning account; `satisfied` only when the reusable/submitted application carries `agreementAccepted === true` **at the current version** (`sokoni-merchant-application.js AGREEMENT_VERSION`); an older version does not satisfy. The gate is enforced twice: by the derivation and by the c4 `applicationDecide` approve path.

## 3 · Authorities reused, and the two hardenings

- **Fresh decision = the existing c4 `applicationDecide`**: agreement gate → `applicationDecisions/{appId}` server record → `priorDecisions` preservation → application patch → `adminAudit application_approve` → `applyDecision` projection → role through `role-authority`. No new approval system.
- **Registry record without an application = `bizAdminApprovalDecide`** (King Bruce class), unchanged.
- **Self-approval is now impossible in both** (rule 2): `bizAdminApprovalDecide` refuses `uid === actor` **before reading the target**; `applicationDecide` refuses `application.uid === req.auth.uid` immediately after the one read it needs to know the applicant and **before any write** (`permission-denied`, code `SELF_DECISION`). The derivation independently marks such decisions `self_decision` (the three existing ones on the admin account are reported, not repaired).
- **A stamp is never nulled by a failed derivation** (rule 1): `projectProvider` recomputes the C1 stamp at every approval; an `application`-sourced category is now kept when C1 cannot derive one from the application text. Langa'ta mamafua's live application does derive `cleaning` (`category: "cleaning"` → exact, per the R3 evidence), so this is a guard, not a repair — but without it a fixture with `type: "business"` and no category lost the stamp. Admin-sourced stamps were already preserved.

## 4 · Projection and independence (proven end to end on the fake store)

DJ Bvmbxno fixture (live by status; 4 bookings, 1 service, 3 wallet tx) → a fixture application representing what the surface would submit (pending, acknowledged at the current version) → real `applicationDecide` approve by `admin_D5` → provider live by evidence, `sourceApplicationId`, server record + audit → derived state **VALID_APPROVAL**, protected → **no category** (C1 has no exact match for the text) → resolver **PENDING_CLASSIFICATION**, no route → wallet, transactions, bookings, services, products **byte-identical** → repeat approve preserves the first admin decision once → suspend-after-approve is a lifecycle change with the approval preserved in `priorDecisions[1]`. Authority separation: had the application said "DJ", C1 would derive `artist_creator` with `source: application` — from the category authority's deterministic derivation, never from the admin's approve.

Langa'ta fixture (label decider, `cleaning` stamp): the fresh decision is **refused** until acknowledged; after acknowledgement, approved by `admin_D5`, `priorDecisions[0]` = the `"founder-decision-2026-08-01"` decision verbatim, the `cleaning` stamp **survives**, derived state VALID_APPROVAL, resolver AVAILABLE.

`bizAdminApprovalDecide`: approve after refuse → `DECISION_EXISTS`; a reversal remains a separate, unbuilt authority.

## 5 · The 14 points, where each is proven

| # | Point | Proof |
|---|---|---|
| 1 | transition predicate | §1 table; suite 1–4 (Kasindi, Langa'ta, KASS D5, DJ, second KASS SHOP, stubs, role-only, King Bruce, Heights) |
| 2 | buyer exclusion | buyer-only, buyer+rider, buyer+admin-claim → BUYER_ONLY, protected, no transition |
| 3 | valid-approval protection | k Riss → VALID_APPROVAL protected; an admin approval for another role does **not** protect |
| 4 | invalid legacy vs no evidence | subtypes `approval_artefact_without_authority` / `live_status_only` / `registry_stub_not_live` / `role_without_registry` |
| 5 | self-approval refusal | derivation `self_decision`; both real authorities refuse `SELF_DECISION` before any write |
| 6 | reuse vs fresh | four modes; Heights `select_among_pending` with 3 candidates, none chosen, none created |
| 7 | agreement/version | required for transitioning accounts; satisfied only at the current version; old version rejected |
| 8 | preservation | `preserve` lists every historical decision; real re-decisions append to `priorDecisions` verbatim |
| 9 | cleanup ownership | Shave 'n' Trims: state reported, `ownership: cleanup`, transition withheld |
| 10 | admin authority reuse | the REAL c4 `applicationDecide` makes the fresh decision (gate, record, audit) |
| 11 | projection | provider live by evidence; derived state flips to VALID_APPROVAL; Langa'ta stamp survives |
| 12 | idempotency / conflict | repeat approve dedupes; suspend preserves; `DECISION_EXISTS` on the record authority |
| 13 | classification independent | no category from approval when C1 cannot derive; PENDING_CLASSIFICATION; derivation is C1's, not the admin's |
| 14 | zero mutation | wallet, transactions, bookings, services, products byte-identical through every step; the two KASS SHOP identities distinct; wallet activity is not an input |

Regressions after the hardenings: decision-preservation 19/0 · decision-authority 21/0 · business-workspace 30/0 · classify-identity 20/0 · approval-decision 40/0 · approval-decision-manifest 15/0 · business-capabilities 46/0 · workspace-capability 51/0.

## 6 · What is NOT built (next slices, each its own authorization)

- the `reapplicationRequired` **surface**: "Complete your business application" on the dashboard shell, reading the derived state; a submission through the existing intake schema (`fresh`) or the re-acknowledgement surface (`redecide_existing`); a selection UI for `select_among_pending`;
- the shell gate: the live shell routes on role/claim/status — it must consult the derived state so REAPPLICATION_REQUIRED / REFUSED accounts land on the completion surface, not a dashboard (3 role-only accounts, King Bruce's residual roles);
- the AdminOS "Pending business applications" view (exists as `applicationList`; wiring of the derived state is new);
- per-identity manifests for the 18 transitioning accounts, cleanup overlaps excluded until ownership is assigned; Langa'ta mamafua follows the Kasindi model (acknowledge → fresh decision → stamp retained);
- deployment of any of this (functions lineage blocked on the self-mint hotfix provenance; hosting from the live line only).

Related: [[APPROVAL_DECISION_AUTHORITY]] · [[KASINDI_REPAIR_PRECONDITIONS]] · [[CAPABILITY_AUTHORITY_READ_MODEL]] · [[R2_ROUTING_RESOLVER]]
