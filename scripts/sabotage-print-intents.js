/* Sabotage runner for the durable print lifecycle.
   Every edit asserts it matched EXACTLY ONCE inside the intended file before writing, and every
   verdict is the suite's EXIT CODE, not a count of FAIL lines — an aborted run prints no FAIL
   lines at all and reads exactly like a clean pass to anything counting them. */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const CASES = [
  ['a non-host desktop may claim',        'functions/print-intents.js',
   "  if (device.printerHost !== true) {", "  if (false) {"],
  ['the shop boundary is dropped',        'functions/print-intents.js',
   "    if (j.shopId !== device.merchantId) {", "    if (false) {"],
  ['a live lease no longer blocks',       'functions/print-intents.js',
   "    if (held && live && !mine) {", "    if (false) {"],
  ['the fencing token is not checked',    'functions/print-intents.js',
   "    if (!token || !j.claimToken || token !== j.claimToken) {", "    if (false) {"],
  ['mayPrint is true even while PRINTING','functions/print-intents.js',
   "        mayPrint: j.status === STATUS.CLAIMED,", "        mayPrint: true,"],
  ['intent ids become random',            'functions/print-intents.js',
   "  return safe(shopId) + '__' + safe(saleOrReceiptId);",
   "  return safe(shopId) + '__' + safe(saleOrReceiptId) + '__' + crypto.randomBytes(4).toString('hex');"],
  ['legacy relay rows become claimable',  'functions/print-intents.js',
   "      throw new HttpsError('failed-precondition',\n        'That record is not a print intent. Legacy relay logs are not claimable.');",
   "      /* sabotage */"],
  ['a PRINTED job can be reclaimed',      'functions/print-intents.js',
   "    if (j.status === STATUS.PRINTED) {", "    if (false) {"],
  ['retry skips the shop check',          'functions/print-intents.js',
   "      await assertShopAccess({\n        db, uid, shopId: j.shopId, branchId: j.branchId || null,",
   "      await Promise.resolve({\n        db, uid, shopId: j.shopId, branchId: j.branchId || null,"],
  ['the local-drain gate is bypassed',    'sokoni-pos-print-service.js',
   "        const _blocked = this._gateLocalDrain(job);", "        const _blocked = null;"],
  ['the gate allows unclaimed intents',   'sokoni-pos-print-service.js',
   "    if (!job || !job.intentId) return null;", "    return null;"],
];

let caught = 0, missed = 0;
for (const [label, file, find, repl] of CASES) {
  const p = path.join(ROOT, file);
  const orig = fs.readFileSync(p, 'utf8');
  const n = orig.split(find).length - 1;
  if (n !== 1) {
    console.log('  BROKEN PROBE  ' + label + '  (matched ' + n + 'x in ' + file + ', need exactly 1)');
    missed++;
    continue;
  }
  fs.writeFileSync(p, orig.replace(find, repl));
  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, ['scripts/test-print-intent-lifecycle.js'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status === undefined ? 1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }
  fs.writeFileSync(p, orig);

  const fails = (out.match(/^ {2}FAIL/gm) || []).length;
  const aborted = /^ {2}aborted/m.test(out);
  const bit = code !== 0;
  console.log('  ' + (bit ? 'CAUGHT ' : 'MISSED ') + label
    + '   exit=' + code + ' fails=' + fails + (aborted ? ' (aborted)' : ''));
  if (!bit) missed++; else caught++;
}

console.log('\n  ' + caught + ' caught, ' + missed + ' missed / not proven');
process.exit(missed ? 1 : 0);
