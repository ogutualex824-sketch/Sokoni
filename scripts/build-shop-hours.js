#!/usr/bin/env node
/* build-shop-hours.js — publish the ONE shop availability evaluator to the browser.
 *
 *   node scripts/build-shop-hours.js           # writes /sokoni-shop-hours.js
 *   node scripts/build-shop-hours.js --check   # exit 1 if the browser copy differs (CI / tests)
 *
 * functions/shared/shop-hours.js is the source; /sokoni-shop-hours.js is a BYTE-IDENTICAL copy so the
 * storefront and the merchant-v2 preview run the same code as the server. Never edit the copy.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'functions', 'shared', 'shop-hours.js');
const OUT = path.join(ROOT, 'sokoni-shop-hours.js');
const src = fs.readFileSync(SRC);
if (process.argv.includes('--check')) {
  const same = fs.existsSync(OUT) && fs.readFileSync(OUT).equals(src);
  console.log(same ? 'sokoni-shop-hours.js is identical to functions/shared/shop-hours.js' : 'DRIFT: run node scripts/build-shop-hours.js');
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(OUT, src);
console.log('wrote sokoni-shop-hours.js (' + src.length + ' bytes)');
