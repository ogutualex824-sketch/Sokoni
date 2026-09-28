#!/usr/bin/env node
/* test-kass-widget-reachable.js — the KASS dialog's close button is on screen and tappable on every device class.
 *
 *   node scripts/test-kass-widget-reachable.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-kass-widget-reachable.js  # kass-widget.js @ 4e9607b — failures ARE the defect
 *
 * The REAL kass-widget.js is served (Playwright route, fake origin — no network, no Firebase) under a page with a
 * fixed site header at the platform's header z-index (100002) that publishes its measured height as --sk-header-h,
 * exactly as shared-header.js does. The dialog is opened with the real FAB handler, then, per viewport:
 *   R1  the close button lies fully inside the viewport and BELOW the header
 *   R2  document.elementFromPoint at the close button's centre IS the close button (nothing covers it)
 *   R3  the dialog's top edge is not under the header
 * The dialog is filled with a conversation first, so it reaches its max-height (an empty one never does).
 *   R5  on short screens (<= 520px tall) a full dialog is at least 220px tall — usable, not a sliver
 *   R4  a fixed header that does NOT publish --sk-header-h: the close button is still what a tap hits
 * Also, with the keyboard-open path (visual viewport shrunk) on iPhone SE:
 *   K1  the close button stays below the header and tappable
 * Engines: Chromium AND WebKit (iPhone Safari's engine). The header height is varied (58px, 80px search header).
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const BASE = '4e9607b', CPM = !!process.env.COUNTERPROOF;
const WIDGET = CPM ? cp.execFileSync('git', ['show', BASE + ':kass-widget.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 })
                   : fs.readFileSync(path.join(ROOT, 'kass-widget.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d) : '')); } };

const DEVICES = [
  ['iPhone SE 375x667', 375, 667, true],
  ['iPhone 14 390x844', 390, 844, true],
  ['iPhone 14 landscape 844x390', 844, 390, true],
  ['Android Pixel 7 412x915', 412, 915, true],
  ['Android small 360x640', 360, 640, true],
  ['Android 412x732 (Nexus 5X class)', 412, 732, true],
  ['iPad portrait 820x1180', 820, 1180, true],
  ['laptop 1366x768', 1366, 768, false],
  ['short laptop 1280x600', 1280, 600, false],
  ['desktop 1920x1080', 1920, 1080, false],
];
const page = (hdr, publish = true) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#000;color:#fff}#hdr{position:fixed;top:0;left:0;right:0;height:${hdr}px;background:#123;z-index:100002}
body{padding-top:${hdr}px;min-height:200vh}</style></head><body><div id="hdr">header</div><p>page</p>
${publish ? `<script>document.documentElement.style.setProperty('--sk-header-h','${hdr}px');</script>` : ''}
<script src="/kass-widget.js"></script></body></html>`;

/* A real conversation fills the dialog to its max-height — an empty dialog is content-sized and never reaches the
   header, which is why the defect only showed once people had chatted. */
const fillConversation = () => { const m = document.getElementById('kassMsgs'); for (let i = 0; i < 40; i++) { const d = document.createElement('div'); d.textContent = 'message ' + i; d.style.cssText = 'height:40px'; m.appendChild(d); } };
async function measure(pg, hdr) {
  return pg.evaluate((hdr) => {
    const c = document.getElementById('kassClose'), m = document.getElementById('kassModal');
    const r = c.getBoundingClientRect(), mr = m.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const at = document.elementFromPoint(cx, cy);
    return { vw: innerWidth, vh: innerHeight, close: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
      modalTop: Math.round(mr.top), modalH: Math.round(mr.height), hdr, hit: !!at && (at === c || c.contains(at)), hitWhat: at ? (at.id || at.tagName) : null };
  }, hdr);
}

