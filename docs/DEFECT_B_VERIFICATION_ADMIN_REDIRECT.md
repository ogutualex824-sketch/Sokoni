# 🔴 Defect B — `verification-admin.html` redirects to `/` · MECHANISM UNIDENTIFIED

**Found:** 2026-08-26 during Admin integration certification
**Status:** 🔴 OPEN — **mechanism not identified.** No fix proposed.
**Relationship to Defect A:** **shares a symptom, not a proven mechanism.**
Do **not** merge these records until B's mechanism is established.

---

## What is established

| | |
|---|---|
| Symptom | With **valid `admin` + `superAdmin` claims**, the page navigates to `/` |
| Consequence | The Admin shell never initialises — no scripts, no overlay, `data-sokoni-workspace` never stamped |
| Loads `sokoni-admin-entry.js` | **NO — 0 references** |
| Loads `sokoni-role-authority.js` | **NO — 0 references** |
| Mechanism | **UNIDENTIFIED** |

A legitimate administrator is ejected to the marketplace. That is the whole of what
is proven.

## What was WRONGLY concluded, and withdrawn

This behaviour was initially attributed to `sokoni-admin-entry.js:239`
(`hub || '/'`) — the mechanism found on `admin-os.html`. **That attribution was
false.** The file is not loaded by this page. The symptom matched; the mechanism was
never checked for presence.

## Scripts this page actually loads

`kass-widget.js` · `security.js` · `shared-header.js` · `sokoni-admin-guard.js` ·
`sokoni-admin-nav.js` · `sokoni-admin-shell.js` · `sokoni-cart.js` ·
`sokoni-event-bus.js` · `sokoni-gateway.js` · `sokoni-observability.js` ·
`sokoni-service-mesh.js` · `splash.js`

None matched a redirect-to-root search. So the mechanism is either in one of these
by a form the search missed, or it is not a scripted `location` assignment at all.

## Investigation notes for whoever picks this up

**Do not start by searching for the Defect A pattern.** That is what produced the
false attribution. Start from the page's own loaded scripts and trace the actual
navigation.

Untested candidates, in no priority order:

- `shared-header.js` — production gained `_skResolveHomeHref` / `_skApplyHomeHref` /
  `_ensureRoleAuthority`, which resolve a role-dependent home. Not examined.
- a non-`location` navigation: form submission, `<meta refresh>`, history + reload,
  or a service-worker/navigation-preload redirect.
- `sokoni-gateway.js` / `sokoni-service-mesh.js` — unexamined, names suggest routing.

**Instrumentation warning:** an earlier probe overriding `location.href` via
`Object.getOwnPropertyDescriptor(Location.prototype, 'href')` **silently failed** —
that property is not reliably configurable in Chrome, the redefinition threw, and a
`try/catch` swallowed it. The probe then reported "not a location assignment", which
was wrong. **Prove the instrument fires before trusting a negative result.**

## LIVE-SITE CONFIRMATION 2026-08-26 — mechanism observed on production

Measured on `https://mysokoni.co.ke` as an **unauthenticated visitor**. No credentials
were used, entered, or invented.

| Page | Destination | Destination preserved? | Admin UI |
|---|---|---|---|
| `admin-os` | `/login` | **no** | none |
| `admin` | `/login` | **no** | none |
| `super-admin` | `/login?redirect=super-admin.html` | yes | none |
| **`verification-admin`** | **`/`** | **no** | none |
| `financial-os` | `/login?redirect=financial-os.html` | yes | none |

**Defect B is no longer only a local observation.** The page-local `authGuard()` deny
route reaches `/` on the **actual production site**. The mechanism is live.

**No admin UI is exposed on any of the five** — the signed-out boundary itself holds.

### What this does NOT establish

It does **not** show that a legitimate administrator is rejected. Severity still turns on
whether the direct gstatic Firebase auth succeeds for a real admin — if it does, `deny()`
never runs and this closes as an environment artifact. **Severity remains UNPROVEN.**

### Separate finding — inconsistent signed-out destination handling

Three different behaviours across four admin surfaces in the same denial class:

- `?redirect=` preserved — `super-admin`, `financial-os`
- bare `/login`, destination lost — `admin`, `admin-os`
- `/` — `verification-admin`

Pre-existing production behaviour, visible without credentials. It belongs to the broader
routing/denial track. **Do NOT fold it into Defect A**, which concerns specifically the
signed-in non-admin path through `sokoni-admin-entry.js` and its `hub || '/'` fallback —
a different code path that nothing above exercises.

### Step 1 gate — remains OPEN

| Test | Status |
|---|---|
| Real **non-admin** → `admin-os.html` (Defect A) | ⏸️ **UNPROVEN** — no accounts available |
| Real **admin** → `verification-admin.html` (Defect B severity) | ⏸️ **UNPROVEN** — no accounts available |

Marked UNPROVEN deliberately rather than substituting the signed-out results, which
exercise a different path. Both require a human operator with genuine accounts on an
origin where Firebase Auth works — not `127.0.0.1:3101`, where App Check returns 403.

## Impact on the Admin candidate

`verification-admin.html` is the one page of six that could not be integration-tested.
The other five pass. This is **not** an Admin-shell integration failure — the shell
never gets to run.

---

## Methodology correction — verify the mechanism is LOADED before attributing to it

**Rule:** a matching symptom is not evidence of a shared cause. Before attributing a
symptom on page X to a mechanism found on page Y, **prove the mechanism is present on
page X.** One `grep -c` would have prevented this.

This is the third instance of the same error class in one investigation, which makes
it a pattern rather than an incident:

| # | Wrong conclusion | Actual cause |
|---|---|---|
| 1 | "enterprise-ops: 0/10 anchors reachable" | the splash overlay was still up — a fixed wait, not a defect |
| 2 | "sasos-admin FAILS integration" | the test fixture threw; every module-auth page measured the login page |
| 3 | "verification-admin hits the Defect A fallback" | that file is not loaded by that page at all |

Each began with a real observation and an unverified inference about its cause.

**Companion rule, from the same investigation:** prove the instrument fires before
trusting a negative result from it. A silent instrumentation failure is
indistinguishable from "the application did not do that".

## Related

`docs/PRODUCTION_DENIAL_ROUTING_DEFECT.md` (Defect A) ·
`docs/ADMIN_RECERTIFICATION_BASELINE.md` · `docs/ROLE_AUTHORITY_CONVERGENCE_TRACK.md`
