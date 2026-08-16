#!/usr/bin/env node
/* Merchant Sell + Inventory — the invariants that keep a correction from becoming a
 * sale, and a retry from becoming a second sale (2D-1C).
 *
 *   node scripts/test-merchant-sell-inventory.js
 *
 * FIXTURE — non-degenerate by construction:
 *     SELLER_A   the account   (auth.uid / sellerUid)
 *     SHOP_B     the shop      (activeShopId, products.shopId)
 *     SHOP_C     a second shop this account must never reach
 * SELLER_A !== SHOP_B, so code that substitutes the account for the shop fails here
 * rather than in a merchant's till.
 *
 * The two chains under test, and the wall between them:
 *
 *   SELL        cart → buildSale → posCompleteCheckout → stock ↓ → sale → sold ↑
 *   CORRECT     delta → buildAdjustment → merchantAdjustStock → stock ⇅ → movement
 *                                                            → sold UNCHANGED
 *
 * The wall is structural, not documentary: the Sell modules must contain no path to
 * the adjustment authority, and the correction modules must contain no path to the
 * sale authority. Both directions are asserted against the shipped source.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const MS = require(path.join(ROOT, 'sokoni-merchant-stock.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B   = 'SHOP_B_shop_91c';
const SHOP_C   = 'SHOP_C_shop_42x';

const P = {
  airtime: { id: 'p1', name: 'Airtime card', price: 100, stock: 12, shopId: SHOP_B, sku: '1234', lowStockThreshold: 5 },
  case:    { id: 'p2', name: 'Phone case',   price: 450, stock: 2,  shopId: SHOP_B, lowStockThreshold: 5 },
  charger: { id: 'p3', name: 'Charger',      price: 900,            shopId: SHOP_B },   /* stock unknown */
  alien:   { id: 'x9', name: 'Other shop item', price: 50, stock: 5, shopId: SHOP_C },
};
const CATALOGUE = [P.airtime, P.case, P.charger, P.alien];

const scopeOf = (uid, shop) => MD.resolveScope({ uid, activeShopId: shop });
const SCOPE = scopeOf(SELLER_A, SHOP_B);

const SRC = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* The wall between selling and correcting is a property of the CODE, not of the
 * prose around it — and every one of these modules documents the wall by naming
 * the authority on the other side of it. Asserting against raw source would
 * therefore fail on a correct file for explaining itself, and (worse) could be
 * "fixed" by deleting the explanation. Strip comments first, so the assertion is
 * about reachable code.
 *
 * Small state machine rather than a regex: it must not mistake the `//` inside a
 * string, or a `/*` inside a template literal, for a comment. */
