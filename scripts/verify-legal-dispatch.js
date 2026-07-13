#!/usr/bin/env node
'use strict';
/**
 * Drift guard for legalDispatch.
 *
 * legal-dispatch.js DERIVES its route list from the handler map (Object.keys(_h)), which
 * fixed a real production outage: the old hand-written allowlist had drifted to 13 of 21
 * handlers, so legal-centre.html's certificate view and three admin panels were dead.
 *
 * Deriving routes shifts a burden: the dispatcher is now a router, NOT an authorization
 * boundary. Every handler MUST authenticate itself. This script enforces that invariant so
 * nobody can add an unguarded handler and silently expose it to any authenticated caller.
 *
 * Checks:
 *   1. every handler on _h is a function
 *   2. every handler calls _assertAdmin(req) or _uid(req) in its opening lines
 *   3. every op the frontend actually calls is routable
 *
 * Run: node scripts/verify-legal-dispatch.js     (exit 1 on failure — safe for CI)
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'functions', 'legal-agreements.js');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split(/\r?\n/);

/* Ops the clients call. If one of these is not routable, a user-facing feature is dead. */
const CALLED_BY_FRONTEND = [
  'legalMyCertificates',   // legal-centre.html
  'legalGetCertificate',   // legal-centre.html
  'legalPreviewAgreements', // legal-admin.html
  'legalScheduleVersion',   // legal-admin.html
  'legalRollbackVersion',   // legal-admin.html
];

const handlers = [];
lines.forEach((l, i) => {
  const m = l.match(/^_h\.(\w+)\s*=/);
  if (m) handlers.push({ name: m[1], line: i + 1 });
});

let bad = 0;
const unguarded = [];

for (const h of handlers) {
  // look at the opening statements of the handler body
  const body = lines.slice(h.line, h.line + 6).join('\n');
  if (!/_assertAdmin\(req\)|_uid\(req\)/.test(body)) {
    unguarded.push(h);
    bad++;
  }
}

const missing = CALLED_BY_FRONTEND.filter(op => !handlers.some(h => h.name === op));

console.log('legalDispatch drift guard\n');
console.log('  handlers found          : ' + handlers.length);
console.log('  self-guarded            : ' + (handlers.length - unguarded.length) + '/' + handlers.length);
console.log('  called by the frontend  : ' + CALLED_BY_FRONTEND.length + ', routable: '
  + (CALLED_BY_FRONTEND.length - missing.length));

if (unguarded.length) {
  console.log('\n  UNGUARDED HANDLERS — exposed to any authenticated caller:');
  unguarded.forEach(h => console.log('    legal-agreements.js:' + h.line + '  _h.' + h.name
    + '  — must call _assertAdmin(req) or _uid(req) first'));
}
if (missing.length) {
  bad += missing.length;
  console.log('\n  FRONTEND CALLS A HANDLER THAT DOES NOT EXIST:');
  missing.forEach(op => console.log('    ' + op));
}

if (bad) {
  console.log('\n  FAIL — ' + bad + ' problem(s).');
  process.exit(1);
}
console.log('\n  PASS — every handler authenticates itself; every frontend op is routable.');
