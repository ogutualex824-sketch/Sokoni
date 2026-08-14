/* KASS SHOP catalogue — SmartPOS verification.

   Seeds the catalogue into PosInventory (IndexedDB, real browser) and exercises
   the till workflow the sprint asks for: category filtering, search, barcode
   lookup, stock levels, low-stock detection and cart maths.

   This is the half of the sprint that does NOT need admin credentials —
   PosInventory is client-side, so the till can be exercised before the merchant
   exists in Firestore. */
'use strict';
const { webkit } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const T = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join('.', p), (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' }); r.end(d);
  });
});

let pass = 0, fail = 0;
/* Shorter than this suite's runner budget (150000ms) ON PURPOSE. Without one, a hang is
   SIGKILLed by the runner and recorded as TIMEOUT -- not a defect verdict -- so the suite leaves
   the blocking set silently. Measured cost of this suite is far below the value chosen, so this
   fires only when the runner was going to kill it anyway. */
const _wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 135s'); process.exit(1); }, 135000);
/* unref: the watchdog must never be the reason the process stays alive. A suite that
   finishes normally exits immediately; one that is genuinely stuck still has a live event
   loop, so the timer still fires and self-reports instead of being SIGKILLed silently. */
if (_wd && _wd.unref) _wd.unref();
const ck = (l, ok, d) => { console.log('  ' + (ok?'PASS  ':'FAIL  ') + l + (d?'   ['+d+']':'')); ok?pass++:fail++; };

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const page = await (await br.newContext()).newPage();
  /* A real origin is required: IndexedDB is blocked on about:blank, which is
     what setContent() produces. */
  await page.goto(B + '/offline.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.addScriptTag({ url: B + '/pos-inventory.js' });
  await page.addScriptTag({ url: B + '/kass-catalog.js' });
  await page.waitForTimeout(800);

  const out = await page.evaluate(async () => {
    const K = window.KassCatalog, I = window.PosInventory;
    if (!K || !I) return { err: 'modules missing' };

    const seed  = await K.seedPos({ branchId: 'kass-main' });
    const again = await K.seedPos({ branchId: 'kass-main' });   /* idempotency */

    const all    = await I.getAllProducts();
    const cats   = await I.getCategories();
    const juice  = await I.byCategory('Vape Juice');
    const coils  = await I.byCategory('coils');            /* by ID */
    const search = await I.search('elf', 20);
    const byBar  = await I.getProductByBarcode('6009880021147');
    const recent = await I.recent(5);

    /* Stock + low-stock, read through the engine rather than the catalogue. */
    const xros = all.find(p => p.sku === 'VAP-XR3-BLK');
    const xrosStock = xros ? (await I.getStock(xros.id, 'kass-main')).qty : -1;
    const low = await I.getLowStockItems('kass-main').catch(() => []);

    /* Cart maths on real prices: 2 disposables + 1 juice, 16% VAT inclusive. */
    const elf   = all.find(p => p.sku === 'ELF-BC5-BRI');
    const nasty = all.find(p => p.sku === 'NST-CSH-M03');
    const gross = (elf.price * 2) + nasty.price;
    const vat   = Math.round((gross - gross / 1.16) * 100) / 100;

    /* Sale deducts stock. */
    let afterSale = -1;
    if (typeof I.deductSaleItems === 'function' && elf) {
      await I.deductSaleItems([{ productId: elf.id, qty: 2 }], 'kass-main').catch(() => {});
      afterSale = (await I.getStock(elf.id, 'kass-main')).qty;
    }

    return {
      seed, again,
      total: all.length, cats: cats.length,
      juiceCount: juice.length, coilCount: coils.length,
      searchCount: search.length, searchNames: search.map(p => p.brand),
      barcodeHit: byBar && byBar.name, recentCount: recent.length,
      xrosStock, lowCount: (low || []).length,
      gross, vat, elfPrice: elf.price, elfStockAfter: afterSale,
      stats: K.stats(),
    };
  });

  if (out.err) ck('modules load', false, out.err);
  else {
    console.log('\n── Seeding ──');
    ck('catalogue seeded', out.seed.added === out.seed.total, out.seed.added + '/' + out.seed.total);
    ck('categories created', out.cats >= 5, String(out.cats));
    ck('re-running seeds nothing (idempotent by SKU)', out.again.added === 0 && out.again.skipped === out.seed.total,
       'added ' + out.again.added + ', skipped ' + out.again.skipped);

    console.log('\n── Category filtering (the till chips) ──');
    ck('filter by NAME "Vape Juice"', out.juiceCount === 5, String(out.juiceCount));
    ck('filter by ID "coils"',        out.coilCount === 3, String(out.coilCount));

    console.log('\n── Search ──');
    ck('search "elf" finds Elf Bar products', out.searchCount >= 3, String(out.searchCount));
    ck('matches on brand as well as name', out.searchNames.includes('Elf Bar'));

    console.log('\n── Barcode lookup ──');
    ck('EAN-13 barcode resolves a product', !!out.barcodeHit, out.barcodeHit || 'no hit');
    ck('resolves the CORRECT product', /XROS 3/.test(out.barcodeHit || ''), out.barcodeHit);

    console.log('\n── Stock ──');
    ck('opening stock applied', out.xrosStock === 18, String(out.xrosStock));
    ck('low-stock items detected', out.lowCount > 0, out.lowCount + ' below threshold');
    ck('sale deducts stock (40 - 2)', out.elfStockAfter === 38, String(out.elfStockAfter));

    console.log('\n── Cart maths ──');
    ck('2x1800 + 1500 = 5100', out.gross === 5100, String(out.gross));
    ck('16% inclusive VAT computed', Math.abs(out.vat - 703.45) < 0.5, String(out.vat));

    console.log('\n── Catalogue shape ──');
    ck('20+ products for realistic testing', out.stats.products >= 20, String(out.stats.products));
    ck('includes a deliberately low-stock line', out.stats.lowStock >= 1, String(out.stats.lowStock));
    console.log('    stock value KES ' + out.stats.stockValue.toLocaleString() +
                ' · retail KES ' + out.stats.retailValue.toLocaleString());
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
     Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
     at their budget because close() never returned, so a finished result was recorded
     as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
  await Promise.race([
    (async () => { try { await br.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  /* A close that lost the race above is still RUNNING. Abandoning it leaks the browser:
     measured at 32 orphaned WebKit processes after one gate, which starves the renderers
     of later suites and crashes them. Kill what did not close. */
  try { const _p = br.process && br.process(); if (_p) _p.kill('SIGKILL'); } catch (_) {}
  try { srv.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
