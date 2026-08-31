#!/usr/bin/env node
/**
 * MINISHOP → CART — driven in a real browser, mobile and desktop.
 *
 *   node scripts/test-minishop-cart-browser.js
 *
 * The MiniShop storefront had NO add-to-cart control at all: a product card could only
 * navigate to product.html, and the page never even loaded the cart service. A shopper
 * on a seller's shared /shop/<handle> link could not buy from the shop page.
 *
 * CONVERGENCE, not a second implementation. getMinishopPublic returns the canonical
 * `products` documents filtered by shopId — the same catalogue Merchant V2 writes — so a
 * product created in the merchant shell is the same record the MiniShop renders. This
 * suite proves the storefront reaches the SAME SokoniCart, with seller attribution taken
 * from the product record rather than from whichever shop page happened to be open.
 *
 * THE MONEY BOUNDARY IS UNCHANGED AND MUST STAY SO: the cart line carries a price because
 * the cart DISPLAYS one, but checkout sends productId and qty only and the server
 * recomputes. Asserted here as a control so a future MiniShop change cannot quietly start
 * asserting an amount.
 *
 * The storefront's own fetch is intercepted with fixtures so the page renders REAL cards
 * from REAL code; the clicks are real clicks on those cards.
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* Two products from ONE shop (a MiniShop is one seller), plus a foreign line added
   directly to the cart so multi-seller separation can be checked. */
const PAYLOAD = {
  ok: true,
  shop: { id: 'SHOP_A', name: 'Bravilex', handle: 'bravilex', sellerUid: 'SELLER_A' },
  config: {},
  products: [
    { id: 'm1', name: 'Bravilex Shirt', price: 2500, shopId: 'SHOP_A', sellerUid: 'SELLER_A',
      imageUrl: '', category: 'Clothing', stock: 8, status: 'active' },
    { id: 'm2', name: 'Bravilex Cap', price: 800, shopId: 'SHOP_A', sellerUid: 'SELLER_A',
      imageUrl: '', category: 'Clothing', stock: 4, status: 'active' },
  ],
  reviews: [], totalProducts: 2, followerCount: 0,
};

const CART_STATE = `(function () {
  var c = window.SokoniCart;
  if (!c) return { ok: false };
  var l = c.list() || [];
  return { ok: true, lines: c.lines(), units: c.units(),
           ids: l.map(function (i) { return i.id; }),
           sellers: l.map(function (i) { return i.sellerId || i.sellerUid || null; }),
           prices: l.map(function (i) { return Number(i.price); }) };
})()`;

