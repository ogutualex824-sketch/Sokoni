/* ================================================================
   SOKONI — Company Identity (single source of truth, server-side)
   functions/company-identity.js

   ONE place for the legal entity's identity metadata. All server-side
   document generators (invoices, receipts, tax documents, emails,
   settlement/financial reports) MUST import from here instead of
   duplicating literals.

   Legal owner:  Bravilex International Co. Limited
   Consumer brand: SOKONI (unchanged, customer-facing)

   The KRA PIN is the ONLY sensitive-ish field and is NEVER hardcoded:
   it lives in Secret Manager (ETIMS_PLATFORM_PIN) and is read via
   getKraPin() inside functions that bind the secret. Everything else
   (legal name, address, email, phone) is public registration data.
================================================================ */
'use strict';

const { defineSecret } = require('firebase-functions/params');

/* Company KRA PIN — single source of truth (Secret Manager). Bind ETIMS_PLATFORM_PIN
   to any function that calls getKraPin(). defineSecret is idempotent per name, so
   modules that already define it (etims.js, sasos-billing.js) keep working. */
const ETIMS_PLATFORM_PIN = defineSecret('ETIMS_PLATFORM_PIN');

/* Non-secret, public registration metadata — safe to reuse anywhere. */
const COMPANY = Object.freeze({
  legalName:       'Bravilex International Co. Limited',
  brand:           'SOKONI',
  address:         'Nairobi, Kenya',
  city:            'Nairobi',
  country:         'Kenya',
  email:           'info@mysokoni.co.ke',
  billingEmail:    'billing@mysokoni.co.ke',
  supportEmail:    'support@mysokoni.co.ke',
  phone:           '+254 800 SOKONI',
  website:         'mysokoni.co.ke',
  websiteUrl:      'https://mysokoni.co.ke',
  incomeTaxStatus: 'ACTIVE',
  /* Human-facing legal footer strings — reuse these to avoid drift. */
  footerCopyright: '© 2026 SOKONI · A product of Bravilex International Co. Limited · All Rights Reserved.',
  operatedBy:      'Operated by Bravilex International Co. Limited',
  poweredBy:       'Powered by Bravilex International Co. Limited',
});

/* Read the company KRA PIN from Secret Manager. Only call inside a function that
   binds ETIMS_PLATFORM_PIN (secrets:[ETIMS_PLATFORM_PIN]). Returns '' if unavailable
   so document generation never crashes — the PIN simply renders blank until set. */
function getKraPin() {
  try { return ETIMS_PLATFORM_PIN.value() || ''; } catch (_) { return ''; }
}

module.exports = { COMPANY, ETIMS_PLATFORM_PIN, getKraPin };
