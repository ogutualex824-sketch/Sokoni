# Merchant/Seller Entry & Authorization Audit — broken-path inventory (READ-ONLY)

**Status:** AUDIT ONLY. No code changed. Produced by four independent read-only tracers
(entry paths, capability model, route gate, 7/9-tap). Separate from POS Gate 1 and the admin
convergence candidate. Extends the established authority (`SokoniMerchantEntry`, the route
registry, the route-gate test) — does not invent a parallel system.

Related: [[project_merchant_auth_boundary]] · [[project_users_merchantid_forgeable]] ·
[[project_seller_authority_gate]] · [[project_application_lifecycle]] · `docs/MERCHANT_ENTRY_POINTS.md`.

---

## The core defect (one sentence)
A dashboard reveals because you can navigate to it, not because you have an **approved capability** —
and even the one correct gate trusts a **forgeable** signal.

---

## A · Dashboards reveal without an approved-capability check

| Surface | On-load gate | Result |
|---|---|---|
| **`/merchant`** (`merchant.html`, DEPLOYED) | `<html lang="en">` has **no `data-require-auth`**; loads `auth-guard.js` but it early-returns (`auth-guard.js:29`) → **inert** (the missing-`?next=` fingerprint). Never loads `sokoni-merchant-entry.js`. | **ANY visitor, even signed-out**, typing/bookmarking `/merchant` sees the full shell. Data stays protected by Firestore rules; the shell does not. |
| **`/merchant-v2.html`** (NOT deployed) | Has `data-require-auth="true"` (`:32`) but **never loads `auth-guard.js`** → attribute decorative. | Anyone sees the shell. |
| **`/seller`** (`seller.html`, DEPLOYED, most-linked) | Has `data-require-auth` (signed-out → `login?next=/seller`) but **no `data-require-role="seller"`** → `sokoni-guards.js` requires *any* login, no role. | **Any authenticated buyer** with zero approved application reaches the full Seller Dashboard. Widest surface. |
| `sokoni-merchant-routes.js` | Declarative registry: each route declares `role:[...]`/`ctx:[...]` but **no code enforces it** against the user's claims. | Inert gate. |

Corroborated in-repo: `scripts/probe-merchant-auth-guard.js`, `scripts/census-merchant-entry-points.js:13` ("PUBLIC ACTION → seller.html/merchant.html ← the bypass").

## B · ~40 direct links bypass the entry gate → land unapproved users in the Seller Dashboard
`script.js:1084/1653/1702/1954/3358`, `404.html:48`, `beta.html:137/140`, `business-os.html:180`,
`construction.html:208/290`, `community.html:236/937`, `business-analytics.html:153/300`,
`life-events.html:172`, `opportunity.html:236`, `providers.html:262/306`, `provider.html:303/825`,
`index.html:1526/1677/2730-2732`, `ministore.html:400`, `minishop-admin.html:429/446/516/519`,
`profile.html` (2046/2115/2186/3219/3254/3914/6111/6241/6423/6784/7352), `profile.js:261`,
`offer.html:149/166`, `invoice.html:265`, `growth-dashboard.html:268/369/451`, `inv-*`, `seller-*`,
`etims-seller.html:110`, `qr-center.html:256`, `pos.html:92/276`, `pos.js:2750-2766`,
`shared-header.js:2258-2265` (role switcher `seller→seller.html`), `auth.js:500/802`, `join.html:313`.

## C · Capability model — there is NO "merchant" capability distinct from "seller"
- Only claims ever minted: **`seller`, `provider`, `rider/driver`** (`functions/role-authority.js:112-118`). **No `merchant` claim.**
- The whole Merchant OS (`/merchant`: POS, Staff, KRA Tax, Disputes, B2B, Payments) opens on the **single `seller` signal**. Every route declares `role:['seller','merchant']` — **`'merchant'` is dead vocabulary**.
- **Approved seller ⇒ full merchant OS, no per-surface capability check.** Privilege-sensitive surfaces (Revenue, POS-only CRM) are handled by *not wiring the button*, not by a check.

## D · Forgeable signals used as capability (the authorization holes)
- **CRITICAL — `users.roles[]` is forgeable.** `noSelfGrant()`/`noAdminFields()` block `role` (singular) and `registeredAs.{admin,superAdmin,moderator,isAdmin}`, but **NOT the `roles` array** (the rule comment lists `roles` as a normal client-writable field; no `rolesUnchanged` rule exists). So a user can self-write `users/{uid}.roles=['seller']` → **`SokoniMerchantEntry.resolve()`'s signal #2 passes**. **Only the custom claim `seller===true` is non-forgeable.**
- `access-control.js:53-66/104-109` — gates `seller/ministore/healthcare/driver/landlord/legal` on `localStorage.sokoniUser.registeredAs`.
- `sokoni-permissions.js` — claim-verifies only level ≥50; seller/driver/provider/business are level 20 → resolve from cache/localStorage/`data.isSeller` **unverified** (`:156-188`, `:230`, `:331-338`, `:421-459`).
- `auth.js:940-954` `completeRoleSelection()` — routes driver/health/legal/landlord dashboards off forgeable `registeredAs.*`. **Only the seller branch was migrated to `SokoniMerchantEntry`.**
- Post-login redirect `auth.js:876-881` — forgeable `registeredAs.seller`.
- Client-writable per rules: `users.merchantId`, `users.isSeller`, `registeredAs.seller`, `sellers/{uid}.status` (self-create = the application, not approval).

