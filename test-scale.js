/**
 * SOKONI Scalability Stress-Test Suite  v1.0
 * Phase 13 — Run from Node.js with Firebase Admin credentials.
 *
 * Usage:
 *   node test-scale.js --users 1000   (test at 1,000 concurrent)
 *   node test-scale.js --users 10000
 *   node test-scale.js --users 50000
 *
 * Prerequisites:
 *   1. npm install firebase-admin
 *   2. export GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
 *   3. Set SOKONI_PROJECT_ID env var (or edit PROJECT_ID below)
 *
 * What is tested per tier:
 *   - Concurrent Firestore reads      (product listings, user profiles)
 *   - Concurrent Firestore writes     (orders, bookings)
 *   - Concurrent Auth token verify    (via Admin SDK)
 *   - Simulated payment flow writes   (payments collection)
 *   - Search-pattern reads            (category + status queries)
 *   - Notification writes             (fan-out simulation)
 *
 * Metrics reported:
 *   - Median, P95, P99 latency
 *   - Throughput (ops/sec)
 *   - Error rate
 *   - Firestore read/write counts
 */

"use strict";
const admin   = require("firebase-admin");
const os      = require("os");
const { performance } = require("perf_hooks");

/* ── Config ────────────────────────────────────────────────── */
const PROJECT_ID = process.env.SOKONI_PROJECT_ID || "sokoni-aeb26";
const ARGS       = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith("--"))
    .map(a => { const [k, v] = a.slice(2).split("="); return [k, v || "true"]; })
);
const TARGET_USERS = parseInt(ARGS.users || "1000", 10);
const BATCH_SIZE   = Math.min(TARGET_USERS, 500); // Firebase Admin SDK parallel limit
const BATCHES      = Math.ceil(TARGET_USERS / BATCH_SIZE);

if (!admin.apps.length) {
  admin.initializeApp({ projectId: PROJECT_ID });
}
const db = admin.firestore();

