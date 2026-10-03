#!/usr/bin/env node
'use strict';
/* READ-ONLY census of production payout queues the scheduled movers act on (b2 / owner 2026-10-03):
   payouts (finos.processPendingPayouts / automation-engine.autoScheduledPayouts) and payoutRequests (wallet B2C /
   processPayoutRetries / reconcilePayouts). Prints status → count + total only. No ids, no names, no phone numbers. */
const cp = require('child_process');
const PROJECT = 'sokoni-aeb26';
const env = { ...process.env, CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON || 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe' };
const tok = cp.execSync('gcloud auth print-access-token', { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const H = { Authorization: 'Bearer ' + tok, 'x-goog-user-project': PROJECT };
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const num = (f) => (f ? Number(f.integerValue ?? f.doubleValue ?? 0) : 0);
async function census(coll, amountFields) {
  const by = new Map(); let n = 0, token = null, pages = 0;
  do {
    const qs = new URLSearchParams({ pageSize: '300' }); ['status', ...amountFields].forEach((f) => qs.append('mask.fieldPaths', f)); if (token) qs.set('pageToken', token);
    const r = await fetch(`${BASE}/${coll}?${qs}`, { headers: H });
    if (!r.ok) { console.log(`  ${coll}: HTTP ${r.status} — unreadable`); return; }
    const j = await r.json();
    for (const d of j.documents || []) {
      n++; const f = d.fields || {}; const st = (f.status && f.status.stringValue) || '(none)';
      const amt = amountFields.map((k) => num(f[k])).find((v) => v > 0) || 0;
      const e = by.get(st) || { count: 0, total: 0 }; e.count++; e.total += amt; by.set(st, e);
    }
    token = j.nextPageToken; pages++;
  } while (token && pages < 50);
  console.log(`${coll}: ${n} docs${token ? ' (TRUNCATED at 50 pages)' : ''} — amount field(s): ${amountFields.join(' | ')}`);
  for (const [st, e] of [...by.entries()].sort((a, b) => b[1].count - a[1].count)) console.log(`  ${st.padEnd(22)} ${String(e.count).padStart(5)}   total ${e.total}`);
}
(async () => {
  await census('payouts', ['netCents', 'grossCents', 'amountCents', 'amount']);
  await census('payoutRequests', ['amount']);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
