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
const { Gate } = require('./lib/gate-result');

const PORT = Number(process.env.PROBE_PORT || 8134);

/* Against localhost App Check refuses every Firestore read, so the live pass
   can only ever report BLOCKED. Point BASE at the deployed origin — which IS
   App Check-registered — and the same assertions become observable, turning
   the live gate into real production evidence.
     PROBE_BASE=https://mysokoni.co.ke node scripts/probe-provider-directory.js */
const BASE = (process.env.PROBE_BASE || '').replace(/\/+$/, '');
const ORIGIN = BASE || ('http://localhost:' + PORT);
const AGAINST_PROD = !!BASE;
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

/* ── App Check debug token ───────────────────────────────────────────────────
   Headless Chromium cannot pass reCAPTCHA v3, so the App Check exchange 403s
   and the SDK throttles for 24 hours — meaning the live read is unobservable
   from an automated browser on ANY origin, production included. The page
   handles it correctly ("Could not load providers … not an empty category"),
   but correct error handling is not evidence that the success path works.

   Firebase's supported escape hatch is a debug token: set
   self.FIREBASE_APPCHECK_DEBUG_TOKEN before the SDK initialises and reCAPTCHA
   is skipped entirely. Minting one via the admin API and injecting it turns
   the live gate into genuine end-to-end evidence — real origin, real page,
   real Firestore read.

   The token is deleted afterwards on every exit path. A debug token left
   registered is a standing App Check bypass for anyone who learns it. */
const AC_DEBUG = process.env.PROBE_APPCHECK_DEBUG === '1';
const DEBUG_TOKEN = '77777777-6666-4555-8444-333333333333';
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const APP_ID = process.env.FIREBASE_APP_ID || '1:24799054989:web:e1cf6ca8c281bf1abf26c4';

