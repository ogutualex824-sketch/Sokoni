'use strict';
/**
 * SOKONI — LSK (Law Society of Kenya) verification ADAPTER.  Mode A of the Legal Verification Authority.
 * ============================================================================================
 * This is the seam where an OFFICIAL, AUTHORIZED machine-readable LSK integration plugs in. There is
 * none today:
 *
 *   LSK automated integration: NOT AVAILABLE / NOT AUTHORIZED.
 *
 * Investigated 2026-09-27: no LSK endpoint, credential, contract or configuration exists anywhere in
 * this repository (functions/.env keys, platformConfig docs, integration catalogue, docs/). LSK's
 * public material directs the public to its online advocate SEARCH (practising status: Active /
 * Inactive / Struck Off / Suspended / Unknown / Deceased; practising numbers begin "P.105"). A public
 * search page is not an API: this adapter does NOT scrape it, does NOT automate any login, and does
 * NOT invent an endpoint. Until LSK authorizes an integration, verification is Mode B — an
 * administrator checks the official LSK source and records the evidence in AdminOS
 * (legal-verification.js legalAdminRecordLsk), and the record says so.
 *
 * CONTRACT for a future authorized integration (the only thing legal-verification.js depends on):
 *
 *   available()            -> true only when an authorized integration is configured server-side
 *   lookup(p105Number)     -> { p105Number, name, practiceStatus, checkedAtMs, reference }
 *                             practiceStatus ∈ Active | Inactive | Struck Off | Suspended | Unknown | Deceased
 *                             reference = the integration's own response / transaction id (audit)
 *
 * Credentials, when they exist, are Secret Manager secrets bound to the calling function — never a
 * client value and never a Firestore field. Replacing the two functions below is the whole change;
 * the booking / payment architecture does not move.
 */
const { HttpsError } = require('firebase-functions/v2/https');

const STATUS = Object.freeze({
  available: false,
  reason: 'LSK automated integration: NOT AVAILABLE / NOT AUTHORIZED. Verify against the official LSK advocate search and record the evidence (Mode B).',
});

function available() { return STATUS.available; }

async function lookup(/* p105Number */) {
  throw new HttpsError('unavailable', STATUS.reason, { code: 'LSK_INTEGRATION_UNAVAILABLE' });
}

module.exports = { available, lookup, STATUS };
