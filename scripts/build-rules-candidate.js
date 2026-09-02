#!/usr/bin/env node
/* BUILD A CONSOLIDATED CANDIDATE FROM THE SERVED RULESET.
 *
 * Group A only, for now: match blocks in which EVERY rule is the literal `false` and which
 * contain no nested match. Such a block grants nothing at all, and an absent allow already
 * denies, so removing it cannot change any request's outcome.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It never removes a rule because a SIBLING is constant-false. Same-scope blocks union;
 * `platformConfig` unions `write: if isSuperAdmin()` with `write: if false` and is
 * superAdmin-writable. Reasoning from a neighbour is the error that silently changes
 * authorization, so no candidate here is justified by one.
 *
 * It also leaves every excluded surface untouched — posTransactions, inventory, adminLog,
 * shopEmployees, story rules, the Rail 2 authorization surface — and asserts afterwards
 * that the repaired shopEmployees.shopOwnerId anchor survives byte-identical.
 *
 * The output is a candidate FILE. It is not released, and nothing here publishes anything.
 *
 *   node scripts/build-rules-candidate.js <served> <out> [--group-a]
 */
'use strict';
const fs = require('fs');
const NL = String.fromCharCode(10);

const SERVED = process.argv[2] || 'firestore.rules.served-59af870d';
const OUT = process.argv[3] || 'firestore.rules.candidate-a';

const EXCLUDE = /posTransactions|inventory|adminLog|shopEmployees|merchantStories|storyAllocations|posSales|posRetailSales|posStaff|posApprovals/i;

const raw = fs.readFileSync(SERVED, 'utf8');
const lines = raw.split(NL);

/* comment-blind view for parsing, while edits are applied to the ORIGINAL lines so that
   comments and formatting survive — they cost 128 compiled bytes in total and carry the
   reasoning behind every rule */
let inB = false;
const code = lines.map((l) => {
  let t = l;
  if (inB) { const e = t.indexOf('*/'); if (e < 0) return ''; inB = false; t = t.slice(e + 2); }
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  const o = t.indexOf('/*'); if (o > -1) { inB = true; t = t.slice(0, o); }
  return t.replace(/\/\/.*$/, '');
});

const RE_MATCH = /match\s+(\/[^{\s]*(?:\{[^}]*\}[^{\s]*)*)/;
const isFalse = (e) => /^if\s+false\s*;?\s*\}?\s*$/.test(e.replace(/\s+/g, ' ').trim());

/* locate every match block with its exact line span */
const stack = [];
const blocks = [];
code.forEach((l, idx) => {
  const t = l.trim();
  const mm = t.match(RE_MATCH);
  const structural = mm ? t.replace(mm[1], '') : t;
  let used = false;
  for (const ch of structural) {
    if (ch === '{') {
      if (mm && !used) {
        used = true;
        const b = { path: mm[1], start: idx, end: -1, depth: stack.length, rules: [], nested: 0 };
        if (stack.length) stack[stack.length - 1].nested++;
        stack.push(b); blocks.push(b);
      } else stack.push({ __brace: true, nested: 0, rules: [] });
    } else if (ch === '}') {
      const top = stack.pop();
      if (top && !top.__brace) top.end = idx;
    }
  }
  const am = t.match(/^allow\s+([a-z, ]+)\s*:\s*(.*)$/);
  if (am) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!stack[i].__brace) { stack[i].rules.push({ ops: am[1], expr: am[2], line: idx }); break; }
    }
  }
});

const inert = blocks.filter((b) =>
  b.end > b.start &&
  b.rules.length > 0 &&
  b.nested === 0 &&
  b.rules.every((r) => isFalse(r.expr)) &&
  !EXCLUDE.test(b.path)
);

console.log('');
console.log('  base           ' + SERVED);
console.log('  match blocks   ' + blocks.length);
console.log('  GROUP A        ' + inert.length + ' wholly inert blocks');
console.log('');
inert.forEach((b) => console.log('    line ' + String(b.start + 1).padStart(5) + '-' +
  String(b.end + 1).padEnd(5) + '  ' + b.path + '   (' + b.rules.length + ' rules, all false)'));

/* remove from the bottom up so earlier spans keep their indices */
const drop = new Set();
inert.slice().sort((a, b) => b.start - a.start).forEach((b) => {
  for (let i = b.start; i <= b.end; i++) drop.add(i);
});
const out = lines.filter((_, i) => !drop.has(i)).join(NL);

/* ── postconditions, asserted rather than assumed ─────────────────────────── */
let fail = 0;
const ck = (label, cond, note) => {
  if (cond) console.log('    PASS  ' + label);
  else { fail++; console.log('    FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};
console.log('');
console.log('  POSTCONDITIONS');

const anchor = 'allow update: if isAdmin()';
const anchorBlock = raw.slice(raw.indexOf('match /shopEmployees/'),
                              raw.indexOf('match /shopEmployees/') + 700);
ck('shopEmployees block present and byte-identical',
   out.indexOf(anchorBlock) > -1);
ck('shopOwnerId immutability clause intact',
   /request\.resource\.data\.shopOwnerId == resource\.data\.shopOwnerId/.test(out));
ck('no excluded surface removed',
   inert.every((b) => !EXCLUDE.test(b.path)));
ck('brace balance preserved', (() => {
  const bal = (s) => { let n = 0; const c = s.replace(/\{[A-Za-z0-9_=*]+\}/g, ''); for (const ch of c) { if (ch === '{') n++; else if (ch === '}') n--; } return n; };
  return bal(raw) === bal(out);
})());
ck('no granting rule removed', (() => {
  const grantsIn = (s) => (s.match(/allow\s+[a-z, ]+\s*:\s*if\s+(?!false\s*;)/g) || []).length;
  return grantsIn(raw) === grantsIn(out);
})(), 'served ' + (raw.match(/allow\s+[a-z, ]+\s*:\s*if\s+(?!false\s*;)/g) || []).length +
      ' -> candidate ' + (out.match(/allow\s+[a-z, ]+\s*:\s*if\s+(?!false\s*;)/g) || []).length);

console.log('');
console.log('  source ' + raw.length + ' -> ' + out.length + ' ch   (-' + (raw.length - out.length) + ')');

if (fail) {
  console.log('');
  console.log('  ' + fail + ' postcondition(s) failed — candidate NOT written.');
  process.exit(1);
}
fs.writeFileSync(OUT, out);
console.log('  wrote ' + OUT);
console.log('');
console.log('  NOT released. Prove with:');
console.log('    node scripts/verify-rules-equivalence.js ' + SERVED + ' ' + OUT);
console.log('');
