'use strict';
/* Phase 3 data-path audit for the Admin OS migration to AdminAPI.
 *
 *   node scripts/audit-admin-data-paths.js
 *
 * Scans the admin client codebase for every direct data-access primitive and
 * classifies each occurrence by its enclosing function, so "every data path is
 * documented" is a machine-checkable fact, not a claim. Output feeds
 * docs/ADMIN_DATA_PATHS.md and is a regression tripwire: a NEW direct read shows
 * up here immediately.
 *
 * Read-only.
 */
const fs = require('fs');
const path = require('path');

const FILES = ['admin.html', 'admin-api.js'];
const PRIMITIVES = [
  { key: 'onSnapshot', re: /\bonSnapshot\s*\(/ },
  { key: 'getDocs', re: /\bgetDocs\s*\(/ },
  { key: 'getDoc', re: /\bgetDoc\s*\(/ },
  { key: 'collection(', re: /\bcollection\s*\(/ },
  { key: 'query(', re: /\bquery\s*\(/ },
  { key: 'where(', re: /\bwhere\s*\(/ },
  { key: 'orderBy(', re: /\borderBy\s*\(/ },
  { key: 'firebase.firestore', re: /firebase\.firestore/ },
  { key: 'localStorage', re: /\blocalStorage\b/ },
  { key: 'sessionStorage', re: /\bsessionStorage\b/ },
];

/* Best-effort enclosing-function name by scanning upward for `function NAME(` /
   `NAME = function` / `NAME(...) {` / `async NAME(`. */
function enclosingFn(lines, i) {
  for (let j = i; j >= 0 && j > i - 400; j--) {
    const m = lines[j].match(/function\s+([A-Za-z0-9_$]+)\s*\(/)
      || lines[j].match(/^\s*([A-Za-z0-9_$]+)\s*[:=]\s*(?:async\s*)?function/)
      || lines[j].match(/^\s*(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/);
    if (m && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(m[1])) return m[1];
  }
  return '(top-level)';
}

const results = {};
for (const f of FILES) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const prim of PRIMITIVES) {
      if (prim.re.test(lines[i])) {
        const fn = enclosingFn(lines, i);
        (results[prim.key] = results[prim.key] || []).push({ file: f, line: i + 1, fn, code: lines[i].trim().slice(0, 90) });
      }
    }
  }
}

let total = 0;
console.log('=== Admin data-access primitives (admin.html + admin-api.js) ===\n');
for (const prim of PRIMITIVES) {
  const hits = results[prim.key] || [];
  total += hits.length;
  console.log(`${prim.key.padEnd(18)} ${hits.length}`);
  const byFn = {};
  hits.forEach(h => { byFn[h.fn] = (byFn[h.fn] || 0) + 1; });
  Object.entries(byFn).sort((a, b) => b[1] - a[1]).forEach(([fn, n]) => console.log(`    ${String(n).padStart(3)}  ${fn}`));
}
console.log('\nTOTAL occurrences:', total);

/* Group by enclosing function → the migration work-list. */
console.log('\n=== By enclosing function (migration work-list) ===');
const fnMap = {};
for (const prim of PRIMITIVES) (results[prim.key] || []).forEach(h => {
  const k = h.fn;
  fnMap[k] = fnMap[k] || { prims: new Set(), lines: [] };
  fnMap[k].prims.add(prim.key); fnMap[k].lines.push(h.line);
});
Object.entries(fnMap).sort((a, b) => b[1].lines.length - a[1].lines.length).forEach(([fn, v]) => {
  console.log(`  ${fn.padEnd(26)} [${[...v.prims].join(', ')}]  lines ${v.lines.slice(0, 8).join(',')}${v.lines.length > 8 ? '…' : ''}`);
});
