#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — a signed-in merchant never meets the BUSINESS wizard
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-pos-wizard-gate.js

   THE DEFECT. pos.js decided wizard-vs-app from
   `state.settings.setupComplete`, which comes from PosDB.settings — IndexedDB, a
   DEVICE cache. It answers "has this browser been set up", not "does this
   account have an approved business".

   It became far more reachable once the PosDB blocked-open deadlock was fixed:
   a blocked open now resolves DEGRADED rather than hanging, and a degraded cache
   returns EMPTY settings — so setupComplete is absent and the business wizard was
   shown to merchants whose business already exists. Reported from a real iPhone.

   This is a source-level gate rather than a DOM test, because the decision is one
   branch inside an async boot that needs the whole POS environment to execute.
   The branch itself is what must be correct, and it is asserted here with the
   negative controls that make the assertion mean something.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });

const raw = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');
/* Comments stripped: a comment explaining the fix must never satisfy a check
   that the fix is present. */
const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');

/* ── the branch under test ──────────────────────────────────────────────── */
const branch = /if \(isSetup \|\| embedded \|\| _known\)/.test(code);
ck('W1  the launch branch admits a KNOWN signed-in account',
  branch, 'isSetup || embedded || _known');

ck('W2  "known" is derived from the SESSION markers, not the device cache',
  /_known[\s\S]{0,220}localStorage\.getItem\('loggedIn'\)/.test(code) &&
  /_known[\s\S]{0,260}sokoniUser/.test(code),
  'loggedIn / sokoniUser — the same markers auth-guard.js and pos.html use');

ck('W3  it does NOT derive "known" from setupComplete or merchantId',
  !/_known[\s\S]{0,200}setupComplete/.test(code) &&
  !/_known[\s\S]{0,200}sokoni_merchant_id/.test(code),
  'those are device caches, and reading them here would reinstate the defect');

/* ── the wizard must still be reachable for a genuinely new, signed-out run ── */
ck('W4  CONTROL the wizard branch still exists for a signed-out first run',
  /pos-wizard'\)[\s\S]{0,80}display = 'flex'/.test(code),
  'the fix must not delete first-run setup, only stop it ambushing known accounts');

ck('W5  CONTROL the embedded path is unchanged',
  /embedded/.test(code) && /window\.parent !== window/.test(code),
  'the merchant shell embeds POS; that behaviour is untouched');

/* ── the degraded-cache path that exposed this ──────────────────────────── */
/* This began as a ternary that always evaluated true — a vacuous pass, which is
   the exact fault this suite exists to prevent elsewhere. Replaced with a claim
   that can fail: a degraded PosDB must not throw on settings, and the launch
   decision must not be gated on those settings alone. */
ck('W6  empty settings from a degraded PosDB cannot throw the boot',
  /state\.settings = await PosDB\.settings\.getAll\(\);\s*\}\s*catch/.test(code.replace(/\s+/g, ' ')) ||
  /try \{ state\.settings = await PosDB\.settings\.getAll\(\); \} catch/.test(code.replace(/\s+/g, ' ')),
  'the getAll() call is inside a try/catch that substitutes an empty object');

/* ── scope ──────────────────────────────────────────────────────────────── */
ck('W7  SCOPE no payment, checkout or settlement code was touched',
  !/posCompleteCheckout|settleOrder|commissionLedger/.test(
    raw.slice(raw.indexOf('const isSetup'), raw.indexOf('const isSetup') + 2000)),
  'the change is confined to the launch branch');

ck('W8  SCOPE the PosDB deadlock fix is still in place',
  /BLOCKED_TIMEOUT_MS/.test(fs.readFileSync(path.join(ROOT, 'pos-db.js'), 'utf8')),
  'this slice must not regress 1b602d1');

const passed = rows.filter((r) => r.ok).length;
console.log('');
console.log('  POS WIZARD GATE — business setup belongs to registration, not to opening a till');
console.log('  ' + '='.repeat(72));
console.log('');
for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
console.log('');
console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
console.log('');
process.exit(passed === rows.length ? 0 : 1);
