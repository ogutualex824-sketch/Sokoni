#!/usr/bin/env node
'use strict';
/* ============================================================================
   One-off re-index of search entries that may carry a FORGED verified badge (owner-approved 2026-10-03)
   ----------------------------------------------------------------------------
   Context: processTypesenseQueue (live rev 00022-fon) indexed `verified` from client-writable fields:
     sellers.isVerified, products.sellerVerified (and indexed products/users.sellerVerified as its own field).
   The fix (fix/typesense-verified-badge-on-032e88e @ 8e560c1) only applies on the NEXT write of each document.
   This script re-queues ONLY the affected documents so the fixed processor recomputes them.

   It NEVER modifies a seller, product or user. It writes typesenseQueue/{collection}_{docId} items exactly as the live
   triggers do (typesense-sync.js: operation 'upsert', data = the document's CURRENT fields).

   MODES
     node scripts/infra/reindex-forged-verified.js            → COUNT ONLY (read-only, default). Prints counts, no ids.
     node scripts/infra/reindex-forged-verified.js --apply    → re-queue the affected docs. ONLY after the fix is the
                                                                serving processTypesenseQueue revision.
   Auth: the operator's gcloud user token (REST), project sokoni-aeb26. Prints no document contents and no secrets.
   ============================================================================ */
const cp = require('child_process');
const PROJECT = 'sokoni-aeb26';
const APPLY = process.argv.includes('--apply');
const env = { ...process.env, CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON || 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe' };
const tok = cp.execSync('gcloud auth print-access-token', { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const H = { Authorization: 'Bearer ' + tok, 'x-goog-user-project': PROJECT, 'Content-Type': 'application/json' };
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function runQuery (collectionId, field, value) {
  const out = []; let cursor = null;
  for (;;) {
    const q = { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { booleanValue: value } } },
      orderBy: [{ field: { fieldPath: '__name__' } }], limit: 300 };
    if (cursor) q.startAt = { values: [{ referenceValue: cursor }], before: false };
    const r = await fetch(BASE + ':runQuery', { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: q }) });
    if (!r.ok) throw new Error(collectionId + ' query HTTP ' + r.status);
    const rows = (await r.json()).filter((x) => x.document).map((x) => x.document);
    out.push(...rows);
    if (rows.length < 300) break;
    cursor = rows[rows.length - 1].name;
  }
  return out;
}
const bool = (doc, f) => doc.fields && doc.fields[f] && doc.fields[f].booleanValue === true;

async function enqueue (collection, doc) {
  const docId = doc.name.split('/').pop();
  const now = Date.now();
  const id = `${collection}_${docId}`;
  const body = { fields: {
    collection: { stringValue: collection }, tsCollection: { stringValue: collection === 'sellers' ? 'sokoni_shops' : collection === 'products' ? 'sokoni_products' : 'sokoni_users' },
    docId: { stringValue: docId }, operation: { stringValue: 'upsert' }, data: { mapValue: { fields: doc.fields || {} } },
    priority: { integerValue: '2' }, attempts: { integerValue: '0' }, status: { stringValue: 'pending' },
    nextAttemptAt: { integerValue: String(now) }, createdAt: { integerValue: String(now) }, updatedAt: { integerValue: String(now) },
    source: { stringValue: 'reindex-forged-verified-2026-10-03' } } };
  const r = await fetch(`${BASE}/typesenseQueue/${encodeURIComponent(id)}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('enqueue ' + id + ' HTTP ' + r.status);
}

(async () => {
  const sellersFlag = await runQuery('sellers', 'isVerified', true);
  const sellers = sellersFlag.filter((d) => !bool(d, 'verified'));            /* forged: isVerified without admin verified */
  const products = await runQuery('products', 'sellerVerified', true);
  const users = await runQuery('users', 'sellerVerified', true);
  /* positive control: the same REST path reads a known-non-empty collection */
  const ctl = await fetch(BASE + ':runAggregationQuery', { method: 'POST', headers: H, body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: 'sellers' }] }, aggregations: [{ alias: 'n', count: {} }] } }) });
  const ctlN = ctl.ok ? Number(((await ctl.json())[0] || {}).result?.aggregateFields?.n?.integerValue || 0) : 'ERR ' + ctl.status;
  console.log(`control: sellers total = ${ctlN}`);
  console.log(`sellers with isVerified=true: ${sellersFlag.length}  (of which NOT admin-verified → affected: ${sellers.length})`);
  console.log(`products with sellerVerified=true (affected): ${products.length}`);
  console.log(`users with sellerVerified=true (affected): ${users.length}`);
  if (!APPLY) { console.log('COUNT ONLY — nothing written. Re-run with --apply after the fix is serving.'); return; }
  let n = 0;
  for (const d of sellers) { await enqueue('sellers', d); n++; }
  for (const d of products) { await enqueue('products', d); n++; }
  for (const d of users) { await enqueue('users', d); n++; }
  console.log(`re-queued ${n} documents (typesenseQueue, operation upsert). No source document was modified.`);
})().catch((e) => { console.log('ERROR', e.message); process.exit(1); });
