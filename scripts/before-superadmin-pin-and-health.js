/* Super Admin PIN gate + "health scores: INTERNAL" — BEFORE-PROOF.
   Measures. CHANGES NOTHING.

   Run:  node scripts/before-superadmin-pin-and-health.js

   Two separate questions, measured together because both were reported from the same screen.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const readFn = (f) => fs.readFileSync(path.join(ROOT, 'functions', f), 'utf8');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (!ok && d ? '   [' + String(d).slice(0, 84) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };

console.log('\nSUPER ADMIN PIN + HEALTH SCORES — BEFORE-PROOF');
console.log('='.repeat(78));

/* ══════════════ PART 1 — the PIN ══════════════ */
console.log('\nPART 1 — where the PIN is enforced, and whether it authorises anything');

const sa = read('super-admin.html');
const ad = read('admin.html');

ck('super-admin.html gates on the CLAIM first', /claims\.superAdmin\s*!==\s*true/.test(sa));

/* These two asserted the PRE-fix state — that a passcode gate existed after the claim check.
   The gate has since been removed, so they now assert its ABSENCE. Changed deliberately and
   recorded here rather than quietly: the census below (0 in functions, 0 in rules) is what
   licensed the removal, and it is unchanged. */
ck('the passcode gate is GONE from super-admin.html', !/3026/.test(sa) && !/_promptSuperPass/.test(sa),
   'a passcode gate still stands after the claim check');
ck('   └─ the claim check alone now opens the console',
   /Claim verified/.test(sa) && /authGate'\)\.style\.display='none'/.test(sa));
ck('admin.html device lock is UNCHANGED (separate decision)',
   /String\(secret\)\s*===\s*['"]3026['"]/.test(ad));

/* The decisive question: does the PIN exist anywhere that can enforce it? */
const fnFiles = fs.readdirSync(path.join(ROOT, 'functions')).filter((f) => f.endsWith('.js'));
let inFunctions = 0;
for (const f of fnFiles) if (/\b3026\b/.test(readFn(f))) inFunctions++;
const inRules = /\b3026\b/.test(read('firestore.rules'));
let hashesServerSide = 0;
for (const f of fnFiles) if (/sokoniAdminPinHash|sokoniAdminPatternHash|sokoniAdminPwHash/.test(readFn(f))) hashesServerSide++;

ck('the passcode appears in NO Cloud Function', inFunctions === 0, inFunctions + ' module(s)');
ck('the passcode appears NOWHERE in firestore.rules', !inRules);
ck('the admin device-lock hashes are client-only (localStorage)', hashesServerSide === 0,
   hashesServerSide + ' module(s)');

const filesWithPin = ['admin.html', 'super-admin.html'].filter((f) => /3026/.test(read(f)));
console.log('        => The PIN is a CLIENT-SIDE UI LOCK. It authorises nothing: no callable and');
console.log('           no rule can observe it. The superAdmin claim is the only gate.');
console.log('        => Files still referencing the literal: ' +
            (filesWithPin.length ? filesWithPin.join(', ') : 'none') +
            '  (super-admin.html gate removed; admin.html device lock is a separate decision)');

/* ══════════════ PART 2 — health scores ══════════════ */
console.log('\nPART 2 — "Could not load health scores: INTERNAL"');

ck('the caller invokes getPlatformHealthScores', /httpsCallable\(['"]getPlatformHealthScores['"]\)/.test(sa));
ck('the callable IS exported', /exports\.getPlatformHealthScores/.test(readFn('index.js')));

const ph = readFn('platform-health.js');
const guard = (ph.match(/function requireAdmin\(req\)\s*\{[\s\S]*?\n\}/) || [])[0] || '';
console.log('        guard as written:');
guard.split('\n').forEach((l) => console.log('          ' + l));

/* DEFECT 1 — a plain Error becomes INTERNAL at the callable boundary. */
ck('the guard throws a plain Error, not HttpsError', /throw new Error\(/.test(guard));
console.log('        => firebase-functions converts any non-HttpsError throw into INTERNAL, so a');
console.log('           PERMISSION DENIAL is reported to the client as "INTERNAL". The message');
console.log('           the operator sees is the guard firing, not a crash.');

/* DEFECT 2 — superAdmin is not accepted. */
ck('the guard checks token.admin', /token\?\.admin/.test(guard));
ck('the guard does NOT accept superAdmin', !/superAdmin/.test(guard));
ck('platform-health.js never mentions superAdmin anywhere', !/superAdmin/.test(ph));
console.log('        => An account holding ONLY superAdmin is refused by this guard, even though');
console.log('           super-admin.html admitted it on the superAdmin claim moments earlier.');
console.log('           Every other admin surface treats superAdmin as >= admin.');

const uses = (ph.match(/requireAdmin\(/g) || []).length - 1;   /* minus the definition */
console.log('        => requireAdmin() guards ' + uses + ' callables in this module, so the same');
console.log('           two defects apply to all of them.');

/* Scope, not a defect count. */
let bareThrow = 0;
for (const f of fnFiles) {
  const s = readFn(f);
  if (/onCall\(/.test(s) && /throw new Error\(/.test(s)) bareThrow++;
}
console.log('        => Wider context: ' + bareThrow + ' callable modules contain a bare');
console.log('           `throw new Error(`. That is a CENSUS number for a later pass, not a');
console.log('           claim that all of them are defects.');

un('which of the 5 health dimensions would succeed once the guard passes',
   'needs an authenticated superAdmin call; requireAdmin fires first');
un('whether the operator account holds admin as well as superAdmin',
   'bootstrapAdminClaim grants both; a separately-granted account may hold only superAdmin');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven\n');
console.log('  Measurement only. No PIN removed, no guard changed.\n');
process.exit(fail ? 1 : 0);
