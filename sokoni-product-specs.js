/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI PRODUCT SPECIFICATIONS — one canonical shape for every category.

   SOKONI sells groceries, electronics, clothing, vehicles, spare parts, furniture and
   services out of ONE products collection. The temptation is a schema per category; that
   ends as a product database per category, and then search, filters, inventory and POS
   each need to know which one they are talking to. So: common structured fields, plus
   category-suggested specs, plus merchant-defined specs, in a single document.

   ADDITIVE BY CONSTRUCTION. `price`, `stock`, `name`, `category` and every existing field
   keep their meaning and their names. Live documents already carry plural `colors`,
   `sizes`, `weights`, `volumes`, `materials` (verified against production, 2026-08-26) and
   those are LEFT ALONE — this adds `specs`, `stockUnit` and `variants` beside them. A
   reader that knows nothing of this file continues to work unchanged.

   WHY UNITS ARE NOT FREE TEXT. "20" is not an inventory figure — 20 pieces, 20 kg and 20
   boxes are three different shops. A merchant typing "kgs", "Kg" and "kilos" across three
   products makes the catalogue unsortable and the POS ambiguous, so canonical units are a
   closed list per dimension and everything normalises into it. The escape hatch is
   `custom`, where the merchant names both the spec and its unit — an unusual product
   should not need a code change, and a battery in mAh must not be forced into kilograms.

   STOCK STAYS THE ONE NUMBER POS READS. Where a product has variants, `stock` is their
   sum and is recomputed here rather than trusted from input — two places to change a
   stock figure is how a till and a catalogue come to disagree.

   Pure: no DOM, no Firestore, no globals. Callable from node so the gate can prove it.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── CANONICAL UNITS ──────────────────────────────────────────────────────
     Each dimension declares its units and a base for comparison. `factor` converts
     TO the base, so two products can be sorted or compared without the caller
     knowing which unit each was entered in. */
  var UNITS = {
    weight: { base: 'g', units: {
      mg: 0.001, g: 1, kg: 1000, t: 1000000,
    } },
    length: { base: 'mm', units: {
      mm: 1, cm: 10, m: 1000, km: 1000000,
      in: 25.4, ft: 304.8, mi: 1609344,
    } },
    volume: { base: 'ml', units: {
      ml: 1, cl: 10, l: 1000, L: 1000, gal: 3785.41,
    } },

    /* ── THE REST OF WHAT A KENYAN SHOP ACTUALLY SELLS ────────────────────
       A pharmacy weighs a dose in mg and counts it in tablets; a hardware shop sells a
       screw by gauge and a box by the hundred; an electronics shop prices by GB and mAh.
       None of these fit weight/length/volume, and forcing them there is how a battery
       ends up recorded in kilograms. Each family is a closed list with a base, so two
       products can still be compared without the caller knowing which unit was typed. */
    storage: { base: 'MB', units: {
      KB: 0.001, MB: 1, GB: 1024, TB: 1048576,
    } },
    power: { base: 'W', units: { mW: 0.001, W: 1, kW: 1000, hp: 745.7 } },
    voltage: { base: 'V', units: { mV: 0.001, V: 1, kV: 1000 } },
    frequency: { base: 'Hz', units: { Hz: 1, kHz: 1000, MHz: 1000000, GHz: 1000000000 } },
    charge: { base: 'mAh', units: { mAh: 1, Ah: 1000 } },
    /* ENERGY is not CHARGE. A phone battery is rated in mAh and a laptop battery in Wh, and
       they are not interchangeable: converting between them needs the cell voltage, which
       the product document does not carry. Two families, so neither pretends to be the
       other and no conversion is invented across them. */
    energy: { base: 'Wh', units: { mWh: 0.001, Wh: 1, kWh: 1000 } },
    /* Counts. A base of 1 with no conversion between siblings is deliberate: a carton is
       not a fixed number of packs across shops, so stockUnit.perPack carries that, per
       product, rather than this table pretending there is a universal answer. */
    count: { base: 'pieces', units: {
      pieces: 1, tablets: 1, capsules: 1, sachets: 1, doses: 1,
      packs: 1, cartons: 1, boxes: 1, rolls: 1, sheets: 1, pairs: 1,
    } },
  };

  /* ── SIZING SYSTEMS ─────────────────────────────────────────────────────────
     A size is NOT always a measurement. "XL" is a legitimate product attribute and has
     no numeric value; "EU 38" and "US 10" are numbers that mean nothing without their
     system — a 38 is a different shoe in each. So size stores a value plus the SYSTEM it
     was expressed in, and never coerces the value to a number.

     Comparing across systems is deliberately NOT attempted. Alpha-to-EU conversion
     differs by garment, by manufacturer and by country, so a table here would be a
     confident guess printed next to a real measurement. */
  var SIZE_SYSTEMS = {
    alpha:    { label: 'S / M / L',   values: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] },
    numeric:  { label: 'Number',      values: null },
    EU:       { label: 'EU',          values: null },
    UK:       { label: 'UK',          values: null },
    US:       { label: 'US',          values: null },
    waist:    { label: 'Waist (in)',  values: null },
    age:      { label: 'Age',         values: null },
    freeSize: { label: 'Free size',   values: null },
  };

  /* Spelling a merchant may type -> the canonical unit. Deliberately small and
     obvious; anything unrecognised is REFUSED rather than guessed, because guessing
     a unit silently changes a quantity. */
  var UNIT_ALIASES = {
    kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
    gram: 'g', grams: 'g', gm: 'g', tonne: 't', tonnes: 't', ton: 't',
    cms: 'cm', centimetre: 'cm', centimeter: 'cm', metre: 'm', meter: 'm',
    metres: 'm', meters: 'm', inch: 'in', inches: 'in', feet: 'ft', foot: 'ft',
    mile: 'mi', miles: 'mi', litre: 'l', liter: 'l', litres: 'l', liters: 'l',
    millilitre: 'ml', milliliter: 'ml',
  };

  /* ── STOCK UNITS ──────────────────────────────────────────────────────────
     What "20" MEANS. A pack unit carries how many base units are inside, so a shop
     counting boxes can still be asked how many pieces it holds. */
  var STOCK_UNITS = [
    'pieces', 'kg', 'g', 'litres', 'ml', 'metres', 'boxes', 'packs',
    'cartons', 'crates', 'bags', 'bundles', 'pairs', 'sets', 'dozens', 'hours',
  ];

  /* ── CATEGORY SUGGESTIONS ─────────────────────────────────────────────────
     SUGGESTIONS, not a schema. They decide which fields the editor OFFERS; they never
     decide what may be stored, and no product is rejected for lacking one. A car gets
     mileage and engine capacity instead of a meaningless "size"; nothing stops a
     merchant adding mileage to something else. */
  var CATEGORY_SPECS = {
    vehicles: [
      { key: 'make', label: 'Make' }, { key: 'model', label: 'Model' },
      { key: 'year', label: 'Year', type: 'number' },
      { key: 'mileage', label: 'Mileage', type: 'measure', dim: 'length', unit: 'km' },
      { key: 'engineCapacity', label: 'Engine capacity', type: 'measure', dim: 'volume', unit: 'l' },
      { key: 'fuelCapacity', label: 'Fuel capacity', type: 'measure', dim: 'volume', unit: 'l' },
      { key: 'fuelType', label: 'Fuel type' }, { key: 'transmission', label: 'Transmission' },
      { key: 'driveType', label: 'Drive type' }, { key: 'bodyType', label: 'Body type' },
      { key: 'seats', label: 'Seats', type: 'number' }, { key: 'doors', label: 'Doors', type: 'number' },
      { key: 'condition', label: 'Condition' }, { key: 'vin', label: 'VIN' },
      { key: 'registration', label: 'Registration' }, { key: 'colour', label: 'Colour' },
      { key: 'horsepower', label: 'Horsepower', type: 'number' },
    ],
    electronics: [
      { key: 'model', label: 'Model' },
      { key: 'storage', label: 'Storage', type: 'measure', dim: 'storage', unit: 'GB' },
      { key: 'ram', label: 'RAM', type: 'measure', dim: 'storage', unit: 'GB' },
      { key: 'screenSize', label: 'Screen size', type: 'measure', dim: 'length', unit: 'in' },
      { key: 'resolution', label: 'Resolution' },
      { key: 'batteryCapacity', label: 'Battery capacity', type: 'measure', dim: 'charge', unit: 'mAh' },
      { key: 'power', label: 'Power', type: 'measure', dim: 'power', unit: 'W' },
      { key: 'voltage', label: 'Voltage', type: 'measure', dim: 'voltage', unit: 'V' },
      { key: 'refreshRate', label: 'Refresh rate', type: 'measure', dim: 'frequency', unit: 'Hz' },
      { key: 'operatingSystem', label: 'Operating system' },
      { key: 'connectivity', label: 'Connectivity' }, { key: 'colour', label: 'Colour' },
      { key: 'warranty', label: 'Warranty' }, { key: 'condition', label: 'Condition' },
    ],
    /* Screens. One family for laptops, TVs and monitors: they differ by which fields matter,
       not by kind. Screen size is a LENGTH in inches — a 15.6" laptop and a 55" TV are the
       same attribute at different scales, and neither is a "size" in the clothing sense. */
    laptops: [
      { key: 'model', label: 'Model' },
      { key: 'screenSize', label: 'Screen size', type: 'measure', dim: 'length', unit: 'in' },
      { key: 'resolution', label: 'Resolution' },
      { key: 'ram', label: 'RAM', type: 'measure', dim: 'storage', unit: 'GB' },
      { key: 'storage', label: 'Storage', type: 'measure', dim: 'storage', unit: 'GB' },
      { key: 'processor', label: 'Processor' }, { key: 'graphics', label: 'Graphics' },
      { key: 'batteryEnergy', label: 'Battery', type: 'measure', dim: 'energy', unit: 'Wh' },
      { key: 'operatingSystem', label: 'Operating system' },
      { key: 'weight', label: 'Weight', type: 'measure', dim: 'weight', unit: 'kg' },
      { key: 'condition', label: 'Condition' }, { key: 'warranty', label: 'Warranty' },
    ],
    tv: [
      { key: 'screenSize', label: 'Screen size', type: 'measure', dim: 'length', unit: 'in' },
      { key: 'resolution', label: 'Resolution' },
      { key: 'panelType', label: 'Panel type' }, { key: 'smartPlatform', label: 'Smart platform' },
      { key: 'refreshRate', label: 'Refresh rate', type: 'measure', dim: 'frequency', unit: 'Hz' },
      { key: 'power', label: 'Power', type: 'measure', dim: 'power', unit: 'W' },
      { key: 'weight', label: 'Weight', type: 'measure', dim: 'weight', unit: 'kg' },
      { key: 'warranty', label: 'Warranty' },
    ],
    monitors: [
      { key: 'screenSize', label: 'Screen size', type: 'measure', dim: 'length', unit: 'in' },
      { key: 'resolution', label: 'Resolution' },
      { key: 'refreshRate', label: 'Refresh rate', type: 'measure', dim: 'frequency', unit: 'Hz' },
      { key: 'responseTime', label: 'Response time' }, { key: 'panelType', label: 'Panel type' },
      { key: 'connectivity', label: 'Connectivity' },
    ],
    cameras: [
      { key: 'sensor', label: 'Sensor' },
      { key: 'megapixels', label: 'Megapixels', type: 'number' },
      { key: 'focalLength', label: 'Focal length', type: 'measure', dim: 'length', unit: 'mm' },
      { key: 'lensMount', label: 'Lens mount' }, { key: 'videoResolution', label: 'Video resolution' },
      { key: 'batteryEnergy', label: 'Battery', type: 'measure', dim: 'energy', unit: 'Wh' },
      { key: 'weight', label: 'Weight', type: 'measure', dim: 'weight', unit: 'g' },
      { key: 'condition', label: 'Condition' },
    ],
    watches: [
      { key: 'caseSize', label: 'Case size', type: 'measure', dim: 'length', unit: 'mm' },
      { key: 'strapSize', label: 'Strap size', type: 'size' },
      { key: 'waterResistance', label: 'Water resistance' },
      { key: 'movement', label: 'Movement' }, { key: 'material', label: 'Material' },
      { key: 'batteryCapacity', label: 'Battery', type: 'measure', dim: 'charge', unit: 'mAh' },
      { key: 'connectivity', label: 'Connectivity' },
    ],
    audio: [
      { key: 'driverSize', label: 'Driver size', type: 'measure', dim: 'length', unit: 'mm' },
      { key: 'batteryCapacity', label: 'Battery', type: 'measure', dim: 'charge', unit: 'mAh' },
      { key: 'impedance', label: 'Impedance' },
      { key: 'frequencyResponse', label: 'Frequency response' },
      { key: 'connectivity', label: 'Connectivity' },
      { key: 'weight', label: 'Weight', type: 'measure', dim: 'weight', unit: 'g' },
    ],
    /* A fridge is a CAPACITY in litres that draws POWER at a VOLTAGE — three different
       families on one product, which is exactly why they are not one generic "size". */
    appliances: [
      { key: 'capacity', label: 'Capacity', type: 'measure', dim: 'volume', unit: 'l' },
      { key: 'power', label: 'Power', type: 'measure', dim: 'power', unit: 'W' },
      { key: 'voltage', label: 'Voltage', type: 'measure', dim: 'voltage', unit: 'V' },
      { key: 'energyRating', label: 'Energy rating' },
      { key: 'weight', label: 'Weight', type: 'measure', dim: 'weight', unit: 'kg' },
      { key: 'colour', label: 'Colour' }, { key: 'warranty', label: 'Warranty' },
    ],
    clothing: [
      { key: 'size', label: 'Size', type: 'size' }, { key: 'fit', label: 'Fit' },
      { key: 'gender', label: 'Gender' }, { key: 'colour', label: 'Colour' },
      { key: 'material', label: 'Material' }, { key: 'pattern', label: 'Pattern' },
      { key: 'waist', label: 'Waist', type: 'measure', dim: 'length', unit: 'in' },
      { key: 'chest', label: 'Chest', type: 'measure', dim: 'length', unit: 'in' },
    ],
    furniture: [
      { key: 'material', label: 'Material' },
      { key: 'seatingCapacity', label: 'Seating capacity', type: 'number' },
      { key: 'loadCapacity', label: 'Load capacity', type: 'measure', dim: 'weight', unit: 'kg' },
      { key: 'assemblyRequired', label: 'Assembly required' }, { key: 'colour', label: 'Colour' },
    ],
    /* A pharmacy's product is a DOSE in a COUNT: 500 mg, 24 tablets. Neither number
       means anything without the other, and neither is a "size". */
    medicine: [
      { key: 'dose', label: 'Strength / dose', type: 'measure', dim: 'weight', unit: 'mg' },
      { key: 'volume', label: 'Volume', type: 'measure', dim: 'volume', unit: 'ml' },
      { key: 'packCount', label: 'Units per pack', type: 'measure', dim: 'count', unit: 'tablets' },
      { key: 'form', label: 'Form' },
      { key: 'activeIngredient', label: 'Active ingredient' },
      { key: 'manufacturer', label: 'Manufacturer' },
      { key: 'expiryDate', label: 'Expiry date', type: 'date' },
      { key: 'batchNumber', label: 'Batch number' },
      { key: 'storageRequirements', label: 'Storage requirements' },
      { key: 'prescriptionOnly', label: 'Prescription only' },
    ],
    /* Hardware is sold by dimension and by the box — a screw has a gauge, a length and a
       pack quantity, and none of those is interchangeable with the others. */
    hardware: [
      { key: 'diameter', label: 'Diameter', type: 'measure', dim: 'length', unit: 'mm' },
      { key: 'length', label: 'Length', type: 'measure', dim: 'length', unit: 'mm' },
      { key: 'gauge', label: 'Gauge' },
      { key: 'packQuantity', label: 'Pack quantity', type: 'measure', dim: 'count', unit: 'pieces' },
      { key: 'material', label: 'Material' }, { key: 'finish', label: 'Finish' },
      { key: 'threadType', label: 'Thread type' },
      { key: 'loadCapacity', label: 'Load capacity', type: 'measure', dim: 'weight', unit: 'kg' },
    ],
    cosmetics: [
      { key: 'volume', label: 'Volume', type: 'measure', dim: 'volume', unit: 'ml' },
      { key: 'netWeight', label: 'Net weight', type: 'measure', dim: 'weight', unit: 'g' },
      { key: 'spf', label: 'SPF', type: 'number' },
      { key: 'shade', label: 'Shade' }, { key: 'skinType', label: 'Skin type' },
      { key: 'packCount', label: 'Items per pack', type: 'measure', dim: 'count', unit: 'pieces' },
      { key: 'expiryDate', label: 'Expiry date', type: 'date' },
      { key: 'ingredients', label: 'Ingredients' },
    ],
    food: [
      { key: 'netWeight', label: 'Net weight', type: 'measure', dim: 'weight', unit: 'g' },
      { key: 'netVolume', label: 'Net volume', type: 'measure', dim: 'volume', unit: 'ml' },
      { key: 'packSize', label: 'Pack size' },
      { key: 'unitsPerPack', label: 'Units per pack', type: 'number' },
      { key: 'ingredients', label: 'Ingredients' },
      { key: 'expiryDate', label: 'Expiry date', type: 'date' },
      { key: 'manufactureDate', label: 'Manufacture date', type: 'date' },
      { key: 'origin', label: 'Origin' },
      { key: 'storageRequirements', label: 'Storage requirements' },
      { key: 'grade', label: 'Grade' },
    ],
  };

  /* Categories a merchant actually picks -> the suggestion set. Unknown categories get
     the common fields only, which is a complete product, not a degraded one. */
  var CATEGORY_ALIASES = {
    vehicle: 'vehicles', cars: 'vehicles', car: 'vehicles', motorbikes: 'vehicles',
    electronic: 'electronics', phones: 'electronics', phone: 'electronics',
    tablets: 'electronics', smartphones: 'electronics',
    laptop: 'laptops', computers: 'laptops', computer: 'laptops', notebooks: 'laptops',
    pcs: 'laptops', desktops: 'laptops',
    tvs: 'tv', television: 'tv', televisions: 'tv', screens: 'tv',
    monitor: 'monitors', displays: 'monitors',
    camera: 'cameras', photography: 'cameras',
    watch: 'watches', smartwatch: 'watches', smartwatches: 'watches',
    headphones: 'audio', earphones: 'audio', speakers: 'audio', sound: 'audio',
    appliance: 'appliances', fridge: 'appliances', fridges: 'appliances',
    refrigerator: 'appliances', kitchen: 'appliances', 'home-appliances': 'appliances',
    clothes: 'clothing', fashion: 'clothing', shoes: 'clothing',
    groceries: 'food', grocery: 'food', produce: 'food', agriculture: 'food',
    pharmacy: 'medicine', medicines: 'medicine', drugs: 'medicine', health: 'medicine',
    tools: 'hardware', building: 'hardware', construction: 'hardware', spares: 'hardware',
    'spare-parts': 'hardware', hardwares: 'hardware',
    beauty: 'cosmetics', cosmetic: 'cosmetics', skincare: 'cosmetics', haircare: 'cosmetics',
    farm: 'food', beverages: 'food',
  };

  function _num (v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function _str (v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  /* Resolve a merchant-typed unit to its canonical spelling within a dimension.
     Returns null for anything unrecognised — never a guess. */
  function canonicalUnit (dim, unit) {
    var u = _str(unit);
    if (!u) return null;
    var d = UNITS[dim];
    if (!d) return null;
    if (d.units[u] !== undefined) return u;
    var lower = u.toLowerCase();
    if (d.units[lower] !== undefined) return lower;
    var alias = UNIT_ALIASES[lower];
    if (alias && d.units[alias] !== undefined) return alias;
    return null;
  }

  /* A measurement, normalised. Carries the merchant's own unit AND the base value, so
     a list can be sorted across mixed units without re-deriving anything at read time. */
  function measure (dim, value, unit) {
    var v = _num(value);
    if (v === null) return null;
    var u = canonicalUnit(dim, unit);
    if (!u) return { v: v, u: _str(unit) || null, base: null, dim: dim, unresolved: true };
    /* Rounded to 6 decimals. 15.6 * 25.4 is 396.23999999999995 in binary floating point, and
       storing fifteen digits of that noise in every product document is not precision — it is
       an artefact. Six decimals keeps the smallest real unit exact (1 mg = 0.001 g) while
       making two equal measurements actually compare equal, which they otherwise would not.
       `v` is untouched: the merchant's own number is never rounded, only the derived base. */
    var base = v * UNITS[dim].units[u];
    return { v: v, u: u, dim: dim, base: Math.round(base * 1e6) / 1e6, baseUnit: UNITS[dim].base };
  }

  /* A size, normalised WITHOUT coercing to a number. "XL" must survive as "XL"; the
     Number() trap that turns an absent stock into "out of stock" would here turn a
     perfectly good alpha size into nothing at all. `number` is attached only when the
     value genuinely is one, so a numeric system can still sort. */
  function size (value, system) {
    var raw = (value === null || value === undefined) ? '' : String(value).trim();
    if (!raw) return null;
    var sys = _str(system);
    /* An alpha value tells us its own system when none was given — a merchant typing XL
       into a bare size box should not have to also declare that XL is a letter size. */
    if (!sys) {
      sys = SIZE_SYSTEMS.alpha.values.indexOf(raw.toUpperCase()) >= 0 ? 'alpha'
          : (isFinite(Number(raw)) ? 'numeric' : '');
    }
    if (sys && !SIZE_SYSTEMS[sys]) {
      /* Keep the merchant's own system rather than discarding the size. Refusing it
         would lose real product data over a vocabulary disagreement. */
      var out0 = { value: raw, system: sys, customSystem: true };
      if (isFinite(Number(raw)) && raw !== '') out0.number = Number(raw);
      return out0;
    }
    var out = { value: sys === 'alpha' ? raw.toUpperCase() : raw };
    if (sys) out.system = sys;
    if (raw !== '' && isFinite(Number(raw))) out.number = Number(raw);
    return out;
  }

  function categoryKey (category) {
    var c = _str(category).toLowerCase();
    if (!c) return null;
    if (CATEGORY_SPECS[c]) return c;
    return CATEGORY_ALIASES[c] || null;
  }

  /* Which specs the EDITOR should offer for a category. Suggestions only. */
  function suggestionsFor (category) {
    var k = categoryKey(category);
    return k ? CATEGORY_SPECS[k].slice() : [];
  }

  /* ── NORMALISE ────────────────────────────────────────────────────────────
     Input from the editor -> the stored `specs` shape. Unknown keys are KEPT (under
     custom), because refusing a merchant's own specification is worse than storing it. */
  function normalizeSpecs (input) {
    var i = input || {};
    var out = {};

    var brand = _str(i.brand); if (brand) out.brand = brand;
    /* NO `sku` here. The product document already has a top-level `sku`, written by the
       existing writer's whitelist and read by Inventory and POS. A second copy under
       specs would be two fields for one identifier, free to disagree — which is the
       whole failure this model exists to avoid. Variants DO carry their own sku,
       because a variant has no other field to hold one. */
    var barcode = _str(i.barcode); if (barcode) out.barcode = barcode;
    var condition = _str(i.condition); if (condition) out.condition = condition;

    var w = i.weight && measure('weight', i.weight.v !== undefined ? i.weight.v : i.weight.value, i.weight.u || i.weight.unit);
    if (w) out.weight = w;

    var cap = i.capacity && measure('volume', i.capacity.v !== undefined ? i.capacity.v : i.capacity.value, i.capacity.u || i.capacity.unit);
    if (cap) out.capacity = cap;

    /* Size is its own shape — value + system, never coerced to a number. */
    if (i.size !== undefined && i.size !== null) {
      var sz = (typeof i.size === 'object')
        ? size(i.size.value !== undefined ? i.size.value : i.size.v, i.size.system || i.size.u || i.size.unit)
        : size(i.size, '');
      if (sz) out.size = sz;
    }

    if (i.dimensions) {
      var d = {}, any = false;
      ['length', 'width', 'height'].forEach(function (k) {
        var src = i.dimensions[k];
        if (!src) return;
        var m = measure('length', src.v !== undefined ? src.v : src.value, src.u || src.unit);
        if (m) { d[k] = m; any = true; }
      });
      if (any) out.dimensions = d;
    }

    /* Category-suggested keys are stored FLAT under specs, so a reader can ask for
       specs.mileage without knowing which category suggested it. */
    var known = {};
    Object.keys(CATEGORY_SPECS).forEach(function (c) {
      CATEGORY_SPECS[c].forEach(function (s) { known[s.key] = s; });
    });
    Object.keys(i).forEach(function (k) {
      if (['brand', 'sku', 'barcode', 'condition', 'weight', 'capacity', 'dimensions', 'custom'].indexOf(k) >= 0) return;
      if (!known[k]) return;
      var def = known[k];
      if (def.type === 'measure' && def.dim) {
        var src = i[k];
        var m = measure(def.dim, (src && src.v !== undefined) ? src.v : (src && src.value !== undefined ? src.value : src), (src && (src.u || src.unit)) || def.unit);
        if (m) out[k] = m;
      } else if (def.type === 'size') {
        /* Never through _num(): "XL" is a real size and Number('XL') is NaN, which the
           numeric branch would drop entirely. size() keeps the value as given. */
        var src2 = i[k];
        var sz2 = (src2 && typeof src2 === 'object')
          ? size(src2.value !== undefined ? src2.value : src2.v, src2.system || src2.u || src2.unit)
          : size(src2, '');
        if (sz2) out[k] = sz2;
      } else if (def.type === 'number') {
        var n = _num(i[k]); if (n !== null) out[k] = n;
      } else {
        var s = _str(i[k]); if (s) out[k] = s;
      }
    });

    /* The escape hatch: a merchant naming their own specification and its unit. */
    if (Array.isArray(i.custom)) {
      var custom = i.custom.map(function (c) {
        var name = _str(c && c.name);
        if (!name) return null;
        var val = (c.value !== undefined) ? c.value : c.v;
        var row = { name: name, value: _str(val) };
        var n2 = _num(val); if (n2 !== null) row.number = n2;
        var u2 = _str(c && (c.unit || c.u)); if (u2) row.unit = u2;
        return row;
      }).filter(Boolean);
      if (custom.length) out.custom = custom;
    }
    return out;
  }

  /* ── STOCK UNIT ───────────────────────────────────────────────────────────
     20 what? And, for a pack, how many are inside one. */
  function normalizeStockUnit (input) {
    /* Accepts either a bare string ('kg') or an object ({name, perPack, packUnit}).
       Written out rather than `input || {}` because an EMPTY STRING is falsy: that
       idiom turned '' into {} and then stringified the object to "[object Object]",
       storing a stock unit no shop has ever counted in. */
    if (input === null || input === undefined) return null;
    var i = (typeof input === 'string') ? { name: input } : (typeof input === 'object' ? input : { name: String(input) });
    var name = _str(i.name || i.unit).toLowerCase();
    if (!name) return null;
    if (STOCK_UNITS.indexOf(name) < 0) {
      /* A merchant's own unit is allowed — refusing it would push them back to a bare
         number, which is the ambiguity this exists to remove. Flagged so the editor can
         offer the canonical list first. */
      return { name: name, custom: true };
    }
    var out = { name: name };
    var per = _num(i.perPack);
    if (per !== null && per > 0) {
      out.perPack = per;
      out.packUnit = _str(i.packUnit) || 'pieces';
    }
    return out;
  }

  /* ── VARIANTS ─────────────────────────────────────────────────────────────
     Each variant carries its own sku/barcode/price/stock/images/specs. `attrs` is what
     distinguishes it (colour: Black, size: 42). */
  function normalizeVariants (list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (v, idx) {
      if (!v) return null;
      var attrs = {};
      Object.keys(v.attrs || {}).forEach(function (k) {
        var s = _str(v.attrs[k]); if (s) attrs[_str(k)] = s;
      });
      if (!Object.keys(attrs).length) return null;   /* a variant with nothing distinguishing it is not a variant */
      var out = {
        id: _str(v.id) || ('v' + (idx + 1)),
        attrs: attrs,
        stock: Math.max(0, _num(v.stock) || 0),
      };
      var sku = _str(v.sku); if (sku) out.sku = sku;
      var bc = _str(v.barcode); if (bc) out.barcode = bc;
      var p = _num(v.price); if (p !== null && p >= 0) out.price = p;
      if (Array.isArray(v.images) && v.images.length) out.images = v.images.slice(0, 5);
      var sp = normalizeSpecs(v.specs);
      if (Object.keys(sp).length) out.specs = sp;
      return out;
    }).filter(Boolean);
  }

  /* Duplicate attribute combinations are a data defect, not a preference: two rows for
     Black/42 give the till two answers for one shelf. */
  function variantConflicts (variants) {
    var seen = {}, dupes = [];
    (variants || []).forEach(function (v) {
      var key = Object.keys(v.attrs).sort().map(function (k) {
        return k.toLowerCase() + '=' + String(v.attrs[k]).toLowerCase();
      }).join('|');
      if (seen[key]) dupes.push(key); else seen[key] = 1;
    });
    return dupes;
  }

  /* THE stock number POS reads. With variants it is their sum, recomputed rather than
     trusted — two places to change one figure is how a till and a catalogue diverge. */
  function totalStock (variants, fallback) {
    if (Array.isArray(variants) && variants.length) {
      return variants.reduce(function (s, v) { return s + (_num(v.stock) || 0); }, 0);
    }
    var f = _num(fallback);
    return f === null ? 0 : Math.max(0, f);
  }

  /* ── THE ONE ENTRY POINT ──────────────────────────────────────────────────
     Returns the ADDITIVE patch to merge onto a product document, plus any problems.
     It never returns `price`, `name` or `category`: those belong to the existing
     writer and are not this file's to redefine. */
  function build (input) {
    var i = input || {};
    var specs = normalizeSpecs(i.specs);
    var variants = normalizeVariants(i.variants);
    var unit = normalizeStockUnit(i.stockUnit);
    var problems = [];

    var dupes = variantConflicts(variants);
    if (dupes.length) problems.push('Two variants share the same options: ' + dupes.join(', '));

    if (Array.isArray(i.variants) && i.variants.length && !variants.length) {
      problems.push('A variant needs at least one option (for example Colour or Size) to tell it apart.');
    }

    /* An unresolved unit is reported, not silently stored as a number without meaning. */
    Object.keys(specs).forEach(function (k) {
      if (specs[k] && specs[k].unresolved) {
        problems.push('"' + (specs[k].u || '') + '" is not a unit we recognise for ' + k + '.');
      }
    });

    var patch = {};
    if (Object.keys(specs).length) patch.specs = specs;
    if (variants.length) patch.variants = variants;
    if (unit) patch.stockUnit = unit;
    if (variants.length) patch.stock = totalStock(variants, i.stock);

    return { ok: problems.length === 0, patch: patch, problems: problems };
  }

  var API = {
    UNITS: UNITS, STOCK_UNITS: STOCK_UNITS, CATEGORY_SPECS: CATEGORY_SPECS,
    SIZE_SYSTEMS: SIZE_SYSTEMS, size: size,
    canonicalUnit: canonicalUnit, measure: measure,
    categoryKey: categoryKey, suggestionsFor: suggestionsFor,
    normalizeSpecs: normalizeSpecs, normalizeStockUnit: normalizeStockUnit,
    normalizeVariants: normalizeVariants, variantConflicts: variantConflicts,
    totalStock: totalStock, build: build,
  };

  if (global) global.SokoniProductSpecs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
