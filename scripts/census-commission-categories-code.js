#!/usr/bin/env node
'use strict';
/* STATIC census (no network): every LITERAL category/hub string the code hands to the commission authority, resolved against
   commission-config — which ones fall to the generic default today. Server: calculateCommission({category|hubId}),
   resolveRate('x'), commissionArgsForHub, commissionCategory: 'x'. Client: SokoniCommission.pct/resolve('x'),
   data-sokoni-rate="x". Output: value | resolves to | call sites. */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CC = require(path.join(ROOT, 'functions', 'commission-config.js'));
const files = [];
(function walk(d, depth) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'docs', 'test', 'tests', 'scripts', 'backups'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); } else if (/\.(js|html)$/.test(e.name)) files.push(p);
  }
})(ROOT, 0);
const PATS = [
  /calculateCommission\([^)]*?category:\s*['"]([a-z0-9_ -]+)['"]/gi,
  /resolveRate\(\s*['"]([a-z0-9_ -]+)['"]/gi,
  /SokoniCommission\.(?:pct|resolve|fixedKES)\(\s*['"]([a-z0-9_ -]+)['"]/gi,
  /data-sokoni-rate=["']([a-z0-9_ -]+)["']/gi,
  /commissionCategory:\s*['"]([a-z0-9_ -]+)['"]/gi,
  /orderAmountCents[^}]{0,120}category:\s*['"]([a-z0-9_ -]+)['"]/gi,
  /* a generic `category || 'x'` is NOT scanned: it matches expense / notification / email categories unrelated to commission.
     The commission-relevant fallbacks are listed explicitly below. */
  /meta\?\.category\s*\|\|\s*['"]([a-z0-9_ -]+)['"]/gi,
  /m\.category\s*\|\|\s*['"]([a-z0-9_ -]+)['"]/gi,
];
const hits = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const re of PATS) for (const m of src.matchAll(re)) {
    const v = m[1].trim().toLowerCase(); const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const e = hits.get(v) || new Set(); e.add(rel); hits.set(v, e);
  }
}
const rows = [...hits.entries()].map(([v, s]) => ({ v, r: CC.resolveRate(v), s: [...s] })).sort((a, b) => a.v.localeCompare(b.v));
const def = rows.filter((x) => !x.r.matched || x.r.category === 'default');
console.log(`literal categories in code: ${rows.length} | explicit: ${rows.length - def.length} | DEFAULT: ${def.length}`);
for (const x of def) console.log(`  ${x.v.padEnd(28)} → ${x.r.category} ${x.r.pct}%   ${x.s.slice(0, 4).join(', ')}${x.s.length > 4 ? ' …+' + (x.s.length - 4) : ''}`);
