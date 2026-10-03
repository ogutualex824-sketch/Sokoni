#!/usr/bin/env node
'use strict';
/* READ-ONLY census: which categories seen in PRODUCTION would resolve to commission-config's `default` row (no explicit
   row/alias) — so the owner can decide on "unconfigured → fail closed" knowing its blast radius (b2 / owner 2026-10-03).
   Reads distinct category-like fields from commissionLedger, products, providerServices and orders (bounded pages) via the
   operator's gcloud token (REST). Prints category names + counts only — no ids, no amounts, no personal data. */
const cp = require('child_process'), path = require('path');
const PROJECT = 'sokoni-aeb26';
const env = { ...process.env, CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON || 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe' };
const tok = cp.execSync('gcloud auth print-access-token', { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const H = { Authorization: 'Bearer ' + tok, 'x-goog-user-project': PROJECT };
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const CC = require(path.join(__dirname, '..', '..', 'functions', 'commission-config.js'));
const SOURCES = [['commissionLedger', ['category', 'hub']], ['products', ['category', 'hubType']], ['providerServices', ['category', 'hub']], ['orders', ['category', 'hub', 'hubType']]];
const PAGES = 6, SIZE = 300;
(async () => {
  const seen = new Map();   // value -> {count, sources:Set}
  for (const [coll, fields] of SOURCES) {
    let token = null, n = 0;
    for (let p = 0; p < PAGES; p++) {
      const qs = new URLSearchParams({ pageSize: String(SIZE) }); fields.forEach((f) => qs.append('mask.fieldPaths', f)); if (token) qs.set('pageToken', token);
      const r = await fetch(`${BASE}/${coll}?${qs}`, { headers: H });
      if (!r.ok) { console.log(`  ${coll}: HTTP ${r.status} (unreadable)`); break; }
      const j = await r.json();
      for (const d of j.documents || []) {
        n++;
        for (const f of fields) {
          const v = d.fields && d.fields[f] && d.fields[f].stringValue; if (!v) continue;
          const k = v.trim().toLowerCase(); const e = seen.get(k) || { count: 0, sources: new Set() }; e.count++; e.sources.add(coll + '.' + f); seen.set(k, e);
        }
      }
      token = j.nextPageToken; if (!token) break;
    }
    console.log(`  scanned ${coll}: ${n} docs${token ? ' (more exist — bounded sample)' : ''}`);
  }
  const rows = [...seen.entries()].map(([v, e]) => ({ v, e, r: CC.resolveRate(v) }));
  const def = rows.filter((x) => !x.r.matched).sort((a, b) => b.e.count - a.e.count);
  console.log(`\ndistinct values: ${rows.length} | resolve to an explicit row: ${rows.length - def.length} | FALL TO DEFAULT (${CC.RATES.default.pct}%): ${def.length}`);
  def.forEach((x) => console.log(`  ${x.v.padEnd(34)} ${String(x.e.count).padStart(5)}  [${[...x.e.sources].join(', ')}]`));
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
