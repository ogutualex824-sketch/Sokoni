#!/usr/bin/env node
/* CONSOLIDATION CANDIDATES IN THE SERVED RULESET — enumeration and proof obligations.
 *
 * BASE IS SERVED, NOT THE REPO ARTIFACT. `firestore.rules.served-59af870d` is what is
 * enforced today, is known releasable, and already contains the repaired
 * shopEmployees.shopOwnerId anchor including its update-immutability clause. The repo's
 * `firestore.rules` cannot be released at all, so shrinking it would be shrinking an
 * artifact whose baseline behaviour is unproven.
 *
 * ══ THE ONLY CLAIM THIS SLICE MAKES ═════════════════════════════════════════════════
 * `A OR false === A`. A rule whose condition is the literal `false` NEVER grants, and an
 * absent allow already denies, so deleting it cannot change what any request is permitted
 * to do. That is a property of the rule ITSELF and needs no reasoning about its neighbours.
 *
 * ══ THE INVERSE, WHICH IS FORBIDDEN ═════════════════════════════════════════════════
 * The presence of `allow write: if false` must NEVER be read as evidence that another
 * block for the same path is redundant. Same-scope blocks UNION: platformConfig unions
 * `write: if isSuperAdmin()` with `write: if false` and the result is superAdmin-writable.
 * Deleting the constant-false member is safe; concluding anything about the OTHER member
 * from its presence is exactly the error that would silently change authorization. This
 * script therefore reports the union context of every candidate and refuses to classify a
 * block as inert while any same-scope sibling grants.
 *
 * ══ EXCLUSIONS, ENFORCED IN CODE ════════════════════════════════════════════════════
 * posTransactions, inventory, adminLog, shopEmployees, story rules and anything matching
 * the Rail 2 authorization surface are out of scope for this slice and are filtered out
 * with their reason recorded, so the exclusion is visible rather than assumed.
 *
 * Read-only. Emits docs/RULES_CONSOLIDATION_CANDIDATES.md.
 *   node scripts/audit-rules-inert-candidates.js
 */
'use strict';
const fs = require('fs');
const NL = String.fromCharCode(10);

const FILE = process.argv[2] || 'firestore.rules.served-59af870d';
const OUT = 'docs/RULES_CONSOLIDATION_CANDIDATES.md';

/* every exclusion carries the reason it exists */
const EXCLUDE = [
  { re: /posTransactions/i,  why: 'Rail 2 sale writes — out of scope' },
  { re: /inventory/i,        why: 'inventory authority — out of scope' },
  { re: /adminLog/i,         why: 'admin audit trail — out of scope' },
  { re: /shopEmployees/i,    why: 'repaired shopOwnerId anchor — preserve verbatim' },
  { re: /merchantStories|storyAllocations/i, why: 'story rules — ADR-014, out of scope' },
  { re: /posSales|posRetailSales|posStaff|posApprovals/i, why: 'Rail 2 authorization surface' }
];

function decomment (src) {
  let inB = false;
  return src.split(NL).map((l) => {
    let t = l;
    if (inB) { const e = t.indexOf('*/'); if (e < 0) return ''; inB = false; t = t.slice(e + 2); }
    t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    const o = t.indexOf('/*'); if (o > -1) { inB = true; t = t.slice(0, o); }
    return t.replace(/\/\/.*$/, '');
  });
}

const RE_MATCH = /match\s+(\/[^{\s]*(?:\{[^}]*\}[^{\s]*)*)/;
const raw = fs.readFileSync(FILE, 'utf8');
const lines = decomment(raw);

/* one pass: scope stack, allow rules with their source lines, nested-match awareness */
const stack = [];
const scopes = {};          /* key -> { path, openLine, rules:[], nested:0 } */
let pending = null;

lines.forEach((l, idx) => {
  const t = l.trim();
  const mm = t.match(RE_MATCH);
  const am = t.match(/^allow\s+([a-z, ]+)\s*:\s*(.*)$/);

  if (am) {
    const k = stack.join('');
    if (scopes[k]) {
      scopes[k].rules.push({ ops: am[1].replace(/\s+/g, ''), expr: am[2], line: idx + 1 });
      pending = { k, i: scopes[k].rules.length - 1 };
    }
  } else if (pending && t && !mm && !/^allow\s/.test(t) && !/^\}/.test(t)) {
    scopes[pending.k].rules[pending.i].expr += ' ' + t;
  }
  if (mm || /^\}/.test(t)) pending = null;

  const structural = mm ? t.replace(mm[1], '') : t;
  let used = false;
  for (const ch of structural) {
    if (ch === '{') {
      if (mm && !used) {
        used = true;
        if (stack.length) {
          const parentKey = stack.join('');
          if (scopes[parentKey]) scopes[parentKey].nested++;
        }
        stack.push(mm[1]);
        const k = stack.join('');
        if (!scopes[k]) scopes[k] = { path: mm[1], key: k, openLine: idx + 1, rules: [], nested: 0 };
      } else stack.push('?');
    } else if (ch === '}') { if (stack.length) stack.pop(); }
  }
});

const isFalse = (e) => /^if\s+false\s*;?\s*\}?\s*$/.test(e.replace(/\s+/g, ' ').trim());
const norm = (e) => e.replace(/\s+/g, ' ').replace(/\s*;?\s*\}*\s*$/, '').trim();

/* same-scope siblings: two match blocks declaring the identical path in the identical
   parent. Their allow rules union, so a candidate must be judged against ALL of them. */
const byPath = {};
Object.keys(scopes).forEach((k) => { (byPath[k] = byPath[k] || []).push(scopes[k]); });

const excludedFor = (p) => {
  for (const e of EXCLUDE) if (e.re.test(p)) return e.why;
  return null;
};

