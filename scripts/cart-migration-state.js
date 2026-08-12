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
  'shared-header.js', 'provider-wiring.js',                    /* 2.6 rollout + interceptor removed */
];

/* ── SURVIVORS ────────────────────────────────────────────────────────────────
   Track 2.3 closed at "all writers + all unblocked readers"; 2.4 then took the checkout
   boundary. Files still touching the
   cart directly are NOT leftovers: each carries an owning phase and the architectural
   fact that blocks it. "UNMIGRATED" in a sweep report must never be readable as
   "forgotten", so the reason lives here, next to the name, and the sweep prints it.

   Every entry is {file, phase, reason} — a bare name would let the next reader assume it
   was simply missed. */

/* Emptied by 2.6. provider-wiring.js carried the global setItem interceptor that
   mirrored cart <-> sokoniCart; with the food cart and inspiq.js migrated in 2.5 the
   mirror had no consumer left, and it was removed rather than kept as a compatibility
   writer. The file still patches setItem for PROVIDER and BOOKING keys — a different
   feature, untouched, and neither watches a cart key. */
const FROZEN = [];

/* Emptied by 2.5. sokoni-food.js was the only entry: a complete parallel cart
   implementation on the same key, which moved onto SokoniCart together with the last
   product consumer of the sokoniCart mirror (inspiq.js). The bridge that maintains that
   mirror is provider-wiring.js and remains FROZEN for 2.6. */
const DEFERRED = [];

/* Blocked by a boundary this track deliberately will not cross. Both were assessed in
   2.3.7 and left alone; shared-header.js was migrated and then REVERTED when the reach
   was measured. */
/* Emptied by 2.6. shared-header.js was the last direct cart reader; it could not move
   until the service loaded on all 311 pages that carry it, which is what the rollout in
   this slice did first. */
const BLOCKED = [];

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
  /* Auth slices 1-2, a separate track running after Track 2 closed. Named here so the
     cart guards keep failing on anything they do NOT recognise, rather than being widened
     into uselessness — which is the failure mode this registry exists to prevent.
       functions/index.js   re-exports authDispatch by name (required for any new CF)
       firebase.json        gained a local `emulators` block so the Auth emulator starts;
                            hosting, functions and rules config are byte-identical */
  'functions/index.js',
  'firebase.json',
  /* Auth slice 3 — the login-path verification gate. Same reasoning as above: these are
     another track's files, named individually so the cart guards keep failing on
     anything they do NOT recognise.
       sokoni-verify-gate.js  new — the gate itself
       firebase.js            enforces the gate in onAuthStateChanged, before the
                              session flag is written
       auth.js                the login path withholds a session for an unverified
                              password account
       auth.css               .auth-msg.info — the base class is display:none and only
                              .error/.success re-enabled it, so a neutral message
                              rendered nothing at all */
  'sokoni-verify-gate.js',
  'firebase.js',
  'auth.js',
  'auth.css',
  'scripts/test-auth-verify-gate.js',
  /* The Slice 1 and Slice 2 suites each asserted "auth.js and firebase.js untouched" —
     true when written, and false by authorisation once Slice 3 landed. Both assertions
     were RETIRED and named in place rather than allowlisted, so these two files are dirty
     for the same reason this registry exists. */
  'scripts/test-auth-email-challenge.js',
  'scripts/test-auth-dispatch.js',
  /* Documentation for the same track. RELEASE_ROADMAP.md carries the rollout constraint —
     the gate must not deploy before the Slice 4 screen, or every legacy account that never
     clicked the old verification link is held at a challenge it cannot answer. */
  'docs/AUTH_EMAIL_VERIFICATION.md',
  'docs/RELEASE_ROADMAP.md',
  /* Auth slice 4 — the verification screen the gate hands off to.
       sokoni-verify-screen.js  new — the screen
       login.html               mount point + script tag. Named EXPLICITLY: it already
                                loads sokoni-cart.js, so the .html fallback in
                                unexpected() would have excused it without anyone
                                deciding to, which is not the same as being explained. */
  'sokoni-verify-screen.js',
  'login.html',
  'scripts/test-auth-verify-screen.js',
  /* Auth slice 5 — session-transition safety. The gate gained cross-tab awareness
     (storage + visibilitychange -> recheck) and firebase.js installs the watcher and
     tears the screen down on sign-out. */
  'scripts/test-auth-session-transitions.js',
  /* Auth slice 6A — the enforcement policy layer. Grandfathers existing password accounts
     (production measurement: 66 of 74 would otherwise have been locked out) and ships with
     enforcement OFF behind a sentinel cutoff. */
  'sokoni-verify-policy.js',
  'scripts/auth-policy-vectors.json',
  'scripts/test-auth-verify-policy.js',
  'scripts/measure-email-verification.js',
  /* Auth slice 6B — the server computes the same enforcement verdict. The policy is
     implemented twice because a functions deploy uploads only functions/; the two copies
     are held together by scripts/auth-policy-vectors.json plus a pairwise sweep. */
  'functions/auth-policy.js',
  'functions/auth-dispatch.js',
  'scripts/test-auth-policy-server.js',
  /* Auth slice 6C — signup enforcement. The signup path withholds the application
     session via the SAME composed verdict the login path uses; signup.html gains the
     mount + otp + screen, mirroring login.html. */
  'signup.html',
  'scripts/test-auth-signup-gate.js',
  /* Finding 1 from the auth-flow review: the login landing consumed none of the three
     states the gate created, so a held user met an ordinary login form. */
  'scripts/test-auth-verify-landing.js',
  /* Activation tooling. Neither is product code: one rehearses a candidate cutoff, the
     other sets it on both sides atomically. Neither deploys, and the sentinel stands. */
  'scripts/auth-cutoff-dry-run.js',
  'scripts/auth-activate-cutoff.js',
  'docs/AUTH_ACTIVATION_RUNBOOK.md',
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

