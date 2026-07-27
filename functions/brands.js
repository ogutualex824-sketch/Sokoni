/* ══════════════════════════════════════════════════════════════════════════
   Bravilex — Brand layer

   ONE legal entity, MANY consumer brands.

   company-identity.js is the canonical source for corporate metadata and stays
   exactly that: legalName, registration number, KRA PIN, postal address,
   settlement identity. Those belong to Bravilex International Co. Limited and do
   NOT vary by brand. eTIMS submissions, invoices and settlement continue to
   carry the one entity.

   What DOES vary is what a customer sees: the name on the receipt header, the
   logo, the colours, the support address, which catalogue they are browsing, and
   which compliance controls apply.

   WHY HERE AND NOT A FOURTH REGISTRY
   Three primitives already claim to describe a brand:
     company-identity.js  COMPANY.brand = 'SOKONI'  (frozen, 9 importing modules)
     franchiseBrands/{id} (franchise-engine.js)     a franchisee registry
     tenants/{tenantId}   (firestore.rules:2124)    a data-isolation boundary
   Adding a fourth would repeat the mistake that produced five lifecycle
   vocabularies. franchiseBrands describes franchisees of a brand, and tenants is
   an access boundary — neither is "which storefront am I". So this extends the
   CompanyIdentity layer, per the directive, and is the only place a consumer
   brand is defined.

   COMPLIANCE IS A DECLARED PROPERTY OF THE BRAND
   requiresAgeVerification is not a UI flag. It is the brand telling the platform
   which controls it is subject to, so a new surface cannot forget to apply them.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { COMPANY } = require('./company-identity');

/* Every brand inherits the legal entity. Only consumer-facing fields differ. */
const BRANDS = Object.freeze({

  sokoni: Object.freeze({
    id:            'sokoni',
    displayName:   'SOKONI',
    tagline:       'Kenya\'s marketplace',
    domains:       ['mysokoni.co.ke', 'www.mysokoni.co.ke', 'sokoni-aeb26.web.app'],
    logo:          '/assets/logo.png',
    theme:         Object.freeze({ bg: '#050505', accent: '#71ff00', ink: '#e8e8e8' }),
    supportEmail:  COMPANY.email,
    homepage:      '/',
    /* null = no catalogue restriction; SOKONI is the general marketplace. */
    categories:    null,

    /* SOKONI is not a restricted storefront — most of it needs no gate. But it
       DOES carry adult categories (adult-gate.js:8 lists vape, alcohol, tobacco,
       adult), so those individual categories are gated even though the brand is
       not. Leaving this empty, as it first was, would have meant SOKONI's own
       adult listings sold with no age check at all — a pre-existing hole, not
       one KASS introduced.

       Kept in step with age-verification.js RESTRICTED_CATEGORIES; the parity
       test asserts they do not drift. */
    requiresAgeVerification: false,
    restrictedCategories: Object.freeze(['vape', 'alcohol', 'tobacco', 'adult', 'nicotine',
                                         'vape-devices', 'pods', 'coils', 'e-liquids', 'vape-accessories']),
    complianceNotice:
      'Age-restricted items may not be sold to persons under 18.',
  }),

  kass: Object.freeze({
    id:            'kass',
    /* Renamed with the merchant (2026-07-26). This is the customer-facing name
       and it feeds `brandName` in documentBranding(), so leaving it as
       "KASS Vapes" printed a different name on receipts than the storefront and
       seller record show. The `domains` below are deliberately NOT renamed —
       kassvapes.co.ke is live infrastructure and host->brand resolution depends
       on it. */
    displayName:   'KASS SHOP',
    tagline:       'Vape devices, pods and e-liquids',
    domains:       ['kassvapes.co.ke', 'www.kassvapes.co.ke'],
    logo:          '/assets/brands/kass-logo.png',
    theme:         Object.freeze({ bg: '#0a0710', accent: '#b06cff', ink: '#ece8f4' }),
    supportEmail:  COMPANY.email,
    homepage:      '/kass',

    /* Catalogue isolation. Shared inventory and orders; merchandising scoped. */
    categories:    Object.freeze(['vape-devices', 'pods', 'coils', 'e-liquids', 'vape-accessories']),

    /* THE REASON THIS BRAND HAS ITS OWN ENTRY.
       Every category KASS sells is age-restricted, so the whole storefront is
       gated rather than individual products — a customer cannot assemble a
       basket that slips past a per-item check. */
    requiresAgeVerification: true,
    restrictedCategories: Object.freeze(['vape-devices', 'pods', 'coils', 'e-liquids', 'vape-accessories']),
    complianceNotice:
      'Sale to persons under 18 is prohibited. Nicotine is an addictive substance. ' +
      'Age verification is required before purchase.',
  }),
});

const DEFAULT_BRAND = 'sokoni';

function getBrand(id) {
  const key = String(id || '').trim().toLowerCase();
  return BRANDS[key] || BRANDS[DEFAULT_BRAND];
}

/* Resolve from a request hostname. Unknown hosts fall back to SOKONI rather than
   erroring — an unrecognised domain must not take the platform down. */
function brandFromHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
  for (const b of Object.values(BRANDS)) {
    if (b.domains.includes(h)) return b;
  }
  return BRANDS[DEFAULT_BRAND];
}

/* Does this brand + category combination require a verified age?

   Deliberately returns true when the BRAND requires verification, regardless of
   the category argument. KASS sells nothing unrestricted, and a per-category
   check would be only as trustworthy as the category label attached to the
   item — which on this platform is client-supplied. Gating the storefront
   removes that dependency. */
function requiresAgeVerification(brandId, category) {
  const b = getBrand(brandId);
  if (b.requiresAgeVerification) return true;
  if (!category) return false;
  return b.restrictedCategories.includes(String(category).toLowerCase());
}

/* Consumer-facing document header. Legal identity is untouched: the receipt
   still carries Bravilex as issuer, because Bravilex is the seller of record.
   Only the presentation layer changes. */
function documentBranding(brandId) {
  const b = getBrand(brandId);
  return {
    brandName:    b.displayName,
    logo:         b.logo,
    supportEmail: b.supportEmail,
    /* Unchanged, and deliberately not overridable per brand. */
    legalName:          COMPANY.legalName,
    registrationNumber: COMPANY.registrationNumber,
    postalAddress:      COMPANY.postalAddress,
    complianceNotice:   b.complianceNotice,
  };
}

module.exports = {
  BRANDS, DEFAULT_BRAND,
  getBrand, brandFromHost, requiresAgeVerification, documentBranding,
  brandIds: () => Object.keys(BRANDS),
};
