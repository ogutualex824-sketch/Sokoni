/**
 * scripts/seed-health-provider.js
 *
 * Seeds ONE approved (status: 'active') healthProviders document so the
 * appointment flow can be validated end to end.
 *
 * WHY THIS IS NEEDED
 * bookAppointment (functions/healthcare-hub.js) refuses to book unless the
 * target provider exists AND has status === 'active'. Providers normally
 * self-register via registerHealthProvider (which writes status 'pending') and
 * an admin approves them via approveHealthProvider. With neither having run in
 * production there is no bookable provider, so the booking screen correctly
 * reports "provider not available" — which reads like a bug but is missing
 * data. This script supplies that data.
 *
 * The document shape is copied field-for-field from registerHealthProvider +
 * approveHealthProvider, so a seeded provider is indistinguishable from a real
 * approved one. If those CFs change, change this too.
 *
 * CREDENTIALS
 * Firestore REST with the gcloud CLI access token, matching the established
 * pattern in scripts/backfill-search-terms.js (the Admin SDK's ADC is unusable
 * on this machine — invalid_client). Additive: it creates or updates exactly
 * one document and never deletes.
 *
 *   node scripts/seed-health-provider.js                 # dry run — prints the doc
 *   node scripts/seed-health-provider.js --apply         # write it
 *   GCLOUD_ACCESS_TOKEN=... node scripts/seed-health-provider.js --apply   # CI
 *
 * Optional overrides:
 *   --id=<docId>  --name="..."  --spec=general_practice  --fee=1500  --city=Nairobi
 */
'use strict';

const https = require('https');
const { execSync } = require('child_process');

const APPLY   = process.argv.includes('--apply');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const HOST    = 'firestore.googleapis.com';
const BASE    = '/v1/projects/' + PROJECT + '/databases/(default)/documents';

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};

/* Must be one of SPECIALIZATIONS in functions/healthcare-hub.js */
const VALID_SPEC = [
  'general_practice', 'pediatrics', 'obstetrics', 'cardiology', 'dermatology',
  'dentistry', 'ophthalmology', 'orthopedics', 'psychiatry', 'physiotherapy',
  'nutrition', 'pharmacy', 'laboratory', 'radiology', 'oncology', 'other',
];

const DOC_ID = arg('id', 'seed-provider-general-001');
const NAME   = arg('name', 'Dr. Amina Wanjiru');
const SPEC   = arg('spec', 'general_practice');
const FEE    = Number(arg('fee', '1500'));
const CITY   = arg('city', 'Nairobi');

if (!VALID_SPEC.includes(SPEC)) {
  console.error('  invalid --spec. One of: ' + VALID_SPEC.join(', '));
  process.exit(1);
}

function token() {
  if (process.env.GCLOUD_ACCESS_TOKEN) return process.env.GCLOUD_ACCESS_TOKEN.trim();
  return execSync('gcloud auth print-access-token',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/* Resolved lazily so a dry run needs no credentials at all. */
let TOK = null;
const authToken = () => (TOK || (TOK = token()));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign(
      { Authorization: 'Bearer ' + authToken() },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    );
    const r = https.request({ host: HOST, path, method, headers }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(res.statusCode + ' ' + out.slice(0, 400)));
        resolve(out ? JSON.parse(out) : {});
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* Firestore REST typed-value encoding */
const S = v => ({ stringValue: String(v) });
const I = v => ({ integerValue: String(v) });
const D = v => ({ doubleValue: v });
const B = v => ({ booleanValue: Boolean(v) });
const T = v => ({ timestampValue: v });
const A = arr => ({ arrayValue: { values: arr.map(S) } });

const NOW = new Date().toISOString();

/* Mirrors registerHealthProvider's write, then approveHealthProvider's update. */
const FIELDS = {
  providerId:            S(DOC_ID),
  uid:                   S(DOC_ID),
  name:                  S(NAME),
  specialization:        S(SPEC),
  bio:                   S('Seeded provider for release-acceptance testing of the appointment flow.'),
  qualifications:        S('MBChB, University of Nairobi'),
  licenseNumber:         S('SEED-LIC-0001'),
  clinic:                S('SOKONI Demo Clinic'),
  address:               S('Kenyatta Avenue'),
  city:                  S(CITY),
  county:                S(CITY),
  country:               S('Kenya'),
  phone:                 S('0700000000'),
  consultationFee:       D(FEE),
  currency:              S('KES'),
  languages:             A(['English', 'Swahili']),
  insuranceAccepted:     { arrayValue: { values: [] } },
  isOnline:              B(true),
  /* approveHealthProvider's effect — this is what makes it bookable */
  status:                S('active'),
  reviewedBy:            S('seed-script'),
  reviewedAt:            T(NOW),
  reviewNotes:           S('Seeded as approved for beta validation'),
  rating:                D(0),
  ratingCount:           I(0),
  totalAppointments:     I(0),
  completedAppointments: I(0),
  isAvailable:           B(true),
  isSeed:                B(true),   /* so it can be found and removed later */
  createdAt:             T(NOW),
  updatedAt:             T(NOW),
};

(async () => {
  console.log('\n  Seed health provider   project ' + PROJECT +
              '   mode ' + (APPLY ? 'APPLY' : 'DRY RUN'));
  console.log('  doc: healthProviders/' + DOC_ID);
  console.log('  ' + NAME + '  ·  ' + SPEC + '  ·  KES ' + FEE + '  ·  ' + CITY + '  ·  status=active\n');

  if (!APPLY) {
    console.log('  dry run — nothing written. Re-run with --apply to seed.\n');
    return;
  }

  const path = BASE + '/healthProviders/' + encodeURIComponent(DOC_ID);
  await req('PATCH', path, { fields: FIELDS });
  console.log('  seeded. Verifying…');

  const got = await req('GET', path);
  const st = got.fields && got.fields.status && got.fields.status.stringValue;
  console.log('  read back: status=' + st +
              '  name=' + (got.fields.name && got.fields.name.stringValue));
  console.log(st === 'active'
    ? '\n  OK — this provider is now bookable via bookAppointment.\n'
    : '\n  WARNING — status is not "active"; bookAppointment will refuse it.\n');
})().catch(e => {
  console.error('\n  failed: ' + e.message);
  console.error('  If this is a credentials error, run:  gcloud auth login\n');
  process.exit(1);
});
