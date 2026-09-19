/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — OFFER VIEW. How an offer reads to a customer, on the card and on the page.
   sokoni-offer-view.js

   ONE RENDERER, TWO SURFACES. The marketplace card (script.js) and the listing page
   (product.js) both call into this file, so an offer looks and reads the same wherever a
   customer meets it. That is the point: the rule forbids a duplicate card component and a
   duplicate detail component, so this adds a TREATMENT to the two that already exist
   rather than a third of each.

   IT RENDERS NOTHING WHEN THERE IS NO OFFER
   offerOf() returns null unless the listing genuinely carries one, and every builder below
   returns '' for null. There is no offer store wired to the marketplace yet, so today these
   functions are silent on every listing — which is correct. A card that invented "SAVE KES
   651" to demonstrate the feature would be fabricating a commercial claim, and a customer
   would act on it.

   THE PRICE HERE IS A DISPLAY QUOTE, NEVER AN AUTHORITY
   sokoni-promotion-model.js resolves a basket deterministically, and the SERVER decides
   what is charged. What this file shows is what the offer says it is worth, computed from
   the offer's own figures. Where it cannot compute a saving honestly — a percentage with no
   listing price, a bundle whose items carry no prices — it shows the offer without a
   saving rather than a saving it had to guess at.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num (v) { var x = Number(v); return isFinite(x) ? x : null; }
  function kes (n) { return 'KES ' + Number(n).toLocaleString('en-KE'); }
  function PM () { return root.SokoniPromotionModel || null; }
  function LT () { return root.SokoniListingTypes || null; }

  var DAY_LABEL = { sun:'Sun', mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat' };

  /* ── WHAT OFFER, IF ANY ─────────────────────────────────────────────────────────────────
     A listing may carry one directly, or a list of which the first LIVE one is shown. An
     offer that is not live is not shown at all: "Fri 17:00–22:00" printed on a Tuesday is a
     promise the basket will refuse, and the customer finds out at checkout.

     A malformed offer is treated as no offer. isLive() already fails closed on a broken
     schedule, and that is the behaviour wanted here too. */
  function offerOf (listing, at) {
    var l = listing || {};
    var list = Array.isArray(l.offers) ? l.offers.slice() : (l.offer ? [l.offer] : []);
    if (!list.length) return null;
    var P = PM();
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || typeof o !== 'object') continue;
      if (P && P.TYPES && !P.TYPES[o.type]) continue;      /* unknown maths — never render */
      if (P && typeof P.isLive === 'function' && !P.isLive(o, at)) continue;
      return o;
    }
    return null;
  }

  /* ── WHAT IT SAVES ──────────────────────────────────────────────────────────────────────
     Returns { was, now, save } or null. NULL IS A REAL ANSWER and the common one: a free
     delivery offer takes nothing off the listing price, and a percentage cannot be turned
     into a figure without a price to apply it to.

     Nothing here rounds in the merchant's favour or the customer's — it is the offer's own
     arithmetic, and where the offer does not supply enough to do it, no figure is shown. */
  function savingOf (offer, listing) {
    var o = offer || {}, l = listing || {};
    var price = num(l.price);
    var was = null, now = null;

    if (o.type === 'bundle') {
      /* The regular value is what the items are worth SEPARATELY. It is used only when the
         offer states it or its items carry prices — never assembled from a guess. */
      var stated = num(o.regularValue);
      if (stated !== null) was = stated;
      else if (Array.isArray(o.items) && o.items.length) {
        var sum = 0, complete = true;
        o.items.forEach(function (it) {
          var p = num(it && it.price);
          if (p === null) { complete = false; return; }
          sum += p * (num(it.qty) || 1);
        });
        if (complete && sum > 0) was = sum;
      }
      now = num(o.bundlePrice);
    } else if (o.type === 'percentage' && price !== null) {
      var pct = num(o.percent);
      if (pct !== null) { was = price; now = Math.round(price - (price * pct / 100)); }
    } else if ((o.type === 'fixed' || o.type === 'spendAndSave') && price !== null) {
      var amt = num(o.amount);
      if (amt !== null) { was = price; now = Math.max(0, price - amt); }
    }

    if (now === null) return null;
    if (was === null || was <= now) return { was: null, now: now, save: null };
    return { was: was, now: now, save: was - now };
  }

  /* "Fri · 17:00–22:00", "Mon–Fri · 17:00–19:00", or '' when the offer simply always runs. */
  function scheduleText (offer) {
    var s = (offer || {}).schedule;
    if (!s) return '';
    var days = (Array.isArray(s.days) ? s.days : [])
      .map(function (d) { return DAY_LABEL[String(d).slice(0, 3).toLowerCase()]; })
      .filter(Boolean);
    var win = (s.from && s.to) ? (s.from + '–' + s.to) : '';
    /* No days selected means EVERY day, which is what the builder's own hint says — so it
       is left unsaid rather than printed as a list of seven. */
    var parts = [];
    if (days.length && days.length < 7) parts.push(days.join(', '));
    if (win) parts.push(win);
    return parts.join(' · ');
  }

  /* ── HOW MANY ARE LEFT ──────────────────────────────────────────────────────────────────
     ABSENT IS UNMETERED, NOT EXHAUSTED. This mirrors the platform's standing stock rule: a
     listing with no counter is not a listing with none left. So a remaining count appears
     only when the offer declares a limit AND a real sold figure exists to subtract. Without
     both, nothing is said — never "SOLD OUT", which would stop a customer buying something
     that is actually available. */
  function remainingOf (offer, usage) {
    var o = offer || {}, u = usage || {};
    var limit = num(o.inventoryLimit);
    if (limit === null) return null;
    var sold = num(u.inventorySold);
    if (sold === null) return null;
    return Math.max(0, limit - sold);
  }

  /* ── THE CARD TREATMENT ─────────────────────────────────────────────────────────────────
     A ribbon over the image and a price row under the name. Deliberately NOT a Buy button:
     the card rule is that cards are browse-only, and an offer does not change that — tapping
     the card opens the listing, where the offer is explained before anything is committed. */
  function cardBadgeHtml (listing, at) {
    var o = offerOf(listing, at);
    if (!o) return '';
    var s = savingOf(o, listing);
    var P = PM();
    var tpl = (P && P.TEMPLATES && P.TEMPLATES[o.template]) || null;
    var icon = (tpl && tpl.icon) || '🏷️';
    /* The strongest TRUE thing the offer can say. A saving beats a label, but a label is
       shown when there is no honest figure — rather than an empty ribbon. */
    var text = (s && s.save) ? 'SAVE ' + kes(s.save)
             : (o.type === 'freeDelivery' ? 'FREE DELIVERY'
             : (o.name ? String(o.name).toUpperCase() : 'OFFER'));
    return '<div class="pcard-offer-ribbon">' + icon + ' ' + esc(text) + '</div>';
  }

  function cardOfferHtml (listing, at) {
    var o = offerOf(listing, at);
    if (!o) return '';
    var s = savingOf(o, listing);
    var when = scheduleText(o);
    var bits = '';
    if (s && s.now !== null) {
      /* THE CARD ALREADY SHOWS THE LISTING PRICE directly above this block, so striking it
         through again here prints the same figure twice, two lines apart — which reads as
         two competing prices rather than one price and one offer. The original is struck
         only when it is genuinely a DIFFERENT number from the one the card is showing. */
      var dup = num(listing && listing.price) !== null && s.was === num(listing.price);
      bits += '<div class="pcard-offer-price">' + kes(s.now) +
              ((s.was && !dup) ? '<s>' + kes(s.was) + '</s>' : '') + '</div>';
    }
    if (o.name) bits += '<div class="pcard-offer-name">' + esc(o.name) + '</div>';
    if (o.summary) bits += '<div class="pcard-offer-sum">' + esc(o.summary) + '</div>';
    if (when) bits += '<div class="pcard-offer-when">' + esc(when) + '</div>';
    return bits ? '<div class="pcard-offer">' + bits + '</div>' : '';
  }

  /* ── THE OFFER DETAIL ───────────────────────────────────────────────────────────────────
     Rendered INTO the listing page, below the gallery and above the specifications — not as
     a separate page, because an offer is a commercial rule ABOUT a listing and splitting it
     onto its own URL would give the customer two places to read one price.

     Every block is omitted when its data is absent, so a thin offer reads as a short panel
     rather than a page of empty headings. */
  function detailHtml (listing, opts) {
    var at = (opts || {}).at;
    var o = offerOf(listing, at);
    if (!o) return '';
    var s = savingOf(o, listing);
    var P = PM();
    var tpl = (P && P.TEMPLATES && P.TEMPLATES[o.template]) || null;
    var when = scheduleText(o);
    var left = remainingOf(o, (opts || {}).usage);
    var out = '';

    /* HEADLINE */
    out += '<div class="prd-offer-head">' +
      '<span class="prd-offer-flag">' + ((tpl && tpl.icon) || '🔥') + ' ' +
        esc((tpl && tpl.label) || 'Limited-time offer') + '</span>' +
      (o.name ? '<div class="prd-offer-name">' + esc(o.name) + '</div>' : '') +
      (o.summary ? '<div class="prd-offer-sum">' + esc(o.summary) + '</div>' : '') +
      '</div>';

    if (s && s.was) {
      out += '<div class="prd-offer-money">' +
        '<span class="prd-offer-now">' + kes(s.now) + '</span>' +
        '<s class="prd-offer-was">' + kes(s.was) + '</s>' +
        '<span class="prd-offer-save">Save ' + kes(s.save) + '</span></div>';
    } else if (s) {
      out += '<div class="prd-offer-money"><span class="prd-offer-now">' + kes(s.now) + '</span></div>';
    }

    /* WHAT'S INCLUDED — only for a bundle, and only from the items it actually lists. */
    if (Array.isArray(o.items) && o.items.length) {
      out += '<div class="prd-offer-block"><h4>What’s included</h4><ul class="prd-offer-list">' +
        o.items.map(function (it) {
          var q = num(it && it.qty);
          return '<li>' + (q && q > 1 ? esc(q) + ' × ' : '') +
                 esc((it && (it.name || it.listingId)) || 'Item') + '</li>';
        }).join('') + '</ul></div>';
    }

    /* OFFER DETAILS */
    var rows = [];
    function row (k, v) { if (v !== null && v !== undefined && String(v).trim() !== '')
      rows.push('<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>'); }
    row('Available', when || (o.startsAt || o.endsAt ? '' : 'Every day'));
    if (o.startsAt || o.endsAt) {
      row('Runs', [o.startsAt, o.endsAt].filter(Boolean).join(' – '));
    }
    row('Minimum spend', num(o.minSpend) !== null ? kes(o.minSpend) : null);
    row('Maximum discount', num(o.maxDiscount) !== null ? kes(o.maxDiscount) : null);
    row('Per customer', num(o.perCustomerLimit) !== null
      ? o.perCustomerLimit + (Number(o.perCustomerLimit) === 1 ? ' redemption' : ' redemptions') : null);
    row('Locations', Array.isArray(o.locations) && o.locations.length ? o.locations.join(', ') : null);
    row('Fulfilment', Array.isArray(o.fulfilments) && o.fulfilments.length
      ? o.fulfilments.join(' · ') : (o.fulfilment || null));
    /* STACKING IS THE CUSTOMER'S BUSINESS. Whether this can be combined with another offer
       is exactly the kind of rule people discover at checkout and resent. */
    if (o.stacking === 'exclusive') row('Combining', 'Cannot be combined with other offers');
    else if (o.stacking === 'stackable') row('Combining', 'Can be combined with other offers');

    if (rows.length) {
      out += '<div class="prd-offer-block"><h4>Offer details</h4>' +
        '<table class="prd-offer-table">' + rows.join('') + '</table></div>';
    }

    /* HOW MANY LEFT — shown ONLY when both the limit and a real sold figure exist. */
    if (left !== null) {
      out += left > 0
        ? '<div class="prd-offer-left">' + esc(left) + ' left</div>'
        : '<div class="prd-offer-left prd-offer-left--out">Sold out</div>';
    }

    /* THE ADVISORY, in the customer's own words. The same sentence the Offers studio shows
       the merchant: this is what the offer says it is worth, and the server is what decides
       what is charged. Saying it here is what makes the figure above safe to show. */
    out += '<div class="prd-offer-note">The price you pay is confirmed at checkout.</div>';

    return '<div class="prd-offer-section" id="prdOfferSection">' + out + '</div>';
  }

  /* The action a customer is offered for an offer — the listing type's own verb, said of
     the package rather than the item. A bundle is not "Buy Now", it is "Order Package". */
  function actionLabel (listing, at) {
    var o = offerOf(listing, at);
    if (!o) return null;
    var T = LT();
    var t = T ? T.typeOf(listing || {}) : null;
    var verb = (t && t.primary && t.primary.label) || 'Buy Now';
    if (o.type !== 'bundle') return null;          /* a discount does not rename the action */
    if (/order/i.test(verb)) return 'Order Package';
    if (/reserve|book/i.test(verb)) return 'Reserve Package';
    return 'Add Package';
  }

  var api = {
    offerOf: offerOf, savingOf: savingOf, scheduleText: scheduleText,
    remainingOf: remainingOf, cardBadgeHtml: cardBadgeHtml, cardOfferHtml: cardOfferHtml,
    detailHtml: detailHtml, actionLabel: actionLabel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniOfferView = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
