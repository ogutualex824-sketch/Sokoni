/* KassShop claim must survive a reload — proven by DESTROYING page state and re-resolving.
 *
 *   node scripts/test-minishop-claim-persistence.js
 *
 * WHY THIS EXISTS
 * "Seller claims KassShop → owner mode → reload → asked to claim again."
 *
 * Two causes, both in the bootstrap, neither fixed by teaching the resolver new collections:
 *   1. Ownership identity came from localStorage.sokoniUser — a profile CACHE — instead of the
 *      authenticated Firebase UID.
 *   2. _resolve() ran ONCE, 700ms after load, and returned early if Auth/Firestore were not
 *      ready, leaving the default {claimed:false}. Auth restoration routinely takes longer than
 *      that on a cold mobile start, so the resolver concluded "unclaimed" before there was
 *      anyone to ask about — and never asked again.
 *
 * THE ASSERTION THAT CANNOT LIE
 * A button, a CSS class, an aria attribute or a localStorage key are NOT proof of persistence.
 * This drives the shell's own resolver against a stubbed Firestore, then throws the page away,
 * restores Auth late (as a real cold start does), and requires the SAME shopId and ownerUid to
 * come back with mode === "OWNER".
 *
 * Firestore and Auth are stubbed so the ORDERING can be controlled — specifically so Auth can be
 * made to answer AFTER the resolver starts, which is the exact race that caused the bug and
 * which a happy-path test would never reproduce. Proving it against real Firestore additionally
 * needs the emulator (App Check cannot attest 127.0.0.1) and remains NOT VERIFIED here.
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

const SHOP_ID = 'kassShop123';
const OWNER   = 'test-seller-001';
const HANDLE  = 'kass-shop-test';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 110) + ']' : ''));
  ok ? pass++ : fail++;
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('SKIP — watchdog'); process.exit(0); }, 135000);
wd.unref && wd.unref();

/* Stub Auth + Firestore INSIDE the page, before any shell script runs.
   authDelayMs models Auth restoration latency: 0 = warm, 2500 = a cold mobile start where the
   old 700ms timer had already given up and declared the shop unclaimed. */
function makeStubs({ authDelayMs, shopDoc, config, handles, failReads, uid, activeShopId, shopDocs }) {
  return `(function(){
    var FAIL_READS = ${failReads ? 'true' : 'false'};
    var UID = ${JSON.stringify(uid || OWNER)};
    var ACTIVE_SHOP = ${JSON.stringify(activeShopId || null)};
    if (ACTIVE_SHOP) {
      try { localStorage.setItem('activeShopId', ACTIVE_SHOP); } catch (e) {}
      window.SokoniShell = window.SokoniShell || {};
      window.SokoniShell.activeShopId = ACTIVE_SHOP;
    }
    var EXTRA_SHOPS = ${JSON.stringify(shopDocs || [])};
    var SHOP = ${JSON.stringify(shopDoc)};
    var ALL_SHOPS = (SHOP ? [SHOP] : []).concat(EXTRA_SHOPS || []);
    var CFG = ${JSON.stringify(config)};
    var HANDLES = ${JSON.stringify(handles)};
    var listeners = [];
    var current = null;
    window.firebaseAuth = {
      get currentUser(){ return current; },
      onAuthStateChanged: function(cb){ listeners.push(cb); try{ cb(current); }catch(e){} return function(){}; }
    };
    setTimeout(function(){
      current = { uid: UID };
      listeners.forEach(function(cb){ try{ cb(current); }catch(e){} });
    }, ${authDelayMs});

    /* Minimal Firestore surface the resolver uses. Recorded so the test can assert WHICH
       collection answered, not merely that something did. */
    window.__fsReads = [];
    window.firebaseDB = { __stub: true };
    window.__stubFirestore = {
      doc: function(db, col, id){ return { col: col, id: String(id) }; },
      collection: function(db, col){ return { col: col }; },
      where: function(f, op, v){ return { f: f, v: v }; },
      limit: function(n){ return { n: n }; },
      query: function(c){ var cs = [].slice.call(arguments, 1); return { col: c.col, cs: cs }; },
      getDoc: async function(ref){
        window.__fsReads.push('get:' + ref.col + '/' + ref.id);
        if (FAIL_READS) { var e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
        var hit = ALL_SHOPS.filter(function(s){ return s.__id === ref.id; })[0];
        if (ref.col === 'shops' && hit) return { exists: function(){return true;}, data: function(){ return hit; } };
        if (ref.col === 'minishopConfig' && CFG && CFG[ref.id]) return { exists: function(){return true;}, data: function(){ return CFG[ref.id]; } };
        return { exists: function(){return false;}, data: function(){ return null; } };
      },
      getDocs: async function(q){
        var w = (q.cs || []).find(function(c){ return c && c.f; });
        window.__fsReads.push('query:' + q.col + (w ? '[' + w.f + '=' + w.v + ']' : ''));
        if (FAIL_READS) { var e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
        var docs = [];
        if (q.col === 'shops' && w) {
          docs = ALL_SHOPS.filter(function(s){ return s[w.f] === w.v; })
                          .map(function(s){ return { id: s.__id, data: function(){ return s; } }; });
        }
        if (q.col === 'shopHandles' && w) {
          Object.keys(HANDLES || {}).forEach(function(h){
            if (HANDLES[h][w.f] === w.v) docs.push({ id: h, data: function(){ return HANDLES[h]; } });
          });
        }
        return { docs: docs };
      }
    };
  })();`;
}

