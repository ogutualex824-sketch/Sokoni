# Merchant authenticated containment — finding classification

**Run:** `scripts/test-merchant-authenticated-containment.js`, authenticated production
session, uid `D5Ql2EYr95bt79IpcGTmOMTK0P83`, 103 products.
**Result:** 354 passed / 21 failed — **REAL 0** · UNPROVEN 8 · ENV 13.
**Not deployed. Production `cdfc8ab`.**

Containment is green across all 31 destinations: shell intact, correct module mounted, no
login page, no customer shell, no onboarding for an approved merchant, no duplicate
navigation, no blank surface.

---

## 🔴 REAL — `registerDevice` 400 (one cause, eight surfaces)

Seen on dashboard, POS, deliveries, returns, minishop, fulfilment, riders, pos-setup.
**It is one defect, not eight.**

`shared-header.js:293` injects `sokoni-zero-trust.js` into every page that loads it.
`sokoni-zero-trust.js:279` calls `registerDevice` with:

```js
{ fingerprint, userAgent, browserName, os, screenResolution, timezone }
```

`functions/index.js:12093` exports **only** `deviceMgr.registerDevice`
(`functions/device-manager.js:166`), whose contract is:

```js
{ deviceId /* UUID v4 */, merchantId, branchId, deviceType, platform, ... }
if (!deviceId)   _err('deviceId is required.');
if (!merchantId) _err('merchantId is required.');
if (!branchId)   _err('branchId is required.');
```

None of those fields is sent, so every call fails at the first validation line → 400
`invalid-argument`.

**This is a Cloud Function name collision.** A matching implementation exists —
`functions/security-identity.js:1106` takes exactly `{ fingerprint, userAgent, platform,
screenResolution, timezone, ... }` and is exported from its own module at line 1370 — but
**`functions/index.js` never requires that module**, so it is not deployed. The name is
taken by an incompatible function.

**Consequence:** zero-trust device-trust registration has never worked. `_saveDeviceTrust`
is never reached, so no trust score is ever recorded. `functions/security-pentest.js:357`
already anticipates the symptom: *"securityEvents is empty — ensure sokoni-zero-trust.js is
integrated on client pages."* It is integrated; its backend is absent.

**No merchant UI impact** — every affected surface rendered correctly. This is a declared
security control that is inoperative, which is a quieter and more dangerous kind of problem
than a broken screen.

**Not fixed here.** Resolving a function-name collision is a deployment-shaped decision —
rename the client call, or export the security-identity implementation under its own name —
and belongs with the Functions owner, not inside a containment pass.

---

## 🟡 TEST-HARNESS

| Finding | Evidence |
|---|---|
| POS `404 /api/catalogue` | `firebase.json:71` rewrites `/api/catalogue` → the `catalogue` function. The gate's server is static-only and implements no `/api`. Resolves in production; confirm on the device run. |
| Verification `permission-denied`, reported under **pos-setup** | The message originates at `verification.html:1394`. It surfaced after the walk advanced, so per-route attribution drifted. Verification handles it — an explicit "Could not load directory" state renders. **The gate attributes async failures to whichever route is active when they land.** A known limitation of the harness, not a defect in either surface. |

---

## 🟡 UNPROVEN — needs one more targeted read

| Finding | What is known | Next test |
|---|---|---|
| Inventory Firestore snapshot `permission-denied` | `merchant.html:1554` loads the Seller module so its authenticated `onSnapshot(orders)` feed runs. Not UI-visible — Inventory rendered 5,068 chars. | Capture the exact collection + query shape, compare against the `orders` rule |
| Returns `400` Firestore **WebChannel** `Listen/channel` | Transport, not a query. Probably the same story as the timings below. | Compare against a production-origin load |

---

## 🟢 EXTERNAL — not SOKONI code, but not nothing

| Finding | Note |
|---|---|
| Products: 10 × `404 images.unsplash.com/photo-...` | Product records point at Unsplash photo IDs that no longer resolve. Not a code defect — but customers see broken images, so it is a **data cleanup ticket**. |
| MiniShop: `404 chart.googleapis.com/chart` | Google Image Charts was retired by Google. Something renders a chart against a dead API. |

---

## 🟢 ENV — loopback origin (13)

`Origin http://127.0.0.1:PORT is not allowed by Access-Control-Allow-Origin`. An ephemeral
loopback origin is not among Firebase's authorized domains. Mechanism measured earlier:
`content-firebaseappcheck.googleapis.com/...:exchangeDebugToken → 403`.

---

## Timing — the first reading was wrong, and so was the obvious fix

The initial measurement suggested `products.where(shopId)` was slow (29.4s) while
`where(sellerUid)` was fast (0.4s), which pointed at migrating the read path. After adding a
discarded warm-up and running both fields in both orders:

```
warmup_discarded   29603ms   (channel setup — discarded)
pass1_by_shopId    30014ms   n=103  fromCache=false
pass1_by_sellerUid 30010ms   n=103  fromCache=false
pass2_by_sellerUid 29999ms   n=103  fromCache=false
pass2_by_shopId    30010ms   n=103  fromCache=false
control_single_doc 29979ms   exists=true  fromCache=false
```

**Every read lands at ~30.0s, including a single-document `getDoc`.** That is not query
cost — it is a uniform ceiling, the signature of a timeout-and-retry, and it matches the
`400 Firestore WebChannel Listen/channel` captured on Returns.

**Do not migrate product authority from `shopId` to `sellerUid`.** The first reading was an
artifact of whichever query ran first absorbing channel setup. Under fair measurement the
two fields are indistinguishable.

Whether the ~30s ceiling exists off the loopback origin is **unproven** and needs a
production-origin measurement before anyone optimises anything.

---

## Outstanding before device acceptance

1. **Ordinary-merchant authorization is UNPROVEN.** The test account carries `admin:true`
   and `superAdmin:true`, so the gate reports `NOT EVALUATED` — a superAdmin passing a
   permission check certifies nothing about a merchant. Needs a plain approved seller.
2. `registerDevice` name collision, above.
3. Production-origin timing measurement.
4. Availability fix still uncommitted — `merchant.html` carries another process's work.
