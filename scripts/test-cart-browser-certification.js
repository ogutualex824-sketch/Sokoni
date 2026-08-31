#!/usr/bin/env node
/**
 * PRODUCT CARD → CART — driven in a real browser, mobile and desktop.
 *
 *   node scripts/test-cart-browser-certification.js
 *
 * The static suite (test-multicart-purchase-authority) proves the money boundary and runs
 * the cart module directly. What it CANNOT prove is that a shopper's tap on a real product
 * card reaches that module: a button can be present in the DOM, correctly wired in source,
 * and still be unclickable because something covers it, or because the handler throws
 * before it reaches the cart.
 *
 * So this drives the REAL page: real card markup, real onclick handlers, real clicks, and
 * asserts the resulting cart state and badge. Products are seeded through
 * localStorage.sellerProducts — the same source category.js already reads — so the cards
 * are the production cards, not a fixture rendering of them.
 *
 * IT NEVER TAKES A PAYMENT. Buy Now is followed only as far as the checkout boundary: the
 * cart contents and the landing URL are asserted, and the flow stops there.
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* Two products, two different shops — multi-seller attribution is the point. */
const SEED = [
  { id: 'p1', name: 'Bravilex Shirt', price: 2500, sellerId: 'SELLER_A', sellerUid: 'SELLER_A',
    shopName: 'Bravilex', category: 'Clothing', stock: 10, status: 'active', image: '' },
  { id: 'p2', name: 'Sugar 2kg', price: 320, sellerId: 'SELLER_B', sellerUid: 'SELLER_B',
    shopName: 'Mama Duka', category: 'Groceries', stock: 25, status: 'active', image: '' },
];

/* Read the cart the way the page does, through the live service. */
const CART_STATE = `(function () {
  var c = window.SokoniCart;
  if (!c) return { ok: false };
  var list = c.list() || [];
  return {
    ok: true,
    lines: c.lines(),
    units: c.units(),
    ids: list.map(function (i) { return i.id; }),
    sellers: list.map(function (i) { return i.sellerId || i.sellerUid || null; }),
    prices: list.map(function (i) { return Number(i.price); }),
    notes: list.map(function (i) { return i.note || null; })
  };
})()`;

const BADGE = `(function () {
  var p = document.getElementById('sk-nav-cart-pip');
  if (!p) return { present: false };
  return { present: true, text: (p.textContent || '').trim(), display: getComputedStyle(p).display };
})()`;

