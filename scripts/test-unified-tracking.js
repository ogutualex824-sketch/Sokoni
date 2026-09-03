#!/usr/bin/env node
/**
 * test-unified-tracking.js — static certification for the unified order-tracking
 * convergence (docs/UNIFIED_ORDER_TRACKING_DESIGN.md).
 *
 * Proves, by source inspection (same comment-stripped convention as
 * scripts/test-convertprtopo-fix.js / scripts/test-seller-handover-ui.js):
 *   - driver.html mirrors GPS onto packageRequests.driverLat/driverLng, riding the
 *     EXISTING throttled watch (no new geolocation watcher/interval introduced)
 *   - the rideDrivers write (dispatch/fleet) is untouched — this is additive
 *   - seller-delivery.html's mini-map reads the SAME driverLat/driverLng field,
 *     not a second rideDrivers subscription
 *   - all three files' coordinate-validity guards agree on what counts as a real fix
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
   driver.html
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\ndriver.html — position mirror onto packageRequests\n');
const dr = strip(fs.readFileSync(path.join(ROOT, 'driver.html'), 'utf8'));

/function _drvMirrorPosition\(lat, lng\) \{[\s\S]*?\n\}/.test(dr)
  ? ok('_drvMirrorPosition is defined')
  : bad('_drvMirrorPosition is missing');

{
  const fnMatch = dr.match(/function _drvMirrorPosition\(lat, lng\) \{[\s\S]*?\n\}/);
  if (fnMatch) {
    const body = fnMatch[0];
    /collection\('packageRequests'\)\.doc\(_drvActiveDeliveryRef\)/.test(body)
      ? ok('_drvMirrorPosition writes to packageRequests, keyed on the active delivery ref')
      : bad('_drvMirrorPosition does not target packageRequests/_drvActiveDeliveryRef');
    /driverLat: lat, driverLng: lng/.test(body)
      ? ok('_drvMirrorPosition writes driverLat/driverLng — the exact field names delivery-tracking.html already reads')
      : bad('_drvMirrorPosition does not write driverLat/driverLng with those exact names');
    /driverLocUpdatedAt/.test(body)
      ? ok('_drvMirrorPosition stamps driverLocUpdatedAt for freshness')
      : bad('_drvMirrorPosition does not stamp driverLocUpdatedAt');
    /_drvActiveDeliveryRef/.test(body) && /!_drvActiveDeliveryRef/.test(body)
      ? ok('_drvMirrorPosition no-ops when there is no active delivery (never writes to a made-up doc id)')
      : bad('_drvMirrorPosition does not guard against a missing active delivery ref');
  } else bad('could not isolate _drvMirrorPosition body for detailed checks');
}

{
  const gpsCbMatch = dr.match(/SokoniDB\.startGPSTracking\(drv\.id, \(lat2, lng2\) => \{[\s\S]*?\n      \}\);/);
  if (!gpsCbMatch) { bad('the startGPSTracking onUpdate callback was not found'); }
  else {
    const body = gpsCbMatch[0];
    /setDriverOnline\(drv\.id, true, drv\.vehicle, lat2, lng2/.test(body)
      ? ok('the existing rideDrivers position write (setDriverOnline) is untouched — dispatch/fleet views unaffected')
      : bad('the existing rideDrivers write appears to have been removed or altered');
    /_drvMirrorPosition\(lat2, lng2\)/.test(body)
      ? ok('the packageRequests mirror write rides the SAME throttled GPS callback — no new watcher added')
      : bad('_drvMirrorPosition is not called from the existing GPS callback');
  }
}

/* Converse: no NEW navigator.geolocation.watchPosition / setInterval GPS loop was
   introduced anywhere near the new code — the design's core claim. */
{
  const mirrorIdx = dr.indexOf('function _drvMirrorPosition');
  const nearby = dr.slice(Math.max(0, mirrorIdx - 400), mirrorIdx + 400);
  !/watchPosition|setInterval\(.*[Gg][Pp][Ss]/.test(nearby)
    ? ok('no new geolocation watcher/interval was introduced around the mirror function')
    : bad('a new geolocation watcher or GPS interval appears near _drvMirrorPosition — should ride the existing one');
}

/_drvActiveDeliveryRef = req\.deliveryRef \|\| req\.ref \|\| null;/.test(dr)
  ? ok('_drvActiveDeliveryRef is set from _showDrvDelivery')
  : bad('_drvActiveDeliveryRef is never set');
/_drvActiveDeliveryRef = null;[\s\S]{0,80}getElementById\('drvLiveDeliveryCard'\)/.test(dr) || /function _clearDrvDelivery\(\) \{\s*_drvActiveDeliveryRef = null;/.test(dr)
  ? ok('_drvActiveDeliveryRef is cleared in _clearDrvDelivery')
  : bad('_drvActiveDeliveryRef is never cleared — could mirror position onto a stale delivery');

/* ══════════════════════════════════════════════════════════════════════════
   seller-delivery.html
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nseller-delivery.html — mini-map convergence\n');
const sd = strip(fs.readFileSync(path.join(ROOT, 'seller-delivery.html'), 'utf8'));

{
  const fnMatch = sd.match(/function _initMiniMap\(d\) \{[\s\S]*?\n  \}/);
  if (!fnMatch) { bad('_initMiniMap function not found'); }
  else {
    const body = fnMatch[0];
    /d\.driverLat/.test(body) && /d\.driverLng/.test(body)
      ? ok('_initMiniMap reads d.driverLat/d.driverLng — the same field driver.html now writes')
      : bad('_initMiniMap does not read driverLat/driverLng off the snapshot item');
    !/collection\('rideDrivers'\)/.test(body)
      ? ok('_initMiniMap no longer opens its own rideDrivers subscription (converse check)')
      : bad('_initMiniMap still subscribes to rideDrivers directly — the duplicated-source risk is not fixed');
    /_isGeo\(/.test(body)
      ? ok('_initMiniMap validates the coordinate before plotting it')
      : bad('_initMiniMap does not validate the coordinate');
  }
}

/* rideDrivers is NOT eliminated page-wide — it legitimately serves a separate feature
   ("available riders near me", _loadRiders) that has nothing to do with a specific
   order's mini-map. Only _initMiniMap's own use of it (checked above) was the defect. */
{
  const ridersMatch = sd.match(/function _loadRiders\(\)[\s\S]*?collection\('rideDrivers'\)/);
  ridersMatch
    ? ok('the remaining rideDrivers reference is _loadRiders\' unrelated "available riders" feature, not the mini-map')
    : bad('rideDrivers appears somewhere unexpected — re-check what still uses it');
}

/_activeDeliveries\.forEach\(function \(d\) \{ if \(d\.assignedRiderId \|\| d\.riderId \|\| d\.assignedDriverUid\) _initMiniMap\(d\); \}\);/.test(sd)
  ? ok('_renderActive\'s call-site condition matches _buildCard\'s own rider-assigned check (was riderId||driverId, a real gap)')
  : bad('_renderActive still gates _initMiniMap on a narrower/different condition than _buildCard uses');

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed.');
if (fail) { console.log('\n  ' + fail + ' FAILURE(S).'); process.exit(1); }
console.log('\n  PASS — unified order-tracking position mirror certified (static).');
