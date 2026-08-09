# Unified Identity — One Login, Many Roles

**Status:** In progress (owner-directed). Driver hub migrated as the reference implementation; other roles staged.
**Scope decision (08-05):** *Login gates only, keep step-up.* One account session unlocks all of a user's roles with **no per-role PIN login**. A lightweight **step-up** confirmation is retained **only** for high-risk actions.

> Related: [[Authentication]] · [[Access Control Matrix]] · Platform Hub role switcher · Navigation Contract (`users.roles` switch) · `sokoni-identity-guard.js`

---

## 1. Principle

Every person has **one** SOKONI account (`users/{uid}`) and authenticates **once**. Their capabilities come from **roles on that account** — never from separate login systems.

```
users/{uid}
{
  uid, phone, email, profile,
  roles: { buyer, seller, driver, provider, manager, admin, superAdmin },  // booleans
  activeRole: "driver"
}
```

Switching roles updates navigation, dashboard, permissions, and available actions **without a new login**.

## 2. Authentication (unchanged, already single-session)

Firebase Auth is the one session (phone/Google/FB/email + cross-provider linking — see [[Universal Auth]]). App Check + reCAPTCHA gate reads. No role introduces a second credential.

## 3. Role entry — the migration

**Before:** each role had its own gate — driver phone+PIN, admin PIN/pattern, etc.
**After:** the page resolves the signed-in account and reads its role record. If the role is present → enter. If signed in but role absent → offer to apply/enable. If not signed in → account sign-in.

| Role | Record | Status |
|---|---|---|
| **Driver** | `rideDrivers/{uid}` | ✅ **Migrated** (`driver.html`) — no PIN; `_enterDriverIdentity()` |
| Seller | `businesses/{uid}` / `users.roles.seller` | ⏳ staged |
| Provider | `providers/{uid}` | ⏳ staged |
| Manager (POS) | `users.roles.manager` | ⏳ staged — **keep step-up** |
| Admin / Super Admin | **Auth custom claims** | ⏳ staged **LAST** — see §5 |

## 4. Step-up verification (retained)

The account session opens the *dashboard*; it does **not** auto-authorize destructive/financial actions. These require a fresh confirmation (account PIN re-entry or re-auth), independent of role entry:

- Refunds, POS voids/discounts
- Deleting users, changing permissions
- Modifying system configuration
- Exporting sensitive data
- Payout approvals

This is *step-up*, not a second account — one confirmation for one sensitive action. Reconciles with the three-layer security model ([[feedback_security_layers]]): the PIN stops being a *login wall* and survives as *step-up*.

## 5. Admin — backend-authoritative, migrated LAST

**Hard rule:** do **not** remove the admin PIN gate until the backend is proven to enforce admin via **Auth custom claims** on *every* admin Cloud Function and Firestore rule ([[reference_admin_custom_claims]]). Order:

1. Verify/complete backend claims enforcement (CF `_assertAdmin` on all admin endpoints; rules `request.auth.token.admin == true`).
2. Then replace the client admin PIN entry with claims-based access.
3. Keep step-up on the highest-risk admin actions.

Removing the client gate first would make a UI lock the *only* thing guarding admin tools — never do this.

## 6. Permissions (derived, not stored per-account)

Client renders features from roles; **backend is the authority** and re-checks identity + role on every privileged call. Never trust the client to grant access.

```
canBuy, canSell, canDeliver, canManageBranch,
canReceiveOrders, canAcceptBookings, canModerate
```

## 7. Unified surfaces (follow-on)

One wallet (per-role sub-balances — see [[Multi-Wallet Architecture]]), one notification center (filter by role), one calendar (all role activities). Extend the existing engines; do not rebuild ([[Platform Constitution]]).

## 8. Rollout order

1. ✅ Driver hub (reference)
2. Seller / provider entry → account+role
3. Manager (POS) entry → account+role, **step-up retained** on voids/refunds
4. Backend admin-claims audit → **then** admin entry
5. Role switcher surfaced platform-wide (Platform Hub)
6. Unified wallet/notifications/calendar polish

This is R1.1 work; nothing here blocks the v1.0.0 checkout-gate tag.
