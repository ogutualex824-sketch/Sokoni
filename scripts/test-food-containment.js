#!/usr/bin/env node
/* FOOD HUB CONTAINMENT (owner 2026-10-03) — the live Food Hub took real IntaSend M-Pesa money for 16 made-up
 * restaurants, charged 50% and recorded 100% as paid, and wrote the order from the browser. Until the real Food Hub
 * ships, no food page may start a payment, write an order, or present made-up restaurants / numbers as real.
 *
 * The menu page's REAL inline script is EXECUTED in a vm with a spy on SokoniPay / SokoniIntaSend, a real-looking
 * restaurant in SokoniFood (so the old path WOULD render and pay), and every food page is checked by source.
 *
 *   node scripts/test-food-containment.js            BASE=72dca56 node scripts/test-food-containment.js (must FAIL)
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + String(got).slice(0, 160) + ']')); ok ? pass++ : fail++; };
const inline = (html) => { const out = []; const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g; let m; while ((m = re.exec(html))) out.push({ attrs: m[1], code: m[2] }); return out; };
console.log('\nFood Hub containment   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

/* ── EXECUTE food-menu.html's classic inline script ── */
const MENU = read('food-menu.html');
const els = {};
const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '0712345678', style: {}, classList: { add() {}, remove() {}, toggle() {} },
  querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, appendChild() {}, focus() {} });
const pay = { calls: [] };
const ctx = {
  console: { log() {}, warn() {}, error() {}, info() {} }, Math, Date, JSON, String, Number, Array, Object, Promise, setTimeout: () => 0, clearTimeout() {},
  encodeURIComponent, URLSearchParams,
  window: null, location: { search: '?id=jambo-burgers', href: '' },
  document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('x' + Math.random()), title: '', body: el('body'), addEventListener() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  SokoniFood: {
    RESTAURANTS: [{ id: 'jambo-burgers', name: 'Jambo Burgers', address: 'Westlands', coverGrad: '', emoji: '🍔', deliveryTime: '30 min', deliveryFee: 100, minOrder: 300, distance: '1km', open: true, promo: '' }],
    MENUS: { 'jambo-burgers': { cats: ['Burgers'], items: [{ id: 'b1', name: 'Burger', price: 1000, cat: 'Burgers' }] } },
    getRestaurantRating: () => ({ avg: 4.8, count: 1200 }), getRatings: () => [], getCart: () => [{ id: 'b1', qty: 10, price: 1000, restaurantId: 'jambo-burgers' }],
    cartTotal: () => 10000, cartCount: () => 10, placeOrder: () => ({ id: 'o1' }), clearCart() {}, addToCart() {},
  },
  SokoniPay: { platformBook: (o) => { pay.calls.push(['platformBook', o]); }, saveCommission: () => pay.calls.push(['saveCommission']), saveFee: () => pay.calls.push(['saveFee']) },
  SokoniIntaSend: { initiateSTKPush: () => { pay.calls.push(['initiateSTKPush']); return Promise.resolve({}); } },
  SokoniCart: { list: () => [], add() {}, remove() {} }, SokoniUI: { toast() {} }, alert() {},
};
ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);
let runErr = null;
for (const s of inline(MENU)) { if (/type="module"/.test(s.attrs)) continue; try { vm.runInContext(s.code, ctx, { timeout: 2000 }); } catch (e) { runErr = runErr || e.message; } }
try { if (typeof ctx.openCheckout === 'function') ctx.openCheckout(); } catch (e) { runErr = runErr || e.message; }
try { if (typeof ctx.placeOrder === 'function') ctx.placeOrder(); } catch (e) { runErr = runErr || e.message; }
ck('FC-1', pay.calls.length === 0, 'EXECUTED: opening checkout and placing an order on the menu page starts NO payment (no platformBook, no STK, no commission)', JSON.stringify(pay.calls.map((c) => c[0])) + (runErr ? ' err=' + runErr : ''));
ck('FC-2', !/Jambo Burgers/.test(el('pageTitle').textContent) && /opens soon/i.test(el('menuBody').innerHTML), 'EXECUTED: a made-up restaurant is not rendered as real — the page says ordering opens soon', el('pageTitle').textContent + ' | ' + el('menuBody').innerHTML.slice(0, 80));

/* ── no browser order / menu writes anywhere on the food pages ── */
const DASH = read('food-dashboard.html'), FOOD = read('food.html');
ck('FC-3', !/_saveFoodOrderFS\s*=/.test(MENU) && !/collection\(db,\s*'foodOrders'\)|doc\(db,\s*'foodOrders'/.test(MENU + DASH) && !/doc\(db,\s*'foodMenus'/.test(DASH),
  'no food page writes foodOrders / foodMenus from the browser (writers and the live listener removed)');

/* ── discovery shows nothing made-up as real ── */
const fctx = { console: ctx.console, document: { getElementById: el }, SokoniFood: { RESTAURANTS: ctx.SokoniFood.RESTAURANTS.map((r) => Object.assign({ featured: true, rating: 4.9, reviews: 999, cat: 'restaurant' }, r)), CATEGORIES: [{ id: 'all', label: 'All', emoji: '' }] },
  URLSearchParams, location: { search: '' }, window: null, localStorage: ctx.localStorage, HubRegister: { open() {} }, navigator: {} };
fctx.window = fctx; vm.createContext(fctx);
for (const k of ['foodGrid', 'featuredScroll', 'foodCount']) els[k] = null;
let fErr = null;
for (const s of inline(FOOD)) { if (/type="module"/.test(s.attrs)) continue; try { vm.runInContext(s.code, fctx, { timeout: 2000 }); } catch (e) { fErr = fErr || e.message; } }
try { if (typeof fctx.renderGrid === 'function') fctx.renderGrid(); if (typeof fctx.renderFeatured === 'function') fctx.renderFeatured(); } catch (e) { fErr = fErr || e.message; }
ck('FC-4', !/Jambo Burgers/.test(el('foodGrid').innerHTML + el('featuredScroll').innerHTML) && /opens soon/i.test(el('foodGrid').innerHTML),
  'EXECUTED: discovery renders no made-up restaurant; it says ordering opens soon (with the real apply route)', el('foodGrid').innerHTML.slice(0, 100) + (fErr ? ' err=' + fErr : ''));
ck('FC-5', !/>16\+</.test(FOOD) && !/WELCOME50/.test(FOOD), 'no invented "16+ restaurants" stat and no WELCOME50 promo that checkout never applied');

/* ── the "Restaurant Portal" ── */
ck('FC-6', !/\ninit\(\);\n/.test(DASH) && /_foodPortalClosed/.test(DASH) && !/onSnapshot\(/.test(DASH),
  'the Restaurant Portal no longer opens a made-up "Jambo Burgers" dashboard for any signed-in user, and starts no live listener');
ck('FC-7', /HubRegister\.open\(\{hub:'food'/.test(FOOD), 'CONTROL: the real application route (HubRegister, hub food) is still offered');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
