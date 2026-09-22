/* ============================================================================
   SOKONI — business display identity        sokoni-business-identity.js v1.0.0
   ============================================================================
   Who is on the other end of this conversation, said in a way a person
   recognises: "KASS Shop · Business", not "seller", and never "Donna".

   THE DISTINCTION THIS MODULE EXISTS FOR
   --------------------------------------
   A merchant owner OPERATES a business. They are not the business. A customer
   who asks a shop about a product is talking to the shop, and must never
   discover they were talking to a person's account — that is a different
   relationship, with different expectations, that nobody agreed to.

   So this module maps a business ANCHOR to a business NAME. It never maps a
   person to a name, because no surface in SOKONI should present a counterparty
   as an individual unless the relationship itself is with an individual.

   PRESENTATION ONLY — IT DECIDES NOTHING
   --------------------------------------
   Nothing here authorizes anything, chooses a recipient, or reaches a person.
   The recipient was already resolved server-side from the anchor before any of
   this runs. If every function in this file returned an em dash, the platform
   would behave identically and simply read less well. That is the test of
   whether a presentation layer has quietly become an authority: this one has
   not, and must not.

   IT DERIVES, IT DOES NOT ACCEPT
   ------------------------------
   The name comes from the ANCHOR — a product, an order, a case — resolved
   through readers the caller injects. It is never taken from a request, a URL
   or a client-supplied field. A name that arrives in a payload is a name an
   attacker can choose, and a convincing shop name over someone else's
   conversation is worse than no name at all.

   PURE. No require, no clock, no network, no Firebase. The readers are
   injected, so every branch below is testable without any of them.
   ========================================================================= */
