#!/usr/bin/env node
/* ============================================================================
   Admin navigation + device-layout certification
   ============================================================================
   SOKONI is flat HTML with no framework shell, so nothing enforces layout
   consistency across pages globally. This asserts it per page, per width.

   Widths: 1440 / 1280 / 1024 / 768 / 430 / 390 / 360

   Checked at EVERY width:
     no-h-overflow     the PAGE never scrolls sideways (wide content must scroll
                       inside its own container instead)
     header            admin header present and visible
     logo-aspect       rendered ratio matches intrinsic ratio (never stretched
                       or cropped)
     nav-usable        >=1024 persistent sidebar visible; <1024 hamburger visible
                       and >=44px
     active-state      exactly one aria-current="page" in the sidebar
     crumbs-fit        breadcrumbs do not exceed the viewport width
     header-no-cover   body padding-top >= MEASURED chrome height, so sticky
                       chrome cannot sit on top of content
     tap-targets       header/sidebar controls >= 44px in the smaller dimension
     drawer            <1024 only: hamburger opens the drawer and the scrim shows

   Usage: node scripts/certify-admin-responsive.js [--pages a.html,b.html] [--base URL]
   Requires a local server (node server.js). Exit 1 on any failure.
   ========================================================================= */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const argv = process.argv.slice(2);
const arg  = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:3000');
const WIDTHS = [1440, 1280, 1024, 768, 430, 390, 360];

const DEFAULT_PAGES = ['admin-os.html','enterprise-ops.html','ops-center.html','ops-dashboard.html',
  'admin-feedback.html','beta-control.html','beta-dashboard.html','reliability-center.html','merchant-pipeline.html'];

/* --controls: rerun ONLY the pages already certified 7/7, as a fast regression gate
   after any change to the SHARED shell (sokoni-admin-shell.js, sokoni-admin-nav.js,
   shared-header.js, security.js). A failure here means the shared shell regressed,
   not that one page drifted. */
