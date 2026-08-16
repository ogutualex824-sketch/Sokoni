/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT TAX — RUNTIME (2D-2 Tax Stage 2)
   ══════════════════════════════════════════════════════════════════════════════
   Answers what only a rendered screen can:

     · does any call ever carry a merchant identifier, even when the shell
       offers one? (the harness DELIBERATELY hands it SHOP_B)
     · is a pending or failed submission ever presented as filed?
     · does an unregistered account get the setup form, and a registered one
       never get it because a figures query failed?
     · is a KRA rejection shown verbatim, with a way to act on it?
     · does a rejected save discard the merchant's typing?
     · is the taxpayer secret ever rendered back?
     · does the account-level statement appear before any figure?

   Run: node scripts/test-merchant-tax-ui.js
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
</style></head><body>
<div id="wrap"><div class="native" id="native-kra-tax"></div></div>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-tax.js"></script>
<script src="/sokoni-merchant-tax-ui.js"></script>
<script>
window.__calls = []; window.__mode = 'ok'; window.__ui = null;
var ME = 'SELLER_A_uid_7f3', SHOP_B = 'SHOP_B_shop_91c', SHOP_C = 'SHOP_C_shop_42x';
var KRA_ERR = 'KRA rejected the submission: resultCd 894 — item classification code invalid for line 2';
var STATE = {};
function reset () {
  STATE = {
    profile: {
      sellerUid: ME, kraPin:'P051234567T', businessName:'Bravilex Duka', vatStatus:'registered',
      taxCategory:'A', branchId:'00', invoicePrefix:'BRV', address:'Westlands, Nairobi',
      phone:'0700000000', status:'active', kraVerified:true,
      totalInvoices:12, pendingInvoices:1, failedInvoices:2,
      lastSubmissionAt:'2026-08-14T09:00:00.000Z', enabledAt:'2026-01-02T08:00:00.000Z'
    },
    stats: { totalRevenue:184500.5, vatCollected:25448.35, acceptedCount:9, failedCount:2, pendingCount:1 },
    recent: [
      { invoiceId:'inv1', invoiceNumber:'BRV-000009', orderId:'ORD-771', total:12500, vat:1724.14, status:'accepted', receiptNumber:'R-9', createdAt:'2026-08-14T09:00:00.000Z' },
      { invoiceId:'inv2', invoiceNumber:'BRV-000008', orderId:'ORD-770', total:4300, vat:593.10, status:'accepted', receiptNumber:'R-8', createdAt:'2026-08-13T09:00:00.000Z' }
    ],
    failed: [
      { invoiceId:'invF1', invoiceNumber:'BRV-000010', orderId:'ORD-772', error: KRA_ERR, createdAt:'2026-08-15T09:00:00.000Z' },
      { invoiceId:'invF2', invoiceNumber:'BRV-000011', orderId:'ORD-773', error:'KRA timeout', createdAt:'2026-08-15T10:00:00.000Z' }
    ]
  };
}
reset();
function deny (msg) { var e = new Error(msg); e.code = 'permission-denied'; throw e; }

