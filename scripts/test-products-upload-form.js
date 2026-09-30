#!/usr/bin/env node
/* THE MERCHANT V2 UPLOAD FORM, RENDERED IN A REAL BROWSER.
 *
 *   node scripts/test-products-upload-form.js
 *
 * WHY A BROWSER AND NOT THE DOM STUB
 * ----------------------------------
 * test-merchant-v2-products-2b drives a hand-rolled element stub, which is right for the
 * write path it certifies — but it cannot tell you whether a <select> actually produced 20
 * <optgroup>s, whether an emoji survived escaping, or whether the section for a butchery
 * appears when the category changes. Those are rendering facts, and this suite renders.
 *
 * WHAT IT CERTIFIES
 *   1  the whole legacy taxonomy reached V2 — 99 categories in 20 groups, every one with
 *      its emoji, plus locations, conditions, storage and slaughter vocabularies
 *   2  EVERY dropdown carries emoji, which is a stated requirement and trivially regressed
 *      by anyone adding an option in a hurry
 *   3  the form CHANGES SHAPE with the category: a phone asks for an IMEI, a goat asks for a
 *      slaughter record and a county permit, an e-book asks for an https download link and
 *      none of the above
 *   4  every field seller.html collected has somewhere to go here — the migration is checked
 *      as complete rather than asserted to be
 *   5  the bulk-deal read-out tells the truth about a wholesale price that is not a discount
 *
 * THE FORM IS MOUNTED, NOT MOCKED. The real sokoni-merchant-products.js runs against the real
 * taxonomy and the real stylesheet; only the data adapters are stubs, because this suite is
 * about what a merchant SEES, not about what the writer stores.
 */
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 120) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t + '\n');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host"></div>
<script src="/sokoni-product-taxonomy.js"></script>
<script src="/sokoni-product-specs.js"></script>
<script src="/sokoni-merchant-data.js"></script>
<script src="/sokoni-merchant-products.js"></script>
<script>
  window.__mount = function () {
    var db = {
      queryProducts: function () { return Promise.resolve([]); },
      createProduct: function () { return Promise.resolve({ id: 'x' }); },
      updateProduct: function () { return Promise.resolve({}); },
      listProducts: function () { return Promise.resolve([]); }
    };
    window.__inst = window.SokoniMerchantProducts.mount(document.getElementById('host'), {
      scope: { ok: true, sellerUid: 'u1', shopId: 's1' },
      db: db,
      shopName: 'Test Shop',
      entitlement: function () { return Promise.resolve({ uploadLimit: 50 }); },
      canPublish: function () { return Promise.resolve({ data: { allowed: true } }); },
      adjustStock: function () { return Promise.resolve({ ok: true }); },
      callAiMetadata: function () { return Promise.resolve({ data: {} }); },
      onToast: function () {}
    });
  };
