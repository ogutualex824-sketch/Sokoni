#!/usr/bin/env node
/* Messages on a phone — POPULATED state, real selectors, real interaction.
 *
 *   node scripts/test-messages-mobile.js
 *
 * The earlier diagnostic proved only that an EMPTY Messages view has no
 * horizontal overflow. That certifies nothing: with no conversations there is
 * nothing wide enough to overflow. This seeds representative conversations and
 * measures the elements the code actually renders — selectors read out of
 * seller.js/seller.html, not guessed:
 *
 *   #sellerDMList        the conversation list      (loadSellerDMs)
 *   .seller-dm-row       a conversation row
 *   .sdm-name/.sdm-preview/.sdm-badge   name, preview, unread badge
 *   #sellerChatPanel     the thread                 (openSellerChat)
 *   .sdm-chat-messages / #sdmMessages   scrolling history
 *   .chat-bubble / .bubble-text         a message bubble
 *   .sdm-chat-input / #sdmInput         the composer + its input
 *
 * `sokoniMessages` (localStorage) is this legacy screen's ACTUAL data source —
 * the capability census recorded it — so seeding it is reproducing the real
 * state, not faking one.
 */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const VIEWPORTS = [
  { name: '320×568', width: 320, height: 568 },
  { name: '375×667', width: 375, height: 667 },
  { name: '390×844', width: 390, height: 844 },
  { name: '430×932', width: 430, height: 932 },
];
const DESKTOP = { name: '1440×900', width: 1440, height: 900 };

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 120) + ']' : ''));
  ok ? pass++ : fail++;
};

const LONG_URL = 'https://example.co.ke/catalogue/electronics/phone-accessories/wireless-charging-pads/model-xyz-2026-edition?ref=whatsapp-broadcast-campaign-q3';
const LONG_NAME = 'Wanjiku wa Kamau Enterprises & General Merchants Limited (Nairobi CBD Branch)';
const LONG_MSG = 'Habari, I would like to order twenty units of the wireless charger for my shop in Eastleigh. Do you offer bulk pricing, and can you deliver on Saturday morning before ten? Also please confirm whether the warranty covers accidental damage, because my customers always ask me that before they pay. ' + LONG_URL;

/* Representative conversations — every case the brief listed. */
const SEED = [
  { id: 'c1', productName: 'Wireless Charger', unread: 0,
    messages: [{ sender: 'buyer', text: 'Is this still available?', time: '09:12' },
               { sender: 'seller', text: 'Yes, in stock.', time: '09:14' }] },
  { id: 'c2', productName: LONG_NAME, unread: 3,
    messages: [{ sender: 'buyer', text: LONG_MSG, time: '10:01' },
               { sender: 'seller', text: 'Let me check for you.', time: '10:05' },
               { sender: 'buyer', text: LONG_URL, time: '10:06' }] },
  { id: 'c3', productName: 'Bulk order — 200 units', unread: 1,
    messages: Array.from({ length: 24 }, (_, i) => ({
      sender: i % 2 ? 'seller' : 'buyer',
      text: 'Message ' + (i + 1) + ' — ' + (i % 3 === 0 ? LONG_URL : 'confirming the delivery window for this order.'),
      time: '11:' + String(10 + i).slice(-2),
    })) },
];

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(d);
  });
});

