#!/usr/bin/env node
/**
 * release-gate.js — PHASE 6. Deployment must fail if any gate below fails.
 *
 * Composes the infrastructure gate (scripts/verify-domain-cutover.js, Phases 1 & 2)
 * with render-level checks that can only be answered by loading the real site in a
 * real browser: build identity, root route, premium layout, asset checksums, service
 * worker install/activate, app-shell completeness, placeholders, console errors.
 *
 *   node scripts/release-gate.js                  # against mysokoni.co.ke
 *   node scripts/release-gate.js --origin https://sokoni-aeb26.web.app
 *   node scripts/release-gate.js --skip-dns       # render checks only
 *
 * Exit 0 = every gate passed. Exit 1 = STOP, do not deploy.
 *
 * DNS NOTE: this machine's resolver has been observed returning the legacy origin
 * (217.20.124.84) while every public resolver returns Firebase. Browser checks pin DNS
 * to the Firebase address so the gate measures the intended origin rather than whatever
 * the local resolver happens to have cached. The legacy origin is still audited
 * separately by verify-domain-cutover.js — pinning here does not hide it.
 */
'use strict';
const cp = require('child_process');
const path = require('path');
const https = require('https');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ORIGIN = arg('--origin', 'https://mysokoni.co.ke');
const FIREBASE_IP = arg('--ip', '199.36.158.100');
const SKIP_DNS = argv.includes('--skip-dns');

const HOST = new URL(ORIGIN).host;
let fail = 0, warn = 0;
const PASS = (m) => console.log('  PASS       ' + m);
const FAIL = (m) => { console.log('  FAIL       ' + m); fail++; };
const UNV = (m) => { console.log('  UNVERIFIED ' + m); warn++; };
const INFO = (m) => console.log('             ' + m);

function get(url, pin) {
  return new Promise((res) => {
    const u = new URL(url);
    const opts = { host: pin || u.hostname, servername: u.hostname, path: u.pathname + u.search,
      method: 'GET', timeout: 25000, headers: { Host: u.host, 'User-Agent': 'SOKONI-release-gate' } };
    const req = https.request(opts, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
    });
    req.on('error', (e) => res({ err: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); res({ err: 'timeout' }); });
    req.end();
  });
}

