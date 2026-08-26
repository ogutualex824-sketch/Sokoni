# 🔴 Defect A — `sokoni-admin-entry.js` falls through to `/`

> **Scope note:** this record covers **Defect A only**. A separate, unrelated redirect
> to `/` on `verification-admin.html` is tracked as **Defect B** in
> `docs/DEFECT_B_VERIFICATION_ADMIN_REDIRECT.md`. They share a symptom, not a mechanism.

**Found:** 2026-08-26, during Admin integration certification
**Class:** production security/routing. **NOT** an Admin-programme regression.
**Status:** 🔴 OPEN — logged, deliberately not fixed inside the Admin candidate
**Track:** production defects / role-authority convergence — **not** the Admin release

---

## The defect

`sokoni-admin-entry.js` can fall through to `/` when leaving or resolving an
administrative surface. Proven for a signed-in **non-admin** on `admin-os.html`.

### RETRACTION 2026-08-26 — an incorrectly attributed second path

> This record previously claimed a second path: an **authorised admin** on
> `verification-admin.html` reaching the same `RA.hubFor(role)` fallback.
> **That attribution was false and is withdrawn.**
>
> `verification-admin.html` loads `sokoni-admin-entry.js` **0 times** and
> `sokoni-role-authority.js` **0 times**. The mechanism blamed for its behaviour is
> not present on that page at all. The symptom (`→ /`) was observed and attributed
> to a mechanism found on a *different* page, without checking whether that
> mechanism was even loaded there.
>
> `verification-admin.html` is now tracked separately as **Defect B**, mechanism
> **UNIDENTIFIED**. The two must not be merged until B's mechanism is proven.

### The one PROVEN path

| Actor | Page | Observed |
|---|---|---|
| signed-in **non-admin** | `admin-os.html` | `RA.hubFor(role)` yields nothing → `/` |

The `hub || '/'` fallback is proven **only** for the `sokoni-admin-entry.js` path
currently observed on `admin-os.html`. No other caller has been demonstrated to
reach it.

## Blast radius — THREE pages, measured

`sokoni-admin-entry.js` is loaded by exactly **3** pages:

| Page | Loads entry primitive | Proven to reach the fallback |
|---|---|---|
| `admin-os.html` | yes | **yes** (non-admin) |
| `admin.html` | yes | not observed |
| `super-admin.html` | yes | not observed |

An earlier version of this record said the primitive was loaded by "admin surfaces
generally". **That was wrong** — it is three pages, and the other two have not been
observed reaching the fallback. Scope is measured, not inferred.

## Why it matters

It violates the standing invariant:

> Admin denial must remain in the Admin workspace, or go to login with the
> intended destination preserved.

`'/'` does neither, and it discards `?next=`, so the user cannot resume the trip
they attempted.

**The compliant pattern already exists in the same codebase** —
`sokoni-permissions.js:505`:

```js
window.location.href = `login.html?next=${encodeURIComponent(window.location.href)}`;
```

So production carries both a compliant and a non-compliant denial route. This is
not a theoretical concern.

## Evidence that it is PRE-EXISTING, not Admin-caused

| | |
|---|---|
| `admin-os.html` at HEAD | **0** redirects to `/` |
| Behaviour with Admin wiring | dumps to `/` |
| Behaviour without Admin wiring | dumps to `/` |
| Owning file | `sokoni-admin-entry.js` — production's own, absent from the branch |

The Admin programme neither causes nor changes it.

## Do NOT fix inside the Admin candidate

Fixing it there would contaminate the integration evidence that separates
Admin-introduced defects from pre-existing production behaviour. Log, preserve,
address on the production/role-authority track.

---

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

## Related finding — a CLIENT-side role authority exists

`sokoni-role-authority.js` is present in production and **absent from the branch**.
The role-authority convergence track (`docs/ROLE_AUTHORITY_CONVERGENCE_TRACK.md`)
recorded only the **server-side** divergence (`functions/role-authority.js` vs the
16 direct `setCustomUserClaims` call sites). **There is a second, client-side
authority layer**, and this defect runs through it via `RA.hubFor()`.

That widens the convergence track: any canonical-authority decision must account
for the client layer as well as the server one.

---

## Harness lesson — a silent instrumentation failure is not a negative result

An earlier probe reported *"redirect is not via `location.href`/`assign`/`replace`"*.
**That was wrong** — it is `location.href`.

The probe used
`Object.getOwnPropertyDescriptor(Location.prototype, 'href')`, which is not
reliably configurable in Chrome. The redefinition threw, a `try/catch` swallowed
it, and the probe reported **absence of evidence as evidence of absence**. The
real cause was found by reading the shared scripts, not by the instrument.

**Rule:** prove the instrument fires before trusting a negative result from it.

## Related

`docs/ROLE_AUTHORITY_CONVERGENCE_TRACK.md` · `docs/ADMIN_RECERTIFICATION_BASELINE.md` ·
`sokoni-admin-entry.js` · `sokoni-role-authority.js` · `sokoni-permissions.js`