(async () => {
  console.log(NL + 'MINISHOP → CART (real browser)' + NL + '='.repeat(60));

  let webkit;
  try { ({ webkit } = require('playwright')); }
  catch (_) {
    console.log(NL + '  ENV  playwright is not installed — cannot drive the storefront.');
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  const server = http.createServer((rq, rs) => {
    let name = (rq.url.split('?')[0] || '/').replace(/^\//, '') || 'index.html';
    if (!path.extname(name)) name += '.html';
    fs.readFile(path.join(ROOT, name), (e, d) => {
      if (e) { rs.writeHead(404); return rs.end('nf'); }
      rs.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'text/plain' });
      rs.end(d);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;

  let br;
  try { br = await webkit.launch(); }
  catch (e) {
    console.log(NL + '  ENV  browser could not launch: ' + String(e && e.message || e).slice(0, 64));
    server.close();
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  async function run (label, viewport) {
    head(label + ' — ' + viewport.width + 'x' + viewport.height);
    const ctx = await br.newContext({ viewport });
    const page = await ctx.newPage();
    try {
      /* The storefront's own data call, answered with fixtures so REAL code renders. */
      await page.route('**/getMinishopPublic**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json',
                        headers: { 'Access-Control-Allow-Origin': '*' },
                        body: JSON.stringify(PAYLOAD) }));

      await page.goto(base + '/minishop.html?handle=bravilex', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);

      /* Clear the transient chrome a real shopper would clear: consent, then the
       notification prompt. Neither is a full-viewport blocker — the toast root is
       pointer-events:none and the notif prompt is a small bottom card — but both sit
       over the grid briefly and would make a click flaky rather than prove anything. */
      const acc = page.locator('#_sokoniPrivacyAcceptBtn');
      if (await acc.count()) { await acc.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(500); }
      await page.evaluate(`(function(){
        var p = document.getElementById('sokoniNotifPrompt'); if (p) p.remove();
      })()`);

      /* Toasts are transient and dismissible; wait them out between clicks so the
         assertion measures the CART, not toast timing. */
      const settle = async () => {
        await page.evaluate(`(function(){
          var r = document.getElementById('sk-toast-root'); if (r) r.innerHTML = '';
          var p = document.getElementById('sokoniNotifPrompt'); if (p) p.remove();
        })()`);
        await page.waitForTimeout(250);
      };

      ck(label + ': the cart service is loaded on the storefront',
         await page.evaluate('typeof window.SokoniCart === "object" && !!window.SokoniCart'),
         'it was not loaded at all before — there was no cart to add to');

      const cards = await page.locator('.ms-product-card').count();
      ck(label + ': product cards rendered from the canonical catalogue', cards >= 2, cards + ' cards');

      const addBtns = page.locator('.ms-add-btn:visible');
      const nBtn = await addBtns.count();
      ck(label + ': every card offers a VISIBLE Add to cart', nBtn === cards, nBtn + ' of ' + cards);

      /* ── the real click ── */
      await page.evaluate('window.SokoniCart && window.SokoniCart.list().slice().forEach(function(){window.SokoniCart.removeAt(0);})');
      await settle();
      await addBtns.first().click({ timeout: 5000 });
      await page.waitForTimeout(400);
      let st = await page.evaluate(CART_STATE);
      ck(label + ': clicking it adds the product', st.ok && st.units === 1,
         JSON.stringify({ lines: st.lines, ids: st.ids }));
      ck(label + ': the line is attributed to the SHOP that sells it',
         st.sellers[0] === 'SELLER_A', String(st.sellers[0]));

      /* minishop.html sets data-no-header, so the marketplace pip does not exist here
         by design — a seller's shop does not wear SOKONI's nav. The storefront has its
         OWN indicator over the same cart, and that is what must update. */
      const badge = await page.evaluate(`(function(){var p=document.getElementById('msCartPill');
        if(!p) return {present:false};
        return { present:true, text:(p.textContent||'').replace(/[^0-9]/g,''),
                 hidden:p.hidden, display:getComputedStyle(p).display };})()`);
      ck(label + ': the storefront cart indicator updates immediately',
         badge.present && badge.text === '1' && !badge.hidden, JSON.stringify(badge));
      ck(label + ': CONTROL the marketplace header is deliberately absent here',
         await page.evaluate('!document.getElementById("sk-nav-cart-pip")'),
         'data-no-header — a sellers shop must not wear the marketplace nav');

      /* ── duplicate-tap protection ── */
      await settle();
      await addBtns.first().click({ timeout: 5000 });
      await page.waitForTimeout(400);
      const dup = await page.evaluate(CART_STATE);
      ck(label + ': a second tap is a no-op, not a duplicate row',
         dup.lines === st.lines && dup.units === st.units,
         dup.lines + ' lines / ' + dup.units + ' units');

      /* ── second product from the same shop ── */
      await settle();
      await addBtns.nth(1).click({ timeout: 5000 });
      await page.waitForTimeout(400);
      const two = await page.evaluate(CART_STATE);
      ck(label + ': a second product coexists', two.lines === 2, JSON.stringify(two.ids));
      ck(label + ': each line keeps its own price',
         two.prices.indexOf(2500) > -1 && two.prices.indexOf(800) > -1, two.prices.join(','));

      /* ── multi-seller separation ── */
      const multi = await page.evaluate(`(function(){
        window.SokoniCart.add({ id:'x9', name:'Sugar', price:320, sellerId:'SELLER_B', shopId:'SHOP_B', qty:1 });
        var l = window.SokoniCart.list();
        var s = l.map(function(i){return i.sellerId;});
        return { sellers:s, distinct:s.filter(function(v,i,a){return a.indexOf(v)===i;}).length };
      })()`);
      ck(label + ': a MiniShop line does not absorb another sellers goods',
         multi.distinct === 2, multi.sellers.join(','));

      /* ── persistence ── */
      const before = await page.evaluate(CART_STATE);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const after = await page.evaluate(CART_STATE);
      ck(label + ': the cart survives a reload of the storefront',
         after.ok && after.units === before.units, before.units + 'u → ' + after.units + 'u');
    } finally {
      await ctx.close();
    }
  }

  try {
    await run('mobile', { width: 390, height: 844 });
    await run('desktop', { width: 1280, height: 900 });
  } finally {
    try { await br.close(); } catch (_) {}
    server.close();
  }

  /* ── the boundary that must not move ── */
  head('the money boundary is untouched');
  const MS = fs.readFileSync(path.join(ROOT, 'sokoni-minishop.js'), 'utf8');
  const CO = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
  /* Strip comments first: the module NAMES createCheckoutSession in a comment explaining
     that checkout owns it, and matching prose made this fail against correct code. */
  const MS_CODE = (function (t) {
    var out = '', k = 0;
    var open = '/' + '*', close = '*' + '/';
    while (k < t.length) {
      var a = t.indexOf(open, k);
      if (a === -1) { out += t.slice(k); break; }
      out += t.slice(k, a);
      var b = t.indexOf(close, a);
      if (b === -1) break;
      k = b + close.length;
    }
    return out;
  })(MS);
  /* Assert INVOCATIONS, not the word. The module names IntaSend in a trust badge
     ('Secure Payments via IntaSend') — display copy, not a call — and matching the
     bare string failed against correct code. What must never appear is the MiniShop
     itself invoking a payment or session endpoint. */
  function callsPaymentEndpoint (code) {
    var names = ['createCheckoutSession', 'verifyIntasendPayment', 'initiateSTK', 'darajaSTKPush'];
    for (var i = 0; i < names.length; i++) if (code.indexOf(names[i]) > -1) return names[i];
    var callers = ['httpsCallable(', 'fetch('];
    for (var c = 0; c < callers.length; c++) {
      var k = 0;
      while ((k = code.indexOf(callers[c], k)) > -1) {
        var win = code.slice(k, k + 120).toLowerCase();
        if (win.indexOf('intasend') > -1 || win.indexOf('checkoutsession') > -1) return callers[c] + '…';
        k += callers[c].length;
      }
    }
    return null;
  }
  var offender = callsPaymentEndpoint(MS_CODE);
  ck('the MiniShop never CALLS a payment or session endpoint', offender === null,
     offender || 'it fills the cart; checkout owns the money');
  ck('CONTROL the detector would catch a real call',
     callsPaymentEndpoint("httpsCallable(fns,'createCheckoutSession')") !== null,
     'a check that matches nothing would pass over any future payment call');
  ck('checkout still sends productId and qty ONLY',
     /productId:\s*String\(/.test(CO) && !/cartForSession[\s\S]{0,400}price:/.test(CO));
  ck('CONTROL the server total is still the charged amount',
     /let stkAmount = null;/.test(CO) && /stkAmount\s*=\s*sessionRes\.data\.serverTotal;/.test(CO));

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
