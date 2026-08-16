/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT TEAM/STAFF — RUNTIME, on a real phone viewport (2D-2 step 2)
   ══════════════════════════════════════════════════════════════════════════════
   The pure suite (test-merchant-staff.js) proves the payloads and the
   merchant-path invariants. This one drives the surface in WebKit at the same
   widths Sell and Inventory were accepted at, and answers the acceptance gates
   that only a rendered screen can answer:

     · does the owner see only the staff of the CANONICAL activeShopId?
     · does every mutation leave through a server authority, with the shop on it?
     · does a long name or a 40-person team break the layout sideways?
     · are empty, loading, error and pending-invite all real, distinct states?
     · does a refusal show the server's words rather than a generic failure?

   The callables are STUBS that record every payload, so "which authority was
   called, with what" is observed rather than assumed — and a surface that edits
   its own list instead of asking the server is caught.

   Run: node scripts/test-merchant-team-ui.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
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
<div id="wrap"><div class="native" id="native-staff"></div></div>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-staff.js"></script>
<script src="/sokoni-merchant-team.js"></script>
<script>
window.__calls = [];
window.__mode = 'ok';           /* ok | empty | error | inviteError | removeDenied | slow | invitesError */
window.__release = null;
window.__team = null;

const SHOP_B = 'SHOP_B_shop_91c';
const SHOP_C = 'SHOP_C_shop_42x';
const SELLER_A = 'SELLER_A_uid_7f3';

/* The SERVER's view. Keyed by shop, so a surface that ignores shopId returns the
   wrong rows rather than silently returning everything. */
var SERVER = {};
function reset () {
  SERVER = {
    [SHOP_B]: {
      employees: [
        { id: SHOP_B+'_u1', uid:'u1', name:'Ann Ali', email:'ann@example.com', role:'manager', active:true },
        { id: SHOP_B+'_u2', uid:'u2', name:'Bob Bee', email:'bob@example.com', role:'cashier', active:true },
        { id: SHOP_B+'_u3', uid:'u3', name:'Priscilla Wanjiru-Kamau Ochieng Muthoni', email:'priscilla.wanjiru.kamau.ochieng@verylongdomainexample.co.ke', role:'inventory', active:true },
      ],
      invites: [ { token:'tok_1', email:'new@example.com', role:'cashier', expired:false } ],
    },
    [SHOP_C]: {
      employees: [ { id: SHOP_C+'_z9', uid:'z9', name:'Other Shop Person', email:'z@other.com', role:'manager', active:true } ],
      invites: [ { token:'tok_c', email:'c@other.com', role:'manager', expired:false } ],
    },
  };
}
reset();

function shopOf (p) { return (p && p.shopId) || null; }
function guard (name, p) {
  window.__calls.push({ name, p });
  const sid = shopOf(p);
  /* The stub enforces the same boundary the server does. */
  if (name !== 'revokeShopInvite' && sid !== SHOP_B) {
    const e = new Error('You do not have access to this shop.'); e.code = 'permission-denied'; throw e;
  }
}

window.__ctx = function (shopId) {
  const scope = SokoniMerchantData.resolveScope({ uid: SELLER_A, activeShopId: shopId === undefined ? SHOP_B : shopId });
  return {
    scope, shopName: 'B Shop', origin: 'https://mysokoni.co.ke',
    callList: async (p) => {
      guard('listShopEmployees', p);
      if (window.__mode === 'error') throw new Error('Your team could not be loaded.');
      if (window.__mode === 'slow') return new Promise(r => { window.__release = () => r({ data: { ok:true, shopId:p.shopId, employees: SERVER[p.shopId].employees } }); });
      const emp = window.__mode === 'empty' ? [] : SERVER[p.shopId].employees;
      return { data: { ok:true, shopId:p.shopId, employees: emp } };
    },
    callInvites: async (p) => {
      guard('listShopInvites', p);
      if (window.__mode === 'invitesError') throw new Error('Outstanding invites could not be loaded.');
      const inv = window.__mode === 'empty' ? [] : SERVER[p.shopId].invites;
      return { data: { ok:true, shopId:p.shopId, invites: inv, count: inv.length, staleCount: window.__stale || 0 } };
    },
    callInvite: async (p) => {
      guard('inviteShopEmployee', p);
      if (window.__mode === 'inviteError') { const e = new Error('Invite limit reached (20 per day). Try again tomorrow.'); e.code='resource-exhausted'; throw e; }
      SERVER[p.shopId].invites.push({ token:'tok_new', email:p.email, role:p.role, expired:false });
      return { data: { token:'tok_new', shopId:p.shopId } };
    },
    callRevoke: async (p) => {
      window.__calls.push({ name:'revokeShopInvite', p });
      SERVER[SHOP_B].invites = SERVER[SHOP_B].invites.filter(v => v.token !== p.token);
      return { data: { success:true } };
    },
    callRemove: async (p) => {
      guard('removeShopEmployee', p);
      if (window.__mode === 'removeDenied') { const e = new Error('Only the shop owner can manage staff.'); e.code='permission-denied'; throw e; }
      SERVER[p.shopId].employees = SERVER[p.shopId].employees.filter(e => e.uid !== p.uid);
      return { data: { ok:true, shopId:p.shopId, uid:p.uid, active:false } };
    },
    onToast: (m,k) => { (window.__toasts = window.__toasts || []).push([m,k]); }
  };
};

