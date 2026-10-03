#!/usr/bin/env node
/**
 * test-invoice-honest-summary.js  (node only — no browser, no network, no emulator)
 *
 * Owner decision 2026-10-03: invoice.html is an HONEST ORDER SUMMARY, not a tax invoice.
 * It shows only facts the stored order record carries (else "—"), carries the visible line
 * "Order summary — not a KRA eTIMS tax invoice.", and makes no KRA / VAT / ETR / eTIMS / fee /
 * payout / "paid" claim. VAT is never inferred; unknown is never rendered as 0 or a guess.
 *
 * Method: the page's main inline <script> is executed in a vm sandbox with a fake DOM and a
 * fake localStorage, generateInvoice() is called on fixture orders, and the REACHABLE text
 * (static body markup + every rendered element + document titles) is inspected.
 *
 * Sections:
 *   A. Static: disclaimer verbatim and inside the printed shell; no kraPinSaved / SokoniCommission;
 *      download title + filename.
 *   B. Rendered: forbidden claims absent (one named row per claim), fact mapping per field.
 *   C. Negative controls: (1) re-insert the old "VAT @ 16%" totals row -> the named VAT row
 *      fails; (2) default unknown status to "PAID" -> the unknown-status row fails;
 *      (3) the pre-change page (git 923cce8) fails rows (positive control on the detector).
 *
 * Exit 0 = all pass, 1 = any failure (fails closed: a crash or missing control is a FAIL).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILE = 'invoice.html';
const DISCLAIMER = 'Order summary — not a KRA eTIMS tax invoice.';
const DASH = '—';

/* Each forbidden claim is its own named row so a regression names what came back. */
const FORBIDDEN = [
  ['KRA', /\bKRA\b/i],
  ['VAT', /\bVAT\b/i],
  ['ETR', /\bETR\b/i],
  ['eTIMS', /etims/i],
  ['Tax Invoice', /tax\s+invoice/i],
  ['tax (any)', /\btax\b/i],
  ['FREE', /\bfree\b/i],
  ['12%', /12\s*%/],
  ['PAYMENT RECEIVED', /payment\s+received/i],
  ['PAID', /\bpaid\b/i],
  ['M-PESA default', /M-PESA/i],
  ['platform fee', /platform\s+fee/i],
  ['payout', /payout/i],
  ['PIN', /\bPIN\b/],
  ['Valued Customer', /valued\s+customer/i],
  ['Verified/Sokoni Seller default', /(verified|sokoni)\s+seller/i],
  ['NaN', /\bNaN\b/],
];

const decode = s => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const textOf = html => decode(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ').trim();

function mainScript(src) {
  const all = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const s = all.find(b => b.includes('function generateInvoice'));
  if (!s) throw new Error('main inline script not found');
  return s;
}

/* Static, visible text: body markup minus scripts/styles/comments, plus <title>s. */
function staticText(src) {
  const body = (src.match(/<body>([\s\S]*)<\/body>/) || ['', ''])[1];
  const titles = [...src.matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]).join(' ');
  return textOf(body) + ' ' + titles;
}

