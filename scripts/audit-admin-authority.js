#!/usr/bin/env node
/* DUPLICATE-AUTHORITY AUDIT (step 6).
   The risk is not "two files mention claims". It is two authorities that can
   DISAGREE about the same page: the shared guard demanding one claim while the
   page's own gate demands another. A page where guard=superAdmin but the page
   accepts admin is a real divergence — the stricter layer can be removed and
   the weaker one still admits.
   Registry authority is the third opinion and should agree with both. */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
global.window = {}; global.location = { pathname: '/admin-os.html' };
require(path.join(ROOT, 'sokoni-admin-nav.js'));
const NAV = global.window.SokoniAdminNav;

const rows = [];
for (const p of NAV.pages) {
  let h = '';
  try { h = fs.readFileSync(path.join(ROOT, p.page), 'utf8'); } catch (e) { continue; }

  const guard = (h.match(/data-admin-guard\s*=\s*["']([^"']+)["']/) || [])[1] || null;

  /* the page's OWN claim opinion, from its inline gate */
  const own = new Set();
  if (/claims\s*\.\s*superAdmin|claims\[['"]superAdmin/.test(h)) own.add('superAdmin');
  if (/claims\s*\.\s*admin\b|claims\[['"]admin['"]\]/.test(h))   own.add('admin');
  if (/claims\s*\.\s*moderator/.test(h))                          own.add('moderator');

  rows.push({ page: p.page, registry: p.authority || null, guard,
              own: [...own].join('+') || null });
}

/* rank: a page is divergent if its own gate admits a claim strictly weaker
   than what the guard/registry require */
const RANK = { superAdmin: 3, admin: 2, moderator: 1 };
const weakest = s => s ? Math.min(...s.split('+').map(x => RANK[x] || 9)) : null;

const noGuard   = rows.filter(r => !r.guard);
const divergent = rows.filter(r => {
  if (!r.guard || !r.own) return false;
  return weakest(r.own) < (RANK[r.guard] || 0);
});
const regMismatch = rows.filter(r => r.guard && r.registry && r.guard !== r.registry);

console.log('registry pages          : ' + rows.length);
console.log('carry data-admin-guard  : ' + rows.filter(r => r.guard).length);
console.log('NO shared guard         : ' + noGuard.length +
            (noGuard.length ? '  -> ' + noGuard.map(r => r.page).join(', ') : ''));
console.log('\nguard vs REGISTRY mismatch : ' + regMismatch.length);
regMismatch.forEach(r => console.log('   ' + r.page + '  guard=' + r.guard + '  registry=' + r.registry));
console.log('\nguard STRICTER than the page\'s own gate (divergence): ' + divergent.length);
divergent.forEach(r => console.log('   ' + r.page + '  guard=' + r.guard + '  own=' + r.own));

const both = rows.filter(r => r.guard && r.own).length;
console.log('\npages with BOTH a shared guard and their own claim check: ' + both);
console.log('pages relying on the shared guard ALONE                 : ' +
            rows.filter(r => r.guard && !r.own).length);

/* GATE: authority declarations must agree. A page-local gate broader than the
   registry is a contradictory authorization declaration even when the server
   denies the data — resolve it by DECISION, never by loosening the registry. */
const failures = divergent.length + regMismatch.length + noGuard.length;
if (failures) {
  console.error("");
  console.error("AUTHORITY GATE FAILED — " + failures + " inconsistency(ies).");
  process.exit(1);
}
console.error("");
console.log("Authority gate: registry, shared guard and page-local gates agree.");