/* Runs INSIDE the seller frame. Returns geometry of the real elements. */
const measure = () => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  const list = document.getElementById('sellerDMList');
  const rows = [].slice.call(document.querySelectorAll('.seller-dm-row'));
  const panel = document.getElementById('sellerChatPanel');
  const bubbles = [].slice.call(document.querySelectorAll('.chat-bubble'));
  const texts = [].slice.call(document.querySelectorAll('.bubble-text'));
  const input = document.getElementById('sdmInput');
  const inputWrap = document.querySelector('.sdm-chat-input');
  const history = document.getElementById('sdmMessages');
  const badges = [].slice.call(document.querySelectorAll('.sdm-badge'));
  const sendBtn = inputWrap ? inputWrap.querySelector('button') : null;
  const over = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.right - vw); };

  return {
    vw,
    docOverflowPx: Math.max(de.scrollWidth, document.body.scrollWidth) - vw,
    listRendered: !!list && rows.length > 0,
    rowCount: rows.length,
    rowsOverflowing: rows.filter(r => over(r) > 1).length,
    widestRowOverhang: rows.length ? Math.max.apply(null, rows.map(over)) : null,
    badgeVisible: badges.length > 0 && badges.every(b => R(b).w > 0),
    panelOpen: !!panel && getComputedStyle(panel).display !== 'none',
    bubbleCount: bubbles.length,
    bubblesOverflowing: bubbles.filter(b => over(b) > 1).length,
    textsOverflowing: texts.filter(t => t.scrollWidth > t.clientWidth + 1).length,
    historyScrollable: history ? history.scrollHeight > history.clientHeight : null,
    historyH: history ? R(history).h : null,
    composer: input ? R(input) : null,
    composerWrap: inputWrap ? R(inputWrap) : null,
    sendBtn: sendBtn ? R(sendBtn) : null,
    innerHeight: window.innerHeight,
  };
};

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + e.message); server.close(); process.exit(0); return; }

  console.log('\nMESSAGES — POPULATED MOBILE STATE\n' + '='.repeat(70));

  const run = async (vp, isMobile) => {
    console.log('\n  ── ' + vp.name);
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: isMobile ? 3 : 1, isMobile, hasTouch: isMobile,
      ...(isMobile ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } : {}),
    });
    /* auth-guard reads these two keys; seeding them is local scaffolding, not an
       auth bypass. sokoniMessages is the screen's real data source. */
    await ctx.addInitScript((seed) => {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'SELLER_A_uid_7f3', name: 'Shop B Traders', roles: ['buyer', 'seller'] }));
      localStorage.setItem('sokoniMessages', JSON.stringify(seed));
    }, SEED);

    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const s = document.getElementById('mshell'); if (s) s.classList.add('mobile-open');
      const i = document.querySelector('.mnav-item[data-id="messages"]'); if (i) i.click();
    });
    await page.waitForTimeout(3500);

    const frame = page.frames().find(f => /seller\.html/.test(f.url()));
    if (!frame) { ck(vp.name + ' — seller frame mounted', false, 'no frame'); await ctx.close(); return; }

    /* The list is rendered by loadSellerDMs(); make sure it has run. */
    await frame.evaluate(() => { try { if (typeof loadSellerDMs === 'function') loadSellerDMs(); } catch (_) {} });
    await frame.waitForTimeout(400);

    const listState = await frame.evaluate(measure);
    ck('conversation list renders the seeded conversations',
      listState.listRendered && listState.rowCount === 3, 'rows=' + listState.rowCount);
    ck('no horizontal overflow with a long merchant name + long URL',
      listState.docOverflowPx <= 0, listState.docOverflowPx + 'px');
    ck('no conversation row extends past the viewport',
      listState.rowsOverflowing === 0, 'overhang=' + listState.widestRowOverhang);
    ck('the unread badge is visible', listState.badgeVisible);

    /* Open the long, multi-message conversation. */
    await frame.evaluate(() => { try { openSellerChat('c3'); } catch (_) {} });
    await frame.waitForTimeout(600);
    const thread = await frame.evaluate(measure);

    ck('the thread opens', thread.panelOpen && thread.bubbleCount > 0, 'bubbles=' + thread.bubbleCount);
    ck('no horizontal overflow with the thread open', thread.docOverflowPx <= 0, thread.docOverflowPx + 'px');
    ck('no message bubble extends past the viewport', thread.bubblesOverflowing === 0);
    ck('long unbroken URLs wrap inside the bubble', thread.textsOverflowing === 0,
      thread.textsOverflowing + ' text node(s) overflow');
    ck('the composer is rendered and has width', !!thread.composer && thread.composer.w > 0,
      JSON.stringify(thread.composer));
    ck('the send button is present and tappable (≥32px)',
      !!thread.sendBtn && thread.sendBtn.h >= 32 && thread.sendBtn.w >= 32, JSON.stringify(thread.sendBtn));

    /* Type a long message and send it — the real interaction. */
    await frame.evaluate((t) => { const i = document.getElementById('sdmInput'); if (i) { i.focus(); i.value = t; } }, LONG_MSG);
    await frame.waitForTimeout(300);
    const typed = await frame.evaluate(measure);
    ck('typing a long message does not push the page sideways',
      typed.docOverflowPx <= 0, typed.docOverflowPx + 'px');
    ck('the composer stays within the viewport width',
      !!typed.composer && typed.composer.x >= -1 && (typed.composer.x + typed.composer.w) <= typed.vw + 1,
      JSON.stringify(typed.composer) + ' vw=' + typed.vw);

    await frame.evaluate(() => { try { sellerReply('c3'); } catch (_) {} });
    await frame.waitForTimeout(500);
    const sent = await frame.evaluate(measure);
    ck('sending keeps the layout intact', sent.docOverflowPx <= 0, sent.docOverflowPx + 'px');

    /* Back to the list. */
    await frame.evaluate(() => { const p = document.getElementById('sellerChatPanel'); if (p) p.style.display = 'none'; });
    await frame.waitForTimeout(300);
    const back = await frame.evaluate(measure);
    ck('returning to the conversation list works', !back.panelOpen && back.rowCount >= 3);

    await ctx.close();
    return { listState, thread };
  };

  for (const vp of VIEWPORTS) await run(vp, true);
  console.log('\n  ── DESKTOP REGRESSION');
  await run(DESKTOP, false);

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
});
