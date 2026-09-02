#!/usr/bin/env node
/* WHAT DOES THE REPO ARTIFACT ADD OVER THE SERVED ONE?
 *
 * The served ruleset 59af870d (`firestore.rules.release-minimal`, 252,640 ch) is the
 * immutable behavioural reference and is known releasable. The repo's `firestore.rules`
 * (255,822 ch) is a different, larger proposal that CANNOT be released — its ruleset
 * creates, its release is refused 400, and stripping 101,522 characters does not rescue it.
 *
 * Consolidation should therefore be derived from SERVED, not from the unreleasable
 * artifact: served is provably releasable, provably what is enforced today, and — verified
 * separately — already contains the repaired shopEmployees.shopOwnerId anchor including
 * its update-immutability clause.
 *
 * That is only correct if nothing in the repo artifact is BOTH intentional and absent from
 * served. This enumerates the difference so that question is answered from evidence rather
 * than assumed. It compares by structure, not by `diff`: reordering and reformatting
 * produce enormous textual diffs that say nothing about authorization.
 *
 * Read-only.
 *   node scripts/audit-rules-served-vs-repo.js
 */
'use strict';
const fs = require('fs');
const NL = String.fromCharCode(10);

const SERVED = 'firestore.rules.served-59af870d';
const REPO = 'firestore.rules';

function decomment (src) {
  let inB = false;
  return src.split(NL).map((l) => {
    let t = l;
    if (inB) { const e = t.indexOf('*/'); if (e < 0) return ''; inB = false; t = t.slice(e + 2); }
    t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    const o = t.indexOf('/*'); if (o > -1) { inB = true; t = t.slice(0, o); }
    return t.replace(/\/\/.*$/, '').trim();
  });
}

/* collect (scope-path -> the allow rules it declares), so a comparison is about
   authorization rather than about text.
 *
 * THE BRACE THAT IS NOT A BRACE. A rules path carries its own braces:
 * `match /wallets/{walletId} {`. Counting `}` naively pops the scope stack on the
 * VARIABLE's closing brace, so every scope collapses and the whole file models as one
 * scope — which is exactly what the first version of this reported (1 scope, both files).
 * This is the third time path braces have broken a structural pass here, so the match
 * path is removed from the line BEFORE any brace is counted, rather than the regex being
 * patched again. */