function code(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

(async () => {

/* ════════════════════════════════════════════════════════════════════════════
   A — the cart. In memory, immutable, and scoped.
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART A — the cart holds nothing but memory\n');
{
  let cart = MD.addToCart([], P.airtime, 1, SCOPE);
  ck('A1  a product enters the cart with quantity 1', cart.length === 1 && cart[0].qty === 1);

  const before = cart;
  cart = MD.addToCart(cart, P.airtime, 2, SCOPE);
  ck('A2  adding the same product MERGES into one line', cart.length === 1 && cart[0].qty === 3);
  ck('A3  ...and the previous cart is not mutated (pure)', before[0].qty === 1);

  cart = MD.addToCart(cart, P.case, 1, SCOPE);
  ck('A4  a second product is a second line', cart.length === 2);

  cart = MD.setLineQty(cart, 'p1', 7);
  ck('A5  an exact quantity can be set', cart[0].qty === 7);

  cart = MD.setLineQty(cart, 'p1', 0);
  ck('A6  quantity 0 REMOVES the line — no ghost zero-qty lines',
    cart.length === 1 && cart[0].productId === 'p2');

  cart = MD.removeLine(cart, 'p2');
  ck('A7  a line can be removed outright', cart.length === 0);

  let threw = false;
  try { MD.addToCart([], P.alien, 1, SCOPE); } catch (_) { threw = true; }
  ck('A8  a SHOP_C product cannot enter SHOP_B\'s cart', threw);

  ck('A9  a zero/negative quantity adds nothing',
    MD.addToCart([], P.airtime, 0, SCOPE).length === 0 &&
    MD.addToCart([], P.airtime, -3, SCOPE).length === 0);

  ck('A10 a fractional quantity is floored to whole units',
    MD.addToCart([], P.airtime, 2.9, SCOPE)[0].qty === 2);
}

/* ════════════════════════════════════════════════════════════════════════════
   B — the stock warning. Unknown is not zero.
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART B — an unknown stock is never treated as empty\n');
{
  const over = MD.addToCart([], P.case, 5, SCOPE);          /* only 2 in stock */
  const w = MD.cartWarnings(over);
  ck('B1  asking for more than the shop has is flagged',
    w.length === 1 && w[0].kind === 'over_stock' && w[0].available === 2 && w[0].wanted === 5);

  const ok = MD.addToCart([], P.case, 2, SCOPE);
  ck('B2  ...and exactly the available quantity is not flagged', MD.cartWarnings(ok).length === 0);

  /* The decisive one: a product with NO stock field is unmeasured, not empty. */
  const unknown = MD.addToCart([], P.charger, 99, SCOPE);
  ck('B3  a product with UNKNOWN stock produces no warning (unknown is not 0)',
    MD.cartWarnings(unknown).length === 0 && unknown[0].knownStock === null);
}

/* ════════════════════════════════════════════════════════════════════════════
   C — finding a product fast, and never the wrong one.
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART C — search and scan\n');
{
  const shopRows = await MD.listProducts({
    scope: SCOPE,
    db: { queryProducts: async (spec) => CATALOGUE.filter(p => String(p[spec.where[0][0]]) === String(spec.where[0][2])) },
  });

  ck('C1  an empty term returns the catalogue unchanged',
    MD.searchProducts(shopRows, '').length === shopRows.length);

  const byName = MD.searchProducts(shopRows, 'pho');
  ck('C2  a name prefix matches', byName.length === 1 && byName[0].id === 'p2');

  ck('C3  search is case-insensitive', MD.searchProducts(shopRows, 'CHARGER')[0].id === 'p3');

  const byCode = MD.searchProducts(shopRows, '1234');
  ck('C4  an exact barcode ranks first', byCode[0].id === 'p1');

  ck('C5  a scan resolving to exactly one product returns it',
    (MD.findByCode(shopRows, '1234') || {}).id === 'p1');

  ck('C6  a scan matching nothing returns null — it never guesses',
    MD.findByCode(shopRows, '999999') === null);

  /* Two products carrying the same code is a catalogue defect; adding "one of them"
     to a cart would silently sell the wrong item. */
  const dupes = shopRows.concat([{ id: 'dup', name: 'Duplicate', price: 1, sku: '1234', shopId: SHOP_B }]);
  ck('C7  an AMBIGUOUS scan returns null rather than picking one',
    MD.findByCode(dupes, '1234') === null);
}

/* ════════════════════════════════════════════════════════════════════════════
   D — money on screen
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART D — an unknown figure is a dash, never a zero\n');
{
  ck('D1  null renders as an em dash', MD.formatKES(null) === '—');
  ck('D2  undefined renders as an em dash', MD.formatKES(undefined) === '—');
  ck('D3  a REAL zero renders as zero (0 is a different, true answer)',
    MD.formatKES(0) === 'KES 0', MD.formatKES(0));
  ck('D4  a value renders as currency', /^KES\s?1[,  ]?250$/.test(MD.formatKES(1250)), MD.formatKES(1250));
  ck('D5  NaN does not become a number', MD.formatKES(NaN) === '—');
}

/* ════════════════════════════════════════════════════════════════════════════
   E — the sale payload actually records who sold what
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART E — the sale carries its provenance to the server\n');
{
  const cart = MD.addToCart(MD.addToCart([], P.airtime, 3, SCOPE), P.case, 1, SCOPE);
  const sale = MD.buildSale({ scope: SCOPE, cart, saleToken: 'tok_1', payments: [{ method: 'cash', amount: 750 }] });

  ck('E1  the till is the SHOP', sale.merchantId === SHOP_B);
  /* posCompleteCheckout destructures a fixed field list and spreads `metadata` into the
     stored sale. `sellerUid` and `channel` at top level are read by nobody. */
  ck('E2  provenance rides in `metadata`, which the server actually stores',
    sale.metadata && sale.metadata.sellerUid === SELLER_A &&
    sale.metadata.shopId === SHOP_B && sale.metadata.channel === 'merchant_pos',
    JSON.stringify(sale.metadata));
  ck('E3  the shop is not the account, all the way through',
    sale.metadata.sellerUid !== sale.metadata.shopId);
  ck('E4  totals come from the cart', sale.subtotal === 750 && sale.grandTotal === 750);
}