/* The 2.6 rollout added <script src="sokoni-cart.js"> to 293 pages. Listing them by name
   in MIGRATED would be 293 lines that say nothing a reader could check, and would need
   editing every time a page is added. They are explained STRUCTURALLY instead: a dirty
   .html whose diff is only the service tag and its comment is the rollout, and anything
   else in an .html is not. */
const ROLLOUT_ONLY = /^[+-]\s*(<!-- Canonical cart access path|through SokoniCart;|<script src="sokoni-cart\.js"><\/script>|NOT deferred|so this must sit above it|still precedes sokoni-food|the pip renders before|\s*)$/;

function isRolloutOnly(file, diff) {
  if (!/\.html$/.test(file) || !diff) return false;
  const lines = diff.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  if (!lines.length) return false;
  if (!lines.some(l => /sokoni-cart\.js/.test(l))) return false;
  /* Allow the tag block, blank lines, and a line that merely got SPLIT (its content
     reappears on the other side of the diff). */
  const added = lines.filter(l => l[0] === '+').map(l => l.slice(1).trim());
  const removed = lines.filter(l => l[0] === '-').map(l => l.slice(1).trim());
  return removed.every(r => !r || added.some(a => a.indexOf(r) > -1) ||
                            r.split('><').every(part => added.some(a => a.indexOf(part) > -1)));
}

/* Anything dirty that none of the above explains. */
function unexpected(changed, diffOf) {
  return changed.filter(f => {
    if (MIGRATED.includes(f) || PRE_EXISTING.includes(f) ||
        INFRASTRUCTURE.includes(f) || TEST_HARNESS.includes(f) || isSuite(f)) return false;
    if (typeof diffOf === 'function' && isRolloutOnly(f, diffOf(f))) return false;
    /* Without a diff getter, fall back to "is it an .html that now loads the service" —
       enough for the suites that only pass a file list. */
    if (/\.html$/.test(f)) {
      try {
        const src = require('fs').readFileSync(require('path').resolve(__dirname, '..', f), 'utf8');
        if (/src="sokoni-cart\.js"/.test(src)) return false;
      } catch (e) { /* fall through */ }
    }
    return true;
  });
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
  isSuite, unexpected, isRolloutOnly,
};
