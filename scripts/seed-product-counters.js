#!/usr/bin/env node
'use strict';

/**
 * Seed productCounters from the products collection, once.
 *
 * WHY
 * productCounters is empty in production — measured 2026-07-22, zero documents.
 * The counter is created by a trigger on a seller's next product write, and
 * that trigger seeds `count` with an increment of 1. So the first listing a
 * long-standing seller adds records a catalogue of 1 against a real catalogue
 * of 116, and the ceiling starts enforcing against a number that was never true.
 *
 * The rule fails open while the counter is absent, so nothing is broken today.
 * It starts being wrong the moment the first counter appears, which is why this
 * runs before that happens rather than after.
 *
 * GRANDFATHERING
 * A seller already past their plan allowance keeps what they published. The
 * ceiling is set to their current count plus the catalogue allowance, so the cap
 * governs growth from today instead of retroactively blocking inventory created
 * when no cap existed. The floor is persisted as `grandfatheredFloor` and
 * honoured by syncLimit — without that, the first subscription change would
 * resolve the catalogue value, overwrite the ceiling and lock the seller out.
 *
 * A seller under their allowance is seeded normally and gets no floor.
 *
 * CREDENTIALS
 * Application Default Credentials are unusable on this machine (invalid_client
 * against a stale refresh token). The gcloud CLI credential is a separate store
 * and works, so the token is taken from there. firebase-admin accepts any object
 * with getAccessToken(), which is all a bearer token needs to be.
 *
 *   node scripts/seed-product-counters.js            # dry run, writes nothing
 *   node scripts/seed-product-counters.js --apply    # seed
 *   node scripts/seed-product-counters.js --uid <u>  # one seller
 */

const { execSync } = require('child_process');
const admin = require('../functions/node_modules/firebase-admin');

const ARGS  = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const ONE   = ARGS.includes('--uid') ? ARGS[ARGS.indexOf('--uid') + 1] : null;
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';

/* execSync, not execFileSync: gcloud on Windows is a .cmd shim, and Node
   refuses to spawn one without a shell (EINVAL). GCLOUD_ACCESS_TOKEN short-
   circuits the whole thing for environments where the CLI is absent — CI, or a
   machine where gcloud needs CLOUDSDK_PYTHON set to find its interpreter. */
