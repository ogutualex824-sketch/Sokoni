#!/usr/bin/env node
/* test-community-c0-browser.js — community slice C0 in Chromium over the hermetic page harness (real
 * community.html / requests.html; Firebase SDK shimmed over a fake Firestore; every external origin stubbed;
 * no network, no production).
 *
 *   B1  a group named `<img src=x onerror=window.__pwn=1>` (and hostile desc/emoji) renders as TEXT:
 *       window.__pwn stays undefined and the literal name is visible
 *   B2  an EMPTY communityPosts collection shows the empty state ("No posts here yet"), writes nothing (no seed),
 *       and the post counter shows the canonical 0 — no "500+" anywhere
 *   B3  a hostile post (title/body/author/product) and a hostile reply render as text; __pwn stays undefined
 *   B4  report on a refused write (the harness refuses every client write, as the served rule refuses this
 *       payload): the page says "We couldn't send your report" and never "Report sent"
 *   B5  requests.html: saving a request draft says it is NOT published to sellers; no "Sellers will respond"
 *   N1  negative control: the same hostile group served through a copy of community.html with the 431b5c7
 *       escape removed from the group name → window.__pwn IS set (proves B1 can fail)
 *
 *   node scripts/test-community-c0-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-community-c0';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'); const Path = require('path'); const ROOT = Path.resolve(__dirname, '..');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const { makePageHarness } = require('./lib/page-harness.js');
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (!ok && d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
const HOSTILE = '<img src=x onerror=window.__pwn=1>';
const USER = { uid: 'c0-user', claims: {} };
const STORAGE = { sokoniUser: JSON.stringify({ uid: 'c0-user', name: 'C0 Tester' }) };

(async () => {
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const settle = (page) => page.waitForTimeout(1200);   /* let <img src=x> fire its error event */
  try {
    /* ── B1 + B2: empty feed, hostile group ── */
    {
      const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
      await db.doc('communityGroups/GX1').set({ id: 'GX1', type: 'estate', name: HOSTILE, desc: '<img src=x onerror=window.__pwn=2>', emoji: '<svg onload=window.__pwn=3>', members: 99999, createdBy: 'someone', createdAt: Date.now() });
      const pre = fs.readFileSync(Path.join(ROOT, 'community.html'), 'utf8');
      const neg = pre.replace('${escapeHTML(g.name)}', '${g.name}');
      const H = makePageHarness({ db, root: ROOT, callables: {}, pages: { '/community-negctl.html': neg } });
      await H.start();

      say('\n── B1/B2: hostile group, empty feed ──');
      let page = await H.page(browser, { user: USER, storage: STORAGE, viewport: { width: 390, height: 844 } });
      await page.goto(H.BASE + '/community.html');
      await page.waitForSelector('#ccGroupsGrid .cc-group-card', { timeout: 15000 });
      await page.waitForFunction(() => /No posts here yet/.test((document.getElementById('cmFeed') || {}).textContent || ''), null, { timeout: 15000 });
      await settle(page);
      ck('B1 window.__pwn is undefined after rendering the hostile group', (await page.evaluate(() => typeof window.__pwn)) === 'undefined', await page.evaluate(() => window.__pwn));
      ck('B1 the hostile name is shown literally as text', (await page.textContent('#ccGroupsGrid .cc-group-name')) === HOSTILE);
      ck('B1 no <img>/<svg> element was created inside the group card', (await page.$$eval('#ccGroupsGrid .cc-group-card img, #ccGroupsGrid .cc-group-card svg', (e) => e.length)) === 0);
      ck('B1 the client-written member count (99999) is not displayed', !(await page.textContent('#ccGroupsGrid')).includes('99,999') && !(await page.textContent('#ccGroupsGrid')).includes('99999'));
      ck('B2 empty feed shows the empty state', /No posts here yet/.test(await page.textContent('#cmFeed')));
      ck('B2 post counter shows the canonical 0 after the snapshot', (await page.textContent('#cmPostCount')).trim() === '0');
      ck('B2 no "500+" anywhere on the page', !(await page.evaluate(() => document.body.innerText.includes('500+'))));
      const posts = await db.collection('communityPosts').get();
      ck('B2 nothing was written to communityPosts (no seed writer)', posts.size === 0, posts.size);
      ck('B2 no page errors', page.__errors.length === 0, page.__errors);
      await page.__ctx.close();

      say('\n── N1: negative control (escape removed from the group name) ──');
      page = await H.page(browser, { user: USER, storage: STORAGE, viewport: { width: 390, height: 844 } });
      await page.goto(H.BASE + '/community-negctl.html');
      await page.waitForSelector('#ccGroupsGrid .cc-group-card', { timeout: 15000 });
      await settle(page);
      ck('N1 with the escape removed, window.__pwn IS set (B1 can fail)', (await page.evaluate(() => window.__pwn)) === 1, await page.evaluate(() => window.__pwn));
      await page.__ctx.close();
      H.stop();
    }

    /* ── B3 + B4: hostile post and reply; report refused ── */
    {
      const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
      await db.doc('communityPosts/P1').set({ type: 'discussion', title: HOSTILE, body: '<img src=x onerror=window.__pwn=5>', author: '<img src=x onerror=window.__pwn=6>', authorUid: 'other', product: '<img src=x onerror=window.__pwn=7>',
        date: '1 Oct', likes: '<img src=x onerror=window.__pwn=8>', helpful: 0, stars: 99, replies: [{ author: '<img src=x onerror=window.__pwn=9>', text: '<img src=x onerror=window.__pwn=10>', time: 'now' }], timestamp: Date.now() });
      const H = makePageHarness({ db, root: ROOT, callables: {} });
      await H.start();
      say('\n── B3/B4: hostile post, refused report ──');
      const page = await H.page(browser, { user: USER, storage: STORAGE, viewport: { width: 1280, height: 900 } });
      await page.goto(H.BASE + '/community.html');
      await page.waitForSelector('#cmFeed .cm-post', { timeout: 15000 });
      await settle(page);
      ck('B3 window.__pwn is undefined after rendering the hostile post and reply', (await page.evaluate(() => typeof window.__pwn)) === 'undefined', await page.evaluate(() => window.__pwn));
      ck('B3 the hostile title renders literally', (await page.textContent('#cmFeed .cm-post-title')) === HOSTILE);
      ck('B3 an out-of-range stars value did not blank the feed', (await page.$$eval('#cmFeed .cm-post', (e) => e.length)) === 1);
      await page.click('#cmFeed .cm-post button[title="Report post"]');
      await page.waitForSelector('#cmReportModal[style*="flex"]', { timeout: 5000 });
      await page.click('#cmReportModal button:has-text("Submit Report")');
      await page.waitForFunction(() => /couldn't send your report/.test((document.getElementById('_cmToastEl') || {}).textContent || ''), null, { timeout: 10000 });
      ck('B4 refused report → "We couldn\'t send your report"', true);
      ck('B4 "Report sent" never shown', !(await page.evaluate(() => document.body.innerText.includes('Report sent'))));
      ck('B4 nothing landed in communityReports', (await db.collection('communityReports').get()).size === 0);
      await page.__ctx.close();
      H.stop();
    }

    /* ── B5: requests.html draft honesty ── */
    {
      const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
      const H = makePageHarness({ db, root: ROOT, callables: {} });
      await H.start();
      say('\n── B5: requests.html ──');
      const page = await H.page(browser, { user: USER, storage: STORAGE, viewport: { width: 390, height: 844 } });
      await page.goto(H.BASE + '/requests.html');
      await page.waitForSelector('#rqName', { timeout: 15000 });
      await page.evaluate(() => { const h = document.querySelector('.rq-post-panel'); if (h) h.classList.add('form-open'); });
      await page.fill('#rqName', HOSTILE);
      await page.evaluate(() => window.postRequest());
      const msg = await page.textContent('#rqPostMsg');
      ck('B5 save says requests are NOT published to sellers', /not published to sellers/.test(msg), msg);
      ck('B5 no "Sellers will respond" / "Posted!" anywhere', !(await page.evaluate(() => /Sellers will respond|✅ Posted/.test(document.body.innerText))));
      await settle(page);
      ck('B5 the hostile request name renders as text (window.__pwn undefined)', (await page.evaluate(() => typeof window.__pwn)) === 'undefined');
      await page.__ctx.close();
      H.stop();
    }
  } catch (e) {
    ck('CRASH ' + (e && e.message), false);
  } finally {
    await browser.close();
  }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