window.__ctx = function (signedIn) {
  /* The shell is DELIBERATELY handed an activeShopId. If the surface can be
     made to send one, this is where it would come from. */
  var scope = SokoniMerchantData.resolveScope({ uid: signedIn === false ? null : ME, activeShopId: SHOP_B });
  return {
    scope: scope,
    callProfile: async function (p) {
      window.__calls.push({ op:'etimsGetProfile', p:p });
      if (window.__mode === 'profileError') throw new Error('Your tax profile could not be loaded.');
      if (window.__mode === 'unregistered') return { data: { profile: null } };
      return { data: { profile: STATE.profile } };
    },
    callStats: async function (p) {
      window.__calls.push({ op:'etimsGetSellerStats', p:p });
      if (window.__mode === 'statsError') throw new Error('Your eTIMS figures could not be loaded.');
      if (window.__mode === 'unregistered') return { data: { profile: null, stats: null } };
      if (window.__mode === 'noFigures') return { data: { profile: STATE.profile, stats: {}, recentInvoices: [], failedInvoices: [] } };
      if (window.__mode === 'noFailures') return { data: { profile: STATE.profile, stats: Object.assign({}, STATE.stats, { failedCount: 0 }), recentInvoices: STATE.recent, failedInvoices: [] } };
      return { data: { profile: STATE.profile, stats: STATE.stats, recentInvoices: STATE.recent, failedInvoices: STATE.failed } };
    },
    callRegister: async function (p) {
      window.__calls.push({ op:'etimsRegisterSeller', p:p });
      if (window.__mode === 'kraRejects') { var e = new Error('KRA rejected PIN: taxpayer not found'); e.code='invalid-argument'; throw e; }
      window.__mode = 'ok';
      return { data: { success:true, status:'active' } };
    },
    callUpdate: async function (p) {
      window.__calls.push({ op:'etimsUpdateProfile', p:p });
      if (window.__mode === 'saveDenied') deny('Register eTIMS first');
      Object.assign(STATE.profile, p);
      return { data: { success:true } };
    },
    callValidate: async function (p) {
      window.__calls.push({ op:'etimsValidatePin', p:p });
      return { data: { valid:true, message:'Format valid' } };
    },
    callInvoice: async function (p) {
      window.__calls.push({ op:'etimsGenerateInvoice', p:p });
      if (window.__mode === 'notYourOrder') deny('Not your order');
      return { data: { success:true, invoiceNumber:'BRV-000012' } };
    },
    callBulk: async function (p) {
      window.__calls.push({ op:'etimsBulkGenerate', p:p });
      return { data: { success:true, message:'Bulk invoice created', count:4 } };
    },
    callResubmit: async function (p) {
      window.__calls.push({ op:'etimsResubmitInvoice', p:p });
      if (window.__mode === 'notYourInvoice') deny('Not your invoice');
      window.__mode = 'noFailures';
      return { data: { success:true, message:'Queued for resubmission' } };
    },
    onToast: function (m,k) { (window.__toasts = window.__toasts || []).push([m,k]); }
  };
};
window.__mount = function (signedIn) {
  if (window.__ui) { try { window.__ui.destroy(); } catch (e) {} window.__ui = null; }
  var h = document.getElementById('native-kra-tax'); h.innerHTML = '';
  window.__toasts = [];
  window.__ui = SokoniMerchantTaxUI.mount(h, window.__ctx(signedIn));
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
  { name: 'iPhone SE (smallest supported)', width: 320, height: 568 },
  { name: 'iPhone SE 2', width: 375, height: 667 },
  { name: 'iPhone 14 Pro', width: 393, height: 852 },
  { name: 'Desktop', width: 1280, height: 800 },
];
const settle = (page, ms = 280) => page.waitForTimeout(ms);
/* Tabs are selected by NAME, never by position — an index assertion has been
   wrong three times in this track because lists reorder. */
