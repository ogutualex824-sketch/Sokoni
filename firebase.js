/* ================================================================
   SOKONI — Firebase SDK
   Auth · Firestore · Storage · Cloud Messaging (FCM)
================================================================ */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider, getToken as getAppCheckToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";

/* Auth Slice 3 — the email verification gate. Side-effect import: the file is a plain
   IIFE that publishes window.SokoniVerifyGate, so it also loads as a classic <script>
   and runs unmodified in the Node suite. Importing it HERE rather than adding a tag to
   every page is deliberate: firebase.js is the one module every authenticated surface
   already loads (directly or through sokoni-init.js), which makes the gate arrive with
   Firebase itself instead of depending on 48 pages each remembering a script tag. */
/* Auth Slice 6A — the enforcement policy. MUST precede the gate: the gate composes
   needsVerification() with enforcementApplies(), and a gate loaded first would spend its
   first evaluations reporting that no policy exists. */
import "./sokoni-verify-policy.js";
import "./sokoni-verify-gate.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithPhoneNumber,
  signInWithRedirect,
  sendPasswordResetEmail,
  RecaptchaVerifier,
  updateProfile,
  sendEmailVerification,
  GoogleAuthProvider,
  getRedirectResult,
  linkWithCredential,
  linkWithPhoneNumber,
  reload,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, terminate, clearIndexedDbPersistence,
  collection, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, limit, limitToLast,
  startAfter, startAt, endAt, endBefore,
  onSnapshot, writeBatch, runTransaction,
  serverTimestamp, increment, arrayUnion, arrayRemove, deleteField,
  Timestamp, FieldPath, documentId,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes, uploadString,
  getDownloadURL, deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
  getMessaging,
  getToken,
  onMessage,
  isSupported as isMessagingSupported
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

const firebaseConfig = {
  apiKey:            "AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",
  /* authDomain MUST be a domain registered as a redirect URI on the Google OAuth
     client, or Google returns "Access blocked: This app's request is invalid" and
     no sign-in can start.

     2026-07-27: moved to the APEX "mysokoni.co.ke" — the SAME origin the app is
     served from. This is the fix for Google sign-in silently failing on PHONES:
     Firebase runs the OAuth helper in a hidden iframe of authDomain; when that was
     the subdomain "auth.mysokoni.co.ke" it was CROSS-ORIGIN inside mysokoni.co.ke,
     so mobile browsers (Safari ITP / Chrome storage partitioning) blocked the
     iframe's storage → getRedirectResult() returned empty → the user bounced back
     to login with no error. Same-origin authDomain removes the iframe partition so
     the redirect flow completes on mobile. Desktop popup was unaffected either way.

     PREREQUISITE (done 2026-07-27): https://mysokoni.co.ke/__/auth/handler is now a
     registered Authorized redirect URI on the OAuth client. The earlier apex attempt
     (2026-07-25) was reverted ONLY because that URI was missing then → "Access
     blocked" on every device. With it registered, the apex works on all devices.
     If sign-in ever "Access blocked"s again, that URI was removed — re-add it or
     revert this to "auth.mysokoni.co.ke" (also still registered). */
  authDomain:        "mysokoni.co.ke",
  projectId:         "sokoni-aeb26",
  storageBucket:     "sokoni-aeb26.firebasestorage.app",
  messagingSenderId: "24799054989",
  appId:             "1:24799054989:web:e1cf6ca8c281bf1abf26c4",
  measurementId:     "G-QT32H65TJS"
};

/* ── Initialize ── */
/* Reuse an existing [DEFAULT] app instead of throwing. Some pages (e.g.
   legal-hub.html) run inline code that calls initializeApp before this module
   executes. An unconditional initializeApp here then throws "app already exists
   with different options" at module top level, halting firebase.js BEFORE App
   Check is initialized or any window.* export is set — which silently disables
   App Check for the entire page and 401s every App-Check-enforced call (the
   legal directory's getLegalProviders was dead for exactly this reason). On
   every normal page getApps() is empty and this behaves identically to before. */
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

/* ── App Check — must be initialised before any other Firebase service ──
   Production (mysokoni.co.ke, sokoni-aeb26.web.app) uses reCAPTCHA v3 attestation
   with no debug token. Localhost uses a debug token that MUST already be registered
   in Firebase Console → App Check → Manage debug tokens.

   Pin the registered token per browser, once:
     localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', '<uuid-from-console>')

   Do not rely on the `true` fallback: it makes the SDK mint a NEW random token that
   is not registered, so attestation returns 403 — and a failed App Check token fetch
   blocks every Firebase Auth request before it is sent (verified: sign-in, phone OTP
   and password reset all fail with auth/network-request-failed). The fallback exists
   only to print a fresh token on first run so it can be registered. */
const IS_LOCALHOST = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const APPCHECK_DEBUG_KEY = 'SOKONI_APPCHECK_DEBUG_TOKEN';
let _appCheck = null;
let _pinnedToken = null;

try {
  if (IS_LOCALHOST) {
    try { _pinnedToken = localStorage.getItem(APPCHECK_DEBUG_KEY); } catch (_) {}

    /* Pinned token wins and is never overwritten or regenerated. Without one we
       fall back to `true` purely to BOOTSTRAP: the SDK mints a throwaway token and
       prints it, so it can be registered once. That bootstrap token is unregistered,
       so attestation will 403 until it is registered and pinned — we say so loudly
       rather than failing silently. */
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = _pinnedToken || true;

    if (!_pinnedToken) {
      console.warn(
        '%c[SOKONI] App Check — FIRST-RUN BOOTSTRAP (no pinned debug token)',
        'color:#71ff00;font-weight:bold',
        '\nThe SDK is minting a TEMPORARY debug token, printed by Firebase just below.' +
        '\nIt is NOT registered yet, so App Check will return HTTP 403 and Firebase Auth' +
        '\nwill fail until you complete these two steps:' +
        '\n  1. Firebase Console -> App Check -> Apps -> Manage debug tokens -> add that token.' +
        `\n  2. Pin it so it is reused (never regenerated):\n     localStorage.setItem('${APPCHECK_DEBUG_KEY}', '<that-token>')` +
        '\nSee docs/APP_CHECK.md'
      );
    }
  }

  _appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider('6Lf93TktAAAAAIqCj8l3YM3dIoS1MIXpilsdnsxj'),
    isTokenAutoRefreshEnabled: true,
  });
} catch (e) {
  /* Never leak internals to end users; developers get the detail. */
  if (IS_LOCALHOST) console.error('[SOKONI] App Check init failed:', e.message);
  else console.error('[SOKONI] Security check unavailable. Please refresh and try again.');
}

/* One-shot health probe. Verifies the token actually exchanges instead of
   discovering it later as an unexplained auth failure. Runs exactly once — no
   retry loop — so a bad token can never spin the browser. */
/* Observable token state. The catalogue investigation needs to know whether an
   anonymous read failed because App Check had no token yet — this records the
   exchange outcome so a listener can report it instead of guessing. */
window.__sokoniAppCheckState = _appCheck ? 'pending' : 'disabled';

/* Readiness signal, so consumers await App Check instead of racing it.
   getAppCheckToken IS the SDK's readiness mechanism — its promise resolves
   exactly when a token has been exchanged — so this exposes that promise
   rather than polling window state. It resolves to a status either way and
   never rejects, so a consumer awaiting it can never hang: a real failure
   still lets the catalogue proceed and surface the empty/denied result rather
   than blocking the page. When App Check is disabled, it is already resolved.
   The 12s ceiling bounds the wait so a stuck token exchange degrades to a
   normal (unattested) read attempt instead of a blank page forever. */