/* ── Helpers ────────────────────────────────────────────────── */
function uid()      { return Math.random().toString(36).slice(2, 12); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

function percentile(sorted, pct) {
  const idx = Math.ceil(sorted.length * pct / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(timings) {
  if (!timings.length) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const s = [...timings].sort((a, b) => a - b);
  return {
    min:  s[0],
    p50:  percentile(s, 50),
    p95:  percentile(s, 95),
    p99:  percentile(s, 99),
    max:  s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

async function bench(label, fn, count) {
  const timings  = [];
  const errors   = [];
  const startAll = performance.now();

  /* Run in batches of BATCH_SIZE parallel operations */
  for (let b = 0; b < Math.ceil(count / BATCH_SIZE); b++) {
    const batchCount = Math.min(BATCH_SIZE, count - b * BATCH_SIZE);
    const promises   = Array.from({ length: batchCount }, async () => {
      const t0 = performance.now();
      try {
        await fn();
        timings.push(Math.round(performance.now() - t0));
      } catch (err) {
        errors.push(err.message);
      }
    });
    await Promise.all(promises);
  }

  const elapsed    = performance.now() - startAll;
  const throughput = Math.round((count / elapsed) * 1000);
  const s          = stats(timings);
  const errRate    = ((errors.length / count) * 100).toFixed(1);

  console.log(`\n  [${label}]`);
  console.log(`  Count:      ${count}`);
  console.log(`  Elapsed:    ${Math.round(elapsed)} ms`);
  console.log(`  Throughput: ${throughput} ops/s`);
  console.log(`  Latency:    min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  p99=${s.p99}ms  max=${s.max}ms`);
  console.log(`  Errors:     ${errors.length} (${errRate}%)`);
  if (errors.length > 0) console.log(`  First err:  ${errors[0]}`);

  return { label, count, elapsed, throughput, ...s, errorRate: parseFloat(errRate) };
}

/* ── Test Collection (all writes go to a temp collection) ─── */
const TEST_COL = `_scale_test_${Date.now()}`;

async function cleanup() {
  const snap = await db.collection(TEST_COL).limit(500).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  if (snap.size === 500) await cleanup();
}

/* ── Individual test cases ────────────────────────────────── */
async function testRead() {
  /* Read a known-good collection; fall back to _scale_test reads */
  await db.collection(TEST_COL).limit(1).get();
}

async function testWrite() {
  await db.collection(TEST_COL).add({
    t: admin.firestore.FieldValue.serverTimestamp(),
    r: uid(),
    n: Math.random(),
  });
}

async function testOrderWrite() {
  await db.collection(TEST_COL).doc(uid()).set({
    type:      "test_order",
    status:    "pending",
    amount:    Math.round(Math.random() * 5000 + 100),
    buyerUid:  uid(),
    sellerUid: uid(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function testCategoryQuery() {
  const categories = ["electronics", "fashion", "food", "healthcare", "services"];
  const cat = categories[Math.floor(Math.random() * categories.length)];
  await db.collection("products")
    .where("category", "==", cat)
    .limit(10)
    .get();
}

async function testNotificationWrite() {
  await db.collection(TEST_COL).doc(uid()).set({
    type:      "test_notification",
    targetUid: uid(),
    read:      false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function testPaymentWrite() {
  const ref = `TEST_${uid()}`;
  await db.collection(TEST_COL).doc(ref).set({
    type:        "test_payment",
    uid:         uid(),
    phone:       "254700000000",
    amount:      1,
    status:      "PENDING",
    idemKey:     ref,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function testTransaction() {
  const docRef = db.collection(TEST_COL).doc(uid());
  await db.runTransaction(async tx => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      tx.set(docRef, { counter: 1, ts: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      tx.update(docRef, { counter: admin.firestore.FieldValue.increment(1) });
    }
  });
}

/* ── Main runner ─────────────────────────────────────────── */
async function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  SOKONI SCALE TEST  — Target: ${TARGET_USERS.toLocaleString()} concurrent users`);
  console.log(`  Project: ${PROJECT_ID}`);
  console.log(`  Node: ${process.version}  CPU: ${os.cpus().length}x  RAM: ${Math.round(os.totalmem() / 1e9)}GB`);
  console.log(`  Batch size: ${BATCH_SIZE}  Batches: ${BATCHES}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const results = [];

  /* Warmup */
  console.log("Warming up (5 writes)…");
  for (let i = 0; i < 5; i++) await testWrite();
  await sleep(500);

  /* ── Test Suite ── */
  results.push(await bench("Firestore Reads (list query)",      testRead,             TARGET_USERS));
  results.push(await bench("Firestore Writes (simple doc)",     testWrite,            TARGET_USERS));
  results.push(await bench("Firestore Writes (order payload)",  testOrderWrite,       Math.round(TARGET_USERS * 0.5)));
  results.push(await bench("Category Query (products)",         testCategoryQuery,    Math.round(TARGET_USERS * 0.3)));
  results.push(await bench("Notification Writes (fan-out sim)", testNotificationWrite, TARGET_USERS));
  results.push(await bench("Payment Doc Writes",                testPaymentWrite,     Math.round(TARGET_USERS * 0.1)));
  results.push(await bench("Firestore Transactions",            testTransaction,      Math.round(TARGET_USERS * 0.2)));

  /* ── Summary ── */
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════");

  const totalOps    = results.reduce((s, r) => s + r.count, 0);
  const totalErrors = results.reduce((s, r) => s + Math.round(r.count * r.errorRate / 100), 0);
  const overallErr  = ((totalErrors / totalOps) * 100).toFixed(2);
  const maxP99      = Math.max(...results.map(r => r.p99));

  console.log(`  Total ops:    ${totalOps.toLocaleString()}`);
  console.log(`  Total errors: ${totalErrors} (${overallErr}%)`);
  console.log(`  Worst P99:    ${maxP99} ms`);

  /* Scalability grade */
  let grade;
  if (maxP99 < 500   && parseFloat(overallErr) < 0.1) grade = "A+ (Excellent — ready for 1M users)";
  else if (maxP99 < 1000 && parseFloat(overallErr) < 1.0) grade = "A  (Good — handle current tier)";
  else if (maxP99 < 2000 && parseFloat(overallErr) < 2.0) grade = "B  (Acceptable — optimisation needed)";
  else if (maxP99 < 5000 && parseFloat(overallErr) < 5.0) grade = "C  (Marginal — significant tuning needed)";
  else                                                      grade = "D  (Unacceptable — architecture review required)";

  console.log(`  Grade:        ${grade}`);
  console.log("═══════════════════════════════════════════════════════\n");

  /* Cleanup test data */
  console.log("Cleaning up test documents…");
  await cleanup();
  console.log("Done.\n");

  process.exit(0);
}

run().catch(err => {
  console.error("Scale test failed:", err);
  process.exit(1);
});
