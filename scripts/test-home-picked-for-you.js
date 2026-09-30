/* test-home-picked-for-you.js — Home page: Picked For You, Edit Interests, New Arrivals and the
 * daily grids, all in sync with the catalogue. Real index.html + real modules in Chromium through
 * the page harness (Firebase SDK shimmed over the fake Firestore; no network, no production).
 *
 *   node scripts/test-home-picked-for-you.js
 *
 * Defects this pins (measured live 2026-09-30 before the fix):
 *   - Edit Interests did nothing for a returning visitor (renderPicker EMPTIES the container when
 *     interests exist) and referenced InspIQ before the lazy loader had executed it.
 *   - The SokoniRecs widget never rendered: its loader bailed at DOMContentLoaded because the module
 *     is lazy-loaded ("module not loaded — recommendations skipped" on every visit).
 *   - New Arrivals was built once and never re-rendered, applied no listing rule, and sorted
 *     Timestamp-shaped dates as NaN; Fastest Selling / Big Discounts / Today's Picks had no caller.
 *   - realtime.js attached a duplicate products listener that failed permission-denied every visit.
 *   - A product the catalogue no longer returned was preserved forever as "local-only".
 */
'use strict';
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(Path.join(ROOT, f), 'utf8');
const say = (s) => console.log(s);
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };

const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const { makePageHarness } = require('./lib/page-harness.js');

