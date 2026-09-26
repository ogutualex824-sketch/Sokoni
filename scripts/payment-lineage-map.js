#!/usr/bin/env node
/* payment-lineage-map.js — READ-ONLY. For each serving payment function, compute the
 * transitive require-closure INSIDE its deployed source archive, and compare every file
 * of that closure, by git blob, against named repository trees.
 *
 *   node scripts/payment-lineage-map.js <deployedRoot> [treeish ...]
 *
 * <deployedRoot>/<functionName>/ holds the unzipped function-source.zip (gcf-v2-sources).
 * Nothing is written anywhere; output is JSON on stdout. No network.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [, , ROOT, ...TREES] = process.argv;
const FNS = ['webhookIntasend', 'initiateSTKPush', 'createPaymentIntent', 'fosSubmitRefund', 'fosApproveRefund', 'adminOsDispatch', 'requestSellerPayout'];
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const blobOf = (file) => git(['hash-object', file]).trim();

/* path → blob for each tree (functions/ only) */
const treeMaps = {};
for (const t of TREES) {
  const m = {};
  for (const line of git(['ls-tree', '-r', t, '--', 'functions/']).split('\n')) {
    const mm = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/);
    if (mm) m[mm[2].replace(/^functions\//, '')] = mm[1];
  }
  treeMaps[t] = m;
}

function resolveReq(fromFile, spec, dir) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(dir, c).split(path.sep).join('/');
  }
  return null;
}
function closure(dir, entry) {
  const seen = new Set(); const unresolved = new Set(); const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, rel), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const r = resolveReq(path.join(dir, rel), m[1], dir);
      if (r) stack.push(r); else unresolved.add(rel + ' -> ' + m[1]);
    }
  }
  return { files: [...seen].sort(), unresolved: [...unresolved] };
}
function definingFile(dir, fn) {
  const re = new RegExp('exports\\.' + fn + '\\s*=\\s*(onCall|onRequest|onSchedule|onDocument\\w+|functions\\.)', 'm');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js') && re.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(dir, p).split(path.sep).join('/'));
  } };
  walk(dir);
  return hits;
}

const out = { trees: TREES, functions: {} };
for (const fn of FNS) {
  const dir = path.join(ROOT, fn);
  if (!fs.existsSync(dir)) { out.functions[fn] = { error: 'archive missing' }; continue; }
  const defs = definingFile(dir, fn);
  /* the entry point is index.js (what the runtime loads); the definition may live in a module */
  const cl = closure(dir, defs[0] || 'index.js');
  const files = cl.files.map((f) => {
    const b = blobOf(path.join(dir, f));
    const inTrees = {};
    for (const t of TREES) inTrees[t] = treeMaps[t][f] === b ? 'same' : (treeMaps[t][f] ? 'differs' : 'absent');
    return { file: f, blob: b.slice(0, 12), inTrees };
  });
  out.functions[fn] = { definedIn: defs, closureSize: files.length, unresolved: cl.unresolved, files };
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
