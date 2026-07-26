/* Seller product hydration.

   The properties that matter here are the destructive ones. This module
   rewrites the cache that the entire merchant dashboard renders from, so the
   tests are weighted toward what must NEVER happen: losing an unsynced product,
   duplicating a product, or replacing a working image with a truncated one. */
'use strict';
const { webkit, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const T = { '.html': 'text/html', '.js': 'application/javascript' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/offline.html';
  fs.readFile(path.join('.', p), (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' }); r.end(d);
  });
});

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const page = await (await br.newContext({ ...devices['iPhone 13'] })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(B + '/offline.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.addScriptTag({ url: B + '/sokoni-seller-products.js' });
  await page.waitForTimeout(250);

  const out = await page.evaluate(async () => {
    const M = window.SokoniSellerProducts;
    if (!M) return { err: 'module missing' };
    const r = {};

    const BIG = 'data:image/jpeg;base64,' + 'A'.repeat(250000);   /* truncated shape */
    const OK  = 'data:image/jpeg;base64,' + 'A'.repeat(5000);

    /* image classification */
    r.imgHttp      = M._usableImage('https://cdn/x.jpg');
    r.imgTruncated = M._usableImage(BIG);
    r.imgSmallData = M._usableImage(OK);
    r.imgGarbage   = M._usableImage('not-an-image');
    r.imgNull      = M._usableImage(null);

    /* canonical wins on scalar fields */
    let m = M.merge(
      [{ id: 'p1', title: 'Canonical', price: 100, sellerName: 'KASS SHOP' }],
      [{ id: 'p1', title: 'Stale',     price: 50,  sellerName: '+254705726803' }]);
    r.canonWins     = m.merged[0].title === 'Canonical' && m.merged[0].price === 100;
    r.staleNameGone = m.merged[0].sellerName === 'KASS SHOP';
    r.noDupe        = m.merged.length === 1;

    /* an unsynced local-only product must survive and be flagged */
    m = M.merge(
      [{ id: 'p1', title: 'A' }],
      [{ id: 'p1', title: 'A' }, { id: 'p2', title: 'Offline create' }]);
    r.localOnlyKept   = m.merged.length === 2 && !!m.merged.find(p => p.id === 'p2');
    r.localOnlyFlagged = !!(m.merged.find(p => p.id === 'p2') || {})._pendingSync;
    r.localOnlyCounted = m.stats.localOnly === 1;

    /* a truncated canonical image must not replace a good cached one */
    m = M.merge(
      [{ id: 'p1', title: 'A', image: BIG, images: [BIG] }],
      [{ id: 'p1', title: 'A', image: OK,  images: [OK] }]);
    r.imagePreserved = m.merged[0].image === OK;
    r.imageCounted   = m.stats.imagesPreserved === 1;

    /* a good canonical image must win normally */
    m = M.merge(
      [{ id: 'p1', image: 'https://cdn/new.jpg' }],
      [{ id: 'p1', image: OK }]);
    r.goodCanonImageWins = m.merged[0].image === 'https://cdn/new.jpg';

    /* canonical is never dropped just because the cache is empty */
    m = M.merge([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], []);
    r.emptyCacheKeepsAll = m.merged.length === 3;

    /* ── hydrate() against a fake Firestore ── */
    const fakeFs = (docsByField) => ({
      collection: (_db, name) => ({ __c: name }),
      query: (c, w) => ({ __c: c.__c, __w: w }),
      where: (field, op, val) => ({ field, op, val }),
      getDocs: async (q) => {
        const rows = docsByField[q.__w.field] || [];
        return {
          forEach: (cb) => rows.forEach(d => cb({ id: d.id, data: () => d })),
          size: rows.length,
        };
      },
    });

    localStorage.setItem('sellerProducts', JSON.stringify([]));
    let res = await M.hydrate({
      uid: 'U1', db: {}, repaint: false,
      fs: fakeFs({ sellerUid: [{ id: 'v1', title: 'Vape 1' }, { id: 'v2', title: 'Vape 2' }],
                   uid: [{ id: 'v3', title: 'Vape 3' }] }),
    });
    r.hydOk    = res.ok === true;
    r.hydUnion = res.canonical === 3;   /* sellerUid + legacy uid, deduped */
    r.hydCache = JSON.parse(localStorage.getItem('sellerProducts')).length === 3;

    /* the same product under BOTH fields is one product */
    localStorage.setItem('sellerProducts', JSON.stringify([]));
    res = await M.hydrate({
      uid: 'U1', db: {}, repaint: false,
      fs: fakeFs({ sellerUid: [{ id: 'v1', title: 'Vape 1' }],
                   uid:       [{ id: 'v1', title: 'Vape 1' }] }),
    });
    r.hydDedupe = res.canonical === 1;

    /* THE DESTRUCTIVE CASE: empty Firestore + non-empty cache must not wipe */
    localStorage.setItem('sellerProducts', JSON.stringify([{ id: 'x1', title: 'Unsynced' }]));
    res = await M.hydrate({
      uid: 'U1', db: {}, repaint: false,
      fs: fakeFs({ sellerUid: [], uid: [] }),
    });
    r.refusedWipe    = res.ok === false;
    r.cacheIntact    = JSON.parse(localStorage.getItem('sellerProducts')).length === 1;
    r.refusalReason  = res.reason || '';

    /* a denied query must not touch the cache either */
    localStorage.setItem('sellerProducts', JSON.stringify([{ id: 'x1' }]));
    res = await M.hydrate({
      uid: 'U1', db: {}, repaint: false,
      fs: { collection: () => ({}), query: () => ({}), where: () => ({}),
            getDocs: async () => { const e = new Error('Missing or insufficient permissions.');
                                   e.code = 'permission-denied'; throw e; } },
    });
    r.deniedOk     = res.ok === false && res.reason === 'query';
    r.deniedIntact = JSON.parse(localStorage.getItem('sellerProducts')).length === 1;

    /* no uid / no db must be inert */
    res = await M.hydrate({ db: {}, repaint: false, fs: fakeFs({}) });
    r.noUid = res.ok === false && res.reason === 'no-uid';

    return r;
  });

  if (out.err) { ck('module loads', false, out.err); }
  else {
    console.log('\n── Image classification ──');
    ck('storage URL is usable',            out.imgHttp === true);
    ck('truncated base64 is NOT usable',   out.imgTruncated === false);
    ck('normal base64 is usable',          out.imgSmallData === true);
    ck('garbage string is NOT usable',     out.imgGarbage === false);
    ck('null is NOT usable',               out.imgNull === false);

    console.log('\n── Canonical Firestore wins ──');
    ck('canonical fields override cache',  out.canonWins === true);
    ck('stale sellerName is replaced',     out.staleNameGone === true);
    ck('no duplicate produced',            out.noDupe === true);
    ck('good canonical image wins',        out.goodCanonImageWins === true);
    ck('empty cache keeps all canonical',  out.emptyCacheKeepsAll === true);

    console.log('\n── Unsynced work is never destroyed ──');
    ck('local-only product survives',      out.localOnlyKept === true);
    ck('flagged _pendingSync',             out.localOnlyFlagged === true);
    ck('counted in stats',                 out.localOnlyCounted === true);

    console.log('\n── Truncated images do not overwrite good ones ──');
    ck('cached image preserved',           out.imagePreserved === true);
    ck('preservation counted',             out.imageCounted === true);

    console.log('\n── hydrate() ──');
    ck('succeeds',                         out.hydOk === true);
    ck('unions sellerUid + legacy uid',    out.hydUnion === true, 'got ' + out.hydUnion);
    ck('writes the cache',                 out.hydCache === true);
    ck('same doc under both fields = one', out.hydDedupe === true);

    console.log('\n── Fails safe ──');
    ck('refuses to wipe cache on empty result', out.refusedWipe === true, out.refusalReason);
    ck('cache left intact',                     out.cacheIntact === true);
    ck('permission-denied does not wipe',       out.deniedOk === true);
    ck('cache intact after denial',             out.deniedIntact === true);
    ck('inert without a uid',                   out.noUid === true);
  }

  ck('no page errors', errs.length === 0, errs[0] || '');

  await br.close(); srv.close();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
