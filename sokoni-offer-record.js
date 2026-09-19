/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — OFFER RECORD. The persisted shape of a merchant offer, and nothing else.
   sokoni-offer-record.js                                            (GATE P, design)

   WHAT THIS IS
   The boundary between the promotion engine (which resolves) and whatever persistence
   authority is eventually approved (which stores). It converts one way and back:

       toRecord(offer, scope)   the document a merchant offer becomes
       fromRecord(doc)          the offer the resolver reads

   It is NOT a writer. It performs no I/O, opens no connection, and names no collection —
   `ctx.saveOffer` sends what `toRecord` produces, wherever that is decided to go. Keeping
   the shape here means the schema can be certified BEFORE any write exists, which is the
   whole point of doing Gate P in this order.

   WHY A SEPARATE FILE FROM THE PROMOTION MODEL
   sokoni-promotion-model.js is the RESOLVER: eligibility, stacking, priority, arithmetic.
   Storage shape is a different concern with a different lifetime — a stored document must
   survive schema versions the resolver never sees. Folding one into the other would mean
   every storage decision became a change to the engine that prices baskets.

   THE PROPERTY THAT MATTERS: NO SEMANTIC LOSS.
   An offer that resolves to KES 651 off must still resolve to KES 651 off after being
   written and read back. The suite proves that by RESOLVING A BASKET twice — once against
   the original offer, once against the round-tripped one — and comparing the full result,
   not by comparing fields. Comparing fields would only prove the fields I remembered to
   compare; comparing outcomes catches the one I forgot.

   OWNERSHIP IS NEVER TAKEN FROM THE FORM.
   `shopId` and `sellerUid` come from the resolved scope, exactly as the certified product
   writer does it. A merchant cannot file an offer against another shop by typing its id,
   because what they type is discarded.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 1;

  /* EVERY FIELD THE RESOLVER READS. Derived from sokoni-promotion-model.js by reading what
     it actually consults — `o.<field>` — rather than from memory. If the engine learns a new
     field, the round-trip suite fails, which is the intended alarm: a field the resolver
     reads but storage drops is a silent pricing change. */
  var RESOLVER_FIELDS = [
    'id', 'type', 'name', 'status',
    'percent', 'amount', 'bundlePrice', 'items',
    'buyQty', 'getQty', 'maxFreeItems', 'freeItemId',
    'minSpend', 'maxDiscount', 'inventoryLimit',
    'perCustomerLimit', 'totalRedemptionLimit',
    'qualifyingListingIds', 'fulfilment', 'schedule', 'stacking',
    'startsAt', 'endsAt',
  ];

  /* Presentation-only, carried so the card and offer panel survive a round trip too. They
     are listed separately because they must never influence resolution.

     `regularValue` was MISSING from this list, and the omission was invisible to the
     resolver-equivalence test: the resolver never reads it, so every total matched exactly
     while the customer silently lost "SAVE KES 651" from the card ribbon and the offer
     panel. A saving is the whole reason an offer is opened. This is why the schema is
     certified against the CUSTOMER SURFACE as well as the engine — two different kinds of
     loss, and only one of them shows up in a total. */
  var PRESENTATION_FIELDS = ['template', 'summary', 'locations', 'fulfilments', 'priority',
                             'regularValue'];

  function isBlank(v) { return v === undefined || v === null || v === ''; }

  function num(v) {
    if (isBlank(v)) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function list(v) {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === 'string' && v.trim() !== '') {
      return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return null;
  }

  /* A schedule is stored as given, EXCEPT that blank parts are dropped rather than stored as
     empty strings. `{days:[], from:'', to:''}` and "no schedule" must not become two
     different things once written — the first would make isLive() evaluate an empty window. */
  function schedule(s) {
    if (!s || typeof s !== 'object') return null;
    var out = {};
    var days = Array.isArray(s.days)
      ? s.days.map(function (d) { return String(d).slice(0, 3).toLowerCase(); }).filter(Boolean)
      : [];
    if (days.length) out.days = days;
    if (!isBlank(s.from)) out.from = String(s.from);
    if (!isBlank(s.to)) out.to = String(s.to);
    return Object.keys(out).length ? out : null;
  }

  function items(v) {
    if (!Array.isArray(v)) return null;
    var out = v.map(function (it) {
      if (!it || typeof it !== 'object') return null;
      var row = {};
      if (!isBlank(it.listingId)) row.listingId = String(it.listingId);
      if (!isBlank(it.name)) row.name = String(it.name);
      var q = num(it.qty); if (q !== null) row.qty = q;
      var p = num(it.price); if (p !== null) row.price = p;
      return Object.keys(row).length ? row : null;
    }).filter(Boolean);
    return out.length ? out : null;
  }

  /**
   * toRecord(offer, scope) — the document this offer becomes.
   *
   * Absent stays ABSENT. A field the merchant did not fill is omitted rather than written as
   * null or 0, because the resolver distinguishes them: `minSpend: 0` is a rule that always
   * qualifies, while an absent minSpend is no rule at all. Writing one as the other changes
   * what customers are charged.
   */
  function toRecord(offer, scope) {
    var o = offer || {}, s = scope || {};
    if (!s.ok || !s.shopId) throw new Error('offer record: a resolved shop scope is required');

    var rec = {
      schemaVersion: SCHEMA_VERSION,
      /* OWNERSHIP FROM THE SCOPE ONLY. Whatever the form said is discarded. */
      shopId: String(s.shopId),
      sellerUid: s.sellerUid ? String(s.sellerUid) : String(s.shopId),
    };

    if (!isBlank(o.id)) rec.id = String(o.id);
    if (!isBlank(o.type)) rec.type = String(o.type);
    if (!isBlank(o.name)) rec.name = String(o.name);
    rec.status = (o.status === 'live' || o.status === 'active') ? 'live'
               : (o.status === 'scheduled' ? 'scheduled'
               : (o.status === 'archived' ? 'archived' : 'draft'));

    [['percent', num], ['amount', num], ['bundlePrice', num],
     ['buyQty', num], ['getQty', num], ['maxFreeItems', num],
     ['minSpend', num], ['maxDiscount', num], ['inventoryLimit', num],
     ['perCustomerLimit', num], ['totalRedemptionLimit', num], ['priority', num],
     ['regularValue', num],
    ].forEach(function (p) {
      var v = p[1](o[p[0]]);
      if (v !== null) rec[p[0]] = v;
    });

    if (!isBlank(o.freeItemId)) rec.freeItemId = String(o.freeItemId);
    if (!isBlank(o.stacking)) rec.stacking = String(o.stacking);
    if (!isBlank(o.fulfilment)) rec.fulfilment = String(o.fulfilment);
    if (!isBlank(o.startsAt)) rec.startsAt = String(o.startsAt);
    if (!isBlank(o.endsAt)) rec.endsAt = String(o.endsAt);

    var q = list(o.qualifyingListingIds); if (q) rec.qualifyingListingIds = q;
    var it = items(o.items); if (it) rec.items = it;
    var sc = schedule(o.schedule); if (sc) rec.schedule = sc;

    PRESENTATION_FIELDS.forEach(function (k) {
      if (k === 'priority' || k === 'regularValue') return;   /* already numeric above */
      var v = o[k];
      if (Array.isArray(v)) { if (v.length) rec[k] = v.slice(); return; }
      if (!isBlank(v)) rec[k] = String(v);
    });

    return rec;
  }

  /**
   * fromRecord(doc) — the offer the resolver reads.
   *
   * Deliberately thin. The resolver already fails closed on nonsense — an unknown type is
   * rejected, a malformed window is not live — so re-validating here would put a second,
   * divergeable opinion in front of it. What this does is restore shape, not judgement.
   */
  function fromRecord(doc) {
    if (!doc || typeof doc !== 'object') return null;
    var o = {};
    RESOLVER_FIELDS.concat(PRESENTATION_FIELDS).forEach(function (k) {
      if (doc[k] !== undefined) o[k] = doc[k];
    });
    /* Ownership travels with the offer so a surface can tell whose it is, but it is not a
       resolver field and never affects pricing. */
    if (doc.shopId) o.shopId = doc.shopId;
    if (doc.sellerUid) o.sellerUid = doc.sellerUid;
    if (doc.schemaVersion !== undefined) o.schemaVersion = doc.schemaVersion;
    return o;
  }

  /**
   * IDEMPOTENCY. Derived from the shop and the merchant's own draft token — never from a
   * clock, so a retry after a dropped response produces the SAME id and claims the same
   * document instead of creating a second offer. This mirrors the product writer's
   * productDraftId, deliberately: two idempotency schemes in one codebase is one too many.
   */
  function offerDraftId(o) {
    var scope = (o && o.scope) || {};
    var token = o && o.draftToken;
    if (!scope.ok || !scope.shopId) throw new Error('offer record: a resolved shop scope is required');
    if (!token) throw new Error('offer record: draftToken is required (one per offer draft)');
    var basis = String(scope.shopId) + '::' + String(token);
    var h = 0;
    for (var i = 0; i < basis.length; i++) { h = ((h << 5) - h + basis.charCodeAt(i)) | 0; }
    return 'off_' + String(scope.shopId).slice(0, 12) + '_' + Math.abs(h).toString(36);
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    RESOLVER_FIELDS: RESOLVER_FIELDS,
    PRESENTATION_FIELDS: PRESENTATION_FIELDS,
    toRecord: toRecord,
    fromRecord: fromRecord,
    offerDraftId: offerDraftId,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniOfferRecord = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
