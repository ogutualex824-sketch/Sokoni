/* Track 2 — the single declaration of where the cart migration has got to.
 *
 * Every cart suite asserts its blast radius against THIS file instead of carrying its own
 * allowlist. The reason is a failure mode already hit twice in this track: each slice
 * legitimately changes files the previous slice's suite asserted were untouched, the
 * assertion fails for a correct reason, and the tempting fix is to widen that suite's
 * list. Do that a few times and the guard passes because it has been taught to.
 *
 * So the state moves in one place, deliberately, as part of the slice that changes it —
 * and every suite sees the same truth.
 */
'use strict';

/* Surfaces migrated onto SokoniCart, newest last. Add a file here in the SAME commit that
   migrates it; a file here that is not actually migrated will be caught by that surface's
   own "no legacy persistence" assertion. */
const MIGRATED = [
  'market-actions.js',                                        /* 2.2B */
  'car-hub.html', 'category.html', 'healthcare.html', 'index.html', 'services.html',
  'product.js', 'product.html',                               /* 2.3 surface 1 */
  'category.js',                                              /* 2.3 surface 2 */
  'script.js',                                                /* 2.3 surface 3 */
  'flashsale.html', 'business.html', 'ministore.html',          /* 2.3 surface 4 */
  'wishlist.html',                                            /* 2.3 surface 5 */
  'cart.js',                                                  /* 2.3 surface 6 */
  'cart.html', 'food.html', 'profile.js',                     /* 2.3 surface 7 readers */
  'checkout.html', 'seller-wiring.js',                        /* 2.4 checkout boundary */
  'sokoni-food.js', 'inspiq.js', 'inspiq.html',               /* 2.5 food cart + sokoniCart */
  'food-menu.html', 'food-order.html', 'food-dashboard.html', 'food-rider.html',
];

/* ── SURVIVORS ────────────────────────────────────────────────────────────────
   Track 2.3 closed at "all writers + all unblocked readers"; 2.4 then took the checkout
   boundary. Files still touching the
   cart directly are NOT leftovers: each carries an owning phase and the architectural
   fact that blocks it. "UNMIGRATED" in a sweep report must never be readable as
   "forgotten", so the reason lives here, next to the name, and the sweep prints it.

   Every entry is {file, phase, reason} — a bare name would let the next reader assume it
   was simply missed. */

const FROZEN = [
  { file: 'provider-wiring.js', phase: '2.6',
    reason: 'Carries the global localStorage.setItem interceptor that mirrors cart <-> ' +
            'sokoniCart, injected by security.js on ~288 pages. Removing it requires ' +
            'every legitimate dependency to be gone first.' },
];

/* Emptied by 2.5. sokoni-food.js was the only entry: a complete parallel cart
   implementation on the same key, which moved onto SokoniCart together with the last
   product consumer of the sokoniCart mirror (inspiq.js). The bridge that maintains that
   mirror is provider-wiring.js and remains FROZEN for 2.6. */
const DEFERRED = [];

/* Blocked by a boundary this track deliberately will not cross. Both were assessed in
   2.3.7 and left alone; shared-header.js was migrated and then REVERTED when the reach
   was measured. */
const BLOCKED = [
  { file: 'shared-header.js', phase: '2.6',
    reason: 'Renders on 311 pages, of which 12 load sokoni-cart.js. Migrating it turns ' +
            'the cart pip from a number into hidden on 299 pages. This is a platform-wide ' +
            'dependency rollout, not a reader migration — and it shares its precondition ' +
            'with removing the interceptor.' },
];

/* Name-only views, for the assertions that just need a list. */
const FROZEN_FILES   = FROZEN.map(e => e.file);
const DEFERRED_FILES = DEFERRED.map(e => e.file);
const BLOCKED_FILES  = BLOCKED.map(e => e.file);

/* Every file still permitted to touch the cart directly, with its owner. */
function survivorFor(file) {
  return FROZEN.find(e => e.file === file) || DEFERRED.find(e => e.file === file) ||
         BLOCKED.find(e => e.file === file) || null;
}

/* Dirty in the working tree for reasons that predate Track 2 — other tracks and build
   artifacts. Named so "unexpected" means unexpected. */
const PRE_EXISTING = [
  'availability-manager.html',          /* Track 1 — availability schedule projection */
  'version.json',                       /* predeploy artifacts, not authored by this work */
  'docs/release-gates/unknown.json',
];

/* The service, its docs and the suites themselves. */
const INFRASTRUCTURE = [
  'sokoni-cart.js',
  'CHANGELOG.md',
  'docs/CART_PERSISTENCE_AUDIT.md',
];

/* Test fixtures that write localStorage['cart'] ON PURPOSE and stay that way.
   rc-02-buyer.js seeds a cart to exercise the buyer flow end to end; routing it through
   SokoniCart would make it test the service instead of the integration, and would mask
   exactly the behaviour it exists to catch. Classified explicitly so the final legacy
   sweep reports it as a decision rather than an unexplained survivor. */
const TEST_HARNESS = [
  'tests/rc/suites/rc-02-buyer.js',
];

/* The cart tooling itself: suites, this registry, and the scanner. Named as one set so
   that changing the guard infrastructure is never mistaken for changing a product surface
   — the scanner was omitted here and every suite flagged it as an unexplained dirty file
   the moment 2.3.8 touched it. */
const isSuite = (f) => /^scripts\/(test-cart-|cart-migration-state|scan-cart-writers)/.test(f);

/* Anything dirty that none of the above explains. */
function unexpected(changed) {
  return changed.filter(f =>
    !MIGRATED.includes(f) && !PRE_EXISTING.includes(f) &&
    !INFRASTRUCTURE.includes(f) && !TEST_HARNESS.includes(f) && !isSuite(f));
}

module.exports = {
  MIGRATED, PRE_EXISTING, INFRASTRUCTURE, TEST_HARNESS,
  /* Structured, with phase + reason */
  FROZEN, DEFERRED, BLOCKED, survivorFor,
  /* Name-only views */
  FROZEN_FILES, DEFERRED_FILES, BLOCKED_FILES,
  /* PENDING is retained as an alias for BLOCKED_FILES: the suites written during 2.3
     assert against "surfaces not migrated yet", and at close of 2.3 that set is exactly
     the two blocked readers. Kept so those assertions keep meaning what they meant. */
  PENDING: BLOCKED_FILES,
  isSuite, unexpected,
};
