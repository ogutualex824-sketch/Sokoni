'use strict';
/**
 * SOKONI — Direct Typesense Setup (bypasses Cloud Functions)
 *
 * Authenticates with the service account key, fetches TYPESENSE_ADMIN_KEY
 * from Secret Manager, then creates all 25 collections + synonyms and
 * backfills from Firestore — all without Cloud Functions.
 *
 * Run from the SOKONI root:
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\Users\USER1\Downloads\sokoni-aeb26-firebase-adminsdk-fbsvc-9a8a074fb6.json"
 *   node functions/scripts/typesense-direct.js
 *
 * Optional: only backfill specific collections:
 *   node functions/scripts/typesense-direct.js --collections products,sellers
 */

const path    = require('path');
const https   = require('https');

/* ── Step up to functions/ dir so relative requires work ── */
process.chdir(path.join(__dirname, '..'));

const { GoogleAuth }    = require('google-auth-library');
const admin             = require('firebase-admin');
const {
  TypesenseClient,
  COLLECTION_SCHEMAS,
  COLLECTION_MAP,
  TRANSFORMERS,
  TS_SYNONYMS,
}                       = require('../typesense-client');

/* ── Config ─────────────────────────────────────────────── */
const PROJECT        = 'sokoni-aeb26';
const TYPESENSE_NODE = (process.env.TYPESENSE_NODES || '4kn6y5bfcxv8o702p-1.a2.typesense.net:443:https')
  .split(',')[0].trim();

/* ── Parse CLI args ─────────────────────────────────────── */
function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : null;
}
const COL_FILTER  = arg('collections');
const ALL_COLS    = Object.keys(COLLECTION_MAP);
const TARGET_COLS = COL_FILTER ? COL_FILTER.split(',').map(s => s.trim()) : ALL_COLS;

/* ── Secret Manager via REST ────────────────────────────── */
async function getSecret(auth, secretName) {
  const client = await auth.getClient();
  const token  = await client.getAccessToken();
  const url    = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${secretName}/versions/latest:access`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${token.token}` },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error(`Secret Manager ${res.statusCode}: ${data}`));
          const val = Buffer.from(body.payload.data, 'base64').toString('utf8').trim();
          resolve(val);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

/* ── Main ───────────────────────────────────────────────── */
async function main() {
  console.log('\n=== SOKONI Typesense Direct Setup ===\n');

  /* 1. Get admin key — env var takes priority over Secret Manager */
  let adminKey = process.env.TYPESENSE_ADMIN_KEY;
  if (adminKey) {
    console.log('Using TYPESENSE_ADMIN_KEY from environment.');
  } else {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    console.log('Fetching TYPESENSE_ADMIN_KEY from Secret Manager...');
    adminKey = await getSecret(auth, 'TYPESENSE_ADMIN_KEY');
  }
  console.log('  Key:', adminKey.slice(0, 8) + '...');

  /* 2. Typesense client */
  const ts = new TypesenseClient([TYPESENSE_NODE], adminKey, {
    timeoutMs: 30_000, maxRetries: 3,
  });

  /* 3. Create / update collections — idempotent */
  console.log('\nCreating / updating Typesense collections...');
  const created = [], updated = [], failed = [];
  for (const [, schema] of Object.entries(COLLECTION_SCHEMAS)) {
    process.stdout.write(`  ${schema.name.padEnd(30)}`);
    try {
      /* Try to create; if it already exists (conflict) fall through to update */
      let justCreated = false;
      try {
        await ts.createCollection(schema);
        justCreated = true;
      } catch (createErr) {
        const isConflict = createErr.status === 409 ||
          (createErr.message && createErr.message.toLowerCase().includes('conflict'));
        if (!isConflict) throw createErr; /* real error — re-throw */
      }

      if (justCreated) {
        console.log('created');
        created.push(schema.name);
      } else {
        /* Collection exists — patch any missing fields */
        const live    = await ts.getCollection(schema.name);
        const liveSet = new Set(live.fields.map(f => f.name));
        const missing = schema.fields.filter(f => !liveSet.has(f.name));
        if (missing.length) {
          await ts.updateCollectionFields(schema.name, missing);
          console.log(`updated (+${missing.length} fields)`);
        } else {
          console.log('no-op');
        }
        updated.push(schema.name);
      }
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed.push(`${schema.name}: ${err.message}`);
    }
  }

  /* 4. Synonyms */
  console.log('\nApplying Kenyan synonyms...');
  let synCount = 0;
  const searchable = Object.values(COLLECTION_SCHEMAS).map(s => s.name);
  for (const col of searchable) {
    for (const syn of TS_SYNONYMS) {
      try { await ts.upsertSynonym(col, syn.id, syn); synCount++; } catch (_) {}
    }
  }
  console.log(`  Applied ${synCount} synonym entries across ${searchable.length} collections.`);

  console.log(`\nCollections — created: ${created.length}, updated: ${updated.length}, failed: ${failed.length}`);
  if (failed.length) failed.forEach(f => console.log('  FAIL:', f));

  /* 5. Firestore backfill */
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore();

  console.log(`\nBackfilling ${TARGET_COLS.length} collections from Firestore...\n`);

  for (const col of TARGET_COLS) {
    const mapping = COLLECTION_MAP[col];
    if (!mapping) { console.log(`  ${col.padEnd(22)} — no mapping, skipped`); continue; }
    const { collection: tsCol, transformer } = mapping;
    process.stdout.write(`  ${col.padEnd(22)}`);

    let total = 0, page = 0;
    let lastSnap = null;

    try {
      while (true) {
        let q = db.collection(col).limit(500);
        if (lastSnap) q = q.startAfter(lastSnap);
        const snap = await q.get();
        if (snap.empty) break;
        lastSnap = snap.docs[snap.docs.length - 1];

        const docs = snap.docs
          .map(d => {
            try { return transformer ? transformer({ ...d.data(), id: d.id }) : { ...d.data(), id: d.id }; }
            catch (_) { return null; }
          })
          .filter(Boolean);

        if (docs.length) {
          await ts.importDocuments(tsCol, docs, 'upsert');
          total += docs.length;
        }
        page++;
        if (snap.docs.length < 500) break;
      }
      console.log(`${total} docs`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  console.log('\n=== Done ===\n');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
