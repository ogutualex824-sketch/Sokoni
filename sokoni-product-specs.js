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
      { key: 'engineCapacity', label: 'Engine capacity', type: 'measure', dim: 'volume', unit: 'cc' },
      { key: 'fuelType', label: 'Fuel type' }, { key: 'transmission', label: 'Transmission' },
      { key: 'driveType', label: 'Drive type' }, { key: 'bodyType', label: 'Body type' },
      { key: 'seats', label: 'Seats', type: 'number' }, { key: 'doors', label: 'Doors', type: 'number' },
      { key: 'condition', label: 'Condition' }, { key: 'vin', label: 'VIN' },
      { key: 'registration', label: 'Registration' }, { key: 'colour', label: 'Colour' },
      { key: 'horsepower', label: 'Horsepower', type: 'number' },
    ],
    electronics: [
      { key: 'model', label: 'Model' },
      { key: 'storage', label: 'Storage' }, { key: 'ram', label: 'RAM' },
      { key: 'screenSize', label: 'Screen size', type: 'measure', dim: 'length', unit: 'in' },
      { key: 'resolution', label: 'Resolution' },
      { key: 'batteryCapacity', label: 'Battery capacity', type: 'measure', unit: 'mAh' },
      { key: 'operatingSystem', label: 'Operating system' },
      { key: 'connectivity', label: 'Connectivity' }, { key: 'colour', label: 'Colour' },
      { key: 'warranty', label: 'Warranty' }, { key: 'condition', label: 'Condition' },
    ],
    clothing: [
      { key: 'size', label: 'Size' }, { key: 'fit', label: 'Fit' },
      { key: 'gender', label: 'Gender' }, { key: 'colour', label: 'Colour' },
      { key: 'material', label: 'Material' }, { key: 'pattern', label: 'Pattern' },
      { key: 'waist', label: 'Waist', type: 'measure', dim: 'length', unit: 'in' },
      { key: 'chest', label: 'Chest', type: 'measure', dim: 'length', unit: 'in' },
    ],
    furniture: [
      { key: 'material', label: 'Material' },
      { key: 'seatingCapacity', label: 'Seating capacity', type: 'number' },
      { key: 'assemblyRequired', label: 'Assembly required' }, { key: 'colour', label: 'Colour' },
    ],
    food: [
      { key: 'netWeight', label: 'Net weight', type: 'measure', dim: 'weight', unit: 'g' },
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
    electronic: 'electronics', phones: 'electronics', computers: 'electronics',
    clothes: 'clothing', fashion: 'clothing', shoes: 'clothing',
    groceries: 'food', grocery: 'food', produce: 'food', agriculture: 'food',
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
    return { v: v, u: u, dim: dim, base: v * UNITS[dim].units[u], baseUnit: UNITS[dim].base };
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
    canonicalUnit: canonicalUnit, measure: measure,
    categoryKey: categoryKey, suggestionsFor: suggestionsFor,
    normalizeSpecs: normalizeSpecs, normalizeStockUnit: normalizeStockUnit,
    normalizeVariants: normalizeVariants, variantConflicts: variantConflicts,
    totalStock: totalStock, build: build,
  };

  if (global) global.SokoniProductSpecs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
