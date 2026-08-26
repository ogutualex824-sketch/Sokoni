# Admin Certification — BLOCKED Register

**Opened:** 2026-08-25
**Membership is DERIVED, not hand-maintained (2026-08-26).**

> The authoritative BLOCKED list comes from `docs/admin-certification-ledger.json`
> (observations) plus `docs/admin-certification-causes.json` (cause + evidence),
> reconciled by `scripts/derive-certification-summary.js`, which **fails** rather
> than printing a table if the two disagree.
>
> This replaced a hand-maintained table that had drifted in two directions at once:
> it listed `search-quality.html`, which certifies **PASS 7/7**, and omitted
> `superadmin.html`, which does not. The total of 11 was right only because one
> wrong entry cancelled one omission — the kind of error a count cannot reveal.
>
> This file keeps the per-page DO-NOT-DISMISS rationale. It is **not** the source
> of membership. Do not add or remove pages here by hand.

> ## READ THIS BEFORE "FIXING" ANY BLOCKED PAGE
>
> **BLOCKED is not a backlog item. It is not a weaker PASS. It is not a defect.**
>
> Every page here is blocked because a **security control is working as designed**. The
> certification harness cannot legitimately complete that page's authentication or
> second-factor flow, so it cannot observe the post-auth layout.
>
> **Do not remove, hide, or auto-dismiss any overlay listed here to make a dashboard go
> green.** Doing so would reveal an admin console before its own authorization completed.
> That trade — a security control for a green check — is never correct.
>
> These pages are resolved by **real authenticated-session verification**, not by code changes.

---

## The taxonomy

| Result | Meaning | Resolution |
|---|---|---|
| **BLOCKED — security control intentionally retained** | A page-owned overlay stays authoritative because the harness cannot complete that page's auth or second factor | Real session. **No code change.** |
| **PARTIAL — product/UI defect** | A measurable layout or navigation defect in the page | Fix the page. See the remediation queue. |

The distinction matters because both appear as "not PASS" on a summary. Conflating them
invites someone to close a BLOCKED row by deleting the very control that caused it.

### The narrow rule (corrected twice by evidence)

> A page is responsive-test BLOCKED when an **authoritative page-owned overlay remains
> active** and the harness **cannot legitimately complete that page's authentication or
> second-factor flow**.

Firebase module scope is **contextual evidence only**, never the predictor. Two of the three
blocked pages use the compat shim, and `monitor.html` module-imports Firebase yet certified
**7/7** because nothing was covering it.

| Page | Module-imported auth | Blocking overlay | Result |
|---|---|---|---|
| `verification-admin.html` | yes | **yes** | BLOCKED |
| `admin.html` | no (compat) | **yes** | BLOCKED |
| `merchant-pipeline.html` | no (compat) | **yes** | BLOCKED |
| `monitor.html` | yes | **no** | **PASS 7/7** |

**The overlay is the blocking condition, not the auth loader.**

---

## Register — 3 pages

### `verification-admin.html` — BLOCKED (security control retained)

| | |
|---|---|
| **Overlay** | `#va-auth-check`, z-index 9999, visible by default |
| **Why the harness cannot pass it** | The page initialises its OWN named Firebase app (`initializeApp(FB_CFG, "sokoni-va")`) and gates on that instance. The harness replaces `window.firebase`, which this module-scoped instance never consults. |
| **Dismissed by** | The page's own success path, after `claims.admin === true` |
| **Certified** | Batch 3 — navigation 9/9 PASS, responsive 3/7 |
| **DO NOT** | Add `va-auth-check` to the shared guard's dismiss list. That clears a gate overlay before the page's own authorization has verified. |

### `admin.html` — BLOCKED (security control retained)

| | |
|---|---|
| **Overlay** | `#adminLock`, z-index 9999, visible by default |
| **Why the harness cannot pass it** | Dismissal requires the **3026 master passcode** — a deliberate SECOND FACTOR layered after the admin claim. The harness has no legitimate way to supply it. |
| **Dismissed by** | The page's own success path, after claim verification **and** passcode entry |
| **Certified** | Batch 4 — navigation 9/9 PASS, responsive 3/7 |
| **DO NOT** | Auto-dismiss `#adminLock`. The passcode is the control; bypassing it to see the dashboard defeats its entire purpose. |

### `merchant-pipeline.html` — BLOCKED (security control retained)

| | |
|---|---|
| **Overlay** | `#mp-gate`, PIN prompt, `display:flex` by default |
| **Why the harness cannot pass it** | Requires a **PIN second factor** after the verified admin claim. |
| **Dismissed by** | `_mpAuth()`, only after `SokoniAdminGuard.verified` resolves AND the PIN matches |
| **Certified** | Batch 4 — navigation 9/9 PASS, responsive 3/7. **Reclassified from Batch-1 PARTIAL.** |
| **DO NOT** | Dismiss `#mp-gate`. This page previously had TWO real authorization bypasses (J2); the PIN is what remains of its layered defence. A verified admin claim is exactly what makes the second factor meaningful. |

---

## What "resolved" looks like

A row leaves this register **only** when a real authenticated session — with the second factor
where one exists — has been used to certify the page. That is the same real-session work
already tracked as a release blocker.

It does **not** leave this register because:

- the overlay was removed
- the overlay was auto-dismissed by shared code
- the harness was taught to click past it
- someone decided the dashboard should be all green

---

## Related

`docs/ADMIN_PAGE_LOCAL_REMEDIATION_QUEUE.md` (genuine PARTIAL defects — a different thing) ·
`docs/ADMIN_AUTH_ARCHITECTURE_SCAN.md` · `docs/ADMIN_BATCH4_OPERATIONS_CERTIFICATION.md`
