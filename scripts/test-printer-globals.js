#!/usr/bin/env node
'use strict';

/**
 * Guards the POS printer script bundle against top-level identifier collisions.
 *
 * WHY THIS EXISTS
 *
 * sokoni-universal-printer.js and sokoni-bluetooth-printer.js both declared
 *
 *     const SOKONI_LEGAL_NAME = 'Bravilex International Co. Limited';
 *
 * at top level. They load together as classic scripts on every POS printer
 * page, and two top-level `const`s of one identifier throw:
 *
 *     Identifier 'SOKONI_LEGAL_NAME' has already been declared
 *
 * That aborts whichever script parses second, so `window.P58EPrinter` was never
 * assigned and the P58E thermal printer could not be paired, configured or
 * tested — on production, for every merchant, silently. The page rendered its
 * full UI; only the hardware layer was missing, so it looked like a printer
 * problem rather than a script problem.
 *
 * The failure mode is nasty because each file is individually valid: `node
 * --check` passes on both, and any test that loads them in isolation passes
 * too. It only breaks when they share a global scope, which is exactly what the
 * browser does and what this test reproduces.
 *
 * Run: node scripts/test-printer-globals.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* The bundle as the POS pages load it, in order. */
const BUNDLE = [
  'sokoni-universal-printer.js',
  'sokoni-bluetooth-printer.js',
  'sokoni-printer-manager.js',
  'sokoni-pos-print-service.js',
];

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m', name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m', name, detail ? '\n      ' + detail : ''); }
};

/**
 * Lexical declarations that are genuinely in the GLOBAL scope.
 *
 * Column-0 position is not sufficient. Every script in this bundle wraps its
 * body in an IIFE whose contents are written unindented, so a naive
 * `/^const /m` scan reports ESC, CMD and PrintQueue as colliding when they are
 * function-scoped and cannot collide with anything.
 *
 * What made SOKONI_LEGAL_NAME a real collision is that it is declared BEFORE
 * the IIFE opens — at brace/paren depth zero. So depth is the test, and it is
 * tracked by scanning, with strings, template literals, regex-ish slashes and
 * comments skipped so their braces do not corrupt the count.
 */
function globalLexical(src) {
  const names = [];
  let depth = 0, i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    /* Skip comments */
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }

    /* Skip string and template literals */
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    if (c === '{' || c === '(' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; i++; continue; }

    /* A declaration only counts when nothing is open around it. */
    if (depth === 0 && (c === 'c' || c === 'l')) {
      const m = /^(const|let|class)\s+([A-Za-z_$][\w$]*)/.exec(src.slice(i, i + 80));
      const prev = i === 0 ? '\n' : src[i - 1];
      if (m && /[\s;{}]/.test(prev)) { names.push({ kind: m[1], name: m[2] }); i += m[0].length; continue; }
    }
    i++;
  }
  return names;
}

console.log('\nPOS printer bundle — top-level collisions');

const decls = {};
for (const f of BUNDLE) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { ok(`${f} exists`, false, 'file missing'); continue; }
  decls[f] = globalLexical(fs.readFileSync(p, 'utf8'));
}

/* Every unordered pair, so a collision is reported once with both owners. */
const files = Object.keys(decls);
const collisions = [];
for (let i = 0; i < files.length; i++) {
  for (let j = i + 1; j < files.length; j++) {
    const a = decls[files[i]], b = decls[files[j]];
    for (const da of a) {
      const hit = b.find(db => db.name === da.name);
      if (hit) collisions.push({ name: da.name, a: files[i], b: files[j], kinds: [da.kind, hit.kind] });
    }
  }
}

ok('no top-level const/let/class shared between bundle scripts',
   collisions.length === 0,
   collisions.map(c => `${c.name} (${c.kinds.join(' + ')}) in ${c.a} AND ${c.b}`).join('\n      '));

/* The specific regression, named, so a failure says what broke rather than
   just "a collision". */
const legal = collisions.find(c => c.name === 'SOKONI_LEGAL_NAME');
ok('SOKONI_LEGAL_NAME specifically does not collide (the P58E regression)', !legal,
   legal ? 'P58EPrinter will be undefined and the P58E cannot be configured' : '');

/* Both files must still contain the canonical literal — verify-company-identity
   scans for it, so "fixing" the collision by deleting one would trade this bug
   for a compliance-gate failure. */
for (const f of ['sokoni-universal-printer.js', 'sokoni-bluetooth-printer.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(`${f} still carries the canonical legal name`,
     src.includes('Bravilex International Co. Limited'));
  ok(`${f} declares SOKONI_LEGAL_NAME with var, not const`,
     /^var\s+SOKONI_LEGAL_NAME/m.test(src),
     'const at top level collides across the bundle');
}

/* The P58E adapter must actually publish its global — the symptom users saw. */
const bt = fs.readFileSync(path.join(ROOT, 'sokoni-bluetooth-printer.js'), 'utf8');
ok('sokoni-bluetooth-printer.js assigns window.P58EPrinter',
   /window\.P58EPrinter\s*=/.test(bt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
