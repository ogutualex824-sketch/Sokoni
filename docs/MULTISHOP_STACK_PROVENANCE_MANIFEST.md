# Multi-Shop Stack — Ownership / Provenance Manifest
**Read-only. Nothing modified, committed, deployed, reset, or cleaned to produce this.**
**Date:** 2026-08-30 · **Author of manifest:** session sokoni-d1 (cart/quote agent)
**Related:** [[MULTISHOP_CHECKOUT_AUDIT]] · [[CHECKOUT_CONTRACT]] · [[STK_VERIFICATION_NO_MONEY]] · [[MERCHANT_OWNED_PAYMENTS]]

## 0. Purpose
The premium multi-shop experience depends on a body of **long-lived, uncommitted** work already
present in the main worktree. Before any new architecture is added or anything is landed, this
manifest records — per file — **what it is, whether it is deployed, and whose it is.** It is the
input to a single **coupled, certified** hosting+functions release. It asserts nothing about
authorship it cannot prove.

## 0a. Implementation status — Agent B reconciliation (working tree, UNCOMMITTED, for the verifier)
Landed in the working tree under explicit user authorization (Rail B; no commit/push/deploy). **Not final GREEN — awaiting independent verification.**
- **Step 1** money-helper E: `subtotal` removed from `sokoni-cart.js groupBySeller`; per-shop display computed in `checkout.html`. → cart-acceptance **22/22**, cart-service-contract **72/0**.
- **Step 2** canonical validator: `validateOrderLines` extracted in `payment-purposes.js` (behavior-preserving); `product_order` calls it + keeps single-seller check; quote reuses it (no fork). → single-shop guard **29/0**, payment-authority **22/0**, product-payment **25/25**, payment-integrity **20/20**.
- **Step 5** manual gate: `checkout-mode.modeFromDestination` → `unavailable` / `manual_payment_unavailable`; `manual-till-orders.js` untouched. → checkout-mode **26/0** (+ gate invariant).
- **Step 3** quote wiring: `createMultiShopCheckoutQuote` onCall in `multishop-checkout-quote.js` (reuses `validateOrderLines` + shared delivery-engine, App-Check on, persists `checkoutQuotes/{id}`); **one** additive `index.js` re-export, content-anchored by sokoni-82. **Proven by hunk (not a count):** reconstructing the pre-edit `index.js` and diffing yields a single hunk `@@ -11604,0 +11605,6 @@` at the `getShopCheckoutMode` cluster; `darajaSTKPush` (line 3536) and `_finalizeMarketplacePayment` (line 3910) have **no hunk** — byte-identical. → quote **33/33**, integration **23/0**.
- **Step 6/3c** checkout render: `_ckRenderMultiShop` requests the quote → per-shop delivery cards + consolidated total; **client never computes the payable** (loading/at-payment states only). → multishop-ui **34/0**.
- **Step 7** Rail B: per-shop `_ckPayShop → createPaymentIntent(product_order)`; **Option A** revalidation (no `quoteId` coupling, documented in `product_order`). **CORRECTED (independent-verifier finding):** the first pass left `_ckShopScope` set-but-never-read, so the charge sent the WHOLE cart and the single-seller guard rejected multi-shop — fail-safe, but per-shop pay was **non-functional / display-only** (the earlier "preserved/working" claim was wrong). **FIXED:** the mpesa charge path now re-derives the chosen shop's lines FRESH from `_ckPendingShop` and scopes the payment to one seller (one shop → one payment → one order); the selection is cleared after each shop settles. Dead `_ckShopScope` removed. Asserted in the integration suite.
- **Step 9** negatives: tamper/expiry/drift/client-price/seller/delivery in the quote suite; cross-shop rejection + manual refusal + wiring reachability in the integration suite.
- **Cert:** 11/12 suites green. The one red is `test-cart-food`'s **K** shared-tree perimeter check (pre-existing; offenders `firestore.rules`/`checkout-2-preview.html`/docs — none mine). Recovery baseline held outside the repo. Commission authority untouched.
- **Verifier must** diff the resulting tree against **HEAD and the deployed estate**, re-run the sweep, and confirm no unrelated files / no protected-region changes before any deploy.

## 1. The stack, file by file

