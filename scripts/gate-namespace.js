/* ══════════════════════════════════════════════════════════════════════════════
   PER-SUITE EMULATOR NAMESPACE
   ------------------------------------------------------------------------------
   Every emulator-backed suite already declares its own project id — but only as a
   fallback:

       process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-wishlist-47-test';

   `firebase emulators:exec` injects GCLOUD_PROJECT (measured: "sokoni-aeb26"), so
   that fallback never fires. Every suite therefore initialises admin against the
   SAME project, and the Firestore/Auth emulators key their data by project — so all
   156 suites share one namespace. The runner also runs up to 6 suites at once, so
   they do not merely inherit each other's leftovers, they race.

   That is why three suites pass standalone and fail inside the gate:

       test-wishlist-marketplace      28/0 standalone   FAIL in gate
       test-wishlist-market-actions   35/0 standalone   FAIL in gate
       test-auth-email-challenge      63/0 standalone   FAIL in gate

   Suites that assert on GLOBAL state cannot survive a neighbour. test-wishlist-phase47
   case E asserts the whole wishlistItems collection is empty; once any other wishlist
   suite has written a document, that assertion is false for a reason that has nothing
   to do with the code under test.

   THE FIX IS A NAMESPACE, NOT A CLEANUP. A reset between suites would still be wrong
   here, because the runner is concurrent: suite B's reset would delete suite A's data
   mid-run. Giving each suite its own project id isolates by construction — no teardown,
   no ordering rule, and correct under concurrency. It also needs no change to any suite:
   the suites already read GCLOUD_PROJECT, they were simply being overridden.

   INVARIANT: a suite's result must not depend on which suites ran before it.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');

/* A GCP project id is <= 30 chars, lowercase alphanumerics and hyphens, starting
   with a letter. The emulators are lenient, but staying inside the real rule keeps
   these ids usable anywhere and keeps long suite names from colliding after the
   truncation: the 6-hex suffix is taken from the FULL file name, so two suites that
   truncate to the same prefix still land in different namespaces. */
function suiteNamespace(file) {
  const base = String(file)
    .replace(/^test-/, '')
    .replace(/\.js$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const hash = crypto.createHash('sha1').update(String(file)).digest('hex').slice(0, 6);
  return ('gate-' + base).slice(0, 23).replace(/-$/, '') + '-' + hash;
}

/* The environment a suite must be spawned with. Everything the parent has, plus a
   namespace the suite cannot be talked out of.

   GCLOUD_PROJECT is what firebase-admin reads. GOOGLE_CLOUD_PROJECT is the newer
   spelling some libraries prefer, set to the same value so a suite cannot end up
   half in one namespace and half in another. FIREBASE_CONFIG, when the CLI injects
   it, carries its own projectId and would silently win for a bare initializeApp() —
   so its projectId is rewritten rather than deleted, which would break any suite
   relying on the rest of that blob. */
function suiteEnv(file, parentEnv) {
  const src = parentEnv || process.env;
  const ns = suiteNamespace(file);
  const env = { ...src, NODE_ENV: 'test', GCLOUD_PROJECT: ns, GOOGLE_CLOUD_PROJECT: ns };

  if (src.FIREBASE_CONFIG) {
    try {
      const cfg = JSON.parse(src.FIREBASE_CONFIG);
      cfg.projectId = ns;
      env.FIREBASE_CONFIG = JSON.stringify(cfg);
    } catch (e) {
      /* Not JSON — leave it exactly as found rather than guess at its shape. */
    }
  }
  return env;
}

module.exports = { suiteNamespace, suiteEnv };