/* Run the page script against `orders`; return { el(id), reads, rendered, run(id) }. */
function makePage(src, orders, search = '') {
  const els = {};
  const mk = id => ({ id, textContent: '', _html: '', className: '', style: {}, dataset: {},
    children: [], appendChild(c) { this.children.push(c); },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; } });
  const reads = [];
  const store = { sokoniOrders: JSON.stringify(orders), kraPinSaved: 'A000000000Z' };
  const ctx = {
    console, URLSearchParams, Blob: function () {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    localStorage: { getItem(k) { reads.push(k); return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem() {}, removeItem() {} },
    document: {
      getElementById(id) { return els[id] || (els[id] = mk(id)); },
      querySelector() { return mk('_q'); },
      createElement() { return mk('_c'); },
      styleSheets: [], body: mk('_body'),
    },
    location: { search },
    /* Present so the PRE-CHANGE page (positive control) can render rather than crash. */
    SokoniCommission: { pct: () => 12 },
    alert() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(mainScript(src), ctx, { filename: FILE });
  const rendered = () => Object.values(els).map(e =>
    [e.textContent, textOf(e._html), ...e.children.map(c => c.textContent)].join(' ')).join(' ');
  return { ctx, el: id => els[id] || mk(id), reads, rendered, run: id => ctx.generateInvoice(id) };
}

const FULL = { id: 'ORD-FULL', date: '3 Oct 2026', total: 1200, deliveryFee: 150, status: 'delivered',
  name: 'Amina W', address: 'Kisumu', phone: '0700000000',
  items: [{ name: 'Lamp', category: 'home', price: 350, qty: 3, sellerName: 'Mwangi Hardware', image: 'assets/x.png' }] };
const SPARSE = { id: 'ORD-SPARSE', items: [{ name: 'Cup', price: 100 }, { name: 'Plate', price: 250 }] };
const ODD = { id: 'ORD-ODD', status: 'refunded_maybe', deliveryFee: '200', total: '999', method: 'mpesa',
  items: [{ name: 'Mug', price: 80, quantity: 2 }, { name: 'Bowl', price: '90', qty: 1 }] };
const ZERO = { id: 'ORD-ZERO', status: 'placed', deliveryFee: 0, total: 500, items: [] };

/* All checks; returns [{name, ok, detail}] so negative controls can look up a NAMED row. */
function checkPage(src) {
  const rows = [];
  const row = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  const guard = (name, fn) => { try { fn(); } catch (e) { row(name + ' (crashed)', false, e && e.message); } };

  /* A. static */
  guard('A', () => {
    row('A1 disclaimer present verbatim', src.includes(DISCLAIMER));
    const shell = (src.match(/<div class="invoice-shell"[\s\S]*?<div class="inv-status-ribbon/) || [''])[0];
    row('A2 disclaimer is inside the printed/downloaded shell', shell.includes(DISCLAIMER));
    const code = mainScript(src).replace(/\/\*[\s\S]*?\*\//g, '');
    row('A3 no kraPinSaved read in page code', !/kraPinSaved/.test(code));
    row('A4 no SokoniCommission use in page code', !/SokoniCommission/.test(code));
    row('A5 download title is "SOKONI Order summary"', /<title>SOKONI Order summary<\/title>/.test(code));
    row('A6 download filename is sokoni-order-summary.html', /a\.download\s*=\s*"sokoni-order-summary\.html"/.test(code));
    row('A7 page <title> is an order summary', /<title>SOKONI — Order summary<\/title>/.test(src));
  });

  /* B. rendered */
  guard('B', () => {
    const fixtures = [FULL, SPARSE, ODD, ZERO];
    const pg = makePage(src, fixtures);
    let reach = staticText(src) + ' ' + pg.rendered();
    for (const f of [FULL, SPARSE, ZERO]) { pg.run(f.id); reach += ' ' + pg.rendered(); }
    const scan = reach.split(DISCLAIMER).join(' ');
    for (const [label, re] of FORBIDDEN) {
      const m = scan.match(re);
      row(`B1 no "${label}" text reachable`, !m, m ? '…' + scan.slice(Math.max(0, m.index - 40), m.index + 40) + '…' : '');
    }
    row('B2 page code never read kraPinSaved at runtime', !pg.reads.includes('kraPinSaved'), pg.reads.join(','));
    row('B3 picker: missing total renders "—" (not NaN/0)', /ORD-SPARSE[^]*?—/.test(textOf(pg.el('orderPickerList').innerHTML)) &&
      !/NaN/.test(pg.el('orderPickerList').innerHTML));

    /* FULL: every field from the record */
    pg.run('ORD-FULL');
    const items = () => textOf(pg.el('invItemsBody').innerHTML);
    const totals = () => textOf(pg.el('invTotalsBox').innerHTML);
    row('B4 date from record', pg.el('invDate').textContent === '3 Oct 2026', pg.el('invDate').textContent);
    row('B5 buyer name from record', pg.el('invBuyerName').textContent === 'Amina W', pg.el('invBuyerName').textContent);
    row('B6 buyer address/phone from record', /Kisumu/.test(pg.el('invBuyerDetail').textContent) && /0700000000/.test(pg.el('invBuyerDetail').textContent));
    row('B7 seller name from items', pg.el('invSellerName').textContent === 'Mwangi Hardware', pg.el('invSellerName').textContent);
    row('B8 qty from record (3) and line total = price x qty', /KES 350 3 KES 1,050/.test(items()), items());
    row('B9 order total = o.total', /Order total KES 1,200/.test(totals()), totals());
    row('B10 numeric deliveryFee shown', /Delivery fee KES 150/.test(totals()), totals());
    row('B11 known status label is neutral', pg.el('invRibbon').textContent === 'DELIVERED', pg.el('invRibbon').textContent);
    row('B12 order status text matches ribbon', pg.el('invStatusText').textContent === 'DELIVERED', pg.el('invStatusText').textContent);

    /* SPARSE: nothing invented */
    pg.run('ORD-SPARSE');
    row('B13 missing total -> "—" (not the 350 item sum)', /Order total —/.test(totals()) && !/350/.test(totals()), totals());
    row('B14 missing deliveryFee -> "—" (not FREE/0)', /Delivery fee —/.test(totals()), totals());
    row('B15 missing qty -> "—" and no line total (no assumed 1)', /Cup — KES 100 — —/.test(items()) && !/KES 100 1 /.test(items()), items());
    row('B16 missing status -> STATUS UNKNOWN', pg.el('invRibbon').textContent === 'STATUS UNKNOWN', pg.el('invRibbon').textContent);
    row('B17 missing method -> "—" (no M-PESA default)', pg.el('invPayMethod').textContent === DASH, pg.el('invPayMethod').textContent);
    row('B18 missing buyer -> "—" (no Valued Customer)', pg.el('invBuyerName').textContent === DASH && pg.el('invBuyerDetail').textContent === DASH,
      pg.el('invBuyerName').textContent + '|' + pg.el('invBuyerDetail').textContent);
    row('B19 missing seller -> "—"', pg.el('invSellerName').textContent === DASH, pg.el('invSellerName').textContent);
    row('B20 missing date -> "—" (not today)', pg.el('invDate').textContent === DASH, pg.el('invDate').textContent);

    /* ODD: wrong types are unknowns, unknown status is unknown */
    pg.run('ORD-ODD');
    row('B21 unknown status -> STATUS UNKNOWN', pg.el('invRibbon').textContent === 'STATUS UNKNOWN' &&
      /ribbon-unknown/.test(pg.el('invRibbon').className), pg.el('invRibbon').textContent + ' ' + pg.el('invRibbon').className);
    row('B22 string deliveryFee -> "—" (shown only when numeric)', /Delivery fee —/.test(totals()), totals());
    row('B23 string total -> "—"', /Order total —/.test(totals()), totals());
    row('B24 quantity field honoured (2 x 80 = 160)', /Mug — KES 80 2 KES 160/.test(items()), items());
    row('B25 string price -> "—" and no line total', /Bowl — — 1 —/.test(items()), items());
    row('B26 method mapped as-is uppercase', pg.el('invPayMethod').textContent === 'MPESA', pg.el('invPayMethod').textContent);

    /* ZERO: a real canonical 0 is shown as 0 */
    pg.run('ORD-ZERO');
    row('B27 canonical deliveryFee 0 shown as KES 0', /Delivery fee KES 0/.test(totals()), totals());
    row('B28 placed -> ORDER PLACED', pg.el('invRibbon').textContent === 'ORDER PLACED', pg.el('invRibbon').textContent);

    /* Every known status label: no payment-received claim */
    const st = makePage(src, ['pending_payment', 'placed', 'processing', 'shipped', 'out_for_delivery', 'delivered']
      .map(s => ({ id: 'S-' + s, status: s, items: [] })));
    const labels = ['pending_payment', 'placed', 'processing', 'shipped', 'out_for_delivery', 'delivered']
      .map(s => { st.run('S-' + s); return st.el('invRibbon').textContent; });
    row('B29 no status label claims payment', labels.every(l => !/paid|received/i.test(l)), labels.join(' | '));

    /* URL param path runs after constants initialise (no TDZ crash) */
    let urlOk = true, urlErr = '';
    try { const u = makePage(src, [FULL], '?order=ORD-FULL'); urlOk = u.el('invRibbon').textContent === 'DELIVERED'; }
    catch (e) { urlOk = false; urlErr = e.message; }
    row('B30 ?order= deep link renders', urlOk, urlErr);

    /* escaping kept */
    const x = makePage(src, [{ id: 'X', items: [{ name: '<b>n</b>', price: 1, qty: 1, image: 'x" onerror="1' }] }]);
    x.run('X');
    row('B31 item name still escaped', !/<b>/.test(x.el('invItemsBody').innerHTML) && /&lt;b&gt;/.test(x.el('invItemsBody').innerHTML));
  });
  return rows;
}

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label); } };
const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

console.log('A/B. invoice.html (working tree)');
for (const r of checkPage(src)) ok(r.ok, r.name + (r.ok || !r.detail ? '' : ' :: ' + r.detail));

console.log('C. negative controls');
{
  const anchor = '<div class="inv-total-row"><span class="inv-total-label">Delivery fee</span>';
  const oldVat = '<div class="inv-total-row"><span class="inv-total-label" style="color:#e07000;">VAT @ 16%</span><span class="inv-total-val" style="color:#e07000;">KES 1</span></div>\n    ';
  ok(src.includes(anchor), 'C1 totals anchor located');
  const r1 = checkPage(src.replace(anchor, oldVat + anchor));
  const vatRow = r1.find(r => r.name === 'B1 no "VAT" text reachable');
  ok(vatRow && !vatRow.ok, 'C1 re-inserted old VAT line -> row "B1 no "VAT" text reachable" FAILS :: ' + (vatRow ? vatRow.detail : '(row missing)'));

  const stAnchor = 'const _INV_STATUS_UNKNOWN = { label:"STATUS UNKNOWN"';
  ok(src.includes(stAnchor), 'C2 unknown-status anchor located');
  const r2 = checkPage(src.replace(stAnchor, 'const _INV_STATUS_UNKNOWN = { label:"PAID"'));
  const stRow = r2.find(r => r.name === 'B21 unknown status -> STATUS UNKNOWN');
  const paidRow = r2.find(r => r.name === 'B1 no "PAID" text reachable');
  ok(stRow && !stRow.ok && paidRow && !paidRow.ok, 'C2 default "PAID" -> rows B21 and B1 "PAID" FAIL');

  let old = null;
  try { old = execFileSync('git', ['show', '923cce8:invoice.html'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (_) { old = null; }
  ok(old !== null, 'C3 pre-change page (923cce8) available as a positive control');
  if (old !== null) {
    const r3 = checkPage(old);
    const bad = r3.filter(r => !r.ok).map(r => r.name);
    ok(bad.length >= 10, `C3 pre-change page FAILS ${bad.length} rows (expected >= 10): ${bad.slice(0, 12).join('; ')}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
