/* ============================================================================
   SOKONI — Centralized User Baseline Bootstrap  (sokoni-user-bootstrap.js)

   ONE idempotent path that gives every AUTHENTICATED user the same baseline
   Firestore structure, creating ONLY what is missing and NEVER overwriting valid
   data. Runs on every login; a completed account triggers zero writes.

   WHY
   New-account creation already happens in firebase.js (onAuthStateChanged), but
   EXISTING accounts predate several baseline docs/fields and were never
   backfilled — a missing wallet or notificationPrefs, or (until 2026-07-26) a
   missing display name that broke auth entirely. This repairs those gaps at the
   edge so the UI can assume a baseline without each page re-implementing it.

   AUTH IS THE IDENTITY PROVIDER, NOT PROFILE COMPLETENESS
   It derives the uid ONLY from the verified Firebase session (currentUser) after
   waitForFirebaseReady — never from localStorage.loggedIn or cached profile. It
   NEVER redirects and NEVER throws: a bootstrap failure must not be able to
   reintroduce the profile↔login loop it exists to help prevent. Fail-open.

   WHAT IT MAY WRITE (bounded by firestore.rules — verified 2026-07-26)
     • users/{uid}          create if absent; else fill only SAFE missing fields.
                            Never writes `role` (singular), admin/privilege fields,
                            `provider` (forgery rule), `createdAt` on an existing
                            doc (timestamp integrity), or `profileEditCount` (edit-
                            limit rule → nc==pc keeps the update allowed).
     • wallets/{uid}        create if absent, balance EXACTLY 0 (rule requirement).
     • notificationPrefs/{uid}  create if absent.
   Everything else (shops, subscriptions, providers.status, provider settings,
   wallet v2 balances) is SERVER-OWNED and left to the server migration.
   ============================================================================ */
