# Admin Navigation & Device Certification — Batch 4: Operations

**Date:** 2026-08-25
**Scope:** 8 Operations pages
**Widths:** 1440 / 1280 / 1024 / 768 / 430 / 390 / 360

> **Not deployed.** Production HOLD stands. Indexes staged.

---

## Navigation — 8/8 PASS (72/72 checks)

`monitor.html` passed all nine including `inbound` and `correct-parent` — it has a real
registry path, not URL-only reachability.

---

## Responsive — 45/56 · 5 PASS · 1 PARTIAL · 2 BLOCKED · 0 NOT RUN

| Page | Result | Widths | Cause |
|---|---|---|---|
| `admin-os.html` | **PASS** | 7/7 | — |
| `ops-dashboard.html` | **PASS** | 7/7 | — |
| `reliability-center.html` | **PASS** | 7/7 | — |
| `monitor.html` | **PASS** | 7/7 | predicted BLOCKED — prediction was WRONG, see below |
| `fleet-monitor.html` | **PASS** | 7/7 | — |
| `ops-center.html` | **PARTIAL** | 4/7 | horizontal overflow <=430 (already in the remediation queue) |
| `admin.html` | **BLOCKED** | 3/7 | `#adminLock` (z-index 9999) stays up — dismissed only by its own success path behind the 3026 passcode |
| `merchant-pipeline.html` | **BLOCKED** | 3/7 | `#mp-gate` PIN second factor stays up — **reclassified from Batch-1 PARTIAL** |

---

## The BLOCKED prediction for `monitor.html` was WRONG

The auth-architecture scan predicted `monitor.html` would BLOCK. **It certified 7/7.**

Measured at 768px: the hamburger is the topmost element and there are **no fullscreen
overlays at all**. It does module-import Firebase (`getAuth`, `onAuthStateChanged` from
gstatic at `:387`) — but module-scoped auth alone does not block anything. Nothing was
covering the page.

The scan's "self-dismissed overlay" heuristic matched an id that is not a blocking overlay.
**Runtime result is authority; the prediction is not.** Recorded so the scan is read as
foresight, never as a certification result.

### The signal, corrected again

| Page | Module-imported auth | Default-visible blocking overlay | Result |
|---|---|---|---|
| `verification-admin.html` | yes | **yes** — `#va-auth-check` z-9999 | BLOCKED |
| `admin.html` | no (compat) | **yes** — `#adminLock` z-9999 + passcode | BLOCKED |
| `merchant-pipeline.html` | no (compat) | **yes** — `#mp-gate` PIN | BLOCKED |
| `monitor.html` | yes | **no** | PASS |
| `security-center.html` | no (compat) | no | PASS on auth |

**The blocking condition is the overlay, not the auth loader.** A page blocks when a
default-visible overlay is dismissed only by an authentication path the harness cannot
complete — whether that is a module-scoped auth instance OR a second factor. Module-imported
Firebase is neither necessary nor sufficient.

---

## `merchant-pipeline.html` reclassified: PARTIAL -> BLOCKED

Batch 1 recorded it PARTIAL, attributing the drawer failure to a transient splash race. That
was incomplete. Measured now: `#mp-gate` is `display:flex` — the PIN second factor is up, and
the harness cannot supply the PIN. The page cannot reach its post-auth layout by any
harness-legitimate means.

It moves OUT of the page-local remediation queue: it needs a real session plus the PIN, not a
CSS fix. `#mp-gate` must NOT be dismissed to make the drawer test pass — a second security
control stays a second security control.

### Splash finding, corrected

Two different elements were being conflated:

- `#sk-spl` — created by `splash.js`. **Absent on admin pages: the workspace suppression
  works.**
- `#sk-splash` — a DIFFERENT, transient element (present at 300ms and 1200ms, gone by
  2600ms) from another source.

The Batch-1 non-determinism was `#sk-splash`, not the splash the suppression targets. Either
way it is not `merchant-pipeline`'s blocker — `#mp-gate` is, deterministically.

---

## Marketplace leakage — 4 more, in the oldest consoles

| Page | Defect |
|---|---|
| `fleet-monitor.html:199` | `if(!claims.admin && !claims.superAdmin){ location.href="/" }` — denial dumping admins on the marketplace |
| `admin.html:678` | page logo pointed at `/` |
| `admin.html:686` | **a "🏠 Home" pill inside the admin nav bar** pointing at the marketplace, styled as an admin control beside Export / Refresh / Lock |
| `admin.html:6410` | denial panel "Back to SOKONI" -> `/`; now `account-centre`, matching the shared guard's denial panel |

The "Home" pill is the clearest instance yet of customer navigation masquerading as admin
navigation.

---

## AT-RISK stayed a prediction, not a verdict

`admin.html` and `ops-center.html` were flagged AT-RISK. Both certified **9/9 navigation**;
`admin.html` needed only the same inline-gate deferral every other console needed. Its
BLOCKED status comes from the passcode overlay, not from the AT-RISK flag.

---

## Nothing unified, nothing loosened

No Firebase instance consolidated. No claims check modified — every deferral touches only the
unauthenticated branch. `Number(c.role) || 0` untouched. `#adminLock` and `#mp-gate` left
authoritative.

Controls at the batch boundary: **35/35**. Registry validation: all checks passed.

---

## Running total

| | Pages | PASS | PARTIAL | BLOCKED | NOT RUN |
|---|---|---|---|---|---|
| Batch 1 (shell) | 9 | 6 | 2 | 1 | 0 |
| Batch 2 (Finance) | 10 | 6 | 4 | 0 | 0 |
| Batch 3 (Trust) | 5 | 2 | 2 | 1 | 0 |
| Batch 4 (Operations) | 8 | 5 | 1 | 2 | 0 |
| **Certified** | **27** | **17** | **8** | **3** | **0** |
| Remaining | 23 | — | — | — | NOT RUN |

Batch 1 and 4 overlap on 5 shared Operations pages; the totals above count each page once,
and `merchant-pipeline` is counted BLOCKED after reclassification.

Shell controls: **35/35** (5 pages).

---

## Related

`docs/ADMIN_AUTH_ARCHITECTURE_SCAN.md` · `docs/ADMIN_PAGE_LOCAL_REMEDIATION_QUEUE.md`
