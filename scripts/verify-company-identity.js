#!/usr/bin/env node
/* ================================================================
   SOKONI — CompanyIdentity consistency guard
   scripts/verify-company-identity.js

   Enforces the "single source of truth" governance rule for corporate
   metadata WITHOUT forcing legal prose to be injected at runtime.

   Rationale: legal documents (terms/privacy/legal) and page footers are
   STATIC HTML by design — a legal notice must never render blank because a
   script failed to load. So those pages keep the literal as their rendered
   artifact, but this guard fails CI if any of those literals DRIFT from the
   canonical values in sokoni-company.js (which the dynamic generators read).

   Canonical sources:
     - sokoni-company.js        → window.SOKONI_COMPANY (client)
     - functions/company-identity.js → COMPANY (server)  [kept in lock-step]

   Usage:  node scripts/verify-company-identity.js
   Exit 0 = consistent, Exit 1 = drift / stale literal detected.
================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ── Load the canonical client config by executing it against a shim ── */
function loadClientCompany() {
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-company.js'), 'utf8');
  const shim = {};
  // The IIFE resolves its target as (window || this); with no `window` in this
  // scope it falls back to `this`, which we bind to `shim`.
  // eslint-disable-next-line no-new-func
  new Function(src).call(shim);
  if (!shim.SOKONI_COMPANY) throw new Error('sokoni-company.js did not set SOKONI_COMPANY');
  return shim.SOKONI_COMPANY;
}

const C = loadClientCompany();

/* Values every static page/footer/legal doc MUST agree with. */
const CANON = {
  legalName:       C.legalName,        // Bravilex International Co. Limited
  footerCopyright: C.footerCopyright,  // © 2026 SOKONI · A product of ... · All Rights Reserved.
  domain:          C.domain,           // mysokoni.co.ke
};

/* Known-obsolete literals that must NEVER reappear (past names / placeholders). */
const FORBIDDEN = [
  'Bravilex International Company Limited', // pre-rename long form
  'SOKONI Ltd',                            // legacy placeholder entity
  'SOKONI Limited',
  'P051999999K',                           // old KRA PIN placeholder
  'P051234567X',                           // old KRA PIN placeholder
];

/* Directories that are not repo source (vendored deps, VCS, temp worktrees). */
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', '.firebase']);
/* This guard intentionally embeds obsolete literals in FORBIDDEN — never scan it. */
const SELF = path.resolve(__filename);

/* Walk the repo for .html/.js (excluding vendored + the canonical sources). */
function collectFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (/\.(html|js)$/.test(entry.name) && path.resolve(full) !== SELF) out.push(full);
  }
  return out;
}

const files = collectFiles(ROOT, []);
const errors = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');

  for (const bad of FORBIDDEN) {
    if (text.includes(bad)) errors.push(`${rel}: contains obsolete literal "${bad}"`);
  }

  // Any page that mentions the legal entity must use the CURRENT spelling.
  // (The canonical spelling is CANON.legalName; a near-miss is drift.)
  if (/Bravilex/.test(text) && !text.includes(CANON.legalName)) {
    errors.push(`${rel}: references "Bravilex" but not the canonical legal name "${CANON.legalName}"`);
  }
}

if (errors.length) {
  console.error('❌ CompanyIdentity drift detected:\n');
  errors.forEach((e) => console.error('  • ' + e));
  console.error(`\n${errors.length} issue(s). Fix to match sokoni-company.js / company-identity.js.`);
  process.exit(1);
}

console.log('✅ CompanyIdentity consistent across', files.length, 'files.');
console.log('   legalName      :', CANON.legalName);
console.log('   footerCopyright:', CANON.footerCopyright);
console.log('   domain         :', CANON.domain);
process.exit(0);