</script></body></html>`;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/probe.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE);
  }
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(d);
  });
});

/* Every field seller.html's upload form collected. The migration is complete when each has a
   home in V2 — matched by the data-pf key the new form uses. */
const LEGACY = [
  ['productName',      'name'],
  ['productPrice',     'price'],
  ['productCategory',  'category'],
  ['productLocation',  'location'],
  ['productDescription', 'description'],
  ['costPrice',        'costPrice'],
  ['deliveryCost',     'deliveryCost'],
  ['stockQty',         'stock'],
  ['wholesalePrice',   'wholesalePrice'],
  ['minWholesaleQty',  'minWholesaleQty'],
  ['kebsCert',         'kebsCert'],
  ['digitalUrl',       'digitalUrl'],
  ['digitalLicense',   'digitalLicense'],
  ['ownerSerial',      'ownership.serial'],
  ['ownerSource',      'ownership.source'],
  ['ownerDeclaration', 'ownership.declared'],
  ['foodPermit',       'foodLicence.permit'],
  ['foodKEBS',         'foodLicence.kebs'],
  ['foodKMC',          'foodLicence.kmc'],
  ['foodHalal',        'foodLicence.halal'],
  ['foodStorage',      'foodLicence.storage'],
  ['foodSlaughter',    'foodLicence.slaughter'],
];

/* THE UNICODE PROPERTY, not a hand-listed range.
   The first version used explicit blocks and reported "⌚ Accessories & Jewelry" as carrying
   no emoji: U+231A WATCH sits in Miscellaneous Technical, outside every range listed. A
   detector that calls a correct label wrong is worse than no detector — the "fix" it invites
   is to edit the taxonomy. \p{Extended_Pictographic} is the property the taxonomy generator
   itself used to split emoji from label, so the two now agree by construction. */
const EMOJI_RE = /\p{Extended_Pictographic}/u;

(async () => {
  const BASE = await new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));

  try {
    await page.goto(BASE + '/probe.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loaded = await page.evaluate(() =>
      !!(window.SokoniProductTaxonomy && window.SokoniMerchantProducts));
    ck('the taxonomy and the products module both load', loaded);
    if (!loaded) throw new Error('modules did not load');

    await page.evaluate(() => window.__mount());
    await page.waitForTimeout(400);
    /* Open the editor. */
    await page.evaluate(() => {
      const b = document.querySelector('[data-pr="add"]');
      if (b) b.click();
    });
    await page.waitForTimeout(300);

    const formUp = await page.evaluate(() => !!document.querySelector('#pf-name'));
    ck('the Add-product form opens', formUp);
    if (!formUp) throw new Error('editor did not open');

    /* ══ 1 — THE TAXONOMY ARRIVED ══ */
    head('1 - the whole legacy taxonomy reached Merchant V2');
    const cat = await page.evaluate(() => {
      const s = document.querySelector('#pf-category');
      if (!s) return null;
      const groups = [...s.querySelectorAll('optgroup')].map((g) => g.label);
      const opts = [...s.querySelectorAll('option')].filter((o) => o.value)
        .map((o) => ({ v: o.value, t: o.textContent }));
      return { tag: s.tagName, groups, opts };
    });
    ck('Category is a DROPDOWN, not a free-text box', cat && cat.tag === 'SELECT',
       cat && cat.tag);
    ck('...with all 20 groups', cat && cat.groups.length === 20, cat && cat.groups.length);
    ck('...and all 99 categories', cat && cat.opts.length === 99, cat && cat.opts.length);
    ck('...every group label carries an emoji',
       cat && cat.groups.every((g) => EMOJI_RE.test(g)),
       cat && cat.groups.filter((g) => !EMOJI_RE.test(g)).join(', '));
    ck('...every category carries an emoji',
       cat && cat.opts.every((o) => EMOJI_RE.test(o.t)),
       cat && cat.opts.filter((o) => !EMOJI_RE.test(o.t)).map((o) => o.v).slice(0, 6).join(', '));
    ck('...covering services, digital and physical goods alike',
       cat && ['plumbing', 'ebook', 'electronics', 'meat', 'solar'].every(
         (v) => cat.opts.some((o) => o.v === v)));

    /* ══ 2 — EVERY DROPDOWN HAS EMOJI ══ */
    head('2 - every dropdown carries emoji');
    const sels = await page.evaluate(() => {
      return [...document.querySelectorAll('select[data-pf]')].map((s) => ({
        key: s.getAttribute('data-pf'),
        opts: [...s.querySelectorAll('option')].filter((o) => o.value).map((o) => o.textContent),
      }));
    });
    ck('the form renders several dropdowns', sels.length >= 3, sels.map((s) => s.key).join(', '));
    sels.forEach((s) => {
      const bad = s.opts.filter((t) => !EMOJI_RE.test(t));
      ck('  ' + s.key + ' — all ' + s.opts.length + ' options carry an emoji',
         s.opts.length > 0 && bad.length === 0, bad.slice(0, 4).join(' | '));
    });

    /* ══ 3 — THE FORM CHANGES SHAPE ══ */
    head('3 - the form asks for what the thing being sold actually needs');
    const shapeFor = async (value) => {
      await page.evaluate((v) => {
        const s = document.querySelector('#pf-category');
        s.value = v;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await page.waitForTimeout(220);
      return page.evaluate(() => ({
        keys: [...document.querySelectorAll('[data-pf]')].map((e) => e.getAttribute('data-pf')),
        text: document.body.textContent || '',
      }));
    };

    const phone = await shapeFor('electronics');
    ck('a PHONE is asked for its IMEI', phone.keys.includes('ownership.serial'));
    ck('  ...labelled as an IMEI, not a generic serial', /IMEI/i.test(phone.text));
    ck('  ...and is NOT asked for a food permit', !phone.keys.includes('foodLicence.permit'));
    ck('  ...nor a download link', !phone.keys.includes('digitalUrl'));

    const meat = await shapeFor('meat');
    ck('a BUTCHERY is asked for a county food permit', meat.keys.includes('foodLicence.permit'));
    ck('  ...a KMC number', meat.keys.includes('foodLicence.kmc'));
    ck('  ...a cold-chain type', meat.keys.includes('foodLicence.storage'));
    ck('  ...and a slaughter route', meat.keys.includes('foodLicence.slaughter'));
    ck('  ...but not an IMEI', !meat.keys.includes('ownership.serial'));

    const ebook = await shapeFor('ebook');
    ck('an E-BOOK is asked for a download link', ebook.keys.includes('digitalUrl'));
    ck('  ...told it must be https', /https:\/\//.test(ebook.text));
    ck('  ...and is NOT asked for a KEBS certificate (a download has no standards mark)',
       !ebook.keys.includes('kebsCert'));

    const service = await shapeFor('plumbing');
    ck('a SERVICE is not asked for a KEBS certificate', !service.keys.includes('kebsCert'));
    ck('  ...nor proof of ownership', !service.keys.includes('ownership.serial'));

    const car = await shapeFor('cars');
    ck('a CAR is asked for its chassis/VIN', car.keys.includes('ownership.serial'));
    ck('  ...and told a logbook is required', /logbook/i.test(car.text));

    const vape = await shapeFor('vape');
    ck('an AGE-RESTRICTED item warns that buyers are 18+ gated', /18\+/.test(vape.text));

    /* ══ 4 — MIGRATION COMPLETENESS ══ */
    head('4 - every field the legacy form collected has a home here');
    /* Ask for the union across the category shapes, since the form is deliberately partial
       for any single category. */
    const union = new Set();
    for (const c of ['electronics', 'meat', 'ebook', 'cars', 'fashion']) {
      const r = await shapeFor(c);
      r.keys.forEach((k) => union.add(k));
    }
    LEGACY.forEach(([legacyId, v2key]) => {
      ck('  ' + legacyId.padEnd(20) + ' -> ' + v2key, union.has(v2key));
    });

    /* ══ 5 — THE BULK DEAL TELLS THE TRUTH ══ */
    head('5 - the bulk-deal read-out is honest');
    await shapeFor('fashion');
    const bulk = async (price, wp, wq) => {
      await page.evaluate((a) => {
        const set = (id, val) => {
          const el = document.querySelector(id);
          if (!el) return;
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('#pf-price', a.price); set('#pf-wholesalePrice', a.wp); set('#pf-minWholesaleQty', a.wq);
        /* A repaint is what redraws the strip; the category select is the form's own trigger. */
        const s = document.querySelector('#pf-category');
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, { price, wp, wq });
      await page.waitForTimeout(220);
      /* The STRIP, not the whole panel: "Bulk deal" is also the section heading, so matching
         body text alone would report a saving on a form that is showing a warning. */
      return page.evaluate(() => ({
        text: document.body.textContent || '',
        strip: !!document.querySelector('.pr-bulk-strip'),
        warn: !!document.querySelector('.pr-warn'),
      }));
    };
    const good = await bulk('1000', '800', '10');
    ck('a real bulk discount shows the saving strip', good.strip && /200/.test(good.text));
    ck('  ...with the percentage', /20%/.test(good.text));
    ck('  ...and no warning', !good.warn);
    const bad = await bulk('1000', '1200', '10');
    ck('a bulk price ABOVE the unit price is called out',
       bad.warn && /not a discount/i.test(bad.text));
    ck('  ...and is NOT dressed up as a saving', !bad.strip);

    /* ══ 6 — AI ══ */
    head('6 - the AI writer is offered honestly');
    const ai = await page.evaluate(() => ({
      text: document.body.textContent || '',
      btn: !!document.querySelector('[data-pr="ai-write"]'),
    }));
    ck('the AI section is present', /SOKONI AI/.test(ai.text));
    /* generateProductMetadata REFUSES an empty imageUrl, so a button offered before a photo
       exists would fail every time it was pressed. On create the photo is still a local File
       with no URL, so the section explains that instead of offering one. seller.html labelled
       its image input "✨ AI enhanced" with nothing behind it; this must not be that twice. */
    ck('on CREATE it explains a photo is needed rather than offering a button that would fail',
       !ai.btn && /photo/i.test(ai.text), ai.btn ? 'button offered with no image' : '');

    ck('no page errors were thrown while rendering the form', errors.length === 0,
       errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