(function (global) {
  'use strict';

  var DASH = '—';

  /* What KIND of counterparty a conversation has. These are display
     categories, deliberately NOT the authority's roles: the authority answers
     "may these two communicate", and this answers "what should the human
     read". Keeping the vocabularies apart is what stops a presentation change
     from looking like a permission change. */
  var KINDS = ['business', 'platform', 'person_role', 'unknown'];

  /* Which anchor kind presents as which counterparty, per the role the SERVER
     assigned. A pair absent from this table renders as unknown — a dash — and
     that is a real answer rather than a gap to be filled with a guess. */
  var PRESENTATION = {
    'inquiry:seller':  { kind: 'business',    context: 'Product Inquiry' },
    'order:seller':    { kind: 'business',    context: 'Order' },
    'order:buyer':     { kind: 'person_role', context: 'Order', label: 'Customer' },
    'booking:provider':{ kind: 'business',    context: 'Booking' },
    'booking:buyer':   { kind: 'person_role', context: 'Booking', label: 'Customer' },
    'supply:supplier': { kind: 'business',    context: 'Supply' },
    'supply:seller':   { kind: 'business',    context: 'Supply' },
    /* Delivery binds a RIDER to both ends. A rider is a person doing a job,
       not a business, and their name is not ours to broadcast — the role is
       what the other party actually needs to know. */
    'delivery:rider':  { kind: 'person_role', context: 'Delivery', label: 'Your rider' },
    'delivery:buyer':  { kind: 'person_role', context: 'Delivery', label: 'Customer' },
    'delivery:seller': { kind: 'business',    context: 'Delivery' },
    /* SOKONI is one identity to the person it is helping. Which administrator
       happens to hold the case is an internal operational fact; publishing it
       turns a platform conversation into a personal one and makes an
       individual the target of a complaint about a company. */
    'support:admin':   { kind: 'platform',    context: 'Support', label: 'SOKONI Support' },
    'support:buyer':   { kind: 'person_role', context: 'Support', label: 'Customer' },
    'support:seller':  { kind: 'business',    context: 'Support' },
  };

  /**
   * presentationFor(relationship, counterpartyRole) -> descriptor | null
   * PURE. Null means "no rule", which the caller must render as unknown.
   */
  function presentationFor(relationship, counterpartyRole) {
    var key = String(relationship || '') + ':' + String(counterpartyRole || '');
    return Object.prototype.hasOwnProperty.call(PRESENTATION, key)
      ? PRESENTATION[key] : null;
  }

  /**
   * describe({ relationship, counterpartyRole, businessName }) -> identity
   *
   * PURE, and the whole decision. `businessName` is whatever a reader managed
   * to resolve; everything else follows from the table.
   *
   *   { kind, label, sublabel, context, named }
   *
   * `named` says whether a REAL business name was resolved, so a surface can
   * tell "KASS Shop" from a fallback without inspecting the label string.
   */
  function describe(input) {
    var i = input || {};
    var p = presentationFor(i.relationship, i.counterpartyRole);

    if (!p) {
      /* No rule. Not a guess, not the role verbatim — a dash. A relationship
         this module has not been taught is one it cannot describe. */
      return { kind: 'unknown', label: DASH, sublabel: null, context: null, named: false };
    }

    if (p.kind === 'business') {
      var name = String(i.businessName || '').trim();
      if (name) {
        return { kind: 'business', label: name.slice(0, 80), sublabel: 'Business',
                 context: p.context, named: true };
      }
      /* The business exists; its NAME could not be read. Say "Business" and
         mean it, rather than falling back to the operator's account — which is
         exactly the substitution this module exists to prevent — or to a uid,
         which is an identifier the reader cannot use and should not see. */
      return { kind: 'business', label: 'Business', sublabel: null,
               context: p.context, named: false };
    }

    return { kind: p.kind, label: p.label || DASH, sublabel: null,
             context: p.context, named: false };
  }

  /**
   * resolveBusinessName({ anchorType, anchorId }, readers) -> Promise<string|null>
   *
   * The derivation, and the ONLY way a name enters this module:
   *
   *     products/{anchorId}.sellerUid  ->  shops/{sellerUid}  ->  its name
   *
   * `readers` supplies { readProduct, readOrder, readShop }, each returning a
   * document or null. Injected, so this is testable with no Firebase and so
   * the module has no opinion about how the platform reaches its data.
   *
   * Every failure resolves to null. A conversation with an unnamed business
   * still works; a conversation labelled with the WRONG business is a person
   * telling a stranger about their order.
   */
  function resolveBusinessName(anchor, readers) {
    var a = anchor || {};
    var r = readers || {};
    var type = String(a.anchorType || '');
    var id = String(a.anchorId || '');
    if (!id) return Promise.resolve(null);

    /* A reader may throw SYNCHRONOUSLY — a missing SDK, a denied permission
       raised on the call rather than the promise. Promise.resolve() wraps a
       RETURNED value, so a synchronous throw escapes the .catch() entirely and
       takes the whole conversation header down with it. Every reader is invoked
       through this. */
    function _try(fn, arg) {
      try { return Promise.resolve(fn(arg)); }
      catch (e) { return Promise.resolve(null); }
    }

    function shopName(sellerUid) {
      if (!sellerUid || typeof r.readShop !== 'function') return null;
      return _try(r.readShop, String(sellerUid)).then(function (shop) {
        if (!shop) return null;
        /* The same fields the platform's own merchant-identity resolver reads,
           in the same order. A second naming rule would let the call header and
           the payment prompt disagree about who the shop is. */
        var n = shop.name || shop.storeName || shop.businessName || shop.displayName || '';
        n = String(n).trim();
        return n ? n : null;
      }).catch(function () { return null; });
    }

    if (type === 'products' && typeof r.readProduct === 'function') {
      return _try(r.readProduct, id).then(function (prod) {
        return prod && prod.sellerUid ? shopName(prod.sellerUid) : null;
      }).catch(function () { return null; });
    }

    if (type === 'orders' && typeof r.readOrder === 'function') {
      return _try(r.readOrder, id).then(function (order) {
        /* An order's seller is resolved from its LINE ITEMS by the server, not
           from a field on the order — order.sellerUid is buyer-written. This
           module will not second-guess that, so an order yields a name only
           when a reader hands one over explicitly. */
        return order && order.resolvedSellerUid ? shopName(order.resolvedSellerUid) : null;
      }).catch(function () { return null; });
    }

    return Promise.resolve(null);
  }

  /**
   * headerHtml(identity, esc) -> string
   * Presentation for a conversation header. `esc` is injected so this file
   * carries no escaping rule of its own to drift from the platform's.
   */
  function headerHtml(identity, esc) {
    var d = identity || {};
    var e = typeof esc === 'function' ? esc : function (s) { return String(s); };
    var icon = d.kind === 'business' ? '🏪'
             : d.kind === 'platform' ? '🛡️'
             : d.kind === 'person_role' ? '👤' : '';
    return '<div class="cx-who cx-who-' + e(d.kind || 'unknown') + '">' +
      (icon ? '<span class="cx-who-icon" aria-hidden="true">' + icon + '</span>' : '') +
      '<span class="cx-who-name">' + e(d.label || DASH) + '</span>' +
      (d.sublabel ? '<span class="cx-who-kind">' + e(d.sublabel) + '</span>' : '') +
      (d.context ? '<span class="cx-who-ctx">' + e(d.context) + '</span>' : '') +
      '</div>';
  }

  var CONTRACT = ['CONTRACT', 'KINDS', 'PRESENTATION', 'presentationFor',
    'describe', 'resolveBusinessName', 'headerHtml'];

  global.SokoniBusinessIdentity = {
    CONTRACT: CONTRACT,
    KINDS: KINDS,
    PRESENTATION: PRESENTATION,
    presentationFor: presentationFor,
    describe: describe,
    resolveBusinessName: resolveBusinessName,
    headerHtml: headerHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
