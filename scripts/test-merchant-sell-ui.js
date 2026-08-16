/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT SELL + INVENTORY — RUNTIME, on a real phone viewport (2D-1C)
   ══════════════════════════════════════════════════════════════════════════════
   The pure suite (test-merchant-sell-inventory.js) proves the payloads. This one
   proves the SURFACE: what a merchant can actually see and touch, in WebKit, at
   iPhone SE and iPhone 14 Pro, driven by real taps.

   The questions it answers, and none of them are answerable from source:

     · Can a sale be rung up by touch alone, and does the cart show real figures?
     · Does anything overflow sideways at 375px? Is any control too small to hit?
     · Can the screen show SUCCESS before the server has answered?   ← the one
       that matters most: a false receipt is a customer walking out unpaid.
     · Does an abandoned cart call any authority at all?
     · Does a retry after a failure reproduce the SAME idempotency key?
     · Does Inventory refuse an impossible correction, and does it show the
       server's number rather than its own arithmetic?

   The Firebase backend is NOT involved. The two callables are STUBS that record
   every payload, so "was posCompleteCheckout called, with what, how many times"
   is observed rather than assumed — and a surface that invents a sale is caught.

   Run: node scripts/test-merchant-sell-ui.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};

/* ── The harness page. Loads the SHIPPED modules unmodified and mounts them with a
      stubbed context, so what is under test is the real surface. ───────────────── */
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
<div id="wrap"><div class="native" id="native-sell"></div><div class="native" id="native-inventory" style="display:none"></div></div>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-stock.js"></script>
<script src="/sokoni-merchant-sell.js"></script>
<script src="/sokoni-merchant-inventory-ui.js"></script>
<script>
/* ── Stubs. Every call is RECORDED; nothing is faked as succeeding by default. ── */
window.__calls = { sale: [], adjust: [] };
window.__saleMode = 'ok';        /* ok | fail | slow | cached */
window.__adjustMode = 'ok';
window.__release = null;         /* resolve() to let a 'slow' call finish */

var CATALOGUE = [
  { id:'p1', name:'Airtime card', price:100, stock:12, shopId:'SHOP_B', sku:'1234', lowStockThreshold:5 },
  { id:'p2', name:'Phone case',   price:450, stock:2,  shopId:'SHOP_B', lowStockThreshold:5 },
  { id:'p3', name:'Charger',      price:900,           shopId:'SHOP_B' },
  { id:'x9', name:'Other shop',   price:50,  stock:5,  shopId:'SHOP_C' }
];
var MOVEMENTS = [];

var db = {
  queryProducts: function (spec) {
    var f = spec.where[0];
    return Promise.resolve(CATALOGUE.filter(function (p) { return String(p[f[0]]) === String(f[2]); })
      .map(function (p) { return Object.assign({}, p); }));
  },
  queryMovements: function () { return Promise.resolve(MOVEMENTS.slice()); }
};

function callSale (payload) {
  window.__calls.sale.push(payload);
  if (payload.dryRun) {
    var deltas = payload.items.map(function (it) {
      var p = CATALOGUE.filter(function (c) { return c.id === it.productId; })[0] || {};
      var from = (typeof p.stock === 'number') ? p.stock : 9999;
      var to = Math.max(0, from - it.qty);
      return { productId: it.productId, from: from, to: to, delta: to - from };
    });
    return Promise.resolve({ data: { dryRun: true, ok: true, serverSubtotal: payload.subtotal,
      grandTotal: payload.grandTotal, items: payload.items, stockDeltas: deltas, differences: [] } });
  }
  var receipt = { receiptNo: 'RC12345', saleId: 'sale_1', items: payload.items,
    subtotal: payload.subtotal, total: payload.grandTotal, payments: payload.payments,
    customer: 'Guest', timestamp: '2026-08-16T09:00:00.000Z' };
  if (window.__saleMode === 'fail') return Promise.reject(new Error('Insufficient stock for Phone case'));
  if (window.__saleMode === 'cached') return Promise.resolve({ data: { saleId:'sale_1', receipt: receipt, cached: true } });
  if (window.__saleMode === 'slow') {
    return new Promise(function (res) { window.__release = function () { res({ data: { saleId:'sale_1', receipt: receipt } }); }; });
  }
  return Promise.resolve({ data: { saleId: 'sale_1', receipt: receipt, loyaltyAwarded: 0 } });
}

function callAdjust (payload) {
  window.__calls.adjust.push(payload);
  if (window.__adjustMode === 'refuse') {
    var e = new Error('That would leave -13 in stock. There are 12; count again or adjust by at most 12.');
    e.code = 'failed-precondition';
    return Promise.reject(e);
  }
  var p = CATALOGUE.filter(function (c) { return c.id === payload.productId; })[0] || {};
  var before = (typeof p.stock === 'number') ? p.stock : 0;
  return Promise.resolve({ data: { ok:true, productId: payload.productId, before: before,
    after: before + payload.delta, inventoryVersion: 5, idempotent: false } });
}