/* The shell imports Firestore from gstatic; serve our stub instead so no network is involved. */
async function newSession(browser, opts) {
  /* serviceWorkers:'block' is load-bearing, not hygiene. merchant.html registers the SOKONI
     service worker, and once it takes control (~2s in) it serves gstatic from its own cache —
     which Playwright's route() does not intercept. The warm-start case imported Firestore before
     that happened and got the stub; the late-Auth case imported it after and silently got the
     REAL SDK, which then found no shop and reported UNCLAIMED. The suite was measuring its own
     service worker. Blocking it keeps every case on the same stub. */
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
  });
  await ctx.route('**/firebase-firestore.js*', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'const S = window.__stubFirestore;\n' +
          'export const doc = (...a) => S.doc(...a);\n' +
          'export const collection = (...a) => S.collection(...a);\n' +
          'export const where = (...a) => S.where(...a);\n' +
          'export const limit = (...a) => S.limit(...a);\n' +
          'export const query = (...a) => S.query(...a);\n' +
          'export const getDoc = (...a) => S.getDoc(...a);\n' +
          'export const getDocs = (...a) => S.getDocs(...a);\n' +
          'export const serverTimestamp = () => "ts";\n' +
          'export const updateDoc = async () => {};\n' +
          'export const setDoc = async () => {};\n',
  }));
  await ctx.addInitScript(makeStubs(opts));
  return ctx;
}

