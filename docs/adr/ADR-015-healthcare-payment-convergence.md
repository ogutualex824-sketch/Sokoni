# ADR-015 — A healthcare consultation is a service booking; IntaSend is the only rail

**Date:** 2026-09-12 · **Status:** Accepted · Gates 2 + 3 IMPLEMENTED 2026-09-13 (not deployed) ·
Gates 4 (healthcare deposit values), 6 (pharmacy `product_order`) and 7 (card) remain open
**Conforms to:** `docs/BOOKING_PAYMENT_CONTRACT.md` v1.0 (RATIFIED 2026-07-28) — **contract of record, unchanged by this ADR**

Related: [[ADR-010]] · [[ADR-011]] · [[ADR-013]] · [[ADR-014]] · [[Payments]] · [[Healthcare]] · [[Orders]]

---

## Context

The Healthcare Hub collects consultation fees through `SokoniMpesa.pay()` →
`darajaSTKPush` — **Safaricom Daraja, straight into the provider's own M-Pesa till**
(`sokoni-mpesa.js:3`: "Payment goes DIRECTLY to seller's M-Pesa"; `:222`: the `sellerUid` "holds
Daraja credentials"). `sokoni-intasend.js` is loaded on `healthcare.html:305` and never called.

Because the money never reaches SOKONI, the hub has: no commission, no escrow, no payment document,
no reconciliation record, no refund capability, and no way to verify that payment occurred — it
trusts a client-side `onSuccess` callback, which [[ADR-011]] and
[[feedback_client_cannot_establish_financial_fact]] both forbid. Three further defects compound it:

- The invoice asserts `subtotal`/`total` equal to the consultation fee on **every** path, including
  `paymentMethod: 'Pay at Facility'`. On payment *failure* the handler still calls
  `_finalise('Pending Payment')` — an unpaid appointment produces a receipt.
- `status: "confirmed"` is set client-side at booking creation, before any server contact.
- Every booking fails server-side regardless: `providerId` is a literal from a hardcoded array
  (`hc1`, `sp01`), so `bookAppointment` throws `not-found`, the rejection is swallowed, and the UI
  reports success.

**Daraja is a Safaricom API with no card rail.** The hub is therefore M-Pesa-only *by construction* —
not by IntaSend configuration. It is not on IntaSend at all.

### The decisive finding

`docs/BOOKING_PAYMENT_CONTRACT.md` v1.0, **ratified 2026-07-28**, already specifies this money flow
and already names the rail: *"Payment authorized (M-Pesa STK via IntaSend) → webhook confirms →
paymentStatus:paid (funds HELD)"*. It already decides deposits, held funds, the single provider
credit point, cancellation forfeits, refunds and payment expiry.

**A healthcare consultation is a service booking.** This ADR therefore records *conformance to an
existing ratified contract*, not a new payment policy — and must not duplicate that contract.

Production census (2026-09-12): `providerBookings` = **4**, `providerAvailability` = 2,
`providerServices` = 1. The canonical rail has real production usage. It is infrastructure, not a
specification that was never run.

## Decision

**Every Healthcare Hub payment uses the SOKONI IntaSend architecture, through the canonical
service-booking path. No healthcare payment rail exists.**

This governs consultations, appointments, healthcare products, facility services, deposits, full
payments, cancellations and refunds, and any future healthcare checkout.

```
reserveSlot → providerBookings (pending, slot-locked, expiresAt)
            → createPaymentIntent({ purpose:'service_booking', bookingId })   ← server snapshots price/fee/deposit
            → IntaSend STK  POST /api/v1/payment/mpesa-stk-push/              ← Bearer, method:'M-PESA'
            → webhookIntasend → paymentStatus: paid_held                      ← funds HELD
            → provider confirms → completed
            → Phase C settlement — the ONE credit point
```

### Commission

**Healthcare service-booking commission = 5%**, aligned with the current marketplace rate. Recorded
here as the policy input; the commission engine is unchanged by this ADR.

The rate itself was already in the single canonical table (`commission-config.RATES.healthcare`,
5%) — what was missing was any way for a booking to *reach* it. The booking settlement path passed
`subscriptionRole: 'provider'`, which puts the engine in compatibility mode where the provider's
**plan** rate is absolute and outranks the category table. A healthcare provider on Free Trial
would therefore have been charged **20%**, not the approved 5%.

Two details of the selection are load-bearing and are documented in `functions/provider-hub.js`:

- **`subscriptionRole` is omitted** for healthcare. Passing it would let the plan rate outrank 5%.
- **`skipMinimum: true` is passed** for healthcare. The KES 10 platform floor is suppressed on
  plan-priced bookings via the engine's internal `usingSubRate` flag; dropping `subscriptionRole`
  also drops that suppression, which would newly apply a floor the provider booking path has never
  had (a KES 100 consultation at 5% = KES 5 → KES 10, a 100% increase). The flag keeps this a rate
  change and nothing else.

`commissionRules` and `revenueConfig` still outrank both, so platform governance is unaffected.

### Which hub a booking belongs to — and why not `providers/{uid}.category`

Pricing needs to know a booking is healthcare. The obvious discriminator is the provider's own
`category` field, and it is the wrong one: it is written from `draft.profile.category` through
`_san()` (length cap + angle-bracket strip) and is **never validated** against `SERVICE_CATEGORIES`,
which is only ever *served* to the client by `providerGetCatalogue` and never used to check what
comes back. The field is provider-settable free text.

Pricing on it would let **any** provider type "Healthcare" into their own profile and move from
their plan rate — up to 20% — down to 5%. That is a self-serve discount on live money, and this
convergence would have introduced it.

The authority-bearing signal is the **role on the provider's DECIDED application**: an admin sets it
through `applicationDecide`; the applicant cannot. An *undecided* application is only what someone
asked for, so it is never allowed to move a provider off the default rate. This is the same signal
[[ADR-014]]/OB-6 uses to select a provider's legal agreements, resolved the same way.

It is resolved **once, server-side, at booking creation** and snapshotted as `commissionHub`, so it
obeys contract invariant 2 alongside `price`/`fee`/`deposit`: a provider reclassified later does not
retroactively reprice bookings taken under the old classification, and settlement performs no extra
read. It is deliberately **not** the booking's `hubType`, which is client-supplied and descriptive.

Resolution is fail-soft *to the higher charge*: an unreadable or absent application resolves to the
plan-priced default, so a lookup failure can never hand out the cheaper healthcare rate.

### Card

Card is **required wherever the live IntaSend account enables it — and is a separately gated
workstream.**

The only card code on the platform is `payment-orchestrator.js:288-291`, which hand-assembles
`https://payment.intasend.com/pay/checkout/?ref=<paymentId>` with **no session creation, no amount,
no currency and no API key**. It cannot collect money. Real card support requires IntaSend's Checkout
API, which is called nowhere in this repository. The canonical booking checkout likewise renders a
single "Pay with M-Pesa" control (`sokoni-book-service.js:233`).

**Whether card is enabled on the live SOKONI IntaSend account is UNPROVEN and must be read from the
IntaSend dashboard.** It must not be inferred from code, and the account's API must not be probed to
find out. Until it is confirmed *and* the Checkout API is implemented, healthcare presents M-Pesa
only — which is correct behaviour, not a gap.

### What this forbids

- **No healthcare Daraja path.** `darajaSTKPush` also serves POS and its callback settles
  `posPayments`; healthcare must stop calling it, and its wider retirement is scoped separately.
- **No healthcare payment purpose.** `service_booking` already exists and already prices from
  `providerServices`.
- **No fourth writer of `payments`.** Three mechanisms are already exported from `index.js`; the
  orchestrator's lowercase `succeeded` is never written in production, so it is not the live writer.
- **No invented card flow.** A fabricated checkout URL is worse than no card support: it presents a
  method that silently cannot collect.
- **No payment-time provider credit.** The legacy `webhookIntasend` `type:'booking'` immediate-credit
  branch must not be landed on.
- **No receipt before settlement**, and no success state before the canonical write returns.

## Implementation — Gates 2 + 3 (2026-09-13, landed together, not deployed)

Removed from `healthcare.html`: the `SokoniMpesa.pay` → `darajaSTKPush` branch and the
`sokoni-mpesa.js` tag; both `SokoniPay.bookNow` entries (appointment and teleconsult); all three
`SokoniInvoice.generate` calls; the client-written `status:"confirmed"`; and the `onFailure`
handler that called `_finalise('Pending Payment')` so a **failed** payment still produced a
confirmed appointment and an invoice. Added: `sokoni-book-service.js`, and delegation from
`openAppt` to `SokoniBookService.open` for a provider carrying a real `providerId`.

**The Daraja branch was latent, not live.** `PROVIDERS` in `healthcare.html` is a hardcoded array
of 28 sample entries; none carries `sellerUid` or `consultationFee`, and nothing merges Firestore
providers into it, so `apptTarget.sellerUid` was always null and the branch never fired — every
appointment fell through to `_finalise('Pay at Facility')`. This is stated precisely because the
removal closes a **reachable-on-first-real-provider** hole rather than an actively leaking one; the
fabricated invoices, the client `confirmed` and finalise-on-failure *were* live on every booking.

The sample directory entries have no Firestore identity, no rate card and no availability, so they
cannot be booked canonically and must not take money. They now open an appointment **request** that
moves no money and claims no confirmation. `bookingCreateService` independently refuses them:
it fail-closes on a missing `providers/{uid}`.

Server: `provider-hub.js` (new) resolves and selects; `booking-service.js` stamps `commissionHub`;
`provider-ops.js` passes hub-selected inputs at **both** commission call sites — completion and
forfeited deposit — so a healthcare no-show is not charged a rate its completion is not.

Verified by `scripts/test-healthcare-payment-convergence.js` — 40/0, with the commission assertions
executing the real `_disburseHeldFunds`, the real `calculateCommission` and the real
`commission-config` against a stubbed data layer. `COUNTERPROOF=1` replays the same handlers and
fixtures against HEAD: 17 checks fail, including a healthcare booking settling **2000 cents where
it must settle 500**. Unchanged-behaviour controls (generic booking at the plan rate, a legacy
booking with no `commissionHub`) pass in **both** runs, which is what makes the change a rate
change for healthcare and a no-op for everyone else.

### Open policy dependency — NOT decided here

`docs/BOOKING_PAYMENT_CONTRACT.md` §3 *is* authoritative and is inherited unchanged: provider
cancel → full refund; customer ≥24h → full refund; customer <24h → deposit retained, remainder
refunded; no-show → deposit forfeited. These are implemented (`provider-ops.js`), so healthcare
invents no window and no forfeiture percentage.

But the contract's §4 ("what is collected upfront") and §5 ("escrow / held-funds mechanism") are
headed **"(decision to confirm)"** — recommendations, not ratified decisions. The implementation has
settled them *de facto*: `_disburseHeldFunds` computes `heldC = priceC + feeC`, which is
full-amount-upfront with the deposit as the forfeitable portion, held logically. Code agreeing with
a recommendation is not ratification, and the gap should be closed in the contract rather than
inferred from the code.

**What remains genuinely undecided is the healthcare `deposit` value itself** — the forfeitable
portion of a consultation price, a per-service field on `providerServices`. It is a commercial and
clinical decision (does a missed appointment forfeit 0%, 50%, 100%?), it is not established in any
authoritative source, and it was therefore **not** chosen here. Until it is set, a healthcare
service defaults to `deposit: 0`, which means a late cancel or no-show forfeits nothing — safe and
conservative, but not a substitute for the decision.

## Consequences

- Healthcare gains escrow, refunds, cancellation policy, commission, settlement and reconciliation
  **by conformance** — the work is deletion and re-pointing, not construction.
- Four items are genuinely new: healthcare cancellation windows, the commission rate (above),
  prescription-required dispensing rules for pharmacy products, and card.
- Convergence depends on `providerServices` being populated, which depends on real approved providers
  — so [[ADR-014]] sequences ahead of this.
- Conformance is testable against the contract's five invariants; each assertion runs on stripped
  source, counted by exit code, with targeted sabotage.

## Alternatives rejected

| alternative | why not |
|---|---|
| keep Daraja for healthcare | platform takes no commission, holds no funds, cannot refund or reconcile, and trusts a client callback |
| add a `healthcare_booking` payment purpose | `service_booking` already prices exactly this from the rate card |
| build healthcare checkout on `payment-orchestrator` | its status vocabulary is absent from production; it is not the live writer |
| ship card now using the existing branch | the URL creates no session and cannot collect money |
| assume card is enabled because IntaSend supports it | provider capability is not account configuration; [[ADR-008]] — measure, do not assume |
| defer IntaSend until the storefront is built | money correctness gates the storefront, not the reverse |
