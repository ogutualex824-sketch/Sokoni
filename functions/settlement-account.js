/* ================================================================
   SOKONI — Settlement Account Service (canonical, server-side ONLY)
   functions/settlement-account.js

   THE single source of truth for the platform's primary COLLECTION /
   Merchant-of-Record settlement account. Every customer payment across
   the SOKONI ecosystem is collected into this account first; the
   Settlement Engine then calculates deductions and pays out sellers.

       Buyer → Gateway → [ Bravilex Collection Account ] → Settlement Engine → Seller net

   SECURITY (hard rules):
     • The account NUMBER is sensitive operational data and lives ONLY in
       Secret Manager (SETTLEMENT_ACCOUNT_NUMBER). It is NEVER hardcoded,
       NEVER shipped to the client, NEVER returned by a public API.
     • Only authorized backend services (functions that bind the secret and
       enforce admin/superAdmin) may read the full number via
       getSettlementAccount(). Admin UIs receive the MASKED form only.
     • The account NAME must match the bank record EXACTLY
       ("Bravilex International Co. Ltd") — banks match on exact string, so
       this is intentionally distinct from CompanyIdentity.legalName
       ("… Co. Limited"). Do not "normalise" it.
================================================================ */
'use strict';

const { defineSecret } = require('firebase-functions/params');

/* Sensitive: the collection account number is Secret-Manager only.
   Bind SETTLEMENT_ACCOUNT_NUMBER to any function that calls getSettlementAccount().
   defineSecret is idempotent per name. */
const SETTLEMENT_ACCOUNT_NUMBER = defineSecret('SETTLEMENT_ACCOUNT_NUMBER');

/* Exact bank account name (public-facing on settlement records; not secret,
   but must never be edited to match CompanyIdentity — banks match exactly). */
const ACCOUNT_NAME = 'Bravilex International Co. Ltd';
const ACCOUNT_ROLE = 'PRIMARY_COLLECTION';   // Merchant-of-Record inbound account
const ACCOUNT_CURRENCY = 'KES';

/* Read the collection account number from Secret Manager. Returns '' if
   unavailable so ledger/reconciliation never crash — callers must treat ''
   as "not configured" and refuse to initiate a real transfer. */
function getAccountNumber() {
  try { return SETTLEMENT_ACCOUNT_NUMBER.value() || ''; } catch (_) { return ''; }
}

/* Mask to last-4 for logs / admin display: "••••0001". */
function maskNumber(n) {
  n = String(n || '');
  return n.length <= 4 ? n : '••••' + n.slice(-4);
}

/* FULL account — backend payout / reconciliation / ledger ONLY.
   Caller MUST bind SETTLEMENT_ACCOUNT_NUMBER and enforce admin. */
function getSettlementAccount() {
  const number = getAccountNumber();
  return {
    name:         ACCOUNT_NAME,
    number,                              // full — never send to client
    numberMasked: maskNumber(number),
    role:         ACCOUNT_ROLE,
    currency:     ACCOUNT_CURRENCY,
    configured:   !!number,
  };
}

/* MASKED account — safe for admin dashboards / settlement records / logs.
   Never contains the full number. */
function getSettlementAccountMasked() {
  return {
    name:         ACCOUNT_NAME,
    numberMasked: maskNumber(getAccountNumber()),
    role:         ACCOUNT_ROLE,
    currency:     ACCOUNT_CURRENCY,
    configured:   !!getAccountNumber(),
  };
}

/* Assert the collection account is configured before initiating a real
   settlement/payout. Throws a plain Error the caller maps to an HttpsError. */
function assertConfigured() {
  if (!getAccountNumber()) {
    throw new Error('Settlement collection account not configured (SETTLEMENT_ACCOUNT_NUMBER secret missing).');
  }
  return true;
}

module.exports = {
  SETTLEMENT_ACCOUNT_NUMBER,
  ACCOUNT_NAME, ACCOUNT_ROLE, ACCOUNT_CURRENCY,
  getSettlementAccount, getSettlementAccountMasked,
  getAccountNumber, maskNumber, assertConfigured,
};
