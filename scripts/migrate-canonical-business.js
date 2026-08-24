#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   CANONICAL BUSINESS MERGE  —  SOK-E7J2Y8 ──▶ D5Ql2EYr95bt79IpcGTmOMTK0P83
   ══════════════════════════════════════════════════════════════════════════
   The owner has TWO business documents. Commerce (103 products, 5 sales,
   shops/{uid}) is keyed by the OWNER UID, which platform-wide evidence shows
   is the convention: of 108 products sampled, 103 carry a uid and ZERO carry a
   SOK- merchantId. So the uid-keyed record becomes canonical and the POS
   INFRASTRUCTURE moves to it — not the other way round.

   WHAT MOVES (pointers only):
     branches.merchantId        1
     posDevices.merchantId      7
     categories.merchantId      1
     subscriptions.merchantId   2
     posSettings/{SOK}      ->  posSettings/{UID}   (copy, never overwrite)
     business config fields ->  filled into the canonical doc IF ABSENT

   WHAT DOES NOT MOVE:
     products (103)  posRetailSales (5)  shops/{uid}   — already uid-keyed.

   THE BRANCH DOCUMENT KEEPS ITS ID. All 7 devices reference
   branchId='SOK-E7J2Y8-main'; renaming it would mean create+delete beneath
   seven live pairings. Only the merchantId POINTER moves. A branch id that
   looks like the old merchant is cosmetic; a device that cannot find its
   branch is an outage.

   IDEMPOTENT BY CONSTRUCTION: every step re-points by QUERY. After one run
   `merchantId == SOK` returns nothing, so a second run is a no-op. Field fills
   only write keys that are absent. Nothing is deleted.

   USAGE
     node scripts/migrate-canonical-business.js              (dry run — default)
     node scripts/migrate-canonical-business.js --apply
     node scripts/migrate-canonical-business.js --verify     (after-proof only)
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const FN = 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions';
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const SOK = 'SOK-E7J2Y8';
const UID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const APPLY = process.argv.includes('--apply');
const VERIFY_ONLY = process.argv.includes('--verify');
const SNAP_DIR = process.env.SNAP_DIR || '.';

/* Collections re-pointed by their merchantId FIELD. */
const FIELD_COLLECTIONS = ['branches', 'posDevices', 'categories', 'subscriptions'];

/* Fields that describe POS INFRASTRUCTURE and may be filled into the canonical
   record. The canonical record's OWN identity fields are never touched. */
const CONFIG_FIELDS = ['businessId', 'defaultBranchId', 'pairingToken', 'storeCode',
                       'posCode', 'publicStoreId', 'referralCode', 'apiPublicKey',
                       'currency', 'country', 'county', 'typeFlags', 'setupChecklist',
                       'productionReady', 'businessType'];
/* NEVER copied: name, businessName, nameLower, ownerId, uid, status, phone, city,
   address, description, tagline, searchableTerms, createdAt, provisionedBy.
   The canonical record's own identity wins — this is a merge, not a takeover. */

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + l); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + l + (d ? '   [' + d + ']' : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(74));

const countField = async (c, f, v) =>
  (await db.collection(c).where(f, '==', v).limit(400).get()).size;

async function snapshot(label) {
  const snap = { label, takenAt: new Date().toISOString(), collections: {}, docs: {} };
  for (const c of FIELD_COLLECTIONS) {
    snap.collections[c] = {
      bySok: await countField(c, 'merchantId', SOK),
      byUid: await countField(c, 'merchantId', UID),
    };
  }
  snap.collections.products = { byShopUid: await countField('products', 'shopId', UID) };
  snap.collections.posRetailSales = { byShopUid: await countField('posRetailSales', 'shopId', UID) };
  for (const [c, id] of [['businesses', UID], ['businesses', SOK], ['posSettings', SOK],
                         ['posSettings', UID], ['shops', UID], ['subscriptions', SOK],
                         ['subscriptions', UID]]) {
    const d = await db.collection(c).doc(id).get();
    snap.docs[c + '/' + id] = d.exists ? JSON.parse(JSON.stringify(d.data(), (k, v) =>
      (v && v._seconds != null) ? new Date(v._seconds * 1000).toISOString() : v)) : null;
  }
  /* The AUTHORITATIVE subscription's commercial terms are captured verbatim so
     the after-proof can assert they did not move. Only the merchantId POINTER
     is allowed to change: leaving it aimed at the retired identity would orphan
     an ACTIVE, PAID subscription against a business that no longer resolves. */
  const BILLING = ['plan', 'planId', 'status', 'paymentRef', 'currentPeriodEnd',
                   'currentPeriodStart', 'trialEnd', 'trialEndsAt', 'expiresAt',
                   'graceEnd', 'billingCycle', 'amount', 'price'];
  snap.billing = {};
  for (const id of [UID, SOK]) {
    const d = await db.collection('subscriptions').doc(id).get();
    if (!d.exists) continue;
    const v = d.data() || {};
    const row = {};
    BILLING.forEach((k) => { if (v[k] !== undefined) row[k] = (v[k] && v[k].toDate)
      ? v[k].toDate().toISOString() : v[k]; });
    snap.billing[id] = row;
  }
  const dev = await db.collection('posDevices').where('merchantId', 'in', [SOK, UID]).limit(50).get();
  snap.devices = dev.docs.map((d) => ({ id: d.id, merchantId: d.data().merchantId,
                                        branchId: d.data().branchId, status: d.data().status }));
  return snap;
}

