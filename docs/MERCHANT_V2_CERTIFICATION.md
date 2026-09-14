# Merchant v2 — Production Certification Record

**Date:** 2026-08-19
**Subject:** `merchant-v2.html` — the native Merchant shell
**Harness:** `scripts/test-merchant-v2-certification.js` (MODE: PRODUCTION)
**Result:** **17 passed · 0 failed · 0 unproven**

Not an emulator, not a simulation. A real approved seller signed in against **production
Auth** and read **production Firestore**.

---

## Identity under test

```
seller uid   D5Ql2EYr95bt79IpcGTmOMTK0P83
active shop  shops/D5Ql2EYr95bt79IpcGTmOMTK0P83   "KASS SHOP"  status: active
```

## What passed

| # | Assertion | Result |
|---|---|---|
| 1 | Signed in against PRODUCTION Auth | PASS |
| 2 | Resolved a production uid | PASS |
| 3 | Shell resolved a real session | PASS |
| 4 | Shell `sellerUid` === authenticated uid | PASS |
| 5 | Active shop resolved | PASS |
| 6 | 12-transition walk — one panel each, in-document | PASS |
| 7 | Every transition kept the same document, identity, shop, one shell | PASS |
| 8 | SDK initialised once, never again across the walk | PASS |
| 9 | The document never left `/merchant-v2.html` | PASS |
| 10 | No child frame navigated itself to login | PASS |
| 11 | Device registry intact after the walk | PASS |
| 12 | Orders reached the BACKEND, every row owned by this seller | PASS |
| 13 | Payments reached the BACKEND, every row owned by this seller | PASS |
| 14 | Refresh restored the same route | PASS |
| 15 | The session itself survived the refresh | PASS |
| 16 | Shell re-adopted the session after refresh | PASS |
| 17 | No uncaught page errors attributable to SOKONI code | PASS |

### The ownership evidence

```
orders    size 9   fromCache false   owners: D5Ql2… ×9
payments  size 0   fromCache false   owners: []
```

`fromCache: false` is the load-bearing part — the backend answered, so these are real reads
rather than a cache replaying. Nine orders, every one owned by this seller.
`payments: 0` is a legitimate answer from a merchant with no settled payments; the query
reached the backend and returned an empty set, which is not the same as a failed read.

### The walk

```
dashboard → products → POS → orders → analytics → revenue →
payments → devices → availability → settings → products → POS
```

At **every** transition: auth uid present · persisted `firebase:authUser:` record present ·
SDK `currentUser` equal to the shell uid · `activeShopId` unchanged · exactly one header and
one sidebar · no panel mounted twice.

---

## Closed by this run: the emulator Auth-persistence investigation

A long diagnosis under the Auth emulator appeared to show that mounting POS destroyed the
origin's Firebase Auth record. **It did not reproduce against production Auth.** The real
seller walked Products → POS twice and the session held.

Three hypotheses were raised and each falsified by the next control — a v1-vs-v2 split, then
`seller.html`'s secondary `revSnap` app, then "a second hosted module is required". The last
was falsified by observing the record vanish with **zero** modules mounted, which pointed at
the rig rather than the product.

**Conclusion: an artifact of emulator Auth + localhost + an App Check debug token.**
**Do NOT build the centralised Auth-ownership migration that was under consideration.**

---

## Two real defects this certification found and fixed

1. **The shell never adopted the session.** `firebase.js` is `type="module"` and therefore
   deferred; `initSession()` ran at boot, found `getApps()` empty, threw, pinned the session
   to `'out'` and never attached a listener. A genuinely signed-in merchant saw
   "Not signed in" on every surface. `sdk()` now waits for the app.
2. **The shop lookup blocked on App Check.** `resolveShop()` awaited attestation for up to
   12s *before its first attempt*, so `activeShopId` was null through the first paint even
   though the document existed and is publicly readable. It now attempts immediately and
   waits only before retrying, and records `shopError` instead of failing silently.

---

## OUTSTANDING — P58E printer persistence (human signature required)

Playwright cannot be granted Bluetooth and no printer is attached, so the harness reports
this as `DEVICE-MANUAL` rather than guessing. It must be signed by a person on real hardware.

**Device:** Android phone, Chrome (Chromium-based).
**NOT iPhone** — iOS Safari has no Web Bluetooth; the chip will correctly read
`Printer (unsupported)` and the test would prove nothing.

| # | Step | Expected | ✓ |
|---|---|---|---|
| 1 | Open Merchant v2, sign in as the merchant | Shell loads, shop name in sidebar | ☐ |
| 2 | Go to **Devices** | Printer card shown | ☐ |
| 3 | Connect the P58E | Chip reads **Connected** (green) — **not** "Saved" | ☐ |
| 4 | Test print | Paper output | ☐ |
| 5 | Open **POS** | POS mounts | ☐ |
| 6 | Go to **Orders** | Orders mounts | ☐ |
| 7 | Go to **Analytics** | Analytics mounts | ☐ |
| 8 | Return to **Devices** | Chip **still** reads Connected | ☐ |
| 9 | Test print again | Paper output | ☐ |
| 10 | Hard-refresh the page, open Devices | Chip reads **Saved**, not Connected | ☐ |

**Step 3 is the one that is easy to misread.** The chip has five states precisely so
"saved but not connected" cannot be mistaken for connected. Only a green **Connected**
counts.

**Step 10 is expected to show "Saved", and that is a PASS.** A GATT connection dies with the
document; a reload is not navigation. Conflating the two would produce a false failure.
Steps 5–8 are the architectural claim: the shell owns the connection, so moving between
Merchant surfaces does not drop it. In the old multi-page merchant every navigation did.

```
Signed: ______________________    Date: __________
Device/phone: ______________________  Browser + version: ______________________
```

---

## Release position

```
Production Auth              PASS
Real seller identity         PASS
Active shop                  PASS
Native operational core      PASS
12-route walk                PASS
Session persistence          PASS
Refresh                      PASS
Device registry              PASS
Orders / Payments ownership  PASS

P58E live persistence        PENDING HUMAN SIGNATURE
```

Merchant v2 is proven against a real merchant. The remaining iframe surfaces
(Staff, Messages, Disputes, Returns, Receipts) still mount their legacy modules and can be
converted deliberately — there is no reason to rush them now that the foundation is proven.

**Not deployed.** `merchant-v2.html` is a new file alongside the existing `merchant.html`;
nothing was replaced and no deployment was performed.
