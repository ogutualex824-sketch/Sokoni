# Kasindi holdings limited — repair census (READ ONLY) and the repair manifest for agreement + legitimate approval (NOT executed)

**Date:** 2026-09-29 · **Census at** 2026-09-29T19:47:49Z · **Production project** `sokoni-aeb26` · **Read-only.** Packet: `docs/release-gates/kasindi-repair-census.json` (no raw PII; field names and states only). Digest over the full live records (application, `applicationDecisions/PRVMS7IACKG`, provider, user, seller, business, shop, Auth claims, wallet transactions):

```
c0b194f29dc33bf12960c97c3f359198fc645f2dd036b16c606bc97be84c2d1e
```

This digest identifies the state the manifest below was written against. It is **not** an authorization to write anything. Continues [[ADJUDICATION_KASINDI]]; the owner's target: *existing application → satisfy the missing approval prerequisites → fresh legitimate admin decision → audited approval → classification → correct routing*, with the July "reindex" state preserved as history, not laundered.

## 1 · Exact current state

| Record | State (observed) |
|---|---|
| `applications/PRVMS7IACKG` | exists; `uid` = provider uid ✔; `status` / `statusCanonical` **approved**; `decidedBy: "reindex"`, `decidedAt` 2026-07-30T15:11:12Z; `projectionStatus: applied`; **`agreementAccepted` absent**, `agreementVersion` absent, `agreementAcceptedAt` absent, `agreementVerifiedAt` absent; `role: provider` (resolved by keyword); `type` "Cleaning Company / Housekeeper", `category` "Service Provider", `hub` service |
| `applicationDecisions/PRVMS7IACKG` | **absent** — no server decision record has ever existed for this application |
| `providers/WLt0Voww…` | `status: active`, `approvedAt` 2026-07-30T15:13:13Z, **no `approvedBy`**, `sourceApplicationId: PRVMS7IACKG`, `searchable: true`, `isPublic: true`, **no `business` (C1) stamp**, not healthcare |
| `users/WLt0Voww…` | roles buyer + provider, `approved: true` |
| Auth | claims `{ provider: true }`; created 2026-07-21; last sign-in **2026-08-04** |
| `sellers/WLt0Voww…` | present, keys `branches`, `updatedAt` only — **not live** (no status, no approval); client-written 2026-07-28 |
| `businesses/` · `shops/` | absent · absent |
| `legalAcceptances` (uid) | **0** records — no versioned acceptance of any instrument |
| `adminAudit` | **0** for the uid, **0** for the application |
| Wallet | balance KES 50; one transaction `rcv_msdiiej6_83f5b95b` — `receive`, KES 50, `completed`, 2026-08-03T17:37:47Z |
| Activity | bookings 0 · services 0 · enquiries 0 · reviews 0 · orders 0 · products 0 |
| Capability read model | classification **SERVICES**, conflicts **none** — the model trusts `approvedAt` as protected evidence (the limit named in the adjudication); provider `live`, seller `present_not_live` |
| R2 resolver | **PENDING_CLASSIFICATION** (reason UNCLASSIFIED) — no category, no route |
| C1 derivation | `categoryFromApplication` → **null (`no-exact-match`)** for "Cleaning Company / Housekeeper". `cleaning` is a C1 category (services lane, not review-only), so it is reached only by an **admin** classification with a reason — not derived |

## 2 · What the repair path actually consists of — code, as deployed and as written

The owner's plan relies on "the existing AdminOS `applicationDecide` authority". There are **three** versions of it, and they differ on exactly the points that matter. Verified by downloading the source archives the deployed functions were built from (read-only):

| Enforcement | **Deployed `applicationDecide`** (rev `00006-kex`, archive 2026-08-24) | **Deployed `applicationLifecycle` trigger** (rev `00007-nox`, archive 2026-09-06) | **c4 line** (`functions/application-lifecycle.js`) |
|---|---|---|---|
| Seller Agreement gate (`agreementAccepted === true` before approve) | **absent** | n/a | present |
| Server decision record `applicationDecisions/{appId}` | not written | not consulted | written first, consulted by the trigger |
| `decisionAuthority` on the trigger | n/a | **claims-only**: `decidedBy` must be a **resolvable Auth uid holding `admin` or `superAdmin`**; otherwise projection is blocked and an `adminAlerts` record is written | server record + claims |
| `adminAudit` `application_approve` | written | — | written |
| Overwrites `applications.decidedBy` / `decidedAt` | **yes** | — | **yes** |