function report(s) {
  console.log('  products  shopId=UID        ' + s.collections.products.byShopUid);
  console.log('  sales     shopId=UID        ' + s.collections.posRetailSales.byShopUid);
  for (const c of FIELD_COLLECTIONS) {
    console.log('  ' + c.padEnd(14) + 'merchantId=SOK ' + String(s.collections[c].bySok).padEnd(6) +
                ' merchantId=UID ' + s.collections[c].byUid);
  }
  console.log('  posSettings/SOK           ' + (s.docs['posSettings/' + SOK] ? 'exists' : '-'));
  console.log('  posSettings/UID           ' + (s.docs['posSettings/' + UID] ? 'exists' : '-'));
  console.log('  shops/UID                 ' + (s.docs['shops/' + UID] ? 'exists' : '-'));
  console.log('  devices attached          ' + s.devices.length);
}

(async () => {
  head('BEFORE — the state this migration must preserve');
  const before = await snapshot('before');
  report(before);
  const bPath = path.join(SNAP_DIR, 'migration-before.json');
  fs.writeFileSync(bPath, JSON.stringify(before, null, 2));
  console.log('\n  snapshot written: ' + bPath);

  /* ── the conflict this script refuses to decide ────────────────────────── */
  if (before.docs['subscriptions/' + SOK] && before.docs['subscriptions/' + UID]) {
    console.log('\n  \x1b[33mCONFLICT\x1b[0m  subscriptions exists at BOTH doc ids.');
    console.log('            This is BILLING data. The script re-points the merchantId');
    console.log('            FIELD but will NOT merge or overwrite either document.');
  }

  if (VERIFY_ONLY) { await verify(); return; }

  if (!APPLY) {
    head('DRY RUN — nothing was written');
    console.log('  would re-point merchantId SOK -> UID in:');
    for (const c of FIELD_COLLECTIONS) console.log('    ' + c.padEnd(16) + before.collections[c].bySok + ' document(s)');
    const sokBiz = before.docs['businesses/' + SOK] || {};
    const uidBiz = before.docs['businesses/' + UID] || {};
    const toFill = CONFIG_FIELDS.filter((f) => sokBiz[f] !== undefined && uidBiz[f] === undefined);
    console.log('  would FILL these absent config fields on the canonical business:');
    console.log('    ' + (toFill.join(', ') || '(none)'));
    console.log('  would set merchantId = ' + UID + ' on the canonical business');
    console.log('  would COPY posSettings/' + SOK + ' -> posSettings/' + UID +
                (before.docs['posSettings/' + UID] ? '  (SKIPPED — target exists)' : ''));
    console.log('  would NOT touch: products, posRetailSales, shops/{uid}, subscriptions docs');
    console.log('  would NOT rename the branch document (7 devices reference it)');
    console.log('  would NOT quarantine ' + SOK + ' — that is a separate step after the after-proof');
    console.log('\n  re-run with --apply to execute.');
    process.exit(0);
  }

  /* ── APPLY ─────────────────────────────────────────────────────────────── */
  head('APPLYING');
  for (const c of FIELD_COLLECTIONS) {
    const snap = await db.collection(c).where('merchantId', '==', SOK).limit(400).get();
    if (snap.empty) { console.log('  ' + c.padEnd(16) + 'nothing to move (already idempotent)'); continue; }
    const batch = db.batch();
    snap.docs.forEach((d) => batch.update(d.ref, {
      merchantId: UID,
      /* Provenance, so a later reader can see this was re-pointed and from where. */
      mergedFrom: SOK,
      mergedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
    await batch.commit();
    console.log('  ' + c.padEnd(16) + 're-pointed ' + snap.size + ' document(s)');
  }

  const sokBiz = (await db.collection('businesses').doc(SOK).get()).data() || {};
  const uidRef = db.collection('businesses').doc(UID);
  const uidBiz = (await uidRef.get()).data() || {};
  const fill = { merchantId: UID, mergedFrom: SOK,
                 mergedAt: admin.firestore.FieldValue.serverTimestamp() };
  CONFIG_FIELDS.forEach((f) => {
    if (sokBiz[f] !== undefined && uidBiz[f] === undefined) fill[f] = sokBiz[f];
  });
  await uidRef.set(fill, { merge: true });
  console.log('  businesses/' + UID.slice(0, 12) + '…  filled: ' +
              Object.keys(fill).filter((k) => !['mergedFrom', 'mergedAt'].includes(k)).join(', '));

  const psTarget = db.collection('posSettings').doc(UID);
  if (!(await psTarget.get()).exists) {
    const ps = await db.collection('posSettings').doc(SOK).get();
    if (ps.exists) {
      await psTarget.set(Object.assign({}, ps.data(), { merchantId: UID, mergedFrom: SOK }));
      console.log('  posSettings      copied to the canonical id');
    }
  } else console.log('  posSettings      target already exists — NOT overwritten');

  await verify();

  async function verify() {
    head('AFTER-PROOF');
    const after = await snapshot('after');
    fs.writeFileSync(path.join(SNAP_DIR, 'migration-after.json'), JSON.stringify(after, null, 2));

    ck('M1 all 103 products untouched',
       after.collections.products.byShopUid === before.collections.products.byShopUid &&
       after.collections.products.byShopUid === 103,
       String(after.collections.products.byShopUid));
    ck('M2 all 5 sales untouched',
       after.collections.posRetailSales.byShopUid === before.collections.posRetailSales.byShopUid,
       String(after.collections.posRetailSales.byShopUid));
    ck('M3 shops/{uid} untouched',
       JSON.stringify(after.docs['shops/' + UID]) === JSON.stringify(before.docs['shops/' + UID]));
    ck('M4 all 7 devices still attached, none lost',
       after.devices.length === before.devices.length && after.devices.length === 7,
       after.devices.length + ' devices');
    ck('M5 every device now points at the canonical merchant',
       after.devices.every((d) => d.merchantId === UID),
       after.devices.map((d) => d.merchantId).filter((m) => m !== UID).join(',') || 'all UID');
    ck('M6 every device kept its branch — no re-pairing required',
       after.devices.every((d, i) => d.branchId === before.devices[i].branchId),
       'branch ids preserved');
    ck('M7 the branch moved to the canonical merchant',
       after.collections.branches.byUid === 1 && after.collections.branches.bySok === 0);
    ck('M8 nothing is left pointing at the retired identity',
       FIELD_COLLECTIONS.every((c) => after.collections[c].bySok === 0),
       FIELD_COLLECTIONS.filter((c) => after.collections[c].bySok > 0).join(',') || 'clean');
    const canon = await db.collection('businesses').doc(UID).get();
    const cv = canon.data() || {};
    ck('M9 the canonical business now carries a merchantId and a default branch',
       cv.merchantId === UID && !!cv.defaultBranchId, cv.merchantId + ' / ' + cv.defaultBranchId);
    ck('M10 ...and kept its OWN identity — the merge did not overwrite it',
       cv.name === 'KASS SHOP' && cv.ownerId === UID, cv.name);
    ck('M11 the resolver now sees ONE business with branches',
       (await countField('branches', 'merchantId', UID)) === 1);
    ck('M12 posSettings reachable at the canonical id',
       (await db.collection('posSettings').doc(UID).get()).exists);
    ck('M13 the ACTIVE subscription kept every commercial term',
       JSON.stringify(after.billing[UID]) === JSON.stringify(before.billing[UID]),
       'plan/status/paymentRef/billing dates must be byte-identical');
    const subUid = (await db.collection('subscriptions').doc(UID).get()).data() || {};
    ck('M14 ...and is still the ACTIVE, PAID one',
       subUid.status === 'active' && !!subUid.paymentRef, subUid.status + ' / ' + subUid.paymentRef);
    ck('M15 ...now pointing at the canonical business rather than the retired one',
       subUid.merchantId === UID, String(subUid.merchantId));
    const subSok = (await db.collection('subscriptions').doc(SOK).get()).data() || {};
    ck('M16 the superseded subscription was NOT deleted and NOT revived',
       subSok.status === 'superseded', String(subSok.status));
    ck('M17 SOK-E7J2Y8 still EXISTS — quarantine is a separate, later step',
       (await db.collection('businesses').doc(SOK).get()).exists);

    console.log('\n' + '='.repeat(74));
    console.log('  ' + pass + ' passed, ' + fail + ' failed');
    console.log('='.repeat(74) + '\n');
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error('ERROR: ' + (e && e.stack || e)); process.exit(1); });
