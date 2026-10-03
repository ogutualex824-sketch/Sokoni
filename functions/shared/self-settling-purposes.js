'use strict';
/**
 * Payment purposes that SETTLE THEMSELVES through their own entitlement adapter.
 *
 * For these, the IntaSend webhook must stop after recording the payment COMPLETE — before its
 * generic marketplace commission calculation, its commissionLedger write and its seller wallet
 * credit — because:
 *   (a) their intents carry no `sellerUid`, so the generic credit would fall back to
 *       payData.uid and pay the BUYER; and
 *   (b) their commercial policy is not the marketplace one (shared/commercial-policy.js):
 *         film_access  → Creator 30 / 70 royalty ledger (creator-hub.js)
 *         event_ticket → 3 % net of provider fee, organizer paid when each ticket is admitted
 *                        (event-settlement.js)
 *         venue_booking → 5 % Entertainment booking lane, venue owner paid at the buyer's show-up
 *                        (venue-payments.js)
 * Activation hangs off the payments/{ref} trigger of each module, so it runs whichever webhook
 * wrote the payment. Purpose is read from the server-minted INTENT, never from client meta.
 */
/* fitness_membership (2026-10-03): HELD by membership-settlement, released monthly after first attendance — never a seller credit. */
/* vehicle_boost (2026-10-03): SOKONI revenue, fulfilled by vehicle-boosts.fulfilVehicleBoost — never a seller credit. */
/* rental_booking (2026-10-03): HELD until the shop completes the rental; deposit refundable, commission on rent only — never a payment-time seller credit. */
const SELF_SETTLING_PURPOSES = Object.freeze(new Set(['film_access', 'event_ticket', 'venue_booking', 'fitness_membership', 'vehicle_boost', 'b2b_lead_invoice', 'rfq_quote', 'rental_booking']));

function isSelfSettling(purposeOrType) {
  return SELF_SETTLING_PURPOSES.has(String(purposeOrType || ''));
}

module.exports = { SELF_SETTLING_PURPOSES, isSelfSettling };
