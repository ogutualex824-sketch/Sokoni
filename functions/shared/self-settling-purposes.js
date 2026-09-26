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
 *         event_ticket → 3 % net of provider fee, organizer paid after the event
 *                        (event-settlement.js)
 * Activation hangs off the payments/{ref} trigger of each module, so it runs whichever webhook
 * wrote the payment. Purpose is read from the server-minted INTENT, never from client meta.
 */
const SELF_SETTLING_PURPOSES = Object.freeze(new Set(['film_access', 'event_ticket']));

function isSelfSettling(purposeOrType) {
  return SELF_SETTLING_PURPOSES.has(String(purposeOrType || ''));
}

module.exports = { SELF_SETTLING_PURPOSES, isSelfSettling };
