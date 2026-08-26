# superadmin.html — end-to-end remediation

**Date:** 2026-08-26
**Branch:** `fix/algolia-batch-poisoning`
**Scope:** this file only. The frozen 50-page evidence in
`docs/ADMIN_CERTIFICATION_FROZEN.md` is **not** mutated by this work.

> Treated as an **active remediation target**, not merely a retirement artifact:
> while it is reachable and precached, leaving a broken privileged console is not
> acceptable. Order followed: parse → auth → operations → routing → layout →
> 7-width certification → retirement decision.

---

## 1. Parse — FIXED

`superadmin.html:861` contained:

```js
this.toast('Export queued — you'll receive a download link shortly')
```

The apostrophe in `you'll` terminated the single-quoted string. This is a **syntax
error**, so the browser discarded the **entire 429-line module** — not just this
handler. Every operation on the page was dead.

Verified identical at `git HEAD`: **pre-existing**, not introduced by this programme.
Fixed by double-quoting with an escaped apostrophe. `node --check` on the extracted
module now passes.

## 2. Auth — TIGHTENED

The gate accepted `admin` **or** `superAdmin`, which was weaker than the comment
above it claimed and weaker than the registry authority, `super-admin.html`, and
this page's own stated contract (audit D4). Now strict:

```js
if (token.claims.superAdmin !== true) { _showDenied('Super Admin access only'); return; }
```

Denial routes to `admin-os.html?error=insufficient_privileges` — inside the admin
workspace, never `/`, `index.html` or `seller.html`.

## 3. Operations — DELEGATED TO THE CANONICAL AUTHORITY

Two privileged operations were broken. Both now call the canonical server
contracts, so role management and suspension have **one** authority rather than
two implementations drifting apart.

| Op | Was | Now |
|---|---|---|
| `grantRole` | `setUserRole({email, role})` | resolve email → uid, then `{uid, role}` |
| `revokeRole` | `setUserRole({email, role:'buyer'})` | `{uid, role:'buyer'}` — the uid was already in hand and was being thrown away |
| `suspendUser` | `updateDoc(users/{uid}, {suspended:true})` | `httpsCallable('suspendUser')({uid, suspend:true})` |

**Why each was a real defect, not a style issue:**

- `functions/super-admin.js:110` destructures `const { uid, role } = request.data`.
  It has **no email→uid lookup**. Sending `{email, role}` produced
  `INVALID_ARGUMENT`, so **every grant and every revoke failed** — while the UI
  reported success. This is the fire-and-forget false-success pattern.
- The suspend path wrote `users.suspended` directly. **No auth path reads that
  field.** A "suspended" user kept a valid session and full access. The canonical
  callable runs `updateUser({disabled:true})` and actually ends the session.

The page's UI collects an **email**, so a `_uidForEmail()` resolver was added
(`users` where `email ==`, `limit(2)`). It returns null for no match so the
operator is told, and throws on a duplicate address rather than guessing which
account to modify.

## 4. Routing — PASS 9/9

`node scripts/certify-admin-navigation.js --pages superadmin.html`

registry-entry · correct-parent · home-path · parent-link · siblings ·
active-state · no-bad-fallback · deep-link · inbound — **all ok**.

Outbound links are `admin-os.html?error=insufficient_privileges`, `monitor.html`,
and the new canonical link. No `/`, no marketplace, no seller chrome; consumer
injectors are suppressed by `data-sokoni-workspace="admin"`.

Added a **LEGACY** badge and a one-click `Canonical Super Admin →` link to
`super-admin.html`, so an operator who lands here can see the page's status and
reach the canonical console — without this page linking itself back in as a
competing root.

## 5. Layout — `min-width: 0` applied PROACTIVELY

`.sa-topbar` / `.sa-topbar-right` now carry `flex-wrap: wrap` and `min-width: 0`.
Applied **before** any certification failure, not after: `min-width: auto` on flex
children accounted for **six** responsive defects elsewhere in this programme, and
a nowrap topbar holding a badge, a link and an avatar is exactly that shape.

## 6. Seven-width certification — **BLOCKED** (not PASS, not PARTIAL)

The harness reports 3/7. **That number must not be recorded as a layout result.**

Direct measurement shows `#saShell` computes `display: none` for the **entire**
run — the page's own content never renders, because the gate requires a real
superAdmin session and this page authenticates through an **ES-module**
`getAuth(app)`, which a `window.firebase` compat stub cannot reach.

So the harness measured **only the shared shell chrome and the gate**. The 3/7
"ok" rows say nothing about this page's topbar or panels. This is the same
"measured the wrong document" trap that invalidated the earlier index scroll PASS,
and it is recorded as **BLOCKED**, not rounded up.

**The 4 mobile-width `drawer` failures are not a defect.** Observed at 390px:

| Observation | Value |
|---|---|
| `#sk-adm-burger` | exists, 44×44, visible at (10,8) |
| topmost element at the burger's centre | `DIV#saGate` |
| `#saGate` | z-index **100010**, `pointer-events: auto`, full-height |
| drawer on a direct click | `left: -300 → 0` — **mechanism works** |

The drawer is wired correctly; the **security overlay** intercepts the pointer.
`#saGate` was **not dismissed** — dismissing it would invalidate the exact
property being protected.

**Component geometry** (`setContent` on the extracted topbar markup — the product
file untouched, explicitly *not* a page certification) is clean at
**1440/1280/1024/768/430/390/360**: no document overflow, no child spilling the
topbar box, canonical link ≥44px at every width.

> *Probe note:* that harness also printed a `wraps` column derived from distinct
> child `top` values. It is **invalid** — vertically-centred children of different
> heights have different `top` values without wrapping. It did not feed the
> verdict, which used overflow/spill/tap-size only.

**Resolution is a real superAdmin session**, the same standing gate that governs
the other BLOCKED surfaces. Not a code change.

## 7. Retirement — decision unchanged, now SAFE to sequence

Preference remains **B**: remove the SW precache entry → one-hop redirect to
`super-admin.html` → verify zero consumption → delete.

What changed is the risk profile. Previously this page was a **broken privileged
console** that was reachable and precached; retirement was racing a live defect.
It now parses, gates strictly on `superAdmin`, and delegates both privileged
operations to canonical server contracts — so the retirement can proceed on
evidence rather than urgency.

**Still gated on:** deployment, which remains on HOLD.

---

## Files changed

| File | Change |
|---|---|
| `superadmin.html` | parse fix; strict `superAdmin` gate; canonical `{uid,…}` contracts + `_uidForEmail()`; LEGACY badge + canonical link; `flex-wrap`/`min-width:0` |

No change to `functions/`, the registry, the shared shell, or the frozen evidence.

## Related

`docs/ADMIN_SUPERADMIN_DUPLICATE_DECISION.md` · `docs/ADMIN_CERTIFICATION_FROZEN.md` ·
`docs/ADMIN_BLOCKED_REGISTER.md`
