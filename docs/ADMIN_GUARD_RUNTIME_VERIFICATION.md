# Admin Guard — Runtime Verification

**Date:** 2026-08-25
**Branch:** `fix/algolia-batch-poisoning`
**Target:** local `node server.js` @ `127.0.0.1:3000` — the working tree, **not** production.
**Tool:** Playwright (Chromium), repo-local.

> Production is `c774608` and `/sokoni-admin-guard.js` there returns the 404 fallback.
> The changes under test are **not deployed**. Verifying against `mysokoni.co.ke` would
> have tested the OLD code — a false pass. See [[reference_production_domain]].

---

## Result summary

| # | Path | Result | Credentials needed |
|---|---|---|---|
| 1 | Admin happy path | **BLOCKED** | real admin/superAdmin session |
| 2 | Denial path (authenticated non-admin) | **BLOCKED** (partial pass, see §2) | real non-admin session |
| 3 | Signed-out path | **PASS** — 8/8 | none |
| 4 | Logo / header regression | **PASS** — with negative control | none |
| 5 | Admin action regression (control flow) | **PASS** — stubbed, both directions | real session for CF round-trip |

---

## 3. Signed-out path — PASS (8/8)

Fresh browser context per page, no storage. Every guarded console redirected to login
with the destination preserved, and **zero page errors** across all eight.

| Console | Landed |
|---|---|
| `admin-os` | `/login.html?next=%2Fadmin-os.html` |
| `enterprise-ops` | `/login.html?next=%2Fenterprise-ops.html` |
| `ops-center` | `/login.html?next=%2Fops-center.html` |
| `ops-dashboard` | `/login.html?next=%2Fops-dashboard.html` |
| `admin-feedback` | `/login.html?next=%2Fadmin-feedback.html` |
| `beta-control` | `/login.html?next=%2Fbeta-control.html` |
| `beta-dashboard` | `/login.html?next=%2Fbeta-dashboard.html` |
| `reliability-center` | `/login.html?next=%2Freliability-center.html` |

**`enterprise-ops` specifically confirmed fixed** — it previously bounced to `/index.html`,
discarding the destination.

Both param spellings are honoured (`auth.js:48`, `const next = sp.get('next') || sp.get('redirect')`),
so pages redirecting via their own older `?redirect=` guard also preserve the destination.

### Probe corrections made during this run

Two probes produced wrong answers before the results above were trusted:

1. An `innerText`-based "leak" metric reported an identical `476` on four pages — the
   uniform-result signal. It was measuring the **login page** after a fast redirect, not
   the guarded document.
2. A second probe aborted the login redirect to hold the page still. That blanked the
   document, so "nothing rendered" masqueraded as "nothing exposed" (`0/25` everywhere).

Per [[feedback_uniform_failure_suspect_the_probe]], both were discarded rather than
reported. The final probe holds the guard **unresolved** by blocking `firebase.js`, which
keeps the document intact inside the exact window of concern.

---

## 2. Pre-guard exposure — partial pass

With the guard held unresolved, `elementFromPoint` sampled a 5×5 grid to ask what is
actually *visible* (not merely present in the DOM — the guard paints an opaque fixed
overlay, so DOM presence is not exposure).

| Console | Overlay | Grid covered |
|---|---|---|
| `admin-os` | yes | **25/25** |
| `ops-dashboard` | yes | **25/25** |
| `admin-feedback` | yes | **25/25** |
| `beta-control` | yes | **25/25** |
| `reliability-center` | yes | **25/25** |
| `enterprise-ops` / `ops-center` / `beta-dashboard` | n/a | redirect to login before admin content renders |

**Control:** `index.html` (unguarded) reported `0/25` with visible text — proving the probe
can detect exposure when it exists.

**Still blocked:** this covers the signed-out case. The case that matters most — an
*authenticated non-admin* — needs a real non-admin session and has NOT been exercised.

---

## 4. Logo / header — PASS

