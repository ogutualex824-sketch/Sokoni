#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   FIND AN ORDINARY APPROVED SELLER — read-only inspection
   ------------------------------------------------------------------------------
   scripts/test-merchant-authorization.js cannot certify anything using the founder
   account, which carries admin:true and superAdmin:true. This locates an EXISTING
   account fit to run it with.

   STRICTLY READ-ONLY. It lists and reads. It never sets a claim, resets a password,
   approves an application, creates a shop, or writes a document. If no suitable
   account already exists, the correct outcome is to say so — provisioning one would
   manufacture the evidence the gate is supposed to find.

   Fitness, all four required:
     seller authority        claims.seller === true, or roles[] naming seller/merchant
     NOT admin               claims.admin !== true
     NOT superAdmin          claims.superAdmin !== true
     canonical shop          users/{uid}.activeShopId resolves to a shops/{id} that exists,
                             or shops/{uid} / sellers/{uid} does — the same order
                             sokoni-merchant-data.resolveShopId() uses

   Output is deliberately minimal: the email needed to run the gate, and a per-criterion
   verdict. It does not dump the user table.

     node scripts/find-ordinary-seller.js            # first 3 matches
     node scripts/find-ordinary-seller.js --all      # every match
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');

let admin;
try {
  admin = require(path.resolve(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
} catch (e) {
  console.error('Cannot load firebase-admin from functions/node_modules. Run npm install there.');
  process.exit(2);
}

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const auth = admin.auth();

const WANT = process.argv.includes('--all') ? Infinity : 3;

const sellerish = (c) =>
  c.seller === true ||
  (Array.isArray(c.roles) && c.roles.some((r) => /seller|merchant/i.test(String(r)))) ||
  (typeof c.role === 'string' && /seller|merchant/i.test(c.role));

(async () => {
  console.log('\n' + '='.repeat(70));
  console.log('  ORDINARY APPROVED SELLER — read-only search (' + PROJECT + ')');
  console.log('='.repeat(70));

  let scanned = 0, sellerClaim = 0, elevated = 0;
  const candidates = [];
  let pageToken;

  try {
    do {
      const res = await auth.listUsers(1000, pageToken);
      pageToken = res.pageToken;
      for (const u of res.users) {
        scanned++;
        const c = u.customClaims || {};
        if (!sellerish(c)) continue;
        sellerClaim++;
        if (c.admin === true || c.superAdmin === true) { elevated++; continue; }
        if (u.disabled) continue;
        candidates.push({ uid: u.uid, email: u.email || '(no email)', claims: c });
      }
    } while (pageToken);
  } catch (e) {
    console.error('\n  Auth listing failed: ' + (e.code || e.message));
    console.error('  If this is a credentials error: gcloud auth application-default login\n');
    process.exit(2);
  }

  console.log('\n  accounts scanned          : ' + scanned);
  console.log('  with seller authority     : ' + sellerClaim);
  console.log('  ...of those, admin/super  : ' + elevated + '  (unusable — wrong subject)');
  console.log('  ordinary seller candidates: ' + candidates.length);

  if (!candidates.length) {
    console.log('\n  NO_EXISTING_ORDINARY_SELLER_FOUND');
    console.log('  Every account carrying seller authority is also admin/superAdmin, or disabled.');
    console.log('  Authorization stays UNPROVEN. Do NOT provision one to close this gate.\n');
    process.exit(1);
  }

  /* Same resolution order as sokoni-merchant-data.resolveShopId(). */
  const resolveShop = async (uid) => {
    const userSnap = await db.collection('users').doc(uid).get();
    const d = userSnap.exists ? (userSnap.data() || {}) : {};
    const declared = d.activeShopId ? String(d.activeShopId) : null;
    if (declared) {
      const s = await db.collection('shops').doc(declared).get();
      if (s.exists) return { shopId: declared, source: 'users.activeShopId' };
    }
    const own = await db.collection('shops').doc(uid).get();
    if (own.exists) return { shopId: uid, source: 'shops/{uid}' };
    const sel = await db.collection('sellers').doc(uid).get();
    if (sel.exists) return { shopId: uid, source: 'sellers/{uid}' };
    return { shopId: null, source: 'no_shop' };
  };

  console.log('\n  ── candidates ──');
  let fit = 0;
  for (const cand of candidates) {
    if (fit >= WANT) break;
    let shop;
    try { shop = await resolveShop(cand.uid); }
    catch (e) { shop = { shopId: null, source: 'ERR ' + (e.code || e.message) }; }

    const sellerSnap = await db.collection('sellers').doc(cand.uid).get().catch(() => null);
    const sellerData = sellerSnap && sellerSnap.exists ? (sellerSnap.data() || {}) : null;
    const status = sellerData ? (sellerData.status || sellerData.live === true ? (sellerData.status || 'live') : 'unknown') : '(no sellers doc)';

    const ok = !!shop.shopId;
    console.log('\n  ' + (ok ? '✓ FIT   ' : '✗ unfit ') + cand.email);
    console.log('          claims   : ' + JSON.stringify(cand.claims));
    console.log('          shop     : ' + (shop.shopId ? shop.shopId + '  via ' + shop.source : 'NONE (' + shop.source + ')'));
    console.log('          seller   : ' + status);
    if (ok) fit++;
  }

  if (!fit) {
    console.log('\n  NO_EXISTING_ORDINARY_SELLER_FOUND');
    console.log('  Candidates carry seller authority without elevation, but none resolves to an');
    console.log('  existing shop — so none can exercise the merchant workspace.');
    console.log('  Authorization stays UNPROVEN. Do NOT create a shop to close this gate.\n');
    process.exit(1);
  }

  console.log('\n  Run the gate with one of the FIT accounts above:');
  console.log('    $env:MERCHANT_STD_EMAIL    = "<that email>"');
  console.log('    $env:MERCHANT_STD_PASSWORD = Read-Host "password"   # run that line alone');
  console.log('    node scripts/test-merchant-authorization.js');
  console.log('\n  Its password is NOT known here and must not be reset to run a test.\n');
  process.exit(0);
})();
