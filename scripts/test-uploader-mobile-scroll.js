/* ══════════════════════════════════════════════════════════════════════════════
   UPLOADER — MOBILE SCROLL GATE  (merchant-v2 → route `products` → Add a product)
   ══════════════════════════════════════════════════════════════════════════════
   Owner report (2026-09-30, a phone): "the uploader page is still not scrollable to
   bottom — the keyboard makes it hard to read the bottom control".

   The uploader is the products module's bottom sheet: `.pr-sheet` (position:fixed) holding
   `.pr-panel[role=dialog]`, which is the ONE scroller. This gate opens the REAL shell
   (merchant-v2.html#products) in a hermetic Chromium — every external origin is refused,
   the Firebase modular SDK is replaced by stub modules (auth = a merchant-owner stub,
   Firestore = async empty snapshots, callables = {data:{}} or a named reply) — and asks,
   at phone widths and with the soft keyboard simulated two ways:

     A  the scroller is identifiable, taller than its box, and scrollTop reaches both its
        maximum and 0 — no nested vertical scroller traps the gesture, no negative margin
        traps the top;
     B  the primary action (Add product) sits in normal flow AFTER the last field, is
        ≥44px tall, is not sticky/fixed, and after scrollIntoView it is the element under
        its own centre (nothing fixed covers it);
     C  with the visual viewport shrunk to 420px — (1) the viewport itself resized, the way
        Chrome/Android `interactive-widget=resizes-content` behaves, and (2) the LAYOUT
        viewport left at 800 while window.visualViewport reports 420, the way iOS Safari
        and default Chrome/Android behave — the sheet ends at the keyboard's top edge and a
        focused field near the bottom, then the action, scrollIntoView above the keyboard;
     D  no horizontal overflow at 360 and 390; every control in the sheet is ≥44px tall;
     N  NEGATIVE CONTROL: a fixed 120px bar injected over the bottom, with the sheet's
        bottom padding removed, makes the occlusion check FAIL — proving the check sees
        what the merchant sees rather than trusting geometry alone.

   Nothing is fabricated: the module renders an EMPTY catalogue (the stub Firestore answers
   with zero documents), and the writer is never invoked — no field is submitted.

   Run: node scripts/test-uploader-mobile-scroll.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label +
    (detail !== undefined && detail !== null ? '   [' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ']' : ''));
  ok ? pass++ : fail++;
  return !!ok;
};

/* ── Stub SDK modules (served in place of gstatic) ────────────────────────────── */
const GSTATIC = 'https://www.gstatic.com/firebasejs/10.12.2/';
const STUB = {
  'firebase-app.js':
    "const apps=[];export function initializeApp(o){const a={name:'[DEFAULT]',options:o||{}};apps.push(a);return a}" +
    'export function getApps(){return apps}export function getApp(){return apps[0]}',
  'firebase-auth.js':
    "const USER={uid:'owner-stub',email:'owner@example.test',getIdToken:()=>Promise.resolve('stub-token')};" +
    'export function getAuth(){return {currentUser:USER}}' +
    'export function onAuthStateChanged(a,cb){setTimeout(()=>cb(USER),0);return()=>{}}' +
    'export function signOut(){return Promise.resolve()}' +
    'export function setPersistence(){return Promise.resolve()}export const browserLocalPersistence={};',
  'firebase-firestore.js':
    'function snapFor(p){const d=(window.__stubDocs||{})[p];return {id:p.split("/").pop(),ref:{path:p},exists:()=>!!d,data:()=>d?Object.assign({},d):undefined}}' +
    'const EMPTY=()=>({docs:[],empty:true,size:0,forEach(){}});' +
    'export function getFirestore(){return {__db:true}}' +
    "export function doc(db,...p){return {type:'doc',path:p.join('/'),id:p[p.length-1]}}" +
    "export function collection(db,...p){return {type:'col',path:p.join('/')}}" +
    'export function query(c){return c}export function where(){return {}}export function orderBy(){return {}}export function limit(){return {}}export function startAfter(){return {}}' +
    'export function getDoc(r){return new Promise(res=>setTimeout(()=>res(snapFor(r.path)),0))}' +
    'export function getDocs(){return new Promise(res=>setTimeout(()=>res(EMPTY()),0))}' +
    'export function onSnapshot(q,cb){setTimeout(()=>cb(EMPTY()),0);return()=>{}}' +
    'export function setDoc(){return Promise.resolve()}export function updateDoc(){return Promise.resolve()}export function deleteDoc(){return Promise.resolve()}' +
    "export function addDoc(){return Promise.resolve({id:'stub'})}" +
    'export function runTransaction(db,fn){return Promise.resolve(fn({get:(r)=>Promise.resolve(snapFor(r.path)),set(){},update(){},delete(){}}))}' +
    'export function writeBatch(){return {set(){},update(){},delete(){},commit(){return Promise.resolve()}}}' +
    'export function serverTimestamp(){return new Date()}export function increment(n){return n}export function arrayUnion(...a){return a}' +
    'export const Timestamp={now:()=>new Date(),fromDate:(d)=>d,fromMillis:(m)=>new Date(m)};',
  'firebase-functions.js':
    'export function getFunctions(){return {}}' +
    'export function httpsCallable(f,name){return (payload)=>{(window.__calls=window.__calls||[]).push({name,payload});' +
    'const r=(window.__reply||{})[name];return new Promise(res=>setTimeout(()=>res({data:r===undefined?{}:r}),0))}}',
  'firebase-app-check.js':
    'export function initializeAppCheck(){return {}}export class ReCaptchaV3Provider{constructor(){}}' +
    "export function getToken(){return Promise.resolve({token:''})}",
  'firebase-storage.js':
    'export function getStorage(){return {}}export function ref(){return {}}' +
    'export function uploadBytes(){return Promise.resolve({})}export function uploadBytesResumable(){return {on(){},then(){}}}' +
    "export function getDownloadURL(){return Promise.resolve('')}export function deleteObject(){return Promise.resolve()}",
};
/* Replaces /firebase.js — the real one imports gstatic (refused here) and App Check. */
const FIREBASE_JS_STUB =
  "import { initializeApp } from '" + GSTATIC + "firebase-app.js';" +
  "import { getAuth } from '" + GSTATIC + "firebase-auth.js';" +
  "import { getFirestore } from '" + GSTATIC + "firebase-firestore.js';" +
  "import { getFunctions, httpsCallable } from '" + GSTATIC + "firebase-functions.js';" +
  "const app=initializeApp({projectId:'stub'});window.firebaseApp=app;window.firebaseAuth=getAuth(app);" +
  'window.firebaseDB=getFirestore(app);window.firebaseFunctions=getFunctions(app);' +
  'window.sokoniCallable=(n)=>httpsCallable(window.firebaseFunctions,n);' +
  'window.waitForFirebaseReady=(cb)=>{cb&&cb();};window.waitForSokoniAuthReady=(cb)=>{cb&&cb(window.firebaseAuth.currentUser);};' +
  'window.__sokoniAppCheckReady=Promise.resolve();';