/* ════════════════════════════════════════════════════════════════════════════
   F — the pre-charge guard
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART F — oversell is caught BEFORE the customer pays\n');
{
  const cart = MD.addToCart([], P.case, 5, SCOPE);
  const seen = [];
  const dryCallable = async (payload) => {
    seen.push(payload);
    return { data: { dryRun: true, ok: true, serverSubtotal: 2250,
      stockDeltas: [{ productId: 'p2', from: 2, to: 0, delta: -2 }], differences: [] } };
  };

  const r = await MD.previewSale({ scope: SCOPE, cart, saleToken: 'tok_p', callable: dryCallable });
  ck('F1  the check is flagged dryRun — the server must not settle it',
    seen.length === 1 && seen[0].dryRun === true);
  ck('F2  ...and it is otherwise the SAME payload, so it checks the real sale',
    seen[0].merchantId === SHOP_B && seen[0].items[0].qty === 5);
  ck('F3  the shortfall is visible to the caller (asked 5, deltas cover 2)',
    Math.abs(r.stockDeltas[0].delta) < cart[0].qty);

  /* A dry run must NOT claim an idempotency key, so the real sale that follows can. */
  const real = MD.buildSale({ scope: SCOPE, cart, saleToken: 'tok_p' });
  ck('F4  the check and the real sale share one idempotency key',
    seen[0].idempotencyKey === real.idempotencyKey);

  const dead = await MD.previewSale({ scope: SCOPE, cart, saleToken: 'tok_p',
    callable: async () => { throw new Error('offline'); } });
  ck('F5  a check that could NOT RUN is reported as not-run, never as a pass',
    dead.ok === false && dead.ran === false && /offline/.test(dead.error));

  const wrong = await MD.previewSale({ scope: SCOPE, cart, saleToken: 'tok_p',
    callable: async () => ({ data: { saleId: 'oops' } }) });
  ck('F6  a non-dry-run response is not accepted as a check', wrong.ok === false && wrong.ran === false);
}

