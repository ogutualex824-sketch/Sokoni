# Role Authority Audit — every client write path to `users.roles` and `users.activeRole`

**Recorded:** 2026-08-15 · **From checkpoint:** `2ba509b` (Roles Phase 2)
**Status at time of audit:** rules UNCHANGED. Nothing was modified before this document existed.

Related: [[project_access_control_matrix]] · [[project_security60]] · [[feedback_standing_security_rules]]
· [[reference_rules_compiled_size_ceiling]]

---

## Why this audit exists

Phase 2 made approval the authority on roles: `grantAccountRole` writes
`users.roles` with `arrayUnion(key)` / `arrayRemove(key)` and sets `activeRole` with
`activeRoleSetBy:'approval'` (`functions/application-lifecycle.js:886, 904, 910`).

That is only half a control. The Admin SDK writes the field, but **the client could still
write it too** — `firestore.rules` guarded the `role` *string* and never the `roles`
*array* or `activeRole`. An authority that a client can overwrite is not an authority.

---

## Finding 1 — SELF-GRANT (severity: HIGH)

**`profile.html:4329-4339`** — Settings → *Linked hubs*.

```js
var roles = ['buyer'];                                        /* buyer always */
if (document.getElementById('hubSeller').checked   ...) roles.push('seller');
if (document.getElementById('hubProvider').checked ...) roles.push('provider');
if (document.getElementById('hubDriver').checked   ...) roles.push('driver');
if (document.getElementById('hubAgent').checked    ...) roles.push('agent');
...
saveToFirestore({ phone: phone || null, roles: roles, activeRole: _user.activeRole });
```

Any authenticated user can tick four checkboxes and write
`roles: ['buyer','seller','provider','driver','agent']` onto their own user document.
No approval, no application, no admin. This is the **whole** `users.roles` array being
replaced from client input, and `activeRole` alongside it.

It also **removes** roles: the array is rebuilt from scratch, so an unticked box drops a
role the server granted.

Aggravating factor — **`profile.html:4548`**: `saveToFirestore` classifies
`permission-denied` as *transient* and retries it twice. A denied write is retried rather
than surfaced.

## Finding 1b — SELF-GRANT, direct (severity: HIGH)

**`profile.html:4514-4527`** — the *Add role* modal.

```js
function addRole(roleKey){
  var roles = _user.roles || ['buyer'];
  roles.push(roleKey);                                   /* ANY role key */
  saveToFirestore({ roles: roles, updatedAt: ... });
  upToast('Role added: ' + rd.label, true);              /* claimed regardless */
}
```

The most direct self-grant on the platform: push any role key, persist it, and toast
success whether or not the write landed.

> **Audit correction.** This path was missed by the first pass. The initial grep required
> a literal array/quote on the line (`roles:` followed by `[`, `'` or `"`), and this line
> reads `roles:roles` — a variable. Found on the follow-up sweep for *residual* writers,
> which searched by write-call (`saveToFirestore|setDoc|updateDoc|arrayUnion`) instead of
> by value shape. **Searching by call site, not by value shape, is the reliable pattern.**

## Finding 2 — SELF-GRANT via shift toggle (severity: MEDIUM)

**`driver.html:1110`** and **`driver.html:3113`** — both sites, on the online/offline toggle:

```js
firebase.firestore().collection('users').doc(_ru).set({
  roles: firebase.firestore.FieldValue.arrayUnion('driver'),
  isDriver: true, isRider: true,
  driverProfile: { shiftStatus: ..., lastShiftAt: ... },
  updatedAt: ...
}, { merge: true }).catch(function(){});
```

Additive rather than destructive, but still a client granting itself `driver`.

**Property that matters for the fix:** `arrayUnion('driver')` on a user who *already* holds
`driver` produces an identical array, so it does not appear in
`diff(resource.data).affectedKeys()`. An **approved rider is therefore unaffected** by an
immutability rule — only a user who does not already hold the role is denied, which is
exactly the attack. The write is `.catch(function(){})`, so a denial is silent and would
also lose the `driverProfile.shiftStatus` mirror in the same `set()`.

## Finding 3 — client repairing server-owned data (severity: LOW)

**`profile.html:3458`** — `_healRolesOnce()` dedupes the stored `roles` array and writes it
back: `saveToFirestore({ roles: clean })`. Legitimate in intent, wrong layer: a dedupe is a
*change* to a server-owned field and is indistinguishable at the rules layer from an attack.

## Finding 4 — legitimate baseline writes on CREATE (must keep working)

| Path | Value | Shape |
|---|---|---|
| `auth.js:677` | `roles: ['user']` | account create |
| `auth.js:1163` | `roles: ['buyer']` | account create |
| `auth.js:1504` | `roles: ['buyer']` | account create |
| `firebase.js:848` | `roles: ['buyer']` | new-user profile create |
| `sokoni-user-bootstrap.js:63` | `roles: ['buyer']` | baseline create |

All five are **create-path only** and all write the baseline `buyer`/`user` and nothing
else. `firebase.js:777` is not a write — it is an auth-ready event payload.

Any rule must let these through, or **every signup breaks**.

## Not findings — read-only

`account-centre.html:1450,1492` · `profile.html:3178-3242, 3757-3779, 4337, 4576` ·
`shared-header.js:1438,1685` · `sokoni-nav-engine.js:49,75` · `sokoni-auth-state.js:51,67` ·
`sokoni-permissions.js` · `access-control.js:55`. `profile.html:3779 switchRole()` writes
`activeRole` to **localStorage only**; it is `savePreferences` at `:4339` that persists it.

`demo-seed.js:2089-2092` uses `roles` as an object literal in seed fixtures — not a
production write path.

---

## Server authority (must keep working)

`functions/application-lifecycle.js` `grantAccountRole()`:

```js
patch.roles = FieldValue.arrayUnion(key);     // :886  approval
patch.roles = FieldValue.arrayRemove(key);    // :910  revocation
patch.activeRole = key;                       // :904  activeRoleSetBy:'approval'
patch.activeRole = 'buyer';                   // :920  activeRoleSetBy:'revocation'
```

The Admin SDK **bypasses security rules entirely**, so no rule can obstruct it. Admins
acting through a client are already covered by `isAdmin()` on the `users` update rule
(`firestore.rules:272`).

---

## Current rules position

`firestore.rules:148` `noSelfGrant()` blocks
`betaStatus, accessLevel, featureFlags, permissions, role, trustScore, kycStatus, riskLevel,
merchantStatus, providerStatus, ageVerified*`.

It blocks the **`role` string**. It does **not** block **`roles`** (array) or
**`activeRole`**. `firestore.rules` contains **zero** occurrences of `activeRole`.

---

## Required properties for Phase 3

1. A client cannot **add** a role to `users.roles`.
2. A client cannot **remove or replace** roles in `users.roles`.
3. A client cannot set `activeRole` to a role it has not been **server-approved** for.
4. A client **can** select an `activeRole` it *has* been approved for (custom claim present).
5. Account creation with the baseline `['buyer']` / `['user']` keeps working.
6. Admin and Admin-SDK provisioning keep working.
7. Existing seller / rider / provider / POS authorization is unchanged.

Approval is expressed in **custom claims** (`claims[key] = !!approved`, set by
`grantAccountRole`), which is the only role signal a client cannot forge — a claim is
signed into the ID token by the server. `activeRole` is therefore validated against
`request.auth.token`, not against the user document, which the client can influence.

**Known consequence:** a newly-approved user carries a stale ID token until it refreshes,
so their new role is selectable only after a token refresh. Standard for claims-based
authorization, and preferable to trusting a client-writable document.
