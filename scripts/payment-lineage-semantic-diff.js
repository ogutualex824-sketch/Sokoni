#!/usr/bin/env node
/* payment-lineage-semantic-diff.js — READ-ONLY. For every file that two or more serving
 * payment functions load with DIFFERENT bytes, decide whether the versions differ in
 * CODE or only in comments/formatting: parse each version with @babel/parser and
 * compare the ASTs with locations, comments and raw-text fields stripped.
 *
 *   node scripts/payment-lineage-semantic-diff.js <deployedRoot> <lineage.json>
 *
 * "SAME CODE" = identical AST (a comment-only or whitespace-only difference).
 * "DIFFERENT CODE" = the programs differ; the report lists the top-level declarations
 * whose code changed, so a reviewer can see what a single composition would have to decide.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parse } = require(path.join(__dirname, '..', 'functions', 'node_modules', '@babel', 'parser'));

const [, , ROOT, LINEAGE] = process.argv;
const j = JSON.parse(fs.readFileSync(LINEAGE, 'utf8'));
const DROP = new Set(['start', 'end', 'loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);
const norm = (n) => JSON.stringify(n, (k, v) => (DROP.has(k) ? undefined : v));
const ast = (src) => parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true, plugins: ['optionalChaining', 'nullishCoalescingOperator'] }).program;
/* top-level units: function / class / variable declarations and `exports.x =` / `module.exports` assignments */
function units(program) {
  const out = {};
  program.body.forEach((st, i) => {
    let key = null;
    if (st.type === 'FunctionDeclaration' && st.id) key = 'function ' + st.id.name;
    else if (st.type === 'ClassDeclaration' && st.id) key = 'class ' + st.id.name;
    else if (st.type === 'VariableDeclaration') key = 'const ' + st.declarations.map((d) => (d.id && d.id.name) || '?').join(',');
    else if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression') {
      const l = st.expression.left;
      const name = (o) => (o.type === 'MemberExpression' ? name(o.object) + '.' + (o.property.name || o.property.value) : (o.name || '?'));
      key = name(l);
    }
    key = key || ('stmt#' + i + ':' + st.type);
    let k = key, n = 2; while (out[k]) k = key + '#' + (n++);
    out[k] = norm(st);
  });
  return out;
}

const byFile = {};
for (const [fn, v] of Object.entries(j.functions)) {
  if (v.error || fn === 'fosApproveRefund') continue;
  for (const f of v.files) (byFile[f.file] = byFile[f.file] || {})[fn] = f.blob;
}
const report = [];
for (const [file, m] of Object.entries(byFile)) {
  const fns = Object.keys(m);
  if (fns.length < 2 || new Set(Object.values(m)).size < 2 || !file.endsWith('.js')) continue;
  const versions = {};                       /* blob → { fns, units, code } */
  for (const fn of fns) {
    const b = m[fn];
    if (!versions[b]) {
      const src = fs.readFileSync(path.join(ROOT, fn, file), 'utf8');
      const p = ast(src);
      versions[b] = { fns: [], code: norm(p), units: units(p) };
    }
    versions[b].fns.push(fn);
  }
  const vs = Object.entries(versions);
  const codeVariants = new Set(vs.map(([, v]) => v.code)).size;
  let changed = [];
  if (codeVariants > 1) {
    const all = new Set(vs.flatMap(([, v]) => Object.keys(v.units)));
    for (const u of all) { if (new Set(vs.map(([, v]) => v.units[u] || '<absent>')).size > 1) changed.push(u); }
  }
  report.push({ file, byteVersions: vs.length, codeVariants, versions: vs.map(([b, v]) => ({ blob: b, loadedBy: v.fns })), changedUnits: changed });
}
report.sort((a, b) => b.codeVariants - a.codeVariants || a.file.localeCompare(b.file));
process.stdout.write(JSON.stringify(report, null, 1) + '\n');
