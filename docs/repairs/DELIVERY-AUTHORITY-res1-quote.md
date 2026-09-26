# Marketplace delivery pricing — the RES-1 server-issued quote is the authority

**Branch:** `delivery-authority/res1-quote` (from main line `62fcbd5`) · **UNCOMMITTED, for review** · not pushed, not deployed
**Owner decision (2026-09-27):** for SOKONI marketplace orders, the RES-1 server-issued policy quote is the authoritative
source of the buyer's delivery charge. Seller `deliveryConfig` no longer determines marketplace delivery pricing.
**Related:** [[R5-rider-entitlement-authority]] · [[RES1-opt1-session-quote-binding]]

## Old vs new

| Path | Before (`62fcbd5`) | After |
|---|---|---|
| `product_order` (the live Pay button's charge) | Priced from `sellers/{uid}.deliveryConfig` through the delivery engine, with a browser distance/zone. The live client sent no distance, so a **distance-mode seller was refused**. A **flat seller's own free threshold applied**. An **unconfigured seller was charged KES 0**. A browser distance moved the price. Meanwhile the page *showed* the RES-1 quote. | Charged the **RES-1 quote the buyer was shown** (`customerCharge`, rounded to whole KES exactly as `createCheckoutSession` rounds it). The intent records which quote priced it. |
| `createMultiShopCheckoutQuote` (display) | Per-shop fees from `deliveryConfig` | Delivery **unpriced** (`null`, `res1_quote_required`) — never a seller figure, never 0, never "free". Totals are the items the basket actually charges. |
| `checkout.html` single-shop Pay | Sent no quote | Sends the displayed quote's id (never a figure). Stops a delivery payment that has no quote, before any pending order is written. |
| `checkout.html` multi-shop panel | Showed seller-config fees; "FREE" when absent | Delivery shown as not available for multi-shop baskets. No delivery payment is taken; pickup still works. |
| `createCheckoutSession` | RES-1 already | Unchanged |

**Fail closed.** A delivery order needs a quote the server resolves for this buyer. The quote must be:
- issued;
- unexpired;
- unconsumed;
- priced under the current policy;
- valid when its figures are revalidated.

Otherwise the charge is refused. A payload stating its own `deliveryFee` is refused. There is no fallback to a browser
figure or to `deliveryConfig`.

**Seller configs.** Preserved untouched; not read for marketplace price. The delivery engine still serves the
non-marketplace surfaces that use it (courier booking, food menu) and is unchanged. Engine sync is verified.

**Historical orders.** Never repriced. No code path rewrites an existing order or intent. A retry that would price an
existing intent differently is refused by the intent replay **amount** rule, and both documents stay byte-identical.

**Buyer-price impact.** This is the approved commercial change, measured read-only beforehand:
- Unconfigured sellers move from KES 0 to the quote.
- Configured sellers' free thresholds no longer apply.
- Distance-mode sellers, previously refused on the live path, become payable at the quote.
- Multi-shop delivery is not offered until per-shop quoting exists.

## Evidence

**`scripts/test-marketplace-delivery-authority.js`** runs against the emulator, using the real `requestDeliveryQuote` and
`createPaymentIntent`.

| tree | result |
|---|---|
| new | **22 / 0** |
| old (`62fcbd5`) | **6 / 16 FAIL** |

What the old tree does:
- The distance seller is refused (`distance_unknown`).
- The flat KES 9,999 seller is charged KES 0 for delivery.
- The unconfigured seller is charged KES 0 for delivery.
- A browser 0.1 km moved the charge to KES 1,102.
- A missing, forged, foreign, expired, consumed or stale quote, and a stated `deliveryFee`, are all **accepted**.
- The multi-shop quote is priced from configs.

The old tree passes only the unchanged properties: controls, pickup, seller records untouched, historical replay rule.

Each refusal case uses the unconfigured seller, which the old code charged without complaint, and must carry its own
specific reason. So no refusal can pass for the wrong cause. The historical case asserts the replay amount rule
specifically; an earlier fixture passed on an ownership mismatch and was corrected.

**Updated suites (assertions of the retired authority rewritten, never deleted):**

| suite | before | after | what changed |
|---|---|---|---|
| `test-multishop-checkout-quote` | 19 pass / 8+ fail | **34/0** | seller configs are kept in the fixtures to prove they have no effect |
| `test-product-payment-authority` | 25/25 | **27/27** | harness stub for the quote module interface; delivery = quote; stated `deliveryFee` refused; no quote refused; another buyer's quote refused |

**Regression floor** (old tree = the main checkout at `62fcbd5`, which has `.git`):
- Unchanged: Gate C GREEN, RES-1 GREEN, RES-1b GREEN, quote authority 128/0, vehicle selection 40/0, payment intents 12/0,
  single-shop checkout 29/0, multi-shop integration 26/0, webhook attribution 34/0, QR payment 81/0, pay-q 43/0,
  healthcare 40/0 and 120/0, subscriptions 45/0 and 76/0, till paid 19/0, offers 35/0.
- Dual-business and commission: all unchanged.
- R1–R5, RES-1 option 1, double credit, refund, escrow: all green.
- Predeploy gates pass.
- `certify-delivery-pricing-v1` cannot load in the worktree (no `functions/node_modules`). Its dependencies are unchanged,
  and its one failure on the old tree is the pre-existing live-production policy check.

**A defect caught during the work.** A shell heredoc ate a backslash and left an unescaped `can't` inside a JS string in
`checkout.html`, which would have broken the page's inline script. It was fixed, and all inline scripts in old and new now
parse with 0 errors. **`predeploy-syntax-gate.js` does not parse inline HTML scripts**: a detector gap, recorded.

## Conditions attached at review (owner, 2026-09-27) — this repair does NOT claim these

1. **Not universal product-payment authority.** The browser-amount STK path without a payment intent (see 1 below)
   remains a separate payment-authority defect.
2. **Not RES-1 option 2.** `sessionId`/`fulfillmentType` propagation and webhook quote recovery are the next workstream.
3. **Multi-shop server enforcement is separate.** The page prevents the unsupported delivery-payment case. The server-side
   payment path (`createManualTillOrder`) still needs its own repair if bypass must be impossible.
4. **Browser-written order fee fields are not solved.** The primary Pay-button *charge* now uses the quote, but
   `orders.deliveryFee` / `orderTotal` are still browser-written, and settlement still reads them. That remains an open
   financial-authority issue.
5. **Rounding.** The buyer-facing payment amount is one unambiguous whole-shilling figure. The rounding residue between
   the quote's minor units and that figure (at most KES 0.50) **must not later be silently interpreted as rider
   entitlement or SOKONI revenue**. Its allocation is a separate financial decision.
6. **`certify-delivery-pricing-v1` was NOT run for this change.** It cannot load in the worktree. Its dependencies are
   unchanged, so this was accepted for this commit, but it is not a certification this repair claims.

## Found, not changed — outside this unit's authority

1. **`initiateSTKPush` with no intent** charges a browser `amount` for category `product`, because `product` is not an
   enforced STK category. This is a payment flow.
2. **`verifyIntasendPayment` with no session** accepts the paid amount if it covers the items; delivery is unchecked. This
   is a payment flow.
3. **`createManualTillOrder`** (multi-shop payment) charges items only and accepts a delivery order. The page now blocks
   it; server enforcement is a payment-flow change.
4. **`checkout.html` pre-writes `orders.deliveryFee` / `orderTotal` from the browser**, and `order-settlement` derives
   `_grossCents` from them. Historical fee fields on the `product_order` path are browser-authored. The best record of
   what was actually charged is `paymentIntents/{orderId}.metadata`.
5. **`sokoni-intasend.js` STK meta drops `fulfillmentType` and `sessionId`.** This is RES-1 option 2 territory.
6. **`sellers/{uid}.deliveryConfig` is owner-writable** (not in `noAdminFields`). It no longer prices marketplace
   delivery, so there is no marketplace impact.
7. **Rounding.** The quote is in minor units, and the charge is rounded to whole KES (the existing `createCheckoutSession`
   rule). Rider and SOKONI allocations come from the quote's minor units. The rounding residue (at most KES 0.50) is not
   yet allocated. Defining that belongs to settlement.