window.__sokoniAppCheckReady = _appCheck
  ? new Promise((resolve) => {
      let done = false;
      const settle = (status) => { if (!done) { done = true; resolve(status); } };
      getAppCheckToken(_appCheck, false)
        .then(() => settle('exchanged'))
        .catch(() => settle('rejected'));
      setTimeout(() => settle('timeout'), 12000);
    })
  : Promise.resolve('disabled');

/* Force a fresh App Check token exchange (re-runs reCAPTCHA v3). Consumers call this on a
   permission-denied/403 read — App Check 403s intermittently on this project (esp. iOS Safari
   under ITP) and a forced refresh usually yields a valid token so the retried read succeeds.
   Resolves true/false, never rejects, so callers can always chain a retry. */
window.__sokoniRefreshAppCheckToken = function () {
  try {
    return _appCheck
      ? getAppCheckToken(_appCheck, true).then(() => true).catch(() => false)
      : Promise.resolve(true);
  } catch (_) { return Promise.resolve(false); }
};

window.__sokoniAuthReady = false;
window.__sokoniAuthReadyDetail = null;
let _sokoniAuthReadyResolve = null;
function _resetSokoniAuthReadyPromise() {
  window.__sokoniAuthReadyPromise = new Promise(function (resolve) {
    _sokoniAuthReadyResolve = resolve;
  });
}
_resetSokoniAuthReadyPromise();
window.waitForSokoniAuthReady = function (cb) {
  const done = function (detail) {
    try { if (typeof cb === 'function') cb(detail); } catch (e) { console.error('[Firebase] auth ready callback threw:', e); }
    return detail;
  };
  if (window.__sokoniAuthReady) return Promise.resolve(done(window.__sokoniAuthReadyDetail));
  return window.__sokoniAuthReadyPromise.then(done);
};

function _publishSokoniAuthReady(detail) {
  window.__sokoniAuthReady = true;
  window.__sokoniAuthReadyDetail = detail || null;
  if (_sokoniAuthReadyResolve) {
    _sokoniAuthReadyResolve(detail);
    _sokoniAuthReadyResolve = null;
  }
  document.dispatchEvent(new CustomEvent('sokoniAuthReady', { detail: detail }));
}

if (_appCheck) {
  getAppCheckToken(_appCheck, false)
    .then(() => { window.__sokoniAppCheckState = 'exchanged'; if (IS_LOCALHOST) console.info('[SOKONI] App Check OK — token exchanged.'); })
    .catch((err) => {
      window.__sokoniAppCheckState = 'rejected';
      if (!IS_LOCALHOST) {
        /* Production: generic, no internals. */
        console.error('[SOKONI] Security verification failed. Please refresh and try again.');
        return;
      }
      const pinnedNote = _pinnedToken
        ? `The pinned debug token is INVALID or NOT REGISTERED:\n  ${_pinnedToken}\n` +
          `Fix: register it in Firebase Console, or clear it and re-bootstrap:\n` +
          `  localStorage.removeItem('${APPCHECK_DEBUG_KEY}')  // then reload`
        : 'No debug token is pinned — this is the expected first-run 403. Register the\n' +
          'token printed above, then pin it (see the bootstrap message).';

      console.error(
        '%c[SOKONI] App Check FAILED — Firebase Auth will not work until this is fixed.',
        'color:#ff5252;font-weight:bold',
        `\nreason: ${err && (err.code || err.message)}\n${pinnedNote}\n` +
        'A failed App Check token blocks every Auth request BEFORE it is sent, so\n' +
        'sign-in/OTP/password-reset surface as auth/network-request-failed.\n' +
        'Troubleshooting: docs/APP_CHECK.md'
      );
    });
}

const auth      = getAuth(app);
const db        = getFirestore(app);
const storage   = getStorage(app);
const functions = getFunctions(app);
let messaging = null;

if (typeof window !== "undefined") {
  /* Feature-detect with Firebase's own async isSupported() rather than sniffing for
     Notification + serviceWorker. Those two exist in desktop Safari while the rest of the
     push stack does not, so getMessaging() got past the hand-rolled check and then rejected
     during component init — an UNHANDLED rejection that a synchronous try/catch cannot see.
     It surfaced on every merchant route as "[PosResilience] Unhandled rejection:
     FirebaseError: Messaging: This browser doesn't support the API's required...".
     isSupported() is the documented guard and settles instead of throwing.

     messaging stays null until this resolves; every consumer already returns early on a null
     messaging (see sokoniRequestPushPermission), so late initialisation is safe — push is
     requested by user gesture long after boot, never during it. */
  isMessagingSupported()
    .then((ok) => {
      if (!ok) { console.info("[SOKONI] FCM unsupported on this browser — push disabled."); return; }
      try { messaging = getMessaging(app); }
      catch (e) { console.warn("[SOKONI] FCM init failed:", e && e.message); }
    })
    .catch((e) => { console.warn("[SOKONI] FCM support check failed:", e && e.message); });
}

/* ── Expose globals for non-module scripts ── */
window.firebaseApp       = app;
window.firebaseAuth      = auth;
window.firebaseDB        = db;
window.firebaseStorage   = storage;
window.firebaseFunctions = functions;

/* ══════════════════════════════════════════════════════════════════
   FIREBASE READY LIFECYCLE
   ──────────────────────────────────────────────────────────────────
   Four pages — index.html, driver.html, launch-readiness.html and
   merchant-pipeline.html — registered their entire auth pipeline
   inside a listener for `sokoniFirebaseReady`. Nothing in the
   codebase ever dispatched it, so those listeners never fired.

   On index.html that is the page the Google OAuth redirect lands on,
   so onAuthStateChanged was never registered there: the session was
   restored by the SDK but nothing rendered it, and the header stayed
   logged-out. The user read that as "not signed in". OAuth itself was
   never broken — the landing page simply never listened.

   The event now fires here, immediately after window.firebaseAuth is
   assigned, so a listener can rely on the global existing.

   IDEMPOTENT BY DESIGN. An event is a one-shot: any page whose script
   parses after this module has already missed it, which on a deferred
   module is a coin-toss the page cannot win reliably. The latch below
   makes late arrivals safe, and waitForFirebaseReady() resolves
   immediately when Firebase is already up rather than waiting for an
   event that has been and gone. That is what removes the race rather
   than narrowing it.
══════════════════════════════════════════════════════════════════ */
window.__sokoniFirebaseReady = true;

/**
 * waitForFirebaseReady(cb?) — the single readiness contract.
 *   waitForFirebaseReady().then(auth => …)   or   waitForFirebaseReady(auth => …)
 * Resolves immediately if Firebase is already initialised, otherwise on
 * the event. Callers never need to know which case they are in.
 */
window.waitForFirebaseReady = function (cb) {
  const done = (a) => { try { if (typeof cb === 'function') cb(a); } catch (e) { console.error('[Firebase] ready callback threw:', e); } return a; };
  if (window.__sokoniFirebaseReady && window.firebaseAuth) return Promise.resolve(done(window.firebaseAuth));
  return new Promise((resolve) => {
    document.addEventListener('sokoniFirebaseReady', function _once() {
      document.removeEventListener('sokoniFirebaseReady', _once);
      resolve(done(window.firebaseAuth));
    }, { once: true });
  });
};

