#!/usr/bin/env node
/* PRODUCTION CENSUS — which withdrawal collections actually hold records?
 *
 * READ-ONLY. No writes, no payouts, no wallet mutation.
 *
 * WHY THIS AND NOT SOURCE READING
 * Six withdrawal callables are deployed. Client callers were counted from the tree, but
 * absence of a caller is NOT evidence of zero traffic: another lineage, a scheduled job, or
 * a client version still in the wild can invoke a callable this repo never mentions. And
 * the converse holds too — a client can call a callable that never successfully writes a
 * row. So neither source nor rows alone settles it; this establishes the ROW side.
 *
 * PRIVACY: reports counts, field NAMES, and timestamps. It never prints field values, so
 * phone numbers, amounts and account details tied to a person do not leave Firestore.
 *
 *   node scripts/census-withdrawal-surfaces.js
 */
'use strict';
const { spawnSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const FS = 'https://firestore.googleapis.com/v1/projects/' + PROJECT +
           '/databases/%28default%29/documents';
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';

const COLLECTIONS = [
  'payoutRequests', 'withdrawals', 'wallets', 'walletTransactions',
  'commissionLedger', 'posPayments', 'sellerPayments',
  'zzz_control_absent_collection'   /* control: must come back empty */
];

const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
const TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { console.log('  no access token'); process.exit(1); }

function req (method, url, body) {
  const args = ['-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'x-goog-user-project: ' + PROJECT,
    '-H', 'Content-Type: application/json'];
  let tmp = null;
  if (body !== undefined) {
    tmp = require('path').join(process.env.TEMP || '.', 'census-' + process.pid + '.json');
    require('fs').writeFileSync(tmp, JSON.stringify(body));
    args.push('--data-binary', '@' + tmp);
  }
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'buffer', maxBuffer: 1024 * 1024 * 64 });
  if (tmp) { try { require('fs').unlinkSync(tmp); } catch (_) {} }
  try { return JSON.parse(Buffer.from(r.stdout).toString('utf8')); }
  catch (_) { return { __raw: Buffer.from(r.stdout).toString('utf8').slice(0, 200) }; }
}

function count (collectionId) {
  const res = req('POST', FS + ':runAggregationQuery', {
    structuredAggregationQuery: {
      structuredQuery: { from: [{ collectionId }] },
      aggregations: [{ count: {}, alias: 'c' }]
    }
  });
  if (Array.isArray(res)) {
    const r = res.find((x) => x.result);
    const v = r && r.result.aggregateFields && r.result.aggregateFields.c;
    return v ? Number(v.integerValue) : null;
  }
  return null;
}

/* one document, purely to learn the SHAPE — field names and types, never values */
function shape (collectionId) {
  const res = req('GET', FS + '/' + collectionId + '?pageSize=1');
  const d = res && res.documents && res.documents[0];
  if (!d) return null;
  const out = {};
  Object.keys(d.fields || {}).forEach((k) => {
    out[k] = Object.keys(d.fields[k])[0].replace(/Value$/, '');
  });
  return { id: String(d.name).split('/').pop().slice(0, 24) + '…', fields: out };
}

/* latest row by a timestamp-ish field, to answer "still in use?" */
function latest (collectionId, field) {
  const res = req('POST', FS + ':runQuery', {
    structuredQuery: {
      from: [{ collectionId }],
      orderBy: [{ field: { fieldPath: field }, direction: 'DESCENDING' }],
      limit: 1
    }
  });
  if (!Array.isArray(res)) return null;
  const r = res.find((x) => x.document);
  if (!r) return null;
  const f = r.document.fields && r.document.fields[field];
  if (!f) return null;
  return f.timestampValue || f.stringValue || (f.integerValue && new Date(Number(f.integerValue)).toISOString()) || null;
}

console.log('');
console.log('  PRODUCTION WITHDRAWAL CENSUS — read-only, values never printed');
console.log('');
console.log('  ' + 'collection'.padEnd(24) + 'rows');
console.log('  ' + '-'.repeat(46));
const counts = {};
COLLECTIONS.forEach((c) => {
  const n = count(c);
  counts[c] = n;
  console.log('  ' + c.padEnd(24) + (n === null ? 'ERROR' : n));
});

if (counts.zzz_control_absent_collection !== 0) {
  console.log('');
  console.log('  CONTROL FAILED — an absent collection did not return 0.');
  console.log('  The counts above cannot be trusted.');
  process.exit(1);
}
console.log('');
console.log('  control (absent collection) = 0  → the census discriminates');

['payoutRequests', 'withdrawals'].forEach((c) => {
  if (!counts[c]) { console.log(''); console.log('  ' + c + ': EMPTY — no production rows'); return; }
  const s = shape(c);
  console.log('');
  console.log('  ' + c + '  (' + counts[c] + ' rows)');
  if (s) {
    console.log('    sample doc id : ' + s.id);
    console.log('    fields        : ' + Object.keys(s.fields).sort().join(', '));
    ['createdAt', 'updatedAt', 'requestedAt', 'timestamp'].forEach((f) => {
      if (s.fields[f]) {
        const t = latest(c, f);
        if (t) console.log('    latest ' + f + ' : ' + t);
      }
    });
  }
});
console.log('');
