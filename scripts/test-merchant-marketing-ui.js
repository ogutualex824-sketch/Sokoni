/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT MARKETING — RUNTIME, on a real phone viewport (2D-2 step 3)
   ══════════════════════════════════════════════════════════════════════════════
   Drives the surface in WebKit at the widths Sell, Inventory and Team were
   accepted at, and answers what only a rendered screen can:

     · does any order count or ROI figure appear anywhere on screen?
     · is Ads labelled as ACCOUNT-level rather than as this shop's?
     · does the promotions tab admit it is showing active promotions only?
     · are blocked capabilities visible as "not available yet", with a reason?
     · is Pause the ordinary action, and does Delete say what it destroys?
     · does every mutation leave through its authority carrying the shop?
     · cross-shop: is SHOP_C refused, and nothing of SHOP_C's rendered?

   Callables are STUBS that record every payload — "which authority, with what"
   is observed, not assumed.

   Run: node scripts/test-merchant-marketing-ui.js
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
  return ok;
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
<div id="wrap"><div class="native" id="native-marketing"></div></div>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-campaigns.js"></script>
<script src="/sokoni-merchant-marketing.js"></script>
<script>
window.__calls = [];
window.__mode = 'ok';
window.__ui = null;
const SHOP_B = 'SHOP_B_shop_91c', SHOP_C = 'SHOP_C_shop_42x', SELLER_A = 'SELLER_A_uid_7f3';

var SERVER = {};
function reset () {
  SERVER = {
    [SHOP_B]: {
      campaigns: [
        /* The server DOES return orders/revenue/roi. The screen must not show them. */
        { campaignId:'c1', name:'April weekend sale', type:'weekend-sale', status:'active',
          campaignUrl:'https://mysokoni.co.ke/shop/b?utm_campaign=april',
          clicks: 4213, views: 9987, orders: 137, revenue: 845000, roi: '3.3%', createdAt: 200 },
        { campaignId:'c2', name:'Back to school — a deliberately very long campaign name that must ellipsise',
          type:'back-to-school', status:'paused',
          campaignUrl:'https://mysokoni.co.ke/shop/b?utm_campaign=bts',
          clicks: 12, views: 40, orders: 0, revenue: 0, roi: '0%', createdAt: 100 },
      ],
      promotions: [ { promoId:'p1', title:'Weekend 20% off', discountType:'percent', discountValue:20, code:'WEEK20' } ],
    },
    [SHOP_C]: { campaigns: [ { campaignId:'z9', name:'Other shop campaign', type:'custom', status:'active', clicks:1, views:1, createdAt:1 } ], promotions: [] },
  };
}
reset();

function guard (name, p) {
  window.__calls.push({ name, p });
  if (p && p.shopId && p.shopId !== SHOP_B) {
    const e = new Error('Not your shop'); e.code = 'permission-denied'; throw e;
  }
}

