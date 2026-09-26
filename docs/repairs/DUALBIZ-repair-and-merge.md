# Dual-business — merged onto the main line, with its authorization defect repaired

**Branch:** `dualbiz/repair` (from main line `3745a5b`) · **NOT landed, NOT deployed** · no production writes
**Related:** [[COMMISSION-own-property-lookups]] · [[RES1-opt1-session-quote-binding]] · `feat/dual-business-commerce`

## Commits

| commit | what |
|---|---|
| `7dd045e` | merge of `feat/dual-business-commerce` (13 commits, `c34455d..68cc988`), with three conflicts resolved deliberately |
| `0f3bf87` | reconcile the merge with the main line's catalogue authority |
| `81394d8` | the security repair: approval evidence, the seller approval marker, the per-sale quick-charge cap |
| `da32263` | a discriminating quick-charge bypass case |

## Conflict resolutions

- **`catalogue.html`: HEAD wins.** The main line routes every catalogue write through the server
  (`smartPosDispatch` → canonical `products`); the branch wrote `posProducts` from the browser.
  - Only the branch's deep-link and shell-embedding UI was ported (`4a3a30b`, `8169293`), so the merged
    `services` route (`catalogue.html?tab=services`) opens the Services tab.
  - No changed line touches Firestore or the write path; only 3 lines of HEAD's version were replaced.
- **`sokoni-pos-pay-console.js`: branch taken.** It is verified as a strict superset of HEAD's (0 lines
  removed) and adds only the mixed-basket breakdown display.
- **`sokoni-merchant-routes.js`: both kept.** HEAD's five ecosystem groups plus the branch's services group.
  The stale `/catalogue` exclusion ("not committed … admit once it lands") is admitted, because it
  landed in `000c75d` and the services route now mounts it.
- **`test-catalogue-model`:** its positive control asserted that the page reads `posProducts`. On the main
  line it reads and writes canonical `products`, so the control now names the authority actually
  used.

## The authorization defect (verified against the served production rules)

`shared/business-scope.js` treated a registry record with **no status** as approved, and a live
**status** as enough. Both are writable by the account itself:
- `sellers/{uid}`: `status` and `active` are not covered by `noAdminFields()`;
- `providers/{uid}`: may be created with no status.

So any signed-in user could grant themselves products **and** services scope.

**The data forced a design correction.** The seller approval path (`application-lifecycle` `projectSeller`)
wrote only `status` and `active`, so no approved seller could be told apart from a self-written record.
Production has 8 sellers and 0 carry any protected field. The owner authorized option A:
- **`projectSeller`** now also writes `approvedAt` and `approvedBy` (the verified `decidedBy`). Both are
  withheld from clients by `noAdminFields()`. This is surgical: only the seller projection changed, and the
  admin-claims blocker was not touched.
- **`business-scope.js`:** a missing status is **not** approved. A live status is required, **and**
  approval needs protected evidence (`approvedAt`, `approved` or `adminApproved`). The new reason code is
  `not_approved`.
- **`catalogue.html`** display mirror updated to the same rule. It is display only.
- **No backfill.** The 8 existing production sellers lack the marker, so they stay unapproved for the
  dormant `pos_service_sale` until a separately authorized migration or re-approval establishes their
  provenance.

**Providers are protected by a different field.** The served owner-update rule does **not** withhold
`approvedAt` or `adminApproved`: it blocks only status, verified, suspended and approved. But an owner
can never set `status:'active'` (create requires absent or pending; update cannot change status), so
the approved end state stays unreachable. The suite records this rather than hiding it.

## Quick charge

The limit was checked **per line**. It is now the **sum** of quick-charge lines per sale. The till's
advisory warns against what remains after quick charges already in the cart. Quick charge stays
dormant from payment finalization.

## Evidence

All suites were run from the real worktree checkout, with `.git`.

| suite | old (`68cc988`) | repaired |
|---|---|---|
| `test-business-scope` | 50 / **12 FAIL**: every self-written, no-status and evidence case | **62 / 0** |
| `test-business-scope-authority` (new; served rules plus allow-all counterproof plus the real `projectSeller`) | 8 / **6 FAIL**: R2 self-seller accepted as `approved`, R6, R8, R9, W1 no marker, W3 browser record accepted | **14 / 0** |
| `test-pos-service-pricing` | 72 / **3 FAIL**: the two-line split, and 7 × KES 19,000 = KES 133,000 accepted | **75 / 0** |

What `test-business-scope-authority` proves:
- An account **cannot** add `approvedAt`, `approvedBy`, `approved` or `adminApproved` to its own seller, nor
  create one carrying them.
- It **cannot** create or update its own provider to `status:'active'`.
- Every record it *can* write is rejected by business-scope.
- The allow-all counterproof accepts every attempt.
- Approval writer → marker → accepted; the browser `{status:'active', active:true}` record is rejected; a
  later suspension revokes approval.

**Regression floor:**

| area | result |
|---|---|
| `product_order` | byte-identical to `6e2b01e` and `3745a5b` |
| dual-business suites | payment purposes 42/0; IntaSend 50/0; tender 76/0; basket 64/0; receipt gate 55/0; QR 36/0; quick-charge UI 44/0; provider application 46/0; nav 71/0; v2 nav 67/0; catalogue model 81/0; deep link 38/0 |
| catalogue migrations | canonical 47/0; write 34/0 |
| merchant | ecosystem 119/0 |
| commission | own-property 20/0; parity 16/0; plan ladder 44/0; money chain 43/0; 5% 58/0; POS lane 92/0; settlement authority 53/0; `--check` text and answers |
| R1–R5 / RES-1 (served rules, nothing skipped) | R1 39; R2 26; R3 21; R4 33; R5 32; RES-1 option 1 23; double credit 66; refund 55; escrow 13 (all /0); RES-1 GREEN; RES-1b GREEN; quote authority 128/0 |
| predeploy gates | syntax, require-closure, single-source, settled-case, delivery-engine: all pass |

Three failing suites are **identical assertion for assertion to `3745a5b`**, so they are pre-existing:
- `test-merchant-routes` 2: sidebar order, primary count;
- `test-merchant-ecosystem-convergence` 1: flash-sale reference;
- `test-merchant-package-convergence` 8: retired 16/12/8/4.

## Kept out, by decision

- RES-1 option 2
- wallet
- commission authority
- `pos-qr.js` (its no-auth, paid-before-signature and reuse findings are pre-existing and separate)
- Hosting
- `functions/.env`
- the card rollout
- the admin-claims blocker
- any production backfill

`car_hub`, `accommodation` and `pos_service_sale` stay **dormant**: no client caller, no finalizer.

## Conditions before `pos_service_sale` is ever wired

- It prices from `posProducts`, while the main-line catalogue writes canonical `products`. Items created
  in the catalogue could never be priced by it.
- It has no finalizer and no declared commission.
- It does not ownership-check `posProducts` items.
