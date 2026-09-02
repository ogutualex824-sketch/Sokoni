#!/usr/bin/env node
/* GROUP B — remove constant-false allow clauses. Builds ON candidate-a, cumulatively.
 *
 * THE CLAIM, AND ONLY THIS CLAIM
 *   Removing `allow X: if false;` changes no authorization, because that clause can never
 *   evaluate to true and an absent allow already denies.
 * It is a property of the clause itself. It is NOT licence to remove a containing block
 * that also grants, and the presence of a false clause is never evidence about a sibling.
 * Same-scope blocks union.
 *
 * FOUR SHAPES, FOUND BY LOOKING RATHER THAN ASSUMED
 *   1. a line that is only the clause                  -> drop the line
 *   2. the clause plus a trailing comment              -> drop the clause, KEEP the comment
 *   3. a whole inert block written on ONE line         -> drop the line
 *   4. a one-line block MIXING false and granting      -> excise only the clause substring
 * Shape 3 is Group A residual: Group A required a block to span multiple lines
 * (`end > start`), so 5 single-line inert blocks were silently skipped. That was an
 * UNDER-removal, so Group A's acceptance stands — nothing wrong was removed — but the
 * blocks belong here.
 *
 * COMMENTS ARE KEPT. They cost 0.0013 compiled bytes per character (measured), and they
 * record why a collection is CF-only. Deleting them would trade the file's explanation for
 * nothing.
 *
 * Because comments are rewritten onto their own lines, the candidate is NOT a strict subset
 * of served LINES. The property asserted instead is stronger where it matters: the
 * DECOMMENTED CODE is a strict subset, in order — no code added, rewritten or reordered.
 *
 *   node scripts/build-rules-candidate-b.js <base> <out>
 */
'use strict';
const fs = require('fs');
const NL = String.fromCharCode(10);

const BASE = process.argv[2] || 'firestore.rules.candidate-a';
const OUT = process.argv[3] || 'firestore.rules.candidate-b';
const EXCLUDE = /posTransactions|inventory|adminLog|shopEmployees|merchantStories|storyAllocations|posSales|posRetailSales|posStaff|posApprovals/i;

const raw = fs.readFileSync(BASE, 'utf8');
const lines = raw.split(NL);

/* comment-blind view for DECIDING; edits are applied to the original lines */
let inB = false;
const code = lines.map((l) => {
  let t = l;
  if (inB) { const e = t.indexOf('*/'); if (e < 0) return ''; inB = false; t = t.slice(e + 2); }
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  const o = t.indexOf('/*'); if (o > -1) { inB = true; t = t.slice(0, o); }
  return t.replace(/\/\/.*$/, '');
});