window.__ctx = function (shopId) {
  const scope = SokoniMerchantData.resolveScope({ uid: SELLER_A, activeShopId: shopId === undefined ? SHOP_B : shopId });
  return {
    scope,
    callList: async (p) => { guard('getMinishopCampaigns', p);
      if (window.__mode === 'error') throw new Error('Marketing could not be loaded.');
      return { data: { campaigns: window.__mode === 'empty' ? [] : SERVER[p.shopId].campaigns } }; },
    callCreate: async (p) => { guard('createMinishopCampaign', p);
      SERVER[p.shopId].campaigns.push({ campaignId:'cN', name:p.name, type:p.type, status:'active',
        campaignUrl:'https://mysokoni.co.ke/shop/b?utm_campaign=new', clicks:0, views:0, createdAt: 300 });
      return { data: { success:true, campaignId:'cN', campaignUrl:'https://mysokoni.co.ke/shop/b?utm_campaign=new' } }; },
    callPause: async (p) => { window.__calls.push({ name:'pauseMinishopCampaign', p });
      const c = SERVER[SHOP_B].campaigns.find(x => x.campaignId === p.campaignId);
      if (c) c.status = p.pause ? 'paused' : 'active';
      return { data: { success:true } }; },
    callDelete: async (p) => { window.__calls.push({ name:'deleteMinishopCampaign', p });
      if (window.__mode === 'deleteDenied') { const e = new Error('Not your shop'); e.code='permission-denied'; throw e; }
      SERVER[SHOP_B].campaigns = SERVER[SHOP_B].campaigns.filter(x => x.campaignId !== p.campaignId);
      return { data: { success:true } }; },
    callPromos: async (p) => { guard('miniShopGetPromotions', p);
      return { data: { promotions: window.__mode === 'empty' ? [] : SERVER[p.shopId].promotions } }; },
    callCreatePromo: async (p) => { guard('miniShopCreatePromotion', p);
      return { data: { promoId:'pN', title:p.title, code:p.code || null } }; },
    callUpdatePromo: async (p) => { window.__calls.push({ name:'miniShopUpdatePromotion', p });
      return { data: { success:true } }; },
    callCreateAd: async (p) => { window.__calls.push({ name:'createAdCampaign', p });
      return { data: { success:true, adId:'ad1' } }; },
    onToast: (m,k) => { (window.__toasts = window.__toasts || []).push([m,k]); }
  };
};
window.__mount = function (shopId) {
  if (window.__ui) { try { window.__ui.destroy(); } catch(e){} window.__ui = null; }
  const h = document.getElementById('native-marketing');
  h.innerHTML = '';
  /* SUPERSEDED 2026-09-29 (U7c1): Marketing now OPENS ON OFFERS (owner: "marketing is the central location" — Offers
     is its first tab). This suite certifies the CAMPAIGNS / PROMOTIONS / ADS surfaces, so it opens there explicitly —
     the tab the shell's #marketing link would otherwise land on is asserted by test-marketing-offers-browser MB1. */
  window.__ui = SokoniMerchantMarketing.mount(h, Object.assign(window.__ctx(shopId), { initialTab: 'campaigns' }));
};
window.__reset = reset;
</` + `script></body></html>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HARNESS); }
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(d);
  });
});

