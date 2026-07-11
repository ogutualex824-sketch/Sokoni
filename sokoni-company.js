/* ================================================================
   SOKONI — CompanyIdentity Service (canonical source, client-side)
   sokoni-company.js  →  window.SOKONI_COMPANY

   THE single source of truth for corporate metadata used by client
   code (SmartPOS receipts, on-device invoices, footers, SEO/JSON-LD).
   Client code must read window.SOKONI_COMPANY / its helpers — never
   duplicate literals.

   Legal owner:   Bravilex International Co. Limited
   Consumer brand: SOKONI (customer-facing, unchanged)

   The KRA PIN here is a PUBLIC tax identifier (legally printed on tax
   invoices/receipts) — NOT a secret. The authoritative source for
   server-generated documents is Secret Manager (ETIMS_PLATFORM_PIN);
   this client copy exists so on-device / offline SmartPOS receipts can
   display the legally-required PIN. Keep the two in sync.
================================================================ */
(function (w) {
  'use strict';

  var C = {
    /* Identity */
    legalName:        'Bravilex International Co. Limited',
    brand:            'SOKONI',
    operatingName:    'SOKONI',
    incomeTaxStatus:  'ACTIVE',
    kraPin:           'P051521597J',          /* verified — legally shown on tax receipts/invoices */

    /* Addresses */
    address:          'Nairobi, Kenya',
    registeredOffice: 'Nairobi, Kenya',
    postalAddress:    '',                     /* TODO: verified P.O. Box (not yet provided) */
    city:             'Nairobi',
    country:          'Kenya',
    countryCode:      'KE',
    registrationNumber: '',                   /* TODO: company reg no. (not yet provided) */

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

    /* Reusable legal strings */
    footerCopyright:  '© 2026 SOKONI · A product of Bravilex International Co. Limited · All Rights Reserved.',
    operatedBy:       'Operated by Bravilex International Co. Limited',
    poweredBy:        'Powered by Bravilex International Co. Limited',
    ownershipStatement: 'SOKONI is owned and operated by Bravilex International Co. Limited.',
  };

  /* Organization JSON-LD (SEO / structured data). */
  C.orgSchema = function () {
    return {
      '@type':     'Organization',
      'name':      C.brand,
      'legalName': C.legalName,
      'brand':     C.brand,
      'url':       C.websiteUrl,
      'logo':      C.logoUrl,
      'email':     C.email,
      'telephone': C.supportPhone,
      'address':   { '@type': 'PostalAddress', 'addressLocality': C.city, 'addressCountry': C.countryCode },
    };
  };
  /* Receipt / SmartPOS issuer block for client-rendered documents. */
  C.receiptIssuer = function () {
    return { name: C.legalName, pin: C.kraPin, address: C.address, operatedBy: C.operatedBy };
  };

  w.SOKONI_COMPANY = C;
})(typeof window !== 'undefined' ? window : this);
