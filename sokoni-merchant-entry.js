/* ============================================================================
   sokoni-merchant-entry.js — ONE answer to "where does this person go to sell?"

   THE DEFECT THIS REPLACES
   Every "Start Selling" CTA in the platform was an unconditional anchor to
   seller.html / onboarding-seller.html. Measured across the repo: ZERO of them
   consulted approval, shop existence, or any guard. An already-approved merchant
   pressing Start Selling therefore landed on seller.js's "Ready to Start Selling?
   Become a seller on SOKONI" prompt — the circular approved -> apply-again loop.

   THREE CONCEPTS, DELIBERATELY NOT COLLAPSED
     ENTITLEMENT  may I sell?          RA.isApproved('seller')   — the AUTHORITY
     DESTINATION  where do I land?     canonical shop resolution — ROUTING only
     ACTING ROLE  what am I now?       RA.getActiveRole()        — presentation only

   Shop existence is a ROUTING question. It is never an entitlement test: an approved
   seller with no shop is still an approved seller and must reach shop setup, not the
   application form. Symmetrically, activeRole never decides entitlement — an account
   whose mirror claims activeRole:'seller' without the claim gets the intake.

   CANONICAL SHOP RESOLUTION — census-derived, not guessed
   Production census (2026-08-17): the single shop has
       docId === uid === sellerUid === users/{uid}.activeShopId, status 'active'
   so all four candidate relations are indistinguishable at n=1. We therefore follow
   the stated canonical chain first and fall back to the identity form:

       users/{uid}.activeShopId  ->  shops/{activeShopId}      (canonical)
       shops/{uid}                                              (fallback)

   sellers/{uid} is NEVER consulted. It is applicant-written — the applicant sets
   status:'active' themselves — so reading it here would let anyone manufacture
   seller authority by writing their own document.

   SHOP EMPLOYEES — a real model, deliberately not built on
   shopEmployees exists (firestore.rules:1416; read by analytics-engine,
   finance-os-sprint43, logistics-plus, marketplace-extensions, pos-completeness)
   but holds ZERO production records, so no behaviour here could be verified against
   it. Entitlement is read from the CLAIM only, which is already the right primitive
   for a staff member: if a shop employee holds a merchant entitlement, isApproved()
   returns true and they enter the workspace without seller onboarding. Wiring
   shopEmployees into destination resolution is left for when records exist and the
   behaviour can be proven. Documented, not silently assumed.

   ADMIN / SUPERADMIN — current limitation, stated plainly
   Admin is NOT a SokoniRoleAuthority role and is not handled here. RA's own header
   explains why: duplicating it "would create a second path to the same privilege".
   Admin switching and admin routing remain governed by sokoni-permissions.js
   (GUARDED_ROUTES -> admin.html). This module does not pretend otherwise.
   ========================================================================== */
