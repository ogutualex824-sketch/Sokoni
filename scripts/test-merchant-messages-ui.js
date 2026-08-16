/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT MESSAGES — RUNTIME, five viewports (2D-2 step 5)
   ══════════════════════════════════════════════════════════════════════════════
   The earlier Messages diagnostic found the structure sound but the composer far
   below the viewport on a long thread. This suite exists mainly to prove that is
   gone — with POPULATED conversations, not an empty fixture:

     · 40 messages, some 900 characters long, one 300-character URL with no spaces
     · a 62-character customer name
     · unread badges, including a 3-digit count

   And it runs at 320×568 (the smallest phone still in use) through 430×932, plus
   desktop, because a composer that is reachable at 390px and not at 320px is not
   reachable.

   Run: node scripts/test-merchant-messages-ui.js
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
<div id="wrap"><div class="native" id="native-messages"></div></div>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-messages.js"></script>
<script src="/sokoni-merchant-messages-ui.js"></script>
<script>
window.__calls = []; window.__mode = 'ok'; window.__ui = null;
var ME = 'SELLER_A_uid_7f3', THEM = 'BUYER_uid_11', SHOP_B = 'SHOP_B_shop_91c';
var LONG_NAME = 'Priscilla Wanjiru-Kamau Ochieng Muthoni Ndung\\'u Kiprotich';
var LONG_URL = 'https://mysokoni.co.ke/track/' + 'x'.repeat(260);
var LONG_TEXT = 'Thank you for the order. ' + 'This is a long explanation that must wrap. '.repeat(20);
var THREADS = [], MESSAGES = {};
function reset () {
  THREADS = [
    { conversationId:'c1', participantName: LONG_NAME, title:'Order ORD-1001',
      transactionType:'order', transactionId:'ORD-1001',
      lastMessageText:'Has it been sent?', lastMessageAt:{seconds:400}, unreadCount:127, status:'active' },
    { conversationId:'c2', participantName:'Ann Ali', title:'Order ORD-1002',
      lastMessageText:'Thank you!', lastMessageAt:{seconds:300}, unreadCount:0, status:'active' },
    { conversationId:'c3', participantName:'Bob Bee', title:'Order ORD-1003',
      lastMessageText:'Received, all good', lastMessageAt:{seconds:200}, unreadCount:2, status:'active' }
  ];
  MESSAGES = { c1: [], c2: [], c3: [] };
  for (var i = 0; i < 40; i++) {
    MESSAGES.c1.push({ id:'m'+i, senderId: i % 2 ? ME : THEM, senderName: i % 2 ? 'You' : 'Buyer',
      type:'text', text: i === 7 ? LONG_URL : (i === 12 ? LONG_TEXT : 'Message number ' + i),
      timestamp: { seconds: 100 + i } });
  }
  MESSAGES.c2 = [{ id:'z', senderId: THEM, type:'text', text:'Thank you!', timestamp:{seconds:300} }];
  MESSAGES.c3 = [];
}
reset();
window.__ctx = function (signedIn) {
  var scope = SokoniMerchantData.resolveScope({ uid: signedIn === false ? null : ME, activeShopId: SHOP_B });
  return {
    scope: scope,
    dispatch: async function (p) {
      window.__calls.push(p);
      if (p.op === 'searchConversations') {
        if (window.__mode === 'error') throw new Error('Your messages could not be loaded.');
        var rows = window.__mode === 'empty' ? [] : THREADS;
        if (p.query) rows = rows.filter(function (t) {
          return (t.participantName || '').toLowerCase().indexOf(String(p.query).toLowerCase()) !== -1; });
        return { data: { items: rows, hasMore: false } };
      }
      if (p.op === 'markRead') {
        var t = THREADS.filter(function (x) { return x.conversationId === p.conversationId; })[0];
        if (t) t.unreadCount = 0;
        return { data: { ok: true } };
      }
      if (p.op === 'sendMessage') {
        if (window.__mode === 'sendDenied') { var e = new Error('Not a participant in this conversation'); e.code='permission-denied'; throw e; }
        MESSAGES[p.conversationId].push({ id:'new', senderId: ME, type:'text', text: p.text, timestamp:{seconds:999} });
        return { data: { ok: true, messageId:'new' } };
      }
      return { data: { ok: true } };
    },
    db: {
      queryMessages: async function (spec) {
        window.__calls.push({ op:'__read', path: spec.path });
        if (window.__mode === 'threadDenied') { var e = new Error('Missing or insufficient permissions.'); e.code='permission-denied'; throw e; }
        return (MESSAGES[spec.path[1]] || []).slice();
      }
    },
    onToast: function (m,k) { (window.__toasts = window.__toasts || []).push([m,k]); }
  };
};
window.__mount = function (signedIn) {
  if (window.__ui) { try { window.__ui.destroy(); } catch (e) {} window.__ui = null; }
  var h = document.getElementById('native-messages'); h.innerHTML = '';
  window.__ui = SokoniMerchantMessagesUI.mount(h, window.__ctx(signedIn));
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
  { name: 'iPhone SE (small)', width: 320, height: 568 },
  { name: 'iPhone SE',         width: 375, height: 667 },
  { name: 'iPhone 14',         width: 390, height: 844 },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
  { name: 'Desktop',           width: 1280, height: 800 },
];
const settle = (page, ms = 220) => page.waitForTimeout(ms);
/* Read the Nth thread ROW. The first child of .mmg-body is the scope banner, so
   :nth-child(1) is never a row — the same offset that made the Disputes suite
   assert about the wrong card. Index among actual rows instead. */
