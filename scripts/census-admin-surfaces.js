#!/usr/bin/env node
/* ============================================================================
   Admin surface census — classify by ENFORCEMENT, never by filename
   ============================================================================
   The 2026-08-25 routing audit mis-classified staff-management.html as a
   platform-admin console because of its name. It is a business-owner tool
   (`businesses where ownerId == uid`); admin-gating it would have locked out
   sellers. minishop-admin ("My MiniShop — SOKONI Seller") and pos-staff-ops
   (SmartPOS) are the same trap.

   A FIRST VERSION of this script classified on whether a page MENTIONED an
   admin claim. That was wrong in both directions: seller-wallet.html and three
   SmartPOS pages came back PLATFORM_ADMIN (they check `isAdmin` only to reveal
   an extra control), while security-center.html came back CUSTOMER. Mentioning
   a claim is not requiring one.

   So the discriminator here is ENFORCEMENT: a claim check that is followed,
   within a short window, by a deny action — a redirect, a thrown error, a
   blocking overlay, or the declarative data-admin-guard attribute. That is what
   "this page requires admin" actually looks like in this codebase.

     PLATFORM_ADMIN  enforces an admin/superAdmin/moderator claim
     BUSINESS_OWNER  scopes reads to the caller's own shop/business
     POS_STAFF       operates a till/terminal/shift session
     CUSTOMER        none of the above
     MIXED           enforces admin AND scopes to own business — reported, not
                     guessed, because choosing wrong either locks out a merchant
                     or leaks a platform surface

   Usage: node scripts/census-admin-surfaces.js [--json out.json] [--explain PAGE]
   Exit:  0 always — a report, not a gate.
   ========================================================================= */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const argv    = process.argv.slice(2);
const OUT     = (() => { const i = argv.indexOf('--json');    return i >= 0 ? argv[i + 1] : null; })();
const EXPLAIN = (() => { const i = argv.indexOf('--explain'); return i >= 0 ? argv[i + 1] : null; })();

/* Pages Firebase Hosting never serves are not part of any workspace. */
const NOT_DEPLOYED = new Set(['test-accounts.html', 'pos-hardware-setup.html', 'email-preview.html']);

const pages = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.html') && fs.statSync(path.join(ROOT, f)).isFile())
  .sort();

/* A NEGATED admin claim — "if the user is NOT an admin". Reading a claim to
   branch UI is NOT enforcement: returns.html picks PLATFORM_ADMIN vs
   PUBLIC_CUSTOMER from one and is a dual-mode page, not an admin console. Only
   a negative test that leads to a deny means "this page requires admin". */
