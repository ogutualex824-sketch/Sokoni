# RES-1 option 2 — the server-owned payment intent carries the delivery quote to the rider

**Branch:** `res1-opt2/census` (from main line `505bd34`) · **UNCOMMITTED, for review** · not pushed, not deployed
**Owner authorization (2026-09-27):** implement the approved design. The chain is: payment → server-owned payment intent →
server-owned delivery quote → transactional binding → Repair 5 rider entitlement. No checkout session is manufactured
for the main Place Order path.
**Related:** [[RES1-opt1-session-quote-binding]] · [[DELIVERY-AUTHORITY-res1-quote]] · [[R5-rider-entitlement-authority]] ·
[[WEBHOOK_ATTRIBUTION_AUTHORITY]]

## The defect (census)

The live Place Order path is:
1. `createPaymentIntent('product_order')`, which since `505bd34` prices delivery from the RES-1 quote and records it
   on `paymentIntents/{orderId}.metadata.deliveryQuote`;
2. `initiateSTKPush`;
3. `webhookIntasend`.

There is no checkout session and no browser verify. On that path:

| # | Before (`505bd34`) | Effect |
|---|---|---|
| B1 | The webhook read `fulfillmentType` from browser STK meta, which the wrapper never sends, so it defaulted to `"delivery"`. | Every paid **pickup** order was dispatched to a rider as a delivery. |
| C1 | The carry looked for the pin on the **order**, then a **session**. On this path neither existed. | Every main-path delivery was created `pricingBlocked: no_pinned_quote`. No rider could be paid (Repair 5 refused `no_pinned_quote`). The charged quote was never bound, so it was not single-use. |
| C2 | Both fields the carry trusted first (`orders.deliveryQuote`, `orders.sessionId`) are browser-writable (B2). | A browser-written pin was carried to the rider record as though it were authority. A browser-named session had its quote bound instead of the charged one. |

## The repair

| File | Change |
|---|---|
| `functions/payment-purposes.js` | The `product_order` intent metadata records `fulfillmentType` (`'delivery'` / `'pickup'`), decided where the charge was priced. |
| `functions/payment-attribution.js` | `mergeAttribution` returns `fulfillmentType` (only the two real values) and `deliveryQuoteId` from the **intent**. The legacy branch reports both as `null` (unknown). |
| `functions/delivery-quote-carry.js` | New `bindIntentQuoteToOrder` and `productIntentFor`. `deliveryPricingForOrder` takes `intentRef`. When a `product_order` intent paid for the order, **that intent is the only authority**. A refusal is final: it never falls back to the order's or a session's fields. Without such an intent the pre-existing carry is unchanged. |
| `functions/index.js` (webhook only) | `_pm.fulfillmentType` = the intent's value, falling back to meta (then the unchanged `"delivery"` default) only for an intent-less payment. The carry receives `intentRef: existing.intentRef \|\| apiRef`. |

**`bindIntentQuoteToOrder` runs as ONE transaction, with all reads before any write.**

Reads: `paymentIntents/{ref}`, `payments/{ref}`, `orders/{orderId}`, `deliveryQuotes/{intent's quote}`.

Refusals, each with a stated reason:

| Reason | Condition |
|---|---|
| `intent_not_product_order` | Not a product_order intent. |
| `intent_order_mismatch` | The intent is for another order (**pairing**). |
| `pickup_order_no_delivery` | A pickup intent. |
| `intent_carries_no_quote` | The intent names no quote. |
| `payment_not_found` / `payment_not_complete` | The payment is missing or not `COMPLETE`. |
| `payer_mismatch` | The payment was made by a uid other than the intent's owner. |
| `buyer_mismatch` | The quote's buyer or the order's buyer is not the intent's owner. |
| `intent_quote_diverges` | The intent's recorded charge/version differs from the stored quote. |
| `order_bound_to_another_quote` | The order already names a different `deliveryQuoteId`. |
| `browser_quote_conflict` | The order carries a pin of a different quote. |
| `quote_bound_to_another_order` | Raised by the single-use binder `bindQuoteToOrderTx`; the quote is never replaced. |
| (`assertSettleable` reason) | Revalidation against the policy in force fails. This runs **before** any write, so a pin that cannot settle never consumes the quote. |