function adminHeaders() {
  const { execSync } = require('child_process');
  const env = Object.assign({}, process.env);
  if (!env.CLOUDSDK_PYTHON && process.env.LOCALAPPDATA) {
    env.CLOUDSDK_PYTHON = process.env.LOCALAPPDATA +
      '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe';
  }
  const tok = execSync('gcloud auth print-access-token',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  return { Authorization: 'Bearer ' + tok, 'x-goog-user-project': PROJECT };
}

function acReq(method, apiPath, body, headers) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ host: 'firebaseappcheck.googleapis.com', path: apiPath, method, headers: h },
      res => { let o = ''; res.on('data', c => o += c); res.on('end', () => resolve({ status: res.statusCode, body: o })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function mintDebugToken() {
  const h = adminHeaders();
  const r = await acReq('POST',
    '/v1/projects/' + PROJECT + '/apps/' + encodeURIComponent(APP_ID) + '/debugTokens',
    { displayName: 'tmp-directory-probe', token: DEBUG_TOKEN }, h);
  if (r.status >= 400) return { error: 'debugTokens.create HTTP ' + r.status + ' ' + r.body.slice(0, 160) };
  const name = JSON.parse(r.body).name;
  return { name, cleanup: () => acReq('DELETE', '/v1/' + name, null, adminHeaders()) };
}

async function injectStub(page) {
  await page.addInitScript(function (records) {
    /* Intercept the assignment rather than polling for it.

       A 25ms poll lost a race on the homepage: firebase.js sets
       window.firebaseDB quickly, the page's own boot sees both globals and
       calls the REAL list() — which App Check denies — before the swap lands.
       The section then stays hidden and the probe reports "nothing rendered",
       a probe defect indistinguishable from a product defect. Defining a
       setter guarantees the wrap happens at the instant the module publishes
       itself, with no window in between. */
    var _sp;
    Object.defineProperty(window, 'SokoniProviders', {
      configurable: true,
      get: function () { return _sp; },
      set: function (v) { _sp = v; if (v) patch(v); },
    });
    function patch(SP) {
      window.firebaseDB = window.firebaseDB || { __stub: true };
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
    }
  }, INJECT);
}

(async () => {
  await new Promise(res => srv.listen(PORT, res));

  /* Mint the App Check debug token before any page loads, so the very first
     navigation already carries a valid attestation. */
  let acDebug = null;
  if (AC_DEBUG) {
    acDebug = await mintDebugToken();
    if (acDebug.error) { console.log("  App Check debug token unavailable: " + acDebug.error); acDebug = null; }
    else console.log("  App Check debug token registered (deleted on exit)");
  }

  const browser = await chromium.launch();

  /* Two gates, because the two passes are different classes of evidence and
     averaging them would overstate what is known. The live pass talks to the
     real project; the injected pass proves rendering against fixtures and is
     NOT production evidence, so it never claims to be. */
  const live = new Gate({
    name: 'provider-directory-live',
    evidence: AGAINST_PROD ? 'production-probe' : 'browser-run',
    environment: AGAINST_PROD ? 'production' : 'local',
  });
  const render = new Gate({
    name: 'provider-directory-render',
    evidence: 'browser-run', environment: 'local', confidence: 'medium',
  });
  render.note('Fixtures are the real production records, injected client-side. ' +
              'This proves the render path, not the Firestore read.');
  let failures = 0;

  for (const spec of PAGES) {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
    if (acDebug) await page.addInitScript(t => { self.FIREBASE_APPCHECK_DEBUG_TOKEN = t; }, DEBUG_TOKEN);

    await page.goto(ORIGIN + spec.url, { waitUntil: 'domcontentloaded' });

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

    /* Deleted demo data reappearing is observable regardless of connectivity —
       it is baked into the page — so this stays a real PASS/FAIL. */
    if (leaked.length) live.fail(spec.url + ': no demo data rendered', leaked.join(', '));
    else               live.pass(spec.url + ': no demo data rendered');

    if (found.length) {
      live.pass(spec.url + ': real providers rendered', found.join(', '));
    } else if (isErrState) {
      /* The page correctly reported that it could not load. That is the page
         behaving well AND the observation being impossible — the assertion
         about real data is BLOCKED, not failed. Conflating the two is what
         made the earlier run print FAIL for something never tested. */
      live.pass(spec.url + ': failed read is reported honestly');
      live.blocked(spec.url + ': real providers rendered',
        (AGAINST_PROD ? 'Firestore read did not resolve' : 'Firestore read blocked (App Check refuses localhost)') + ' — not observed');
    } else if (spec.expectReal) {
      live.fail(spec.url + ': real providers rendered',
        'neither providers nor an error state were shown');
    } else {
      live.pass(spec.url + ': section correctly hidden when empty');
    }
    await ctx.close();
  }

  /* Public profile page for a known provider. */
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const perr = [];
  page.on('pageerror', e => perr.push(String(e.message).slice(0, 160)));
  if (acDebug) await page.addInitScript(t => { self.FIREBASE_APPCHECK_DEBUG_TOKEN = t; }, DEBUG_TOKEN);
  await page.goto(ORIGIN + '/provider-profile.html?uid=H7p6ktBHogM5GcBy6mz8negKVbG2',
    { waitUntil: 'domcontentloaded' });
  let body = '';
  /* Must exceed sokoni-providers.js READ_TIMEOUT_MS (8s) plus module boot,
     or the probe samples the skeleton and reports "nothing shown" for a page
     that was about to render its error state correctly. */
  /* Wait for a DECISIVE signal, not merely for the body to be non-empty. The
     nav and the cookie banner alone clear 40 characters before the read has
     resolved, so a length test broke out on the very first sample and reported
     "neither the provider nor an error was shown" for a page that renders its
     error state correctly three seconds later. Only the provider's name or the
     error string settles the question. */
  for (let i = 0; i < 100; i++) {
    body = await page.evaluate(() => document.body.innerText);
    if (/Ann|Could not load this profile|Provider not available|No provider selected/i.test(body)) break;
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
  if (body.includes('Ann')) {
    live.pass('provider-profile: renders the provider');
  } else if (honestErr) {
    live.pass('provider-profile: failed read is reported honestly');
    live.blocked('provider-profile: renders the provider',
      'Firestore read blocked (App Check refuses localhost) — not observed');
  } else {
    live.fail('provider-profile: renders the provider',
      'neither the provider nor an error was shown');
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
    await p2.goto(ORIGIN + spec.url, { waitUntil: 'domcontentloaded' });

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
    if (found.length) render.pass(spec.url + ': real records render', found.join(', '));
    else               render.fail(spec.url + ': real records render', 'nothing rendered');
    if (leaked.length) render.fail(spec.url + ': no demo data', leaked.join(', '));
    else               render.pass(spec.url + ': no demo data');
    if (fakeStars)     render.fail(spec.url + ': no stars on an unrated provider');
    else               render.pass(spec.url + ': no stars on an unrated provider');
    await c2.close();
  }

  /* Public profile, injected. */
  const c3 = await browser.newContext();
  const p3 = await c3.newPage();
  const e3 = [];
  p3.on('pageerror', e => e3.push(String(e.message).slice(0, 140)));
  await injectStub(p3);
  await p3.goto(ORIGIN + '/provider-profile.html?uid=H7p6ktBHogM5GcBy6mz8negKVbG2',
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
  if (b3.includes('Ann')) render.pass('provider-profile: renders the provider');
  else                    render.fail('provider-profile: renders the provider');
  if (/★★★★★/.test(b3)) render.fail('provider-profile: no stars on an unrated provider');
  else                    render.pass('provider-profile: no stars on an unrated provider');
  await c3.close();

  await browser.close();
  srv.close();

  if (acDebug && acDebug.cleanup) {
    const d = await acDebug.cleanup();
    console.log('\n  App Check debug token ' +
      (d.status < 400 ? 'deleted' : '** NOT DELETED (HTTP ' + d.status + ') — REVOKE MANUALLY **'));
  }

  const liveCode   = live.finish();
  const renderCode = render.finish();
  /* Worst outcome wins: any FAIL(1) beats any BLOCKED(2) beats PASS(0). */
  process.exit((liveCode === 1 || renderCode === 1) ? 1
             : (liveCode === 2 || renderCode === 2) ? 2 : 0);
})().catch(e => { console.error('probe failed: ' + e.message); srv.close(); process.exit(1); });
