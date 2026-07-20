# SOKONI Defect Register

**Cycle closed:** 2026-07-20 · **Release Candidate:** NO-GO · **Certification:** INCOMPLETE

Status stays as recorded until new evidence contradicts it. Rejected items are
closed — they should not reappear as active investigations.

---

## VERIFIED FIXED

| # | Defect | Root cause | Commit |
|---|---|---|---|
| 1 | Any cart purchasable for KES 1 | `darajaSTKPush` passed the browser's `amount` to Safaricom with no catalogue lookup; the server recompute was skipped by an early return | `a4964b1` |
| 2 | Client could mint `status:"paid"` orders | `orders/create` required only `claimsOwner()`; `validOrderStatus()` whitelisted `paid`, and `onNewOrderCreated` gated fulfilment on those client-written fields | `f7825bc` |
| 3 | Daraja orders never decremented stock | The only decrement lived inside `verifyIntasendPayment` | `7ed9a6c` |
| 4 | Checkout threw after charging the customer | `_ckOrderId`, `_resetPlaceBtn`, `_ckikey` were called from six sites and defined nowhere | `1bbfb72` |
| 5 | POS privilege escalation, 18 handlers | `_requireSeller` validated the *type* of a client-supplied `sellerId`, never the caller's right to it | `9d31e09` |
| 6 | Reading a corrupt cart destroyed it | `catch { return [] }`, then the next write persisted the empty array | `ebb214f` |
| 7 | Cart persistence gated on a hidden `<ul>` | The save sat below an early return keyed on `#cartItems` | `57f2c82` |
| 8 | Badge never updated for the acting user | `storage` fires in every tab *except* the writer; `skNavRefresh` was called from one unrelated page | `c6fe893` |
| 9 | Category pages could not add to cart | Handlers existed and were exported; no control was ever rendered to reach them | `ab6e2fa` |
| 10 | Quick View dead code | Definition + export, zero call sites repo-wide | `85c0d0b` |
| 11 | Home section cards entirely inert | Click delegation attached only to `#productsContainer` | `46e0351` |
| 12 | Eleven category deep links coerced to "all" | A hand-written whitelist drifted from `categoryMeta` (25 vs 36 entries) | `01cc3f6` |
| 13 | Orphaned `beforeUserCreated` import | Residue of a deleted blocking function | `2bf0311` |
| 14 | Branch selection UX + identifier leak | One-branch merchants were blocked; Firebase error codes and Firestore doc ids were printed into the UI | `f414c8f`, `0b58c31` |

## VERIFIED — NO DEFECT FOUND

**15 · Shop Category selection** — `22ee4e7`

Reproduced in the authenticated harness on mobile WebKit *and* Chromium:
`swSelectCat` defined, inline `onclick` executes, `.sel` applies, `swData`
updates, no initialisation exception. Production bundle markers identical to
repository; service-worker versions match. **Closed.**

## REASONED BUT UNPROVEN

**16 · `workspaceMemberships` Firestore rule** — `0478bb1`

Collection had no match block, so it defaulted to deny and the workforce client
rendered an empty business switcher instead of reporting a fault. Rule written
(read-own, no client write) and diagnostics added.

Blocked on **JDK 21**. Twelve assertions are written and committed:

```
firebase emulators:exec --only firestore "node scripts/test-workspace-rules.js"
```

Do not promote to VERIFIED without that output. It widens permissions from
deny-all to read-own — least-privilege, but still a widening.

## HIGH CONFIDENCE — OPEN

**17 · Duplicate charge retry window**

Decomposes into three risks that were being conflated:

- duplicate **order** — resolved (`1bbfb72`, deterministic id)
- duplicate **inventory** — resolved (`7ed9a6c`, `inventoryApplied` inside the transaction)
- duplicate **charge** — **open**: two STK pushes both pending, both later completing. One order, correct stock, customer charged twice.

Fix shape: replace the read-then-throw pending query with a transactional claim
on a deterministic `posPayments` doc id. Payment is feature-frozen pending
IntaSend review; this is correctness, so it qualifies — but it needs
verification room.

## BLOCKED BY EXTERNAL DEPENDENCY

**18 · Authentication root cause.** `auth/internal-error` reproduced on
`mysokoni.co.ke` with **zero failing network requests** — which places the fault
server-side inside Identity Platform, the one segment the browser cannot see.
Leading hypothesis: a blocking function registered against a dead Cloud Run
service. One command decides it:

```
gcloud auth login && node scripts/auth-cert/index.js --layers 2
```

**19 · Branch-loading backend failure.** The UI no longer leaks identifiers, but
the underlying load genuinely failed with a Firebase internal error. Needs an
authenticated session to trace.

## REJECTED WITH EVIDENCE

| Hypothesis | Evidence |
|---|---|
| App Check as auth root cause | HTTP 200, valid JWT, both production origins |
| authDomain mismatch | both `__/auth/handler` endpoints → 200 |
| Authorized domains | server returned all six, incl. all three production hosts |
| Shop Category implementation defect | reproduced working in both engines |
| Stale service worker | prod and local both `sokoni-20260719-app-shell-v98` |
| Production bundle divergence | 1-byte delta; all four category markers identical |

---

## Certification

```
Layer 1  PASS (7/7 CERTIFIED)
Layer 2  SKIPPED — no credentialed gcloud account
Layer 3  SKIPPED — requires a working sign-in
VERDICT  INCOMPLETE
```

`INCOMPLETE` is a release blocker, not a pass. Fifteen defects are fixed in the
repository and **none are deployed** — production still runs the client-priced
payment path, the permissive order rules, and the POS escalation.

## Next cycle

1. `gcloud auth login` → Layer 2 → items 18, 19
2. JDK 21 → emulator suite → item 16
3. Item 17 hardening
4. Deploy per [GO_LIVE_RUNBOOK.md](GO_LIVE_RUNBOOK.md) — **hosting → functions → rules**; reversing the last two rejects every live checkout
5. Re-certify against production

No new feature development until these are complete.