console.info('[Firebase] Initialized');
console.info('[Firebase] Auth Ready');
/* Dispatched on `document` — that is where all four existing listeners
   are registered, so the contract matches what pages already expect. */
document.dispatchEvent(new CustomEvent('sokoniFirebaseReady', { detail: { auth } }));
console.info('[Firebase] sokoniFirebaseReady dispatched');

/* sokoniCallable(name) — synchronous replacement for firebase.functions().httpsCallable(name) */
window.sokoniCallable = (name) => httpsCallable(functions, name);

/* firebaseSDK — bound auth helpers so non-module pages never touch the compat namespace */
window.firebaseSDK = {
  auth,
  signInWithEmailAndPassword:    (e, p)       => signInWithEmailAndPassword(auth, e, p),
  createUserWithEmailAndPassword:(e, p)       => createUserWithEmailAndPassword(auth, e, p),
  signInWithPopup:               (provider)   => signInWithPopup(auth, provider),
  signInWithPhoneNumber:         (phone, ver) => signInWithPhoneNumber(auth, phone, ver),
  /* Verify/attach a phone to the CURRENTLY signed-in account (profile phone
     verification). Sends an SMS and returns a ConfirmationResult; .confirm(code)
     links the verified number so auth.currentUser.phoneNumber is set. */
  linkWithPhoneNumber:           (phone, ver) => auth.currentUser
                                    ? linkWithPhoneNumber(auth.currentUser, phone, ver)
                                    : Promise.reject(new Error('No user')),
  /* Refresh the current user so freshly-changed emailVerified/phoneNumber flags
     are visible without a full page reload. */
  reloadUser:                    ()           => auth.currentUser ? reload(auth.currentUser) : Promise.reject(new Error('No user')),
  signOut:                       ()           => signOut(auth),
  onAuthStateChanged:            (cb)         => onAuthStateChanged(auth, cb),
  updateProfile,
  sendEmailVerification: () => auth.currentUser ? sendEmailVerification(auth.currentUser) : Promise.reject(new Error('No user')),
  GoogleAuthProvider,
  RecaptchaVerifier,
};