window.__ctx = function (shopOk) {
  return {
    scope: SokoniMerchantData.resolveScope({ uid: 'SELLER_A', activeShopId: shopOk === false ? null : 'SHOP_B' }),
    db: db, shopName: 'Test Shop',
    callSale: callSale, callAdjust: callAdjust,
    onToast: function (m, k) { (window.__toasts = window.__toasts || []).push([m, k]); }
  };
};
/* Destroy before re-mounting, exactly as merchant.html's renderSell/renderInventory
   do. The host element is reused, so a controller left alive keeps its delegated
   listener on it and repaints the host from ITS state — two controllers fighting
   over one screen. (Discovered by this suite: without the destroy, a remount after
   a completed sale left the old receipt sheet on top of the new till.) */
window.__mountSell = function (shopOk) {
  if (window.__sell) { try { window.__sell.destroy(); } catch (e) {} window.__sell = null; }
  var h = document.getElementById('native-sell');
  h.innerHTML = '';
  window.__sell = SokoniMerchantSell.mount(h, window.__ctx(shopOk));
};
window.__mountInv = function () {
  if (window.__inv) { try { window.__inv.destroy(); } catch (e) {} window.__inv = null; }
  document.getElementById('native-sell').style.display = 'none';
  var h = document.getElementById('native-inventory');
  h.style.display = ''; h.innerHTML = '';
  window.__inv = SokoniMerchantInventoryUI.mount(h, window.__ctx());
};
</` + `script></body></html>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/harness.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HARNESS);
  }
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(d);
  });
});

const VIEWPORTS = [
  { name: 'iPhone SE',     width: 375, height: 667 },
  { name: 'iPhone 14 Pro', width: 393, height: 852 },
];

const settle = (page, ms = 140) => page.waitForTimeout(ms);

/* Charge exists in two places — on the always-visible cart bar, and inside the cart
   sheet. When the sheet is open the bar's copy sits BEHIND the scrim and is
   correctly unclickable, so the test must aim at the one a merchant could actually
   reach rather than at whichever comes first in the DOM. */
