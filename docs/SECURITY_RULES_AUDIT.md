# Security rules audit — self-certifying ownership

**Date:** 2026-08-02 · **Status:** Phase 1 MEASURED. Triage not started. **Nothing fixed.**

Related: [[Landlord Rules Run]] · [[ADR-001]] · [[Access Control Matrix]]

---

## The class

Three landlord defects were found by assertions that happened to exist. The pattern —
**letting the client's own payload certify who owns the document** — is not landlord-specific.

## Measurement

**`firestore.rules`: 106 occurrences** of `request.resource.data.<field> == request.auth.uid`,
across **33 distinct field names**:

| count | field | | count | field |
|---:|---|---|---:|---|
| 46 | `uid` | | 4 | `createdBy` |
| 8 | `ownerUid` | | 4 | `buyerUid` |
| 6 | `sellerUid` | | 3 | `senderUid` |
| 5 | `ownerId` | | 2 | `userId`, `reportedBy`, `customerId`, `clientUid` |

Singles: `targetUid` `shopOwnerId` `sellerId` `riderId` `reviewerUid` `responderUid` `requestedByUid`
`requestedBy` `reporterUid` `providerUid` `organizerUid` `hostUid` `gymUid` `freelancerUid` `flaggedBy`
`employerUid` `driverUid` `buyerId` `businessId` `authorUid` `askerUid` `applicantUid`

**`functions/`: 25 occurrences** of an owner id read from the client payload — `data.uid` (21),
`data.sellerUid` (2), `data.providerId` (2).

## **106 is the population to triage, NOT the vulnerability count**

This distinction matters and must survive into the fix work.

**Legitimate.** On a top-level collection, `request.resource.data.uid == request.auth.uid` on
**create** is the correct pattern — it stamps the creator and prevents writing a document as someone
else. That is authority *constraining* the payload.

**Vulnerable.** The same expression is a hole when it is the *only* check on an operation whose
authority belongs to a **parent document** — the landlord case. Landlord B writes their own uid onto a
unit and the rule agrees, because it never asks who owns the building.

So the triage question per occurrence is not "does it compare to `auth.uid`" but:

> **Is there a parent or pre-existing document whose ownership should decide this, and does the rule
> consult it?**

## Triage vocabulary (Phase 6)

`Canonical` · `Redundant` · `Dangerous` · `Dead`

## Next

1. Fix the two confirmed holes (`units`, `ledger` create) via parent `get()`.
2. Add assertions for missing / deleted / unreadable parent.
3. Triage the 106 against the question above; only `Dangerous` needs a rule change.
4. Then `FUNCTION_AUTH_AUDIT.md` for the 25 function-side occurrences.

**No feature work during this programme.**

---

## Classification taxonomy (founder, 2026-08-02)

**The criterion is who is AUTHORITATIVE for the resource — not whether a rule compares a field to
`request.auth.uid`.**

| Category | Example | Action |
|---|---|---|
| **SAFE** | `users/{uid}/preferences`, create, `data.uid == auth.uid` | none |
| **PARENT-AUTHORITY** | unit→building, service→provider, vehicle→rider | verify parent ownership (server-side, or `get()` where appropriate) |
| **SERVER-OWNED** | settlements, wallets, commissions, payouts, audit logs | client may not write ownership fields at all |
| **IMMUTABLE OWNERSHIP** | any document that already has an owner | owner cannot change after creation; compare against `resource.data.ownerUid`, never client input |
| **DEAD** | no reader, no writer | delete |

Only the last four require changes. **SAFE requires no change, and "fixing" it would add a document
read to every create on the platform while breaking legitimate top-level ownership.**

### The category most likely to be missed: IMMUTABLE OWNERSHIP

A rule can be **correct on create and still permit ownership transfer on update**. If an `update`
branch validates `request.resource.data.ownerUid == request.auth.uid` rather than
`resource.data.ownerUid == request.auth.uid`, the current owner is never consulted — so a document can
be *taken over* by anyone permitted to update it.

This is a **different hole from the landlord parent-authority one**, and the landlord suite would not
catch it: those assertions test who may create, not whether an owner can be swapped. Triage must read
`resource.` versus `request.resource.` on every update branch, not only creates.

## Phases

- **2A — Triage before fixes.** Classify all 106; produce a path → category → action matrix.
- **2B — Fix confirmed holes.** The two self-certification defects, plus new assertions: forged owner ·
  deleted parent · unreadable parent · cross-tenant write. Existing assertions must still pass.
- **3 — Convergence.** Remaining occurrences by classification, evidence-driven.

## Release gate — before Rider Convergence or any feature work

1. Confirmed authorization defects fixed.
2. Authorization regression suite green.
3. All 106 occurrences classified.
4. Every `Dangerous` occurrence remediated.
5. Classification rationale documented.

---

## Update-branch audit table

`request.resource` (the incoming payload) and `resource` (the stored document) are **not
interchangeable**. One character of difference, opposite security meaning.

| Update pattern | Verdict |
|---|---|
| `resource.data.ownerUid == request.auth.uid` | ✅ correct — the **existing** owner authorizes |
| `request.resource.data.ownerUid == request.auth.uid` | 🚩 **review** — can permit ownership takeover if ownership is mutable |
| `resource.data.ownerUid == request.resource.data.ownerUid` enforced | ✅ ownership immutable |
| ownership field absent from the update allowlist | ✅ **preferred** where ownership never changes |

The fourth row is the strongest form: if `ownerUid` is simply not in the `hasOnly()` list, ownership
cannot be written at all and no comparison is needed.

### Measuring the 🚩 population needs block-aware parsing, not a grep

A regex cannot tell whether an occurrence sits inside `allow create` or `allow update` — the two have
opposite correctness. The 106 figure is create-and-update combined. **Splitting it requires walking
the rule blocks**, and reporting a grep count as the update population would be a misleading number of
exactly the kind this audit exists to avoid.

## Regression category: OWNERSHIP IMMUTABILITY

Complements the parent-authority tests rather than overlapping them — the landlord suite asserts who
may **create**, never whether an owner can be **swapped**. For every resource classified
IMMUTABLE OWNERSHIP:

1. User A creates the resource.
2. **A attempts to change `ownerUid` → must FAIL.**
3. **B attempts to change `ownerUid` → must FAIL.**
4. B attempts to update other fields → must FAIL unless explicitly authorized.
5. A updates permitted non-owner fields → must SUCCEED.
6. **`ownerUid` is unchanged after every update above.**

Step 6 is the one that catches a silent transfer: steps 2–5 can all behave correctly while an
ownership field still drifts through an allowed write.

## Programme

1. **Measure** — complete (106 rules · 25 functions).
2. **Classify** — taxonomy complete; matrix not yet produced.
3. **Fix confirmed defects** — the two self-certification holes, with expanded assertions.
4. **Audit update branches** — ownership must not be silently transferable.
5. **Triage** the remaining occurrences by category.
6. **Remediate** only the genuinely dangerous.
7. **Full regression green** before any feature work resumes.
