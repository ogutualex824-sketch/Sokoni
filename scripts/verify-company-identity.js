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

/* Canonical fields that must be populated (no empty / placeholder values). */
const REQUIRED_FIELDS = [
  'legalName', 'brand', 'operatingName', 'incomeTaxStatus', 'kraPin',
  'registrationNumber', 'postalAddress', 'postalCode', 'town', 'country',
  'email', 'supportEmail', 'phone', 'website', 'domain', 'footerCopyright',
];
/* Placeholder tokens that indicate an un-filled value. */
const PLACEHOLDER_RX = /\b(TODO|TBD|XXXX+|YYYY|123456|999999|PLACEHOLDER|CHANGE_?ME)\b/i;

/* Known-obsolete literals that must NEVER reappear (past names / placeholders). */
const FORBIDDEN = [
  'Bravilex International Company Limited', // pre-rename long form
  'SOKONI Ltd',                            // legacy placeholder entity
  'SOKONI Limited',
  'P051999999K',                           // old KRA PIN placeholder
  'P051234567X',                           // old KRA PIN placeholder
];

/* ── Customer-Facing Brand Policy ──────────────────────────────────────
   Brand shown to customers/merchants/riders is ALWAYS "SOKONI". "Bravilex"
   is permitted ONLY as legal footer ("Operated by …"), KRA tax-invoice issuer,
   and the backend settlement account. These phrases put Bravilex in a
   customer-facing brand position (payment / wallet / checkout / subscription /
   merchant dashboard) and must NEVER appear anywhere in source. */
/* Brand Architecture v2.0 (docs/BRAND_POLICY.md) — SOKONI-first, Bravilex-attributed.
 *
 * The line this guard enforces is ATTRIBUTION vs SUBSTITUTION:
 *
 *   "Powered by Bravilex"  names who BUILT the product   -> permitted (v2.0)
 *   "Bravilex Wallet"      names who HOLDS YOUR MONEY    -> forbidden, always
 *
 * Every pattern below makes Bravilex the actor or counterparty in a transaction. A user
 * reading "Bravilex Wallet" or "Paid to Bravilex" could reasonably believe their balance
 * sits with a company they have no relationship with — that is a consumer-protection
 * problem, not a branding preference, which is why this list does NOT relax with the
 * brand architecture.
 *
 * v1.0 also banned "Powered by Bravilex". v2.0 permits it as corporate attribution: the
 * parent company is real and may be credited. It must stay visually subordinate to the
 * SOKONI mark (a rule for review, not something a regex can check). */
const BRAND_FORBIDDEN = [
  /Bravilex\s+Payment\s+Confirmed/i,
  /Paid\s+to\s+Bravilex/i,
  /Bravilex\s+Received(\s+Payment)?/i,
  /Bravilex\s+Wallet/i,
  /Bravilex\s+Balance/i,
  /Bravilex\s+Credits?/i,
  /Bravilex\s+Checkout/i,
  /Bravilex\s+(Earnings|Sales|Orders|Settlements)/i,
  /Subscribed\s+via\s+Bravilex/i,
  /Bravilex\s+Subscription/i,
];
/* JSON-LD must brand as SOKONI (name) with Bravilex only in legalName. */
const JSONLD_NAME_BRAVILEX = /"name"\s*:\s*"Bravilex\b/i;
/* Exact settlement-account bank name — a permitted Bravilex variant ("… Co. Ltd"). */
const SETTLEMENT_ACCOUNT_NAME = 'Bravilex International Co. Ltd';

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

/* 0. Canonical config completeness — every required field populated, no placeholders. */
for (const field of REQUIRED_FIELDS) {
  const val = C[field];
  if (val == null || String(val).trim() === '') {
    errors.push(`sokoni-company.js: required field "${field}" is empty`);
  } else if (PLACEHOLDER_RX.test(String(val))) {
    errors.push(`sokoni-company.js: field "${field}" still holds a placeholder value ("${val}")`);
  }
}

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');

  for (const bad of FORBIDDEN) {
    if (text.includes(bad)) errors.push(`${rel}: contains obsolete literal "${bad}"`);
  }

  /* Brand Architecture v2.0: Bravilex may be attributed, never substituted.
     Scan CODE ONLY — comments are stripped first. A comment that quotes a forbidden
     string in order to explain why it is forbidden is documentation, not a violation;
     flagging it teaches people to delete the explanation instead of fixing the code.
     (Same reasoning as the comment-stripping in scripts/test-overlays.js.) */
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')     /* block comments  */
    .replace(/^\s*\/\/.*$/gm, '')         /* line comments   */
    .replace(/<!--[\s\S]*?-->/g, '');     /* HTML comments   */
  for (const rx of BRAND_FORBIDDEN) {
    const m = code.match(rx);
    if (m) errors.push(`${rel}: brand-policy violation — "${m[0]}" names Bravilex as the party the user TRANSACTS WITH. ` +
      `Corporate attribution ("Powered by Bravilex", "A Bravilex Company") is permitted; naming Bravilex as the ` +
      `wallet/checkout/counterparty is not. Use the SOKONI equivalent. See docs/BRAND_POLICY.md v2.0.`);
  }
  if (JSONLD_NAME_BRAVILEX.test(text))
    errors.push(`${rel}: JSON-LD uses Bravilex as "name" — brand should be "SOKONI" with Bravilex in "legalName"`);

  // Any page that mentions the legal entity must use the CURRENT spelling.
  // (Canonical legalName, OR the exact settlement-account bank name "… Co. Ltd",
  // which is intentionally distinct — banks match exactly.) Modules that consume
  // the canonical settlement-account service may reference "Bravilex" in comments.
  const consumesSettlementAccount = /settlement-account/.test(text) || /Merchant[- ]of[- ]Record/i.test(text)
    || /(^|[\\/])settlement-[a-z]+\.js$/.test(rel) || /(^|[\\/])payment-adapters\.js$/.test(rel);
  if (/Bravilex/.test(text) && !text.includes(CANON.legalName)
      && !text.includes(SETTLEMENT_ACCOUNT_NAME) && !consumesSettlementAccount) {
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
console.log('   legalName         :', C.legalName);
console.log('   registrationNumber:', C.registrationNumber);
console.log('   postalAddress     :', C.postalAddress + ', ' + C.town + ' ' + C.postalCode + ', ' + C.country);
console.log('   kraPin            :', C.kraPin, '(client copy; server = Secret Manager)');
console.log('   footerCopyright   :', C.footerCopyright);
console.log('   domain            :', C.domain);
process.exit(0);