(async () => {
  const pw = require('playwright');
  console.log('\nSOURCE: kass-widget.js @ ' + (CPM ? BASE + ' (before) — failures below ARE the defect' : 'working tree (fix)'));
  for (const engine of (process.env.ENGINES || 'chromium,webkit').split(',')) {
    const browser = await pw[engine].launch();
    try {
      for (const hdr of [58, 80]) {
        for (const [name, w, h, touch] of DEVICES) {
          const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: engine === 'chromium' ? touch : false });
          const pg = await ctx.newPage();
          await pg.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (u.pathname === '/kass-widget.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: WIDGET });
            if (u.pathname === '/' ) return route.fulfill({ status: 200, contentType: 'text/html', body: page(hdr) });
            return route.fulfill({ status: 404, body: '' });
          });
          await pg.goto('https://sokoni.test/');
          await pg.waitForSelector('#kassBtn', { state: 'attached', timeout: 10000 });
          /* open through the widget's own FAB handler (the FAB itself may be hidden by page CSS on short screens) */
          await pg.evaluate(() => document.getElementById('kassBtn').click());
          await pg.evaluate(fillConversation);
          await pg.waitForTimeout(450);
          const m = await measure(pg, hdr);
          const tag = `[${engine} · hdr ${hdr}px · ${name}]`;
          ck(`R1  close button fully on screen and below the header ${tag}`, m.close.top >= hdr && m.close.bottom <= m.vh && m.close.left >= 0 && m.close.right <= m.vw, m);
          ck(`R2  close button is what a tap at its centre hits ${tag}`, m.hit, { hit: m.hitWhat, close: m.close });
          ck(`R3  dialog top is not under the header ${tag}`, m.modalTop >= hdr, { modalTop: m.modalTop, hdr });
          /* R5 — usability, not reachability: on short screens a full conversation still gets a usable dialog */
          if (h <= 520) ck(`R5  short screen: a full dialog is at least 220px tall ${tag}`, m.modalH >= 220, { modalH: m.modalH });
          await ctx.close();
        }
      }
      /* R4: a page whose fixed header does NOT publish --sk-header-h (no shared header). The height cap cannot see
         that header, so the dialog may reach under it — the dialog must still sit ABOVE it, so its close button is
         what a tap hits. */
      for (const [name, w, h, touch] of DEVICES.filter((d) => /SE|landscape|short laptop/.test(d[0]))) {
        const hdr = 58;
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: engine === 'chromium' ? touch : false });
        const pg = await ctx.newPage();
        await pg.route('**/*', (route) => {
          const u = new URL(route.request().url());
          if (u.pathname === '/kass-widget.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: WIDGET });
          if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: page(hdr, false) });
          return route.fulfill({ status: 404, body: '' });
        });
        await pg.goto('https://sokoni.test/');
        await pg.waitForSelector('#kassBtn', { state: 'attached', timeout: 10000 });
        await pg.evaluate(() => document.getElementById('kassBtn').click());
        await pg.evaluate(fillConversation);
        await pg.waitForTimeout(450);
        const m = await measure(pg, hdr);
        ck(`R4  header without --sk-header-h: close button still on screen and what a tap hits [${engine} · ${name}]`, m.hit && m.close.top >= 0 && m.close.bottom <= m.vh, m);
        await ctx.close();
      }
      /* keyboard-open path: shrink the visual viewport the way the on-screen keyboard does, then run the handler */
      {
        const hdr = 64;
        const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true });
        const pg = await ctx.newPage();
        await pg.addInitScript(() => {
          const fake = { height: 667 - 300, width: 375, offsetTop: 0, addEventListener(t, f) { (window.__vvL = window.__vvL || []).push(f); } };
          Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
        });
        await pg.route('**/*', (route) => {
          const u = new URL(route.request().url());
          if (u.pathname === '/kass-widget.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: WIDGET });
          if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: page(hdr) });
          return route.fulfill({ status: 404, body: '' });
        });
        await pg.goto('https://sokoni.test/');
        await pg.waitForSelector('#kassBtn', { state: 'attached', timeout: 10000 });
        await pg.evaluate(() => document.getElementById('kassBtn').click());
        await pg.evaluate(fillConversation);
        await pg.waitForTimeout(450);
        /* the widget registers _handleViewport on visualViewport resize; our fake ignores listeners, so fire the same
           handler path the widget uses by dispatching a window resize after the fake is in place */
        await pg.evaluate(() => { (window.__vvL || []).forEach((f) => f()); });
        const fired = await pg.evaluate(() => { const m = document.getElementById('kassModal'); return m.style.bottom !== ''; });
        if (!fired) {
          /* the handler is private: re-run it through the only public trigger the widget listens to */
          ck(`K1  keyboard path reachable in test [${engine}]`, false, 'viewport handler could not be triggered — K1 UNPROVEN, not passed');
        } else {
          const m = await measure(pg, hdr);
          ck(`K1  keyboard open: close button below the header and tappable [${engine}]`, m.close.top >= hdr && m.hit, m);
        }
        await ctx.close();
      }
    } finally { await browser.close(); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