/* ════════════════════════════════════════════════════════════════════════
   LEGACY COMPAT SHIM  —  window.firebase
   Backs the compat namespace with the modular SDK so pages that call
   firebase.auth() / firebase.firestore() / firebase.functions() work
   without loading firebase-*-compat.js CDN scripts.
   Guard: pages that DO load compat scripts keep their own window.firebase.
════════════════════════════════════════════════════════════════════════ */
if (!window.firebase) {

  /* ── Snapshot wrappers ─────────────────────────────────────────────── */
  function _wd(snap) {
    return {
      id: snap.id, ref: snap.ref, exists: snap.exists(),
      data: () => snap.data(), get: (f) => (snap.data() || {})[f],
    };
  }
  function _ws(snap) {
    const docs = snap.docs.map(_wd);
    return {
      empty: snap.empty, size: snap.size, docs, forEach: (cb) => docs.forEach(cb),
      /* docChanges() — compat parity, and NOT optional.
         Consumers use it to react to deltas instead of reprocessing a whole result set
         on every snapshot. Omitting it here meant every such call site threw
         "TypeError: snap.docChanges is not a function" the instant this shim became the
         Firestore provider, inside an async onSnapshot callback — so it surfaced only as
         an unhandled rejection and the listener silently stopped doing its job. That hit
         POS inventory sync, POS marketplace-order intake, realtime.js, and the driver /
         dispatch boards alike.
         Each change's doc is wrapped with _wd so change.doc.id / .data() behave exactly
         as they do on the documents in .docs. Computed lazily: snapshots that never ask
         for changes pay nothing, which matters for the large collections this shim feeds. */
      docChanges: (opts) => snap.docChanges(opts).map((c) => ({
        type: c.type, doc: _wd(c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex,
      })),
    };
  }

  /* ── Firestore collection shim ─────────────────────────────────────── */
  class _CS {
    constructor(path, c) {
      this._p = path;
      this._r = collection(db, path);
      this._c = c || [];
    }
    _cl(x)         { return new _CS(this._p, [...this._c, x]); }
    _bq()          { return this._c.length ? query(this._r, ...this._c) : this._r; }
    doc(id)        { return new _DS(`${this._p}/${id || doc(this._r).id}`); }
    add(d)         { return addDoc(this._r, d); }
    where(f,op,v)  { return this._cl(where(f,op,v)); }
    orderBy(f,d)   { return this._cl(orderBy(f,d||'asc')); }
    limit(n)       { return this._cl(limit(n)); }
    limitToLast(n) { return this._cl(limitToLast(n)); }
    startAfter(s)  { return this._cl(startAfter(s)); }
    startAt(s)     { return this._cl(startAt(s)); }
    endBefore(s)   { return this._cl(endBefore(s)); }
    endAt(s)       { return this._cl(endAt(s)); }
    get()          { return getDocs(this._bq()).then(_ws); }
    onSnapshot(o,c){ const fn=typeof o==='function'?o:c; return onSnapshot(this._bq(),s=>fn(_ws(s))); }
  }

  /* ── Firestore document shim ───────────────────────────────────────── */
  class _DS {
    constructor(path) {
      this._p = path;
      this._r = doc(db, ...path.split('/').filter(Boolean));
    }
    collection(p)  { return new _CS(`${this._p}/${p}`); }
    set(d,o)       { return setDoc(this._r, d, o||{}); }
    update(d)      { return updateDoc(this._r, d); }
    delete()       { return deleteDoc(this._r); }
    get()          { return getDoc(this._r).then(_wd); }
    onSnapshot(o,c){ const fn=typeof o==='function'?o:c; return onSnapshot(this._r,s=>fn(_wd(s))); }
    get id()       { return this._r.id; }
    get path()     { return this._r.path; }
  }

  /* ── Storage ref shim ──────────────────────────────────────────────── */
  class _SR {
    constructor(path) { this._r = storageRef(storage, path||''); this._p = path||''; }
    child(p)          { return new _SR(`${this._p}/${p}`); }
    put(d,m)          { return uploadBytes(this._r, d, m); }
    putString(s,f,m)  { return uploadString(this._r, s, f, m); }
    getDownloadURL()  { return getDownloadURL(this._r); }
    delete()          { return deleteObject(this._r); }
    get fullPath()    { return this._r.fullPath; }
    get name()        { return this._r.name; }
  }

  /* ── Firestore db ops object ───────────────────────────────────────── */
  const _fso = {
    collection: (p) => new _CS(p),
    doc:        (p) => new _DS(p),
    batch:      ()  => writeBatch(db),
    runTransaction: (cb) => runTransaction(db, async (t) => cb({
      get:    (r) => t.get(r._r||r).then(_wd),
      set:    (r,d,o) => t.set(r._r||r, d, o||{}),
      update: (r,d)   => t.update(r._r||r, d),
      delete: (r)     => t.delete(r._r||r),
    })),
  };

  /* ── Auth function with static class properties ────────────────────── */
  const _af = Object.assign(
    function(_app) {
      return {
        get currentUser()                 { return auth.currentUser; },
        onAuthStateChanged:               (cb,e,c) => onAuthStateChanged(auth,cb,e,c),
        signInWithEmailAndPassword:       (e,p)    => signInWithEmailAndPassword(auth,e,p),
        createUserWithEmailAndPassword:   (e,p)    => createUserWithEmailAndPassword(auth,e,p),
        signInWithPopup:                  (p)      => signInWithPopup(auth,p),
        signInWithRedirect:               (p)      => signInWithRedirect(auth,p),
        signInWithPhoneNumber:            (ph,v)   => signInWithPhoneNumber(auth,ph,v),
        signOut:                          ()       => signOut(auth),
        sendPasswordResetEmail:           (e,c)    => sendPasswordResetEmail(auth,e,c),
        sendEmailVerification:            (u)      => sendEmailVerification(u||auth.currentUser),
      };
    },
    { GoogleAuthProvider, RecaptchaVerifier }
  );

  /* ── Firestore function: callable + direct-access + static helpers ─── */
  const _ff = Object.assign(function(_app) { return _fso; }, _fso, {
    FieldValue: {
      serverTimestamp: ()    => serverTimestamp(),
      increment:       (n)   => increment(n),
      arrayUnion:      (...a)=> arrayUnion(...a),
      arrayRemove:     (...a)=> arrayRemove(...a),
      delete:          ()    => deleteField(),
    },
    Timestamp,
    FieldPath: { documentId: () => documentId() },
  });

  /* ── Functions shim ────────────────────────────────────────────────── */
  const _fnShim = (_app) => ({ httpsCallable: (n,o) => httpsCallable(functions,n,o) });

  /* ── App shim ──────────────────────────────────────────────────────── */
  const _appShim = (name) => ({
    name:      name||'[DEFAULT]',
    functions: (r) => _fnShim(r),
    auth:      ()  => _af(),
    firestore: ()  => _fso,
    storage:   ()  => ({ ref: (p) => new _SR(p||'') }),
  });

  window.firebase = {
    get apps()    { return getApps(); },
    app:          (name) => _appShim(name),
    auth:         _af,
    firestore:    _ff,
    functions:    _fnShim,
    storage:      (_app) => ({ ref: (p) => new _SR(p||'') }),
    initializeApp:(cfg, name) => {
      if (!name) return app;
      return getApps().find(a => a.name === name) || initializeApp(cfg, name);
    },
  };

  /* Announce that window.firebase now exists.
     This file is a MODULE, so it is deferred and always runs AFTER the classic
     inline scripts on a page. Anything touching the global `firebase.*` compat
     shim at top level therefore runs too early and throws "firebase is not
     defined". Pages can wait on this event instead of guessing.

     subscription-os.html already did `addEventListener('firebaseReady', init)`,
     but nothing in the codebase ever dispatched it — so its init never ran at
     all. Dispatching here makes that listener (and any future one) work.
     Fired on window AND document so either target works, and a late listener
     can still check window.firebase directly. */
  try {
    window.__sokoniFirebaseReady = true;
    window.dispatchEvent(new Event('firebaseReady'));
    document.dispatchEvent(new Event('firebaseReady'));
  } catch (_) { /* never let a listener error break auth bootstrap */ }
}

/* Shared "a user has actually signed in" signal. onAuthStateChanged (below)
   resolves it the instant the SDK restores a session. The redirect-result
   handler awaits it to tell a GENUINE failure apart from iOS Safari's spurious
   getRedirectResult error — where ITP blocks the authDomain's storage so
   getRedirectResult throws auth/internal-error, yet the session is restored and
   onAuthStateChanged fires with the user regardless. */
let _sokoniUserSeenResolve = null;
const _sokoniUserSeen = new Promise((resolve) => { _sokoniUserSeenResolve = resolve; });

/* ══════════════════════════════════════════════════════════════════
   GOOGLE REDIRECT RESULT
   After signInWithRedirect() the browser returns to this page.
   getRedirectResult() resolves with the credential (or null if no
   redirect was pending).  We dispatch custom events so auth.js
   (non-module) can handle the result without a direct import.

   iOS Safari / ITP note
   ─────────────────────
   Apple's Intelligent Tracking Prevention (ITP) treats the Firebase
   authDomain iframe (sokoni-aeb26.firebaseapp.com) as a third-party
   in the context of mysokoni.co.ke, blocking it from reading its own
   cookies / IndexedDB.  As a result, getRedirectResult() throws
   auth/internal-error or auth/web-storage-unsupported on EVERY page
   load on iPhone/iPad — even when no redirect was ever initiated.

   The fix: read sokoniAuthRedirectPending (set by signInWithRedirect
   in auth.js) BEFORE calling getRedirectResult.  If absent, any error
   is environmental noise and must be swallowed silently — we log it
   for diagnostics but never dispatch an event that would display an
   error banner to the user.
══════════════════════════════════════════════════════════════════ */
(async () => {
  let _redirectWasPending = false;
  try { _redirectWasPending = sessionStorage.getItem('sokoniAuthRedirectPending') === '1'; } catch (_) {}

  try {
    const result = await getRedirectResult(auth);
    if (result && result.user) {
      const providerId = result.user.providerData?.[0]?.providerId || "unknown";
      /* Dispatch provider-specific event for Google (backward compat) + generic for all */
      if (providerId === "google.com") {
        window.dispatchEvent(new CustomEvent("sokoniGoogleRedirectDone", { detail: result }));
      }
      window.dispatchEvent(new CustomEvent("sokoniOAuthRedirectDone", { detail: result }));
    }
  } catch (err) {
    const silent = [
      "auth/null-user",
      "auth/no-auth-event",
      "auth/operation-not-supported-in-this-environment",
    ];
    /* If no redirect was initiated by this session, the error is ITP noise from
       iOS Safari.  Log it for diagnostics but do NOT dispatch events — dispatching
       would surface an error banner to the user before they have done anything. */
    if (!_redirectWasPending) {
      console.warn('[SOKONI Auth] getRedirectResult error (no redirect pending — suppressed):', err.code, err.message);
      return;
    }
    if (!silent.includes(err.code)) {
      /* iOS Safari / ITP FALSE POSITIVE. After a real redirect sign-in, ITP can
         make getRedirectResult throw auth/internal-error (or
         auth/web-storage-unsupported) even though the sign-in SUCCEEDED and
         onAuthStateChanged is about to fire with the user. Dispatching the error
         banner here told signed-in users their sign-in failed. Wait briefly for
         the auth-state signal; if the user materialises, the sign-in worked —
         stay silent. A genuine failure (no user within the window) still surfaces
         below, so nothing is masked. Bounded wait: never hangs the page. */
      if (err.code === 'auth/internal-error' || err.code === 'auth/web-storage-unsupported') {
        const _user = await Promise.race([
          _sokoniUserSeen,
          new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        if (_user) {
          console.warn('[SOKONI Auth] getRedirectResult threw', err.code,
            '— but the session was restored (onAuthStateChanged fired). Suppressing false error.');
          return;
        }
      }
      /* Log the real error code so production failures can be diagnosed from
         console snapshots. Never exposes sensitive data — code is an enum string. */
      console.warn('[SOKONI Auth] getRedirectResult error:', err.code, err.message);
      if (err.code === "auth/account-exists-with-different-credential") {
        /* Attach the matching credential for the linking flow in auth.js */
        const pid = err.customData?._tokenResponse?.providerId || "";
        try {
          if (pid === "google.com")         err._pendingCred = GoogleAuthProvider.credentialFromError(err);
        } catch (_) {}
      }
      window.dispatchEvent(new CustomEvent("sokoniGoogleRedirectError", { detail: err }));
      window.dispatchEvent(new CustomEvent("sokoniOAuthRedirectError",  { detail: err }));
    }
  }
})();

/* ══════════════════════════════════════════════════════════════════
   AUTH STATE OBSERVER
   Keeps localStorage in sync with the real Firebase Auth session.
   Every page benefits: non-module scripts reading loggedIn/sokoniUser
   get the correct, up-to-date state without needing to know about
   Firebase Auth directly.
══════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
   SESSION / DEVICE REGISTRATION
   ──────────────────────────────────────────────────────────────────
   deviceRegister was called from exactly ONE place in the codebase —
   account-centre.html — so a device only appeared in the Devices list
   if the user happened to open the Account Centre page on it. A phone
   that signed in and used the app normally was authenticated but
   never registered, which is why concurrent devices showed as one.

   The Cloud Function was never the problem: it keys documents on
   `${uid}_${deviceId}`, so distinct devices already get distinct
   documents. The trigger was simply in the wrong place.

   Registering here means every authenticated device registers itself
   regardless of which pages it visits. Deliberately cheap:

     • once per browser session (sessionStorage latch), not per page
       load — otherwise every navigation costs a Firestore write
     • fire-and-forget, so a failure can never block or delay sign-in
     • the deviceId is the same stable localStorage key the Devices
       page already reads, so existing rows keep their identity
       instead of duplicating
══════════════════════════════════════════════════════════════════ */
function _sokoniDeviceId() {
  try {
    let id = localStorage.getItem('sk_device_id');
    if (!id) {
      id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('sk_device_id', id);
    }
    return id;
  } catch (_) { return null; }
}

async function _registerSession() {
  try {
    if (sessionStorage.getItem('_skSessionRegistered') === '1') return;
    const deviceId = _sokoniDeviceId();
    if (!deviceId) return;                       /* private mode — skip silently */
    sessionStorage.setItem('_skSessionRegistered', '1');   /* latch before await: no double-fire */

    const res = await httpsCallable(functions, 'deviceRegister')({
      deviceId,
      deviceName: (navigator.userAgentData?.platform || navigator.platform || '') || undefined,
    });
    const docId = res?.data?.deviceDocId;
    if (docId) { try { localStorage.setItem('sk_device_doc', docId); } catch (_) {} }
    console.info('[Session] device registered', docId || '(no id)');
  } catch (e) {
    /* Never surface: a session-tracking failure must not affect sign-in. */
    try { sessionStorage.removeItem('_skSessionRegistered'); } catch (_) {}
    console.warn('[Session] device registration failed:', e?.code || e?.message || e);
  }
}

/* ── AUTH SLICE 5 — cross-tab and re-entry ──────────────────────────────────
   onAuthStateChanged covers every page LOAD, but Firebase does not fire it when
   emailVerified flips. Without this a second tab held at the challenge would sit there
   forever after the user verified in the first one — verified, and still locked out.

   A GETTER is passed, not auth.currentUser: an account switch replaces the user, and a
   captured reference would go on answering for the account that has left. */
try { window.SokoniVerifyGate.watch(() => auth.currentUser); } catch (e) {
  console.warn("[SOKONI Auth] verification watcher not installed:", e && e.message);
}

onAuthStateChanged(auth, async (user) => {
  /* Expose current UID for framework-agnostic consumers (e.g. sokoni-search-engine.js)
     without requiring them to import Firebase directly. */
  window.__sokoniCurrentUid = user?.uid || null;

  if (user) {
    /* Tell the redirect-result handler a real session exists, so it can suppress
       iOS Safari's false auth/internal-error. Fires once; harmless if never awaited. */
    if (_sokoniUserSeenResolve) { _sokoniUserSeenResolve(user); _sokoniUserSeenResolve = null; }

    /* ── AUTH SLICE 3 — email verification gate ──────────────────────────────
       This handler is the ONE place an application session is created from
       authoritative Firebase state, and it runs on every page load and every token
       refresh — not just at login. Putting the gate here is what makes a refresh, a
       direct URL, a restored tab and a back-button all stay gated: there is no path
       into the app that skips this callback.

       Everything below this point IS the application session — the `loggedIn` flag
       auth-guard.js reads, the cached profile, the device registration. A gated user
       gets none of it, so the check has to come first.

       sokoniAuthReady is deliberately NOT dispatched when gated. Surfaces treat that
       event as "a usable session exists"; firing it for someone who is being held at
       the challenge would hand them exactly the session this gate is refusing. */
    let _skGate = { gated: false };
    try {
      _skGate = await window.SokoniVerifyGate.enforce(user);
    } catch (e) {
      /* The gate itself failing must not become a way through it. */
      console.warn('[SOKONI Auth] verification gate error — denying session:', e && e.message);
      _skGate = { gated: true, reason: 'gate-error' };
      try { window.SokoniVerifyGate.denyAppSession(); } catch (_) { }
    }
    if (_skGate.gated) {
      console.warn('[SOKONI Auth] email not verified — application session withheld.');
      return;
    }

    /* ── AUTH SLICE 5 ──
       Past the gate, so this is a different account than any screen still on the page was
       opened for. Tear it down before the session is built. */
    try { window.SokoniVerifyScreen && window.SokoniVerifyScreen.onAuthChange(user); } catch (e) { }

    localStorage.setItem("loggedIn", "true");

    /* Register this device for the multi-device session list. Not awaited —
       sign-in must never wait on session bookkeeping. */
    _registerSession();

    /* Determine sign-in provider from Auth token */
    const providerId = user.providerData?.[0]?.providerId || "password";
    const isGoogle   = providerId === "google.com";

    try {
      const { getDoc, setDoc, doc, serverTimestamp } = await import(
        "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
      );
      const snap = await getDoc(doc(db, "users", user.uid));

      if (snap.exists()) {
        /* ── Existing user ─────────────────────────────────────────
           Load the full profile into localStorage (source of truth).
           For Google users: merge photoURL if it was previously empty.
           NEVER overwrite roles, seller data, wallet, subscriptions.  */
        const existing = snap.data();
        localStorage.setItem("sokoniUser", JSON.stringify(existing));

        /* Notify all modules that auth state is confirmed with real profile data.
           shared-header.js, auth.js, and realtime modules all listen for this. */
        const authReadyDetail = {
          uid:   user.uid,
          roles: existing.roles || ["buyer"],
          role:  existing.role  || (existing.roles && existing.roles[0]) || "buyer",
        };
        _publishSokoniAuthReady(authReadyDetail);

        /* Preserve the existing profile while updating any safe fields for
           Google users only if they are missing from the canonical Firestore doc. */
        const profileUpdates = {};
        if (isGoogle && !existing.photoURL && user.photoURL) profileUpdates.photoURL = user.photoURL;
        if (Object.keys(profileUpdates).length) {
          setDoc(doc(db, "users", user.uid), profileUpdates, { merge: true }).catch(() => {});
        }
      } else {
        /* ── New user ──────────────────────────────────────────────
           Create the authoritative Firestore profile.
           Google users get firstName/lastName/photoURL/emailVerified.
           Roles default to ['buyer'] — never write admin-protected
           fields ('role' singular is blocked by Firestore rules).      */
        const parts    = (user.displayName || "").split(" ");
        const firstName = parts[0] || "";
        const lastName  = parts.slice(1).join(" ") || "";
        const _now     = new Date();

        /* Generate unique referral code: SKN + 7 alphanumeric chars */
        const _refChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let _refCode = "SKN";
        for (let _i = 0; _i < 7; _i++) {
          _refCode += _refChars[Math.floor(Math.random() * _refChars.length)];
        }

        /* Capture inbound referral code from URL or localStorage */
        const _inboundRef = (function() {
          try {
            const p = new URLSearchParams(window.location.search);
            const urlRef = p.get("ref") || p.get("referral") || "";
            if (urlRef) { localStorage.setItem("_pendingRef", urlRef); return urlRef; }
            return localStorage.getItem("_pendingRef") || "";
          } catch(_) { return ""; }
        })();

        /* Resolve inbound code → referrer UID via Firestore query */
        let _referredByUid = "";
        if (_inboundRef && _inboundRef !== _refCode) {
          try {
            const { collection: _col, query: _q, where: _w, limit: _lim, getDocs: _gd } =
              await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
            const _refSnap = await _gd(_q(_col(db, "users"),
              _w("referralCode", "==", _inboundRef.toUpperCase()), _lim(1)));
            if (!_refSnap.empty) {
              _referredByUid = _refSnap.docs[0].id;
              localStorage.removeItem("_pendingRef");
            }
          } catch(_) {}
        }

        /* Resolve provider label for all supported sign-in methods */
        const isFacebook = providerId === "facebook.com";
        const isPhone    = providerId === "phone";
        const isEmail    = providerId === "password";

        const providerSlug = isGoogle   ? "google"
                           : isFacebook ? "facebook"
                           : isPhone    ? "phone"
                           : "email";

        const profile = {
          uid:                user.uid,
          name:               user.displayName || (user.email || user.phoneNumber || "").split("@")[0] || "User",
          email:              user.email || null,
          phoneNumber:        user.phoneNumber || null,
          registeredAs:       { user: true },
          roles:              ["buyer"],
          accountStatus:      "active",
          onboardingCompleted: false,
          onboardingRequired: true,
          referralCode:       _refCode,
          referredBy:         _referredByUid || null,
          firstReferralOrderDone: false,
          joinedAt:           _now.toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }),
          joinedTimestamp:    _now.getTime(),
          provider:           providerSlug,
          providers:          [providerSlug],
          photoURL:           user.photoURL || "",
          emailVerified:      user.emailVerified || isPhone,
          ...(isGoogle && { firstName, lastName }),
          ...(isFacebook && {
            firstName: (user.displayName || "").split(" ")[0] || "",
            lastName:  (user.displayName || "").split(" ").slice(1).join(" ") || "",
          }),
        };
        await setDoc(doc(db, "users", user.uid), {
          ...profile,
          createdAt: serverTimestamp(),
          lastLogin: serverTimestamp(),
        });
        localStorage.setItem("sokoniUser", JSON.stringify(profile));

        /* Notify all modules that auth state is confirmed — new user path */
        _publishSokoniAuthReady({ uid: user.uid, roles: ["buyer"], role: "buyer" });

        /* ── First-login initialisation: wallet + notification prefs ──
           These are fire-and-forget; failure is non-fatal.            */
        (async () => {
          try {
            const { doc: _doc, setDoc: _set, serverTimestamp: _sts, getDoc: _get } = await import(
              "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
            );
            /* Wallet — initialised with zero balance */
            const walletRef  = _doc(db, "wallets", user.uid);
            const walletSnap = await _get(walletRef);
            if (!walletSnap.exists()) {
              await _set(walletRef, {
                uid:       user.uid,
                balance:   0,
                currency:  "KES",
                createdAt: _sts(),
              });
            }
            /* Notification preferences */
            const notifRef  = _doc(db, "notificationPrefs", user.uid);
            const notifSnap = await _get(notifRef);
            if (!notifSnap.exists()) {
              await _set(notifRef, {
                uid:        user.uid,
                email:      true,
                push:       true,
                sms:        false,
                marketing:  false,
                orders:     true,
                security:   true,
                createdAt:  _sts(),
              });
            }
          } catch (_) {}
        })();
      }
    } catch (e) {
      /* Firestore temporarily unreachable. The user IS authenticated (Firebase Auth
         confirmed the session and set loggedIn above). Keep any existing localStorage
         profile and still dispatch sokoniAuthReady so the login page redirects rather
         than leaving the user stuck on a visually-signed-out state. */
      console.warn('[SOKONI Auth] onAuthStateChanged: Firestore unreachable:', e.code || e.message);
      let _roles = ['buyer'], _role = 'buyer';
      try {
        const _c = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
        if (_c.roles && _c.roles.length) { _roles = _c.roles; _role = _c.roles[0]; }
      } catch (_) {}
      const fallback = {
        uid: user.uid,
        email: user.email || null,
        phoneNumber: user.phoneNumber || null,
        name: user.displayName || (user.email || '').split('@')[0] || 'User',
        provider: providerId || 'password',
        emailVerified: user.emailVerified,
        accountStatus: 'active',
        registeredAs: { user: true },
        roles: _roles,
        role: _role,
      };
      localStorage.setItem('sokoniUser', JSON.stringify(fallback));
      _publishSokoniAuthReady({ uid: user.uid, roles: _roles, role: _role });
    }
  } else {
    window.__sokoniAuthReady = false;
    window.__sokoniAuthReadyDetail = null;
    _resetSokoniAuthReadyPromise();

    /* ── AUTH SLICE 5 ──
       Signed out — here or in another tab. The challenge marker and the verification
       screen both belong to a session that no longer exists: leaving the screen up would
       offer a code entry for somebody who has left, and the next person to sign in on
       this device would be typing into it. */
    try {
      window.SokoniVerifyGate && window.SokoniVerifyGate.clearPending();
      window.SokoniVerifyScreen && window.SokoniVerifyScreen.onAuthChange(null);
    } catch (e) { }

    /* Stop idle timeout when signed out */
    if (window._sokoniStopIdleTimer) window._sokoniStopIdleTimer();

    /* Release the registration latch so a subsequent sign-in on this device
       registers again. sk_device_id is deliberately NOT cleared — it is this
       browser's stable identity, and regenerating it would create a duplicate
       row in the Devices list on every sign-out/sign-in cycle. */
    try { sessionStorage.removeItem('_skSessionRegistered'); } catch (_) {}

    /* Firebase session gone — clear ALL auth-related storage */
    localStorage.removeItem("loggedIn");
    localStorage.removeItem("sokoniUser");
    localStorage.removeItem("sokoniSession_v2");
    localStorage.removeItem("sokoniEmployeeSession");
    try { sessionStorage.removeItem("sokoniPermCache"); } catch (_) {}
    /* Invalidate subscription cache */
    if (window.SokoniSubscriptions) window.SokoniSubscriptions.invalidateCache();
    /* Stop syncing */
    if (window.SokoniSync) window.SokoniSync.clear();
  }
});

/* ── SokoniSync wiring ──────────────────────────────────────────
   If SokoniSync is already loaded, init it immediately.
   If not (script not yet parsed), store pending state — sokoni-sync.js
   will pick it up via window._sokoniSyncPending on load.
─────────────────────────────────────────────────────────────── */
function _initSokoniSync(firestoreDb, uid) {
  if (window.SokoniSync) {
    window.SokoniSync.init(firestoreDb, uid);
    window.SokoniSync.pull(uid);
  } else {
    /* Queue for when sokoni-sync.js loads */
    window._sokoniSyncPending = { db: firestoreDb, uid };
    /* Also listen for the load event */
    window.addEventListener('sokoniSyncLoaded', function handler() {
      window.removeEventListener('sokoniSyncLoaded', handler);
      if (window.SokoniSync && window._sokoniSyncPending) {
        const { db: d, uid: u } = window._sokoniSyncPending;
        window._sokoniSyncPending = null;
        window.SokoniSync.init(d, u);
        window.SokoniSync.pull(u);
      }
    }, { once: true });
  }
}

/* ══════════════════════════════════════════════════════════════════
   SIGN OUT
   Call window.sokoniSignOut() from any page's logout button.
   It signs out of Firebase Auth, then clears the legacy localStorage
   keys so all pages immediately see the logged-out state.
══════════════════════════════════════════════════════════════════ */
/* All localStorage keys managed by SOKONI — cleared on every signout */
const _SOKONI_LS_KEYS = [
  "loggedIn", "sokoniUser", "sokoniCreds", "sokoniSessionId",
  "sokoniSession_v2", "sokoniAuditLog", "sokoniEmployeeSession",
  "sokoni_fcm_token", "sokoniBookingFees", "sokoniCommissionLedger",
  "sokoniPlatformBookings", "sokoniPhoneLeads", "sokoniLeadFees",
  "sokoniSubscriptions", "sokoniListingBoosts",
  /* Permission cache */
  "sokoniPermCache",
];

/* Non-user infrastructure keys that MUST survive sign-out — everything else in
   local/session storage is treated as user data and wiped. Matched case-insensitively
   as a substring of the key name. */
/* Also preserve the admin LOCK-SCREEN credential hashes (sokoniAdminPinHash /
   PatternHash / PwHash). They are a per-DEVICE second factor the admin sets
   themselves, not user session data — wiping them on sign-out silently locked
   admins out ("No credentials set") and forced a re-setup every time. The
   authoritative admin gate is the Firebase claim, not this hash, so keeping the
   hash is safe. */
const _SOKONI_LS_KEEP = /theme|darkmode|consent|cookie|appcheck|debug|install|onboard|dismiss|locale|printer|hardware|sokoniadmin(pin|pattern|pw)hash/i;

async function sokoniSignOut() {
  /* 1. Stop any registered Firestore listeners so no post-signout snapshot can fire
        into a stale UI. (Belt-and-suspenders — the caller-side redirect/reload also
        tears every listener down.) */
  try {
    if (Array.isArray(window._sokoniListeners)) {
      window._sokoniListeners.forEach(u => { try { if (typeof u === "function") u(); } catch (_) {} });
      window._sokoniListeners = [];
    }
  } catch (_) {}

  /* 2. Firebase sign-out (clears the auth session in IndexedDB). Clear local state
        even if the network call fails. */
  try { await signOut(auth); } catch (e) { /* proceed to wipe regardless */ }

  /* 3. SECURITY — wipe ALL user-specific local/session storage so the NEXT user can
        never see the previous user's wallet, profile, cart, orders or seller data.
        A fixed allow-list always missed keys (cart, _walletBal, sellerProfile, bnb_*,
        b2b_*, chpro_*, permissions, authCache…); this clears everything EXCEPT the
        non-user infra keys above. */
  const _wipe = (store) => {
    try {
      Object.keys(store).forEach(k => {
        if (!_SOKONI_LS_KEEP.test(k)) { try { store.removeItem(k); } catch (_) {} }
      });
    } catch (_) {}
  };
  _wipe(localStorage);
  _wipe(sessionStorage);

  /* 4. Invalidate any in-memory caches (the page reload after this clears the rest). */
  try { if (window.SokoniSubscriptions) window.SokoniSubscriptions.invalidateCache(); } catch (_) {}

  /* 5. HARDENING — purge Firestore's offline IndexedDB so no cached document can
        survive into the next account's session on this device. Firestore's lifecycle
        REQUIRES the instance be terminated before its persistence can be cleared, so
        this is the correct (and only safe) place: it runs LAST, and every
        sokoniSignOut() caller immediately redirects, reloads, or shows a terminal
        session-revoked overlay — so the now-dead `db` instance is never touched again
        and the next page re-initialises Firestore fresh.

        Persistence is currently memory-only (getFirestore default), so this clears
        nothing today — but it completes the security model and future-proofs the
        moment persistentLocalCache is ever enabled, plus removes any legacy on-disk
        cache from an older build. Best-effort and TIME-BOXED (1.5s) so a slow or
        multi-tab-blocked IndexedDB delete can never stall the post-signout redirect;
        clearIndexedDbPersistence throws failed-precondition when another tab still
        holds Firestore open — that is expected and swallowed. */
  try {
    await Promise.race([
      (async () => {
        try { await terminate(db); } catch (_) {}
        try { await clearIndexedDbPersistence(db); } catch (_) {}
      })(),
      new Promise((res) => setTimeout(res, 1500)),
    ]);
  } catch (_) {}
}
window.sokoniSignOut = sokoniSignOut;

/* ══════════════════════════════════════════════════════════════════
   PROFILE UPDATE HELPER
   Use this from any page (profile.js, role selectors, etc.) to keep
   both localStorage and Firestore in sync when profile data changes.

   Usage: await window.sokoniUpdateProfile({ name: "New Name", ... })
══════════════════════════════════════════════════════════════════ */
async function sokoniUpdateProfile(updates) {
  if (!updates || typeof updates !== "object") return;

  /* 1. Update localStorage immediately (synchronous) */
  try {
    const existing = JSON.parse(localStorage.getItem("sokoniUser") || "{}");
    const merged   = Object.assign({}, existing, updates);
    localStorage.setItem("sokoniUser", JSON.stringify(merged));
  } catch (e) { /* ignore */ }

  /* 2. Persist to Firestore if authenticated */
  const currentUser = auth.currentUser;
  if (!currentUser) return;

  try {
    const { doc, updateDoc, serverTimestamp } = await import(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
    );
    await updateDoc(doc(db, "users", currentUser.uid), {
      ...updates,
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    /* localStorage was already updated — Firestore sync is best-effort */
  }
}
window.sokoniUpdateProfile = sokoniUpdateProfile;

/* ── Request permission + get FCM token ── */
async function sokoniRequestPushPermission(vapidKey, opts) {
  if (!messaging || !vapidKey || vapidKey === "YOUR_VAPID_KEY_HERE") return null;

  try {
    /* Browsers only allow a permission prompt from a user gesture. This runs on boot from
       sw-register's _initPushNotifications, so calling requestPermission() unconditionally
       threw "Notification prompting can only be done from a user gesture." on every page —
       a console error on every merchant route, and a prompt the user never asked for.

       On boot we therefore only mint a token when permission was ALREADY granted. The actual
       ask happens from the in-app "Allow Notifications" button, which passes fromGesture. */
    if (Notification.permission !== "granted") {
      if (!(opts && opts.fromGesture)) return null;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return null;
    }

    const swReg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: swReg,
    });

    if (token) {
      localStorage.setItem("sokoni_fcm_token", token);
      try {
        const { doc, setDoc, serverTimestamp } = await import(
          "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
        );
        /* Use auth.currentUser for JWT-verified identity — never localStorage */
        const currentUser = auth.currentUser;
        const platform    = navigator.userAgent.includes("iPhone") ? "ios" :
                            navigator.userAgent.includes("Android") ? "android" : "web";
        if (currentUser?.email) {
          /* Doc ID from verified JWT email — cannot be spoofed via localStorage */
          const safeId = currentUser.email.replace(/[^a-zA-Z0-9]/g, "_");
          await setDoc(doc(db, "fcm_tokens", safeId), {
            token, email: currentUser.email, name: currentUser.displayName || "",
            uid: currentUser.uid,
            updatedAt: serverTimestamp(), platform,
          }, { merge: true });
        }
        /* Save on users/{uid} for Cloud Function fan-out */
        if (currentUser?.uid) {
          await setDoc(doc(db, "users", currentUser.uid), {
            fcmToken: token, fcmPlatform: platform, fcmUpdatedAt: serverTimestamp()
          }, { merge: true });
        }
      } catch (e) {
        if (window.SokoniLogger) window.SokoniLogger.warn("[FCM] Token save failed:", e.message);
      }
      return token;
    }
  } catch (e) {
    console.warn("[SOKONI FCM] getToken failed:", e.message);
  }
  return null;
}

/* ── Listen for foreground messages ── */
function sokoniListenMessages(callback) {
  if (!messaging) return;
  onMessage(messaging, payload => {
    if (callback) callback(payload);
    else {
      const n = payload.notification || {};
      _showSokoniPushToast(n.title || "SOKONI", n.body || "", n.icon, payload.data?.url);
    }
  });
}

/* ── In-app push notification toast ── */
function _showSokoniPushToast(title, body, icon, url) {
  const existing = document.getElementById("sokoniPushToast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id    = "sokoniPushToast";
  toast.style.cssText = `
    position:fixed;top:80px;right:16px;z-index:999999;
    width:min(340px,calc(100vw - 32px));
    background:#111;border:1px solid rgba(113,255,0,0.28);
    border-radius:18px;padding:14px 16px;
    display:flex;align-items:flex-start;gap:12px;
    box-shadow:0 12px 40px rgba(0,0,0,0.6);
    animation:sokoniToastIn 0.35s cubic-bezier(0.34,1.56,0.64,1);
    cursor:${url ? "pointer" : "default"};
    font-family:'Segoe UI',system-ui,sans-serif;
  `;

  /* Use textContent for dynamic values to prevent XSS */
  const style = document.createElement("style");
  style.textContent = "@keyframes sokoniToastIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:translateX(0)}}";

  const img = document.createElement("img");
  img.src    = "assets/sokoni logoo.jpeg"; /* safe default */
  img.style.cssText = "width:40px;height:40px;object-fit:contain;flex-shrink:0;";
  img.onerror = () => { img.src = "assets/sokoni logoo.jpeg"; };
  /* Only set src from icon if it is a same-origin or HTTPS URL */
  if (icon && /^https:\/\//.test(icon)) img.src = icon;

  const textWrap  = document.createElement("div");
  textWrap.style.cssText = "flex:1;min-width:0;";

  const titleEl = document.createElement("div");
  titleEl.style.cssText = "font-size:13px;font-weight:800;color:white;margin-bottom:2px;";
  titleEl.textContent = title; /* textContent — safe */

  const bodyEl = document.createElement("div");
  bodyEl.style.cssText = "font-size:12px;color:rgba(255,255,255,0.55);line-height:1.4;";
  bodyEl.textContent = body; /* textContent — safe */

  const closeBtn = document.createElement("button");
  closeBtn.style.cssText = "background:none;border:none;color:rgba(255,255,255,0.3);font-size:18px;cursor:pointer;flex-shrink:0;padding:0;line-height:1;";
  closeBtn.textContent = "✕";
  closeBtn.onclick = e => { e.stopPropagation(); toast.remove(); };

  textWrap.appendChild(titleEl);
  textWrap.appendChild(bodyEl);
  toast.appendChild(style);
  toast.appendChild(img);
  toast.appendChild(textWrap);
  toast.appendChild(closeBtn);

  if (url) toast.addEventListener("click", e => {
    if (e.target.closest("button")) return;
    /* Allow same-origin relative paths and HTTPS same-host URLs only */
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin === window.location.origin || parsed.protocol === 'https:' && parsed.hostname === window.location.hostname) {
        window.location.href = parsed.href;
      }
    } catch (_) { /* malformed URL — ignore */ }
  });
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity    = "0";
    toast.style.transition = "opacity 0.4s";
    setTimeout(() => toast.remove(), 400);
  }, 6000);
}

