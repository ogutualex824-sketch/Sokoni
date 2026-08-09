#!/usr/bin/env node
/* The delivery engine exists in two PLACES but must never be two ENGINES.
 *
 *   sokoni-delivery-engine.js            served to the browser
 *   functions/shared/delivery-engine.js  uploaded with the Cloud Functions
 *
 * Firebase uploads only the `functions` directory, so the server cannot require
 * the root file — a `require('../…')` deploys green and then throws on the first
 * checkout. Copying is therefore forced by the platform. What is NOT forced is
 * letting the copies drift: if they diverge, the server recomputes a different
 * fee from the one the customer was shown, and every order is rejected as a
 * mismatch. This gate makes that impossible to ship.
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const A = path.join(ROOT, 'sokoni-delivery-engine.js');
const B = path.join(ROOT, 'functions', 'shared', 'delivery-engine.js');

const norm = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const sum  = (f) => crypto.createHash('sha256').update(norm(f)).digest('hex').slice(0, 12);

for (const f of [A, B]) {
  if (!fs.existsSync(f)) {
    console.error('FAIL delivery engine missing: ' + path.relative(ROOT, f));
    process.exit(1);
  }
}

if (sum(A) !== sum(B)) {
  console.error('FAIL delivery engine copies have DIVERGED');
  console.error('  sokoni-delivery-engine.js           ' + sum(A));
  console.error('  functions/shared/delivery-engine.js ' + sum(B));
  console.error('\n  The server would price delivery differently from the client,');
  console.error('  rejecting every order as a mismatch. Copy the canonical file:');
  console.error('    cp sokoni-delivery-engine.js functions/shared/delivery-engine.js');
  process.exit(1);
}

console.log('PASS delivery engine in sync (' + sum(A) + ')');
