'use strict';
/**
 * scripts/probe-provider-directory.js
 *
 * Verifies that the provider directory pages render the REAL registry and no
 * longer render the deleted demo arrays.
 *
 *   node scripts/probe-provider-directory.js
 *
 * What it asserts per page, and why each assertion is here rather than a
 * screenshot glance:
 *
 *   • a known real provider's name appears           — the read worked
 *   • no known demo name appears                     — the arrays are really gone,
 *                                                      not merely unreferenced
 *   • no "0★" / "5.0★" on an unrated provider        — invented ratings stayed out
 *   • page-level JS errors are collected             — a thrown handler renders an
 *                                                      empty grid that looks like
 *                                                      "no providers", the exact
 *                                                      failure this work removes
 *
 * The pages read Firestore directly from the browser, so this needs network
 * access to the live project. If App Check or rules reject the read, the probe
 * reports THAT rather than passing on an empty page — an empty grid is not
 * evidence of a working empty state.
 */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = Number(process.env.PROBE_PORT || 8134);
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                '.ico': 'image/x-icon', '.json': 'application/json', '.png': 'image/png',
                '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  /* path.resolve + prefix check: a probe server must not serve outside the repo. */
  const root = path.resolve('.');
  let fp = path.resolve(root, '.' + p);
  if (!fp.startsWith(root)) { r.writeHead(403); return r.end('no'); }
  if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); return r.end('not found'); }
    r.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'text/plain' });
    r.end(d);
  });
});

/* Real records currently in the registry. */
const REAL = ['Ann', 'King Bruce'];
/* A sample of the names that were hardcoded in the deleted arrays. */
const DEMO = ['Mama Jane Laundry', 'Mary Njeri Mamafua', 'CleanMasters Kenya',
              'Dr. Amina Hassan', 'Benson Plumbing', 'Glam By Ciku',
              'ShineClean Services', 'PestFree Kenya', 'Joyce Wanjiru Beauty'];

const PAGES = [
  { url: '/providers.html',  grid: '#pvGrid',                expectReal: true },
  { url: '/cleaning.html',   grid: '#clProviderGrid',        expectReal: true },
  { url: '/services.html',   grid: '#providersGrid',         expectReal: true },
  /* The homepage strip hides itself when it has nothing trustworthy to show —
     a marketing surface must not display an outage banner — so on a blocked
     read "empty and hidden" IS the correct outcome, not a failure. */
  { url: '/index.html',      grid: '#featuredProvidersGrid', expectReal: false },
];

/* ── Injected-render pass ────────────────────────────────────────────────────
   App Check refuses browser reads from localhost, so the live pass above can
   only prove two of the three things that matter: that no demo data survives,
   and that a blocked read is reported as a blocked read.

   It cannot prove the pages render real providers correctly. This pass does,
   by replacing SokoniProviders.list/get with the ACTUAL production records —
   the ones scripts/audit-provider-onboarding.js reads over REST — before the
   page boots. The read path is verified separately over REST; this verifies
   the render path, which is the part App Check hides. */
const INJECT = [
  {
    uid: 'H7p6ktBHogM5GcBy6mz8negKVbG2', id: 'H7p6ktBHogM5GcBy6mz8negKVbG2',
    providerId: 'PRV-H7P6KTBH', name: 'Ann', businessName: "Langa'ta mamafua",
    category: 'laundry', categories: ['laundry', 'cleaning'],
    categoryLabel: 'Mama Fua', emoji: '🧺', serviceType: 'Laundry & Cleaning',
    description: 'Cleaning services,houses, carpets,',
    location: "Langa'ta canivor, Nairobi", city: 'Nairobi', phone: '0748346783',
    skills: ['Mama Fua', 'Laundry', 'Cleaning', 'Washing', 'House Cleaning'],
    rating: null, reviewCount: 0, jobsCompleted: 0, rate: null, rateType: '',
    photo: '', verified: true, featured: true, available: true,
    acceptsBookings: true, chatEnabled: true,
    profileUrl: 'provider-profile.html?uid=H7p6ktBHogM5GcBy6mz8negKVbG2',
    profilePending: ['photo', 'kycDocuments', 'exactLocation', 'bio', 'pricing', 'workingHours', 'serviceRadius'],
  },
  {
    uid: 'aOdQxmUGLCO4hOYsdHMhWuwYV9D2', id: 'aOdQxmUGLCO4hOYsdHMhWuwYV9D2',
    providerId: 'PRV-AODQXMUG', name: 'King Bruce', businessName: 'King Bruce',
    category: 'mc', categories: ['mc', 'entertainment'],
    categoryLabel: 'Entertainment', emoji: '🎤', serviceType: 'Artist / MC',
    description: '', location: '', city: '', phone: '',
    skills: ['MC', 'Artist', 'Live Performance', 'Events'],
    rating: null, reviewCount: 0, jobsCompleted: 0, rate: null, rateType: '',
    photo: '', verified: false, featured: false, available: true,
    acceptsBookings: true, chatEnabled: true,
    profileUrl: 'provider-profile.html?uid=aOdQxmUGLCO4hOYsdHMhWuwYV9D2',
    profilePending: [],
  },
];

