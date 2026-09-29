#!/usr/bin/env node
/* build-package-stock.js — publish the ONE package-stock helper to the browser.
 *
 *   node scripts/build-package-stock.js           # writes /sokoni-package-stock.js
 *   node scripts/build-package-stock.js --check   # exit 1 if the browser copy differs (CI / tests)
 *
 * functions/shared/package-stock.js is the source; /sokoni-package-stock.js is a BYTE-IDENTICAL copy so the
 * merchant-v2 catalogue runs the same code as the server. Never edit the copy.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'functions', 'shared', 'package-stock.js');
const OUT = path.join(ROOT, 'sokoni-package-stock.js');
const src = fs.readFileSync(SRC);
if (process.argv.includes('--check')) {
  const same = fs.existsSync(OUT) && fs.readFileSync(OUT).equals(src);
  console.log(same ? 'sokoni-package-stock.js is identical to functions/shared/package-stock.js' : 'DRIFT: run node scripts/build-package-stock.js');
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(OUT, src);
console.log('wrote sokoni-package-stock.js (' + src.length + ' bytes)');
