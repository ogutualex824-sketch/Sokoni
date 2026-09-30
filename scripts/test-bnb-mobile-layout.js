#!/usr/bin/env node
/* test-bnb-mobile-layout.js — BnB category strip: mobile layout certification.
 *
 * Owner ask (2026-09-30): "fix the bnb mobile layout the categories buttons or card are in a mess".
 *
 * Hermetic: Chromium from node_modules/playwright, a local static server on a random port,
 * EVERY non-local origin aborted, firebase compat stubbed with ASYNC empty snapshots,
 * auth-guard.js / sokoni-routing.js stubbed (bnb-manage.html loads auth-guard, which redirects).
 * No production endpoint is touched; nothing is written anywhere.
 *
 * Pages × viewports: bnb.html (strip = .bnb-filter-bar), bnb-hub.html (strip = .bh-type-bar +
 * .bh-filter-row) at 360 / 390 / 768 / 1280. bnb-manage.html has NO category strip (its
 * .ll-sidebar is the host dashboard nav), so it gets the page-overflow check only.
 *
 * Assertions per page × viewport:
 *   O  no horizontal page overflow (documentElement.scrollWidth <= innerWidth)
 *   V  every category control is fully inside the viewport, OR inside a horizontally
 *      scrollable strip (overflow-x auto|scroll) within that strip's scroll extent
 *   X  no two category controls overlap (bounding boxes, 1px tolerance)
 *   H  on phones (< 768) every control is >= 40px tall
 *   L  the label is not clipped (scrollWidth <= clientWidth, scrollHeight <= clientHeight)
 *   R  the strip is reachable: elementFromPoint at each control's centre (after
 *      scrollIntoView) resolves to the control itself — nothing fixed covers it
 *   N  negative control: a deliberately broken strip is injected and O/V/X/H/L MUST fail
 *
 * BASELINE (0271709, before any change) — STATIC diagnosis 2026-09-30:
 *   bnb.html: .bnb-filter-bar was a flex-wrap row of six pills plus a right-aligned sort
 *   <select>; on phones the global select rules (font-size 16px, padding 12px 16px/36px,
 *   width:100% — style.css, mobile.css, sokoni-premium-v2.css) and the 44px button floor turned
 *   it into three uneven pill rows with the sort control stranded on a fourth, hugging the 28px
 *   desktop gutters. bnb-hub.html's .bh-type-bar was already an overflow-x:auto strip.
 *   BROWSER measurement of that baseline is done with SOKONI_BNB_ROOT pointing at a
 *   `git archive 0271709` export; the measured numbers are recorded in CHANGELOG.md
 *   (2026-09-30 BnB entry) — if that entry says "queued", the run has not happened yet.
 *
 * Env: SOKONI_BNB_ROOT=<dir> serves that tree instead of the repo (baseline measurement);
 *      SOKONI_PLAYWRIGHT_ROOT=<dir> is tried after ./node_modules for playwright.
 *
 * Usage: node scripts/test-bnb-mobile-layout.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
const ROOT = process.env.SOKONI_BNB_ROOT ? path.resolve(process.env.SOKONI_BNB_ROOT) : REPO;
const PW_CANDIDATES = [
  path.join(REPO, 'node_modules', 'playwright'),
  process.env.SOKONI_PLAYWRIGHT_ROOT ? path.join(path.resolve(process.env.SOKONI_PLAYWRIGHT_ROOT), 'node_modules', 'playwright') : null,
  'c:/Users/USER1/OneDrive/Desktop/SOKONI/node_modules/playwright',
].filter(Boolean);
let chromium = null;
for (const c of PW_CANDIDATES) { try { ({ chromium } = require(c)); break; } catch (_) { /* try next */ } }
if (!chromium) { console.error('FAIL  playwright not found in: ' + PW_CANDIDATES.join(', ')); process.exit(2); }

