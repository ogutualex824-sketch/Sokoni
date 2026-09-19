/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — LISTING STUDIO. The surface that turns the product editor into a listing editor.
   sokoni-listing-studio.js

   WHAT THIS IS
   A renderer, and only a renderer. It answers one question for the Merchant V2 product
   editor: given a listing, what should be on screen? It holds no state, mounts no panel,
   owns no route and writes nothing. Every figure it shows is derived from the listing it
   was handed.

   WHY IT IS NOT A SECOND UPLOADER
   The rule is explicit: no product-uploader.html, no restaurant-uploader.html, no second
   merchant app, no duplicate card and no duplicate detail component. So this file adds a
   type picker, a set of type-specific fields, a completeness report and a customer preview
   INTO the editor that already exists in sokoni-merchant-products.js. It emits the editor's
   own `pr-*` markup so the new sections are indistinguishable from the ones already there —
   the merchant sees a longer form, not a different application.

   WHERE ITS ANSWERS COME FROM
     sokoni-listing-types.js   which type this is, and what the customer is offered
     sokoni-listing-model.js   which fields that type collects, and how complete it is
   Neither is consulted twice and neither is re-implemented here. If a field is wrong, it is
   wrong in one table, not in eight forms.

   THE FIELDS IT DOES NOT RENDER
   It is handed the set of keys the native editor already draws — name, price, category,
   brand, condition and the rest — and skips them. Drawing a second "Price (KES)" box would
   give the merchant two inputs for one number and the writer no way to know which one they
   meant.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function LT () { return root.SokoniListingTypes || null; }
  function LM () { return root.SokoniListingModel || null; }

  /* The type currently in force: what the merchant has picked while typing, else what the
     record carries, else whatever the type authority infers from the category. */
  function typeIdOf (listing) {
    var T = LT();
    if (!T) return (listing && listing.listingType) || 'product';
    return T.typeOf(listing || {}).id;
  }

  /* ── 1. WHAT ARE YOU LISTING? ───────────────────────────────────────────────────────────
     The single control that makes one editor serve a shop, a kitchen, a hotel and a garage.

     THE HIDDEN INPUT IS THE ONE THAT SAVES. The chips are buttons, and a button is not a
     form value — so the chosen type is mirrored into an input carrying the editor's own
     `data-pf` attribute. That means a typed field and a tapped chip reach the writer by
     exactly the same route, which is the property that stops the picker becoming a second
     way into the record. */
  function typePickerHTML (listing) {
    var T = LT();
    if (!T) return '';
    var cur = typeIdOf(listing);
    var explicit = listing && listing.listingType;
    var chips = Object.keys(T.TYPES).map(function (id) {
      var t = T.TYPES[id];
      var on = id === cur;
      return '<button type="button" class="ls-chip' + (on ? ' on' : '') + '" data-ls="type" ' +
        'data-type="' + esc(id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="ls-chip-e">' + t.primary.icon + '</span>' +
        '<span>' + esc(t.label) + '</span></button>';
    }).join('');

    var t = T.TYPES[cur] || T.TYPES.product;
    return '<div class="pr-sec ls-sec"><div class="pr-sec-h">' +
        '<span class="pr-sec-e">🧭</span><span class="pr-sec-t">What are you listing?</span></div>' +
      '<div class="pr-sec-s">This decides which details you are asked for, and what a ' +
        'customer is offered. It does not change where it is saved.</div>' +
      '<div class="ls-chips">' + chips + '</div>' +
      '<input type="hidden" data-pf="listingType" value="' + esc(explicit ? cur : '') + '">' +
      /* INFERRED IS SAID, NOT HIDDEN. A merchant who never chose a type is looking at a
         guess made from their category, and has every right to know that before they
         publish something labelled "Book Appointment". */
      '<div class="pr-note">' +
        (explicit
          ? 'Customers will see <b>' + esc(t.primary.label) + '</b>' +
            (t.secondary ? ' and <b>' + esc(t.secondary.label) + '</b>' : '') + '.'
          : 'Not set — SOKONI is reading this as <b>' + esc(t.label) + '</b> from your category. ' +
            'Pick one above to decide it yourself.') +
      '</div></div>';
  }

  /* ── 2. THE TYPE'S OWN FIELDS ───────────────────────────────────────────────────────────
     Rendered from sokoni-listing-model.js, never from a list kept here.

     `native` is the set of keys the surrounding editor already draws. Everything in it is
     skipped, so adding a field to the native form removes it from here automatically and
     the two can never drift into showing the same box twice.

     The dotted `lf.` prefix puts these values in their own namespace on the way to the
     writer, for the same reason `spec.` and `ownership.` have one: the form is flat and the
     listing model is not. */
  function extraFieldsHTML (listing, native) {
    var M = LM(), T = LT();
    if (!M) return '';
    var skip = {};
    (native || []).forEach(function (k) { skip[k] = 1; });
    var typeId = typeIdOf(listing);
    var l = listing || {};
    var attrs = l.attributes || {};

    var fields = M.fieldsFor(l).filter(function (f) { return !skip[f.key]; });
    if (!fields.length) return '';

    var body = fields.map(function (f) {
      var id = 'pf-lf-' + f.key;
      var key = 'lf.' + f.key;
      /* The typed value wins over the stored one, so a repaint never discards what the
         merchant has in front of them. */
      var cur = (l['lf.' + f.key] !== undefined) ? l['lf.' + f.key] : attrs[f.key];
      var req = f.required ? ' <span class="ls-req">required to publish</span>' : '';
      var label = '<label class="pr-l" for="' + id + '">' + esc(f.label) + req + '</label>';
      var input;

      if (f.kind === 'textarea') {
        input = '<textarea class="pr-i" id="' + id + '" data-pf="' + key + '" maxlength="2000">' +
          esc(cur == null ? '' : cur) + '</textarea>';
      } else if (f.kind === 'bool') {
        return '<label class="pr-check"><input type="checkbox" data-pf="' + key + '"' +
          (cur ? ' checked' : '') + '> <span>' + esc(f.label) + '</span></label>';
      } else if (f.kind === 'select') {
        input = '<select class="pr-i pr-sel" id="' + id + '" data-pf="' + key + '">' +
          '<option value="">— Select —</option>' +
          (f.options || []).map(function (o) {
            return '<option value="' + esc(o) + '"' +
              (String(cur) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
          }).join('') + '</select>';
      } else if (f.kind === 'list') {
        /* A list is typed as text and split on save. A repeater for six optional lists
           would be more form than any merchant will fill in. */
        var asText = Array.isArray(cur) ? cur.join(', ') : (cur == null ? '' : cur);
        input = '<input class="pr-i" id="' + id + '" data-pf="' + key + '" type="text" ' +
          'maxlength="600" value="' + esc(asText) + '">';
      } else {
        var t = f.kind === 'number' ? 'number' : (f.kind === 'time' ? 'time' : 'text');
        input = '<input class="pr-i" id="' + id + '" data-pf="' + key + '" type="' + t + '" ' +
          (t === 'number' ? 'inputmode="decimal" step="any" min="0" ' : 'maxlength="200" ') +
          'value="' + esc(cur == null ? '' : cur) + '">';
      }
      return '<div class="pr-f">' + label + input +
        (f.kind === 'list' ? '<div class="pr-note">Separate each one with a comma.</div>' : '') +
        '</div>';
    }).join('');

    var tlabel = (T && T.TYPES[typeId]) ? T.TYPES[typeId].label : typeId;
    return '<div class="pr-sec ls-sec"><div class="pr-sec-h">' +
        '<span class="pr-sec-e">📋</span><span class="pr-sec-t">' + esc(tlabel) + ' details</span></div>' +
      '<div class="pr-sec-s">Asked because you are listing a ' + esc(String(tlabel).toLowerCase()) +
        '. Change the type above and these change with it.</div>' +
      body + '</div>';
  }

  /* ── 3. MEDIA GROUPS ────────────────────────────────────────────────────────────────────
     Metadata over ONE media pipeline. A hotel's photographs are a room, a bathroom and a
     view; a restaurant's are the dish and the room it is served in. That is a label on an
     upload, not a second uploader — which is why this renders names and nothing else.

     It is deliberately not a drop zone. The editor's existing photo control owns uploading,
     and a second one here would be the duplicate media pipeline the rule forbids. */
  function mediaGroupsHTML (listing) {
    var M = LM();
    if (!M) return '';
    var groups = M.mediaGroupsFor(listing || {});
    var imgs = Array.isArray(listing && listing.images) ? listing.images.length
             : ((listing && listing.image) ? 1 : 0);
    return '<div class="pr-sec ls-sec"><div class="pr-sec-h">' +
        '<span class="pr-sec-e">🖼️</span><span class="pr-sec-t">Photos to include</span></div>' +
      '<div class="pr-sec-s">What buyers of this type expect to see. Photos are added with ' +
        'the photo button — this is the shot list, not a second uploader.</div>' +
      '<div class="ls-groups">' + groups.map(function (g) {
        return '<span class="ls-group">' + esc(g) + '</span>';
      }).join('') + '</div>' +
      '<div class="pr-note">' +
        (imgs ? esc(imgs) + ' photo' + (imgs === 1 ? '' : 's') + ' on this listing so far.'
              : 'No photos yet. A listing without one is rarely opened.') +
      '</div></div>';
  }

  /* ── 4. LISTING QUALITY ─────────────────────────────────────────────────────────────────
     NOT A COSMETIC BAR. Every point in the score is a named field, and everything missing is
     printed, so the merchant is told what remains rather than left to guess which of thirty
     inputs the number is complaining about.

     The blocking items are separated from the rest because they are a different kind of
     fact: one is "this would be a better listing", the other is "this cannot be published". */
  function qualityHTML (listing) {
    var M = LM();
    if (!M) return '';
    var q = M.quality(listing || {});
    var blocking = q.missing.filter(function (m) { return m.required; });
    var optional = q.missing.filter(function (m) { return !m.required; });
    var tone = q.score >= 80 ? 'good' : (q.score >= 50 ? 'ok' : 'low');

    return '<div class="pr-sec ls-sec"><div class="pr-sec-h">' +
        '<span class="pr-sec-e">📊</span><span class="pr-sec-t">Listing quality</span></div>' +
      '<div class="ls-score ls-score--' + tone + '">' +
        '<div class="ls-bar"><i style="width:' + q.score + '%"></i></div>' +
        '<b>' + q.score + '%</b></div>' +
      (blocking.length
        ? '<div class="ls-need"><b>Needed before you can publish</b><ul>' +
            blocking.map(function (m) { return '<li>' + esc(m.label) + '</li>'; }).join('') +
          '</ul></div>'
        : '<div class="ls-ok">Everything required to publish is here.</div>') +
      (optional.length
        ? '<div class="ls-opt"><b>Would make it stronger</b><ul>' +
            optional.map(function (m) { return '<li>' + esc(m.label) + '</li>'; }).join('') +
          '</ul></div>'
        : '') +
      '<div class="pr-note">' + q.passed.length + ' of ' +
        (q.passed.length + q.missing.length) + ' complete.</div></div>';
  }

  /* ── 5. CUSTOMER PREVIEW ────────────────────────────────────────────────────────────────
     What the buyer will actually see, built from the same type authority the real card and
     the real listing page read. It is a preview because it is drawn from the live form
     values — not a screenshot, and not a second card component: the marketplace card keeps
     its own markup, and this shows the same FACTS through the editor's own styling.

     THE PRICE IS SHOWN ONLY WHEN THERE IS ONE. A preview that renders "KES 0" for an empty
     price box teaches the merchant their listing is free. */
  function previewHTML (listing, device) {
    var T = LT();
    if (!T) return '';
    var l = listing || {};
    var t = T.typeOf(l);
    var d = device === 'desktop' ? 'desktop' : 'mobile';
    var priceNum = Number(l.price);
    var hasPrice = l.price !== '' && l.price != null && isFinite(priceNum) && priceNum > 0;
    var img = l.image || (Array.isArray(l.images) && l.images[0]) || null;

    /* The one line of fact under the price, in the type's own vocabulary. */
    var facts = [];
    var a = l.attributes || {};
    function at (k) { return (l['lf.' + k] !== undefined) ? l['lf.' + k] : a[k]; }
    if (t.id === 'food' && at('prepTime')) facts.push(esc(at('prepTime')) + ' min');
    if (t.id === 'room') {
      if (at('guests')) facts.push(esc(at('guests')) + ' guests');
      if (at('beds')) facts.push(esc(at('beds')) + ' bed');
    }
    if (t.id === 'service' && at('duration')) facts.push(esc(at('duration')));
    if (t.id === 'vehicle' && at('year')) facts.push(esc(at('year')));
    if (l.location) facts.push(esc(l.location));

    return '<div class="pr-sec ls-sec"><div class="pr-sec-h">' +
        '<span class="pr-sec-e">👁️</span><span class="pr-sec-t">Customer preview</span></div>' +
      '<div class="pr-sec-s">How this listing reads to a buyer right now.</div>' +
      '<div class="ls-dev">' +
        '<button type="button" class="ls-devbtn' + (d === 'mobile' ? ' on' : '') +
          '" data-ls="device" data-device="mobile">Mobile</button>' +
        '<button type="button" class="ls-devbtn' + (d === 'desktop' ? ' on' : '') +
          '" data-ls="device" data-device="desktop">Desktop</button>' +
      '</div>' +
      '<div class="ls-prev ls-prev--' + d + '">' +
        '<div class="ls-prev-img">' +
          (img ? '<img src="' + esc(img) + '" alt="">' : '<span>No photo yet</span>') + '</div>' +
        '<div class="ls-prev-body">' +
          '<div class="ls-prev-name">' + esc(l.name || 'Untitled listing') + '</div>' +
          /* NO RATING IS INVENTED. A new listing has no reviews, and a preview showing
             "★ 4.8" would be showing the merchant a number that does not exist. */
          '<div class="ls-prev-price">' +
            (hasPrice ? 'KES ' + priceNum.toLocaleString('en-KE')
                      : '<span class="ls-prev-none">No price yet</span>') + '</div>' +
          (facts.length ? '<div class="ls-prev-facts">' + facts.join(' · ') + '</div>' : '') +
          /* The SAME availability reading the customer page renders, so the merchant's
             preview and the listing page can never disagree about whether this is
             available. Absent when the module has not loaded. */
          (root.SokoniAvailabilityView
            ? '<div class="ls-prev-avl">' + root.SokoniAvailabilityView.lineHtml(l) + '</div>' : '') +
          '<div class="ls-prev-acts">' +
            '<span class="ls-prev-cta">' + t.primary.icon + ' ' + esc(t.primary.label) + '</span>' +
            (t.secondary
              ? '<span class="ls-prev-cta ls-prev-cta--2">' + t.secondary.icon + ' ' +
                esc(t.secondary.label) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div></div>';
  }

  /* ── 6. LIFECYCLE ───────────────────────────────────────────────────────────────────────
     Draft → Review → Live, and where this listing is on it. The states and the legal moves
     between them come from the listing model, so a transition offered here is one the model
     will actually accept. */
  function lifecycleHTML (listing) {
    var M = LM();
    if (!M) return '';
    var l = listing || {};
    /* `status` is the editor's existing visibility field, and 'active' is what it calls
       live. Reading it rather than inventing a parallel field keeps one state, not two. */
    var cur = l.lifecycle || (l.status === 'active' ? 'live' : (l.status || 'draft'));
    if (!M.LIFECYCLE[cur]) cur = 'draft';
    /* A LISTING THAT HAS NEVER BEEN SAVED IS A DRAFT, whatever the visibility select says.
       Without this, choosing a type on a new listing made the chain jump to "Live" — the
       form's visibility field defaults to active, and capturing it told the merchant their
       unsaved listing was already on sale. Nothing is live until the writer has said so,
       and an id is the only evidence that it has. */
    var saved = !!(l.id || l.productId || l._id);
    if (!saved) cur = 'draft';
    var order = ['draft', 'review', 'live', 'paused', 'archived'];
    var atIdx = order.indexOf(cur);

    return '<div class="pr-sec ls-sec"><div class="pr-sec-h">' +
        '<span class="pr-sec-e">🚦</span><span class="pr-sec-t">Listing status</span></div>' +
      '<div class="ls-life">' + order.map(function (id, i) {
        var s = M.LIFECYCLE[id];
        var cls = i === atIdx ? ' on' : (i < atIdx ? ' done' : '');
        return '<span class="ls-life-s' + cls + '">' + esc(s.label) + '</span>';
      }).join('<span class="ls-life-x">›</span>') + '</div>' +
      '<div class="pr-note">' +
        (saved ? '' : 'Nothing is saved yet — this listing does not exist until you add it. ') +
        'Saving keeps it a draft until you set visibility to active. ' +
        'Price, stock and booking rules are written by the authority that owns them, not here.</div>' +
      '</div>';
  }

  /* `lf.*` back into the listing shape the model reads, so quality() and the preview can be
     scored against what is on screen rather than what was last saved.

     THE ATTRIBUTES ARE ALSO PROJECTED FLAT, and that is the load-bearing half. quality()
     looks up every field by its bare key — it asks a room for `guests`, not for
     `attributes.guests` — so a merchant who filled in the guest count would have gone on
     being told it was missing, and a fully completed room would have sat at a blocked
     score for ever. The flat copy exists only for reading: the writer assembles its patch
     from fieldsFromForm(), which keeps these values inside `attributes` where the universal
     listing model puts them. Nothing here is ever saved. */
  function applyFormValues (product, values) {
    var out = {}, attrs = {};
    Object.keys(product || {}).forEach(function (k) { out[k] = product[k]; });
    Object.keys(product && product.attributes || {}).forEach(function (k) {
      attrs[k] = product.attributes[k];
    });
    Object.keys(values || {}).forEach(function (k) {
      if (k.indexOf('lf.') === 0) { attrs[k.slice(3)] = values[k]; out[k] = values[k]; }
      else out[k] = values[k];
    });
    /* A real top-level field always wins: `price` on the record is the price, whatever an
       attribute of the same name happens to say. */
    Object.keys(attrs).forEach(function (k) {
      if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = attrs[k];
    });
    out.attributes = attrs;
    return out;
  }

  var api = {
    typeIdOf: typeIdOf,
    typePickerHTML: typePickerHTML,
    extraFieldsHTML: extraFieldsHTML,
    mediaGroupsHTML: mediaGroupsHTML,
    qualityHTML: qualityHTML,
    previewHTML: previewHTML,
    lifecycleHTML: lifecycleHTML,
    applyFormValues: applyFormValues,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniListingStudio = api;
/* globalThis, for the reason recorded in sokoni-listing-model.js: `this` at CommonJS module
   scope is module.exports, not the global, and a sibling module read off it is invisible. */
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
