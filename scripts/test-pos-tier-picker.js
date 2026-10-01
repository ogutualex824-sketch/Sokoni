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
ck('P-3', c2 && c2[0].priceTier === 'shop' && c2[0].price === 140 && c2[0].qty === 2, 'cashier taps SHOP → KES 140, qty kept', c2 && c2[0]);
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

/* the Sell screen: chips only for configured tiers, accessible names, selected state not colour-only */
const sell = read('sokoni-merchant-sell.js');
ck('U-1', /data-act="tier"/.test(sell) && /aria-pressed="/.test(sell) && /aria-label="Use ' \+ label\.toLowerCase\(\) \+ ' price — '/.test(sell), 'tier buttons carry an accessible name ("Use shop price — KES 140") and aria-pressed');
ck('U-2', /\(on \? '✓ ?' : ''\)/.test(sell), 'the selected tier shows a ✓ (not colour alone)');
ck('U-3', /if \(!has\) \{[\s\S]{0,200}disabled aria-disabled="true"[\s\S]{0,120}price not set/.test(sell) && !/if \(!has\) \{[^}]*data-act="tier"/.test(sell), 'an UNSET tier renders as a disabled "—" cell that cannot be selected (never 0)');
ck('U-6', /\['online', 'shop', 'wholesale'\]\.map\(/.test(sell) && /'<\/div><\/div>' \+ tierCol \+\s*\n?\s*\/\*[\s\S]{0,400}'<div class="msl-step">'/.test(sell), 'layout: ONL / SHOP / WHOLE column, top to bottom, directly LEFT of the + / qty / − stepper');
ck('U-7', /'\.msl-tiers\{[^']*flex-direction:column/.test(sell) && /@media \(max-width:360px\)\{\.msl-tiers/.test(sell), 'the tier column is vertical and shrinks on small phones (responsive)');
ck('U-4', /act === 'tier'[\s\S]{0,300}md\.setLineTier\([\s\S]{0,500}S\.preflight = null; clearToken\(\)/.test(sell), 'a tier change re-runs the pre-charge check and mints a new sale key');
ck('U-5', !/location\.(href|assign|replace)|salescontrol/i.test((sell.match(/if \(act === 'dec'\)[\s\S]{0,260}/) || [''])[0]), 'minus never navigates (no location change, no Sales Control)');

/* the payment sheet (owner, 2026-10-01): items shown ABOVE the money, and the sheet scrolls on phones */
const payAt = sell.indexOf("<div class=\"t\">Take payment</div>");
const paySeg = payAt > 0 ? sell.slice(payAt, payAt + 4000) : '';
ck('Y-1', /msl-pay-items[\s\S]*S\.cart\.map[\s\S]*msl-pay-it[\s\S]*Subtotal/.test(paySeg) && paySeg.indexOf('msl-pay-items') < paySeg.indexOf('Subtotal'), 'Take payment lists the sale items (qty × price, tier, line total) ABOVE the subtotal');
ck('Y-2', /'\.msl-sh-b\{[^']*overflow-y:auto[^']*-webkit-overflow-scrolling:touch;'/.test(sell) && /overscroll-behavior:contain;touch-action:pan-y/.test(sell), 'the sheet body scrolls on iPhone (momentum, contained overscroll, vertical pan)');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
