#!/usr/bin/env node
/* ================================================================
   SOKONI Store — operator-only workspace, REAL BROWSER certification
   scripts/test-first-party-store-operator.js

   QUEUED — written 2026-10-01 under a BROWSER HOLD. Not yet run.

   HERMETIC. The repo is served from disk under a fake host; every other
   origin is aborted. firebase.js and the two gstatic modules the workspace
   imports (firebase-auth, firebase-functions) are replaced by fixtures, so
   the persona and the server's answer are fixed by the test and NOTHING can
   reach production. The fixture callable records every call by name.

   Holds:
     1. operator (?store=sokoni) → workspace rendered; gate called FIRST, then
        wallet/orders/products; merchant chrome (.app) never visible.
     2. admin-not-operator → "Access denied — the SOKONI Store is operated by
        its owner"; exactly ONE call (the gate); zero store reads; no store
        text ever painted (sampled every animation frame from first paint).
     3. superAdmin-not-operator → same as 2.
     4. AdminOS and Super Admin sidebars both carry the entry and it navigates
        to merchant-v2.html?store=sokoni.
     5. 390x844 and 1280x800: no horizontal page scroll in either state.
   Negative control: served merchant-v2.html with the boot guard removed must
   show the merchant chrome in store mode (check 1 turns red).

   Run:  node scripts/test-first-party-store-operator.js
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOST = 'sokoni-cert.test';

function playwright() {
  for (const c of [path.join(ROOT, 'node_modules', 'playwright'), path.join('C:/Users/USER1/OneDrive/Desktop/SOKONI', 'node_modules', 'playwright')]) {
    try { return require(c); } catch (_) { /* next */ }
  }
  console.error('HARNESS: playwright not found'); process.exit(2);
}
const { chromium } = playwright();

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); } };

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp' };

/* Persona + server answer, injected into the page before any script runs. */
function fixtureInit(persona) {
  window.__SKS_CALLS = [];
  window.__SKS_PERSONA = persona;
}
const FIREBASE_JS = `window.firebaseApp = { name: 'fixture' }; window.firebaseAuth = { currentUser: null };
window.__sokoniAppCheckReady = Promise.resolve(); window.__sokoniFirebaseReady = true;`;
const AUTH_MOD = `export function onAuthStateChanged(auth, cb) {
  const p = window.__SKS_PERSONA; setTimeout(() => cb(p && p.uid ? { uid: p.uid, email: p.email } : null), 10); return () => {};
}
export function getAuth() { return window.firebaseAuth; }`;
const FN_MOD = `export function getFunctions() { return {}; }
export function httpsCallable(_f, name) {
  return async function () {
    window.__SKS_CALLS.push(name);
    const p = window.__SKS_PERSONA || {};
    if (!p.operator) { const e = new Error('Access denied — the SOKONI Store is operated by its owner.'); e.code = 'functions/permission-denied'; e.details = { reason: 'not-store-operator' }; throw e; }
    if (name === 'sokoniStoreGetContext') return { data: { ok: true, operator: true, storeId: 'STR_147f5ce11b424ec4bb892519', businessId: 'SOK-XX2338', businessName: 'SOKONI Store', profile: { name: 'SOKONI Store', phone: '+254705726803' }, payoutDestination: { status: 'unavailable' } } };
    if (name === 'sokoniStoreGetWallet') return { data: { ok: true, storeWallet: { exists: false } } };
    if (name === 'sokoniStoreListOrders') return { data: { ok: true, orders: [{ id: 'o1', status: 'paid', total: 500, createdAt: 1 }] } };
    if (name === 'sokoniStoreListProducts') return { data: { ok: true, products: [{ id: 'p1', name: 'STORE-SENTINEL-PRODUCT', price: 500, stock: null }] } };
    return { data: {} };
  };
}`;

function router(overrides) {
  return async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com' && /firebase-auth\.js$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: AUTH_MOD });
    if (url.hostname === 'www.gstatic.com' && /firebase-functions\.js$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: FN_MOD });
    if (url.hostname !== HOST) return route.abort();
    let rel = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'index.html';
    if (rel === 'firebase.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: FIREBASE_JS });
    if (overrides && overrides[rel]) return route.fulfill({ status: 200, contentType: MIME[path.extname(rel)] || 'text/plain', body: overrides[rel] });
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  };
}

