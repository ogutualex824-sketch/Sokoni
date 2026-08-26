# Admin Routing & Navigation Audit

**Date:** 2026-08-25
**Branch audited:** `fix/algolia-batch-poisoning`
**Method:** static analysis of the working tree (`scripts/nav-audit.js` + targeted greps).
**Scope:** platform-admin surfaces only. Kept deliberately separate from RC release work.

> **Evidence class.** Everything below is **statically proven from source**. Nothing here is
> runtime-proven — headless cannot boot these consoles (App Check), see
> [[project_pos_single_window]]. Per [[project_release_validation_standard]]:
> *written != reviewed != runtime proven.* The authorization column is the one that
> most needs runtime confirmation, and it is explicitly marked incomplete.

---

## 0. Substrate — the audit's framing had to change

SOKONI has **no React/Next router and no `/admin/*` nesting.** Hosting is
`public: "."` with `cleanUrls: true`, so every "route" is a root-level `.html` file
served at its basename. Consequences that shape the rest of this document:

| Assumption in the audit brief | Reality |
|---|---|
| Nested routes `/admin/orders` | Do not exist. Flat basenames only. |
| Route guards / route table | No route table. Guards are per-page inline script. |
| Redirects masking architecture | `redirects: []` — **zero**. Nothing is masked or aliased. |
| Catch-all / 404 | `"404": "/404.html"` — static, no auth awareness. |
| Deep-link behaviour | Every admin page **is** a deep link. There is no shell to deny entry. |

There are **330 root HTML pages**. 24 are admin-named; by authority-demanded the real
admin surface is larger and fuzzier (§3).

**This is the core structural finding:** there is no admin *shell*. There are ~30
independent, separately-deployed HTML documents that each re-implement their own gate,
or fail to. "Sidebar → section → page" hierarchy, breadcrumbs, and active-route
highlighting — the things the brief asked me to check — **do not exist as a system** to be
audited. That absence is the defect.

---

## A. Canonical route map + navigation matrix

`IN` = distinct inbound in-repo links. `Gate` = client-side authorization actually present.

| Navigation target | Exists | IN | Reachable | Client gate | Parent | Status |
|---|---|---|---|---|---|---|
| `/admin` | Y | 21 | Y | claims `admin`/`superAdmin` | — (root) | **PASS** |
| `/admin-os` | Y | 8 | Y | **NONE** | ambiguous | **FAIL-AUTH** |
| `/super-admin` | Y | 3 | Y | claims `superAdmin` strict | admin-os, index, profile | **PASS** |
| `/superadmin` | Y | 1 | Y | claims `admin` OR `superAdmin` | admin | **FAIL-DUP + FAIL-GATE** |
| `/admin-messages` | Y | 0 | direct-URL only | claims | orphan | **FAIL-REACH** |
| `/messages-admin` | Y | 0 | direct-URL only | claims | orphan | **FAIL-DUP** |
| `/admin-feedback` | Y | 3 | Y | **NONE** | admin, ops-dashboard | **FAIL-AUTH** |
| `/admin-subscriptions` | Y | 1 | via orphan | claims | **finos-admin (orphan)** | **FAIL-PARENT** |
| `/commission-admin` | Y | 1 | via orphan | claims | **finos-admin (orphan)** | **FAIL-PARENT** |
| `/finos-admin` | Y | 0 | direct-URL only | claims | orphan | **FAIL-REACH** |
| `/fos-admin` | Y | 0 | direct-URL only | claims (guard inert) | orphan | **FAIL-REACH** |
| `/enterprise-ops` | Y | 0 | direct-URL only | **NONE** | orphan | **FAIL-AUTH+REACH** |
| `/etims-admin` | Y | 0 | direct-URL only | claims | orphan | **FAIL-REACH** |
| `/legal-admin` | Y | 0 | direct-URL only | claims | orphan | **FAIL-REACH** |
| `/platform` | Y | 0 | direct-URL only | claims | orphan | **FAIL-REACH** |
| `/sasos-admin` | Y | 0 | direct-URL only | claims | orphan | **FAIL-REACH** |
| `/beta-control` | Y | 0 | direct-URL only | **NONE** | orphan | **FAIL-AUTH+REACH** |
| `/beta-dashboard` | Y | 0 | direct-URL only | **NONE** | orphan | **FAIL-AUTH+REACH** |
| `/uat-center` | Y | 0 | direct-URL only | claims | orphan | **FAIL-REACH** |
| `/ops-center` | Y | 1 | Y | **NONE** | executive-dashboard | **FAIL-AUTH** |
| `/ops-dashboard` | Y | 3 | Y | **NONE** | admin, platform-health | **FAIL-AUTH** |
| `/reliability-center` | Y | 3 | Y | **NONE** | admin-os, admin | **FAIL-AUTH** |
| `/minishop-admin` | Y | 3 | Y | **NONE** | seller, inventory | **FAIL-OWNER** (§C) |
| `/pos-staff-ops` | Y | 1 | Y | **NONE** | pos-daily | **FAIL-OWNER** |
| `/staff-management` | Y | 2 | Y | auth only (correct) | account-centre, profile | **RECLASSIFIED - not admin** |
| `/platform-health` | Y | 2 | Y | claims | admin-os, admin | PASS |
| `/platform-hub` | Y | 1 | Y | claims | admin-os | PASS |
| `/verification-admin` | Y | 1 | Y | claims `admin` strict | admin | PASS |
| `/trust-safety` | Y | 2 | Y | claims | admin-os | PASS (name, §B2) |
| `/moderation` | Y | 2 | Y | claims | admin, platform-health | PASS |
| `/security-center` | Y | 3 | Y | claims | executive-dashboard | PASS |
| `/release-readiness` | Y | 1 | Y | claims | executive-dashboard | PASS |