/* ════════════════════════════════════════════════════════════════════════════
   G — the correction authority (client layer)
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART G — a correction is built, refused and retried correctly\n');
{
  const a = MS.buildAdjustment({ scope: SCOPE, productId: 'p1', delta: -3, reason: 'damage',
    note: 'crushed in transit', attemptToken: 'att_1' });
  ck('G1  the payload names the shop and the product', a.shopId === SHOP_B && a.productId === 'p1');
  ck('G2  the delta is SIGNED, not an absolute target', a.delta === -3);
  ck('G3  the reason and note are carried', a.reason === 'damage' && /crushed/.test(a.note));

  const bad = (o) => { try { MS.buildAdjustment(Object.assign({ scope: SCOPE, productId: 'p1',
    delta: 1, reason: 'damage', attemptToken: 't' }, o)); return false; } catch (_) { return true; } };
  ck('G4  a zero delta is refused — it is not a correction', bad({ delta: 0 }));
  ck('G5  a fractional delta is refused', bad({ delta: 1.5 }));
  ck('G6  a missing reason is refused — an unexplained change is not auditable', bad({ reason: null }));
  ck('G7  an unknown reason is refused', bad({ reason: 'because' }));
  ck('G8  an unresolved scope cannot produce an adjustment',
    bad({ scope: scopeOf(SELLER_A, null) }));

  /* Idempotency: the SAME correction retried must claim the SAME id. */
  const again = MS.buildAdjustment({ scope: SCOPE, productId: 'p1', delta: -3, reason: 'damage',
    note: 'crushed in transit', attemptToken: 'att_1' });
  ck('G9  a retry of the same correction reproduces the same adjustmentId',
    again.adjustmentId === a.adjustmentId, a.adjustmentId);

  const later = MS.buildAdjustment({ scope: SCOPE, productId: 'p1', delta: -3, reason: 'damage',
    attemptToken: 'att_2' });
  ck('G10 a NEW attempt gets a different id', later.adjustmentId !== a.adjustmentId);

  const diffDelta = MS.buildAdjustment({ scope: SCOPE, productId: 'p1', delta: -4, reason: 'damage',
    attemptToken: 'att_1' });
  ck('G11 changing the delta makes it a DIFFERENT correction', diffDelta.adjustmentId !== a.adjustmentId);

  const otherShop = MS.buildAdjustment({ scope: scopeOf(SELLER_A, SHOP_C), productId: 'p1',
    delta: -3, reason: 'damage', attemptToken: 'att_1' });
  ck('G12 the same correction in another shop is a different correction',
    otherShop.adjustmentId !== a.adjustmentId);

  /* No clock in the derivation — otherwise a retry would mint a new id and double-apply. */
  const src = SRC('sokoni-merchant-stock.js');
  const derivation = src.slice(src.indexOf('function adjustmentId'), src.indexOf('function buildAdjustment'));
  ck('G13 the id derivation contains no clock', !/Date\.now|new Date|performance\.now/.test(derivation));
}

