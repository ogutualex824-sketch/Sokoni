#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT SHELL BOUNDARY — one shell owns the page
   ------------------------------------------------------------------------------
   /merchant owns its header (<header class="mtop">) and its bottom nav (#mbnav) and
   does NOT load shared-header.js. Embedded destinations opened inside it must
   contribute CONTENT ONLY.

   Suppression used to be per-page opt-in (data-no-header="true"). plans.html and
   pos.html declared it; sell.html and business.html did not — so opening either from
   /merchant mounted a SECOND complete application: two fixed headers and two bottom
   navs, the customer Home/Shop/Services/Orders/Profile sitting on top of the merchant
   Home/Orders/Sell/More. That is the defect in the screenshots.

   shared-header.js now reads the shell's own ?shell=merchant signal, so suppression is
   a property of being embedded rather than of a page remembering an attribute.

   This measures the RENDERED DOM in Chromium at an iPhone viewport, both ways, because
   shared-header.js is loaded by ~300 pages and standalone must keep working.

     node scripts/test-merchant-shell-boundary.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8795;
const IPHONE = { width: 390, height: 844 };

let pass = 0, fail = 0;
const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + l); return true; }
  fail++; failures.push(l + (d ? '  → ' + d : ''));
  console.log('  FAIL  ' + l + (d ? '   → ' + d : ''));
  return false;
};
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
               '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function serve() {
  return new Promise((res) => {
    const s = http.createServer((req, rs) => {
      const u = decodeURIComponent((req.url || '/').split('?')[0]);
      const f = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end(); return; }
      rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rs);
    });
    s.listen(PORT, () => res(s));
  });
}

/* Count the two shells by the elements each actually creates. The customer shell is
   shared-header.js's #sk-top-nav / #sk-bottom-nav; the merchant shell is merchant.html's
   own static .mtop / #mbnav. */
const COUNT = () => ({
  customerHeader: document.querySelectorAll('#sk-top-nav, .sk-top-nav, header.sk-header').length,
  customerNav: document.querySelectorAll('#sk-bottom-nav, .sk-bottom-nav, nav.sk-bottomnav').length,
  merchantHeader: document.querySelectorAll('header.mtop').length,
  merchantNav: document.querySelectorAll('nav#mbnav, nav.mbnav').length,
  horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
});

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { console.error('\n  playwright required\n'); process.exit(2); }

  const server = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: IPHONE });

  async function probe(url) {
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 160)));
    await p.goto('http://localhost:' + PORT + url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(2500);
    const c = await p.evaluate(COUNT);
    await p.close();
    return { ...c, errs };
  }

  const show = (n, r) => console.log('    ' + n.padEnd(34) +
    'custHdr=' + r.customerHeader + ' custNav=' + r.customerNav +
    '  mrcHdr=' + r.merchantHeader + ' mrcNav=' + r.merchantNav);

  try {
    head('A · EMBEDDED — the customer shell must not mount');
    const eSell = await probe('/sell.html?shell=merchant');
    const eBiz = await probe('/business.html?shell=merchant&id=demo');
    show('sell.html?shell=merchant', eSell);
    show('business.html?shell=merchant', eBiz);
    ok('embedded Sell mounts NO customer header', eSell.customerHeader === 0, String(eSell.customerHeader));
    ok('embedded Sell mounts NO customer bottom nav', eSell.customerNav === 0, String(eSell.customerNav));
    ok('embedded Business mounts NO customer header', eBiz.customerHeader === 0, String(eBiz.customerHeader));
    ok('embedded Business mounts NO customer bottom nav', eBiz.customerNav === 0, String(eBiz.customerNav));

    head('B · STANDALONE — the customer shell MUST still mount (the control)');
    const sSell = await probe('/sell.html');
    const sBiz = await probe('/business.html?id=demo');
    show('sell.html (standalone)', sSell);
    show('business.html (standalone)', sBiz);
    ok('standalone Sell still gets its customer header', sSell.customerHeader >= 1,
       'the shared-header change broke ordinary marketplace pages');
    ok('standalone Business still gets its customer header', sBiz.customerHeader >= 1,
       'the shared-header change broke ordinary marketplace pages');
    ok('the fix is CONDITIONAL, not a global disable',
       sSell.customerHeader >= 1 && eSell.customerHeader === 0,
       'standalone=' + sSell.customerHeader + ' embedded=' + eSell.customerHeader);

    head('C · the merchant shell itself');
    const m = await probe('/merchant.html');
    show('merchant.html', m);
    ok('merchant.html has exactly ONE merchant header', m.merchantHeader === 1, String(m.merchantHeader));
    ok('merchant.html has exactly ONE merchant bottom nav', m.merchantNav === 1, String(m.merchantNav));
    ok('merchant.html mounts NO customer bottom nav', m.customerNav === 0, String(m.customerNav));

    head('D · existing opt-out still honoured (no regression for declared pages)');
    const plans = await probe('/plans.html?shell=merchant');
    ok('plans.html (data-no-header) still suppresses the customer header',
       plans.customerHeader === 0, String(plans.customerHeader));

    head('E · iPhone viewport — no horizontal overflow');
    ok('embedded Sell has no horizontal overflow', !eSell.horizontalOverflow);
    ok('merchant.html has no horizontal overflow', !m.horizontalOverflow);

    head('F · no uncaught exceptions on the repaired routes');
    ok('embedded Sell raised no page error', eSell.errs.length === 0, eSell.errs.slice(0, 2).join(' | '));
    ok('merchant.html raised no page error', m.errs.length === 0, m.errs.slice(0, 2).join(' | '));
  } catch (e) {
    fail++; failures.push('probe error: ' + (e && e.message));
    console.error('  probe error: ' + (e && e.message));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'merchant shell boundary: ' + pass + '/' + (pass + fail) + '\x1b[0m\n');
  process.exit(fail ? 1 : 0);
})();
