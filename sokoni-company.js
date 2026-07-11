/* ================================================================
   SOKONI — Company Identity (single source of truth, client-side)
   sokoni-company.js

   ONE place for the legal entity's PUBLIC identity metadata used by
   client-rendered documents (SmartPOS receipts, on-device invoices,
   footers). All client code should read window.SOKONI_COMPANY instead
   of duplicating literals.

   Legal owner:  Bravilex International Co. Limited
   Consumer brand: SOKONI (customer-facing, unchanged)

   Note on the KRA PIN: this is a PUBLIC tax identifier that is legally
   printed on tax invoices and receipts — it is NOT a secret. The
   authoritative source for server-generated documents is Secret Manager
   (ETIMS_PLATFORM_PIN); this client copy exists only so offline / on-device
   SmartPOS receipts can display the legally-required PIN. Keep the two in
   sync (update both when the PIN changes).
================================================================ */
(function (w) {
  'use strict';
  w.SOKONI_COMPANY = {
    legalName:       'Bravilex International Co. Limited',
    brand:           'SOKONI',
    kraPin:          'P051521597J',        /* verified — legally shown on tax receipts/invoices */
    address:         'Nairobi, Kenya',
    email:           'support@mysokoni.co.ke',
    phone:           '+254 800 SOKONI',
    website:         'mysokoni.co.ke',
    incomeTaxStatus: 'ACTIVE',
    footerCopyright: '© 2026 SOKONI · A product of Bravilex International Co. Limited · All Rights Reserved.',
    operatedBy:      'Operated by Bravilex International Co. Limited',
    poweredBy:       'Powered by Bravilex International Co. Limited',
  };
})(typeof window !== 'undefined' ? window : this);
