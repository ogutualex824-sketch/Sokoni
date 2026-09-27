/* test-in-app-support.js — support and contact stay IN the app (owner directive 2026-09-27: "no WhatsApp …
 * everything in app communication"). CHANGELOG 217.
 *
 * PROVES
 *   static   no support / contact / policy / footer surface links to SOKONI's WhatsApp numbers any more
 *            (254705726803 · 254703480154); a positive control proves the detector finds one
 *   browser  support.html#ticket opens the in-app TICKET form; the contact, help and home-page support links land
 *            there; support.html offers no WhatsApp card; no horizontal scroll at 360 / 1280
 *
 *   node scripts/test-in-app-support.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-in-app-support';
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const SURFACES = ['about.html', 'careers.html', 'community-guidelines.html', 'contact.html', 'cookie-policy.html', 'faq.html', 'payment-security.html',
  'press.html', 'provider-terms.html', 'refund-policy.html', 'returns-policy.html', 'seller-terms.html', 'index.html', 'help.html', 'checkout.html',
  'dispute-portal.html', 'driver.html', 'support.html', 'legal.html', 'script.js', 'sokoni-ui-extras.js'];
const ADMIN_WA = /wa\.me\/2547(?:05726803|03480154)/;

(async () => {
  say('\n── static: no support surface hands the user to WhatsApp ──');
  const hits = SURFACES.filter((f) => ADMIN_WA.test(fs.readFileSync(Path.join(ROOT, f), 'utf8')));
  ck(`none of the ${SURFACES.length} support / contact / footer surfaces links SOKONI's WhatsApp numbers`, hits.length === 0, hits);
  ck('the detector finds an admin WhatsApp link when one exists (positive control)', ADMIN_WA.test('<a href="https://wa.me/254705726803?text=hi">'));

  say('\n── browser ──');
  const HAR = makePageHarness({ db: F.db, root: ROOT });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    for (const vp of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
      const P = await HAR.page(browser, { viewport: vp });
      await P.goto(HAR.BASE + '/support.html#ticket');
      await P.waitForTimeout(800);
      const s = await P.evaluate(() => ({ ticketOpen: !!document.querySelector('#spP-ticket.active') || getComputedStyle(document.getElementById('spP-ticket')).display !== 'none',
        form: !!document.getElementById('spSubmitBtn'), wa: [...document.querySelectorAll('a[href]')].filter((a) => /wa\.me|whatsapp/i.test(a.href)).map((a) => a.href),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
      ck(`${vp.width}: support.html#ticket opens the in-app ticket form`, s.ticketOpen && s.form, s);
      ck(`${vp.width}: support.html offers no WhatsApp link at all`, s.wa.length === 0, s.wa);
      ck(`${vp.width}: support.html has no horizontal scroll`, !s.overflow);
      await P.__ctx.close();
    }
    for (const page of ['/contact.html', '/help.html', '/index.html']) {
      const P = await HAR.page(browser, { viewport: { width: 390, height: 844 } });
      await P.goto(HAR.BASE + page);
      await P.waitForTimeout(1200);
      const l = await P.evaluate(() => ({ support: [...document.querySelectorAll('a[href]')].filter((a) => /support\.html#ticket$/.test(a.href)).length,
        adminWa: [...document.querySelectorAll('a[href]')].filter((a) => /wa\.me\/2547(05726803|03480154)/.test(a.href)).map((a) => a.href) }));
      ck(`${page}: its support link(s) go to the in-app ticket, none to SOKONI's WhatsApp`, l.support >= 1 && l.adminWa.length === 0, l);
      await P.__ctx.close();
    }
  } finally { await browser.close(); HAR.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
