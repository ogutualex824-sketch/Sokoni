'use strict';
/**
 * Algolia Backfill Script — Firestore REST API version.
 * Uses the Firebase CLI's stored access token (no service account needed).
 * Run: node functions/scripts/algolia-backfill.js
 */

const https   = require('https');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { variantAttributes } = require('../search-terms');
/* Sanitisation is shared with the LIVE queue path so the two cannot diverge —
   that divergence is what let a 195KB base64 image reach production. */
const { safeImageUrl, enforceSize: _enforce } = require('../algolia-sanitize');
const enforceSize = rec => _enforce(rec).record;

/* ── Config ─────────────────────────────────────────────────────── */

const PROJECT_ID = 'sokoni-aeb26';
const APP_ID     = process.env.ALGOLIA_APP_ID  || 'F2XND3V1FW';
const ADMIN_KEY  = process.env.ALGOLIA_ADMIN_KEY;
const BATCH_SIZE = 100;
if (!ADMIN_KEY) {
  console.error('ERROR: ALGOLIA_ADMIN_KEY environment variable is required.');
  console.error('  Get it: firebase functions:secrets:access ALGOLIA_ADMIN_KEY');
  process.exit(1);
}

/* Load Firebase CLI access token */
const cfgPath    = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const cliConfig  = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const ACCESS_TOKEN = cliConfig.tokens.access_token;
if (!ACCESS_TOKEN) { console.error('No access token in Firebase CLI config'); process.exit(1); }
console.log(`Auth: Firebase CLI token (${ACCESS_TOKEN.length} chars)`);

/* Collections to backfill */
const COLLECTIONS = [
  { col: 'products',    index: 'sokoni_products',  global: true },
  { col: 'sellers',     index: 'sokoni_shops',     global: true },
  { col: 'stores',      index: 'sokoni_shops',     global: true },
  { col: 'services',    index: 'sokoni_services',  global: true },
  { col: 'jobs',        index: 'sokoni_jobs',      global: true },
  { col: 'digitalJobs', index: 'sokoni_jobs',      global: true },
  { col: 'cars',        index: 'sokoni_vehicles',  global: true },
  { col: 'vehicles',    index: 'sokoni_vehicles',  global: true },
  { col: 'properties',  index: 'sokoni_properties', global: true },
  { col: 'real_estate', index: 'sokoni_properties', global: true },
  { col: 'events',      index: 'sokoni_events',    global: true },

  /* Collections the PLATFORM actually writes to. The list above uses the names
     the search architecture was designed around; the app writes several of its
     entities elsewhere (shops as `businesses`, events as `entEvents`, property
     as `propertyListings`). Omitting them meant a backfill reported success
     while silently covering only products. */
  { col: 'businesses',       index: 'sokoni_shops',      global: true },
  { col: 'restaurants',      index: 'sokoni_shops',      global: true },
  { col: 'mechanics',        index: 'sokoni_services',   global: true },
  { col: 'healthProviders',  index: 'sokoni_services',   global: true },
  { col: 'lawyers',          index: 'sokoni_services',   global: true },
  { col: 'entEvents',        index: 'sokoni_events',     global: true },
  { col: 'entVenues',        index: 'sokoni_events',     global: true },
  { col: 'propertyListings', index: 'sokoni_properties', global: true },
  { col: 'bnbListings',      index: 'sokoni_properties', global: true },
];

/* ── HTTP helpers ────────────────────────────────────────────────── */

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = { ...opts };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── Firestore REST ──────────────────────────────────────────────── */

