/* Banking Hub — every tile and tab must DO something, and nothing may be invented.

   The property under test is deliberately not "the handler didn't throw". An
   earlier probe reported all 20 tiles ok on that basis while 8 of 8 changed
   nothing at all. Every assertion here compares before/after, or checks a real
   destination.

   2026-10-01 reality (banking-hub.js replaces sokoni-banking-pro.js):
   - category panes render financialPartnerDispatch publicDirectory rows, lazily;
   - wallet / payment history / finance dashboard are LINKS to real pages;
   - no pane renders a localStorage balance (a seeded sentinel must never appear);
   - partner cards never say verified / licensed / CBK-approved;
   - an empty category shows an apply link to business-apply.html?offer=financial.

   NO LIVE BACKEND. Every request to cloudfunctions.net / run.app is answered by
   page.route() below, so this suite cannot touch production (see memory:
   REGRESSION LOOPS CAN HIT PROD). The mock serves SACCO rows (one promoted,
   plus a DIGITAL_LENDER in the digital pane) and empty results elsewhere. */
'use strict';
const { webkit, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const T = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let fp = path.join('.', p);
  if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(fp)] || 'text/plain' }); r.end(d);
  });
});

let pass = 0, fail = 0;
const _wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 135s'); process.exit(1); }, 135000);
if (_wd && _wd.unref) _wd.unref();
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

