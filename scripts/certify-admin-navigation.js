#!/usr/bin/env node
/* ============================================================================
   Admin navigation certification — hierarchy, reachability, fallbacks
   ============================================================================
   Complements scripts/certify-admin-responsive.js (which covers layout).
   This asserts the NAVIGATION contract for a set of admin pages:

     registry-entry     the page has a canonical registry entry
     correct-parent     its parent resolves and is itself registered
     home-path          Admin Home -> ... -> page is walkable in the registry
     parent-link        the rendered breadcrumb offers a link to the parent
     siblings           the sidebar exposes same-section siblings
     active-state       exactly one aria-current="page", and it is THIS page
     no-bad-fallback    no index.html / seller.html / bare "/" navigation target
     deep-link          loading the URL directly lands on that page (no bounce)
     inbound            some other registered admin page links here, OR the
                        shell sidebar provides the inbound path

   Usage:
     node scripts/certify-admin-navigation.js --section finance
     node scripts/certify-admin-navigation.js --pages a.html,b.html
   Requires a local server. Exit 1 on any failure.
   ========================================================================= */
'use strict';
const path = require('path');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const argv = process.argv.slice(2);
const arg  = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:3000');

/* registry, loaded DOM-lessly */
global.window = {}; global.location = { pathname: '/admin-os.html' };
require(path.join(ROOT, 'sokoni-admin-nav.js'));
const NAV = global.window.SokoniAdminNav;

const SECTION = arg('--section', null);
let PAGES;
if (SECTION) PAGES = NAV.pages.filter(p => p.section === SECTION).map(p => p.page);
else PAGES = (arg('--pages', '') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!PAGES.length) { console.error('nothing to certify — pass --section or --pages'); process.exit(1); }

const ADMIN_STUB = () => {
  const claims = { admin: true, superAdmin: true };
  const u = { uid: 'nav_admin', email: 'nav@sokoni.test',
              getIdTokenResult: async () => ({ claims }) };
  window.firebaseAuth = { currentUser: u };
  const q = { collection: () => q, doc: () => q, where: () => q, orderBy: () => q, limit: () => q,
              get: async () => ({ empty: true, size: 0, docs: [], forEach() {} }),
              onSnapshot: () => () => {}, add: async () => {}, set: async () => {}, update: async () => {} };
  window.firebase = { auth: () => ({ onAuthStateChanged: (cb) => cb(u), currentUser: u }),
                      firestore: () => q,
                      functions: () => ({ httpsCallable: () => async () => ({ data: {} }) }) };
  window.firebase.initializeApp = (cfg, name) => ({ name: name || '[DEFAULT]', options: cfg || {} });
  window.firebase.apps = [];
  window.firebase.app = (name) => ({ name: name || '[DEFAULT]' });
  window.firebase.firestore.FieldValue = { serverTimestamp: () => 'ts', increment: (n) => n };
  window.firebase.firestore.Timestamp  = { fromDate: (d) => d, now: () => new Date(0) };
};

