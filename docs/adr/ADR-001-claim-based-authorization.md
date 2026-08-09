# ADR-001 — Authorization comes from custom claims

**Date:** 2026-08-02 · **Status:** Accepted · **Enforced by:** `scripts/verify-claim-based-auth.js` (predeploy)

## Decision

Authorization is decided by **Firebase Auth custom claims** and nothing else. Not a Firestore field,
not an email address, not a localStorage flag.

## Evidence

An audit of **1,192 source files** found **zero** email-equality gates, hardcoded privileged-address
lists or domain-suffix privilege tests. The codebase was already correct; the ADR exists to keep it so
while administrative identities are renamed to `superadmin@` / `ceo@` / `company@mysokoni.co.ke`.

Measured alongside it: `platformEmployees` was **empty for all three real administrators**, because
`invitations-core.acceptInvitation()` is its only writer. It records *accepted invitations*, not
*administrators* — a projection, never an authority.

## What this forbids

- `if (user.email === "founder@…")` anywhere in a gate. One such line turns an address change into a
  silent privilege loss — or leaves the **old** address privileged after it is handed to someone else.
- Reading `users/{uid}.role`, `.roles[]` or `platformEmployees` to decide access.
- Adding `admin` to `roles[]`. That array is the marketplace axis; admin authority is not in it.

## Consequences

Claims travel with the UID, so **renaming an identity requires no authorization change**. A UID
allowlist (`_systemConfig/bootstrap.allowedUids`) is acceptable where a bootstrap needs one — a UID
survives a rename; an email does not.

**Open:** 17 `setCustomUserClaims()` call sites, only a handful of which revoke refresh tokens. A
device therefore keeps stale claims for up to an hour, or indefinitely if the user never returns.
See `project_admin_console_integrity`.
