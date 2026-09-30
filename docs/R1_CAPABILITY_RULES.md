# R1 — the capability stamp and the category stamp on `businesses` are server-written only

**Date:** 2026-09-29 · **Line:** `slice/c4-capability-consumer` · **Rules source + build changed; NOT deployed.** The served production ruleset (`6c67a34d…`) still carries the vector until a rules release the owner authorizes.
Follows [[ROUTING_CONVERGENCE_CENSUS]] finding 2. Precedes R2 (the resolver), which may trust `businesses.capabilities` only after this rule is served.

## The vector

`businesses/{id}`: `allow create: isAuthed() && request.resource.data.uid == request.auth.uid && noAdminFields()`; `noAdminFields()` did not list `capabilities` or `business`. A signed-in user could create `businesses/{their uid}` carrying a well-formed capability stamp — `decidedBy`, `decidedAt`, `source` are only strings to the rules — and any consumer of the stamp would read it as **STAMPED**: a self-granted capability. The same held for the C1 category stamp `business` on `businesses` (on `providers` it was already admin-protected). Latent, not live: nothing deployed reads either stamp yet.

## The rule (firestore.rules, one `businesses` block)

- **create**: unchanged conditions **and** the document may not contain `capabilities` or `business`.
- **update**: an owner may not affect `capabilities` or `business` (whole object, dotted path, or a single nested field); **an admin's raw client write may not either** — like `providers.business`, the audited server paths are the only writers (approval projection, the capability migration contract, AdminOS reclassification, all Admin SDK).
- Everything else unchanged: owner edits of ordinary fields, `uid` immutable, `noAdminFields()` (approved / approvedAt / verified …) admin-only, admin edits of other fields (adminNote, status/suspended), delete admin-only.

## Evidence

`scripts/test-business-capability-rules.js` via `scripts/run-rules-suite.js` (private emulator port, built ruleset):

| | Result |
|---|---|
| on the rebuilt ruleset | **24 / 0** — 3 create denials, 5 owner-update denials, 3 admin-raw denials, 4 identity-field protections, 5 positive controls (plain create, owner field edits, admin adminNote, admin suspend), 3 server-path counterproofs (rules disabled: the same stamp writes succeed), single-block check |
| **negative control** — the same suite on the pre-R1 build (`HEAD:firestore.rules.build`) | **12 / 12**: every self-stamp and admin-raw denial FAILS ("expected to fail, but it succeeded") while every positive control still passes — the rule is new and the suite bites |
| regression on the rebuilt ruleset | `test-business-category-rules` 20/0 · `test-employment-events-rules` 26/0 · `test-employment-invites-rules` 40/0 · `test-shop-writer-authority` 20/0 |
| build | `build-firestore-rules.js`: braces 1702/1702, `firestore.rules.build` 179,590 bytes (+274) |

## Not done, by instruction

No consumer change (`business-workspace.js` untouched in R1). No classification of the seven unclassified providers, no touch of DG Wine / Latomi / KASS / the four status-only accounts / the 34-record manifest / branches / cards / AdminOS counts. No deploy: the rules release is its own decision (`--only firestore:rules` scope caveats in the repo's rules memory apply).