async function openStore(browser, persona, viewport, overrides) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await ctx.addInitScript(fixtureInit, persona);
  /* Sample every frame from first paint: did store text or merchant chrome ever show? */
  await ctx.addInitScript(() => {
    window.__SKS_SEEN = { storeText: false, chrome: false };
    const sample = () => {
      try {
        const t = document.body ? document.body.innerText || '' : '';
        if (/STORE-SENTINEL-PRODUCT|Store wallet|Store profile/.test(t)) window.__SKS_SEEN.storeText = true;
        const app = document.querySelector('.app');
        if (app && getComputedStyle(app).display !== 'none' && app.getBoundingClientRect().height > 0) window.__SKS_SEEN.chrome = true;
      } catch (_) {}
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await ctx.route('**/*', router(overrides));
  const page = await ctx.newPage();
  await page.goto('https://' + HOST + '/merchant-v2.html?store=sokoni', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => { const r = document.getElementById('sokoni-store-root'); return r && /data-sks-state="(workspace|denied)"/.test(r.innerHTML); }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  return { ctx, page };
}

(async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.error('HARNESS: cannot launch Chromium', e.message); process.exit(2); }
  const OPERATOR = { uid: 'D5Ql2EYr95bt79IpcGTmOMTK0P83', email: 'alexochieng3030@gmail.com', operator: true };
  const ADMIN = { uid: 'adminUid', email: 'ochiisaac@example.test', operator: false };
  const SUPER = { uid: 'superUid', email: 'super@example.test', operator: false };

  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const tag = vp.width + 'px';
    /* 1 operator */
    let { ctx, page } = await openStore(browser, OPERATOR, vp);
    let st = await page.evaluate(() => ({ calls: window.__SKS_CALLS, seen: window.__SKS_SEEN, html: document.getElementById('sokoni-store-root').innerHTML, sx: document.documentElement.scrollWidth > window.innerWidth + 1 }));
    ok(`1 ${tag} operator sees the workspace`, /data-sks-state="workspace"/.test(st.html));
    ok(`1 ${tag} gate called first, then wallet/orders/products`, st.calls[0] === 'sokoniStoreGetContext' && ['sokoniStoreGetWallet', 'sokoniStoreListOrders', 'sokoniStoreListProducts'].every((n) => st.calls.includes(n)), st.calls);
    ok(`1 ${tag} merchant chrome never visible in store mode`, st.seen.chrome === false);
    ok(`5 ${tag} operator: no horizontal page scroll`, st.sx === false);
    await ctx.close();
    /* 2, 3 admin / superAdmin not operator */
    for (const [label, persona] of [['admin', ADMIN], ['superAdmin', SUPER]]) {
      ({ ctx, page } = await openStore(browser, persona, vp));
      st = await page.evaluate(() => ({ calls: window.__SKS_CALLS, seen: window.__SKS_SEEN, text: document.body.innerText, sx: document.documentElement.scrollWidth > window.innerWidth + 1 }));
      ok(`2 ${tag} ${label}: Access denied shown`, /Access denied — the SOKONI Store is operated by its owner/.test(st.text));
      ok(`2 ${tag} ${label}: exactly one call (the gate), zero store reads`, st.calls.join() === 'sokoniStoreGetContext', st.calls);
      ok(`2 ${tag} ${label}: no store data ever painted (every frame)`, st.seen.storeText === false);
      ok(`2 ${tag} ${label}: no merchant chrome ever painted`, st.seen.chrome === false);
      ok(`5 ${tag} ${label}: no horizontal page scroll`, st.sx === false);
      await ctx.close();
    }
  }

  /* 4 both sidebars carry the entry and it lands on the store URL */
  for (const pg of ['admin-os.html', 'super-admin.html']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    await ctx.route('**/*', router());
    const page = await ctx.newPage();
    await page.goto('https://' + HOST + '/' + pg, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const href = await page.evaluate(() => { const a = document.querySelector('a.nav-item[data-sokoni-store]'); return a && a.getAttribute('href'); });
    ok(`4 ${pg}: sidebar carries the SOKONI Store entry`, href === 'merchant-v2.html?store=sokoni', href);
    await ctx.close();
  }

  /* Negative control: remove the boot guard in the SERVED file → chrome must show. */
  const sabotaged = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8')
    .replace('if (window.__SOKONI_STORE_MODE === true) return;', '/* guard removed */')
    .replace('html[data-sokoni-store] .app,html[data-sokoni-store] .bnav{display:none!important}', '');
  const nc = await openStore(browser, OPERATOR, { width: 1280, height: 800 }, { 'merchant-v2.html': sabotaged });
  const ncSeen = await nc.page.evaluate(() => window.__SKS_SEEN);
  ok('NC sabotage (guard + CSS removed) makes the merchant chrome visible — the check can fail', ncSeen.chrome === true);
  await nc.ctx.close();

  await browser.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH (not a pass):', e && (e.stack || e)); process.exit(2); });
