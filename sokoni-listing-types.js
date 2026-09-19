/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — LISTING TYPES. One authority for what a listing IS and what you do with it.
   sokoni-listing-types.js

   THE PROBLEM THIS SOLVES
   A merchant sells products, serves food, rents rooms, books services and hosts events.
   Hard-coding "Buy Now / Add to Cart" into the listing page makes every one of those a
   product, and pushes each vertical towards its own uploader, its own card and its own
   detail page — the duplication that has to be avoided.

   THE RULE: ONE listing engine, MANY presentation modes. A listing's TYPE decides what the
   customer is offered — Order, Book, Reserve, Request — while the listing itself, its media,
   its inventory and its write authority stay exactly as they are. Nothing here writes, prices
   or reserves anything: it is a vocabulary the surfaces read.

   WHY IT IS A SEPARATE FILE AND NOT A DUPLICATE
   sokoni-product-specs.js owns PHYSICAL SPECIFICATION — units, measures, sizes. It has 15
   categories and none of them are services, rooms or events, because that is not what it is
   for. sokoni-product-schema.js owns VARIANTS — colours, sizes, storage. Listing TYPE is a
   third, distinct concern: what kind of commerce this is. Folding it into either would
   overload a model that already has a clear job. The rule being honoured is no duplicate
   UPLOADERS, WRITERS, CARDS or DETAIL PAGES — this adds none of those.

   TYPE IS INFERRED, NEVER INVENTED
   Listings carry no listingType field today. Rather than fabricate one, typeOf() reads an
   explicit listing.listingType when a merchant has set one, otherwise infers from the
   category vocabulary the marketplace already uses, and otherwise returns 'product' — the
   safe default, because a wrong "Book" on a physical good is worse than a plain "Buy".
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* Each type names the commerce it is, and the words the customer sees. `primary` is the
     committing action; `secondary` is the lower-commitment one, and may be null where a
     basket makes no sense — you do not add a hotel room to a cart. */
  var TYPES = {
    product: {
      id: 'product', label: 'Product', noun: 'item',
      primary: { key: 'buy',   label: 'Buy Now',        icon: '⚡' },
      secondary:{ key: 'cart',  label: 'Add to Cart',    icon: '🛒' },
      availabilityNoun: 'in stock',
    },
    food: {
      id: 'food', label: 'Food', noun: 'dish',
      primary: { key: 'order', label: 'Order Now',       icon: '🍽️' },
      secondary:{ key: 'cart',  label: 'Add to Order',    icon: '🛒' },
      availabilityNoun: 'available',
    },
    drink: {
      id: 'drink', label: 'Drink', noun: 'drink',
      primary: { key: 'order', label: 'Order Now',       icon: '🍹' },
      secondary:{ key: 'cart',  label: 'Add to Order',    icon: '🛒' },
      availabilityNoun: 'available',
    },
    room: {
      id: 'room', label: 'Stay', noun: 'room',
      primary: { key: 'reserve', label: 'Reserve',       icon: '🔑' },
      secondary:{ key: 'availability', label: 'Check Availability', icon: '📅' },
      availabilityNoun: 'available',
    },
    service: {
      id: 'service', label: 'Service', noun: 'service',
      primary: { key: 'book',  label: 'Book Appointment', icon: '📅' },
      secondary:{ key: 'request', label: 'Request Service', icon: '💬' },
      availabilityNoun: 'available',
    },
    event: {
      id: 'event', label: 'Event', noun: 'ticket',
      primary: { key: 'tickets', label: 'Get Tickets',   icon: '🎫' },
      secondary:{ key: 'reserve', label: 'Reserve',      icon: '📅' },
      availabilityNoun: 'available',
    },
    rental: {
      id: 'rental', label: 'Rental', noun: 'rental',
      primary: { key: 'reserve', label: 'Reserve',       icon: '🔑' },
      secondary:{ key: 'availability', label: 'Check Availability', icon: '📅' },
      availabilityNoun: 'available',
    },
    property: {
      id: 'property', label: 'Property', noun: 'property',
      /* No basket and no instant purchase: property moves through a viewing and a
         conversation, and offering "Buy Now" on a house would be a lie about the process. */
      primary: { key: 'viewing', label: 'Request Viewing', icon: '🔑' },
      secondary:{ key: 'contact', label: 'Contact Agent',  icon: '💬' },
      availabilityNoun: 'available',
    },
    vehicle: {
      id: 'vehicle', label: 'Vehicle', noun: 'vehicle',
      primary: { key: 'enquire', label: 'Enquire',       icon: '💬' },
      secondary:{ key: 'viewing', label: 'Book Viewing', icon: '📅' },
      availabilityNoun: 'available',
    },
    digital: {
      id: 'digital', label: 'Digital', noun: 'download',
      primary: { key: 'buy',   label: 'Buy Now',          icon: '⚡' },
      secondary:null,
      availabilityNoun: 'available',
    },
  };

  /* Inference from the category vocabulary the marketplace already ships. Only categories
     that genuinely imply a different commerce are mapped; everything else stays a product,
     because guessing wrongly changes what the customer is promised. */
  var CATEGORY_TYPE = {
    food: 'food', groceries: 'food', restaurant: 'food', meals: 'food', bakery: 'food',
    drinks: 'drink', beverages: 'drink', bar: 'drink',
    services: 'service', repair: 'service', cleaning: 'service', beautyservices: 'service',
    printing: 'service', construction: 'service',
    hotel: 'room', hotels: 'room', accommodation: 'room', rooms: 'room', lodging: 'room',
    events: 'event', tickets: 'event',
    property: 'property', properties: 'property', realestate: 'property', land: 'property',
    vehicles: 'vehicle', cars: 'vehicle', motorcycles: 'vehicle',
    rentals: 'rental',
    digital: 'digital', software: 'digital', ebooks: 'digital',
  };

  function norm(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, ''); }

  /**
   * What kind of listing is this? Explicit field first, category second, 'product' last.
   * Never throws and never returns undefined — a surface asking "what do I show" must
   * always get an answer it can render.
   */
  function typeOf(listing) {
    var l = listing || {};
    var explicit = norm(l.listingType || l.type);
    if (explicit && TYPES[explicit]) return TYPES[explicit];
    var byCat = CATEGORY_TYPE[norm(l.category)];
    if (byCat && TYPES[byCat]) return TYPES[byCat];
    /* A service flag already exists on some listings and is more specific than category. */
    if (l.isService === true || norm(l.productKind) === 'service') return TYPES.service;
    if (l.isDigital === true || norm(l.productKind) === 'digital') return TYPES.digital;
    return TYPES.product;
  }

  function actionsFor(listing) {
    var t = typeOf(listing);
    return { type: t.id, primary: t.primary, secondary: t.secondary };
  }

  /* ── WHAT A PRICE MEANS ────────────────────────────────────────────────────────────────
     KES 12,500 is a different promise for a room than for a kettle: one is per night, the
     other is the whole thing. The unit belongs to the TYPE, so the card and the listing
     page read it from here rather than each deciding.

     Only types whose price is genuinely periodic get a unit. A service is priced per job
     unless the merchant says otherwise, so it gets none — inventing "/ hour" would be a
     claim about billing nobody made. */
  var PRICE_UNIT = { room: 'night', rental: 'day' };

  /**
   * The price as a customer should read it: { amount, unit, from }.
   *
   * `from` is TRUE only when the listing really does start at this figure — that is, when
   * it has variants whose prices actually differ. "From KES 6,500" on a single fixed price
   * is a lie of the most ordinary kind: it implies a cheaper option that does not exist.
   * Returns null when there is no usable price, so no surface has to invent one.
   */
  function priceLabel(listing) {
    var l = listing || {};
    var base = Number(l.price);
    var variants = Array.isArray(l.variants) ? l.variants : [];
    var prices = variants
      .map(function (v) { return Number(v && v.price); })
      .filter(function (n) { return isFinite(n) && n > 0; });

    if (isFinite(base) && base > 0) prices.push(base);
    if (!prices.length) return null;

    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    return { amount: min, unit: PRICE_UNIT[typeOf(l).id] || null, from: max > min };
  }

  /** The same thing as a string: "From KES 12,500 / night", or "KES 850". */
  function priceText(listing, currency) {
    var p = priceLabel(listing);
    if (!p) return null;
    return (p.from ? 'From ' : '') + (currency || 'KES') + ' ' +
           p.amount.toLocaleString('en-KE') + (p.unit ? ' / ' + p.unit : '');
  }

  /** True when this type transacts through a basket. Hotels and property do not. */
  function usesCart(listing) {
    var s = typeOf(listing).secondary;
    return !!(s && s.key === 'cart');
  }

  var api = {
    TYPES: TYPES,
    CATEGORY_TYPE: CATEGORY_TYPE,
    PRICE_UNIT: PRICE_UNIT,
    typeOf: typeOf,
    actionsFor: actionsFor,
    usesCart: usesCart,
    priceLabel: priceLabel,
    priceText: priceText,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniListingTypes = api;
/* THE TRUE GLOBAL. `this` at CommonJS module scope is module.exports, NOT the global —
   so a sibling module attached to the global was invisible here and every listing silently
   fell back to 'product'. It worked in a browser and degraded quietly under Node, which is
   the worst combination: green in the place you test least. */
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
