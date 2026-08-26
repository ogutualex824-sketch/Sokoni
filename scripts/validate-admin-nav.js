#!/usr/bin/env node
/* ============================================================================
   Validate sokoni-admin-nav.js against the confirmed census — CI gate
   ============================================================================
   Catches the failure modes that make a navigation registry silently wrong:
     - a confirmed admin page missing from the registry (a new dead end)
     - a registry entry whose file does not exist (a dead link)
     - a NON-admin surface admitted (breaks a merchant/POS workspace)
     - a parent that is not itself registered (broken breadcrumb)
     - a parent cycle (infinite trail)
     - an unreachable page: no parent AND not the workspace root
     - a section id with no definition
   Usage: node scripts/validate-admin-nav.js
   Exit:  1 on any failure — this IS a gate.
   ========================================================================= */
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* Load the registry in a DOM-less context by faking the globals it touches. */
global.window   = {};
global.location = { pathname: '/admin-os.html' };
require(path.join(ROOT, 'sokoni-admin-nav.js'));
const NAV = global.window.SokoniAdminNav;

/* Surfaces that must NEVER appear — each would break another workspace. */
const MUST_EXCLUDE = {
  'staff-management.html': 'business owner (businesses where ownerId == uid)',
  'minishop-admin.html':   'business owner (My MiniShop — SOKONI Seller)',
  'pos-staff-ops.html':    'POS staff (SmartPOS shift session)',
  'pos-live-floor.html':   'POS staff',
  'pos-till-manager.html': 'POS staff',
  'pos-cash-manager.html': 'POS staff',
  'seller-wallet.html':    'merchant (accepts claims.seller)',
  'seller-analytics.html': 'merchant analytics',
  'profile.html':          'customer account surface',
  'trust.html':            'public Trust Passport',
  'trust-and-safety.html': 'public marketing page',
  'beta.html':             'public beta invite',
  'returns.html':          'dual-mode customer/admin',
  'test-accounts.html':    'not served (firebase.json ignore)',
  'platform-hub.html':     'AMBIGUOUS — claims.role semantics unproven; held out by ruling',
};

const CONFIRMED = path.join(ROOT, 'docs', 'admin-confirmed-pages.json');
let confirmed = null;
if (fs.existsSync(CONFIRMED)) confirmed = JSON.parse(fs.readFileSync(CONFIRMED, 'utf8'));

const fail = [], warn = [];
const byPage = {};
NAV.pages.forEach(p => { byPage[p.page] = p; });
const sectionIds = new Set(NAV.sections.map(s => s.id));

/* 1. every registry entry maps to a real file */
NAV.pages.forEach(p => {
  if (!fs.existsSync(path.join(ROOT, p.page))) fail.push(`MISSING FILE: ${p.page} is registered but not on disk`);
});

/* 2. no excluded surface admitted */
Object.keys(MUST_EXCLUDE).forEach(p => {
  if (byPage[p]) fail.push(`WRONGLY INCLUDED: ${p} — ${MUST_EXCLUDE[p]}`);
});

/* 3. parents resolve, no cycles, everything reachable */
NAV.pages.forEach(p => {
  if (p.parent && !byPage[p.parent]) fail.push(`BAD PARENT: ${p.page} -> ${p.parent} (not registered)`);
  if (!p.parent && p.page !== NAV.home) fail.push(`UNREACHABLE: ${p.page} has no parent and is not the workspace root`);
  if (!sectionIds.has(p.section)) fail.push(`BAD SECTION: ${p.page} -> "${p.section}"`);
  let seen = new Set(), cur = p, n = 0;
  while (cur && n++ < 20) {
    if (seen.has(cur.page)) { fail.push(`PARENT CYCLE at ${p.page}`); break; }
    seen.add(cur.page);
    cur = cur.parent ? byPage[cur.parent] : null;
  }
});

/* 4. exactly one workspace root */
const roots = NAV.pages.filter(p => !p.parent);
if (roots.length !== 1) fail.push(`Expected exactly 1 workspace root, found ${roots.length}: ${roots.map(r => r.page).join(', ')}`);

/* 5. authority values are real claims SOKONI actually mints */
const VALID_AUTHORITY = new Set(['admin', 'superAdmin', 'moderator']);
NAV.pages.forEach(p => {
  if (!VALID_AUTHORITY.has(p.authority)) fail.push(`BAD AUTHORITY: ${p.page} -> "${p.authority}" (setUserRole never mints this)`);
});

/* 6. coverage against the confirmed census, when present */
if (confirmed) {
  const reg = new Set(NAV.pages.map(p => p.page));
  confirmed.forEach(p => { if (!reg.has(p)) fail.push(`NOT IN REGISTRY: ${p} is CONFIRMED ADMIN but has no entry (a dead end)`); });
  NAV.pages.forEach(p => { if (!confirmed.includes(p.page)) warn.push(`EXTRA: ${p.page} is registered but not in the confirmed census`); });
} else {
  warn.push('docs/admin-confirmed-pages.json not found — coverage not checked');
}

/* 7. LEGACY pages accept NO new inbound references.
   A page marked legacy:true is on a controlled retirement path. Every new link to it
   makes that retirement harder and re-establishes it as a live destination. The
   canonical target is in migrateTo. */
NAV.pages.filter(p => p.legacy).forEach(legacy => {
  const linkers = [];
  NAV.pages.forEach(src => {
    if (src.page === legacy.page) return;
    let html = '';
    try { html = fs.readFileSync(path.join(ROOT, src.page), 'utf8'); } catch (e) { return; }
    const bare = legacy.page.replace(/\.html$/, '');
    const re = new RegExp('href\\s*=\\s*["\']\\.?/?(' + bare + '(\\.html)?)["\'#?]', 'i');
    if (re.test(html)) linkers.push(src.page);
  });
  if (linkers.length) {
    fail.push(`LEGACY PAGE LINKED: ${legacy.page} is legacy (migrate to ${legacy.migrateTo}) ` +
              `but is linked from: ${linkers.join(', ')}. Point these at ${legacy.migrateTo}.`);
  }
});

/* 8. aliases point at real entries */
NAV.pages.forEach(p => (p.aliases || []).forEach(a => {
  if (!byPage[a]) warn.push(`ALIAS ${a} on ${p.page} is not itself registered`);
}));

console.log(`registry v${NAV.version} — ${NAV.pages.length} pages, ${NAV.sections.length} sections`);
const counts = {};
NAV.pages.forEach(p => { counts[p.section] = (counts[p.section] || 0) + 1; });
NAV.sections.forEach(s => console.log(`  ${String(counts[s.id] || 0).padStart(3)}  ${s.label}`));

if (warn.length) { console.log('\nWARNINGS'); warn.forEach(w => console.log('  ! ' + w)); }
if (fail.length) { console.log('\nFAILURES'); fail.forEach(f => console.log('  X ' + f)); console.log(`\n${fail.length} failure(s)`); process.exit(1); }
console.log('\nAll checks passed.');