const tab = async (page, t) => { await page.click('[data-tab="' + t + '"]'); await settle(page); };

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

    /* ══ 1. No identifier leaves the page ══════════════════════════════════ */
    console.log('\n  1. The shell offers a shopId; the surface never uses it');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mode = 'ok'; window.__mount(); });
    await settle(page, 460);
    ck('the tax surface renders', (await page.$('.mtx')) !== null);
    ck('the scope really did carry an activeShopId — the trap is armed',
      await page.evaluate(() => {
        const s = SokoniMerchantData.resolveScope({ uid: 'SELLER_A_uid_7f3', activeShopId: 'SHOP_B_shop_91c' });
        return !!(s && (s.shopId || s.activeShopId));
      }));
    ck('etimsGetSellerStats was called with an EMPTY payload',
      await page.evaluate(() => {
        const c = window.__calls.find((x) => x.op === 'etimsGetSellerStats');
        return !!c && Object.keys(c.p || {}).length === 0;
      }), await page.evaluate(() => JSON.stringify((window.__calls[0] || {}).p)));
    ck('no call carries any merchant identifier',
      await page.evaluate(() => {
        const bad = ['sellerUid', 'sellerId', 'merchantId', 'shopId', 'uid', 'ownerId', 'ownerUid'];
        return window.__calls.every((c) => bad.every((k) => !(c.p && k in c.p)));
      }), await page.evaluate(() => JSON.stringify(window.__calls.map((c) => c.op + ':' + JSON.stringify(c.p)))));
    ck('neither SHOP_B nor SHOP_C appears anywhere on the page',
      !(await page.textContent('.mtx')).includes('SHOP_B') &&
      !(await page.textContent('.mtx')).includes('SHOP_C'));

    /* ══ 2. Account-level is stated before any figure ══════════════════════ */
    console.log('\n  2. The account-level scope is stated, not implied');
    const scopeTx = await page.textContent('.mtx-scope');
    ck('the header says the tax identity is account-level', /account-level/i.test(scopeTx), scopeTx.slice(0, 80));
    ck('...and explains what that means for multiple shops', /every shop/i.test(scopeTx));
    ck('the statement sits ABOVE the figures in document order',
      await page.evaluate(() => {
        const s = document.querySelector('.mtx-scope'), k = document.querySelector('.mtx-kpi');
        if (!s || !k) return false;
        return !!(s.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING);
      }));

    /* ══ 3. Pending is not filed ══════════════════════════════════════════ */
    console.log('\n  3. Accepted, pending and failed are three different claims');
    const statusTx = await page.textContent('.mtx-body');
    ck('the accepted total is shown', /25,448\.35|25448/.test(statusTx));
    ck('pending is labelled Pending, not folded into a total', /Pending/i.test(statusTx));
    ck('failed is labelled Failed', /Failed/i.test(statusTx));
    ck('the screen states that pending is NOT counted as filed',
      /not counted as filed/i.test(statusTx), statusTx.slice(0, 60));
    ck('the failures tab carries a count badge', (await page.$('[data-tab="failures"] .n')) !== null);

    /* ══ 4. A KRA rejection is shown verbatim and is actionable ═══════════ */
    console.log('\n  4. A KRA refusal is quoted, not summarised away');
    await tab(page, 'failures');
    const failTx = await page.textContent('.mtx-body');
    ck('the KRA error text appears verbatim', /resultCd 894/.test(failTx), failTx.slice(0, 90));
    ck('each failure offers a Resubmit action',
      (await page.$$('[data-a="resubmit"]')).length === 2);
    await page.click('[data-a="resubmit"][data-i="0"]');
    await settle(page, 520);
    ck('resubmit named an INVOICE and nothing else',
      await page.evaluate(() => {
        const c = window.__calls.filter((x) => x.op === 'etimsResubmitInvoice').pop();
        return !!c && Object.keys(c.p).length === 1 && c.p.invoiceId === 'invF1';
      }), await page.evaluate(() => JSON.stringify((window.__calls.filter((x) => x.op === 'etimsResubmitInvoice').pop() || {}).p)));
    ck('the server\'s own confirmation is shown, not an invented one',
      /Queued for resubmission/.test(await page.textContent('.mtx-body')));

    /* ══ 5. A denied action does not report success ═══════════════════════ */
    console.log('\n  5. Nothing claims success before the server says so');
    await page.evaluate(() => { window.__reset(); window.__mode = 'notYourOrder'; window.__calls = []; window.__mount(); });
    await settle(page, 460);
    await tab(page, 'invoices');
    await page.fill('#mtx-order', 'ORD-999');
    await page.click('[data-a="generate"]');
    await settle(page, 520);
    const denyTx = await page.textContent('.mtx-body');
    ck('the refusal is shown in the surface', /Not your order/.test(denyTx), denyTx.slice(0, 90));
    ck('no success wording appears anywhere', !/Invoice created|created\./i.test(denyTx));
    ck('the merchant\'s typing survives the refusal',
      (await page.inputValue('#mtx-order')) === 'ORD-999');
    ck('no success toast was raised',
      await page.evaluate(() => (window.__toasts || []).every((t) => t[1] !== 'ok')));

    /* ══ 6. Unregistered gets setup; registered never does ════════════════ */
    console.log('\n  6. Setup appears only when there is genuinely no profile');
    await page.evaluate(() => { window.__reset(); window.__mode = 'unregistered'; window.__calls = []; window.__mount(); });
    await settle(page, 500);
    ck('an unregistered account gets the setup form', (await page.$('[data-a="register"]')) !== null);
    ck('...and no fabricated figures', (await page.$('.mtx-kpi')) === null);
    ck('...and the setup form does not pretend to be an error',
      !/could not be loaded/i.test(await page.textContent('.mtx-body')));

    /* A registered merchant whose FIGURES query failed must not be handed the
       setup form — that would invite a second registration over a live one. */
    await page.evaluate(() => { window.__reset(); window.__mode = 'statsError'; window.__calls = []; window.__mount(); });
    await settle(page, 620);
    ck('a stats failure does NOT show the setup form to a registered merchant',
      (await page.$('[data-a="register"]')) === null);
    ck('...the profile is still shown', /P051234567T/.test(await page.textContent('.mtx-body')));
    ck('...and the missing figures are dashes, not zeros',
      await page.evaluate(() => {
        const v = Array.from(document.querySelectorAll('.mtx-kpi .v')).map((e) => e.textContent.trim());
        return v.length > 0 && v.every((x) => x === '—');
      }), await page.evaluate(() => Array.from(document.querySelectorAll('.mtx-kpi .v')).map((e) => e.textContent.trim()).join('|')));
    ck('...and it says the totals are unavailable rather than implying zero',
      /could not be loaded/i.test(await page.textContent('.mtx-body')));

    /* ══ 7. Missing figures never render as 0 ═════════════════════════════ */
    console.log('\n  7. Unknown is a dash; a real zero is a zero');
    await page.evaluate(() => { window.__reset(); window.__mode = 'noFigures'; window.__calls = []; window.__mount(); });
    await settle(page, 500);
    ck('every absent figure renders as an em dash',
      await page.evaluate(() => Array.from(document.querySelectorAll('.mtx-kpi .v'))
        .every((e) => e.textContent.trim() === '—')));
    await page.evaluate(() => { window.__reset(); window.__mode = 'noFailures'; window.__calls = []; window.__mount(); });
    await settle(page, 500);
    ck('a genuine zero failure count renders as 0, not a dash',
      await page.evaluate(() => {
        const k = Array.from(document.querySelectorAll('.mtx-kpi'))
          .find((e) => /Failed/i.test(e.textContent));
        return !!k && /(^|\D)0(\D|$)/.test(k.querySelector('.v').textContent.trim());
      }), await page.evaluate(() => {
        const k = Array.from(document.querySelectorAll('.mtx-kpi')).find((e) => /Failed/i.test(e.textContent));
        return k ? k.textContent.trim() : 'none';
      }));

    /* ══ 8. Lists say they are capped ═════════════════════════════════════ */
    console.log('\n  8. A truncated list does not imply completeness');
    await page.evaluate(() => {
      window.__reset(); window.__mode = 'ok';
      const many = [];
      for (let i = 0; i < 15; i++) many.push({ invoiceId:'i'+i, invoiceNumber:'BRV-'+i, orderId:'O'+i, total:100, vat:16, status:'accepted', createdAt:'2026-08-01T00:00:00.000Z' });
      window.__ctxRecent = many;
      const orig = window.__ctx;
      window.__ctx = function (s) { const c = orig(s); const cs = c.callStats;
        c.callStats = async function (p) { const r = await cs(p); r.data.recentInvoices = many; return r; };
        return c; };
      window.__mount();
    });
    await settle(page, 520);
    await tab(page, 'invoices');
    ck('a full page of invoices says it is capped',
      /not your full filing history/i.test(await page.textContent('.mtx-body')));

    /* ══ 9. Credentials are never rendered back ═══════════════════════════ */
    console.log('\n  9. The taxpayer secret is write-only');
    await page.evaluate(() => { window.__reset(); window.__mode = 'ok'; window.__mount(); });
    await settle(page, 500);
    await tab(page, 'settings');
    const setTx = await page.textContent('.mtx-body');
    ck('the settings screen does not offer to edit the KRA PIN',
      (await page.$('[data-d="kraPin"]')) === null);
    ck('...nor the taxpayer secret', (await page.$('[data-d="taxpayerSecret"]')) === null);
    ck('...nor the device serial', (await page.$('[data-d="deviceSerial"]')) === null);
    ck('it explains WHY they are not editable', /KRA matter|cannot be edited/i.test(setTx));
    ck('it states the credentials are never shown back', /never shown back/i.test(setTx));
    ck('exactly the six allow-listed fields are editable',
      (await page.$$('[data-d]')).length === 6, String((await page.$$('[data-d]')).length));

    /* ══ 10. A save sends only what changed ═══════════════════════════════ */
    console.log('\n  10. A save corresponds to a real change');
    await page.evaluate(() => { window.__calls = []; });
    await page.fill('[data-d="phone"]', '0722123456');
    await page.click('[data-a="save"]');
    await settle(page, 560);
    ck('etimsUpdateProfile was sent ONLY the changed field',
      await page.evaluate(() => {
        const c = window.__calls.filter((x) => x.op === 'etimsUpdateProfile').pop();
        return !!c && Object.keys(c.p).length === 1 && c.p.phone === '0722123456';
      }), await page.evaluate(() => JSON.stringify((window.__calls.filter((x) => x.op === 'etimsUpdateProfile').pop() || {}).p)));

    await page.evaluate(() => { window.__reset(); window.__mode = 'saveDenied'; window.__calls = []; window.__mount(); });
    await settle(page, 500);
    await tab(page, 'settings');
    await page.fill('[data-d="phone"]', '0733999888');
    await page.click('[data-a="save"]');
    await settle(page, 560);
    ck('a refused save shows the server\'s reason',
      /Register eTIMS first/.test(await page.textContent('.mtx-body')));
    ck('...and keeps the merchant\'s typing',
      (await page.inputValue('[data-d="phone"]')) === '0733999888');

    /* ══ 11. Registration ═════════════════════════════════════════════════ */
    console.log('\n  11. Registration refuses a bad PIN and quotes KRA on rejection');
    await page.evaluate(() => { window.__reset(); window.__mode = 'unregistered'; window.__calls = []; window.__mount(); });
    await settle(page, 500);
    await page.fill('[data-r="kraPin"]', '12345');
    await page.click('[data-a="register"]');
    await settle(page, 400);
    ck('a malformed PIN is refused WITHOUT calling the server',
      await page.evaluate(() => window.__calls.filter((c) => c.op === 'etimsRegisterSeller').length === 0));
    ck('...and the reason names the expected format',
      /P051234567T/.test(await page.textContent('.mtx-body')));

    await page.evaluate(() => { window.__mode = 'kraRejects'; });
    await page.fill('[data-r="kraPin"]', 'P051234567T');
    await page.fill('[data-r="businessName"]', 'Bravilex Duka');
    await page.fill('[data-r="deviceSerial"]', 'DS-001');
    await page.fill('[data-r="taxpayerSecret"]', 'super-secret');
    await page.click('[data-a="register"]');
    await settle(page, 620);
    const regTx = await page.textContent('.mtx-body');
    ck('KRA\'s rejection is shown verbatim', /taxpayer not found/.test(regTx), regTx.slice(0, 90));
    ck('the surface does NOT claim registration succeeded', !/registration complete/i.test(regTx));
    ck('the secret is never echoed into the page text', !regTx.includes('super-secret'));
    ck('the secret field is type=password',
      (await page.getAttribute('[data-r="taxpayerSecret"]', 'type')) === 'password');

    /* ══ 12. Phone ergonomics ═════════════════════════════════════════════ */
    console.log('\n  12. Phone ergonomics');
    await page.evaluate(() => { window.__reset(); window.__mode = 'ok'; window.__mount(); });
    await settle(page, 520);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    ck('nothing overflows sideways on Status', overflow.doc <= 0 && overflow.body <= 0, JSON.stringify(overflow));
    for (const t of ['invoices', 'failures', 'settings']) {
      await tab(page, t);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ck('nothing overflows sideways on ' + t, o <= 0, String(o));
    }
    await tab(page, 'settings');
    const small = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('button,input,select').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.height < 44) bad.push((el.className || el.tagName) + ':' + Math.round(r.height));
      });
      return bad;
    });
    ck('every control is at least 44px tall', small.length === 0, small.join(', '));
    const fontSmall = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('input,select,textarea').forEach((el) => {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 16) bad.push((el.id || el.tagName) + ':' + fs);
      });
      return bad;
    });
    ck('no text input is under 16px — iOS must not zoom on focus', fontSmall.length === 0, fontSmall.join(', '));
    await tab(page, 'failures');
    ck('the long KRA error wraps instead of overflowing',
      await page.evaluate(() => {
        const e = document.querySelector('.mtx-inv .err');
        return !!e && e.scrollWidth <= e.clientWidth + 1;
      }));

    /* ══ 13. Nothing but the eight authorities, and no errors ═════════════ */
    console.log('\n  13. Only the eight SAFE authorities were ever called');
    const ops = await page.evaluate(() => Array.from(new Set(window.__calls.map((c) => c.op))));
    ck('every call was one of the eight', ops.every((o) => [
      'etimsGetProfile', 'etimsRegisterSeller', 'etimsUpdateProfile', 'etimsValidatePin',
      'etimsGetSellerStats', 'etimsGenerateInvoice', 'etimsBulkGenerate', 'etimsResubmitInvoice',
    ].indexOf(o) !== -1), ops.join(','));
    const real = errors.filter((e) => !/favicon|404/.test(e));
    ck('no page error or console error during the whole run', real.length === 0, real.slice(0, 2).join(' | '));

    await ctx.close();
  }
  await browser.close(); server.close();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
