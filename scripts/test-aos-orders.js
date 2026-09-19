/* ══════════════════════════════════════════════════════════════════════════════
   ADMINOS ORDERS WORKSPACE — certification
   scripts/test-aos-orders.js              node scripts/test-aos-orders.js

   `adminGetOrders` returns ONE key — `orders` — carrying RAW Firestore documents, capped
   at 200, newest first. No total, no facet counts, no aggregate, no prior period.

   Because the documents are raw, the field set is whatever the writers wrote, and they
   disagree: api-gateway writes orderId/buyerId/subtotal, manual-till writes
   id/uid/amount/total/orderTotal. Most of this suite is about the desk reading those
   unions and refusing the eight figures the mockup wanted but this platform cannot source
   — each paired with an inverting control.

   It also pins the live defect this page does NOT inherit: the legacy table renders
   `KES ${o.total || 0}`, so a gateway-written order displays a confident KES 0.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

global.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute () {}, appendChild () {}, style: {} }),
  head: { appendChild () {} },
};
global.window = globalThis;
const O = require(path.join(ROOT, 'sokoni-aos-orders.js'));

const host = () => ({ innerHTML: '', addEventListener () {}, querySelector: () => null,
                      querySelectorAll: () => [] });

/* The TWO shapes production actually writes, built from the writers rather than imagined. */
const tillOrder = (o) => Object.assign({
  id: 'ORD98765', uid: 'buyer-1', buyerUid: 'buyer-1', buyerName: 'Sarah Johnson',
  buyerPhone: '+254700111222', sellerUid: 'seller-9', items: [{ name: 'Shield Case', quantity: 1, unitPrice: 2799 }],
  amount: 3124, total: 3124, orderTotal: 3124, currency: 'KES', hub: 'marketplace',
  channel: 'online', fulfillmentType: 'delivery', status: 'delivered',
  paymentStatus: 'paid', paymentMethod: 'mpesa_till', paymentVerified: true,
  paymentReference: 'SJ4K2LMN01', createdAt: '2026-09-08T10:42:00Z',
}, o);
const gatewayOrder = (o) => Object.assign({
  id: 'ORD98764', orderId: 'ORD98764', buyerId: 'buyer-2', status: 'pending_payment',
  items: [{ name: 'Charger', quantity: 2, unitPrice: 890 }],
  subtotal: 1780, currency: 'KES', paymentMethod: 'mpesa',
  source: 'api-gateway', createdAt: '2026-09-07T15:15:00Z',
}, o);

/* The standing notes NAME the things this desk refuses to draw — "no Amazon integration",
   "<code>total</code>". An absence check run over the whole page therefore reads the
   explanation as the violation. Every such check runs over the page with the notes
   removed; the explanations are asserted separately, on the full markup. */
const shownOnly = h => h.replace(/<div class="odx-note">[\s\S]*?<\/div>/g, '');

