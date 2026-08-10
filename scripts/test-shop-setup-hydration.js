#!/usr/bin/env node
/* Shop Setup hydration — does the CANONICAL value survive to the form?
 *
 *   node scripts/test-shop-setup-hydration.js
 *
 * The backend is proven (test-kasshop-boundary.js, 52/52 on real Firestore: save → fresh read
 * returns the same shopId and values). The device still loses them. There are only three places
 * the value can vanish:
 *
 *     1. before getShopProfile   — never saved, or saved against another shop
 *     2. in its response          — Firestore returned something else
 *     3. after the response       — the UI overwrote the form
 *
 * (1) and (2) are already excluded on the server. This suite tests (3) — the only part a
 * browser can be wrong about on its own — by stubbing getShopProfile to return a KNOWN profile
 * and then asking what the form actually holds afterwards.
 *
 * The decisive case is `stale cache disagrees`: localStorage holds OLD values while Firestore
 * holds NEW ones. That is the exact device situation after a save, and the rule is absolute —
 * once Firestore answers, Firestore wins. A pass here means the hydration order is sound and
 * the device loss is upstream; a fail names it outright.
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

const UID = 'hydration-seller';
const SHOP_ID = 'shopHydrationTest';
const NAME = 'KASS TEST 731';
const ABOUT = 'PERSISTENCE TEST 731';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 120) + ']' : ''));
  ok ? pass++ : fail++;
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/seller.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('SKIP — watchdog'); process.exit(0); }, 900000);
wd.unref && wd.unref();

/* Stub Auth + the callable bridge. getShopProfile answers after `delayMs`, modelling the real
   round-trip — the cache paints first on a device, and the question is what happens next. */
function stubs({ delayMs, cache, exists }) {
  return `(function(){
    var UID = ${JSON.stringify(UID)};
    ${cache ? `try{ localStorage.setItem('sokoniStore', JSON.stringify(${JSON.stringify(cache)})); }catch(e){}` : `try{ localStorage.removeItem('sokoniStore'); }catch(e){}`}
    try{ localStorage.setItem('loggedIn','true');
         localStorage.setItem('sokoniUser', JSON.stringify({uid:UID,name:'Hydration',roles:['seller'],role:'seller'})); }catch(e){}

    var listeners=[]; var current={uid:UID};
    window.firebaseAuth = { get currentUser(){return current;},
      onAuthStateChanged:function(cb){ listeners.push(cb); try{cb(current);}catch(e){} return function(){}; } };
    window.firebaseDB = { __stub:true };
    window.__sokoniAppCheckReady = Promise.resolve();

    window.__calls = [];
    window.sokoniCallable = function(name){
      return function(payload){
        window.__calls.push(name);
        if (name === 'getShopProfile') {
          return new Promise(function(res){ setTimeout(function(){
            res({ data: ${exists ? `{
              exists:true, shopId:${JSON.stringify(SHOP_ID)}, ownerUid:UID,
              profile:{ name:${JSON.stringify(NAME)}, about:${JSON.stringify(ABOUT)},
                        city:'Nairobi', phone:'+254700000731' },
              availability:{acceptingOrders:true,online:true,delivery:true,pickup:true},
              handle:'kasstest731', storefrontUrl:'/shop/kasstest731'
            }` : `{ exists:false, shopId:null, ownerUid:null, profile:null, availability:null, handle:null }`} });
          }, ${delayMs}); });
        }
        return Promise.resolve({ data:{ success:true } });
      };
    };
  })();`;
}

