/* Seller section addressing — the Sell workspace must be reachable by URL.
 *
 *   node scripts/test-seller-deeplink.js
 *
 * WHY THIS EXISTS
 * sokoni-merchant-routes.js declares every seller destination as `kind:'seller', sec:'products'`,
 * so `sec` is the vocabulary the merchant route contract already speaks. Nothing read it.
 * `seller.html?sec=products` resolved to Overview — byte-for-byte the same render as a bare
 * `seller.html` — so the merchant asked for Products and was handed the dashboard, with no
 * error in the console and nothing failing anywhere. That is the silent-wrong-section class
 * this router exists to prevent, and it is the reason other pages once invented
 * seller-products.html: people write the URL they wish existed when the real one does nothing.
 *
 * The two forms are NOT interchangeable and the difference is asserted here:
 *
 *   #products      transient. seller.html's deep-link IIFE applies it and then strips it
 *                  (history.replaceState) so the browser does not anchor-scroll to a
 *                  matching element id. It therefore cannot survive a reload.
 *   ?sec=products  durable. It outlives that strip because the strip preserves
 *                  location.search, so it reloads, shares and bookmarks correctly.
 *
 * A test that only checked "#products works" would have passed against the broken build and
 * missed the entire defect, so the reload case below is the one that matters most.
 *
 * The five sections are asserted by an interactive control each, not merely by the section
 * element being display:block — a section that mounts empty is still a broken workspace.
 */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 95) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';       /* cleanUrls:true, as hosting serves it */
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

/* Each Products section plus a control that proves it actually rendered its body. */
const SECTIONS = {
  'upload-section':      'productName',
  'products-section':    'sellerProductsContainer',
  'inventory-section':   'inventoryTbody',
  'bulk-upload-section': 'bulkCsvFile',
  'ai-desc-section':     'aiDescBtn',
};

/* The watchdog is shorter than the runner's browser budget on purpose: if this suite ever
   hangs it must say so itself rather than be killed and reported as lost coverage. */
const wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 120s'); process.exit(1); }, 120000);

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await webkit.launch();

  /* Read the page's own section visibility — the same evidence merchant.html's sellerSwitch
     uses. Asking the sidebar which item is active would only prove we asked, not that the
     body changed, which is exactly how the original defect stayed invisible. */
  const readState = (page) => page.evaluate((SECTIONS) => {
    const vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return 'MISSING';
      const cs = getComputedStyle(el);
      return (cs.display !== 'none' && cs.visibility !== 'hidden') ? 'shown' : 'hidden';
    };
    const sections = {}, controls = {};
    Object.keys(SECTIONS).forEach((s) => { sections[s] = vis(s); controls[s] = !!document.getElementById(SECTIONS[s]); });
    return { sections, controls, sellerStats: vis('seller-stats'), url: location.pathname + location.search + location.hash };
  }, SECTIONS);

  /* "Products is on screen" = all five of its sections shown AND seller-stats hidden.
     Both halves are required: upload-section and products-section are ALSO in overview,
     so checking only those would report success while the dashboard was on screen. */
  const isProducts = (st) =>
    Object.keys(SECTIONS).every((s) => st.sections[s] === 'shown') && st.sellerStats === 'hidden';

  /* Wait for the ROUTER'S OUTCOME rather than sleeping a fixed interval.
     Both outcomes are positive conditions — Products reveals #inventory-section, Overview
     reveals #seller-stats — so neither case has to burn a worst-case wait, and neither can
     be read before the router has run. A flat sleep would be both slower and less reliable:
     too short is a flake, too long is the suite drifting toward its budget until the gate
     silently stops running it (see nearBudget in scripts/test-inventory.js). */
  /* BOTH halves are required, and that is not belt-and-braces — a single-element wait resolves
     on the WRONG state. On a phone every section is visible by default until seller.html adds
     body.sdm-mobile-mode, so "inventory-section is visible" is briefly true during boot, before
     any routing has happened. Waiting on that alone returned while the page was still showing
     everything, and the assertion then read Overview. The pair is only ever true after the
     router has actually run, because no default state satisfies both. */
  /* The section coming up is only HALF the router's outcome, and waiting on it alone made
     the URL assertions read mid-flight. seller.js's DOMContentLoaded router puts the section
     on screen; seller.html's deep-link router is what cleans #hash off the address, and it
     only does so after verifying the section really came up. So there is a window in which
     Products is up and the hash is still there — ~150ms before the fix, and it is why
     "the hash is stripped" failed 13/1 in the full gate population while passing standalone
     eight times: under load the strip drifted past the read, and this suite discarded child
     output, so the assertion was never seen.
     seller.html therefore publishes data-seller-deeplink when routing SETTLES. Waiting for it
     is a synchronisation fix, not a weaker test: the attribute says only that the router
     finished, never that it was right, and every assertion below still checks the real
     address and the real section visibility for itself. */
  const settle = (page, want) => page.waitForFunction((want) => {
    if (!document.documentElement.hasAttribute('data-seller-deeplink')) return false;
    const shown = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    return want === 'products'
      ? shown('inventory-section') === true && shown('seller-stats') === false
      : shown('seller-stats') === true && shown('inventory-section') === false;
  }, want, { timeout: 20000 }).catch(() => null);   /* null → assert on the real state below */

  /* ONE context and ONE page for every case, reused by navigating.
     Each case used to build its own context. That is the right instinct when cases need
     different state — but every case here seeds the IDENTICAL session and differs only in
     the URL, so the isolation bought nothing and cost a browser context each time. Measured:
     43s standalone but 120s+ inside the isolated gate, where it tripped this suite's own
     watchdog and reported FAIL for a suite whose 14 assertions all passed. A test that fails
     because it is slow teaches the reader to distrust it.
     Navigation gives the same isolation that matters here: each goto is a fresh document,
     and the init script re-seeds storage on every one. */
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    try {
      /* auth-guard.js treats localStorage.loggedIn as the authoritative session flag
         (sokoniUser is only a profile cache), so this is a real authenticated merchant
         as far as every client-side gate on the page is concerned. */
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({
        uid: 'DEEPLINK_TEST', name: 'Deep Link', roles: ['buyer', 'seller', 'merchant'], isSeller: true }));
    } catch (e) {}
  });
  const shared = await ctx.newPage();

  async function open(url, want) {
    /* A same-document hash change would not reload, and this suite is specifically about
       what happens on LOAD — so step off the page first when only the hash differs. */
    if (new URL(BASE + url).pathname === new URL(shared.url() || BASE).pathname) {
      await shared.goto('about:blank');
    }
    await shared.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(shared, want);
    return { ctx: { close: async () => {} }, page: shared };
  }

  head('?sec= is a real address (the defect)');
  for (const url of ['/seller.html?sec=products', '/seller.html?sec=products&shell=merchant']) {
    const { ctx, page } = await open(url, 'products');
    const st = await readState(page);
    ck(url + ' selects Products', isProducts(st),
       'stats=' + st.sellerStats + ' shown=' + Object.keys(SECTIONS).filter((s) => st.sections[s] === 'shown').length + '/5');
    await ctx.close();
  }

  head('the five Products sections rendered a body, not just a box');
  {
    const { ctx, page } = await open('/seller.html?sec=products', 'products');
    const st = await readState(page);
    for (const s of Object.keys(SECTIONS)) {
      ck(s + ' present with #' + SECTIONS[s], st.sections[s] === 'shown' && st.controls[s],
         st.sections[s] + (st.controls[s] ? '' : ', CONTROL MISSING'));
    }
    await ctx.close();
  }

  head('?sec= survives a reload; #hash does not (they are different tools)');
  {
    const { ctx, page } = await open('/seller.html?sec=products', 'products');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page, 'products');
    const st = await readState(page);
    ck('?sec=products still on Products after reload', isProducts(st), st.url);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('/seller.html#products', 'products');
    const before = await readState(page);
    ck('#products selects Products on first load', isProducts(before), before.url);
    /* The strip is deliberate (it prevents anchor-scroll). Pinning it here means nobody
       "fixes" the hash into a durable address and reintroduces the scroll bug, and it
       documents WHY ?sec= had to exist rather than leaving it looking redundant. */
    ck('...and the hash is stripped from the URL', !/#/.test(before.url), before.url);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page, 'overview');
    const after = await readState(page);
    ck('...so a reload falls back to Overview — use ?sec= for a durable link', !isProducts(after), after.url);
    await ctx.close();
  }

  head('unknown and absent keys fall back to Overview, never to nothing');
  for (const [url, label] of [['/seller.html', 'bare seller.html'], ['/seller.html?sec=not-a-section', 'unknown ?sec=']]) {
    const { ctx, page } = await open(url, 'overview');
    const st = await readState(page);
    ck(label + ' shows Overview (seller-stats visible)', st.sellerStats === 'shown', 'stats=' + st.sellerStats);
    await ctx.close();
  }

  /* The failure mode the strip must never have. The old router stripped #products
     unconditionally — whether or not either selector existed and whether or not anything
     had been routed — so a boot slow enough to miss the fixed 150ms delay removed the only
     copy of the request and left the merchant on Overview, silently. The hash IS the
     request; if it cannot be honoured it must survive, because a retained hash still routes
     on the next hashchange or reload, and a discarded one is gone.
     sdSwitchTab is blocked before any page script runs, so on this mobile viewport the
     selector genuinely never becomes available — the real condition, not a simulated one. */
  head('a route that cannot be honoured keeps the address (negative case)');
  {
    const nctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
    await nctx.addInitScript(() => {
      try {
        localStorage.setItem('loggedIn', 'true');
        localStorage.setItem('sokoniUser', JSON.stringify({
          uid: 'DEEPLINK_TEST', name: 'Deep Link', roles: ['buyer', 'seller', 'merchant'], isSeller: true }));
      } catch (e) {}
      /* Swallow the page's own assignment so typeof stays 'undefined' throughout. */
      try {
        Object.defineProperty(window, 'sdSwitchTab', {
          get() { return undefined; }, set() {}, configurable: false,
        });
      } catch (e) {}
    });
    const npage = await nctx.newPage();
    await npage.goto(BASE + '/seller.html#products', { waitUntil: 'domcontentloaded', timeout: 30000 });
    /* Wait for the router to give up on its own terms rather than sleeping past its budget. */
    await npage.waitForFunction(
      () => document.documentElement.getAttribute('data-seller-deeplink') === 'unresolved',
      null, { timeout: 15000 }).catch(() => null);
    const nst = await npage.evaluate(() => ({
      url: location.pathname + location.search + location.hash,
      state: document.documentElement.getAttribute('data-seller-deeplink'),
      sdSwitchTab: typeof window.sdSwitchTab,
    }));
    ck('selector never available → #products is NOT stripped',
       /#products$/.test(nst.url) && nst.sdSwitchTab === 'undefined',
       'url=' + nst.url + ' selector=' + nst.sdSwitchTab);
    ck('...and the router reports it never resolved', nst.state === 'unresolved', 'state=' + nst.state);
    await nctx.close();
  }

  head('the merchant shell route still works (regression guard)');
  {
    const page = shared;   /* same session, same context — only the destination differs */
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    /* Wait for the shell's nav to exist rather than sleeping 4s for it. */
    await page.waitForFunction(() => !!document.querySelector('.mnav-item[data-id="products"]'),
      null, { timeout: 20000 }).catch(() => null);
    await page.evaluate(() => { const el = document.querySelector('.mnav-item[data-id="products"]'); if (el) el.click(); });
    /* Same conjunction inside the iframe, for the same reason — and the shell re-asserts the
       requested section on the iframe's load event and again 350ms later, so a wait that can
       be satisfied by the boot default would observe Products and then be overtaken. */
    await page.waitForFunction(() => {
      const f = document.querySelector('.mpanel.show iframe') || document.getElementById('mfx-seller');
      const d = f && f.contentDocument;
      if (!d) return false;
      const shown = (id) => {
        const el = d.getElementById(id);
        if (!el) return null;
        const cs = d.defaultView.getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      return shown('inventory-section') === true && shown('seller-stats') === false;
    }, null, { timeout: 30000 }).catch(() => null);
    const st = await page.evaluate((SECTIONS) => {
      const f = document.querySelector('.mpanel.show iframe') || document.getElementById('mfx-seller');
      const d = f && f.contentDocument;
      if (!d) return { ok: false };
      const vis = (id) => {
        const el = d.getElementById(id);
        if (!el) return 'MISSING';
        const cs = d.defaultView.getComputedStyle(el);
        return (cs.display !== 'none' && cs.visibility !== 'hidden') ? 'shown' : 'hidden';
      };
      const sections = {};
      Object.keys(SECTIONS).forEach((s) => { sections[s] = vis(s); });
      return { ok: true, sections, sellerStats: vis('seller-stats') };
    }, SECTIONS);
    ck('Merchant → Products mounts the Sell workspace in the shell',
       st.ok && Object.keys(SECTIONS).every((s) => st.sections[s] === 'shown') && st.sellerStats === 'hidden',
       st.ok ? 'stats=' + st.sellerStats : 'no panel iframe');
  }

  /* REPORT FIRST, THEN TEAR DOWN — and never let teardown decide the verdict.
     Inside the isolated gate this suite printed every one of its 14 assertions, all passing,
     and was then killed by its own watchdog at 120s: it had finished testing and hung in
     ctx.close()/browser.close(). The last case leaves a merchant shell holding a live iframe
     with in-flight requests, and closing that is intermittently slow — standalone it returns
     in milliseconds, under a loaded gate it does not.
     A suite that has already answered the question must not be reported as a failure because
     the browser took its time going away. The result is printed before teardown, and teardown
     is raced against a short timer so the process always reaches process.exit(). */
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');

  clearTimeout(wd);
  await Promise.race([
    (async () => { try { await ctx.close(); await browser.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  try { server.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
