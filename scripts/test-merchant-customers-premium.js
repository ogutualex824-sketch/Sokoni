#!/usr/bin/env node
/**
 * MERCHANT CUSTOMERS — the premium surface, rendered and inspected.
 *
 *   node scripts/test-merchant-customers-premium.js
 *
 * The module is MOUNTED against a fake DOM and fixture data, and the assertions read
 * the HTML it actually produced. A stylesheet check would prove only that a string
 * exists; this proves the surface renders, groups, filters and — most importantly —
 * invents no figure.
 *
 * THE DATA-INTEGRITY LINE: the summary shows only what getCRMDashboard returned. The
 * one derived thing is the ladder BAR WIDTH, relative to the largest spend on screen.
 * That is a rendering of real values, so it carries no number and no label, and it is
 * omitted when there is nothing to compare against.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

/* ── a DOM just real enough to mount into ───────────────────────────────────── */
function makeEl (tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: '', className: '', innerHTML: '',
    textContent: '', style: {}, children: [], attributes: {},
    ownerDocument: null,
    setAttribute (k, v) { this.attributes[k] = String(v); },
    getAttribute (k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    appendChild (c) { this.children.push(c); return c; },
    addEventListener () {}, removeEventListener () {}, querySelector () { return null; },
    querySelectorAll () { return []; }, closest () { return null; }, focus () {},
    classList: { add () {}, remove () {}, contains () { return false; }, toggle () {} },
  };
  return el;
}
function makeDoc () {
  const doc = {
    head: makeEl('head'), documentElement: makeEl('html'), body: makeEl('body'),
    createElement: (t) => { const e = makeEl(t); e.ownerDocument = doc; return e; },
    getElementById: () => null,
    addEventListener () {}, querySelector () { return null }, querySelectorAll () { return [] },
  };
  doc.head.ownerDocument = doc; doc.body.ownerDocument = doc;
  return doc;
}

