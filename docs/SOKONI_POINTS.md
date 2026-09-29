# SOKONI Points

> One SOKONI-wide points balance per person, earned on every purchase at any SOKONI shop, spendable later.
> Related: [[Loyalty]] · [[SmartPOS]] · [[Payments]] · [[MARKETING_OFFERS]] · [[LOYALTY_CONTINUITY_REQUIREMENT]]

## Status

| Phase | Scope | State |
|---|---|---|
| **P1 — Earning** | Till (Sell / pos-checkout), Quick Charge, online checkout, card checkout | **Built locally, not deployed** (branch `slice/c4-points-p1`) |
| **P2a — Spending online** | One rate (0.10), holds, M-PESA = card, checkout display from the server | **Built locally, not deployed** (branch `slice/c4-points-p2`) |
| P2b — Spending at the till | Pay with points, confirmed by a code texted to the buyer | Next |

## Owner decisions (2026-09-29)

- **One balance, SOKONI-wide** — not per shop.
- **Earn:** 1 point per KES 10 of a completed sale (1% back). `KES_PER_POINT_EARNED = 10`.
- **Value:** 10 points = KES 1 (`POINT_VALUE_KES = 0.10`). Online checkout still redeems at KES 0.5/point until P2
  changes it — so no screen or text in P1 states a KES value for a balance.
- The till's phone number is **identity only**: "The cashier's phone lookup is only an identity/customer-assistance
  mechanism; it must never become authority to modify the customer's account."

## The store

There is **no second points store**. Points live in the canonical loyalty collections, Cloud-Functions-only:

- `loyaltyAccounts/{uid}` — `balance`, `lifetimePoints`, `totalEarned`, `tier`. Same shape `createLoyaltyAccount` writes
  (via `loyalty.js` `_internal`).
- `loyaltyLedger/{id}` — one row per earn:

| Field | Meaning |
|---|---|
| `type: 'earn'`, `source` | `till` · `quick` · `online` · `card` |
| `issuerShopId` (+ `merchantId`) | the shop the purchase was made at — carried for P2 funding |
| `points`, `pointsRemaining` | earned; `pointsRemaining` is what P2 draws down lot by lot |
| `amountKES`, `rate` | the authoritative amount the points were computed from |
| `orderId` | the sale / intent / order id |

**Ledger ids are the idempotency guarantee:**

- till `earn__till__{saleId}` · Quick Charge `earn__quick__{intentRef}`
- orders `earn__order__{orderId}__{shopId}` — **one per (order, shop) whichever payment path confirms it**, so the
  IntaSend webhook finaliser and `verifyIntasendPayment` can never both credit one order.

A shop-local `posCustomers.points` figure still exists in the legacy POS CRM. It is **not** this balance
(technical debt, recorded in `ROADMAP.md`).

## Spending (P2)

**Owner decision (2026-09-29): the shop where points are SPENT funds the redemption.** It simply receives that much less
money for the sale. No money moves from the shop that issued the points.

### One rate — `functions/loyalty-points-spend.js`

- 10 points = KES 1 (`POINTS_PER_KES = 10`, derived from `POINT_VALUE_KES`). Online checkout used KES 0.50 until P2a.
- `capFor({ balance, goodsKES, payableKES })` = the least of: the points, **25% of the goods after the shop's offers**, and
  the payable less KES 1. Always whole shillings, so the points spent are a multiple of 10.
- Every surface asks this module: the card session, the M-PESA order (`product_order`), the checkout display
  (`shopOfferQuote` → `points`) and, in P2b, the till. **No page holds a rate.**

### Holds — why points are held, not deducted at payment

Pricing from the balance and deducting after payment let two checkouts spend the same points (the card path did an
uncapped `increment(-points)`, which could go negative). Now a price that includes points first **holds** them in one
transaction: balance −N, `heldPoints` +N, and the oldest earn lots are drawn down (`pointsRemaining`).

| Hold state | When | Effect |
|---|---|---|
| `held` | the session / intent is priced | balance −N, lots drawn |
| `consumed` | the payment completes (exactly once) | ledger `redeem` rows, one per funding shop; `totalRedeemed` +N |
| `released` | the checkout is abandoned, or points switched off | balance and lots restored |

`pointsHolds/{channel}__{ref}` — channel `checkout` (card session id) · `order` (M-PESA order id) · `till` (P2b).

- **Idempotent:** a retried or double-tapped intent for the same order re-prices to the same amount and holds once.
- **Expiry is settled, never guessed:** a hold past 60 minutes is checked against its payment. If it was paid it is
  consumed, if not it is released, and if the payment state cannot be read it is left alone. This runs before a new
  hold and before a balance is shown (`settleExpired`).
- **A late payment is never refused:** if its hold was already released, the points are re-deducted. If they are gone,
  the sale stands, the available points are taken, and the shortfall is flagged in `pointsRedemptionAlerts` (status
  `open`). This is the same "flag, never reject" rule as `oversoldAlerts`.

### Ledger

`loyaltyLedger/redeem__{channel}__{ref}__{shopId}`: `type: 'redeem'`, `points: −N`, `pointsRedeemed: N`, `valueKES`,
`fundingShopId` (the spending shop), `holdId`, and `lots`, the earn rows the points came from with their issuing shops.
Together these keep *points earned → originating shop* and *points redeemed → spending shop*.

### Online: every rail pays the same

| Rail | Priced by | Spent by |
|---|---|---|
| Card / IntaSend session | `createCheckoutSession` → `priceAndHold('checkout', sessionId)` | `verifyIntasendPayment`, inside its transaction (hold read before the first write) |
| M-PESA | `createPaymentIntent(product_order)` → `priceAndHold('order', orderId)` | `webhookIntasend` on PAID |

