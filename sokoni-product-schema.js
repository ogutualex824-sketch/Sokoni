/* SOKONI PRODUCT FIELD SCHEMA — the single definition of an ordinary product field.
 *
 * Upload and Edit were two hand-maintained forms. They drifted: the edit modal
 * carried 12 category options against upload's 78 and was missing five fields,
 * and the gap silently corrupted a product's category on save. This schema is
 * the fix's foundation — one list of fields, one populate step, one serialize
 * step, one validation rule set, used by both forms.
 *
 * SCOPE (Phase 1A/1B). Ordinary fields only: text, number, category, textarea,
 * boolean. The media pipeline, ownership verification and digital-product
 * sub-flows are deliberately NOT here — they are asynchronous, multi-step, and
 * their own components. They were never the source of the drift.
 *
 * EACH FIELD carries the id suffix both forms agree on (`name` → #editName /
 * #productName), so a caller passes a prefix and the schema resolves the element.
 * A field defined once therefore appears, populates, validates and saves in both
 * forms — the divergence that caused today's bug becomes structurally impossible.
 */
(function (global) {
  'use strict';

  /* `key`      — the product-document field.
     `suffix`   — capitalised id fragment; #<prefix><Suffix> (name → editName).
     `type`     — text | number | category | textarea | bool.
     `required` — blocks save when empty.
     `min`      — numeric floor (numbers only).
     A number field with `emptyKeeps:true` leaves the stored value untouched when
     blank, so clearing a box by accident never zeroes a real cost or fee. */
  /* `ids` overrides the default #<prefix><Suffix> when a form's input id does not
     follow the convention. The upload form predates the schema and uses bare ids
     (stockQty, costPrice, …) for five fields; rather than rename that HTML — which
     the upload handler and other code reference — the schema maps to the real id.
     Edit uses the convention throughout, so it needs no overrides. */
  var FIELDS = [
    { key: 'name',            suffix: 'Name',            type: 'text',     required: true,  trim: true },
    { key: 'price',           suffix: 'Price',           type: 'number',   required: true,  min: 0 },
    { key: 'category',        suffix: 'Category',        type: 'category' },
    { key: 'stock',           suffix: 'Stock',           type: 'number',   min: 0, emptyKeeps: true, ids: { product: 'stockQty' } },
    { key: 'costPrice',       suffix: 'CostPrice',       type: 'number',   min: 0, emptyKeeps: true, ids: { product: 'costPrice' } },
    { key: 'deliveryCost',    suffix: 'DeliveryCost',    type: 'number',   min: 0, emptyKeeps: true, ids: { product: 'deliveryCost' } },
    { key: 'location',        suffix: 'Location',        type: 'text',     trim: true, emptyKeeps: true },
    { key: 'wholesalePrice',  suffix: 'WholesalePrice',  type: 'number',   min: 0, emptyKeeps: true, ids: { product: 'wholesalePrice' } },
    { key: 'minWholesaleQty', suffix: 'MinWholesaleQty', type: 'number',   min: 0, emptyKeeps: true, ids: { product: 'minWholesaleQty' } },
    { key: 'description',     suffix: 'Description',     type: 'textarea',  trim: true, emptyKeeps: true },
  ];

  /* ── VARIANT ATTRIBUTES ────────────────────────────────────────────────────
     Colour, size and the like are not universal: a T-shirt needs S/M/L, a shoe
     needs 36-46, a phone needs storage, and a bag of maize needs a weight. One
     fixed "Size" box would be wrong for most of the catalogue, so the attribute
     SET is chosen by the product's category.

     Stored on the product as plain arrays under the attribute key
     (`colors: ['Black','White']`, `sizes: ['M','L']`) rather than a nested
     `variants` object, because search, filtering and the product page all read
     flat fields — a nested shape would need a migration everywhere before it
     bought anything.

     Adding a category here is the whole change: both forms pick it up, because
     both render from this list. */
  var SIZES_APPAREL = ['XS','S','M','L','XL','XXL','3XL'];
  var SIZES_SHOE    = ['36','37','38','39','40','41','42','43','44','45','46'];
  var COLORS        = ['Black','White','Grey','Navy','Blue','Red','Green',
                       'Yellow','Orange','Pink','Purple','Brown','Beige','Gold','Silver','Multicolour'];

  var ATTR = {
    colors:   { key: 'colors',   label: 'Colours',  options: COLORS,        hint: 'Colours this item comes in' },
    apparel:  { key: 'sizes',    label: 'Sizes',    options: SIZES_APPAREL, hint: 'Clothing sizes available' },
    shoe:     { key: 'sizes',    label: 'Shoe sizes', options: SIZES_SHOE,  hint: 'UK/EU sizes available' },
    storage:  { key: 'storage',  label: 'Storage',  options: ['32GB','64GB','128GB','256GB','512GB','1TB','2TB'] },
    weight:   { key: 'weights',  label: 'Pack size', options: ['250g','500g','1kg','2kg','5kg','10kg','25kg','50kg'] },
    volume:   { key: 'volumes',  label: 'Volume',   options: ['30ml','50ml','100ml','250ml','500ml','1L','2L','5L'] },
    material: { key: 'materials',label: 'Material', options: ['Cotton','Leather','Denim','Wool','Silk','Polyester','Wood','Metal','Glass','Plastic','Ceramic'] },
  };

  /* category → attribute sets. Anything not listed gets colours only, which is
     the one attribute that is almost always meaningful and never misleading. */
  var CATEGORY_ATTRS = {
    fashion:     ['colors', 'apparel', 'material'],
    accessories: ['colors', 'material'],
    shoes:       ['colors', 'shoe'],
    bags:        ['colors', 'material'],
    luxury:      ['colors', 'material'],
    kids:        ['colors', 'apparel'],

    electronics: ['colors', 'storage'],
    computers:   ['colors', 'storage'],
    gaming:      ['colors', 'storage'],
    cameras:     ['colors'],
    appliances:  ['colors'],

    furniture:   ['colors', 'material'],
    kitchen:     ['colors', 'material'],
    garden:      ['colors'],
    tools:       ['colors'],
    cleaning:    ['volume'],

    beauty:      ['colors', 'volume'],
    skincare:    ['volume'],
    haircare:    ['volume'],
    fragrances:  ['volume'],
    health:      ['volume'],

    cars:        ['colors'],
    motorcycles: ['colors'],
    'auto-parts':['colors'],
    tyres:       [],

    food:        ['weight'],
    meat:        ['weight'],
    poultry:     ['weight'],
    fish:        ['weight'],
    dairy:       ['volume'],
    bakery:      ['weight'],
    agriculture: ['weight'],
    livestock:   [],

    sports:      ['colors', 'apparel'],
    outdoor:     ['colors'],
    toys:        ['colors'],
  };

  /* Every attribute key that can appear, so populate/serialize can clear a key
     that no longer applies after a category change. */
  var ALL_ATTR_KEYS = (function () {
    var seen = {};
    Object.keys(ATTR).forEach(function (k) { seen[ATTR[k].key] = true; });
    return Object.keys(seen);
  })();

  function attrsForCategory(cat) {
    var names = CATEGORY_ATTRS[String(cat || '').toLowerCase()];
    if (!names) names = ['colors'];              /* sensible default */
    return names.map(function (n) { return ATTR[n]; }).filter(Boolean);
  }

  function elId(prefix, f) {
    return (f.ids && f.ids[prefix]) ? f.ids[prefix] : (prefix + f.suffix);
  }
  function el(prefix, f, doc) {
    return (doc || document).getElementById(elId(prefix, f));
  }

  /* Load a product into the form identified by prefix ('edit' or 'product'). */
  function populate(prefix, product, doc) {
    var p = product || {};
    FIELDS.forEach(function (f) {
      var node = el(prefix, f, doc);
      if (!node) return;
      var v = p[f.key];
      if (f.type === 'bool') { node.checked = !!v; return; }
      node.value = (v == null) ? '' : v;
    });
  }

  /* Read the form into a patch object. Only keys the user actually set are
     included: an emptyKeeps field left blank is omitted so the caller does not
     overwrite a stored value with ''. Wholesale price and its minimum quantity
     move together — a price of 0 clears both. */
  function serialize(prefix, doc) {
    var out = {};
    FIELDS.forEach(function (f) {
      var node = el(prefix, f, doc);
      if (!node) return;
      if (f.type === 'bool') { out[f.key] = !!node.checked; return; }
      var raw = f.trim ? String(node.value || '').trim() : node.value;
      if (f.type === 'number') {
        if (raw === '' || raw == null) { if (!f.emptyKeeps) out[f.key] = 0; return; }
        out[f.key] = Number(raw);
      } else {
        if ((raw === '' || raw == null) && f.emptyKeeps) return;
        out[f.key] = raw;
      }
    });
    /* Wholesale coupling: below 1 means "no wholesale", which clears both. */
    if ('wholesalePrice' in out) {
      var wp = Number(out.wholesalePrice);
      out.wholesalePrice  = wp > 0 ? wp : null;
      out.minWholesaleQty = wp > 0 ? Number(out.minWholesaleQty || 0) : null;
    }
    return out;
  }

  /* One validation pass for both forms. Returns { ok, message, field }. */
  function validate(prefix, doc) {
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      if (!f.required) continue;
      var node = el(prefix, f, doc);
      var raw = node ? (f.trim ? String(node.value || '').trim() : node.value) : '';
      if (f.type === 'number') {
        if (!(Number(raw) > 0)) return { ok: false, field: f.key, message: 'Enter a valid ' + f.key + '.' };
      } else if (!raw) {
        return { ok: false, field: f.key, message: 'Enter a ' + f.key + '.' };
      }
    }
    return { ok: true };
  }

  /* ── Variant UI ────────────────────────────────────────────────────────────
     Rendered into #<prefix>Variants. Chips rather than a multi-select: on a
     phone a native multi-select requires a long-press and is close to
     undiscoverable, and this is a mobile-first seller flow.
     Selection state lives in the DOM (aria-pressed), so no extra state to keep
     in sync and the form can be read with serialize() like any other field. */
  /* The renderer ships its own styles. Keeping them in seller.html would mean a
     second page adopting this schema renders bare browser buttons — the exact
     "one definition, two implementations" split this module exists to prevent.
     Injected once, and only in a browser. */
  var STYLE_ID = 'sk-variant-css';
  function ensureStyles(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || d.getElementById(STYLE_ID)) return;
    var s = d.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.sk-variants{margin-bottom:12px;display:grid;gap:12px}',
      '.sk-var-group{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:11px 12px}',
      '.sk-var-label{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:9px}',
      '.sk-var-hint{text-transform:none;letter-spacing:0;font-weight:400;color:rgba(255,255,255,.25);font-size:10px;margin-left:4px}',
      '.sk-var-chips{display:flex;flex-wrap:wrap;gap:7px}',
      /* 16px prevents the iOS focus-zoom that smaller controls trigger. */
      '.sk-var-chip{font-size:16px;line-height:1;font-family:inherit;font-weight:700;padding:9px 13px;border-radius:10px;cursor:pointer;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);color:rgba(255,255,255,.72);transition:background .15s,border-color .15s,color .15s;-webkit-tap-highlight-color:transparent}',
      '.sk-var-chip:hover{border-color:rgba(113,255,0,.35);color:#fff}',
      '.sk-var-chip.on{background:rgba(113,255,0,.14);border-color:rgba(113,255,0,.55);color:#71ff00}',
      '@media(max-width:480px){.sk-var-chip{padding:8px 11px}}',
    ].join('');
    (d.head || d.documentElement).appendChild(s);
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  function renderVariants(prefix, category, product, doc) {
    var d    = doc || document;
    var host = d.getElementById(prefix + 'Variants');
    if (!host) return;                       /* form has not opted in */
    ensureStyles(d);

    var attrs = attrsForCategory(category);
    if (!attrs.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
    host.style.display = '';

    var p = product || {};
    host.innerHTML = attrs.map(function (a) {
      var chosen = Array.isArray(p[a.key]) ? p[a.key].map(String) : [];
      var chips = a.options.map(function (opt) {
        var on = chosen.indexOf(String(opt)) !== -1;
        return '<button type="button" class="sk-var-chip' + (on ? ' on' : '') + '"' +
               ' data-attr="' + escAttr(a.key) + '" data-val="' + escAttr(opt) + '"' +
               ' aria-pressed="' + (on ? 'true' : 'false') + '">' + escAttr(opt) + '</button>';
      }).join('');
      return '<div class="sk-var-group" data-attr="' + escAttr(a.key) + '">' +
               '<div class="sk-var-label">' + escAttr(a.label) +
                 (a.hint ? ' <span class="sk-var-hint">' + escAttr(a.hint) + '</span>' : '') +
               '</div>' +
               '<div class="sk-var-chips">' + chips + '</div>' +
             '</div>';
    }).join('');

    /* One delegated listener per render — no per-chip handlers to leak. */
    if (!host._skVarBound) {
      host.addEventListener('click', function (ev) {
        var chip = ev.target.closest && ev.target.closest('.sk-var-chip');
        if (!chip || !host.contains(chip)) return;
        ev.preventDefault();
        var on = chip.getAttribute('aria-pressed') === 'true';
        chip.setAttribute('aria-pressed', on ? 'false' : 'true');
        chip.classList.toggle('on', !on);
      });
      host._skVarBound = true;
    }
  }

  /* Read selected chips back out. Attribute keys that do not apply to the
     current category are returned as null so a category change actively CLEARS
     stale values — a shirt re-categorised as a phone must not keep its sizes. */
  function serializeVariants(prefix, category, doc) {
    var d = doc || document;
    var host = d.getElementById(prefix + 'Variants');
    var out = {};
    ALL_ATTR_KEYS.forEach(function (k) { out[k] = null; });
    if (!host) return {};                    /* form opted out — change nothing */

    attrsForCategory(category).forEach(function (a) {
      var picked = [];
      host.querySelectorAll('.sk-var-chip[data-attr="' + a.key + '"][aria-pressed="true"]')
          .forEach(function (c) { picked.push(c.getAttribute('data-val')); });
      out[a.key] = picked.length ? picked : null;
    });
    return out;
  }

  /* ── Reading variants back out ─────────────────────────────────────────────
     Display code (product page, cards, search results) shares these so a value
     is normalised identically wherever it is shown. Tolerates every shape a
     legacy or partially-written document can hold: missing, null, empty array,
     a bare scalar, or non-string members. */
  function variantValues(raw) {
    if (raw === null || raw === undefined) return [];
    var list = Array.isArray(raw) ? raw : [raw];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v === null || v === undefined) continue;
      v = String(v).trim();
      if (v && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  /* Groups a product actually carries, in the order its category defines, then
     any attribute the category no longer claims — a re-categorised product
     should still show what it has rather than lose it silently. */
  function variantGroups(product) {
    var p = product || {}, groups = [], seen = {};
    attrsForCategory(p.category).forEach(function (a) {
      if (!a || seen[a.key]) return;
      var vals = variantValues(p[a.key]);
      if (!vals.length) return;
      seen[a.key] = 1;
      groups.push({ key: a.key, label: a.label, values: vals });
    });
    ALL_ATTR_KEYS.forEach(function (k) {
      if (seen[k]) return;
      var vals = variantValues(p[k]);
      if (!vals.length) return;
      seen[k] = 1;
      groups.push({ key: k, label: k, values: vals });
    });
    return groups;
  }

  /* One-line card summary — "Black • XL", "Black • 256GB", "500ml".
     Capped at two parts on purpose: a card has to stay scannable, and a third
     attribute is detail for the product page, not the grid. Returns '' when the
     product declares nothing, so a caller renders no element at all. */
  function variantSummary(product, max) {
    var cap = max || 2;
    var parts = [];
    var groups = variantGroups(product);
    for (var i = 0; i < groups.length && parts.length < cap; i++) {
      parts.push(groups[i].values[0]);
    }
    return parts.join(' • ');
  }

  global.SokoniProductSchema = {
    FIELDS: FIELDS,
    populate: populate,
    serialize: serialize,
    validate: validate,
    /* variant API */
    ATTR: ATTR,
    CATEGORY_ATTRS: CATEGORY_ATTRS,
    ALL_ATTR_KEYS: ALL_ATTR_KEYS,
    attrsForCategory: attrsForCategory,
    renderVariants: renderVariants,
    serializeVariants: serializeVariants,
    /* read side — display, cards, search results */
    variantValues: variantValues,
    variantGroups: variantGroups,
    variantSummary: variantSummary,
  };

  /* CommonJS export so the parity gate can assert the field set without a DOM. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SokoniProductSchema;
  }
})(typeof window !== 'undefined' ? window : globalThis);