const NEG = [
  /!\s*[\w.?]*\bclaims\s*\??\s*[.[]\s*['"]?(admin|superAdmin|moderator)/,
  /\bclaims\s*\??\s*[.[]\s*['"]?(admin|superAdmin|moderator)['"]?\]?\s*(!==|!=)\s*true/,
  /!\s*[\w.?]*\btoken\s*\??\s*\.\s*(admin|superAdmin|moderator)\b/,
  /\btoken\s*\??\s*\.\s*(admin|superAdmin|moderator)\s*(!==|!=)\s*true/,
];
const CLAIM = { test: (s) => NEG.some((re) => re.test(s)) };
const DENY   = /(location\s*\.\s*(href|replace)|window\s*\.\s*location|throw\b|accessDenied|showAccessDenied|authGate|deny\(|insufficient|display\s*=\s*['"]none)/;
const OWN    = [
  /where\(\s*['"]ownerId['"]\s*,\s*['"]==['"]/,
  /where\(\s*['"]sellerUid['"]\s*,\s*['"]==['"]/,
  /where\(\s*['"]shopId['"]\s*,\s*['"]==['"]/,
  /where\(\s*['"]uid['"]\s*,\s*['"]==['"]\s*,\s*[^)]*(currentUser|_user\b|user\.uid)/,
  /doc\(\s*_?db\s*,\s*['"](shops|sellers|businesses)['"]\s*,\s*[^)]*(uid|currentUser)/,
];
/* A till/shift SESSION, not a passing mention of SmartPOS. */
const POS    = [/\bposSession\b/, /\btillSession\b/, /\bshiftId\b/, /\bcashDrawer\b/, /\bopenShift\b/, /\bterminalId\b/];

/** Is an admin claim ENFORCED on this page?
 *
 *  A NEGATED test ("if NOT admin") is the gate idiom; a POSITIVE read
 *  ("claims.admin ? adminView : customerView") is UI branching. That
 *  distinction alone separates them reliably, so no proximity-to-deny window is
 *  needed — and requiring one produced FALSE NEGATIVES, because every page
 *  denies differently: admin.html calls _lockSetError() and returns, others
 *  redirect, others paint an overlay. Enumerating deny helpers is a losing game;
 *  the negated test is the invariant.
 *
 *  DENY is still consulted, but only to record HOW the page denies — never to
 *  decide WHETHER it gates. */
function enforcesClaim(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!CLAIM.test(lines[i])) continue;
    const win = lines.slice(i, Math.min(lines.length, i + 12)).join('\n');
    return {
      at: i + 1,
      snippet: lines[i].trim().slice(0, 90),
      denyForm: DENY.test(win) ? 'redirect/throw/overlay' : 'other (inline deny)',
    };
  }
  return null;
}

/* ── link graph ───────────────────────────────────────────────────────────── */
const inbound = {}, outbound = {};
for (const p of pages) {
  const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
  outbound[p] = new Set();
  let m; const re = /href\s*=\s*["']([^"'#?]+)/g;
  while ((m = re.exec(src))) {
    let t = m[1].split('#')[0].split('?')[0].replace(/^\.?\//, '');
    if (!t) continue;
    if (!/\.html$/.test(t)) t += '.html';
    if (!pages.includes(t) || t === p) continue;
    outbound[p].add(t);
    (inbound[t] = inbound[t] || new Set()).add(p);
  }
}

const rows = [];
for (const p of pages) {
  const src   = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const lines = src.split('\n');
  const declarative = /data-admin-guard\s*=/.test(src);
  const enforced = declarative ? { at: 0, snippet: 'data-admin-guard (declarative)' } : enforcesClaim(lines);
  const own = OWN.filter(re => re.test(src)).length;
  const pos = POS.filter(re => re.test(src)).length;

  let klass;
  if (NOT_DEPLOYED.has(p))      klass = 'NOT_DEPLOYED';
  else if (enforced && own)     klass = 'MIXED';
  else if (enforced)            klass = 'PLATFORM_ADMIN';
  else if (own)                 klass = 'BUSINESS_OWNER';
  else if (pos)                 klass = 'POS_STAFF';
  else                          klass = 'CUSTOMER';

  rows.push({
    page: p, klass,
    enforcedAt: enforced ? enforced.at : null,
    evidence:   enforced ? enforced.snippet : null,
    ownSignals: own, posSignals: pos,
    guarded: declarative,
    title: (src.match(/<title>([^<]*)/) || [, ''])[1].trim().slice(0, 50),
    inbound: [...(inbound[p] || [])],
    inboundCount: (inbound[p] || new Set()).size,
  });
}

if (EXPLAIN) {
  const r = rows.find(x => x.page === EXPLAIN || x.page === EXPLAIN + '.html');
  console.log(r ? JSON.stringify(r, null, 2) : 'no such page');
  process.exit(0);
}

const admin = rows.filter(r => r.klass === 'PLATFORM_ADMIN').sort((a, b) => a.page.localeCompare(b.page));
const mixed = rows.filter(r => r.klass === 'MIXED');
const NAMEY = /admin|ops\b|platform|super|staff|moderation|trust|beta|verification|compliance|enterprise|release|uat|security|reliability/i;

const tally = {};
rows.forEach(r => { tally[r.klass] = (tally[r.klass] || 0) + 1; });
console.log('=== ALL ' + rows.length + ' ROOT PAGES ===');
Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k.padEnd(16) + v));

console.log('\n=== PLATFORM_ADMIN — enforces an admin claim (' + admin.length + ') ===');
console.log('  PAGE'.padEnd(38), 'IN'.padStart(3), 'GUARD', ' EVIDENCE');
admin.forEach(r => console.log('  ' + r.page.padEnd(36), String(r.inboundCount).padStart(3),
  ' ' + (r.guarded ? 'yes ' : ' -  '), ' ' + (r.evidence || '').slice(0, 62)));

console.log('\n=== NAME SUGGESTS ADMIN, EVIDENCE SAYS OTHERWISE (do NOT admin-gate) ===');
rows.filter(r => r.klass !== 'PLATFORM_ADMIN' && r.klass !== 'MIXED' && NAMEY.test(r.page))
  .sort((a, b) => a.page.localeCompare(b.page))
  .forEach(r => console.log('  ' + r.page.padEnd(36), r.klass.padEnd(15), r.title));

if (mixed.length) {
  console.log('\n=== MIXED — needs a human decision (' + mixed.length + ') ===');
  mixed.forEach(r => console.log('  ' + r.page.padEnd(36),
    'own=' + r.ownSignals, ' ', r.title, '\n      claim @' + r.enforcedAt + ': ' + (r.evidence || '')));
}

const isolated = admin.filter(r => r.inboundCount === 0);
console.log('\n=== ISOLATED admin pages — 0 inbound links (' + isolated.length + ') ===');
isolated.forEach(r => console.log('  ' + r.page.padEnd(36), r.title));

if (OUT) { fs.writeFileSync(OUT, JSON.stringify(rows, null, 2)); console.log('\nwrote ' + OUT); }
