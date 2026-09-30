# Adjudication — Kasindi holdings limited: is the "reindex" approval valid approval evidence? (read-only; no manifest, no write)

**Date:** 2026-09-29 · **Production project** `sokoni-aeb26` · **READ ONLY.** Identity 2 of the six ([[ADJUDICATION_SIX_UNRESOLVED]]). Standard applied: the one k Riss met — an approved application decided by a named admin account, mirrored by a provider record live by approval evidence ([[LANDING_KRISS_ARTIST_CREATOR]]).

## 1 · The questions, answered from the records

| Question | Evidence |
|---|---|
| What exact record says Kasindi was approved? | `applications/PRVMS7IACKG`: `status: approved`, `statusCanonical: approved`, `decisionAppliedFor: approved`, `projectionStatus: applied`, `projectionReceipt` → `providers/WLt0Voww…` updated. `providers/WLt0Voww…`: `status: active`, `approvedAt` 2026-07-30T15:13:13Z, `sourceApplicationId: PRVMS7IACKG`. `users/WLt0Voww…`: `approved: true`, `approvedAt` 15:13:13Z, roles buyer + provider. Auth claim `provider`. |
| Who / what is recorded as the decider? | **`decidedBy: "reindex"`** — a bare string, not a uid. `decidedAt` 2026-07-30T15:11:12Z. No `approvedBy` on the provider. |
| Is "reindex" an automation label or an authorized AdminOS actor? | **Not an actor.** It is the **only** application in production with that decider. No code on the implementation line or the live line writes `decidedBy: 'reindex'`; the word appears only in `search-repair.js` as a *source label for search re-indexing* — unrelated to applications. No Auth account or admin has that id. It can only have been written by a hand-run or ad-hoc script, or by a decision path that no longer exists. |
| Is there an original application and does it match the uid? | Yes: `PRVMS7IACKG`, `uid` = the provider uid, `type: "Cleaning Company / Housekeeper"`, `category: "Service Provider"`, hub service, submitted 30/07/2026 (created 12:44:56Z). Match is consistent. |
| Are `approvedAt`, status and approval fields consistent? | Internally consistent with an automated pass, not with a review: `receivedAt` / `normalizedAt` **15:11:11Z**, `decidedAt` **15:11:12Z** — the decision landed **one second after intake normalisation**; provider projected 15:11:15Z; `decisionAppliedAt` 15:13:17Z; `approvedAt` 15:13:13Z. Role/keyword resolution `provider` by keyword. `agreementAccepted` **absent** (the current `applicationDecide` would refuse to approve). |
| Human/admin authorization, or only an automation changing state? | **Only an automation / unknown actor changing state.** No `adminAudit` record exists for the uid or the application — `applicationDecide` has always written one for every decision it makes, so the audited admin path did not run. The current decider check (`decisionAuthority`) requires `decidedBy` to be a uid holding an admin claim; "reindex" would be **refused** today. |
| Has any later process relied on that status? | Yes: the role authority granted the `provider` claim and wrote `users.approved / approvedAt`; the provider is `searchable: true, isPublic: true` (publicly listed since 30 July); a stray `sellers/{uid}` record exists (branches only, client-written 2026-07-28, no status, not live); one wallet transaction — a `receive` of KES 50 on 2026-08-03 (completed). No bookings, services, enquiries or reviews. |
| Does the evidence satisfy the k Riss standard? | **No.** k Riss: decided by the admin account `D5Ql2EYr…` (holds admin + superAdmin claims), 24 days after submission, provider `approvedAt` from that projection. Kasindi: decided by a non-actor string one second after intake, no audit trail, no admin uid, no agreement acknowledgement. What is established is that *something* marked it approved on 30 July and the system faithfully projected that; **it is not established that an authorized person decided it.** |

## 2 · Verdict

**Approval provenance is NOT established.** Kasindi remains **unclassified**; no manifest is prepared. Under R2 the identity stays PENDING_CLASSIFICATION (no route) — and, more precisely, its liveness rests on an `approvedAt` that the July automation wrote, which the read model accepts as protected evidence. That acceptance is a limit of the evidence model: `approvedAt` is server-only today, so it is trusted, but here it was minted without an admin decision. This document records that, and does not change the model.

"reindex" is not equivalent to the k Riss approval merely because it produced an approved-looking state.

## 3 · What would establish it — the decision the owner must make (not this document)

Kasindi's business is a real one (a named company, phone-verified, a cleaning company by its own type field, a completed receipt of KES 50). The lawful routes to valid approval evidence:

- **A. A fresh admin decision on the existing application** through the audited path (`applicationDecide` / `applyDecision`). Blocker: `agreementAccepted` is absent, so the approve path throws `failed-precondition` until the business acknowledges the agreement — the same gate every applicant meets. This re-decision would write a real `decidedBy` (admin uid), an `adminAudit`, and re-project the provider; only then the classification manifest (`cleaning`) applies with k Riss's controls.
- **B. An admin approval-decision authority** that records an admin's decision on an existing provider record with an audit — the same missing operation DJ Bvmbxno needs. It must not backdate or recast the "reindex" event as an approval; it records a new decision, today, by a named admin.
- **C. Leave as is** — publicly listed, provider claim held, no routable workspace on this line.

The classification itself is not in doubt: type "Cleaning Company / Housekeeper" → C1 `cleaning` → services lane → provider dashboard. It waits only on valid approval evidence.

## 4 · Finding beyond Kasindi

The audited `applicationDecide` (which writes `adminAudit`) entered the lineage on **2026-07-30** (`5990437`) — the very day of this decision — and left no record for Kasindi, so the decision did not go through it; the decider check (`decisionAuthority`) arrived on **2026-08-16** (`bc9bf4c`). Between those dates the lifecycle trigger accepted any `decidedBy` string on a document. Kasindi is the one production application that shows it. That history is why the model treats `approvedAt` as evidence *and* why this adjudication does not: the field is protected now, but was not always written by a decision.
