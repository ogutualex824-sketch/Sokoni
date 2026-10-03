# Gate 6 — Hub Payment Routes

State on 2026-10-03, from the live `createPaymentIntent` archive (purposes registry), live hosting 72dca56, and the
branches named below. Related: [[IntaSend Convergence Brief]], [[Gate 13 Browser Fabrication Census]].

Rule (owner brief): every SOKONI-mediated payment needs server pricing, a server intent, IntaSend, webhook confirmation
and a canonical record. A hub without that **refuses honestly** and never fabricates success. No new collection path is
invented for any hub.

Live server purposes (`functions/payment-purposes.js`): `subscription`, `digital_download`, `event_ticket`,
`service_booking`, `product_order`, `hub_registration`, `boost`, `marketing_boost`, `commission_collection`.

| Hub | Live today | Server-priced IntaSend route | State / next step |
|---|---|---|---|
| Marketplace checkout | M-Pesa via `createCheckoutSession` → IntaSend → `verifyIntasendPayment` | yes (session) | Card built (5aa9fe3); method fix built (5aa7711). Webhook binding (Gate 5) depends on the `product_order` intent b5d0541 + checkout Unit 3 3eb22ce — owner trade-off (a)/(b) |
| Till / merchant dashboard | Daraja push name, not deployed → fails | IntaSend POS rail on sokoni-2f's union | Not live; server sale gate (Gate 4) owned by the POS workstream, no session named |
| Old POS | refuses (a436e12) / IntaSend POS rail (99e1177) | same | Not live |
| Subscriptions | `subscription` purpose | yes | Live |
| Events / tickets | `event_ticket` purpose | yes | Hosted multi-method checkout on the commercial line, not live |
| Creator / stream | film access is self-settling on the commercial line | partly | Not live |
| Digital downloads | `digital_download` | yes | Live |
| Foundation | pledge-only browser path; server-priced donation | yes (sokoni-2f / sokoni-5b) | Built, not live |
| Delivery / parcels | client IntaSend STK with a client amount (live) | parcel rail 5958eba (sokoni-e3): server-priced, IntaSend, server-confirmed | Not live. The live client-priced STK is a Gate 6 defect until the parcel rail ships |
| Rent | client STK / fake confirmation (live) | — | Owner decision: rent is EXTERNAL, recording-only (sokoni-f3's B2 df1a4cb). No SOKONI collection |
| BnB stays | fake confirmation (live) | none | Refuses honestly (265b1f7). Needs a `bnb_stay` purpose priced from the listing — owner pricing decision |
| Car hire | booking only, no payment | none | Honest booking (sokoni-f3); fabricated fee/commission removed (2ddaee5). Needs a purpose if SOKONI is to collect |
| Car tracking plans | Daraja engine → WhatsApp | none | Support ticket (sokoni-f3). Could map to `subscription` if plans join the plan catalogue — owner decision |
| Healthcare consultation | engine refuses → "Pending Payment" booking | possibly `service_booking` | Check whether the `service_booking` pricer can price a consultation from the provider record; otherwise a purpose is needed |
| Legal deposit | engine refuses → WhatsApp / ticket | possibly `service_booking` | Same check; the KES 500 default deposit is client-side and must not become a price |
| Digital gigs (freelance) | engine refuses; contract not created | none | Needs a purpose (escrowed contract) — owner pricing decision |

## Decisions needed from the owner

1. Which hubs SOKONI collects for at all (BnB, car hire, car tracking, freelance gigs). Rent is already decided: external.
2. For each collected hub, the price authority: listing nightly rate, provider service record, contract bid. That
   decides whether an existing purpose (`service_booking`, `subscription`) fits or a new purpose is added to the
   existing registry. No new payment core either way.
3. Release order relative to the webhook security fix (see the brief's trade-off).

Until then, every hub without a route refuses honestly. That is the safe state, and it is what this branch ships.
