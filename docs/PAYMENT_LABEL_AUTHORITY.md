# Till payment labels — authority map (convergence slice 13)

> **Status:** map for owner review, 2026-09-29. Local, uncommitted until authorised. Branch `slice/c4-convergence` on
> `8b9ca72`. Related: [[COMMERCE_CONVERGENCE_CENSUS]] · [[SOKONI_POINTS]] · [[SmartPOS]]
>
> **Owner rule:** "Every payment label must either represent a real authorized payment path, or be refused. No
> arbitrary 'points' / 'voucher' / similar string may complete a sale without an authorized payment record."
> Card and gift card must be made to WORK end to end, not merely refused.

## The sale authority and its gap

`posCompleteCheckout` (`functions/pos-zero-friction.js`) is the ONE till sale authority: merchant-v2 Sell, pos-checkout
and pos-v2 cash, and catalogue Quick Charge from this slice on. Its tender check today:

| Label | What it requires today | Result |
|---|---|---|
| `cash` | nothing — the drawer is the audit | OK by design |
| `mpesa`, `card`, `mpesa_daraja` | `posPayments/{ref}` with `status === 'completed'`, same shop, amount ≥ line; single-use `posPaymentClaims` | **Only the RETIRED Daraja callback writes `completed`.** The IntaSend-verified POS QR path (`pos-qr.js` `completePOSQRPayment`) writes `paid`, so it never counts. No server writes a card record. Sell and pos-checkout send no reference, so these tenders are refused in practice and M-PESA / card do not work at the till. |
| `wallet` | `posWallets/{customer}` balance, debited in the transaction | OK (top-ups are cashier-declared: census note) |
| `points` | the buyer-confirmed redemption for this shop + sale (P2b) | OK |
| **anything else** (`gift_card`, `split`, `mpesa_till_manual`, `qr`, `bank`, `voucher`, …) | **nothing** | **completes the sale with no evidence** and is booked as electronic money |

## Proposed authority per label (extend, never add)

