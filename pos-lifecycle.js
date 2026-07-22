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

  /* ── State adapter ───────────────────────────────────────────────────────
     The ONLY place this file touches application internals. The policy asks
     "how many items are in the cart"; the adapter answers. If the POS changes
     how it stores a sale, this function changes and the policy does not.

     The first version read window.state and window.SPos and would never have
     worked. pos.js declares `const SPos = (function(){ ... })()` at the top
     level of a classic script, and a top-level const goes into the global
     LEXICAL scope — it is resolvable by name from another classic script, but
     it is not a property of window. Both lookups returned undefined, so
     hasOpenSale() would have answered false forever, canReload() would have
     answered true forever, and the guard would have shipped doing nothing —
     while looking exactly like a guard that was never needed.

     That SPos resolves by bare name is not an assumption: pos.html has worked
     for months with inline handlers like onclick="SPos.cart.addItem(...)",
     which resolve identifiers through the same global scope chain. */
  function cartItemCount() {
    try {
      /* Bare identifier, guarded by typeof so it cannot throw where SPos is
         absent — every page that is not the POS. */
      if (typeof SPos !== 'undefined' && SPos && SPos.state &&
          Array.isArray(SPos.state.cartItems)) {
        return SPos.state.cartItems.length;
      }
    } catch (_) { /* fall through */ }

    try {
      /* Other surfaces may expose a cart on window. Checked second so the POS
         never depends on it. */
      if (window.state && Array.isArray(window.state.cartItems)) {
        return window.state.cartItems.length;
      }
    } catch (_) { /* fall through */ }

    /* Unknown is not the same as empty, but it must behave as empty here: a
       page whose cart we cannot read must remain updatable, or an unrelated
       surface could block every future release. */
    return 0;
  }

  function hasOpenSale() {
    return cartItemCount() > 0;
  }

  /* ── Decision record ─────────────────────────────────────────────────────
     Every evaluation is logged with its inputs, not just its outcome. Without
     this, "it reloaded while I was serving a customer" and "it never updated"
     are both unanswerable — you can see that a reload happened or did not, but
     never why the contract decided it.

     Persisted alongside the crash breadcrumbs so it survives the reload it is
     describing. A ring buffer, because the useful window is the last few
     decisions and an unbounded log in localStorage eventually fails to write. */
  const DECISIONS_KEY = 'sokoni_lifecycle_decisions';
  const MAX_DECISIONS = 20;

  function record(reason, decision, extra) {
    const entry = Object.assign({
      reason,
      decision,
      cartItems: cartItemCount(),
      reloadPending: !!window.__sokoniReloadPending,
      at: new Date().toISOString(),
    }, extra || {});

    console.info('[AppLifecycle] ' + decision + ' — ' + reason +
                 ' (cartItems: ' + entry.cartItems + ')');
    try {
      const log = JSON.parse(localStorage.getItem(DECISIONS_KEY) || '[]');
      log.push(entry);
      while (log.length > MAX_DECISIONS) log.shift();
      localStorage.setItem(DECISIONS_KEY, JSON.stringify(log));
    } catch (_) { /* private mode — the console line is still emitted */ }
    return entry;
  }

  const AppLifecycle = {
    /* False vetoes the reload. Anything other than an explicit false allows it,
       so an error or an unexpected value fails toward keeping the platform
       updatable rather than toward a POS that can never receive a fix. */
    canReload(reason) {
      const open = hasOpenSale();
      record(reason || 'controllerchange', open ? 'DEFER' : 'ALLOW');
      return !open;
    },

    /** Recent decisions, newest last. The answer to "why did it do that?" */
    decisions() {
      try { return JSON.parse(localStorage.getItem(DECISIONS_KEY) || '[]'); }
      catch (_) { return []; }
    },

    hasOpenSale,
    cartItemCount,

    /* Called when the sale completes or the cart is cleared. Applies an update
       that was deferred, so the POS picks up the new version at the first safe
       moment instead of waiting for the next cold start. */
    applyPendingReload(reason) {
      if (!window.__sokoniReloadPending) return false;
      if (hasOpenSale()) return false;
      record(reason || 'deferred-apply', 'APPLIED');
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