| File | Git | mtime | Size (working) | Δ vs `0a0d921` | What the change IS | Deployed? |
|---|---|---|---|---|---|---|
| `sokoni-cart.js` | M | 2026-08-27 19:50 | 19,197 B | +85 | Multi-shop **cart grouping** — `groupBySeller` / `removeBySeller` / "MULTI-SHOP CART, SINGLE-SHOP SETTLEMENT" | **No** — live cart = 14,770 B, **zero** shop concept |
| `checkout.html` | M | 2026-08-27 20:11 | 202,977 B | +260 | Multi-shop **checkout UI** — `multiShopPanel` / `_ckRenderMultiShop` / `_ckPayShop` (per-shop pay) | **No** — not in live `checkout.html` |
| `functions/payment-purposes.js` | M | 2026-08-26 20:40 | 17,972 B | +15 | **Canonical `product_order` validator** (item price/availability/stock) + **single-shop guard** ("spans multiple sellers") + **delivery-engine recompute** | **No** — `product_order` absent from **all 4** deployed archives |
| `functions/payment-destinations.js` | M | 2026-08-28 00:28 | 16,680 B | +22 | TILL-vs-paybill attribution (`?? null` keeps TILL absent) in `resolveActiveDestination` | Partially — base is live; this delta unverified deployed |
| `functions/index.js` | M | 2026-08-28 00:37 | 698,911 B | +122 | `_normalizeMsisdn` helper; `darajaSTKPush` switch; **`_finalizeMarketplacePayment` "SINGLE-SHOP CHECKOUT INVARIANT — defence in depth"** (layer 3); `sendTestSTKPush` | **No** — deployed writer takes one `sellerUid`, does **not** re-derive/validate line sellers (`_lineSellers`/invariant = 0 in all archives) |
| `functions/checkout-mode.js` | ?? (untracked) | 2026-08-28 00:28 | 5,027 B | NEW | Per-shop mode resolver → `MODE{STK:'daraja_stk', MANUAL:'manual_payment', UNAVAILABLE}`. "The customer does NOT choose the mode." | **No** — untracked, undeployed |
| `functions/manual-till-orders.js` | ?? (untracked) | 2026-08-27 17:25 | 13,669 B | NEW | `createManualTillOrder` + `attestManualTillPayment` onCall → orders in `awaiting_payment_attestation` | **No** — untracked, undeployed |

## 2. Provenance
- **All mtimes 2026-08-26 → 08-28**, spread across days, **2–4 days older than any current session** → long-lived pre-session state, not concurrent/in-flight work. **Uncommitted/untracked → no git author** (not in any stash; only stash is unrelated "delight + legal-sign"). Neither live peer (sokoni-82, sokoni-94) authored any of it.
- **The mtimes cluster into FOUR working sessions, each paired with its own contract doc (sokoni-94):**
  - **A · 08-26 20:40** — `payment-purposes.js` + `docs/CHECKOUT_CONTRACT.md` (**17 seconds apart**) → the `product_order` validator **and its written spec**, one unit. *Read `CHECKOUT_CONTRACT.md` before designing anything on the validator.*
  - **B · 08-27 17:25** — `functions/manual-till-orders.js` (new) + `docs/MANUAL_TILL_ORDER_CONTRACT.md` (12 min) → the manual-till lifecycle + its contract.
  - **C · 08-27 16:58 → 19:50 → 20:11** — `docs/MULTISHOP_CHECKOUT_AUDIT.md` **FIRST**, then `sokoni-cart.js`, then `checkout.html` (~3 h later).
  - **D · 08-28 00:28:42 → 00:28:43 → 00:37** — `payment-destinations.js` (M) + `checkout-mode.js` (new, **ONE second later** → written as a single unit), then `index.js` 9 min later (the export/wiring step). Same shape as B: a module + its collaborator written together, then `index.js` touched to export it.
- **KEY REFRAME (cluster C):** the audit that says *"the cart MAY NOT be multi-shop; checkout REJECTS rather than partitions; building it means relaxing a deliberately-built guard at three layers"* was written **~3 hours BEFORE** the multi-shop cart/checkout was implemented. So the dirty stack is **not drift** — it is a **deliberate implementation that followed a documented conflict analysis; whoever built it very likely knew about the guard layers and chose to relax them.** "Unattributable leftover state" undersells it. **Attribution/intent still requires the user** — mtimes bound *when*, not *who*.
- Treated as **candidate implementation** — preserved, not trusted-by-default, not reset/cleaned/overwritten.

