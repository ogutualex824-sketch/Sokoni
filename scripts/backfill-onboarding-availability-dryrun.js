'use strict';
/* ============================================================================
   SOKONI — Legacy Onboarding Availability Reconciliation  (DRY-RUN, ZERO WRITES)
   docs/BOOKING_CONVERGENCE.md — Phase D2b follow-up.

   Before D2b, onboarding publish wrote availability as a RAW simple form
   (`{days, from, to, breakFrom, breakTo, leadTime, emergency}`) with no
   `schedule`/`appt`/`modes` — so those providers are unbookable by the
   authoritative engine until they save through the canonical editor. D2b fixes
   the GO-FORWARD path; this script REPORTS the providers left in the legacy shape
   so a human can decide whether a one-time reconciliation is needed. NO writes.

   A backfill, if approved, would re-project each legacy doc through the SAME
   canonical pipeline the adapter uses: normalizeAvailabilityConfig(
     _onboardingAvailabilityToConfig({ availability: <legacy doc>, bookings: <providerSettings> })).

   Run against production (ADC):  node scripts/backfill-onboarding-availability-dryrun.js
   Emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-sokoni node scripts/backfill-onboarding-availability-dryrun.js
   Optional --json for machine-readable rows.
   ========================================================================== */
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const { _onboardingAvailabilityToConfig } = require(path.join(__dirname, '..', 'functions', 'provider-onboarding'));
const { normalizeAvailabilityConfig } = require(path.join(__dirname, '..', 'functions', 'availability'));
const asJson = process.argv.includes('--json');

/* Canonical iff the doc carries the schema the engine reads. */
const isCanonical = (d) => !!(d && d.schedule && typeof d.schedule === 'object' &&
  Object.keys(d.schedule).length && Array.isArray(d.modes) && d.modes.length && d.appt);
/* Legacy-raw iff it looks like the onboarding simple form and is NOT canonical. */
const isLegacyRaw = (d) => !isCanonical(d) && !!(d && (Array.isArray(d.days) || d.from || d.to));

(async () => {
  const snap = await db.collection('providerAvailability').limit(5000).get();
  const rows = [];
  let canonical = 0, candidates = 0, review = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    const uid = doc.id;
    const createdAt = d.createdAt && d.createdAt.toDate ? d.createdAt.toDate().toISOString().slice(0, 10) : null;
    let disposition, projectionDiffers, proposed = null;

    if (isCanonical(d)) {
      disposition = 'already-canonical'; projectionDiffers = false; canonical++;
    } else if (isLegacyRaw(d)) {
      disposition = 'backfill-candidate'; projectionDiffers = true; candidates++;
      try {
        const settings = (await db.collection('providerSettings').doc(uid).get()).data() || {};
        const cfg = normalizeAvailabilityConfig(_onboardingAvailabilityToConfig({ availability: d, bookings: settings }), uid);
        const openDays = Object.keys(cfg.schedule).filter(k => cfg.schedule[k] && !cfg.schedule[k].closed);
        proposed = { modes: cfg.modes, openDays, durationMins: cfg.appt.durationMins, minNoticeHours: cfg.appt.minNoticeHours };
      } catch (e) { proposed = { error: e.message }; }
    } else {
      disposition = 'review (empty/unknown shape)'; projectionDiffers = null; review++;
    }
    rows.push({ uid, createdAt, alreadyCanonical: isCanonical(d), projectionDiffers, disposition, proposed });
  }

  if (asJson) { console.log(JSON.stringify({ count: rows.length, rows }, null, 2)); }
  else {
    console.log('\n=== LEGACY ONBOARDING AVAILABILITY — DRY RUN (no writes) ===\n');
    if (!rows.length) console.log('No providerAvailability docs found.');
    const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
    if (rows.length) {
      console.log(pad('providerUid', 26), pad('onboardedAt', 12), pad('canonical?', 11), pad('differs?', 9), pad('disposition', 30), 'proposed');
      console.log('-'.repeat(120));
      for (const r of rows) {
        console.log(pad(r.uid, 26), pad(r.createdAt || '—', 12), pad(r.alreadyCanonical ? 'yes' : 'no', 11),
          pad(r.projectionDiffers == null ? '—' : (r.projectionDiffers ? 'yes' : 'no'), 9), pad(r.disposition, 30),
          r.proposed ? `open=${(r.proposed.openDays || []).length}d dur=${r.proposed.durationMins} notice=${r.proposed.minNoticeHours}h` : '');
      }
    }
    console.log('\n--- SUMMARY ---');
    console.log(`  providerAvailability docs:    ${rows.length}`);
    console.log(`  already canonical (skip):     ${canonical}`);
    console.log(`  backfill candidates (legacy): ${candidates}`);
    console.log(`  review (unknown shape):       ${review}`);
    console.log('\nDRY RUN — no documents were written. Backfill execution requires explicit approval.\n');
  }
  process.exit(0);
})().catch((e) => { console.error('dry-run error:', e && e.stack || e); process.exit(1); });