### Main header `#sk-nav-logo img` — unchanged, as intended

| Viewport | Rendered | object-fit | Aspect fidelity |
|---|---|---|---|
| desktop 1600 | 42 × 28 | `contain` | **1.000** |
| desktop 1024 | 42 × 28 | `contain` | **1.000** |
| mobile 390 | 36 × 24 | `contain` | **1.000** |

### Workspace bar `#sk-ws-bar-logo img` — now contains

Tested against the CSS `shared-header.js` actually injects at runtime, using synthetic
4:1 and 1:1 logos.

| Logo | Box | Rendered | object-fit | Fidelity | Verdict |
|---|---|---|---|---|---|
| wide 4:1 | 26×26 | 26 × 6.5 | `contain` | **1.000** | fits, aspect preserved |
| square 1:1 | 26×26 | 26 × 26 | `contain` | **1.000** | fits, aspect preserved |

**Negative control** — the pre-fix rule re-applied in the same harness:

| Rule | Rendered | object-fit | Fidelity | |
|---|---|---|---|---|
| NEW (current) | 26 × 6.5 | `contain` | 1.000 | correct |
| OLD (`width/height:100%` + `cover`) | 26 × 26 | `cover` | **0.250** | cropped — probe detects it |

A 4:1 logo squashed to 1:1 is exactly fidelity 0.25, so the test is measuring the real
property and would fail if the fix regressed.

---

## 5. Admin action control flow — PASS (stubbed)

The Firebase SDK was stubbed in a local harness so the closure-internal `_call()` could be
made to resolve or reject on demand. **No real claim was minted and no production
authority was touched** — only the SDK surface was replaced.

| Action | Backed by | CF/DB rejects | CF/DB resolves |
|---|---|---|---|
| `moderateReview('approve')` | callable | error only — **no false success** | "Review approved" |
| `moderateReview('reject')` | callable | error only — **no false success** | "Review rejected" |
| `updateProduct` | callable | error only — **no false success** | "Product status updated" |
| `revokeSession` | Firestore | error only — **no false success** | "Session revoked" |
| `approveRequest` | Firestore | error only — **no false success** | "Request approved" |
| `rejectRequest` | Firestore | error only — **no false success** | — |

### Probe correction

The first run reported `revokeSession` and `approveRequest` as FAILING. That was a harness
artifact: those two paths use Firestore directly, and the stub only made *callables*
reject while Firestore always resolved. Once the Firestore stub was made to throw, both
passed. The failure was in the test, not the code.

### Incidental fix

`sokoni-aos.js` toasted **"Review rejectd"** (`action + "d"`). Now maps
approve/reject/restore to their correct past tense.

---

## What is still NOT proven

1. **Admin happy path (§1).** No guarded console has been loaded by a real admin. The
   guard fails **closed**, so a claim-shape or timing error would present as a locked-out
   administrator. This is the highest-risk untested path and gates deploy.
2. **Authenticated non-admin denial (§2).** The denial panel and its workspace links have
   never rendered against real claims.
3. **Real CF round-trip (§5).** `adminModerateReview` has not been called against the live
   function, so the `ratingsSummary` recalc remains unproven end-to-end.

Per [[project_release_validation_standard]], the guard is **engineering-complete and
partially runtime-proven — not production-proven.** Do not deploy on this evidence alone.

### To close the gap

A real admin (or superAdmin) session and one non-admin session, in a browser, against a
build carrying these changes. Credentials must come from the operator —
[[project_cert_persona_layer]] is explicit that creds are never invented and superAdmin is
never self-minted to satisfy a test.

---

## Related

[[project_admin_console_integrity]] · [[project_release_validation_standard]] ·
[[feedback_uniform_failure_suspect_the_probe]] · [[feedback_measurement_validity]] ·
[[project_cert_persona_layer]] · Audit: `docs/ADMIN_ROUTING_NAVIGATION_AUDIT.md`
