#!/usr/bin/env node
/* Merchant payment destinations (the Till) and the IntaSend MoR boundary.
 *
 * R-48H (owner ruling 2026-09-28): these checks were PARTS C, I and J (and two STK-endpoint checks of PART H)
 * of scripts/test-commission-48h-destinations.js. The 48-hour commission they sat beside is retired, but these
 * invariants have nothing to do with it and must not be lost with it, so they move here VERBATIM. The only edit:
 * the deploy-contract check names the destination callables instead of the retired sweepCommissionDue export.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const IDX  = R('functions/index.js');
const PDST = R('functions/payment-destinations.js');
const RULES = R('firestore.rules');

/* ══ 3. NO SELF-VERIFIED DESTINATION ══════════════════════════════════ */
console.log('\nC. Invariant 3 — the merchant cannot verify their own Till\n');
{
  ck('paymentDestinations denies ALL client writes',
     /match \/paymentDestinations\/\{sellerUid\} \{[\s\S]{0,300}?allow write: if false;/.test(RULES));
  ck('sellerRestrictions denies ALL client writes',
     /match \/sellerRestrictions\/\{sellerUid\} \{[\s\S]{0,300}?allow write: if false;/.test(RULES));
  ck('  ...both readable only by owner or admin',
     /match \/paymentDestinations\/\{sellerUid\} \{\s*\n\s*allow read:\s*if isAdmin\(\) \|\| \(isAuthed\(\) && request\.auth\.uid == sellerUid\);/.test(RULES));

  ck('savePaymentDestination NEVER writes status VERIFIED',
     !/status:\s*STATUS\.VERIFIED[\s\S]{0,200}?savePaymentDestination/.test(PDST)
     && /pending[\s\S]{0,200}?status: STATUS\.PENDING_TEST/.test(PDST));
  ck('confirmVerified is the ONLY producer of a verified activeDestination',
     (PDST.match(/activeDestination: promoted/g) || []).length === 1);
  ck('  ...and it is NOT exported as a callable',
     !/exports\.confirmVerified\s*=\s*onCall/.test(PDST));
  ck('verification is reached only from the STK callback',
     /payData\.hub === "destination_test"[\s\S]{0,400}?confirmVerified/.test(IDX));
  ck('  ...gated on a genuine success result code',
     /if \(resultCode === 0\) \{\s*\n\s*const r = await _pd\.confirmVerified/.test(IDX));
}
console.log('\n   ...and a change never costs the merchant their live destination\n');
{
  ck('a staged change writes only `pending`, leaving activeDestination alone',
     /pending,\s*\n[\s\S]{0,400}?status: active \? STATUS\.VERIFIED : STATUS\.PENDING_TEST/.test(PDST));
  ck('the swap is transactional (no window with two or zero destinations)',
     /return db\.runTransaction\(async \(txn\) => \{[\s\S]{0,2000}?activeDestination: promoted/.test(PDST));
  ck('the old destination is retired into history, not discarded',
     /history: prior\.slice\(0, 20\)/.test(PDST) && /retiredAt: now/.test(PDST));
  ck('a failed test marks only the ATTEMPT failed',
     /'pending\.status': STATUS\.FAILED/.test(PDST));
  ck('  ...and overall status stays VERIFIED while a live destination stands',
     /status: hasActive \? STATUS\.VERIFIED : STATUS\.FAILED/.test(PDST));
  ck('the callback must match the checkout id that started the test',
     /pending\.testCheckoutId \|\| ''\) !== String\(checkoutId\)[\s\S]{0,120}?checkout_id_mismatch/.test(PDST));
  ck('resolveActiveDestination returns null rather than any fallback shortcode',
     /if \(!d\.activeDestination \|\| d\.activeDestination\.status !== STATUS\.VERIFIED\) return null;/.test(PDST));
  ck('  ...and no Bravilex/KASS till is hardcoded anywhere in the module',
     !/3588275|174379/.test(PDST));
}


console.log('\nH. No new STK endpoint, and the destination callables are re-exported by name\n');
{
  ck('still exactly one STK callback endpoint',
     (IDX.match(/exports\.darajaSTKCallback\s*=/g) || []).length === 1);
  ck('no new STK push endpoint was created',
     (IDX.match(/mpesa\/stkpush\/v1\/processrequest/g) || []).length === 2);
  ck('the destination callables are re-exported by name (deploy contract)',
     /exports\.getPaymentDestination\s*=\s*_pdest\.getPaymentDestination/.test(IDX)
     && /exports\.savePaymentDestination\s*=\s*_pdest\.savePaymentDestination/.test(IDX));
}

/* ══ Identity: the Till is configuration, not identity ════════════════ */
console.log('\nI. The Till is configuration hanging off one identity\n');
{
  ck('scope resolves auth.uid -> users/{uid}.activeShopId -> shops/{shopId}',
     /collection\('users'\)\.doc\(String\(uid\)\)[\s\S]{0,300}?activeShopId[\s\S]{0,300}?collection\('shops'\)\.doc\(String\(activeShopId\)\)/.test(PDST));
  ck('shop ownership is verified against ownerId/sellerUid',
     /shop\.ownerId !== String\(uid\) && shop\.sellerUid !== String\(uid\)/.test(PDST));
  ck('destination doc is keyed by sellerUid — changing a Till cannot fork a merchant',
     /collection\(COLL\)\.doc\(scope\.sellerUid\)/.test(PDST));
  ck('re-saving the live destination is a no-op, not a re-verification',
     /return \{ ok: true, unchanged: true/.test(PDST));
}

/* ══ Migration boundary is not silently crossed ═══════════════════════ */
console.log('\nJ. IntaSend MoR boundary kept explicit\n');
{
  ck('production authorization gate exists and defaults false when absent',
     /productionAuthorized !== true/.test(PDST)
     && /productionAuthorized: cur \? cur\.productionAuthorized === true : false/.test(PDST));
  ck('  ...and blocks the destination rather than silently using it',
     /blocked: 'production_not_authorized'/.test(PDST));
  ck('resolveCollectionRoute still defaults DIRECT_TO_SELLER',
     /collectionRoute: ROUTE_DIRECT/.test(R('functions/payment-config.js')));
  ck('CENTRAL_MOR still refuses without central credentials',
     /Central collection \(CENTRAL_MOR\) is enabled but central Daraja credentials are not provisioned/.test(IDX));
}


console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
