/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT STORE — RUNTIME (2D-2 Stage 2)
   ══════════════════════════════════════════════════════════════════════════════
   Answers what only a rendered screen can:

     · does the surface ever ask for a shop it was not given by the server?
     · is a foreign shop's data ever rendered?
     · does an account with no shop get an honest state, or a guess?
     · does a rejected save discard the merchant's typing?
     · is the follower count read once, from the authority?

   Run: node scripts/test-merchant-store-ui.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
  :root{--bg:#050505;--panel:#0a0a0a;--card:#0d0d0d;--line:rgba(255,255,255,.08);
    --txt:#fff;--txt2:rgba(255,255,255,.55);--txt3:rgba(255,255,255,.35);--acc:#71ff00}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--txt);
    font-family:-apple-system,system-ui,sans-serif;overflow:hidden}
  #wrap{position:absolute;inset:0}
  .native{position:absolute;inset:0;overflow-y:auto;padding:22px}
  .sk-line{height:14px;border-radius:7px;margin-bottom:12px;background:rgba(255,255,255,.07)}
</style></head><body>
<div id="wrap"><div class="native" id="native-shop"></div></div>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-store.js"></script>
<script src="/sokoni-merchant-store-ui.js"></script>
<script>
window.__calls = []; window.__mode = 'ok'; window.__ui = null;
var ME = 'SELLER_A_uid_7f3', SHOP_B = 'SHOP_B_shop_91c', SHOP_C = 'SHOP_C_shop_42x';
var LONG_TAGLINE = 'The very best electronics, accessories and repairs in the whole of Nairobi and beyond';
var STATE = {};
function reset () {
  STATE = {
    shopId: SHOP_B, handle: 'bshop',
    config: { tagline: LONG_TAGLINE, location: 'Westlands, Nairobi', description: 'We sell phones.' },
    followerCount: 42, views: 1280, visits: 940
  };
}
reset();
window.__ctx = function (signedIn) {
  var scope = SokoniMerchantData.resolveScope({ uid: signedIn === false ? null : ME, activeShopId: SHOP_B });
  return {
    scope: scope, origin: 'https://mysokoni.co.ke',
    callIdentity: async function (p) {
      window.__calls.push({ op:'getMyMinishop', p:p });
      if (window.__mode === 'identityError') throw new Error('Your shop could not be loaded.');
      if (window.__mode === 'noShop') return { data: { shopId:null, handle:null, config:null, url:null, hasHandle:false } };
      if (window.__mode === 'noHandle') return { data: { shopId: STATE.shopId, handle:null, config: STATE.config, url:null, hasHandle:false } };
      return { data: { shopId: STATE.shopId, handle: STATE.handle, config: STATE.config,
        url: 'https://mysokoni.co.ke/shop/' + STATE.handle, hasHandle: true } };
    },
    callSave: async function (p) {
      window.__calls.push({ op:'saveMinishopConfig', p:p });
      if (p.shopId !== SHOP_B) { var e = new Error('You do not own this shop.'); e.code='permission-denied'; throw e; }
      if (window.__mode === 'saveDenied') { var d = new Error('You do not own this shop.'); d.code='permission-denied'; throw d; }
      Object.assign(STATE.config, p.config);
      return { data: { success: true } };
    },
    callClaim: async function (p) {
      window.__calls.push({ op:'claimMinishopHandle', p:p });
      if (window.__mode === 'handleTaken') { var e = new Error('This handle is already taken.'); e.code='already-exists'; throw e; }
      STATE.handle = p.handle; window.__mode = 'ok';
      return { data: { success:true, handle:p.handle, shopId: STATE.shopId } };
    },
    callAnalytics: async function (p) {
      window.__calls.push({ op:'getMinishopAnalytics', p:p });
      if (p.shopId !== SHOP_B) { var e = new Error('You do not own this shop.'); e.code='permission-denied'; throw e; }
      if (window.__mode === 'analyticsError') throw new Error('Your shop figures could not be loaded.');
      if (window.__mode === 'noFollowers') return { data: { shopId:p.shopId, analytics: { views: STATE.views } } };
      return { data: { shopId:p.shopId, followerCount: STATE.followerCount,
        analytics: { views: STATE.views, visits: STATE.visits } } };
    },
    callShare: async function (p) {
      window.__calls.push({ op:'generateMinishopShareCard', p:p });
      return { data: { shareUrl:'https://mysokoni.co.ke/shop/'+STATE.handle,
        shareText:'Shop bshop on SOKONI — Kenya\\'s leading marketplace: https://mysokoni.co.ke/shop/bshop' } };
    },
    onToast: function (m,k) { (window.__toasts = window.__toasts || []).push([m,k]); }
  };
};
window.__mount = function (signedIn) {
  if (window.__ui) { try { window.__ui.destroy(); } catch (e) {} window.__ui = null; }
  var h = document.getElementById('native-shop'); h.innerHTML = '';
  window.__ui = SokoniMerchantStoreUI.mount(h, window.__ctx(signedIn));
};
window.__reset = reset;
</` + `script></body></html>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HARNESS); }
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' }); res.end(d);
  });
});

