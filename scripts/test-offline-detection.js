#!/usr/bin/env node
/**
 * test-offline-detection.js — regression suite for the false-offline banner.
 *
 * THE DEFECT THIS GUARDS AGAINST
 * sokoni-offline.js used to treat `navigator.onLine` as authoritative and show the
 * banner directly from it. Installed PWAs, iOS Safari and Android WebViews report
 * `navigator.onLine === false` while the network is healthy, so the banner appeared
 * with working internet — and because only the flag could hide it, it stayed STUCK.
 *
 * Run:  node scripts/test-offline-detection.js
 *       (needs a local server on :3000 — `npm run dev` — and playwright)
 *
 * Exit 0 = pass, 1 = fail. Wire into predeploy.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://localhost:3000';
const PAGE = '/index.html';

let failures = 0;
const ok   = (m) => console.log('  pass  ' + m);
const bad  = (m) => { console.error('  FAIL  ' + m); failures++; };

/* ─────────── static guards (run without a browser) ─────────── */
function staticChecks() {
  console.log('\nStatic guards\n');

  const offline = fs.readFileSync(path.join(ROOT, 'sokoni-offline.js'), 'utf8');

  // 1. The banner must never be shown from navigator.onLine alone.
  //    Any `if (!navigator.onLine) ... _show()` is the original defect.
  const flagShow = /if\s*\(\s*!\s*navigator\.onLine\s*\)[^\n]*_show\s*\(/.test(offline);
  flagShow
    ? bad('sokoni-offline.js shows the banner directly from !navigator.onLine (the original defect)')
    : ok('sokoni-offline.js never shows the banner from navigator.onLine alone');

  // 2. It must probe an off-origin URL. An own-origin probe is served from the SW
  //    cache while offline and would falsely report "online".
  /generate_204/.test(offline)
    ? ok('sokoni-offline.js uses an off-origin probe (SW cannot fake it)')
    : bad('sokoni-offline.js has no off-origin connectivity probe');

  // 3. Recovery must never be gated on the probe succeeding.
  /addEventListener\('online'[\s\S]{0,240}_hide\s*\(/.test(offline)
    ? ok("`online` event hides the banner immediately (recovery cannot be blocked)")
    : bad("`online` event does not hide the banner immediately — it could get stuck");

  // 4. It must re-check on pageshow + visibilitychange, or state sticks after
  //    install / backgrounding / refresh / SW update.
  const rechecks = /pageshow/.test(offline) && /visibilitychange/.test(offline);
  rechecks
    ? ok('re-probes on pageshow and visibilitychange (no stuck state after resume)')
    : bad('missing pageshow/visibilitychange re-probe — state can stick');

  // 5. Connectivity-critical scripts must be network-first in the SW, or a fix to
  //    the detector can never reach a user holding an old cached copy.
  const sw = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
  const freshBlock = (sw.match(/const ALWAYS_FRESH = \[[\s\S]*?\];/) || [''])[0];
  for (const f of ['sokoni-offline.js', 'sokoni-ui.js', 'shared-header.js']) {
    freshBlock.includes(f)
      ? ok(`${f} is network-first in the service worker (fix can reach cached users)`)
      : bad(`${f} is NOT in ALWAYS_FRESH — served cache-first, so a connectivity fix cannot reach existing users`);
  }
}

/* ─────────── live browser behaviour ─────────── */
async function browserChecks() {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.log('\n  skip  browser checks (playwright not installed)\n'); return; }

  console.log('\nBrowser behaviour\n');
  const browser = await chromium.launch({ headless: true });

  const bannerVisible = (page) => page.evaluate(() => {
    const bar    = document.getElementById('sk-offline-bar');
    const banner = document.getElementById('sk-offline-banner');
    const barOn    = !!bar && bar.classList.contains('sk-offline--visible');
    const bannerOn = !!banner && banner.style.transform === 'translateY(0)';
    return barOn || bannerOn;
  });

  /* CASE 1 — THE BUG: navigator.onLine lies (false) but the network is up.
     The banner must NOT appear. This is what installed PWAs / iOS Safari do. */
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    });
    const page = await ctx.newPage();
    await page.goto(ORIGIN + PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(14000);           // past the 8s probe + grace
    const shown = await bannerVisible(page);
    shown
      ? bad('navigator.onLine=false while ONLINE → banner shown (FALSE OFFLINE — the reported defect)')
      : ok('navigator.onLine=false while ONLINE → banner stays hidden (probe overrides the lying flag)');
    await ctx.close();
  }

  /* Genuinely offline = the browser reports offline AND the probe fails.
     navigator.onLine must be overridden via addInitScript: a defineProperty inside
     page.evaluate() does NOT take effect (the getter is on Navigator.prototype), and
     a test that silently fails to apply it proves nothing. */
  const OFFLINE_INIT = () => {
    Object.defineProperty(Navigator.prototype, 'onLine', {
      get: () => window.__forceOffline !== true, configurable: true,
    });
    window.__forceOffline = true;
  };

  /* CASE 2 — genuinely offline: probe blocked + browser reports offline.
     The banner MUST appear. Guards against "fixing" the bug by never showing it. */
  {
    const ctx = await browser.newContext();
    await ctx.route('**/generate_204*', r => r.abort());
    await ctx.addInitScript(OFFLINE_INIT);
    const page = await ctx.newPage();
    await page.goto(ORIGIN + PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (await page.evaluate(() => navigator.onLine)) bad('setup: could not force navigator.onLine=false');

    /* Poll — the probe schedule (first at 8s, retries every 8s) makes a fixed sleep flaky. */
    let shown = false;
    for (let i = 0; i < 12 && !shown; i++) {
      await page.waitForTimeout(3000);
      shown = await bannerVisible(page);
    }
    shown
      ? ok('genuinely offline (probe fails + browser offline) → banner IS shown')
      : bad('genuinely offline → banner NOT shown (offline state is not reported at all)');
    await ctx.close();
  }

  /* CASE 3 — recovery: network returns. The banner must hide and must not stick. */
  {
    const ctx = await browser.newContext();
    let blocked = true;
    await ctx.route('**/generate_204*', r => (blocked ? r.abort() : r.continue()));
    await ctx.addInitScript(OFFLINE_INIT);
    const page = await ctx.newPage();
    await page.goto(ORIGIN + PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 });

    /* Poll for the banner rather than guessing a fixed delay — the probe schedule
       (8s first probe, then 8s retries) makes a single sleep flaky. */
    let armed = false;
    for (let i = 0; i < 12 && !armed; i++) {
      await page.waitForTimeout(3000);
      armed = await bannerVisible(page);
    }

    if (!armed) {
      bad('setup: banner never appeared, cannot test recovery');
    } else {
      blocked = false;                                    // network restored
      await page.evaluate(() => {
        window.__forceOffline = false;
        window.dispatchEvent(new Event('online'));
      });
      await page.waitForTimeout(4000);
      (await bannerVisible(page))
        ? bad('network restored → banner STILL showing (STUCK offline state)')
        : ok('network restored → banner hides immediately (no stuck state)');
    }
    await ctx.close();
  }

  await browser.close();
}

(async () => {
  console.log('\nOffline detection — regression suite');
  staticChecks();
  await browserChecks();
  console.log('');
  if (failures) { console.error(`Offline detection FAILED (${failures} problem${failures > 1 ? 's' : ''})\n`); process.exit(1); }
  console.log('Offline detection PASSED\n');
})().catch(e => { console.error('suite error:', e.message); process.exit(2); });
