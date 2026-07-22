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
  var FIELDS = [
    { key: 'name',            suffix: 'Name',            type: 'text',     required: true,  trim: true },
    { key: 'price',           suffix: 'Price',           type: 'number',   required: true,  min: 0 },
    { key: 'category',        suffix: 'Category',        type: 'category' },
    { key: 'stock',           suffix: 'Stock',           type: 'number',   min: 0, emptyKeeps: true, coerceKey: 'stock' },
    { key: 'costPrice',       suffix: 'CostPrice',       type: 'number',   min: 0, emptyKeeps: true },
    { key: 'deliveryCost',    suffix: 'DeliveryCost',    type: 'number',   min: 0, emptyKeeps: true },
    { key: 'location',        suffix: 'Location',        type: 'text',     trim: true, emptyKeeps: true },
    { key: 'wholesalePrice',  suffix: 'WholesalePrice',  type: 'number',   min: 0, emptyKeeps: true },
    { key: 'minWholesaleQty', suffix: 'MinWholesaleQty', type: 'number',   min: 0, emptyKeeps: true },
    { key: 'description',     suffix: 'Description',     type: 'textarea',  trim: true, emptyKeeps: true },
  ];

  function el(prefix, f, doc) {
    return (doc || document).getElementById(prefix + f.suffix);
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

  global.SokoniProductSchema = {
    FIELDS: FIELDS,
    populate: populate,
    serialize: serialize,
    validate: validate,
  };

  /* CommonJS export so the parity gate can assert the field set without a DOM. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SokoniProductSchema;
  }
})(typeof window !== 'undefined' ? window : globalThis);