| Label | Evidence the sale must present | Authority reused |
|---|---|---|
| `cash` | unchanged | drawer / shift reconciliation |
| `mpesa`, `card` | **a PAID IntaSend payment**: `intentRef` → `paymentIntents/{ref}` with `purpose: pos_till_sale`, `status: 'paid'` (set only by the verified webhook), `metadata.shopId` = this shop, `metadata.saleId` = this sale's key, amount = the tender. Claimed once through `posPaymentClaims/{intentRef}`. | Quick Charge / `createPaymentIntent(pos_till_sale)` + `webhookIntasend` (the payment registry). Card is the SAME proof paid through IntaSend's card rail; there is no simulator and no separate card record. |
| ~~`mpesa` (legacy Daraja)~~ | **RETIRED — owner 2026-09-29: "no daraja everything intasend".** A `posPayments` `completed` record (written only by the retired Daraja callback) no longer settles a sale, and the `mpesa_daraja` label is refused. | — |
| `wallet`, `points` | unchanged | existing |
| `gift_card` | `code` (+ `pin`), redeemed **inside the sale transaction** from ONE store: `giftCards/{code}` (shop-scoped, `balance`, `pin`, `status`, `expiryDate`). Must be this shop's card, active, unexpired, PIN-matched and cover the amount. Balance is decremented atomically with the sale. | `pos-completeness.js` store (served via `smartPosDispatch` `giftCardIssue` / `giftCardRedeem` / `giftCardBalance`) |
| `mpesa_till_manual` (**owner to confirm**: paid straight to the merchant's own Till — neither Daraja nor IntaSend) | an M-PESA confirmation code (format `REF_RE`), claimed **once per merchant** through the existing reference claim; recorded as **merchant-attested, not SOKONI-observed** (the manual-till invariant) | `pos-mpesa-refs.js` `claimReference` |
| `split` | never a tender — a split is several tenders, each proving itself | — |
| anything else | **refused** | — |

### Why `giftCards` and not the other two stores

| Store | Issue path | Verdict |
|---|---|---|
| `giftCards` (`pos-completeness.js`) | shop-scoped (`shopId`), stored-value balance + PIN, transactional redemption | **canonical** — the only stored-value, shop-scoped one. Its own `_assertPOS` reads `shops.ownerId` and does not check an employee is still active; the sale path does not use it (the sale is already authorised by `posCompleteCheckout`'s shop authority) |
| `posGiftCards` (`pos-crm-pro.js`) | `_resolveSellerId` trusts `req.data.sellerId` when there is no claim | not used by the sale; frozen (no migration here) |
| `loyaltyGiftCards` (`loyalty-enterprise.js`) | promo-style (`valueType` fixed/percent, `maxUses`) | a coupon, not stored value; not a tender |
| pos-checkout IndexedDB (`pos-loyalty-engine.js`) | device-side decrement, error swallowed | retired as a tender: the server redeems |

Owner decision still open: whether existing `posGiftCards` / `loyaltyGiftCards` balances are migrated into `giftCards`.
**No production data is migrated in this slice.**

## Client impact (live tills)

- **pos-checkout `gift_card`:** the device-side IndexedDB decrement is replaced by server redemption inside the sale.
  A code that is not in `giftCards` is refused.
- **pos-checkout `split`:** already sends component tenders. Each is proven; a literal `split` label is refused.
- **M-PESA / card at Sell and pos-checkout:** this slice's server side accepts the paid intent. The UI half (send the
  request, wait for PAID, complete with `intentRef`) comes in the same slice, after this map is reviewed.
- **pos.js (`mpesa_till_manual`, `qr`, `split`):** these sync straight to `posTransactions` and never reach
  `posCompleteCheckout`. That is a separate lineage decision, recorded and not changed.

## Decisions taken (owner, 2026-09-29/30)

- **No Daraja — every electronic payment through IntaSend.** `mpesa_daraja` and the Daraja `posPayments` "completed"
  record no longer settle a sale.
- **Manual M-PESA to the merchant's own Till is refused** (SOKONI never sees it).
- M-PESA and card at the till = a PAID IntaSend `pos_till_sale` payment bound to the sale. The Quick Charge pricer now
  records `metadata.saleId`, the sale's key.

## UI (end to end)

- **merchant-v2 Sell:** M-PESA → "Send M-PESA request" (`createPaymentIntent` for exactly the amount due, bound to the
  sale → `initiateSTKPush`). Card → "Show payment QR" (`mintDynamicSokoniQR`); the customer pays on their phone.
  Complete stays locked until the server says PAID, then the sale completes itself with `intentRef`.
  `sokoni-merchant-data.buildSale` carries `intentRef`.
- **pos-checkout:** M-PESA uses the same IntaSend payment. This replaces `SokoniPay.platformBook` (the legacy booking
  path) and the Daraja `posSendMpesa`. Card uses the payment QR. A gift card goes to the server as code + PIN; the
  device-side IndexedDB check and decrement are retired.

## One spelling per tender (fixed 2026-09-30)

**Defect, proven by execution.** The allow-list and the M-PESA/card confirmation lower-cased the tender label, but the
wallet debit (`payments.find(p => p.method === 'wallet')`) and the cash-change rule matched it **exactly**.

- `"Wallet"` passed the allow-list, was never debited, and **completed the sale with no money**: goods out, no
  `posWalletTransactions`.
- `"WALLET"` against a funded wallet completed and left the balance untouched.

**Fix.** `posCompleteCheckout` canonicalises every tender, in place, the moment the payments are read
(`method = String(method).trim().toLowerCase()`), before any reader. The allow-list, points, gift cards, the IntaSend
confirmation, the wallet debit, the cash-change rule and the sale record then all see one spelling. No reader keeps a
private copy of the rule.

**Evidence.** `test-payment-labels.js` PL10:

- `"Wallet"` with an empty wallet is refused and nothing moves;
- `"WALLET"` with KES 1,000 is debited to 0 and the wallet transaction is written (positive control);
- `" CASH "` gives change;
- `"MPESA"` with no proof is refused.

The parent `e8cde7d` fails PL10: `"Wallet"` completes, and the funded wallet is not debited. Breakages 2/2 (no
canonicalisation; case without trim).

**Serving production is worse, measured statically by another session and NOT executed.** The live
`posCompleteCheckout` (`ee37437`) has **no tender allow-list**, so `"Wallet"` or any invented label (`"free"`, `"bank"`)
skips confirmation and debit and completes the sale. The POS line (`8183694` / `3357619`) adds the allow-list but keeps
the exact-match wallet debit. This fix is local to `slice/c4-convergence`. The serving lineage needs the same
one-spelling rule when the owner assigns it; it is Track A in `C:/temp/COMMERCE_CENSUS_2026-09-30.md`.

> **PORT HAZARD.** The undeployed POS line (`8183694`, and sokoni-69's frozen `3357619`) carries the same residual
> hole: the 6b allow-list lower-cases, while the wallet debit matches `'wallet'` exactly. **Whoever ports that line onto
> the serving lineage must take this canonicalisation, or a merge that includes it.** Otherwise the bypass is
> re-imported. PL10 is the regression test to carry with it.

## Evidence

| | |
|---|---|
| Server | `test-payment-labels` **10/0** (PL1–PL9 incl. PL9: the REAL pricer binds the sale) |
| Browser (Chromium) | `test-payment-labels-sell-browser` **4/0** · `test-payment-labels-poscheckout-browser` **4/0** |
| Counterproof `8b9ca72` | server 9/10 fail (cash control passes); Sell 5/6 fail; pos-checkout 5/6 fail (page-error controls pass) |
| Mutation manifest | **20/20 caught** — server 14 (unknown label, intent status / shop / sale / amount / purpose, gift card debit / re-read / PIN / shop, manual M-PESA, Daraja, non-IntaSend M-PESA, pricer sale id) + UI 6 (Sell locked until PAID, proof sent, data layer carries it, intent bound; pos-checkout PIN, M-PESA proof) |
| Full regression | 183 suites vs `8b9ca72`: 178 identical; `catalogue-canonical-migration` = dirty-tree check; `merchant-v2-ecosystem-runtime` 131/0 alone (batch flake); 3 new green. `certify-pos-payment-ownership` NOT GREEN identically on the parent. |

**Recorded, not changed:**
- **POS QR (`pos-qr.js`):** a second IntaSend till rail that writes `posPayments` "paid" and creates its own order.
  It needs converging onto the intent authority.
- **Quick Charge pricer:** it lets only the shop OWNER ring a charge, so employee cashiers cannot take M-PESA / card yet.
- **pos.js:** it syncs straight to `posTransactions`, bypassing the sale authority.
- **Existing gift cards:** `posGiftCards` / `loyaltyGiftCards` balances are not migrated (owner decision).
