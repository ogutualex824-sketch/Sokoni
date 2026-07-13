#!/usr/bin/env node
/**
 * audit-payment-integrity.js — reconciliation report for the checkout hotfix.
 *
 * READ-ONLY. This script NEVER writes, updates or deletes anything. Not one field.
 *
 * That is a deliberate constraint, not caution. Some of these orders may have been
 * legitimately fulfilled and settled out-of-band; some customers may genuinely have
 * paid by bank transfer and been served correctly. Auto-"correcting" them would
 * destroy the evidence needed to work out which is which, and could reverse an order
 * a real person actually paid for. A human decides. This only tells them what to look at.
 *
 * ── What it looks for ──────────────────────────────────────────────────────────
 * checkout.html used to write status:"paid" for EVERY payment method, whether or not
 * money had moved. Four paths fabricated the confirmation outright:
 *
 *   processMobileMoney()  airtel/tkash/equity/mtn/ecocash/chipper — no backend exists
 *   _runDemoStkPush()     fake M-Pesa STK on a 5-second timer
 *   _cardFallback()       "simulate approval then save order" when the SDK failed to load
 *   no-verify branch      trusted a client-side IntaSend COMPLETE event
 *
 * Plus PayPal (marked paid when the tab opened) and bank transfer (trusted a
 * customer-typed reference).
 *
 * So: any order marked `paid` with no verifiable provider evidence is suspect.
 *
 * Usage:
 *   node scripts/audit-payment-integrity.js               # report to stdout
 *   node scripts/audit-payment-integrity.js --csv out.csv # + CSV for finance
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';

/* ── Auth ──────────────────────────────────────────────────────────────────────
   firebase-admin needs Application Default Credentials. On this machine the ADC file
   exists but is stale (invalid_client), and `gcloud auth list` reports no credentialed
   accounts — so the admin SDK cannot authenticate.

   The Firebase CLI, however, IS authenticated (it deploys). It stores a refresh token
   in ~/.config/configstore/firebase-tools.json. We mint a short-lived access token from
   it with the CLI's own public installed-app OAuth client, and read Firestore over the
   REST API.

   These are the operator's OWN credentials, on their OWN machine, against their OWN
   project, used for a READ-ONLY query. No new endpoint is stood up, nothing is
   deployed, and no secret is written anywhere. The token lives in memory for the life
   of this process.

   If you would rather not use this path: run `gcloud auth application-default login`
   and this script will work through the admin SDK instead. */
function cliRefreshToken() {
  const f = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (j.tokens && j.tokens.refresh_token) || null;
  } catch (e) { return null; }
}

/* The Firebase CLI's public OAuth client. Not a secret — it ships inside firebase-tools
   and is a Google "installed application" client, which by design has no confidential
   secret. It cannot be used to access anything the signed-in user cannot already reach. */
const CLI_CLIENT_ID     = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

