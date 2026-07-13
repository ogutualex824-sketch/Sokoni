# SOKONI — Go / No-Go Report

**Date:** 2026-07-13 · **Build:** candidate
**Verdict:** 🔴 **NO-GO — and not because something is broken.**

> **Every critical workflow is UNVERIFIED, not FAILED.**
> The engineering is done. The evidence is not. Those are different words and this report
> keeps them apart on purpose.

---

## 1. Why this report exists

Engineering completion is not production readiness. On this platform that is not a slogan —
it is a measured fact, twice over:

| The instrument said | The truth was |
| --- | --- |
| Push: **"sent successfully"** | Delivered to **zero devices**, for months, every dashboard green |
| Add Product form: **"0px overflow, fits perfectly"** | Falling off the right edge of the user's screen |

Both times the tool measured the wrong thing and reported success. A green report is not
evidence. **Observation is.**

So the deliverable here is not a verdict — it is an **instrument honest enough to produce
one**.

---

## 2. Production Validation Mode

**`sokoni-validate.js` — OFF by default.** When off it defines a few no-ops and returns:
no patches, no listeners, no writes. **Verified**: with validation off, `fetch` is unpatched,
`firebase.functions` is unpatched, zero events recorded. It cannot touch a real customer.

Turn on: `https://mysokoni.co.ke/?validate=1` · Dashboard: `/validation.html` · Off: `?validate=0`

### How 523 call sites got instrumented without editing one

Every Cloud Function call on the platform goes through
`firebase.functions().httpsCallable(name)`. Validation mode wraps **that single seam**, so
every CF invocation is captured — name, payload (redacted), result, duration, and the full
error object on failure — with **no production code path edited**. Nothing can regress when
validation is off, because when it is off, nothing is wrapped.

Errors are **rethrown**, so the app behaves exactly as it always did.

### What it captures

- **Auth (§3):** firebase init · `getRedirectResult()` · auth state · **custom claims** ·
  **Firestore profile exists?** — with full error objects, never swallowed
- **Money path (§2):** every CF call with elapsed time; provider confirmation is recorded as
  `ok` **only when the provider actually confirms**
- **Push (§4):** recorded as **`queued`, never `ok`** — see §3 below
- **PO (§5):** the `delivery` field (`queued` / `failed` / `no_email_on_supplier`)
- **Mobile (§6):** viewport · **safe-area insets** · real header height · **horizontal overflow
  on every route** (the bug my own tools missed) · scroll container · standalone/PWA
- **Performance (§7):** FCP · LCP · CLS · INP · JS heap — flushed on **`pagehide`, not `unload`**
  (iOS Safari does not reliably fire `unload`, so metrics on `unload` are metrics you never get)
- **Service worker:** flags a **waiting** worker — *the session is running stale code*, which
  would silently invalidate the entire run
- **Errors (§9):** uncaught exceptions, unhandled rejections, failed fetches — code, message,
  details, stack. No generic messages

Secrets (PIN, card, OTP, token, password) are **redacted** before anything is logged — a trace
gets pasted into chats.

---

## 3. The one rule the dashboard enforces

> ### 🟡 "Queued" is not "delivered."

A push the server accepted. An email in a queue. A 200 from a provider. **None of these is
evidence that anything arrived.**

Push and PO delivery are recorded as **`queued` (🟡)** and **can only become 🟢 when you
confirm on the device**. That single distinction is what a green dashboard erased for months.

And a module nobody exercised shows **⚪ "not exercised" — never green.** Shipping on the
strength of tests that never ran is the failure mode this whole document is built to prevent.

---

## 4. Release gate — current state

**Nothing below can be closed from this machine.**

| # | Gate | Status | Why not verifiable here |
| --- | --- | --- | --- |
| 1 | Email authentication | ⬜ **Unverified** | Needs a real sign-in |
| 2 | Google authentication | ⬜ **Unverified** | Redirect chain; headless reCAPTCHA cannot score a bot |
| 3 | **Marketplace checkout, real M-Pesa** | ⬜ **Unverified** | **Zero orders have ever existed. This is SOKONI's first sale.** |
| 4 | Commission deducted correctly | ⬜ **Unverified** | No transaction has ever run |
| 5 | Seller settlement correct | ⬜ **Unverified** | No transaction has ever run |
| 6 | Order lifecycle completed | ⬜ **Unverified** | — |
| 7 | **Push received on device** | ⬜ **Unverified** | **Never once confirmed. Highest risk item.** |
| 8 | Email receipt delivered | ⬜ **Unverified** | SendGrid key is real; **no receipt has ever been sent** |
| 9 | Purchase Order emailed | ⬜ **Unverified** | **No PO has ever reached a supplier.** `procSuppliers` is **empty** |
| 10 | Maps load | ⬜ **Unverified** | Leaflet now first-party; unconfirmed on device |
| 11 | No critical mobile layout defects | ⬜ **Unverified** | Emulation is weakest exactly here |
| 12 | Service worker update behaves | ⬜ **Unverified** | Installed PWA may serve a stale worker |

**0 of 12 verified. 0 failed. 12 unverified.**

---

## 5. Pre-flight — do these before you pick up the phone

1. **`procSuppliers` is empty.** Gate 9 cannot run until a supplier exists (your own email + phone).
2. **The first purchase is real money.** Use a small amount. Make it **yours, deliberately** — not a customer's.
3. **Hard-refresh / reinstall the PWA.** If the SW is stale, every result below is about yesterday's build. Validation mode will tell you (`serviceWorker: a NEW worker is waiting`).

---

## 6. The session

1. iPhone → `mysokoni.co.ke/?validate=1` → orange banner appears with a **trace id**
2. Mac Safari → **Develop → [iPhone]** → the trace prints live to the console
3. Run gates **1 → 12 in order** (a failure early invalidates what follows)
4. `/validation.html` → **Copy trace JSON** → send it back

Every step arrives timestamped, correlated by one trace id, with elapsed time and the full
error object on any failure.

---

## 7. Risk

| Risk | Level | Note |
| --- | --- | --- |
| Push never confirmed on a device | 🔴 **High** | The exact bug that hid for months. Code is fixed; **delivery is unproven.** |
| Money path never executed | 🔴 **High** | 17 CI checks green, fails closed — **but it has never taken a shilling.** |
| PO never delivered | 🟠 Medium | Chain built and guarded; an email queue silently swallowed everything here before |
| iOS-specific UI | 🟠 Medium | Zoom, safe-area, swipe-back, PWA cache — what emulation reproduces worst |
| Historical financial damage | 🟢 **None** | **Zero orders ever existed.** P0-7 was fixed *before* the first customer |

---

## 8. Verdict

> ## 🔴 NO-GO
>
> Not because SOKONI is broken. Because **nothing critical has ever been observed working**,
> and I will not convert "the code is correct" into "the platform is ready" by asserting it
> more confidently.
>
> **Every one of the twelve gates is Unverified, not Passed.** That distinction is the entire
> point of this report.

One real-device session now conclusively determines launch readiness. The instrument is
built, it is honest, and it is off by default.

**Bring back the trace. If it is green, I will say so. If it is not, it will tell us exactly
where it stopped — which is worth far more than a green report that was never true.**
