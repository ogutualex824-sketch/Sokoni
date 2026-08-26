# 🟠 Defect — `data-require-role` is unenforced; role-declaring pages gate on client-writable `localStorage`

**Found:** 2026-08-26, while investigating D2 (`financial-os` → `finos.html`)
**Status:** 🟠 OPEN — recorded, **not fixed**
**Track:** role-authority convergence — **not** the Admin release
**Severity:** unauthorized **UI/shell** exposure. **NOT** demonstrated financial-data exposure.

---

## The finding

`auth-guard.js` runs on any page with `data-require-auth="true"` and gates on:

```js
var loggedIn = localStorage.getItem('loggedIn') === 'true';
var hasUser  = !!JSON.parse(localStorage.getItem('sokoniUser') || 'null');
```

Both values are **client-writable**. More importantly, the file contains **zero
references** to `role`, `claims`, or `getAttribute` across its 6,290 bytes — so
**`data-require-role` is never read by anything.** A page declaring
`data-require-role="admin"` states a boundary that no code enforces.

This is the pattern production has already corrected twice — the `admin.html` 3026
passcode and `super-admin.html`'s `_promptSuperPass` — each removed after
measurement found the credential *"reached 0 Cloud Functions and 0 rules… it
restricted nobody who read the source."* A `localStorage` boolean is that same
shape.

## Scope — MEASURED, 2 pages, not 58

| | Count |
|---|---|
| Pages loading `auth-guard.js` | 58 |
| Where it is the **only** client-side gate | 50 |
| Declaring `data-require-role` | **3** |
| **In scope: role-declaring AND no other gate** | **2** |

| Page | `data-require-role` | Other client gate | In scope |
|---|---|---|---|
| `finos.html` | `admin` | none | **YES** |
| `dispatch.html` | `admin` | none | **YES** |
| `fleet-monitor.html` | `admin` | **`data-admin-guard="admin"`** | no — **control case** |

`fleet-monitor.html` is the control: it declares the same unenforced attribute but
carries the registry guard as well, so the unenforced declaration is harmless there.
That is what distinguishes a decorative attribute from an exposed one.

### The other 48 pages are NOT part of this finding

They declare only `data-require-auth` — `cart`, `wishlist`, `my-orders`,
`notifications`, `subscriptions` and similar. Their intent is "any signed-in user",
not a role restriction, so an unenforced *role* attribute is not the issue.

**A weak client-side auth gate on those pages is a separate, unassessed question.**
Some are sensitive (`wallet.html`, `pos.html`, `staff-management.html`). That
question is deliberately **not** merged into this record. Do not cite "58 pages" as
the scope of this defect.

## Backend evidence — the sensitive data IS server-authorized

`isAdmin()` resolves from **Firebase custom claims**, not `localStorage`. A
client-side bypass cannot satisfy it.

| Collection read by `finos.html` | Rule |
|---|---|
| `finosAuditLog` | `allow read: if isAdmin()` |
| `payouts` | `isAdmin()` or own `entityId` |
| `ledger` | `isAdmin()` or own `ownerUid` / `tenantUid` |
| `fraudAlerts` | `allow read: if isModerator()` |

So the demonstrated impact is that a **console shell renders for someone who should
not see it**; the financial records behind it do not load.

### `commissionRules` — a separate pre-existing rule, NOT evidence of a bypass

```
match /commissionRules/{ruleId} { allow read: if isAuthed(); }
```

Readable by **any authenticated user**. That is a property of the rule itself and is
identical whether reached through `finos.html` or anywhere else. It is **not** caused
by the `localStorage` gate and must not be cited as proof the bypass yields data.
Whether `isAuthed()` is the right authority for commission rules is its own question.

## NOT YET ESTABLISHED

- **The shell rendering has not been empirically confirmed.** It is inferred from
  reading `auth-guard.js`. Setting `localStorage.loggedIn = "true"` in a disposable
  environment would confirm it. The rules already answer the question that decides
  severity, so this was not pursued.
- Whether `dispatch.html` exposes anything comparable to `finos.html`.
- Whether any Cloud Function trusts client-supplied role state.

## Relationship to D2 — SEPARATE, not superseded

| | |
|---|---|
| **D2** | `financial-os.html` links to `finos.html`, which is unregistered and reachable — a **certification-scope** issue |
| **This defect** | two pages declare a role that **no code reads** — an **enforcement** issue |

**Hiding the `finos.html` link would not fix this**, and would leave `dispatch.html`
untouched and the false declaration in place. That tempting patch is precisely what
this record exists to prevent.

## Do NOT

- change `auth-guard.js`, `firestore.rules`, the registry, navigation, or role logic
- register `finos.html` or `dispatch.html`
- remove the `financial-os` → `finos.html` link as a fix for **this** defect
- describe the scope as 58 pages

## Related

`docs/ROLE_AUTHORITY_CONVERGENCE_TRACK.md` · `docs/ADMIN_RECERTIFICATION_BASELINE.md` (D2) ·
`auth-guard.js` · `firestore.rules`