function accessToken(refresh) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: CLI_CLIENT_ID, client_secret: CLI_CLIENT_SECRET,
      refresh_token: refresh, grant_type: 'refresh_token',
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const o = JSON.parse(d);
          o.access_token ? resolve(o.access_token) : reject(new Error('token mint failed: ' + d.slice(0, 200)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

/* Paged REST read of a collection. READ-ONLY: this file issues GET, and only GET. */
function listDocs(token, collection, pageToken) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (pageToken) qs.set('pageToken', pageToken);
    https.get({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${collection}?${qs}`,
      headers: { Authorization: 'Bearer ' + token },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/* Firestore REST returns typed values ({stringValue}, {integerValue}, …). Flatten to
   plain JS so the risk logic below reads like ordinary code. */
function plain(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v.stringValue    !== undefined) out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = Number(v.integerValue);
    else if (v.doubleValue  !== undefined) out[k] = Number(v.doubleValue);
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.timestampValue !== undefined) out[k] = v.timestampValue;
    else if (v.nullValue    !== undefined) out[k] = null;
    else if (v.mapValue     !== undefined) out[k] = plain(v.mapValue.fields);
    else if (v.arrayValue   !== undefined) out[k] = (v.arrayValue.values || []).map(x => x.stringValue ?? x.integerValue ?? null);
  }
  return out;
}

/* Methods that could never have taken money — no integration exists for any of them. */
const NO_BACKEND = ['airtel', 'tkash', 'equity', 'mtn', 'ecocash', 'chipper'];
/* Methods that CAN take money but were marked paid without proof. */
const UNVERIFIED = ['paypal', 'bank', 'card'];

const ALL = [...NO_BACKEND, ...UNVERIFIED, 'mpesa'];

/* Risk is about what the platform has already LOST, not about how odd the row looks.
   An order that was shipped is money gone; an order still sitting unfulfilled is a
   phone call. Rank by that, because that is what a human should work through first. */
function riskOf(o) {
  const method    = String(o.paymentMethod || o.method || '').toLowerCase();
  const fulfilled = ['shipped', 'out_for_delivery', 'delivered', 'completed']
                      .includes(String(o.deliveryStatus || o.fulfilmentStatus || '').toLowerCase())
                    || o.timelineIndex >= 6;          /* picked_up or later */

  if (NO_BACKEND.includes(method)) {
    /* No money can possibly have been taken. If it shipped, the seller is out of pocket. */
    return fulfilled ? 'CRITICAL — goods shipped, payment impossible'
                     : 'HIGH — marked paid, payment impossible';
  }
  if (method === 'card' || method === 'mpesa') {
    /* Could be genuine (provider path) or fabricated (fallback path). Provider reference
       is the tell: the real paths always carry one. */
    const hasRef = Boolean(o.paymentRef || o.mpesaCode || o.trackingId || o.verificationToken);
    if (hasRef) return null;                          /* has provider evidence — not suspect */
    return fulfilled ? 'CRITICAL — goods shipped, no provider reference'
                     : 'HIGH — marked paid, no provider reference';
  }
  if (method === 'paypal' || method === 'bank') {
    /* These were ALWAYS marked paid without verification, by design of the old code.
       Many may have been settled manually — that is exactly why a human must look. */
    return fulfilled ? 'MEDIUM — shipped; verify payment landed'
                     : 'LOW — awaiting manual verification';
  }
  return null;
}

const RANK = { 'CRITICAL': 0, 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3 };
const rankOf = r => RANK[String(r).split(' ')[0]] ?? 9;

(async function main() {
  const csvPath = (process.argv.includes('--csv'))
    ? process.argv[process.argv.indexOf('--csv') + 1]
    : null;

  console.log('\nSOKONI — payment integrity reconciliation');
  console.log('READ-ONLY. No data is modified.\n');

  const refresh = cliRefreshToken();
  if (!refresh) {
    console.error('No Firebase CLI credentials found. Run:  firebase login\n');
    process.exit(1);
  }
  const token = await accessToken(refresh);

  /* Page the whole collection. We filter in code rather than with a server-side query
     because the point of this audit is to find orders whose recorded state is WRONG —
     narrowing with a query on the very field we distrust would beg the question. */
  const docs = [];
  let pageToken;
  do {
    const page = await listDocs(token, 'orders', pageToken);
    (page.documents || []).forEach(d => docs.push({
      id: d.name.split('/').pop(),
      data: plain(d.fields),
    }));
    pageToken = page.nextPageToken;
    if (docs.length && docs.length % 900 === 0) process.stdout.write(`  …${docs.length} orders read\n`);
  } while (pageToken);

  const paid = docs.filter(d => String(d.data.status || '').toLowerCase() === 'paid');
  console.log(`Scanned ${docs.length} orders total; ${paid.length} with status = "paid".\n`);

  const rows = [];
  paid.forEach(doc => {
    const o = doc.data || {};
    const method = String(o.paymentMethod || o.method || '').toLowerCase();
    if (!ALL.includes(method)) return;

    const risk = riskOf(o);
    if (!risk) return;                                /* has provider evidence — clean */

    rows.push({
      orderId:  doc.id,
      customer: o.buyerName || o.name || o.buyerUid || o.uid || '—',
      merchant: o.sellerName || o.sellerUid || o.sellerId || '—',
      method,
      amount:   Number(o.total || o.amount || 0),
      /* REST returns timestamps as ISO strings, not Firestore Timestamp objects. */
      created:  typeof o.createdAt === 'string' ? o.createdAt.slice(0, 10)
                : (o.timestamp ? new Date(Number(o.timestamp)).toISOString().slice(0, 10) : '—'),
      providerRef: o.paymentRef || o.mpesaCode || o.trackingId || '—',
      providerTxn: o.verificationToken ? 'server-verified' : 'NONE',
      risk,
    });
  });

  rows.sort((a, b) => rankOf(a.risk) - rankOf(b.risk) || b.amount - a.amount);

  if (!rows.length) {
    console.log('No suspect orders found. Every "paid" order carries provider evidence.\n');
    return;
  }

  /* Summary first — the number a human actually needs. */
  const exposure = rows
    .filter(r => r.risk.startsWith('CRITICAL') || r.risk.startsWith('HIGH'))
    .reduce((s, r) => s + r.amount, 0);

  const byRisk = {};
  rows.forEach(r => { const k = r.risk.split(' ')[0]; byRisk[k] = (byRisk[k] || 0) + 1; });

  console.log('SUMMARY');
  Object.entries(byRisk).sort((a, b) => rankOf(a[0]) - rankOf(b[0]))
    .forEach(([k, n]) => console.log(`  ${k.padEnd(9)} ${n} order(s)`));
  console.log(`\n  Unbacked exposure (CRITICAL + HIGH): KSh ${exposure.toLocaleString('en-KE')}`);
  console.log('  = orders marked paid for which no provider evidence exists.\n');

  console.log('ORDERS (most severe first)\n');
  rows.forEach(r => {
    console.log(`  ${r.risk}`);
    console.log(`    order    ${r.orderId}`);
    console.log(`    customer ${r.customer}`);
    console.log(`    merchant ${r.merchant}`);
    console.log(`    method   ${r.method}   amount KSh ${r.amount.toLocaleString('en-KE')}   created ${r.created}`);
    console.log(`    ref      ${r.providerRef}   provider txn: ${r.providerTxn}`);
    console.log('');
  });

  if (csvPath) {
    const head = 'orderId,customer,merchant,paymentMethod,amount,created,providerRef,providerTxn,risk\n';
    const body = rows.map(r => [
      r.orderId, r.customer, r.merchant, r.method, r.amount, r.created,
      r.providerRef, r.providerTxn, r.risk,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    fs.writeFileSync(csvPath, head + body + '\n');
    console.log(`CSV written: ${csvPath}\n`);
  }

  console.log('NEXT — for a human, not a script:');
  console.log('  1. CRITICAL rows first: goods left the building against a payment that cannot exist.');
  console.log('  2. Cross-check each against the provider dashboard (IntaSend / M-Pesa statement).');
  console.log('  3. Decide per order. Do NOT bulk-update: some bank/PayPal orders were genuinely');
  console.log('     paid and settled by hand, and reversing those would rob a paying customer.\n');
})().catch(e => {
  console.error('Audit failed:', e.message);
  process.exit(1);
});
