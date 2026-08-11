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
];

/* Must not change until their own slice. checkout.html is 2.4; provider-wiring.js carries
   the global setItem interceptor and is 2.6. */
const FROZEN = ['checkout.html', 'provider-wiring.js'];

/* Not yet migrated — asserted untouched so a slice cannot quietly reach ahead of itself.
   Move an entry from here to MIGRATED when its slice lands. */
const PENDING = [
  'script.js', 'cart.js', 'shared-header.js',
  'flashsale.html', 'business.html', 'ministore.html', 'wishlist.html',
  'food.html', 'profile.js', 'seller-wiring.js',
];

/* Dirty in the working tree for reasons that predate Track 2 — other tracks and build
   artifacts. Named so "unexpected" means unexpected. */
const PRE_EXISTING = [
  'availability-manager.html',          /* Track 1 — availability schedule projection */
  'cart.html',                          /* Track 4 — min-width:0 overflow fix */
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

const isSuite = (f) => /^scripts\/(test-cart-|cart-migration-state)/.test(f);

/* Anything dirty that none of the above explains. */
function unexpected(changed) {
  return changed.filter(f =>
    !MIGRATED.includes(f) && !PRE_EXISTING.includes(f) &&
    !INFRASTRUCTURE.includes(f) && !TEST_HARNESS.includes(f) && !isSuite(f));
}

module.exports = { MIGRATED, FROZEN, PENDING, PRE_EXISTING, INFRASTRUCTURE,
                   TEST_HARNESS, isSuite, unexpected };