(async () => {
  console.log('\n  SOKONI RELEASE GATE — ' + ORIGIN + '\n');

  /* ── GATE 1: infrastructure (Phases 1 & 2) ── */
  if (!SKIP_DNS) {
    console.log('  [1] Infrastructure — single origin, DNS, TLS, IPv6');
    try {
      cp.execSync('node ' + JSON.stringify(path.join(__dirname, 'verify-domain-cutover.js')),
        { stdio: 'pipe', encoding: 'utf8' });
      PASS('verify-domain-cutover.js passed (single origin, no legacy host)');
    } catch (e) {
      const out = (e.stdout || '') + (e.stderr || '');
      FAIL('verify-domain-cutover.js FAILED — see below');
      out.split('\n').filter(l => /FAIL|UNVERIFIED|STILL SERVING/.test(l))
        .slice(0, 8).forEach(l => INFO(l.trim()));
    }
  } else INFO('[1] infrastructure gate skipped (--skip-dns)');

  /* ── GATE 2: build identity ── */
  console.log('\n  [2] Build identity');
  const ver = await get(ORIGIN + '/version.json', FIREBASE_IP);
  let build = null;
  if (ver.err || ver.status !== 200) {
    FAIL('/version.json unavailable (' + (ver.err || 'HTTP ' + ver.status) + ')');
  } else {
    try {
      build = JSON.parse(ver.body);
      PASS('build ' + build.commitShort + '  ' + build.buildTime + '  cache=' + build.cacheVersion);
      if (build.dirtyWorkingTree) FAIL('build was produced from a DIRTY working tree — it matches no commit');
      const cc = (ver.headers['cache-control'] || '');
      (/no-store|no-cache/.test(cc) ? PASS : FAIL)('version.json Cache-Control: ' + (cc || '(none)'));
    } catch (e) { FAIL('/version.json is not valid JSON'); }
  }

  /* ── GATE 3: root route + premium layout + checksums ── */
  console.log('\n  [3] Root route, layout and asset integrity');
  const root = await get(ORIGIN + '/', FIREBASE_IP);
  if (root.err || root.status !== 200) {
    FAIL('GET / returned ' + (root.err || root.status));
  } else {
    PASS('GET / -> HTTP 200  (' + root.body.length + ' bytes)');
    const tmpl = (root.body.match(/name="sokoni-page"\s+content="([^"]+)"/) || [, ''])[1];
    (tmpl === 'marketplace-home' ? PASS : FAIL)('root template = ' + (tmpl || '(none)') +
      (tmpl === 'marketplace-home' ? '' : '  — root must render the marketplace home'));
    (/href="index\.html"/.test(root.body) ? FAIL : PASS)('no relative Home links in root HTML');
    /* Look for RENDERED placeholder text, not the string anywhere in the source.
       index.html:2955 has <img id="quickViewImage" alt="Product Image"> — a correct
       accessibility attribute, not a placeholder. Flagging it was a gate defect: a check
       that cries wolf gets ignored, which is worse than not having it. The browser gate
       in [4] already inspects rendered innerText, which is the real signal. */
    const visiblePlaceholder = /(>\s*Product Image\s*<)|(placeholder["'>][^<]*Product Image)/i.test(root.body);
    (visiblePlaceholder ? FAIL : PASS)('no rendered "Product Image" placeholder in root HTML');
    const sw = await get(ORIGIN + '/service-worker.js', FIREBASE_IP);
    if (sw.status === 200) {
      const cv = (sw.body.match(/CACHE_VERSION\s*=\s*["']([^"']+)["']/) || [, ''])[1];
      if (build && cv !== build.cacheVersion) {
        FAIL('SW cacheVersion "' + cv + '" != version.json "' + build.cacheVersion + '"');
      } else PASS('service-worker.js cacheVersion = ' + cv);
      const shell = (sw.body.match(/const APP_SHELL\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1];
      const n = (shell.match(/["'][^"']+["']/g) || []).length;
      (n > 0 && n <= 15 ? PASS : FAIL)('APP_SHELL has ' + n + ' entries (limit 15)');
      /* Every shell asset must be reachable, or install rejects for every client. */
      const urls = (shell.match(/["']([^"']+)["']/g) || []).map(s => s.slice(1, -1));
      let broken = 0;
      for (const u of urls) {
        const r = await get(ORIGIN + u, FIREBASE_IP);
        if (r.err || r.status !== 200) { broken++; FAIL('shell asset ' + u + ' -> ' + (r.err || r.status)); }
      }
      if (!broken && urls.length) PASS('all ' + urls.length + ' app-shell assets return 200');
    } else FAIL('service-worker.js unavailable (HTTP ' + sw.status + ')');
  }

  /* ── GATE 4: real browser — SW install/activate, CSS, console ── */
  console.log('\n  [4] Browser render — service worker, CSS, console');
  let chromium = null;
  try { ({ chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'))); }
  catch (e) { UNV('playwright unavailable — browser gates cannot run here'); }

  if (chromium) {
    const b = await chromium.launch({
      args: ['--host-resolver-rules=MAP ' + HOST + ' ' + FIREBASE_IP + ', MAP www.' + HOST + ' ' + FIREBASE_IP],
    });
    const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    const errs = [];
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); });
    p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message.slice(0, 140)));

    await p.goto(ORIGIN + '/', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(10000);

    const r1 = await p.evaluate(() => ({
      sheets: document.styleSheets.length,
      rules: [...document.styleSheets].reduce((n, s) => { try { return n + s.cssRules.length; } catch (e) { return n; } }, 0),
      bg: getComputedStyle(document.body).backgroundColor,
      nodes: document.getElementsByTagName('*').length,
      placeholders: (document.body.innerText.match(/Product Image/gi) || []).length,
      brokenImgs: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
      totalImgs: document.images.length,
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 2,
    }));
    (r1.rules > 1000 ? PASS : FAIL)('CSS applied: ' + r1.rules + ' rules across ' + r1.sheets + ' sheets');
    (r1.bg !== 'rgba(0, 0, 0, 0)' && r1.bg !== 'rgb(255, 255, 255)' ? PASS : FAIL)('premium dark theme: body bg ' + r1.bg);
    (r1.placeholders === 0 ? PASS : FAIL)('placeholder components: ' + r1.placeholders);
    (!r1.hScroll ? PASS : FAIL)('no horizontal scroll');
    INFO('images: ' + r1.brokenImgs + '/' + r1.totalImgs + ' broken, DOM ' + r1.nodes + ' nodes');

    /* Service worker must reach "activated" — the defect that started this. */
    const swState = await p.evaluate(async () => {
      for (let i = 0; i < 45; i++) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.active) return { state: reg.active.state, controller: !!navigator.serviceWorker.controller, waited: i };
        await new Promise(z => setTimeout(z, 1000));
      }
      const reg = await navigator.serviceWorker.getRegistration();
      return { state: reg ? (reg.installing ? 'STUCK INSTALLING' : 'no active worker') : 'not registered',
               controller: !!navigator.serviceWorker.controller, waited: 45 };
    }).catch(() => null);
    if (!swState) UNV('could not query service worker state');
    else if (swState.state === 'activated') PASS('service worker ACTIVATED after ' + swState.waited + 's  (controller=' + swState.controller + ')');
    else FAIL('service worker did not activate: ' + swState.state + ' after ' + swState.waited + 's');

    const appErrs = errs.filter(e => !/doubleclick|ga-audiences|storage-access|analytics|generate_204|recaptcha/i.test(e));
    (appErrs.length === 0 ? PASS : FAIL)('unexpected console errors: ' + appErrs.length);
    appErrs.slice(0, 5).forEach(e => INFO(e));

    await b.close();
  }

  console.log('\n  ══════════════════════════════════════════════════════════');
  if (fail) {
    console.log('  RELEASE GATE FAILED — ' + fail + ' gate(s) failed. DO NOT DEPLOY.');
    if (warn) console.log('  (' + warn + ' unverified — evidence could not be collected here)');
  } else if (warn) {
    console.log('  GATES PASSED with ' + warn + ' UNVERIFIED item(s). Review before deploying.');
  } else {
    console.log('  ALL GATES PASSED — cleared to deploy.');
  }
  console.log('  ══════════════════════════════════════════════════════════\n');
  process.exit(fail ? 1 : 0);
})();
