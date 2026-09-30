#!/usr/bin/env node
'use strict';
/* ============================================================================
   FREE-50 BACKFILL — the whole procedure rehearsed on the Firestore emulator with the production shape
   ----------------------------------------------------------------------------
   Seeds the exact production situation from the retained dry-run artifact (12 counters at ceiling 10;
   one real merchant with 102 products by sellerUid / 97 by shopId and a stored count of -24; eleven
   zero-product identities), then drives scripts/backfill-product-counters-v3.js through:
     dry-run → apply (--authorized-by) → verify → apply again (idempotent: 0 writes) → rollback → verify
   and asserts the owner's checklist at every step. Nothing touches production.

     firebase emulators:exec --config firebase.emu.json --only firestore --project sokoni-e2e "node scripts/test-backfill-v3-emulator.js"
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST || !/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)) { console.error('refusing: FIRESTORE_EMULATOR_HOST must point at a local emulator'); process.exit(3); }
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-e2e';
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); } };
const run = (args) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backfill-product-counters-v3.js'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
  const out = (r.stdout || '') + (r.stderr || '');
  const ev = (out.match(/evidence: (\S+)/) || [])[1];
  return { code: r.status, out, evidence: ev ? path.join(ROOT, ev) : null };
};
const KASS = 'D5Ql2E_realmerchant_uid';
const TEST_IDS = ['MERCHANT_A_uid', 'SELLER_A', 'SELLER_A_uid_7', '_qa_seller_178', 'oXrgbq2oBwadJS', 'rc-not-this-seller', 'xrH21J5GFbW8Pl', 'zzz_diag_merchant', 'zzz_release_ve', 'zzz_verify_ann', 'zzz_verify_mon'];

(async () => {
  console.log(`FREE-50 backfill rehearsal (emulator ${HOST})\n`);
  /* seed: the production shape */
  for (const c of ['productCounters', 'products']) { const s = await db.collection(c).limit(500).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
  await db.collection('productCounters').doc(KASS).set({ uid: KASS, count: -24, maxProducts: 10, catalogVersion: 1, source: 'subscription-catalog' });
  for (const id of TEST_IDS) await db.collection('productCounters').doc(id).set({ uid: id, count: 0, maxProducts: 10, catalogVersion: 1 });
  const batch = db.batch();
  for (let i = 0; i < 102; i++) batch.set(db.collection('products').doc('p' + i), { sellerUid: KASS, shopId: i < 97 ? KASS : 'other_shop', name: 'P' + i });
  await batch.commit();

  console.log('1. dry-run');
  const dry = run([]);
  ck('1a dry-run exits 0 and makes no writes', dry.code === 0 && /no writes were made/.test(dry.out), dry.code);
  const dryEv = JSON.parse(fs.readFileSync(dry.evidence, 'utf8'));
  ck('1b exactly 12 identities enumerated', dryEv.identities.length === 12 && dryEv.identities.includes(KASS), dryEv.identities.length);
  const k = dryEv.rows.find((r) => r.uid === KASS);
  ck('1c KASS: actual 102 (sellerUid) / 97 (shopId) measured from products; stored count −24 reported as drift −126', k.actual.bySellerUid === 102 && k.actual.byShopId === 97 && k.before.count === -24 && k.countDrift === -126, k && { actual: k.actual, drift: k.countDrift });
  ck('1d KASS target 102 with grandfatheredFloor 102 — nothing removed, no counter decreases anywhere', k.target === 102 && k.grandfatheredFloor === 102 && dryEv.rows.every((r) => r.target >= r.before.maxProducts), dryEv.rows.map((r) => [r.uid, r.before.maxProducts, r.target]));
  ck('1e eleven test identities → catalogue 50', dryEv.rows.filter((r) => r.uid !== KASS).every((r) => r.target === 50 && r.grandfatheredFloor === null));
  const still = await db.collection('productCounters').doc(KASS).get();
  ck('1f dry-run left the counter untouched (max 10, count −24)', still.data().maxProducts === 10 && still.data().count === -24);

  console.log('\n2. apply refuses without authorization');
  const noAuth = run(['--apply']);
  ck('2a --apply without --authorized-by exits 2 and writes nothing', noAuth.code === 2 && (await db.collection('productCounters').doc(KASS).get()).data().maxProducts === 10, noAuth.code);

  console.log('\n3. apply with authorization');
  const ap = run(['--apply', '--authorized-by', 'rehearsal-owner']);
  ck('3a apply exits 0, wrote 12, readback 12 match', ap.code === 0 && /wrote 12 counter\(s\), authorized by rehearsal-owner · readback: 12 match, 0 differ/.test(ap.out), ap.out.split('\n').filter((l) => /wrote|readback/.test(l)));
  const apEv = JSON.parse(fs.readFileSync(ap.evidence, 'utf8'));
  const live = (await db.collection('productCounters').doc(KASS).get()).data();
  ck('3b KASS live: maxProducts 102, grandfatheredFloor 102, count STILL −24 (never written), migrationVersion + migratedBy + migrationBefore recorded',
     live.maxProducts === 102 && live.grandfatheredFloor === 102 && live.count === -24 && live.migrationVersion === 'catalog-v3-free50-2026-09-30' && live.migratedBy === 'rehearsal-owner' && live.migrationBefore && live.migrationBefore.maxProducts === 10, live);
  const t1 = (await db.collection('productCounters').doc(TEST_IDS[0]).get()).data();
  ck('3c a test identity live: maxProducts 50, catalogMax 50, no floor', t1.maxProducts === 50 && t1.catalogMax === 50 && t1.grandfatheredFloor === undefined, t1);
  ck('3d evidence holds before/after readback for every row', apEv.rows.every((r) => r.readback && r.before && typeof r.readback.maxProducts === 'number'));

  console.log('\n4. verify + idempotence');
  const ver = run(['--verify', ap.evidence]);
  ck('4a --verify against the apply evidence: 12 match', ver.code === 0 && /verify: 12 match, 0 differ/.test(ver.out), ver.out.split('\n').pop());
  const again = run(['--apply', '--authorized-by', 'rehearsal-owner']);
  ck('4b a second apply is idempotent: 12 skip (already migrated), 0 writes', again.code === 0 && /to write: 0 · skip: 12/.test(again.out) && /wrote 0 counter/.test(again.out), again.out.split('\n').filter((l) => /to write|wrote/.test(l)));

  console.log('\n5. the never-reduce guard');
  await db.collection('productCounters').doc('big_plan_uid').set({ uid: 'big_plan_uid', count: 0, maxProducts: 500, catalogVersion: 1 });
  const guard = run(['--uid', 'big_plan_uid']);
  ck('5a a counter already above the catalogue (500) keeps 500 — target never below current', guard.code === 0 && /→\s+500/.test(guard.out), guard.out.split('\n').find((l) => /big_plan_uid/.test(l)));

  console.log('\n6. rollback');
  const rb = run(['--rollback', ap.evidence, '--authorized-by', 'rehearsal-owner']);
  const after = (await db.collection('productCounters').doc(KASS).get()).data();
  ck('6a rollback exits 0 and KASS is back at max 10, floor removed, version cleared, count still −24', rb.code === 0 && after.maxProducts === 10 && after.grandfatheredFloor === undefined && after.migrationVersion === undefined && after.count === -24 && after.rolledBackFrom === 'catalog-v3-free50-2026-09-30', after);
  const rbEv = (rb.out.match(/readback recorded in (\S+)/) || [])[1];
  const verRb = run(['--verify', path.join(ROOT, rbEv)]);
  ck('6b --verify against the rollback evidence: 12 match (all back to before-values)', verRb.code === 0 && /verify: 12 match/.test(verRb.out), verRb.out.split('\n').pop());

  /* clean the emulator evidence files this rehearsal produced */
  for (const f of fs.readdirSync(path.join(ROOT, 'docs', 'backups'))) if (/^free50-.*-emulator-/.test(f)) fs.unlinkSync(path.join(ROOT, 'docs', 'backups', f));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
