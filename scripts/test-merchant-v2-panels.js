#!/usr/bin/env node
/**
 * MERCHANT SHELL — PANEL RENDERING.
 *
 *   node scripts/test-merchant-v2-panels.js
 *
 * Two defects that both presented to the merchant as "a blank black surface", which is
 * the one thing a panel must never be — it is indistinguishable from an empty account.
 *
 * 1. ONE RENDERER, THREE PANELS. analytics | revenue | reports share renderAnalytics,
 *    and each panel builds a node with the SAME id (an-body). The paint functions used
 *    document.getElementById, which returns the FIRST in document order — so once
 *    Analytics had been opened, painting Revenue wrote into the HIDDEN Analytics panel
 *    and left Revenue's own panel empty.
 *
 * 2. CLEAR-THEN-MOUNT. renderModule sets p.innerHTML='' and then called G.mount()
 *    unguarded. A throw left a permanently empty panel with no message and no retry.
 *
 * Both are exercised through the REAL functions lifted out of merchant-v2.html.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(String.fromCharCode(10) + t);

function grab (name) {
  const i = SRC.indexOf('function ' + name + ' (');
  const j = i === -1 ? SRC.indexOf('function ' + name + '(') : i;
  if (j === -1) return null;
  let d = 0, started = false;
  for (let k = j; k < SRC.length; k++) {
    const c = SRC[k];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return SRC.slice(j, k + 1); }
  }
  return null;
}

/* ── a DOM with the property that matters: getElementById returns the FIRST match ── */
function makeDom () {
  const reg = [];
  function node (id) {
    const n = {
      id: id || '', innerHTML: '', dataset: {}, style: {},
      classList: { add () {}, remove () {}, contains () { return false; } },
      children: [],
      querySelector (sel) {
        const want = String(sel).replace('#', '');
        return this.children.filter((c) => c.id === want)[0] || null;
      },
      addEventListener () {},
    };
    return n;
  }
  const doc = {
    getElementById (id) { return reg.filter((n) => n.id === id)[0] || null; },
  };
  return { doc, node, reg };
}

console.log(String.fromCharCode(10) + 'MERCHANT SHELL — PANEL RENDERING' + String.fromCharCode(10) + '='.repeat(62));

head('1 · one renderer, three panels — the paint must land in the RIGHT one');
const anElSrc = grab('anEl');
ck('anEl was extracted from the shell', !!anElSrc, anElSrc ? anElSrc.length + ' chars' : 'NOT FOUND');

(function () {
  const { doc, node, reg } = makeDom();
  /* Analytics is built FIRST, so its an-body is first in document order. */
  const panelA = node('p-analytics'); const bodyA = node('an-body');
  panelA.children.push(bodyA); reg.push(bodyA);
  const panelR = node('p-revenue');   const bodyR = node('an-body');
  panelR.children.push(bodyR); reg.push(bodyR);

  ck('CONTROL the document lookup really does return the ANALYTICS node',
     doc.getElementById('an-body') === bodyA,
     'if this were false the defect could not have happened and the test proves nothing');

  const sandbox = { AN: { panel: panelR }, document: doc, console };
  vm.createContext(sandbox);
  vm.runInContext(anElSrc + '; var got = anEl("an-body");', sandbox);
  ck('painting Revenue resolves REVENUE\'s own node', sandbox.got === bodyR);
  ck('...and NOT the hidden Analytics panel', sandbox.got !== bodyA,
     'this was the blank black Revenue surface');

  /* The fallback must still work for any caller with no panel recorded. */
  const s2 = { AN: { panel: null }, document: doc, console };
  vm.createContext(s2);
  vm.runInContext(anElSrc + '; var got = anEl("an-body");', s2);
  ck('with no panel recorded it falls back to the document', s2.got === bodyA,
     'the fallback is the OLD behaviour — kept, but no longer the only path');
})();

head('2 · the shell records the panel it is rendering');
const ra = grab('renderAnalytics');
ck('renderAnalytics assigns AN.panel', !!ra && ra.indexOf('AN.panel = p') > -1);
ck('no an-* lookup is document-wide any more',
   SRC.indexOf("document.getElementById('an-") === -1,
   'a single missed call reintroduces the defect for that one surface');

head('2b · all THREE routes sharing the renderer were affected');
/* Reports was reported blank alongside Revenue, and for the same reason: nativePanel()
   caches a DISTINCT element per route, so analytics | revenue | reports each build their
   own an-body with the same id, and only the first was ever found. */
ck('nativePanel keys by route, so the three panels are distinct',
   SRC.indexOf("var k = 'native:' + id;") > -1,
   'if they shared one element there would have been no duplicate id and no defect');
ck('all three routes go through the one renderer',
   /id === 'analytics' || id === 'revenue' || id === 'reports'/.test(SRC));
ck('CONTROL the shared renderer is still SHARED, not forked per route',
   (SRC.match(/function renderAnalytics/g) || []).length === 1,
   'two implementations would be two sets of numbers');

head('3 · a module that throws must SAY so, never leave an empty panel');
const rm = grab('renderModule');
ck('renderModule was extracted', !!rm, rm ? rm.length + ' chars' : 'NOT FOUND');

function mountCase (mountFn) {
  const { node } = makeDom();
  const p = node('panel');
  const sandbox = {
    MODULES: { shop: { global: 'G_SHOP', ctx: () => ({}) } },
    window: { G_SHOP: { mount: mountFn } },
    _mounted: {}, byId: { shop: { name: 'Shop Details' } },
    esc: (x) => String(x), console: { error () {}, warn () {} },
    _scope: () => ({}), _scopeKey: () => 'k',
    r_name: (id) => 'Shop Details',
  };
  vm.createContext(sandbox);
  vm.runInContext(rm + '; renderModule("shop", p);', Object.assign(sandbox, { p }));
  return { p, sandbox };
}

(function () {
  const bad = mountCase(() => { throw new Error('boom'); });
  ck('a throwing mount leaves a MESSAGE, not an empty panel',
     bad.p.innerHTML.length > 0, bad.p.innerHTML.slice(0, 70) || '(EMPTY — the defect)');
  ck('...it names the surface the merchant clicked',
     bad.p.innerHTML.indexOf('Shop Details') > -1);
  ck('...and reports the real cause rather than inventing one',
     bad.p.innerHTML.indexOf('boom') > -1);
  ck('...and offers a retry wired to the MODULE, not to Orders',
     bad.p.innerHTML.indexOf('data-retry="module"') > -1 &&
     bad.p.innerHTML.indexOf('data-module="shop"') > -1);
  ck('...and nothing is left registered as mounted',
     bad.sandbox._mounted.shop === null || bad.sandbox._mounted.shop === undefined);
})();

(function () {
  const good = mountCase((host) => { host.innerHTML = '<b>real content</b>'; return { destroy () {} }; });
  ck('CONTROL a healthy mount is untouched by the guard',
     good.p.innerHTML.indexOf('real content') > -1, good.p.innerHTML.slice(0, 50));
  ck('CONTROL ...and IS registered as mounted', !!good.sandbox._mounted.shop);
})();

head('4 · the retry the error offers actually exists');
ck('the delegate has a module branch',
   SRC.indexOf("r.dataset.retry === 'module'") > -1,
   'without it the else falls through and re-renders ORDERS');
ck('CONTROL the orders/payments branches still stand',
   SRC.indexOf("r.dataset.retry === 'payments'") > -1);

console.log(String.fromCharCode(10) + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