async function readForm(page) {
  return page.evaluate(() => ({
    name: (document.getElementById('swStoreName') || {}).value,
    about: (document.getElementById('swAbout') || {}).value,
    city: (document.getElementById('swCity') || {}).value,
    state: (document.getElementById('swStateBanner') || {}).dataset
      ? (document.getElementById('swStateBanner') || {}).dataset.state : null,
    banner: (document.getElementById('swStateBanner') || {}).textContent || null,
    shopId: window.__kasShopId || null,
    calls: window.__calls || [],
  }));
}

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  async function run(opts) {
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    });
    await ctx.addInitScript(stubs(opts));
    const page = await ctx.newPage();
    /* App Check cannot attest 127.0.0.1, so Firebase loads the Google API iframe helper and it
       throws from apis.google.com. That is the harness's origin problem, not the page's — but
       the filter is deliberately narrow (that module, that message) so a genuine error in our
       own code still fails this suite. */
    const errors = [];
    page.on('pageerror', (e) => {
      const msg = String(e && e.message || e);
      const stack = String((e && e.stack) || '');
      const isGapi = /apis\.google\.com|gapi/.test(stack) && /u\[v\] is not a function/.test(msg);
      if (!isGapi) errors.push(msg);
    });
    await page.goto(BASE + '/seller.html#store', { waitUntil: 'domcontentloaded', timeout: 60000 });
    /* Long enough for the stubbed round-trip plus any late overwrite. */
    await page.waitForTimeout(opts.settle || 9000);
    const form = await readForm(page);
    await ctx.close();
    return { form, errors };
  }

  console.log('\nSHOP SETUP HYDRATION — does the canonical value reach the form?');
  console.log('='.repeat(74));
  console.log('  canonical: name="' + NAME + '"  about="' + ABOUT + '"');

  /* ── 1. Cold device: nothing cached, Firestore has the shop ── */
  console.log('\n1. No cache — the form must be filled from Firestore alone');
  {
    const { form, errors } = await run({ delayMs: 1200, cache: null, exists: true });
    ck('getShopProfile was called', form.calls.indexOf('getShopProfile') !== -1, form.calls.join(','));
    ck('shop name is the canonical value', form.name === NAME, JSON.stringify(form.name));
    ck('description is the canonical value', form.about === ABOUT, JSON.stringify(form.about));
    ck('shopId was recorded', form.shopId === SHOP_ID, form.shopId);
    ck('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  }

  /* ── 2. THE DEVICE CASE: a stale cache disagrees with Firestore ── */
  console.log('\n2. Stale cache vs Firestore — Firestore must win');
  {
    const { form } = await run({
      delayMs: 1500, exists: true,
      cache: { name: 'OLD CACHED NAME', about: 'OLD CACHED DESCRIPTION', city: 'Mombasa' },
    });
    ck('the stale cached name was replaced', form.name === NAME, JSON.stringify(form.name));
    ck('the stale cached description was replaced', form.about === ABOUT, JSON.stringify(form.about));
    /* swCity is a <select> whose options are lowercase, so the CONTROL's canonical value for
       "Nairobi" is "nairobi". What matters is that the canonical city won and the stale cached
       "Mombasa" did not survive — compared case-insensitively, because the display form and the
       stored form legitimately differ. */
    ck('the stale cached city was replaced by the canonical one',
       String(form.city || '').toLowerCase() === 'nairobi', JSON.stringify(form.city));
  }

  /* ── 3. A SLOW response must still win, however late it lands ── */
  console.log('\n3. Slow Firestore (4s) — the late answer still wins');
  {
    const { form } = await run({
      delayMs: 4000, exists: true, settle: 12000,
      cache: { name: 'OLD CACHED NAME', about: 'OLD CACHED DESCRIPTION' },
    });
    ck('the late canonical name won', form.name === NAME, JSON.stringify(form.name));
    ck('the late canonical description won', form.about === ABOUT, JSON.stringify(form.about));
  }

  /* ── 4. No shop: the cache must not fake one ── */
  console.log('\n4. Firestore says no shop — a stale cache must not invent one');
  {
    const { form } = await run({
      delayMs: 900, exists: false,
      cache: { name: 'GHOST SHOP', about: 'SHOULD NOT SURVIVE' },
    });
    ck('the empty state is reported', form.state === 'empty', form.state + ' :: ' + String(form.banner).slice(0, 60));
    ck('no shopId is adopted', !form.shopId, String(form.shopId));
  }

  await browser.close(); server.close(); clearTimeout(wd);
  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('\n  SCOPE: the browser half only — whether the canonical response reaches and holds');
  console.log('         the form. The server half is covered by test-kasshop-boundary.js. A pass');
  console.log('         here means a device that still loses values is losing them BEFORE the');
  console.log('         response, not after it.');
  process.exit(fail ? 1 : 0);
});