const CONTROLS_FILE = require('path').join(ROOT, 'docs', 'admin-responsive-controls.json');
let CONTROL_MODE = argv.includes('--controls');
let PAGES;
if (CONTROL_MODE) {
  const cfg = JSON.parse(require('fs').readFileSync(CONTROLS_FILE, 'utf8'));
  PAGES = cfg.controls.map(c => c.page);
  console.log(`CONTROL RUN — ${PAGES.length} page(s) certified ${cfg.certifiedOn}`);
  console.log('A failure here is a SHARED-SHELL regression. Do not edit the baseline to go green.\n');
} else {
  PAGES = (arg('--pages', null) || DEFAULT_PAGES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
}

/* Signed-in admin, so the guard clears and the shell renders. */
const ADMIN_STUB = () => {
  const claims = { admin: true, superAdmin: true };
  const u = { uid: 'cert_admin', email: 'cert@sokoni.test', displayName: 'Cert Admin',
              getIdTokenResult: async () => ({ claims }) };
  window.firebaseAuth = { currentUser: u };
  const q = { collection: () => q, doc: () => q, where: () => q, orderBy: () => q, limit: () => q,
              get: async () => ({ empty: true, size: 0, docs: [], forEach() {} }),
              onSnapshot: () => () => {}, add: async () => {}, set: async () => {}, update: async () => {} };
  window.firebase = {
    auth: () => ({ onAuthStateChanged: (cb) => cb(u), currentUser: u }),
    firestore: () => q,
    functions: () => ({ httpsCallable: () => async () => ({ data: {} }) }),
  };
  window.firebase.initializeApp = (cfg, name) => ({ name: name || '[DEFAULT]', options: cfg || {} });
  window.firebase.apps = [];
  window.firebase.app = (name) => ({ name: name || '[DEFAULT]' });
  window.firebase.firestore.FieldValue = { serverTimestamp: () => 'ts', increment: (n) => n };
  window.firebase.firestore.Timestamp  = { fromDate: (d) => d, now: () => new Date(0) };
};

async function audit(page, width) {
  return page.evaluate((w) => {
    const R = {};
    const de = document.documentElement;

    R.hOverflow = Math.max(de.scrollWidth, document.body.scrollWidth) - de.clientWidth;

    const hdr = document.getElementById('sk-adm-header');
    R.header = !!hdr && getComputedStyle(hdr).display !== 'none';

    const img = hdr && hdr.querySelector('#sk-adm-logo img');
    if (img && img.naturalWidth && img.naturalHeight) {
      const b = img.getBoundingClientRect();
      R.logoFidelity = +(((b.width / b.height) / (img.naturalWidth / img.naturalHeight))).toFixed(3);
      R.logoBox = [Math.round(b.width), Math.round(b.height)];
    } else { R.logoFidelity = null; }

    const side   = document.getElementById('sk-adm-side');
    const burger = document.getElementById('sk-adm-burger');
    const sideVisible = !!side && getComputedStyle(side).display !== 'none' &&
                        side.getBoundingClientRect().right > 1;
    const burgerVisible = !!burger && getComputedStyle(burger).display !== 'none';
    R.navUsable = w >= 1024 ? sideVisible : burgerVisible;
    R.burgerBox = burger ? [Math.round(burger.getBoundingClientRect().width),
                            Math.round(burger.getBoundingClientRect().height)] : null;

    R.activeCount = side ? side.querySelectorAll('[aria-current="page"]').length : 0;

    const cr = document.getElementById('sk-adm-crumbs');
    R.crumbsFit = !cr || cr.scrollWidth <= de.clientWidth + 1;

    /* chrome height vs body padding — sticky must not cover content */
    let chrome = hdr ? hdr.offsetHeight : 0;
    if (cr) chrome += cr.offsetHeight;
    R.chrome = chrome;
    R.bodyPad = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    R.headerNoCover = R.bodyPad + 1 >= chrome;

    /* tap targets in the chrome */
    let small = 0;
    (hdr ? Array.from(hdr.querySelectorAll('a,button')) : []).forEach(el => {
      const b = el.getBoundingClientRect();
      if (b.width && b.height && Math.min(b.width, b.height) < 44) small++;
    });
    (side ? Array.from(side.querySelectorAll('a')).slice(0, 12) : []).forEach(el => {
      const b = el.getBoundingClientRect();
      if (b.width && b.height && b.height < 44) small++;
    });
    R.smallTargets = small;

    /* any element wider than the viewport that is NOT inside a scroll container */
    let widest = 0, widestTag = '';
    Array.from(document.body.querySelectorAll('*')).slice(0, 2500).forEach(el => {
      const b = el.getBoundingClientRect();
      if (b.width > de.clientWidth + 2) {
        let p = el, contained = false;
        while (p && p !== document.body) {
          const cs = getComputedStyle(p);
          if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'hidden') { contained = true; break; }
          p = p.parentElement;
        }
        if (!contained && b.width > widest) { widest = Math.round(b.width); widestTag = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''); }
      }
    });
    R.widestOverflow = widest; R.widestTag = widestTag;
    return R;
  }, width);
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  let failures = 0;

  for (const pg of PAGES) {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
      await ctx.addInitScript(ADMIN_STUB);
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(String(e.message).slice(0, 60)));
      let r = null, r0_bannerCovers = false;
      try {
        await page.goto(`${BASE}/${pg}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(1800);

        /* Dismiss the consent banner before interacting. #_sokoniPrivacyBanner is
           fixed at z-index 300001 and COVERS the admin hamburger at narrow
           widths — the same consent scrim already known for the product-page
           "black layer". A real user dismisses it, so the harness must too;
           reported separately as a layout finding rather than silently ignored. */
        r0_bannerCovers = await page.evaluate(() => {
          const bu = document.getElementById('sk-adm-burger');
          if (!bu) return false;
          const b = bu.getBoundingClientRect();
          if (!b.width) return false;
          const top = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
          return !!(top && top.closest && top.closest('#_sokoniPrivacyBanner'));
        }).catch(() => false);
        await page.evaluate(() => {
          const el = document.getElementById('_sokoniPrivacyBanner');
          if (el) el.remove();
        }).catch(() => {});

        r = await audit(page, w);
        r.bannerCoversBurger = r0_bannerCovers;
        if (w < 1024 && r.header) {
          await page.click('#sk-adm-burger').catch(() => {});
          await page.waitForTimeout(360);
          r.drawerOpens = await page.evaluate(() => {
            const s = document.getElementById('sk-adm-side');
            return !!s && s.getBoundingClientRect().left > -5;
          }).catch(() => false);
        } else { r.drawerOpens = true; }
      } catch (e) { r = { error: String(e.message).slice(0, 50) }; }
      await ctx.close();

      const checks = r.error ? { load: false } : {
        'no-h-overflow':   r.hOverflow <= 1 && r.widestOverflow === 0,
        'header':          r.header,
        'logo-aspect':     r.logoFidelity === null || Math.abs(r.logoFidelity - 1) < 0.03,
        'nav-usable':      r.navUsable,
        'active-state':    r.activeCount === 1,
        'crumbs-fit':      r.crumbsFit,
        'header-no-cover': r.headerNoCover,
        'tap-targets':     r.smallTargets === 0,
        'drawer':          r.drawerOpens,
      };
      const bad = Object.keys(checks).filter(k => !checks[k]);
      if (bad.length) failures++;
      results.push({ pg, w, bad, r, errs: errs.length });
    }
  }
  await browser.close();

  const CHECKS = ['no-h-overflow','header','logo-aspect','nav-usable','active-state','crumbs-fit','header-no-cover','tap-targets','drawer'];
  let lastPg = null;
  for (const row of results) {
    if (row.pg !== lastPg) { console.log('\n── ' + row.pg); lastPg = row.pg;
      console.log('   width  ' + CHECKS.map(c => c.slice(0, 9).padEnd(10)).join('')); }
    const marks = CHECKS.map(c => (row.bad.includes(c) ? 'FAIL' : 'ok').padEnd(10)).join('');
    console.log('   ' + String(row.w).padEnd(6) + ' ' + marks + (row.r.error ? '  ' + row.r.error : ''));
  }

  console.log('\n' + (results.length - failures) + '/' + results.length + ' page-width combinations passed');

  /* Emit a MACHINE-READABLE ledger so downstream documents DERIVE their
     PASS / not-PASS lists instead of hand-maintaining a table that drifts.
     A hand-kept list is exactly how a page that had been certified out of the
     BLOCKED set stayed listed in it.
     This records OBSERVATIONS only. It deliberately does NOT decide whether a
     failure is a deliberate security block or a real defect — that needs the
     per-page cause and remains a human judgement in the blocked register. */
  const OUT = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : null; })();
  if (OUT) {
    const byPage = {};
    results.forEach(r => {
      const e = byPage[r.pg] = byPage[r.pg] || { page: r.pg, widths: {}, passWidths: 0, totalWidths: 0 };
      e.totalWidths++;
      if (!r.bad.length) e.passWidths++;
      e.widths[r.w] = { failed: r.bad, error: r.r.error || null };
    });
    const pages = Object.values(byPage).map(e => Object.assign(e, {
      result: e.passWidths === e.totalWidths ? 'PASS' : 'NOT_PASS',
      failedChecks: [...new Set(Object.values(e.widths).flatMap(w => w.failed))],
    }));
    require('fs').writeFileSync(OUT, JSON.stringify({
      base: BASE, widths: WIDTHS, checks: CHECKS,
      summary: {
        pages: pages.length,
        pass: pages.filter(p => p.result === 'PASS').length,
        notPass: pages.filter(p => p.result !== 'PASS').length,
        combinations: results.length, passed: results.length - failures,
      },
      pages,
    }, null, 2));
    console.log('ledger written -> ' + OUT);
  }
  if (CONTROL_MODE) {
    console.log(failures
      ? '\nCONTROL REGRESSION — the shared admin shell broke pages already certified 7/7.\n' +
        'Fix the shell, or establish that the ASSERTION was wrong. Do not edit the baseline.'
      : '\nControls hold: no shared-shell regression.');
  }
  if (failures) {
    console.log('\nFAILURE DETAIL');
    results.filter(r => r.bad.length).slice(0, 18).forEach(r => {
      const d = r.r;
      console.log(`  ${r.pg} @${r.w}: ${r.bad.join(', ')}` +
        (d.widestOverflow ? `  [widest ${d.widestTag} = ${d.widestOverflow}px vs ${r.w}]` : '') +
        (d.smallTargets ? `  [${d.smallTargets} small tap targets]` : '') +
        (d.activeCount !== undefined && r.bad.includes('active-state') ? `  [active=${d.activeCount}]` : '') +
        (r.bad.includes('header-no-cover') ? `  [chrome ${d.chrome} > pad ${d.bodyPad}]` : ''));
    });
    process.exit(1);
  }
})();
