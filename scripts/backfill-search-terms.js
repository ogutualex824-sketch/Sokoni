#!/usr/bin/env node
'use strict';
/**
 * Backfill Firestore searchableTerms for products that never got indexed.
 *
 * WHY
 * The buyer-facing search (sokoni-search-pro.js) tries Algolia, then Typesense,
 * then falls back to Firestore: where('searchableTerms','array-contains', q).
 * Algolia and Typesense are not configured in this project, so every buyer
 * search runs on that Firestore fallback. A product with no searchableTerms is
 * therefore invisible to search while still rendering on the home feed (which
 * lists products directly). Measured 2026-07-22: 11 of 129 products had no
 * searchableTerms — including "PASSION FRUIT KIWI GUAVA", which a buyer could
 * see but not find.
 *
 * The indexProductCreate trigger writes these terms on new products, so this is
 * a one-off repair for documents that predate the trigger or hit a transient
 * failure — not an ongoing need. New products are covered.
 *
 * NO DRIFT
 * Terms come from functions/search-terms.js buildSearchTerms — the SAME function
 * the trigger uses — so a backfilled product is byte-identical to a
 * trigger-indexed one. It writes searchableTerms + nameLower, exactly the
 * trigger's field set. It does NOT write indexedAt: that field denotes external
 * (Algolia/Typesense) membership, which this repair does not create.
 *
 * CREDENTIALS
 * Firestore REST with the gcloud CLI access token (roles/owner), because the
 * Admin SDK's ADC is unusable on this machine (invalid_client). Additive writes
 * only — it adds two fields and never deletes.
 *
 *   node scripts/backfill-search-terms.js                 # dry run
 *   node scripts/backfill-search-terms.js --apply         # write
 *   GCLOUD_ACCESS_TOKEN=... node scripts/backfill-search-terms.js --apply   # CI
 */
const https = require('https');
const { execSync } = require('child_process');
const { buildSearchTerms } = require('../functions/search-terms.js');

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const HOST = 'firestore.googleapis.com';
const BASE = '/v1/projects/' + PROJECT + '/databases/(default)/documents';

function token() {
  if (process.env.GCLOUD_ACCESS_TOKEN) return process.env.GCLOUD_ACCESS_TOKEN.trim();
  return execSync('gcloud auth print-access-token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const TOK = token();

const V = (f) => f == null ? null
  : (f.stringValue != null ? f.stringValue
    : f.integerValue != null ? f.integerValue
    : f.arrayValue ? (f.arrayValue.values || []).map(V) : null);

function req(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({ Authorization: 'Bearer ' + TOK },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {});
    const r = https.request({ host: HOST, path: path, method: method, headers: headers }, (x) => {
      let s = ''; x.on('data', (d) => s += d);
      x.on('end', () => res({ code: x.statusCode, json: (() => { try { return JSON.parse(s); } catch (_) { return s; } })() }));
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

(async () => {
  const j = (await req('GET', BASE + '/products?pageSize=300')).json;
  if (j.error) { console.error('  READ FAILED: ' + j.error.status + ' — ' + j.error.message); process.exit(1); }
  const all = (j.documents || []).map((d) => ({ id: d.name.split('/').pop(), f: d.fields || {} }));
  const missing = all.filter((p) => !(V(p.f.searchableTerms) || []).length);

  console.log('\n  searchableTerms backfill   project ' + PROJECT + '   mode ' + (APPLY ? 'APPLY' : 'DRY RUN'));
  console.log('  ' + all.length + ' products, ' + missing.length + ' missing searchableTerms\n');

  let wrote = 0, failed = 0;
  for (const p of missing) {
    const doc = {
      name: V(p.f.name), title: V(p.f.title), category: V(p.f.category),
      description: V(p.f.description), tags: V(p.f.tags), brand: V(p.f.brand),
      location: V(p.f.location), county: V(p.f.county),
    };
    const terms = buildSearchTerms(doc);
    const nameLower = String(doc.name || '').toLowerCase();
    console.log('    ' + String(doc.name || p.id).slice(0, 30).padEnd(32) + '→ ' + terms.length + ' terms');
    if (!APPLY) continue;
    const path = BASE + '/products/' + p.id +
      '?updateMask.fieldPaths=searchableTerms&updateMask.fieldPaths=nameLower';
    const body = { fields: {
      searchableTerms: { arrayValue: { values: terms.map((t) => ({ stringValue: t })) } },
      nameLower: { stringValue: nameLower },
    } };
    const r = await req('PATCH', path, body);
    if (r.code === 200) wrote++;
    else { failed++; console.log('      WRITE FAILED ' + r.code + ' ' + JSON.stringify(r.json).slice(0, 140)); }
  }

  console.log('');
  if (APPLY) console.log('  wrote ' + wrote + ', failed ' + failed);
  else if (missing.length) console.log('  dry run — re-run with --apply to write');
  else console.log('  nothing to backfill — every product has searchableTerms.');
  console.log('');
})().catch((e) => { console.error('\n  FAILED: ' + e.message); process.exit(1); });
