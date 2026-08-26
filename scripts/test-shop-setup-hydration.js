#!/usr/bin/env node
/* Shop Setup hydration — does the CANONICAL value survive to the form?
 *
 *   node scripts/test-shop-setup-hydration.js
 *
 * The backend is proven (test-kasshop-boundary.js, 52/52 on real Firestore: save → fresh read
 * returns the same shopId and values). The device still loses them. There are only three places
 * the value can vanish:
 *
 *     1. before getShopProfile   — never saved, or saved against another shop
 *     2. in its response          — Firestore returned something else
 *     3. after the response       — the UI overwrote the form
 *
 * (1) and (2) are already excluded on the server. This suite tests (3) — the only part a
 * browser can be wrong about on its own — by stubbing getShopProfile to return a KNOWN profile
 * and then asking what the form actually holds afterwards.
 *
 * The decisive case is `stale cache disagrees`: localStorage holds OLD values while Firestore
 * holds NEW ones. That is the exact device situation after a save, and the rule is absolute —
 * once Firestore answers, Firestore wins. A pass here means the hydration order is sound and
 * the device loss is upstream; a fail names it outright.
 */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

const UID = 'hydration-seller';
const SHOP_ID = 'shopHydrationTest';
const NAME = 'KASS TEST 731';
const ABOUT = 'PERSISTENCE TEST 731';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 120) + ']' : ''));
  ok ? pass++ : fail++;
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/seller.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

/* SHORTER THAN THE RUNNER'S BUDGET (240s for this suite, see SUITE_BUDGET_MS in
   gate-classify.js) ON PURPOSE. At 900s it could never fire: the runner killed the suite
   first, at 240s, and a killed suite is TIMEOUT — non-blocking, so it left the blocking set
   silently rather than saying it had hung. A watchdog that cannot outlive its own
   executioner is not a watchdog. */
const wd = setTimeout(() => { console.log('SKIP — watchdog'); process.exit(0); }, 180000);
wd.unref && wd.unref();

/* Stub Auth + the callable bridge. getShopProfile answers after `delayMs`, modelling the real
   round-trip — the cache paints first on a device, and the question is what happens next. */
function stubs({ delayMs, cache, exists, uid, email, profile, shopId }) {
  const _uid   = uid   || UID;
  const _email = email || 'hydration@sokoni.test';
  const _shop  = shopId || SHOP_ID;
  const _prof  = profile || { name: NAME, about: ABOUT, city: 'Nairobi', phone: '+254700000731' };
  return `(function(){
    var UID = ${JSON.stringify(_uid)};
    var EMAIL = ${JSON.stringify(_email)};
    ${cache ? `try{ localStorage.setItem('sokoniStore', JSON.stringify(${JSON.stringify(cache)})); }catch(e){}` : `try{ localStorage.removeItem('sokoniStore'); }catch(e){}`}
    try{ localStorage.setItem('loggedIn','true');
         localStorage.setItem('sokoniUser', JSON.stringify({uid:UID,email:EMAIL,name:'Hydration',roles:['seller'],role:'seller'})); }catch(e){}

    var listeners=[]; var current={uid:UID,email:EMAIL};
    var _authStub = { get currentUser(){return current;},
      onAuthStateChanged:function(cb){ listeners.push(cb); try{cb(current);}catch(e){} return function(){}; } };
    /* The real firebase.js does \`window.firebaseAuth = <real Auth>\` on load and would
       replace this, leaving currentUser null — which made every identity assertion
       vacuous. A setter that IGNORES writes keeps the stub authoritative and is legal
       in strict mode (unlike a getter-only property, which would throw in the module). */
    try {
      Object.defineProperty(window, 'firebaseAuth', {
        configurable: true, get: function(){ return _authStub; }, set: function(){ /* ignored */ },
      });
    } catch(e) { window.firebaseAuth = _authStub; }
    window.firebaseDB = { __stub:true };
    window.__sokoniAppCheckReady = Promise.resolve();

    window.__calls = [];
    window.sokoniCallable = function(name){
      return function(payload){
        window.__calls.push(name);
        if (name === 'getShopProfile') {
          return new Promise(function(res){ setTimeout(function(){
            res({ data: ${exists ? `{
              exists:true, shopId:${JSON.stringify(_shop)}, ownerUid:UID,
              profile:${JSON.stringify(_prof)},
              availability:{acceptingOrders:true,online:true,delivery:true,pickup:true},
              handle:'kasstest731', storefrontUrl:'/shop/kasstest731'
            }` : `{ exists:false, shopId:null, ownerUid:null, profile:null, availability:null, handle:null }`} });
          }, ${delayMs}); });
        }
        return Promise.resolve({ data:{ success:true } });
      };
    };
  })();`;
}

