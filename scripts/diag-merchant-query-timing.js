#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT QUERY TIMING — how long does the canonical products read actually take?
   ------------------------------------------------------------------------------
   DIAGNOSTIC ONLY. Reads. Creates nothing, writes nothing, deploys nothing.

   Sell and Availability both sat textless past a 25s ceiling in the authenticated
   containment gate. Neither is failing: Sell's load() sets phase='error' on
   rejection, which renders "Products could not be loaded", and Availability's
   readShop/readProducts swallow internally and resolve. A body with NO TEXT
   therefore means the promise had neither resolved nor rejected — still loading.

   Both sit behind the same canonical products read. This times it cleanly:

     · FIRST call, cold, nothing else in flight — the earlier ~30s figure came from
       a second call issued while the first pass was still settling, so it could not
       be trusted and is not repeated here.
     · Each stage timed separately, so a slow shop resolve is not blamed on the query.
     · Reports whether the read came from cache or the backend, because a cache hit
       is a different measurement entirely.

     $env:APPCHECK_DEBUG_TOKEN = "..."
     $env:MERCHANT_EMAIL       = "..."
     $env:MERCHANT_PASSWORD    = "..."
     node scripts/diag-merchant-query-timing.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs'), http = require('http'), path = require('path');
const { webkit } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = process.env.APPCHECK_DEBUG_TOKEN || '';
const EMAIL = process.env.MERCHANT_EMAIL || '';
const PASSWORD = process.env.MERCHANT_PASSWORD || '';
const PLACEHOLDER = (v) => !v || /^<.*>$/.test(v) || /^(YOUR|THE)[_-]/i.test(v);
if (PLACEHOLDER(TOKEN) || PLACEHOLDER(EMAIL) || PLACEHOLDER(PASSWORD)) {
  console.error('\nNeed APPCHECK_DEBUG_TOKEN, MERCHANT_EMAIL, MERCHANT_PASSWORD (real values).\n');
  process.exit(2);
}

const MIME = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json',
               '.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  let f = path.join(ROOT, p); if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); r.end(d);
  });
});

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const b = await webkit.launch();
  const ctx = await b.newContext({ viewport:{ width:393, height:852 }, isMobile:true, hasTouch:true });
  await ctx.addInitScript((t) => { try { localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', t); } catch(e){} }, TOKEN);
  const pg = await ctx.newPage();

  await pg.goto(BASE + '/index.html', { waitUntil:'domcontentloaded', timeout:40000 });
  await pg.waitForFunction(() => typeof window.__sokoniAppCheckState === 'string', null, { timeout:25000 }).catch(()=>null);
  await pg.waitForTimeout(2500);
  const s = await pg.evaluate(async (o) => {
    const [{ getApps, getApp }, A] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')]);
    if (!getApps().length) return { ok:false, why:'no app' };
    try { const c = await A.signInWithEmailAndPassword(A.getAuth(getApp()), o.e, o.p); return { ok:true, uid:c.user.uid }; }
    catch (e) { return { ok:false, why:e.code || String(e) }; }
  }, { e: EMAIL, p: PASSWORD });
  if (!s.ok) { console.log('\nsign-in failed: ' + s.why + '\n'); await b.close(); server.close(); process.exit(1); }

  const tNav = Date.now();
  await pg.goto(BASE + '/merchant.html', { waitUntil:'domcontentloaded', timeout:40000 });
  const shopOk = await pg.waitForFunction(() => !!((window.SokoniShell||{}).activeShopId), null, { timeout:60000 })
    .then(() => true).catch(() => false);
  const shopMs = Date.now() - tNav;

  console.log('\n' + '='.repeat(68));
  console.log('  MERCHANT QUERY TIMING  (cold, one call each)');
  console.log('='.repeat(68) + '\n');
  console.log('  canonical shop resolve : ' + (shopOk ? shopMs + 'ms' : 'DID NOT RESOLVE in 60s'));
  if (!shopOk) { await b.close(); server.close(); process.exit(1); }

  const out = await pg.evaluate(async () => {
    const res = {};
    const uid = window.firebaseAuth.currentUser.uid;
    const shopId = (window.SokoniShell||{}).activeShopId;
    res.shopId = shopId;
    const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

    /* The exact query the Sell surface runs, timed cold and reported with its source. */
    let t = Date.now();
    try {
      const snap = await F.getDocs(F.query(
        F.collection(window.firebaseDB, 'products'),
        F.where('shopId', '==', String(shopId))));
      res.products_by_shopId = (Date.now()-t) + 'ms  n=' + snap.size + '  fromCache=' + snap.metadata.fromCache;
    } catch (e) { res.products_by_shopId = (Date.now()-t) + 'ms  ERR ' + (e.code||e.message); }

    /* The query Availability runs. */
    t = Date.now();
    try {
      const snap = await F.getDocs(F.query(
        F.collection(window.firebaseDB, 'products'),
        F.where('sellerUid', '==', String(uid)), F.limit(500)));
      res.products_by_sellerUid = (Date.now()-t) + 'ms  n=' + snap.size + '  fromCache=' + snap.metadata.fromCache;
    } catch (e) { res.products_by_sellerUid = (Date.now()-t) + 'ms  ERR ' + (e.code||e.message); }

    /* A single-document read, as a control: isolates per-request overhead
       (attestation, connection setup) from the cost of the query itself. */
    t = Date.now();
    try {
      const d = await F.getDoc(F.doc(window.firebaseDB, 'shops', String(shopId)));
      res.control_single_doc = (Date.now()-t) + 'ms  exists=' + d.exists() + '  fromCache=' + d.metadata.fromCache;
    } catch (e) { res.control_single_doc = (Date.now()-t) + 'ms  ERR ' + (e.code||e.message); }

    return res;
  });

  Object.keys(out).forEach((k) => console.log('  ' + k.padEnd(23) + ': ' + out[k]));
  console.log('\n  A single-doc control in the tens of ms alongside a multi-second query points');
  console.log('  at the QUERY (index / result size). Both slow points at per-request overhead');
  console.log('  on this origin. fromCache=true anywhere invalidates that reading entirely.\n');

  await b.close(); server.close(); process.exit(0);
});
