# Quarantine baseline — pre-existing production failures

**Candidate:** `7296b0b` · **Live at time of measurement:** `8290102` · **Gate:** `PASS 185 FAIL 0 QUARANTINE 3 STALE 0 ENV 5 TIMEOUT 0` (APPROVED)

The gate calls its quarantine set *"genuine failure, untriaged — not blocking until classified."*
This document is that classification. It exists so the release record never reads as
`0 failures` when three suites genuinely fail — and equally, so those three are not mistaken
for regressions this release introduced.

**Verdict: all three fail identically at live `8290102`. None is a release regression.
None blocks. All three remain open defects in production today.**

Related: [[RELEASE_STATE]] · [[MERCHANT_2D2_QUEUE]]

---

## Method

Each suite was run twice: once on the candidate, once on `8290102` checked out into a
throwaway worktree. "Pre-existing" is a **measurement**, not an inference from the diff —
a suite can break without its own files changing, which is exactly how the seven cart and
wishlist suites went silent earlier in this release (`708e98c`).

---

## 1 · `test-overlays` — overlay z-index ratchet

```
legacy overlays with a hardcoded z-index below the header ROSE from 212 to 217
new body{overflow:hidden} scroll lock in: sokoni-book-service.js, sokoni-product-schema.js
```

| evidence | result |
|---|---|
| count at live `8290102` | **217** — identical |
| `sokoni-book-service.js`, `sokoni-product-schema.js` | untouched since live |
| `scripts/.overlay-baseline.json` (212, set at `a0b45e5`) | untouched by this release |

This release adds exactly one hardcoded z-index — `z-index:6` on an out-of-stock badge inside
a product card in `category.js` — and it does **not** contribute to the 217. If it did, live
would read 216. It reads 217.

**Impact:** a user may be unable to close an overlay on iOS Safari, where
`body{overflow:hidden}` can put a close button out of reach. Real, and live today.

## 2 · `test-icons` — brand asset gate

```
BLANK ICON: assets/favicon.png does not exist — referenced by earnings.html
6 page(s) do not use the canonical block: android-doctor.html, diagnostics.html,
earnings.html, merchant.html, my-orders.html
```

Every named file is untouched since live, and the suite fails identically at `8290102`.

**Impact:** blank or missing favicons on six pages. Cosmetic, live today.

## 3 · `test-auth-email` — misclassified, and should move

```
7 passed / 7 failed   at BOTH SHAs, same assertion list
root cause: signInWithEmailAndPassword -> auth/network-request-failed
```

The browser suite reaches the **real** Firebase Auth endpoint rather than the emulator, so it
cannot pass in this environment regardless of product state. Every downstream failure
(`same uid on re-auth`, `session persists`, `sendEmailVerification`) cascades from that first
network error.

This is **environment-dependent**, not a product defect: it belongs with
`test-merchant-visual-gate` and the other four ENV suites, not in quarantine. It is left in
quarantine here deliberately — reclassifying a suite out of the failing set is the gate
owner's call, and doing it inside a release would be indistinguishable from tuning the gate
to go green.

**Recommended follow-up:** add to `ENV_SIGNALS` / the ENV set in `gate-classify.js`, in its
own commit, outside a release window.

---

## What would make these block

Each ceases to be a baseline the moment it moves:

- `test-overlays` — the count exceeding **217**, or a new file joining the scroll-lock list.
- `test-icons` — any **additional** page losing the canonical block, or a new missing asset.
- `test-auth-email` — a failure that is **not** downstream of `auth/network-request-failed`.

A future run must compare against these numbers, not merely observe that the same three
suites are red. Three red suites is not the assertion; *these* three failing *this* way is.