Consequences the manifest has to design around:

1. **The agreement prerequisite is NOT enforced by production.** If the owner approves Kasindi through the AdminOS UI today, the deployed callable approves without any acknowledgement. The prerequisite therefore has to be a **manifest gate verified by read** before the decision, not something the code is trusted to refuse.
2. **The decider must be a real admin account.** The deployed trigger resolves `decidedBy` through Auth. A tool label such as `admin-sdk:…` (the actor used for the k Riss *classification*, where no trigger is involved) would make the trigger **block the projection and raise an `adminAlerts` record**. The decision has to be made by (or as) an Auth account holding the admin claim — the owner names which.
3. **`decidedBy: "reindex"` cannot stay untouched by the existing authority.** Every version writes `decidedBy: <actor>` onto the same document. There is no `priorDecisions` field and the `adminAudit` record carries no `previous`. The owner's "July stays visible as history" is satisfiable only by (a) preserving it **outside** the document — this census packet + digest, the adjudication, and the audit `reason` text naming the July state — or (b) a small change to the c4 handler that appends the prior `{status, decidedBy, decidedAt}` to `priorDecisions` (arrayUnion) whenever it re-decides a document that already carries a decider, before overwriting. (b) makes the document itself tell the truth and is the recommendation; it is a code change on this line, not yet made.
4. **Re-approval re-projects the provider** (`projectProvider`): `status active`, `searchable/isPublic/available/acceptsBookings true`, contact fields from the application, **`approvedAt` refreshed to now**, `updatedAt`, `sourceApplicationId`; the `provider` role re-granted through the role authority (already held → no change). It does **not** write `approvedBy`. It does **not** touch `sellers/`, wallets, or the KES 50 transaction. The stray `sellers` record therefore survives — correctly; it belongs to the cleanup track, not to this repair.
5. **Two projections run.** Whoever makes the decision projects synchronously; the deployed trigger then re-projects on the document write. Both are idempotent merges. The second refreshes `approvedAt` a second time (seconds apart). Harmless, but the landing proof must expect it.

## 3 · The agreement prerequisite — how the business can acknowledge

- **Who may write it.** Only the business, signed in. Source rules: the applicant may update their own application under `noAdminFields() && noApplicationDecision() && classificationFrozenOnceDecided()`; `agreementAccepted`, `agreementVersion`, `agreementAcceptedAt` are in none of those lists, so the write is permitted on an approved application. The served ruleset (`6c67a34d`) is looser still (`isOwner && claimsOwner && noAdminFields`). An admin may not write it for them — it would fabricate consent.
- **What writes it today.** Only the intake forms, at **creation** (`hub-register.js`, `sokoni-merchant-application.js`; current `AGREEMENT_VERSION` = `2026-09-07-lanes-mkt-ladder-pos-5pct`). **No surface exists for re-acknowledging an existing application.** The canonical versioned path (`legalAccept` → `legalAcceptances`, eight provider instruments) exists, but the approve gate for a generic provider consults only the client boolean.
- **Options for the owner:** **(i)** a minimal re-acknowledgement surface for the signed-in applicant (writes the three fields with the current version and today's date — no backdating; needs a hosting deploy from the latest commit, or a one-off link the business opens); **(ii)** the business accepts the eight provider instruments through `legalAccept`, and the c4 gate is extended to honour `complianceFor(uid,'provider')` for generic providers as well as the boolean (a code change, then either local execution or a deploy); **(iii)** the business re-registers a fresh application through the live form (creates a second application — pending queue — and leaves PRVMS7IACKG as it is; not the owner's target). Kasindi last signed in on 2026-08-04, so every option requires reaching the business.

## 4 · Repair manifest (the exact sequence; nothing here has been executed)

**Gates, all re-verified by read immediately before each write, abort on any mismatch:**

