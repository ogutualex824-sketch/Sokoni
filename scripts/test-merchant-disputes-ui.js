/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT DISPUTES — RUNTIME, on a real phone viewport (2D-2 step 4)
   ══════════════════════════════════════════════════════════════════════════════
   Answers what only a rendered screen can:

     · does responding ever LOOK like resolving?
     · is there any control anywhere to open, cancel or resolve a dispute?
     · does the screen explain where disputes come from instead of omitting it?
     · is the account-level scope stated rather than implied to be shop-level?
     · does a closed dispute correctly offer nothing?

   Run: node scripts/test-merchant-disputes-ui.js
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
<div id="wrap"><div class="native" id="native-disputes"></div></div>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-disputes.js"></script>
<script src="/sokoni-merchant-disputes-ui.js"></script>
<script>
window.__calls = []; window.__mode = 'ok'; window.__ui = null;
var SELLER_A = 'SELLER_A_uid_7f3', SHOP_B = 'SHOP_B_shop_91c';
var D = [];
function reset () {
  D = [
    { id:'dp_o1', orderId:'ORD-1001', reason:'not_received',
      description:'The customer says the parcel never arrived even though tracking shows it was delivered to the gate.',
      status:'open', amount:2400, evidence:[], timeline:[], createdAt:{seconds:300} },
    { id:'dp_o2', orderId:'ORD-1002', reason:'damaged', description:'Screen cracked in transit.',
      status:'seller_responded', amount:8900, sellerResponse:'Packed with bubble wrap; photos attached.',
      evidence:[{type:'photo',description:'Packed item',addedByRole:'seller'}], timeline:[], createdAt:{seconds:200} },
    { id:'dp_o3', orderId:'ORD-1003', reason:'wrong_item', description:'Wrong size sent.',
      status:'resolved', amount:1500, evidence:[], timeline:[], createdAt:{seconds:100} }
  ];
}
reset();
window.__ctx = function (signedIn) {
  var scope = SokoniMerchantData.resolveScope({ uid: signedIn === false ? null : SELLER_A, activeShopId: SHOP_B });
  return {
    scope: scope,
    callList: async function (p) { window.__calls.push({ name:'getSellerDisputes', p:p });
      if (window.__mode === 'error') throw new Error('Your disputes could not be loaded.');
      return { data: { disputes: window.__mode === 'empty' ? [] : D } }; },
    callDetail: async function (p) { window.__calls.push({ name:'getDisputeDetail', p:p });
      return { data: { dispute: D.filter(function(x){return x.id===p.disputeId;})[0] } }; },
    callRespond: async function (p) { window.__calls.push({ name:'sellerRespondToDispute', p:p });
      if (window.__mode === 'denied') { var e = new Error('Not the seller'); e.code='permission-denied'; throw e; }
      var d = D.filter(function(x){return x.id===p.disputeId;})[0];
      if (d) { d.sellerResponse = p.response; d.status = 'seller_responded'; }
      return { data: { success:true } }; },
    callEvidence: async function (p) { window.__calls.push({ name:'addDisputeEvidence', p:p });
      var d = D.filter(function(x){return x.id===p.disputeId;})[0];
      if (d) d.evidence = (d.evidence||[]).concat([{ type:p.evidenceType, description:p.description, addedByRole:'seller' }]);
      return { data: { success:true } }; },
    onToast: function (m,k) { (window.__toasts = window.__toasts || []).push([m,k]); }
  };
};
window.__mount = function (signedIn) {
  if (window.__ui) { try { window.__ui.destroy(); } catch (e) {} window.__ui = null; }
  var h = document.getElementById('native-disputes'); h.innerHTML = '';
  window.__ui = SokoniMerchantDisputesUI.mount(h, window.__ctx(signedIn));
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

const VIEWPORTS = [{ name: 'iPhone SE', width: 375, height: 667 }, { name: 'iPhone 14 Pro', width: 393, height: 852 }];
const settle = (page, ms = 220) => page.waitForTimeout(ms);

/* Click the Nth dispute CARD. Positional CSS (:nth-child) is wrong here: the
   first child of .mdp-body is the account-scope banner, so nth-child(1) is never
   a card and the indices silently shift by one — which had section 7 clicking the
   responded dispute while asserting about the resolved one. */
const clickCard = async (page, i) => {
  const cards = await page.$$('.mdp-card');
  if (!cards[i]) throw new Error('no dispute card at index ' + i + ' (found ' + cards.length + ')');
  return cards[i].click();
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

    console.log('\n  1. The list, and what it says about itself');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 340);
    ck('open disputes are listed under Needs attention', (await page.$$('.mdp-card')).length === 2);
    const t = await page.textContent('.mdp-body');
    ck('the account scope is stated', /across your account/i.test(t));
    ck('...and it explains disputes are not per-shop', /not against one shop/i.test(t));
    ck('the screen says a merchant cannot OPEN a dispute', /You cannot open a dispute here/i.test(t));
    ck('...and says where they come from', /raised by the buyer/i.test(t));
    ck('the open dispute is flagged as needing the merchant', /Awaiting your response/i.test(t));
    ck('the responded one says SOKONI is reviewing', /Awaiting SOKONI review/i.test(t));

    console.log('\n  2. No control exists to open, cancel or resolve');
    const controls = await page.evaluate(() => Array.from(document.querySelectorAll('[data-act]')).map((e) => e.getAttribute('data-act')));
    ck('no create/cancel/resolve control anywhere on the list',
      !controls.some((a) => /create|cancel|resolve/i.test(a)), controls.join(','));

    console.log('\n  3. Phone ergonomics');
    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth }));
    ck('nothing overflows sideways', o.doc <= 0 && o.body <= 0, JSON.stringify(o));
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

    console.log('\n  4. Detail — the progression is honest');
    await clickCard(page, 0);
    await settle(page, 340);
    const det = await page.textContent('.mdp-sheet');
    ck('the buyer\'s account is shown', /never arrived/i.test(det));
    ck('the three-step progression is rendered', (await page.$$('.mdp-step')).length === 3);
    ck('the third step is SOKONI\'s, not the merchant\'s', /SOKONI reviews|SOKONI decided/.test(det));
    ck('...and is NOT marked done while the dispute is open', (await page.$$('.mdp-step.done')).length === 1);
    ck('the screen says responding does not close it',
      /does .{0,12}not.{0,12} close the dispute/i.test(det.replace(/\s+/g, ' ')));
    ck('detail was re-read from the authority',
      (await page.evaluate(() => window.__calls.filter((c) => c.name === 'getDisputeDetail').length)) === 1);

    console.log('\n  5. Responding — and what it does NOT say');
    await page.click('[data-act="open-respond"]');
    await settle(page);
    await page.fill('#mdp-response', 'The parcel was delivered to the gate on the 14th and signed for by the guard.');
    await page.click('[data-act="send-response"]');
    await settle(page, 420);
    const sent = await page.textContent('.mdp-sheet');
    const respCall = await page.evaluate(() => window.__calls.find((c) => c.name === 'sellerRespondToDispute'));
    ck('sellerRespondToDispute was called once with the text',
      (await page.evaluate(() => window.__calls.filter((c) => c.name === 'sellerRespondToDispute').length)) === 1 &&
      /signed for by the guard/.test(respCall.p.response));
    ck('the outcome is "Awaiting SOKONI review"', /Awaiting SOKONI review/.test(sent));
    ck('...it never claims the dispute is resolved', !/\bresolved\b/i.test(sent), sent.slice(0, 90).replace(/\s+/g, ' '));
    ck('...and states nothing is settled yet', /nothing is settled yet/i.test(sent));
    ck('the list is re-read from the server',
      (await page.evaluate(() => window.__calls.filter((c) => c.name === 'getSellerDisputes').length)) >= 2);

    console.log('\n  6. Evidence');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 340);
    await clickCard(page, 0);
    await settle(page, 320);
    await page.click('[data-act="open-evidence"]');
    await settle(page);
    ck('Add is disabled until a kind is chosen',
      await page.$eval('[data-act="send-evidence"]', (b) => b.disabled === true));
    await page.click('[data-act="etype"][data-v="proof_of_delivery"]');
    await page.fill('#mdp-evidence', 'Signed delivery note from the rider, 14 April');
    await page.click('[data-act="send-evidence"]');
    await settle(page, 420);
    const ev = await page.evaluate(() => window.__calls.find((c) => c.name === 'addDisputeEvidence'));
    ck('addDisputeEvidence carries the dispute, type and description',
      ev && ev.p.disputeId === 'dp_o1' && ev.p.evidenceType === 'proof_of_delivery' && /Signed delivery note/.test(ev.p.description));
    ck('no empty fileUrl is sent when none was given', ev && ev.p.fileUrl === undefined, JSON.stringify(ev && ev.p));
    ck('the outcome again says awaiting review', /Awaiting SOKONI review/.test(await page.textContent('.mdp-sheet')));

    console.log('\n  7. A closed dispute offers nothing');
    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 340);
    await page.click('[data-act="tab"][data-t="all"]');
    await settle(page);
    await clickCard(page, 2);
    await settle(page, 340);
    const closed = await page.textContent('.mdp-sheet');
    ck('a resolved dispute says SOKONI decided', /Resolved by SOKONI/i.test(closed));
    ck('...and offers no response control', (await page.$('[data-act="open-respond"]')) === null);
    ck('...and offers no evidence control', (await page.$('[data-act="open-evidence"]')) === null);
    ck('...and explains why', /no further response or evidence/i.test(closed));

    console.log('\n  8. States');
    await page.evaluate(() => { window.__mode = 'empty'; window.__mount(); });
    await settle(page, 320);
    ck('an empty queue says nothing needs attention', /Nothing needs your attention/i.test(await page.textContent('.mdp-body')));
    await page.evaluate(() => { window.__mode = 'error'; window.__mount(); });
    await settle(page, 320);
    const err = await page.textContent('.mdp-body');
    ck('a failed read is shown as a failure', /could not be loaded/i.test(err));
    ck('...and NOT as an empty queue', !/Nothing needs your attention/i.test(err));
    await page.evaluate(() => { window.__mode = 'ok'; window.__mount(false); });
    await settle(page, 320);
    ck('a signed-out account is told to sign in', /Sign in to see disputes/i.test(await page.textContent('.mdp')));

    console.log('\n  9. Nothing local');
    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 340);
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
