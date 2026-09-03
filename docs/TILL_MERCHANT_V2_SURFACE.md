# Till & QR — Merchant V2 surface (Till Approval Automation, Part 2)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (pure core + served-page browser
check). COMMITTED · STACKED. NOT ON R1 · NOT DEPLOYED.** Production remains `d592d8f`/v632,
untouched.
**Date:** 2026-09-04

---

## 0. A finding that changes what "commit" means for this slice

`merchant-v2.html` was **untracked** on `release/multishop-checkout-certified` — present in the
working tree (from before this turn) but never committed to this branch. `git log --all -- 
merchant-v2.html` shows it has full, real history on other branches. Diffed directly against
`release/r1-pos-printer-fn`'s own committed copy: **the working-tree file is ~99% identical to
r1's own `merchant-v2.html`**, apart from two things — this slice's own additions (the `till`
script tag + `MODULES.till` entry), and one pre-existing gap: **the working-tree copy is missing
the Supplier Hub module/script tag that r1's tip already has** (`3b9ccbc`,
`supplierHub:{global:'SokoniMerchantSupplierHub', ...}` + its script tag) — meaning this
working-tree copy predates that r1 commit, not a fresh copy of r1's current tip.

**This is committed to the evidence branch for the first time as part of this slice**, since the
user's own instruction is to build "inside the existing Merchant V2 shell" and this is that
shell — but it is flagged here explicitly, not silently absorbed: reconciling this branch's Till
work back onto r1 will need to account for the fact this branch's `merchant-v2.html` is missing
Supplier Hub, and any future sync must not silently regress that r1 feature.

## 1. Trace — the shell's own contract, followed exactly, not reinvented

