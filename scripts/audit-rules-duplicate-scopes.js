#!/usr/bin/env node
/* SAME-SCOPE DUPLICATE match BLOCKS — a security question before a size question.
 *
 * Firestore evaluates every match block whose path matches, and allow rules UNION. Two
 * blocks for the same path in the same scope therefore OR together: the second can GRANT
 * what the first withholds, and reading either one alone tells you the wrong answer. That
 * is the shape of the shopEmployees anchor finding — a protection that is present in one
 * place and absent in another.
 *
 * WHY THIS SCRIPT EXISTS RATHER THAN A GREP
 * A grep for `match /events/` cannot tell a top-level collection from a subcollection of
 * the same name, and a regex that stops at `{` merges `/users/{userId}` with `/users/{uid}`.
 * A first pass here reported 28 duplicate paths; resolving the variable name brought it to
 * 13; resolving ANCESTRY is what decides which of those are real. Nesting is the whole
 * question, so the file has to be walked with a brace stack, not matched line by line.
 *
 * It reports only SAME-SCOPE repeats — identical ancestor chain and identical path. Those
 * are the ones that union. Different parents are normal structure and are not reported.
 *
 * Read-only. Consolidating anything it finds requires proving the union is preserved:
 * merging two OR'd blocks into one is a rules change, not a cleanup.
 *
 *   node scripts/audit-rules-duplicate-scopes.js [file]
 */
'use strict';
const fs = require('fs');

const FILE = process.argv[2] || 'firestore.rules';
const NL = String.fromCharCode(10);
const raw = fs.readFileSync(FILE, 'utf8');

/* strip comments, preserving line numbers so findings stay citable */
let inBlock = false;
const clean = raw.split(NL).map((l) => {
  let t = l;
  if (inBlock) {
    const e = t.indexOf('*/');
    if (e < 0) return '';
    inBlock = false; t = t.slice(e + 2);
  }
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  const o = t.indexOf('/*');
  if (o > -1) { inBlock = true; t = t.slice(0, o); }
  return t.replace(/\/\/.*$/, '');
});

/* walk with a real brace stack: a match owns the scope opened by ITS brace */
const found = [];
const stack = [];
clean.forEach((line, i) => {
  let rest = line;
  let consumed = 0;
  while (rest.length) {
    /* A rules path CONTAINS braces: `match /wallets/{walletId} {`. A non-greedy
       `\/\S*?` followed by `\{` stops at the VARIABLE's brace, capturing `/wallets/`
       and then pushing the scope on the wrong brace — which is why every ancestor
       first rendered as `?`. The path must consume `{var}` segments explicitly. */
    const mm = rest.match(/match\s+(\/[^{\s]*(?:\{[^}]*\}[^{\s]*)*)\s*\{/);
    const ob = rest.indexOf('{');
    const cb = rest.indexOf('}');
    if (mm && ob > -1 && rest.indexOf(mm[0]) <= ob) {
      const at = rest.indexOf(mm[0]);
      /* any braces before the match keyword */
      for (const ch of rest.slice(0, at)) {
        if (ch === '{') stack.push('?');
        else if (ch === '}') stack.pop();
      }
      found.push({ line: i + 1, path: mm[1], anc: stack.join(' > ') });
      stack.push(mm[1]);
      rest = rest.slice(at + mm[0].length);
      consumed++;
      continue;
    }
    if (ob === -1 && cb === -1) break;
    const next = (ob > -1 && (cb === -1 || ob < cb)) ? ob : cb;
    if (rest[next] === '{') stack.push('?'); else stack.pop();
    rest = rest.slice(next + 1);
    if (++consumed > 400) break;
  }
});

const key = (f) => f.anc + ' >> ' + f.path;
const by = {};
found.forEach((f) => { (by[key(f)] = by[key(f)] || []).push(f); });
const dups = Object.keys(by).filter((k) => by[k].length > 1);

console.log('');
console.log('  ' + FILE);
console.log('  match declarations        ' + String(found.length).padStart(5));
console.log('  distinct (scope + path)   ' + String(Object.keys(by).length).padStart(5));
console.log('  SAME-SCOPE duplicates     ' + String(dups.length).padStart(5));
console.log('');

if (!dups.length) {
  console.log('  No same-scope duplicate match blocks.');
  console.log('  Every repeated path name sits under a different parent — normal structure,');
  console.log('  not a union. There is no OR-merge hazard here, and no size win either.');
  console.log('');
  process.exit(0);
}

console.log('  THESE UNION. The second block can grant what the first withholds.');
console.log('');
dups.sort((a, b) => by[b].length - by[a].length).forEach((k) => {
  const g = by[k];
  console.log('  x' + g.length + '  ' + g[0].path +
              (g[0].anc ? '      under  ' + g[0].anc : '      (top level)'));
  g.forEach((f) => console.log('        line ' + String(f.line).padStart(5)));
});
console.log('');
console.log('  Each is a reconciliation item, not a delete. Merging two OR\'d blocks into');
console.log('  one changes evaluation unless the union is reproduced exactly.');
console.log('');
