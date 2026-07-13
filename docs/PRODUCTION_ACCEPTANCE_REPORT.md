# SOKONI — Production Acceptance Report

**Build:** candidate release · **Date:** 2026-07-13
**Service worker (live == repo):** `sokoni-20260713-leaflet-local-v65`
**Status:** ⛔ **NOT SIGNED OFF — and I cannot sign it off.**

---

## 0. The honest constraint, first

**I cannot execute this PAT. I have no iPhone, no Safari, and no way to tap anything.**

Every acceptance criterion in the brief is gated on *"verified on the real iPhone… do not rely
solely on emulators or headless tests for sign-off."* That rules me out by construction.

This is not modesty. It is the specific failure mode this project has already hit **twice today**:

| What my tools said | What was actually true |
| --- | --- |
| Add Product form: **"0px overflow, fits perfectly"** | It was falling off the right edge of your screen |
| Push notifications: **"sent successfully"** | Delivered to **zero** devices, for months, every dashboard green |

Both times, headless verification and reality diverged. A PAT I run headlessly would be a
**third** instance of the same mistake, wearing a report as a disguise.

So this document does the one useful thing I *can* do: **establish every fact that does not
require a device**, so your device session is spent testing, not discovering setup problems.

**Sign-off is yours. Nothing below may be marked ✅ until you have done it on the phone.**

---

## 1. Ground truth — verified server-side (no device needed)

These are facts, checked against **live production** today.

| Check | Result |
| --- | --- |
| Service worker live == repo | ✅ `…leaflet-local-v65` (no stale SW) |
| IntaSend public key live | ✅ `ISPubKey_live_72b29717…`, `intasendLive: true` — **checkout can take real money** |
| `verifyIntasendPayment` deployed | ✅ |
| `onNewOrderCreated` / `emailOnOrderCreated` deployed | ✅ (both now payment-gated) |
| `notifySend` / `orderAdvance` deployed | ✅ |
| `createPurchaseOrder` / `addSupplier` / `sendPurchaseOrder` | ✅ |
| `processEmailQueue` deployed | ✅ (runs every 5 min) |
| SendGrid API key | ✅ real (`SG.…`) — email **can** actually send |
| **Orders ever created** | **0 — none, ever. SOKONI is pre-revenue.** |
| Products to buy | ✅ exist |
| User accounts | ✅ exist |
| **Suppliers (`procSuppliers`)** | ❌ **EMPTY — must create one before the PO test** |

> **I nearly reported the IntaSend key as missing.** My grep used the wrong field name.
> The key is present and live. Checked before claiming — which is the standard this whole
> document is trying to hold.

---

## 2. Per-priority status

Nothing is ✅ until it is ✅ **on the phone**.

| # | Area | Pre-verified (server / code) | Needs the device |
| --- | --- | --- | --- |
| 1 | **Authentication** | App Check enforced; auth CFs live | ⬜ Google redirect chain, email/password, logout, session restore after browser restart, account deletion, password reset |
| 2 | **Commerce** | Money path fails **closed**; 17 CI checks; IntaSend live; order triggers payment-gated | ⬜ **The first real purchase.** Browse → cart → checkout → M-Pesa → order → notifications → inventory → receipt |
| 3 | **Procurement** | Full chain wired; PDF generator validated (xref parsed); SendGrid real | ⬜ **No PO has ever been sent.** Needs a supplier created first |
| 4 | **Push** | Token bug fixed; engine is the one entry point | ⬜ **Never once confirmed on a real device.** This is the highest-uncertainty item |
| 5 | **Mobile UI** | Sticky bars, forms, tiles fixed and measured headlessly | ⬜ **Emulation is weakest exactly here** (iOS zoom, safe-area, PWA cache) |
| 6 | **Navigation** | History floor; deep links; Home fix live | ⬜ **iOS swipe-back** — the one gesture emulation cannot reproduce |
| 7 | **Service worker** | Live == repo (v65); no stale SW | ⬜ Offline behaviour, cache eviction, no stale HTML **in the installed PWA** |
| 8 | **Performance** | — | ⬜ FCP/LCP/TTI **must be measured on the device**, not estimated. I will not invent numbers |

---

## 3. Device runbook — ordered so failures surface early

Run **in this order**. Each step is a prerequisite for the next; a failure here stops the line.

### Before you start
1. iPhone → Safari → `mysokoni.co.ke` → **hard refresh** (or delete + reinstall the PWA).
   *The installed PWA may still be serving an older worker; nothing below is meaningful until it isn't.*