const RE_MATCH = /match\s+(\/[^{\s]*(?:\{[^}]*\}[^{\s]*)*)/;
const RE_FALSE_CLAUSE = /allow[ \ta-z,]+:\s*if\s+false\s*;/g;

/* scope of every line, so exclusions apply to the PATH and not to the text */
const scopeOf = new Array(lines.length).fill('');
{
  const stack = [];
  code.forEach((l, i) => {
    const t = l.trim();
    const mm = t.match(RE_MATCH);
    scopeOf[i] = stack.join('');
    const structural = mm ? t.replace(mm[1], '') : t;
    let used = false;
    for (const ch of structural) {
      if (ch === '{') {
        if (mm && !used) { used = true; stack.push(mm[1]); scopeOf[i] = stack.join(''); }
        else stack.push('?');
      } else if (ch === '}') { if (stack.length) stack.pop(); }
    }
  });
}

const stats = { onlyClause: 0, clausePlusComment: 0, inertOneLine: 0, mixedOneLine: 0, skippedExcluded: 0 };
const out = [];

lines.forEach((orig, i) => {
  const c = code[i];
  const t = c.trim();

  if (!RE_FALSE_CLAUSE.test(t)) { RE_FALSE_CLAUSE.lastIndex = 0; out.push(orig); return; }
  RE_FALSE_CLAUSE.lastIndex = 0;

  const mm = t.match(RE_MATCH);
  const scope = mm ? scopeOf[i] : scopeOf[i];
  if (EXCLUDE.test(scope) || (mm && EXCLUDE.test(mm[1]))) { stats.skippedExcluded++; out.push(orig); return; }

  /* shape 3/4 — a whole block on one line */
  const one = t.match(/^match\s+(\/[^{\s]*(?:\{[^}]*\}[^{\s]*)*)\s*\{(.*)\}\s*$/);
  if (one) {
    const allows = one[2].match(/allow[ \ta-z,]+:\s*if\s+[^;]*;/g) || [];
    const falses = allows.filter((x) => /:\s*if\s+false\s*;/.test(x));
    if (allows.length && falses.length === allows.length) { stats.inertOneLine++; return; }   /* drop line */
    if (falses.length) {                                                                     /* excise clause */
      stats.mixedOneLine++;
      let edited = orig;
      falses.forEach((f) => { edited = edited.replace(f, ''); });
      out.push(edited.replace(/\{\s+/, '{ ').replace(/\s+\}/, ' }').replace(/\s{2,}\}/, ' }'));
      return;
    }
  }

  /* shape 1/2 — a standalone clause, with or without a trailing comment */
  const codeOnly = c.replace(RE_FALSE_CLAUSE, '').trim();
  if (codeOnly !== '') { out.push(orig); return; }   /* other code on the line: leave alone */

  const indent = (orig.match(/^\s*/) || [''])[0];
  const commentMatch = orig.match(/(\/\/.*|\/\*[\s\S]*?\*\/)\s*$/);
  if (commentMatch) {
    stats.clausePlusComment++;
    out.push(indent + commentMatch[1].trim());   /* keep the documentation, drop the clause */
  } else {
    stats.onlyClause++;                          /* drop the line */
  }
});

/* ── PHASE 2 — an emptied block is a SYNTAX ERROR, not a harmless remnant ──────
 * Probed directly: `match /a/{id} { }` is REJECTED by ruleset create, and so is a block
 * containing only a comment, while a normal block is accepted. So "removing a constant-
 * false clause is semantically safe" does not imply the FILE stays valid.
 *
 * It bites cumulatively rather than in either group alone. Group A removed the nested
 * `/versions/{version}` block inside `legalAgreements` — correct, it granted nothing — and
 * candidate-a compiled and released. Group B then removed the parent's own constant-false
 * clause, and the parent had nothing left. One block, found only because the compile
 * failed and the first empty-block detector I wrote was itself wrong (it reported 29 by
 * popping single-line blocks before counting their content; the real answer was 1, with
 * served as a 0 control).
 *
 * Removing an empty block is behaviour-preserving for the same reason the clause was: no
 * rules means deny, and no block means deny. Comments inside are re-emitted so the record
 * of WHY a collection is CF-only survives. Iterated to a fixpoint, since emptying a child
 * can empty its parent. */
function dropEmptyBlocks (arr) {
  const isCode = (s) => {
    let t = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
    return t.replace(/[\s{}]/g, '').length > 0;
  };
  for (let pass = 0; pass < 12; pass++) {
    const cl = arr.map((l) => l.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, ''));
    const stack = [];
    let target = null;
    for (let i = 0; i < cl.length && !target; i++) {
      const t = cl[i].trim();
      const mm = t.match(RE_MATCH);
      const structural = mm ? t.replace(mm[1], '') : t;
      let used = false;
      for (const ch of structural) {
        if (ch === '{') {
          if (mm && !used) { used = true; stack.push({ start: i, path: mm[1], code: 0 }); }
          else stack.push({ start: i, path: null, code: 0 });
        } else if (ch === '}') {
          const top = stack.pop();
          if (top && top.path && top.code === 0 && i > top.start) target = { start: top.start, end: i };
          else if (top && stack.length) stack[stack.length - 1].code += top.code + (top.path ? 1 : 0);
        }
      }
      /* content on this line belongs to the innermost open block */
      if (stack.length && !mm && isCode(arr[i])) stack[stack.length - 1].code++;
      if (stack.length > 1 && mm) stack[stack.length - 2].code++;
    }
    if (!target) return { arr, passes: pass };
    const kept = [];
    for (let i = target.start; i <= target.end; i++) {
      const c = arr[i].match(/(\/\/.*|\/\*[\s\S]*?\*\/)\s*$/);
      if (c && !isCode(arr[i])) kept.push((arr[target.start].match(/^\s*/) || [''])[0] + c[1].trim());
      else if (c) kept.push((arr[target.start].match(/^\s*/) || [''])[0] + c[1].trim());
    }
    arr = arr.slice(0, target.start).concat(kept, arr.slice(target.end + 1));
    stats.emptiedBlocks = (stats.emptiedBlocks || 0) + 1;
  }
  return { arr, passes: 12 };
}
const phase2 = dropEmptyBlocks(out.slice());
const result = phase2.arr.join(NL);