> **Note on `checkout-mode.js`:** it exists at **`functions/checkout-mode.js`** (5,027 B, untracked `??`, mtime 08-28 00:28:43) — **not** at the repo root (absent there; an early probe checked the wrong path). It is a **new untracked** file, as is `manual-till-orders.js`. (Untracked files *do* appear in `git status` as `??`.)

## 3. Deployed reality (from immutable GCS archives, read-only)
Verified generations: `createPaymentIntent` gen `1787988598550043` (08-29), `recordPayment` gen `1788077453711719` (08-30, newest), `posCompleteCheckout` gen `1788077453733750` (08-30), `verifyIntasendPayment` gen `1787383897356775` (08-22).
**Absent from every archive:** `product_order` purpose · single-shop guard · `_finalizeMarketplacePayment` single-shop invariant / `_lineSellers`. Production is single-shop **by absence of capability**, not by an active guard.

## 3a. ⚠️ A second payment rail bypasses the single-shop invariant (sokoni-82)
The `_finalizeMarketplacePayment` single-shop invariant (and the `product_order` guard) sit on the
**IntaSend / `createPaymentIntent`** rail only. There is a **second rail** that never touches either:
`sokoni-mpesa.js` exposes a **shared** `SokoniMpesa.pay()` that calls `darajaSTKPush` **directly**
from bnb, car-rental, car-hub, delivery, digital (×2), healthcare, landlord and legal-hub — a buyer
paying a different seller, **bypassing `createPaymentIntent` and `_finalizeMarketplacePayment`
entirely.** Only `pos.js`, `merchant-v2.html`, `till.html` send `hub:'pos'`.
**Consequence for landing:** a multi-shop cart routed through `SokoniMpesa.pay` **never meets the
invariant.** The marketplace premium-cart path (`_ckPayShop → createPaymentIntent(product_order)`)
IS the covered rail, so Rail-B landing must ensure the marketplace path uses the covered rail and
must not assume the invariant protects the Daraja/`SokoniMpesa` surfaces.

**Clarification (sokoni-82 census):** those eight surfaces have **NO IntaSend path at all** — the
Daraja/`SokoniMpesa` rail is their **only** rail, not a fallback. `sokoni-pay.js` is loaded there but
used only for `saveCommission()`, which `sokoni-pay.js:131` documents as a **localStorage display
ledger**; the real `commissionLedger` is written solely by `intasendWebhook` after server-confirmed
payment. So multi-shop must not be exposed on those surfaces expecting the marketplace protections.

**Cross-track (SEPARATE from this release, cross-reference only):** sokoni-82's rail-separation track —
`c3e23dc` (bind `sellerUid` to sell authority), `4cb46a6` (Daraja POS-only + server-set `hub` label),
`a69c187` (payment-surface census); 77/0, undeployed — fixes a real money bug: `darajaSTKPush`
persisted `hub: hub || "marketplace"`, so a POS till sale was labelled *marketplace* and mis-priced
commission (POS flat 5% vs marketplace package-governed 5/4/3/2). **⚠️ Landing caution:** main's dirty
`index.js` delta ALSO edits `darajaSTKPush` (the `_normalizeMsisdn` switch) — the same handler
sokoni-82's guard touches (the unresolved collision, §5). The `hub || "marketplace"` default is
**CORRECT for the IntaSend rail — a cleanup must not rename it** (sokoni-82 guards this with a sabotage
case). When editing `darajaSTKPush`, slice to the handler's own `\n);\n`, **not** the next `\nexports.`
— the latter overruns into `_finalizeMarketplacePayment`, which is a plain async function, not an export.

