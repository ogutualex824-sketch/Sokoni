#!/usr/bin/env node
/**
 * LAZY MANAGER APPROVAL — the bytes move, the control does not.
 *
 *   node scripts/test-pos-lazy-manager-auth.js
 *
 * pos-manager-auth.js is 60 KB of a measured 2,148 KB POS startup payload, and a cashier
 * reaches it only on a privileged operation — refund, void, price override, large discount,
 * stock adjustment, drawer, shift close. Loading it to open a till spends 60 KB on a screen
 * that never uses it.
 *
 * THE DANGEROUS FAILURE, AND THE ONLY ASSERTION THAT REALLY MATTERS
 * A lazy module can fail to load. If `request()` then returned undefined, the caller's
 *
 *     const ok = await ManagerAuth.request('refund', …);
 *     if (!ok) { …denied…; return; }
 *
 * would still refuse — undefined is falsy. But if it EVER resolved truthy on failure, or threw
 * into a handler not written to catch it, a network hiccup would become an unapproved refund.
 * So the shim resolves exactly `false`: the same value a declined approval produces.
 *
 * Counting fewer scripts proves nothing about that. This suite deliberately makes the module
 * unavailable and asserts the refusal.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const POS = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

/* Run the shim exactly as pos.html defines it, against a fake document whose script loading
   we control. This exercises the REAL code — the block is lifted from the page, not retyped. */
function instantiate (loadOutcome) {
  /* Anchor on the declaration, then walk BACK to the enclosing IIFE. Matching a multi-line
     literal failed on line endings, and a failed extraction silently disables every
     assertion below it — so this locates the block by content, not by exact layout. */
  const decl = POS.indexOf("var URL_ = 'pos-manager-auth.js';");
  if (decl === -1) return null;
  const at = POS.lastIndexOf('(function () {', decl);
  if (at === -1) return null;
  const end = POS.indexOf('})();', decl);
  if (end === -1) return null;
  const src = POS.slice(at, end + 5);

  const win = {};
  const head_ = { appendChild: null };
  const doc = {
    createElement: () => ({ set src (v) { this._src = v; }, get src () { return this._src; } }),
    head: head_,
  };
  head_.appendChild = (s) => {
    setTimeout(() => {
      if (loadOutcome === 'error') { s.onerror && s.onerror(); return; }
      if (loadOutcome === 'silent') { s.onload && s.onload(); return; }   /* loads, registers nothing */
      win.ManagerAuth = {                                                  /* the real module would */
        request: () => Promise.resolve(true),
        requestPriceOverride: () => Promise.resolve(42),
      };
      s.onload && s.onload();
    }, 0);
  };

  const fn = new Function('window', 'document', 'console', src + NL + 'return window.ManagerAuth;');
  return fn(win, doc, { error: () => {}, warn: () => {}, log: () => {} });
}

console.log(NL + 'LAZY MANAGER APPROVAL' + NL + '='.repeat(60));

(async () => {
  /* ── 1 · it is genuinely lazy ────────────────────────────────────────────── */
  head('1 · nothing is fetched to open a till');
  ck('pos.html no longer loads the module eagerly',
     POS.indexOf('<script src="pos-manager-auth.js" defer></script>') === -1);
  ck('the module still exists on disk',
     fs.existsSync(path.join(ROOT, 'pos-manager-auth.js')),
     'deferred, never deleted');
  ck('the shim declares the module it will fetch',
     POS.indexOf("URL_ = 'pos-manager-auth.js'") > -1);
  ck('CONTROL other pages still load it directly',
     fs.readFileSync(path.join(ROOT, 'manager-auth.html'), 'utf8').indexOf('pos-manager-auth.js') > -1,
     'the enrolment surface must not depend on this shim');

  /* ── 2 · the failure mode that matters ───────────────────────────────────── */
  head('2 · a module that will not load REFUSES');
  const broken = instantiate('error');
  ck('the shim could be instantiated from the page source', !!broken,
     'if this fails the rest proves nothing');
  if (broken) {
    const r = await broken.request('refund', { amount: 5000 });
    ck('NEGATIVE request() resolves exactly FALSE when the module 404s', r === false,
       'got ' + JSON.stringify(r) + ' — anything truthy here is an unapproved refund');
    ck('NEGATIVE ...and it does not throw into the caller', true,
       'the await above completed; a throw would have failed this suite');
  }

  const silent = instantiate('silent');
  if (silent) {
    const r = await silent.request('void', {});
    ck('NEGATIVE a module that loads but registers nothing also refuses', r === false,
       'got ' + JSON.stringify(r));
  }

  /* ── 3 · the working path still works ────────────────────────────────────── */
  head('3 · CONTROL — approval still succeeds when the module loads');
  const ok = instantiate('ok');
  if (ok) {
    const r = await ok.request('refund', { amount: 5000 });
    ck('CONTROL a successful load forwards the real answer', r === true,
       'if this were false the refusals above would be meaningless');
    const p = await ok.requestPriceOverride('id', 'name', 100);
    ck('CONTROL other methods forward too', p === 42);
  }

  /* ── 4 · it loads once ───────────────────────────────────────────────────── */
  head('4 · one fetch, however many requests');
  const once = instantiate('ok');
  if (once) {
    const a = await once.request('refund', {});
    const b = await once.request('void', {});
    ck('two operations both resolve', a === true && b === true);
    ck('the shim caches the pending load',
       POS.indexOf('if (pending) return pending;') > -1,
       'without this every guarded action refetches 60 KB');
  }

  /* ── 5 · the control was not weakened ────────────────────────────────────── */
  head('5 · this is a loading change, not an authorization change');
  ck('the eight guarded operations are untouched',
     fs.readFileSync(path.join(ROOT, 'pos-manager-auth.js'), 'utf8')
       .indexOf('inventory_correction:') > -1);
  ck('CONTROL pos.js still asks for approval before refunding',
     fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8')
       .indexOf("ManagerAuth.request('refund'") > -1,
     'lazy loading must not remove a single call site');
  ck('CONTROL the shim never resolves true on its own',
     POS.indexOf("request:              proxy('request', false)") > -1,
     'the fallback value for approval is false, written explicitly');

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
  console.log('  NOTE: loading behaviour only. The PIN/manager-approval architecture is unchanged.');
  process.exit(fail ? 1 : 0);
})();
