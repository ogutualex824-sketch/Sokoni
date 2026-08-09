#!/usr/bin/env node
/* ============================================================================
   Admin markup integrity — unbalanced <div> and broken inline scripts
   ============================================================================
   Written after shipping exactly the bug it checks for.

   A status filter was inserted one line too early in admin.html and brought a
   spare `</div>` with it. That extra close ended `#adm-pane-users` prematurely,
   so the users table, its pager and the detail slide-in became SIBLINGS of the
   pane instead of children. `.adm-pane { display:none }` hides the pane element
   and nothing else, so those three blocks rendered on every other admin pane —
   and the page still looked fine in the diff, still parsed, still passed every
   other gate. It reached production as v199.

   Two cheap invariants catch it:

     1. <div> opens and closes balance across the file.
     2. Every inline <script> block parses.

   Neither proves the layout is correct. Both make "I moved some markup and it
   still renders" a claim with something behind it.

   Usage:  node scripts/verify-admin-markup.js [file...]
   Exit:   0 clean · 1 any failure
   ========================================================================= */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const argFiles = process.argv.slice(2).filter(a => !a.startsWith('--'));
const files = argFiles.length ? argFiles
  : ['admin.html', 'super-admin.html', 'moderation.html', 'trust-safety.html', 'verification-admin.html'];

let failures = 0;

for (const rel of files) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) continue;
  const src = fs.readFileSync(fp, 'utf8');

  /* Ignore markup inside <script> strings and HTML comments — a renderer that
     builds '<div>' in a template literal is not an unclosed tag. */
  const markup = src
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const opens  = (markup.match(/<div\b/g) || []).length;
  const closes = (markup.match(/<\/div>/g) || []).length;
  const delta  = opens - closes;

  console.log(`\n${rel}`);
  console.log('─'.repeat(rel.length));
  if (delta === 0) {
    console.log(`  ✓ <div> balanced (${opens} open, ${closes} close)`);
  } else {
    failures++;
    console.log(`  ✗ <div> UNBALANCED: ${opens} open, ${closes} close (${delta > 0 ? '+' : ''}${delta})`);
    console.log(delta < 0
      ? '    Too many closes — a container is ending early, and everything after it'
      : '    Too few closes — a container is swallowing markup that follows it,');
    console.log(delta < 0
      ? '    has escaped its parent. Panes hidden with display:none stop hiding it.'
      : '    which will inherit its visibility and styling.');
  }

  /* Inline script blocks must parse. */
  const RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, n = 0, broken = 0;
  while ((m = RE.exec(src))) {
    const attrs = m[1] || '', body = m[2] || '';
    if (/\bsrc\s*=/.test(attrs) || !body.trim()) continue;
    if (/type\s*=\s*["']module["']/.test(attrs)) continue;   /* needs a module loader */
    /* Only parse blocks that are actually JavaScript. A <script
       type="application/ld+json"> holds structured data, and feeding it to a JS
       parser reports "Unexpected token ':'" on a perfectly valid page — which is
       exactly what this check did on bnb.html before the guard was corrected. */
    const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/) || [])[1];
    if (type && !/^(text\/javascript|application\/javascript|text\/ecmascript)$/i.test(type)) continue;
    n++;
    try { new vm.Script(body); }
    catch (e) {
      broken++; failures++;
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`  ✗ ${rel}:${line} inline script — ${e.message.split('\n')[0]}`);
    }
  }
  if (!broken) console.log(`  ✓ ${n} inline script block(s) parse`);
}

console.log('');
if (failures) {
  console.log(`${failures} markup problem(s).\n`);
  process.exit(1);
}
console.log('Admin markup intact.\n');
process.exit(0);