## 4. Dependency chain (drives landing order)
```
cart.js + cart.html (premium UI, frozen)      ── depends on ──▶  sokoni-cart.js groupBySeller
checkout.html multiShopPanel                  ── depends on ──▶  checkout-mode.js (mode resolver)
                                              ── depends on ──▶  payment-purposes.js product_order (+ delivery recompute)
                                              ── depends on ──▶  payment-destinations.js (destination)
product_order (canonical validator)           ── uses ────────▶  shared/delivery-engine.js  ✅ already deployed & shared
_finalizeMarketplacePayment invariant         ── is ──────────▶  layer-3 order-writer guard
checkout-mode MANUAL + manual-till-orders.js  ── is ──────────▶  manual_payment lifecycle  ⚠️ MUST stay gated until deployed+certified
MultiShopCheckoutQuote (33/33, separate)      ── reuses ──────▶  product_order validator (once landed)  — NOT wired yet
```

## 5. Reconciliation — no duplicates (invariant)
- **Delivery:** ONE engine only — `functions/shared/delivery-engine.js` (deployed, shared). `product_order` recompute and the quote both call it. **No second engine.** ✅
- **Validator:** `product_order` is THE validator. The quote must **reuse** it (behavior-preserving extraction), **never fork** it. ✅
- **Commission:** untouched — `commission-config.js` is sokoni-82's single authority; the quote computes no commission. ✅
- **Payment path:** Rail B = existing `_ckPayShop` → `createPaymentIntent(product_order)` per shop. **No new payment path.** ✅
- **`index.js` collision:** main's `darajaSTKPush` phone-normalisation switch (~3774) vs sokoni-82's sell-authority guard (~3583, **now committed** `c3e23dc` on `chore/adopt-entitlements-index`, unpushed/undeployed) — same function, different points, so they **merge textually; the risk is semantic, not a conflict marker.** **Reconciliation owner: UNRESOLVED, pending provenance of the main-worktree Daraja delta.** sokoni-82's rail-separation is a **separate** track, not part of this coupled release.

## 6. Recommended landing order (coupled, guard-first — for user decision)
1. **User attributes/owns** the candidate stack (confirm it is the intended multi-shop implementation).
2. **Functions release (deploy FIRST):** `product_order` + delivery recompute + single-shop guard (`payment-purposes.js`) + order-writer invariant (`index.js`) + `checkout-mode.js` — with `manual_payment` **gated off** until `manual-till-orders.js` lifecycle is separately certified.
3. **Hosting release (deploy WITH/AFTER functions):** `sokoni-cart.js` grouping + `checkout.html` partition + `cart.js`/`cart.html` premium UI.
4. **Then** wire `MultiShopCheckoutQuote` (Rail B) + `revalidateQuote`.
5. **Combined certification before any deploy:** one cart → 2+ shops → independent delivery policies/fees → authoritative quote → shop-specific payment → shop-specific order → correct commission receivable; plus rerun cart/payment suites.

## 6a. Reusable guards & an adjacent settlement flag (sokoni-82)
- **Reuse, don't re-write:** whoever takes the checkout/money slice and touches `darajaSTKPush` should reuse sokoni-82's `scripts/cert-daraja-sell-authority.js` (77 assertions, real callable on emulator) + `scripts/sabotage-daraja-authority.js` (8 mutations, hash-restore) rather than writing a second, possibly-disagreeing set. (They live in sokoni-82's worktree; ask for the copy list.)
- **Adjacent settlement flag (SEPARATE rail — not this stack, do not chase here; source-level only, NOT verified against live data):** the defect is in **`finos-admin.js` `releaseEscrow` (~:342)**, which credits `FieldValue.increment(escrow.amountCents)` — a field that **neither** finos escrow creator writes. Creator `finosCreateEscrow` (`finos-router.js:372`, hold ~:390) sets `commissionCents:0 / sellerNetCents:amountCents`. **Three callables share the name — only `finos-admin.js` has the mismatch:** `finosReleaseEscrow` (`finos-router.js:425`) and `exports.releaseEscrow` (`index.js:8665`, live in the 2026-08-29 deploy) are **not** the defect. The main rail's hold at `finos-router.js:~252` (`finosRecordTransaction`) is **correct** (records `commissionCents/sellerNetCents`, credits `platform_master` at hold). Verify only if single-shop settlement work nears escrow release; escrow-rail concern, not the marketplace product-order path.

## 7. Open questions for the user
- Confirm authorship/intent of the candidate stack (§2).
- Who reconciles the `index.js` `darajaSTKPush` collision (§5)?
- Confirm `manual_payment` stays gated until `manual-till-orders.js` + `attestManualTillPayment` lifecycle is deployed and certified.
