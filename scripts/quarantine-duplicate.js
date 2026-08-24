#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   QUARANTINE THE DUPLICATE BUSINESS  —  SOK-E7J2Y8
   ══════════════════════════════════════════════════════════════════════════
   The merge moved every pointer to the canonical record and the real till has
   since resolved it on a real phone. What remains is a metadata document with
   no branches, no devices, no settings and no commerce, whose only remaining
   effect is to appear in `businesses where ownerId == uid` and make the owner
   look like they have two shops.

   RETIRED, NOT DELETED. The document is preserved in full, marked retired, and
   pointed at the canonical record. Deletion would destroy the only evidence of
   where the merged infrastructure came from, and the after-proof below depends
   on the document still being readable.

   REVERSIBLE. `_quarantineSnapshot` stores the exact prior status, so undo is
   a single field write back.

   IDEMPOTENT. Re-running finds `retiredTo` already set and does nothing.

     node scripts/quarantine-duplicate.js            (dry run — default)
     node scripts/quarantine-duplicate.js --apply
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
const SNAP_DIR = process.env.SNAP_DIR || '.';

let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + l); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + l + (d ? '   [' + d + ']' : '')); } };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(74));
const size = async (c, f, v) => (await db.collection(c).where(f, '==', v).limit(400).get()).size;

async function snap() {
  const s = { at: new Date().toISOString() };
  for (const c of ['branches', 'posDevices', 'categories', 'subscriptions']) {
    s[c + '_sok'] = await size(c, 'merchantId', SOK);
    s[c + '_uid'] = await size(c, 'merchantId', UID);
  }
  s.products = await size('products', 'shopId', UID);
  s.sales = await size('posRetailSales', 'shopId', UID);
  const b = await db.collection('businesses').doc(SOK).get();
  s.sokExists = b.exists;
  s.sokStatus = b.exists ? (b.data() || {}).status : null;
  s.sokRetiredTo = b.exists ? ((b.data() || {}).retiredTo || null) : null;
  s.sokDoc = b.exists ? JSON.parse(JSON.stringify(b.data(), (k, v) =>
    (v && v._seconds != null) ? new Date(v._seconds * 1000).toISOString() : v)) : null;
  const owned = await db.collection('businesses').where('ownerId', '==', UID).get();
  s.owned = owned.docs.map((d) => ({ id: d.id, status: (d.data() || {}).status }));
  s.ownedActive = s.owned.filter((o) => o.status === 'active').length;
  return s;
}

(async () => {
  head('BEFORE');
  const before = await snap();
  console.log('  owned businesses : ' + before.owned.map((o) => o.id.slice(0, 16) + '=' + o.status).join('  '));
  console.log('  active count     : ' + before.ownedActive);
  console.log('  products / sales : ' + before.products + ' / ' + before.sales);
  console.log('  SOK still holds  : branches=' + before.branches_sok + ' devices=' + before.posDevices_sok +
              ' categories=' + before.categories_sok + ' subs=' + before.subscriptions_sok);
  fs.writeFileSync(path.join(SNAP_DIR, 'quarantine-before.json'), JSON.stringify(before, null, 2));

  /* REFUSE if the duplicate still owns anything. Quarantining a record that is
     still load-bearing would strand whatever points at it. */
  const stillHolds = before.branches_sok + before.posDevices_sok +
                     before.categories_sok + before.subscriptions_sok;
  if (stillHolds > 0) {
    console.log('\n  \x1b[31mREFUSING\x1b[0m — ' + stillHolds + ' document(s) still point at ' + SOK + '.');
    console.log('  Run the merge first. Quarantine must never strand live pointers.');
    process.exit(1);
  }
  if (!before.sokExists) { console.log('\n  ' + SOK + ' does not exist — nothing to quarantine.'); process.exit(0); }
  if (before.sokRetiredTo) { console.log('\n  already retired to ' + before.sokRetiredTo + ' — idempotent no-op.'); process.exit(0); }

  if (!APPLY) {
    head('DRY RUN — nothing written');
    console.log('  would set on businesses/' + SOK + ':');
    console.log('    status                 active -> retired');
    console.log('    retiredTo              ' + UID);
    console.log('    retiredAt              <server timestamp>');
    console.log('    retiredReason          duplicate-business-merged');
    console.log('    _quarantineSnapshot    { status: "' + before.sokStatus + '" }   <- makes this reversible');
    console.log('  would NOT delete the document, and would touch nothing else.');
    console.log('\n  re-run with --apply.');
    process.exit(0);
  }

  head('APPLYING');
  await db.collection('businesses').doc(SOK).set({
    status: 'retired',
    retiredTo: UID,
    retiredAt: admin.firestore.FieldValue.serverTimestamp(),
    retiredReason: 'duplicate-business-merged',
    _quarantineSnapshot: { status: before.sokStatus },
  }, { merge: true });
  console.log('  businesses/' + SOK + ' marked retired -> ' + UID);

  head('AFTER-PROOF');
  const after = await snap();
  fs.writeFileSync(path.join(SNAP_DIR, 'quarantine-after.json'), JSON.stringify(after, null, 2));

  ck('Q1 the duplicate still EXISTS — retired, not deleted', after.sokExists);
  ck('Q2 ...marked retired', after.sokStatus === 'retired', String(after.sokStatus));
  ck('Q3 ...and points at the canonical record', after.sokRetiredTo === UID, String(after.sokRetiredTo));
  ck('Q4 ...reversibly — the prior status is preserved',
     after.sokDoc && after.sokDoc._quarantineSnapshot &&
     after.sokDoc._quarantineSnapshot.status === before.sokStatus,
     JSON.stringify(after.sokDoc && after.sokDoc._quarantineSnapshot));
  ck('Q5 every field the merge read is still readable — nothing was destroyed',
     ['merchantId', 'businessId', 'defaultBranchId', 'pairingToken', 'apiPublicKey']
       .every((k) => after.sokDoc[k] !== undefined),
     Object.keys(after.sokDoc || {}).length + ' fields retained');

  ck('Q6 the canonical business is now the SOLE ACTIVE one', after.ownedActive === 1,
     after.owned.map((o) => o.id.slice(0, 14) + '=' + o.status).join('  '));
  ck('Q7 ...and it is the canonical record',
     (after.owned.find((o) => o.status === 'active') || {}).id === UID);
  ck('Q8 103 products untouched', after.products === before.products && after.products === 103,
     String(after.products));
  ck('Q9 5 sales untouched', after.sales === before.sales, String(after.sales));
  ck('Q10 the 7 devices are still on the canonical merchant',
     after.posDevices_uid === before.posDevices_uid && after.posDevices_uid === 7,
     String(after.posDevices_uid));
  ck('Q11 the branch is still on the canonical merchant', after.branches_uid === 1);
  ck('Q12 nothing points at the retired record',
     after.branches_sok + after.posDevices_sok + after.categories_sok + after.subscriptions_sok === 0);

  /* The resolver replay — the thing the till actually does. */
  const owned = await db.collection('businesses').where('ownerId', '==', UID).get();
  const ids = owned.docs.map((d) => d.id);
  const per = [];
  for (const id of ids) per.push((await db.collection('branches').where('merchantId', '==', id).get()).size);
  let chosen = null;
  for (let i = 0; i < ids.length; i++) if (per[i] > 0 && !chosen) chosen = ids[i];
  ck('Q13 the resolver still selects the canonical business', (chosen || ids[0]) === UID,
     String(chosen || ids[0]));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR: ' + (e && e.stack || e)); process.exit(1); });