(function () {
  'use strict';

  var SESSION_FLAG = 'sk_baseline_ok';   /* per-session guard: run once per uid   */

  /* ── PURE LOGIC (unit-tested in scripts/test-user-bootstrap.js) ──────────────
     Given the existing users-doc data (or null) and the verified auth user,
     return the write plan. No Firestore, no globals — deterministic. */

  /* Fields that are safe for a CLIENT to backfill on an EXISTING users doc.
     Excludes: role(singular)/admin/privilege fields (rules), provider (forgery),
     createdAt (timestamp integrity), profileEditCount/onboarding (semantics). */
  function planUserDoc(existing, authUser) {
    var u = authUser || {};
    var derivedName =
      (u.displayName && String(u.displayName).trim()) ||
      (u.email ? String(u.email).split('@')[0] : '') ||
      (u.phoneNumber ? 'Member' : '') || 'SOKONI User';

    if (!existing) {
      /* Brand-new doc (rare here — firebase.js normally creates it). Full safe
         baseline; NO role/admin/provider fields, onboarding starts fresh. */
      return {
        op: 'create',
        data: {
          uid: u.uid,
          name: derivedName,
          email: u.email || null,
          phoneNumber: u.phoneNumber || null,
          photoURL: u.photoURL || '',
          registeredAs: { user: true },
          roles: ['buyer'],
          accountStatus: 'active',
          onboardingCompleted: false,
          onboardingRequired: true,
          _baselineVersion: 1,
        },
      };
    }

    /* Existing doc — compute ONLY missing safe fields. */
    var patch = {};
    var has = function (k) { return existing[k] !== undefined && existing[k] !== null; };

    if (!Array.isArray(existing.roles) || existing.roles.length === 0) patch.roles = ['buyer'];
    if (!existing.registeredAs || typeof existing.registeredAs !== 'object') patch.registeredAs = { user: true };
    if (!has('accountStatus')) patch.accountStatus = 'active';
    if (!has('name')) patch.name = derivedName;                 /* was the auth-loop trigger */
    if (!has('email') && u.email) patch.email = u.email;
    if (!has('phoneNumber') && u.phoneNumber) patch.phoneNumber = u.phoneNumber;
    /* An existing account that lacks onboarding flags has clearly been using the
       app — treat as onboarded so we never RE-trigger onboarding for them. */
    if (!has('onboardingCompleted') && !has('onboardingRequired')) {
      patch.onboardingCompleted = true;
      patch.onboardingRequired = false;
    }

    return Object.keys(patch).length ? { op: 'update', data: patch } : { op: 'none', data: null };
  }

  function planWallet(existing) {
    if (existing) return { op: 'none' };
    /* Rule: create allowed only when balance == 0 exactly. */
    return { op: 'create', data: { uid: null, balance: 0, currency: 'KES' } };
  }

  function planNotifPrefs(existing) {
    if (existing) return { op: 'none' };
    return {
      op: 'create',
      data: { uid: null, email: true, push: true, sms: false, marketing: false, orders: true, security: true },
    };
  }

  /* Expose pure planners for testing (no side effects). */
  var PLAN = { planUserDoc: planUserDoc, planWallet: planWallet, planNotifPrefs: planNotifPrefs };
  if (typeof module !== 'undefined' && module.exports) { module.exports = PLAN; return; }

  /* ── FIRESTORE I/O ───────────────────────────────────────────────────────── */

  var FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  var _running = false;

  async function ensureUserBaseline() {
    if (_running) return null;
    _running = true;
    try {
      var db = window.firebaseDB;
      var auth = window.firebaseAuth;
      var user = auth && auth.currentUser;
      if (!db || !user || !user.uid) return null;          /* not signed in — nothing to do */

      var uid = user.uid;
      /* Session guard: once a uid is confirmed complete this session, skip the reads. */
      try { if (sessionStorage.getItem(SESSION_FLAG) === uid) return { uid: uid, cached: true }; } catch (e) {}

      var fs = await import(FS_URL);
      var doc = fs.doc, getDoc = fs.getDoc, setDoc = fs.setDoc, updateDoc = fs.updateDoc, serverTimestamp = fs.serverTimestamp;

      var result = { uid: uid, wrote: [] };

      /* 1) users/{uid} — create if absent, else fill safe gaps (never overwrite). */
      try {
        var uref = doc(db, 'users', uid);
        var usnap = await getDoc(uref);
        var plan = planUserDoc(usnap.exists() ? usnap.data() : null, user);
        if (plan.op === 'create') {
          plan.data.createdAt = serverTimestamp();
          plan.data.lastLogin = serverTimestamp();
          await setDoc(uref, plan.data, { merge: true });
          result.wrote.push('users:create');
        } else if (plan.op === 'update') {
          /* merge:true so ONLY the missing keys are written; profileEditCount is
             untouched → passes profileEditWithinLimit(); existing values preserved. */
          await setDoc(uref, plan.data, { merge: true });
          result.wrote.push('users:fill(' + Object.keys(plan.data).join(',') + ')');
        }
      } catch (e) { _warn('users', e); }

      /* 2) wallets/{uid} — create if absent, balance exactly 0. */
      try {
        var wref = doc(db, 'wallets', uid);
        var wsnap = await getDoc(wref);
        if (!wsnap.exists()) {
          await setDoc(wref, { uid: uid, balance: 0, currency: 'KES', createdAt: serverTimestamp() });
          result.wrote.push('wallet:create');
        }
      } catch (e) { _warn('wallet', e); }

      /* 3) notificationPrefs/{uid} — create if absent. */
      try {
        var nref = doc(db, 'notificationPrefs', uid);
        var nsnap = await getDoc(nref);
        if (!nsnap.exists()) {
          var np = planNotifPrefs(null).data; np.uid = uid; np.createdAt = serverTimestamp();
          await setDoc(nref, np);
          result.wrote.push('notifPrefs:create');
        }
      } catch (e) { _warn('notificationPrefs', e); }

      try { sessionStorage.setItem(SESSION_FLAG, uid); } catch (e) {}
      if (result.wrote.length) console.info('[SOKONI baseline] repaired:', result.wrote.join('  '));
      return result;
    } catch (e) {
      _warn('bootstrap', e);
      return null;                                          /* fail-open — never block the page */
    } finally {
      _running = false;
    }
  }

  function _warn(scope, e) {
    /* Recoverable by definition — log, never surface, never redirect. */
    try { console.warn('[SOKONI baseline] ' + scope + ' skipped:', (e && (e.code || e.message)) || e); } catch (_) {}
  }

  window.ensureUserBaseline = ensureUserBaseline;

  /* ── SELF-HOOK ───────────────────────────────────────────────────────────────
     Run once auth is genuinely ready and a user is present. Uses the single
     authoritative readiness contract (waitForFirebaseReady) + the live auth
     listener — not localStorage. Safe to include on any page; a logged-out
     visitor triggers nothing. */
  function _boot() {
    if (typeof window.waitForFirebaseReady !== 'function') { setTimeout(_boot, 300); return; }
    window.waitForFirebaseReady(function () {
      if (window.firebaseAuth && window.firebaseAuth.currentUser) ensureUserBaseline();
      /* Also catch the case where the user resolves slightly later. */
      if (window.firebaseSDK && typeof window.firebaseSDK.onAuthStateChanged === 'function') {
        window.firebaseSDK.onAuthStateChanged(function (u) { if (u && u.uid) ensureUserBaseline(); });
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot);
  else _boot();
})();
