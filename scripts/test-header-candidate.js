#!/usr/bin/env node
/* test-header-candidate.js — the header asks, in a real browser, on this line.
 *   H1 no top-left back button on a non-buyer workspace page
 *   H2 actions row: cart before the bell; no ⚡ Activity button
 *   H3 menu drawer header: logo link first, no wordmark, close ✕ is the LAST child
 *   H4 quick-action palette: a visible ✕ closes it; Escape closes it from the list (not the input)
 *   H5 home page static nav matches (cart before bell, no ⚡)
 * Hermetic: fake host from disk, other origins aborted; a stub firebase so nothing reaches production.
 *   node scripts/test-header-candidate.js
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
(async () => {
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
  const srv = http.createServer((rq, rs) => { const u = decodeURIComponent(rq.url.split('?')[0]); let fp = path.join(ROOT, u === '/' ? 'index.html' : u); if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html'; if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(rs); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    /* a seller identity in localStorage so the nav engine takes the non-buyer branch (where the back button used to be built) */
    try { localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'u1', name: 'Test', roles: ['seller'], role: 'seller', isSeller: true })); localStorage.setItem('sokoniRole', 'seller'); } catch (_) {}
    const fns = { httpsCallable: () => () => Promise.resolve({ data: {} }) };
    window.firebase = { apps: [{}], initializeApp() {}, app: () => ({ functions: () => fns }), functions: () => fns, auth: () => ({ currentUser: null, onAuthStateChanged(cb) { cb(null); } }), firestore: () => ({ collection: () => ({ doc: () => ({ get: () => Promise.resolve({ exists: false }), onSnapshot: () => () => {} }), where: () => ({ onSnapshot: () => () => {}, get: () => Promise.resolve({ docs: [], size: 0 }) }) }) }) };
  });
  await page.goto(base + '/services.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const nav = await page.evaluate(() => {
    const top = document.getElementById('sk-top-nav');
    const kids = top ? Array.from(top.querySelectorAll('#sk-nav-actions > *')).map((e) => e.id || e.className) : [];
    return { hasNav: !!top, back: !!document.getElementById('sk-nav-back-btn'), activity: !!document.getElementById('sk-activity-btn'), kids,
      cartIdx: kids.findIndex((k) => k === 'sk-nav-cart'), bellIdx: kids.findIndex((k) => k === 'sk-notif-btn') };
  });
  ck('H0  shared header rendered', nav.hasNav, nav);
  ck('H1  no top-left back button', nav.back === false, nav);
  ck('H2  cart sits before the bell; no ⚡ Activity button', nav.cartIdx >= 0 && nav.bellIdx > nav.cartIdx && nav.activity === false, nav);
  await page.evaluate(() => { try { window._skOpenMenu(document.getElementById('sk-menu-btn')); } catch (_) {} });
  await page.waitForTimeout(700);
  const drawer = await page.evaluate(() => {
    const h = document.getElementById('sk-menu-head'); if (!h) return { head: false };
    const kids = Array.from(h.children).map((e) => e.id || e.className);
    const img = document.querySelector('#sk-menu-logo img');
    return { head: true, kids, first: kids[0], last: kids[kids.length - 1], wordmark: /SOKO/.test(h.textContent), imgH: img ? img.getBoundingClientRect().height : 0 };
  });
  ck('H3  drawer header: logo link first, no wordmark text, close ✕ last (right corner), logo ≥ 48px tall', drawer.head && drawer.first === 'sk-menu-logo' && /sk-drawer-close/.test(drawer.last) && drawer.wordmark === false && drawer.imgH >= 48, drawer);
  await page.evaluate(() => { try { window.SokoniDrawer && window.SokoniDrawer.close('sk-menu-drawer'); } catch (_) {} });
  await page.evaluate(() => { window.SokoniCP && window.SokoniCP.open(); });
  await page.waitForTimeout(400);
  const cp1 = await page.evaluate(() => { const o = document.getElementById('sk-cp'); const b = document.getElementById('sk-cp-close'); return { open: !!o && o.classList.contains('sk-cp-open'), btn: !!b, visible: !!b && b.getBoundingClientRect().width >= 36 }; });
  ck('H4a palette opens with a visible ✕ (≥36px)', cp1.open && cp1.btn && cp1.visible, cp1);
  await page.evaluate(() => document.getElementById('sk-cp-close').click());
  await page.waitForTimeout(300);
  const cp2 = await page.evaluate(() => document.getElementById('sk-cp').classList.contains('sk-cp-open'));
  ck('H4b ✕ closes it', cp2 === false, cp2);
  await page.evaluate(() => { window.SokoniCP.open(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.getElementById('sk-cp-list').focus(); document.activeElement.blur(); });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const cp3 = await page.evaluate(() => document.getElementById('sk-cp').classList.contains('sk-cp-open'));
  ck('H4c Escape closes it when the input is not focused', cp3 === false, cp3);
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const home = await page.evaluate(() => { const kids = Array.from(document.querySelectorAll('#sk-nav-actions > *')).map((e) => e.id); return { kids, cart: kids.indexOf('sk-nav-cart'), bell: kids.indexOf('sk-notif-btn'), activity: kids.includes('sk-activity-btn') }; });
  ck('H5  home page static nav: cart before bell, no ⚡', home.cart >= 0 && home.bell > home.cart && !home.activity, home);
  await browser.close(); srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
