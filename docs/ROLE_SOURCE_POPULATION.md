# Role-Source Population — which promotion path writes which field

> **Status:** consumer half DONE · writer half DONE · **runtime half BLOCKED**
> Read-only census. **No role vocabulary renamed or normalised.**

Related: [[Access Control Matrix]] · [[Authentication]] · [[Admin Console Integrity]] · [[Users Document Integrity]]

---

## Three sources, deliberately kept apart

```
users/{uid}.role     singular Firestore field
users/{uid}.roles    Firestore ARRAY — a different field
claims.role          a CUSTOM CLAIM — not Firestore at all
```

Treating `role` and `roles` as one thing, or a claim as a document field, is what makes this class
of bug invisible.

---

## The finding

`setUserRole` is the canonical role setter. Both of its payloads are **object literals** — nothing
inferred, nothing spread:

```
claims     { admin, superAdmin, seller, driver, moderator, buyer }   ← no `role` claim
firestore  { role, roleUpdatedAt }                                    ← no `roles` array
```

The consumer half (`77e7928`) found nine reader sites:

```
7 read  users/{uid}.roles     ← setUserRole never writes it
2 read  claims.role           ← setUserRole never writes it
```

**An account promoted through `setUserRole` satisfies none of the nine.** Every one of those
checks fails closed for such an account — a functional defect, not a security one, but a real one.

---

## The matrix

23 production promotion paths touch a role source.

| path | `role` | `roles[]` | `claims.role` | other claims |
|---|:--:|:--:|:--:|---|
| `functions/super-admin.js` `setUserRole()` | ✔ | — | — | admin, superAdmin, seller, driver, moderator |
| `functions/index.js` `bootstrapAdminClaim()` | ✔ | — | **✔** | admin, superAdmin |
| `functions/index.js` `grantAdminClaim()` | ✔ | **✔** | — | admin |
| `functions/index.js` `revokeAdminClaim()` | — | ✔ | — | — |
| `functions/index.js` `revokePlatformRole()` | — | ✔ | — | — |
| `functions/admin-os.js` `adminUpdateUserRole()` | ✔ | — | — | *(partial)* |
| `functions/wap.js` `wapSaveDefinition()` | ✔ | — | — | — |
| `sokoni-wap-definitions.js` *(module scope)* | ✔ | — | — | — |
| 15 further paths | — | — | — | provider, platformEmployee, suspended, … |

```
paths populating users/{uid}.role     6
paths populating users/{uid}.roles    3     ← 7 consumers read this
paths populating claims.role          1     ← 2 consumers read this
```

**`bootstrapAdminClaim` is the only path that writes `claims.role`.** So
`functions/delivery-authority.js` and `functions/pos-integrations-api.js` — the two `claims.role`
readers — can only ever recognise the bootstrap account.

**Two promotion paths produce differently-shaped accounts.** An admin granted via
`grantAdminClaim` has a `roles[]` array; one promoted via `setUserRole` does not. Same role, two
account shapes, and which one you get depends on which button an operator pressed.

---

## What is not established

20 of the 29 writer payloads are **PARTIAL** — they spread another object
(`{...existingClaims, …}`). `setCustomUserClaims` **replaces** the whole claim set, so the spread
contents matter, and they cannot be known statically. They are reported as PARTIAL, never rounded
down to "writes nothing".

**Which path a given real account went through is history, not source.** The runtime half stays
open, and it is the only half that can say how many live accounts are affected.

---

## What must not happen next

- Do **not** normalise the role vocabulary globally. The consumer census (`77e7928`) found 17
  dormant lowercase comparisons that currently fail closed; a rename would convert them into live
  authorization behaviour in one commit.
- Do **not** "fix" `setUserRole` to also write `roles[]` and `claims.role` before deciding which
  source is canonical. That would make three sources agree by writing all three — entrenching the
  duplication rather than removing it.
- Do **not** infer a PARTIAL payload's contents.

The decision this census enables is **which of the three sources is authoritative**, after which
the other two become derived — or are removed.