/* What the stub backend answers. Only what the shell needs to resolve an OWNER session
   and mount the products module — nothing else exists, and no figure is invented. */
const INIT = `
  window.__stubDocs = { 'shops/owner-stub': { name: 'Stub Shop', status: 'active' } };
  window.__reply = {
    merchantIdentity: { capabilities: ['sell'], servedBy: 'stub', shop: { name: 'Stub Shop' } },
    resolveMerchantContext: { resolved: true, merchantId: 'owner-stub', name: 'Stub Shop', choices: [] },
    getMerchantEntitlements: { active: true, uploadLimit: -1, uploadsUsed: 0, uploadsRemaining: -1, premium: false },
    canPublishProduct: { ok: true, allowed: true },
  };
  try { localStorage.setItem('loggedIn', 'true'); } catch (_) {}
`;
/* A faked visualViewport: the LAYOUT viewport stays put, the visual one reports what
   the test dictates — exactly the shape of a soft keyboard on iOS / Chrome-Android. */
const FAKE_VV = `
  (function () {
    var t = new EventTarget();
    Object.defineProperty(t, 'height', { get: function () { return window.__vvH || window.innerHeight; } });
    Object.defineProperty(t, 'width', { get: function () { return window.innerWidth; } });
    Object.defineProperty(t, 'offsetTop', { get: function () { return window.__vvT || 0; } });
    Object.defineProperty(t, 'offsetLeft', { get: function () { return 0; } });
    Object.defineProperty(t, 'pageTop', { get: function () { return window.__vvT || 0; } });
    Object.defineProperty(t, 'scale', { get: function () { return 1; } });
    Object.defineProperty(window, 'visualViewport', { get: function () { return t; }, configurable: true });
  })();
`;