| # | Gate | Observed now |
|---|---|---|
| G1 | `applications/PRVMS7IACKG` exists, `uid` matches, still `approved` by `"reindex"`, `applicationDecisions/` still absent | ✔ |
| G2 | `agreementAccepted === true`, `agreementVersion` = current, `agreementAcceptedAt` **≥ the day the business acknowledges** (never July) | ✘ — **blocks stage 2** |
| G3 | actor = an Auth uid holding `admin` or `superAdmin`, named by the owner | not chosen |
| G4 | deployed trigger still `applicationlifecycle-00007-nox` (claims-only authority) — re-describe before apply | ✔ |
| G5 | `adminAudit` for the uid/application still 0 (first legitimate decision, no duplicate) | ✔ |
| G6 | full-record digest equals the value the owner authorizes | `c0b194f2…2d1e` now |

**Stage 1 — agreement (business action, not ours).** One of §3 (i)/(ii) chosen by the owner; the business acknowledges the current version. Re-census → new digest → G2 ✔.

**Stage 2 — fresh decision (one write set, by the named admin).** Recommended vehicle: the **c4 `applicationDecide` handler**, invoked locally through `CallableFunction.run` (proven available, firebase-functions 7.2.5) with `auth.uid` = the owner-named admin account and `data = { applicationId: 'PRVMS7IACKG', decision: 'approve', reason: <owner text naming the July "reindex" state as historical and this as the first audited decision> }` — because it is the only version that enforces the agreement gate and writes the server decision record; with the `priorDecisions` preservation (§2·3b) added first if the owner accepts it. Alternative: the AdminOS UI (deployed callable) — same audit, no gate, no server record, no preservation. Writes, in order: `applicationDecisions/PRVMS7IACKG` (new), application patch (`status approved`, `decidedBy <admin>`, `decidedAt now`, `reviewReason`, `agreementVerifiedAt/Version`, `decisionAppliedFor` deleted), `adminAudit` `application_approve` (`applicationId`, `targetUid`, `performedBy <admin>`, `reason`, `createdAt`), then `projectProvider` (§2·4) and the role authority (no-op).

**Stage 3 — verify projection.** Provider `approvedAt` > decision time; application `decidedBy` = admin uid and `decisionAppliedFor: approved`, `projectionStatus: applied`; **no** `adminAlerts` `application_unauthorised_decision__PRVMS7IACKG`; `adminAudit` +1 exactly; `users`, wallet, KES 50 transaction, `sellers` record byte-identical; Auth claims unchanged (`provider`). The approval evidence now points to the September decision.

**Stage 4 — classification (separate manifest, separate authorization).** `scripts/classify-identity.js --plan` for uid → `cleaning`, reason stating that C1 derivation was `no-exact-match` and the category is the admin's reading of "Cleaning Company / Housekeeper". Same controls as [[MANIFEST_KRISS_ARTIST_CREATOR]]: plan digest → owner names it → apply → landing → second apply no-op.

**Stage 5 — resolver.** Expected: approval evidence → C1 `cleaning` → services lane → SERVICES → `provider-dashboard.html` → AVAILABLE, with the KES 50 transaction and every other historical record preserved.

**Preserved throughout (never written):** `wallets/`, `walletTransactions/`, `sellers/` (cleanup track), `users/` beyond what the role authority already holds, Auth claims, the July `decidedAt` value in this packet. **Not preserved by the existing authority:** the `decidedBy: "reindex"` field on the application document (§2·3).

## 5 · Decisions the owner must make before any write

1. Agreement route — §3 (i) or (ii).
2. The admin account that makes the decision (G3).
3. Whether to add the `priorDecisions` preservation to the c4 handler before using it (recommended), or accept packet-only preservation of the July state.
4. Vehicle — c4 handler run locally (gate + record + preservation) or AdminOS UI (deployed, no gate).

Nothing in this document was written to production. Related: [[ADJUDICATION_KASINDI]] · [[APPROVAL_DECISION_AUTHORITY]] (not the vehicle for Kasindi — it has an application) · [[R2_ROUTING_RESOLVER]] · [[CAPABILITY_AUTHORITY_READ_MODEL]]
