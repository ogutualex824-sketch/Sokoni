#!/usr/bin/env node
/**
 * verify-appcheck.js — automated App Check guard.
 *
 * Fails the build if:
 *   1. Any debug-token assignment is not gated behind a localhost check.
 *   2. A debug token UUID is hardcoded in source.
 *   3. A production origin (mysokoni.co.ke, www.mysokoni.co.ke, sokoni-aeb26.web.app)
 *      sets FIREBASE_APPCHECK_DEBUG_TOKEN or calls exchangeDebugToken.
 *
 * Static checks always run. The live browser check (3) runs only when Playwright
 * is installed and a local server is serving the site:
 *   npm run dev            # then, in another shell:
 *   node scripts/verify-appcheck.js --live
 *
 * Exit code 0 = pass, 1 = fail.  Wire into predeploy.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROD_HOSTS = ['mysokoni.co.ke', 'www.mysokoni.co.ke', 'sokoni-aeb26.web.app'];
const APPCHECK_FILES = ['firebase.js', 'sokoni-appcheck.js'];
const LOCALHOST_HINT = /localhost|127\.0\.0\.1|IS_LOCALHOST/;

let failures = 0;
const fail = (msg) => { console.error('  FAIL  ' + msg); failures++; };
const pass = (msg) => console.log('  pass  ' + msg);

console.log('\nApp Check verification\n');

/* ── 1 + 2: static source checks ─────────────────────────────────────────── */
for (const file of APPCHECK_FILES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { fail(`${file} is missing`); continue; }
  const lines = fs.readFileSync(full, 'utf8').split('\n');

  lines.forEach((line, i) => {
    if (!/FIREBASE_APPCHECK_DEBUG_TOKEN\s*=/.test(line)) return;

    // A hardcoded UUID debug token must never be committed.
    if (/=\s*['"][0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}['"]/.test(line)) {
      fail(`${file}:${i + 1} hardcodes a debug token UUID — it must come from localStorage`);
      return;
    }

    // The assignment must sit inside a localhost guard (look back a few lines).
    const context = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
    if (!LOCALHOST_HINT.test(context)) {
      fail(`${file}:${i + 1} assigns a debug token without a localhost guard`);
    }
  });

  pass(`${file} — debug token is localhost-gated, no hardcoded UUID`);
}

/* ── 3: live production-origin check ─────────────────────────────────────── */
async function live() {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.log('\n  skip  live check (playwright not installed)'); return; }

  const browser = await chromium.launch({ headless: true });
  console.log('');

  for (const host of PROD_HOSTS) {
    const origin = 'https://' + host;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Serve the repo's real files under the production origin.
    await ctx.route(origin + '/**', async (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'login.html';
      try {
        const body = fs.readFileSync(path.join(ROOT, p));
        const ext = p.split('.').pop();
        const ct = { html: 'text/html', js: 'text/javascript', css: 'text/css',
                     json: 'application/json', png: 'image/png', svg: 'image/svg+xml' }[ext] || 'text/plain';
        await route.fulfill({ status: 200, contentType: ct, body });
      } catch { await route.fulfill({ status: 404, body: '' }); }
    });

    // Pin a token — production must ignore it entirely.
    await page.addInitScript(() => {
      try { localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', '00000000-0000-4000-8000-000000000000'); } catch (_) {}
    });

    let debugExchange = false;
    page.on('request', (r) => { if (/exchangeDebugToken/.test(r.url())) debugExchange = true; });

    try {
      await page.goto(origin + '/login.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForTimeout(6000);
    } catch (e) {
      fail(`${host} — page failed to load: ${e.message.split('\n')[0]}`);
      await ctx.close();
      continue;
    }

    const flagSet = await page.evaluate(() => self.FIREBASE_APPCHECK_DEBUG_TOKEN !== undefined);

    if (flagSet)       fail(`${host} — FIREBASE_APPCHECK_DEBUG_TOKEN is set in production`);
    if (debugExchange) fail(`${host} — called exchangeDebugToken in production`);
    if (!flagSet && !debugExchange) pass(`${host} — no debug token; reCAPTCHA attestation only`);

    await ctx.close();
  }
  await browser.close();
}

(async () => {
  if (process.argv.includes('--live')) await live();
  else console.log('\n  skip  live production check (pass --live to run it)');

  console.log('');
  if (failures) { console.error(`App Check verification FAILED (${failures} problem${failures > 1 ? 's' : ''})\n`); process.exit(1); }
  console.log('App Check verification PASSED\n');
})();
