# Smoke Test — Dispatcher Collision Fix (2026-07-12)

**Scope:** verify the 13 collision changes in commit `8fe29e2` didn't break any live path.
**Who:** run on a real authenticated device (phone/tablet) against production `sokoni-aeb26.web.app`.
**Time:** ~10 min. **If any ❌ in Section A → run the Rollback at the bottom immediately.**

> Why: the deploy renamed 5 dispatcher-routed handlers (wallet + admin) and removed 8 dead ones. Functions + clients were deployed together, so this is a confirmation pass, not an expected-failure hunt. A rename miss shows up as **`Handler for "…" not found`** or **`internal / not-found`** in the browser console.

Open **DevTools → Console + Network** on the device (or desktop logged in as the same roles) before starting.

---

## Section A — RENAMED handlers (dispatch-routed) — MUST PASS

These are the only real-risk items (money + admin). Each was renamed and its caller updated.

### A1. POS wallet balance + transactions  → `posGetWalletBalance` / `posGetWalletTransactions`
- **Page:** `pos-crm-pro.html` (POS → CRM / customer lookup)
- **Do:** search a customer by phone number that has a SOKONI wallet.
- **✅ Pass:** wallet **balance** and **transaction list** render.
- **❌ Fail:** balance shows blank/error; console shows `posGetWalletBalance … not found` or `getWalletBalance … not found`.
- **Means:** the smartPosDispatch rename/caller is out of sync.

### A2. POS wallet refund  → `posRefundToWallet`
- **Page:** `pos-crm-pro.html` → open the **Refund to wallet** modal.
- **Do:** issue a **small test refund** (e.g. KES 1) against a test sale, to a test customer.
- **✅ Pass:** refund succeeds; balance increases by the amount; toast confirms.
- **❌ Fail:** error toast; console shows `posRefundToWallet … not found`.
- ⚠️ Use a **test customer + KES 1** only. Reverse it after (or note it) — this moves real value.

### A3. Admin — pending payouts  → `aosGetPendingPayouts`
- **Page:** `admin-os.html` (Admin OS → **Payouts** panel — loads `sokoni-aos.js`).
- **Do:** open the pending-payouts list.
- **✅ Pass:** the payouts list loads (even if empty, it loads without error).
- **❌ Fail:** panel spinner hangs / error; console shows `aosGetPendingPayouts … not found`.

### A4. Admin — resolve dispute  → `aosResolveDispute`
- **Page:** `admin-os.html` → **Disputes** panel (loads `sokoni-aos.js`).
- **Do:** open a **test dispute** and resolve it (pick a winner + note).
- **✅ Pass:** dispute moves to resolved; list refreshes.
- **❌ Fail:** error toast; console shows `aosResolveDispute … not found`.
- ⚠️ Use a **test/dummy dispute** only.

---

## Section B — REMOVED dead handlers — verify the canonical path still works

These handlers were removed from dispatchers; the clients already used the **standalone** CF directly, so these should be **unaffected**. Quick confirm only.

| # | Page | Action | ✅ Pass |
|---|------|--------|---------|
| B1 | `developer-portal.html` / `partner-portal.html` | Register a webhook + send test payload | webhook saved; test returns a status code |
| B2 | `procurement.html` | Create a purchase order (test supplier) | PO saves |
| B3 | `pos-completeness.html` | Open a screen showing currency/FX rates | rates load |
| B4 | `security-center.html` | Open the Audit Log panel | log entries load |
| B5 | `pos-setup.html` | Complete device setup on a new device | device pairs (uses `registerDevice`) |

**❌ Any fail here** = a client I classified as "direct" is actually dispatch-routed. Report which one; it's a targeted 1-line fix (re-add that handler under a namespaced key).

---

## Section C — Provider onboarding backend (newly deployed `providerDispatch`)

Optional sanity — the provider **UI is not live yet**, so this is backend-only.
- **✅ Pass:** `providerDispatch` appears in `firebase functions:list` (already confirmed live).
- No client action required until the provider onboarding page is flipped on.

---

## Rollback (only if Section A fails)

The rename is fully reversible. From the repo root:

```bash
git revert --no-edit 8fe29e2
firebase deploy --only functions:smartPosDispatch,functions:adminOsDispatch,functions:servicesDispatch
firebase deploy --only hosting
```

This restores the original handler keys (`getWalletBalance`, `adminGetPendingPayouts`, …) and the original client calls together. Guard will show the 13 warnings again (non-fatal) — that's the pre-fix state, which was healthy.

> Note: `git revert 8fe29e2` reverts ONLY the collision fix. It does **not** touch the SmartPOS Setup Guide, provider CFs, or onboardingDispatch.

---

## Result log

| Section | Item | Pass/Fail | Notes |
|---------|------|-----------|-------|
| A | A1 wallet balance/tx | | |
| A | A2 wallet refund | | |
| A | A3 admin payouts | | |
| A | A4 admin dispute | | |
| B | B1 webhooks | | |
| B | B2 purchase order | | |
| B | B3 currency rates | | |
| B | B4 audit log | | |
| B | B5 device register | | |

Related: [[DISPATCHER_REGISTRY]]