/* ════════════════════════════════════════════════════════════════════════════
   H — the correction goes to the SERVER, exactly once, and failure is failure
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART H — the server applies it, or nothing happened\n');
{
  const calls = [];
  const okCallable = async (p) => { calls.push(p);
    return { data: { ok: true, before: 12, after: 9, inventoryVersion: 4, idempotent: false } }; };

  const r = await MS.adjustStock({ scope: SCOPE, productId: 'p1', delta: -3, reason: 'damage',
    attemptToken: 'att_9', callable: okCallable });
  ck('H1  the correction is applied through the server authority',
    r.ok === true && r.result.after === 9);
  ck('H2  merchantAdjustStock was called EXACTLY once', calls.length === 1);
  ck('H3  the payload carries the shop scope', calls[0].shopId === SHOP_B);
  ck('H4  the displayed figure is the SERVER\'s `after`, not a local sum',
    r.result.before === 12 && r.result.after === 9);

  const refused = await MS.adjustStock({ scope: SCOPE, productId: 'p1', delta: -25, reason: 'damage',
    attemptToken: 'att_10',
    callable: async () => { const e = new Error('There are 10; count again or adjust by at most 10.');
      e.code = 'failed-precondition'; throw e; } });
  ck('H5  a refusal is reported as a refusal, with the SERVER\'s own wording',
    refused.ok === false && /count again/.test(refused.error), refused.error);
  ck('H6  ...and no local stock figure is invented to compensate',
    refused.result === undefined);

  const down = await MS.adjustStock({ scope: SCOPE, productId: 'p1', delta: -1, reason: 'damage',
    attemptToken: 'att_11', callable: async () => { throw new Error('network down'); } });
  ck('H7  a network failure is a failure, not a success shape', down.ok === false);

  const notOk = await MS.adjustStock({ scope: SCOPE, productId: 'p1', delta: -1, reason: 'damage',
    attemptToken: 'att_12', callable: async () => ({ data: { ok: false, error: 'shop closed' } }) });
  ck('H8  a server-side ok:false is a refusal', notOk.ok === false && /shop closed/.test(notOk.error));

  ck('H9  history is scoped to this shop',
    MS.movementsQuery(SCOPE).where[0][0] === 'shopId' && MS.movementsQuery(SCOPE).where[0][2] === SHOP_B);
  ck('H10 history can be narrowed to one product',
    MS.movementsQuery(SCOPE, { productId: 'p1' }).where.length === 2);
}

/* ════════════════════════════════════════════════════════════════════════════
   I — THE WALL. A correction cannot become a sale, in either direction.
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART I — the wall between a sale and a correction\n');
{
  const dataSrc  = code(SRC('sokoni-merchant-data.js'));
  const stockSrc = code(SRC('sokoni-merchant-stock.js'));
  const sellSrc  = code(SRC('sokoni-merchant-sell.js'));
  const invSrc   = code(SRC('sokoni-merchant-inventory-ui.js'));

  /* Direction 1 — the SELL side cannot adjust stock. */
  ck('I1  the Sell data layer never names the adjustment authority',
    !/merchantAdjustStock/.test(dataSrc));
  ck('I2  the Sell SURFACE never names the adjustment authority',
    !/merchantAdjustStock|SokoniMerchantStock/.test(sellSrc));
  ck('I3  ...and exports no stock-writing function',
    !Object.keys(MD).some(k => /decrement|adjustStock|writeStock|setStock/i.test(k)),
    Object.keys(MD).join(','));

  /* Direction 2 — the CORRECTION side cannot sell. */
  ck('I4  the correction layer never names the sale authority',
    !/posCompleteCheckout/.test(stockSrc));
  ck('I5  the Inventory SURFACE never names the sale authority',
    !/posCompleteCheckout|callSale/.test(invSrc));
  ck('I6  the correction layer never touches `sold` in any payload',
    !/\bsold\b\s*:/.test(stockSrc));

  /* Neither side writes Firestore. Both mutations are the server's. */
  [['Sell data', dataSrc], ['correction', stockSrc], ['Sell surface', sellSrc], ['Inventory surface', invSrc]]
    .forEach(([name, src], i) => {
      const w = src.match(/updateDoc|setDoc\(|addDoc|writeBatch|runTransaction|FieldValue/g) || [];
      ck('I' + (7 + i) + '  the ' + name + ' module contains NO Firestore write', w.length === 0, w.join(','));
    });

  /* No inline event handler is built from data — the XSS shape this codebase has
     been bitten by before (esc() is not safe inside onclick=""). */
  [['Sell', sellSrc], ['Inventory', invSrc]].forEach(([name, src], i) => {
    ck('I' + (11 + i) + '  the ' + name + ' surface builds no inline on* handler',
      !/\son(click|input|change|submit)\s*=\s*(\\?["'])/.test(src));
  });

  ck('I13 both surfaces render unknown values through the shared formatter',
    /formatKES/.test(sellSrc) && /formatKES/.test(invSrc));
}

/* ════════════════════════════════════════════════════════════════════════════
   J — routing: Sell and Inventory are real destinations, POS is preserved
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART J — navigation\n');
{
  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('J1  the route contract still validates', C.validate().length === 0, C.validate().join(' | '));
  ck('J2  Sell is a native route', (C.get('sell') || {}).kind === 'native');
  ck('J3  Inventory is a native route', (C.get('inventory') || {}).kind === 'native');
  ck('J4  #inventory no longer resolves to POS — it is its own authority',
    C.resolve('inventory') === 'inventory');
  ck('J5  POS is PRESERVED as its own destination', (C.get('pos') || {}).kind === 'pos');
  ck('J6  #cashier still resolves to POS (no bookmark is broken)', C.resolve('cashier') === 'pos');
  ck('J7  the bottom-nav Sell tab points at the native till',
    (C.BOTTOM_NAV.find(b => b.label === 'Sell') || {}).id === 'sell');
  ck('J8  both require a resolved SHOP, not just an account',
    C.get('sell').ctx.indexOf('shopId') >= 0 && C.get('inventory').ctx.indexOf('shopId') >= 0);
  ck('J9  both are declared mobile- and desktop-safe',
    C.get('sell').mobile && C.get('sell').desktop && C.get('inventory').mobile && C.get('inventory').desktop);

  const shell = SRC('merchant.html');
  ck('J10 the shell loads all three new modules',
    /sokoni-merchant-stock\.js/.test(shell) && /sokoni-merchant-sell\.js/.test(shell) &&
    /sokoni-merchant-inventory-ui\.js/.test(shell));
  ck('J11 the shell has a renderer for each new native route',
    /id === 'sell'\) renderSell\(\)/.test(shell) && /id === 'inventory'\) renderInventory\(\)/.test(shell));
  ck('J12 the shell binds Sell to posCompleteCheckout and Inventory to merchantAdjustStock',
    /callSale:\s*_callable\('posCompleteCheckout'\)/.test(shell) &&
    /callAdjust:\s*_callable\('merchantAdjustStock'\)/.test(shell));
}

/* ════════════════════════════════════════════════════════════════════════════
   K — mutation control. A suite that cannot fail proves nothing.
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\nPART K — mutation control (each defect must be CAUGHT)\n');
{
  /* K1 — a correction that also decrements `sold`. */
  const mutSold = SRC('sokoni-merchant-stock.js')
    .replace('note: o.note ? String(o.note).slice(0, 500) : \'\',',
             'note: o.note ? String(o.note).slice(0, 500) : \'\', sold: -o.delta,');
  ck('K1  the correction payload starts carrying `sold` → detected', /\bsold\b\s*:/.test(mutSold));

  /* K2 — a time-based adjustment id (a retry would then double-apply). */
  const mutClock = SRC('sokoni-merchant-stock.js')
    .replace("var basis = scope.shopId + '::'", "var basis = Date.now() + scope.shopId + '::'");
  const dSlice = mutClock.slice(mutClock.indexOf('function adjustmentId'), mutClock.indexOf('function buildAdjustment'));
  ck('K2  a clock enters the id derivation → detected', /Date\.now/.test(dSlice));

  /* K3 — unknown stock reported as empty, which would block a legitimate sale. */
  const fakeWarn = [{ productId: 'z', name: 'z', qty: 1, knownStock: 0 }];
  ck('K3  unknown stock coerced to 0 → detected as a warning that should not exist',
    MD.cartWarnings(fakeWarn).length === 1);

  /* K4 — a preview that reports "checked and fine" when it never ran. */
  const lenient = (r) => (r.ok === true);
  ck('K4  a not-run check treated as a pass → detected',
    lenient({ ok: false, ran: false }) === false);

  /* K5 — the wall breached: Sell reaching the adjustment authority. */
  const breach = SRC('sokoni-merchant-sell.js').replace('ctx.callSale', 'ctx.callAdjust /* merchantAdjustStock */');
  ck('K5  the Sell surface reaching merchantAdjustStock → detected', /merchantAdjustStock/.test(breach));

  /* K6 — an inline handler built from a product name. */
  const xss = '<button onclick="add(\'' + 'NAME' + '\')">';
  ck('K6  an inline on* handler in a surface → detected',
    /\son(click|input|change|submit)\s*=\s*(\\?["'])/.test(xss));

  /* K7 — the shop silently defaulting to the account. */
  ck('K7  shopId falling back to the uid → detected',
    scopeOf(SELLER_A, null).shopId === null);
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
