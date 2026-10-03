#!/usr/bin/env node
/* DIGITAL & eSOKO CONTAINMENT (DE-1, owner 2026-10-03) — hosting only.
 *
 * Owner: "Digital & eSOKO" now means phones / laptops / electronics RETAIL on the one marketplace
 * (category.html?cat=electronics | ?cat=computers). The digital-download store is RETIRED as pages (data kept,
 * digital-hub.js dormant). Freelance gigs (digital.html) are MOVING to SOKONI Jobs.
 *
 * Live 72dca56 defects contained here (census sections B1-B8, B12):
 *   digital-esoko.html        SokoniPay.platformBook 50% deposit at a client-read price (intent-less STK; the live
 *                             webhook may credit the payer), browser digitalPurchases {status:'completed'} write,
 *                             browser commission row 'auto_collected', browser invoice, public file URL hand-over,
 *                             "Payment confirmed! Downloading…".
 *   digital-esoko-seller.html browser setDoc digitalProducts + "Product published!"; Net Earnings / Commission
 *                             computed in the browser.
 *   digital.html              SokoniMpesa.pay -> darajaSTKPush (retired), contracts created from the browser,
 *                             "funds in escrow" with no escrow authority, Total Earned / In Escrow / Total Spent
 *                             summed in the browser, unbacked withdrawals write (secondary app dh-wd) + "submitted".
 *   digital-store.html        digitalProductPurchase / digitalProductDownload callables (free-download hole if fixed).
 *   index.html                four home links into the store, "Pay M-Pesa · Instant Download".
 *
 * The page's classic inline scripts are EXECUTED in a vm (spy on SokoniPay / SokoniMpesa / SokoniIntaSend /
 * window.open; a product + a signed-in user injected; every legacy money entry point invoked). Module
 * scripts are checked by source.
 *
 *   node scripts/test-digital-containment.js              (this tree — must PASS)
 *   BASE=72dca56 node scripts/test-digital-containment.js (live — named rows must FAIL; CONTROL rows pass)
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE
  ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  : fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => { try { read(f); return true; } catch (_) { return false; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined || got === '' ? '' : '   [got ' + String(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
const stripComments = (h) => h.replace(/<!--[\s\S]*?-->/g, '');
const scripts = (html) => { const out = []; const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g; let m; while ((m = re.exec(html))) out.push({ code: m[2], module: /type="module"/.test(m[1]) }); return out; };
const srcs = (html) => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);

console.log('\nDigital & eSOKO containment   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const PAGES = ['digital-esoko.html', 'digital-esoko-seller.html', 'digital.html', 'digital-store.html'];
const H = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
const INLINE = Object.fromEntries(PAGES.map((p) => [p, scripts(H[p]).map((s) => s.code).join('\n;\n')]));
const ALL_INLINE = Object.values(INLINE).join('\n;\n');
const VISIBLE = Object.fromEntries(PAGES.map((p) => [p, stripComments(H[p])]));

/* ── EXECUTE every page's classic inline scripts with money spies, then call each legacy money entry point ── */
const spy = { pay: [], open: [] };
const payStub = (name) => new Proxy({}, { get: (_, k) => (...a) => { spy.pay.push(name + '.' + String(k)); const o = a[0] || {}; try { if (typeof o.onSuccess === 'function') o.onSuccess('REF1'); } catch (_) {} return Promise.resolve({}); } });
const runErrs = [];
const rendered = [];
function execPage(page, actions) {
  const store = {
    sokoniUser: JSON.stringify({ uid: 'U1', name: 'Buyer', phone: '0712000000' }),
    deProducts: JSON.stringify([{ id: 'P1', title: 'Paid eBook', price: 1000, sellerName: 'S', sellerUid: 'S1', fileURL: 'https://x/f.pdf', active: true, createdAt: 1 }]),
  };
  const els = {};
  const mkEl = (id) => ({ id, innerHTML: '', textContent: '', value: /phone/i.test(id) ? '0712345678' : /amount/i.test(id) ? '5000' : 'x', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, appendChild() {}, removeChild() {}, remove() {}, click() {}, focus() {}, setAttribute() {}, scrollIntoView() {} });
  const el = (id) => els[id] || (els[id] = mkEl(id));
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} }, Math, Date, JSON, String, Number, Array, Object, Promise, Set, Map, Proxy, encodeURIComponent, URLSearchParams,
    setTimeout: (f) => { try { if (typeof f === 'function') f(); } catch (_) {} return 0; }, clearTimeout() {}, setInterval: () => 0,
    location: { hostname: 'mysokoni.co.ke', search: '', href: '', replace() {} },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl('x' + Math.random()), body: mkEl('body'), addEventListener() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    SokoniPay: payStub('SokoniPay'), SokoniMpesa: payStub('SokoniMpesa'), SokoniIntaSend: payStub('SokoniIntaSend'),
    SokoniCommission: { pct: () => 10 }, SokoniInvoice: { generate() { spy.pay.push('SokoniInvoice.generate'); } },
    HubRegister: { open() {} }, alert() {}, confirm: () => true, open: (u) => { spy.open.push(String(u)); }, addEventListener() {},
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  try { vm.runInContext(scripts(H[page]).filter((s) => !s.module).map((s) => s.code).join('\n;\n'), ctx, { timeout: 4000 }); } catch (e) { runErrs.push(page + ': ' + e.message); }
  for (const [fn, args] of actions) {
    if (typeof ctx[fn] !== 'function') continue;
    try { const r = ctx[fn](...args); if (r && r.catch) r.catch(() => {}); } catch (e) { runErrs.push(page + ' ' + fn + ': ' + e.message); }
  }
  rendered.push(Object.values(els).map((e) => e.innerHTML + ' ' + e.textContent).join('\n'));
}
execPage('digital-esoko.html', [['purchaseProduct', ['P1']], ['openProductModal', ['P1']], ['showMyPurchases', []]]);
execPage('digital-esoko-seller.html', [['publishProduct', []], ['saveProduct', []]]);
execPage('digital.html', [['orderGig', ['G1', true]], ['acceptProposal', ['PR1', true]], ['submitWithdrawal', []]]);
execPage('digital-store.html', [['purchase', ['P1']], ['buyProduct', ['P1']]]);

