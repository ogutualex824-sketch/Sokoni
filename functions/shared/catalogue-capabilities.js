/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — CATALOGUE CAPABILITIES. What each kind of business may list, and how it trades it.
   functions/shared/catalogue-capabilities.js   (byte-identical browser copy: /sokoni-catalogue-capabilities.js,
   published by scripts/build-catalogue-capabilities.js — never edit the copy)

   Universal catalogue U2 (2026-09-29, owner brief): ONE merchant-v2 catalogue engine for every SOKONI business.
   Not 100 uploaders, and not one product form forced on a lawyer or a hotel. A restaurant lists dishes, a hotel lists
   rooms, a lawyer lists consultations, a car-hire firm lists vehicles — through the same writer, the same media
   pipeline and the same inventory authority.

   KEYED ON THE ONE CATEGORY AUTHORITY. The 31 canonical categories of functions/business-category.js (CATEGORIES),
   which the 105 registered business ids (FROM_BUSINESS_ID) and 73 professions (FROM_PROFESSION) resolve to. This file
   holds no category list of its own — scripts/test-catalogue-capabilities.js fails if a category is missing here or
   one is invented.

   THE VOCABULARY IS NOT NEW EITHER. `types` are ids of sokoni-listing-types.js (product, food, drink, room, service,
   event, rental, property, vehicle, digital, package, bundle, custom_job, project) — the owner's object types map onto
   them: MENU_ITEM → food/drink, ROOM → room, EVENT/TICKET → event, BOOKABLE_ITEM → service, VEHICLE → vehicle / rental,
   PROPERTY → property, DIGITAL_PRODUCT → digital, CUSTOM_JOB → custom_job, PROJECT → project.

   PERMISSIONS, NOT PROMISES. A flag says a surface MAY offer something to this kind of business; it never states that a
   business does it. `inventory: true` means stock is tracked through merchantAdjustStock for its countable listings;
   `booking: true` means its bookable listings go to the booking authority — neither invents availability or stock.
   Categories with a merchant workspace profile (functions/business-workspace.js PROFILE_OF) must agree with it; the
   test checks that too.

   UNCLASSIFIED shops (no C1 category yet — the owner ruled no blind backfill; AdminOS classifies) keep EXACTLY what
   they can do today: goods. They are never granted a type by guesswork.

   PURE. No Firestore, no network.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniCatalogueCapabilities = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TYPE_IDS = ['product', 'food', 'drink', 'room', 'service', 'event', 'rental', 'property', 'vehicle', 'digital',
                  'package', 'bundle', 'custom_job', 'project'];

  /* Compliance a listing of this business may be asked for. Each is a DECLARATION until verified (U6): a number a
     seller types is `declared`, never `verified`. */
  var COMPLIANCE = {
    kebs: 'KEBS standards mark', food_licence: 'County food business permit', ownership: 'Ownership / serial record',
    health_facility_licence: 'Health facility licence', pharmacy_licence: 'Pharmacy & Poisons Board licence',
    professional_licence: 'Professional licence', legal_credential: 'Practising certificate (LSK)',
    vehicle_docs: 'Vehicle logbook & insurance', property_title: 'Title / mandate to list', event_permit: 'Event permit',
    business_permit: 'Single business permit',
  };

  /* how a buyer receives it */
  var F = { delivery: 'delivery', pickup: 'pickup', onsite: 'onsite', visit: 'visit', online: 'online', digital: 'digital' };

  function cap(profile, types, o) {
    return {
      profile: profile, types: types,
      inventory: !!o.inventory, booking: !!o.booking, quote: !!o.quote, pos: !!o.pos,
      marketing: o.marketing !== false, staff: !!o.staff,
      fulfilment: o.fulfilment || [], compliance: o.compliance || [],
    };
  }
  var GOODS = ['product', 'bundle', 'package'];

  var CAPS = {
    /* ── Healthcare ── (no invented medical claims: listings describe services; licences are declarations) */
    clinician:    cap('healthcare', ['service', 'package', 'digital'], { booking: true, staff: true, fulfilment: [F.onsite, F.visit, F.online], compliance: ['professional_licence'] }),
    facility:     cap('healthcare', ['service', 'package', 'product'], { booking: true, inventory: true, pos: true, staff: true, fulfilment: [F.onsite, F.pickup], compliance: ['health_facility_licence'] }),
    pharmacy:     cap('healthcare', ['product', 'bundle', 'package', 'service'], { inventory: true, pos: true, booking: true, staff: true, fulfilment: [F.delivery, F.pickup, F.onsite], compliance: ['pharmacy_licence', 'kebs'] }),
    laboratory:   cap('healthcare', ['service', 'package'], { booking: true, staff: true, fulfilment: [F.onsite, F.visit], compliance: ['health_facility_licence'] }),
    telemedicine: cap('healthcare', ['service', 'package', 'digital'], { booking: true, staff: true, fulfilment: [F.online], compliance: ['professional_licence'] }),
    home_care:    cap('healthcare', ['service', 'package', 'custom_job'], { booking: true, quote: true, staff: true, fulfilment: [F.visit], compliance: ['professional_licence'] }),
    /* ── Hospitality ── */
    hotel:        cap('accommodation', ['room', 'package', 'food', 'drink', 'service'], { booking: true, inventory: true, pos: true, staff: true, fulfilment: [F.onsite], compliance: ['business_permit', 'food_licence'] }),
    restaurant:   cap('food', ['food', 'drink', 'package', 'bundle', 'product'], { inventory: true, pos: true, staff: true, fulfilment: [F.delivery, F.pickup, F.onsite], compliance: ['food_licence'] }),
    /* ── Home & professional services ── */
    trades:       cap('quoted_service', ['service', 'custom_job', 'project', 'package', 'product'], { quote: true, booking: true, inventory: true, pos: true, staff: true, fulfilment: [F.visit, F.pickup], compliance: ['professional_licence'] }),
    cleaning:     cap('quoted_service', ['service', 'package', 'custom_job'], { quote: true, booking: true, staff: true, fulfilment: [F.visit, F.onsite, F.pickup], compliance: [] }),
    it_services:  cap('quoted_service', ['service', 'product', 'digital', 'package', 'bundle', 'custom_job', 'project'], { quote: true, booking: true, inventory: true, pos: true, staff: true, fulfilment: [F.onsite, F.visit, F.delivery, F.pickup, F.digital], compliance: ['kebs', 'ownership'] }),
    salon:        cap('appointment_shop', ['service', 'package', 'product'], { booking: true, inventory: true, pos: true, staff: true, fulfilment: [F.onsite, F.visit], compliance: ['business_permit'] }),
    lawyer:       cap('quoted_service', ['service', 'package'], { booking: true, quote: true, staff: true, fulfilment: [F.onsite, F.online], compliance: ['legal_credential'] }),
    professional_services: cap('quoted_service', ['service', 'package', 'project', 'custom_job', 'digital'], { quote: true, booking: true, staff: true, fulfilment: [F.onsite, F.online, F.digital], compliance: ['professional_licence'] }),
    education:    cap('learning', ['service', 'package', 'digital', 'event'], { booking: true, staff: true, fulfilment: [F.onsite, F.online, F.digital], compliance: [] }),
    auto_services: cap('quoted_service', ['service', 'package', 'product', 'custom_job', 'rental', 'vehicle'], { quote: true, booking: true, inventory: true, pos: true, staff: true, fulfilment: [F.onsite, F.pickup, F.delivery], compliance: ['vehicle_docs'] }),
    fitness_studio: cap('appointment_shop', ['service', 'package', 'product', 'event'], { booking: true, inventory: true, pos: true, staff: true, fulfilment: [F.onsite, F.online], compliance: [] }),
    service_business: cap('quoted_service', ['service', 'package', 'custom_job', 'product', 'event'], { quote: true, booking: true, inventory: true, pos: true, staff: true, fulfilment: [F.onsite, F.visit, F.pickup, F.delivery], compliance: [] }),
    /* ── Entertainment & events ── */
    artist_creator: cap('entertainment', ['service', 'package', 'digital', 'event', 'custom_job'], { booking: true, quote: true, staff: true, fulfilment: [F.onsite, F.online, F.digital], compliance: [] }),
    event_services: cap('entertainment', ['service', 'package', 'custom_job', 'project'], { booking: true, quote: true, staff: true, fulfilment: [F.onsite], compliance: [] }),
    event_organizer: cap('events', ['event', 'package'], { booking: true, staff: true, fulfilment: [F.onsite, F.online], compliance: ['event_permit'] }),
    venue:        cap('events', ['service', 'event', 'package'], { booking: true, pos: true, staff: true, fulfilment: [F.onsite], compliance: ['business_permit'] }),
    /* ── Commerce ── (compliance per product comes from the 99-category taxonomy: KEBS / food / ownership) */
    retail_store: cap('commerce', GOODS.concat(['digital']), { inventory: true, pos: true, staff: true, fulfilment: [F.delivery, F.pickup], compliance: ['kebs', 'ownership', 'food_licence'] }),
    supermarket:  cap('commerce', GOODS, { inventory: true, pos: true, staff: true, fulfilment: [F.delivery, F.pickup], compliance: ['kebs', 'food_licence'] }),
    wholesale:    cap('commerce', GOODS, { inventory: true, pos: true, staff: true, quote: true, fulfilment: [F.delivery, F.pickup], compliance: ['kebs', 'food_licence'] }),
    hardware:     cap('commerce', GOODS, { inventory: true, pos: true, staff: true, quote: true, fulfilment: [F.delivery, F.pickup], compliance: ['kebs'] }),
    electronics:  cap('commerce', GOODS.concat(['digital', 'service']), { inventory: true, pos: true, staff: true, booking: true, fulfilment: [F.delivery, F.pickup, F.onsite, F.digital], compliance: ['kebs', 'ownership'] }),
    fashion:      cap('commerce', GOODS.concat(['custom_job']), { inventory: true, pos: true, staff: true, quote: true, fulfilment: [F.delivery, F.pickup], compliance: [] }),
    agriculture:  cap('commerce', GOODS.concat(['service']), { inventory: true, pos: true, staff: true, fulfilment: [F.delivery, F.pickup], compliance: ['kebs', 'food_licence'] }),
    /* ── Property & logistics ── (property moves through viewings and conversations — no basket) */
    property:     cap('property', ['property', 'rental', 'service', 'project'], { booking: true, quote: true, staff: true, fulfilment: [F.onsite], compliance: ['property_title'] }),
    delivery:     cap('logistics', ['service'], { marketing: false, fulfilment: [F.delivery], compliance: [] }),
  };

  /* What an UNCLASSIFIED shop keeps: exactly today's goods selling. Flagged, never passed off as a category. */
  var UNCLASSIFIED = Object.assign(cap('unclassified', GOODS.concat(['digital']), { inventory: true, pos: true, staff: true, fulfilment: [F.delivery, F.pickup], compliance: ['kebs', 'ownership', 'food_licence'] }), { unclassified: true });

  /* The 99-category product taxonomy's `kindOf` each type accepts (null = the taxonomy does not apply). */
  var TYPE_TAXONOMY_KIND = { product: 'physical', bundle: 'physical', food: 'physical', drink: 'physical', digital: 'digital', service: 'service' };

  /* Types whose units are counted through the inventory authority (merchantAdjustStock). */
  var COUNTED = ['product', 'bundle', 'food', 'drink'];
  /* Types a buyer books (booking authority), and types priced by quotation. */
  var BOOKED = ['service', 'room', 'rental', 'event'];
  var QUOTED = ['custom_job', 'project'];

  function capsFor(category) {
    return (category && Object.prototype.hasOwnProperty.call(CAPS, category)) ? CAPS[category] : UNCLASSIFIED;
  }
  function allows(category, typeId) { return capsFor(category).types.indexOf(typeId) !== -1; }

  /**
   * Can this business list this? Pure; returns every reason, never just the first.
   * @param {string|null} category  the shop's C1 category (business.category), or null when unclassified
   * @param {object} listing        { listingType, category (product-taxonomy key) }
   * @param {object} [tx]           the product taxonomy (SokoniProductTaxonomy), when available
   */
  function check(category, listing, tx) {
    var c = capsFor(category), l = listing || {}, errors = [];
    var t = String(l.listingType || 'product');
    if (TYPE_IDS.indexOf(t) === -1) errors.push({ code: 'UNKNOWN_TYPE', message: 'That is not a kind of listing SOKONI knows.' });
    else if (c.types.indexOf(t) === -1) errors.push({ code: 'TYPE_NOT_ALLOWED', message: 'A ' + (c.unclassified ? 'shop that is not yet classified' : 'business of this kind') + ' cannot list a ' + t.replace('_', ' ') + '.' });
    var kind = TYPE_TAXONOMY_KIND[t];
    if (kind && l.category && tx && typeof tx.kindOf === 'function' && typeof tx.isKnown === 'function' && tx.isKnown(l.category)) {
      var k = tx.kindOf(l.category);
      if (k !== kind) errors.push({ code: 'CATEGORY_MISMATCH', message: 'The product category does not fit a ' + t.replace('_', ' ') + ' listing.' });
    }
    return { ok: errors.length === 0, errors: errors, caps: c };
  }

  return {
    TYPE_IDS: TYPE_IDS, COMPLIANCE: COMPLIANCE, FULFILMENT: F, CAPS: CAPS, UNCLASSIFIED: UNCLASSIFIED,
    TYPE_TAXONOMY_KIND: TYPE_TAXONOMY_KIND, COUNTED: COUNTED, BOOKED: BOOKED, QUOTED: QUOTED,
    capsFor: capsFor, allows: allows, check: check,
  };
}));
