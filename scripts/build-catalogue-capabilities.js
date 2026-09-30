#!/usr/bin/env node
/* build-catalogue-capabilities.js — publish the ONE catalogue capability matrix to the browser.
 *
 *   node scripts/build-catalogue-capabilities.js           # writes /sokoni-catalogue-capabilities.js
 *   node scripts/build-catalogue-capabilities.js --check   # exit 1 if the browser copy differs (CI / tests)
 *
 * functions/shared/catalogue-capabilities.js is the source; /sokoni-catalogue-capabilities.js is a BYTE-IDENTICAL copy so the
 * merchant-v2 catalogue runs the same code as the server. Never edit the copy.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'functions', 'shared', 'catalogue-capabilities.js');
const OUT = path.join(ROOT, 'sokoni-catalogue-capabilities.js');
const src = fs.readFileSync(SRC);
if (process.argv.includes('--check')) {
  const same = fs.existsSync(OUT) && fs.readFileSync(OUT).equals(src);
  console.log(same ? 'sokoni-catalogue-capabilities.js is identical to functions/shared/catalogue-capabilities.js' : 'DRIFT: run node scripts/build-catalogue-capabilities.js');
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(OUT, src);
console.log('wrote sokoni-catalogue-capabilities.js (' + src.length + ' bytes)');