Both use the same goods, cap and rate, so a KES 1,000 cart with 1,000 points costs **KES 900 on either rail**
(test PS2 / QB3). Points are figures from the **server intent / session only**; points in legacy client meta are ignored.

Orders, the card order doc and the M-PESA receipt carry `pointsRedeemed` / `pointsDiscount` only when points were
spent. **Nothing is earned on the part paid with points.**

### Checkout display

`checkout.html` renders the balance, the "N pts = KES X off this order" line and the discount row **only** from the
server preview returned with the offer quote. It no longer reads `localStorage.sokoniLoyalty` and no longer shows an
invented "+N pts from this order" figure; the earn line states the rule.

## Earning — where and from what amount

All in `functions/loyalty-points.js` → `earnForSale(db, {...})`. Never throws for a buyer problem; the sale always stands.

| Channel | Trigger | Buyer | Amount |
|---|---|---|---|
| Till (merchant-v2 Sell, pos-checkout.html) | `posCompleteCheckout`, after the receipt | `buyerPhone` the cashier looked up | the sale's `authoritativeTotal` |
| Quick Charge | `webhookIntasend`, till intent **PAID** | intent `metadata.buyerPhone`, or the paying number when the buyer paid from their own phone | the **confirmed** amount |
| Online (M-Pesa / IntaSend) | `webhookIntasend` product finaliser | `payData.uid` | goods − shop offer discount (delivery excluded) |
| Card checkout session | `verifyIntasendPayment` | `sessionDoc.uid` | per shop: its lines − its offers (delivery excluded) |

A client-sent points figure is never read. Blocked accounts are not credited. An unknown phone earns nothing and the
receipt says why (`pointsEarned.reason: 'no-account'`).

## The till: identify, or create with consent

Callables (exported in `functions/index.js`):

- **`tillBuyerLookup({ shopId, phone })`** — this shop's staff only (owner/admin/manager/cashier via
  `shop-employees.resolveShopAccess`). Answers `{ found, maskedName: 'J. W.', maskedPhone: '••••678', points }`.
  Never a full number, never a uid.
- **`tillCreateBuyer({ shopId, phone, name?, consent: true })`**
  - refuses without the customer's **consent**;
  - an **existing number is found, never re-created, taken over or modified**;
  - otherwise creates a Firebase Auth user by phone + `users/{uid}` `{ createdVia: 'till', createdByShop, claimed: false }`
    + the loyalty account, and queues the **`till_welcome`** SMS;
  - the cashier receives no password, link or code — the buyer signs in with their own number and an SMS code;
  - a ceiling of **100 accounts per shop per day** (`tillBuyerCreates/{shopId}_{day}`).

UI: merchant-v2 Sell pay sheet ("Customer points"), `pos-checkout.html` (⭐ row), Quick Charge (phone field +
"Check points / create account"). Only a buyer the server has identified is sent with the sale — a number typed but
never looked up is not.

## SMS

Queued through `sms-service.enqueue` (a worker sends). Feature-phone buyers are covered.

- `till_welcome` — transactional: tells the owner of the number that an account exists and how to sign in.
- `points_earned` — optional (`pref: account`): "You earned N points at SHOP. Balance: B points."

## Security

- Points are credited **only** by the server, from the authoritative amount, after the sale / payment completes.
- `loyaltyDispatch` is an allow-list (commit `c59e0f2`); `awardLoyaltyPoints` and friends are `internal` and refused
  to clients. P1 adds no client path that writes points.
- Phones and names are masked in every till response.
- Account creation is consent-gated, capped per shop per day, and never touches an existing account.
- **The card QR is signed with `LOYALTY_HMAC_SECRET` or not at all.** An earn can open a loyalty account for an
  existing SOKONI user; if the secret is unavailable the account is NOT opened (never signed with a placeholder, which
  would make the QR forgeable) and the sale stands with `reason: 'not-credited'`. An existing account still earns.

## Tests

- `scripts/test-points-p1.js` — PT1–PT8, real modules over the fake Firestore; Auth stubbed; SMS queued, never sent.
  Sabotage 15/15.
- `scripts/test-points-p1-browser.js` — PB1–PB5, the real Sell screen in Chromium wired to the real callables and
  `posCompleteCheckout`.
- `scripts/test-points-p2a.js` — PS1–PS12 (+PS3b), real spending module, M-PESA pricer, attribution and finaliser over
  the transactional fake (concurrency is real). The card session and verify wiring are checked **structurally** (PS11):
  they are inline in `index.js`. Sabotage 12/12.
- `scripts/test-points-p2a-checkout-browser.js` — QB1–QB5, the real checkout.html in Chromium with its one points source
  (`shopOfferQuote`) served by the real module. Sabotage 3/3.
- `scripts/test-points-p1-quick-browser.js` — PQ1–PQ4, the real Quick Charge module with the real callables and the real
  Quick Charge pricer; the PAID step is the webhook's own `earnForSale` call.
- UI sabotage 4/4: a phone that was never checked is not sent; creation needs consent (Sell and Quick Charge).

## Deployment

Not deployed. When authorised: `posCompleteCheckout`, `webhookIntasend`, `verifyIntasendPayment`,
`createPaymentIntent` (Quick Charge metadata), and the new `tillBuyerLookup` / `tillCreateBuyer`, plus hosting for
merchant-v2 / pos-checkout.

**Secret bindings change** — `LOYALTY_HMAC_SECRET` is now bound to `posCompleteCheckout`, `verifyIntasendPayment`,
`webhookIntasend` and `tillCreateBuyer`. The secret already exists (used by `createLoyaltyAccount`); the deploy grants
those services accessor. Verify the webhook still answers after deploy — a secret that cannot be resolved stops a
revision from starting. Deploy **after** the `c59e0f2` loyalty security fix.
