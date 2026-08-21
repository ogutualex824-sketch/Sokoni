# users/{uid} ↔ Firebase Auth — reconciliation result

> **Run 2026-08-22 against production `sokoni-aeb26`.** Read-only; nothing written or deleted.
> Credential: **Application Default Credentials (`authorized_user`)** — a personal gcloud
> login, not a service account. Recorded because the identity matters to the record.
> Artifact: `docs/users-reconciliation.json` · Scanner: `scripts/reconcile-users-vs-auth.js`

Related: [[Users Document Integrity]] · [[Role Source Population]] · [[ODPC Compliance]]

---

## The premise was inverted

```
Firebase Auth accounts     103      enumerated, not estimated
Firestore users documents   82
difference                 −21
```

The question was opened as *"83 Firestore documents against fewer than 20 Auth accounts"* —
i.e. a suspicion of ~63 fabricated user records.

**There are more Auth accounts than documents.** Twenty-one authenticated accounts have **no**
`users/{uid}` document at all. And the document count is **82**, not 83.

So the dashboard's "Total Users" was not inflated by orphan documents. If anything it
**understates** the number of real accounts.

---

## Classification

| class | count |
|---|---:|
| **AUTH MATCH** — uid resolves to an Auth account | **71** |
| **ORPHAN** — no Auth account, looks like a stub | **8** |
| **UNCLASSIFIED** — cannot be explained | **3** |
| EXPECTED SYSTEM | 0 |

71 + 8 + 3 = 82. ✔

### The 8 orphans

Six carry an obviously synthetic id — `zzz_annual`, `zzz_diag_merchant`,
`zzz_release_verify_synthetic`, `zzz_skew_1`, `zzz_skew_2` and one more — and a field set of
`{activatedAt, activatedBy, automationProcessed, status, subscription.seller}`. These are
seeded diagnostics, not user records.

Two carry real-looking uids with `{activatedAt, activatedBy, automationProcessed, lastSeen,
status}`. **No writer signature covers that field set**, so the census cannot say which path
created them. They are NOT attributed, and that is the honest answer.

### The 3 UNCLASSIFIED — the one genuinely concerning finding

```
{_baselineVersion, accountStatus, activatedAt, activatedBy, automationProcessed,
 createdAt, email, lastLogin, name, onboardingCompleted, onboardingRequired,
 phoneNumber, photoURL, registeredAs, roles, status, uid}
```

All three carry a **complete identity record — email, phone number, name, photo** — for a uid
that **no longer exists in Firebase Auth**.

That is not a stub. It is the residue of a real person whose Auth account is gone while their
personal data remains in Firestore. **This belongs to the ODPC erasure question, not to the
dashboard-count question**, and it is the reason UNCLASSIFIED exists as a separate class: had
these been folded into ORPHAN they would have been one step from deletion, when what they
actually need is a data-protection decision.

**Do not delete them on the strength of this census.** Whether the Auth account was deleted
deliberately, and whether an erasure obligation was already discharged, is not visible here.

---

## Role shapes, across the 71 matched accounts

```
grantAdminClaim-shaped    8
unknown-shape            63
setUserRole-shaped        0
```

**No account in production has the `setUserRole` shape.** The concern that a
`setUserRole`-shaped Super Admin would satisfy zero of the nine role consumers does not
manifest — there are none.

### The 3 elevated accounts

| uid | claims | `users.role` | `users.roles` | strict `roles[]` (5) | fallback (2) | `claims.role` (2) |
|---|---|---|---|:--:|:--:|:--:|
| `D5Ql2…P83` | admin, superAdmin, seller, driver | *(absent)* | `[buyer, rider, seller, driver]` | ✔ | ✔ | ✘ |
| `uwpD5…ch2` | admin, superAdmin | `admin` | `[buyer, business]` | ✔ | ✔ | ✘ |
| `zPYdn…bo2` | admin | *(absent)* | `[buyer]` | ✔ | ✔ | ✘ |

**Elevated accounts satisfying no consumer group at all: 0 of 3.** Every administrator is
visible to the seven `roles[]` consumers.

**None satisfies the two `claims.role` consumers** — `delivery-authority.js` and
`pos-integrations-api.js`. So those two checks are dead for every administrator in production,
exactly as the writer census predicted.

### `claims.role = 5`

`D5Ql2…P83` carries `claims.role` as the **number 5**, not a string. Both consumers compare it
to `'admin'` / `'superadmin'`, and a number can never equal either. This is a numeric role
*level* from the zero-trust vocabulary sharing a key name with the string role. **Recorded, not
changed** — it is the same class of vocabulary collision as the lowercase `superadmin` census,
and a blind normalisation would be the wrong move.

---

## What this settles, and what it does not

**Settled**

- The dashboard count is not inflated by fabricated records. It undercounts real accounts.
- No `setUserRole`-shaped account exists, so that predicted failure is theoretical.
- No administrator is invisible to the `roles[]` consumers.
- The two `claims.role` consumers are dead for every administrator.

**Not settled**

- Which path created the 2 unattributed orphans.
- Whether the 21 Auth-accounts-without-documents is expected (a signup that never completed
  its profile write) or a defect.
- Whether the 3 UNCLASSIFIED records represent an unmet erasure obligation.

**Do not change the dashboard yet.** It now looks like the *label* is wrong rather than the
number — it counts documents and calls them users, while the real account count is higher.