function firestoreGet(collection, pageToken) {
  const params = [`pageSize=${BATCH_SIZE}`];
  if (pageToken) params.push(`pageToken=${encodeURIComponent(pageToken)}`);
  return request({
    hostname: 'firestore.googleapis.com',
    path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}?${params.join('&')}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

/* Convert Firestore REST field value to plain JS value */
function fsValue(v) {
  if (!v) return null;
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue  !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue    !== undefined) return null;
  if (v.arrayValue   !== undefined) return (v.arrayValue.values || []).map(fsValue);
  if (v.mapValue     !== undefined) return fsDoc(v.mapValue.fields || {});
  return null;
}

function fsDoc(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fsValue(v);
  return out;
}

/* ── Algolia batch upsert ────────────────────────────────────────── */

function algoliaBatch(indexName, records) {
  const requests = records.map(r => ({ action: 'updateObject', body: r }));
  return request({
    hostname: `${APP_ID}-1.algolianet.com`,
    path: `/1/indexes/${indexName}/batch`,
    method: 'POST',
    headers: {
      'X-Algolia-Application-Id': APP_ID,
      'X-Algolia-API-Key': ADMIN_KEY,
      'Content-Type': 'application/json',
    },
  }, { requests });
}

/* ── Transform helpers ───────────────────────────────────────────── */

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function freshnessScore(data) {
  const ts = data.updatedAt || data.createdAt;
  if (!ts) return 50;
  const d = (Date.now() - new Date(ts).getTime()) / 86400000;
  if (d < 7)   return 100;
  if (d < 30)  return 85;
  if (d < 90)  return 65;
  if (d < 180) return 40;
  if (d < 365) return 20;
  return 5;
}

function popularityScore(data) {
  return (data.views || 0) * 1 + (data.orders || data.orderCount || 0) * 5 + (data.rating || 0) * 10;
}

/* safeImageUrl / enforceSize now come from ../algolia-sanitize, which the live
   queue path imports too. They used to live here only, which is how a 195KB
   base64 image reached production through the runtime path while the recovery
   path was immune. SOKONI products store images as base64 data: URIs (up to
   200KB — see seller-wiring.js); a data URI is pixels, not an address, and is
   useless in a search record regardless. */

function transformDoc(col, docId, data) {
  const base = {
    objectID:         docId,
    _slug:            data.slug || slug(data.name || data.title || docId),
    _freshnessScore:  freshnessScore(data),
    _popularityScore: popularityScore(data),
    isActive:         data.isActive !== false && data.status !== 'inactive' && data.status !== 'deleted',
    indexedAt:        Date.now(),
  };

  switch (col) {
    case 'products':
    case 'foods':
      return { ...base, name: data.name, brand: data.brand, category: data.category,
        description: (data.description||'').slice(0,500), price: data.price,
        salePrice: data.salePrice, inStock: data.inStock !== false,
        sellerId: data.sellerId, sellerName: data.sellerName,
        imageUrl: safeImageUrl(data.imageUrl || data.thumbnail || data.image),
        rating: data.rating || 0, isFeatured: !!data.isFeatured, hub: data.hub,
        county: data.county || data['location.county'],
        'seller.verified': data['seller.verified'] || false,
        /* Same normaliser the live trigger uses, so a backfill over unchanged
           data cannot produce a different variant representation. */
        ...variantAttributes(data) };
    case 'sellers':
    case 'stores':
    case 'vendors':
    /* the app creates shops as 'businesses'; restaurants are shops too */
    case 'businesses':
    case 'restaurants':
      return { ...base, name: data.name || data.shopName || data.storeName,
        description: (data.description||'').slice(0,500), category: data.category,
        county: data.county || data['location.county'], town: data.town,
        verified: !!data.verified, rating: data.rating || 0,
        ownerId: data.ownerId || data.uid,
        imageUrl: safeImageUrl(data.imageUrl || data.logo || data.logoUrl) };
    case 'services':
    case 'providers':
    /* service-like directories that live under their own names */
    case 'mechanics':
    case 'healthProviders':
    case 'lawyers':
      return { ...base, name: data.name || data.title, category: data.category,
        description: (data.description||'').slice(0,500),
        county: data.county || data['location.county'], price: data.price,
        priceType: data.priceType, rating: data.rating || 0,
        providerId: data.providerId || data.uid };
    case 'jobs':
    case 'digitalJobs':
      return { ...base, title: data.title, company: data.company, category: data.category,
        description: (data.description||'').slice(0,500), location: data.location,
        county: data.county, jobType: data.jobType, salaryMin: data.salaryMin,
        salaryMax: data.salaryMax, employerId: data.employerId || data.uid };
    case 'cars':
    case 'vehicles':
      return { ...base, make: data.make, model: data.model, year: data.year,
        price: data.price, condition: data.condition, mileage: data.mileage,
        county: data.county, sellerId: data.sellerId,
        'seller.verified': data['seller.verified'] || false };
    case 'properties':
    case 'real_estate':
    /* the property hub writes propertyListings; BnB is a property too */
    case 'propertyListings':
    case 'bnbListings':
      return { ...base, title: data.title || data.name, type: data.type,
        listingType: data.listingType || data.purpose, price: data.price,
        bedrooms: data.bedrooms, bathrooms: data.bathrooms,
        county: data.county || data['location.county'], town: data.town || data.area,
        agentId: data.agentId || data.uid };
    case 'events':
    /* the events hub writes entEvents; venues are event entities */
    case 'entEvents':
    case 'entVenues':
      return { ...base, title: data.title || data.name, category: data.category,
        description: (data.description||'').slice(0,500), venue: data.venue,
        county: data.county, startDate: data.startDate, endDate: data.endDate,
        isFree: !!data.isFree, ticketPrice: data.ticketPrice,
        organizerId: data.organizerId || data.uid };
    default:
      return { ...base, name: data.name || data.title || docId };
  }
}

function toGlobal(col, docId, record) {
  return {
    objectID:         `${col}_${docId}`,
    type:             col,
    title:            record.name || record.title || record.make || docId,
    subtitle:         record.description || record.category || '',
    isFeatured:       record.isFeatured || false,
    isActive:         record.isActive !== false,
    _popularityScore: record._popularityScore || 0,
    _freshnessScore:  record._freshnessScore  || 50,
    imageUrl:         record.imageUrl || '',
    county:           record.county || '',
    indexedAt:        Date.now(),
  };
}

/* ── Backfill one collection ─────────────────────────────────────── */

async function backfillCollection({ col, index, global: globalSearch }) {
  let pageToken = null;
  let indexed   = 0;
  let skipped   = 0;
  let page      = 0;

  console.log(`  → ${col} → ${index}${globalSearch ? ' + global_search' : ''}`);

  while (true) {
    const res = await firestoreGet(col, pageToken);
    if (res.status === 404) { console.log(`    (collection empty or does not exist)`); break; }
    if (res.status !== 200) { console.error(`    ✗ Firestore error ${res.status}:`, JSON.stringify(res.body).slice(0,200)); break; }

    const docs = res.body.documents || [];
    if (docs.length === 0) break;
    page++;

    const primary = [];
    const global  = [];

    for (const doc of docs) {
      const docId = doc.name.split('/').pop();
      const data  = fsDoc(doc.fields || {});

      if (data.status === 'deleted' || data.status === 'draft' || data._noIndex) { skipped++; continue; }

      try {
        /* enforceSize on BOTH records — Algolia rejects the entire batch if any
           single record exceeds 10 KB, so one oversized document would
           otherwise cost every other record in the same page. */
        const record = enforceSize(transformDoc(col, docId, data));
        primary.push(record);
        if (globalSearch) global.push(enforceSize(toGlobal(col, docId, record)));
      } catch { skipped++; }
    }

    if (primary.length > 0) {
      const r = await algoliaBatch(index, primary);
      if (r.status === 200) {
        indexed += primary.length;
        console.log(`    page ${page}: +${primary.length} to ${index}`);
      } else {
        console.error(`    ✗ Algolia error (${index}):`, JSON.stringify(r.body).slice(0,200));
      }
    }

    if (global.length > 0) {
      const r = await algoliaBatch('global_search', global);
      if (r.status === 200) console.log(`    page ${page}: +${global.length} to global_search`);
      else console.error(`    ✗ global_search error:`, JSON.stringify(r.body).slice(0,200));
    }

    pageToken = res.body.nextPageToken;
    if (!pageToken) break;
    await sleep(150);
  }

  return { indexed, skipped };
}

/* ── Main ────────────────────────────────────────────────────────── */

async function main() {
  console.log('\n=== Algolia Backfill ===');
  console.log(`Project: ${PROJECT_ID}  |  App: ${APP_ID}\n`);

  let totalIndexed = 0;
  let totalSkipped = 0;

  for (const entry of COLLECTIONS) {
    try {
      const { indexed, skipped } = await backfillCollection(entry);
      totalIndexed += indexed;
      totalSkipped += skipped;
    } catch (e) {
      console.error(`  ✗ ${entry.col} failed:`, e.message);
    }
  }

  console.log('\n=== Backfill Complete ===');
  console.log(`Indexed: ${totalIndexed}`);
  console.log(`Skipped: ${totalSkipped}`);
  console.log('');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
