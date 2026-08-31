'use strict';
/* F8 fosReconcile — read-only correction, emulator suite.
 *
 * fosReconcile is onCall + secrets + an external IntaSend fetch, so — as with F5 and the
 * design-review prototype — the reconcile READ+COMPARE logic below is copied VERBATIM from
 * functions/finos-automation.js fosReconcile (:284-358), parameterized by (collection,
 * refField, statusFilter, statusOk) so the FIXED path and the PRE-FIX control run the same
 * harness against the REAL Firestore emulator with a stubbed provider list. The provider
 * fetch is stubbed (no external call). Independent verification confirms the copy is
 * faithful and verifies the actual deployed generation.
 *
 * Run: firebase emulators:exec --only firestore --project sokoni-test \
 *        "node functions/emulator-tests/f8-fosreconcile.emul.js"
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-test';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

/* Verbatim reconcile core, parameterized. FIXED = the four edits; PREFIX = the deployed bug. */
const FIXED  = { col: 'fosTransactions',   ref: 'payRef',     statuses: ['COMPLETED', 'INITIATION_FAILED'],
  statusOk: (pt, s) => (pt === 'COMPLETE' && s === 'COMPLETED') || (pt === 'FAILED' && s === 'INITIATION_FAILED') };
const PREFIX = { col: 'finosTransactions', ref: 'paymentRef', statuses: ['completed', 'failed'],
  statusOk: (pt, s) => (pt === 'COMPLETE' && s === 'completed') || (pt === 'FAILED' && s === 'failed') };

async function reconcile(cfg, providerTxs) {
  const snap = await db.collection(cfg.col).where('status', 'in', cfg.statuses).limit(500).get();
  const localMap = {};
  snap.docs.forEach(d => { const data = d.data(); if (data[cfg.ref]) localMap[data[cfg.ref]] = { ...data, _id: d.id }; });

  const missing = [], mismatch = [], orphaned = [], providerRefs = new Set();
  for (const pt of providerTxs) {
    const ref = pt.api_ref; if (!ref) continue; providerRefs.add(ref);
    const local = localMap[ref];
    if (!local) { missing.push({ ref }); continue; }
    const localKes = (local.amountCents ?? 0) / 100, pKes = parseFloat(pt.value ?? 0);
    if (Math.abs(localKes - pKes) > 0.5 || !cfg.statusOk(pt.state, local.status)) mismatch.push({ ref });
  }
  for (const [ref, local] of Object.entries(localMap))
    if (!providerRefs.has(ref) && (local.provider === 'intasend' || local.provider === 'mpesa')) orphaned.push({ ref });
  return { count: snap.size, mapSize: Object.keys(localMap).length, missing, mismatch, orphaned };
}

async function clearCol(n) { const s = await db.collection(n).get(); await Promise.all(s.docs.map(d => d.ref.delete())); }
async function reset() { await Promise.all(['fosTransactions', 'finosTransactions'].map(clearCol)); }
async function seedFos(payRef, { status = 'COMPLETED', amountCents = 500000, provider = 'intasend' } = {}) {
  await db.collection('fosTransactions').add({ payRef, status, amountCents, provider, createdAt: now() });
}
async function snapshotAll() {
  const out = {};
  for (const c of ['fosTransactions', 'finosTransactions', 'wallets', 'refunds', 'pendingRefunds', 'fosRefundQueue']) {
    const s = await db.collection(c).get();
    out[c] = s.docs.map(d => d.id + ':' + JSON.stringify(d.data())).sort().join('|');
  }
  return JSON.stringify(out);
}

(async () => {
  /* 1 & 2. Corrected read MATCHES vs pre-fix control (dead path). Same seed both ways. */
  await reset(); await seedFos('r1', { status: 'COMPLETED', amountCents: 500000 });
  const prov = [{ api_ref: 'r1', state: 'COMPLETE', value: 5000 }];
  const fx = await reconcile(FIXED, prov);
  ok(fx.mapSize === 1 && fx.missing.length === 0 && fx.mismatch.length === 0 && fx.orphaned.length === 0,
     '1: corrected read (fosTransactions/payRef) MATCHES the COMPLETED tx (map=1, 0 discrepancies)');
  const pf = await reconcile(PREFIX, prov);
  ok(pf.mapSize === 0 && pf.missing.length === 1,
     '2: NEG control — pre-fix read (finosTransactions/paymentRef) → empty map, everything "missing" (dead path detected)');

  /* 3. Status mapping — COMPLETED↔COMPLETE, INITIATION_FAILED↔FAILED (D-status A) */
  await reset(); await seedFos('rc', { status: 'COMPLETED' }); await seedFos('rf', { status: 'INITIATION_FAILED' });
  const m = await reconcile(FIXED, [{ api_ref: 'rc', state: 'COMPLETE', value: 5000 }, { api_ref: 'rf', state: 'FAILED', value: 5000 }]);
  ok(m.mismatch.length === 0, '3: COMPLETED↔COMPLETE and INITIATION_FAILED↔FAILED both reconcile (0 mismatch)');
  const mbad = await reconcile(FIXED, [{ api_ref: 'rc', state: 'FAILED', value: 5000 }]);
  ok(mbad.mismatch.length === 1, '3: status disagreement (local COMPLETED vs provider FAILED) → mismatch');

  /* 4. missing / mismatch / orphaned */
  await reset(); await seedFos('local1', { status: 'COMPLETED', amountCents: 500000 });
  const r = await reconcile(FIXED, [
    { api_ref: 'local1', state: 'COMPLETE', value: 5000 },   // matched
    { api_ref: 'prov_only', state: 'COMPLETE', value: 3000 }, // missing (no local)
  ]);
  ok(r.missing.length === 1 && r.missing[0].ref === 'prov_only', '4: provider-only ref → missing');
  await reset(); await seedFos('amt1', { status: 'COMPLETED', amountCents: 500000 });
  const mm = await reconcile(FIXED, [{ api_ref: 'amt1', state: 'COMPLETE', value: 4000 }]); // 5000 vs 4000
  ok(mm.mismatch.length === 1, '4: amount divergence (>0.5 KES) → mismatch');
  await reset(); await seedFos('orph1', { status: 'COMPLETED', provider: 'intasend' });
  const orp = await reconcile(FIXED, []);  // provider returned nothing
  ok(orp.orphaned.length === 1 && orp.orphaned[0].ref === 'orph1', '4: local intasend tx not in provider → orphaned');

  /* 5. READ-ONLY invariant — reconcile writes NOTHING */
  await reset(); await seedFos('ro1', { status: 'COMPLETED' });
  const before = await snapshotAll();
  await reconcile(FIXED, [{ api_ref: 'ro1', state: 'COMPLETE', value: 5000 }, { api_ref: 'x', state: 'COMPLETE', value: 1 }]);
  const after = await snapshotAll();
  ok(before === after, '5: read-only invariant — all collections byte-identical before/after reconcile (no writes)');

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ': ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e && e.stack || e); process.exit(2); });
