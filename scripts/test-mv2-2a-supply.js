#!/usr/bin/env node
/* test-mv2-2a-supply.js — Supply workspace on the live line (port + honest backing + row actions).
 *   R  route 'supply' registered (tier more, Commerce group), validate() clean
 *   B  backing map == the LIVE functions estate (measured 2026-09-30, `firebase functions:list`):
 *      a section is backed only when its read is deployed; the six absent reads are stated
 *   S  shell wiring: module-map entry + module script + in-app inbox script
 *   U  executed in hermetic Chromium (no network) with a fake shell ctx:
 *      unbacked section → "Not available yet", NO call · Suppliers rows → Add supplier / New order /
 *      Call, Chat only with a counterparty uid · Add supplier → addSupplier · New order →
 *      createPurchaseOrder with the supplier id + typed lines, the ENGINE's number/total shown ·
 *      Create invoice → createSupplierInvoice with the PO id · an engine refusal shown, nothing done
 *   N  negative control: claiming an absent read is backed → B fails
 *   node scripts/test-mv2-2a-supply.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 500) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LIVE = ['listSuppliers', 'listPurchaseOrders', 'getInboundSupplyOrders', 'getProcurementDashboard', 'getProcurementForecast', 'addSupplier', 'createPurchaseOrder', 'createSupplierInvoice', 'resolveMerchantContext', 'getSupplierPerformance'];

(async () => {
  /* ── R ── */
  {
    const w = { window: null, document: { readyState: 'complete', addEventListener() {} }, location: { search: '', hash: '', pathname: '/merchant' }, console }; w.window = w;
    const ctx = vm.createContext(w); vm.runInContext(read('sokoni-merchant-routes.js'), ctx, { filename: 'routes' });
    const C = ctx.SokoniMerchantRoutes; const r = C.ROUTES.find((x) => x.id === 'supply');
    const grp = C.MORE_GROUPS.find((g) => g.key === 'commerce');
    ck('R1  supply route: native, tier more, in the Commerce group; validate() clean', !!r && r.kind === 'native' && r.tier === 'more' && !!grp && grp.ids.includes('supply') && C.validate().length === 0, { r: r && r.tier, errs: C.validate() });
  }

  /* ── B ── */
  const src = read('sokoni-merchant-supply.js');
  const navOf = (s) => [...s.matchAll(/\{ id: '([a-z]+)',\s+name: '[^']*',\s+icon: '[^']*',\s+backed: (true|false)/g)].map((m) => ({ id: m[1], backed: m[2] === 'true' }));
  const ops = Object.fromEntries([...src.matchAll(/^\s+([a-z]+): \{ op: '([A-Za-z]+)'/gm)].map((m) => [m[1], m[2]]));
  const opFor = (id) => ops[id] || ({ forecast: 'getProcurementForecast', performance: 'getSupplierPerformance', overview: 'getProcurementDashboard', procurement: 'getProcurementDashboard', spend: 'getProcurementDashboard', queue: null })[id];
  const check = (s) => { const wrong = []; navOf(s).forEach((n) => { const op = opFor(n.id); if (op === null) return; if (op === undefined) { wrong.push(n.id + ':no-op'); return; } if (LIVE.includes(op) !== n.backed) wrong.push(n.id + ':' + op + ':' + (LIVE.includes(op) ? 'live-but-unbacked' : 'absent-but-backed')); }); return wrong; };
  const wrong = check(src);
  ck('B1  backing map == live estate for every section (backed ⇔ its read is deployed); 18 sections', wrong.length === 0 && navOf(src).length === 18, { wrong, n: navOf(src).length });
  ck('B2  the eight absent-read sections name the missing op instead of failing at runtime', ['receiving', 'invoices', 'payments', 'find', 'catalogue', 'mysupply', 'stock', 'movements'].every((id) => new RegExp("id: '" + id + "'[^}]*backed: false, why: 'Its server read \\((list|find|get)[A-Za-z]+\\)").test(src)), null);

  /* ── S ── */
  const shell = read('merchant-v2.html');
  ck('S1  shell: supply module-map entry hands merchantContext + callable; module + inbox scripts loaded', /supply:\s*\{ global: 'SokoniMerchantSupply'/.test(shell) && /merchantContext/.test(shell) && /<script src="sokoni-merchant-supply\.js"><\/script>/.test(shell) && /<script src="sokoni-inbox\.js"><\/script>/.test(shell), null);

  /* ── U: hermetic Chromium ── */
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.route('**/*', (route) => route.abort());
    await page.setContent('<!doctype html><html><body><div id="host" style="height:700px"></div></body></html>');
    await page.addScriptTag({ content: read('sokoni-merchant-supply.js') });
    await page.evaluate(() => {
      window.__calls = []; window.__opened = [];
      window.__reply = {
        listSuppliers: { items: [{ id: 'sup1', name: 'Mwangi Wholesalers', phone: '0700111222', contactUid: 'u-mw', status: 'active', currentBalance: 0 }, { id: 'sup2', name: 'Kilimo Farm', phone: '0700333444', status: 'active' }] },
        getInboundSupplyOrders: { orders: [{ id: 'po9', poNumber: 'PO-2026-0009', buyerBusinessId: 'bizX', status: 'sent', total: 12000 }] },
        getProcurementDashboard: {},
        addSupplier: { supplierId: 'sup_new1' },
        createPurchaseOrder: (p) => ({ poNumber: 'PO-2026-0042', total: 4500, supplierId: p.supplierId }),
        createSupplierInvoice: (p) => ({ invoiceId: 'inv1', invoiceNumber: p.invoiceNumber }),
      };
      window.SokoniInbox = { HUB_TYPES: { GENERAL: 'general' }, openChat: (p) => window.__opened.push(p) };
      const ctx = {
        merchantContext: () => ({ merchantId: 'biz1', name: 'Test Business', choices: [] }),
        resolveMerchantContext: async () => ({ resolved: true, merchantId: 'biz1' }),
        callable: (name) => async (payload) => { window.__calls.push({ name, payload }); const f = window.__reply[name]; if (!f) throw new Error('functions/not-found'); const r = typeof f === 'function' ? f(payload) : f; if (r && r.__refuse) throw new Error(r.__refuse); return { data: r }; },
      };
      window.SokoniMerchantSupply.mount(document.getElementById('host'), ctx);
    });
    const wait = (ms) => page.waitForTimeout(ms || 80);
    const html = () => page.evaluate(() => document.getElementById('host').innerHTML);
    const calls = () => page.evaluate(() => window.__calls.map((c) => c.name));
    const click = async (sel) => { await page.click('#host ' + sel, { force: true }); await wait(); };
    const fill = (id, v) => page.evaluate(([i, val]) => { document.getElementById(i).value = val; }, [id, v]);
    await wait(150);
    await click('[data-sec="catalogue"]');
    let h = await html();
    ck('U1  unbacked section (catalogue) → "Not available yet" naming getSupplyCatalogue; NO server call', /Not available yet/.test(h) && /getSupplyCatalogue/.test(h) && !(await calls()).includes('getSupplyCatalogue'), await calls());
    await click('[data-sec="suppliers"]'); await wait(150);
    h = await html();
    ck('U2  Suppliers: rows from listSuppliers; Add supplier + New order + Call; Chat ONLY where a contactUid exists; unknown type = —', (await calls()).includes('listSuppliers') && /data-add-supplier="1"/.test(h) && /data-new-po="sup1"/.test(h) && /data-new-po="sup2"/.test(h) && /tel:0700111222/.test(h) && /data-chat="u-mw"/.test(h) && (h.match(/data-chat=/g) || []).length === 1 && !/External/.test(h), h.slice(0, 400));
    await click('[data-chat="u-mw"]');
    const opened = await page.evaluate(() => window.__opened);
    ck('U3  Chat enters SokoniInbox.openChat with the uid and name (in-app, never a second chat)', opened.length === 1 && opened[0].otherUid === 'u-mw' && opened[0].otherName === 'Mwangi Wholesalers', opened);
    await click('[data-add-supplier]');
    await fill('sup-name', 'Bidco Depot'); await fill('sup-phone', '0711000111'); await fill('sup-credit', '5000'); await fill('sup-kra', 'a123456789b');
    await click('[data-supplier-submit]'); await wait(150);
    const add = await page.evaluate(() => window.__calls.find((c) => c.name === 'addSupplier'));
    ck('U4  Add supplier → addSupplier with merchantId, name, phone, terms 30, credit 5000, KRA upper-cased; the ENGINE id shown', add && add.payload.merchantId === 'biz1' && add.payload.name === 'Bidco Depot' && add.payload.phone === '0711000111' && add.payload.paymentTerms === 30 && add.payload.creditLimit === 5000 && add.payload.kraPin === 'A123456789B' && /sup_new1/.test(await html()), add && add.payload);
    await click('[data-sec="suppliers"]'); await wait(150);
    await click('[data-new-po="sup1"]');
    await fill('po-name-0', 'Sugar 50kg'); await fill('po-qty-0', '3'); await fill('po-cost-0', '1500');
    await click('[data-po-add-line]');
    await fill('po-name-1', 'Rice 25kg'); await fill('po-qty-1', '2'); await fill('po-cost-1', '2000');
    await click('[data-po-submit]'); await wait(150);
    const po = await page.evaluate(() => window.__calls.find((c) => c.name === 'createPurchaseOrder'));
    h = await html();
    ck('U5  Place order → createPurchaseOrder {merchantId, supplierId, items×2 typed}; the ENGINE PO number + total shown, nothing client-computed', po && po.payload.supplierId === 'sup1' && po.payload.merchantId === 'biz1' && po.payload.items.length === 2 && po.payload.items[0].name === 'Sugar 50kg' && po.payload.items[0].qty === 3 && po.payload.items[0].unitCost === 1500 && po.payload.items[1].unitCost === 2000 && /PO-2026-0042/.test(h) && /4,500/.test(h) && !/8,500/.test(h), { po: po && po.payload, h: h.slice(0, 300) });
    await click('[data-sec="incoming"]'); await wait(150);
    ck('U6  Incoming orders (supplier side) render with Create invoice', /data-new-invoice="po9"/.test(await html()), (await html()).slice(0, 300));
    await click('[data-new-invoice="po9"]');
    await fill('inv-number', 'INV-77'); await fill('inv-due', '2026-10-30'); await fill('inv-amount', '12000'); await fill('inv-vat', '1920');
    await click('[data-invoice-submit]'); await wait(150);
    const inv = await page.evaluate(() => window.__calls.find((c) => c.name === 'createSupplierInvoice'));
    ck('U7  Create invoice → createSupplierInvoice {poId, invoiceNumber, invoiceDate, dueDate, amount, vatAmount}; engine number shown', inv && inv.payload.poId === 'po9' && inv.payload.invoiceNumber === 'INV-77' && inv.payload.amount === 12000 && inv.payload.vatAmount === 1920 && inv.payload.dueDate === '2026-10-30' && /^\d{4}-\d{2}-\d{2}$/.test(inv.payload.invoiceDate) && /INV-77/.test(await html()), inv && inv.payload);
    /* refusal */
    await page.evaluate(() => { window.__reply.createPurchaseOrder = () => ({ __refuse: 'functions/failed-precondition: Supplier is inactive.' }); });
    await click('[data-sec="suppliers"]'); await wait(150); await click('[data-new-po="sup2"]');
    await fill('po-name-0', 'Maize'); await fill('po-cost-0', '100');
    await click('[data-po-submit]'); await wait(150);
    h = await html();
    ck('U8  an engine refusal is shown and nothing is marked placed', /Supplier is inactive/.test(h) && !/Purchase order placed/.test(h), h.slice(-300));
    /* empty submit never calls */
    await click('[data-qf-cancel="suppliers"]'); await wait(150); await click('[data-new-po="sup2"]');
    const before = (await calls()).length;
    await click('[data-po-submit]');
    ck('U9  an empty order form is refused client-side (no call) with a plain message', (await calls()).length === before && /at least one line/.test(await html()), (await html()).slice(-200));
    ck('U10 phone width: no horizontal overflow of the module', await page.evaluate(() => document.getElementById('host').scrollWidth <= 390), await page.evaluate(() => document.getElementById('host').scrollWidth));
  } finally { await browser.close(); }

  /* ── N ── */
  const sab = src.replace(/(\{ id: 'catalogue',\s+name: '[^']*',\s+icon: '[^']*',\s+)backed: false, why: '[^']*'/, '$1backed: true');
  ck('N1  negative control: claiming the catalogue is backed makes B1 fail', check(sab).includes('catalogue:getSupplyCatalogue:absent-but-backed'), check(sab));

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
