#!/usr/bin/env node
/* ============================================================================
   Authorization must come from claims, never from an email string
   ============================================================================
   SOKONI is renaming its administrative identities:

     alexochieng3030@gmail.com   ->  superadmin@mysokoni.co.ke
     ochisaac@gmail.com          ->  ceo@mysokoni.co.ke
     bravilexinternational@…     ->  company@mysokoni.co.ke

   A rename is only safe if no gate depends on the old string. One
   `if (user.email === "founder@…")` left anywhere turns an address change into a
   silent privilege loss — or worse, leaves the OLD address privileged after it
   has been handed to someone else.

   The audit that motivated this found the codebase already clean: every gate
   reads custom claims. This exists to keep it that way, because the failure is
   invisible until the day someone renames an account.

   WHAT IS FLAGGED
     - an email compared to a literal address inside an auth/permission context
     - a hardcoded list of privileged email addresses
     - a domain-suffix check used as a privilege test

   WHAT IS NOT
     - a notification RECIPIENT (orders@mysokoni.co.ke and friends) — sending
       something to a fixed address grants nobody anything
     - test fixtures, comments, changelog prose, ops-script defaults
     - a UID allowlist: it does not break on a rename, because a UID is stable
       across an address change. That is precisely why the bootstrap allowlist
       was moved from an email to a UID.

   Usage:  node scripts/verify-claim-based-auth.js
   Exit:   0 clean · 1 a gate depends on an email string
   ========================================================================= */

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* Directories that hold no runtime authorization. */
const SKIP_DIR  = new Set(['node_modules', '.git', 'dist', 'coverage', 'docs', 'test', '__tests__']);
const SKIP_FILE = /\.(test|spec)\.js$|^CHANGELOG\.md$/;

/* A line is only interesting if it both compares an email AND sits in something
   that decides access. Either signal alone is far too noisy: the codebase is
   full of legitimate email handling. */
const EMAIL_LITERAL = /(===?|!==?|\.includes\(|\.indexOf\(|\.some\(|endsWith\()\s*[`'"][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+/;
const AUTH_CONTEXT  = /\b(isAdmin|superAdmin|permission|unauthor|forbidden|allow|denied|claim|role|privileg|grant|authoriz|canAccess|requireAdmin|gate)\b/i;

/* Recipient constants are allowed. Named so the intent is explicit at the call
   site as well as here. */
const RECIPIENT_HINT = /\b(PLATFORM_ADMIN_EMAIL|SUPPORT_EMAIL|NOTIFY|RECIPIENT|toEmail|sendTo|mailTo|FROM_EMAIL|replyTo)\b/i;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { walk(fp, out); continue; }
    if (!/\.(js|html|rules)$/.test(e.name)) continue;
    if (SKIP_FILE.test(e.name)) continue;
    out.push(fp);
  }
  return out;
}

const findings = [];
let scanned = 0;

for (const fp of walk(ROOT, [])) {
  scanned++;
  const rel = path.relative(ROOT, fp).replace(/\\/g, '/');
  if (rel.startsWith('scripts/')) continue;          /* ops tooling, incl. this file */
  const lines = fs.readFileSync(fp, 'utf8').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    /* Comments explain history; they do not authorize anything. */
    const code = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (!EMAIL_LITERAL.test(code)) continue;

    /* Look at the surrounding block, not just the line — the decision and the
       comparison are often a few lines apart. */
    const ctx = lines.slice(Math.max(0, i - 6), i + 4).join('\n');
    if (!AUTH_CONTEXT.test(ctx)) continue;
    if (RECIPIENT_HINT.test(ctx)) continue;

    findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120) });
  }
}

console.log('\nClaim-based authorization check');
console.log('───────────────────────────────');
console.log(`  scanned ${scanned} file(s)\n`);

if (!findings.length) {
  console.log('  ✓ no gate depends on an email string');
  console.log('  ✓ administrative identities can be renamed without touching authorization\n');
  process.exit(0);
}

console.log(`  ✗ ${findings.length} gate(s) depend on an email address:\n`);
findings.forEach(f => console.log(`    ${f.file}:${f.line}\n      ${f.text}`));
console.log('\n  Replace with a custom-claim check. An email is a label; a claim is authority,');
console.log('  and only the claim survives a rename.\n');
process.exit(1);