const clickCharge = async (page) => {
  const inSheet = await page.$('.msl-sheet [data-act="charge"]');
  return (inSheet || await page.$('.msl-bar [data-act="charge"]')).click();
};

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

    /* ══ 1. Sell mounts against a real shop scope ══ */
    console.log('\n  1. The till opens');
    await page.evaluate(() => window.__mountSell());
    await settle(page, 260);

    const cards = await page.$$('.msl-card');
    ck('the shop\'s products are on screen', cards.length === 3, cards.length + ' cards');
    /* Asserted against the RENDERED grid, not page.content() — the harness's own
       fixture array lives in an inline script and would match trivially. */
    ck('another shop\'s product is NOT',
      !(await page.$eval('.msl-grid', (g) => g.textContent)).includes('Other shop'));

    const unknownStock = await page.$eval('.msl-grid',
      (g) => Array.from(g.querySelectorAll('.msl-card')).map(c => c.textContent).join('|'));
    ck('a product with unknown stock says "Stock —", not "0 in stock"',
      /Stock\s*—/.test(unknownStock) && !/0 in stock/.test(unknownStock));

    ck('no sale authority has been called just by opening the till',
      (await page.evaluate(() => window.__calls.sale.length)) === 0);

    /* ══ 2. Phone ergonomics ══ */
    console.log('\n  2. It fits, and it can be hit');
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    ck('nothing overflows sideways', overflow.doc <= 0 && overflow.body <= 0, JSON.stringify(overflow));

    const small = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('button,input,[data-act]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;          /* not rendered */
        if (r.height < 44) bad.push((el.className || el.tagName) + ':' + Math.round(r.height));
      });
      return bad;
    });
    ck('every visible control is at least 44px tall', small.length === 0, small.join(', '));

    /* ══ 3. Ringing up a sale by touch ══ */
    console.log('\n  3. Ringing it up');
    await page.click('.msl-card:nth-child(1)');
    await page.click('.msl-card:nth-child(1)');
    await page.click('.msl-card:nth-child(2)');
    await settle(page);

    ck('the cart bar shows the real unit count', /3 items/.test(await page.textContent('.msl-bar')));
    ck('...and the real total (2×100 + 450)', /650/.test(await page.textContent('.msl-bar')));
    ck('a repeat tap merges rather than duplicating',
      (await page.$eval('.msl-card:nth-child(1) .msl-badge', (e) => e.textContent)) === '2');

    await page.click('[data-act="open-cart"]');
    await settle(page);
    ck('the cart sheet lists one line per product', (await page.$$('.msl-line')).length === 2);

    await page.click('.msl-line:nth-child(2) [data-act="inc"]');
    await settle(page);
    ck('a quantity can be raised from the cart', /900/.test(await page.textContent('.msl-sheet')));

    await page.click('.msl-line:nth-child(2) [data-act="dec"]');
    await page.click('.msl-line:nth-child(2) [data-act="dec"]');
    await settle(page);
    ck('...and dropping to zero removes the line', (await page.$$('.msl-line')).length === 1);

    /* ══ 4. THE ONE THAT MATTERS — success cannot precede the server ══ */
    console.log('\n  4. Success is the server\'s word, never the screen\'s');
    await page.evaluate(() => { window.__saleMode = 'slow'; });
    await clickCharge(page);
    await settle(page);
    ck('the payment sheet opens', /Take payment/.test(await page.textContent('.msl-sheet')));
    ck('...and no sale has been submitted merely by opening it',
      (await page.evaluate(() => window.__calls.sale.filter(c => !c.dryRun).length)) === 0);

    await page.click('[data-act="complete"]');
    await settle(page, 300);

    const midFlight = await page.textContent('.msl-sheet');
    ck('while the server is deciding, the screen says so',
      /Completing|Checking/.test(midFlight), midFlight.slice(0, 60).replace(/\s+/g, ' '));
    ck('...and shows NO receipt, NO tick, NO "Sale complete"',
      !/Sale complete/.test(midFlight) && !/RC12345/.test(midFlight) && !/✅/.test(midFlight));
    ck('...and the Complete button is disabled so it cannot be double-fired',
      await page.$eval('[data-act="complete"]', (b) => b.disabled === true));
    ck('...and the sheet cannot be dismissed mid-flight',
      await page.$eval('[data-act="close-sheet"].msl-btn', (b) => b.disabled === true));

    await page.evaluate(() => window.__release());
    await settle(page, 320);
    const after = await page.textContent('.msl-sheet');
    ck('once the server answers, the receipt appears', /Sale complete|RC12345/.test(after));
    ck('...and it carries the SERVER\'s receipt number', /RC12345/.test(after));
    ck('the receipt is immediately printable and shareable',
      (await page.$('[data-act="print"]')) !== null && (await page.$('[data-act="share"]')) !== null);

    const calls = await page.evaluate(() => window.__calls.sale);
    const real = calls.filter((c) => !c.dryRun);
    ck('posCompleteCheckout was called EXACTLY once for this sale', real.length === 1, real.length);
    ck('the pre-charge check ran first, and was a DRY RUN',
      calls.length === 2 && calls[0].dryRun === true && !calls[1].dryRun);
    ck('the check and the sale share ONE idempotency key',
      calls[0].idempotencyKey === calls[1].idempotencyKey);
    ck('the sale carries the shop as the till', real[0].merchantId === 'SHOP_B');
    ck('...and the seller in metadata the server stores',
      real[0].metadata && real[0].metadata.sellerUid === 'SELLER_A');

    /* ══ 5. Failure, and a retry that cannot double-sell ══ */
    console.log('\n  5. Failure, and a retry that cannot sell twice');
    await page.evaluate(() => { window.__saleMode = 'fail'; window.__calls.sale = []; window.__mountSell(); });
    await settle(page, 240);
    await page.click('.msl-card:nth-child(2)');
    await clickCharge(page);
    await settle(page);
    await page.click('[data-act="complete"]');
    await settle(page, 320);

    const failed = await page.textContent('.msl-sheet');
    ck('a failed sale is shown as a failure', /Insufficient stock/.test(failed), failed.slice(0, 70).replace(/\s+/g, ' '));
    ck('...and says plainly that nothing was charged and no stock moved',
      /nothing was charged/i.test(failed) || /Nothing was charged/.test(failed));
    ck('...and offers a retry', /Try again/.test(failed));

    const key1 = await page.evaluate(() => window.__calls.sale.filter(c => !c.dryRun)[0].idempotencyKey);
    await page.click('[data-act="complete"]');
    await settle(page, 320);
    const keys = await page.evaluate(() => window.__calls.sale.filter(c => !c.dryRun).map(c => c.idempotencyKey));
    ck('a retry reproduces the SAME idempotency key — the server completes it once',
      keys.length === 2 && keys[0] === keys[1] && keys[1] === key1, keys.join(' / '));

    /* ══ 6. An abandoned cart ══ */
    console.log('\n  6. An abandoned cart changes nothing');
    await page.evaluate(() => { window.__calls.sale = []; window.__calls.adjust = []; window.__mountSell(); });
    await settle(page, 240);
    await page.click('.msl-card:nth-child(1)');
    await page.click('.msl-card:nth-child(2)');
    await page.click('[data-act="open-cart"]');
    await settle(page);
    await page.click('[data-act="clear-cart"]');
    await settle(page);
    const abandoned = await page.evaluate(() => ({ s: window.__calls.sale.length, a: window.__calls.adjust.length }));
    ck('abandoning a cart calls NO authority at all', abandoned.s === 0 && abandoned.a === 0, JSON.stringify(abandoned));
    ck('...and the till returns to its resting state', /Tap a product/.test(await page.textContent('.msl-bar')));

    /* ══ 7. No shop yet ══ */
    console.log('\n  7. A merchant with no shop is told so');
    await page.evaluate(() => window.__mountSell(false));
    await settle(page, 200);
    const noShop = await page.textContent('.msl');
    ck('an unresolved shop renders an honest empty state', /No shop is active yet/.test(noShop));
    ck('...and no catalogue is shown for a guessed shop', (await page.$$('.msl-card')).length === 0);

    /* ══ 8. Inventory ══ */
    console.log('\n  8. Inventory corrects stock — and only stock');
    await page.evaluate(() => window.__mountInv());
    await settle(page, 300);

    const rows = await page.$$('.mnv-row');
    ck('stock on hand is listed for this shop', rows.length === 3, rows.length + ' rows');
    const invTxt = await page.textContent('.mnv-body');
    ck('a product with no tracked count shows "—", never 0',
      /—/.test(invTxt) && /not tracked/.test(invTxt));

    const inv2 = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    ck('Inventory does not overflow sideways either', inv2.doc <= 0, JSON.stringify(inv2));

    await page.click('.mnv-row:nth-child(1)');
    await settle(page, 180);
    ck('the adjust sheet opens on the chosen product', /Airtime card/.test(await page.textContent('.mnv-sheet')));
    ck('the Apply button is disabled until a reason is chosen',
      await page.$eval('[data-act="apply"]', (b) => b.disabled === true));

    await page.click('[data-act="amt-set"][data-n="20"]');
    await settle(page, 140);
    ck('an impossible correction is refused before it is sent',
      /only 12 in stock/i.test(await page.textContent('.mnv-sheet')));
    ck('...and Apply stays disabled', await page.$eval('[data-act="apply"]', (b) => b.disabled === true));
    ck('...and nothing was sent', (await page.evaluate(() => window.__calls.adjust.length)) === 0);

    await page.click('[data-act="amt-set"][data-n="2"]');
    await page.click('[data-act="reason"][data-r="damage"]');
    await settle(page, 140);
    ck('with a reason and a possible delta, Apply becomes available',
      await page.$eval('[data-act="apply"]', (b) => b.disabled === false));

    await page.click('[data-act="apply"]');
    await settle(page, 340);
    const applied = await page.textContent('.mnv-sheet');
    ck('the correction is applied through the server', /10 on hand/.test(applied), applied.slice(0, 60).replace(/\s+/g, ' '));
    ck('...and the figure shown is the SERVER\'s `after`', /12 → 10/.test(applied));
    ck('...and the screen states it was NOT a sale',
      /not a sale/i.test(applied) && /unchanged/i.test(applied));

    const adj = await page.evaluate(() => window.__calls.adjust);
    ck('merchantAdjustStock was called exactly once', adj.length === 1);
    ck('the payload carries a SIGNED delta and a reason', adj[0].delta === -2 && adj[0].reason === 'damage');
    ck('the payload carries the shop', adj[0].shopId === 'SHOP_B');
    ck('the payload NEVER mentions `sold`', !Object.keys(adj[0]).some(k => /sold/i.test(k)), Object.keys(adj[0]).join(','));
    ck('no sale authority was called by a correction',
      (await page.evaluate(() => window.__calls.sale.length)) === 0);

    /* Idempotency at the surface: a refused correction retried keeps its id. */
    await page.evaluate(() => { window.__adjustMode = 'refuse'; window.__calls.adjust = []; window.__mountInv(); });
    await settle(page, 300);
    await page.click('.mnv-row:nth-child(1)');
    await page.click('[data-act="reason"][data-r="theft"]');
    await settle(page, 140);
    await page.click('[data-act="apply"]');
    await settle(page, 320);
    ck('a server refusal is shown in the SERVER\'s own words',
      /count again/i.test(await page.textContent('.mnv-sheet')));
    await page.click('[data-act="apply"]');
    await settle(page, 320);
    const ids = await page.evaluate(() => window.__calls.adjust.map(a => a.adjustmentId));
    ck('a retried correction reproduces the SAME adjustmentId',
      ids.length === 2 && ids[0] === ids[1], ids.join(' / '));

    /* ══ 9. Console hygiene ══ */
    console.log('\n  9. Nothing broke quietly');
    const real404 = errors.filter((e) => !/favicon|404/.test(e));
    ck('no page error or console error during the whole run', real404.length === 0, real404.slice(0, 2).join(' | '));

    await ctx.close();
  }

  await browser.close();
  server.close();

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
