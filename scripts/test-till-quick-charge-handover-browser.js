/* test-till-quick-charge-handover-browser.js — Step 2 (2026-09-30): the Till & QR module hands a cashier's charge to Sell.
 *
 * Owner: "use till and poscheckout". A charge the CASHIER rings up — a product sale or a quick charge (a service, a fee) —
 * is ONE canonical sale on Sell (merchant-v2) or pos-checkout: customer, SOKONI points, the M-PESA / card QR, receipt.
 * The Till & QR module used to mint a free-typed payment with no sale behind it ("Dynamic QR (POS sale)"); it now hands
 * over to Sell. Its permanent QR (the customer types the amount) is unchanged.
 *
 * SUPERSEDES test-points-quick-charge-browser.js (8b9ca72) and test-points-p1-quick-browser.js (4ad69bf): the UI they
 * drove no longer exists. Their evidence now lives in test-quick-charge-sell-browser.js (quick charge + customer +
 * points + M-PESA on Sell), test-quick-charge-poscheckout-browser.js, test-points-p2b-browser.js (paying with points at
 * the till) and test-quick-charge-sale.js (the canonical sale).
 *
 * PROVES (REAL sokoni-merchant-till.js in Chromium)
 *   TH1 the module offers "Quick charge on Sell" (data-route="sell" — merchant-v2's own navigation) and NO free-typed
 *       charge form: no amount / note / points-phone inputs, no "Generate QR" for a cashier sale
 *   TH2 tapping it asks the shell for the Sell route (the same delegated navigation every merchant-v2 control uses)
 *   TH3 the permanent QR (customer-typed payments) is still drawn
 *   TH4 nothing mints a payment: no intent is created by opening the module or tapping the hand-over
 *   TH5 no page errors
 */
'use strict';
const Path = require('path'), http = require('http'), fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
const TILL = { exists: true, sokoniTillId: 'TILLA', shopId: 'shopA', status: 'ACTIVE', currency: 'KES', qrUrl: 'https://mysokoni.co.ke/pay-q?t=TILLA' };
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="till"></div><script src="/sokoni-merchant-till.js"></script>
<script>
  window.__intents = 0; window.__routes = [];
  /* merchant-v2's own delegated navigation: one listener for every [data-route] control */
  document.addEventListener('click', function (e) { var b = e.target.closest('[data-route]'); if (b) { e.preventDefault(); window.__routes.push(b.dataset.route); } });
  window.__mount = function () {
    var h = document.getElementById('till'); h.innerHTML = '';
    window.__t = SokoniMerchantTill.mount(h, { scope: { ok: true, shopId: 'shopA' }, shopName: 'Mama Duka',
      callMyTill: function () { return Promise.resolve({ data: ${JSON.stringify(TILL)} }); },
      callActivity: function () { return Promise.resolve({ data: { items: [] } }); },
      callCreateIntent: function () { window.__intents++; return Promise.reject(new Error('no payment may be minted here')); },
      callMintDynamicQR: function () { window.__intents++; return Promise.reject(new Error('no')); } });
  };
</script></body></html>`;
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/till.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
      const f = Path.join(ROOT, u.replace(/^\/+/, ''));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(''); }
      res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
(async () => {
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const P = await browser.newPage({ viewport: { width: 390, height: 900 } });
    P.on('pageerror', (e) => errors.push(e.message));
    await P.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await P.goto(BASE + '/till.html');
    await P.evaluate(() => window.__mount());
    await P.waitForSelector('[data-act="to-sell"]', { timeout: 10000 }).catch(() => null);
    const v = await P.evaluate(() => ({
      btn: (document.querySelector('[data-act="to-sell"]') || {}).outerHTML || '',
      text: document.body.innerText,
      amount: !!document.querySelector('[data-f="amount"]'), note: !!document.querySelector('[data-f="note"]'),
      phone: !!document.querySelector('[data-f="buyerPhone"]'), gen: !!document.querySelector('[data-act="gen-dynamic"]'),
      pts: !!document.querySelector('[data-act="pts-start"]'), permQR: !!document.querySelector('[data-qr="permanent"]'),
    }));
    ck('TH1 "Quick charge on Sell" (data-route="sell") and NO free-typed charge form (no amount / note / points phone / Generate QR / pay with points)',
      /data-route="sell"/.test(v.btn) && /Quick charge on Sell/.test(v.btn) && !v.amount && !v.note && !v.phone && !v.gen && !v.pts, v);
    await P.click('[data-act="to-sell"]').catch(() => {});
    const routes = await P.evaluate(() => window.__routes);
    ck('TH2 tapping it asks the shell for the Sell route', routes.length === 1 && routes[0] === 'sell', routes);
    ck('TH3 the permanent QR (customer-typed payments) is still drawn', v.permQR, '');
    ck('TH4 nothing mints a payment (no intent created)', (await P.evaluate(() => window.__intents)) === 0, '');
    ck('TH5 no page errors', errors.length === 0, errors.slice(0, 3));
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
