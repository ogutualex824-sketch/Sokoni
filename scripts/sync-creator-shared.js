/* sync-creator-shared.js — publish the Creator Hub's UMD rule modules to the
 * hosting root. functions/** is not served (firebase.json hosting.ignore), so
 * the browser loads a COPY; functions/shared/ is the only source of truth.
 * scripts/test-creator-publishing.js fails if a copy drifts.
 *
 *   node scripts/sync-creator-shared.js          write copies
 *   node scripts/sync-creator-shared.js --check  exit 1 if any copy differs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PAIRS = [
  ['functions/shared/creator-publishing.js', 'sokoni-creator-rules.js'],
  ['functions/shared/creator-watermark.js', 'sokoni-watermark.js'],
  ['functions/shared/creator-commercial.js', 'sokoni-creator-commercial.js'],
  ['functions/shared/event-refund-reasons.js', 'sokoni-event-refund-reasons.js'],
];
const check = process.argv.includes('--check');
let drift = 0;
for (const [src, dst] of PAIRS) {
  const a = fs.readFileSync(path.join(ROOT, src));
  const dp = path.join(ROOT, dst);
  const b = fs.existsSync(dp) ? fs.readFileSync(dp) : null;
  if (b && a.equals(b)) { console.log('  same   ' + dst); continue; }
  if (check) { drift++; console.log('  DRIFT  ' + dst + ' differs from ' + src); continue; }
  fs.writeFileSync(dp, a); console.log('  wrote  ' + dst);
}
process.exit(drift ? 1 : 0);