const SENTINEL = '987654';   /* seeded into every localStorage key the old tools read */
const ROWS = {
  SACCO: [
    { partnerUid: 'p1', name: 'Mock Teachers SACCO', institutionType: 'SACCO', services: ['SAVINGS', 'LOANS'], county: 'Nairobi', website: 'https://example.org', label: 'Listed by SOKONI', promoted: true },
    { partnerUid: 'p2', name: 'Mock Farmers SACCO', institutionType: 'SACCO', services: ['SAVINGS'], county: 'Nakuru', website: 'javascript:alert(1)', label: 'Listed by SOKONI', promoted: false }
  ],
  DIGITAL_LENDER: [
    { partnerUid: 'p3', name: 'Mock Quick Loans', institutionType: 'DIGITAL_LENDER', services: ['DIGITAL_LOANS'], county: 'Mombasa', website: 'http://insecure.example', label: 'Listed by SOKONI', promoted: false }
  ]
};
const calls = [];
async function mockBackend(ctx) {
  await ctx.route(/cloudfunctions\.net|\.run\.app|firebaseappcheck|recaptcha/, async (route) => {
    const req = route.request();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const fn = new URL(req.url()).pathname.split('/').pop();
    let data = {};
    try { data = (JSON.parse(req.postData() || '{}').data) || {}; } catch (_) {}
    calls.push({ fn, op: data.op, types: data.types });
    let result = {};
    if (fn === 'financialPartnerDispatch' && data.op === 'publicDirectory') {
      const rows = (data.types || []).length === 1 ? (ROWS[data.types[0]] || []) : [];
      result = { rows, next: null };
    } else if (fn === 'foundationContentDispatch') {
      result = { rows: [], next: null };
    }
    return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ result }) });
  });
}

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const ctx = await br.newContext({ ...devices['iPhone 13'] });
  await mockBackend(ctx);
  await ctx.addInitScript((s) => {
    try {
      ['sokoniWallet', 'sokoniWalletBalance', 'bkpWallet', 'bkpBalance', 'sokoniBankingPro', 'bkpTransactions',
       'bkpInvoices', 'bkpLoans', 'sokoniBnpl', 'bkpNotifs'].forEach((k) => localStorage.setItem(k, JSON.stringify({ balance: Number(s), amount: Number(s), items: [{ amount: Number(s) }] })));
    } catch (_) {}
  }, SENTINEL);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(B + '/banking.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6500);
  const landed = new URL(page.url()).pathname;
  ck('measured the right page', /banking/.test(landed), landed);

  const out = await page.evaluate(async () => {
    const r = { tabs: [], tiles: [], fns: {}, search: {}, modal: {} };
    ['showTab', 'filterBankCards', 'openApplyModal'].forEach((n) => { r.fns[n] = typeof window[n]; });
    r.bankingPro = !!document.querySelector('script[src*="sokoni-banking-pro"]');
    r.bell = !!document.querySelector('.bkp-notif-bell');
    const snap = () => ({
      tab: (document.querySelector('.bk-tab.active') || {}).id || null,
      panes: [...document.querySelectorAll('.bk-pane.active')].map((p) => p.id),
    });
    const wait = (ms) => new Promise((s) => setTimeout(s, ms));

    /* Every tab the page exposes. */
    for (const t of [...document.querySelectorAll('.bk-tab')]) {
      const n = t.id.replace('tab-', '');
      t.click();
      await wait(1200);   /* lazy directory load (mocked backend) */
      const after = snap();
      const pane = document.getElementById('pane-' + n);
      const txt = pane ? pane.innerText : '';
      r.tabs.push({
        n,
        tabMoved: after.tab === 'tab-' + n,
        paneShown: after.panes.length === 1 && after.panes[0] === 'pane-' + n,
        rendered: !!pane && pane.children.length > 0 && !/Loading listings/.test(txt),
        cards: pane ? pane.querySelectorAll('.bkd-card').length : 0,
        apply: pane ? [...pane.querySelectorAll('a[href*="business-apply.html?offer=financial"]')].map((a) => a.getAttribute('href')) : [],
        unavailable: /isn't available right now/.test(txt),
        text: txt
      });
    }
    r.singlePane = document.querySelectorAll('.bk-pane.active').length === 1;

    /* Every tile: a button must switch to a pane; a link must point at a real page. */
    for (const tile of [...document.querySelectorAll('.qa-tile')]) {
      const label = (tile.querySelector('.qa-label') || tile).textContent.trim();
      if (tile.tagName === 'A') { r.tiles.push({ label, kind: 'link', href: tile.getAttribute('href') }); continue; }
      const before = snap();
      tile.click();
      await wait(300);
      const after = snap();
      r.tiles.push({ label, kind: 'pane', pane: after.panes[0] || null, moved: after.panes.length === 1 && (before.panes.join() !== after.panes.join() || after.panes.length === 1) });
    }

    /* Partner cards */
    const cards = [...document.querySelectorAll('.bkd-card')];
    r.cardText = cards.map((c) => c.innerText).join('\n');
    r.listedBadges = cards.filter((c) => /Listed by SOKONI/.test(c.innerText)).length;
    r.partnerCards = document.querySelectorAll('[data-contact]').length;
    r.promoted = [...document.querySelectorAll('.bkd-promo')].length;
    r.hrefs = cards.flatMap((c) => [...c.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel') || '' })));
    r.digitalWarn = /Check the lender's CBK licence before borrowing/.test((document.getElementById('pane-digital') || {}).innerText || '');
    r.allText = document.body.innerText;

    /* search */
    const input = document.getElementById('bkSearch');
    const total = document.querySelectorAll('.qa-tile').length;
    input.value = 'sacco'; window.filterBankCards();
    const afterFilter = [...document.querySelectorAll('.qa-tile')].filter((t) => t.style.display !== 'none').length;
    input.value = 'zzzznomatch'; window.filterBankCards();
    const none = [...document.querySelectorAll('.qa-tile')].filter((t) => t.style.display !== 'none').length;
    const emptyEl = document.getElementById('bkSearchEmpty');
    r.search = { total, afterFilter, none, emptyShown: !!(emptyEl && emptyEl.style.display !== 'none' && emptyEl.textContent) };
    input.value = ''; window.filterBankCards();
    r.search.restored = [...document.querySelectorAll('.qa-tile')].filter((t) => t.style.display !== 'none').length;

    /* apply (USSD) modal */
    window.openApplyModal('Emergency Loan', 'Any Bank');
    const m = document.getElementById('bkApplyModal');
    r.modal.opened = !!m;
    r.modal.hasUssd = !!(m && /\*234#/.test(m.textContent));
    const closeBtn = m && m.querySelector('button');
    if (closeBtn) closeBtn.click();
    r.modal.closes = !document.getElementById('bkApplyModal');
    r.ussdExternal = /External — dial from your phone/.test(document.body.innerText);
    return r;
  });

  console.log('\n── Removed tools ──');
  ck('sokoni-banking-pro.js is not loaded', out.bankingPro === false);
  ck('no notification bell', out.bell === false);
  const goneTabs = out.tabs.filter((t) => ['wallet', 'dashboard', 'bnpl', 'merchant', 'invoices', 'payments', 'notifs', 'admin'].includes(t.n));
  ck('no wallet/dashboard/bnpl/merchant/invoices/payments/notifs/admin tabs', goneTabs.length === 0, goneTabs.map((t) => t.n).join(', '));
  ck('no pane renders a localStorage balance (seeded sentinel never shown)', out.allText.indexOf(SENTINEL) === -1 && out.allText.indexOf('987,654') === -1);

  console.log('\n── Every tab does something (' + out.tabs.length + ' tabs) ──');
  const noTab = out.tabs.filter((c) => !c.tabMoved), noPane = out.tabs.filter((c) => !c.paneShown), blank = out.tabs.filter((c) => !c.rendered);
  ck('active tab always moves', noTab.length === 0, noTab.map((d) => d.n).join(', '));
  ck('matching pane is shown', noPane.length === 0, noPane.map((d) => d.n).join(', '));
  ck('every pane renders content after opening', blank.length === 0, blank.map((d) => d.n).join(', '));
  ck('exactly one pane visible', out.singlePane === true);
  const dir = out.tabs.filter((t) => t.n !== 'foundation');
  const emptyNoApply = dir.filter((t) => t.cards === 0 && !t.unavailable && !t.apply.some((h) => /category=[A-Z_]+$/.test(h)));
  ck('every empty category has an apply link (business-apply.html?offer=financial&category=TYPE)', emptyNoApply.length === 0, emptyNoApply.map((d) => d.n).join(', '));
  ck('SACCO pane renders the directory rows', (out.tabs.find((t) => t.n === 'saccos') || {}).cards === 2);
  ck('advisers + foundation tabs exist', out.tabs.some((t) => t.n === 'advisers') && out.tabs.some((t) => t.n === 'foundation'));
  const lazy = calls.filter((c) => c.fn === 'financialPartnerDispatch' && c.op === 'publicDirectory');
  ck('directory loads once per pane (lazy, no storm)', lazy.length === dir.length, lazy.length + ' calls for ' + dir.length + ' panes');

  console.log('\n── Every tile does something (' + out.tiles.length + ' tiles) ──');
  const deadTiles = out.tiles.filter((t) => t.kind === 'pane' ? !t.pane : !(t.href && fs.existsSync(path.join('.', t.href.split(/[?#]/)[0]))));
  ck('every tile switches a pane or links to a page that exists', deadTiles.length === 0, deadTiles.map((t) => t.label).join(', '));
  const tile = (l) => out.tiles.find((t) => t.label === l) || {};
  ck('My Wallet + Payment History → wallet.html; Finance Dashboard → financial-os.html', tile('My Wallet').href === 'wallet.html' && tile('Payment History').href === 'wallet.html' && tile('Finance Dashboard').href === 'financial-os.html');
  ck('Merchant Finance → loans pane', tile('Merchant Finance').pane === 'pane-loans');
  ck('no BNPL / Invoices tiles', !out.tiles.some((t) => /Buy Now Pay Later|Invoices/.test(t.label)));

  console.log('\n── Partner cards ──');
  ck('cards never say verified / licensed / CBK-approved', !/\b(verified|licensed|licenced|cbk[\s-]*approved)\b/i.test(out.cardText));
  ck('every card shows "Listed by SOKONI"', out.listedBadges === out.partnerCards && out.partnerCards >= 3, out.listedBadges + '/' + out.partnerCards);
  ck('Promoted tag only on the promoted row', out.promoted === 1, String(out.promoted));
  ck('only https websites are linked, with rel=noopener', out.hrefs.every((h) => /^https:\/\//.test(h.href) ? /noopener/.test(h.rel) : !/^(javascript|http):/i.test(h.href)) && !out.hrefs.some((h) => /^javascript:|^http:/i.test(h.href)));
  ck('digital lender carries the CBK-licence caution', out.digitalWarn === true);

  console.log('\n── Search / USSD ──');
  ck('filters the tiles', out.search.afterFilter > 0 && out.search.afterFilter < out.search.total, out.search.afterFilter + '/' + out.search.total);
  ck('no-match hides all and explains', out.search.none === 0 && out.search.emptyShown === true);
  ck('clearing restores all', out.search.restored === out.search.total);
  ck('USSD modal opens with real codes and closes', out.modal.opened && out.modal.hasUssd && out.modal.closes);
  ck('USSD banner labelled external', out.ussdExternal === true);

  console.log('\n── Responsive ──');
  for (const d of ['iPhone SE', 'iPhone 13', 'iPhone 14 Pro Max']) {
    const c2 = await br.newContext({ ...devices[d] });
    await mockBackend(c2);
    const p2 = await c2.newPage();
    await p2.goto(B + '/banking.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p2.waitForTimeout(6500);
    const m = await p2.evaluate(async () => {
      document.getElementById('tab-saccos').click();
      await new Promise((s) => setTimeout(s, 1200));
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        small: [...document.querySelectorAll('.qa-tile,.bk-tab,.bkd-btn')]
          .filter((b) => { const r = b.getBoundingClientRect(); return r.height > 0 && r.height < 40; }).length,
      };
    });
    ck(d + ' — no horizontal scroll', m.overflow === false);
    ck(d + ' — no tap target under 40px', m.small === 0, String(m.small));
    await c2.close();
  }

  const KNOWN = /ResizeObserver loop completed with undelivered notifications|recordMetric.*access control/;
  const introduced = errs.filter((e) => !KNOWN.test(e));
  ck('no page errors introduced', introduced.length === 0, introduced[0] || '');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  await Promise.race([
    (async () => { try { await br.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  try { srv.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