/* ── postconditions ───────────────────────────────────────────────────────── */
let fail = 0;
const ck = (label, cond, note) => {
  if (cond) console.log('    PASS  ' + label);
  else { fail++; console.log('    FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};

const decomment = (s) => {
  let b = false;
  return s.split(NL).map((l) => {
    let t = l;
    if (b) { const e = t.indexOf('*/'); if (e < 0) return ''; b = false; t = t.slice(e + 2); }
    t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    const o = t.indexOf('/*'); if (o > -1) { b = true; t = t.slice(0, o); }
    return t.replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim();
  }).filter((l) => l);
};

console.log('');
console.log('  base ' + BASE + '   ' + raw.length + ' ch');
console.log('');
console.log('  clause-only lines dropped        ' + stats.onlyClause);
console.log('  clause dropped, comment KEPT     ' + stats.clausePlusComment);
console.log('  one-line inert blocks dropped    ' + stats.inertOneLine + '   (Group A residual)');
console.log('  one-line mixed blocks edited     ' + stats.mixedOneLine);
console.log('  skipped: excluded scope          ' + stats.skippedExcluded);
console.log('');
console.log('  POSTCONDITIONS');

/* the check that would have caught this before the compile did */
ck('no empty or unclosed match block', (function(){
  var dc = decomment(result).join(NL);
  var re = new RegExp('match\\s+(/[^{\\s]*(?:\\{[^}]*\\}[^{\\s]*)*)\\s*\\{', 'g');
  var mm, bad = [];
  while ((mm = re.exec(dc))) {
    var open = mm.index + mm[0].length - 1, d = 0, close = -1;
    for (var k = open; k < dc.length; k++) { if (dc[k] === '{') d++; else if (dc[k] === '}') { d--; if (d === 0) { close = k; break; } } }
    if (close < 0 || !dc.slice(open + 1, close).replace(/\s/g, '')) bad.push(mm[1]);
  }
  if (bad.length) console.log('        ' + bad.length + ': ' + bad.slice(0,5).join(', '));
  return bad.length === 0;
})());

const RE_ALLOW = /allow[ \ta-z,]+:\s*if\s+/g;
const RE_F = /allow[ \ta-z,]+:\s*if\s+false\s*;/g;
const grants = (s) => {
  const dc = decomment(s).join(NL);
  return (dc.match(RE_ALLOW) || []).length - (dc.match(RE_F) || []).length;
};
ck('granting clauses unchanged  (' + grants(raw) + ')', grants(raw) === grants(result),
   grants(raw) + ' -> ' + grants(result));

const shopBlock = (s) => {
  const i = s.indexOf('match /shopEmployees/');
  return i < 0 ? null : s.slice(i, s.indexOf(NL + '    }', i));
};
ck('shopEmployees block byte-identical', shopBlock(raw) && shopBlock(raw) === shopBlock(result));
ck('shopOwnerId occurrences unchanged',
   (raw.match(/shopOwnerId/g) || []).length === (result.match(/shopOwnerId/g) || []).length);

let exOk = true; const exBad = [];
['posTransactions', 'inventory', 'adminLog', 'shopEmployees', 'merchantStories',
 'storyAllocations', 'posSales', 'posRetailSales', 'posStaff', 'posApprovals'].forEach((n) => {
  const ca = (raw.match(new RegExp(n, 'g')) || []).length;
  const cb = (result.match(new RegExp(n, 'g')) || []).length;
  if (ca !== cb) { exOk = false; exBad.push(n + ' ' + ca + '->' + cb); }
});
ck('excluded surfaces unchanged', exOk, exBad.join('; '));

const bal = (s) => { let n = 0; for (const ch of s.replace(/\{[A-Za-z0-9_=*]+\}/g, '')) { if (ch === '{') n++; else if (ch === '}') n--; } return n; };
ck('brace balance preserved', bal(raw) === bal(result), bal(raw) + ' -> ' + bal(result));

/* EXACT RE-DERIVATION, not a subset test.
   A subset test cannot express shape 4: those lines are EDITED, so they legitimately do
   not appear in the base, and the first version of this check failed for that reason.
   Weakening it to "subset or edited" would have made it unfalsifiable. Instead the
   expected output is recomputed here by a different route — take every base code line,
   delete constant-false clauses outside excluded scopes, drop whatever becomes empty or
   an empty match block — and required to equal the transformer's output EXACTLY. Two
   different derivations agreeing is a real check; a relaxed assertion is not. */
ck('candidate equals an independent re-derivation of the base, line for line', (() => {
  const predicted = [];
  code.forEach((c, i) => {
    const mm = c.trim().match(RE_MATCH);
    const scope = scopeOf[i];
    const excluded = EXCLUDE.test(scope) || (mm && EXCLUDE.test(mm[1]));
    let t = c;
    if (!excluded) t = t.replace(/allow[ \ta-z,]+:\s*if\s+false\s*;/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (/^match\s+\S+\s*\{\s*\}$/.test(t)) return;      /* one-line empty block: dropped */
    predicted.push(t);
  });
  /* Phase 2, modelled by a DIFFERENT algorithm than the transformer uses. The builder
     walks a brace stack over the raw lines; this collapses adjacent `match X {` / `}`
     pairs in the code-line sequence, to a fixpoint. Re-implementing the same walk here
     would only prove the code agrees with itself. */
  for (;;) {
    let cut = -1;
    for (let i = 0; i < predicted.length - 1; i++) {
      if (/^match\s+\S+\s*\{$/.test(predicted[i]) && predicted[i + 1] === '}') { cut = i; break; }
    }
    if (cut < 0) break;
    predicted.splice(cut, 2);
  }
  const actual = decomment(result);
  if (predicted.length !== actual.length) {
    console.log('        predicted ' + predicted.length + ' code lines, got ' + actual.length);
    return false;
  }
  for (let i = 0; i < predicted.length; i++) {
    if (predicted[i] !== actual[i]) {
      console.log('        first difference at code line ' + i);
      console.log('          predicted: ' + predicted[i].slice(0, 100));
      console.log('          actual   : ' + actual[i].slice(0, 100));
      return false;
    }
  }
  return true;
})());

const fRaw = (decomment(raw).join(NL).match(RE_F) || []).length;
const fRes = (decomment(result).join(NL).match(RE_F) || []).length;
console.log('        constant-false clauses: ' + fRaw + ' -> ' + fRes + '   (-' + (fRaw - fRes) + ')');

console.log('');
console.log('  source ' + raw.length + ' -> ' + result.length + ' ch   (-' + (raw.length - result.length) + ')');
if (fail) { console.log(NL + '  ' + fail + ' postcondition(s) failed — candidate NOT written.'); process.exit(1); }
fs.writeFileSync(OUT, result);
console.log('  wrote ' + OUT);
console.log('');
