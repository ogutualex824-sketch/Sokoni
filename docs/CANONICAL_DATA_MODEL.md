# Canonical data model

**Date:** 2026-08-02 · **Status:** specification. **Nothing has been migrated.**
**Evidence:** `node functions/scripts/probe-canonical-fields.js` — every percentage below is measured
against production, not inferred from source.

Related: [[ADR-009 Canonical Field Representation]] · [[Properties Data Source]] · [[Landlord Property Model]] · [[Admin LocalStorage Inventory]]

---

## Why measure rather than read

Every duplicated field found in this programme had a **coverage split that changed the
recommendation**. `phone` looked like the obvious field name and covers 5% of users; `phoneNumber`
covers 75%. Choosing by intuition would have written a canonical model that describes almost none of
the data.

---

## 1. Identity

| collection | representations (measured) |
|---|---|
| `users` | `uid` 72% · `sellerId` 2% |
| `applications` | `uid` 100% |
| `providers` | **`uid` 100% AND `providerId` 100%** — both on every document |
| `sellers` | `uid` 60% |
| `platformEmployees`, `invitations` | `uid` 100% |
| `notifications` | **`userId` 100%** |
| `auditLogs` | `uid` 50% |

**Canonical: `uid`** for the subject of a document, and a **role-qualified uid** for a relationship —
`ownerUid`, `hostUid`, `tenantUid`, `sellerId`, `providerId` — where the document needs to say *which*
party it means.

`providers` carrying both `uid` and `providerId` on 100% of documents is pure duplication: they hold
the same value. **Canonical: `uid`**; `providerId` is a compatibility alias to be dropped once readers
are checked.

`notifications.userId` should be `uid`. Low risk — one collection, one meaning.

**Do not "simplify" the role-qualified names into `uid`.** `landlordProperties/units.ownerUid` and
`.tenantUid` are different people on the same document; collapsing them would be a security defect, and
the rules depend on the distinction.

## 2. Role — **four representations, and it is the worst case**

Measured on `users` (61 documents):

| field | coverage |
|---|---|
| **`roles[]`** | **97%** |
| `registeredAs` | 97% |
| `role` (string) | 13% |
| `accountType` | 13% |

`sellers` adds `accountType` at 60%. `applications` carries **`role` and `type` on 100%** of documents
— both, always. **Two documents in `users` carry neither `roles` nor `role`.**

**Canonical: `roles[]`** — an array, because SOKONI identities are genuinely multi-role (a seller who
is also a buyer, a provider who is also a landlord). A single string cannot express that and is why
`registeredAs` grew alongside it.

| representation | disposition |
|---|---|
| `roles[]` | **canonical** |
| `registeredAs.{role}: true` | equivalent map form — **fold into `roles[]`**, keep the read path during migration |
| `role` (string) | **legacy** — read-only compatibility, never written again |
| `accountType` | **legacy** — same |
| `applications.type` | **distinct meaning**: the *application kind*. Rename to `applicationType`, do not fold into role |

**Admin authority is NOT in this model.** `admin` / `superAdmin` live in Firebase custom claims and
nowhere else — see ADR-001. Never add an admin value to `roles[]`.

**Migration:** dual-read now (already done in the Users pane — it reads both `roles[]` and `role`,
because either alone hides real accounts), then converge writes onto `roles[]`, then backfill the two
role-less documents, then drop the legacy readers.

## 3. Phone

| collection | `phone` | `phoneNumber` |
|---|---|---|
| `users` | 5% | **75%** |
| `applications` | 100% | 100% |
| `providers` | 80% | 80% |
| `sellers` | 60% | 60% |
| `payments` | 100% | — |

**Canonical: `phoneNumber`, E.164 (`+2547…`)** — measured majority on `users`, and the existing
`_findUserByPhone` helper already depends on that format. `phone` holds the local `07…` form in places,
so a naive rename would corrupt values: **normalise, do not just copy.**

## 4. Timestamps

| collection | created field |
|---|---|
| `users`, `providers`, `sellers`, `payments`, `notifications` | `createdAt` |
| `applications` | **`createdAt` AND `submittedAt`, both 100%** |
| `auditLogs` | **`ts`** |
| `users.joined` | **0% — does not exist** |

**Canonical: `createdAt` / `updatedAt`, Firestore `Timestamp`, server-generated.**

`applications.submittedAt` is a duplicate of `createdAt` — drop it. `auditLogs.ts` is a Unix number
written by the client audit helper, which the `auditLogs` rule requires (`hasAll(['uid','action','ts'])`)
— **changing it means changing the rule**, so it stays until that is done deliberately.

**`updatedAt` coverage is the operational risk, not the naming.** It is 21% on `users` and 25% on
`invitations`. **Firestore omits documents that lack the ordering field**, so `orderBy('updatedAt')`
silently hides most of the collection — measured: 13 of 61 users. Every listener written in this
programme deliberately avoids server-side ordering for exactly this reason. **Backfill `updatedAt`
before any query orders by it.**

## 5. Status — **vocabularies do not agree, and one is a different case**

| collection | values |
|---|---|
| `users`, `providers`, `products`, `sellers` | `active` |
| `applications` | `approved`, `pending` |
| `invitations` | `queued`, `sent` |
| **`payments`** | **`COMPLETE`, `FAILED`, `PENDING`** |