const constFalse = [];
const inertBlocks = [];
const excluded = [];

Object.keys(scopes).forEach((k) => {
  const s = scopes[k];
  const ex = excludedFor(k);
  const falses = s.rules.filter((r) => isFalse(r.expr));
  const granting = s.rules.filter((r) => !isFalse(r.expr));

  if (ex) {
    if (falses.length) excluded.push({ path: k, line: s.openLine, why: ex, n: falses.length });
    return;
  }
  falses.forEach((r) => {
    constFalse.push({
      path: s.path, key: k, line: r.line, ops: r.ops, expr: norm(r.expr),
      siblingGrants: granting.map((g) => g.ops + ': ' + norm(g.expr)),
      nested: s.nested
    });
  });
  /* a block is inert only if EVERY rule in it is constant-false AND it contains no nested
     match block that might itself grant */
  if (s.rules.length > 0 && falses.length === s.rules.length && s.nested === 0) {
    inertBlocks.push({ path: s.path, key: k, line: s.openLine, rules: s.rules.length });
  }
});

/* ── report ───────────────────────────────────────────────────────────────── */
console.log('');
console.log('  base                    ' + FILE);
console.log('  scopes                  ' + Object.keys(scopes).length);
console.log('  constant-false rules    ' + constFalse.length + '   (in-scope)');
console.log('  wholly inert blocks     ' + inertBlocks.length + '   (all rules false, no nested match)');
console.log('  excluded by policy      ' + excluded.length + ' scopes');
console.log('');
const byWhy = {};
excluded.forEach((e) => { byWhy[e.why] = (byWhy[e.why] || 0) + e.n; });
Object.keys(byWhy).forEach((w) => console.log('    ' + String(byWhy[w]).padStart(4) + '  ' + w));

const withGrantingSibling = constFalse.filter((c) => c.siblingGrants.length);
console.log('');
console.log('  of the constant-false rules, ' + withGrantingSibling.length + ' sit in a block that ALSO grants.');
console.log('  Removing them is still safe (A OR false === A). What is NOT safe is reading');
console.log('  their presence as evidence about the granting sibling — that inference is');
console.log('  forbidden by this slice and is not made anywhere below.');

const md = [];
md.push('# Rules consolidation candidates — ' + FILE);
md.push('');
md.push('Generated by `scripts/audit-rules-inert-candidates.js`. **Mapping only — nothing removed, nothing published.**');
md.push('');
md.push('Base is the **served** ruleset `59af870d`, not the repo artifact: served is what is');
md.push('enforced today, is known releasable, and already carries the repaired');
md.push('`shopEmployees.shopOwnerId` anchor with its update-immutability clause.');
md.push('');
md.push('## The claim, and its limit');
md.push('');
md.push('`A OR false === A`. A rule whose condition is the literal `false` never grants, and an');
md.push('absent `allow` already denies. Removing one cannot change what any request may do.');
md.push('That is a property of the rule itself and requires no reasoning about its neighbours.');
md.push('');
md.push('**The inverse is forbidden.** The presence of `allow write: if false` is never evidence');
md.push('that another block for the same path is redundant. Same-scope blocks union —');
md.push('`platformConfig` unions `write: if isSuperAdmin()` with `write: if false`, and the result');
md.push('is superAdmin-writable. No candidate below is justified by a sibling.');
md.push('');
md.push('## Summary');
md.push('');
md.push('| | count |');
md.push('|---|---|');
md.push('| scopes in base | ' + Object.keys(scopes).length + ' |');
md.push('| constant-false rules, in scope | **' + constFalse.length + '** |');
md.push('| wholly inert blocks (all rules false, no nested match) | **' + inertBlocks.length + '** |');
md.push('| excluded by policy | ' + excluded.length + ' scopes |');
md.push('');
md.push('### Excluded, and why');
md.push('');
md.push('| rules | reason |');
md.push('|---|---|');
Object.keys(byWhy).forEach((w) => md.push('| ' + byWhy[w] + ' | ' + w + ' |'));
md.push('');
md.push('## Group A — wholly inert blocks (' + inertBlocks.length + ')');
md.push('');
md.push('Every rule constant-false and no nested `match`, so the block grants nothing at all.');
md.push('');
md.push('| line | path | rules |');
md.push('|---|---|---|');
inertBlocks.forEach((b) => md.push('| ' + b.line + ' | `' + b.path + '` | ' + b.rules + ' |'));
md.push('');
md.push('## Group B — constant-false rules (' + constFalse.length + ')');
md.push('');
md.push('`siblings that grant` is recorded for context only. It is **not** a justification and');
md.push('**no conclusion is drawn from it** — it is here so a reviewer can see the union each');
md.push('candidate sits in.');
md.push('');
md.push('| line | path | rule | siblings that grant |');
md.push('|---|---|---|---|');
constFalse.forEach((c) => md.push('| ' + c.line + ' | `' + c.path + '` | `allow ' + c.ops +
  ': ' + c.expr + '` | ' + (c.siblingGrants.length ? c.siblingGrants.length : '—') + ' |'));
md.push('');
md.push('## Proof obligation, per group');
md.push('');
md.push('Removal is proven by **differential evaluation**, not by inspection: the same request');
md.push('set is evaluated against the served source and against the candidate, and every verdict');
md.push('must match. A candidate that changes a single ALLOW/DENY is rejected outright.');
md.push('');
md.push('The sabotage control: a deliberately altered candidate — one granting rule weakened —');
md.push('must make the harness FAIL. A harness that passes everything proves nothing.');
fs.writeFileSync(OUT, md.join(NL) + NL);
console.log('');
console.log('  wrote ' + OUT + '  (' + md.length + ' lines)');
console.log('');
