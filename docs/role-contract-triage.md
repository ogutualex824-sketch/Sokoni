# Role Contract Triage — Phase 2

> **Base commit: `faa149e`.** Every row below was read against that exact source.
> **Read-only. No product code changed.** Verdicts, not fixes.
> Matrix: `docs/role-contract-matrix.json` · Scanner: `scripts/census-role-contract.js`
> Evidence tool: `scripts/triage-role-contract.js`

Related: [[Access Control Matrix]] · [[Role Source Population]] · [[Authentication]]

---

## The three questions kept apart

```
role VOCABULARY    "Seller"                         a word
role DECISION      if (user.role === 'seller')      a branch
role CAPABILITY    canEditProduct(product)          an operation
```

The census caught the second. This triage adds the third — for every flagged page,
whether it performs a write or callable at all, and whether a role word sits near one.

---

## Bucket A — the 10 P0 rows

| page | what the role-shaped code actually does | class | disposition |
|---|---|---|---|
| **business-analytics.html** | `_lsFallback()` grants the analytics view from `localStorage.getItem('userRole')` or a `sokoniUser` doc — `onGranted(user)` on a client-controlled value | **DECISION** | **ESCALATE** |
| **seller-analytics.html** | identical `_lsFallback()` | **DECISION** | **ESCALATE** |
| index.html | `script.js:3641` builds `_isSeller` from `user.isSeller \|\| user.role \|\| user.registeredAs \|\| user.sellerActive \|\| user.storeName`; used at 3364-65 to choose *which story button to show* | FEATURE VISIBILITY | **FIX** (medium) |
| expense-management.html | `const role = claims.role \|\| data.role` — claims first, document as fallback, then gates | DECISION (partially canonical) | **FIX** (medium) |
| search.html | `sokoni-recommendations.js:449` sets `_userRole = user.activeRole \|\| user.role`; declared line 139, **read nowhere** | DEAD | KEEP |
| account-centre.html | line 2238 is `_acActiveRole()` — the shared resolver that asks `SokoniRoleAuthority` first and only falls back to the mirror | DISPLAY | KEEP |
| admin.html | `_userRoles(u)` at 4688 builds the role list **for the admin user table** — another user's roles | DISPLAY | KEEP |
| admin-os.html | `sokoni-aos.js:315,341` render `role-badge` for **listed users** | DISPLAY | KEEP |
| super-admin.html | line 1126 `const role = u.role \|\| 'buyer'` inside `list.map(u => …)` — **the user table** | DISPLAY | KEEP |
| release-readiness.html | `currentRole = data.role \|\| 0` in an internal readiness tool | DISPLAY | DEFER |

**Five of the ten are false positives.** `admin`, `admin-os` and `super-admin` were flagged
for rendering *other people's* roles in an administrative table — the opposite of deciding
their own access. Their administrative decision runs through `SokoniAdminEntry.guard()` →
`requireAdminContext()` → claims, exactly as designed.

### The one that matters

```js
function _lsFallback(){
  var lsu = JSON.parse(localStorage.getItem('sokoniUser')||'{}');
  var r   = (localStorage.getItem('userRole')||'').toLowerCase();
  if (_isSellerDoc(lsu) || r === 'seller' || r === 'admin' || r === 'vendor') { onGranted(user); }
  else { _deny(); }
}
```

Two pages grant a view from a value the visitor controls. **ESCALATE — but do not assume
severity.** What it grants is the client-side *view*; whether the data behind it is
readable depends on Firestore rules, which are the actual boundary. That needs a
before-proof establishing whether `onGranted` leads to any privileged read, exactly as the
admin-lock question did. `_lsFallback` reachability is already an open item in the register.

### On `search.html`

Asked directly: it is **not** querying the wrong dataset. `_userRole` is assigned once and
never read. Severity: none. It is dead code, not a workspace leak.

---

## Bucket B — legacy `driver` vocabulary (9 pages)

`beta` · `driver-success` · `org-workflows` · `rider-dashboard` · `staff-management` ·
`subscription-billing` · `super-admin` · `verification-admin` · `verification`

**DEFER, all nine.** The canonical workspace name is `rider`; `driver` is a legacy alias
normalised by `LEGACY_CLAIM`. But the census cannot separate a user-facing workspace label
from domain vocabulary — `driverUid`, `driverLocation`, `driverAssigned`, driver
notification fields and SMS templates are backend schema and are *not* wrong.

Renaming needs a per-occurrence decision, and a blind sweep would rename schema. The
lowercase-`superadmin` census already showed what that costs: 15 dormant comparisons would
have gone live and 2 working ones would have broken.

---

## Bucket C — the 43 UNGUARDED pages

Classified by capability, because "mentions a role word" is not a defect.

| bucket | count | disposition |
|---|---|---|
| **no write, no callable** — cannot perform a role-requiring operation | 18 | KEEP |
| **capability present, no role word near it** — writes are owner-scoped; rules are the boundary | 21 | DEFER |
| **role word adjacent to a capability** — read individually, all benign | 4 | KEEP |

The four adjacency hits, read:

```
onboarding-seller.html:468        addDoc(onboardingCompleted, {role:'seller'})   a RECORD
onboarding-driver.html:594        addDoc(applications, …)                       a REQUEST
onboarding-professional.html:520  addDoc(applications, …)                       a REQUEST
kass-seller.html:582,692,712      role:'user' / role:'kass'                     CHAT roles
```

**No page writes `users/{uid}.role`.** No self-provisioning. `applications` is a request and
the registries are truth — the established contract. `kass-seller`'s `role` field is chat
message vocabulary and shares only the word.

---

## Which outcome this is

Of the three possibilities:

- **Outcome 1 — tiny real defect surface.** 2 escalations, 2 medium fixes, 1 dead
  variable, 5 false positives, 43 rows needing no action.

There is **no evidence for a formal page contract or `canAccessRoute()`**. Nothing in the
43 shows seller mutations, rider operations or admin operations behind an absent gate.

Outcome 3 remains partly open: the header/dropdown divergence was real and is fixed
(`b9c5c55`), but footer, search placeholder and notification perspective have not been
audited. That is a **presentation** question, not an authorization one, and it does not
require a new authorization framework.

---

## Recommended order

1. **ESCALATE** the two `_lsFallback` pages — before-proof first: does `onGranted` reach
   any privileged read, or only a view over rules-gated data?
2. **FIX** `index.html` via `script.js:3641` — ask the authority for seller entitlement
   instead of a five-way mirror `||` chain. Feature visibility, not authorization.
3. **FIX** `expense-management.html` — it already prefers `claims.role`; drop the document
   fallback.
4. Everything else: KEEP or DEFER.

## What must not happen

- Do not build `canAccessRoute()` on this evidence. It is not justified.
- Do not put route guards on 43 pages. 39 of them need nothing.
- Do not rename `driver` globally.
- Do not replace a sound server-side model with client-side route logic. The UI decides
  what to *show*; claims and ownership decide what may *happen*.
