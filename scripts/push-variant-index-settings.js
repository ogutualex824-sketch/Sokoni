#!/usr/bin/env node
'use strict';

/**
 * Push the variant searchable attributes and facets to the live Algolia index.
 *
 * algoliaSetupIndexes is an admin-only onCall, so the settings added to
 * functions/algolia-admin.js stay inert until something applies them. This does
 * exactly that one operation, reading the real admin key from Secret Manager
 * through scripts/_secret.js — the key is never substituted, mocked, printed or
 * written to disk.
 *
 * Deliberately partial: Algolia leaves unspecified settings untouched, so only
 * searchableAttributes and attributesForFaceting are sent. Sending the whole
 * INDEX_SETTINGS block would risk overwriting ranking or replica configuration
 * that was tuned outside this file.
 *
 *   node scripts/push-variant-index-settings.js          # show the diff, change nothing
 *   node scripts/push-variant-index-settings.js --apply  # write it
 */

const https = require('https');
const path  = require('path');
const { getSecret } = require('./_secret');
const { INDEX_SETTINGS } = require(path.join(__dirname, '..', 'functions', 'algolia-admin.js'));
const { VARIANT_FIELDS } = require(path.join(__dirname, '..', 'functions', 'search-terms.js'));

const APP_ID = process.env.ALGOLIA_APP_ID || 'F2XND3V1FW';
const INDEX  = 'sokoni_products';
const APPLY  = process.argv.includes('--apply');

function call(method, pathname, key, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: `${APP_ID}.algolia.net`, path: pathname, method,
      headers: Object.assign(
        { 'X-Algolia-Application-Id': APP_ID, 'X-Algolia-API-Key': key },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      ),
    }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => {
        /* Never echo the body on an auth failure — it can quote the key back. */
        if (res.statusCode >= 400) return reject(new Error(`${method} ${pathname} → HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(b)); } catch (_) { resolve({}); }
      });
    });
    req.on('error', e => reject(new Error('request failed: ' + e.code)));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const want = INDEX_SETTINGS[INDEX];
  if (!want) throw new Error(`${INDEX} missing from INDEX_SETTINGS`);

  const key = getSecret('ALGOLIA_ADMIN_KEY');
  const live = await call('GET', `/1/indexes/${INDEX}/settings`, key);

  const liveSearch = live.searchableAttributes || [];
  const liveFacets = live.attributesForFaceting || [];

  const missingSearch = VARIANT_FIELDS.filter(f => !liveSearch.includes(`unordered(${f})`));
  const missingFacets = VARIANT_FIELDS.filter(f => !liveFacets.includes(f));

  console.log(`\nindex: ${INDEX}`);
  console.log(`  live searchableAttributes:  ${liveSearch.length}`);
  console.log(`  live attributesForFaceting: ${liveFacets.length}`);
  console.log(`  variant fields not searchable: ${missingSearch.length ? missingSearch.join(', ') : 'none'}`);
  console.log(`  variant fields not facetable:  ${missingFacets.length ? missingFacets.join(', ') : 'none'}`);

  if (!missingSearch.length && !missingFacets.length) {
    console.log('\nAlready configured — nothing to do.\n');
    return;
  }
  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write these settings.\n');
    return;
  }

  /* Merge onto what is LIVE, not onto what the repo declares. The live index has
     drifted from functions/algolia-admin.js (fewer searchable attributes and
     facets than the file lists), and pushing the file wholesale would silently
     re-tune relevance and filtering under cover of a variant change. That
     re-alignment may well be wanted — but it is its own decision, with its own
     testing, not a side effect of this script. */
  const nextSearch = liveSearch.concat(missingSearch.map(f => `unordered(${f})`));
  const nextFacets = liveFacets.concat(missingFacets);

  const res = await call('PUT', `/1/indexes/${INDEX}/settings`, key, {
    searchableAttributes:  nextSearch,
    attributesForFaceting: nextFacets,
  });
  console.log(`\nApplied (additive merge onto live).`);
  console.log(`  searchableAttributes:  ${liveSearch.length} → ${nextSearch.length}`);
  console.log(`  attributesForFaceting: ${liveFacets.length} → ${nextFacets.length}`);
  console.log(`  taskID ${res.taskID || '(none)'} — Algolia applies settings asynchronously.\n`);
  console.log(`NOTE: live still differs from functions/algolia-admin.js on non-variant`);
  console.log(`      attributes. Left untouched deliberately — see the comment above.\n`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
