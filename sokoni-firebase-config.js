/* ══════════════════════════════════════════════════════════════════
   CANONICAL FIREBASE CONFIG — ES MODULE

   WHY THIS FILE EXISTS (P0, 2026-07-18).
   The POS/admin pages initialised Firebase from `window._sokoniConfig` — a global that was
   NEVER defined anywhere. `initializeApp(window._sokoniConfig || {})` therefore ran with an
   empty object, and Auth / Firestore / Storage / callable Functions were dead on all of them
   with `auth/invalid-api-key`.

   The first fix published the config as a global from sokoni-config.js (a classic script).
   That worked on the three compat-SDK pages but NOT on the eight module-SDK pages: on those,
   the `<script src="sokoni-config.js">` tag is FETCHED (HTTP 200) but never executed — it is
   absent from document.outerHTML entirely. Those documents declare `<meta charset>` roughly
   31KB in, long after the first script tag, which forces the HTML parser to restart; the
   speculative preload has already issued the request, but the tag is discarded on re-parse.

   An ES module import does not depend on the HTML parser surviving that restart — it is
   resolved by the module loader from inside the module graph. That is why the config lives
   here as a module export.

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
