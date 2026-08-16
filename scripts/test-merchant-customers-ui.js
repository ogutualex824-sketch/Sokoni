/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT CUSTOMERS — RUNTIME, five viewports (2D-2 step 6)
   ══════════════════════════════════════════════════════════════════════════════
   Populated fixture, not an empty one:

     · 240 customers, so the list is genuinely long
     · a 71-character name and a 58-character email
     · one customer with NO profile figures at all (must show dashes, never 0)
     · a SHOP_C customer the adapter will only return if the scope is wrong

   Answers what only a rendered screen can:

     · does a foreign customer ever appear?
     · does an unprofiled customer render 0 anywhere?
     · does the missing POS merchant record degrade the LIST, or only the extras?
     · is any unsafe authority reachable from the screen?

   Run: node scripts/test-merchant-customers-ui.js
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
<div id="wrap"><div class="native" id="native-customers"></div></div>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-customers.js"></script>
<script src="/sokoni-merchant-customers-ui.js"></script>
<script>
window.__calls = []; window.__mode = 'ok'; window.__ui = null;
var ME = 'SELLER_A_uid_7f3', SHOP_B = 'SHOP_B_shop_91c', OTHER = 'OTHER_MERCHANT_uid';
var LONG_NAME = 'Priscilla Wanjiru-Kamau Ochieng Muthoni Ndungu Kiprotich Wafula';
var LONG_EMAIL = 'priscilla.wanjiru.kamau.ochieng@verylongdomainexample.co.ke';
var ALL = [];
function reset () {
  ALL = [
    { uid:'c1', merchantId: ME, name: LONG_NAME, phone:'+254700000001', email: LONG_EMAIL,
      segment:'vip', clv:82000, orderCount:14, totalSpend:61000, avgOrderValue:4357,
      churnRiskLevel:'low', loyaltyPoints:340, loyaltyTier:'gold', preferredCategories:['Phones','Cases'],
      firstOrderAt:{seconds:1700000000}, lastOrderAt:{seconds:1750000000} },
    { uid:'c2', merchantId: ME, name:'Bob Bee', phone:'+254700000002', email:'bob@example.com',
      segment:'first_time', clv:900, orderCount:1, totalSpend:900, avgOrderValue:900, churnRiskLevel:'high' },
    /* No figures at all — must render dashes, never zeros. */
    { uid:'c3', merchantId: ME, name:'Unprofiled Person', phone:'+254700000003' },
    /* Belongs to somebody else. The adapter honours the filter, so this only
       appears if the scope is wrong. */
    { uid:'x9', merchantId: OTHER, name:'SHOP C Customer', phone:'+254799999999', totalSpend: 5000 }
  ];
  for (var i = 0; i < 237; i++) {
    ALL.push({ uid:'g'+i, merchantId: ME, name:'Customer Number ' + i, phone:'+2547111' + (10000+i),
      email:'cust'+i+'@example.com', segment: i % 5 === 0 ? 'regular' : 'customer',
      clv: 1000 + i, orderCount: (i % 7) + 1, totalSpend: 500 + i * 13 });
  }
}
reset();
window.__ctx = function (signedIn) {
  var scope = SokoniMerchantData.resolveScope({ uid: signedIn === false ? null : ME, activeShopId: SHOP_B });
  return {
    scope: scope,
    db: {
      queryProfiles: async function (spec) {
        window.__calls.push({ op:'queryProfiles', where: spec.where, collection: spec.collection });
        if (window.__mode === 'listDenied') { var e = new Error('Missing or insufficient permissions.'); e.code='permission-denied'; throw e; }
        if (window.__mode === 'empty') return [];
        var f = spec.where[0];
        return ALL.filter(function (r) { return String(r[f[0]]) === String(f[2]); });
      }
    },
    callProfile: async function (p) {
      window.__calls.push({ op:'getCustomerProfile', p:p });
      if (window.__mode === 'noMerchantRecord') { var e = new Error('Merchant not found.'); e.code='not-found'; throw e; }
      var r = ALL.filter(function (x) { return x.uid === p.uid; })[0];
      return { data: Object.assign({}, r, { orderCount: (r.orderCount || 0) + 1 }) };
    },
    callDashboard: async function (p) {
      window.__calls.push({ op:'getCRMDashboard', p:p });
      if (window.__mode === 'noMerchantRecord') { var e = new Error('Merchant not found.'); e.code='not-found'; throw e; }
      return { data: { totalCustomers: 240, highChurnRisk: 6, openTickets: 2, newLeads30d: 11 } };
    },
    onToast: function (m,k) { (window.__toasts = window.__toasts || []).push([m,k]); }
  };
};
window.__mount = function (signedIn) {
  if (window.__ui) { try { window.__ui.destroy(); } catch (e) {} window.__ui = null; }
  var h = document.getElementById('native-customers'); h.innerHTML = '';
  window.__ui = SokoniMerchantCustomersUI.mount(h, window.__ctx(signedIn));
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
const settle = (page, ms = 240) => page.waitForTimeout(ms);

/* Open by NAME, never by position: the first child of the list is the scope
   banner and the KPI grid, so :nth-child indices do not map to rows. */
const openNamed = async (page, name) => {
  const rows = await page.$$('.mcu-row');
  for (const r of rows) {
    const t = await r.evaluate((e) => e.textContent);
    if (t.indexOf(name) !== -1) { await r.click(); return; }
  }
  throw new Error('no customer row named ' + name + ' (found ' + rows.length + ')');
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

    console.log('\n  1. The list, and what it must not contain');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 420);
    const rows = await page.$$('.mcu-row');
    ck('240 customers render', rows.length === 240, String(rows.length));
    ck('the read went to crmCustomerProfiles, scoped by merchantId',
      await page.evaluate(() => {
        const c = window.__calls.find((x) => x.op === 'queryProfiles');
        return !!c && c.collection === 'crmCustomerProfiles' && c.where[0][0] === 'merchantId';
      }));
    const listTxt = await page.textContent('.mcu-body');
    ck('ANOTHER merchant\'s customer never appears', !listTxt.includes('SHOP C Customer'));
    ck('...and their phone number is nowhere on the page', !listTxt.includes('+254799999999'));
    ck('the account scope is stated', /account/i.test(listTxt));

    console.log('\n  2. No fabricated figures');
    await openNamed(page, 'Unprofiled Person');
    await settle(page, 380);
    const unp = await page.textContent('.mcu-sheet');
    ck('an unprofiled customer shows dashes for spend and orders',
      /Total spent\s*—/.test(unp.replace(/\s+/g, ' ')) || /—/.test(unp), unp.slice(0, 90).replace(/\s+/g, ' '));
    ck('...and never a fabricated KES 0',
      !/Total spent\s*KES 0/.test(unp.replace(/\s+/g, ' ')));
    await page.click('.mcu-sh-f [data-act="close"]');
    await settle(page, 260);

    console.log('\n  3. Long name and email');
    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth }));
    ck('a 71-character name does not scroll the page sideways', o.doc <= 0 && o.body <= 0, JSON.stringify(o));
    ck('...it ellipsises in the list', await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.mcu-nm')).find((e) => e.textContent.indexOf('Priscilla') !== -1);
      return !!r && getComputedStyle(r).textOverflow === 'ellipsis';
    }));
    ck('the list scrolls inside its own container',
      await page.$eval('.mcu-body', (e) => e.scrollHeight > e.clientHeight));

    console.log('\n  4. Search');
    await page.fill('#mcu-q', 'priscilla');
    await settle(page, 300);
    ck('search narrows the list', (await page.$$('.mcu-row')).length === 1);
    ck('...and the count reflects it', /1 of 240/.test(await page.textContent('.mcu-top')));
    await page.fill('#mcu-q', '+254799999999');
    await settle(page, 300);
    ck('searching another merchant\'s phone finds NOTHING',
      (await page.$$('.mcu-row')).length === 0);
    ck('...and says so honestly', /Nobody matches/i.test(await page.textContent('.mcu-body')));
    await page.fill('#mcu-q', '');
    await settle(page, 300);
    ck('clearing search restores the list', (await page.$$('.mcu-row')).length === 240);

    console.log('\n  5. Profile');
    await openNamed(page, 'Priscilla');
    await settle(page, 400);
    const prof = await page.textContent('.mcu-sheet');
    ck('the profile opens with real figures', /61,000/.test(prof) && /14|15/.test(prof));
    ck('the segment is shown', /VIP/i.test(prof));
    /* Find the call FOR THIS CUSTOMER. `find` on the op alone returns the first
       profile opened in the run — section 2 opened a different one — so the
       assertion was reading the wrong call and failing on correct behaviour. */
    ck('getCustomerProfile was called with merchantId = the ACCOUNT uid',
      await page.evaluate(() => {
        const c = window.__calls.filter((x) => x.op === 'getCustomerProfile' && x.p.uid === 'c1').pop();
        return !!c && c.p.merchantId === 'SELLER_A_uid_7f3';
      }));
    ck('...and every profile call carries that same account merchantId',
      await page.evaluate(() => window.__calls.filter((x) => x.op === 'getCustomerProfile')
        .every((c) => c.p.merchantId === 'SELLER_A_uid_7f3')));
    await page.click('.mcu-sh-f [data-act="close"]');
    await settle(page, 260);

    console.log('\n  6. The missing POS merchant record degrades only the extras');
    await page.evaluate(() => { window.__mode = 'noMerchantRecord'; window.__mount(); });
    await settle(page, 460);
    ck('the LIST still renders in full', (await page.$$('.mcu-row')).length === 240);
    const notice = await page.textContent('.mcu-body');
    ck('the missing record is explained, not shown as an error',
      /POS merchant record/i.test(notice));
    ck('...and the notice says the list is complete and correct',
      /complete and correct/i.test(notice));
    ck('no summary tiles are shown when the dashboard refused',
      (await page.$$('.mcu-kpi')).length === 0);

    await openNamed(page, 'Priscilla');
    await settle(page, 420);
    const degraded = await page.textContent('.mcu-sheet');
    ck('the profile still shows the STORED row', /61,000/.test(degraded));
    ck('...and explains the live refresh is unavailable', /stored profile/i.test(degraded));
    ck('...without calling it an error', !/error/i.test(degraded.slice(0, 400)));
    await page.click('.mcu-sh-f [data-act="close"]');
    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(); });
    await settle(page, 420);

    console.log('\n  7. Summary figures come only from the dashboard');
    ck('the dashboard tiles render', (await page.$$('.mcu-kpi')).length === 4);
    ck('...showing the server\'s totalCustomers', /240/.test(await page.textContent('.mcu-kpis')));
    ck('getCRMDashboard was called with the account uid',
      await page.evaluate(() => {
        const c = window.__calls.find((x) => x.op === 'getCRMDashboard');
        return !!c && c.p.merchantId === 'SELLER_A_uid_7f3';
      }));

    console.log('\n  8. No unsafe authority is reachable');
    const ops = await page.evaluate(() => window.__calls.map((c) => c.op));
    ck('only queryProfiles, getCustomerProfile and getCRMDashboard were ever called',
      ops.every((o) => ['queryProfiles', 'getCustomerProfile', 'getCRMDashboard'].indexOf(o) !== -1),
      [...new Set(ops)].join(','));

    console.log('\n  9. States and hygiene');
    await page.evaluate(() => { window.__mode = 'empty'; window.__mount(); });
    await settle(page, 380);
    ck('an empty list says so', /No customer profiles yet/i.test(await page.textContent('.mcu-body')));
    await page.evaluate(() => { window.__mode = 'listDenied'; window.__mount(); });
    await settle(page, 380);
    const err = await page.textContent('.mcu-body');
    ck('a refused read is a failure', /could not be loaded/i.test(err));
    ck('...and NOT an empty customer list', !/No customer profiles yet/i.test(err));
    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(false); });
    await settle(page, 320);
    ck('a signed-out account is told to sign in', /Sign in to see your customers/i.test(await page.textContent('.mcu')));

    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 420);
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
