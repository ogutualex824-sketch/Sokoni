# SOKONI Release Validation Standard (RVS)
## Version 1.0 — Permanent Release Governance

**Status:** Permanent. Subordinate to [[PLATFORM_CONSTITUTION]], binding on every release.
**Ratified:** 2026-07-13
**Enforced by:** `scripts/test-rvs.js` (CI-blocking) · **Register:** `release-gates.json`

---

## Mission

> **Engineering Complete ≠ Production Proven.**
>
> Never confuse them.

No feature, module, integration or release is complete until it has **evidence**.

---

## The four states

Every gate is **exactly one** of these. There is no fifth, and there is no "probably fine".

| | State | Meaning |
| --- | --- | --- |
| ⚪ | **NOT EXERCISED** | Never tested. **No evidence exists.** Never report as PASS. |
| 🟡 | **ENGINEERING COMPLETE** | Built, reviewed, unit/integration/regression tests pass. **Still awaiting production evidence.** |
| 🟢 | **VERIFIED** | Executed in the intended environment. Evidence captured. Behaviour confirmed. Safe to release. |
| 🔴 | **FAILED** | Executed. Evidence captured. Expected behaviour **not** observed. Root cause documented. **Regression test added.** |

### The rule

> **A gate may not move from ⚪ NOT EXERCISED to 🟢 VERIFIED without execution.**

A gate may not be marked 🟢 without a non-empty `evidence` block. `scripts/test-rvs.js`
**fails the build** if either rule is broken. It is a gate, not a lint warning.

---

## Validation philosophy

|  | is **NOT** |  |
| --- | --- | --- |
| Queued | ≠ | **Delivered** |
| Accepted | ≠ | **Completed** |
| HTTP 200 | ≠ | **Business success** |
| Cloud Function success | ≠ | **User success** |
| Deployment success | ≠ | **Production success** |

**Always validate outcomes. Never only validate requests.**

### This is not theoretical here

This platform has been wrong about exactly this, twice:

| The instrument reported | The truth |
| --- | --- |
| Push: **"sent successfully"** | Delivered to **zero devices**, for months, every dashboard green |
| Add Product form: **"0px overflow, fits perfectly"** | Falling off the right edge of the user's screen |

Both times the tool measured a **request** and reported an **outcome**. The RVS exists so
that cannot be written down as a pass again.

---

## Traceability

Every validation session has **one Trace ID**.

- Every event belongs to that trace
- Every failure references that trace
- Every report links to that trace

Produced by `sokoni-validate.js` (`?validate=1`). Dashboard: `/validation.html`.

---

## Evidence

A gate marked 🟢 must carry:

```
timestamp · traceId · operator · environment · duration
logs · screenshots · cfResult · dbChange · userVisibleResult
```

**No evidence → no PASS.** Not "probably passed". Not "should work". **⚪.**

---

## The money path

Every step needs its own evidence. A green step with a red step beneath it is a lie.

```
customer paid → provider confirms → order created → inventory updated
→ ledger updated → commission correct → settlement correct
→ customer notified → merchant notified → refund path → dispute path
```

---

## Notifications & email

**Notifications:** do not validate *queued*. Validate **delivered · displayed · read ·
actioned**. The user must actually receive it.

**Email:** do not validate *202 Accepted*. Validate **delivered · rendered · links work ·
attachments correct · branding correct**.

---

## PWA

Validate **fresh service worker · offline · install · update · recovery · multiple devices**.

> A **waiting** service worker means the session is running **stale code** — and every
> result gathered in it is about yesterday's build. `sokoni-validate.js` flags this
> explicitly, because a validation run against the wrong build is worse than no run.

---

## Role validation

Validate **separately**: buyer · merchant · provider · driver · employer · administrator.

> **Never assume one role proves another.**

---

## Go / No-Go

**GO** — only when **every critical gate is 🟢 VERIFIED.**

**NO-GO** — if **any** critical gate is 🔴 FAILED **or** ⚪ NOT EXERCISED.

> **Never upgrade a release because engineering is complete.**
> Upgrade only when evidence exists.

---

## Constitution rule

> **Evidence always overrides assumptions.**
> **Real behaviour always overrides documentation.**
> **Verification always overrides reasoning.**
>
> **If reality disagrees with code — reality wins.**

---

## Success

A SOKONI release must be defensible **months later**. Anyone reading the report can answer:

1. What was tested?
2. Who tested it?
3. When?
4. Where?
5. What evidence exists?
6. Can it be reproduced?

**If those questions cannot be answered, the release is not ready.**

---

## Current state — v1.0.0-candidate

> ## 🔴 NO-GO
>
> **0 of 10 critical gates VERIFIED.**
> 9 × 🟡 ENGINEERING COMPLETE · 1 × ⚪ NOT EXERCISED (payments — **zero orders have ever
> existed; the money path has never taken a shilling**).

The engineering is done. **The evidence is not.** Those are different words, and this
standard exists to keep them apart.

Live register: `release-gates.json` · Report: `docs/GO_NO_GO.md`