window.__mount = function (shopId) {
  if (window.__team) { try { window.__team.destroy(); } catch(e){} window.__team = null; }
  const h = document.getElementById('native-staff');
  h.innerHTML = '';
  window.__team = SokoniMerchantTeam.mount(h, window.__ctx(shopId));
};
window.__reset = reset;
window.__bigTeam = function (n) {
  SERVER[SHOP_B].employees = Array.from({length:n}, (_,i) => ({
    id: SHOP_B+'_b'+i, uid:'b'+i, name:'Employee Number '+i, email:'emp'+i+'@example.com',
    role: ['manager','cashier','inventory','support'][i % 4], active:true }));
};
</` + `script></body></html>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HARNESS); }
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(d);
  });
});

const VIEWPORTS = [
  { name: 'iPhone SE',     width: 375, height: 667 },
  { name: 'iPhone 14 Pro', width: 393, height: 852 },
];
const settle = (page, ms = 180) => page.waitForTimeout(ms);
const overflow = (page) => page.evaluate(() => ({
  doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  body: document.body.scrollWidth - document.body.clientWidth,
}));

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

    /* ══ 1. The owner's team ══ */
    console.log('\n  1. The owner sees their shop\'s team');
    await page.evaluate(() => { window.__reset(); window.__calls = []; window.__mount(); });
    await settle(page, 320);

    const rows = await page.$$('.mtm-row');
    ck('the team is listed', rows.length === 3, rows.length + ' rows');
    ck('the roster came from listShopEmployees, scoped by shopId',
      await page.evaluate(() => {
        const c = window.__calls.find(x => x.name === 'listShopEmployees');
        return !!c && c.p.shopId === 'SHOP_B_shop_91c';
      }));
    ck('managers sort to the top', /Ann Ali/.test(await page.$eval('.mtm-row:nth-child(1)', e => e.textContent)));
    ck('another shop\'s staff is NOT shown',
      !(await page.$eval('.mtm-body', e => e.textContent)).includes('Other Shop Person'));

    /* ══ 2. Phone ergonomics with hostile data ══ */
    console.log('\n  2. It survives a long name and a big team');
    const o1 = await overflow(page);
    ck('a 47-character name does not scroll the page sideways', o1.doc <= 0 && o1.body <= 0, JSON.stringify(o1));
    ck('...and the name is ellipsised rather than wrapped into the row',
      await page.$eval('.mtm-row:nth-child(3) .mtm-nm', (e) => getComputedStyle(e).textOverflow === 'ellipsis'));

    await page.evaluate(() => { window.__bigTeam(40); window.__mount(); });
    await settle(page, 340);
    ck('a 40-person team renders', (await page.$$('.mtm-row')).length === 40);
    const o2 = await overflow(page);
    ck('...and still does not overflow sideways', o2.doc <= 0 && o2.body <= 0, JSON.stringify(o2));
    ck('...and the list scrolls inside its own container',
      await page.$eval('.mtm-body', (e) => e.scrollHeight > e.clientHeight));

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

    /* ══ 3. Empty state ══ */
    console.log('\n  3. Empty is an answer, not a spinner');
    await page.evaluate(() => { window.__reset(); window.__mode = 'empty'; window.__mount(); });
    await settle(page, 320);
    const emptyTxt = await page.textContent('.mtm-body');
    ck('an empty team says so plainly', /just you so far/i.test(emptyTxt), emptyTxt.slice(0, 60).replace(/\s+/g, ' '));
    ck('...and still offers the one useful action', (await page.$('[data-act="open-invite"]')) !== null);
    ck('...and shows no skeleton left running', (await page.$$('.sk-line')).length === 0);

    /* ══ 4. Error state ══ */
    console.log('\n  4. A failed read is a failure, not an empty team');
    await page.evaluate(() => { window.__mode = 'error'; window.__mount(); });
    await settle(page, 320);
    const errTxt = await page.textContent('.mtm-body');
    ck('the failure is shown', /could not be loaded/i.test(errTxt));
    ck('...with a retry', (await page.$('[data-act="reload"]')) !== null);
    ck('...and NOT as "it is just you so far"', !/just you so far/i.test(errTxt));

    /* ══ 5. Invite ══ */
    console.log('\n  5. Inviting goes through the authority');
    await page.evaluate(() => { window.__reset(); window.__mode = 'ok'; window.__calls = []; window.__mount(); });
    await settle(page, 320);
    await page.click('[data-act="open-invite"]');
    await settle(page);
    ck('the invite sheet opens', /Invite someone/.test(await page.textContent('.mtm-sheet')));
    ck('Create is disabled until a role is chosen',
      await page.$eval('[data-act="send"]', (b) => b.disabled === true));

    await page.fill('#mtm-email', 'new.person@example.com');
    await page.click('[data-act="role"][data-r="cashier"]');
    await settle(page);
    ck('with an email and a role, Create becomes available',
      await page.$eval('[data-act="send"]', (b) => b.disabled === false));

    await page.click('[data-act="send"]');
    await settle(page, 340);
    const inviteCall = await page.evaluate(() => window.__calls.find(c => c.name === 'inviteShopEmployee'));
    ck('inviteShopEmployee was called exactly once',
      (await page.evaluate(() => window.__calls.filter(c => c.name === 'inviteShopEmployee').length)) === 1);
    ck('...carrying the shop, the normalised email and the role',
      inviteCall.p.shopId === 'SHOP_B_shop_91c' && inviteCall.p.email === 'new.person@example.com' && inviteCall.p.role === 'cashier',
      JSON.stringify(inviteCall.p));
    const linkVal = await page.$eval('#mtm-link', (e) => e.value);
    ck('the link is built from the SERVER token',
      linkVal === 'https://mysokoni.co.ke/join?t=tok_new&type=shop', linkVal);
    ck('...and the screen says nothing is granted until they accept',
      /only after they accept/i.test(await page.textContent('.mtm-sheet')));

    /* ══ 6. Invite failure ══ */
    console.log('\n  6. A refused invite shows the server\'s words');
    await page.evaluate(() => { window.__reset(); window.__mode = 'inviteError'; window.__mount(); });
    await settle(page, 320);
    await page.click('[data-act="open-invite"]');
    await page.fill('#mtm-email', 'x@example.com');
    await page.click('[data-act="role"][data-r="manager"]');
    await page.click('[data-act="send"]');
    await settle(page, 340);
    ck('the server\'s refusal is shown verbatim',
      /Invite limit reached \(20 per day\)/.test(await page.textContent('.mtm-sheet')));
    ck('...and no link is offered', (await page.$('#mtm-link')) === null);

    /* ══ 7. Pending invites ══ */
    console.log('\n  7. Pending invites are visible and withdrawable');
    await page.evaluate(() => { window.__reset(); window.__mode = 'ok'; window.__calls = []; window.__mount(); });
    await settle(page, 340);
    await page.click('[data-act="tab"][data-t="invites"]');
    await settle(page);
    ck('the pending invite is listed', /new@example.com/.test(await page.textContent('.mtm-body')));
    ck('...marked Pending', /Pending/.test(await page.textContent('.mtm-body')));

    await page.click('[data-act="revoke"][data-i="0"]');
    await settle(page, 340);
    ck('withdrawing goes through revokeShopInvite',
      (await page.evaluate(() => window.__calls.filter(c => c.name === 'revokeShopInvite').length)) === 1);
    ck('...and the list is re-read from the server, not spliced locally',
      (await page.evaluate(() => window.__calls.filter(c => c.name === 'listShopInvites').length)) >= 2);

    /* Stale pre-convergence invites are reported, not hidden. */
    await page.evaluate(() => { window.__reset(); window.__stale = 2; window.__mount(); });
    await settle(page, 360);
    await page.click('[data-act="tab"][data-t="invites"]');
    await settle(page);
    ck('pre-convergence invites are reported honestly',
      /cannot be accepted any more/i.test(await page.textContent('.mtm-body')));
    await page.evaluate(() => { window.__stale = 0; });

    /* ══ 8. Removal ══ */
    console.log('\n  8. Removal goes through the server authority');
    await page.evaluate(() => { window.__reset(); window.__mode = 'ok'; window.__calls = []; window.__mount(); });
    await settle(page, 340);
    await page.click('.mtm-row:nth-child(2) [data-act="member"]');
    await settle(page);
    ck('the member sheet opens on the chosen person', /Bob Bee/.test(await page.textContent('.mtm-sheet')));
    ck('...and explains the record is kept, not deleted',
      /kept, not deleted/i.test(await page.textContent('.mtm-sheet')));

    await page.click('[data-act="remove"]');
    await settle(page, 400);
    const rmCall = await page.evaluate(() => window.__calls.find(c => c.name === 'removeShopEmployee'));
    ck('removeShopEmployee was called with shop and uid',
      rmCall && rmCall.p.shopId === 'SHOP_B_shop_91c' && rmCall.p.uid === 'u2', JSON.stringify(rmCall && rmCall.p));
    ck('the list is RE-READ from the server afterwards',
      (await page.evaluate(() => window.__calls.filter(c => c.name === 'listShopEmployees').length)) >= 2);
    ck('...and the person is gone', !(await page.$eval('.mtm-body', e => e.textContent)).includes('Bob Bee'));

    /* ══ 9. Refused removal ══ */
    console.log('\n  9. A refused removal changes nothing on screen');
    await page.evaluate(() => { window.__reset(); window.__mode = 'removeDenied'; window.__mount(); });
    await settle(page, 340);
    await page.click('.mtm-row:nth-child(2) [data-act="member"]');
    await page.click('[data-act="remove"]');
    await settle(page, 360);
    ck('the refusal is shown in the server\'s words',
      /Only the shop owner can manage staff/.test(await page.textContent('.mtm-sheet')));
    /* The footer's Cancel, specifically. `[data-act="close"]` also matches the
       scrim, whose centre point sits underneath the sheet — so a bare selector
       resolves to an element a real thumb could never hit there. */
    await page.click('.mtm-sh-f [data-act="close"]');
    await settle(page);
    ck('...and the person is still listed', /Bob Bee/.test(await page.textContent('.mtm-body')));

    /* ══ 10. Cross-tenant ══ */
    console.log('\n  10. SHOP_C is unreachable from this workspace');
    await page.evaluate(() => { window.__reset(); window.__mode = 'ok'; window.__calls = []; window.__mount('SHOP_C_shop_42x'); });
    await settle(page, 360);
    const cTxt = await page.textContent('.mtm-body');
    ck('asking for SHOP_C is refused by the authority', /could not be loaded/i.test(cTxt), cTxt.slice(0, 60).replace(/\s+/g, ' '));
    ck('...and no SHOP_C staff is rendered', !cTxt.includes('Other Shop Person'));

    /* ══ 11. No shop ══ */
    console.log('\n  11. A merchant with no shop is told so');
    await page.evaluate(() => window.__mount(null));
    await settle(page, 260);
    ck('an unresolved shop renders an honest empty state',
      /No shop is active yet/.test(await page.textContent('.mtm')));
    ck('...and no authority was called for a guessed shop',
      (await page.evaluate(() => window.__calls.filter(c => c.name === 'listShopEmployees' && !c.p.shopId).length)) === 0);

    /* ══ 12. Nothing local ══ */
    console.log('\n  12. Nothing is stored on the device');
    await page.evaluate(() => { window.__reset(); window.__mount(); });
    await settle(page, 340);
    const ls = await page.evaluate(() => Object.keys(localStorage));
    ck('the surface wrote NO localStorage key', ls.length === 0, ls.join(','));

    const real = errors.filter((e) => !/favicon|404/.test(e));
    ck('no page error or console error during the whole run', real.length === 0, real.slice(0, 2).join(' | '));

    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