/* ══════════════════════════════════════════════════════════════════
   IDLE SESSION TIMEOUT
   Auto-signs out after 30 minutes of inactivity for regular users
   (60 min for admin/superAdmin). Resets on any user interaction.
   Prevents abandoned-session attacks on shared devices.
══════════════════════════════════════════════════════════════════ */
(function _initIdleTimeout() {
  const IDLE_MS_STANDARD = 30 * 60 * 1000; // 30 min
  const IDLE_MS_ADMIN    = 20 * 60 * 1000; // 20 min — tighter window for high-privilege sessions

  let _idleTimer = null;

  function _getIdleLimit() {
    try {
      const u = JSON.parse(localStorage.getItem("sokoniUser") || "{}");
      const isAdmin = u.roles && (u.roles.includes("admin") || u.roles.includes("superAdmin"));
      return isAdmin ? IDLE_MS_ADMIN : IDLE_MS_STANDARD;
    } catch (_) {
      return IDLE_MS_STANDARD;
    }
  }

  function _onTimeout() {
    /* Only timeout if still logged in */
    if (localStorage.getItem("loggedIn") !== "true") return;

    /* Show a toast warning before signing out */
    const toast = document.createElement("div");
    toast.style.cssText = "position:fixed;top:80px;right:16px;z-index:2147483647;width:min(320px,calc(100vw - 32px));background:#1a0000;border:1px solid rgba(255,60,60,0.4);border-radius:16px;padding:14px 16px;font-family:'Segoe UI',system-ui,sans-serif;color:white;box-shadow:0 12px 40px rgba(0,0,0,0.7);";
    toast.textContent = "Session expired due to inactivity. Signing out…";
    document.body && document.body.appendChild(toast);

    setTimeout(async () => {
      toast.remove && toast.remove();
      await sokoniSignOut();
      try {
        sessionStorage.setItem("sokoniLoginRedirect", window.location.pathname.split("/").pop() + (window.location.search || ""));
        sessionStorage.setItem("sokoniSessionExpired", "1");
      } catch (_) {}
      window.location.href = "login.html";
    }, 2000);
  }

  function _resetTimer() {
    if (!_idleTimer) return; /* timer not started — user not logged in */
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(_onTimeout, _getIdleLimit());
  }

  function _startIdleTimer() {
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(_onTimeout, _getIdleLimit());
    /* Bind interaction events */
    ["click", "keydown", "touchstart", "scroll", "mousemove"].forEach(evt => {
      document.removeEventListener(evt, _resetTimer, { passive: true });
      document.addEventListener(evt, _resetTimer, { passive: true });
    });
  }

  function _stopIdleTimer() {
    clearTimeout(_idleTimer);
    _idleTimer = null;
    ["click", "keydown", "touchstart", "scroll", "mousemove"].forEach(evt => {
      document.removeEventListener(evt, _resetTimer, { passive: true });
    });
  }

  /* Start timer on auth state (Firebase onAuthStateChanged calls this) */
  window._sokoniStartIdleTimer = _startIdleTimer;
  window._sokoniStopIdleTimer  = _stopIdleTimer;
})();

/* ── Firestore audit writer (exposed for non-module security.js) ── */
window.sokoniFirestoreAudit = async function(entry = {}) {
  try {
    const { collection, addDoc, serverTimestamp } = await import(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
    );
    await addDoc(collection(db, "auditLogs"), Object.assign({}, entry, {
      serverTs: serverTimestamp()
    }));
  } catch (e) {
    console.warn("[SOKONI] Audit write failed:", e && e.message);
  }
};

export {
  app, auth, db, storage, messaging,
  sokoniRequestPushPermission,
  sokoniListenMessages
};