/* ── Static server ─────────────────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant-v2.html';
  if (p === '/firebase.js') { res.writeHead(200, { 'Content-Type': MIME['.js'] }); return res.end(FIREBASE_JS_STUB); }
  /* No service worker, no crash-sentinel beacons in a hermetic run. */
  if (p === '/sw-register.js' || p === '/sokoni-crash-sentinel.js') { res.writeHead(200, { 'Content-Type': MIME['.js'] }); return res.end('/* stubbed for the hermetic gate */'); }
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(d);
  });
});

const WATCHDOG_MS = Number(process.env.UPLOADER_GATE_TIMEOUT_MS || 120000);
const wd = setTimeout(() => { console.log('\nTIMEOUT after ' + WATCHDOG_MS + 'ms — NOT a pass'); process.exit(2); }, WATCHDOG_MS);
wd.unref && wd.unref();

/* ── In-page probes (serialised into page.evaluate) ────────────────────────── */
const SEL = { sheet: '.pr-sheet', panel: '.pr-panel[role="dialog"]', save: '.pr-panel .pr-save', add: '#panel-products [data-pr="add"]' };

function probe () {
  const panel = document.querySelector('.pr-panel[role="dialog"]');
  const sheet = panel && panel.closest('.pr-sheet');
  if (!panel) return { found: false };
  const fields = Array.from(panel.querySelectorAll('[data-pf]')).filter((el) => el.tagName !== 'BUTTON');
  const lastField = fields[fields.length - 1] || null;
  const save = panel.querySelector('.pr-save');
  const foot = save && save.parentElement;
  const nested = Array.from(panel.querySelectorAll('*')).filter((el) => {
    const cs = getComputedStyle(el);
    return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
  }).map((el) => el.className);
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height), w: Math.round(b.width) }; };
  const small = Array.from(panel.querySelectorAll('button, input, select, textarea, label.pr-pickbtn'))
    .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 2 && b.height > 2; })   /* clipped file inputs are 1px by design */
    .filter((el) => el.getBoundingClientRect().height < 44)
    .map((el) => (el.tagName + '.' + el.className + ':' + Math.round(el.getBoundingClientRect().height)));
  return {
    found: true,
    sheet: r(sheet), panel: r(panel),
    scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, scrollTop: panel.scrollTop,
    scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth,
    overflowY: getComputedStyle(panel).overflowY, overscroll: getComputedStyle(panel).overscrollBehaviorY,
    docScrollW: document.documentElement.scrollWidth, innerW: innerWidth, innerH: innerHeight,
    nested,
    lastField: lastField && { pf: lastField.getAttribute('data-pf'), rect: r(lastField) },
    save: save && { rect: r(save), position: getComputedStyle(foot).position, afterLastField: !!(lastField && (lastField.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING)) },
    small,
    fieldCount: fields.length,
  };
}
function scrollTo (which) {
  const panel = document.querySelector('.pr-panel[role="dialog"]');
  panel.scrollTop = which === 'max' ? panel.scrollHeight : 0;
  return { scrollTop: panel.scrollTop, max: panel.scrollHeight - panel.clientHeight };
}
/* The occlusion test: bring the control into view, then ask what is actually under its
   centre. Geometry inside the scroller is not enough — a fixed bar over the bottom of the
   screen leaves every rect intact and still hides the button from the merchant. */
function reach (sel, vvH) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, why: 'missing ' + sel };
  el.scrollIntoView({ block: 'nearest' });
  const b = el.getBoundingClientRect();
  const panel = el.closest('.pr-panel');
  const pb = panel.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const under = document.elementFromPoint(cx, cy);
  const hit = !!(under && (under === el || el.contains(under)));
  const limit = vvH || innerHeight;
  return {
    ok: hit && b.bottom <= limit + 0.5 && b.top >= pb.top - 0.5 && b.bottom <= pb.bottom + 0.5,
    hit, top: Math.round(b.top), bottom: Math.round(b.bottom), limit, panelBottom: Math.round(pb.bottom),
    under: under ? (under.tagName + '.' + (under.className || '') + '#' + (under.id || '')) : null,
  };
}

