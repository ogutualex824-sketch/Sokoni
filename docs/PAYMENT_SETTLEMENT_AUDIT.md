# Payment & Settlement Architecture — Audit Before Implementation

**Date:** 2026-08-24 · **Method:** read-only trace · **Code changed:** none

The brief said *"audit the existing IntaSend collection, wallet, split-payment, payout,
subscription and settlement implementations before writing anything. Do not create a second
payment system."* This is that audit.

**Headline: most of the target architecture already exists and is deliberately switched off.**
The work is not to build it. It is to (a) verify the provider capability in sandbox, (b) connect
POS to the financial system it currently bypasses entirely, and (c) make delivery PIN a
settlement condition rather than a status field.

---

## 1  Already built, deliberately dormant

| Module | What it already does | Gate |
|---|---|---|
| [`payment-adapters.js`](../functions/payment-adapters.js) | Provider-agnostic adapter; IntaSend `initiateSplitPayment()` scaffolded against `/api/v1/payment/split-collection/` | Endpoint/payload **explicitly marked unconfirmed**; never reached while `splitEnabled=false` |
| [`settlement-providers.js`](../functions/settlement-providers.js) | Per-gateway split capability registry, config-driven, fail-safe | **All gateways ship `splitEnabled: false`** → collect-then-payout fallback always used |
| [`settlement-engine.js`](../functions/settlement-engine.js) | `computeSettlement()` — seller / rider / platform allocation with a **balanced ledger plan**; rider share of delivery fee (default 0.88) | Adopted by `order-settlement`, `settlement-executor`, `settlement-validation` |
| [`order-settlement.js`](../functions/order-settlement.js) | Escrow hold → release, advanced on `status === 'delivered'`, plus an auto-confirm sweep past a config window | Release condition is a **status field**, not verified proof |
| [`payment-config.js`](../functions/payment-config.js) | `resolveCollectionRoute()` — `DIRECT_TO_SELLER` vs `CENTRAL_MOR`, fails closed | `CENTRAL_MOR` refuses loudly without central credentials |
| [`etims-tax-engine.js`](../functions/etims-tax-engine.js) | VAT categories A–E, 16% standard, `computeInvoice()` / `computeCreditNote()` | **Not wired to POS sales** |

The adapter layer is genuinely live — `financial-os.js` and `wallet.js` both call `getAdapter()`.
So there is one payment abstraction, and a second one must not be created.

## 2  The real gaps

### 2.1 POS sales never enter the financial system at all — **the biggest gap**
`posCompleteCheckout` writes `posRetailSales`, `posDaily`, `posReceipts` and stops. It records:

- **no commission entry** (zero matches for `commission` in the module)
- **no ledger entry**
- **no tax computation**
- **no settlement record**

The commission writer is `payment-success.js:170 onPaymentSucceeded`, which watches
**`payments/{paymentId}`** — the IntaSend collection. POS writes `posPayments`. **A till sale
therefore reaches no commission, ledger or tax path under either routing model.**

This is route-independent: it must be fixed whether or not collection ever moves to CENTRAL_MOR.

### 2.2 IntaSend **wallets are not implemented**
Zero calls to any wallets/sub-account endpoint. Implemented IntaSend surface is:
`mpesa-stk-push`, `send-money/initiate`, `payment/collection`, `payment/status`,
`payment/chargeback`, and the one unverified `payment/split-collection`.
**"Working wallets as sub-accounts" is aspiration, not current capability.**

### 2.3 Delivery PIN is not a settlement condition
No settlement module references `deliveryPin` or `proofOfDelivery`. Release advances on
`status === 'delivered'`. The PIN exists but is not the thing that unlocks money — which is
exactly the fraud boundary the brief asks for. Compounded by the standing P0: the rider client
*reads* `deliveryPin`.

### 2.4 No VAT metadata on a sale
`taxTotal` is a client-supplied number. There is no tax rate, no per-item VAT class, no
supplier/purchase side. The tax engine that could supply all of it exists and is unconnected.

### 2.5 No real-time multi-device sync
`merchant-v2.html` contains **zero** `onSnapshot` calls. Two devices cannot see each other's
sales. The till re-reads the catalogue after its own sale only.

## 3  Blocked on something other than code

1. **IntaSend split endpoint is unverified.** The adapter comment says so in as many words.
   Requires a sandbox transaction against the real account before `splitEnabled` may be turned on.
2. **Does the IntaSend account actually have split/wallet entitlements?** Capability defaults in
   `settlement-providers.js` are *assumptions about the product*, not observations of this account.
3. **`CENTRAL_MOR` is a business decision, not a deploy** — `payment-config.js:66-71` records the
   CBK / Safaricom / tax implications. Unresolved: for an **in-person POS sale**, is SOKONI the
   merchant of record, or a software vendor invoicing a receivable?

## 4  Recommended order

**Slice 1 — POS into the ledger and tax trail. Unblocked, route-independent, highest value.**
Every till sale writes a commission entry, a balanced ledger entry and a computed tax line via the
existing engines. Nothing about money movement changes. This alone makes the tax-assistance
product possible and fixes a live integrity defect.

**Slice 2 — Tax period export.** Sales, discounts, payments, commissions, VAT — clearly labelled
**SOKONI estimate**, never *official*. Depends on Slice 1.

**Slice 3 — Delivery PIN as a settlement condition.** Release requires verified proof, not a
status string. Independent of routing.

**Slice 4 — Real-time sync.** `onSnapshot` on the canonical sale/inventory records.

**Slice 5 — Sandbox verification of IntaSend split/wallets.** Gates everything below it.

**Slice 6 — Routing decision + CENTRAL_MOR**, only after 5 and the MoR determination.

## 5  Tax posture (recorded decision)

SOKONI is a **business financial record and tax-assistance system**, not a tax collector. Every
figure it produces is labelled an **estimate based on records held in SOKONI**, kept visually and
structurally distinct from any **official KRA/ETIMS result**. The merchant files. ETIMS becomes an
upgrade path once approval is in place, reusing the same transaction data rather than a second
system.

Related: [[project_collection_route_two_rails]], [[project_settlement_engine]],
[[project_commission_engine]], [[project_etims_v1]], [[project_delivery_pin_payout_track]]