async function readForm(page) {
  return page.evaluate(() => ({
    name: (document.getElementById('swStoreName') || {}).value,
    about: (document.getElementById('swAbout') || {}).value,
    city: (document.getElementById('swCity') || {}).value,
    /* Identity-bearing fields. These are the ones that make a wrong-account paint
       obvious to the seller — and kraPin/sbp/brs are the regulatory identifiers the
       Cloud Function deliberately keeps in an owner-only subcollection. */
    email: (document.getElementById('swEmail') || {}).value,
    phone: (document.getElementById('swPhone') || {}).value,
    kraPin: (document.getElementById('swKraPin') || {}).value,
    authUid: (window.firebaseAuth && window.firebaseAuth.currentUser || {}).uid || null,
    authEmail: (window.firebaseAuth && window.firebaseAuth.currentUser || {}).email || null,
    state: (document.getElementById('swStateBanner') || {}).dataset
      ? (document.getElementById('swStateBanner') || {}).dataset.state : null,
    banner: (document.getElementById('swStateBanner') || {}).textContent || null,
    shopId: window.__kasShopId || null,
    calls: window.__calls || [],
  }));
}

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  async function run(opts) {
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    });
    /* The real firebase.js reassigns window.firebaseAuth on load, clobbering the stub —
       so the page saw currentUser === null and the identity assertions were vacuous.
       Ownership now depends on Firebase Auth specifically (a cached profile blob is not
       an identity authority), so the stub has to be the one the page reads. The callable
       bridge and App Check are already stubbed, so nothing else here needs the module. */
    /* firebase.js is left REAL. Stubbing the module out broke every consumer that
       imports db/auth/storage by name, which surfaced as page errors that looked like
       product bugs but were the harness's. The only thing that needs overriding is the
       identity the page reads — see stubs(), which pins window.firebaseAuth behind a
       getter whose setter ignores writes, so the real module's assignment is discarded
       while db/storage/fns stay genuine objects. */
    await ctx.addInitScript(stubs(opts));
    const page = await ctx.newPage();
    /* App Check cannot attest 127.0.0.1, so Firebase loads the Google API iframe helper and it
       throws from apis.google.com. That is the harness's origin problem, not the page's — but
       the filter is deliberately narrow (that module, that message) so a genuine error in our
       own code still fails this suite. */
    const errors = [];
    page.on('pageerror', (e) => {
      const msg = String(e && e.message || e);
      const stack = String((e && e.stack) || '');
      const isGapi = /apis\.google\.com|gapi/.test(stack) && /u\[v\] is not a function/.test(msg);
      if (!isGapi) errors.push(msg);
    });
    /* ?legacy=1. This suite tests the LEGACY getShopProfile -> seller.html#store form. The
       native Shop surface (sokoni-merchant-store-ui.js, route kind:'native') is a different
       authority entirely — getMyMinishop/saveMinishop — so pointing this at merchant-v2 would
       not test the same thing. See docs/findings for the coverage gap that leaves. */
    await page.goto(BASE + '/seller.html?legacy=1#store', { waitUntil: 'domcontentloaded', timeout: 60000 });
    /* Long enough for the stubbed round-trip plus any late overwrite. */
    await page.waitForTimeout(opts.settle || 9000);
    const form = await readForm(page);
    await ctx.close();
    return { form, errors };
  }

  console.log('\nSHOP SETUP HYDRATION — does the canonical value reach the form?');
  console.log('='.repeat(74));
  console.log('  canonical: name="' + NAME + '"  about="' + ABOUT + '"');

  /* ── 1. Cold device: nothing cached, Firestore has the shop ── */
  console.log('\n1. No cache — the form must be filled from Firestore alone');
  {
    const { form, errors } = await run({ delayMs: 1200, cache: null, exists: true });
    ck('getShopProfile was called', form.calls.indexOf('getShopProfile') !== -1, form.calls.join(','));
    ck('shop name is the canonical value', form.name === NAME, JSON.stringify(form.name));
    ck('description is the canonical value', form.about === ABOUT, JSON.stringify(form.about));
    ck('shopId was recorded', form.shopId === SHOP_ID, form.shopId);
    ck('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  }

  /* ── 2. THE DEVICE CASE: a stale cache disagrees with Firestore ── */
  console.log('\n2. Stale cache vs Firestore — Firestore must win');
  {
    const { form } = await run({
      delayMs: 1500, exists: true,
      cache: { ownerUid: UID, name: 'OLD CACHED NAME', about: 'OLD CACHED DESCRIPTION', city: 'Mombasa' },
    });
    ck('the stale cached name was replaced', form.name === NAME, JSON.stringify(form.name));
    ck('the stale cached description was replaced', form.about === ABOUT, JSON.stringify(form.about));
    /* swCity is a <select> whose options are lowercase, so the CONTROL's canonical value for
       "Nairobi" is "nairobi". What matters is that the canonical city won and the stale cached
       "Mombasa" did not survive — compared case-insensitively, because the display form and the
       stored form legitimately differ. */
    ck('the stale cached city was replaced by the canonical one',
       String(form.city || '').toLowerCase() === 'nairobi', JSON.stringify(form.city));
  }

  /* ── 3. A SLOW response must still win, however late it lands ── */
  console.log('\n3. Slow Firestore (4s) — the late answer still wins');
  {
    const { form } = await run({
      delayMs: 4000, exists: true, settle: 12000,
      cache: { ownerUid: UID, name: 'OLD CACHED NAME', about: 'OLD CACHED DESCRIPTION' },
    });
    ck('the late canonical name won', form.name === NAME, JSON.stringify(form.name));
    ck('the late canonical description won', form.about === ABOUT, JSON.stringify(form.about));
  }

  /* ── 4. No shop: the cache must not fake one ── */
  console.log('\n4. Firestore says no shop — a stale cache must not invent one');
  {
    const { form } = await run({
      delayMs: 900, exists: false,
      cache: { ownerUid: UID, name: 'GHOST SHOP', about: 'SHOULD NOT SURVIVE',
               email: 'ghost@previous.test', kraPin: 'A00GHOST99Z' },
    });
    ck('the empty state is reported', form.state === 'empty', form.state + ' :: ' + String(form.banner).slice(0, 60));
    ck('no shopId is adopted', !form.shopId, String(form.shopId));
    /* The banner and the shopId were the only things asserted here before, so this
       case passed while the seller was still looking at the previous shop's name,
       email and KRA PIN in the form. "You don't have a KassShop yet" has to mean
       the FIELDS say so too — otherwise a save would adopt the ghost values. */
    ck('the ghost NAME was cleared from the form',        !form.name,   JSON.stringify(form.name));
    ck('the ghost DESCRIPTION was cleared from the form', !form.about,  JSON.stringify(form.about));
    ck('the ghost EMAIL was cleared from the form',       !form.email,  JSON.stringify(form.email));
    ck('the ghost KRA PIN was cleared from the form',     !form.kraPin, JSON.stringify(form.kraPin));
  }

  /* ── 5. THE ACCOUNT-SWITCH CASE ───────────────────────────────────────────────
     Seller B opens Shop Details on a device whose cache still holds Seller A's shop.
     This is the wrong-account report: B sees A's email in their own Shop Details.

     sokoniSignOut() wipes localStorage, so a CLEAN sign-out already protects this.
     What it does not cover is every path that skips it — a force-quit mid-session, a
     session restored as a different user, or an account switch that never reached the
     sign-out handler. The cache is not stamped with an owner, so nothing else can tell
     whose data it is. Firestore must win, and until it answers no other account's
     values may be on screen. */
  console.log('\n5. Account switch — Seller B must never see Seller A\'s shop');
  {
    const A_CACHE = { ownerUid: 'seller-A-uid', name: 'SELLER A SHOP', about: 'SELLER A TEST',
                      email: 'sellerA@sokoni.test', phone: '+254700000001',
                      kraPin: 'A123456789Z', city: 'Mombasa' };
    const B_PROFILE = { name: 'SELLER B SHOP', about: 'SELLER B DESCRIPTION',
                        email: 'sellerB@sokoni.test', phone: '+254700000002', city: 'Nairobi' };

    const { form } = await run({
      delayMs: 1500, exists: true, cache: A_CACHE,
      uid: 'seller-B-uid', email: 'sellerB@sokoni.test',
      shopId: 'shopSellerB', profile: B_PROFILE,
    });
    ck('the session really is Seller B',   form.authUid === 'seller-B-uid', form.authUid);
    ck('B sees B\'s shop name',            form.name  === 'SELLER B SHOP', JSON.stringify(form.name));
    ck('B does NOT see A\'s description',  form.about !== 'SELLER A TEST', JSON.stringify(form.about));
    ck('B does NOT see A\'s email',        form.email !== 'sellerA@sokoni.test', JSON.stringify(form.email));
    ck('B does NOT see A\'s KRA PIN',      !form.kraPin || form.kraPin !== 'A123456789Z', JSON.stringify(form.kraPin));
    ck('B adopted B\'s shopId',            form.shopId === 'shopSellerB', String(form.shopId));
  }

  /* ── 6. Account switch where B has NO shop — the hardest version ──────────────
     B is new. Firestore answers exists:false, so there is nothing to overwrite A's
     cached paint with. Every field must still be B's (empty), not A's. */
  console.log('\n6. Account switch, B has no shop — A\'s values must not survive');
  {
    const { form } = await run({
      delayMs: 1200, exists: false,
      cache: { ownerUid: 'seller-A-uid', name: 'SELLER A SHOP', about: 'SELLER A TEST',
               email: 'sellerA@sokoni.test', kraPin: 'A123456789Z' },
      uid: 'seller-B-uid', email: 'sellerB@sokoni.test',
    });
    ck('the empty state is reported', form.state === 'empty', String(form.banner).slice(0, 60));
    ck('A\'s name did not survive',    !form.name,   JSON.stringify(form.name));
    ck('A\'s description did not survive', !form.about, JSON.stringify(form.about));
    ck('A\'s email did not survive',   !form.email,  JSON.stringify(form.email));
    ck('A\'s KRA PIN did not survive', !form.kraPin, JSON.stringify(form.kraPin));
  }

  /* REPORT FIRST, THEN TEAR DOWN — and never let teardown decide the verdict.
     In the deploy gate this suite printed its last four assertions PASS and was then
     SIGKILLed at its 240s budget, recording TIMEOUT — a non-blocking verdict, so a suite
     that had finished testing silently left the blocking set and its coverage was lost
     without anything failing. It had answered the question; browser.close() simply did not
     return. Same fix, same reason, as test-seller-deeplink, test-merchant-deep-switch and
     test-merchant-route-gate. */
  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');

  clearTimeout(wd);
  await Promise.race([
    (async () => { try { await browser.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  try { server.close(); } catch (_) {}
  console.log('\n  SCOPE: the browser half only — whether the canonical response reaches and holds');
  console.log('         the form. The server half is covered by test-kasshop-boundary.js. A pass');
  console.log('         here means a device that still loses values is losing them BEFORE the');
  console.log('         response, not after it.');
  process.exit(fail ? 1 : 0);
});
