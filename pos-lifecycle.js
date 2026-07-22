/* SOKONI POS lifecycle contract.
 *
 * Answers one question for the service worker: may this page be reloaded right
 * now? Load it on any page that holds work a reload would destroy.
 *
 * WHY IT EXISTS
 * sw-register.js reloads the page on `controllerchange` so a new service worker
 * takes effect. That is right for a content page and wrong for a till: a reload
 * mid-sale discards the cart and the cashier starts again in front of a
 * customer. It is the reported "Flight Mode toggle restarts the POS".
 *
 * The service worker must not know what a sale is, so the page answers instead.
 * canReload() defaults to true everywhere it is absent — no page has to opt in
 * to keep working, and the guard costs nothing where it does not apply.
 *
 * A page that vetoes OWNS the reload. If it never calls applyPendingReload(),
 * the update never lands. That is the deliberate trade: a stale POS is
 * recoverable, a lost sale is not.
 */
(function () {
  'use strict';

  function hasOpenSale() {
    try {
      /* state.cartItems is what the POS actually holds a sale in (pos.js:18).
         Read defensively — this file must never throw inside a lifecycle
         handler, or a broken predicate becomes a broken update mechanism. */
      const items = (window.state && window.state.cartItems) ||
                    (window.SPos && window.SPos.state && window.SPos.state.cartItems);
      return Array.isArray(items) && items.length > 0;
    } catch (_) { return false; }
  }

  const AppLifecycle = {
    /* False vetoes the reload. Anything other than an explicit false allows it,
       so an error or an unexpected value fails toward keeping the platform
       updatable rather than toward a POS that can never receive a fix. */
    canReload() {
      return !hasOpenSale();
    },

    hasOpenSale,

    /* Called when the sale completes or the cart is cleared. Applies an update
       that was deferred, so the POS picks up the new version at the first safe
       moment instead of waiting for the next cold start. */
    applyPendingReload(reason) {
      if (!window.__sokoniReloadPending) return false;
      if (hasOpenSale()) return false;
      console.info('[POS lifecycle] applying deferred reload' + (reason ? ' — ' + reason : ''));
      window.__sokoniReloadPending = false;
      window.location.reload();
      return true;
    },

    isReloadPending() { return !!window.__sokoniReloadPending; },
  };

  window.AppLifecycle = AppLifecycle;

  /* A deferred update should not wait for the cashier to notice. Re-check when
     the cart empties — the natural end of a sale — and on the transitions that
     already mean the till is idle. */
  window.addEventListener('sokoni:sale-complete', () => AppLifecycle.applyPendingReload('sale complete'));
  window.addEventListener('sokoni:cart-cleared',  () => AppLifecycle.applyPendingReload('cart cleared'));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') AppLifecycle.applyPendingReload('returned to foreground');
  });

  /* Tell the operator rather than leaving them on a version that quietly is not
     the current one. A banner is honest; silently deferring forever is not. */
  window.addEventListener('sokoni:reload-deferred', () => {
    try {
      if (document.getElementById('sokoni-update-pending')) return;
      const el = document.createElement('div');
      el.id = 'sokoni-update-pending';
      el.textContent = 'Update ready — will apply when this sale is finished';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
        'background:#71ff00;color:#050505;font:600 13px/1.4 system-ui,sans-serif;' +
        'padding:10px 14px;text-align:center';
      document.body.appendChild(el);
    } catch (_) {}
  });

  console.log('[POS lifecycle] reload contract armed — a sale in progress defers updates');
})();
