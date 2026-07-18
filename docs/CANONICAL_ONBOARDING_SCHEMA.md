# Canonical Onboarding Schema

**Discovered 2026-07-19 by tracing every production write path in the codebase.**
Nothing here was invented. Every field below is written by code that already ships.

> **Why this document exists.** Five separate attempts to build merchant tooling stalled on
> "what shape is a merchant?" The Firestore collections are empty in production, which made
> the schema look absent. It is not absent — it is defined by the code that writes it. This
> is that definition, with file:line citations so it can be re-verified rather than trusted.

---

## 1. `users/{uid}` — the root identity document

**Written by:** `firebase.js:535` (self-registration, all providers) · `functions/index.js:145`
(admin claim grant) · `functions/account-manager.js:52` (deletion scheduling) ·
`auth.js:616` (role selection).

**Created on first successful authentication**, for every provider — email, Google, Facebook,
phone. There is no separate "create user" step.

| Field | Type | Source | Notes |
|---|---|---|---|
| `uid` | string | `firebase.js:512` | matches the doc id; rules enforce it never changes |
| `name` | string | `:513` | displayName, else email local-part, else `"User"` |
| `email` | string \| null | `:514` | null for phone-only accounts |
| `phoneNumber` | string \| null | `:515` | |
| `registeredAs` | map | `:516` | **the role map** — see §2 |
| `roles` | array | `:517` | `["buyer"]` at creation |
| `accountStatus` | string | `:518` | `"active"` · `"pending_deletion"` (`account-manager.js:56`) |
| `onboardingCompleted` | bool | `:519` | **`false` at creation** |
| `onboardingRequired` | bool | `:520` | **`true` at creation** |
| `referralCode` | string | `:521` | |
| `referredBy` | string \| null | `:522` | |
| `firstReferralOrderDone` | bool | `:523` | |
| `joinedAt` | string | `:524` | human-readable, en-KE |
| `joinedTimestamp` | number | `:525` | epoch ms |
| `provider` | string | `:526` | `google` · `facebook` · `phone` · `email` |
| `providers` | array | `:527` | grows on cross-provider linking |
| `photoURL` | string | `:528` | |
| `emailVerified` | bool | `:529` | true for phone sign-in |
| `firstName` / `lastName` | string | `:530-533` | Google and Facebook only |
| `createdAt` | serverTimestamp | `:536` | |
| `lastLogin` | serverTimestamp | `:537` | |
| `role` | string | `functions/index.js:146` | **admin path only** — `"admin"` |
| `adminGrantedAt` | serverTimestamp | `functions/index.js:146` | |
| `deletionScheduledAt` / `deletionReason` / `deletionRequestedAt` | — | `account-manager.js:52` | 30-day grace |

**`onboardingCompleted: false` + `onboardingRequired: true` is the canonical "invited but not
activated" state.** An admin invitation does not need a new status vocabulary — this pair
already expresses it, and the UI already routes on it.

---

## 2. `registeredAs` — the role map

**Written by:** `auth.js:600-605`. Verticals are booleans on one map, not separate documents.

```
registeredAs: {
  user:       true,     // firebase.js:516 — always set at creation
  seller:     true,     // auth.js:600   -> seller.html
  healthcare: true,     // auth.js:601   -> healthcare.html
  driver:     true,     // auth.js:602   -> driver.html
  delivery:   true,     // auth.js:603   -> onboarding-driver.html
  landlord:   true,     // auth.js:604   -> landlord.html
  legal:      true,     // auth.js:605   -> provider.html?cat=legal
}
```

Post-selection routing is `auth.js:625-640`. **An admin invitation for a merchant sets
`registeredAs.seller = true`** — the same field the self-service path writes.

---

## 3. `applications/{appId}` — vertical onboarding submissions

**Written by:** `hub-register.js:277` (`addDoc`), shape built at `hub-register.js:359-376`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | `"APP" + Date.now()` |
| `name`, `phone`, `email`, `location`, `description` | string | operator-supplied |
| `category` | string | one of 103 categories |
| `categoryLabel` | string | display label |
| `hub` | string | vertical the category belongs to |
| `plan` | string | subscription tier |
| `status` | string | **`"pending"`** |
| `type` | string | `"business"` |
| `uid` | string | owning user |
| `submittedAt` | ISO string | |
| `createdAt` | number | epoch ms |

**Rules:** `firestore.rules:107-109` — `create: claimsOwner()`, `read: isAdmin() || isOwner()`.
Moderation is `status`, on this document. **There is no separate moderation collection.**

---

## 4. Ancillary records created at first login

**Written by:** `firebase.js:548+` (fire-and-forget, non-fatal).

- `wallets/{uid}` — `{ uid, balance: 0, … }`, created only if absent
- notification preferences — same block

---

## 5. Merchant profile fields — the one partial area

The single live merchant (`users/pfcL6QTr…`) carries seven additional fields:

```
businessName, category, merchantSlug, accountStatus, featured, searchIndexed, mechanicId
```

These live **on `users/{uid}`**, not a separate collection. `mechanicId` is vertical-specific;
the retail equivalent is **not yet evidenced in code**.

> **This is the only genuine gap.** Everything above is written by shipping code. The
> retail-merchant field name must be read from what merchant onboarding actually writes on
> first real completion — not chosen by me. Until then, an admin invitation should write
> only §1 and §2, which are fully canonical, and let the merchant onboarding UI add its own
> fields exactly as it does for self-registration.

---

## 6. Security rules

`firestore.rules:91-105`:

- `create` — self only, plus `noAdminFields()`, `noPrivilegeEscalation()`, `noProviderForgery()`
- `update` — admin, or self with `uidUnchanged()` and the same three guards
- `delete` — admin only

**An admin invitation must therefore write `users/{uid}` from a Cloud Function** using the
Admin SDK. Client-side admin creation is blocked by `request.auth.uid == userId` — correctly.

---

## 7. What an admin invitation must create

Derived from the above. **No new collections required.**

| Step | Target | Basis |
|---|---|---|
| 1 | Firebase Auth account (create or reuse) | Admin SDK |
| 2 | `users/{uid}` with §1 fields, `onboardingCompleted:false`, `onboardingRequired:true` | §1 |
| 3 | `registeredAs.<vertical> = true` | §2 |
| 4 | `wallets/{uid}` zero balance | §4 |
| 5 | `invitations/{id}` — **the only new collection** | §8 |
| 6 | `emailQueue` document | existing pipeline |
| 7 | `auditLog` entry | `account-manager.js:60` pattern |

---

## 8. `invitations/{id}` — the one new collection

Justified because no existing collection records invitation state. Modelled on
`applications` (status-on-document) rather than a parallel moderation store.

| Field | Type | Values |
|---|---|---|
| `email` | string | recipient |
| `uid` | string | Auth uid |
| `role` | string | vertical from §2 |
| `status` | string | `pending` `queued` `sent` `delivered` `accepted` `expired` `failed` `superseded` |
| `source` | string | **`"admin_invitation"`** |
| `invitedBy` | string | admin uid |
| `invitedAt` / `sentAt` / `acceptedAt` / `expiresAt` | timestamp | |
| `messageId` | string | SendGrid id from `emailLogs` |
| `supersededBy` | string \| null | previous-invitation chain |
| `resendCount` | number | |

**Acceptance** = the user sets a password and signs in, at which point `lastLogin` appears on
`users/{uid}`. No new activation mechanism is needed.

---

## Verification

Every citation re-checkable with `grep -n` at the stated file:line. Sole unresolved item is
§5 — the retail merchant field name — which requires one completed merchant onboarding to
observe rather than any further code reading.
