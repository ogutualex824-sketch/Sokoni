#!/usr/bin/env node
/* Daraja STK payload field limits — both call sites.
 *
 *   Daraja caps AccountReference at ~12 characters and TransactionDesc at ~13,
 *   and rejects non-ASCII. A payload that breaches either is refused on FORMAT,
 *   which presents to the merchant as "bad credentials" — a failure that points
 *   at the wrong thing.
 *
 * WHY BOTH CALL SITES
 * `darajaSTKPush` slices TransactionDesc to 13; `sendTestSTKPush` did not, so
 * the KES 1 live test could fail on FORMAT where the real push succeeded.
 * Testing one would have proved the half that already worked.
 *
 * `validateDarajaCredentials` is NOT a third call site: it only requests an
 * OAuth token and builds no STK payload, so it has no field limits to breach.
 *
 * DETECTOR NOTE
 * The source comments deliberately discuss em dashes and over-long strings, so
 * a naive non-ASCII scan flags the explanation rather than the payload. Comments
 * are stripped BEFORE any assertion, and section E proves the stripped detector
 * still catches a real breach.
 *
 *   node scripts/test-daraja-stk-payload.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
/* Strip block and line comments — see DETECTOR NOTE. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const AR_MAX = 12, TD_MAX = 13;
const nonAscii = (s) => [...s].filter((c) => c.charCodeAt(0) > 127);

/* ══ A. Every literal TransactionDesc in executable code is legal ═══════════ */
console.log('\nA. TransactionDesc literals\n');
{
  const lits = [...CODE.matchAll(/TransactionDesc:\s*"([^"]*)"/g)].map((m) => m[1]);
  ck('at least one literal found (detector is looking at real code)', lits.length > 0, lits.length + ' found');
  lits.forEach((s) => {
    ck('"' + s + '" within ' + TD_MAX + ' chars', s.length <= TD_MAX, s.length + ' chars');
    ck('"' + s + '" is pure ASCII', nonAscii(s).length === 0,
       nonAscii(s).length ? 'contains ' + nonAscii(s).join('') : 'ascii');
  });
}

/* ══ B. AccountReference likewise ═══════════════════════════════════════════ */
console.log('\nB. AccountReference literals\n');
{
  const lits = [...CODE.matchAll(/AccountReference:\s*"([^"]*)"/g)].map((m) => m[1]);
  ck('at least one literal found', lits.length > 0, lits.length + ' found');
  lits.forEach((s) => {
    ck('"' + s + '" within ' + AR_MAX + ' chars', s.length <= AR_MAX, s.length + ' chars');
    ck('"' + s + '" is pure ASCII', nonAscii(s).length === 0);
  });
}

/* ══ C. The specific regression that prompted this suite ═══════════════════ */
console.log('\nC. The 2026-08-26 regression stays fixed\n');
{
  ck('the 27-char em-dash description is GONE from executable code',
     !/SOKONI Payment Test/.test(CODE));
  ck('sendTestSTKPush now sends a short ASCII description',
     /TransactionDesc:\s*"SOKONI Test"/.test(CODE));
}

/* ══ D. The dynamic path still slices ══════════════════════════════════════ */
console.log('\nD. darajaSTKPush still bounds caller-supplied text\n');
{
  ck('TransactionDesc is sliced to ' + TD_MAX,
     new RegExp('TransactionDesc:[^,]*slice\\(0, ' + TD_MAX + '\\)').test(CODE));
  ck('AccountReference is sliced to ' + AR_MAX,
     new RegExp('AccountReference:[^,]*slice\\(0, ' + AR_MAX + '\\)').test(CODE));
}

/* ══ E. Negative controls — a detector that cannot fail proves nothing ═════ */
console.log('\nE. Negative controls\n');
{
  const bad = 'SOKONI Payment Test — 1 KES';
  ck('length detector DOES flag a 27-char description', bad.length > TD_MAX, bad.length + ' chars');
  ck('ascii detector DOES flag an em dash', nonAscii(bad).length === 1, 'found ' + nonAscii(bad).join(''));
  ck('comment-stripping did NOT remove the payload literals',
     /TransactionDesc:/.test(CODE) && /AccountReference:/.test(CODE));
  /* The stripper must remove commentary without eating code — prove both. */
  const probe = '/* TransactionDesc: "an em dash — lives here" */\nTransactionDesc: "ok",';
  const stripped = probe.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('  ...and it DOES remove a comment that would false-positive',
     nonAscii(stripped).length === 0 && /TransactionDesc:\s*"ok"/.test(stripped));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