async function injectStub(page) {
  await page.addInitScript(function (records) {
    /* Poll for the real module, then swap its two read methods. Everything
       else — normalize, esc, emptyStateHtml, the category buckets — stays as
       shipped, so this exercises the real filtering and rendering code. */
    var iv = setInterval(function () {
      if (!window.SokoniProviders) return;
      clearInterval(iv);
      window.firebaseDB = window.firebaseDB || { __stub: true };
      var SP = window.SokoniProviders;
      SP.list = function (opts) {
        opts = opts || {};
        var out = records.slice();
        if (opts.category && opts.category !== 'all') {
          var aliases = { cleaning: ['cleaning', 'laundry', 'housekeeping'],
                          laundry: ['laundry', 'mamafua', 'cleaning'] };
          var want = aliases[opts.category] || [opts.category];
          out = out.filter(function (p) {
            return [p.category].concat(p.categories).some(function (c) {
              return want.indexOf(String(c).toLowerCase()) !== -1;
            });
          });
        }
        if (opts.featuredOnly) out = out.filter(function (p) { return p.featured; });
        if (opts.limit) out = out.slice(0, opts.limit);
        return Promise.resolve({ providers: out, error: null });
      };
      SP.get = function (uid) {
        var hit = records.filter(function (p) { return p.uid === uid; })[0] || null;
        return Promise.resolve({ provider: hit, error: null });
      };
    }, 25);
  }, INJECT);
}

