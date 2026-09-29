/* test-marketing-offers-browser.js — universal catalogue U7c1 (2026-09-29): Offers live inside Marketing, on the ONE
 * merchant offer store, with a real wizard per offer type.
 *
 * Owner (2026-09-29): "fix offer page … it is saying not saved, SOKONI has no merchant writable offer store … all offer
 * types with their own wizards … calendar … drafts … if you open you can't go back … remove flash sale from the side
 * bar … connected to inventory so you can take soda and add pizza for a pizza offer, choose how many".
 *
 * REAL sokoni-merchant-marketing.js + sokoni-merchant-offers.js + sokoni-promotion-model.js in Chromium. The ctx
 * mimics the shell's _offersCtx: listOffers/saveOffer (recording each payload, idempotent on draftToken the way
 * shopOfferUpsert is) and listListings (the shop's catalogue). EVERY payload the browser saved is then replayed through
 * the REAL server normaliseOffer + resolve (functions/shop-offers.js) in Node.
 *
 * PROVES
 *   MB1 Marketing opens on Offers, the first of its tabs (Offers · Campaigns · Promotions · Ads); the studio is backed
 *       by the store — no "no offer store" message
 *   MB2 every one of the 12 offer types opens its OWN wizard: a flash sale has products, a sale price, start/end and a
 *       sales limit and NO buy-X-get-Y or item controls; a meal deal has items and a price and no percentage; BXGY has
 *       its quantities and a product picker and no package price; each has its own name example
 *   MB3 a flash sale on a catalogue product (Laptop KES 75,000 → sale price 68,000) publishes percentage + that product
 *       + the end time + the limit; the preview shows the real discount
 *   MB4 typed values survive every re-render (a day chip, the calendar)
 *   MB5 a meal deal is built from the catalogue (Pizza × 1, Soda × 2 via the steppers), saved as a DRAFT without
 *       publishing, listed under Drafts, and CONTINUED with its items intact, then published from the list
 *   MB6 Back works: the on-screen Back and the browser/phone Back both return to the list without leaving Marketing;
 *       a changed, unsaved offer is kept as a draft when the merchant says so
 *   MB7 switching type in the rail keeps the name and products and sends none of the old type's fields
 *   MB8 Publish with required fields missing says what is missing and saves nothing; End offer archives it
 *   MB9 server replay: every saved payload passes the REAL normaliseOffer; the stored flash sale prices the laptop at
 *       KES 68,000 through the REAL resolver, and not after its end time; a meal deal gives Pizza + 2 Soda for 850
 *   MB10 no horizontal overflow at 390 px; no page errors
 */
'use strict';
const Path = require('path'), http = require('http'), fs = require('fs'), Module = require('module');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
const MODULES = ['sokoni-promotion-model.js', 'sokoni-package-stock.js', 'sokoni-merchant-campaigns.js', 'sokoni-merchant-offers.js', 'sokoni-merchant-marketing.js'];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/sokoni-merchant-offers.css">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}#host{height:100vh;overflow:auto}</style></head>
<body><div id="host"></div>
${MODULES.map((m) => `<script src="/${m}"></script>`).join('\n')}
<script>
  var SCOPE = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
  window.__store = {}; window.__saves = [];
  var CATALOGUE = [
    { id: 'laptop', name: 'Laptop', price: 75000, stock: 4, status: 'active', shopId: 'shopA' },
    { id: 'pizza', name: 'Pizza', price: 800, stock: 10, status: 'active', shopId: 'shopA' },
    { id: 'soda', name: 'Soda', price: 100, stock: 5, status: 'active', shopId: 'shopA' },
    { id: 'svc', name: 'Car Wash', price: 500, status: 'active', shopId: 'shopA' },
    { id: 'gone', name: 'Old Item', price: 50, status: 'archived', shopId: 'shopA' },
  ];
  function offersCtx() {
    return {
      scope: SCOPE, shopName: 'Duka A', onToast: function (m) { window.__toast = m; },
      listOffers: async function () { return Object.values(window.__store).map(function (o) { return JSON.parse(JSON.stringify(o)); }); },
      saveOffer: async function (offer, o) {
        window.__saves.push({ offer: JSON.parse(JSON.stringify(offer)), draftToken: o && o.draftToken, offerId: o && o.offerId });
        var id = (o && o.offerId) || ('off_' + (o && o.draftToken));
        window.__store[id] = Object.assign({}, window.__store[id] || {}, offer, { id: id, shopId: 'shopA' });
        return { ok: true, id: id };
      },
      listListings: async function () { return CATALOGUE.map(function (p) { return Object.assign({}, p); }); },
    };
  }
  window.__mk = SokoniMerchantMarketing.mount(document.getElementById('host'), {
    scope: SCOPE, shopName: 'Duka A', origin: location.origin, offers: offersCtx,
    callList: async function () { return { data: { campaigns: [] } }; },
    callPromos: async function () { return { data: { promotions: [] } }; },
    onToast: function (m) { window.__toast = m; },
  });