(function (window) {
  'use strict';

  var SELLER = 'seller';

  /* Existing destinations only — every one of these is already in use elsewhere in
     the platform (profile.html ROLES[].hub and the Business Hub module links). No
     new URL is introduced by this module. */
  /* THE cutover constant. One place decides which merchant shell an approved seller
     enters from a Start Selling CTA, so the destination can never be scattered across
     call sites and drift.

     '/merchant-v2' — the v2 shell, DEPLOYED and certified 18/0 against production Auth,
     App Check, shop resolution, Orders and sellerPayments ownership, the 12-route walk
     and refresh persistence. Only that certification justifies pointing a live CTA here.

     SCOPE, deliberately narrow: this governs the Start Selling family
     (data-sk-merchant-entry) and nothing else. My Store, Business and the workspace
     cutover do NOT resolve through this module — measured: no file outside this one
     references SokoniMerchantEntry — so they remain on /merchant under their own gate.

     Clean routes, not '.html'. firebase.json sets cleanUrls:true, so 'merchant-v2.html'
     301-redirects; a CTA must reach the shell in ONE navigation, not a redirect chain. */
  var MERCHANT_URL = '/merchant-v2';
  var ONBOARD_URL  = '/offer';        /* not approved — seller intake             */
  var SIGNIN_URL   = '/login';

  /* All three are NAMED constants rather than literals inside DEST, so a gate can read
     the destination the module will actually use instead of restating it — a restated
     copy keeps passing after someone flips the real one. scripts/test-auth-post-login-
     routing.js reads exactly these three and refuses to run if they are absent. */
  var DEST = {
    workspace: MERCHANT_URL,           /* has a shop  — the merchant shell        */
    setup:     MERCHANT_URL + '#shop', /* no shop yet — shop setup INSIDE the shell,
                                          which is what keeps an approved seller out
                                          of the application flow                  */
    intake:    ONBOARD_URL,
    signedOut: SIGNIN_URL,
  };

  function _auth() { try { return window.firebaseAuth || null; } catch (_) { return null; } }
  function _uid() { var a = _auth(); return (a && a.currentUser && a.currentUser.uid) || null; }

  /* Entitlement — the claim, and nothing else. Returns false when the authority is
     absent or unverified: "cannot tell" must never read as "yes" on a path that
     decides whether someone skips an application. */
  async function isEntitled() {
    try {
      var RA = window.SokoniRoleAuthority;
      if (!RA) return false;
      if (typeof RA.ready === 'function') await RA.ready();
      return typeof RA.isApproved === 'function' ? !!RA.isApproved(SELLER) : false;
    } catch (_) { return false; }
  }

  /* Canonical shop for the signed-in user, or null. Read-only. */
  async function resolveShop(uid) {
    if (!uid || !window.firebaseDB) return null;
    try {
      var m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      var db = window.firebaseDB;

      /* 1 — the canonical chain: users/{uid}.activeShopId -> shops/{activeShopId} */
      var userSnap = await m.getDoc(m.doc(db, 'users', String(uid)));
      var activeShopId = userSnap && userSnap.exists() ? (userSnap.data() || {}).activeShopId : null;
      if (activeShopId) {
        var byActive = await m.getDoc(m.doc(db, 'shops', String(activeShopId)));
        if (byActive && byActive.exists()) return { id: byActive.id, via: 'activeShopId' };
      }

      /* 2 — fallback: shops/{uid}. Present for the one production merchant, where
             docId === uid === sellerUid, so this agrees with the chain above. */
      var byUid = await m.getDoc(m.doc(db, 'shops', String(uid)));
      if (byUid && byUid.exists()) return { id: byUid.id, via: 'shops/{uid}' };

      return null;
    } catch (_) {
      /* A read failure is NOT "no shop". Reported as unknown so the caller sends an
         approved seller to setup rather than to the application form — the worse of
         the two wrong answers is telling a merchant to re-apply. */
      return { id: null, via: 'unreadable', unknown: true };
    }
  }

  /* THE resolver. Returns {state, destination, shopId, via}. */
  async function resolve() {
    var uid = _uid();
    if (!uid) return { state: 'signed-out', destination: DEST.signedOut };

    if (!(await isEntitled())) {
      return { state: 'not-approved', destination: DEST.intake };
    }

    var shop = await resolveShop(uid);
    if (shop && shop.id) {
      return { state: 'approved-with-shop', destination: DEST.workspace, shopId: shop.id, via: shop.via };
    }
    return {
      state: shop && shop.unknown ? 'approved-shop-unknown' : 'approved-no-shop',
      destination: DEST.setup,
      via: shop ? shop.via : 'none',
    };
  }

  async function go() {
    var r = await resolve();
    try { window.location.href = r.destination; } catch (_) {}
    return r;
  }

  /* Convergence point for the existing CTAs. Any element carrying
     data-sk-merchant-entry routes through resolve() instead of its static href, so
     the seven scattered Start Selling links cannot drift apart again. The href is
     kept in the markup as the no-JS fallback. */
  function wire() {
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-sk-merchant-entry]') : null;
      if (!el) return;
      e.preventDefault();
      go();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.SokoniMerchantEntry = {
    resolve: resolve,
    go: go,
    isEntitled: isEntitled,
    resolveShop: resolveShop,
    DESTINATIONS: DEST,
  };
}(window));
