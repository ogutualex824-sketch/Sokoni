#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────────
   functions-allowlist.js — build a SAFE `firebase deploy --only functions:…`

   WHY NOT AN "ALLOWLIST OF EVERYTHING SAFE"
   functions/index.js exports ~1468 functions. A list of every safe one is
   neither deployable (command length, deploy duration, quota) nor meaningful —
   redeploying 1400 unchanged functions to ship one fix is its own risk.

   So the unit of release is: **what changed, minus what is blocked.**

   `firebase deploy --only functions` (blanket) is forbidden because
   inventoryTransferSubtype is already exported and would ship unverified.

   USAGE
     node scripts/deploy/functions-allowlist.js darajaSTKPush [more…]
     node scripts/deploy/functions-allowlist.js --changed       (infer from git)

   Exits non-zero if any requested function is BLOCKED. Prints the command; it
   never runs a deploy itself.
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'functions', 'index.js');

/* ── BLOCKED ────────────────────────────────────────────────────────────────
   Each entry names the verification that is missing. A function leaves this
   list only when that verification PASSES — never to unblock a release.      */
const BLOCKED = [
  { re: /^inventory/i,  why: 'JDK 21 — concurrency + oversell proof unexecuted' },
  { re: /^landlord/i,   why: 'JDK 21 — 26 landlord rule assertions unexecuted' },
  { re: /^tenantLedger/i, why: 'JDK 21 — landlord ledger rules unexecuted' },
  { re: /receipt/i,     why: 'Phase 7 — receiptNo→receiptNumber rename, needs a real merchant' },
  { re: /^pos[A-Z]/,    why: 'Phase 7 — needs printer + cash drawer + multi-till verification' },
  { re: /^multiTill/i,  why: 'Phase 7 — needs a real merchant with two tills' },
  { re: /^cm[A-Z]/,     why: 'Phase 7 — cash manager, needs cash drawer verification' },
];

function exportedNames() {
  const src = fs.readFileSync(INDEX, 'utf8');
  const out = new Set();
  const re = /^exports\.([A-Za-z0-9_]+)\s*=/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

function blockedReason(name) {
  const hit = BLOCKED.find((b) => b.re.test(name));
  return hit ? hit.why : null;
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: functions-allowlist.js <functionName…>  |  --changed');
  process.exit(2);
}

const known = exportedNames();
let requested = args;

if (args[0] === '--changed') {
  /* Infer from what changed vs LIVE. Fail closed: if the baseline cannot be
     established, say so rather than emitting a command that looks authoritative. */
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '10', 'https://mysokoni.co.ke/version.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const live = String(JSON.parse(out).commit || '').trim();
    execFileSync('git', ['cat-file', '-e', live + '^{commit}'], { stdio: 'ignore' });
    const diff = execFileSync('git', ['diff', '-U0', live, 'HEAD', '--', 'functions/'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const touched = new Set();
    for (const line of diff.split('\n')) {
      const m = /^[+-]\s*exports\.([A-Za-z0-9_]+)\s*=/.exec(line);
      if (m) touched.add(m[1]);
    }
    requested = [...touched];
    console.log('# inferred from diff ' + live.slice(0, 7) + '..HEAD');
    if (!requested.length) {
      console.log('# No exported function definitions changed.');
      console.log('# NOTE: a change INSIDE a function body is not detected here —');
      console.log('#       name the function explicitly in that case.');
      process.exit(0);
    }
  } catch (e) {
    console.error('BASELINE UNKNOWN — cannot infer changed functions. Name them explicitly.');
    process.exit(1);
  }
}

const unknown = requested.filter((n) => !known.has(n));
const blocked = requested.map((n) => [n, blockedReason(n)]).filter(([, w]) => w);

if (unknown.length) {
  console.error('NOT EXPORTED from functions/index.js: ' + unknown.join(', '));
  console.error('A function absent from index.js does not deploy — re-export it by name first.');
  process.exit(1);
}

if (blocked.length) {
  console.error('BLOCKED — refusing to emit a deploy command:');
  for (const [n, why] of blocked) console.error('  ' + n + '  — ' + why);
  console.error('\nThese ship only in the Phase 7 bundle, after their verification passes.');
  process.exit(1);
}

console.log('\nfirebase deploy --only ' + requested.map((n) => 'functions:' + n).join(',') + '\n');
console.log('# ' + requested.length + ' function(s). Verify live after deploying, then monitor.');