2. Mac → Safari → **Develop → [your iPhone] → mysokoni.co.ke**. This gives you the real
   console and network log. **Screenshot every failure with the console open** — a red
   console line is the root cause; a screenshot of a stuck page is not.

### P1 — Authentication (5 min)
- Sign in with Google. Watch for: redirect → Firebase → **profile written to Firestore** → dashboard.
- Force-quit Safari. Reopen. **Still signed in?**
- Sign out. Sign in with email/password. Password reset. Account deletion **last** (it's destructive).

> ⚠️ Headless runs showed a **403 on `exchangeRecaptchaV3Token`** and *"Security verification failed."*
> In headless that is **expected** (reCAPTCHA cannot score a bot) and I did **not** treat it as a defect.
> **If you see that message on the real phone, stop and tell me** — that would be a genuine App Check bug.

### P2 — The first real purchase (the big one)
This will be **SOKONI's first order ever**. Use a **small real amount**. It should be **yours, deliberately** — not a customer's.

Watch, in order:
1. Browse → add to cart → checkout
2. M-Pesa STK prompt arrives **on your phone**
3. Enter PIN → **order appears with `status: "paid"`**
4. **Seller notified** · **buyer notified** · **push lands on the lock screen**
5. Inventory decremented · receipt · order history · dashboard

> **If the order is created but `status` is anything other than `paid`, that is my fix working
> as designed**, not a bug: unverified payments are `pending_payment` and must not ship.
> Tell me the status value and I will trace it.

### P3 — Procurement
1. **Create a supplier first** (`procSuppliers` is empty) — use **your own email and phone**.
2. Add one line item → **Send PO**.
3. Expect: PDF in your inbox (attachment, not a formatted email) **+ an SMS pointing at it**.
4. The PO document carries a `delivery` field — `queued` / `failed` / `no_email_on_supplier`.
   **That field tells us exactly where it stopped** if it does.

### P4 — Push (highest uncertainty)
Two devices if you can. Trigger: new order, payment, message, PO.
**Confirm it lands on the lock screen — not that a queue row was written.** Queue insertion is
precisely what lied to us for months.

### P5–P6 — Mobile UI + Navigation
- Services → scroll → **"List My Service" stays put and responds**
- Seller dashboard → tap a tile (Add Product / Orders / Analytics)
- **Add Product → tap into a field → the page must not zoom or lurch sideways**
- Organizer → Analytics → **swipe back** → should land on Dashboard, **not out of the app**
- Home button from any page
- Healthcare / Legal / Property / Event hubs

### P7–P8 — SW + Performance
- Airplane mode → navigate → correct offline page, **no stale HTML**
- Safari Web Inspector → **record real FCP / LCP / TTI**. Paste them to me. I will not guess.

---

## 4. Risk assessment

| Risk | Severity | Why |
| --- | --- | --- |
| **Push never confirmed on a device** | 🔴 **High** | The exact bug that hid for months. `sendEachForMulticast()` with zero tokens returns *success*. Code is fixed; **delivery is unproven.** |
| **Money path never executed** | 🔴 **High** | Zero orders, ever. Verified by static analysis + 17 CI checks, but **it has never taken a shilling.** CB-M1 legitimately NO-GO. |
| **No PO ever delivered** | 🟠 Medium | Chain is built and guarded. But an email queue silently swallowed everything on this platform before. |
| **iOS-specific UI** | 🟠 Medium | Zoom, safe-area, swipe-back, PWA cache — the four things emulation reproduces worst are the four things I fixed today. |
| **PWA serving a stale worker** | 🟡 Low | Live SW == repo. But an *installed* PWA can lag. Hard-refresh first. |
| Historical financial damage | 🟢 **None** | **Zero orders ever existed.** P0-7 caused no loss. Fixed before the first customer — the correct order. |

---

## 5. Remaining blockers to public launch

1. ⛔ **Every item in §2 marked ⬜** — none can be closed from here.
2. ⛔ **`procSuppliers` is empty** — create a supplier before the PO test.
3. ⛔ **No real transaction has ever occurred.**

---

## 6. Verdict

> **SOKONI is NOT production-ready, and I am not the one who can change that.**

The engineering is done and guarded: 13 CI gates green, the money path fails closed, push is
routed through one engine, six hubs got their CTA back. **None of that is evidence of working.**

**Everything I can verify from here, I have. The rest genuinely needs your hands and a handset.**

Bring me the console logs, the failures, and the real performance numbers, and I will fix what
they show. Give me a green checkmark I did not earn, and I will have learned nothing.
