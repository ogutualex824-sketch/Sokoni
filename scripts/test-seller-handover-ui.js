#!/usr/bin/env node
/**
 * test-seller-handover-ui.js — static certification for the seller-delivery.html /
 * driver.html UI wiring of sellerAuthorizeHandover / getMyPickupPin / completePickupWithPin.
 *
 * Backend behaviour is already certified in scripts/test-seller-handover.js (55/55).
 * This suite proves the UI CALLS the right callables from the right place, degrades
 * to a real (not silent) error, and no longer offers the old unverified self-declare
 * path where the new gated one now stands — using the same comment-stripped
 * static-assertion pattern scripts/test-procurement.js and
 * scripts/test-convertprtopo-fix.js already use, so an explanatory comment quoting
 * old code verbatim can't false-positive the checks.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════════
   seller-delivery.html
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nseller-delivery.html — handover UI\n');
const sd = strip(fs.readFileSync(path.join(ROOT, 'seller-delivery.html'), 'utf8'));

/^picked_up['"]?\s*[:,]/m.test(sd) || sd.includes("'picked_up'")
  ? ok('the active-delivery query / label maps reference picked_up')
  : bad('picked_up is not referenced anywhere — the active list will drop it');

/\.where\('status', 'in', \[[^\]]*'picked_up'[^\]]*\]\)/.test(sd)
  ? ok('_loadActive\'s status IN-list includes picked_up (would otherwise vanish from Active)')
  : bad('_loadActive\'s status IN-list is missing picked_up');

{
  const buildCardMatch = sd.match(/function _buildCard\(d\) \{[\s\S]*?\n  \}/);
  if (!buildCardMatch) { bad('_buildCard function not found'); }
  else {
    const body = buildCardMatch[0];
    /handoverAuthorizedAt/.test(body)
      ? ok('_buildCard branches on handoverAuthorizedAt (authorize vs. show-PIN state)')
      : bad('_buildCard does not read handoverAuthorizedAt at all');
    /_authorizeHandover/.test(body)
      ? ok('_buildCard wires the Authorize Handover button')
      : bad('_buildCard never references _authorizeHandover');
    /_showPickupPin/.test(body)
      ? ok('_buildCard wires the Show Pickup PIN button')
      : bad('_buildCard never references _showPickupPin');
  }
}

{
  const authMatch = sd.match(/window\._authorizeHandover = function[\s\S]*?\n  \};/);
  if (!authMatch) { bad('window._authorizeHandover not found'); }
  else {
    const body = authMatch[0];
    /httpsCallable\('sellerAuthorizeHandover'\)/.test(body)
      ? ok('_authorizeHandover calls the real sellerAuthorizeHandover callable')
      : bad('_authorizeHandover does not call sellerAuthorizeHandover');
    /\.catch\(/.test(body)
      ? ok('_authorizeHandover has a .catch — a failed call surfaces, not swallowed')
      : bad('_authorizeHandover has no error handling');
  }
}

{
  const pinMatch = sd.match(/window\._showPickupPin = function[\s\S]*?\n  \};/);
  if (!pinMatch) { bad('window._showPickupPin not found'); }
  else {
    const body = pinMatch[0];
    /httpsCallable\('getMyPickupPin'\)/.test(body)
      ? ok('_showPickupPin calls the real getMyPickupPin callable')
      : bad('_showPickupPin does not call getMyPickupPin');
    !/proofPin/.test(body)
      ? ok('_showPickupPin never references the retired-pending proofPin field')
      : bad('_showPickupPin references proofPin — must not reuse the stale field');
  }
}

!/proofPin/.test(sd)
  ? ok('seller-delivery.html does not reference proofPin anywhere (page-wide converse check)')
  : bad('seller-delivery.html references proofPin somewhere');

/* ══════════════════════════════════════════════════════════════════════════
   driver.html
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\ndriver.html — pickup-PIN rider flow\n');
const dr = strip(fs.readFileSync(path.join(ROOT, 'driver.html'), 'utf8'));

{
  const btnsMatch = dr.match(/function _deliveryActionBtns\(req\) \{[\s\S]*?\n  return '';/);
  if (!btnsMatch) { bad('_deliveryActionBtns function not found'); }
  else {
    const body = btnsMatch[0];

    /if \(s === 'driver_accepted'\) \{/.test(body)
      ? ok('_deliveryActionBtns branches driver_accepted into its own block')
      : bad('driver_accepted is no longer its own branch');

    /if \(!req\.handoverAuthorizedAt\) return `/.test(body)
      ? ok('an unauthorized delivery shows a waiting state, not a self-declare button')
      : bad('no waiting-for-authorization branch found for driver_accepted');

    /_drvCompletePickup/.test(body)
      ? ok('the authorized-pickup branch wires _drvCompletePickup')
      : bad('_drvCompletePickup is never referenced from the action buttons');

    /maxlength="6"/.test(body)
      ? ok('the pickup-PIN input accepts 6 digits, matching the real PIN length')
      : bad('the pickup-PIN input does not declare maxlength="6"');

    !/maxlength="4"/.test(body)
      ? ok('no 4-digit maxlength remains anywhere in the action buttons (the stale 4-digit delivery-PIN input is fixed too)')
      : bad('a maxlength="4" PIN input remains — a real 6-digit PIN cannot be fully typed');

    /* The converse: the OLD unverified self-declare call must be gone from the
       driver_accepted branch specifically — checked on the ISOLATED branch text,
       not the whole function, since driver_at_seller/picked_up legitimately still
       call _drvUpdateDelivery for the harmless, non-custody in_transit step. */
    const acceptedBranch = body.slice(0, body.indexOf("if (s === 'driver_at_seller'"));
    !/_drvUpdateDelivery\('\$\{dRef\}','driver_at_seller'\)/.test(acceptedBranch)
      ? ok('driver_accepted no longer self-declares driver_at_seller unverified')
      : bad('driver_accepted still offers the old unverified "I\'m at the Seller" self-declare button');
  }
}

{
  const fnMatch = dr.match(/window\._drvCompletePickup = async function[\s\S]*?\n\};/);
  if (!fnMatch) { bad('window._drvCompletePickup not found'); }
  else {
    const body = fnMatch[0];
    /httpsCallable\('completePickupWithPin'\)/.test(body)
      ? ok('_drvCompletePickup calls the real completePickupWithPin callable')
      : bad('_drvCompletePickup does not call completePickupWithPin');
    /^\s*\/\^\\d\{4,8\}\\\$\/\.test\(entered\)/m.test(body) || /\\d\{4,8\}/.test(body)
      ? ok('_drvCompletePickup validates PIN format before calling the server')
      : bad('_drvCompletePickup sends an unvalidated value to the server');
    !/drv\.earnings|tripsCompleted/.test(body)
      ? ok('_drvCompletePickup touches no earnings/trip-count state — pickup is not a payout event')
      : bad('_drvCompletePickup touches earnings state — pickup must never look like a payout');
  }
}

!/proofPin/.test(dr)
  ? ok('driver.html does not reference proofPin anywhere (page-wide converse check)')
  : bad('driver.html references proofPin somewhere');

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed.');
if (fail) { console.log('\n  ' + fail + ' FAILURE(S).'); process.exit(1); }
console.log('\n  PASS — seller-delivery.html / driver.html handover UI certified (static).');
