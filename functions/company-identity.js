/* ================================================================
   SOKONI — CompanyIdentity Service (canonical source, server-side)
   functions/company-identity.js

   THE single source of truth for all corporate metadata on the server.
   Every generator (invoice, receipt, SmartPOS, PDF, email, report) and
   SEO/JSON-LD builder MUST import from here — never duplicate literals.

   Legal owner:   Bravilex International Co. Limited
   Consumer brand: SOKONI (customer-facing, unchanged)

   The KRA PIN is the only secret-managed field: it lives in Secret Manager
   (ETIMS_PLATFORM_PIN) and is read via getKraPin() inside functions that
   bind the secret. Everything else is public registration data.
================================================================ */
'use strict';

const { defineSecret } = require('firebase-functions/params');

/* Company KRA PIN — single source of truth (Secret Manager). Bind ETIMS_PLATFORM_PIN
   to any function that calls getKraPin(). defineSecret is idempotent per name. */
const ETIMS_PLATFORM_PIN = defineSecret('ETIMS_PLATFORM_PIN');

/* ── Canonical public metadata ─────────────────────────────────── */
const COMPANY = Object.freeze({
  /* Identity */
  legalName:        'Bravilex International Co. Limited',   // registered legal entity
  brand:            'SOKONI',                               // consumer brand
  operatingName:    'SOKONI',                               // trading / operating name
  incomeTaxStatus:  'ACTIVE',                               // KRA income-tax status

  /* Addresses */
  address:          'Nairobi, Kenya',                       // registered office (display)
  registeredOffice: 'Nairobi, Kenya',
  postalAddress:    '',                                     // TODO: set verified P.O. Box (not yet provided)
  city:             'Nairobi',
  country:          'Kenya',
  countryCode:      'KE',

  /* Registration (fill when provided) */
  registrationNumber: '',                                  // TODO: company registration no. (not yet provided)

  /* Contact */
  email:            'info@mysokoni.co.ke',
  billingEmail:     'billing@mysokoni.co.ke',
  supportEmail:     'support@mysokoni.co.ke',
  phone:            '+254 800 SOKONI',
  supportPhone:     '+254 705 726 803',

  /* Web */
  website:          'mysokoni.co.ke',
  websiteUrl:       'https://mysokoni.co.ke',
  domain:           'mysokoni.co.ke',
  logoUrl:          'https://mysokoni.co.ke/assets/Sokonilogo2.png',

  /* Reusable legal strings (avoid drift across documents) */
  footerCopyright:  '© 2026 SOKONI · A product of Bravilex International Co. Limited · All Rights Reserved.',
  operatedBy:       'Operated by Bravilex International Co. Limited',
  poweredBy:        'Powered by Bravilex International Co. Limited',
  ownershipStatement: 'SOKONI is owned and operated by Bravilex International Co. Limited.',
});

/* Read the company KRA PIN from Secret Manager. Call only inside a function that binds
   ETIMS_PLATFORM_PIN. Returns '' if unavailable so document generation never crashes. */
function getKraPin() {
  try { return ETIMS_PLATFORM_PIN.value() || ''; } catch (_) { return ''; }
}

/* ── Derived issuer blocks (single place the shape is defined) ───── */
/* Invoice issuer — for tax invoices / billing documents. Pass a pin (getKraPin())
   from a secret-bound caller, or omit to resolve it here. */
function invoiceIssuer(pin) {
  return {
    name:    COMPANY.legalName,
    pin:     pin != null ? pin : getKraPin(),
    address: COMPANY.address,
    email:   COMPANY.billingEmail,
    phone:   COMPANY.phone,
    website: COMPANY.website,
  };
}
/* Receipt issuer — for customer receipts. */
function receiptIssuer(pin) {
  return {
    name:    COMPANY.legalName,
    pin:     pin != null ? pin : getKraPin(),
    address: COMPANY.address,
    poweredBy: COMPANY.poweredBy,
  };
}
/* SmartPOS issuer — POS receipts (brand kept as "SOKONI SmartPOS"). */
function posIssuer(pin) {
  return {
    brand:   'SOKONI SmartPOS',
    name:    COMPANY.legalName,
    pin:     pin != null ? pin : getKraPin(),
    operatedBy: COMPANY.operatedBy,
  };
}
/* PDF document metadata (author/producer/creator). */
function pdfMeta() {
  return {
    author:   COMPANY.legalName,
    producer: COMPANY.legalName,
    creator:  `${COMPANY.brand} (${COMPANY.legalName})`,
  };
}
/* Organization schema (JSON-LD) — publisher/organization for structured data. */
function orgSchema() {
  return {
    '@type':     'Organization',
    'name':      COMPANY.brand,
    'legalName': COMPANY.legalName,
    'brand':     COMPANY.brand,
    'url':       COMPANY.websiteUrl,
    'logo':      COMPANY.logoUrl,
    'email':     COMPANY.email,
    'telephone': COMPANY.supportPhone,
    'address':   { '@type': 'PostalAddress', 'addressLocality': COMPANY.city, 'addressCountry': COMPANY.countryCode },
  };
}
/* Email footer metadata block. */
function emailFooter() {
  return { poweredBy: COMPANY.poweredBy, copyright: COMPANY.footerCopyright, brand: COMPANY.brand };
}

module.exports = {
  COMPANY, ETIMS_PLATFORM_PIN, getKraPin,
  invoiceIssuer, receiptIssuer, posIssuer, pdfMeta, orgSchema, emailFooter,
};
