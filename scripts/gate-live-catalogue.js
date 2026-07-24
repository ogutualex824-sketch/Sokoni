#!/usr/bin/env node
/**
 * RELEASE GATE — LIVE CATALOGUE
 *
 * Answers one binary question with production telemetry rather than inference:
 *
 *     Do legitimate clients receive the live catalogue?
 *
 * WHY THIS DOES NOT USE A BROWSER
 * -------------------------------
 * Every browser this project can drive — headless or headed Playwright — is
 * classified as automation by reCAPTCHA v3 and denied by App Check. Two separate
 * conclusions in this repo were withdrawn after being built on that probe effect:
 * once when deployed Firestore rules were called "wrong", and once when App Check
 * was called "broken platform-wide". In both cases the tool was the failing client,
 * not the platform.
 *
 * So this gate reads what REAL users already produced:
 *
 *   - App Check verification counts, split by target service. App Check is only
 *     evaluated for CLIENT SDK traffic; Cloud Functions use the Admin SDK and
 *     bypass it entirely. A VALID/ALLOW against firestore.googleapis.com is
 *     therefore proof that a real browser completed attestation and was authorised
 *     to reach Firestore.
 *   - Firestore document read volume, to confirm the data path is actually moving.
 *   - The catalogue itself via the Admin SDK, to confirm there is inventory to serve.
 *
 * PASS / FAIL / BLOCKED are never conflated. BLOCKED means the gate could not
 * obtain evidence (missing credentials, API disabled) and is NOT a pass.
 *
 * Usage:  node scripts/gate-live-catalogue.js [--hours 24] [--json]
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { GoogleAuth } = require(path.join(ROOT, 'functions/node_modules/google-auth-library'));
const admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));

const PROJECT = 'sokoni-aeb26';
const args = process.argv.slice(2);
const HOURS = parseInt((args.find(a => a.startsWith('--hours')) || '').split('=')[1] || args[args.indexOf('--hours') + 1] || '24', 10);
const JSON_OUT = args.includes('--json');

/* Thresholds. Deliberately conservative: the gate should catch "the catalogue is
   dark", not police day-to-day traffic variance. */
const MIN_VALID_FIRESTORE = 1;     /* at least one real client authorised to Firestore */
const MIN_READS           = 1;     /* documents actually moving */
const MAX_DENY_RATIO      = 0.50;  /* over half of client traffic denied = degraded */

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  if (!JSON_OUT) {
    const tag = status === 'PASS' ? 'PASS   ' : status === 'FAIL' ? 'FAIL   ' : 'BLOCKED';
    console.log(`${tag} ${name}${detail ? '  — ' + detail : ''}`);
  }
};

async function timeSeries(client, metricType, hours, periodSec) {
  const end = new Date();
  const start = new Date(Date.now() - hours * 3600 * 1000);
  const url = 'https://monitoring.googleapis.com/v3/projects/' + PROJECT + '/timeSeries'
    + '?filter=' + encodeURIComponent(`metric.type="${metricType}"`)
    + '&interval.startTime=' + start.toISOString()
    + '&interval.endTime=' + end.toISOString()
    + `&aggregation.alignmentPeriod=${periodSec}s&aggregation.perSeriesAligner=ALIGN_SUM`;
  const r = await client.request({ url });
  return r.data.timeSeries || [];
}

const sumPoints = (s) => (s.points || [])
  .reduce((a, p) => a + Number(p.value.int64Value || p.value.doubleValue || 0), 0);

(async () => {
  let monitoring = null;
  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/monitoring.read'] });
    monitoring = await auth.getClient();
  } catch (e) {
    record('Cloud Monitoring credentials', 'BLOCKED', e.message.split('\n')[0]);
  }

  /* ── 1. App Check: are real clients authorised to reach Firestore? ────── */
  let validFs = 0, deniedFs = 0;
  if (monitoring) {
    try {
      const ts = await timeSeries(monitoring,
        'firebaseappcheck.googleapis.com/services/verification_count', HOURS, 86400);
      for (const s of ts) {
        const svc = (s.resource && s.resource.labels && s.resource.labels.service_id) || '';
        if (svc !== 'firestore.googleapis.com') continue;
        const m = s.metric.labels || {};
        const n = sumPoints(s);
        if (m.result === 'ALLOW' && m.security === 'VALID') validFs += n;
        else if (m.result === 'DENY') deniedFs += n;
      }
      record('App Check accepted for a real client (Firestore)',
        validFs >= MIN_VALID_FIRESTORE ? 'PASS' : 'FAIL',
        `VALID/ALLOW=${validFs} DENY=${deniedFs} over ${HOURS}h`);

      const total = validFs + deniedFs;
      const ratio = total ? deniedFs / total : 0;
      record('Client denial rate within tolerance',
        total === 0 ? 'BLOCKED' : (ratio <= MAX_DENY_RATIO ? 'PASS' : 'FAIL'),
        total === 0 ? 'no client traffic observed' : `${(ratio * 100).toFixed(1)}% denied (limit ${MAX_DENY_RATIO * 100}%)`);
    } catch (e) {
      record('App Check accepted for a real client (Firestore)', 'BLOCKED', e.message.split('\n')[0]);
    }

    /* ── 2. Is the data path actually moving documents? ─────────────────── */
    try {
      const ts = await timeSeries(monitoring, 'firestore.googleapis.com/document/read_count', HOURS, 86400);
      const reads = ts.reduce((a, s) => a + sumPoints(s), 0);
      record('Firestore document reads observed',
        reads >= MIN_READS ? 'PASS' : 'FAIL', `${reads} reads over ${HOURS}h`);
    } catch (e) {
      record('Firestore document reads observed', 'BLOCKED', e.message.split('\n')[0]);
    }
  }

  /* ── 3. Is there a catalogue to serve, and is it free of demo data? ───── */
  try {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    const snap = await admin.firestore().collection('products').get();
    const active = snap.docs.filter(d => (d.data().status || 'active') === 'active').length;
    record('Catalogue has active products', active > 0 ? 'PASS' : 'FAIL',
      `${active} active of ${snap.size} total`);

    /* FALLBACK_PRODUCTS use F1..F30 / G1..G2 ids. A real document with one of
       those ids would mean demo data had been written into production. */
    const demo = snap.docs.filter(d => /^[FG]\d{1,2}$/.test(d.id)).length;
    record('No demo products in the live catalogue', demo === 0 ? 'PASS' : 'FAIL',
      `${demo} demo-shaped ids`);
  } catch (e) {
    record('Catalogue has active products', 'BLOCKED', (e.code || e.message.split('\n')[0]));
  }

  const fail = results.filter(r => r.status === 'FAIL');
  const blocked = results.filter(r => r.status === 'BLOCKED');
  const verdict = fail.length ? 'FAIL' : blocked.length ? 'BLOCKED' : 'PASS';

  if (JSON_OUT) {
    console.log(JSON.stringify({ gate: 'live-catalogue', verdict, hours: HOURS, results }, null, 1));
  } else {
    console.log('\nGATE: ' + verdict +
      (verdict === 'BLOCKED' ? '  (evidence unavailable — this is NOT a pass)' : ''));
  }
  process.exit(verdict === 'PASS' ? 0 : 1);
})();
