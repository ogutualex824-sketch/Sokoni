#!/usr/bin/env node
/* Track 2.6 — universal rollout, interceptor removal, shared-header migration.
 *
 *   node scripts/test-cart-universal.js
 *
 * Three things had to happen in this order, and each is asserted separately:
 *
 *   1. the service loads on every page that needs it — 311 of them
 *   2. the cart <-> sokoniCart interceptor is gone, with no compatibility writer
 *   3. shared-header.js, the last direct cart reader, moves to units()
 *
 * The order matters: migrating the header first would have hidden the cart badge on 299
 * pages, and removing the interceptor first would have desynchronised the food cart. That
 * sequencing is what blocks C and D exist to prove was respected.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const { stripComments, keepOnly, htmlScriptRegions } = require('./scan-legacy-wishlist.js');
const SCAN = require('./scan-cart-writers.js');
const STATE = require('./cart-migration-state.js');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const execOf = (f) => stripComments(f.endsWith('.html')
  ? keepOnly(read(f), htmlScriptRegions(read(f))) : read(f));
const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));

console.log('\nTRACK 2.6 — UNIVERSAL ROLLOUT + INTERCEPTOR REMOVAL\n' + '='.repeat(70));

/* ══ A. every consumer page loads the service ══ */
console.log('\nA. No page is left inert for want of the service');
{
  /* Read each page ONCE. Block A scans 311 files and previously re-read them per check;
     adding the async check pushed the suite past the harness's 60s limit and it started
     reporting TIMEOUT instead of a verdict — a guard that stops answering is worse than a
     slow one. One pass, cached. */
  const headerPages = [];
  const srcOf = new Map();
  for (const p of pages) {
    const s = read(p);
    if (/<script[^>]*src="shared-header\.js"/.test(s)) { headerPages.push(p); srcOf.set(p, s); }
  }
  const missing = headerPages.filter(p => !/src="sokoni-cart\.js"/.test(srcOf.get(p)));
  ck('A', 'the header is on a lot of pages (control)', headerPages.length > 300, headerPages.length);
  ck('A', 'every one of them loads sokoni-cart.js', missing.length === 0,
     missing.slice(0, 6).join(', '));
  /* THE REAL DEPENDENCY — corrected with real-browser evidence, not reasoning.

     This asserted that the service must EXECUTE before the header. That is not the
     dependency. shared-header.js does not read the cart when it executes; it gates on
     document.readyState and defers _inject() — and therefore the read — to
     DOMContentLoaded (shared-header.js ~2470, asserted below so the premise cannot rot).

     scripts/test-pos-cart-defer-browser.js measured this in Chromium against the shipped
     pos.html: the service was defined at readyState "loading", and all four reads happened
     at readyState "complete". Three Node simulations had failed to answer it first, each
     disproving the model rather than the code, which is why the answer came from a browser.

     So what must hold is narrower and truer: the service must be DEFINED before the header
     READS it. Every ordinary <script> tag — blocking or deferred — executes before
     DOMContentLoaded, so both qualify. What does NOT qualify is `async` (may land after)
     or no tag at all. Those still fail, and the mutation controls below still bite. */
  const badOrder = headerPages.filter(p => {
    const s = srcOf.get(p);
    const hm = s.match(/<script[^>]*src="shared-header\.js"[^>]*>/);
    const cm = s.match(/<script[^>]*src="sokoni-cart\.js"[^>]*>/);
    if (!hm || !cm) return true;                      /* missing entirely — still a defect */
    if (/\basync\b/.test(cm[0])) return true;         /* may execute after the read */
    return false;                                     /* blocking or deferred: both in time */
  });
  ck('A', 'the service is always DEFINED before the header reads it', badOrder.length === 0,
     badOrder.slice(0, 6).join(', '));
  /* The premise, pinned. If shared-header ever reads the cart eagerly instead of at
     DOMContentLoaded, the rule above stops being true — and this fails loudly rather than
     letting a stale assumption ride. */
  ck('A', 'shared-header still defers its injection to DOMContentLoaded (the premise)',
     /if \(document\.readyState === 'loading'\)\s*\{\s*document\.addEventListener\('DOMContentLoaded', _inject\);/
       .test(read('shared-header.js')));
  ck('A', 'no page loads the service async', headerPages.every(p =>
     !/<script[^>]*\basync\b[^>]*src="sokoni-cart\.js"|<script[^>]*src="sokoni-cart\.js"[^>]*\basync\b/.test(srcOf.get(p))));
  ck('A', 'exactly one service tag per page', headerPages.every(p =>
     (srcOf.get(p).match(/src="sokoni-cart\.js"/g) || []).length === 1),
     headerPages.filter(p => (srcOf.get(p).match(/src="sokoni-cart\.js"/g) || []).length !== 1).slice(0, 5).join(', '));

  /* RETIRED: 'never deferred'. Two problems, and the second is the worse one.

     Superseded — the browser probe proved a deferred service is still defined before the
     header reads it. And it was passing by ACCIDENT: the regex required `defer` to follow
     `src=`, while the tag written for pos.html is <script defer src="...">. It would have
     reported "never deferred" about a page that is deferred, which is the least useful
     thing a guard can do.

     Replaced by a count that matches on either attribute order, so which pages defer is
     visible rather than implied. */
  const deferred = headerPages.filter(p =>
    /<script[^>]*\bdefer\b[^>]*src="sokoni-cart\.js"|<script[^>]*src="sokoni-cart\.js"[^>]*\bdefer\b/
      .test(srcOf.get(p)));
  ck('A', 'deferred pages are known and few', deferred.length <= 1, deferred.join(', '));
  ck('A', 'the only deferred page is pos.html (perf-guard baseline: 4 blocking scripts)',
     deferred.length === 0 || (deferred.length === 1 && deferred[0] === 'pos.html'),
     deferred.join(', '));
  /* Any page whose own scripts call the service must also carry it. */
  const API = /SokoniCart\s*\.\s*(list|raw|has|find|lines|units|add|setQty|replace|removeAt|removeById|removeAllById|removeByCartId|clear|subscribe)\b/;
  const inlineUsers = pages.filter(p => API.test(execOf(p)));
  const inlineMissing = inlineUsers.filter(p => !/src="sokoni-cart\.js"/.test(read(p)));
  ck('A', 'pages with inline SokoniCart calls load it too', inlineMissing.length === 0,
     inlineMissing.join(', '));
}

/* ══ B. line endings survived a 293-file rollout ══ */
console.log('\nB. The rollout did not mangle any file');
{
  /* Compare against the commit that PERFORMED the rollout, not the working tree. These
     assertions were written while 2.6 was uncommitted, when the rollout WAS the working
     diff; once committed the tree went clean and they measured nothing — passing on an
     empty set would have been worse than failing. BASE is the rollout commit's parent, so
     the same evidence is re-checked for good. */
  const BASE = cp.execSync('git log --format=%H --grep="universal rollout, interceptor removed" -1',
    { cwd: ROOT, encoding: 'utf8' }).trim() + '~1';   /* ~1, NOT ^ — node spawns cmd.exe on
       Windows, where ^ is the ESCAPE character, so "<sha>^" silently became "<sha>" and this
       block diffed the rollout commit against itself and measured one file. */
  const changed = cp.execSync('git diff --name-only ' + BASE + ' -- "*.html"', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  ck('B', 'a large number of pages changed (control)', changed.length > 250, changed.length);
  /* Only the pages THIS rollout touched. availability-manager.html is Track 1 dirt and
     comparing it here says nothing. */
  /* ONE diff, split per file — this used to spawn `git diff` once per changed page, 250+
     subprocesses, and it was what pushed this suite past the harness's 60s limit into
     TIMEOUT. A guard that stops returning a verdict is worse than a slow one. */
  const wholeDiff = cp.execSync('git diff ' + BASE + ' -- "*.html"', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const perFile = new Map();
  for (const chunk of wholeDiff.split(/^diff --git /m).slice(1)) {
    const m = /^a\/(\S+)/.exec(chunk);
    if (m) perFile.set(m[1], chunk);
  }
  const rolled = changed.filter(f => /src="sokoni-cart\.js"/.test(perFile.get(f) || ''));
  ck('B', 'the rollout touched the expected number of pages', rolled.length > 250, rolled.length);

  /* Line endings: comparing against `git show HEAD:` is invalid — git may normalise on
     checkout, so a CRLF working file reads back as LF and every mixed file looks newly
     broken. Check the INSERTED BLOCK instead: its three lines must all end the same way
     as the tag line that follows them. That is exactly the property the rollout promised.  */
  const badEol = rolled.filter(f => {
    const s = read(f);
    const i = s.indexOf('<!-- Canonical cart access path');
    if (i === -1) return true;
    const j = s.indexOf('</script>', s.indexOf('sokoni-cart.js', i)) + '</script>'.length;
    const block = s.slice(i, j + 2);
    const crlf = (block.match(/\r\n/g) || []).length;
    const lf = (block.match(/(?<!\r)\n/g) || []).length;
    return crlf > 0 && lf > 0;                 /* the block itself must not be mixed */
  });
  ck('B', 'no inserted block mixes line endings', badEol.length === 0, badEol.slice(0, 6).join(', '));

  /* "Nothing removed" is the wrong bar: on a handful of pages the shared-header tag shares
     a line with a <link>, so inserting above it necessarily rewrites that line. The real
     property is CONTENT PRESERVATION — every removed line's content must still be present
     in the added lines. That catches a genuine deletion while allowing a line split.
     availability-manager.html is excluded: it is Track 1 dirt, not this rollout. */
  const PRE = require('./cart-migration-state.js').PRE_EXISTING;
  /* Compare the SET of resource tags before and after. Line-level diffing was the wrong
     tool: on a few pages the header tag shares a line with a <link> so an insertion
     rewrites that line, and on the four food pages the 2.5 block was deliberately MOVED.
     Both look like "content lost" to a line comparison and neither is. What must hold is
     that the page's tags are unchanged apart from gaining sokoni-cart.js. */
  const tagsOf = (src) => (src.match(/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*"[^"]+"/g) || [])
    .map(t => t.replace(/\s+/g, ' ').trim()).sort();
  const overreach = rolled.filter(f => {
    if (PRE.includes(f)) return false;
    const now = tagsOf(read(f));
    const was = tagsOf(cp.execSync('git show ' + BASE + ':"' + f + '"', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e8 }));
    const hadService = was.some(t => /sokoni-cart\.js/.test(t));
    const gained = now.filter(t => { const i = was.indexOf(t); if (i > -1) { was.splice(i, 1); return false; } return true; });
    /* `was` now holds anything LOST; `gained` anything new.
       The four food pages already carried the tag from 2.5 — this slice only MOVED it
       above their non-deferred header, so they gain nothing and must lose nothing. */
    /* Nothing may be LOST — that is the real perimeter and it stays absolute. */
    if (was.length > 0) return true;
    /* Gains were originally required to be exactly sokoni-cart.js. That froze every rolled
       page against all later work, and two unrelated workstreams have since landed
       legitimately: adult-gate.js (f8c5b5a, the canonical 18+ classification) and
       sokoni-sellability.js (dde631b) on product.html. Read literally, this check called
       them cart-migration overreach and failed.

       What this suite actually owns is the CART perimeter, so that is what it now asserts:
       the service tag arrived where it was missing, and no OTHER cart or wishlist authority
       was smuggled onto the page alongside it. A page gaining an unrelated module is not
       this suite's business; a page gaining a second cart is. */
    const extra = gained.filter(t => !/sokoni-cart\.js/.test(t));
    const rivalCartAuthority = extra.some(t => /(^|[\/"'])(.*cart.*|.*wishlist.*)\.js/i.test(t));
    if (rivalCartAuthority) return true;
    return hadService ? gained.length !== extra.length
                      : !gained.some(t => /sokoni-cart\.js/.test(t));
  });
  ck('B', 'every page kept all its tags; new ones are only the service',
     overreach.length === 0, overreach.slice(0, 6).join(', '));
  /* And prove the trailing bytes were not rewritten — the string round trip that broke
     28 files showed up first as a changed final newline. */
  const tailChanged = rolled.filter(f => {
    if (PRE.includes(f)) return false;
    const now = fs.readFileSync(path.join(ROOT, f));
    const was = cp.execSync('git show ' + BASE + ':"' + f + '"', { cwd: ROOT, encoding: 'buffer', maxBuffer: 1e8 });
    return Buffer.compare(now.slice(-8), was.slice(-8)) !== 0;
  });
  ck('B', 'no file had its trailing bytes rewritten', tailChanged.length === 0,
     tailChanged.slice(0, 6).join(', '));
}

/* ══ C. the cart interceptor is gone ══ */
console.log('\nC. The cart <-> sokoniCart interceptor is removed');
{
  const pw = execOf('provider-wiring.js');
  ck('C', 'no cart key appears in executable code at all',
     !/["'](cart|sokoniCart)["']/.test(pw),
     (pw.match(/["'](cart|sokoniCart)["']/g) || []).join(', '));
  ck('C', '_mergeCarts is gone', !/_mergeCarts/.test(pw));
  ck('C', 'the recursion guard is gone too', !/_bridging/.test(pw));
  ck('C', 'and it is no longer exported', !/mergeCarts\s*:/.test(pw));
  /* NO COMPATIBILITY WRITER: nothing may still write sokoniCart. */
  const hits = SCAN.scan().filter(h => h.key === 'sokoniCart');
  ck('C', 'nothing anywhere writes sokoniCart', !hits.some(h => h.kind === 'WRITE'),
     hits.filter(h => h.kind === 'WRITE').map(h => h.file + ':' + h.line).join(', '));
  ck('C', 'nothing anywhere reads it either', hits.length === 0,
     hits.map(h => h.file + ':' + h.line).join(', '));
  /* The file still patches setItem for PROVIDER and BOOKING keys — a different feature,
     deliberately untouched. Stated so "the interceptor is gone" is not read as
     "setItem is unpatched". */
  const patches = (pw.match(/localStorage\.setItem\s*=/g) || []).length;
  ck('C', 'two unrelated setItem watchers remain (provider + booking sync)', patches === 2, patches);
  ck('C', 'and neither of them watches a cart key',
     !/PROVIDER_KEYS[\s\S]{0,400}["']cart["']/.test(pw) && !/BK_KEYS[\s\S]{0,200}["']cart["']/.test(pw));
  /* It must still evaluate — removing a function that was still exported would have
     thrown a ReferenceError on every page security.js injects it into. */
  const g = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, JSON, Date, Math, Object, Array, String, Number, Set, Error, Promise, setTimeout,
    document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
      body: { appendChild() {} }, head: { appendChild() {} }, readyState: 'complete' },
    addEventListener() {}, dispatchEvent() { return true; }, CustomEvent: function () {},
    location: { pathname: '/index.html', href: '', search: '' } };
  g.window = g; vm.createContext(g);
  let evaluated = true;
  try { vm.runInContext(read('provider-wiring.js'), g); } catch (e) { evaluated = e.message; }
  ck('C', 'provider-wiring.js still evaluates cleanly', evaluated === true, evaluated);
  ck('C', 'its remaining public API is intact',
     !!(g.ProviderWiring && g.ProviderWiring.writeProvider && g.ProviderWiring.pullProviders),
     Object.keys(g.ProviderWiring || {}).join(','));
}

/* ══ D. shared-header.js ══ */
console.log('\nD. The header badge reads the canonical cart');
{
  const src = stripComments(read('shared-header.js'));
  ck('D', 'no direct cart read remains',
     !/localStorage\s*(?:\.\s*getItem\s*\(\s*|\[\s*)["']cart["']/.test(src));
  ck('D', 'it reads units()', /SokoniCart[\s\S]{0,40}units\(\)/.test(src));

  function header(opts) {
    opts = opts || {};
    const store = Object.assign({}, opts.seed || {});
    const g = {
      localStorage: { getItem: k => (k in store ? store[k] : null),
                      setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
      console, JSON, Date, Math, Object, Array, String, Number, Set, Error, RegExp,
      setTimeout, clearTimeout, isNaN, parseInt, parseFloat,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
      location: { pathname: '/index.html', href: '', search: '' },
    };
    g.window = g; g.store = store;
    vm.createContext(g);
    if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
    /* Only the state reader is needed; the rest of the header wants a live DOM. */
    const fn = read('shared-header.js').match(/function _readState\(\)[\s\S]*?\n  \}/)[0];
    vm.runInContext(fn, g);
    return g;
  }

  const g1 = header({ seed: { cart: JSON.stringify([{ id: 'a', qty: 3 }, { id: 'b' }]) } });
  ck('D', 'counts UNITS, not lines', g1._readState().cartCount === 4, g1._readState().cartCount);
  const g2 = header({ seed: { cart: '[]' } });
  ck('D', 'a genuinely empty cart is 0', g2._readState().cartCount === 0, g2._readState().cartCount);
  const g3 = header({ withoutService: true, seed: { cart: JSON.stringify([{ id: 'a', qty: 3 }]) } });
  ck('D', 'UNKNOWN is null — never 0', g3._readState().cartCount === null,
     JSON.stringify(g3._readState().cartCount));
  ck('D', 'so "no service" and "empty cart" stay distinguishable',
     g2._readState().cartCount !== g3._readState().cartCount);
  /* And neither renders the string "null" into the pip. */
  const hdr = read('shared-header.js');
  ck('D', 'the pip renders blank, not "null", when unknown',
     /cartCount == null\) \? '' : cartCount/.test(hdr));
  ck('D', 'the aria-label does not announce "0 items" for an unknown cart',
     /cartCount == null \? 'Cart' :/.test(hdr));
}

/* ══ E. cross-page consistency ══ */
console.log('\nE. Every badge on the platform now counts the same way');
{
  /* Each surface's badge, exercised against one shared cart. */
  const CART = JSON.stringify([{ id: 'a', qty: 3 }, { id: 'b' }, { type: 'food', cartId: 'C1', itemId: 'd', qty: 2 }]);
  const expected = 3 + 1 + 2;                       /* Σ(qty||1) */
  function svc(seed) {
    const store = { cart: seed };
    const g = { localStorage: { getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
      console, JSON, Date, Math, Object, Array, String, Number, Set, Error, RegExp, setTimeout,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      CustomEvent: function () {} };
    g.window = g; vm.createContext(g);
    vm.runInContext(read('sokoni-cart.js'), g);
    return g.SokoniCart;
  }
  ck('E', 'the service agrees with the header formula', svc(CART).units() === expected,
     svc(CART).units() + ' vs ' + expected);
  /* Every migrated badge site must call units(), not lines() or .length. */
  const badgeFiles = ['shared-header.js', 'market-actions.js', 'category.js', 'script.js',
                      'sokoni-food.js', 'wishlist.html', 'cart.html', 'food.html', 'flashsale.html'];
  const wrong = badgeFiles.filter(f => {
    const s = execOf(f);
    return /cart[\s\S]{0,40}\.length/i.test(s) && !/units\(\)/.test(s);
  });
  ck('E', 'no badge site still counts array length', wrong.length === 0, wrong.join(', '));
  const usesUnits = badgeFiles.filter(f => /units\(\)/.test(execOf(f)));
  ck('E', 'the badge sites read units()', usesUnits.length >= 7, usesUnits.join(', '));
}

/* ══ F. the whole repo ══ */
console.log('\nF. Repo-wide state');
{
  const hits = SCAN.scan().filter(h => h.key === 'cart');
  const files = [...new Set(hits.map(h => h.file))];
  const rogue = files.filter(f => f !== 'sokoni-cart.js' && !STATE.TEST_HARNESS.includes(f));
  ck('F', 'the ONLY direct cart access left is the service and the test harness',
     rogue.length === 0, rogue.join(', '));
  ck('F', 'no survivors remain declared',
     STATE.FROZEN_FILES.length === 0 && STATE.BLOCKED_FILES.length === 0 &&
     STATE.DEFERRED_FILES.length === 0,
     'frozen=' + STATE.FROZEN_FILES.length + ' blocked=' + STATE.BLOCKED_FILES.length +
     ' deferred=' + STATE.DEFERRED_FILES.length);
  ck('F', 'and none is needed — nothing is unaccounted', SCAN.scan()
     .filter(h => h.key === 'cart' && h.file !== 'sokoni-cart.js' && !STATE.TEST_HARNESS.includes(h.file))
     .length === 0);
}

/* ══ G. guards ══ */
console.log('\nG. Guards held');
{
  ck('G', 'the checkout payment contract is untouched',
     /orderItems: cart/.test(execOf('checkout.html')));
  /* RETIRED at the release pass. This asserted the saveAndRedirect fallback still summed
     price WITHOUT quantity — correct while that defect was deliberately carried, and now
     false by authorisation: the release explicitly cleared it as a money-path blocker.

     Replaced by the constraints that outlive the fix: the fallback is quantity-aware, it
     shares ONE line-total with the displayed subtotal rather than carrying a second copy,
     and the charge is still the server's. scripts/test-checkout-fallback-total.js proves
     the arithmetic; these keep the cart suites honest about it. */
  ck('G', 'the saveAndRedirect fallback is quantity-aware',
     /currentCart\.reduce\(\(s, p\) => s \+ _ckLineTotal\(p\), 0\)/.test(read('checkout.html')));
  ck('G', 'the qty-blind sum is gone',
     !/reduce\(\(s,p\) => s \+ Number\(p\.price\|\|0\), 0\)/.test(read('checkout.html')));
  ck('G', 'the line total has exactly ONE definition',
     (read('checkout.html').match(/function _ckLineTotal/g) || []).length === 1);
  ck('G', 'the charge is still server-authoritative',
     /amount:\s*stkAmount \?\? _serverTotalOverride \?\? orderTotal/.test(read('checkout.html')));
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  /* RETIRED at the release pass — checkout.html IS modified now, by the authorised
     money-path fix. What replaces it is the thing that must stay true: the payment
     contract the 2.6 rollout was protecting is intact. */
  ck('G', 'the checkout payment contract survived the fallback fix',
     /orderItems: cart/.test(execOf('checkout.html')) &&
     /_serverTotalOverride/.test(read('checkout.html')));
  /* Scoped to product files: scripts/test-cart-wishlist-page.js is a cart SUITE whose
     name contains "wishlist", and matching it flagged a guard against itself. */
  ck('G', 'no wishlist product file was touched',
     !changed.some(f => /wishlist/i.test(f) && !STATE.isSuite(f)),
     changed.filter(f => /wishlist/i.test(f) && !STATE.isSuite(f)).join(', '));
  ck('G', 'no Firestore rules change', !changed.some(f => /firestore\.rules/.test(f)),
     changed.filter(f => /firestore\.rules/.test(f)).join(', '));
  ck('G', 'the minishop SokoniCart.open collision is still inert — our service has no open()',
     !/open\s*:/.test(stripComments(read('sokoni-cart.js'))));
}

console.log('\n' + '='.repeat(70));
console.log('Track 2.6 acceptance\n');
['A','B','C','D','E','F','G'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
