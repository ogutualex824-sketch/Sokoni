'use strict';
/* Sales tier picker (owner, 2026-10-01): the cashier picks a CONFIGURED price tier per line; the cart sends the tier;
   the server resolves the price. Runs the REAL sokoni-merchant-data.js (UMD) + checks the Sell screen markup.
     node scripts/test-pos-tier-picker.js            (this tree)
     BASE=<rev> node scripts/test-pos-tier-picker.js (baseline 7a9f276 must FAIL the tier rows) */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 160) + ']')); ok ? pass++ : fail++; };

const ctx = { window: {}, console, setTimeout, Date, Math, JSON, isFinite, Number, String, Object, Array, Error };
ctx.self = ctx.window; ctx.globalThis = ctx;
vm.createContext(ctx);
try { vm.runInContext(read('sokoni-merchant-data.js'), ctx); } catch (e) { ck('L-0', false, 'sokoni-merchant-data.js loads', e.message); }
const md = ctx.window.SokoniMerchantData || ctx.SokoniMerchantData;
console.log('\nPOS tier picker   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
if (!md) { ck('L-1', false, 'SokoniMerchantData exported'); process.exit(1); }

const A = { id: 'A', name: 'Coffee', price: 150, shopPrice: 140, wholesalePrice: 125, stock: 9 };
const B = { id: 'B', name: 'Tea', price: 100, wholesalePrice: 80 };            /* no shop price */
const C = { id: 'C', name: 'Sugar', price: 100 };                             /* online only */
const D = { id: 'D', name: 'Bad', price: 100, shopPrice: 130, wholesalePrice: '90' }; /* out of order + string */

let cart = md.addToCart([], A, 2);
ck('P-1', typeof md.setLineTier === 'function' && cart[0].priceTier === 'online' && cart[0].price === 150, 'a new line starts on ONLINE at the online price', cart[0]);
ck('P-2', cart[0].tiers && cart[0].tiers.shop === 140 && cart[0].tiers.wholesale === 125, 'the line knows the product\'s configured tiers', cart[0].tiers);
let c2; try { c2 = md.setLineTier(cart, 'A', 'shop'); } catch (e) { c2 = null; }
ck('P-3', c2 && c2[0].priceTier === 'shop' && c2[0].price === 140 && c2[0].qty === 2, 'cashier taps SHELF → KES 140, qty kept', c2 && c2[0]);
let c3; try { c3 = md.setLineTier(c2, 'A', 'wholesale'); } catch (e) { c3 = null; }
ck('P-4', c3 && c3[0].priceTier === 'wholesale' && c3[0].price === 125, 'cashier taps WHOLESALE → KES 125', c3 && c3[0]);
let threw = false; try { md.setLineTier(md.addToCart([], B, 1), 'B', 'shop'); } catch (e) { threw = true; }
ck('P-5', threw, 'a tier the product does NOT have (Tea: shop) is refused, never priced');
threw = false; try { md.setLineTier(cart, 'A', 'vip'); } catch (e) { threw = true; }
ck('P-6', threw, 'an unknown tier name is refused');
const d = md.addToCart([], D, 1)[0];
ck('P-7', d && d.tiers && d.tiers.shop === null && d.tiers.wholesale === null, 'out-of-order (shop > online) and string prices are NOT offered (mirrors the server rule)', d && d.tiers);
const cc = md.addToCart([], C, 1)[0];
ck('P-8', cc && cc.tiers && cc.tiers.shop === null && cc.tiers.wholesale === null && cc.price === 100, 'an online-only product offers only ONLINE (missing tier ≠ 0)', cc && cc.tiers);
/* quantity behaviour keeps the tier; minus at 1 removes; no navigation in the data layer */
let q = md.setLineQty(c2 || cart, 'A', 3);
ck('Q-1', q[0] && q[0].qty === 3 && q[0].priceTier === (c2 ? 'shop' : 'online'), 'changing quantity keeps the chosen tier', q[0]);
q = md.setLineQty(md.setLineQty(q, 'A', 1), 'A', 0);
ck('Q-2', Array.isArray(q) && q.length === 0, '1 → minus → the line is removed');
const merged = md.addToCart(c2 || cart, A, 1);
ck('Q-3', merged.length === 1 && merged[0].qty === 3 && merged[0].priceTier === (c2 ? 'shop' : 'online'), 'adding the same product again merges and keeps the tier', merged[0]);
/* the sale payload */
const scope = { ok: true, shopId: 'SHOP1', sellerUid: 'U1' };
let sale = null; try { sale = md.buildSale({ scope, cart: c2 || cart, payments: [{ method: 'cash', amount: 280 }], saleToken: 't1' }); } catch (e) { sale = { err: e.message }; }
const it = sale && sale.items && sale.items[0];
ck('S-1', it && it.priceTier === 'shop' && it.unitPrice === 140 && it.qty === 2, 'the sale sends productId + qty + the chosen tier (unitPrice is only checked by the server)', it);
ck('S-2', sale && sale.subtotal === 280 && sale.grandTotal === 280, 'totals follow the tier price (2 × 140 = 280)', sale && { s: sale.subtotal, g: sale.grandTotal });
const s0 = md.buildSale({ scope, cart: md.addToCart([], C, 1), payments: [{ method: 'cash', amount: 100 }], saleToken: 't2' });
ck('S-3', s0.items[0].priceTier === 'online', 'an untouched line sells as ONLINE (unchanged behaviour)', s0.items[0]);

ck('W-1', md.TIER_LABEL.shop === 'Shelf' && md.TIER_SHORT.shop === 'SHELF' && md.TIER_SHORT.online === 'ONL' && md.TIER_SHORT.wholesale === 'WHOLE', 'owner wording: the in-store tier reads SHELF / Shelf price (buttons ONL / SHELF / WHOLE)', { label: md.TIER_LABEL, short: md.TIER_SHORT });
/* the Sell screen: chips only for configured tiers, accessible names, selected state not colour-only */
const sell = read('sokoni-merchant-sell.js');
ck('U-1', /data-act="tier"/.test(sell) && /aria-pressed="/.test(sell) && /aria-label="Use ' \+ label\.toLowerCase\(\) \+ ' price — '/.test(sell), 'tier buttons carry an accessible name ("Use shop price — KES 140") and aria-pressed');
ck('U-2', /\(on \? '✓ ?' : ''\)/.test(sell), 'the selected tier shows a ✓ (not colour alone)');
ck('U-3', /if \(!has\) \{[\s\S]{0,200}disabled aria-disabled="true"[\s\S]{0,120}price not set/.test(sell) && !/if \(!has\) \{[^}]*data-act="tier"/.test(sell), 'an UNSET tier renders as a disabled "—" cell that cannot be selected (never 0)');
ck('U-6', /\['online', 'shop', 'wholesale'\]\.map\(/.test(sell) && /'<\/div><\/div>' \+ tierCol \+\s*\n?\s*\/\*[\s\S]{0,400}'<div class="msl-step">'/.test(sell), 'layout: ONL / SHOP / WHOLE column, top to bottom, directly LEFT of the + / qty / − stepper');
ck('U-8', /var tierCol = l\.quick \? '' :/.test(sell), 'a Quick Charge line (cashier-priced, no tiers) gets NO tier column');
ck('U-7', /'\.msl-tiers\{[^']*flex-direction:column/.test(sell) && /@media \(max-width:360px\)\{\.msl-tiers/.test(sell), 'the tier column is vertical and shrinks on small phones (responsive)');
ck('U-4', /act === 'tier'[\s\S]{0,300}md\.setLineTier\([\s\S]{0,700}S\.preflight = null; paint\(\)/.test(sell)
  && !/act === 'tier'\)\s*\{ var lt[\s\S]{0,700}clearToken\(\)/.test(sell), 'a tier change re-runs the pre-charge check and keeps the sale token (cleared only when a sale ends)');
{ const base = md.addToCart([], A, 2); const k = (cart) => md.idempotencyKey({ scope: { ok: true, shopId: 'SHOP1' }, cart, saleToken: 'T1' });
  const kShelf = k(md.setLineTier(base, 'A', 'shop')), kWh = k(md.setLineTier(base, 'A', 'wholesale'));
  const legacy = (() => { const basis = 'SHOP1::T1::Ax2'; let h = 5381; for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0; return h.toString(36); })();
  ck('K-1', k(base) === k(md.addToCart([], A, 2)) && kShelf !== k(base) && kWh !== kShelf && kWh !== k(base),
    'the sale key includes the tier: the same cart retried = the same key; a tier change = a different sale', { on: k(base), sh: kShelf, wh: kWh });
  ck('K-2', k(base).slice(-legacy.length) === legacy, 'an online-only cart keeps EXACTLY its old key (a persisted attempt still resumes after the deploy)', { key: k(base), legacy }); }
ck('U-5', !/location\.(href|assign|replace)|salescontrol/i.test((sell.match(/if \(act === 'dec'\)[\s\S]{0,260}/) || [''])[0]), 'minus never navigates (no location change, no Sales Control)');

/* the payment sheet (owner, 2026-10-01): items shown ABOVE the money, and the sheet scrolls on phones */
const payAt = sell.indexOf("<div class=\"t\">Take payment</div>");
const paySeg = payAt > 0 ? sell.slice(payAt, payAt + 4000) : '';
ck('Y-1', /msl-pay-items[\s\S]*S\.cart\.map[\s\S]*msl-pay-it[\s\S]*Subtotal/.test(paySeg) && paySeg.indexOf('msl-pay-items') < paySeg.indexOf('Subtotal'), 'Take payment lists the sale items (qty × price, tier, line total) ABOVE the subtotal');
ck('Y-2', /'\.msl-sh-b\{[^']*overflow-y:auto[^']*-webkit-overflow-scrolling:touch;'/.test(sell) && /overscroll-behavior:contain;touch-action:pan-y/.test(sell), 'the sheet body scrolls on iPhone (momentum, contained overscroll, vertical pan)');

/* THE SHELF PRICE IS PRIVATE (owner, 2026-10-01: "make it truly private"). products/{id} is public, so the shelf
   price is read only from the merchant-only posProducts/{id}; a staff device (refused by the rules) asks the server. */
(async () => {
  const spec = []; const pub = [{ id: 'A', name: 'Coffee', price: 150, shopPrice: 140, wholesalePrice: 125, shopId: 'SHOP1', sellerUid: 'U1' }];
  const dbOwner = { queryProducts: async (q) => { spec.push(q); return q.collection === 'posProducts'
    ? [{ id: 'A', sellerId: 'U1', shopPrice: 140 }, { id: 'Z', sellerId: 'SOMEONE', shopPrice: 1 }] : pub; } };
  const dbStaff = { queryProducts: async (q) => { if (q.collection === 'posProducts') throw new Error('Missing or insufficient permissions.'); return pub; } };
  let rows = []; try { rows = await md.listProducts({ scope, db: dbOwner }); } catch (e) { rows = [{ err: e.message }]; }
  ck('X-1', rows[0] && (rows[0].shopPrice === null || !('shopPrice' in rows[0])) && rows[0].wholesalePrice === 125, 'a shopPrice on the PUBLIC product doc is never read (wholesale still is)', rows[0]);
  let sh = null; try { sh = await md.listShelfPrices({ scope, db: dbOwner }); } catch (e) { sh = { err: e.message }; }
  const q = spec.find((x) => x.collection === 'posProducts');
  ck('X-2', sh && sh.readable === true && sh.map.A === 140 && !('Z' in sh.map) && q && JSON.stringify(q.where) === JSON.stringify([['sellerId', '==', 'U1']]),
    'the OWNER reads shelf prices from posProducts filtered by their own sellerId (the field the rule checks); a foreign record is dropped', { sh, q });
  const ownerRows = sh && sh.readable ? md.withShelf(rows, sh) : [];
  const ol = ownerRows[0] ? md.addToCart([], ownerRows[0], 1)[0] : null;
  ck('X-3', ol && ol.tiers.shop === 140 && ol.shelfPending === false, 'owner device: the cart line offers SHELF at the private price', ol);
  let st = null; try { st = await md.listShelfPrices({ scope, db: dbStaff }); } catch (e) { st = { threw: e.message }; }
  const sl = st ? md.addToCart([], md.withShelf(rows, st)[0], 1)[0] : null;
  ck('X-4', st && st.readable === false && sl && sl.tiers.shop === null && sl.shelfPending === true && sl.price === 150,
    'staff device: the rules refuse the private read → no shelf price is guessed; the line is marked to ASK the server', { st, sl });
  /* the server preview (dry run) */
  const sent = []; const callOk = async (payload) => { sent.push(payload); return { data: { dryRun: true, ok: false, items: [{ productId: 'A', unitPrice: 140, priceTier: 'shop' }], differences: [{ field: 'unitPrice' }] } }; };
  let pv = null; try { pv = await md.previewShelfPrice({ scope, productId: 'A', name: 'Coffee', callable: callOk }); } catch (e) { pv = e.message; }
  const pay = sent[0];
  ck('X-5', pv === 140 && pay && pay.dryRun === true && pay.merchantId === 'SHOP1' && pay.items.length === 1 && pay.items[0].priceTier === 'shop' && pay.items[0].productId === 'A',
    'staff tap on SHELF asks the server (dryRun, this shop, one shelf line) and gets the price', { pv, pay: pay && { d: pay.dryRun, m: pay.merchantId, it: pay.items } });
  const callNone = async () => ({ data: { dryRun: true, ok: false, items: [], differences: [{ field: 'priceTier', error: 'tier_not_configured' }] } });
  const callDown = async () => { throw new Error('unavailable'); };
  const callWrong = async () => ({ data: { dryRun: true, ok: true, items: [{ productId: 'A', unitPrice: 140, priceTier: 'online' }] } });
  const n1 = await md.previewShelfPrice({ scope, productId: 'A', callable: callNone });
  const n2 = await md.previewShelfPrice({ scope, productId: 'A', callable: callDown });
  const n3 = await md.previewShelfPrice({ scope, productId: 'A', callable: callWrong });
  ck('X-6', n1 === null && n2 === null && n3 === null, 'no shelf price / the check failing / a non-shelf answer → null (never 0, never the online price)', [n1, n2, n3]);
  let c = md.setLineShelf([sl], 'A', 140); let ct; try { ct = md.setLineTier(c, 'A', 'shop'); } catch (e) { ct = null; }
  ck('X-7', ct && ct[0].priceTier === 'shop' && ct[0].price === 140 && ct[0].shelfPending === false, 'the previewed price becomes the SHELF tier for that line', ct && ct[0]);
  let thr = false; try { md.setLineTier(md.setLineShelf([sl], 'A', null), 'A', 'shop'); } catch (e) { thr = true; }
  const hi = md.setLineShelf([sl], 'A', 999)[0];
  ck('X-8', thr && hi.tiers.shop === null, 'a missing or out-of-order previewed price is NOT offered (shelf above online refused)', hi.tiers);
  /* the screen wiring */
  ck('U-9', /Promise\.all\(\[md\.listProducts\([\s\S]{0,120}md\.listShelfPrices\(/.test(sell) && /S\.products = md\.withShelf\(res\[0\], S\.shelf\)/.test(sell) && /onProducts: function \(rows\) \{\s*S\.products = md\.withShelf\(rows, S\.shelf\)/.test(sell),
    'Sell merges the private shelf prices into BOTH the first load and the live updates');
  ck('U-10', /if \(t === 'shop' && !has && l\.shelfPending\)[\s\S]{0,400}aria-label="Check the shelf price"/.test(sell) && /md\.previewShelfPrice\(\{ scope: ctx\.scope, productId: pid, name: lp\.name, callable: ctx\.callSale \}\)/.test(sell),
    'a staff device shows SHELF "?" and asks the server on tap (busy while asking)');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
