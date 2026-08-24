#!/usr/bin/env node
/* READ ONLY after-proof. Replays the resolver's OWN algorithm from
   sokoni-pos-context.js — owned businesses, branches per business, prefer the
   one with a default branch — and then walks the chain the till walks, to show
   the 103 products are reachable WITHOUT having been touched. */
'use strict';
const FN = 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions';
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();
const UID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const SOK = 'SOK-E7J2Y8';

let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + l); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + l + (d ? '   [' + d + ']' : '')); } };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(74));

(async () => {
  head('R — the resolver, replayed exactly as sokoni-pos-context.js runs it');

  /* ownedBusinesses(db, uid) */
  const owned = (await db.collection('businesses').where('ownerId', '==', UID).get())
    .docs.map((d) => ({ id: d.id, name: (d.data().name || d.id), status: d.data().status }));
  console.log('  owned businesses: ' + owned.length);
  owned.forEach((b) => console.log('    ' + b.id.slice(0, 30).padEnd(32) + b.status + '  ' + b.name));

  /* branchesOf(db, id) for each, then prefer the one with a DEFAULT branch */
  const ids = owned.map((b) => b.id);
  const perBusiness = [];
  for (const id of ids) {
    const s = await db.collection('branches').where('merchantId', '==', id).get();
    perBusiness.push(s.docs.map((d) => ({ id: d.id, isDefault: !!d.data().isDefault })));
  }
  let withBranches = null;
  for (let i = 0; i < ids.length; i++) {
    if (perBusiness[i] && perBusiness[i].length) {
      if (!withBranches) withBranches = ids[i];
      if (perBusiness[i].some((b) => b.isDefault)) { withBranches = ids[i]; break; }
    }
  }
  const chosen = withBranches || ids[0];
  console.log('\n  branches per business:');
  ids.forEach((id, i) => console.log('    ' + id.slice(0, 30).padEnd(32) + perBusiness[i].length +
    (perBusiness[i].length ? '  [' + perBusiness[i].map((b) => b.id + (b.isDefault ? '*' : '')).join(', ') + ']' : '')));
  console.log('\n  RESOLVER CHOOSES: ' + chosen);

  ck('R1 the resolver selects the CANONICAL business', chosen === UID, chosen);
  ck('R2 ...and it has a branch, so a till can actually operate it',
     perBusiness[ids.indexOf(chosen)].length > 0);
  ck('R3 the retired identity now has NO branches to win with',
     ids.indexOf(SOK) === -1 || perBusiness[ids.indexOf(SOK)].length === 0);

  /* Honest statement of what is NOT yet true. */
  const activeCount = owned.filter((b) => b.status === 'active').length;
  ck('R4 the canonical business is the sole business WITH POS INFRASTRUCTURE',
     perBusiness.filter((p) => p.length > 0).length === 1);
  console.log('  NOTE  businesses still marked active: ' + activeCount +
              '  — SOK-E7J2Y8 remains "active" until the QUARANTINE step.');

  head('T — the chain the till walks, and what it finds');
  const canon = (await db.collection('businesses').doc(UID).get()).data() || {};
  console.log('  auth.uid          ' + UID);
  console.log('  business          ' + UID + '  (' + canon.name + ')');
  console.log('  merchantId        ' + canon.merchantId);
  console.log('  defaultBranchId   ' + canon.defaultBranchId);
  const branchDoc = await db.collection('branches').doc(canon.defaultBranchId).get();
  console.log('  branch document   ' + (branchDoc.exists ? 'EXISTS  merchantId=' + branchDoc.data().merchantId : 'MISSING'));
  const prod = await db.collection('products').where('shopId', '==', UID).limit(400).get();
  const sales = await db.collection('posRetailSales').where('shopId', '==', UID).limit(50).get();
  const devs = await db.collection('posDevices').where('merchantId', '==', UID).get();
  console.log('  products          ' + prod.size + '   (scope: shopId == uid, UNCHANGED)');
  console.log('  sales             ' + sales.size);
  console.log('  devices           ' + devs.size);
  console.log('  posSettings       ' + ((await db.collection('posSettings').doc(UID).get()).exists ? 'present' : 'MISSING'));

  ck('T1 the default branch document resolves', branchDoc.exists);
  ck('T2 ...and belongs to the canonical merchant',
     branchDoc.exists && branchDoc.data().merchantId === UID);
  ck('T3 the till finds all 103 products through the UNCHANGED uid scope', prod.size === 103, String(prod.size));
  ck('T4 all 5 sales still reachable', sales.size === 5, String(sales.size));
  ck('T5 all 7 devices on the canonical merchant', devs.size === 7, String(devs.size));
  ck('T6 NC not one product carries a SOK- shopId — commerce vocabulary intact',
     (await db.collection('products').where('shopId', '==', SOK).limit(5).get()).size === 0);

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR: ' + (e && e.stack || e)); process.exit(1); });
