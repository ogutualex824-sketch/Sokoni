# Till Gift-Card Payment Integrity — P0 Brief

Owner direction, 2026-10-03. Related: [[IntaSend Convergence Brief]], [[SmartPOS]], [[Gate 13 Browser Fabrication Census]].

**Scope:** the till (`till.html`) **and `pos-checkout.html`** — the owner said "same for pos-checkout.html". The known
client site is `pos-checkout.html` → `PosLoyalty.redeemGiftCard` (IndexedDB debit; the direct `giftCards` update is refused
and the error swallowed) → `posCompleteCheckout([{ method: 'gift_card', amount: total }])`, which the server never verifies.

## Target

```
TILL / POS CHECKOUT
  ↓
payment method
  ├── CASH      → existing cash authority
  ├── INTASEND  → server payment record → IntaSend confirmation → sale completion
  └── GIFT CARD → server gift-card authority
                    → validate card · owner/eligibility · balance · amount
                    → reserve/redeem atomically
                    → payment record
                    → sale completion
```

There is no fourth path called "browser says paid".

## The brief (verbatim)

SOKONI — TILL GIFT-CARD PAYMENT INTEGRITY — P0 SERVER-SIDE REPAIR

**OWNER:** sokoni-5b POS lane

DO NOT modify the Till UI as the primary fix. The browser-side UI must not be allowed to determine that a gift-card
payment succeeded.

**CURRENT GAP.** Till currently accepts `paymentMethod = gift_card`, `paid = true` without a server-side gift-card payment
verification. The browser deducts the balance locally/device-side. The server sale-completion authority does not
independently verify the gift-card payment. Therefore the browser can fabricate payment.

**REQUIRED END STATE.** The browser can REQUEST a gift-card payment. Only the server can AUTHORIZE and COMPLETE the
gift-card payment.

**FLOW.**

```
Till
 ↓
server gift-card payment request
 ↓
server loads canonical gift card
 ↓
server verifies:
   - card exists
   - card is active
   - card is eligible
   - card belongs to/was legitimately issued for the applicable account
   - card has sufficient balance
   - amount is valid
   - currency is KES
   - card has not expired/revoked
   - transaction has not already been consumed
 ↓
server atomically reserves/deducts amount
 ↓
server creates authoritative payment record
 ↓
server completes sale
 ↓
ledger/inventory/receipt use same transaction
```

### Security rule

NEVER trust: browser gift-card balance; browser "payment successful"; browser "gift card paid"; browser deduction;
browser payment reference. The browser must never directly write the authoritative gift-card balance or payment-success
state.

### Atomicity

Gift-card deduction and payment authorization must be safe against: double click, duplicate request, network retry,
browser refresh, replayed request, two simultaneous tills, two simultaneous sales. A card with KES 1,000 must not
successfully pay two simultaneous KES 1,000 sales. Use the existing transactional/ledger authority where available. Do
NOT create a second gift-card ledger.

### Sale binding

The gift-card payment must bind to the exact sale/order. Verify:

- `giftCardPayment.saleId == sale.id`
- `giftCardPayment.merchantId == sale.merchantId`
- `giftCardPayment.amount == serverCalculatedSaleTotal`
- `giftCardPayment.currency == KES`

Do not accept a browser-supplied final total. The server must calculate the amount from the canonical sale.

### Test matrix

| ID | Case | Expected |
|---|---|---|
| GC-01 | valid gift card + sufficient balance | PASS |
| GC-02 | insufficient balance | REFUSE |
| GC-03 | inactive card | REFUSE |
| GC-04 | expired card | REFUSE |
| GC-05 | revoked card | REFUSE |
| GC-06 | nonexistent card | REFUSE |
| GC-07 | wrong merchant/context | REFUSE |
| GC-08 | wrong sale ID | REFUSE |
| GC-09 | wrong amount | REFUSE |
| GC-10 | wrong currency | REFUSE |
| GC-11 | browser says paid but server payment absent | REFUSE |
| GC-12 | browser supplies fake balance | REFUSE |
| GC-13 | browser supplies fake successful reference | REFUSE |
| GC-14 | duplicate request | one payment only |
| GC-15 | replay same transaction | no second deduction |
| GC-16 | simultaneous redemption | cannot overspend card |
| GC-17 | sale already completed | no second completion |
| GC-18 | card balance exactly equals sale | PASS |
| GC-19 | card balance one cent/one unit below sale | REFUSE |
| GC-20 | failed sale after reservation | reservation safely released/rolled back according to existing financial authority |

### Server sale completion

The canonical POS sale-completion function must independently verify:

- cash: valid cash flow
- IntaSend: verified IntaSend payment record
- gift card: verified server gift-card payment record

No payment method may bypass this gate. A request such as `completeSale({ paymentMethod: "gift_card", paid: true })` MUST
NOT complete a sale.

### Client repair

After server functionality is proven, remove all browser-side authoritative gift-card deduction. The UI may display the
balance returned by the server, request redemption, display success returned by the server, and display failure. The UI
may NOT subtract balance authoritatively, write gift-card balance, create a payment record, mark the sale paid, or
complete the sale locally.

### Rules

Firestore/database rules must deny browser writes to the authoritative gift-card balance, gift-card redemption records,
authoritative payment records, and sale paid/completed state. Server/Admin authority only. Do not weaken rules to
accommodate the existing UI.

### Regression

Run all existing POS payment tests: cash, IntaSend, gift card, refunds, returns, duplicate-sale protection, inventory,
receipts. The gift-card repair must not change cash or IntaSend semantics.

### Proof

Record each test as a named row: TEST · EXPECTED · OBSERVED · DATABASE EFFECT · MONEY EFFECT · SALE EFFECT · PASS/FAIL.
Do not call the repair proven from an exit code alone.

### Deployment

Do not deploy. Build and test server side first. Then build the paired Till UI change. Both halves must be proven
together. Functions deployment must be explicitly scoped: `firebase deploy --only functions:<exact-function>`. No blanket
Functions deployment. Production deployment requires separate authorization.

## The four P0 controls (owner, 2026-10-03)

| # | Control | Owner |
|---|---|---|
| 1 | IntaSend webhook — KES 1 → KES 10,000 attack | sokoni-5b (Gates 5/9/10) |
| 2 | SmartPOS electronic payment — server completion requires a confirmed payment | POS workstream (sokoni-5b POS lane) |
| 3 | Finance OS seller payout — the browser cannot mark a payout completed | sokoni-b2 (taken; owner may reassign) |
| 4 | Till / POS checkout gift card — the browser cannot declare or redeem payment | sokoni-5b POS lane (this brief) |

The fee-record and browser-paid repairs are separate completed code changes (2ddaee5, 2f80fab) and are not reopened.

## Release decision (owner, 2026-10-03)

Security first: once the memory and guard prerequisites clear, ship the IntaSend webhook fix (P0 #1) to close the live
KES 1 vulnerability, **then ship `createPaymentIntent` product_order and its checkout consumer immediately afterwards**, so
legitimate M-Pesa checkouts do not stay in the temporary REVIEW state.
