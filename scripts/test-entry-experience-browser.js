#!/usr/bin/env node
/**
 * Entry experience (2026-09-30): "Create Free Account" opens the canonical account wizard, and the splash states the
 * whole device viewport.
 *
 *   EE1 the home page's "Create Free Account" goes to onboarding.html?mode=signup, and the wizard opens on the
 *       Create Account tab (the sign-up form is the visible one)
 *   EE2 every other entry (login.html "Create Account", the mobile menu, the welcome popup, the chatbot) points to the
 *       wizard's sign-up mode; no user-facing entry still points at the legacy signup.html
 *   EE3 an ordinary arrival at onboarding.html still opens on Sign In (sign-up mode is opt-in only)
 *   EE4 the splash states the full viewport: 100vh fallback, 100dvh, min-height 100svh, safe-area padding — and on an
 *       emulated iPhone (WebKit) and Android phone (Chromium) its box equals the viewport
 *
 *   EE5 once per visit: the first page splashes, returning to home in the same session does not
 *   EE6 the restored colour journey (b905bc9 home splash): glitter canvas drawing, five brand colours
 *   EE7 reduced motion: no glitter
 *
 * Real pages from this tree over a local static server; ALL external network is blocked, so nothing reaches production.
 *   node scripts/test-entry-experience-browser.js
 */