function gcloudToken() {
  if (process.env.GCLOUD_ACCESS_TOKEN) return process.env.GCLOUD_ACCESS_TOKEN.trim();
  return execSync('gcloud auth print-access-token', {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/* A bearer token is enough for most Admin SDK services and NOT enough for
   Firestore: getFirestoreOptions accepts only a service-account, compute-engine
   or refresh-token credential and rejects anything else, however valid the
   token it produces. Passing one anyway fails deep inside a require() with a
   stack trace that names firestore-internal.js and not the cause, so the
   condition is detected here and explained instead. */
admin.initializeApp({ projectId: PROJECT });

/* admin.firestore() constructs lazily and succeeds against credentials it will
   later refuse, so the check has to be a real round trip. One read, before any
   work is planned — a migration that discovers its credentials halfway through
   is a migration that half-applied. */
async function preflight() {
  try {
    await admin.firestore().collection('productCounters').limit(1).get();
    return true;
  } catch (e) {
    const tokenWorks = (() => { try { return gcloudToken().length > 50; } catch (_) { return false; } })();
    console.error('');
    console.error('  Firestore will not accept the available credentials.');
    console.error('  ' + '─'.repeat(74));
    console.error('  gcloud CLI credential : ' + (tokenWorks ? 'WORKS — mints tokens, roles/owner' : 'unusable'));
    console.error('  Application Default   : unusable — ' + (e.message || '').slice(0, 60));
    console.error('');
    console.error('  The Admin SDK reads ADC specifically. A CLI bearer token is sufficient for');
    console.error('  the Firestore REST API but not for this client, which accepts only a');
    console.error('  service account, a compute-engine identity, or a valid refresh token.');
    console.error('');
    console.error('  Two ways forward:');
    console.error('    1. gcloud auth application-default login    (interactive, ~30s, no code change)');
    console.error('    2. run the seed server-side as an admin-gated callable, where the runtime');
    console.error('       already holds a service identity and no key touches this machine');
    console.error('');
    return false;
  }
}

const { resolveMaxProducts } = require('../functions/product-limit')._internal;
const db = admin.firestore();
const F  = admin.firestore.FieldValue;

const fmt = n => (n === -1 ? 'unlimited' : String(n));

(async () => {
  if (!(await preflight())) { process.exitCode = 1; return; }

  console.log('');
  console.log('  seed productCounters from products');
  console.log('  project ' + PROJECT + '   mode ' + (APPLY ? 'APPLY' : 'DRY RUN (no writes)'));
  console.log('  ' + '─'.repeat(78));

  /* Paginated rather than a single read. 119 products would fit in one page
     today; a migration script that only works at today's size is one that gets
     re-debugged the next time it is needed. */
  const owners = new Map();
  let scanned = 0, orphans = 0, cursor = null;

  for (;;) {
    let q = db.collection('products').orderBy('__name__').limit(500);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) break;
    page.forEach(d => {
      scanned++;
      const uid = d.data().sellerUid;
      if (!uid) { orphans++; return; }
      owners.set(uid, (owners.get(uid) || 0) + 1);
    });
    cursor = page.docs[page.docs.length - 1];
    if (page.size < 500) break;
  }

  console.log('  scanned ' + scanned + ' products   ' + owners.size + ' distinct sellers' +
              (orphans ? '   ' + orphans + ' with no sellerUid (skipped)' : ''));
  if (orphans) {
    console.log('  Products without a sellerUid cannot be attributed to a counter. They are');
    console.log('  left alone — guessing an owner would corrupt someone else\'s ceiling.');
  }
  console.log('');

  const targets = ONE ? [[ONE, owners.get(ONE) || 0]] : [...owners.entries()];
  if (ONE && !owners.has(ONE)) {
    console.log('  ' + ONE + ' owns no products. Seeding a count of 0 is still correct.');
  }

  console.log('  ' + 'seller'.padEnd(30) + 'count'.padEnd(8) + 'catalogue'.padEnd(12) +
              'ceiling'.padEnd(12) + 'note');
  console.log('  ' + '─'.repeat(78));

  let seeded = 0, grandfathered = 0, skipped = 0;

  for (const [uid, count] of targets) {
    const existing = await db.collection('productCounters').doc(uid).get();
    if (existing.exists) {
      console.log('  ' + uid.slice(0, 28).padEnd(30) + String(count).padEnd(8) +
                  '-'.padEnd(12) + '-'.padEnd(12) + 'already seeded — left alone');
      skipped++;
      continue;
    }

    const { max, status, source, catalogVersion } = await resolveMaxProducts(uid);

    /* Unlimited needs no floor, and a seller inside their allowance needs none
       either — a floor there would quietly raise the cap for someone the cap
       has never applied to. */
    const needsFloor = max !== -1 && count >= max;
    const floor      = needsFloor ? count + max : null;
    const ceiling    = needsFloor ? floor : max;

    console.log('  ' + uid.slice(0, 28).padEnd(30) + String(count).padEnd(8) +
                fmt(max).padEnd(12) + fmt(ceiling).padEnd(12) +
                (needsFloor ? 'GRANDFATHERED (was over by ' + (count - max) + ')' : ''));

    if (needsFloor) grandfathered++;

    if (APPLY) {
      await db.collection('productCounters').doc(uid).set({
        uid, count,
        maxProducts:    ceiling,
        catalogMax:     max,
        grandfatheredFloor: floor,
        status, source: source || null,
        catalogVersion: catalogVersion == null ? null : catalogVersion,
        seededAt:  F.serverTimestamp(),
        updatedAt: F.serverTimestamp(),
      }, { merge: true });
      seeded++;
    }
  }

  console.log('');
  console.log('  ' + targets.length + ' seller(s)   ' + grandfathered + ' grandfathered   ' +
              skipped + ' already seeded');
  if (!APPLY) {
    console.log('  Nothing was written. Re-run with --apply to seed.');
  } else {
    console.log('  ' + seeded + ' counter(s) written.');
    console.log('  Enforcement is now live for these sellers — the rule stops failing open');
    console.log('  the moment a counter exists.');
  }
  console.log('');
})().catch(e => {
  console.error('\n  FAILED: ' + (e.code ? e.code + ' ' : '') + e.message + '\n');
  process.exit(1);
});