let pass = 0, fail = 0;
const ck = (label, ok, got) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 900) + ']'));
  ok ? pass++ : fail++;
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
const STUBBED = { '/auth-guard.js': '/* stubbed by test-bnb-mobile-layout */', '/sokoni-routing.js': '/* stubbed */', '/sokoni-init.js': '/* stubbed */', '/sokoni-mock-data.js': '/* stubbed: no demo fallback in the harness */', '/sokoni-dev-mock.js': '/* stubbed */' };

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      if (STUBBED[url] !== undefined) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(STUBBED[url]); return; }
      const rel = url === '/' ? '/index.html' : url;
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(''); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* Firebase compat stub — every read resolves ASYNC with an empty snapshot; no listener ever fires data. */
const FIREBASE_STUB = `
(function(){
  var emptySnap = { empty: true, size: 0, docs: [], forEach: function(){}, exists: false, data: function(){ return undefined; }, id: '' };
  function q(){ var o = {}; ['where','orderBy','limit','startAfter','startAt','endAt','collection','doc','collectionGroup'].forEach(function(k){ o[k] = function(){ return q(); }; });
    o.get = function(){ return new Promise(function(r){ setTimeout(function(){ r(emptySnap); }, 0); }); };
    o.onSnapshot = function(cb){ setTimeout(function(){ try { (typeof cb === 'function' ? cb : cb && cb.next || function(){})(emptySnap); } catch(e){} }, 0); return function(){}; };
    o.set = o.update = o.add = o.delete = function(){ return Promise.resolve(); };
    return o; }
  var db = q(); db.runTransaction = function(){ return Promise.resolve(); }; db.batch = function(){ return { set: function(){}, update: function(){}, delete: function(){}, commit: function(){ return Promise.resolve(); } }; };
  var auth = { currentUser: null, onAuthStateChanged: function(cb){ setTimeout(function(){ try { cb(null); } catch(e){} }, 0); return function(){}; }, signOut: function(){ return Promise.resolve(); } };
  var fb = { apps: [{}], initializeApp: function(){ return {}; }, app: function(){ return {}; }, firestore: function(){ return db; }, auth: function(){ return auth; }, functions: function(){ return { httpsCallable: function(){ return function(){ return Promise.resolve({ data: {} }); }; } }; }, storage: function(){ return {}; } };
  fb.firestore.FieldValue = { serverTimestamp: function(){ return 0; }, increment: function(n){ return n; }, arrayUnion: function(){ return []; } };
  fb.firestore.Timestamp = { now: function(){ return { toMillis: function(){ return Date.now(); } }; } };
  window.firebase = fb; window.firebaseDB = db; window.firebaseAuth = auth; window.db = db;
})();`;

/* Runs in the page. Returns the measured facts for a strip. */
function measureStrip({ stripSel, controlSel, phone }) {
  const vw = window.innerWidth;
  const out = { stripSel, present: false, offenders: { V: [], X: [], H: [], L: [], R: [] }, count: 0 };
  const strip = document.querySelector(stripSel);
  if (!strip) return out;
  out.present = true;
  const cs = getComputedStyle(strip);
  const scrollable = /auto|scroll/.test(cs.overflowX) && strip.scrollWidth > strip.clientWidth + 1;
  const sr = strip.getBoundingClientRect();
  const ctrls = Array.from(strip.querySelectorAll(controlSel)).filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
  out.count = ctrls.length;
  const sig = (el, i) => (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : '') + '[' + i + ']');
  const boxes = ctrls.map((el, i) => { const r = el.getBoundingClientRect(); return { i, s: sig(el, i), l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });
  boxes.forEach((bx, i) => {
    const el = ctrls[i];
    const insideViewport = bx.l >= -0.5 && bx.r <= vw + 0.5;
    const insideStrip = scrollable && bx.l >= sr.left - strip.scrollLeft - 0.5 && bx.r <= sr.left - strip.scrollLeft + strip.scrollWidth + 0.5;
    if (!(insideViewport || insideStrip)) out.offenders.V.push(bx.s + ' l=' + bx.l.toFixed(0) + ' r=' + bx.r.toFixed(0) + ' vw=' + vw + (scrollable ? ' (strip scrollable)' : ' (strip NOT scrollable)'));
    if (phone && bx.h < 40) out.offenders.H.push(bx.s + ' h=' + bx.h.toFixed(1));
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.offenders.L.push(bx.s + ' sw=' + el.scrollWidth + '/cw=' + el.clientWidth + ' sh=' + el.scrollHeight + '/ch=' + el.clientHeight);
  });
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
    const A = boxes[a], B = boxes[b];
    const ox = Math.min(A.r, B.r) - Math.max(A.l, B.l), oy = Math.min(A.b, B.b) - Math.max(A.t, B.t);
    if (ox > 1 && oy > 1) out.offenders.X.push(A.s + ' x ' + B.s + ' (' + ox.toFixed(0) + 'x' + oy.toFixed(0) + 'px)');
  }
  ctrls.forEach((el, i) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), r.top + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) out.offenders.R.push(boxes[i].s + ' covered by ' + (hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className ? '.' + String(hit.className).trim().split(/\s+/).slice(0, 2).join('.') : '') : 'nothing'));
  });
  window.scrollTo(0, 0);
  return out;
}

