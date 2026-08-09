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
      /* ── Premium compact variant dropdowns ── */
      '.sk-vd-head{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:10px}',
      '.sk-vd-row{display:flex;flex-wrap:wrap;gap:10px}',
      '.sk-vd{flex:1 1 140px;min-width:0}',
      '.sk-vd-label{font-size:11px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:5px}',
      '.sk-vd-btn{width:100%;display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:11px;padding:11px 12px;color:#fff;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;min-height:44px;text-align:left}',
      '.sk-vd-btn:hover{border-color:rgba(113,255,0,.4)}',
      '.sk-vd-val{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sk-vd-val.empty{color:rgba(255,255,255,.4)}',
      '.sk-vd-caret{color:rgba(255,255,255,.4);font-size:12px;flex:0 0 auto}',
      /* picker sheet */
      '.sk-vd-sheet{display:none;position:fixed;inset:0;z-index:var(--sk-z-sheet,100020);background:rgba(0,0,0,.72);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:16px}',
      '.sk-vd-card{background:#0f0f0f;border:1px solid rgba(255,255,255,.1);border-radius:18px;width:100%;max-width:420px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden}',
      '.sk-vd-cardhead{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;font-size:15px;font-weight:900;color:#fff}',
      '.sk-vd-x{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.55);border-radius:9px;min-width:40px;min-height:40px;cursor:pointer;font-size:14px;font-family:inherit}',
      '.sk-vd-search{margin:0 16px 10px;padding:11px 13px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#fff;font-size:16px;outline:none;font-family:inherit}',
      '.sk-vd-opts{overflow-y:auto;padding:0 10px;flex:1;-webkit-overflow-scrolling:touch}',
      '.sk-vd-opt{display:flex;align-items:center;justify-content:space-between;padding:12px 12px;border-radius:10px;cursor:pointer;color:rgba(255,255,255,.82);font-size:15px;min-height:48px}',
      '.sk-vd-opt:hover{background:rgba(255,255,255,.04)}',
      '.sk-vd-opt.on{background:rgba(113,255,0,.1);color:#71ff00}',
      '.sk-vd-check{color:#71ff00;font-weight:900}',
      '.sk-vd-custom{display:flex;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.06)}',
      '.sk-vd-custominput{flex:1;padding:10px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#fff;font-size:16px;outline:none;font-family:inherit}',
      '.sk-vd-addcustom{padding:10px 16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#fff;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;min-height:44px}',
      '.sk-vd-done{margin:12px 16px 16px;padding:13px;background:rgba(113,255,0,.14);border:1px solid rgba(113,255,0,.5);color:#71ff00;border-radius:12px;font-weight:900;font-size:15px;cursor:pointer;font-family:inherit}',
      /* mobile → bottom sheet */
      '@media(max-width:560px){.sk-vd-sheet{align-items:flex-end;padding:0}.sk-vd-card{max-width:none;border-radius:20px 20px 0 0;max-height:88vh;padding-bottom:env(safe-area-inset-bottom,0px)}}',
    ].join('');
    (d.head || d.documentElement).appendChild(s);
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  /* Premium compact variant UI (v475): one dropdown per applicable attribute in a tidy
     row, instead of a bulky chip grid. Multi-select is preserved (the canonical model is
     still flat arrays: colors/sizes/materials …). Selection lives in data-selected JSON on
     each .sk-vd; a searchable bottom-sheet/popover picker edits it with an Other/Custom
     input. serializeVariants reads the same JSON — the data contract is unchanged. */
  function renderVariants(prefix, category, product, doc) {
    var d    = doc || document;
    var host = d.getElementById(prefix + 'Variants');
    if (!host) return;                       /* form has not opted in */
    ensureStyles(d);

    var attrs = attrsForCategory(category);
    if (!attrs.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
    host.style.display = '';

    var p = product || {};
    host.innerHTML =
      '<div class="sk-vd-head">Variants</div>' +
      '<div class="sk-vd-row">' +
      attrs.map(function (a) {
        var chosen = variantValues(p[a.key]);          /* tolerant of every legacy shape */
        return '<div class="sk-vd" data-attr="' + escAttr(a.key) + '" data-selected="' + escAttr(JSON.stringify(chosen)) + '">' +
          '<div class="sk-vd-label">' + escAttr(a.label) + '</div>' +
          '<button type="button" class="sk-vd-btn" data-attr="' + escAttr(a.key) + '">' +
            '<span class="sk-vd-val' + (chosen.length ? '' : ' empty') + '">' + (chosen.length ? escAttr(chosen.join(', ')) : 'Select') + '</span>' +
            '<span class="sk-vd-caret" aria-hidden="true">▾</span>' +
          '</button>' +
        '</div>';
      }).join('') +
      '</div>';

    if (!host._skVdBound) {
      host.addEventListener('click', function (ev) {
        var btn = ev.target.closest && ev.target.closest('.sk-vd-btn');
        if (!btn || !host.contains(btn)) return;
        ev.preventDefault();
        _openVariantPicker(host, btn.getAttribute('data-attr'), category, d);
      });
      host._skVdBound = true;
    }
  }

  /* Refresh one dropdown's button summary from its data-selected. */
  function _paintVd(vd) {
    var sel = []; try { sel = JSON.parse(vd.getAttribute('data-selected') || '[]'); } catch (_) {}
    var val = vd.querySelector('.sk-vd-val');
    if (val) { val.textContent = sel.length ? sel.join(', ') : 'Select'; val.classList.toggle('empty', !sel.length); }
  }

  /* Shared searchable multi-select picker (bottom-sheet on phone, centred card on desktop). */
  function _openVariantPicker(host, attrKey, category, d) {
    var attrObj = attrsForCategory(category).filter(function (a) { return a.key === attrKey; })[0];
    if (!attrObj) return;
    var vd = host.querySelector('.sk-vd[data-attr="' + attrKey + '"]');
    var selected = []; try { selected = JSON.parse(vd.getAttribute('data-selected') || '[]'); } catch (_) {}
    /* Options = predefined ∪ any custom values already chosen (so they persist/show). */
    var opts = attrObj.options.slice();
    selected.forEach(function (v) { if (opts.indexOf(v) === -1) opts.push(v); });

    var ov = d.getElementById('sk-vd-sheet') || (function () {
      var m = d.createElement('div'); m.id = 'sk-vd-sheet'; m.className = 'sk-vd-sheet';
      d.body.appendChild(m);
      m.addEventListener('click', function (e) { if (e.target === m) _closeSheet(d); });
      return m;
    })();

    var searchable = opts.length > 8;
    ov.innerHTML =
      '<div class="sk-vd-card">' +
        '<div class="sk-vd-cardhead"><span>' + escAttr(attrObj.label) + '</span>' +
          '<button type="button" class="sk-vd-x" aria-label="Close">✕</button></div>' +
        (searchable ? '<input type="text" class="sk-vd-search" placeholder="Search…" autocomplete="off">' : '') +
        '<div class="sk-vd-opts">' + opts.map(function (o) {
          var on = selected.indexOf(o) !== -1;
          return '<label class="sk-vd-opt' + (on ? ' on' : '') + '" data-val="' + escAttr(o) + '">' +
            '<span>' + escAttr(o) + '</span><span class="sk-vd-check">' + (on ? '✓' : '') + '</span></label>';
        }).join('') + '</div>' +
        '<div class="sk-vd-custom"><input type="text" class="sk-vd-custominput" placeholder="Other / custom value…" autocomplete="off">' +
          '<button type="button" class="sk-vd-addcustom">Add</button></div>' +
        '<button type="button" class="sk-vd-done">Done</button>' +
      '</div>';
    ov.style.display = 'flex';
    try { d.body.style.overflow = 'hidden'; } catch (_) {}

    var card = ov.querySelector('.sk-vd-card');
    function commit(vals) { vd.setAttribute('data-selected', JSON.stringify(vals)); _paintVd(vd); }
    function toggle(v) {
      var i = selected.indexOf(v);
      if (i === -1) selected.push(v); else selected.splice(i, 1);
      var lab = card.querySelector('.sk-vd-opt[data-val="' + (window.CSS && CSS.escape ? CSS.escape(v) : v) + '"]');
      if (lab) { lab.classList.toggle('on', selected.indexOf(v) !== -1); var ck = lab.querySelector('.sk-vd-check'); if (ck) ck.textContent = selected.indexOf(v) !== -1 ? '✓' : ''; }
      commit(selected);
    }
    card.addEventListener('click', function (e) {
      var opt = e.target.closest('.sk-vd-opt');
      if (opt) { e.preventDefault(); toggle(opt.getAttribute('data-val')); return; }
      if (e.target.closest('.sk-vd-x') || e.target.closest('.sk-vd-done')) { _closeSheet(d); return; }
      if (e.target.closest('.sk-vd-addcustom')) {
        var inp = card.querySelector('.sk-vd-custominput'); var v = (inp && inp.value.trim()) || '';
        if (v && selected.indexOf(v) === -1) {
          selected.push(v); commit(selected);
          var list = card.querySelector('.sk-vd-opts');
          var l = d.createElement('label'); l.className = 'sk-vd-opt on'; l.setAttribute('data-val', v);
          l.innerHTML = '<span>' + escAttr(v) + '</span><span class="sk-vd-check">✓</span>'; list.appendChild(l);
        }
        if (inp) inp.value = '';
      }
    });
    var srch = card.querySelector('.sk-vd-search');
    if (srch) srch.addEventListener('input', function () {
      var q = srch.value.toLowerCase();
      card.querySelectorAll('.sk-vd-opt').forEach(function (l) {
        l.style.display = l.getAttribute('data-val').toLowerCase().indexOf(q) !== -1 ? '' : 'none';
      });
    });
  }
  function _closeSheet(d) {
    var m = (d || document).getElementById('sk-vd-sheet');
    if (m) m.style.display = 'none';
    try { (d || document).body.style.overflow = ''; } catch (_) {}
  }

  /* Read selections back out — same {key:[values]|null} contract as before. Keys not in
     the current category return null so a re-categorisation clears stale values. */
  function serializeVariants(prefix, category, doc) {
    var d = doc || document;
    var host = d.getElementById(prefix + 'Variants');
    var out = {};
    ALL_ATTR_KEYS.forEach(function (k) { out[k] = null; });
    if (!host) return {};                    /* form opted out — change nothing */

    attrsForCategory(category).forEach(function (a) {
      var vd = host.querySelector('.sk-vd[data-attr="' + a.key + '"]');
      var picked = [];
      if (vd) { try { picked = JSON.parse(vd.getAttribute('data-selected') || '[]'); } catch (_) {} }
      out[a.key] = (picked && picked.length) ? picked : null;
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
