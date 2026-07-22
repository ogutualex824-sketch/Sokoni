#!/usr/bin/env node
'use strict';

/**
 * Converge productCounters.maxProducts onto the canonical subscription catalogue.
 *
 * WHY THIS EXISTS
 * canPublishProduct materialises the ceiling into productCounters/{uid} because
 * Firestore rules cannot aggregate — a rule can read one document, so `count`
 * and `maxProducts` must sit together for `count < maxProducts` to be
 * expressible. That cache is correct and stays.
 *
 * THE PREMISE THIS WAS WRITTEN ON WAS WRONG
 * It was built to converge counters stamped by the ten superseded catalogues,
 * on the reasoning that canPublishProduct prefers a cached number when one is
 * present. Production was then measured: productCounters holds ZERO documents.
 * No ceiling has ever been materialised for anyone, so nothing is stale and
 * every merchant already resolves canonically through the live path.
 *
 * The real gap is the opposite one and this script does not close it. Counters
 * do not exist, and the trigger that creates one seeds `count` with an
 * increment of 1 — so the first product a long-standing seller adds records a
 * catalogue of 1 when they hold 116. Seeding the count from the products
 * collection is a separate operation with a commercial decision attached
 * (whether a merchant already past the ceiling is grandfathered), and it is
 * deliberately not folded in here.
 *
 * This script remains correct for what it does: reconcile a ceiling against the
 * catalogue once counters exist. It is currently a no-op against production.
 *
 * DRY RUN IS THE DEFAULT
 * Nothing is written unless --apply is passed. The dry run prints the exact
 * diff it would make, so the change is reviewed before it lands rather than
 * described afterwards.
 *
 * SAMPLE BEFORE SWEEP
 *   node scripts/backfill-product-counters.js --uid <uid>            # inspect one
 *   node scripts/backfill-product-counters.js --uid <uid> --apply    # fix one
 *   node scripts/backfill-product-counters.js                        # diff all
 *   node scripts/backfill-product-counters.js --apply                # converge all
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 * `count`. This script reconciles the ceiling, not the tally. A wrong count is a
 * different defect with a different remedy (recountMarketplaceProducts, which
 * re-aggregates from `products`), and conflating them would mean a ceiling fix
 * silently rewriting inventory figures it never verified.
 */

const admin = require('../functions/node_modules/firebase-admin');

const ARGS    = process.argv.slice(2);
const APPLY   = ARGS.includes('--apply');
const ONE_UID = (ARGS[ARGS.indexOf('--uid') + 1] && ARGS.includes('--uid'))
  ? ARGS[ARGS.indexOf('--uid') + 1] : null;
const LIMIT   = ARGS.includes('--limit') ? Number(ARGS[ARGS.indexOf('--limit') + 1]) : 0;

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';

/* initializeApp runs before product-limit is required: that module calls
   initializeApp itself when no app exists, and would otherwise pick up a
   different project than the one asked for here. */
admin.initializeApp({ projectId: PROJECT });

/* The resolver is imported, never reimplemented. Reproducing the
   override-then-catalogue precedence in this script would make it the twelfth
   plan catalogue — the exact defect the migration exists to end. */
const { resolveMaxProducts } = require('../functions/product-limit')._internal;

const db = admin.firestore();

function fmt(n) {
  if (n === -1)  return 'unlimited';
  if (n == null) return '(absent)';
  return String(n);
}

(async () => {
  console.log('');
  console.log('  productCounters → canonical catalogue');
  console.log('  project ' + PROJECT + '   mode ' + (APPLY ? 'APPLY' : 'DRY RUN (no writes)'));
  console.log('  ' + '─'.repeat(74));

  let docs;
  if (ONE_UID) {
    const snap = await db.collection('productCounters').doc(ONE_UID).get();
    if (!snap.exists) {
      console.log('  No productCounters document for ' + ONE_UID + '.');
      console.log('  That merchant has never had a ceiling materialised, so canPublishProduct');
      console.log('  already resolves them canonically. Nothing to converge.');
      return;
    }
    docs = [snap];
  } else {
    let q = db.collection('productCounters');
    if (LIMIT > 0) q = q.limit(LIMIT);
    docs = (await q.get()).docs;
  }

  console.log('  ' + docs.length + ' counter document(s)\n');

  const rows = [];
  let drift = 0, agreed = 0, failed = 0;

  for (const d of docs) {
    const data   = d.data() || {};
    const cached = typeof data.maxProducts === 'number' ? data.maxProducts : null;

    let canonical, source, version;
    try {
      const r   = await resolveMaxProducts(d.id);
      canonical = r.max; source = r.source; version = r.catalogVersion;
    } catch (e) {
      failed++;
      rows.push({ uid: d.id, cached, canonical: null, verdict: 'RESOLVE FAILED: ' + e.message });
      continue;
    }

    /* An absent ceiling counts as drift: it is resolved live today, but the next
       product write fills it in from whatever _bump happens to resolve, and
       stamping it now records the source and version alongside it. */
    const differs = cached !== canonical;
    if (differs) drift++; else agreed++;

    rows.push({
      uid: d.id, cached, canonical, source, version,
      verdict: differs ? 'DRIFT' : 'agrees',
    });

    if (differs && APPLY) {
      await d.ref.set({
        maxProducts:    canonical,
        source:         source || null,
        catalogVersion: version == null ? null : version,
        backfilledAt:   admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  const shown = rows.filter(r => r.verdict !== 'agrees').slice(0, 40);
  if (shown.length) {
    console.log('  ' + 'uid'.padEnd(30) + 'cached'.padEnd(12) + 'canonical'.padEnd(12) + 'verdict');
    console.log('  ' + '─'.repeat(74));
    shown.forEach(r => console.log('  ' + String(r.uid).padEnd(30) +
      fmt(r.cached).padEnd(12) + fmt(r.canonical).padEnd(12) + r.verdict));
    if (rows.filter(r => r.verdict !== 'agrees').length > shown.length) {
      console.log('  … ' + (rows.filter(r => r.verdict !== 'agrees').length - shown.length) + ' more');
    }
    console.log('');
  }

  console.log('  ' + agreed + ' already canonical   ' + drift + ' drifted   ' + failed + ' unresolvable');
  if (failed) {
    console.log('  Unresolvable counters were LEFT UNCHANGED. A resolution failure is not');
    console.log('  evidence the ceiling is wrong, and overwriting on an error would hand out');
    console.log('  an entitlement no subscription document supports.');
  }
  console.log('');
  if (drift && !APPLY) {
    console.log('  Nothing was written. Re-run with --apply to converge these ' + drift + '.');
  } else if (drift && APPLY) {
    console.log('  ' + drift + ' counter(s) converged onto the canonical catalogue.');
  } else if (!drift) {
    console.log('  Every counter already matches the catalogue. No migration needed.');
  }
  console.log('');
})().catch(e => {
  console.error('\n  FAILED: ' + (e.code ? e.code + ' ' : '') + e.message);
  if (String(e.message).includes('invalid_client') || e.code === 2 || e.code === 16) {
    console.error('  Application Default Credentials are not usable. Run:');
    console.error('    gcloud auth application-default login');
  }
  process.exit(1);
});
