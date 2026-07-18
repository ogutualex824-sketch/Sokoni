/* ══════════════════════════════════════════════════════════════════
   CANONICAL FIREBASE CONFIG — ES MODULE

   WHY THIS FILE EXISTS (P0, 2026-07-18).

   CONFIRMED ROOT CAUSE. The POS/admin pages initialised Firebase from `window._sokoniConfig` —
   a global that was NEVER defined anywhere. `initializeApp(window._sokoniConfig || {})`
   (pos-hq.html:645 at 2cdbe8b~1) therefore ran with an empty object, and Auth / Firestore /
   Storage / callable Functions were dead on all of them with `auth/invalid-api-key`.
   Evidence: `git grep 'window._sokoniConfig ='` returns zero assignments, before the fix
   and after. The global never existed. That defect is real and this file resolves it.

   CORRECTION, 2026-07-18 — a previous version of this comment claimed the config script was
   "fetched but never executed" because a late `<meta charset>` forced an HTML parser restart
   that discarded the speculatively-preloaded tag. THAT EXPLANATION IS WITHDRAWN. It rested on
   a DOM probe that did not assert which URL it had landed on: the POS/admin pages are
   RBAC-gated and redirect unauthenticated sessions to /login, so the probe inspected the login
   page's DOM — which legitimately contains no sokoni-config.js tag — and misread that absence
   as a parse failure. Controlled re-test: /pos-setup reached via redirect from /pos produced
   82 aborted requests while the SAME file loaded directly produced 2, and document.characterSet
   resolved to UTF-8 on every page tested. A byte-identical file cannot restart the parser in
   one case and not the other; the aborts were navigation cancellation. pos.html and
   checkout.html additionally begin with a UTF-8 BOM, which outranks <meta charset> entirely.

   WHY THE MODULE FORM IS RETAINED. Not as a parser workaround — that premise is gone. It is
   kept because a single exported constant, imported through the module graph, gives one
   authoritative source with no load-order dependency between a classic script and the module
   that consumes it. That property is worth keeping on its own merits.

   NOT VERIFIED: whether the classic-script global form would also have worked on the eight
   module-SDK pages. Confirming that needs an authenticated session on those RBAC-gated pages,
   which has not been run. Do not restate the parser-restart claim without that evidence.

   VALUES MUST MATCH firebase.js:48-63 and sokoni-config.js EXACTLY.
   scripts/verify-firebase-config.js fails the build if any of the three ever drift.
══════════════════════════════════════════════════════════════════ */

export const firebaseConfig = {
  apiKey:            "AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",
  authDomain:        "auth.mysokoni.co.ke",
  projectId:         "sokoni-aeb26",
  storageBucket:     "sokoni-aeb26.firebasestorage.app",
  messagingSenderId: "24799054989",
  appId:             "1:24799054989:web:e1cf6ca8c281bf1abf26c4",
  measurementId:     "G-QT32H65TJS"
};

/* Also expose it as a global so the compat-SDK pages and any late script can read one source. */
if (typeof window !== 'undefined') window.SOKONI_FIREBASE_CONFIG = firebaseConfig;

export default firebaseConfig;
