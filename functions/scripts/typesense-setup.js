'use strict';
/**
 * SOKONI — Typesense One-Time Setup Script
 *
 * Does two things in sequence:
 *   1. typesenseCreateCollections — creates all 25 Typesense collection schemas
 *      and wires Kenyan synonyms.
 *   2. typesenseBackfill — reads each Firestore collection and pushes documents
 *      into Typesense in 500-doc pages.
 *
 * Prerequisites:
 *   a) Functions deployed:  firebase deploy --only functions
 *   b) Admin user exists in Firebase Auth with  admin: true  custom claim.
 *   c) TYPESENSE_ADMIN_KEY secret set in Secret Manager.
 *
 * Run:
 *   $env:FIREBASE_EMAIL="your-admin@email.com"
 *   $env:FIREBASE_PASSWORD="your-admin-password"
 *   node functions/scripts/typesense-setup.js
 *
 * OR pass flags:
 *   node functions/scripts/typesense-setup.js --email admin@example.com --password secret
 *
 * Optional: only backfill specific collections:
 *   node functions/scripts/typesense-setup.js --collections products,sellers,providers
 */

const https  = require('https');
const http   = require('http');

/* ── Config ─────────────────────────────────────────────────────── */
const PROJECT  = 'sokoni-aeb26';
const REGION   = 'us-central1';
const CF_BASE  = `https://${REGION}-${PROJECT}.cloudfunctions.net`;
const AUTH_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';

/* Web API key — public, visible in firebase.js. Used only for the sign-in step. */
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';

/* Firestore collections to backfill, in recommended order */
const ALL_COLLECTIONS = [
  'products',
  'sellers',
  'providers',
  'services',
  'events',
  'cars',
  'jobs',
  'digitalJobs',
  'propertyListings',
  'lawyers',
  'education',
  'reviews',
  'users',
  'categories',
  'brands',
];

/* ── CLI args ─────────────────────────────────────────────────────── */
function _arg(name) {
  const flag = `--${name}`;
  const idx  = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const EMAIL       = _arg('email')    || process.env.FIREBASE_EMAIL    || '';
const PASSWORD    = _arg('password') || process.env.FIREBASE_PASSWORD || '';
const COL_FILTER  = _arg('collections');
const COLLECTIONS = COL_FILTER
  ? COL_FILTER.split(',').map(s => s.trim()).filter(Boolean)
  : ALL_COLLECTIONS;

if (!EMAIL || !PASSWORD) {
  console.error('\n❌  Admin email and password required.\n');
  console.error('  $env:FIREBASE_EMAIL="admin@email.com"');
  console.error('  $env:FIREBASE_PASSWORD="password"');
  console.error('  node functions/scripts/typesense-setup.js\n');
  process.exit(1);
}

/* ── HTTP helpers ─────────────────────────────────────────────────── */
function _post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (_) { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ── Step 1: Sign in as admin to get an ID token ─────────────────── */
async function _getIdToken() {
  console.log(`\n🔐  Signing in as ${EMAIL}...`);
  const res = await _post(
    `${AUTH_URL}?key=${WEB_API_KEY}`,
    { email: EMAIL, password: PASSWORD, returnSecureToken: true }
  );

  if (res.status !== 200 || !res.body.idToken) {
    console.error('\n❌  Sign-in failed:', res.body?.error?.message || JSON.stringify(res.body));
    console.error('    Make sure this account has  admin: true  custom claim.\n');
    process.exit(1);
  }
  console.log('✅  Signed in.');
  return res.body.idToken;
}

/* ── Step 2: Call a Firebase onCall function ──────────────────────── */
async function _callCF(idToken, funcName, data) {
  const res = await _post(
    `${CF_BASE}/${funcName}`,
    { data },
    { Authorization: `Bearer ${idToken}` }
  );

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Auth error (${res.status}): ${JSON.stringify(res.body)}`);
  }
  if (res.status >= 400) {
    const msg = res.body?.error?.message || JSON.stringify(res.body);
    throw new Error(`CF error (${res.status}): ${msg}`);
  }
  return res.body?.result !== undefined ? res.body.result : res.body;
}

/* ── Step 3: Human-readable result printer ────────────────────────── */
function _printResult(label, result) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
  if (typeof result === 'object') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result);
  }
}

/* ── Main ─────────────────────────────────────────────────────────── */
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║    SOKONI Typesense Setup                            ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const idToken = await _getIdToken();

  /* ── Phase 1: Create / update all collection schemas ── */
  console.log('\n📐  Creating Typesense collection schemas and synonyms...');
  try {
    const createResult = await _callCF(idToken, 'typesenseCreateCollections', {});
    _printResult('Collection Setup Result', createResult);
  } catch (err) {
    console.error('\n❌  typesenseCreateCollections failed:', err.message);
    console.error('    Common causes:');
    console.error('    • TYPESENSE_ADMIN_KEY secret not set in Secret Manager');
    console.error('    • TYPESENSE_NODES not set in functions/.env + functions not redeployed');
    console.error('    • Account does not have admin: true custom claim');
    process.exit(1);
  }

  /* ── Phase 2: Backfill each Firestore collection ── */
  console.log(`\n🔄  Backfilling ${COLLECTIONS.length} collections...`);
  console.log(`    ${COLLECTIONS.join(', ')}\n`);

  const results = [];
  for (const col of COLLECTIONS) {
    process.stdout.write(`  ↳ ${col.padEnd(22)}`);
    try {
      const result = await _callCF(idToken, 'typesenseBackfill', {
        firestoreCollection: col,
        version:             'v1',
        pageSize:            500,
      });
      const n = result?.imported ?? result?.count ?? '?';
      process.stdout.write(`✅  ${n} docs imported\n`);
      results.push({ collection: col, status: 'ok', imported: n });
    } catch (err) {
      /* "not-found" means the Firestore collection is empty — not an error */
      if (err.message.includes('not-found') || err.message.includes('No COLLECTION_MAP')) {
        process.stdout.write(`⏭️   skipped (not mapped)\n`);
        results.push({ collection: col, status: 'skipped' });
      } else if (err.message.includes('already-exists')) {
        process.stdout.write(`⏭️   already indexed (pass overwrite:true to rebuild)\n`);
        results.push({ collection: col, status: 'already-exists' });
      } else {
        process.stdout.write(`❌  ${err.message}\n`);
        results.push({ collection: col, status: 'error', error: err.message });
      }
    }
  }

  /* ── Summary ── */
  const ok      = results.filter(r => r.status === 'ok').length;
  const skipped = results.filter(r => r.status === 'skipped' || r.status === 'already-exists').length;
  const failed  = results.filter(r => r.status === 'error').length;
  const total   = results.reduce((s, r) => s + (Number(r.imported) || 0), 0);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(`║  ✅  ${ok} collections indexed  (${total} total docs)`.padEnd(54) + '║');
  console.log(`║  ⏭️   ${skipped} skipped`.padEnd(54) + '║');
  if (failed) {
    console.log(`║  ❌  ${failed} failed`.padEnd(54) + '║');
  }
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  NEXT:                                               ║');
  console.log('║  1. Set TYPESENSE_SEARCH_KEY secret:                 ║');
  console.log('║     firebase functions:secrets:set TYPESENSE_SEARCH_KEY ║');
  console.log('║  2. Redeploy functions:                              ║');
  console.log('║     firebase deploy --only functions                 ║');
  console.log('║  3. Test search on mysokoni.co.ke                    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('\n❌  Unexpected error:', err.message);
  process.exit(1);
});