function model (file) {
  const lines = decomment(fs.readFileSync(file, 'utf8'));
  const stack = [];
  const blocks = {};
  const fns = {};
  let pending = null;
  const RE_MATCH = /match\s+(\/[^{\s]*(?:\{[^}]*\}[^{\s]*)*)/;
  lines.forEach((l) => {
    if (!l) return;
    const fm = l.match(/^function\s+([A-Za-z0-9_]+)\s*\(/);
    if (fm) { pending = 'fn:' + fm[1]; fns[fm[1]] = ''; }
    const mm = l.match(RE_MATCH);
    const am = l.match(/^allow\s+([a-z, ]+):\s*(.*)$/);
    if (am) {
      const k = stack.join('');
      blocks[k] = blocks[k] || [];
      blocks[k].push({ ops: am[1].replace(/\s+/g, ''), expr: am[2] });
      pending = { k, i: blocks[k].length - 1 };
    } else if (pending && typeof pending === 'object' && !mm && !/^allow\s/.test(l)) {
      /* continuation line of a multi-line allow expression */
      blocks[pending.k][pending.i].expr += ' ' + l;
    }
    if (typeof pending === 'string' && pending.indexOf('fn:') === 0) {
      fns[pending.slice(3)] += ' ' + l;
    }
    /* Every `{` pushes and every `}` pops, so a helper body's braces cannot pop a match
       scope — an earlier version popped on `}` without pushing on `{`, which let
       `function f() { ... }` silently close the enclosing collection. The match's own
       opening brace pushes the PATH; any other brace pushes a placeholder. The path text
       is removed first so its `{var}` is never counted as structure. */
    const structural = mm ? l.replace(mm[1], '') : l;
    let usedMatch = false;
    for (const ch of structural) {
      if (ch === '{') {
        if (mm && !usedMatch) { stack.push(mm[1]); usedMatch = true; }
        else stack.push('?');
      } else if (ch === '}') {
        if (stack.length) stack.pop();
      }
    }
  });
  /* normalise whitespace inside expressions so formatting is not mistaken for change */
  Object.keys(blocks).forEach((k) => blocks[k].forEach((r) => {
    r.expr = r.expr.replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim();
  }));
  Object.keys(fns).forEach((n) => { fns[n] = fns[n].replace(/\s+/g, ' ').trim(); });
  return { blocks, fns };
}

const A = model(SERVED);
const B = model(REPO);

const pathsA = Object.keys(A.blocks);
const pathsB = Object.keys(B.blocks);
const onlyB = pathsB.filter((p) => pathsA.indexOf(p) === -1);
const onlyA = pathsA.filter((p) => pathsB.indexOf(p) === -1);
const both = pathsA.filter((p) => pathsB.indexOf(p) > -1);

console.log('');
console.log('  SERVED ' + SERVED + '   scopes ' + pathsA.length);
console.log('  REPO   ' + REPO + '                     scopes ' + pathsB.length);
console.log('');
console.log('  scopes only in REPO   ' + String(onlyB.length).padStart(4) +
            '   <- would be LOST by basing on served');
console.log('  scopes only in SERVED ' + String(onlyA.length).padStart(4) +
            '   <- repo has dropped these');
console.log('  scopes in both        ' + String(both.length).padStart(4));

if (onlyB.length) {
  console.log('');
  console.log('  ONLY IN REPO — each is an intentional addition or an unmerged experiment:');
  onlyB.slice(0, 40).forEach((p) => {
    console.log('    ' + p);
    B.blocks[p].forEach((r) => console.log('        allow ' + r.ops + ': ' + r.expr.slice(0, 96)));
  });
  if (onlyB.length > 40) console.log('    ... and ' + (onlyB.length - 40) + ' more');
}
if (onlyA.length) {
  console.log('');
  console.log('  ONLY IN SERVED — present in production, absent from the repo proposal:');
  onlyA.slice(0, 40).forEach((p) => console.log('    ' + p));
  if (onlyA.length > 40) console.log('    ... and ' + (onlyA.length - 40) + ' more');
}

/* differing authorization on a shared path is the highest-signal category */
const changed = [];
both.forEach((p) => {
  const a = A.blocks[p].map((r) => r.ops + '|' + r.expr).sort().join(' ;; ');
  const b = B.blocks[p].map((r) => r.ops + '|' + r.expr).sort().join(' ;; ');
  if (a !== b) changed.push(p);
});
console.log('');
console.log('  scopes present in BOTH but with DIFFERENT allow rules: ' + changed.length);
changed.slice(0, 25).forEach((p) => {
  console.log('');
  console.log('    ' + p);
  A.blocks[p].forEach((r) => console.log('      served    allow ' + r.ops + ': ' + r.expr.slice(0, 92)));
  B.blocks[p].forEach((r) => console.log('      repo      allow ' + r.ops + ': ' + r.expr.slice(0, 92)));
});
if (changed.length > 25) console.log('    ... and ' + (changed.length - 25) + ' more');

const fnA = Object.keys(A.fns), fnB = Object.keys(B.fns);
const fnChanged = fnA.filter((n) => fnB.indexOf(n) > -1 && A.fns[n] !== B.fns[n]);
console.log('');
console.log('  helpers  served ' + fnA.length + '  repo ' + fnB.length +
            '   only-in-repo ' + fnB.filter((n) => fnA.indexOf(n) === -1).length +
            '   differing bodies ' + fnChanged.length);
fnChanged.forEach((n) => console.log('    ' + n + '()'));
console.log('');
