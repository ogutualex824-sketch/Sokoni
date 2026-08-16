/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Stock — the client layer over a stock CORRECTION (2D-1C)

   ── Why this is a SEPARATE module from sokoni-merchant-data.js ──────────────
   Not tidiness. The Sell layer is asserted — by suite, not by intention — to be
   incapable of moving stock: `test-merchant-data.js` D4/D6 forbid any Firestore
   write and any adjust-shaped export, and `test-merchant-adjust-stock.js` F3
   greps `sokoni-merchant-data.js` and fails if the string `merchantAdjustStock`
   appears in it at all. Putting corrections here keeps that invariant literally
   true rather than merely intended: the module a cashier's Sell screen loads
   cannot express a stock correction, because the function does not exist in it.

   ── The invariant this module is one half of ────────────────────────────────
     SALE        posCompleteCheckout  → stock ↓ → sale event → sold ↑
     CORRECTION  merchantAdjustStock  → stock ⇅ → movement   → sold UNCHANGED

   A correction is not a sale. Nothing here touches `sold`, and nothing here
   creates an order, a receipt or a payment.

   ── What this module CANNOT do ──────────────────────────────────────────────
   It performs no Firestore write. `merchantAdjustStock` owns the transaction,
   the ownership check, the idempotency claim and the refusal of an impossible
   result. This layer builds the payload, calls the authority, and reports what
   the authority said — including "it failed", which is never dressed up as a
   success and never compensated for with a local number.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantStock = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ADJUST_CALLABLE = 'merchantAdjustStock';
  var MOVEMENTS = 'stockMovements';

  /* Mirrors functions/merchant-inventory.js REASONS exactly. The server validates
     against its own copy and refuses anything else, so a drift here surfaces as an
     honest invalid-argument rather than an unexplained inventory change. */
  var REASONS = [
    { id: 'count_correction',   label: 'Stock count correction', hint: 'The shelf and the system disagree' },
    { id: 'restock',            label: 'Restock / delivery',     hint: 'New units received' },
    { id: 'damage',             label: 'Damaged',                hint: 'Broken or unsellable' },
    { id: 'expiry',             label: 'Expired',                hint: 'Past its date' },
    { id: 'theft',              label: 'Theft / loss',           hint: 'Missing and unaccounted for' },
    { id: 'return_to_supplier', label: 'Returned to supplier',   hint: 'Sent back' },
    { id: 'transfer',           label: 'Transferred',            hint: 'Moved to another branch' },
    { id: 'other',              label: 'Other',                  hint: 'Explain in the note' },
  ];
  var REASON_IDS = REASONS.map(function (r) { return r.id; });

  /* ── Idempotency ──────────────────────────────────────────────────────────
     Derived from shop + product + delta + reason + a per-attempt token, with NO
     clock in it, so a double tap or a retry after a dropped response reproduces
     the SAME id and the server applies the correction exactly once. Changing the
     delta or the reason makes it a different correction, which it is. */
  function adjustmentId(o) {
    var scope = o.scope, token = o.attemptToken;
    if (!scope || !scope.ok) throw new Error('merchant stock: a resolved shop scope is required');
    if (!token) throw new Error('merchant stock: attemptToken is required (one per adjustment attempt)');
    var basis = scope.shopId + '::' + String(o.productId) + '::' + Number(o.delta) +
                '::' + String(o.reason) + '::' + token;
    var h = 5381;
    for (var i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
    return 'adj_' + scope.shopId + '_' + token + '_' + h.toString(36);
  }

  /**
   * The exact payload merchantAdjustStock receives. PURE — asserting on it is
   * asserting on what the server would be asked to do.
   *
   * `delta` is signed: +5 received, -3 damaged. It is never expressed as a target
   * quantity, because two operators counting the same shelf at the same time must
   * not silently overwrite each other with an absolute number.
   */
  function buildAdjustment(o) {
    var scope = o.scope;
    if (!scope || !scope.ok) throw new Error('merchant stock: a resolved shop scope is required');
    if (!o.productId) throw new Error('merchant stock: productId is required');
    var delta = Number(o.delta);
    if (!isFinite(delta) || Math.floor(delta) !== delta || delta === 0) {
      throw new Error('merchant stock: delta must be a non-zero whole number');
    }
    if (REASON_IDS.indexOf(String(o.reason)) === -1) {
      throw new Error('merchant stock: a reason is required — an unexplained stock change is not auditable');
    }
    return {
      productId: String(o.productId),
      shopId: scope.shopId,
      adjustmentId: adjustmentId({
        scope: scope, productId: o.productId, delta: delta,
        reason: o.reason, attemptToken: o.attemptToken,
      }),
      delta: delta,
      reason: String(o.reason),
      note: o.note ? String(o.note).slice(0, 500) : '',
    };
  }

  /**
   * Apply the correction through the SERVER authority.
   *
   * Returns { ok:true, result } or { ok:false, error, code }. A failure is
   * reported as a failure: no optimistic local stock number, no "we'll fix it on
   * the next read". The screen re-reads canonical stock from the result.
   */
  async function adjustStock(o) {
    var payload = buildAdjustment(o);
    if (typeof o.callable !== 'function') throw new Error('merchant stock: callable is required');
    try {
      var res = await o.callable(payload);
      var d = (res && res.data) ? res.data : res;
      if (!d || d.ok !== true) {
        return { ok: false, error: (d && d.error) || 'The adjustment was not applied.', payload: payload };
      }
      return { ok: true, result: d, payload: payload };
    } catch (e) {
      return {
        ok: false,
        /* The server's refusals are written for the person holding the stock
           ("There are 10; count again or adjust by at most 10.") — surface them
           verbatim rather than replacing them with a generic failure. */
        error: (e && e.message) || 'The adjustment could not be applied.',
        code: (e && e.code) || null,
        payload: payload,
      };
    }
  }

  /* ── History ──────────────────────────────────────────────────────────────
     One query descriptor for this shop's movements, so the history a merchant
     reads is the same collection the authority writes. */
  function movementsQuery(scope, o) {
    if (!scope || !scope.ok) throw new Error('merchant stock: a resolved shop scope is required');
    o = o || {};
    var q = { collection: MOVEMENTS, where: [['shopId', '==', scope.shopId]],
              orderBy: ['createdAt', 'desc'], limit: o.limit || 50 };
    if (o.productId) q.where.push(['productId', '==', String(o.productId)]);
    return q;
  }

  async function listMovements(o) {
    var rows = await o.db.queryMovements(movementsQuery(o.scope, o));
    return (rows || []).map(function (m) {
      return {
        id: m.id,
        productId: m.productId || null,
        productName: m.productName || null,
        delta: (typeof m.delta === 'number') ? m.delta : null,
        before: (typeof m.before === 'number') ? m.before : null,
        after: (typeof m.after === 'number') ? m.after : null,
        reason: m.reason || null,
        note: m.note || null,
        actorRole: m.actorRole || null,
        sellerUid: m.sellerUid || null,
        createdAt: m.createdAt || null,
      };
    });
  }

  function reasonLabel(id) {
    for (var i = 0; i < REASONS.length; i++) if (REASONS[i].id === id) return REASONS[i].label;
    return id || '—';
  }

  return {
    ADJUST_CALLABLE: ADJUST_CALLABLE,
    MOVEMENTS: MOVEMENTS,
    REASONS: REASONS,
    REASON_IDS: REASON_IDS,
    adjustmentId: adjustmentId,
    buildAdjustment: buildAdjustment,
    adjustStock: adjustStock,
    movementsQuery: movementsQuery,
    listMovements: listMovements,
    reasonLabel: reasonLabel,
  };
}));