'use strict';
const path = require('path'), http = require('http'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const pw = require(path.join(ROOT, 'node_modules', 'playwright'));
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 400) + ']' : '')); ok ? pass++ : fail++; };
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const open = async (engine, device) => {
    const browser = await pw[engine].launch();
    const ctx = await browser.newContext(Object.assign({}, device ? pw.devices[device] : {}, { serviceWorkers: 'block' }));
    await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
    return { browser, page: await ctx.newPage() };
  };
  let b;
  try {
    /* EE1 */
    b = await open('chromium');
    await b.page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    const href = await b.page.$eval('a.social-join-btn', (a) => a.getAttribute('href')).catch(() => null);
    await b.page.goto(BASE + '/' + (href || 'missing'), { waitUntil: 'domcontentloaded' });
    await b.page.waitForTimeout(300);
    const w1 = await b.page.evaluate(() => {
      const su = document.getElementById('fSu'), si = document.getElementById('fSi'), tabs = document.querySelectorAll('.atab');
      return { suOn: !!su && su.classList.contains('on'), siOn: !!si && si.classList.contains('on'),
        activeTab: [...tabs].findIndex((t) => t.classList.contains('on')), heading: (document.querySelector('.auth-hero h1') || {}).textContent || '' };
    });
    ck('EE1 "Create Free Account" opens the canonical wizard (onboarding.html?mode=signup) on the Create Account tab',
      href === 'onboarding.html?mode=signup' && w1.suOn && !w1.siOn && w1.activeTab === 1 && /Join/.test(w1.heading), { href, w1 });

    /* EE3 */
    await b.page.goto(BASE + '/onboarding.html', { waitUntil: 'domcontentloaded' });
    await b.page.waitForTimeout(300);
    const w3 = await b.page.evaluate(() => ({ siOn: document.getElementById('fSi').classList.contains('on'), suOn: document.getElementById('fSu').classList.contains('on') }));
    ck('EE3 an ordinary arrival at onboarding.html still opens on Sign In', w3.siOn && !w3.suOn, w3);
    await b.browser.close(); b = null;

    /* EE2 */
    const entries = {
      'login.html':          /Don't have an account\? <a href="onboarding\.html\?mode=signup">/,
      'sokoni-ui-extras.js': /<a href="onboarding\.html\?mode=signup" id="mmenuSignupLink"/,
      'script.js (popup)':   /<a href="onboarding\.html\?mode=signup" class="mkt-popup-cta">/,
      'script.js (chatbot)': /<a href='onboarding\.html\?mode=signup' style='color:#71ff00'>/,
      'sokoni-security.js':  /regBtn\.href = 'onboarding\.html';/,
    };
    const bad = Object.entries(entries).filter(([k, re]) => !re.test(src(k.split(' ')[0]))).map(([k]) => k);
    const legacy = ['index.html', 'login.html', 'script.js', 'sokoni-ui-extras.js', 'sokoni-security.js']
      .filter((f) => /href\s*=\s*["']signup\.html|\.href\s*=\s*'signup\.html'/.test(src(f)));
    ck('EE2 every user-facing "create account" entry points to the wizard; none still links the legacy signup.html', bad.length === 0 && legacy.length === 0, { bad, legacy });

    /* EE4 */
    const css = src('splash.js');
    const stated = /width:100vw;height:100vh;height:100dvh;min-height:100svh/.test(css) && /env\(safe-area-inset-top/.test(css) && /env\(safe-area-inset-bottom/.test(css);
    const fits = [];
    for (const [engine, dev] of [['webkit', 'iPhone 13'], ['chromium', 'Pixel 5']]) {
      let got = null;
      for (let attempt = 0; attempt < 3 && !got; attempt++) {   /* the splash lives ~2s: catch it on attach */
        const x = await open(engine, dev);
        try {
          x.page.goto(BASE + '/index.html', { waitUntil: 'commit' }).catch(() => null);
          await x.page.waitForSelector('#sk-spl', { state: 'attached', timeout: 8000 }).catch(() => null);
          got = await x.page.evaluate(() => { const el = document.getElementById('sk-spl'); if (!el) return null;
            return { h: parseFloat(getComputedStyle(el).height), vh: innerHeight, w: el.getBoundingClientRect().width / (el.getBoundingClientRect().width ? 1 : 1), vw: innerWidth }; }).catch(() => null);
        } finally { await x.browser.close(); }
      }
      fits.push({ engine, dev, got });
    }
    ck('EE4 the splash states the full viewport (100vh → 100dvh, min 100svh, safe-area padding) and its height equals the viewport on emulated iPhone (WebKit) and Android (Chromium)',
      stated && fits.every((f) => f.got && Math.abs(f.got.h - f.got.vh) < 1), { stated, fits });

    /* EE5 — once per visit: the first page splashes; coming back to home in the same session does not */
    const x5 = await open('chromium', 'Pixel 5');
    try {
      x5.page.goto(BASE + '/index.html', { waitUntil: 'commit' }).catch(() => null);
      const first = !!(await x5.page.waitForSelector('#sk-spl', { state: 'attached', timeout: 8000 }).catch(() => null));
      await x5.page.waitForTimeout(3200);   /* let the first splash finish */
      await x5.page.goto(BASE + '/search.html', { waitUntil: 'domcontentloaded' }).catch(() => null);
      await x5.page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' }).catch(() => null);
      await x5.page.waitForTimeout(300);
      const again = await x5.page.evaluate(() => !!document.getElementById('sk-spl'));
      const guard = await x5.page.evaluate(() => window.SokoniSplash === true);
      ck('EE5 the splash greets the FIRST page of a visit; returning to home (after search) does not splash again — and the guard still stops any second splash system',
        first && !again && guard, { first, again, guard });
    } finally { await x5.browser.close(); }

    /* EE6 — the colour journey is really there (glitter drawing in the five brand colours) */
    const x6 = await open('webkit', 'iPhone 13');
    let j6 = null;
    try {
      x6.page.goto(BASE + '/index.html', { waitUntil: 'commit' }).catch(() => null);
      await x6.page.waitForSelector('#sk-spl .spl-glitter', { state: 'attached', timeout: 8000 }).catch(() => null);
      await x6.page.waitForTimeout(250);
      j6 = await x6.page.evaluate(() => {
        const cv = document.querySelector('#sk-spl .spl-glitter'); if (!cv) return { canvas: false };
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let lit = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
        return { canvas: true, w: cv.width, lit };
      }).catch((e) => ({ err: e.message }));
    } finally { await x6.browser.close(); }
    const five = ['#71ff00', '#00d4ff', '#a855f7', '#f59e0b', '#ec4899'].every((c) => css.includes(c));
    ck('EE6 the restored colour journey: a glitter canvas drawing on the splash, and all five brand colours in its palette (green, cyan, purple, amber, rose)',
      !!j6 && j6.canvas && j6.lit > 20 && five, { j6, five });

    /* EE7 — reduced motion: no glitter, nothing animated */
    const x7b = await pw.chromium.launch();
    try {
      const ctx7 = await x7b.newContext(Object.assign({}, pw.devices['Pixel 5'], { serviceWorkers: 'block', reducedMotion: 'reduce' }));
      await ctx7.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
      const p7 = await ctx7.newPage();
      p7.goto(BASE + '/index.html', { waitUntil: 'commit' }).catch(() => null);
      await p7.waitForSelector('#sk-spl', { state: 'attached', timeout: 8000 }).catch(() => null);
      const r7 = await p7.evaluate(() => { const cv = document.querySelector('#sk-spl .spl-glitter'); return cv ? getComputedStyle(cv).display : 'absent'; }).catch(() => 'err');
      ck('EE7 with "reduce motion" the glitter is not shown', r7 === 'none' || r7 === 'absent', r7);
    } finally { await x7b.close(); }

    /* EE8 — the splash is the FIRST paint (owner 2026-10-01: "home loads first, then splash, then home").
       An init script watches the DOM from the very first byte: when the first piece of home content (any
       element inside <body> other than the splash) appears, the splash must ALREADY be attached and opaque.
       Both engines; a slow-parsing 3,000-line page is exactly where the old DOMContentLoaded mount lost. */
    for (const [eng, dev] of [['chromium', 'Pixel 5'], ['webkit', 'iPhone 13']]) {
      const xb = await pw[eng].launch();
      try {
        const c8 = await xb.newContext(Object.assign({}, pw.devices[dev], { serviceWorkers: 'block' }));
        await c8.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
        await c8.addInitScript(() => {
          window.__ord = { contentFirstAt: null, splashAtContent: null, splashBg: null };
          new MutationObserver(function (_, obs) {
            const body = document.body; if (!body) return;
            const content = [...body.children].find((e) => e.id !== 'sk-spl' && !/^(SCRIPT|STYLE|LINK|NOSCRIPT|TEMPLATE)$/.test(e.tagName));
            if (!content) return;
            const s = document.getElementById('sk-spl');
            window.__ord.contentFirstAt = content.tagName + (content.id ? '#' + content.id : '');
            window.__ord.splashAtContent = !!s;
            window.__ord.splashBg = s ? getComputedStyle(s).backgroundColor : null;
            obs.disconnect();
          }).observe(document, { childList: true, subtree: true });
        });
        const p8 = await c8.newPage();
        await p8.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' }).catch(() => null);
        const o8 = await p8.evaluate(() => window.__ord).catch(() => null);
        ck('EE8 [' + eng + '] the splash is attached and opaque BEFORE the first home content exists (no home → splash → home flash)',
          !!o8 && o8.splashAtContent === true && /rgb\(5, 5, 5\)/.test(String(o8.splashBg)), o8);
      } finally { await xb.close(); }
    }
  } catch (e) {
    ck('EE0 harness', false, e.message);
  } finally {
    if (b) await b.browser.close();
    server.close();
  }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