const PAGES = [
  { file: 'bnb.html', strips: [{ strip: '.bnb-filter-bar', controls: '.bnb-pill, #bnbSort', min: 7 }] },
  { file: 'bnb-hub.html', strips: [{ strip: '.bh-type-bar', controls: '.bh-type', min: 2 }, { strip: '.bh-filter-row', controls: '.bh-filter-sel, .bh-filter-btn, .bh-filter-reset', min: 5 }] },
  { file: 'bnb-manage.html', strips: [] },
];
const WIDTHS = [360, 390, 768, 1280];

/* Deliberately broken strip for the negative control: a fixed-width, nowrap, non-scrolling row
   of 20px-tall buttons with two absolutely positioned on top of each other and a clipped label. */
const BROKEN = `
  var d = document.createElement('div'); d.id = 'brokenStrip';
  d.style.cssText = 'display:flex;gap:4px;width:900px;flex-wrap:nowrap;overflow:visible;position:relative;';
  for (var i = 0; i < 8; i++) { var b = document.createElement('button'); b.className = 'broken-pill'; b.textContent = 'Category ' + i + ' with a very long label that cannot fit';
    b.style.cssText = 'height:20px;width:140px;white-space:nowrap;overflow:hidden;flex:none;padding:0 6px;'; if (i === 1) b.style.cssText += 'position:absolute;left:0;top:0;'; d.appendChild(b); }
  document.body.insertBefore(d, document.body.firstChild);`;

(async () => {
  const srv = await startServer();
  const port = srv.address().port;
  const ORIGIN = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch();
  const consoleErrors = [];
  try {
    for (const pg of PAGES) {
      for (const w of WIDTHS) {
        const phone = w < 768;
        const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 1 });
        await ctx.route('**/*', (route) => { const u = route.request().url(); if (u.startsWith(ORIGIN)) return route.continue(); return route.abort(); });
        await ctx.addInitScript(FIREBASE_STUB);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => consoleErrors.push(pg.file + '@' + w + ': ' + e.message));
        await page.goto(ORIGIN + '/' + pg.file, { waitUntil: 'load' });
        await page.waitForTimeout(600); /* splash.js dismissal + deferred scripts (shared-header) settle */
        const tag = pg.file + ' @' + w;
        const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, vw: window.innerWidth }));
        ck('O  ' + tag + '  no horizontal page overflow', ov.sw <= ov.vw && ov.bw <= ov.vw, ov);
        for (const s of pg.strips) {
          const m = await page.evaluate(measureStrip, { stripSel: s.strip, controlSel: s.controls, phone });
          ck('P  ' + tag + '  strip ' + s.strip + ' present with >= ' + s.min + ' controls', m.present && m.count >= s.min, { present: m.present, count: m.count });
          ck('V  ' + tag + '  ' + s.strip + ' every control inside viewport or a scrollable strip', m.offenders.V.length === 0, m.offenders.V);
          ck('X  ' + tag + '  ' + s.strip + ' no two controls overlap', m.offenders.X.length === 0, m.offenders.X);
          if (phone) ck('H  ' + tag + '  ' + s.strip + ' every control >= 40px tall', m.offenders.H.length === 0, m.offenders.H);
          ck('L  ' + tag + '  ' + s.strip + ' no clipped labels', m.offenders.L.length === 0, m.offenders.L);
          ck('R  ' + tag + '  ' + s.strip + ' every control reachable (nothing covers it)', m.offenders.R.length === 0, m.offenders.R);
        }
        /* Negative control on the first phone width of the first page only. */
        if (pg.file === 'bnb.html' && w === 360) {
          await page.evaluate(BROKEN);
          const nov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth }));
          const nm = await page.evaluate(measureStrip, { stripSel: '#brokenStrip', controlSel: '.broken-pill', phone: true });
          ck('N  negative control: broken strip makes O fail (page overflow detected)', nov.sw > nov.vw, nov);
          ck('N  negative control: broken strip makes V fail (control outside viewport, strip not scrollable)', nm.offenders.V.length > 0, nm.offenders.V);
          ck('N  negative control: broken strip makes X fail (overlap detected)', nm.offenders.X.length > 0, nm.offenders.X);
          ck('N  negative control: broken strip makes H fail (20px tall)', nm.offenders.H.length === 8, nm.offenders.H.length);
          ck('N  negative control: broken strip makes L fail (clipped label)', nm.offenders.L.length > 0, nm.offenders.L);
        }
        await ctx.close();
      }
    }
    ck('E  no uncaught page errors across all renders', consoleErrors.length === 0, consoleErrors);
  } finally {
    await browser.close();
    srv.close();
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