/* ── 1. source contract ─────────────────────────────────────────────────────────────────────── */
say('\n── source contract ──');
const html = read('index.html'), iq = read('inspiq.js'), lazy = read('sokoni-lazy.js'), sc = read('script.js'), rt = read('realtime.js'), sdb = read('sokoni-db.js'), recs = read('sokoni-recommendations.js');
ck('index.html: the Edit Interests button is the named control and no longer calls renderPicker inline', /id="inspiqEditBtn"[^>]*aria-controls="inspiqPicker"/.test(html) && !/onclick="[^"]*InspIQ\.renderPicker\(/.test(html));
ck('index.html: the button goes through sokoniToggleInterests, which loads InspIQ on demand', /sokoniToggleInterests\(this\)/.test(html) && /function sokoniToggleInterests/.test(html) && /SokoniLazy\.load\(\)/.test(html));
ck('index.html: the recommendations loader WAITS for the lazy module instead of bailing', /sokoniWhenLazyModule\('sokoni-recommendations\.js', 'SokoniRecs'/.test(html));
ck('index.html: six recommendations on the home page (owner 2026-09-30)', /SokoniRecs\.getForYou\(6\)/.test(html));
ck('index.html: the catalogue listener forwards meta to _homeMergeFirestore', /_homeMergeFirestore\(fsProducts, meta\)/.test(html));
ck('inspiq.js: toggleEditor exists, is exported, and picks editor-vs-picker by hasInterests()', /function toggleEditor\(/.test(iq) && /applyPickEdit, toggleEditor,/.test(iq) && /if \(hasInterests\(\)\) renderPickerEdit\(el\.id\); else renderPicker\(el\.id\);/.test(iq));
ck('inspiq.js: the home feed is capped at six', /const HOME_LIMIT\s*=\s*6;/.test(iq));
ck('inspiq.js: applying picks on the home page renders the home widget, not the infinite feed', /function _renderFeedForPage\(\)/.test(iq) && !/^\s*renderForYou\('inspiqFeed'\);\s*$/m.test(iq.slice(iq.indexOf('function applyPick()'), iq.indexOf('function trackClick'))));
ck('sokoni-lazy.js: readiness contract (whenLoaded / isLoaded / load) and per-script event', /window\.SokoniLazy = \{ load: run, whenLoaded: whenLoaded, isLoaded: isLoaded \}/.test(lazy) && /sokoni:lazy-loaded/.test(lazy) && /s\.onload = function \(\) \{ settle\(src, true\); \}/.test(lazy));
ck('script.js: one deferral for every home grid, re-rendered when already built', /function _deferHomeGrid\(/.test(sc) && /if\(st\.state === 'built'\)\{ _build\(\); return; \}/.test(sc));
ck('script.js: New Arrivals applies the canonical listing predicate and a shape-tolerant time', /products\.filter\(_listedForHome\)\s*\.sort\(\(a,b\) => _productTime\(b\) - _productTime\(a\)\)/.test(sc));
ck('script.js: boot and every snapshot render the SAME set of grids', (sc.match(/_renderHomeProductGrids\(\);/g) || []).length === 2 && /displayFastestSelling\(\);\s*displayBiggestDiscounts\(\);\s*displayTodaysPicks\(\);/.test(sc));
ck('script.js: daily sections use listed AND sellable, not the bare outOfStock flag', /function _sellableForHome\(p\)/.test(sc) && !/filter\(p => \(p\.sold \|\| 0\) > 0 && !p\.outOfStock\)/.test(sc) && !/filter\(p => !p\.outOfStock\)/.test(sc));
ck('script.js: _homeMergeFirestore obeys the delivery authority; only a fresh read may drop a row, and never the seller\'s own', /window\._homeMergeFirestore = function \(fsProducts, meta\)/.test(sc) && /&& \(!authoritative \|\| _mine\(p\)\)/.test(sc));
ck('sokoni-db.js sets the canonical-listener flag; realtime.js stands down when it is present', /window\.__sokoniCatalogueModule = true/.test(sdb) && /if \(window\.__sokoniCatalogueModule\) return;/.test(rt));
ck('sokoni-recommendations.js: bounded products query + sellability filter on product candidates', /orderBy\(documentId\(\), 'desc'\), limit\(_CAP\)/.test(recs) && /if \(spec\.type === 'product' && !_sellable\(d\)\) return;/.test(recs));

/* ── 2. browser ─────────────────────────────────────────────────────────────────────────────── */
(async () => {
  const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
  const T0 = 1790000000000;
  const P = (id, o) => Object.assign({ id, name: 'Product ' + id, price: 1000, category: 'electronics', sellerUid: 'seller1', sellerName: 'Seller One', image: '', stock: 10, sold: 0, uploadedAt: T0 + Number(id.replace(/\D/g, '')) * 1000, location: 'nairobi' }, o);
  const seed = [
    P('p1', { sold: 50 }),
    P('p2', { sold: 20, stock: 0 }),                                   /* depleted → shown marked, never "fastest"/recommended */
    P('p3', { sold: 5, status: 'archived' }),                           /* unlisted → nowhere on Home */
    P('p4', { sold: 9, uploadedAt: { _seconds: Math.floor((T0 + 9000) / 1000), _nanoseconds: 0 } }), /* Timestamp-shaped date */
    P('p5', { sold: 1 }), P('p6', { sold: 2 }), P('p7', { sold: 3, outOfStock: true }), P('p8', { sold: 4 }),
    P('p9', { sold: 0, uploadedAt: T0 + 8500 }), P('p10', { sold: 0 }),           /* unsold, sellable: picks material; p9 sits between p8 and p4 so no two dates tie */
  ];
  for (const p of seed) await db.doc('products/' + p.id).set(p);

  const H = makePageHarness({ db, root: ROOT });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const open = async (w, storage) => {
    const page = await H.page(browser, { viewport: { width: w || 390, height: 844 } });
    if (storage) await page.__ctx.addInitScript((st) => { Object.keys(st).forEach((k) => { try { localStorage.setItem(k, st[k]); } catch (_) {} }); }, storage);
    page.__console = [];
    page.on('console', (m) => page.__console.push(m.type() + ': ' + m.text()));
    await page.goto(H.BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Array.isArray(window.__sokoniHomeProducts ? window.__sokoniHomeProducts : null) || document.querySelectorAll('#productsContainer .product-card[data-pid]').length > 0, null, { timeout: 15000 }).catch(() => {});
    return page;
  };
  const waitLazy = async (page) => { await page.mouse.move(50, 50); await page.mouse.down(); await page.mouse.up(); await page.waitForFunction(() => window.InspIQ && window.SokoniRecs, null, { timeout: 15000 }); };
  const grids = (page) => page.evaluate(() => {
    const ids = (sel) => Array.from(document.querySelectorAll(sel + ' .product-card[data-pid]')).map((c) => c.getAttribute('data-pid')).filter(Boolean);
    const vis = (id) => { const s = document.getElementById(id); return s ? s.style.display !== 'none' : null; };
    const oos = (sel) => Array.from(document.querySelectorAll(sel + ' .product-card[data-pid]')).filter((c) => c.querySelector('.oos-overlay')).map((c) => c.getAttribute('data-pid'));
    return {
      trending: ids('#productsContainer'), newArrivals: ids('#newArrivalsGrid'), fastest: ids('#fastestSellingGrid'), picks: ids('#todaysPicksGrid'),
      vis: { na: vis('newArrivalsSection'), fs: vis('fastestSellingSection'), bd: vis('biggestDiscountsSection'), tp: vis('todaysPicksSection') },
      oosNew: oos('#newArrivalsGrid'), flag: window.__sokoniCatalogueModule === true,
    };
  });
  const scrollAll = async (page) => { await page.evaluate(() => ['newArrivalsSection', 'fastestSellingSection', 'biggestDiscountsSection', 'todaysPicksSection', 'inspiqSection'].forEach((id) => { const s = document.getElementById(id); if (s) { s.style.display = s.style.display; s.scrollIntoView(); } })); await page.waitForTimeout(700); await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(700); };

  let page;
  try {
    /* A. fresh visitor, 390px */
    say('\n── fresh visitor (no interests), 390px ──');
    page = await open(390);
    await page.waitForFunction(() => document.querySelectorAll('#productsContainer .product-card[data-pid]').length > 0, null, { timeout: 15000 }).catch(() => {});
    await scrollAll(page);
    await page.waitForFunction(() => document.querySelectorAll('#newArrivalsGrid .product-card[data-pid]').length > 0, null, { timeout: 12000 }).catch(() => {});
    let g = await grids(page);
    ck('the canonical catalogue module flag is set (realtime.js stands down)', g.flag);
    ck('Trending renders the seeded catalogue minus the archived product', g.trending.length === 9 && !g.trending.includes('p3') && !g.trending.some((id) => /^[FG]d/.test(id)), g.trending);
    ck('New Arrivals is built, excludes the archived product, includes the depleted one', g.vis.na === true && g.newArrivals.length === 9 && !g.newArrivals.includes('p3') && g.newArrivals.includes('p2'), g.newArrivals);
    ck('New Arrivals is newest-first and the Timestamp-shaped date (p4, the newest) sorts by its real time instead of NaN', g.newArrivals[0] === 'p10' && g.newArrivals[1] === 'p4' && g.newArrivals[2] === 'p9' && g.newArrivals[g.newArrivals.length - 1] === 'p1', g.newArrivals);
    ck('the depleted product is marked Out of Stock in New Arrivals', g.oosNew.includes('p2'), g.oosNew);
    ck('Fastest Selling is now rendered: sold>0 AND sellable — p2 (stock 0), p3 (archived), p7 (flagged) excluded, p1 first', g.vis.fs === true && g.fastest[0] === 'p1' && !g.fastest.includes('p2') && !g.fastest.includes('p3') && !g.fastest.includes('p7'), g.fastest);
    ck('Today\'s Picks rendered from sellable products only; Big Discounts hidden (no price history)', g.vis.tp === true && g.picks.length === 7 && !g.picks.includes('p2') && !g.picks.includes('p7') && g.vis.bd === false, { picks: g.picks, bd: g.vis.bd });
    ck('no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

    /* Edit Interests before the lazy loader has run: the tap loads InspIQ and opens the picker */
    /* By now the lazy loader has usually run (scrolling is an interaction) and InspIQ's init has
       rendered the onboarding picker OPEN for a fresh visitor, so the first press CLOSES it and
       the second re-opens it. If the module is not in yet, the press loads it and opens the picker. */
    const preLoaded = await page.evaluate(() => typeof window.InspIQ);
    const btn = page.locator('#inspiqEditBtn');
    await btn.scrollIntoViewIfNeeded();
    const wasOpen = await page.evaluate(() => !!window.InspIQ && document.getElementById('inspiqPicker').innerHTML.length > 0 && document.getElementById('inspiqPicker').style.display !== 'none');
    await btn.click({ timeout: 8000 });
    await page.waitForFunction(() => !!window.InspIQ, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    const t1 = await page.evaluate(() => ({ display: document.getElementById('inspiqPicker').style.display, exp: document.getElementById('inspiqEditBtn').getAttribute('aria-expanded') }));
    ck('the press toggles: an already-open onboarding picker closes, a closed one opens', wasOpen ? (t1.display === 'none' && t1.exp === 'false') : (t1.display !== 'none' && t1.exp === 'true'), Object.assign({ inspiqBefore: preLoaded, wasOpen }, t1));
    if (wasOpen) { await btn.click({ timeout: 8000 }); await page.waitForTimeout(300); }
    const fresh = await page.evaluate(() => ({ picks: document.querySelectorAll('#inspiqPicker .iq-pick-btn').length, text: document.getElementById('inspiqPicker').innerText.slice(0, 40), exp: document.getElementById('inspiqEditBtn').getAttribute('aria-expanded'), display: document.getElementById('inspiqPicker').style.display }));
    ck('a fresh visitor gets the onboarding picker (a tap loads InspIQ on demand if needed)', fresh.picks > 5 && /Pick what you love/.test(fresh.text) && fresh.display !== 'none' && fresh.exp === 'true', Object.assign({ inspiqBefore: preLoaded }, fresh));
    /* pick two and show the feed → home widget, six cards max */
    await page.evaluate(() => { document.querySelector('#inspiqPicker .iq-pick-btn[data-cat="fashion"]').click(); document.querySelector('#inspiqPicker .iq-pick-btn[data-cat="electronics"]').click(); });
    await page.evaluate(() => InspIQ.applyPick());
    await page.waitForTimeout(400);
    const afterPick = await page.evaluate(() => ({ has: InspIQ.hasInterests(), feed: document.querySelectorAll('#inspiqFeed .inspiq-card').length, pickerHidden: document.getElementById('inspiqPicker').style.display === 'none', exp: document.getElementById('inspiqEditBtn').getAttribute('aria-expanded') }));
    ck('applying picks saves interests, hides the picker and renders the HOME widget with at most six cards', afterPick.has && afterPick.feed > 0 && afterPick.feed <= 6 && afterPick.pickerHidden && afterPick.exp === 'false', afterPick);

    /* the recommendations widget renders once the lazy module is in */
    await page.waitForFunction(() => document.querySelector('#sk-recs-foryou .sk-recs-widget'), null, { timeout: 15000 }).catch(() => {});
    const recsState = await page.evaluate(() => ({ widget: !!document.querySelector('#sk-recs-foryou .sk-recs-widget'), cards: document.querySelectorAll('#sk-recs-foryou .sk-recs-grid > *').length, warned: false }));
    const bailed = page.__console.some((l) => /module not loaded — recommendations skipped/.test(l));
    ck('Picked For You (SokoniRecs) renders after the lazy load — the DOMContentLoaded bail-out is gone', recsState.widget && !bailed, Object.assign(recsState, { bailed }));
    ck('the recommendations widget shows at most six items', recsState.cards <= 6, recsState.cards);
    const rtErr = page.__console.filter((l) => /\[RT\] products/.test(l));
    ck('no duplicate realtime products listener ran on Home', rtErr.length === 0, rtErr);
    await page.__ctx.close();

    /* B. returning visitor with interests, 1280px */
    say('\n── returning visitor (saved interests), 1280px ──');
    page = await open(1280, { sokoniInspIQ: JSON.stringify({ scores: { fashion: 10, electronics: 6 } }) });
    await waitLazy(page);
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => ({ pickerLen: document.getElementById('inspiqPicker').innerHTML.length, feed: document.querySelectorAll('#inspiqFeed .inspiq-card').length }));
    ck('on load the home feed shows the interest widget (≤6 cards) and no picker', before.feed > 0 && before.feed <= 6 && before.pickerLen === 0, before);
    await page.locator('#inspiqEditBtn').scrollIntoViewIfNeeded();
    await page.locator('#inspiqEditBtn').click({ timeout: 8000 });
    await page.waitForTimeout(300);
    const edit = await page.evaluate(() => ({ text: document.getElementById('inspiqPicker').innerText.slice(0, 40), active: Array.from(document.querySelectorAll('#inspiqPicker .iq-pick-btn')).filter((b) => /scale/.test(b.style.transform)).map((b) => b.dataset.cat), exp: document.getElementById('inspiqEditBtn').getAttribute('aria-expanded'), display: document.getElementById('inspiqPicker').style.display }));
    ck('Edit Interests OPENS THE EDITOR for a returning visitor, pre-selected with their interests (the live defect)', /Edit Your Interests/.test(edit.text) && edit.active.sort().join() === 'electronics,fashion' && edit.exp === 'true' && edit.display !== 'none', edit);
    await page.locator('#inspiqEditBtn').click({ timeout: 8000 });
    await page.waitForTimeout(200);
    const closed = await page.evaluate(() => ({ display: document.getElementById('inspiqPicker').style.display, exp: document.getElementById('inspiqEditBtn').getAttribute('aria-expanded') }));
    ck('pressing it again closes the editor', closed.display === 'none' && closed.exp === 'false', closed);
    await page.locator('#inspiqEditBtn').click({ timeout: 8000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => { document.querySelector('#inspiqPicker .iq-pick-btn[data-cat="electronics"]').click(); /* deselect */ InspIQ.applyPickEdit(); });
    await page.waitForTimeout(300);
    const updated = await page.evaluate(() => ({ top: InspIQ.getTopCategories(5).filter((c) => c.score > 0).map((c) => c.key), feed: document.querySelectorAll('#inspiqFeed .inspiq-card').length, hidden: document.getElementById('inspiqPicker').style.display === 'none' }));
    ck('Update My Feed rewrites the interests and re-renders the home widget (≤6)', updated.top.join() === 'fashion' && updated.feed > 0 && updated.feed <= 6 && updated.hidden, updated);

    /* C. live inventory sync — the same delivery contract the listener uses */
    say('\n── live inventory sync ──');
    await scrollAll(page);
    await page.waitForFunction(() => document.querySelectorAll('#newArrivalsGrid .product-card[data-pid]').length > 0, null, { timeout: 12000 }).catch(() => {});
    const fresh2 = seed.filter((p) => p.id !== 'p8').map((p) => p.id === 'p1' ? Object.assign({}, p, { stock: 0 }) : p);   /* p8 deleted by its seller; p1 sold out */
    await page.evaluate((rows) => window._homeMergeFirestore(rows, { source: 'firestore', authority: 'fresh', authoritative: true }), fresh2);
    await page.waitForTimeout(400);
    g = await grids(page);
    ck('a FRESH delivery removes the deleted product from every grid', !g.trending.includes('p8') && !g.newArrivals.includes('p8') && !g.fastest.includes('p8') && !g.picks.includes('p8'), { t: g.trending, na: g.newArrivals, fs: g.fastest });
    ck('the product that sold out is re-rendered as Out of Stock in New Arrivals and leaves Fastest Selling', g.oosNew.includes('p1') && !g.fastest.includes('p1') && g.newArrivals.includes('p1'), { oos: g.oosNew, fs: g.fastest });
    const unconfirmed = fresh2.filter((p) => p.id !== 'p6');
    await page.evaluate((rows) => window._homeMergeFirestore(rows, { source: 'firestore', authority: 'unconfirmed', authoritative: false }), unconfirmed);
    await page.waitForTimeout(400);
    g = await grids(page);
    ck('an UNCONFIRMED delivery that omits a product does NOT remove it', g.trending.includes('p6') && g.newArrivals.includes('p6'), g.newArrivals);
    /* index.html has no #recommendedContainer today, so the stable-selection rule is proven on
       Today's Picks: two identical fresh deliveries must render the identical order. */
    const picks1 = g.picks.slice();
    await page.evaluate((rows) => window._homeMergeFirestore(rows, { authority: 'fresh', authoritative: true }), fresh2);
    await page.waitForTimeout(300);
    const picks2 = (await grids(page)).picks;
    ck('Today\'s Picks is stable across identical snapshots (deterministic order, no reshuffle)', picks1.length > 0 && picks1.join() === picks2.join(), { a: picks1, b: picks2 });
    ck('no page errors', page.__errors.length === 0, page.__errors.slice(0, 3));
    await page.__ctx.close();
  } catch (e) {
    ck('suite ran to completion', false, e && e.stack ? e.stack.slice(0, 400) : String(e));
    if (page) { try { say('  console tail: ' + JSON.stringify((page.__console || []).slice(-6))); await page.__ctx.close(); } catch (_) {} }
  } finally {
    await browser.close(); H.stop();
  }
  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
