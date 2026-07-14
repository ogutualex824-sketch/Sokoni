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

    /* Registered office (physical / display) */
    address:          'Nairobi, Kenya',
    registeredOffice: 'Nairobi, Kenya',
    city:             'Nairobi',
    country:          'Kenya',
    countryCode:      'KE',

    /* Postal address (verified) */
    postalAddress:    'P.O. Box 114–50411',   /* P.O. Box (box–postal code) */
    postalCode:       '50411',
    town:             'Siaya',                 /* postal town */

    /* Registration (verified — BRS Certificate of Incorporation) */
    registrationNumber: 'CPR/2014/166272',

    /* Contact — executive */
    email:             'info@mysokoni.co.ke',
    adminEmail:        'admin@mysokoni.co.ke',
    legalEmail:        'legal@mysokoni.co.ke',
    privacyEmail:      'privacy@mysokoni.co.ke',
    complianceEmail:   'compliance@mysokoni.co.ke',
    /* Contact — operations */
    supportEmail:      'support@mysokoni.co.ke',
    financeEmail:      'finance@mysokoni.co.ke',
    billingEmail:      'billing@mysokoni.co.ke',
    paymentsEmail:     'payments@mysokoni.co.ke',
    notificationsEmail:'notifications@mysokoni.co.ke',
    /* Contact — technology */
    securityEmail:     'security@mysokoni.co.ke',
    developersEmail:   'developers@mysokoni.co.ke',
    noReplyEmail:      'noreply@mysokoni.co.ke',
    phone:             '+254 800 SOKONI',
    supportPhone:      '+254 705 726 803',

    /* Web */
    website:          'mysokoni.co.ke',
    websiteUrl:       'https://mysokoni.co.ke',
    domain:           'mysokoni.co.ke',
    logoUrl:          'https://mysokoni.co.ke/assets/Sokoni%20Logo.png',

    /* Reusable legal strings */
    footerCopyright:  '© 2026 SOKONI · A product of Bravilex International Co. Limited · All Rights Reserved.',
    operatedBy:       'Operated by Bravilex International Co. Limited',   /* legal operator line */
    poweredBy:        'Powered by SOKONI',                                /* brand statement (customer-facing) */
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
  /* Full postal address line, composed from atomic parts (no duplicate literal).
     → "P.O. Box 114–50411, Siaya, Kenya" */
  C.postalLine = function () {
    return C.postalAddress + ', ' + C.town + ', ' + C.country;
  };
  /* Receipt / SmartPOS issuer block for client-rendered documents. */
  C.receiptIssuer = function () {
    return {
      name: C.legalName, pin: C.kraPin, regNo: C.registrationNumber,
      address: C.address, postal: C.postalLine(), operatedBy: C.operatedBy,
    };
  };

  w.SOKONI_COMPANY = C;
})(typeof window !== 'undefined' ? window : this);