function draw (orders, over) {
  const h = host();
  O._render(h, Object.assign(
    { orders, q: '', qRaw: '', status: 'all', channel: 'all', open: null, can: { status: true } },
    over));
  return h.innerHTML;
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  ADMINOS ORDERS WORKSPACE');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. THE EIGHT FIGURES WITH NO SOURCE ────────────────────────────────────── */
head('1 - what this platform cannot source is not drawn');
{
  const html = draw([tillOrder(), gatewayOrder()]);
  const shown = shownOnly(html);   /* the notes NAME what is refused — see shownOnly */

  ok('no month-on-month change is rendered', !/vs last month|[↑↓]\s*\d/i.test(shown));
  ok('no percentage figure is rendered', !/\d+(\.\d+)?%/.test(shown));
  ok('no sparkline or chart element is emitted', !/<svg|<canvas|sparkline|polyline/i.test(shown));

  /* NO CARD BRANDS. Payment here is M-PESA and IntaSend. */
  ok('no card brand is rendered', !/\b(visa|mastercard|amex|american express)\b/i.test(shown));
  ok('no masked card number is rendered', !/••••|\*{4}\s*\d{4}|•{4}/.test(shown));
  ok('no wallet brand is invented', !/\b(apple pay|shop pay|paypal|google pay)\b/i.test(shown));

  /* NO CARRIERS AND NO SIGNATURE. */
  ok('no courier is named', !/\b(fedex|ups|usps|dhl)\b/i.test(shown));
  ok('no signature capture is claimed', !/signed by/i.test(shown));

  /* NO MARKETPLACE CHANNELS. */
  ok('no storefront integration is named',
     !/\b(amazon|ebay|walmart|tiktok shop|shopify pos|etsy)\b/i.test(shown));

  /* NO PLATFORM TOTAL — asserted on the LABEL element, so the prose explaining that there
     is no total cannot satisfy it. */
  const labels = [...html.matchAll(/class="odx-stat-l">([^<]+)</g)].map(m => m[1]);
  ok('control — stat labels were found', labels.length >= 5, labels.join(' · '));
  ok('the first stat is "Loaded", not "Total"', labels[0] === 'Loaded', labels[0]);
  ok('no stat label claims a platform total', !labels.some(l => /^total\b/i.test(l)));
  ok('every stat states its scope', (html.match(/odx-stat-s/g) || []).length === labels.length);

  /* NO GROSS REVENUE — the word must not label a sum of order documents. */
  ok('no stat is labelled revenue', !labels.some(l => /revenue/i.test(l)));
  ok('the value stat names what it measures', labels.some(l => /value of loaded orders/i.test(l)));

  /* And the page says why, so none of it is re-added later. */
  ok('it explains there is no prior-period figure', /no prior-period figure exists/.test(html));
  ok('it explains value is not revenue', /not revenue/.test(html));
  ok('it explains why there is no card brand', /card brand or last four/.test(html));
  ok('it explains why there is no carrier', /no carrier and no signature/i.test(html));
  ok('it explains the multi-writer shape', /more than one producer/.test(html));

  /* INVERTING CONTROLS — real derived figures ARE rendered. */
  ok('control — the loaded count is real', /odx-stat-n">2</.test(html));
  ok('control — a real currency total is rendered', /KES\s*4,904/.test(html), 'KES 3,124 + 1,780');
  ok('control — fulfilled is derived from status', /odx-stat-n">1<\/div><div class="odx-stat-l">Fulfilled/.test(html));
}

/* ── 2. THE DEFECT THIS PAGE DOES NOT INHERIT ───────────────────────────────── */
head('2 - an order with no `total` is not worth zero');
{
  /* The gateway writes `subtotal` and no `total`. The legacy table renders `o.total || 0`. */
  const legacy = read('sokoni-aos.js');
  ok('control — the legacy table still renders the zero-coalesced total',
     /KES \$\{_fmt\(o\.total\|\|0\)\}/.test(legacy));

  const g = draw([gatewayOrder()]);
  ok('this desk does not print a zero for it', !/KES\s*0\b/.test(g));
  ok('it reads the subtotal instead', /KES\s*1,780/.test(g));
  /* And names the field, because subtotal is not total. */
  ok('and names the field it came from', />subtotal</.test(g));
  ok('control — a `total` is NOT annotated', !/>total</.test(shownOnly(draw([tillOrder()]))));

  ok('the money precedence is declared in code',
     /MONEY_FIELDS\s*=\s*\['total', 'orderTotal', 'amount', 'grandTotal', 'subtotal'\]/
       .test(strip(read('sokoni-aos-orders.js'))));

  /* An order with NO money field at all says so rather than showing any number. */
  const none = draw([gatewayOrder({ subtotal: undefined })]);
  ok('an order with no recorded value says so', none.indexOf('not recorded') > -1);
  ok('and still prints no zero', !/KES\s*0\b/.test(none));
  ok('control — _money returns null for it', O._money({ currency: 'KES' }) === null);
  ok('control — _money reads the union', O._money({ amount: 50 }).field === 'amount');
}

/* ── 3. THE FIELD UNIONS THE WRITERS ACTUALLY USE ───────────────────────────── */
head('3 - the same spellings order-advance-authority reads');
{
  const auth = read('functions/order-advance-authority.js');
  const mod = strip(read('sokoni-aos-orders.js'));

  /* The authority is the source of truth for these unions; the desk must not invent a
     ninth spelling. */
  ok('control — the authority declares its unions', /SELLER_FIELDS|BUYER_FIELDS/.test(auth));
  ['sellerUid', 'sellerId', 'vendorId'].forEach(f =>
    ok('seller union includes ' + f, mod.indexOf("'" + f + "'") > -1));
  ['riderId', 'riderUid', 'driverId', 'assignedRider'].forEach(f =>
    ok('rider union includes ' + f, mod.indexOf("'" + f + "'") > -1));
  ['buyerId', 'uid', 'userId', 'customerId'].forEach(f =>
    ok('buyer union includes ' + f, mod.indexOf("'" + f + "'") > -1));

  /* Reading, never writing. */
  ok('the module performs no read of its own', !/_call\(|collection\(|httpsCallable/.test(mod));
  ok('and no write', !/\.set\(|\.update\(|\.add\(/.test(mod));

  /* A buyer known only by uid is MARKED, so an identifier is never read as a name. */
  const byId = draw([gatewayOrder()]);
  ok('a buyer with no name shows the identifier', byId.indexOf('buyer-2') > -1);
  ok('and it is marked as not a name', /odx-c-n--derived/.test(byId));
  ok('control — a real name is not marked', !/odx-c-n--derived/.test(draw([tillOrder()])));
  ok('an order with no party at all says so',
     draw([{ id: 'x', status: 'pending' }]).indexOf('No customer recorded') > -1);

  /* The detail must not answer "not recorded" twice for a buyer it CAN identify. */
  const d = draw([gatewayOrder()], { open: 'ORD98764' });
  ok('the detail shows the account identifier', d.indexOf('>Account<') > -1 && d.indexOf('buyer-2') > -1);
  ok('and distinguishes a missing NAME from a missing buyer', /no name on the order/.test(d));
  ok('control — an order with no buyer field says so',
     /no buyer recorded/.test(draw([{ id: 'x', status: 'pending' }], { open: 'x' })));
  /* The spelling is named when it is not the canonical one, because the writers disagree. */
  ok('a non-canonical buyer field is named',
     /<small>uid<\/small>/.test(draw([{ id: 'x', uid: 'u-9', status: 'pending' }], { open: 'x' })));
  ok('control — the canonical spelling is not annotated',
     !/<small>buyerId<\/small>/.test(d));
}

/* ── 4. ABSENT IS UNKNOWN, NOT NEGATIVE ─────────────────────────────────────── */
head('4 - a flag the writer never set is not a "no"');
{
  const open = { open: 'ORD98764' };
  const g = draw([gatewayOrder()], open);
  /* The gateway writer sets no paymentVerified at all. */
  ok('an absent verification flag is not rendered as "no"', /records no verification flag/.test(g));
  ok('control — a false flag IS rendered as no',
     /<span>Verified<\/span><b>no<\/b>/.test(draw([tillOrder({ paymentVerified: false })], { open: 'ORD98765' })));
  ok('control — a true flag is rendered as yes',
     /<span>Verified<\/span><b>yes<\/b>/.test(draw([tillOrder()], { open: 'ORD98765' })));

  /* Money lines are listed only when present — never a printed zero for an absent line. */
  ok('an absent shipping line is not printed as zero', !/<span>shipping<\/span>/.test(g));
  ok('control — a present shipping line IS printed',
     /<span>shipping<\/span>/.test(draw([tillOrder({ shipping: 200 })], { open: 'ORD98765' })));
  ok('control — a genuine zero shipping is printed, not hidden',
     /<span>shipping<\/span>/.test(draw([tillOrder({ shipping: 0 })], { open: 'ORD98765' })));

  ok('an undelivered order says so, not "—"',
     draw([gatewayOrder()]).indexOf('not dispatched') > -1);
  ok('a missing tracking code is named', /no tracking code/.test(g));
  ok('a missing date is named', draw([gatewayOrder({ createdAt: null })]).indexOf('not recorded') > -1);
}

/* ── 5. STATUS COMES FROM THE DATA, NOT FROM A MOCKUP ───────────────────────── */
head('5 - the real stage vocabulary, and anything else rendered verbatim');
{
  const auth = read('functions/order-advance-authority.js');
  const mod = strip(read('sokoni-aos-orders.js'));
  /* Every stage the authority governs must be tonable, or a real order renders untyped. */
  ['accepted', 'preparing', 'ready', 'assigned', 'picked_up', 'delivered', 'completed']
    .forEach(s => {
      ok('stage "' + s + '" is known to the desk', mod.indexOf("'" + s + "'") > -1);
      ok('control — and to the authority', auth.indexOf(s + ':') > -1);
    });

  ok('delivered reads as complete', O._statusTone('delivered') === 'ok');
  ok('preparing reads as in flight', O._statusTone('preparing') === 'info');
  ok('pending_payment reads as waiting', O._statusTone('pending_payment') === 'warn');
  ok('cancelled reads as bad', O._statusTone('cancelled') === 'bad');
  /* An unknown status from a writer nobody has catalogued must still render. */
  ok('an uncatalogued status is neutral, not dropped', O._statusTone('quantum_flux') === 'muted');
  ok('and it still appears in the table',
     draw([tillOrder({ status: 'quantum_flux' })]).indexOf('quantum flux') > -1);

  /* Tabs are derived from the loaded page. */
  const tabs = draw([tillOrder(), gatewayOrder(), gatewayOrder({ id: 'z' })]);
  ok('a status tab carries the loaded count',
     tabs.indexOf('data-v="pending_payment">pending payment <span>2</span>') > -1);
  ok('the All tab counts the page', tabs.indexOf('data-v="all">All <span>3</span>') > -1);
  ok('no tab is rendered for a status not on the page', !/data-v="refunded"/.test(tabs));
}

/* ── 6. SAFETY ──────────────────────────────────────────────────────────────── */
head('6 - hostile order content cannot reach the DOM');
{
  const x = '<img src=x onerror=alert(1)>';
  const html = draw([tillOrder({
    id: x, buyerName: x, status: x, paymentMethod: x, channel: x, trackingCode: x,
    items: [{ name: x, quantity: x, unitPrice: 1 }],
  })], { open: x });
  ok('every field is escaped', html.indexOf('<img') === -1);
  ok('the payload is present but inert', html.indexOf('&lt;img') > -1);
  ok('the id is escaped in every action attribute', !/data-id="[^"]*</.test(html));
  ok('initials from a hostile name do not inject', O._buyerOf({ buyerName: x }).text.indexOf('<') > -1
     && html.indexOf('<img') === -1);
}

/* ── 7. ONE WRITER, AND NO REFUND BUTTON ────────────────────────────────────── */
head('7 - the desk offers exactly one write, and it is not a refund');
{
  const mod = read('sokoni-aos-orders.js');
  const src = strip(mod);

  ok('a status change delegates', /A0\.updateStatus/.test(src));
  ok('capability is derived from the action supplied',
     /can: \{ status: !!A0\.updateStatus \}/.test(src));
  ok('no status button when the host owns no action',
     !/data-odx="advance"/.test(draw([tillOrder()], { open: 'ORD98765', can: { status: false } })));
  ok('control — the button IS rendered when it is owned',
     /data-odx="advance"/.test(draw([tillOrder()], { open: 'ORD98765' })));

  /* THE REFUND BOUNDARY. On this platform a refundRequests document credits a wallet on
     creation, so there must be no control here that creates one. Asserted on STRIPPED
     code, because the header explains at length why the button is absent. */
  ok('no refund control exists', !/data-odx="refund"|refundRequest/i.test(src));
  ok('the desk never names the refund collection', !/refundRequests/.test(src));
  ok('control — the page explains why in prose', /refund request/i.test(mod));
  ok('control — the refund rail really is creation-triggered',
     /credits a wallet on creation|auto-credit/i.test(mod));

  /* The one write goes to the callable AdminOS already owns. */
  const aos = read('sokoni-aos.js');
  ok('the host delegates to its existing updateOrder', /updateStatus: \(id\) => updateOrder\(id\)/.test(aos));
  ok('and that action still calls adminUpdateOrderStatus',
     /adminUpdateOrderStatus/.test(aos));
  ok('no second order writer was introduced',
     (aos.match(/adminUpdateOrderStatus/g) || []).length <= 2);
}

/* ── 8. ADDITIVE ────────────────────────────────────────────────────────────── */
head('8 - the Orders tab still works without this module');
{
  const mod = strip(read('sokoni-aos-orders.js'));
  ok('it declines rather than throwing',
     /if \(!host \|\| !Array\.isArray\(o\.orders\)\) return false;/.test(mod));
  ok('listeners are unbound before a remount rebinds them', /host\.__odxOff/.test(mod));
  ok('every listener goes through the tracked binder', !/host\.addEventListener\('/.test(mod));

  const aos = read('sokoni-aos.js');
  ok('the legacy table is still present', /No orders<\/|_emptyMsg\("No orders"\)/.test(aos));
  ok('the rich view is tried first and falls through on error',
     /SokoniAOSOrders[\s\S]{0,900}catch[\s\S]{0,140}using table/.test(aos));
  ok('the read is no longer capped below the contract', /adminGetOrders", \{ limit: 200 \}/.test(aos));

  const html = read('admin-os.html');
  ok('admin-os.html loads the module before the shell',
     html.indexOf('sokoni-aos-orders.js') > -1 &&
     html.indexOf('sokoni-aos-orders.js') < html.indexOf('<script src="sokoni-aos.js">'));
  ok('no new sidebar entry was added — Orders lives in the section it already had',
     (html.match(/data-section="orders"/g) || []).length === 0);
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  live callable responses       [proven by loading admin-os.html]');
console.log('  UNPROVEN  the order collection\'s full shape census   [writers disagree; 2 pinned here]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