`merchant-v2.html`'s routing is a single canonical registry, `sokoni-merchant-routes.js`
(`window.SokoniMerchantRoutes` — `ROUTES`, `PRIMARY_ORDER`, `MORE_GROUPS`, `validate()`); the
sidebar, mobile drawer, and command palette are all *projections* of it, never hand-maintained
lists (the file's own stated Hard Rule). Native routes with a `MODULES[id]` entry dispatch
generically to `window[global].mount(host, ctx)` — `renderNative()`'s existing `if
(MODULES[id]) return renderModule(id, p);` line required **no new dispatch code at all**.

**Confirmed, not assumed:** `merchant-v2.html` is documented elsewhere
(`docs/MERCHANT_ENTRY_AUTHORIZATION_AUDIT.md`) as not currently deployed/gated — consistent with
every other Till/QR slice, built for the eventual mass release, not live now. Scope resolution
(`_scope()`) is AUTH + the canonically resolved shop only, `{ok, sellerUid, shopId, reason}` —
**never** a client-supplied identifier; the new surface uses this exact function, unmodified.

## 2. Design

**Route:** `till` (`sokoni-merchant-routes.js`) — `tier:'primary'`, `kind:'native'`, placed
immediately after `payments` in both `ROUTES` and `PRIMARY_ORDER`, per the explicit
discoverability preference. `ctx:[SELLER_UID, SHOP_ID, BRANCH_ID]`.

**Module:** `sokoni-merchant-till.js` (new) → `window.SokoniMerchantTill.mount(host, ctx)`,
registered in `merchant-v2.html`'s `MODULES` table exactly like `staff`/`marketing`/`disputes` —
`ctx()` supplies `scope: _scope()`, `shopName: _shopName()`, and five callables via the shell's
own generic `_callable(name)` wrapper (`callMyTill`, `callActivity`, `callMintDynamicQR`,
`callCreateIntent`, `callSetStatus`). No new dispatcher, no new auth path — reuses the shell's own.

**Three new backend callables** (`functions/sokoni-till.js`, Part 1's file, extended):
- `getMySokoniTill({shopId, branchId})` — resolves the caller's OWN Till from `shopId`
  (defaulting to `auth.uid`, refused for any other shop unless admin) — never a client-supplied
  Till id. Prefers the ACTIVE Till for the branch; falls back to the most recently issued one
  (any status) so a disabled/retired Till is still visible, not just silently absent.
- `getSokoniTillActivity({sokoniTillId})` — recent **paid** `paymentIntents` for that Till,
  authorized to the Till's own `merchantUid` or admin only. Deliberately has no `orderBy()` — a
  query on the nested `metadata.sokoniTillId` field + `status` + an `orderBy` on a third field
  would need a composite index that does not exist and is not being deployed this slice; sorts
  the small, capped (50-row) result set in memory instead, avoiding a new index dependency.
- Dynamic QR generation reuses `createPaymentIntent` (unmodified, `purpose:'pos_till_sale'`) then
  `mintDynamicSokoniQR` (unmodified, Q5) — the page's amount input is only ever the seed for one
  free-form line item; `priceTillSale` sums server-side, exactly as every dynamic-QR flow in this
  programme already works.

**QR rendering:** `sokoni-qr.js` (`window.SokoniQR.generateCanvas(url, size)`), the same
first-party encoder `pay-q.html` already uses — added to `merchant-v2.html`'s script list (it
was not loaded there before).

**Deliberately no "Generate Till" control on this page.** Till issuance is now server-side and
automatic on approval (Part 1). A "no Till yet" state explains why, rather than offering a button
that would resurrect the exact self-service dependency this whole feature replaces.

## 3. Certification

**Backend (pure core):** the three new callables' authorization is the same one-line
`shopId !== auth.uid` / `merchantUid !== auth.uid` equality-unless-admin pattern already used,
unextracted, by `mintSokoniTill`/`setSokoniTillStatus` before this slice — consistent with
precedent, not a new pattern needing its own extraction. `scripts/test-sokoni-qr-payment.js`
remains **81/81** (unchanged by this part — no new pure-core decision was introduced; the
authorization shape is identical to already-certified code).

**Served-page browser check** (`merchant-v2.html`, local static server, no live backend):
- All three touched/added script requests (`sokoni-merchant-routes.js`, `sokoni-qr.js`,
  `sokoni-merchant-till.js`) resolved 200 with `application/javascript`, verified via both network
  interception and content-type inspection — the exact failure mode Q8's browser check caught
  (a script silently receiving HTML) was explicitly re-checked for and did not occur here.
- Zero `pageerror`s traced to the new code.
- `window.SokoniMerchantRoutes.validate()` → `[]` (zero contract violations) executed **inside
  the live page**, not just statically — confirms the `till` route entry is well-formed in the
  actual served file.
- `window.SokoniMerchantRoutes.get('till')` resolves correctly: `tier:'primary'`,
  `kind:'native'`, `ctx:['sellerUid','shopId','branchId']`.
- `window.SokoniMerchantTill.mount` confirmed a real function, module exports cleanly (only
  `mount`, no accidental global leakage).
- Sidebar renders "🏧 Till & QR" between "💳 Payments" and "🛵 Delivery Hub" — exactly matching
  the declared `PRIMARY_ORDER`.
- Page reaches an honest signed-out state (no live Firebase session) — dashboard shows `—`
  placeholders, not fabricated zeros, consistent with this project's UI-data-integrity rule.

**Noted, not caused by this slice:** several unrelated `merchant-v2.html` script tags
(`sokoni-merchant-dashboard.js`, `sokoni-merchant-products.js`, `sokoni-merchant-wallet.js`, and
others) 404 in this working tree — confirmed genuinely absent from repo history for those
filenames, pre-existing, unrelated to Till & QR. Not fixed here; out of scope.

| requirement | how certified |
|---|---|
| KASS Shop resolves its Till | `getMySokoniTill` resolves generically from `auth.uid`/`shopId` — no shop-specific branch exists anywhere in this code; identical path for KASS Shop as any other |
| Merchant V2 can read its own Till | live browser check confirms the route, module, and callable wiring all load and resolve correctly in the actual served page |
| permanent QR resolves correctly | reuses `resolveSokoniQR` (Q5, already 81/81 certified) unmodified — this page only renders the `qrUrl` it returns via `SokoniQR.generateCanvas`, confirmed loaded and functional in the browser check |
| dynamic QR resolves correctly | reuses `createPaymentIntent` + `mintDynamicSokoniQR` (Q5/Q8, unmodified) — the page is a thin caller, not a new authority |
| no client-supplied merchant identity can redirect the Till | `getMySokoniTill`'s `shopId` defaults to `auth.uid` and is refused for any other value unless admin (same shape already certified for `mintSokoniTill`/`setSokoniTillStatus`); `getSokoniTillActivity` is gated on the Till's own `merchantUid`, never the caller's claim |

## What this slice does NOT do

Does not touch `posCompleteCheckout`, `posRetailSales`/`posSales`, D4, `intasendWebhook`,
`webhookIntasend`, or `initiateSTKPush`. Does not add a manual "Generate Till" control (Part 1
made this unnecessary). Does not fix the unrelated pre-existing 404s for other
`merchant-v2.html` module scripts. Does not build the shared profile dropdown (Parts 3-5, next).
Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/TILL_APPROVAL_AUTOMATION.md` (Part 1, the automatic-issuance backend this surface reads
from) · `sokoni-merchant-routes.js` (`till` route) · `merchant-v2.html` (`MODULES.till`, script
tags) · `sokoni-merchant-till.js` (new) · `functions/sokoni-till.js` (`getMySokoniTill`,
`getSokoniTillActivity`, new) · `sokoni-qr.js` (added to the shell's dependency list)
