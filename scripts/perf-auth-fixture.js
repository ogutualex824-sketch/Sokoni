'use strict';
/**
 * Creates the Playwright storageState the performance probe needs to measure
 * authenticated pages (checkout), which otherwise redirect to /login and are
 * reported BLOCKED.
 *
 *   PERF_USER=qa@example.com PERF_PASS='…' node scripts/perf-auth-fixture.js
 *   → writes .perf-auth.json  (gitignored — it holds a live session)
 *
 * Then:
 *   PERF_AUTH_STATE=.perf-auth.json node scripts/perf-probe.js --page checkout
 *
 * Use a DEDICATED QA account, never a real customer or an admin. The state file
 * is a bearer credential: anyone holding it is signed in as that user. It is
 * written to the repo root only because the probe runs there; it must never be
 * committed, and it should be deleted when a measurement session ends.
 *
 * Signs in against PRODUCTION even when the probe measures localhost, because
 * the Firebase project — and therefore the session — is the same either way.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.PERF_AUTH_BASE || 'https://mysokoni.co.ke';
const USER = process.env.PERF_USER || '';
const PASS = process.env.PERF_PASS || '';
const OUT = process.env.PERF_AUTH_OUT || '.perf-auth.json';

if (!USER || !PASS) {
  console.error('Set PERF_USER and PERF_PASS (use a dedicated QA account).');
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});

  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);   // auth SDK + App Check settle

  /* Field ids vary across the auth surfaces; try the known ones in order rather
     than assuming one layout. */
  const emailSel = ['#authEmail', '#email', 'input[type="email"]'];
  const passSel  = ['#authPassword', '#password', 'input[type="password"]'];
  const fill = async (sels, val) => {
    for (const s of sels) {
      const el = await page.$(s);
      if (el) { await el.fill(val); return s; }
    }
    throw new Error('no field matched: ' + sels.join(', '));
  };

  await fill(emailSel, USER);
  await fill(passSel, PASS);
  await page.keyboard.press('Enter');

  /* Success is LEAVING /login. Waiting for a dashboard selector would couple
     this to a layout; the redirect is the actual signal. */
  try {
    await page.waitForFunction(() => !location.pathname.includes('login'), { timeout: 30000 });
  } catch (_) {
    const msg = await page.evaluate(() => {
      const m = document.querySelector('.auth-msg, .auth-error, [role="alert"]');
      return m ? m.textContent.trim().slice(0, 160) : '';
    });
    console.error('Sign-in did not leave /login. Page said: ' + (msg || '(nothing)'));
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(2000);   // let tokens persist
  await ctx.storageState({ path: OUT });
  await browser.close();

  console.log(`storageState written to ${OUT}`);
  console.log('This file is a live session — do not commit it. Delete it when finished.');
  if (!fs.readFileSync('.gitignore', 'utf8').includes('.perf-auth')) {
    console.error('WARNING: .perf-auth.json is not in .gitignore — add it before continuing.');
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