/* ── The walk ──────────────────────────────────────────────────────────────── */
server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let chromium;
  try { ({ chromium } = require(path.join(ROOT, 'node_modules', 'playwright'))); }
  catch (e) { console.log('SKIP — playwright not resolvable: ' + e.message + ' (NOT a pass)'); server.close(); process.exit(2); return; }
  const browser = await chromium.launch();
  const pageErrors = [];

  async function openUploader (opts) {
    const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await ctx.addInitScript(INIT + (opts.fakeVV ? FAKE_VV : ''));
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE)) return route.continue();
      if (url.startsWith(GSTATIC)) {
        const name = url.slice(GSTATIC.length).split('?')[0];
        if (STUB[name]) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB[name] });
      }
      return route.abort();                       /* every other origin is refused */
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    await page.goto(BASE + '/merchant-v2.html#products', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SEL.add, { timeout: 20000 });
    await page.click(SEL.add, { force: true });
    await page.waitForSelector(SEL.panel, { timeout: 5000 });
    await page.waitForTimeout(120);
    return { ctx, page };
  }

  try {
    /* ── 390x800, then the viewport itself shrunk to 420 ───────────────────── */
    console.log('\n  ── 390x800: the sheet and its ONE scroller ──');
    let { ctx, page } = await openUploader({ width: 390, height: 800 });
    let p = await page.evaluate(probe);
    ck('A1  uploader sheet open in the real shell: .pr-panel[role=dialog] found with fields', p.found && p.fieldCount >= 6, p.found ? { fields: p.fieldCount } : p);
    ck('A2  the panel is the ONE scroller: overflow-y auto, overscroll contained (measured, not assumed)', p.found && p.overflowY === 'auto' && p.overscroll === 'contain', { overflowY: p.overflowY, overscroll: p.overscroll, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight });
    ck('A3  no nested vertical scroller inside the panel (no scroll trap)', p.found && p.nested.length === 0, p.nested);
    let s = await page.evaluate(scrollTo, 'max');
    ck('A4  scrollTop reaches its maximum', Math.abs(s.scrollTop - s.max) <= 1, s);
    s = await page.evaluate(scrollTo, 'top');
    ck('A5  scrollTop returns to 0 (top reachable)', s.scrollTop === 0, s);
    let rr = await page.evaluate(reach, '.pr-panel [data-pf="name"]');
    ck('A6  first field visible and hit-testable at the top (no negative-margin trap)', rr.ok, rr);
    ck('B1  primary action (Add product) is in DOM flow AFTER the last field', p.save && p.save.afterLastField, p.lastField && p.lastField.pf);
    ck('B2  the action row is static flow (not sticky, not fixed)', p.save && p.save.position === 'static', p.save && p.save.position);
    ck('B3  Add product is ≥44px tall', p.save && p.save.rect.h >= 44, p.save && p.save.rect);
    rr = await page.evaluate(reach, SEL.save);
    ck('B4  scrollIntoView brings Add product fully into the sheet and it is the element under its centre', rr.ok, rr);
    ck('B5  the sheet fills the visual viewport height (bottom edge = screen bottom)', p.sheet && Math.abs(p.sheet.h - p.innerH) <= 1 && p.sheet.top === 0, p.sheet);
    ck('D1  no horizontal overflow at 390 (document and panel)', p.docScrollW <= p.innerW && p.scrollWidth <= p.clientWidth + 1, { docScrollW: p.docScrollW, innerW: p.innerW, panelScrollW: p.scrollWidth, panelClientW: p.clientWidth });
    ck('D2  every visible control in the sheet is ≥44px tall', p.small.length === 0, p.small);

    console.log('\n  ── keyboard (1): viewport resized 390x800 → 390x420 with the last field focused ──');
    await page.focus('.pr-panel [data-pf="status"]').catch(() => {});
    await page.setViewportSize({ width: 390, height: 420 });
    await page.waitForTimeout(150);
    p = await page.evaluate(probe);
    ck('C1  sheet now 420px tall at top 0 (follows the shrunken viewport)', p.sheet && Math.abs(p.sheet.h - 420) <= 1 && p.sheet.top === 0, p.sheet);
    ck('C2  panel scrolls (scrollHeight > clientHeight) at 420', p.scrollHeight > p.clientHeight, { scrollHeight: p.scrollHeight, clientHeight: p.clientHeight });
    rr = await page.evaluate(reach, '.pr-panel [data-pf="status"]');
    ck('C3  the focused field scrollIntoView lands fully above the 420 line', rr.ok && rr.bottom <= 420, rr);
    rr = await page.evaluate(reach, SEL.save);
    ck('C4  Add product scrollIntoView lands fully above the 420 line and is hit-testable', rr.ok && rr.bottom <= 420, rr);
    s = await page.evaluate(scrollTo, 'top');
    rr = await page.evaluate(reach, '.pr-panel [data-pf="name"]');
    ck('C5  back to the top at 420: first field visible', s.scrollTop === 0 && rr.ok, rr);

    /* ── NEGATIVE CONTROL ──────────────────────────────────────────────────── */
    console.log('\n  ── negative control: a fixed 120px bottom bar, no bottom padding ──');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const bar = document.createElement('div'); bar.id = 'neg-bar';
      bar.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;height:120px;z-index:2147483000;background:#f00');
      document.body.appendChild(bar);
      const st = document.createElement('style'); st.id = 'neg-css';
      st.textContent = '.pr-panel[role="dialog"]{padding-bottom:0 !important}';
      document.head.appendChild(st);
    });
    rr = await page.evaluate(reach, SEL.save);
    ck('N1  CONTROL: with the bar in place the reachability check FAILS (button occluded)', !rr.ok && rr.hit === false, rr);
    await page.evaluate(() => { document.getElementById('neg-bar').remove(); document.getElementById('neg-css').remove(); });
    rr = await page.evaluate(reach, SEL.save);
    ck('N2  CONTROL restored: the same check passes again once the bar is gone', rr.ok, rr);
    await ctx.close();

    /* ── keyboard (2): layout viewport 800, visualViewport says 420 (iOS / Android) ── */
    console.log('\n  ── keyboard (2): layout viewport stays 800, window.visualViewport reports 420 ──');
    ({ ctx, page } = await openUploader({ width: 390, height: 800, fakeVV: true }));
    p = await page.evaluate(probe);
    ck('C6  before the keyboard: sheet is 800 tall', p.sheet && Math.abs(p.sheet.h - 800) <= 1, p.sheet);
    await page.focus('.pr-panel [data-pf="status"]').catch(() => {});
    await page.evaluate(() => { window.__vvH = 420; window.visualViewport.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(120);
    p = await page.evaluate(probe);
    ck('C7  keyboard open: the sheet shrinks to the VISUAL viewport (420) while innerHeight stays 800', p.sheet && Math.abs(p.sheet.h - 420) <= 1 && p.innerH === 800, { sheet: p.sheet, innerH: p.innerH });
    rr = await page.evaluate(reach, '.pr-panel [data-pf="status"]', 420);
    ck('C8  the focused field scrollIntoView lands above the keyboard line (420)', rr.ok, rr);
    rr = await page.evaluate(reach, SEL.save, 420);
    ck('C9  Add product scrollIntoView lands above the keyboard line and is hit-testable', rr.ok, rr);
    await page.evaluate(() => { window.__vvT = 60; window.visualViewport.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(60);
    p = await page.evaluate(probe);
    ck('C10 iOS-style visual viewport offset: the sheet follows offsetTop', p.sheet && p.sheet.top === 60, p.sheet);
    await page.evaluate(() => { window.__vvH = 0; window.__vvT = 0; window.visualViewport.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(60);
    p = await page.evaluate(probe);
    ck('C11 keyboard closed: the sheet is 800 tall at top 0 again', p.sheet && Math.abs(p.sheet.h - 800) <= 1 && p.sheet.top === 0, p.sheet);
    await page.click('.pr-panel [data-pr="close"]', { force: true });
    await page.waitForTimeout(80);
    const cleared = await page.evaluate(() => { const h = document.querySelector('.sk-mprod'); return { vvh: h && h.style.getPropertyValue('--pr-vvh'), open: !!document.querySelector('.pr-sheet') }; });
    ck('C12 closing the sheet clears the viewport bindings from the host', !cleared.open && !cleared.vvh, cleared);
    await ctx.close();

    /* ── 360 wide ──────────────────────────────────────────────────────────── */
    console.log('\n  ── 360x800 ──');
    ({ ctx, page } = await openUploader({ width: 360, height: 800 }));
    p = await page.evaluate(probe);
    ck('D3  no horizontal overflow at 360', p.found && p.docScrollW <= p.innerW && p.scrollWidth <= p.clientWidth + 1, { docScrollW: p.docScrollW, innerW: p.innerW, panelScrollW: p.scrollWidth, panelClientW: p.clientWidth });
    ck('D4  controls ≥44px at 360', p.found && p.small.length === 0, p.small);
    rr = await page.evaluate(reach, SEL.save);
    ck('D5  Add product reachable at 360', rr.ok, rr);
    await ctx.close();

    const ours = pageErrors.filter((m) => !/App Check|appCheck|net::ERR|Failed to fetch/i.test(m));
    ck('E1  no uncaught page errors from the shell or the module', ours.length === 0, ours.slice(0, 5));
  } catch (e) {
    ck('HARNESS  completed without throwing', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    try { await browser.close(); } catch (_) {}
    server.close();
    clearTimeout(wd);
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
});