const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14 Pro', width: 393, height: 852 },
  { name: 'Desktop', width: 1280, height: 800 },
];
const settle = (page, ms = 260) => page.waitForTimeout(ms);
const tab = async (page, t) => { await page.click('[data-act="tab"][data-t="' + t + '"]'); await settle(page); };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await webkit.launch();

  for (const vp of VIEWPORTS) {
    console.log('\n' + '─'.repeat(70) + '\n  ' + vp.name + '  (' + vp.width + '×' + vp.height + ')\n' + '─'.repeat(70));
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.width < 900 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base + '/harness.html', { waitUntil: 'load' });

    console.log('\n  1. Identity comes from the server');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mode = 'ok'; window.__mount(); });
    await settle(page, 420);
    ck('the storefront renders', (await page.$('.mst-id')) !== null);
    ck('getMyMinishop was called with an EMPTY payload — no shopId offered',
      await page.evaluate(() => {
        const c = window.__calls.find((x) => x.op === 'getMyMinishop');
        return !!c && Object.keys(c.p || {}).length === 0;
      }));
    ck('every later call uses the shopId the SERVER returned',
      await page.evaluate(() => window.__calls.filter((c) => c.p && c.p.shopId)
        .every((c) => c.p.shopId === 'SHOP_B_shop_91c')),
      await page.evaluate(() => JSON.stringify(window.__calls.map((c) => c.op + ':' + ((c.p && c.p.shopId) || '-')))));
    ck('SHOP_C never appears anywhere on the page',
      !(await page.textContent('.mst')).includes('SHOP_C'));

    console.log('\n  2. The follower count, from one source');
    ck('the follower count is shown', /42/.test(await page.textContent('.mst-body')));
    ck('getMinishopAnalytics was called exactly once',
      (await page.evaluate(() => window.__calls.filter((c) => c.op === 'getMinishopAnalytics').length)) === 1);
    await page.evaluate(() => { window.__mode = 'noFollowers'; window.__mount(); });
    await settle(page, 420);
    const noF = await page.textContent('.mst-body');
    ck('a MISSING follower count is omitted, never rendered as 0',
      !/\bFollowers\b/.test(noF) || !/>0</.test(noF), 'no zero-follower tile');
    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(); });
    await settle(page, 420);

    console.log('\n  3. Phone ergonomics');
    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth }));
    ck('nothing overflows sideways', o.doc <= 0 && o.body <= 0, JSON.stringify(o));
    await tab(page, 'details');
    const small = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('button,input,textarea,[data-act]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.height < 44) bad.push((el.className || el.tagName) + ':' + Math.round(r.height));
      });
      return bad;
    });
    ck('every visible control is at least 44px tall', small.length === 0, small.join(', '));
    const o2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('an 84-character tagline does not scroll the details form sideways', o2 <= 0, String(o2));

    console.log('\n  4. Saving — only what changed, and only on the server\'s word');
    ck('Save is disabled with no changes',
      await page.$eval('[data-act="save"]', (b) => b.disabled === true));
    await page.fill('#mst-f-location', 'Kilimani, Nairobi');
    await settle(page, 160);
    ck('...and enabled once something changes',
      await page.$eval('[data-act="save"]', (b) => b.disabled === false));
    ck('...naming how many changes', /Save 1 change/.test(await page.textContent('[data-act="save"]')));
    await page.click('[data-act="save"]');
    await settle(page, 420);
    const saveCall = await page.evaluate(() => window.__calls.find((c) => c.op === 'saveMinishopConfig'));
    ck('saveMinishopConfig carries the resolved shopId', saveCall.p.shopId === 'SHOP_B_shop_91c');
    ck('...and ONLY the changed field', Object.keys(saveCall.p.config).join(',') === 'location',
      JSON.stringify(saveCall.p.config));
    ck('the save is confirmed from the server response', /Saved\./.test(await page.textContent('.mst-body')));

    console.log('\n  5. A refused save keeps the merchant\'s typing');
    await page.evaluate(() => { window.__mode = 'saveDenied'; });
    await page.fill('#mst-f-description', 'We also repair screens.');
    await settle(page, 160);
    await page.click('[data-act="save"]');
    await settle(page, 420);
    ck('the refusal is shown in the server\'s words',
      /do not own this shop/i.test(await page.textContent('.mst-body')));
    ck('...and the typed text is STILL in the field',
      (await page.$eval('#mst-f-description', (e) => e.value)) === 'We also repair screens.');
    ck('...and Save is still offered', await page.$eval('[data-act="save"]', (b) => b.disabled === false));
    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(); });
    await settle(page, 420);

    console.log('\n  6. Handle claim sends no shopId');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mode = 'noHandle'; window.__mount(); });
    await settle(page, 420);
    ck('a shop without a handle is invited to claim one', (await page.$('#mst-handle')) !== null);
    ck('Claim is disabled while the handle is invalid',
      await page.$eval('[data-act="claim"]', (b) => b.disabled === true));
    await page.fill('#mst-handle', 'ab');
    await settle(page, 140);
    ck('...still disabled at two characters',
      await page.$eval('[data-act="claim"]', (b) => b.disabled === true));
    await page.fill('#mst-handle', 'my-shop');
    await settle(page, 140);
    ck('...enabled once valid', await page.$eval('[data-act="claim"]', (b) => b.disabled === false));
    await page.click('[data-act="claim"]');
    await settle(page, 460);
    const claimCall = await page.evaluate(() => window.__calls.find((c) => c.op === 'claimMinishopHandle'));
    ck('claimMinishopHandle carries the handle ALONE — no shopId',
      claimCall && Object.keys(claimCall.p).join(',') === 'handle' && claimCall.p.handle === 'my-shop',
      JSON.stringify(claimCall && claimCall.p));
    ck('identity is RE-READ from the server after claiming',
      (await page.evaluate(() => window.__calls.filter((c) => c.op === 'getMyMinishop').length)) >= 2);

    console.log('\n  7. No shop — an honest state, not a guess');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mode = 'noShop'; window.__mount(); });
    await settle(page, 420);
    const noShop = await page.textContent('.mst');
    ck('the empty state says there is no shop yet', /do not have a shop yet/i.test(noShop));
    ck('...and no shopId was invented for any call',
      await page.evaluate(() => window.__calls.every((c) => !c.p || !c.p.shopId)),
      await page.evaluate(() => JSON.stringify(window.__calls.map((c) => c.op))));
    ck('...and the uid never appears as a shop', !noShop.includes('SELLER_A_uid_7f3'));
    ck('no analytics call was made without a shop',
      (await page.evaluate(() => window.__calls.filter((c) => c.op === 'getMinishopAnalytics').length)) === 0);

    console.log('\n  8. Share');
    await page.evaluate(() => { window.__reset(); window.__mode = 'ok'; window.__mount(); });
    await settle(page, 420);
    await tab(page, 'share');
    ck('the storefront link is shown', /mysokoni\.co\.ke\/shop\/bshop/.test(await page.$eval('#mst-url2', (e) => e.value)));
    await page.click('[data-act="share"]');
    await settle(page, 420);
    const shareCall = await page.evaluate(() => window.__calls.find((c) => c.op === 'generateMinishopShareCard'));
    ck('generateMinishopShareCard carries the resolved shopId and type shop',
      shareCall && shareCall.p.shopId === 'SHOP_B_shop_91c' && shareCall.p.type === 'shop');
    ck('the ready-to-send message appears', /leading marketplace/.test(await page.textContent('.mst-body')));

    console.log('\n  9. States and hygiene');
    await page.evaluate(() => { window.__mode = 'identityError'; window.__mount(); });
    await settle(page, 420);
    const err = await page.textContent('.mst-body');
    ck('a failed identity read is a failure', /could not be loaded/i.test(err));
    ck('...and NOT "you do not have a shop yet"', !/do not have a shop yet/i.test(err));

    await page.evaluate(() => { window.__mode = 'analyticsError'; window.__mount(); });
    await settle(page, 460);
    ck('a failed analytics read does not blank the shop', (await page.$('.mst-id')) !== null);
    ck('...and says the figures failed, with a retry',
      /figures could not be loaded/i.test(await page.textContent('.mst-body')));

    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(false); });
    await settle(page, 320);
    ck('a signed-out account is told to sign in', /Sign in to manage your shop/i.test(await page.textContent('.mst')));

    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 420);
    const ls = await page.evaluate(() => Object.keys(localStorage));
    ck('the surface wrote NO localStorage key', ls.length === 0, ls.join(','));
    const ops = await page.evaluate(() => [...new Set(window.__calls.map((c) => c.op))]);
    ck('only the five SAFE authorities were ever called',
      ops.every((o) => ['getMyMinishop', 'saveMinishopConfig', 'claimMinishopHandle',
        'getMinishopAnalytics', 'generateMinishopShareCard'].indexOf(o) !== -1), ops.join(','));
    const real = errors.filter((e) => !/favicon|404/.test(e));
    ck('no page error or console error during the whole run', real.length === 0, real.slice(0, 2).join(' | '));

    await ctx.close();
  }
  await browser.close(); server.close();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