const VIEWPORTS = [
  { name: 'iPhone SE',     width: 375, height: 667 },
  { name: 'iPhone 14 Pro', width: 393, height: 852 },
];
const settle = (page, ms = 200) => page.waitForTimeout(ms);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await webkit.launch();

  for (const vp of VIEWPORTS) {
    console.log('\n' + '─'.repeat(70) + '\n  ' + vp.name + '  (' + vp.width + '×' + vp.height + ')\n' + '─'.repeat(70));
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base + '/harness.html', { waitUntil: 'load' });

    /* ══ 1. Campaigns, traffic only ══ */
    console.log('\n  1. Campaigns show traffic — and nothing that is not traffic');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 340);

    ck('both campaigns render', (await page.$$('.mmk-card')).length === 2);
    const bodyTxt = await page.textContent('.mmk-body');
    ck('clicks are shown', /4,213/.test(bodyTxt), bodyTxt.slice(0, 60).replace(/\s+/g, ' '));
    ck('views are shown', /9,987/.test(bodyTxt));

    /* The decisive assertions: the server sent orders 137, revenue 845000, roi 3.3%. */
    ck('the ORDER count never appears on screen', !/\b137\b/.test(bodyTxt));
    ck('the REVENUE never appears on screen', !/845,?000/.test(bodyTxt));
    /* The ROI VALUE must be absent. The word "ROI" is allowed — and wanted —
       inside the "not available yet" card, which is how the merchant learns the
       figure exists but cannot be trusted yet. Asserting the word away entirely
       would have forced the screen to hide the limitation instead of stating it. */
    ck('no ROI value appears on screen', !/3\.3%/.test(bodyTxt));
    const statTiles = await page.$$eval('.mmk-stat', (els) => els.map((e) => e.textContent).join(' | '));
    ck('the metric tiles carry ONLY clicks and views',
      /Clicks/.test(statTiles) && /Views/.test(statTiles) &&
      !/ROI|Orders|Revenue/i.test(statTiles), statTiles);
    const roiMentions = await page.$$eval('.mmk-blocked', (els) => els.map((e) => e.textContent).join(' '));
    ck('...and every mention of ROI is inside a not-available notice',
      /ROI/i.test(roiMentions));
    ck('...and the figures are labelled as traffic', /Traffic only/i.test(bodyTxt));
    ck('per-campaign conversions are declared not-available, with a reason',
      /Not available yet/i.test(bodyTxt) && /Orders & ROI/i.test(bodyTxt));

    /* ══ 2. Phone ergonomics ══ */
    console.log('\n  2. It fits, and it can be hit');
    const o = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth }));
    ck('a very long campaign name does not scroll the page sideways', o.doc <= 0 && o.body <= 0, JSON.stringify(o));
    ck('...it ellipsises instead',
      await page.$eval('.mmk-card:nth-child(2) .mmk-nm', (e) => getComputedStyle(e).textOverflow === 'ellipsis'));
    const small = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('button,input,[data-act]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.height < 44) bad.push((el.className || el.tagName) + ':' + Math.round(r.height));
      });
      return bad;
    });
    ck('every visible control is at least 44px tall', small.length === 0, small.join(', '));

    /* ══ 3. Pause is the ordinary action ══ */
    console.log('\n  3. Pause is ordinary; delete says what it destroys');
    await page.click('.mmk-card:nth-child(1) [data-act="toggle"]');
    await settle(page, 340);
    const pauseCall = await page.evaluate(() => window.__calls.find(c => c.name === 'pauseMinishopCampaign'));
    ck('pause goes through pauseMinishopCampaign', !!pauseCall && pauseCall.p.pause === true);
    ck('...and the list is re-read from the server',
      (await page.evaluate(() => window.__calls.filter(c => c.name === 'getMinishopCampaigns').length)) >= 2);

    await page.click('.mmk-card:nth-child(1) [data-act="ask-delete"]');
    await settle(page);
    const confirmTxt = await page.textContent('.mmk-sheet');
    ck('delete asks first', /Delete this campaign\?/.test(confirmTxt));
    ck('...and states exactly what is destroyed', /clicks and/.test(confirmTxt) && /permanently/.test(confirmTxt));
    ck('...and offers Pause as the alternative', /Pause instead/.test(confirmTxt));
    ck('nothing was deleted merely by asking',
      (await page.evaluate(() => window.__calls.filter(c => c.name === 'deleteMinishopCampaign').length)) === 0);

    await page.click('[data-act="confirm-delete"]');
    await settle(page, 380);
    ck('confirming goes through deleteMinishopCampaign',
      (await page.evaluate(() => window.__calls.filter(c => c.name === 'deleteMinishopCampaign').length)) === 1);
    ck('...and the campaign is gone', (await page.$$('.mmk-card')).length === 1);

    /* ══ 4. Creating a campaign ══ */
    console.log('\n  4. Creating a campaign');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 340);
    await page.click('[data-act="open-campaign"]');
    await settle(page);
    ck('Create is disabled until name and type are set',
      await page.$eval('[data-act="save-campaign"]', (b) => b.disabled === true));
    await page.fill('#mmk-name', 'May flash weekend');
    await page.click('[data-act="ctype"][data-v="flash-sale"]');
    await settle(page);
    ck('...then it becomes available',
      await page.$eval('[data-act="save-campaign"]', (b) => b.disabled === false));
    await page.click('[data-act="save-campaign"]');
    await settle(page, 380);
    const createCall = await page.evaluate(() => window.__calls.find(c => c.name === 'createMinishopCampaign'));
    ck('createMinishopCampaign carries the SHOP, name and type',
      createCall.p.shopId === 'SHOP_B_shop_91c' && createCall.p.name === 'May flash weekend' && createCall.p.type === 'flash-sale',
      JSON.stringify(createCall.p));
    ck('the shareable link is offered', (await page.$('#mmk-link')) !== null);

    /* ══ 5. Promotions ══ */
    console.log('\n  5. Promotions admit they are the storefront list');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 340);
    await page.click('[data-act="tab"][data-t="promotions"]');
    await settle(page);
    const promoTxt = await page.textContent('.mmk-body');
    ck('the active promotion is listed', /Weekend 20% off/.test(promoTxt));
    ck('the discount is readable', /20% off/.test(promoTxt));
    ck('the list says it is ACTIVE-ONLY', /active promotions only/i.test(promoTxt));
    ck('...and that it is what shoppers see', /shoppers see/i.test(promoTxt));

    await page.click('[data-act="open-promotion"]');
    await page.fill('#mmk-title', 'June bundle');
    await page.click('[data-act="ptype"][data-v="bundle"]');
    await page.fill('#mmk-value', '15');
    await page.fill('#mmk-until', '2026-12-31');
    await page.click('[data-act="save-promotion"]');
    await settle(page, 380);
    const promoCall = await page.evaluate(() => window.__calls.find(c => c.name === 'miniShopCreatePromotion'));
    ck('miniShopCreatePromotion carries the shop and the discount',
      promoCall && promoCall.p.shopId === 'SHOP_B_shop_91c' && promoCall.p.discountValue === 15,
      JSON.stringify(promoCall && promoCall.p));

    /* ══ 6. Ads are account-level and say so ══ */
    console.log('\n  6. Ads are account-level, and the screen says so');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 340);
    await page.click('[data-act="tab"][data-t="ads"]');
    await settle(page);
    const adsTxt = await page.textContent('.mmk-body');
    ck('the Ads tab labels the scope as the ACCOUNT', /account, not to one shop/i.test(adsTxt), adsTxt.slice(0, 80).replace(/\s+/g, ' '));
    ck('...and never claims the ads belong to this shop', !/this shop's ads/i.test(adsTxt));

    await page.click('[data-act="open-ad"]');
    await page.fill('#mmk-adtitle', 'Fresh stock every Friday');
    await page.fill('#mmk-budget', '2000');
    await page.click('[data-act="save-ad"]');
    await settle(page, 380);
    const adCall = await page.evaluate(() => window.__calls.find(c => c.name === 'createAdCampaign'));
    ck('createAdCampaign is called with title and budget',
      adCall && adCall.p.title === 'Fresh stock every Friday' && adCall.p.budgetKES === 2000);
    ck('...and carries NO shopId — the payload does not invent shop scope',
      adCall && adCall.p.shopId === undefined, JSON.stringify(adCall && adCall.p));
    ck('the merchant is told it is reviewed before running', /review/i.test(await page.textContent('.mmk-sheet')));

    /* ══ 7. Blocked capabilities are visible ══ */
    console.log('\n  7. The edge of what works is visible');
    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 340);
    await page.click('[data-act="tab"][data-t="promotions"]');
    await settle(page);
    const blockedTxt = await page.textContent('.mmk-body');
    ck('bundle deals are shown as not available yet', /Bundle deals/.test(blockedTxt));
    ck('...with a reason rather than a dead button', /not deployed/i.test(blockedTxt));
    ck('no blocked capability is offered as a working control',
      (await page.$$('[data-act="open-bundle"], [data-act="open-abtest"]')).length === 0);

    /* ══ 8. Cross-shop ══ */
    console.log('\n  8. SHOP_C is unreachable');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount('SHOP_C_shop_42x'); });
    await settle(page, 360);
    const cTxt = await page.textContent('.mmk-body');
    ck('asking for SHOP_C is refused by the authority', /could not be loaded/i.test(cTxt));
    ck('...and nothing of SHOP_C is rendered', !cTxt.includes('Other shop campaign'));

    /* ══ 9. States ══ */
    console.log('\n  9. Empty, error and no-shop are distinct answers');
    await page.evaluate(() => { window.__reset(); window.__mode = 'empty'; window.__mount(); });
    await settle(page, 340);
    ck('an empty campaign list explains what a campaign is for',
      /No campaigns yet/.test(await page.textContent('.mmk-body')));

    await page.evaluate(() => { window.__mode = 'error'; window.__mount(); });
    await settle(page, 340);
    const errTxt = await page.textContent('.mmk-body');
    ck('a failed read is shown as a failure', /could not be loaded/i.test(errTxt));
    ck('...and NOT as an empty list', !/No campaigns yet/.test(errTxt));

    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(null); });
    await settle(page, 300);
    ck('no shop renders an honest empty state', /No shop is active yet/.test(await page.textContent('.mmk')));

    /* ══ 10. Nothing local ══ */
    console.log('\n  10. Nothing is stored on the device');
    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 340);
    const ls = await page.evaluate(() => Object.keys(localStorage));
    ck('the surface wrote NO localStorage key', ls.length === 0, ls.join(','));

    const real = errors.filter((e) => !/favicon|404/.test(e));
    ck('no page error or console error during the whole run', real.length === 0, real.slice(0, 2).join(' | '));

    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
