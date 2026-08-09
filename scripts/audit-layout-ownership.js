'use strict';
/**
 * Shared layout-state ownership audit — Sprint 2 Phase 2.0.
 *
 * A dirty-check on `--sk-header-h` regressed style recalculation by 10% because
 * `sokoni-layout.js` cached a write it did not own: `shared-header.js` writes the
 * same property. Caching then went stale, elements settled at wrong offsets, and
 * the invalidation cost more than the redundant writes ever did.
 *
 * That is a CORRECTNESS defect, not a performance one, and it is invisible until
 * two writers happen to disagree. This finds every such property before more
 * optimisation is attempted on top of an inconsistent state model.
 *
 * Classifies each shared custom property as:
 *   OWNED       exactly one runtime writer            — safe
 *   CONTESTED   two or more runtime writers           — must be resolved
 *   STATIC      declared in CSS only, never written   — safe
 *   ORPHAN      written but never read                — dead
 *
 * A CSS *declaration* (`--x: 4px` in a stylesheet or style block) is a default,
 * not a writer; only runtime `setProperty` calls compete. Both are reported,
 * because a default that disagrees with the runtime value is its own trap.
 *
 *   node scripts/audit-layout-ownership.js
 *   node scripts/audit-layout-ownership.js --json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AS_JSON = process.argv.includes('--json');

/* Layout-affecting shared state. Deliberately not every --sk-* token: colours
   and radii cannot cause a positioning bug. */
const TRACKED = /^--sk-(header-h|tab-bar-h|bottom-nav-h|fab-bottom|fab-right|chat-bottom|scroll-bottom|content-pad-bottom|viewport-[hw]|safe-(top|bottom|left|right)|keyboard-h)$/;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []).filter(f => !/[\\/](scripts|functions[\\/]test|tests)[\\/]/.test(f));
const props = new Map();   /* name -> { writers:Map, readers:Map, declared:Map } */

const bump = (name, bucket, file, line) => {
  if (!props.has(name)) props.set(name, { writers: new Map(), readers: new Map(), declared: new Map() });
  const rec = props.get(name)[bucket];
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (!rec.has(rel)) rec.set(rel, []);
  rec.get(rel).push(line);
};

for (const f of files) {
  let src; try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  const lines = src.split('\n');
  lines.forEach((ln, i) => {
    const no = i + 1;
    /* Runtime writer: setProperty('--x', …) or removeProperty('--x') */
    let m;
    const wRe = /(?:setProperty|removeProperty)\(\s*['"`](--[a-z0-9-]+)['"`]/gi;
    while ((m = wRe.exec(ln))) if (TRACKED.test(m[1])) bump(m[1], 'writers', f, no);
    /* Reader: var(--x) */
    const rRe = /var\(\s*(--[a-z0-9-]+)/gi;
    while ((m = rRe.exec(ln))) if (TRACKED.test(m[1])) bump(m[1], 'readers', f, no);
    /* Reader: getPropertyValue('--x') */
    const gRe = /getPropertyValue\(\s*['"`](--[a-z0-9-]+)['"`]/gi;
    while ((m = gRe.exec(ln))) if (TRACKED.test(m[1])) bump(m[1], 'readers', f, no);
    /* Static declaration in CSS: `--x: value;` not inside var()/setProperty */
    const dRe = /(^|[;{\s])(--[a-z0-9-]+)\s*:/g;
    while ((m = dRe.exec(ln))) {
      if (!TRACKED.test(m[2])) continue;
      if (/setProperty|getPropertyValue|var\(/.test(ln)) continue;
      bump(m[2], 'declared', f, no);
    }
  });
}

const rows = [...props.entries()].map(([name, r]) => {
  const writers = [...r.writers.keys()];
  const readers = [...r.readers.keys()];
  const declared = [...r.declared.keys()];
  let status;
  if (writers.length > 1) status = 'CONTESTED';
  else if (writers.length === 1) status = readers.length ? 'OWNED' : 'ORPHAN';
  else status = declared.length ? 'STATIC' : 'UNUSED';
  return { name, status, writers, readers, declared,
           writerLines: Object.fromEntries(r.writers) };
}).sort((a, b) => {
  const rank = s => ({ CONTESTED: 0, ORPHAN: 1, OWNED: 2, STATIC: 3, UNUSED: 4 }[s]);
  return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
});

if (AS_JSON) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

console.log('\nShared layout-state ownership audit');
console.log('OWNED = 1 writer · CONTESTED = 2+ writers (must resolve) · STATIC = CSS default only\n');

const contested = rows.filter(r => r.status === 'CONTESTED');
for (const r of rows) {
  console.log(`${r.status.padEnd(10)} ${r.name}`);
  if (r.writers.length) {
    r.writers.forEach(w => console.log(`             writes: ${w}  (lines ${r.writerLines[w].join(', ')})`));
  }
  if (r.declared.length) console.log(`             css default: ${r.declared.slice(0, 3).join(', ')}${r.declared.length > 3 ? ` +${r.declared.length - 3}` : ''}`);
  console.log(`             readers: ${r.readers.length}`);
}

console.log('\n────────────────────────────────────────────────────────');
console.log(`CONTESTED: ${contested.length}   OWNED: ${rows.filter(r => r.status === 'OWNED').length}   ` +
            `STATIC: ${rows.filter(r => r.status === 'STATIC').length}   ORPHAN: ${rows.filter(r => r.status === 'ORPHAN').length}`);
if (contested.length) {
  console.log('\nMUST RESOLVE — more than one runtime writer:');
  contested.forEach(r => console.log(`  ${r.name}  <-  ${r.writers.join('  +  ')}`));
  process.exitCode = 1;   /* usable as a gate once ownership is established */
}