## E · 7/9-tap admin
- **9-tap → `/super-admin.html`** (`index.html:4178`) = **canonical** guarded super-admin. ✅
- **7-tap → legacy "🔐 Admin Access" PIN overlay (localStorage hashes) → `admin.html`** (`index.html:3603-3699`). `admin.html` is guarded but is the **old "Admin Panel" sub-page, not the canonical `admin-os.html`** (`sokoni-admin-nav.js:57` HOME; `shared-header.js:2263`). The PIN overlay is a second client-side gate the claims guard replaces. **This is the "old admin version."**
- `_secretTap` is **dead on the homepage** (not bound to the logo); the **wired** gesture is `seller.html`'s **8-tap → `admin.html`** (`seller.html:6096`).
- **Stale-serve:** `index.html` + `admin.html` are SW-precached (`sw-register.js`); `admin-os.html`/`super-admin.html` are not. So the old 7-tap→`admin.html` build **survives a deploy on a device** — why "7-tap still opens the old version."
- Many links + email CTAs (`functions/email-templates.js:1064/1085/1512/1532`) still target old `admin.html`; `profile.html:3265` mislabels "Admin OS" → `admin.html`.

---

## The authority to EXTEND (not replace)
- **Gate:** `SokoniMerchantEntry.resolve()` — but must (1) trust the **claim** not forgeable `users.roles`, and (2) be **enforced on the shell** (`merchant.html`/`seller.html` need `data-require-role` + a claim check), not just decorate entry buttons.
- **Registry:** `sokoni-merchant-routes.js` — wire its per-route `role[]` to actual claim enforcement.
- **Server:** `grantAccountRole` is the sole capability writer; keep it. **Rule fix:** protect `users.roles[]` (add to `noSelfGrant`) OR stop reading it in the gate.
- **Tests:** extend `scripts/test-merchant-route-gate.js` (panel identity; auth = UNPROVEN) and `scripts/test-merchant-entry-routing.js` (3×3 approval matrix) — do not add a competing gate.

## Acceptance table — current vs expected
| Scenario | Expected | Current |
|---|---|---|
| New user clicks Start Selling | Applications | ✅ (the `data-merchant-entry`/`offer` paths) — but ~40 links skip it (B) |
| No application | Applications | ❌ reaches Seller/Merchant dashboard (A3, B) |
| Pending | status page | ❌ no pending gate |
| Rejected | reapply | ❌ no rejected gate |
| Approved **seller** | Seller dashboard only | ❌ gets the **full Merchant OS** (C) |
| Approved merchant | Merchant dashboard | n/a — no merchant capability exists (C) |
| Approved provider / rider | that dashboard | ⚠ gated on forgeable `registeredAs` (D) |
| Direct `/merchant.html` no approval | DENY/redirect | ❌ reveals to anyone incl. signed-out (A1) |
| Old merchant URL / deep link / bookmark | same gate | ❌ inert (A1, A4) |
| Mobile & desktop nav merchant link | same gate | ❌ role switcher → `seller.html` login-only (B) |
| Admin / Super Admin | admin/super authority | ✅ guard enforces; but 7-tap → old `admin.html` (E) |
| Existing KASS Shop | preserve approved access | must verify its approval is claim-backed, not `users.roles`-only |

---

## Recommended fix shape (for the LATER candidate — not done here)
1. **Enforce the gate on the shell:** `merchant.html` + `seller.html` add `data-require-auth="true"` **and** a **claim-based** capability check (`seller===true`) on load → non-approved → `/account-centre` (or the application flow). Wire `merchant-v2.html`'s existing flag to actually load the guard.
2. **Trust the claim, not `users.roles`:** change `SokoniMerchantEntry` signal #2, and/or **protect `users.roles[]` in `firestore.rules`** so the array can't be self-granted.
3. **Re-point the ~40 direct `seller.html` links** and the role switcher through the gate.
4. **7-tap:** route through the claims guard to canonical **`admin-os.html`**, retire the localStorage-PIN overlay; add `sw-register.js` freshness where the old build persists.
5. Migrate the **non-seller** `completeRoleSelection` branches off forgeable `registeredAs` onto the same claim-based authority.
6. **Extend** the two existing tests with the authenticated 3×3 approval matrix + the deny-on-no-capability cases; keep the panel-identity suite.