/* ── load both modules into one sandbox ─────────────────────────────────────── */
function loadUI () {
  const doc = makeDoc();
  const sandbox = {
    console, setTimeout, clearTimeout, Math, JSON, Date, String, Number, Array, Object,
    isNaN, parseInt, parseFloat, encodeURIComponent, document: doc,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ['sokoni-merchant-customers.js', 'sokoni-merchant-customers-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return { sandbox, doc };
}

/* Fixture: four segments, distinct spends, one with no last order. */
const CUSTOMERS = [
  { uid: 'c1', name: 'Grace Wanjiru', phone: '0712000001', segment: 'vip',
    totalSpend: 120000, orderCount: 31, clv: 240000, lastOrderAt: Date.now() - 86400000 },
  { uid: 'c2', name: 'Otieno Odhiambo', phone: '0712000002', segment: 'regular',
    totalSpend: 30000, orderCount: 7, clv: 60000, lastOrderAt: Date.now() - 5 * 86400000 },
  { uid: 'c3', name: 'Amina Yusuf', phone: '0712000003', segment: 'first_time',
    totalSpend: 1500, orderCount: 1, clv: 3000, lastOrderAt: null },
  { uid: 'c4', name: 'Peter Kimani', phone: '0712000004', segment: 'regular',
    totalSpend: 0, orderCount: 0, clv: 0, lastOrderAt: null },
];

function render (opts) {
  const o = opts || {};
  const { sandbox, doc } = loadUI();
  const UI = sandbox.SokoniMerchantCustomersUI;
  const MC = sandbox.SokoniMerchantCustomers;
  if (!UI || !MC) return { err: 'modules did not load', UI, MC };
  const host = doc.createElement('div');
  const rows = (o.customers === undefined) ? CUSTOMERS : o.customers;
  const api = UI.mount(host, {
    scope: { ok: true, sellerUid: 'S1', shopId: 'SHOP1' },
    db: { queryProfiles: async () => rows },
    shopName: 'Bravilex',
    callDashboard: o.dashboard ? (async () => ({ data: o.dashboard })) : undefined,
    callProfile: undefined,
  });
  return { sandbox, doc, host, api, MC, UI };
}

console.log('\nMERCHANT CUSTOMERS — PREMIUM SURFACE\n' + '='.repeat(64));

(async () => {
  head('1 · it mounts and renders');
  const r = render();
  ck('both modules loaded', !r.err, r.err || 'ok');
  if (r.err) { console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); }
  ck('mount returned an api', !!r.api);
  await new Promise((res) => setTimeout(res, 30));
  const html = r.host.innerHTML;
  ck('it painted something', html.length > 200, html.length + ' chars');

  head('2 · the premium structure is present');
  ck('search box', /id="mcu-q"/.test(html));
  ck('segment FILTER chips', /class="mcu-filters"/.test(html) && /data-act="seg"/.test(html));
  ck('...built from segments actually present, not a fixed list',
     /data-seg="vip"/.test(html) && /data-seg="regular"/.test(html) &&
     !/data-seg="high_value"/.test(html),
     'high_value is absent from the fixture, so it must not be offered');
  ck('group headers', /class="mcu-grp/.test(html));
  ck('...VIP is ordered before regular',
     html.indexOf('VIP') > -1 && html.indexOf('VIP') < html.indexOf('Regular'),
     'a merchant scans for their best customers first');
  ck('the spend LADDER is drawn', /class="mcu-ladder"/.test(html));
  ck('last-order recency appears', /class="mcu-when"/.test(html));
  ck('every row is still a real button with an index',
     (html.match(/data-act="open" data-i="/g) || []).length === CUSTOMERS.length,
     (html.match(/data-act="open"/g) || []).length + ' rows');

  head('3 · DATA INTEGRITY — nothing is invented');
  const widths = (html.match(/width:(\d+)%/g) || []).map((x) => parseInt(x.replace(/\D/g, ''), 10));
  ck('the widest ladder is the largest spender', widths.length ? Math.max.apply(null, widths) === 100 : false,
     widths.join(','));
  ck('the ladder carries NO number and NO label',
     !/mcu-ladder[^>]*>[^<]*\d/.test(html) && /aria-hidden="true"/.test(html),
     'it is a rendering of real values, never a claimed statistic');
  ck('no summary tile is shown when the dashboard returned nothing',
     !/class="mcu-kpi"/.test(html),
     'a total over a 500-row page is not a total');
  ck('a zero spend renders as a real zero, not a blank',
     /KES\s*0|0\.00|Ksh\s*0/i.test(html) || /class="v">[^<]*0/.test(html), 'Peter Kimani has spent 0');

  head('4 · the ladder disappears when there is nothing to compare');
  {
    const one = render({ customers: [CUSTOMERS[0]] });
    await new Promise((res) => setTimeout(res, 30));
    const h1 = one.host.innerHTML;
    ck('one customer ⇒ no ladder', !/class="mcu-ladder"/.test(h1));
    ck('one customer ⇒ no filter chips either', !/class="mcu-filters"/.test(h1),
       'a filter that can only return everything is noise');
    ck('...but the row still renders', /data-act="open"/.test(h1));
  }
  {
    const zeros = render({ customers: CUSTOMERS.map((c) => Object.assign({}, c, { totalSpend: 0 })) });
    await new Promise((res) => setTimeout(res, 30));
    ck('all-zero spend ⇒ no ladder, rather than four empty bars',
       !/class="mcu-ladder"/.test(zeros.host.innerHTML));
  }

  head('5 · the states that existed before still exist');
  {
    const { sandbox, doc } = loadUI();
    const host = doc.createElement('div');
    sandbox.SokoniMerchantCustomersUI.mount(host, { scope: { ok: false }, db: {} });
    await new Promise((res) => setTimeout(res, 20));
    ck('no signed-in scope ⇒ the sign-in state, not a crash',
       /Sign in to see your customers/.test(host.innerHTML), host.innerHTML.slice(0, 60));
  }
  {
    const { sandbox, doc } = loadUI();
    const host = doc.createElement('div');
    sandbox.SokoniMerchantCustomersUI.mount(host, {
      scope: { ok: true, sellerUid: 'S1' },
      db: { queryProfiles: async () => { throw new Error('permission-denied'); } },
    });
    await new Promise((res) => setTimeout(res, 30));
    const h = host.innerHTML;
    ck('a refusal is REPORTED, never rendered as "no customers"',
       /could not be loaded/.test(h) && /permission-denied/.test(h), h.slice(0, 80));
    ck('...and offers a retry', /data-act="reload"/.test(h));
  }
  {
    const empty = render({ customers: [] });
    await new Promise((res) => setTimeout(res, 30));
    ck('an empty account explains itself', /No customer profiles yet/.test(empty.host.innerHTML));
  }

  head('6 · house style — it inherits the shell, it does not fork it');
  {
    const css = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-customers-ui.js'), 'utf8');
    ck('uses the shell tokens', /var\(--panel\)/.test(css) && /var\(--acc\)/.test(css) && /var\(--line\)/.test(css));
    ck('respects reduced motion', /prefers-reduced-motion/.test(css));
    ck('touch targets stay >= 44px', /min-height:44px|height:48px|min-height:48px/.test(css));
    ck('CONTROL no hard-coded page background that would fight the theme',
       !/background:#(fff|000)\b/i.test(css));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
