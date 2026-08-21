# Users Document Integrity — the "83 users" question

> **Status:** census COMPLETE · reconciliation **BLOCKED on Admin SDK credentials**
> **Do not change the Admin dashboard number yet.** Establish what it represents first.

Related: [[Authentication]] · [[Access Control Matrix]] · [[Admin Console Integrity]] · [[ODPC Compliance]]

---

## The claim under examination

The Admin dashboard reports **83 Total Users**. Firebase Authentication is believed to hold
fewer than 20 accounts.

These are not the same measurement, so the gap is a **question, not yet a defect**:

```
a Firestore users document   ≠   a Firebase Auth account
```

The dashboard figure comes from:

```
functions/admin-os.js:443    db.collection('users').count().get()
      ↓ adminGetOverview → adminGetExecutiveDashboard
admin.html:5367              "Total Users"
```

That counts **documents in `users/`**. Nothing in that path consults Firebase Authentication.

---

## The mechanism that can inflate it

```
set(ref, data, { merge: true })    CREATES the document when it does not exist
update(ref, data)                  FAILS when it does not exist
```

Every `set(..., {merge:true})` against `users/{uid}` is therefore a path that can mint a
**stub** — a document holding only the fields that writer happened to touch, for a uid that may
never have signed up. `update()` cannot do this.

---

## Census result

`scripts/census-users-doc-writers.js` — artifact at `docs/users-writers-census.json`

| measure | count |
|---|---|
| write sites found | 78 |
| **can create** a document (`set`) | **39** |
| of those, `set` + `merge:true` | 35 |
| narrow (≤4 keys) — most likely to mint a stub | **25** |
| opaque payload (variable; width unknown) | 3 |
| excluded — `scripts/` harnesses & migrations | 26 |

Production writers concentrate in `functions/index.js` (8), then `auth.js`, `firebase.js`,
`functions/account-status.js`, `functions/sub-billing.js` (3 each).

### The narrow writers, and the document each would leave behind

| writer | fields it would leave |
|---|---|
| `functions/booking-payment-sweep.js:53` | `walletBalance` |
| `functions/index.js:4720` | `lastSeen` |
| `functions/invitations-core.js:319` | `updatedAt` |
| `functions/index.js:220`, `:4693` | `roles` |
| `functions/index.js:139` | `role`, `adminGrantedAt` |
| `functions/super-admin.js:110` | `role`, `roleUpdatedAt` |
| `functions/wallet-engine.js:704` | `phoneNumber`, `phoneVerifiedAt` |
| `functions/age-verification.js:79` | `ageVerified`, `ageVerifiedAt`, `ageVerifiedMethod` |
| `auth.js:379` | `googleLinked`, `googleLinkedAt` |
| `auth.js:1608` | `linkedProviders`, `linkedAt` |
| `firebase.js:877` | `fcmToken`, `fcmPlatform`, `fcmUpdatedAt` |
| `functions/sub-billing.js:331` | `tier`, `features`, `expiresAt`, `updatedAt` |

A document whose entire field set is covered by one row above is **attributable to that writer**.
That is how the reconciler assigns provenance rather than guessing.

---

## Reconciliation — built, not yet run

`scripts/reconcile-users-vs-auth.js` classifies every `users/{uid}` as:

```
AUTH MATCH        uid resolves to a Firebase Auth account
ORPHAN            uid does not resolve, and the document looks like a stub
EXPECTED SYSTEM   a known non-account document (allowlist — currently EMPTY)
UNCLASSIFIED      everything else — NOT a synonym for orphan
```

`UNCLASSIFIED` exists so the report cannot quietly round uncertainty down into a category that
invites deletion. **A document nobody can explain is a document nobody should delete.**

The allowlist is empty on purpose. Nothing in the repo demonstrably creates a `users/` document
for a non-account purpose, and widening the list to make a report look tidy would relabel
unknowns as expected.

The script is **read-only**. It has no delete path and no flag that would add one.

### Why it has not run

It enumerates Firebase Authentication, which needs the Admin SDK. Without credentials it
**exits non-zero** and reports what is missing. It does not sample, estimate, or fall back to the
client SDK.

```
GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/reconcile-users-vs-auth.js
```

**Until someone runs it, the Auth-side count is UNPROVEN** and "83" remains a document count with
nothing to compare it against.

---

## Two adjacent defects, recorded not fixed

Both are instances of the standing no-fabricated-metrics rule and are **out of scope** for this
slice:

1. `functions/admin-os.js:443` wraps the count in `.catch(() => ({ data: () => ({ count: 0 }) }))`.
   A failed read renders as a confident **0**.
2. `admin.html:5367` renders `(d.totalUsers || 0)`. An absent value renders as **0**, not `—`.

An unknown displayed as `0` is a defect; a canonical `0` is fine.

---

## What must not happen next

- Do **not** change the dashboard number to match Auth. The number is not wrong about what it
  measures; the **label** is what overstates it.
- Do **not** delete any document on the strength of this census. It establishes which code *can*
  create a stub, not which live documents *are* one.
- Do **not** treat `UNCLASSIFIED` as a soft `ORPHAN`.
