/* ══════════════════════════════════════════════════════════════════════════════
   GATE W — THE LISTING STUDIO ACTUALLY SAVES
   scripts/test-listing-studio-saves.js

     node scripts/test-listing-studio-saves.js          (expects a static server on :8099)

   WHAT THIS CLOSES
   The writer's own two suites both end with the same honest admission:

       UNPROVEN  the 2b UI   [not built; the writer is certified first, deliberately]

   It is built now, so that line is stale and this suite retires it. The other two prove the
   writer's DECISIONS (in-memory, 37/0) and that those decisions survive real Firestore and
   the live ruleset (emulator, 46/0). Neither touches the wiring between the Listing Studio
   and the writer, which is precisely where a port can look finished and do nothing.

   WHAT IT DELIBERATELY DOES NOT RE-PROVE
   Rules. The emulator suite owns that, against firestore.rules.live and a real rules engine.
   Re-asserting it here through a stubbed adapter would be theatre: an in-memory adapter
   cannot deny anything, so a "rules" pass here would prove only that nothing refused.

   THE ADAPTER IS AN OBSERVER, NOT A MODEL. It records exactly what the shell's real _mdb
   would have been asked to send to Firestore, and the assertions read that record. The real
   adapter is certified as an adapter-not-authority by the emulator suite; what is under test
   here is the chain:

       Listing Studio form  ->  createProduct/updateProduct  ->  canonical document
                            ->  POS + Inventory projections  ->  id back to the Studio
                            ->  the merchant's list reflecting the save
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function head (t) { console.log('\n' + t); }

const URL = process.env.STUDIO_URL || 'http://localhost:8099/merchant-v2.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('button')].find(b => /^\s*Reject\s*$/.test(b.textContent || ''));
    if (r) r.click();
  });
  await page.waitForTimeout(400);

  const R = await page.evaluate(async () => {
    /* ── THE OBSERVING ADAPTER ────────────────────────────────────────────────
       Exactly the surface the writer requires, recording every call. It mimics the real
       adapter's ONE behaviour the writer depends on — that a create replays rather than
       duplicating — and nothing else. */
    const store = new Map();
    const log = { writeProduct: [], writeMirror: [], getProduct: [], deleteProduct: [] };
    const db = {
      writeProduct(o) {
        log.writeProduct.push({ id: o.id, mode: o.mode, data: JSON.parse(JSON.stringify(o.data)) });
        if (o.mode === 'create') {
          if (store.has(o.id)) return Promise.resolve({ replayed: true });
          store.set(o.id, Object.assign({}, o.data));
          return Promise.resolve({ replayed: false });
        }
        store.set(o.id, Object.assign({}, store.get(o.id) || {}, o.data));
        return Promise.resolve({ replayed: false });
      },
      getProduct(id) { log.getProduct.push(id); return Promise.resolve(store.get(id) || null); },
      deleteProduct(o) { log.deleteProduct.push(o.id); store.delete(o.id); return Promise.resolve(); },
      writeMirror(o) { log.writeMirror.push({ path: o.path.slice(), data: o.data }); return Promise.resolve(); },
      queryProducts() { return Promise.resolve([...store.values()]); },
    };

    const scope = { ok: true, shopId: 'shop_W', sellerUid: 'shop_W' };
    const out = { log, store: null, toasts: [] };

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#050505';
    document.body.appendChild(host);

    window.SokoniMerchantData.listProducts = () => Promise.resolve([...store.values()]);

    const api = window.SokoniMerchantProducts.mount(host, {
      scope, db, shopName: 'Gate W Shop',
      onToast: m => out.toasts.push(m),
      canPublish: () => Promise.resolve({ data: { allowed: true } }),
    });
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(600);

    const setField = (sel, v) => {
      const el = host.querySelector(sel);
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    /* ── CREATE ──────────────────────────────────────────────────────────── */
    host.querySelector('[data-pr="add"]').click();
    await wait(500);
    out.sheetOpened = !!host.querySelector('.pr-panel');
    out.fieldsSet = {
      name: setField('[data-pf="name"]', 'Gate W Kettle'),
      price: setField('[data-pf="price"]', '2500'),
      cost: setField('[data-pf="costPrice"]', '1800'),
      sku: setField('[data-pf="sku"]', 'GW-1'),
    };
    await wait(250);
    host.querySelector('[data-pr="submit"]').click();
    await wait(900);

    out.afterCreate = {
      sheetClosed: !host.querySelector('.pr-panel'),
      listText: (host.querySelector('.pr-grid') || {}).textContent || '',
    };
    out.store = [...store.entries()].map(([k, v]) => ({ id: k, ...v }));

    /* ── UPDATE the product that was just created ────────────────────────── */
    const created = out.store[0];
    if (created) {
      const editBtn = host.querySelector('[data-pr="edit"]');
      if (editBtn) {
        editBtn.click();
        await wait(500);
        setField('[data-pf="price"]', '2750');
        await wait(200);
        host.querySelector('[data-pr="submit"]').click();
        await wait(900);
      }
    }
    out.afterUpdate = [...store.entries()].map(([k, v]) => ({ id: k, ...v }));

    try { api.destroy && api.destroy(); } catch (_) {}

    /* ── A REFUSED PUBLICATION MUST NOT READ AS A SAVE ────────────────────────
       The writer is certified to mutate nothing when canPublishProduct refuses. What that
       certification cannot show is what the MERCHANT is told. A success toast over a
       refusal is the specific failure the platform's own rule forbids: never announce a
       success until the canonical operation has completed. Re-mounted with a refusing
       gate, against a fresh store, so the count below is unambiguous. */
    const store2 = new Map();
    const log2 = { writeProduct: [], writeMirror: [] };
    const db2 = {
      writeProduct(o) { log2.writeProduct.push(o); store2.set(o.id, o.data); return Promise.resolve({}); },
      getProduct(id) { return Promise.resolve(store2.get(id) || null); },
      deleteProduct() { return Promise.resolve(); },
      writeMirror(o) { log2.writeMirror.push(o); return Promise.resolve(); },
      queryProducts() { return Promise.resolve([...store2.values()]); },
    };
    const host2 = document.createElement('div');
    host2.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#050505';
    document.body.appendChild(host2);
    const toasts2 = [];
    window.SokoniMerchantData.listProducts = () => Promise.resolve([...store2.values()]);
    window.SokoniMerchantProducts.mount(host2, {
      scope, db: db2, shopName: 'Gate W Shop', onToast: m => toasts2.push(m),
      canPublish: () => Promise.resolve({ data: {
        allowed: false, upgrade: { message: 'Your plan allows 10 products. Upgrade to add more.' },
      } }),
    });
    await wait(600);
    host2.querySelector('[data-pr="add"]').click();
    await wait(500);
    setField2 = (sel, v) => {
      const el = host2.querySelector(sel); if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setField2('[data-pf="name"]', 'Refused Product');
    setField2('[data-pf="price"]', '900');
    await wait(200);
    host2.querySelector('[data-pr="submit"]').click();
    await wait(900);

    out.refusal = {
      productWrites: log2.writeProduct.length,
      mirrorWrites: log2.writeMirror.length,
      stored: store2.size,
      sheetStillOpen: !!host2.querySelector('.pr-panel'),
      shownText: (host2.querySelector('.pr-panel') || {}).textContent || '',
      toasts: toasts2,
    };
    return out;
  });

  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  GATE W — Listing Studio -> certified writer -> canonical product');
  console.log('══════════════════════════════════════════════════════════════════');

  head('1 - the Studio reached the certified writer at all');
  ok('the editor opened', R.sheetOpened);
  ok('every field under test was present', Object.values(R.fieldsSet).every(Boolean),
     JSON.stringify(R.fieldsSet));
  ok('createProduct performed exactly ONE canonical write',
     R.log.writeProduct.filter(w => w.mode === 'create').length === 1,
     R.log.writeProduct.length + ' total product writes');
  ok('and it was a create, not a blind overwrite',
     (R.log.writeProduct[0] || {}).mode === 'create');

  head('2 - the canonical document carries what the form said');
  const doc = R.store[0] || {};
  ok('the product exists after save', !!doc.id, doc.id);
  ok('the name was carried', doc.name === 'Gate W Kettle', String(doc.name));
  ok('the price was carried as a NUMBER', doc.price === 2500, JSON.stringify(doc.price));
  /* costPrice was one of the two contract defects the live ruleset exposed during the
     original certification: without it every mirrored product reports a 100% margin. */
  ok('costPrice survived the round trip', doc.costPrice === 1800, JSON.stringify(doc.costPrice));
  ok('ownership came from the SCOPE, not the form',
     doc.shopId === 'shop_W' && doc.sellerUid === 'shop_W');
  ok('no image field was invented', doc.image === undefined && doc.images === undefined);
  /* Stock is inventory authority and must never ride in the product document. */
  ok('no stock field rode along in the product write',
     !('stock' in doc) && !('inventoryVersion' in doc) && !('sold' in doc),
     Object.keys(doc).filter(k => /stock|sold|inventoryVersion/.test(k)).join(',') || 'none');

  head('3 - the projections the till and Inventory depend on');
  const paths = R.log.writeMirror.map(m => m.path.join('/'));
  ok('two projections were written', R.log.writeMirror.length === 2, paths.join(' · '));
  ok('one reaches POS', paths.some(p => /posProducts/.test(p)), paths.join(' · '));
  ok('one reaches Inventory', paths.some(p => /inventory_products/.test(p)), paths.join(' · '));
  const inv = (R.log.writeMirror.find(m => /inventory_products/.test(m.path.join('/'))) || {}).data || {};
  ok('Inventory maps costPrice -> buyingPrice', inv.buyingPrice === 1800, JSON.stringify(inv.buyingPrice));
  ok('Inventory maps price -> sellingPrice', inv.sellingPrice === 2500, JSON.stringify(inv.sellingPrice));

  head('4 - the identity came back and the merchant can see it');
  ok('the editor closed on success', R.afterCreate.sheetClosed);
  ok('the saved listing appears in the merchant list',
     R.afterCreate.listText.indexOf('Gate W Kettle') > -1);
  ok('the Studio reported a real outcome',
     R.toasts.some(t => /added|ready at the till|catalogue/i.test(t)), R.toasts.join(' | '));

  head('5 - an edit updates that product, it does not create a second');
  ok('still exactly one product', R.afterUpdate.length === 1, R.afterUpdate.length + ' products');
  ok('the edit reached the writer as an UPDATE',
     R.log.writeProduct.some(w => w.mode === 'update'));
  ok('the new price landed', (R.afterUpdate[0] || {}).price === 2750,
     JSON.stringify((R.afterUpdate[0] || {}).price));
  ok('the id did not change', (R.afterUpdate[0] || {}).id === doc.id);
  /* An update must not resend ownership — a product cannot be moved between shops. */
  const upd = R.log.writeProduct.filter(w => w.mode === 'update').pop() || { data: {} };
  ok('the update carried no shopId or sellerUid',
     !('shopId' in upd.data) && !('sellerUid' in upd.data),
     Object.keys(upd.data).join(','));

  head('6 - a REFUSED publication is a refusal, not a quiet failure');
  const F = R.refusal;
  ok('nothing was written to the catalogue', F.productWrites === 0 && F.stored === 0,
     F.productWrites + ' writes, ' + F.stored + ' stored');
  ok('and no projection was written either', F.mirrorWrites === 0, F.mirrorWrites + ' mirrors');
  /* The whole point: the merchant must not be told it worked. */
  ok('the merchant was NOT told it was saved',
     !F.toasts.some(t => /added|saved|ready at the till/i.test(t)), F.toasts.join(' | ') || 'no toast');
  ok('the editor stayed open so the work is not lost', F.sheetStillOpen);
  ok('the plan message was shown verbatim',
     F.shownText.indexOf('Your plan allows 10 products') > -1);

  head('7 - the page itself');
  ok('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  Firestore rules enforcement   [owned by the emulator suite, ' +
              'against firestore.rules.live and a real rules engine]');
  console.log('  UNPROVEN  App Check                     [not enforced outside production]');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');

  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE CRASHED:', e); process.exit(1); });