const rowText = async (page, i) => {
  const rows = await page.$$('.mmg-row');
  if (!rows[i]) throw new Error('no thread row at ' + i + ' (found ' + rows.length + ')');
  return rows[i].evaluate((e) => e.textContent);
};
const rowProp = async (page, i, sel, fn) => {
  const rows = await page.$$('.mmg-row');
  const el = await rows[i].$(sel);
  return el.evaluate(fn);
};

/* Open a thread BY NAME. Selecting by position is fragile here for a second
   reason beyond the banner offset: the list sorts unread-first, so the fixture's
   display order is not its declaration order — index 2 was the one-message
   thread, not the empty one, and the assertion failed while looking like a real
   defect. */
const openThreadNamed = async (page, name) => {
  const rows = await page.$$('.mmg-row');
  for (const r of rows) {
    const t = await r.evaluate((e) => e.textContent);
    if (t.indexOf(name) !== -1) { await r.click(); return; }
  }
  throw new Error('no thread row named ' + name + ' (found ' + rows.length + ' rows)');
};

const openThread = async (page, i) => {
  const rows = await page.$$('.mmg-row');
  if (!rows[i]) throw new Error('no thread row at ' + i + ' (found ' + rows.length + ')');
  await rows[i].click();
};

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

    console.log('\n  1. The inbox');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 340);
    ck('conversations are listed', (await page.$$('.mmg-row')).length === 3);
    ck('the inbox came from the searchConversations OP',
      await page.evaluate(() => window.__calls.some((c) => c.op === 'searchConversations')));
    ck('unread threads sort first', /Priscilla/.test(await rowText(page, 0)));
    ck('a 3-digit unread count is capped and visible', /99\+/.test(await page.textContent('.mmg-body')));
    ck('a zero-unread thread shows no badge',
      (await page.$$('.mmg-badge')).length === 2, 'two threads have unread, one does not');
    ck('the participant scope is stated', /part of/i.test(await page.textContent('.mmg-body')));

    console.log('\n  2. Long names and the list layout');
    const o1 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth }));
    ck('a 62-character name does not scroll the page sideways', o1.doc <= 0 && o1.body <= 0, JSON.stringify(o1));
    ck('...it ellipsises', await rowProp(page, 0, '.mmg-nm', (e) => getComputedStyle(e).textOverflow === 'ellipsis'));
    ck('...and the unread badge is still on screen', await page.$eval('.mmg-badge', (e) => {
      const r = e.getBoundingClientRect();
      return r.right <= window.innerWidth + 1 && r.left >= -1 && r.width > 0;
    }));

    console.log('\n  3. THE COMPOSER — reachable without scrolling a 40-message thread');
    await openThreadNamed(page, 'Priscilla');
    await settle(page, 420);
    ck('the thread opened', (await page.$('.mmg-thread')) !== null);
    ck('40 messages rendered', (await page.$$('.mmg-msg')).length === 40);
    ck('the thread body came from a participant-gated READ',
      await page.evaluate(() => window.__calls.some((c) => c.op === '__read' && c.path[0] === 'conversations')));

    const composer = await page.evaluate(() => {
      const c = document.querySelector('.mmg-composer');
      const t = document.querySelector('#mmg-draft');
      const list = document.querySelector('.mmg-msgs');
      if (!c || !t || !list) return null;
      const cr = c.getBoundingClientRect(), tr = t.getBoundingClientRect(), lr = list.getBoundingClientRect();
      return { cBottom: cr.bottom, cTop: cr.top, tBottom: tr.bottom, tTop: tr.top,
        vh: window.innerHeight, listScrollable: list.scrollHeight > list.clientHeight,
        listBottom: lr.bottom, pageScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight };
    });
    ck('the composer is INSIDE the viewport without scrolling',
      composer && composer.cTop >= 0 && composer.cBottom <= composer.vh + 1,
      JSON.stringify(composer));
    ck('...and so is the text field itself',
      composer && composer.tTop >= 0 && composer.tBottom <= composer.vh + 1);
    ck('the message list is what scrolls, not the page',
      composer && composer.listScrollable === true && composer.pageScroll <= 0,
      'listScrollable=' + (composer && composer.listScrollable) + ' pageScroll=' + (composer && composer.pageScroll));

    /* Scroll the thread to the very top — the composer must not move. */
    await page.evaluate(() => { document.querySelector('.mmg-msgs').scrollTop = 0; });
    await settle(page, 160);
    const after = await page.evaluate(() => {
      const c = document.querySelector('.mmg-composer').getBoundingClientRect();
      return { top: c.top, bottom: c.bottom, vh: window.innerHeight };
    });
    ck('...and it stays put when the thread is scrolled to the top',
      after.bottom <= after.vh + 1 && after.top >= 0, JSON.stringify(after));

    console.log('\n  4. Long content wraps');
    const overflowInThread = await page.evaluate(() => {
      const list = document.querySelector('.mmg-msgs');
      const wide = Array.from(document.querySelectorAll('.mmg-msg'))
        .filter((m) => m.getBoundingClientRect().right > window.innerWidth + 1).length;
      return { horizontal: list.scrollWidth - list.clientWidth, wide };
    });
    ck('a 290-character URL with no spaces does not scroll the thread sideways',
      overflowInThread.horizontal <= 0, JSON.stringify(overflowInThread));
    ck('...and no bubble extends past the viewport', overflowInThread.wide === 0);
    ck('a 900-character message wraps rather than clipping',
      await page.evaluate(() => {
        const m = Array.from(document.querySelectorAll('.mmg-msg')).find((e) => e.textContent.length > 800);
        return !!m && m.getBoundingClientRect().height > 40;
      }));

    console.log('\n  5. Sending');
    await page.fill('#mmg-draft', 'It went out this morning, tracking is on the way.');
    await settle(page, 120);
    await page.click('[data-act="send"]');
    await settle(page, 460);
    const sendCall = await page.evaluate(() => window.__calls.find((c) => c.op === 'sendMessage'));
    ck('sending is an OP on the dispatcher, with the conversation and text',
      sendCall && sendCall.conversationId === 'c1' && /went out this morning/.test(sendCall.text));
    ck('the thread is RE-READ after sending, not appended locally',
      (await page.evaluate(() => window.__calls.filter((c) => c.op === '__read').length)) >= 2);
    ck('the sent message appears', /went out this morning/.test(await page.textContent('.mmg-msgs')));
    ck('the draft is cleared', (await page.$eval('#mmg-draft', (e) => e.value)) === '');

    console.log('\n  6. A refused send does not fake a sent message');
    await page.evaluate(() => { window.__mode = 'sendDenied'; });
    await page.fill('#mmg-draft', 'This one will be refused by the server.');
    await settle(page, 120);
    await page.click('[data-act="send"]');
    await settle(page, 420);
    ck('the refusal is shown in the server\'s words',
      /Not a participant/.test(await page.textContent('.mmg-thread')));
    ck('...and the refused text is NOT in the conversation',
      !(await page.textContent('.mmg-msgs')).includes('refused by the server'));
    await page.evaluate(() => { window.__mode = 'ok'; });

    console.log('\n  7. Back to the list, and unread clears through the server');
    await page.click('[data-act="back"]');
    await settle(page, 320);
    ck('back returns to the conversation list', (await page.$('.mmg-thread')) === null && (await page.$$('.mmg-row')).length === 3);
    ck('markRead was an OP, not a local flag',
      await page.evaluate(() => window.__calls.some((c) => c.op === 'markRead' && c.conversationId === 'c1')));
    ck('...and the badge is gone after the list was re-read',
      !(await rowText(page, 0)).includes('99+'));

    console.log('\n  8. States');
    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 340);
    await openThreadNamed(page, 'Bob Bee');
    await settle(page, 400);
    ck('an empty conversation invites a first message', /No messages yet/i.test(await page.textContent('.mmg-thread')));
    ck('...and still shows a usable composer', (await page.$('#mmg-draft')) !== null);
    await page.click('[data-act="back"]');
    await settle(page, 300);

    await page.evaluate(() => { window.__mode = 'threadDenied'; });
    await openThreadNamed(page, 'Priscilla');
    await settle(page, 420);
    ck('a refused thread read is reported, not shown as empty',
      /could not be opened/i.test(await page.textContent('.mmg-thread')));
    ck('...with a retry', (await page.$('[data-act="retry-thread"]')) !== null);
    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(); });
    await settle(page, 340);

    await page.evaluate(() => { window.__mode = 'empty'; window.__mount(); });
    await settle(page, 340);
    ck('an empty inbox says so', /No conversations yet/i.test(await page.textContent('.mmg-body')));
    await page.evaluate(() => { window.__mode = 'error'; window.__mount(); });
    await settle(page, 340);
    const errTxt = await page.textContent('.mmg-body');
    ck('a failed read is a failure', /could not be loaded/i.test(errTxt));
    ck('...and NOT an empty inbox', !/No conversations yet/i.test(errTxt));
    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(false); });
    await settle(page, 320);
    ck('a signed-out account is told to sign in', /Sign in to see your messages/i.test(await page.textContent('.mmg')));

    console.log('\n  9. Ergonomics and hygiene');
    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 340);
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
    const ls = await page.evaluate(() => Object.keys(localStorage));
    ck('the surface wrote NO localStorage key', ls.length === 0, ls.join(','));
    const real = errors.filter((e) => !/favicon|404/.test(e));
    ck('no page error or console error during the whole run', real.length === 0, real.slice(0, 2).join(' | '));

    await ctx.close();
  }
  await browser.close(); server.close();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