`payments` is **UPPERCASE** while everything else is lowercase. Any code comparing status across
subsystems without normalising is wrong today.

**Canonical: lowercase `snake_case`, and a vocabulary per *lifecycle*, not one global enum.** A
payment is not a listing and forcing them to share words would lose meaning.

| lifecycle | canonical vocabulary |
|---|---|
| moderation (applications, listings, providers) | `pending` · `approved` · `rejected` · `suspended` |
| publication (products, listings) | `draft` · `active` · `archived` |
| payment | `pending` · `complete` · `failed` · `refunded` |
| delivery (invitations, email) | `queued` · `sent` · `delivered` · `failed` |
| ledger | `pending` · `paid` · `overdue` · `refunded` |

**`payments` needs a case migration, and it is the only one that is a live correctness risk**: a
comparison against `'complete'` fails silently against `COMPLETE`. Dual-read first.

`applications.projectionStatus` (50%) is **not** a status duplicate — it records whether the approval
reached its registry, which is a genuinely separate fact and the thing that made approved-but-invisible
providers detectable. **Keep it.**

## 6. Verified

| collection | representation |
|---|---|
| `users` | `verified` 2% · `verificationStatus` 7% |
| `providers`, `sellers` | `verified` 60–80% |
| `products` | `verificationStatus` 10% |

**Canonical: `verified: boolean`** for the fact, plus `verifiedAt` and `verifiedBy` for the audit trail.
`verificationStatus` (a string) is really a *moderation lifecycle* and belongs in `status` — keeping
both invites the two to disagree about the same entity.

## 7. Location — **the worst-covered concept**

| collection | fields |
|---|---|
| `users` | `location` 2% · **`city` 0%** |
| `applications` | `city`, `location`, `area` — all 100% |
| `providers` | `city` 40% · `location` 40% · `area` 40% · `county` 20% |
| `products` | `location` 100% |

**`city` does not exist on any user document.** The admin Users pane renders a City column that is
structurally always empty — reported in the Users migration and still true.

**Canonical: a single `location` map**, not four flat fields:

```
location: { county, city, area, address, geo: { lat, lng } }
```

Kenya's administrative unit is the **county** — the applications lifecycle already splits 47 counties —
so `county` is the queryable field and `city` is display text within it. Four sibling fields at 40%
coverage each cannot be filtered on reliably; one map with a defined shape can.

## 8. Names

`users`: `name` 97% · `displayName` 15% · `businessName` 5%. `providers`/`sellers`: `name` and
`businessName` both present.

**Canonical: `name`** for the entity's own display name; **`businessName`** kept where it is a
genuinely different fact (a person's name vs their trading name). `displayName` is Firebase Auth's
field — **do not copy it into Firestore**; read it from the token when needed.

## 9. Ownership fields — already correct, recorded so they are not "unified"

| field | meaning |
|---|---|
| `ownerUid` | `landlordProperties`, and its `units`/`ledger` — denormalised for rules performance, **immutable** |
| `hostUid` | `bnbListings` — the host of a short-stay listing |
| `tenantUid` | `landlordProperties/units` — the occupant, **not** the owner |
| `sellerId` / `providerId` | the merchant or provider a record belongs to |

These are **deliberately distinct** and must not be collapsed into `uid`. `ownerUid` and `tenantUid`
appear on the same document and mean different people; the rules depend on telling them apart.

## 10. Entities and their authorities

| entity | authority | notes |
|---|---|---|
| Identity | **Firebase Auth** | the account; profile data is a projection |
| Admin authority | **custom claims** | ADR-001 — never Firestore, never `roles[]` |
| Users | `users/{uid}` | migrated 2026-08-01 |
| Applications | `applications/{id}` | REQUEST; registries are TRUTH |
| Providers | `providers/{uid}` | registry projected from an approved application |
| Orders | `orders` | migrated 2026-08-01 |
| Bookings (BnB) | `bnbBookings` | commit point for every downstream side effect — ADR-005 |
| Properties (BnB) | `bnbListings` | migrated 2026-08-01 |
| Landlord | `landlordProperties` → `units` → `ledger` | ADR-006; rules deployed, **implementation blocked on rule tests** |
| Commission | commission engine | **still localStorage in admin — highest-priority migration** |
| Ledger | `landlordProperties/…/ledger` | paid entries immutable to the landlord |
| Payments | `posPayments`, `orphanPayments` | server-written by the STK callback |
| Settlement | settlement engine | canonical MoR |
| Notifications | `notifications` | `userId` → should be `uid` |

## Migration principles

1. **Dual-read before converging writes.** Reading both representations hides nothing; writing one too
   early loses the other. The Users pane already does this for `roles[]`/`role`.
2. **Normalise, never rename, where formats differ.** `phone` → `phoneNumber` must convert `07…` to
   `+2547…`.
3. **Backfill before ordering.** `orderBy` on a partially-present field silently drops documents.
4. **One field per commit,** with a measured before/after coverage count.
5. **Nothing here is migrated by this document.** It is the specification the migrations will be
   checked against.

## Priority

**Financial first**, consistent with the localStorage backlog: `payments` status case (a live
comparison bug), then commission and ledger keys out of localStorage. Then approval-bearing fields
(`roles[]`, `verified`), then `location`, then cosmetic naming.
