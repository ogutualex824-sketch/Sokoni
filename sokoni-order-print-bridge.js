/* ════════════════════════════════════════════════════════════════════════════
   SOKONI ORDER → RECEIPT → PRINTER BRIDGE   (Phase 1)

       orders (paid, channel:'online')  →  SokoniReceiptDoc  →  PosPrintService

   The merchant's BROWSER is the print worker, not the payment server. That is
   the whole point of the separation: a confirmed online payment stays confirmed
   whether or not a printer is switched on, connected, or even present. This file
   may fail in every way imaginable and the money is unaffected.

   ── WHAT THIS FILE MUST NEVER DO ─────────────────────────────────────────────
   Write to `orders`. Write to any payment collection. Call a payment endpoint.
   Touch Daraja, payment destinations or productionAuthorized. Claim a receipt
   was printed when it was queued. It is a READER of order state and a WRITER of
   print jobs — nothing else.

   ── WHY channel === 'online' AND NOT "it's in the orders collection" ─────────
   Today every document in `orders` is an online order; POS till sales live in
   `posRetailSales`. Building on that coincidence would mean the day another
   order type lands in `orders`, this component silently starts printing it. The
   discriminator is written server-side by _finalizeMarketplacePayment under the
   Admin SDK, so it cannot be forged by a client either.

   ── DUPLICATE SUPPRESSION ────────────────────────────────────────────────────
   onSnapshot re-delivers a document on EVERY change — a status edit hours later
   re-delivers a paid order. PosPrintService.enqueue() is idempotent on
   receiptId, which stops a duplicate reaching the printer, but this bridge also
   keeps its own persisted marker so it does not even attempt one. Both layers
   are keyed on the STABLE order id, never on a timestamp or a random job id.
   ════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var MARK_KEY = 'sokoni_order_print_seen';   /* order ids already handled here */
  var MARK_CAP = 500;                          /* keep the marker bounded */

  /* ── Printed-marker store ────────────────────────────────────────────────
     Deliberately per-device. Two merchant devices watching the same shop will
     EACH print once, which is the behaviour a shop with a counter printer and a
     back-office printer actually wants. A server-side "printed" flag would make
     that impossible and would also mean this reader had to write to orders. */
  function _seen() {
    try { return JSON.parse(global.localStorage.getItem(MARK_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function _markSeen(id) {
    try {
      var a = _seen();
      if (a.indexOf(id) > -1) return;
      a.push(id);
      global.localStorage.setItem(MARK_KEY, JSON.stringify(a.slice(-MARK_CAP)));
    } catch (_) { /* storage full or blocked — the queue's own dedupe still holds */ }
  }
  function _alreadyPrinted(id) { return _seen().indexOf(id) > -1; }

  /* ── Eligibility ─────────────────────────────────────────────────────────
     Every condition is a REQUIREMENT, not a preference. An order missing any of
     them is not printed and not marked, so it can still print later if it
     becomes eligible (e.g. payment confirms after a delay). */
  function isPrintable(order) {
    if (!order || !order.id) return false;
    if (order.channel !== 'online') return false;        /* server-authored */
    if (order.paymentVerified !== true) return false;    /* money confirmed */
    return true;
  }

  /* ── autoPrint preference ────────────────────────────────────────────────
     Reads the EXISTING POS setting rather than inventing a second one that
     could drift out of step with the POS toggle. Fails CLOSED: if the setting
     cannot be read, nothing prints. An automation that starts printing because
     it could not find its own configuration is worse than one that stays quiet. */
  function autoPrintEnabled() {
    try {
      if (global.PosDB && global.PosDB.settings && typeof global.PosDB.settings.getAll === 'function') {
        return Promise.resolve(global.PosDB.settings.getAll())
          .then(function (s) { return !!(s && (s.autoPrint === true || s.autoPrint === 'true')); })
          .catch(function () { return false; });
      }
    } catch (_) {}
    return Promise.resolve(false);
  }

  /* ── Order → SokoniReceiptDoc ────────────────────────────────────────────
     Values are COPIED from the order, never recomputed. The order is the
     authority for what was sold and what was paid; a receipt that arrived at
     its own totals could disagree with the money that actually moved. */
  function toReceiptDoc(order, shop) {
    var doc = {
      /* Stable identity, end to end: the order id IS the receipt id and the
         print job id. Nothing here may use Date.now() or a random value. */
      id:          order.id,
      receiptId:   order.id,
      ref:         order.paymentRef || order.mpesaCode || order.id,
      orderNumber: order.orderNumber || order.id,
      createdAt:   order.paidAt || order.createdAt || null,

      shop:     shop || { name: order.sellerName || '' },
      customer: {
        name:  order.buyerName  || '',
        phone: order.buyerPhone || '',
      },
      items:  Array.isArray(order.items) ? order.items : [],
      totals: order.totals || {
        grandTotalMinor: _minor(order.total != null ? order.total : order.amount),
      },
      payment: {
        method: order.paymentMethod || 'MPESA',
      },
      paymentRef: order.mpesaCode || order.paymentRef || null,
    };

    /* Conditional fulfilment block — pickup vs delivery vs neither. Built through
       SokoniFulfilment so the receipt renders the SAME block the rest of the
       platform does. Absent module or unusable data ⇒ no block, never a
       half-rendered one. */
    try {
      var F = global.SokoniFulfilment;
      if (F && typeof F.buildFulfilment === 'function') {
        if (order.fulfilment) {
          doc.fulfilment = order.fulfilment;
        } else if (order.deliveryAddress || order.address) {
          doc.fulfilment = F.buildFulfilment({
            type: 'delivery',
            destinationSnapshot: { label: order.deliveryAddress || order.address },
            assignment: order.assignment || undefined,
          });
        } else if (order.fulfillmentType === 'pickup') {
          doc.fulfilment = F.buildFulfilment({ type: 'pickup' });
        }
      }
    } catch (_) { /* a receipt without the block still prints; a throw would lose it entirely */ }

    if (order.settlement) doc.settlement = order.settlement;
    return doc;
  }

  function _minor(v) {
    var n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }

  /* ── Print one order ─────────────────────────────────────────────────────
     FIRE AND FORGET. The returned promise is for tests and telemetry; no caller
     may branch order state on it. An offline printer resolves into
     PosPrintService's existing localStorage queue and drains on reconnect. */
  function printOrder(order, shop) {
    if (!isPrintable(order)) return Promise.resolve({ printed: false, reason: 'not_eligible' });
    if (_alreadyPrinted(order.id)) return Promise.resolve({ printed: false, reason: 'already_printed' });

    var svc = global.PosPrintService;
    if (!svc || typeof svc.printReceipt !== 'function') {
      return Promise.resolve({ printed: false, reason: 'no_print_service' });
    }

    /* Marked BEFORE dispatch, on purpose. A print that fails is handled by the
       service's queue and retry; re-marking on failure would let a flapping
       printer produce a stack of duplicate receipts. */
    _markSeen(order.id);

    var doc;
    try { doc = toReceiptDoc(order, shop); }
    catch (e) { return Promise.resolve({ printed: false, reason: 'render_failed', error: String(e && e.message) }); }

    return Promise.resolve()
      .then(function () { return svc.printReceipt(doc, { receiptId: order.id, source: 'online_order' }); })
      .then(function (r) { return { printed: true, receiptId: order.id, result: r }; })
      .catch(function (e) {
        /* Swallowed deliberately. The order is paid; a print failure is a
           printing problem and must never surface as a payment problem. */
        return { printed: false, reason: 'print_failed', receiptId: order.id, error: String(e && e.message) };
      });
  }

  /* ── Start watching ──────────────────────────────────────────────────────
     Returns the listener's unsubscribe so a host page can stop cleanly. */
  function start(opts) {
    opts = opts || {};
    var sellerUid = opts.sellerUid;
    var shop      = opts.shop || null;
    var Orders    = global.SokoniOrders;

    if (!sellerUid || !Orders || typeof Orders.listenSellerOrders !== 'function') {
      return function () {};
    }

    return Orders.listenSellerOrders(sellerUid, function (orders) {
      if (!Array.isArray(orders) || !orders.length) return;
      var candidates = orders.filter(function (o) {
        return isPrintable(o) && !_alreadyPrinted(o.id);
      });
      if (!candidates.length) return;

      autoPrintEnabled().then(function (on) {
        /* Checked at PRINT time, not at start(), so toggling the setting takes
           effect without reloading the page. */
        if (!on) return;
        candidates.forEach(function (o) { printOrder(o, shop); });
      });
    });
  }

  global.SokoniOrderPrintBridge = {
    start: start,
    printOrder: printOrder,
    isPrintable: isPrintable,
    toReceiptDoc: toReceiptDoc,
    autoPrintEnabled: autoPrintEnabled,
    _seen: _seen, _markSeen: _markSeen, _alreadyPrinted: _alreadyPrinted,
    MARK_KEY: MARK_KEY,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniOrderPrintBridge;
}