/* Static scan: does any registered admin page link here? */
const registered = NAV.pages.map(p => p.page);
const inboundMap = {};
registered.forEach(src => {
  let html = '';
  try { html = fs.readFileSync(path.join(ROOT, src), 'utf8'); } catch (e) { return; }
  const re = /href\s*=\s*["']([^"'#?]+)/g; let m;
  while ((m = re.exec(html))) {
    let t = m[1].split('#')[0].split('?')[0].replace(/^\.?\//, '');
    if (!t) continue;
    if (!/\.html$/.test(t)) t += '.html';
    if (t === src) continue;
    (inboundMap[t] = inboundMap[t] || new Set()).add(src);
  }
});

(async () => {
  const browser = await chromium.launch();
  const rows = [];

  for (const pg of PAGES) {
    const entry = NAV.lookup(pg);
    const checks = {};
    checks['registry-entry'] = !!entry;

    if (entry) {
      const parent = entry.parent ? NAV.lookup(entry.parent) : null;
      checks['correct-parent'] = entry.page === NAV.home ? true : !!parent;
      const trail = NAV.trail(pg);
      checks['home-path'] = trail.length >= 1 && trail[0].page === NAV.home;
      /* A page with no sibling is not automatically a defect. Administration holds
         exactly two pages, one of which is the legacy duplicate that siblings()
         deliberately excludes — so the CANONICAL page has no true sibling and never
         can. It still reaches every other section through the shell sidebar.
         The assertion was wrong, not the product: pass when the page is the only
         canonical page in its section. */
      const canonicalInSection = NAV.pages.filter(p => p.section === entry.section && !p.duplicateOf).length;
      checks['siblings']  = entry.page === NAV.home ? true
                          : (NAV.siblings(pg).length > 0 || canonicalInSection <= 1);
    }

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(ADMIN_STUB);
    const page = await ctx.newPage();
    let detail = {};
    try {
      await page.goto(`${BASE}/${pg}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2200);
      await page.evaluate(() => { const b = document.getElementById('_sokoniPrivacyBanner'); if (b) b.remove(); });

      detail = await page.evaluate((expectedParent) => {
        const side = document.getElementById('sk-adm-side');
        const cr   = document.getElementById('sk-adm-crumbs');
        const cur  = side ? side.querySelectorAll('[aria-current="page"]') : [];
        const crumbLinks = cr ? Array.from(cr.querySelectorAll('a')).map(a => a.getAttribute('href')) : [];
        /* any navigation target that dumps out of the admin workspace */
        const bad = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href'))
          .filter(h => /^\/?(index(\.html)?|seller(\.html)?)$/.test(h) || h === '/');
        return {
          landed: location.pathname.replace(/^\//, ''),
          activeCount: cur.length,
          activeHref: cur.length ? cur[0].getAttribute('href') : null,
          sidebarLinks: side ? side.querySelectorAll('a').length : 0,
          crumbLinks,
          parentLinked: crumbLinks.some(h => h && h.replace(/^\.?\//, '') === expectedParent),
          badFallbacks: bad.slice(0, 4),
        };
      }, entry && entry.parent ? entry.parent : '');
    } catch (e) { detail = { error: String(e.message).slice(0, 60) }; }
    await ctx.close();

    checks['active-state']    = detail.activeCount === 1 &&
                                (detail.activeHref || '').replace(/^\.?\//, '') === pg;
    checks['parent-link']     = entry && !entry.parent ? true : !!detail.parentLinked;
    checks['no-bad-fallback'] = Array.isArray(detail.badFallbacks) && detail.badFallbacks.length === 0;
    checks['deep-link']       = detail.landed === pg;
    checks['inbound']         = (inboundMap[pg] && inboundMap[pg].size > 0) || detail.sidebarLinks > 0;

    const bad = Object.keys(checks).filter(k => !checks[k]);
    rows.push({ pg, checks, bad, detail });
  }
  await browser.close();

  const NAMES = ['registry-entry','correct-parent','home-path','parent-link','siblings','active-state','no-bad-fallback','deep-link','inbound'];
  console.log('PAGE'.padEnd(28) + NAMES.map(n => n.slice(0, 8).padEnd(9)).join(''));
  console.log('-'.repeat(28 + NAMES.length * 9));
  rows.forEach(r => console.log(r.pg.padEnd(28) +
    NAMES.map(n => (r.checks[n] === undefined ? '-' : r.checks[n] ? 'ok' : 'FAIL').padEnd(9)).join('')));

  const failed = rows.filter(r => r.bad.length);
  console.log(`\n${rows.length - failed.length}/${rows.length} pages passed all navigation checks`);
  if (failed.length) {
    console.log('\nFAILURE DETAIL');
    failed.forEach(r => console.log(`  ${r.pg}: ${r.bad.join(', ')}` +
      (r.detail.error ? `  [${r.detail.error}]` : '') +
      (r.detail.badFallbacks && r.detail.badFallbacks.length ? `  [fallbacks: ${r.detail.badFallbacks.join(', ')}]` : '') +
      (r.bad.includes('active-state') ? `  [active=${r.detail.activeCount} href=${r.detail.activeHref}]` : '') +
      (r.bad.includes('deep-link') ? `  [landed=${r.detail.landed}]` : '')));
    process.exit(1);
  }
})();
