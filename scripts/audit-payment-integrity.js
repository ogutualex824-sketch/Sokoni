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

const admin = require('firebase-admin');
const fs    = require('fs');

if (!admin.apps.length) {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
}
const db = admin.firestore();

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

  const snap = await db.collection('orders').where('status', '==', 'paid').get();
  console.log(`Scanned ${snap.size} orders with status = "paid".\n`);

  const rows = [];
  snap.forEach(doc => {
    const o = doc.data() || {};
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
      created:  o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toISOString().slice(0, 10)
                : (o.timestamp ? new Date(o.timestamp).toISOString().slice(0, 10) : '—'),
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
