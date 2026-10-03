#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   FUNCTIONS SAFETY GUARD — a functions deploy must not bring a retired payment rail back,
   and must not open production authorisation in source.
   ═══════════════════════════════════════════════════════════════════════════
   HISTORY

   Until 2026-10-03 this guard protected the Daraja (Safaricom direct) STK path: the MSISDN
   normaliser on its three call sites, the fail-closed seller-phone ownership check, and the
   sandbox callback lane. Those protections existed because Daraja code could be redeployed
   from a lineage that lacked them (observed 2026-08-28).

   On 2026-10-03 the owner ordered Daraja removed: SOKONI collects through IntaSend only. The
   four Daraja functions that were live (darajaSTKCallback, webhookMpesa, mpesaC2BValidation,
   mpesaC2BConfirmation) were deleted from production, and the code — including darajaSTKPush,
   validateDarajaCredentials and sendTestSTKPush — was removed from source. Archives:
   C:/temp/daraja-retired-2026-10-03.

   The risk is now the reverse: a deploy from a tree that still carries Daraja would RECREATE
   deleted functions (an unscoped deploy creates every export). So the guard asserts Daraja is
   ABSENT from every functions module. That is stricter than the old checks, not weaker: the
   protected code cannot ship at all.

   Absence is checked on comment-stripped code, so a comment explaining the removal cannot
   satisfy or defeat it. Every detector is proved on a planted sample first (a detector that
   cannot fire proves nothing).

     node scripts/deploy/guard-functions-safety.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FN = path.join(ROOT, 'functions');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test' || e.name === 'lib' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const FILES = walk(FN).map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), code: strip(fs.readFileSync(f, 'utf8')) }));

let fail = 0;
const bad = (msg, detail) => { console.error('  BLOCKED  ' + msg + (detail !== undefined ? '   [' + detail + ']' : '')); fail++; };
const ok = (msg, detail) => console.log('  ok       ' + msg + (detail !== undefined ? '   [' + detail + ']' : ''));

console.log('\nFunctions safety guard — retired rails stay retired\n');
ok('scanned functions modules', FILES.length + ' files');
if (FILES.length < 20 || !FILES.some((f) => f.rel === 'functions/index.js')) bad('the scan did not see the functions tree', FILES.length + ' files');

const DETECTORS = [
  ['no Daraja function is exported',
   /exports\.(darajaSTKPush|darajaSTKCallback|validateDarajaCredentials|sendTestSTKPush|webhookMpesa|mpesaC2BValidation|mpesaC2BConfirmation)\s*=/,
   "exports.darajaSTKPush = onCall({}, async () => {});"],
  ['no Safaricom API endpoint is called',
   /(api|sandbox)\.safaricom\.co\.ke|oauth\/v1\/generate|mpesa\/stkpush|mpesa\/c2b|mpesa\/stkpushquery/,
   "await fetch('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest')"],
  ['no Daraja configuration is read',
   /process\.env\.DARAJA_|darajaConsumerKey|darajaConsumerSecret|darajaPassKey|_darajaToken/,
   "const k = process.env.DARAJA_CONSUMER_KEY;"],
  ['the Daraja C2B module is not required',
   /require\(\s*['"]\.\/mpesa-c2b['"]\s*\)/,
   "const _c2b = require('./mpesa-c2b');"],
];
for (const [label, re, planted] of DETECTORS) {
  if (!re.test(strip(planted)) || re.test(strip('/* ' + planted + ' */'))) { bad('detector cannot be trusted: ' + label); continue; }
  const hits = FILES.filter((f) => re.test(f.code)).map((f) => f.rel + ': ' + f.code.match(re)[0]);
  if (hits.length) bad(label, hits.slice(0, 4).join('; '));
  else ok(label);
}
if (fs.existsSync(path.join(FN, 'mpesa-c2b.js'))) bad('functions/mpesa-c2b.js is present — it would be packaged with every deploy');
else ok('functions/mpesa-c2b.js is absent');

/* production authorisation is an external decision, never code */
const opened = FILES.filter((f) => /productionAuthorized\s*[:=]\s*true/.test(f.code)).map((f) => f.rel);
if (opened.length) bad('productionAuthorized is set true in source — that decision is external, never code', opened.join(', '));
else ok('productionAuthorized is not opened in source');

console.log('');
if (fail) {
  console.error('FUNCTIONS SAFETY GUARD FAILED — ' + fail + ' check(s).\n' +
                'A deploy from this tree could recreate a retired payment rail or open production in code.\n' +
                'Do NOT bypass. Remove the retired code from this lineage first (see the history above).\n');
  process.exit(1);
}
console.log('Functions safety guard PASSED — retired rails absent, production not opened in code.\n');
process.exit(0);