Writes: the quote is bound (skipped if already bound to this order). The order receives `deliveryQuoteId` and the
**server's** pin (`pinnedFromStored` of the stored quote). An exact replay writes nothing. `order.sessionId` is never
read on this path. Expiry is deliberately not re-checked: the quote was unexpired when the charge was priced, and
payment may land later.

**B2 is not part of this repair.** The browser can still write `deliveryQuote`, `deliveryQuoteId` and `sessionId` on
an order; that remains a separate Firestore-rules repair. This repair only makes sure those fields cannot become the
carry's authority when a `product_order` intent exists.

## Evidence — `scripts/test-res1-intent-quote-binding.js`

The suite drives the **real** functions from `functions/index.js` on the Firestore emulator:
- `requestDeliveryQuote`, `createCheckoutSession`, `createPaymentIntent`;
- `initiateSTKPush`, with only its one outbound IntaSend HTTPS call answered by a local stub (every other outbound call
  is blocked and counted);
- `webhookIntasend`, challenge-verified with a test-only secret value;
- the carry and `rider-entitlement`.

The browser's own Firestore writes (pending order, forged pin, named session) are made with the Admin SDK, i.e.
assuming B2 lets the browser write them. Forgeries are **valid, self-consistent pins of real quotes**, so no older
guard (conservation, version, band) can refuse them for an unrelated reason.

| tree | result |
|---|---|
| new | **34 / 0** |
| old (`505bd34`, `git archive` export) | **10 / 24 FAIL** |

The seven mandatory proofs:

| Proof | New | Old (`505bd34`) |
|---|---|---|
| **A** wrong payment/order pairing fails | A-1..3: `intent_order_mismatch`, nothing written | A-1 **priced** order B from A's pin |
| **B** wrong buyer fails | B-1 `buyer_mismatch` (order held by another uid), quote not consumed; B-3 `payer_mismatch` | B-1, B-3 **priced** |
| **C** forged browser quote/session is not authority | C-1..3: a browser pin never reaches the rider record (`browser_quote_conflict`); C-4/5: a browser-named session is ignored, the intent's quote is bound, the session is untouched | C-1 **carried the forged pin**; C-4/5 **bound the session's quote** and consumed the session |
| **D** pickup: no dispatch | D-1..3: 0 dispatches, even with crafted meta `"delivery"`; order recorded `pickup`; D-4 carry refuses | D-1, D-3 **dispatched**; order recorded `delivery` |
| **E** duplicate webhook: one binding, one rider credit | E-1..4: one delivery record; quote and order pin byte-identical after replay; repeated carry is a no-op; exactly **one** rider credit, from the bound quote | E-2..4 fail: nothing bound, **0** credits (`no_pinned_quote`) |
| **F** already-bound quote fails closed | F-1..3: one quote legitimately on two intents; the first paid order binds it; the second is refused `quote_bound_to_another_order`; never replaced | F-1, F-2 fail: nothing bound, reason `no_pinned_quote` |
| **G** webhook-first without browser verification | G-2..8: the intent records fulfilment and quote; the webhook binds it; the order gets the server pin; ONE priced delivery record (`quotePinSource: intent`); Repair 5 derives the entitlement from it. The same holds with the pending order written first. | G-2, G-4..8 fail: `no_pinned_quote`, Repair 5 refuses |

**How to read these two numbers (owner, at commit review).** 34/0 is the proof of the new implementation. 10/24 is
the old-tree differential, **not "24 bugs fixed"**. The 24 old-tree failures show that the authority behaviour
changed. The 10 old-tree passes are controls: they show that the harness still exercises the existing behaviour it is
expected to exercise.

On the old tree the passing cases are the unchanged ones:
- the controls: G-0, G-1, G-3, D-0, F-0;
- the pre-existing webhook claim (E-1);
- the no-write outcomes that the old code reached by not binding at all (A-2, B-2, C-2);
- the no-intent legacy control (L-1).

In each of those proofs, the discriminating assertion fails on the old tree.

## Regression floor

Both trees ran the same 54-entry runner in one emulator session each, with `SERVED_RULES_PATH` set (new = this
worktree, old = the main checkout at `505bd34`).