(async () => {
  await new Promise(res => srv.listen(PORT, res));
  const browser = await chromium.launch();
  let failures = 0;

  for (const spec of PAGES) {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

    await page.goto('http://localhost:' + PORT + spec.url, { waitUntil: 'domcontentloaded' });

    /* Wait for the grid to stop saying "loading", up to 15s. Asserting
       immediately would test the skeleton, not the data. */
    let text = '';
    for (let i = 0; i < 60; i++) {
      text = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? el.textContent : '__NO_GRID__';
      }, spec.grid);
      if (text !== '__NO_GRID__' && text && !/Loading/i.test(text)) break;
      await page.waitForTimeout(250);
    }

    const found   = REAL.filter(n => text.includes(n));
    const leaked  = DEMO.filter(n => text.includes(n));
    const isErrState = /Could not load providers/i.test(text);

    console.log('\n  ' + spec.url);
    console.log('    grid          : ' + (text === '__NO_GRID__' ? 'MISSING' : text.trim().length + ' chars'));
    console.log('    real found    : ' + (found.length ? found.join(', ') : 'none'));
    console.log('    demo leaked   : ' + (leaked.length ? leaked.join(', ') : 'none'));
    if (isErrState) console.log('    state         : read FAILED (page reported it honestly)');
    if (errors.length) console.log('    js errors     : ' + errors.slice(0, 3).join(' | '));

    if (leaked.length) { failures++; console.log('    ** FAIL: demo data still rendering'); }
    if (spec.expectReal && !found.length && !isErrState) {
      failures++; console.log('    ** FAIL: no real provider rendered and no error reported');
    }
    await ctx.close();
  }

  /* Public profile page for a known provider. */
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const perr = [];
  page.on('pageerror', e => perr.push(String(e.message).slice(0, 160)));
  await page.goto('http://localhost:' + PORT + '/provider-profile.html?uid=H7p6ktBHogM5GcBy6mz8negKVbG2',
    { waitUntil: 'domcontentloaded' });
  let body = '';
  for (let i = 0; i < 60; i++) {
    body = await page.evaluate(() => document.body.innerText);
    if (!/Loading|^\s*$/.test(body) && body.length > 40) break;
    await page.waitForTimeout(250);
  }
  const title = await page.title();
  console.log('\n  /provider-profile.html?uid=H7p6ktBHog…');
  console.log('    title         : ' + title);
  console.log('    shows name    : ' + (body.includes('Ann') ? 'yes' : 'NO'));
  console.log('    shows category: ' + (/Mama Fua/i.test(body) ? 'yes' : 'NO'));
  console.log('    invented data : ' + (/0\.0★|★★★★★/.test(body) ? '** STARS ON UNRATED **' : 'none'));
  if (perr.length) console.log('    js errors     : ' + perr.slice(0, 3).join(' | '));
  /* Reporting "Could not load this profile" when the read is blocked is the
     correct outcome, and is what must NOT be conflated with "no such
     provider". Only silence — neither the provider nor an explanation — is a
     failure here. The injected pass below proves the render path itself. */
  const honestErr = /Could not load this profile/i.test(body);
  if (honestErr) console.log('    state         : read FAILED (page reported it honestly)');
  if (!body.includes('Ann') && !honestErr) {
    failures++; console.log('    ** FAIL: neither the provider nor an error was shown');
  }

  await ctx.close();

  /* ── PASS B: render path, with the real records injected ─────────────────── */
  console.log('\n  ── injected-render pass (real records, App Check bypassed) ──');
  for (const spec of PAGES) {
    const c2 = await browser.newContext();
    const p2 = await c2.newPage();
    const errs = [];
    p2.on('pageerror', e => errs.push(String(e.message).slice(0, 140)));
    await injectStub(p2);
    await p2.goto('http://localhost:' + PORT + spec.url, { waitUntil: 'domcontentloaded' });

    let text = '', html = '';
    for (let i = 0; i < 60; i++) {
      const got = await p2.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? { t: el.textContent, h: el.innerHTML } : { t: '__NO_GRID__', h: '' };
      }, spec.grid);
      text = got.t; html = got.h;
      if (text !== '__NO_GRID__' && text && !/Loading/i.test(text) && text.trim()) break;
      await p2.waitForTimeout(250);
    }

    const found  = REAL.filter(n => text.includes(n));
    const leaked = DEMO.filter(n => text.includes(n));
    /* An unrated provider must not be painted with stars. */
    const fakeStars = /★★★★★/.test(text) || /\b0\.0★|\b0★/.test(text);
    const linksOk = !html || html.includes('provider-profile.html?uid=');

    console.log('\n  ' + spec.url);
    console.log('    real rendered : ' + (found.length ? found.join(', ') : 'none'));
    console.log('    demo leaked   : ' + (leaked.length ? leaked.join(', ') : 'none'));
    console.log('    invented stars: ' + (fakeStars ? '** YES **' : 'none'));
    console.log('    profile links : ' + (linksOk ? 'provider-profile.html?uid=' : '** MISSING **'));
    if (errs.length) console.log('    js errors     : ' + errs.slice(0, 2).join(' | '));
    if (!found.length) { failures++; console.log('    ** FAIL: real records did not render'); }
    if (leaked.length) { failures++; console.log('    ** FAIL: demo data rendered'); }
    if (fakeStars)     { failures++; console.log('    ** FAIL: stars on an unrated provider'); }
    await c2.close();
  }

  /* Public profile, injected. */
  const c3 = await browser.newContext();
  const p3 = await c3.newPage();
  const e3 = [];
  p3.on('pageerror', e => e3.push(String(e.message).slice(0, 140)));
  await injectStub(p3);
  await p3.goto('http://localhost:' + PORT + '/provider-profile.html?uid=H7p6ktBHogM5GcBy6mz8negKVbG2',
    { waitUntil: 'domcontentloaded' });
  let b3 = '';
  for (let i = 0; i < 60; i++) {
    b3 = await p3.evaluate(() => document.body.innerText);
    if (b3.includes('Ann') || /Could not load|not available/.test(b3)) break;
    await p3.waitForTimeout(250);
  }
  console.log('\n  /provider-profile.html?uid=H7p6ktBHog…  (injected)');
  console.log('    name          : ' + (b3.includes('Ann') ? 'Ann' : 'NOT RENDERED'));
  console.log('    category      : ' + (/Mama Fua/i.test(b3) ? 'Mama Fua' : 'MISSING'));
  console.log('    verified badge: ' + (/Verified/i.test(b3) ? 'shown' : 'MISSING'));
  console.log('    unrated shown : ' + (/New on SOKONI/i.test(b3) ? '"New on SOKONI" (correct)' : 'check'));
  console.log('    pending fields: ' + (/has not added a description|not published yet/i.test(b3) ? 'prompted, not invented' : 'none shown'));
  console.log('    invented stars: ' + (/★★★★★/.test(b3) ? '** YES **' : 'none'));
  if (e3.length) console.log('    js errors     : ' + e3.slice(0, 2).join(' | '));
  if (!b3.includes('Ann')) { failures++; console.log('    ** FAIL: profile did not render'); }
  if (/★★★★★/.test(b3))  { failures++; console.log('    ** FAIL: stars on an unrated provider'); }
  await c3.close();

  await browser.close();
  srv.close();

  console.log('\n  ' + (failures ? failures + ' FAILURE(S)' : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('probe failed: ' + e.message); srv.close(); process.exit(1); });
