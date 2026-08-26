/* Sabotage runner for the phone-sale bridge.
   Every edit asserts it matched EXACTLY ONCE before writing; every verdict is the suite's
   EXIT CODE. A sabotage that changes nothing is a broken probe, never evidence that the
   assertion it targets is redundant. */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const SUITES = ['scripts/test-print-sale-bridge.js', 'scripts/test-print-intent-lifecycle.js'];

const CASES = [
  ['an in-flight sale creates an intent', 'functions/print-intents.js',
   "    if (sale.status !== 'completed') return;", "    if (false) return;"],

  ['intents are created with no host', 'functions/print-intents.js',
   "    if (hostSnap.empty) return;", "    if (false) return;"],

  ['the receipt number becomes the identity', 'functions/print-intents.js',
   "    const id  = intentDocId(shopId, saleId);",
   "    const id  = intentDocId(shopId, String(saleId).slice(-8).toUpperCase());"],

  ['the intent copies the sale totals', 'functions/print-intents.js',
   "        source:    { collection: 'posRetailSales', id: saleId },",
   "        source:    { collection: 'posRetailSales', id: saleId },\n        grandTotal: sale.grandTotal, items: sale.items,"],

  ['the mayPrint guard is removed', 'sokoni-print-host-listener.js',
   "    if (!claim || claim.mayPrint !== true) {", "    if (false) {"],

  ['a failing transport is reported as success', 'sokoni-print-host-listener.js',
   "      if (res && res.ok === false) throw new Error(res.error || 'printer reported failure');",
   "      void res;"],

  ['the render happens before the claim', 'sokoni-print-host-listener.js',
   "    var claim;\n    try {\n      claim = await deps.claim({ jobId: jobId, deviceId: S.deviceId });",
   "    var claim;\n    try {\n      deps.render({});\n      claim = await deps.claim({ jobId: jobId, deviceId: S.deviceId });"],

  ['the listener query drops the kind discriminator', 'sokoni-print-host-listener.js',
   "        fsMod.where('kind', '==', 'printIntent'),", "        /* sabotage */"],

  ['the local-drain gate is removed', 'sokoni-pos-print-service.js',
   "  _gateLocalDrain (job) {", "  _removedGate (job) {"],

  ['the composite index is dropped', 'firestore.indexes.json',
   '"collectionGroup": "posPrintJobs"', '"collectionGroup": "posPrintJobsXX"'],
];

let caught = 0, missed = 0;
for (const [label, file, find, repl] of CASES) {
  const p = path.join(ROOT, file);
  const orig = fs.readFileSync(p, 'utf8');
  const n = orig.split(find).length - 1;
  if (n !== 1) {
    console.log('  BROKEN PROBE  ' + label + '  (matched ' + n + 'x in ' + file + ')');
    missed++; continue;
  }
  fs.writeFileSync(p, orig.replace(find, repl));

  let worst = 0; const detail = [];
  for (const suite of SUITES) {
    let code = 0, out = '';
    try { out = execFileSync(process.execPath, [suite], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { code = e.status === undefined ? 1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }
    const fails = (out.match(/^ {2}FAIL/gm) || []).length;
    if (code !== 0) worst = 1;
    detail.push(path.basename(suite, '.js').replace('test-print-', '') + '(exit=' + code + ',f=' + fails + (/^ {2}aborted/m.test(out) ? ',abort' : '') + ')');
  }
  fs.writeFileSync(p, orig);

  console.log('  ' + (worst ? 'CAUGHT ' : 'MISSED ') + label.padEnd(42) + detail.join(' '));
  if (worst) caught++; else missed++;
}

console.log('\n  ' + caught + ' caught, ' + missed + ' missed / not proven');
process.exit(missed ? 1 : 0);
