# Rentals deploy scope — `functions/rentals-on-53100ff`

Related: [[CONSTRUCTION_HUB_CONVERGENCE]] · [[Payments]] · [[Orders]]

This tree carries the equipment-rental lifecycle, the rental PIN, settlement, receipts and the deposit-refund executor.
It is **not** a general functions release. Deploy **only** the names below, one at a time, each with `--only functions:NAME`.

## Deploy from this tree (in order, only after the dependencies are live)

| Order | Function | Depends on (must already be live) |
|---|---|---|
| 1 | `commerceDispatch` | sokoni-5b P0 webhook `73c5e5e` → providerDispatch `451acee` (booking-PIN core) → rental webhook `feat/webhook-rental-hold-on-73c5e5e` → sokoni-2f `createPaymentIntent` (rental_booking pricer + commissionSnapshot) |
| 2 | `rentalPinOnRentalBooking` | the providerDispatch booking-PIN release, with `booking-pin-core.js` + `shared/ent-booking-identity.js` byte-identical to this tree |
| 3 | `rentalDepositRefundOnCreate`, `rentalDepositRefundReconcile`, `adminSetRefundPolicy` | `refundPolicy/b2c.minCents` set by an admin through `adminSetRefundPolicy` (until then every refund holds `b2c_minimum_not_configured`) |

## NEVER deploy from this tree

- **`fos*` (financial-os / finos-admin):** this tree's `payment-adapters.js` is intentionally **pre-repair**. The repaired
  adapter (`1af3029`) requires `invoiceId`, and `financial-os.js` still calls `initiateRefund({ originalRef })`
  (:512, :616). Repair unit = adapter `1af3029` + financial-os passing `invoiceId`, owned by whoever owns financial-os
  refunds, as its own unit with its own tests. Until then rental deposits hold `refund_adapter_unproven` (safe).
- **Anything else not in the table above.** This tree is the e3 DE-2 commerce lineage plus rentals; other functions live on
  their own lineages (see the functions lineage gate).

## Known holds (safe by design)

- Deposit refunds: `refund_adapter_unproven` until the adapter repair unit ships; `b2c_minimum_not_configured` until an
  admin sets the floor. The floor value is an OWNER decision, recorded in config, never in code.
- Settlement: refuses `no_commission_snapshot` for any rental priced before the snapshot pricer shipped.
