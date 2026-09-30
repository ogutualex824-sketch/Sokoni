'use strict';
/**
 * Admin production ground-truth probe (payments / users / providers).
 *   node functions/scripts/probe-admin-data.js
 *
 * Answers, from the SERVER (not the UI): does the data exist, does it carry the
 * fields the admin queries sort/filter on, and what would adminGetFinance return?
 * Read-only. Writes nothing.
 */
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const ms = (c) => (c && c.toDate ? c.toDate().getTime() : (c && c._seconds ? c._seconds * 1000 : 0));

(async () => {
  // ---- counts ----
  for (const col of ['payments', 'users', 'providers', 'orders', 'providerBookings', 'payoutRequests', 'wallets', 'commissionLedger', 'providerPayouts']) {
    try { const c = await db.collection(col).count().get(); console.log(`count ${col.padEnd(18)} = ${c.data().count}`); }
    catch (e) { console.log(`count ${col.padEnd(18)} ERR ${e.message}`); }
  }

  // ---- payments detail: THE render/query-critical fields ----
  console.log('\n===== payments — field presence (orderBy("createdAt") drops docs missing it) =====');
  const snap = await db.collection('payments').limit(500).get();
  console.log('payments fetched (no order):', snap.size);
  let hasCreatedAt = 0, hasAmount = 0, statusDist = {}, createdAtTypes = {};
  const samples = [];
  snap.forEach((d, i) => {
    const x = d.data();
    if (x.createdAt !== undefined && x.createdAt !== null) hasCreatedAt++;
    if (x.amount !== undefined || x.amountKES !== undefined) hasAmount++;
    const st = String(x.status || '(none)');
    statusDist[st] = (statusDist[st] || 0) + 1;
    const ct = x.createdAt == null ? 'MISSING' : (x.createdAt.toDate ? 'Timestamp' : typeof x.createdAt);
    createdAtTypes[ct] = (createdAtTypes[ct] || 0) + 1;
    if (samples.length < 6) samples.push({ id: d.id, keys: Object.keys(x), status: x.status, amount: x.amount ?? x.amountKES, createdAt: ct, mpesaCode: x.mpesaCode, phone: x.phone, hasMeta: !!x.meta });
  });
  console.log('with createdAt   :', hasCreatedAt, '/', snap.size);
  console.log('with amount|KES  :', hasAmount, '/', snap.size);
  console.log('createdAt types  :', JSON.stringify(createdAtTypes));
  console.log('status distrib   :', JSON.stringify(statusDist));
  console.log('samples:');
  samples.forEach(s => console.log('  -', JSON.stringify(s)));

  // ---- does the ACTUAL admin query return anything? orderBy createdAt desc limit 200 ----
  console.log('\n===== replicate _admLoadMpesa query: orderBy(createdAt desc) limit 200 =====');
  try {
    const q = await db.collection('payments').orderBy('createdAt', 'desc').limit(200).get();
    console.log('rows returned by the admin M-Pesa query:', q.size, '  <-- if 0 while payments>0, orderBy dropped them');
  } catch (e) { console.log('ADMIN QUERY ERROR:', e.message, '  <-- needs an index?'); }

  // ---- replicate adminGetFinance payment aggregation ----
  console.log('\n===== replicate adminGetFinance (payments COMPLETE, createdAt>=30d) =====');
  const start30 = Date.now() - 30 * 86400000;
  let vol = 0, cnt = 0, completeTotal = 0;
  snap.forEach(d => {
    const x = d.data();
    const isComplete = String(x.status || '').toUpperCase() === 'COMPLETE';
    if (isComplete) completeTotal++;
    const t = ms(x.createdAt);
    if (isComplete && t >= start30) { vol += Number(x.amount != null ? x.amount : x.amountKES) || 0; cnt++; }
  });
  console.log('payments with status COMPLETE (any date):', completeTotal);
  console.log('adminGetFinance last30d paymentsCount   :', cnt, ' paymentsVolume:', vol);

  process.exit(0);
})().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