ck('DG-1', spy.pay.length === 0 && spy.open.length === 0,
  'EXECUTED: Buy / order gig / accept proposal / withdraw entry points start NO SokoniPay / SokoniMpesa / IntaSend call, no browser invoice, open nothing',
  JSON.stringify(spy.pay) + ' open=' + JSON.stringify(spy.open));

const PAY_SRC = /SokoniPay|platformBook|\.gateway\(|saveCommission|saveBookingFee|darajaSTKPush|initiateSTKPush|SokoniMpesa|SokoniIntaSend|digitalProductPurchase|digitalProductDownload|httpsCallable/;
const PAY_SCRIPTS = /^(sokoni-pay|sokoni-intasend|sokoni-mpesa|sokoni-gateway|sokoni-invoice|sokoni-commission-rates|sokoni-upload)\.js$|firebase-functions/;
const payHits = PAGES.flatMap((p) => { const out = []; const m = INLINE[p].match(PAY_SRC); if (m) out.push(p + ':' + m[0]); srcs(H[p]).filter((s) => PAY_SCRIPTS.test(s.replace(/^.*\//, '')) || /firebase-functions/.test(s)).forEach((s) => out.push(p + ':<script src=' + s + '>')); return out; });
ck('DG-2', payHits.length === 0,
  'no payment path is reachable: no inline SokoniPay / platformBook / gateway / saveCommission / saveBookingFee / darajaSTKPush / initiateSTKPush / SokoniMpesa / digitalProduct* callable, and none of sokoni-pay / intasend / mpesa / gateway / invoice / commission-rates / functions SDK is loaded',
  payHits.join('  '));

const WRITE = /(addDoc|setDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\b|collection\([^)]*'(digitalPurchases|digitalProducts|withdrawals|digitalContracts|contracts|commissions|digital[A-Z]\w*)'|initializeApp\(/;
const writeHits = PAGES.filter((p) => WRITE.test(INLINE[p])).map((p) => p + ':' + INLINE[p].match(WRITE)[0]);
ck('DG-3', writeHits.length === 0,
  'no browser Firestore write from any of the four pages (digitalPurchases / digitalProducts / withdrawals / digitalContracts / commissions / any digital* collection) and no secondary Firebase app',
  writeHits.join('  '));

const FAKE = /published|escrow|submitted|Purchase complete|Payment confirmed|Contract created|Instant download|Downloading…|Owned</i;
const fakeHits = PAGES.filter((p) => FAKE.test(VISIBLE[p])).map((p) => p + ':' + VISIBLE[p].match(FAKE)[0]).concat(rendered.filter((r) => FAKE.test(r)).map((r) => 'rendered:' + r.match(FAKE)[0]));
ck('DG-4', fakeHits.length === 0,
  'no unconfirmed success copy: no "published" / "escrow" / "submitted" / "Purchase complete" / "Payment confirmed" / "Contract created" / "Instant download" (page source outside comments, and everything the executed scripts rendered)',
  fakeHits.join('  '));

const FIG = /Net Earnings|Total Earned|In Escrow|Total Spent|SOKONI Commission|sokoniCut|providerNet|SokoniCommission|Keep up to \d+%|\.reduce\(/;
const figHits = PAGES.filter((p) => FIG.test(stripComments(H[p]))).map((p) => p + ':' + stripComments(H[p]).match(FIG)[0]);
ck('DG-5', figHits.length === 0,
  'no browser-computed earnings / commission / wallet figure: no Net Earnings, Total Earned, In Escrow, Total Spent, commission %, "keep up to N%", and no client .reduce() summing', figHits.join('  '));

const waHits = PAGES.filter((p) => /wa\.me|api\.whatsapp|whatsapp:\/\//i.test(H[p]));
ck('DG-6', waHits.length === 0 && !spy.open.some((u) => /wa\.me|whatsapp/i.test(u)), 'no wa.me / WhatsApp hand-off on any of the four pages', waHits.join(','));

const INNER = /\.innerHTML\s*[+]?=/;
const sinkHits = PAGES.filter((p) => INNER.test(INLINE[p]));
ck('DG-7', sinkHits.length === 0 && !/<img src=x/.test(rendered.join('')),
  'no user-written text reaches an innerHTML sink: the contained pages render no seller / buyer / gig field at all (nothing left to escape)', sinkHits.join(','));

const esoko = VISIBLE['digital-esoko.html'];
const devOk = /Digital downloads are paused\./.test(esoko) && /href="category\.html\?cat=electronics"[^>]*>[^<]*Phones, laptops &amp; electronics/.test(esoko) && /href="category\.html\?cat=computers"/.test(esoko);
const storeOk = /location\.replace\('category\.html\?cat=electronics'\)/.test(H['digital-store.html']) && /href="category\.html\?cat=electronics"/.test(VISIBLE['digital-store.html']);
const sellerOk = /HubRegister\.open\(\{hub:'shopping',category:'retail-shop'\}\)/.test(VISIBLE['digital-esoko-seller.html']) && srcs(H['digital-esoko-seller.html']).includes('hub-register.js') && srcs(H['digital-esoko-seller.html']).includes('sokoni-init.js');
const gigOk = /Freelance gigs are moving to SOKONI Jobs\./.test(VISIBLE['digital.html']) && /href="jobs\.html"/.test(VISIBLE['digital.html']) && !/tech-hub\.html#freelancers/.test(H['digital.html']);
ck('DG-8', devOk && storeOk && sellerOk && gigOk,
  'honest replacements: eSOKO says "Digital downloads are paused." and links Phones, laptops & electronics (?cat=electronics) + ?cat=computers; digital-store sends to ?cat=electronics; the seller page opens the ONE intake HubRegister.open({hub:\'shopping\',category:\'retail-shop\'}) with hub-register.js + sokoni-init.js (firebase) loaded; digital.html says "Freelance gigs are moving to SOKONI Jobs." with a plain jobs.html link',
  'esoko=' + devOk + ' store=' + storeOk + ' seller=' + sellerOk + ' gigs=' + gigOk);

const IDX = read('index.html');
const idxBad = IDX.match(/href="digital-esoko(-seller)?\.html"|location\.href='digital-esoko(-seller)?\.html'|Pay M-Pesa · Instant Download/g) || [];
const idxDev = (IDX.match(/category\.html\?cat=electronics/g) || []).length >= 3 && /Phones, laptops &amp; electronics/.test(IDX);
ck('DG-9', idxBad.length === 0 && idxDev,
  'home (index.html): no link into the retired store or seller dashboard, no "Pay M-Pesa · Instant Download"; the Digital card / pill / quick link point at the device marketplace', idxBad.join(' ') + ' devLinks=' + idxDev);

/* ── CONTROLS: these must hold on live AND on this tree ── */
const catJs = read('category.js'), hr = read('hub-register.js');
ck('DG-10', exists('category.html') && /\belectronics\s*:/.test(catJs) && /\bcomputers\s*:/.test(catJs) && exists('jobs.html')
  && /id:'retail-shop'[^}]*hub:'shopping'/.test(hr) && /shopping:\s*'seller'/.test(hr),
  'CONTROL: every destination is real — category.html with categoryMeta electronics + computers, jobs.html, and hub-register CATS retail-shop (hub shopping -> role seller)');
const swMiss = PAGES.filter((p) => !srcs(H[p]).some((s) => /(^|\/)(sw-register|shared-header)\.js$/.test(s)));
ck('DG-11', swMiss.length === 0, 'CONTROL: every page still self-updates (sw-register.js or shared-header.js)', swMiss.join(','));

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed' + (runErrs.length ? '   (script errors during execution: ' + runErrs.join(' | ').slice(0, 300) + ')' : ''));
process.exit(fail ? 1 : 0);
