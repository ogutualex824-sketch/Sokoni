#!/usr/bin/env node
/* PROBE (READ-ONLY): which payment methods has the SOKONI IntaSend account
   ACTUALLY been paid through?
   ───────────────────────────────────────────────────────────────────────────

   The capability probe (probe-intasend-capability.js) asks the account for a
   checkout session per method — and every accepted request CREATES A REAL
   INVOICE. This probe creates nothing. It reads the account's own history:

     GET https://payment.intasend.com/api/v1/invoices/?state=COMPLETE&page=N
     Authorization: Bearer <SECRET key>

   Each invoice carries `provider` (IntaSend's method enum: M-PESA, PESALINK,
   CARD-PAYMENT, GOOGLE-PAY, APPLE-PAY, BITCOIN, BANK-ACH, COOP_B2B —
   developers.intasend.com/reference/api_v1_invoices_list).

   WHAT IT CAN AND CANNOT PROVE
     • a COMPLETE invoice with provider X  → X has taken real money on this
       account (evidence type `completed_invoice`, reference = that invoice id).
       It does not prove X is STILL enabled today.
     • no invoice for X                     → proves NOTHING. X may be enabled and
       simply unused. Never record "absent here" as UNSUPPORTED.

   IT IS STILL A PROVIDER CALL. It uses the live SECRET key and reads financial
   records, so it runs only when a person passes the explicit flag below. It
   never runs itself, from a hook, a suite or a deploy step, and it writes
   nothing — the operator records the result in AdminOS (Creator Hub › Config ›
   IntaSend method capability) as a Super Admin.

   USAGE
     INTASEND_PRIVATE_KEY=… node scripts/probe-intasend-invoice-methods.js \
         --i-authorize-a-read-only-provider-call [--pages=5]

   Output: per method, the count of COMPLETE invoices seen and the most recent
   invoice id (the evidence reference). No customer data is printed. */
'use strict';
const https = require('https');

const argv = process.argv.slice(2);
if (!argv.includes('--i-authorize-a-read-only-provider-call')) {
  console.error('\n  This makes a READ-ONLY call to the live IntaSend account (GET /api/v1/invoices/).');
  console.error('  Re-run with --i-authorize-a-read-only-provider-call once that is authorized.\n');
  process.exit(2);
}
const KEY = process.env.INTASEND_PRIVATE_KEY || '';
if (!KEY) { console.error('\n  INTASEND_PRIVATE_KEY is not set (environment only — never the command line).\n'); process.exit(2); }
const pagesArg = argv.find((a) => a.startsWith('--pages='));
const PAGES = Math.min(20, Math.max(1, Number(pagesArg ? pagesArg.split('=')[1] : 5) || 5));

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'payment.intasend.com', path, method: 'GET',
      headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch (_) { reject(new Error('unreadable body, HTTP ' + res.statusCode)); } });
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  const seen = {};
  let scanned = 0;
  for (let page = 1; page <= PAGES; page++) {
    const r = await get(`/api/v1/invoices/?state=COMPLETE&page=${page}`);   // eslint-disable-line no-await-in-loop
    if (r.status !== 200) { console.log(`  page ${page}: HTTP ${r.status} — stopping (not an answer about any method)`); break; }
    const rows = Array.isArray(r.data) ? r.data : (r.data.results || []);
    for (const inv of rows) {
      scanned++;
      const p = String(inv.provider || 'UNKNOWN');
      const id = inv.invoice_id || inv.id || '?';
      const at = inv.updated_at || inv.created_at || '';
      if (!seen[p]) seen[p] = { count: 0, latest: id, latestAt: at };
      seen[p].count++;
      if (at && at > seen[p].latestAt) { seen[p].latest = id; seen[p].latestAt = at; }
    }
    if (!r.data.next) break;
  }
  console.log(`\n  COMPLETE invoices scanned: ${scanned}`);
  for (const [p, v] of Object.entries(seen).sort()) console.log(`  ${p.padEnd(14)} ${String(v.count).padStart(5)}   latest ${v.latest} ${v.latestAt}`);
  console.log('\n  A method listed here has taken real money on this account: record it in AdminOS as');
  console.log('  LIVE_AND_PROVEN, evidence completed_invoice, reference = the invoice id above.');
  console.log('  A method NOT listed is UNKNOWN — never UNSUPPORTED on this evidence.\n');
  process.exit(0);
})().catch((e) => { console.error('\n  PROBE FAILED — no conclusion about any method:', e.message, '\n'); process.exit(2); });
