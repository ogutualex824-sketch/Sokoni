# Business approval-decision authority — design and proof (no production use)

**Date:** 2026-09-29 · **Status:** implemented on `slice/c4-capability-consumer`, proven on the fake store (**40 / 0**), registered in the AdminOS dispatcher, **not deployed, not used on any production record.** Built for identity 3 of the six ([[ADJUDICATION_SIX_UNRESOLVED]]): DJ Bvmbxno — a provider record live by a client-written `status` alone, with **no application**, and real activity (4 bookings, 1 service, 3 wallet transactions). The same class covers King Bruce. The owner decides separately whether DJ Bvmbxno is approved and, only after that, whether it is classified.

Module: `functions/business-approval-admin.js` · handler `bizAdminApprovalDecide` (`_adminH`, merged into `admin-os-dispatch.js` beside `bizAdminClassify`) · suite `scripts/test-business-approval-decision.js`.

## 1 · The gap it closes

The application lifecycle ([[Authentication]], `application-lifecycle.js`) can only decide an **application**. A registry record that reached `status: active` without one has nothing for `applicationDecide` to act on, and the only other writer of approval evidence is the projection. Until now the choices were: fabricate an application (refused — it asserts something untrue about what the business submitted), rewrite the status by hand (a client-shaped write with no decider and no audit), or leave the record permanently in `CAPABILITY_CONFLICT` (`provider_status_without_approval`). This authority is the fourth option: **an administrator records a real decision, today, on the existing record.**

## 2 · Contract, clause by clause, and how each is enforced

| Owner's clause | Enforcement | Proof (suite section) |
|---|---|---|
| Admin-only; the provider/owner cannot invoke it; refuse before any mutation | `admin-claim.isAdmin(req)` before the transaction; unauthenticated → `unauthenticated`, non-admin → `permission-denied`. No read, no write happens first. | *admin-only*: 3 refusals, store byte-identical, 0 audits, 0 role grants |
| A real decision today: named admin actor, current timestamp, decision, reason, target uid | `providers/{uid}.approvalDecision = { decision, decidedBy: <caller uid>, decidedAt: serverTimestamp, reason, prior, source: 'admin_decision' }`; approve also writes `approvedAt: serverTimestamp`, `approvedBy: <caller uid>`. | *real decision*: `decidedBy = admin_D5`, `approvedAt` within 60 s of now |
| Never interpret historical status as the approval | The pre-decision `status / approvedAt / approvedBy / decidedBy` are **copied into `prior`** and into the audit's `previous`; they are inputs to nothing. | *real decision*: `prior = {active, null, null, null}` |
| No fabricated application; never rewrite `decidedBy` on old records | The module has no code path that touches `applications/*`. Proven against a Kasindi-shaped application (`decidedBy: "reindex"`) sitting in the same store. | *no fabrication*: 0 applications for DJ; Kasindi application and provider byte-identical |
| Idempotent: same decision repeated → same result, no duplicate audit | An existing `approvalDecision` with the same `decision` returns `repeated: true` with the **original** decider and timestamp; nothing is written, not even by a different admin or with a different reason. | *idempotent*: provider byte-identical, 1 audit, 1 grant, original decider returned |
| Conflicting subsequent decision must refuse, not overwrite | A different `decision` → `failed-precondition` `DECISION_EXISTS` naming the existing decision and decider. A reversal is a separate authority with its own audit, deliberately not this one. | *conflicting*: refuse-after-approve and approve-after-refuse both refused, store unchanged |
| Financial / activity isolation | The transaction touches exactly `providers/{uid}` and one new `adminAudit` document. | *isolation*: providerBookings, providerServices, walletTransactions, wallets, products byte-identical |
| Explicit decision semantics: approval ≠ classification | No `business` (category) field is written. After approval the capability read model reports the provider live with the conflict cleared, and the R2 resolver **still holds at `PENDING_CLASSIFICATION` (no route)**. Classification remains `bizAdminClassify`, a second, separately reasoned admin decision. | *semantics*: `business` undefined; readModel conflicts `[]`; resolver `PENDING_CLASSIFICATION`, route null |
| Audit: one authoritative record, named admin, before/after, reason, timestamp, immutable provenance | One `adminAudit` `business_approval_decision` per decision: `targetUid, performedBy, decision, previous {status, approvedAt}, next {status, approvedAt}, reason, createdAt`. `adminAudit` is admin-read, server-write only under the rules. | *audit*: exactly 1; all fields present; 2 identities → 2 audits |

Additional behaviour the contract implies:

- **Refuse fails closed.** `refuse` → `status: suspended`, `suspended: true`, `searchable: false`, `isPublic: false`; **no** `approvedAt` / `approvedBy`; no role. An unapproved record that was publicly listed by status alone stops being public.
- **Role through the ONE role authority.** `approve` grants `provider` via `role-authority.grantAccountRole` (injected as `deps.grantRole` for the suite). The module never calls `setCustomUserClaims` itself — the stubbed Admin Auth in the suite throws if it did.
- **Boundaries.** Missing record → `not-found` `NO_PROVIDER` and **no record is created**; a healthcare provider → `HEALTHCARE_BOUNDARY` (its own approval authority); bad decision / short reason / missing uid → `invalid-argument`; all before any write.

## 3 · What it deliberately does not do

- It does not decide applications — `applicationDecide` keeps that. Kasindi ([[KASINDI_REPAIR_CENSUS]]) has an application, so its repair goes through the application path, not this one.
- It does not classify, route, or stamp a capability. Capabilities stay a read model on this line ([[CAPABILITY_AUTHORITY_READ_MODEL]]); `approvedAt` written here is the same protected evidence the read model already honours.
- It does not reverse a decision. A reversal (`approve` → `refuse` later) needs its own audited authority with its own reason; overwriting `approvalDecision` would delete the record of the first decision.
- It is not reachable by the business: the handler sits behind `adminOsDispatch`, which requires the admin claim, and `providers/{uid}.approvalDecision`, `approvedAt`, `approvedBy`, `status` promotion are all withheld from the client by the rules (`noAdminFields`, the providers `status` clause).

## 4 · Suite result

```
node scripts/test-business-approval-decision.js   → 40 passed, 0 failed
node scripts/test-admin-os-wiring.js              → 327 passed, 0 failed  (dispatcher registration)
```

## 5 · For DJ Bvmbxno specifically — the owner's next decision, not this document's

The authority exists and is proven. It has **not** been pointed at `providers/<DJ Bvmbxno>`. The owner now decides, in order: (1) is DJ Bvmbxno approved to operate (a `bizAdminApprovalDecide` manifest: one provider row, one audit, bookings/wallet/service untouched — the suite's isolation proof is the template), or refused (fail-closed delisting); (2) only if approved, whether it is classified `artist_creator` through `bizAdminClassify` with its own manifest and reason. Neither follows from the other, and neither follows from this authority existing.

Related: [[ADJUDICATION_KASINDI]] · [[MANIFEST_KRISS_ARTIST_CREATOR]] · [[R2_ROUTING_RESOLVER]] · [[R3_CLASSIFICATION_MANIFEST]]