async function resolveState(page) {
  await page.waitForFunction('!!window.__miniShopState', { timeout: 30000 }).catch(() => {});
  return page.evaluate(() => window.__miniShopState || null);
}

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  const CLAIMED_SHOP = { __id: SHOP_ID, sellerUid: OWNER, name: 'KASS SHOP' };
  const CONFIG = { [SHOP_ID]: { handle: HANDLE, shopId: SHOP_ID, ownerUid: OWNER } };
  const HANDLES = { [HANDLE]: { shopId: SHOP_ID, uid: OWNER, handle: HANDLE } };

  console.log('\nKASSSHOP CLAIM PERSISTENCE');
  console.log('='.repeat(74));
  console.log('  shopId=' + SHOP_ID + '  ownerUid=' + OWNER + '  handle=' + HANDLE);

  /* ── 1. Warm start: Auth already restored ── */
  console.log('\n1. Auth already restored (warm start)');
  {
    const ctx = await newSession(browser, { authDelayMs: 0, shopDoc: CLAIMED_SHOP, config: CONFIG, handles: HANDLES });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    const st = await resolveState(page);
    ck('resolves OWNER mode', st && st.mode === 'OWNER', JSON.stringify(st));
    ck('resolves the SAME shopId', st && st.shopId === SHOP_ID, st && st.shopId);
    ck('ownerUid is the authenticated uid', st && st.ownerUid === OWNER, st && st.ownerUid);
    const reads = await page.evaluate(() => window.__fsReads || []);
    ck('ownership came from a shops query on sellerUid',
       reads.some((r) => r === 'query:shops[sellerUid=' + OWNER + ']'), reads.slice(0, 3).join(' | '));
    await ctx.close();
  }

  /* ── 2. THE BUG: Auth restores LATE, after the old 700ms timer would have fired ── */
  console.log('\n2. Cold start — Auth restores at 2.5s (the reload case that used to fail)');
  {
    const ctx = await newSession(browser, { authDelayMs: 2500, shopDoc: CLAIMED_SHOP, config: CONFIG, handles: HANDLES });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });

    /* Before Auth answers, the shell must NOT have decided "unclaimed". */
    await page.waitForTimeout(1200);
    const early = await page.evaluate(() => ({
      state: window.__miniShopState || null,
      label: (document.getElementById('mshop-state') || {}).textContent || '',
    }));
    ck('while LOADING it does not claim to be unclaimed', !early.state || early.state.mode !== 'UNCLAIMED',
       JSON.stringify(early.state));
    ck('while LOADING it does not offer "Claim Shop"', !/claim/i.test(early.label), 'label="' + early.label.trim() + '"');

    const st = await resolveState(page);
    ck('after Auth restores it resolves OWNER', st && st.mode === 'OWNER', JSON.stringify(st));
    ck('same shopId after late Auth', st && st.shopId === SHOP_ID, st && st.shopId);
    if (!st || st.mode !== 'OWNER') {
      console.log('      reads: ' + JSON.stringify(await page.evaluate(() => window.__fsReads || [])));
    }
    await ctx.close();
  }

  /* ── 3. PERSISTENCE: destroy the page entirely, restore Auth late, re-resolve ── */
  console.log('\n3. Page state destroyed, fresh load, Auth restored late (the reload test)');
  {
    const ctx = await newSession(browser, { authDelayMs: 1800, shopDoc: CLAIMED_SHOP, config: CONFIG, handles: HANDLES });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    const first = await resolveState(page);

    /* Throw everything away — new page object, and clear every client-side store so nothing
       can carry the answer forward. Only Firestore may supply it. */
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
    await page.close();
    const page2 = await ctx.newPage();
    await page2.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    const second = await resolveState(page2);

    ck('reload still resolves OWNER', second && second.mode === 'OWNER', JSON.stringify(second));
    ck('reload resolves the SAME shopId', first && second && first.shopId === second.shopId,
       (first && first.shopId) + ' -> ' + (second && second.shopId));
    ck('reload resolves the SAME ownerUid', second && second.ownerUid === OWNER, second && second.ownerUid);
    ck('persistence did NOT come from localStorage (it was cleared)',
       await page2.evaluate(() => !localStorage.getItem('sokoniUser')), 'cache empty');
    await ctx.close();
  }

  /* ── 4. A genuinely unowned shop must still offer Claim ── */
  console.log('\n4. No owned shop — Claim is correct here');
  {
    const ctx = await newSession(browser, { authDelayMs: 0, shopDoc: null, config: {}, handles: {} });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    const st = await resolveState(page);
    ck('resolves UNCLAIMED when no shop names this uid', st && st.mode === 'UNCLAIMED', JSON.stringify(st));
    ck('no shopId is invented', st && !st.shopId, String(st && st.shopId));
    await ctx.close();
  }

  /* ── 5. Another seller's shop must never resolve as mine ── */
  console.log('\n5. A shop owned by someone else is not mine');
  {
    const other = { __id: 'someoneElseShop', sellerUid: 'different-uid-999', name: 'Other Shop' };
    const ctx = await newSession(browser, { authDelayMs: 0, shopDoc: other, config: {}, handles: {} });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    const st = await resolveState(page);
    ck('does NOT claim ownership of another uid\'s shop', st && st.mode !== 'OWNER', JSON.stringify(st));
    ck('does not adopt the other shopId', !st || st.shopId !== 'someoneElseShop', String(st && st.shopId));
    await ctx.close();
  }

  /* ── 6. A FAILED read is not an EMPTY read ── */
  console.log('\n6. Firestore reads denied — unknown, not "unclaimed"');
  {
    /* Every ownership lookup swallowed its error and returned null, so permission-denied looked
       identical to "this seller owns no shop" and the shell invited them to re-claim a shop they
       already own. An error must never be rendered as an invitation. */
    const ctx = await newSession(browser, { authDelayMs: 0, shopDoc: CLAIMED_SHOP, config: CONFIG, handles: HANDLES, failReads: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(6000);
    const out = await page.evaluate(() => ({
      state: window.__miniShopState || null,
      label: (document.getElementById('mshop-state') || {}).textContent || '',
      reads: (window.__fsReads || []).length,
    }));
    ck('the reads were actually attempted', out.reads > 0, 'reads=' + out.reads);
    ck('denied reads do NOT resolve to UNCLAIMED', !out.state || out.state.mode !== 'UNCLAIMED',
       JSON.stringify(out.state));
    ck('denied reads do NOT offer "Claim Shop"', !/claim/i.test(out.label), 'label="' + out.label.trim() + '"');
    await ctx.close();
  }

  /* ── 7. A shop this uid does NOT own must never be adopted ── */
  console.log('\n7. Another seller\'s claimed shop sits in activeShopId — it is not mine');
  {
    /* THE CROSS-SELLER LEAK.
       activeShopId comes from SokoniBranch / localStorage and survives an account switch, so on
       a shared device it can name the PREVIOUS seller's shop. The handle lookup used to fall
       back to `activeId || uid` when nothing was owned, read that shop's minishopConfig, and
       adopt its handle — so a seller who owned nothing was shown someone else's storefront as
       "Shop Live", with a link straight into it. */
    const ctx = await newSession(browser, {
      authDelayMs: 0,
      uid: 'seller-with-no-shop',
      activeShopId: SHOP_ID,                 // the OTHER seller's shop, left behind on the device
      shopDoc: CLAIMED_SHOP,                 // owned by OWNER, not by us
      config: CONFIG,                        // and it has a handle
      handles: HANDLES,
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    const st = await resolveState(page);

    ck('does not enter OWNER mode', st && st.mode !== 'OWNER', JSON.stringify(st));
    ck('adopts no shopId', st && !st.shopId, String(st && st.shopId));
    ck('adopts no handle', st && !st.handle, String(st && st.handle));
    ck('is not reported as claimed', st && st.claimed === false, String(st && st.claimed));
    ck('ownerUid is not set to this uid', st && !st.ownerUid, String(st && st.ownerUid));

    const label = await page.evaluate(() => (document.getElementById('mshop-state') || {}).textContent || '');
    ck('the header does NOT say "Shop Live"', !/shop live/i.test(label), 'label="' + label.trim() + '"');

    /* And opening it must give an empty state — not the other seller's storefront, and not the
       seller management page. */
    const opened = await page.evaluate(async () => {
      try { window.__mgo('minishop'); } catch (e) { return { err: e.message }; }
      await new Promise((r) => setTimeout(r, 1500));
      const panel = document.querySelector('.mpanel.show');
      const frame = panel && panel.querySelector('iframe');
      return {
        src: (frame && frame.getAttribute('src')) || null,
        empty: !!(panel && panel.querySelector('.sk-blocked')),
        text: (panel && panel.textContent || '').slice(0, 120),
        url: window.__miniShopUrl || null,
      };
    });
    ck('no management page is loaded', !/minishop-admin/.test(opened.src || ''), 'src=' + opened.src);
    ck('no storefront is loaded', !/\/shop\//.test(opened.src || ''), 'src=' + opened.src);
    ck('the empty state is shown instead', opened.empty === true, JSON.stringify(opened));
    ck('it says the shop is not claimed', /haven't claimed|have not claimed/i.test(opened.text),
       opened.text.replace(/\s+/g, ' ').slice(0, 80));
    await ctx.close();
  }

  /* ── 8. The owner gets management, and the storefront only as a preview ── */
  console.log('\n8. Owner opens My MiniShop — management, not the public storefront');
  {
    const ctx = await newSession(browser, { authDelayMs: 0, shopDoc: CLAIMED_SHOP, config: CONFIG, handles: HANDLES });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await resolveState(page);
    const opened = await page.evaluate(async () => {
      try { window.__mgo('minishop'); } catch (e) { return { err: e.message }; }
      await new Promise((r) => setTimeout(r, 1500));
      const frame = document.querySelector('.mpanel.show iframe');
      return { src: (frame && frame.getAttribute('src')) || null, url: window.__miniShopUrl || null };
    });
    ck('owner lands on the private control centre', /minishop-admin/.test(opened.src || ''), 'src=' + opened.src);
    ck('the public storefront is a preview, not the destination',
       !/\/shop\//.test(opened.src || ''), 'src=' + opened.src);
    await ctx.close();
  }

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('\n  SCOPE: proves the resolver survives page destruction, a cleared cache and late');
  console.log('         Auth; that ownership comes from shops.sellerUid == authenticated uid and');
  console.log('         from nothing else; and that a non-owner is handed neither a storefront');
  console.log('         nor the seller management page.');
  console.log('         The claim WRITE is covered by test-minishop-claim-firestore.js.');
  console.log('         NOT VERIFIED here: the on-device reload.');
  /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
     Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
     at their budget because close() never returned, so a finished result was recorded
     as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
  try { clearTimeout(wd); } catch (_) {}
  await Promise.race([
    (async () => { try { await browser.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  /* A close that lost the race above is still RUNNING. Abandoning it leaks the browser:
     measured at 32 orphaned WebKit processes after one gate, which starves the renderers
     of later suites and crashes them. Kill what did not close. */
  try { const _p = browser.process && browser.process(); if (_p) _p.kill('SIGKILL'); } catch (_) {}
  try { server.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