</script></body></html>`;
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/mk.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
      const f = Path.join(ROOT, u.replace(/^\/+/, ''));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(''); }
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'application/javascript' }); res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
/* the REAL server offer module, with its Firebase imports stubbed */
function loadServerOffers() {
  class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
    if (id === 'firebase-admin') return { apps: [{}], initializeApp() {}, firestore: Object.assign(() => ({}), { FieldValue: {} }) };
    if (id === './shop-employees') return { resolveShopAccess: async () => ({}), capabilitiesForRole: () => [] };
    return orig.apply(this, arguments);
  };
  try { return require(Path.join(ROOT, 'functions', 'shop-offers.js')); } catch (e) { return { __err: e.message }; } finally { Module.prototype.require = orig; }
}

(async () => {
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 8000 };
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 200)); return false; } };
  const errors = [];
  let saves = [];
  try {
    const P = await browser.newPage({ viewport: { width: 390, height: 900 } });
    P.on('pageerror', (e) => errors.push(e.message));
    P.on('dialog', (d) => d.accept());
    await P.goto(BASE + '/mk.html#marketing');
    /* FAIL CLOSED: with no Offers studio inside Marketing every check is a FAIL, never a crash */
    const mounted = await P.waitForSelector('.mo-wrap', { timeout: 15000 }).then(() => true, () => false);
    if (!mounted) {
      ['MB1', 'MB2', 'MB3', 'MB4', 'MB5', 'MB6', 'MB7', 'MB8', 'MB10'].forEach((n) => ck(n + ' — the Offers studio never mounted inside Marketing', false));
      throw Object.assign(new Error('not mounted'), { notMounted: true });
    }

    /* MB1 */
    const tabs = await P.$$eval('.mmk-tab', (b) => b.map((x) => x.textContent.trim().split(' ')[0]));
    const onTab = await P.$eval('.mmk-tab.on', (b) => b.textContent.trim()).catch(() => '');
    const noStore = await P.evaluate(() => /No offer store connected/.test(document.body.innerText));
    ck('MB1 Marketing opens on Offers, first of Offers · Campaigns · Promotions · Ads, backed by the store', tabs[0] === 'Offers' && onTab === 'Offers'
      && ['Campaigns', 'Promotions', 'Ads'].every((t) => tabs.includes(t)) && !noStore, { tabs, onTab, noStore });

    /* MB2 — every template's own wizard */
    const types = await P.$$eval('.mo-rail-card', (b) => b.map((x) => x.getAttribute('data-k')));
    const W = {};
    for (const k of types) {
      await P.goto(BASE + '/mk.html#marketing'); await P.waitForSelector('.mo-rail-card', T);
      await P.click(`.mo-rail-card[data-k="${k}"]`, T); await P.waitForSelector('.mo-edit', T);
      W[k] = await P.evaluate(() => ({
        keys: [...document.querySelectorAll('.mo-edit .mo-in[data-k]')].map((e) => e.getAttribute('data-k')),
        picks: [...document.querySelectorAll('[data-act="pick"]')].map((e) => e.getAttribute('data-mode')),
        days: !!document.querySelector('[data-act="day"]'), ph: (document.querySelector('[data-k="name"]') || {}).placeholder,
        h: (document.querySelector('.mo-h1') || {}).textContent }));
    }
    const f = W.flashSale || {}, m = W.mealDeal || {}, b = W.bxgy || {};
    const phs = Object.values(W).map((w) => w.ph);
    ck('MB2 12 types, each its OWN wizard: flash = products + sale price + start/end + limit (no BXGY/items); meal = items + price (no %); BXGY = quantities + products (no package price)',
      types.length === 12
      && f.keys.includes('percent') && f.keys.includes('startsAt') && f.keys.includes('endsAt') && f.keys.includes('inventoryLimit') && f.picks.includes('products')
      && !f.keys.includes('buyQty') && !f.keys.includes('bundlePrice') && !f.picks.includes('items') && !f.days
      && m.keys.includes('bundlePrice') && m.picks.includes('items') && !m.keys.includes('percent') && !m.keys.includes('buyQty')
      && b.keys.includes('buyQty') && b.keys.includes('getQty') && b.picks.includes('products') && !b.keys.includes('bundlePrice')
      && new Set(phs).size === phs.length,
      { types: types.length, flash: f, meal: m, bxgy: b, distinctNames: new Set(phs).size });

    /* MB3 — flash sale on the laptop */
    await P.goto(BASE + '/mk.html#marketing'); await P.waitForSelector('.mo-rail-card', T);
    const endLocal = await P.evaluate(() => { const d = new Date(Date.now() + 3 * 864e5); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T18:00'; });
    await act('build and publish a flash sale', async () => {
      await P.click('.mo-rail-card[data-k="flashSale"]', T); await P.waitForSelector('.mo-edit', T);
      await P.fill('[data-k="name"]', 'Weekend Laptop Deal', T);
      await P.click('[data-act="pick"][data-mode="products"]', T); await P.waitForSelector('[data-act="pickone"][data-id="laptop"]', T);
      await P.click('[data-act="pickone"][data-id="laptop"]', T); await P.click('.mo-sheet-f [data-act="pickclose"]', T);
      await P.waitForSelector('[data-k="salePrice"]', T); await P.fill('[data-k="salePrice"]', '68000', T);
      await P.fill('[data-k="endsAt"]', endLocal, T); await P.fill('[data-k="inventoryLimit"]', '5', T);
      await P.click('[data-act="stack"]').catch(() => {}); /* not on this wizard — must be absent */
      await P.click('[data-act="publish"]', T);
      await P.waitForFunction(() => window.__saves.some((s) => s.offer.name === 'Weekend Laptop Deal'), null, T);
    });
    saves = await P.evaluate(() => window.__saves);
    const fs1 = saves.find((s) => s.offer.name === 'Weekend Laptop Deal');
    const fo = fs1 && fs1.offer;
    ck('MB3 flash sale publishes percentage off THE laptop, with its end time and limit — and nothing else',
      fo && fo.type === 'percentage' && fo.template === 'flashSale' && fo.status === 'live' && JSON.stringify(fo.qualifyingListingIds) === '["laptop"]'
      && Math.abs(fo.percent - 9.3333) < 0.001 && fo.inventoryLimit === 5 && typeof fo.endsAt === 'string' && !('buyQty' in fo) && !('items' in fo) && !('stacking' in fo)
      && typeof fs1.draftToken === 'string' && !fs1.offerId, fo);

    /* MB4 — values survive re-renders */
    await P.goto(BASE + '/mk.html#marketing'); await P.waitForSelector('.mo-rail-card', T);
    let kept = null;
    await act('happy hour: type, then tap a day and page the calendar', async () => {
      await P.click('.mo-rail-card[data-k="happyHour"]', T); await P.waitForSelector('[data-k="percent"]', T);
      await P.fill('[data-k="name"]', 'Evening Hour', T); await P.fill('[data-k="percent"]', '20', T);
      await P.fill('[data-k="schedule.from"]', '17:00', T); await P.fill('[data-k="schedule.to"]', '19:00', T);
      await P.click('[data-act="day"][data-d="fri"]', T); await P.click('[data-act="calnext"]', T);
      kept = await P.evaluate(() => ({ n: document.querySelector('[data-k="name"]').value, p: document.querySelector('[data-k="percent"]').value,
        f: document.querySelector('[data-k="schedule.from"]').value, fri: document.querySelector('[data-act="day"][data-d="fri"]').classList.contains('on') }));
    });
    ck('MB4 typed values survive a day chip and the calendar', kept && kept.n === 'Evening Hour' && kept.p === '20' && kept.f === '17:00' && kept.fri, kept);

    /* MB5 — meal deal from the catalogue, saved as a draft, continued, published */
    await P.goto(BASE + '/mk.html#marketing'); await P.waitForSelector('.mo-rail-card', T);
    let resumed = null;
    await act('meal deal: pizza + 2 soda, save draft, continue, publish', async () => {
      await P.click('.mo-rail-card[data-k="mealDeal"]', T); await P.waitForSelector('[data-act="pick"][data-mode="items"]', T);
      await P.fill('[data-k="name"]', 'Pizza Meal Deal', T);
      await P.click('[data-act="pick"][data-mode="items"]', T); await P.waitForSelector('[data-act="pickone"][data-id="pizza"]', T);
      const archivedOffered = await P.$('[data-act="pickone"][data-id="gone"]');
      if (archivedOffered) throw new Error('an archived product was offered in the picker');
      await P.click('[data-act="pickone"][data-id="pizza"]', T); await P.click('[data-act="pickone"][data-id="soda"]', T);
      await P.click('.mo-sheet-f [data-act="pickclose"]', T);
      await P.click('[data-act="iteminc"][data-i="1"]', T);
      await P.fill('[data-k="bundlePrice"]', '850', T);
      await P.click('[data-act="savedraft"]', T);
      await P.waitForFunction(() => window.__saves.some((s) => s.offer.name === 'Pizza Meal Deal' && s.offer.status === 'draft'), null, T);
      await P.waitForSelector('[data-act="filter"][data-f="draft"]', T); await P.click('[data-act="filter"][data-f="draft"]', T);
      /* the named card: earlier sections leave their own drafts behind (an interrupted edit is KEPT as a draft) */
      const mealCard = '.mo-card:has(.mo-card-name:text-is("🍕 Pizza Meal Deal"))';
      await P.waitForSelector(mealCard + ' [data-act="edit"]', T); await P.click(mealCard + ' [data-act="edit"]', T);
      await P.waitForSelector('[data-act="iteminc"]', T);
      resumed = await P.evaluate(() => ({ name: document.querySelector('[data-k="name"]').value, price: document.querySelector('[data-k="bundlePrice"]').value,
        items: [...document.querySelectorAll('.mo-item')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()) }));
      await P.click('[data-act="back"]', T); await P.waitForSelector('.mo-card', T);
      await P.click('[data-act="filter"][data-f="draft"]', T); await P.click(mealCard + ' [data-act="quickpublish"]', T);
      await P.waitForFunction(() => window.__saves.some((s) => s.offer.name === 'Pizza Meal Deal' && s.offer.status === 'live'), null, T);
    });
    saves = await P.evaluate(() => window.__saves);
    const md = saves.filter((s) => s.offer.name === 'Pizza Meal Deal');
    const draft = md.find((s) => s.offer.status === 'draft'), live = md.find((s) => s.offer.status === 'live');
    ck('MB5 meal deal from the catalogue: draft saved (Pizza ×1, Soda ×2, 850), continued intact, then published as the SAME offer',
      draft && live && JSON.stringify(draft.offer.items.map((i) => [i.listingId, i.qty])) === '[["pizza",1],["soda",2]]' && draft.offer.bundlePrice === 850
      && !('percent' in draft.offer) && resumed && resumed.name === 'Pizza Meal Deal' && resumed.price === '850' && resumed.items.length === 2
      && live.offerId && live.offerId === ('off_' + draft.draftToken), { draft: draft && draft.offer, live: live && { offerId: live.offerId }, resumed });

    /* MB6 — Back: button, and the browser/phone Back; unsaved changes kept as a draft */
    await P.goto(BASE + '/mk.html#marketing'); await P.waitForSelector('.mo-rail-card', T);
    let viaButton = false, viaBrowser = false, hashAfter = null, keptDraft = false, pushedOne = false;
    await act('Back button and browser Back', async () => {
      await P.click('.mo-rail-card[data-k="coupon"]', T); await P.waitForSelector('.mo-edit', T);
      await P.click('[data-act="back"]', T); await P.waitForSelector('.mo-rail-card:not(.on)', T);
      viaButton = !(await P.$('.mo-edit')) && !!(await P.$('.mmk-tab.on'));
      /* the shell's reality: the entry BEFORE Marketing is another route. Without the editor's own entry, Back
         would leave Marketing for it — the owner's "you can't go back" defect. */
      await P.evaluate(() => { history.pushState({}, '', '#dashboard'); history.pushState({}, '', '#marketing'); });
      const h0 = await P.evaluate(() => history.length);
      await P.click('.mo-rail-card[data-k="coupon"]', T); await P.waitForSelector('.mo-edit', T);
      pushedOne = (await P.evaluate(() => history.length)) === h0 + 1;
      await P.fill('[data-k="name"]', 'KES 200 off', T); await P.fill('[data-k="amount"]', '200', T);
      await P.goBack(); await P.waitForFunction(() => !document.querySelector('.mo-edit'), null, T);
      viaBrowser = true; hashAfter = await P.evaluate(() => location.hash);
      await P.waitForFunction(() => window.__saves.some((s) => s.offer.name === 'KES 200 off' && s.offer.status === 'draft'), null, T);
      keptDraft = true;
    });
    ck('MB6 on-screen Back and browser Back both return to the list inside Marketing; a changed offer is kept as a draft',
      viaButton && viaBrowser && pushedOne && hashAfter === '#marketing' && keptDraft, { viaButton, viaBrowser, pushedOne, hashAfter, keptDraft });

    /* MB7 — switching type */
    await P.goto(BASE + '/mk.html#marketing'); await P.waitForSelector('.mo-rail-card', T);
    await act('switch a flash sale into a buy-X-get-Y', async () => {
      await P.click('.mo-rail-card[data-k="flashSale"]', T); await P.waitForSelector('.mo-edit', T);
      await P.fill('[data-k="name"]', 'Soda Promo', T); await P.fill('[data-k="percent"]', '15', T);
      await P.click('[data-act="pick"][data-mode="products"]', T); await P.waitForSelector('[data-act="pickone"][data-id="soda"]', T);
      await P.click('[data-act="pickone"][data-id="soda"]', T); await P.click('.mo-sheet-f [data-act="pickclose"]', T);
      await P.click('.mo-rail-card[data-k="bxgy"]', T); await P.waitForSelector('[data-k="buyQty"]', T);
      await P.click('[data-act="savedraft"]', T);
      await P.waitForFunction(() => window.__saves.some((s) => s.offer.name === 'Soda Promo'), null, T);
    });
    saves = await P.evaluate(() => window.__saves);
    const sw = (saves.find((s) => s.offer.name === 'Soda Promo') || {}).offer;
    ck('MB7 switching type keeps the name and products and sends none of the old type\'s fields', sw && sw.type === 'buyXgetY' && sw.template === 'bxgy'
      && JSON.stringify(sw.qualifyingListingIds) === '["soda"]' && !('percent' in sw) && !('inventoryLimit' in sw) && sw.buyQty === 2 && sw.getQty === 1, sw);

    /* MB8 — publish with gaps; end an offer */
    await P.goto(BASE + '/mk.html#marketing'); await P.waitForSelector('.mo-rail-card', T);
    const before = await P.evaluate(() => window.__saves.length);
    let gaps = '';
    await act('publish an empty flash sale', async () => {
      await P.click('.mo-rail-card[data-k="flashSale"]', T); await P.waitForSelector('.mo-edit', T);
      await P.click('[data-act="publish"]', T); await P.waitForSelector('.mo-warn', T);
      gaps = await P.$eval('.mo-warn', (e) => e.innerText);
      await P.click('[data-act="back"]', T); await P.waitForSelector('.mo-card', T);
    });
    const afterGaps = await P.evaluate(() => window.__saves.length);
    await act('end the live flash sale', async () => {
      await P.click('[data-act="filter"][data-f="live"]', T);
      await P.waitForSelector('.mo-card [data-act="archive"]', T); await P.click('.mo-card [data-act="archive"]', T);
      await P.waitForFunction(() => window.__saves.some((s) => s.offer.status === 'archived'), null, T);
    });
    saves = await P.evaluate(() => window.__saves);
    const ended = saves.find((s) => s.offer.status === 'archived');
    ck('MB8 publishing with gaps says what is missing and saves nothing; End offer archives it', /Choose at least one product/.test(gaps) && /Set when the sale ends/.test(gaps)
      && afterGaps === before && ended && ended.offerId, { gaps, before, afterGaps, ended: ended && ended.offerId });

    /* MB10 */
    const over = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false);
    ck('MB10 no horizontal overflow at 390 px; no page errors', over && errors.length === 0, { over, errors: errors.slice(0, 3) });
  } catch (e) { if (!e || !e.notMounted) throw e; } finally { await browser.close().catch(() => {}); srv.close(); }

  /* MB9 — server replay of everything the browser saved */
  const SO = loadServerOffers();
  if (typeof SO.normaliseOffer !== 'function') ck('MB9 the server offer module loads', false, SO.__err);
  else {
    const refused = [];
    for (const s of saves) { try { SO.normaliseOffer(s.offer, { shopId: 'shopA' }); } catch (e) { refused.push([s.offer.name, s.offer.status, e.message]); } }
    const flash = saves.find((s) => s.offer.name === 'Weekend Laptop Deal');
    const meal = saves.filter((s) => s.offer.name === 'Pizza Meal Deal').pop();
    const fo = flash && Object.assign({ id: 'f1' }, SO.normaliseOffer(flash.offer, { shopId: 'shopA' }));
    const mo = meal && Object.assign({ id: 'm1' }, SO.normaliseOffer(meal.offer, { shopId: 'shopA' }));
    const now = SO.resolve({ lines: [{ listingId: 'laptop', price: 75000, qty: 1 }] }, [fo], { at: new Date() });
    const afterEnd = SO.resolve({ lines: [{ listingId: 'laptop', price: 75000, qty: 1 }] }, [fo], { at: new Date(Date.now() + 5 * 864e5) });
    const mealR = SO.resolve({ lines: [{ listingId: 'pizza', price: 800, qty: 1 }, { listingId: 'soda', price: 100, qty: 2 }] }, [mo], {});
    ck('MB9 every saved payload passes the REAL server normaliser; flash prices the laptop at 68,000 until its end; meal deal = 850',
      saves.length >= 5 && refused.length === 0 && now.total === 68000 && afterEnd.total === 75000 && mealR.total === 850,
      { saves: saves.length, refused, flashNow: now.total, flashAfter: afterEnd.total, meal: mealR.total });
  }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
