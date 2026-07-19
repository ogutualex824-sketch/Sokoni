/* SmartPOS till adapters — functional test.

   pos-checkout.html calls PosInventory.byCategory/recent/search. None existed, so
   the product grid at the counter never loaded. This exercises them through the
   real engine (IndexedDB in a real browser) using the EXACT call signatures the
   till uses, including search(q, 20) with a numeric second argument. */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = '.';
const T = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' });
    res.end(d);
  });
});

let pass = 0, fail = 0;
const check = (l, ok, d) => { console.log('  ' + (ok?'PASS  ':'FAIL  ') + l + (d?'   ['+d+']':'')); ok?pass++:fail++; };

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await webkit.launch();
  const page = await (await browser.newContext()).newPage();

  await page.goto(BASE + '/pos-printer-setup.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
  await page.addScriptTag({ url: '/pos-inventory.js' }).catch(async () => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/pos-inventory.js' });
  });
  await page.waitForTimeout(1500);

  const out = await page.evaluate(async () => {
    const I = window.PosInventory;
    if (!I) return { err: 'PosInventory missing' };

    const api = ['byCategory', 'recent', 'search'].filter(k => typeof I[k] === 'function');

    /* Seed: two categories, products in each, plus one archived. */
    const drinks = await I.addCategory({ name: 'Drinks' });
    const snacks = await I.addCategory({ name: 'Snacks' });
    /* updateProduct stamps updatedAt: Date.now() LAST in its merge
       (pos-inventory.js:183), so a backdated value cannot be injected. Order is
       therefore established by touching a product, which is also exactly how
       recency arises in real use. */
    const mk = (name, category) => I.addProduct({ name, category, price: 100 });
    const cola = await mk('Cola 500ml', 'Drinks');
    await mk('Water 1L', 'Drinks');
    await mk('Crisps',   'Snacks');
    await new Promise(r => setTimeout(r, 30));
    await I.updateProduct(cola.id, { price: 120 });   /* now the most recent */
    const arch = await I.addProduct({ name: 'Old Stock', category: 'Snacks', price: 10 });
    await I.updateProduct(arch.id, { status: 'archived' });

    /* Exactly how the till calls them (pos-checkout.html). */
    const byName   = await I.byCategory('Drinks');
    const byId     = await I.byCategory(drinks.id);
    const rec      = await I.recent(48);
    const srch     = await I.search('cola', 20);      /* NUMERIC 2nd arg */
    const srchOpts = await I.search('cola', { limit: 5 });
    const empty    = await I.byCategory(null);
    const none     = await I.byCategory('does-not-exist');

    return {
      api,
      byNameCount: byName.length,
      byIdCount:   byId.length,
      byIdNames:   byId.map(p => p.name).sort(),
      recentFirst: rec[0] && rec[0].name,
      recentExcludesArchived: !rec.some(p => p.status === 'archived'),
      recentLimited: (await I.recent(2)).length,
      searchCount: srch.length,
      searchName:  srch[0] && srch[0].name,
      searchRespectsLimit: (await I.search('', 2)).length,
      searchOptsWorks: srchOpts.length,
      emptyFallsBackToRecent: Array.isArray(empty) && empty.length > 0,
      unknownCategory: none.length,
      drinksId: drinks.id, snacksId: snacks.id,
    };
  });

  if (out.err) { check('engine loads', false, out.err); }
  else {
    console.log('\n── The three missing methods now exist ──');
    check('byCategory, recent, search all exported', out.api.length === 3, out.api.join(','));

    console.log('\n── byCategory: id AND name both work ──');
    check('by category NAME returns its products', out.byNameCount === 2, String(out.byNameCount));
    check('by category ID returns the same products', out.byIdCount === 2, String(out.byIdCount));
    check('correct products returned', JSON.stringify(out.byIdNames) === JSON.stringify(['Cola 500ml','Water 1L']),
          out.byIdNames.join(','));
    check('unknown category returns empty, does not throw', out.unknownCategory === 0);
    check('no category falls back to recent', out.emptyFallsBackToRecent === true);

    console.log('\n── recent ──');
    check('most recently updated first', out.recentFirst === 'Cola 500ml', out.recentFirst);
    check('archived products excluded', out.recentExcludesArchived === true);
    check('limit respected', out.recentLimited === 2, String(out.recentLimited));

    console.log('\n── search: the till passes a NUMBER as 2nd arg ──');
    check('search(q, 20) finds the product', out.searchCount === 1, String(out.searchCount));
    check('correct match', out.searchName === 'Cola 500ml', out.searchName);
    check('numeric limit is honoured', out.searchRespectsLimit === 2, String(out.searchRespectsLimit));
    check('options form still works', out.searchOptsWorks === 1, String(out.searchOptsWorks));
  }

  await browser.close(); server.close();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
