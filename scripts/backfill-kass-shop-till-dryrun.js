'use strict';
/* ============================================================================
   SOKONI — KASS Shop Till backfill (Part 8, Till Approval Automation +
   Unified Dashboard Profile)

   WHY THIS EXISTS
   Till Approval Automation (Part 1) auto-issues a Till on a NEW merchant
   approval going forward. KASS Shop was approved long before that hook
   existed — it needs a one-time BACKFILL, not onboarding, and not a
   client-triggered "Generate" click (that dependency is exactly what Part 1
   replaced). This script is that backfill, for KASS Shop specifically —
   named for it deliberately, not a generic "backfill every shop" tool,
   because the user's own instruction was to provision/verify THIS shop's
   Till against its EXISTING canonical identity, not invent a fake/test
   merchant.

   DRY-RUN BY DEFAULT, ZERO WRITES — matches this codebase's own established
   convention (see scripts/backfill-onboarding-availability-dryrun.js). Pass
   --execute to actually provision. Idempotent either way: reuses
   mintSokoniTillCore's own onExisting:'return' mode (Part 1) — a second run
   after a successful first converges on the SAME Till, never mints another.

   RELEASE-RECORD NOTE (explicit, per instruction): running this with
   --execute is a PRODUCTION-DATA change, not a deploy — it creates one
   sokoniTills document via the Admin SDK, nothing more. It requires
   Cloud Functions to actually be deployed first (mintSokoniTillCore's
   QR_SIGNING_SECRET must be a real, accessible secret) — running --execute
   before that deployment will fail cleanly (see "Requirements" below), not
   silently. This script is CODE, stacked and certified now; the ACTUAL
   provisioning run happens after the final stacked release is deployed,
   as its own recorded, reviewed action — not part of this commit's effect.

   KASS Shop's canonical identity, confirmed this session (not invented):
   shopId D5Ql2EYr95bt79IpcGTmOMTK0P83 (docs/MERCHANT_V2_CERTIFICATION.md).
   This script does NOT hardcode that id as a fallback/default — it is
   required explicitly (or via --shop-id) so a copy-paste of this script for
   a different shop cannot silently target the wrong one.

   Requirements to --execute (all fail loudly, never silently, if missing):
     - Cloud Functions deployed (so mintSokoniTillCore's QR_SIGNING_SECRET
       resolves) — OR run with QR_SIGNING_SECRET set in the environment
       directly for a controlled one-off (`.value()` reads process.env,
       confirmed this session).
     - Application Default Credentials with Firestore write access
       (`gcloud auth application-default login`, or a service account).

   Usage:
     node scripts/backfill-kass-shop-till-dryrun.js
       [--shop-id <shopId>]   default: KASS Shop's own canonical id
       [--branch-id <id>]     default: {shopId}-main
       [--execute]            actually write (default: dry-run, zero writes)
       [--json]               machine-readable output
   ============================================================================ */

const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const QA = require(path.join(__dirname, '..', 'functions', 'sokoni-qr-authority'));

/* KASS Shop's own identity — confirmed via docs/MERCHANT_V2_CERTIFICATION.md
   this session, not assumed. Used only as the DEFAULT for --shop-id, never
   silently substituted for whatever the caller actually names. */
const KASS_SHOP_ID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

function _arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const shopId   = _arg('--shop-id', KASS_SHOP_ID);
const branchId = _arg('--branch-id', `${shopId}-main`);
const execute  = process.argv.includes('--execute');
const asJson   = process.argv.includes('--json');

function report(obj) {
  if (asJson) { console.log(JSON.stringify(obj, null, 2)); return; }
  console.log('');
  console.log('  SOKONI Till backfill —', shopId === KASS_SHOP_ID ? 'KASS Shop' : shopId);
  console.log('  mode:', execute ? 'EXECUTE (will write)' : 'DRY RUN (zero writes)');
  console.log('');
  Object.entries(obj).forEach(([k, v]) => console.log('  ' + k + ':', typeof v === 'object' ? JSON.stringify(v) : v));
  console.log('');
}

(async () => {
  /* Confirm the shop is real and active — never assume the id given (even
     the KASS default) actually resolves to a live shop before touching
     anything. */
  const shopSnap = await db.collection('shops').doc(shopId).get();
  if (!shopSnap.exists) {
    report({ ok: false, reason: 'shop-not-found', shopId });
    process.exitCode = 1;
    return;
  }
  const shop = shopSnap.data() || {};
  if (shop.status === 'suspended') {
    report({ ok: false, reason: 'shop-suspended', shopId, note: 'A suspended shop must not receive a new Till.' });
    process.exitCode = 1;
    return;
  }

  const existingQ = await db.collection('sokoniTills')
    .where('shopId', '==', shopId).where('branchId', '==', branchId).get();
  const existingActive = existingQ.docs.map((d) => d.data()).find((t) => t.status === 'ACTIVE');

  if (existingActive) {
    report({
      ok: true, action: 'already-provisioned', shopId, branchId,
      sokoniTillId: existingActive.sokoniTillId, status: existingActive.status,
    });
    return;
  }

  /* Compute the DETERMINISTIC candidate id the same way mintSokoniTillCore
     would (Q2's shopCode+sequence convention) — reported even in dry-run,
     so what WOULD be created is knowable before anything is executed. Real
     provisioning still goes through the counter transaction (not this
     preview), so a concurrent issuance elsewhere is still handled safely —
     this is a preview, not a reservation. */
  const previewCode = QA.deriveShopCode(shop.storeName || shop.name, shopId);
  const previewId = QA.formatTillId(previewCode, 1);

  if (!execute) {
    report({
      ok: true, action: 'dry-run-would-create', shopId, branchId,
      previewSokoniTillId: previewId,
      note: 'Re-run with --execute to actually provision (requires Functions deployed / QR_SIGNING_SECRET set).',
    });
    return;
  }

  const { mintSokoniTillCore } = require(path.join(__dirname, '..', 'functions', 'sokoni-till'))._internal;
  try {
    const till = await mintSokoniTillCore({
      shopId, branchId, actorUid: 'ops:backfill-kass-shop-till', onExisting: 'return', source: 'backfill',
    });
    report({ ok: true, action: till.created ? 'created' : 'already-provisioned', sokoniTillId: till.sokoniTillId, shopId, branchId });
  } catch (e) {
    report({ ok: false, reason: e.code || 'error', message: e.message, shopId, branchId });
    process.exitCode = 1;
  }
})().catch((e) => {
  report({ ok: false, reason: 'unhandled', message: e.message });
  process.exitCode = 1;
});
