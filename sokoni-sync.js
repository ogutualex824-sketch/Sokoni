/* ════════════════════════════════════════════════════════════════════════
   SOKONI Sync — the merchant/seller change-propagation facade.

   This is NOT a new bus. It is a thin, named facade over the existing
   window.SokoniEventBus (sokoni-event-bus.js), which already provides
   on/emit/once, wildcard patterns, and same-origin cross-tab/iframe delivery
   via BroadcastChannel. SokoniSync just adds the merchant domain vocabulary the
   modules speak — Product / Stock / Availability / Shop / Order / Payment /
   Refund / Customer changed — so one change propagates everywhere instead of
   each page manually telling every other page to refresh.

     change → SokoniSync.emit(...) → SokoniEventBus (BroadcastChannel)
            → every subscribed module (POS, Shop, Orders, Inventory, Analytics, Dashboard)

   Usage:
     SokoniSync.productChanged({ id, ... });         // emit
     SokoniSync.on('ProductChanged', fn);            // subscribe (returns unsubscribe)
     SokoniSync.onAny(fn);                            // subscribe to all sync events
   ════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* The canonical merchant sync vocabulary. Values are the on-bus event names. */
  var EVENTS = {
    ProductChanged:      'Product.Changed',
    StockChanged:        'Stock.Changed',
    AvailabilityChanged: 'Availability.Changed',
    ShopChanged:         'Shop.Changed',
    OrderChanged:        'Order.Changed',
    PaymentChanged:      'Payment.Changed',
    RefundChanged:       'Refund.Changed',
    CustomerChanged:     'Customer.Changed'
  };
  var NAME_BY_BUS = {};
  Object.keys(EVENTS).forEach(function (k) { NAME_BY_BUS[EVENTS[k]] = k; });

  function _bus () { return root.SokoniEventBus || null; }

  /* Emit a sync event. Broadcasts across same-origin tabs/iframes so every module
     hears it. Falls back to a window CustomEvent if the bus isn't present yet. */
  function emit (name, payload, opts) {
    var busName = EVENTS[name] || name;
    payload = payload || {};
    opts = opts || {};
    var bus = _bus();
    if (bus && typeof bus.emit === 'function') {
      /* Bus present → it owns delivery (local handlers + same-origin cross-iframe/tab via
         BroadcastChannel). Do NOT also dispatch the DOM mirror, or handlers fire twice. */
      try { bus.emit(busName, payload, { source: opts.source || 'sokoni-sync', broadcast: opts.broadcast !== false }); } catch (_) {}
      return true;
    }
    /* Bus absent → DOM CustomEvent fallback so same-document subscribers still fire. */
    try { root.dispatchEvent(new CustomEvent('sokoni:sync', { detail: { event: NAME_BY_BUS[busName] || name, payload: payload } })); } catch (_) {}
    return true;
  }

  /* Subscribe to one sync event by facade name (e.g. 'ProductChanged'). Returns an
     unsubscribe function. Handler receives the payload object. Bus and DOM-fallback are
     mutually exclusive so a handler is never invoked twice for one emit. */
  function on (name, handler) {
    var busName = EVENTS[name] || name;
    var bus = _bus();
    if (bus && typeof bus.on === 'function') {
      return bus.on(busName, function (evt) { try { handler(evt.payload, evt); } catch (_) {} });
    }
    var domFn = function (e) { if (e.detail && (e.detail.event === name || EVENTS[e.detail.event] === busName)) { try { handler(e.detail.payload, e.detail); } catch (_) {} } };
    root.addEventListener('sokoni:sync', domFn);
    return function unsubscribe () { root.removeEventListener('sokoni:sync', domFn); };
  }

  /* Subscribe to EVERY sync event. Handler receives (facadeName, payload). */
  function onAny (handler) {
    var offs = Object.keys(EVENTS).map(function (name) {
      return on(name, function (payload, evt) { try { handler(name, payload, evt); } catch (_) {} });
    });
    return function unsubscribe () { offs.forEach(function (f) { try { f(); } catch (_) {} }); };
  }

  var SokoniSync = {
    EVENTS: EVENTS,
    emit: emit,
    on: on,
    onAny: onAny,
    /* Named convenience emitters — one canonical call per domain change. */
    productChanged:      function (p, o) { return emit('ProductChanged', p, o); },
    stockChanged:        function (p, o) { return emit('StockChanged', p, o); },
    availabilityChanged: function (p, o) { return emit('AvailabilityChanged', p, o); },
    shopChanged:         function (p, o) { return emit('ShopChanged', p, o); },
    orderChanged:        function (p, o) { return emit('OrderChanged', p, o); },
    paymentChanged:      function (p, o) { return emit('PaymentChanged', p, o); },
    refundChanged:       function (p, o) { return emit('RefundChanged', p, o); },
    customerChanged:     function (p, o) { return emit('CustomerChanged', p, o); }
  };

  root.SokoniSync = SokoniSync;
})(typeof window !== 'undefined' ? window : this);