**Identical on both trees:**
- Gate C, RES-1 and RES-1b are GREEN.
- Quote authority 128/0, marketplace delivery authority 22/0, RES-1 option 1 23/0, rider entitlement 32/0.
- Webhook attribution 34/0, product payment 27/27, payment intents 12/0, purposes verticals 42/0.
- Single-shop 29/0, multi-shop 26/0 and 34, QR 81/0, pay-q 43/0, till paid 19/0.
- Healthcare 40/0 and 120/0, subscriptions 45/0 and 76/0, offers 35/0, vehicle 40/0, C1 credit guard GREEN.
- Business scope 62/0 and 14/0, POS service 75/0, catalogue 81/0, merchant nav 71/0 and 67/0, POS basket 64/0,
  quick charge 44/0.
- Commission 20/0, 16/0 and 44/0, post-PIN money chain 43/0.
- Dispute 39/0 and 26/0, refund reasons 21/0, returns 33/0, settled case 66/0, refund 55/0, escrow 13/0.
- Delivery-PIN 65/0, IntaSend checkout 50/0, P3 GREEN, verify-commission and engine-sync pass.

**Not green on both trees, with identical failing lines (pre-existing):**
- `certify-intasend-webhook-retirement` (6 lines);
- `certify-d1d2-daraja-retirement` (3 lines);
- `certify-p3a-pos-qr-association` (6 lines);
- the merchant suites: routes 2, ecosystem-convergence 1, package-convergence 8. Ecosystem is 119/0.

**Notes:**
- `certify-payment` is a per-payment CLI tool (prints usage, exits 2 on both trees), not a suite.
- `test-returns-server-authority` printed 33/0 and then hit a libuv teardown assertion (exit 127) in the shared
  session. Re-run in isolation it is 33/0, exit 0.
- `certify-delivery-pricing-v1` cannot load in the worktree (no `functions/node_modules`). Its dependencies
  (`delivery-quote-authority`, `money-authority`, `write-delivery-pricing-policy`) are byte-identical to `505bd34`. On
  the old tree it is 33/1, the pre-existing live-policy check. It is **not** claimed for this change.
- Predeploy gates pass: syntax, require-closure, commission single-source, settled-case guard, engine sync. No HTML
  was touched.

## Conditions and boundaries — what this repair does NOT claim

1. **B2 is untouched.** Browser-writable `deliveryQuote` / `deliveryQuoteId` / `sessionId` on orders remain a rules
   repair. A browser pin naming a *different* quote now makes that order's delivery `pricingBlocked`
   (`browser_quote_conflict`): it fails closed and is visible. It is never paid from.
2. **No new rider or wallet authority.** `rider-entitlement.js` is unchanged. The binding makes Repair 5's existing
   `QUOTE_NOT_BOUND` precondition satisfiable on the main path, and nothing more.
3. **`pos-marketplace-sync` is now intent-authoritative too.** It calls `deliveryPricingForOrder(db, {orderId})`,
   and the carry consults `paymentIntents/{orderId}`. This was named in the design, and the file is unchanged. It
   still decides pickup from `order.fulfillmentType` (browser-written). A pickup intent there is refused by the carry
   (`pickup_order_no_delivery`), but that file still writes an unpriced record. Found, not changed.
4. **Intents without `fulfillmentType`.** Intents minted before this change keep the webhook's legacy default for
   the *dispatch decision*. A delivery-priced one with a quote is still bound. One with no quote is refused
   `intent_carries_no_quote`, where it was `no_pinned_quote` before. The exposure is bounded by the intent TTL,
   and by the fact that this code is not deployed.
5. **The intent-less STK path** (browser amount, no intent) and **`verifyIntasendPayment`** are unchanged; both are
   separate payment-authority defects already recorded.
6. **The rounding residue** (at most KES 0.50 between the quote's minor units and the whole-shilling charge) is still
   unallocated. It is not interpreted as rider pay or SOKONI revenue here.
7. **The browser-SDK callback investigation** and the **deployment/provenance blocker (B5)** are separate. This is not
   a claim that production behaves this way.

## Database / API / security changes

- **Database:** `paymentIntents/{orderId}.metadata.fulfillmentType` (new, server-written). The order's
  `deliveryQuoteId` / `deliveryQuote` are now written by the server on the main path; these existing fields were
  previously absent there. There is no migration, no backfill, and no historical order is rewritten.
- **API:** none. The callable signatures are unchanged. `deliveryPricingForOrder` accepts an optional `intentRef`.
- **Security:** closes a browser-authored pin/session becoming carry authority on the intent path; closes pickup
  orders being dispatched; makes the charged quote single-use on the main path.
- **Breaking:** none for callers.
- **Deployment:** none performed. Deploying requires the provenance gap (B5) to be resolved first.
