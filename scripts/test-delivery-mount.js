#!/usr/bin/env node
/* ============================================================================
   SOKONI — the delivery surface mount            scripts/test-delivery-mount.js
   ============================================================================
   §3 of the closure mandate, for the one delivery relationship the evidence
   supports: Marketplace fulfilment (packageRequests), buyer/seller/rider.

   The two things that must hold:

     1. The page asks the SERVER what to draw. It must not map a delivery
        status onto a relationship state itself — two lifecycle tables is how
        one screen offers a call the server refuses.

     2. A Delivery Hub record offers NOTHING. Hub is a different product with no
        `sender` role in the frozen authority, so a button there would mean
        aliasing a hub ref into an anchor that resolves packageRequests.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(name + (detail ? '  — ' + detail : ''));
  return false;
}

/* HTML carries BOTH comment syntaxes, and the comments here discuss the hub at
   length — so both must go before asserting, or the suite reads my own prose. */
function stripAll(src) {
  let out = src.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/^\s*\/\/.*$/gm, '');
  return out;
}

const raw = fs.readFileSync(path.join(ROOT, 'delivery-tracking.html'), 'utf8');
const code = stripAll(raw);

ok('CONTROL: the stripped page is still readable', code.indexOf('_onDelivery') !== -1);
ok('CONTROL: stripping actually removed prose', code.length < raw.length * 0.95);

/* ── 1. The mount exists and is server-driven ───────────────────────────── */
ok('the page loads the Connect action module',
  raw.indexOf('sokoni-connect-call.js') !== -1);
ok('a slot exists for the actions', code.indexOf('id="dtConnectActions"') !== -1);
ok('the mount goes through mountForAnchor, the server-driven path',
  code.indexOf('SokoniConnectCall.mountForAnchor') !== -1);
ok('it passes the delivery anchor type', /anchorType:\s*'delivery'/.test(code));
ok('it reaches the server through connectDispatch',
  code.indexOf("sokoniCallable('connectDispatch')") !== -1);

/* ── 2. The client invents no lifecycle ─────────────────────────────────── */
ok('the page never sends a relationshipState', code.indexOf('relationshipState') === -1);
ok('the page never calls the surface policy itself', code.indexOf('shouldShow') === -1);
ok('the page never calls callSurfaceFor itself', code.indexOf('callSurfaceFor') === -1);
ok('the page names no counterparty uid in the request',
  !/calleeUid|targetUid/.test(code));

/* ── 3. THE HUB IS NOT OFFERED ──────────────────────────────────────────── */
ok('the mount is gated on the marketplace source',
  /_delivSource\s*!==\s*'pkg'/.test(code));
ok('…and also on the hub marker carried by the normalised document',
  /_src\s*===\s*'hub'/.test(code.slice(code.indexOf('_mountDeliveryActions'))));
ok('a hub record CLEARS the slot rather than leaving a stale button',
  /slot\.innerHTML\s*=\s*''/.test(code));

/* The anchor must be the packageRequests DOCUMENT ID. delivRef is that id:
   listenDelivery -> SokoniDB.listenPackageRequest -> doc(db,'packageRequests',ref). */
ok('the anchor id is delivRef, the packageRequests document id',
  /anchorId\s*=\s*delivRef/.test(code));
{
  const db = fs.readFileSync(path.join(ROOT, 'sokoni-db.js'), 'utf8');
  ok('CONTROL: and that really is a packageRequests document lookup',
    /doc\(db,\s*'packageRequests',\s*ref\)/.test(db));
}
ok('the hub deliveryRef FIELD is never used as the anchor',
  !/anchorId\s*=\s*.*deliveryRef/.test(code));

/* ── 4. THE ID COLLISION THAT NEARLY SHIPPED ────────────────────────────── */
/* dtActions already belonged to the role-dependent buttons _renderActions
   draws. getElementById returns the FIRST match, so a duplicate id would have
   had _renderActions write into the Connect slot and mountForAnchor clobber it.
   Asserted by name so it cannot come back. */
const idCount = (id) => (raw.match(new RegExp('id="' + id + '"', 'g')) || []).length;
ok('dtActions appears exactly once', idCount('dtActions') === 1, String(idCount('dtActions')));
ok('dtConnectActions appears exactly once',
  idCount('dtConnectActions') === 1, String(idCount('dtConnectActions')));
ok('the Connect slot is NOT the role-button container',
  code.indexOf("getElementById('dtConnectActions')") !== -1 &&
  code.indexOf("_renderActions") !== -1);

/* Every id on the page is unique — the general form of the same defect. */
{
  const ids = (raw.match(/\sid="([^"]+)"/g) || []).map((m) => m.slice(5, -1));
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  ok('no duplicate element id anywhere on the page',
    dupes.length === 0, Array.from(new Set(dupes)).join(','));
  ok('CONTROL: the id sweep found ids at all', ids.length > 10, String(ids.length));
}

/* ── 5. Re-entrancy: a live listener re-fires constantly ────────────────── */
ok('the mount is guarded against re-mounting the same anchor',
  /_actionsMountedFor/.test(code));
ok('…and the guard resets when the record is not mountable',
  /_actionsMountedFor\s*=\s*null/.test(code));

console.log('');
console.log('  SOKONI delivery surface mount — closure mandate §3');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
