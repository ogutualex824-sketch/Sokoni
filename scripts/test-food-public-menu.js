#!/usr/bin/env node
/* FOOD HUB GATE 2 — the buyer Food page renders a restaurant's REAL published menu (sokoni-food-public-menu.js).
 *   node scripts/test-food-public-menu.js          BASE=df0ddbd node scripts/test-food-public-menu.js (must FAIL)
 * Executes the REAL renderer in a vm against scripted server answers. No browser. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\nFood public menu   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const SRC = read('sokoni-food-public-menu.js');
const CONTAINED = '<div class="food-opening-soon">Ordering opens soon</div>';

function env(answer, opts) {
  const calls = [];
  const els = { menuBody: { innerHTML: CONTAINED }, pageTitle: { textContent: 'Food Hub' } };
  const ctx = { console, Promise, String, Object, Date, setTimeout, URLSearchParams, document: { title: 'x', getElementById: (id) => els[id] || null }, window: null };
  ctx.window = ctx; ctx.location = { search: (opts && opts.search) || '' };
  if (!(opts && opts.noCallable)) ctx.sokoniCallable = (name) => async (payload) => { calls.push([name, payload]); if (answer instanceof Error) throw answer; return { data: answer }; };
  vm.createContext(ctx);
  try { vm.runInContext(SRC, ctx); } catch (e) { return { err: e.message }; }
  return { ctx, els, calls };
}
const MENU = { ok: true, available: true, ordering: 'NOT_OPEN', shop: { id: 'shopA', name: 'Mama <b>Oliech</b>' },
  sections: [{ id: 'mains', name: 'Mains', kind: 'food' }, { id: 'soft', name: 'Soft drinks', kind: 'drinks' }, { id: 'empty', name: 'Desserts', kind: 'food' }],
  items: [
    { id: 'p1', name: 'Fish & ugali', description: 'Whole tilapia', price: 650, sectionId: 'mains', availability: 'in_stock', sellable: true, orderable: false, variants: [], image: 'https://firebasestorage.googleapis.com/x.jpg' },
    { id: 'p2', name: 'Passion "juice"<script>', price: 120, sectionId: 'soft', availability: 'out_of_stock', sellable: false, orderable: false, variants: [{ name: '500ml', price: 180 }], image: 'javascript:alert(1)' },
  ] };

(async () => {
  let e = env(MENU);
  if (e.err || !e.ctx.SokoniFoodPublicMenu) { ck('LOAD', false, 'the renderer loads', e.err || 'NO_MODULE'); console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  let r = await e.ctx.SokoniFoodPublicMenu.show('shopA');
  const h = e.els.menuBody.innerHTML;
  ck('PM-1', r === 'menu' && e.calls[0][0] === 'foodMenu' && e.calls[0][1].op === 'public' && e.calls[0][1].shopId === 'shopA', 'asks foodMenu {op:public} for this shop', e.calls);
  ck('PM-2', /Fish &amp; ugali/.test(h) && /KES 650/.test(h) && /Mains/.test(h) && /Soft drinks/.test(h) && !/Desserts/.test(h), 'renders the server\'s sections and items (an empty section is not shown)');
  ck('PM-3', /Ordering opens soon/.test(h) && !/add to cart|addToCart|Order now|Pay|data-add/i.test(h.replace(/payments are not open/i, '')), 'ordering is NOT open: the banner stays, and there is no cart / add / pay control');
  ck('PM-4', /Sold out/.test(h), 'a sold-out item says so (server availability)');
  ck('PM-5', !/<script>/.test(h) && !/<b>Oliech/.test(h) && /&lt;script&gt;/.test(h) && !/javascript:/.test(h), 'server strings are escaped and a non-https image is dropped');
  ck('PM-6', /Mama &lt;b&gt;Oliech&lt;\/b&gt;/.test(h) && e.els.pageTitle.textContent === 'Mama <b>Oliech</b>', 'the title is the real shop name (textContent, not HTML)');
  for (const [id, ans, msg] of [['PM-7', { ok: true, available: false, reason: 'SHOP_NOT_PUBLIC', sections: [], items: [] }, 'a shop that is not public'],
    ['PM-8', { ok: true, available: false, reason: 'NO_FOOD_MENU', sections: [], items: [] }, 'a non-food shop'], ['PM-9', new Error('offline'), 'an unreachable server']]) {
    e = env(ans); r = await e.ctx.SokoniFoodPublicMenu.show('shopA');
    ck(id, e.els.menuBody.innerHTML === CONTAINED && r !== 'menu', msg + ' → the "Ordering opens soon" message is left untouched; nothing invented', r);
  }
  e = env(MENU); r = await e.ctx.SokoniFoodPublicMenu.show('../x');
  ck('PM-10', r === 'no-shop' && e.calls.length === 0, 'a malformed shop id is never sent');
  const PAGE = read('food-menu.html');
  ck('PM-11', /<script defer src="sokoni-food-public-menu\.js"><\/script>/.test(PAGE) && /<script type="module" src="firebase\.js"><\/script>/.test(PAGE) && /sw-register\.js/.test(PAGE), 'food-menu.html loads the renderer (and still self-updates)');
  ck('PM-12', !/setDoc|addDoc|updateDoc|foodOrders|platformBook|localStorage/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')), 'the renderer writes nothing and starts no payment');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
