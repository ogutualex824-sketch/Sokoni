/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — LISTING MODEL. Field configuration, quality and lifecycle for every listing type.
   sokoni-listing-model.js

   ONE LISTING ENGINE, MANY FIELD CONFIGURATIONS. A restaurant, a hotel, a garage and an
   electronics shop are not seven uploaders — they are seven FIELD SETS over one listing.
   This module owns those sets, the quality assessment, and the draft→live lifecycle. It
   renders nothing and writes nothing: the Studio reads it to decide which inputs to show,
   and the existing certified product writer still performs every write.

   WHY THE FIELDS LIVE HERE AND NOT IN THE FORM
   A form that hard-codes its own fields becomes the authority on what a listing is, and the
   next vertical needs a second form. Keeping the configuration in data means adding a
   business type is a table entry, not another uploader — which is the rule being honoured.

   COMPANION MODULES, NOT DUPLICATES
     sokoni-listing-types.js   what a listing IS and what the customer is offered
     sokoni-product-specs.js   physical measurement — units, sizes, stock units
     sokoni-product-schema.js  variant attributes — colours, sizes, storage
     sokoni-promotion-model.js commercial rules over listings
   This adds the fourth distinct concern: which fields a type collects, how complete a
   listing is, and what state it is in.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var T = 'text', N = 'number', A = 'textarea', L = 'list', T_ = 'time', S = 'select', B = 'bool';

  /* f(key, label, kind, required?) — `required` means required TO PUBLISH, not to save a
     draft. A merchant must always be able to stop halfway. */
  function f(key, label, kind, required, opts) {
    return { key: key, label: label, kind: kind || T, required: !!required, options: opts || null };
  }

  /* Fields EVERY listing has, whatever it is. */
  var COMMON = [
    f('name',        'Listing name',  T, true),
    f('description', 'Description',   A, true),
    f('price',       'Price (KES)',   N, true),
    f('category',    'Category',      T, true),
    f('location',    'Location',      T, true),
  ];

  /* Type-specific fields, in the order a merchant would naturally fill them. */
  var BY_TYPE = {
    product: [
      f('brand','Brand',T), f('model','Model',T), f('sku','SKU',T),
      f('condition','Condition',S,false,['New','Refurbished','Used']),
      f('warranty','Warranty',T), f('stock','Inventory',N,true),
    ],
    food: [
      f('cuisine','Cuisine',T), f('portion','Portion',T),
      f('ingredients','Ingredients',L), f('allergens','Allergens',L),
      f('prepTime','Preparation time (min)',N),
      f('dietary','Dietary attributes',L), f('addOns','Add-ons',L),
      f('stock','Portions available',N),
    ],
    drink: [
      f('servingSize','Serving size',T), f('ingredients','Ingredients',L),
      f('alcoholic','Alcoholic',B), f('addOns','Add-ons',L),
      f('stock','Servings available',N),
    ],
    room: [
      f('roomType','Room type',T,true), f('guests','Guests',N,true),
      f('beds','Beds',N), f('bathrooms','Bathrooms',N), f('roomSize','Room size',T),
      f('amenities','Amenities',L), f('checkIn','Check-in',T_), f('checkOut','Check-out',T_),
      f('cancellationPolicy','Cancellation policy',A),
      f('stock','Rooms available',N,true),
    ],
    service: [
      f('duration','Duration',T,true), f('provider','Staff / provider',T),
      f('serviceArea','Service area',T), f('includes','What’s included',L),
      f('requirements','Appointment requirements',A),
      f('cancellationPolicy','Cancellation policy',A),
    ],
    vehicle: [
      f('make','Make',T,true), f('model','Model',T,true), f('year','Year',N,true),
      f('mileage','Mileage (km)',N), f('transmission','Transmission',S,false,['Automatic','Manual']),
      f('fuel','Fuel',S,false,['Petrol','Diesel','Hybrid','Electric']),
      f('engine','Engine',T), f('condition','Condition',S,false,['New','Used']),
      f('registration','Registration status',T), f('features','Features',L),
    ],
    property: [
      f('propertyType','Property type',T,true), f('bedrooms','Bedrooms',N,true),
      f('bathrooms','Bathrooms',N), f('floorArea','Floor area',T),
      f('parking','Parking',T), f('furnished','Furnished',B),
      f('tenure','Lease or sale',S,false,['For rent','For sale']),
      f('amenities','Amenities',L), f('viewingAvailability','Viewing availability',T),
    ],
    event: [
      f('startsAt','Starts',T,true), f('endsAt','Ends',T),
      f('venue','Venue',T,true), f('organiser','Organiser',T),
      f('ageLimit','Age limit',T), f('stock','Tickets available',N),
    ],
    rental: [
      f('rentalPeriod','Rental period',T,true), f('availableFrom','Available from',T),
      f('deposit','Deposit (KES)',N), f('condition','Condition',T),
    ],
    digital: [
      f('fileFormat','Format',T), f('fileSize','Size',T), f('licence','Licence',T),
    ],
  };

  /* Media groups per type — metadata over ONE media pipeline, never a second uploader. */
  var MEDIA_GROUPS = {
    product:  ['Main','Gallery','Packaging'],
    food:     ['Dish','Presentation','Menu','Interior'],
    drink:    ['Drink','Presentation','Bar'],
    room:     ['Room','Bathroom','View','Amenities','Exterior'],
    service:  ['Work','Team','Before / after'],
    vehicle:  ['Exterior','Interior','Engine','Documents'],
    property: ['Exterior','Living room','Bedroom','Kitchen','Bathroom','View'],
    event:    ['Poster','Venue','Past events'],
    rental:   ['Main','Condition'],
    digital:  ['Cover','Preview'],
  };

  /* DRAFT is where a listing starts and where it can always return. PUBLISHING is the only
     transition that demands completeness, which is why validate() gates exactly that edge. */
  var LIFECYCLE = {
    draft:    { id:'draft',    label:'Draft',    next:['review','live','archived'] },
    review:   { id:'review',   label:'In review',next:['live','draft','archived'] },
    live:     { id:'live',     label:'Live',     next:['paused','archived'] },
    paused:   { id:'paused',   label:'Paused',   next:['live','archived'] },
    archived: { id:'archived', label:'Archived', next:['draft'] },
  };

  function typeIdOf(listing) {
    var LT = root.SokoniListingTypes;
    if (LT && typeof LT.typeOf === 'function') return LT.typeOf(listing).id;
    return (listing && listing.listingType) || 'product';
  }

  /** Every field this listing should collect, common first then type-specific. */
  function fieldsFor(listing) {
    return COMMON.concat(BY_TYPE[typeIdOf(listing)] || BY_TYPE.product);
  }

  function mediaGroupsFor(listing) {
    return MEDIA_GROUPS[typeIdOf(listing)] || MEDIA_GROUPS.product;
  }

  function filled(v) {
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.filter(function (x) { return String(x).trim() !== ''; }).length > 0;
    if (typeof v === 'boolean') return true;
    return String(v).trim() !== '';
  }

  /**
   * QUALITY. Not a cosmetic bar: every point is a named field, and everything missing is
   * returned so the merchant is told exactly what remains rather than guessing at a number.
   * Required fields weigh double, because a listing missing a price is not 90% of a listing.
   */
  function quality(listing) {
    var l = listing || {}, fields = fieldsFor(l);
    var passed = [], missing = [], got = 0, total = 0;
    fields.forEach(function (fd) {
      var w = fd.required ? 2 : 1;
      total += w;
      if (filled(l[fd.key])) { got += w; passed.push(fd.label); }
      else missing.push({ label: fd.label, required: fd.required });
    });
    /* Media is scored separately because a listing with no photograph is not merely
       incomplete — it is one nobody will open. */
    var imgs = Array.isArray(l.images) ? l.images.length : (filled(l.image) ? 1 : 0);
    total += 3;
    if (imgs >= 3) { got += 3; passed.push('Photos (3+)'); }
    else if (imgs >= 1) { got += 1; missing.push({ label: 'Add ' + (3 - imgs) + ' more photo' + (3 - imgs === 1 ? '' : 's'), required: false }); }
    else missing.push({ label: 'Main image', required: true });

    return {
      score: total ? Math.round((got / total) * 100) : 0,
      passed: passed,
      missing: missing,
      blocking: missing.filter(function (m) { return m.required; }),
    };
  }

  /** May this listing be published? Draft saving is never gated; publishing is. */
  function validate(listing) {
    var q = quality(listing);
    return { ok: q.blocking.length === 0, blocking: q.blocking, score: q.score };
  }

  function canTransition(from, to) {
    var s = LIFECYCLE[String(from || 'draft')];
    return !!(s && s.next.indexOf(String(to)) > -1);
  }

  var api = {
    COMMON: COMMON, BY_TYPE: BY_TYPE, MEDIA_GROUPS: MEDIA_GROUPS, LIFECYCLE: LIFECYCLE,
    fieldsFor: fieldsFor, mediaGroupsFor: mediaGroupsFor,
    quality: quality, validate: validate, canTransition: canTransition,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniListingModel = api;
/* THE TRUE GLOBAL. `this` at CommonJS module scope is module.exports, NOT the global —
   so a sibling module attached to the global was invisible here and every listing silently
   fell back to 'product'. It worked in a browser and degraded quietly under Node, which is
   the worst combination: green in the place you test least. */
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