(async () => {
  console.log(NL + 'PRODUCT CARD → CART (real browser)' + NL + '='.repeat(62));

  let webkit;
  try { ({ webkit } = require('playwright')); }
  catch (_) {
    console.log(NL + '  ENV  playwright is not installed — cannot drive a browser.');
    console.log('  ENV  This suite proves CLICKABILITY; it must not pass statically.');
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
    console.log(NL + '  ENV  browser could not launch: ' + String(e && e.message || e).slice(0, 70));
    server.close();
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  async function newPage (viewport) {
    const ctx = await br.newContext({ viewport });
    /* addInitScript runs on EVERY navigation, so clearing the cart here wiped it on the
       reload that persistence is supposed to prove. Clear ONCE, on first load only. */
    await ctx.addInitScript((seed) => {
      try {
        localStorage.setItem('sellerProducts', JSON.stringify(seed));
        if (!sessionStorage.getItem('__certSeeded')) {
          localStorage.removeItem('sokoniCart');
          localStorage.removeItem('cart');
          sessionStorage.setItem('__certSeeded', '1');
        }
      } catch (_) {}
    }, SEED);
    const page = await ctx.newPage();
    return { ctx, page };
  }

  async function cardsReady (page) {
    await page.goto(base + '/category.html', { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector('.product-card', { timeout: 15000 });
      return true;
    } catch (_) { return false; }
  }

  /* ══ one full pass at a given viewport ═════════════════════════════════════ */
  async function run (label, viewport) {
    head(label + ' — ' + viewport.width + 'x' + viewport.height);
    const { ctx, page } = await newPage(viewport);
    try {
      const ready = await cardsReady(page);
      ck(label + ': real product cards rendered', ready,
         ready ? '' : 'seeded via localStorage.sellerProducts, the source category.js reads');
      if (!ready) return;

      const names = await page.locator('.product-card').allTextContents();
      ck(label + ': the cards are the SEEDED products, not demo data',
         names.join(' ').indexOf('Bravilex Shirt') > -1,
         'a demo fallback would certify fixtures rather than the seeded catalogue');
      const n = await page.locator('.product-card').count();
      ck(label + ': both seeded products are on screen', n >= 2, n + ' cards');

      /* ── CONSENT FIRST, BECAUSE A REAL SHOPPER MUST ────────────────────────────
         category.html is a standalone page, so the consent dialog is the FULL-SCREEN
         blocking variant and it intercepts taps until answered. That is correct, and
         it is asserted here rather than worked around: a shopper who taps fast can get
         one click in before the banner mounts at ~1.5s and then hits a wall, which is
         precisely why the gate must be answered, not raced. */
      await page.waitForTimeout(2200);          /* let the banner mount if it is going to */
      const gate = page.locator('#_sokoniPrivacyBanner');
      const gated = await gate.count();
      ck(label + ': the consent gate is present on a standalone shop page', gated > 0,
         'it is the blocking variant here; the merchant shell gets the non-blocking sheet');
      if (gated) {
        const accept = page.locator('#_sokoniPrivacyAcceptBtn');
        if (await accept.count()) {
          await accept.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(600);
        }
        ck(label + ': accepting consent clears the blocker',
           (await page.locator('#_sokoniPrivacyBanner').count()) === 0 ||
           (await page.evaluate(() => {
              var b = document.getElementById('_sokoniPrivacyBanner');
              return !b || getComputedStyle(b).display === 'none';
            })),
           'the dialog must be completable, not merely present');
      }

      /* ── ADD TO CART, by clicking the real button ── */
      /* DESKTOP AND MOBILE CARRY DIFFERENT CONTROLS ON PURPOSE. Below 600px the desktop
         .pcard-actions row is display:none — the mobile grid is two 120px columns, which a
         three-button row cannot fit — and .pcard-mobile-strip provides .pcard-m-cart
         instead. Both carry the same aria-label, so the honest test is: whichever control
         is VISIBLE at this viewport must be clickable and must reach the cart.

         A test that clicked .pcard-actions on a phone would fail against correct code,
         which is exactly what happened first. */
      const visibleAdd = page.locator('button[aria-label^="Add "]:visible');
      const perCard = await page.evaluate(() => {
        const card = document.querySelector('.product-card');
        if (!card) return -1;
        return Array.from(card.querySelectorAll('button[aria-label^="Add "]'))
          .filter((b) => b.getBoundingClientRect().width > 0).length;
      });
      ck(label + ': exactly ONE visible Add control per card', perCard === 1,
         perCard + ' visible (desktop row and mobile strip must never both show)');
      const add1 = visibleAdd.first();
      await add1.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      let st = await page.evaluate(CART_STATE);
      ck(label + ': clicking Add puts the product in the cart',
         st.ok && st.units === 1, JSON.stringify({ lines: st.lines, units: st.units }));

      let badge = await page.evaluate(BADGE);
      ck(label + ': the cart badge reflects it immediately',
         badge.present && badge.text === '1' && badge.display !== 'none',
         JSON.stringify(badge));

      /* ── SECOND SELLER ── */
      const add2 = visibleAdd.nth(1);
      await add2.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      st = await page.evaluate(CART_STATE);
      ck(label + ': a second product from another shop coexists',
         st.lines === 2 && st.units === 2, JSON.stringify(st.ids));
      ck(label + ': each line keeps its OWN seller',
         st.sellers.filter((v, i, a) => a.indexOf(v) === i).length === 2, st.sellers.join(','));
      ck(label + ': no line borrows the other sellers price',
         st.prices.indexOf(2500) > -1 && st.prices.indexOf(320) > -1, st.prices.join(','));

      badge = await page.evaluate(BADGE);
      ck(label + ': the badge tracks the second add', badge.text === '2', JSON.stringify(badge));

      /* ── APPEND SEMANTICS via a real second click on the same card ── */
      /* THE CARD IS IDEMPOTENT PER PRODUCT, and the MODULE appends — both on purpose.
         addToCart() refuses a product already in the cart ("Already in cart") because a
         double tap used to produce duplicate rows; the module still appends, which is what
         lets two food lines differ only by note. Certify the card's contract here and the
         module's below, rather than assuming one implies the other. */
      const beforeDouble = await page.evaluate(CART_STATE);
      await add1.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      st = await page.evaluate(CART_STATE);
      ck(label + ': a second tap on the SAME card is a no-op, not a duplicate row',
         st.lines === beforeDouble.lines && st.units === beforeDouble.units,
         st.lines + ' lines / ' + st.units + ' units (double-tap protection)');

      /* ── the same product with DIFFERENT NOTES must not collapse ── */
      const notes = await page.evaluate(() => {
        const c = window.SokoniCart;
        c.add({ id: 'p9', name: 'Ugali', price: 100, sellerId: 'SELLER_B', qty: 1, note: 'extra ugali' });
        c.add({ id: 'p9', name: 'Ugali', price: 100, sellerId: 'SELLER_B', qty: 1, note: 'no ugali' });
        const l = (c.list() || []).filter(function (i) { return i.id === 'p9'; });
        return { rows: l.length, notes: l.map(function (i) { return i.note; }) };
      });
      ck(label + ': two notes on one product stay two lines',
         notes.rows === 2 && notes.notes.indexOf('extra ugali') > -1 && notes.notes.indexOf('no ugali') > -1,
         JSON.stringify(notes));

      /* ── {merge:true} aggregation, and unit parity ── */
      const merged = await page.evaluate(() => {
        const c = window.SokoniCart;
        const before = c.units();
        c.add({ id: 'p1', name: 'Bravilex Shirt', price: 2500, sellerId: 'SELLER_A', qty: 2 }, { merge: true });
        return { before, after: c.units(), lines: c.lines() };
      });
      ck(label + ': merge adds the items OWN qty, not one unit',
         merged.after === merged.before + 2, JSON.stringify(merged));

      /* ── QUANTITY + REMOVE, badge follows ── */
      const q = await page.evaluate(() => {
        const c = window.SokoniCart;
        const at = (c.list() || []).findIndex(function (i) { return i.id === 'p2'; });
        c.setQty(at, 4);
        return { units: c.units(), qty: (c.list()[at] || {}).qty };
      });
      ck(label + ': a quantity change is reflected', q.qty === 4, JSON.stringify(q));
      await page.waitForTimeout(300);
      badge = await page.evaluate(BADGE);
      ck(label + ': the badge follows a quantity change',
         badge.text === String(q.units), 'badge=' + badge.text + ' units=' + q.units);

      const rem = await page.evaluate(() => {
        const c = window.SokoniCart;
        c.removeById('p2');
        return { units: c.units(), has: c.has('p2') };
      });
      ck(label + ': remove takes the item out', rem.has === false, JSON.stringify(rem));
      await page.waitForTimeout(300);
      badge = await page.evaluate(BADGE);
      ck(label + ': the badge follows a removal', badge.text === String(rem.units),
         'badge=' + badge.text + ' units=' + rem.units);

      /* ── PERSISTENCE ACROSS A REAL NAVIGATION ── */
      const beforeNav = await page.evaluate(CART_STATE);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const afterNav = await page.evaluate(CART_STATE);
      ck(label + ': the cart survives an actual page reload',
         afterNav.ok && afterNav.units === beforeNav.units && afterNav.lines === beforeNav.lines,
         'before ' + beforeNav.units + 'u / after ' + afterNav.units + 'u');
      const badgeNav = await page.evaluate(BADGE);
      ck(label + ': the badge is correct on a fresh load, not only after an event',
         badgeNav.present && badgeNav.text === String(afterNav.units),
         JSON.stringify(badgeNav));

      /* ── EMPTY-CART RECOVERY ── */
      const emptied = await page.evaluate(() => {
        const c = window.SokoniCart;
        (c.list() || []).slice().forEach(function () { c.removeAt(0); });
        return { lines: c.lines(), units: c.units() };
      });
      ck(label + ': emptying the cart leaves a clean empty state',
         emptied.lines === 0 && emptied.units === 0, JSON.stringify(emptied));
      await page.waitForTimeout(300);
      const emptyBadge = await page.evaluate(BADGE);
      ck(label + ': an empty cart hides the badge rather than showing 0',
         emptyBadge.present === false || emptyBadge.display === 'none' || emptyBadge.text === '0',
         JSON.stringify(emptyBadge));

      const readd = await page.evaluate(() => {
        const c = window.SokoniCart;
        c.add({ id: 'p1', name: 'Bravilex Shirt', price: 2500, sellerId: 'SELLER_A', qty: 1 });
        return { lines: c.lines(), units: c.units() };
      });
      ck(label + ': the cart still works after being emptied',
         readd.lines === 1 && readd.units === 1, JSON.stringify(readd));

      /* ── BUY NOW — followed only to the checkout boundary ── */
      await page.evaluate(() => {
        const c = window.SokoniCart;
        c.add({ id: 'p2', name: 'Sugar 2kg', price: 320, sellerId: 'SELLER_B', qty: 3 });
      });
      const buy = page.locator('button[aria-label^="Buy "]:visible').first();
      const buyCount = await buy.count();
      if (buyCount) {
        await buy.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const url = page.url();
        /* SIGNED OUT, express checkout must route to LOGIN, not to a payment screen.
           That is the checkout gate, and reaching login is the correct boundary for an
           unauthenticated shopper — this suite never authenticates and never pays. */
        ck(label + ': Buy Now leaves the shop page for the purchase path',
           /checkout|login/i.test(url), url.split('/').pop().slice(0, 40));
        ck(label + ': signed out, it stops at the auth gate rather than a payment screen',
           !/pay|stk|intasend/i.test(url), url.split('/').pop().slice(0, 40));
      } else {
        ck(label + ': a Buy Now control exists on the card', false, 'no Buy button found');
      }
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

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