**Totals: 12 of 32 admin surfaces are reachable only by typing the URL.**
**10 had no client authorization gate whatsoever.**

> **Correction (2026-08-25, during remediation).** `staff-management.html` was
> over-classified above. It queries `businesses where ownerId == request.auth.uid` - a
> business-owner tool, correctly self-scoped, NOT a platform-admin console. Admin-gating
> it would have locked out legitimate sellers. Same for `minishop-admin` (title "My
> MiniShop - SOKONI Seller", keyed on `shopId`) and `pos-staff-ops` (SmartPOS). The
> genuine ungated platform-admin set is **8**, not 10.

---

## B. Broken / duplicate routes

**No dead links and no redirects.** The whole tree has exactly **one** dead link
(`provider-profile.html` → `bookings.html`) and it is not an admin route. Nothing is
aliased or masked. The problem is the opposite of rot-by-redirect: it is **sprawl
without a spine**.

### B1 — Genuine duplicates (same job, two pages)

| Pair | Evidence | Recommendation |
|---|---|---|
| `super-admin` / `superadmin` | "Super Admin" vs "Super Admin Console". Different parents, **different gates**, both live. | Keep `super-admin` (strict `superAdmin`). Retire `superadmin`. |
| `admin-messages` / `messages-admin` | "Message Admin" vs "Communications Admin". **Both orphaned.** | Pick one, delete the other. |
| `ops-center` / `ops-dashboard` | "Operations Center" vs "Operations Dashboard". Both ungated. | Merge. |

### B2 — NOT duplicates (name collisions only — do not merge)

Verified by title/H1; flagged so a future consolidation does not destroy them:

- `trust.html` = **public** "Trust Passport" (consumer identity)
- `trust-and-safety.html` = **public** marketing page
- `trust-safety.html` = the **admin** console
- `beta.html` = **public** invite; `beta-control` / `beta-dashboard` = admin

Three near-identical names spanning two trust boundaries is itself the risk.

---

## C. Navigation defects

1. **`finos-admin` is an unreachable parent.** Zero inbound, yet the sole in-repo parent
   of both `admin-subscriptions` and `commission-admin`. An entire financial-admin
   subtree hangs off a node nothing links to.
2. **No breadcrumbs, no active-route highlighting, no parent/back — anywhere.** There is
   no shell to host them.
3. **Admin pages inherit the *customer* bottom nav.** `shared-header.js` injects
   Home/Shop/Services/Orders/Profile on 82 pages, admin consoles included. This is
   direct **admin↔customer navigation leakage** — the reverse direction of the brief's
   concern.
4. **Ownership leakage.** `minishop-admin` is parented under `seller`/`inventory` and
   `pos-staff-ops` under `pos-daily`. These are **merchant** tools carrying `-admin` /
   `-ops` names, implying platform authority they do not have. See
   [[project_merchant_consolidation]].
5. **Terminology drift already measured**: 17 distinct bottom-nav label encodings for
   5 slots (raw emoji, HTML entities, ligature codepoints).

---

## D. Authorization defects — the security boundary

> **Navigation being hidden is not authorization.** Confirmed: nothing here relies on nav
> hiding, because nav barely exists. But the client gates are equally not authorization.

### D1 — `security.js` does not gate. `auth-guard.js` is authentication only.

`security.js` (1347 lines) contains **no** role check and no redirect-on-unauthorized.
`auth-guard.js` checks `localStorage.getItem('loggedIn') === 'true'` — client-side,
trivially forgeable, and **role-blind**. It only runs when `data-require-auth="true"`
is present on `<html>`.

**`staff-management.html` is the only admin page loading `auth-guard.js` with the
attribute set — so it is gated on *being logged in at all*. Any authenticated buyer can
load the staff-management console.**

**`fos-admin.html` loads `auth-guard.js` but has no `data-require-auth` attribute, so the
guard returns early and is INERT.** Same fingerprint as [[project_merchant_auth_boundary]].
(`fos-admin` does carry its own claims check, so it is not exposed — but the inert guard
is a live trap for the next page that relies on it alone.)

### D2 — Ten admin consoles with no client gate

`admin-os`, `enterprise-ops`, `ops-center`, `ops-dashboard`, `admin-feedback`,
`beta-control`, `beta-dashboard`, `minishop-admin`, `pos-staff-ops`, `reliability-center`.

`admin-os.html` (57 KB, 8 inbound links, the de-facto admin hub) has **zero**
`onAuthStateChanged`, **zero** `getIdTokenResult`, and no redirect.

**What this does and does not mean.** These pages *render* for anyone. Data is still
protected by Firestore rules (§D3), so this is **disclosure of admin UI structure and of
whatever is not rules-protected** — not automatic data compromise. The severity of each
page depends on which collections it touches. **That per-collection mapping is NOT yet
done and is the single biggest gap in this audit.**

### D3 — The real boundary is sound where it was checked

`firestore.rules` derives admin authority from **custom claims**, correctly:

```
function isSuperAdmin() { return request.auth != null && request.auth.token.superAdmin == true; }
function isAdmin()      { return request.auth != null &&
                          (request.auth.token.admin == true || request.auth.token.superAdmin == true); }
```

Claims are the only client-trustworthy authority ([[project_role_authority_phases]]).
`setUserRole` is server-guarded by `_requireSuperAdmin` + App Check + rate limiting.
**No privilege-escalation path was found through the role console.**

### D4 — `superadmin.html` gate is weaker than its own contract

`superadmin.html:450` comments *"requires superAdmin JWT claim"*; `:454` accepts
`admin || superAdmin`. `super-admin.html` requires `superAdmin === true` strictly.
Because the server enforces superAdmin, an `admin` gets a **fully rendered
role-management console where every action fails** — a defense-in-depth and UX defect,
**not** an escalation.

---

## E. Two functional defects found in the role console

Outside the routing brief, but P1 and found in the audited path.

### E1 — `setUserRole` client/server contract mismatch: Grant/Revoke Role is dead

`superadmin.html:741` and `:751` send `{ email, role }`.
`functions/super-admin.js:110` destructures `{ uid, role }` and throws
`INVALID_ARGUMENT: uid is required`. **There is no email→uid resolution server-side.**

**Every Grant Role and Revoke Role call fails.** The platform's only role-management UI
is non-functional. Fix: resolve email via `getAuth().getUserByEmail()` server-side, or
send `uid` from the client.

### E2 — Suspend bypasses the callable and is cosmetic

`superadmin.html:757` writes Firestore directly:

```js
await updateDoc(doc(db,'users',uid), { suspended: true, suspendedAt: serverTimestamp(), ... });
```

It never calls the `suspendUser` CF, which does the real thing
(`functions/super-admin.js:227`: `getAuth().updateUser(cleanUid, { disabled: suspend })`).

**No auth/session path reads `users.suspended`.** The only `suspended` handling in
functions is `application-lifecycle.js`, which is seller/provider *listing* status — a
different concept. Net effect: **a "suspended" user keeps a valid session and full
platform access.** Fix: call the `suspendUser` callable.

---

## F. Exact files to change

**P1 — security / correctness**
1. `superadmin.html:741,751` — send `uid`, or resolve email in `functions/super-admin.js:110`.
2. `superadmin.html:757` — call the `suspendUser` callable instead of `updateDoc`.
3. `superadmin.html:454` — require `superAdmin === true` strictly.
4. `fos-admin.html` — add `data-require-auth="true"` (guard currently inert).
5. `staff-management.html` — add a claims check; auth-only is insufficient.
6. Add a claims gate to the 10 pages in §D2, starting with `admin-os.html`.

**P2 — structure**
7. Retire `superadmin.html` and `messages-admin.html`; merge `ops-center` ↔ `ops-dashboard`.
8. Re-parent `admin-subscriptions` + `commission-admin` off `finos-admin`.
9. Suppress the customer bottom nav on admin surfaces in `shared-header.js`.
10. Rename `minishop-admin` / `pos-staff-ops` — they are merchant tools.
11. Regenerate `navigation-registry.json` (stale since 2026-07-20).

**Do NOT do yet:** mass-delete orphans. The 12 orphaned consoles may be in operational
use via bookmarks; direct-URL-only is not proof of disuse.

---

## G. Tests needed

1. **Gate coverage gate (CI):** every page matching `*admin*|*ops*|platform*` must
   contain a claims check. Prove the detector with a negative control
   ([[feedback_marker_comments_need_runtime_proof]]).
2. **Inert-guard detector:** `auth-guard.js` present + `data-require-auth` absent → fail.
   Catches the `fos-admin` class.
3. **Per-page collection→rules mapping** — closes the §D2 gap. Highest value.
4. **Runtime authorization probe:** load each admin route as buyer / admin / superAdmin
   and assert the landed URL ([[feedback_measurement_validity]]).
5. **Contract test** for every `httpsCallable` payload vs server destructure — E1 is
   almost certainly not the only instance.
6. **Orphan gate:** a new admin page with 0 inbound links fails CI.

---

## Related

[[project_admin_console_integrity]] · [[project_role_authority_phases]] ·
[[project_merchant_auth_boundary]] · [[project_admin_unguarded_user_write]] ·
[[project_access_control_matrix]] · [[reference_deployed_ruleset_authority]] ·
[[project_release_validation_standard]]

---

## H. Remediation applied - 2026-08-25

| # | Fix | Files |
|---|---|---|
| 1 | New shared claims gate; closes D2 for all 8 genuine platform-admin consoles | `sokoni-admin-guard.js` (new) |
| 2 | Guard wired + `firebase.js` added where missing (3 pages would otherwise fail closed) | 8 consoles |
| 3 | 11 deny paths converged off the marketplace onto `admin-os.html?error=insufficient_privileges` | see CHANGELOG |
| 4 | **`etims-admin` checked a claim that is never minted (`isAdmin`)** - console denied everyone, super admins included | `etims-admin.html:243` |
| 5 | Link labelled "Dashboard" pointed at the marketplace | `verification-admin.html:301` |
| 6 | Admin lock screen offered only "Back to Seller Dashboard" | `admin.html:639` |
| 7 | Signed-out bounce to `/index.html` lost the destination and raced the new guard | `enterprise-ops.html:785` |
| 8 | Business logo cropped by `width/height:100%` + `object-fit:cover` in a 26x26 box | `shared-header.js:1107` |
| 9 | **32 false-success toasts** - errors swallowed, success toasted unconditionally | `sokoni-aos.js` |

### Not changed, and why

- `superadmin.html:861` `signOut()` to `/` is **correct** - the marketplace is the right
  destination after sign-out. Left alone.
- The main header logo (`#sk-nav-logo img`) was **already correct**
  (`height:28px; width:auto; object-fit:contain`, 24px mobile bound). No change needed.
- `providerReviews` **does** have a creation path (`functions/booking-service.js:345`,
  CF-only write + public read). It is not orphaned.
- `minishop-admin`, `pos-staff-ops`, `staff-management` are merchant/business-owner tools.
  They need a **seller/owner** gate, not an admin claim - tracked separately.

### Still open - the review path

1. **`reviews.targetId` is caller-supplied and never validated** server-side
   (`functions/reviews.js:112`). Nothing checks that it resolves to a real seller or shop,
   so a caller passing a display name writes `ratingsSummary/{displayName}` - invisible to
   the shop, which queries its canonical id. **Most likely cause of the Kass symptom.**
2. **No `platform` targetType.** Valid types are product/seller/service/food/healthcare/
   entertainment/education/legal/driver. A review *about SOKONI itself* cannot be
   represented in the canonical model at all.
3. **`autoApprove = true` is hardcoded** (`functions/reviews.js:158`), so `submitReview`
   never produces a `pending` review. The moderation queue can only ever act on reviews
   written by some other path.

---

## I. Admin surface census — 2026-08-25 (classification in progress)

`scripts/census-admin-surfaces.js` classifies every root page by what it ENFORCES,
never by filename. The admin workspace is **far larger than the 32 pages in §A** —
roughly 45-50 pages enforce an admin claim, against 8 currently carrying the shared guard.

### Automated classification proved unreliable — four attempts

| Attempt | Rule | Failure |
|---|---|---|
| 1 | page MENTIONS an admin claim | False positives: `seller-wallet`, 3 SmartPOS pages. False negative: `security-center` |
| 2 | NEGATED claim + deny within 12 lines | False negatives: `admin.html` denies via `_lockSetError()`, not a redirect |
| 3 | NEGATED claim anywhere | Missed indirection: `var isAdmin = claims.admin; if(!isAdmin)` |
| 4 | wide net + evidence extraction | Still missed `security-center` (`c.admin`) and `platform-hub` (`claims.role`) |

Every page denies differently and many gate through an intermediate variable. Enumerating
deny helpers is a losing game. **The final classification must be confirmed page-by-page
against the extracted evidence, not taken from a regex.** Building navigation on a wrong
classification would admin-gate a merchant tool and break seller workflows — the exact
failure that `staff-management.html` already demonstrated.

### Confirmed NOT platform admin (ownership evidence)

| Page | Evidence | Correct owner |
|---|---|---|
| `staff-management.html` | `businesses where ownerId == uid` | business owner |
| `minishop-admin.html` | "My MiniShop - SOKONI Seller", keyed on `shopId` | business owner |
| `pos-staff-ops.html` | SmartPOS shift/till session | POS staff |
| `returns.html` | ternary picks `PLATFORM_ADMIN` vs `PUBLIC_CUSTOMER` | dual-mode |
| `test-accounts.html` | in `firebase.json` ignore - never served | not deployed |

---

## J. Two NEW authorization defects found during the census

### J1 - `executive-dashboard.html` FAILS OPEN (high)

`executive-dashboard.html:2164-2167`:

```js
} catch (tokenErr) {
  console.warn('[token]', tokenErr.message);
  isAuthorized = true; // fail-open: user is signed in, let app render
}
```

If the token read throws - a network blip, an App Check rejection - the page **grants**
access. Any signed-in user reaches the Executive BI console by causing that call to fail.
This is a deliberate, commented fail-open on a platform surface, and it is worse than an
ungated page: it is a bypass with a plausible trigger.

It also accepts `claims.isAdmin` (a claim SOKONI never mints - the same defect already
fixed in `etims-admin`) and a numeric `claims.role >= 4` that no current issuer sets.

**Fix:** fail CLOSED in the catch, and drop the phantom claim names.

### J2 - `merchant-pipeline.html` client-side gate bypass (high)

`merchant-pipeline.html:296-306`:

```js
var stored = localStorage.getItem('sokoniAdminPin') || localStorage.getItem('sokoniAdminPass');
var ok = !stored;
if (stored && hash !== stored) { err.textContent = 'Wrong PIN.'; return; }
var fbUser = window.firebaseAuth && window.firebaseAuth.currentUser;
if (fbUser) { ok = tok.claims && (tok.claims.admin === true || tok.claims.superAdmin === true); }
else        { ok = !!stored; }               // <-- signed OUT + attacker-set localStorage
if (!ok) { err.textContent = 'Admin claim not found.'; return; }
```

When no Firebase user is present, authorization collapses to *"does a localStorage key
exist"*. A visitor sets `sokoniAdminPin` to any value, enters the matching PIN, and the
console opens **with no Firebase authentication at all**.

**Fix:** require a verified Firebase admin claim unconditionally; the PIN may only ever be
an additional factor layered on top of it, never a substitute (the pattern `super-admin.html`
already follows correctly with passcode 3026 AFTER the claim check).

### Shared caveat

Both defects expose admin **UI**. Firestore rules and CF guards still enforce data access,
so neither is automatically a data breach - the severity of each depends on which
collections the page reads, which remains the open §D2 gap.
