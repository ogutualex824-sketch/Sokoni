/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — SELLER APPLICATION (E2 stage 1: intake only)

   The buyer-facing half of the seller approval gate. It submits a REQUEST and
   reports its state. It grants nothing, and it must never be mistaken for the
   thing that does.

   ── The separation this file exists to protect ──────────────────────────────
       `applications` is the REQUEST.  The `seller` claim is the AUTHORITY.

   Four things that are NOT seller authority, all of them observed in live data:

     • an application document            — 3 accounts hold one with no role and
                                            no claim
     • `sellers/{uid}.status === 'active'`— the applicant writes that document
                                            themselves; rules permit it BY DESIGN
                                            because it IS the application
     • `roles[]` containing 'seller'      — historical, and not what the rules or
                                            the server read
     • a stray `seller: true` claim       — one test account holds one with no
                                            application behind it

   So `state()` reads the CLAIM through SokoniRoleAuthority, which owns claim
   verification, and reads `applications` only to describe progress. It never
   infers approval from a document's existence.

   ── What this module deliberately does NOT do ───────────────────────────────
   No claim writes, no role writes, no product access, no UI gating decisions
   that anything server-side depends on. The enforcement boundary is the server;
   this is the front door and the status board.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var FS = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  var ROLE = 'seller';

  /* An application in one of these states is still in play, so a second one must
     not be filed. `info_requested` counts: the reviewer asked for something and
     is waiting — a duplicate would orphan that thread. */
  var ACTIVE = ['pending', 'info_requested', 'in_review', 'submitted'];

  function _norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  function _db() {
    if (!global.firebaseDB) throw new Error('firebase-not-ready');
    return global.firebaseDB;
  }
  function _uid() {
    var u = global.firebaseAuth && global.firebaseAuth.currentUser;
    return u ? u.uid : null;
  }

  /* Every seller application this account has filed, newest first. Bounded to
     `uid ==` so the query satisfies the owner rule; the role filter is applied
     client-side deliberately, to avoid requiring a composite index for a list
     that is only ever a handful of rows. */
  async function _myApplications() {
    var uid = _uid();
    if (!uid) return [];
    var m = await import(FS);
    var snap = await m.getDocs(m.query(
      m.collection(_db(), 'applications'),
      m.where('uid', '==', uid)
    ));
    var rows = [];
    snap.forEach(function (d) {
      var x = d.data() || {};
      var requested = _norm(x.requestedRole);
      /* `merchant`/`vendor`/`shop` normalise to seller server-side (role-vocabulary),
         so a request filed under an alias is still this account's seller request. */
      if (requested === ROLE || requested === 'merchant' || requested === 'vendor' || requested === 'shop') {
        rows.push(Object.assign({ id: d.id }, x));
      }
    });
    rows.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return rows;
  }

  /* Does this account hold the seller CLAIM — the only thing that is authority?
     Routed through SokoniRoleAuthority so claim verification lives in one place.
     When the authority module is unavailable we return false rather than falling
     back to roles[] or a cached profile: "cannot tell" must never read as "yes". */
  async function _hasSellerClaim() {
    var RA = global.SokoniRoleAuthority;
    if (!RA) return false;
    try {
      if (RA.ready) await RA.ready();
      if (typeof RA.isApproved === 'function') return !!RA.isApproved(ROLE);
    } catch (e) { /* fall through to false */ }
    return false;
  }

  /**
   * The account's seller state.
   *
   *   { state, application, canApply, reason }
   *
   *   'signed-out' | 'approved' | 'pending' | 'rejected' | 'suspended' | 'none'
   *
   * `approved` is reported ONLY on the claim. An application marked approved whose
   * claim has not landed yet is reported as 'pending', because the capability is
   * what the user is actually waiting for — and reporting otherwise would be the
   * fabricated-success pattern this codebase has been bitten by before.
   */
  async function state() {
    if (!_uid()) return { state: 'signed-out', application: null, canApply: false, reason: 'not-signed-in' };

    var claim = await _hasSellerClaim();
    var apps = [];
    try { apps = await _myApplications(); }
    catch (e) { return { state: claim ? 'approved' : 'unknown', application: null, canApply: false, reason: 'lookup-failed' }; }

    var latest = apps[0] || null;
    if (claim) return { state: 'approved', application: latest, canApply: false, reason: 'claim-held' };

    var active = apps.filter(function (a) { return ACTIVE.indexOf(_norm(a.status)) !== -1; })[0] || null;
    if (active) return { state: 'pending', application: active, canApply: false, reason: 'awaiting-review' };

    /* Decided 'approved' but the claim is not on the token yet — the projection has
       not landed, or it failed. The capability is what the applicant is waiting for,
       so this is PENDING, never 'none': reporting 'none' would invite a duplicate
       application on top of one that has already been granted, and reporting
       'approved' would claim a capability the account does not have. */
    var approvedApp = apps.filter(function (a) { return _norm(a.status) === 'approved'; })[0] || null;
    if (approvedApp) {
      return { state: 'pending', application: approvedApp, canApply: false, reason: 'approved-awaiting-claim' };
    }

    if (latest && _norm(latest.status) === 'rejected') {
      return { state: 'rejected', application: latest, canApply: true, reason: 'previously-rejected' };
    }
    if (latest && _norm(latest.status) === 'suspended') {
      return { state: 'suspended', application: latest, canApply: false, reason: 'suspended' };
    }
    return { state: 'none', application: latest, canApply: true, reason: null };
  }

  /**
   * File a seller application.
   *
   * Duplicate-safe: re-checks state immediately before writing, so a double tap or
   * two open tabs cannot file two live requests. This is a client-side guard on a
   * client-written document — it prevents the accident, not a determined actor, and
   * it is not load-bearing for authorization. Nothing here grants anything, so a
   * duplicate is an admin-queue annoyance rather than a privilege.
   */
  async function submit(details) {
    var d = details || {};
    var uid = _uid();
    if (!uid) throw new Error('not-signed-in');

    var current = await state();
    if (!current.canApply) {
      var err = new Error('application-not-allowed:' + current.state);
      err.state = current.state;
      throw err;
    }

    var m = await import(FS);
    var user = global.firebaseAuth.currentUser;

    /* Only fields the applicant is permitted to write. `role`, `approved`,
       `approvedAt` and `approvedBy` are refused by noAdminFields() in the live
       ruleset and are deliberately absent: the DECLARATION is `requestedRole`,
       which application-lifecycle.js resolves explicitly. */
    var doc = {
      uid:           uid,
      requestedRole: ROLE,
      status:        'pending',
      type:          'business',
      name:          String(d.shopName || d.name || user.displayName || '').slice(0, 120),
      email:         String(d.email || user.email || '').slice(0, 160),
      phone:         String(d.phone || '').slice(0, 32),
      location:      String(d.location || '').slice(0, 120),
      description:   String(d.description || '').slice(0, 600),
      category:      String(d.category || 'general').slice(0, 60),
      source:        'profile',
      submittedAt:   new Date().toISOString(),
      createdAt:     Date.now(),
      updatedAt:     m.serverTimestamp(),
    };

    var ref = await m.addDoc(m.collection(_db(), 'applications'), doc);
    return { id: ref.id, state: 'pending' };
  }

  global.SokoniSellerApplication = {
    state: state,
    submit: submit,
    ACTIVE_STATUSES: ACTIVE.slice(),
    _internal: { norm: _norm, myApplications: _myApplications, hasSellerClaim: _hasSellerClaim },
  };
}(typeof window !== 'undefined' ? window : this));
