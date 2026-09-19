/* ============================================================================
   CERTIFICATION — AdminOS Products workspace
   scripts/test-aos-products.js
   ============================================================================
   THE INVARIANT THIS SUITE EXISTS TO PROTECT

       stock 0        = OUT OF STOCK   (a real, canonical zero)
       stock ABSENT   = NOT METERED    (which is NOT zero)

   Collapsing those invents a stockout that never happened, on a catalogue an
   operator acts on. So it is certified in BOTH directions: an absent field must
   never render or count as zero, AND a measured zero must still render and count
   as zero. A suite checking only the first would pass a surface that hid every
   genuine stockout.

   Also certified: the workspace never claims a catalogue total (it counts the
   loaded page), it renders an unknown status verbatim instead of defaulting to
   active, it escapes hostile fields, and it holds no write authority of its own.

   Every absence assertion is paired with a positive control. The harness fails
   closed.

   RUN  node scripts/test-aos-products.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MIN_ASSERTIONS = 45;

let PASS = 0, FAIL = 0, ASSERTS = 0;
const FAILURES = [];
let _caseAsserts = 0;

function ok(label, cond, detail) {
  ASSERTS++; _caseAsserts++;
  if (cond) { PASS++; return true; }
  FAIL++; FAILURES.push(label + (detail ? '  — ' + detail : ''));
  return false;
}
function runCase(name, fn) {
  _caseAsserts = 0;
  try { fn(); } catch (e) {
    ASSERTS++; FAIL++;
    FAILURES.push('[' + name + '] THREW: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
    return;
  }
  if (_caseAsserts === 0) {
    ASSERTS++; FAIL++;
    FAILURES.push('[' + name + '] registered NO assertions — a silent case is a failure.');
  }
}

/* ── Minimal DOM ─────────────────────────────────────────────────────── */
function load() {
  const byId = {};
  const head = { appendChild(el) { if (el.id) byId[el.id] = el; } };
  const doc = {
    head,
    getElementById: (id) => byId[id] || null,
    createElement: () => ({ id: '', textContent: '', innerHTML: '', appendChild() {} }),
  };
  const sandbox = { window: {}, document: doc, console, Date, Math, Object,
                    isFinite, Number, String, Array, JSON };
  sandbox.window.document = doc;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sokoni-aos-products.js'), 'utf8'),
                  sandbox, { filename: 'sokoni-aos-products.js' });
  return sandbox.window.SokoniAOSProducts;
}

function mount(products, actions) {
  const API = load();
  const host = { innerHTML: '' };
  const shown = API.mount({ host, products, actions });
  return { API, host, shown };
}

/* ── Fixtures ────────────────────────────────────────────────────────── */
const NOW = Date.now();
const base = { sellerUid: 'seller-1', category: 'Audio', updatedAt: NOW - 3600000 };

const METERED_ZERO  = Object.assign({ id: 'z', name: 'Zero Stock', stock: 0,  price: 100 }, base);
const UNMETERED     = Object.assign({ id: 'u', name: 'No Stock Field', price: 200 }, base);
const LOW           = Object.assign({ id: 'l', name: 'Low Stock',  stock: 5,   price: 300 }, base);
const PLENTY        = Object.assign({ id: 'p', name: 'In Stock',   stock: 320, price: 400 }, base);
const NULL_STOCK    = Object.assign({ id: 'n', name: 'Null Stock', stock: null, price: 500 }, base);

(function main() {

  /* ── A. The invariant, both directions ───────────────────────────── */

  runCase('A1 an absent stock field is NOT METERED, never zero', () => {
    const API = load();
    const s = API._stockState(UNMETERED);
    ok('A1 kind is unmetered', s.kind === 'unmetered', 'got ' + s.kind);
    ok('A1 value is null, not 0', s.n === null, 'got ' + s.n);
    ok('A1 it is not classified out of stock', s.kind !== 'out');
    /* POSITIVE CONTROL — the same function DOES report out-of-stock for a real
       zero, so "not out" above is a judgement rather than a dead branch. */
    ok('A1 control: a measured 0 IS out of stock', API._stockState(METERED_ZERO).kind === 'out');
  });

  runCase('A2 a measured zero survives as a real zero', () => {
    const API = load();
    const s = API._stockState(METERED_ZERO);
    ok('A2 kind is out', s.kind === 'out', 'got ' + s.kind);
    ok('A2 value is 0, not null', s.n === 0, 'got ' + s.n);
    ok('A2 it is NOT treated as unmetered', s.kind !== 'unmetered');
  });

  runCase('A3 a null stock field is unmetered, not zero', () => {
    const API = load();
    const s = API._stockState(NULL_STOCK);
    ok('A3 null is unmetered', s.kind === 'unmetered', 'got ' + s.kind);
    ok('A3 null is not out of stock', s.kind !== 'out');
  });

  runCase('A4 low and in-stock are distinguished from both', () => {
    const API = load();
    ok('A4 5 is low', API._stockState(LOW).kind === 'low');
    ok('A4 320 is in stock', API._stockState(PLENTY).kind === 'in');
    ok('A4 low carries its number', API._stockState(LOW).n === 5);
  });

  runCase('A5 the tally counts unmetered separately from out-of-stock', () => {
    const API = load();
    const t = API._tally([METERED_ZERO, UNMETERED, NULL_STOCK, LOW, PLENTY]);
    ok('A5 control: everything was counted', t.total === 5, 'total=' + t.total);
    ok('A5 exactly one out-of-stock', t.out === 1, 'out=' + t.out);
    ok('A5 two unmetered (absent + null)', t.unmetered === 2, 'unmetered=' + t.unmetered);
    ok('A5 unmetered did NOT inflate out-of-stock', t.out !== 3);
    ok('A5 one low', t.low === 1);
    ok('A5 one in stock', t.inStock === 1);
  });

  /* ── B. Rendered output honours the same rule ────────────────────── */

  const rendered = mount([METERED_ZERO, UNMETERED, LOW, PLENTY]).host.innerHTML;

  runCase('B1 the rendered rows distinguish zero from unmetered', () => {
    ok('B1 control: the table rendered', /ap-table/.test(rendered));
    ok('B1 control: all four products rendered',
       /Zero Stock/.test(rendered) && /No Stock Field/.test(rendered) &&
       /Low Stock/.test(rendered) && /In Stock/.test(rendered));
    ok('B1 an unmetered row says so', /not metered/.test(rendered));
    /* The cell carries a title attribute between the class and the text, so the
       assertion anchors on the class and then on the dash it wraps — not on an
       exact attribute order that would break on any tooltip change. */
    ok('B1 the unmetered row shows an em dash',
       /class="ap-em"[^>]*>—</.test(rendered));
    ok('B1 a measured zero renders the digit 0', /ap-n out">0</.test(rendered));
    ok('B1 the zero is NOT rendered as an em dash',
       !/ap-n out">—</.test(rendered));
  });

  runCase('B2 the stat row keeps the two buckets apart', () => {
    ok('B2 control: stats rendered', /ap-stats/.test(rendered));
    ok('B2 an "Out of stock" tile exists', /Out of stock/.test(rendered));
    ok('B2 a "Not metered" tile exists', /Not metered/.test(rendered));
    ok('B2 the not-metered tile disclaims zero', /no stock field — not zero/.test(rendered));
  });

  runCase('B3 no figure is presented as a catalogue total', () => {
    ok('B3 control: the footer rendered', /ap-foot/.test(rendered));
    ok('B3 it names the loaded page', /loaded page/.test(rendered));
    ok('B3 it disclaims a platform total', /none of these is a platform total/.test(rendered));
    ok('B3 the Loaded tile is labelled per-page', /products on this page/.test(rendered));
  });

  /* ── C. Status is rendered, never assumed ────────────────────────── */

  runCase('C1 an unknown status is shown verbatim, not defaulted to active', () => {
    const odd = Object.assign({}, base, { id: 'o', name: 'Odd', stock: 1, status: 'quarantined' });
    const html = mount([odd]).host.innerHTML;
    ok('C1 control: the row rendered', /Odd/.test(html));
    ok('C1 the real status is shown', /quarantined/.test(html));
    ok('C1 it is NOT relabelled active', !/ap-chip ok">active/.test(html));
    ok('C1 it falls into the neutral bucket', /ap-chip unknown/.test(html));
  });

  runCase('C2 a missing status is not invented', () => {
    const none = Object.assign({}, base, { id: 'x', name: 'NoStatus', stock: 1 });
    const html = mount([none]).host.innerHTML;
    ok('C2 control: the row rendered', /NoStatus/.test(html));
    ok('C2 absence is shown as (none)', /\(none\)/.test(html));
    ok('C2 it is not shown as active', !/ap-chip ok">active/.test(html));
  });

  /* ── D. Escaping ─────────────────────────────────────────────────── */

  runCase('D1 a hostile product name cannot inject markup', () => {
    const bad = Object.assign({}, base, { id: 'h', name: '<img src=x onerror=alert(1)>', stock: 1 });
    const good = Object.assign({}, base, { id: 'g', name: 'Benign', stock: 1 });
    const html = mount([bad, good]).host.innerHTML;
    ok('D1 control: the benign row rendered', /Benign/.test(html));
    ok('D1 no live img tag', html.indexOf('<img') === -1);
    ok('D1 no handler inside a tag', !/<[^>]*onerror/i.test(html));
    ok('D1 it is escaped instead', /&lt;img/.test(html));
  });

  /* ── E. The workspace holds no write authority ───────────────────── */

  runCase('E1 it declines rather than inventing a fallback', () => {
    const API = load();
    ok('E1 control: a valid mount succeeds',
       API.mount({ host: { innerHTML: '' }, products: [] }) === true);
    ok('E1 no host -> declines', !API.mount({ products: [] }));
    ok('E1 non-array products -> declines', !API.mount({ host: {}, products: null }));
  });

  runCase('E2 the only write is delegated, never issued here', () => {
    const src = fs.readFileSync(path.join(ROOT, 'sokoni-aos-products.js'), 'utf8')
                  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
                  .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    ok('E2 control: stripped source still has real code', /function/.test(src) && /window\./.test(src));
    ok('E2 control: string literals were stripped', src.indexOf('SokoniAOSProducts.select(') === -1);
    ['httpsCallable', '.set(', '.update(', '.delete(', '.add(', 'firebase.'].forEach((w) => {
      ok('E2 no ' + w, src.indexOf(w) === -1);
    });
  });

  runCase('E3 the delegated action is actually invoked', () => {
    let got = null;
    const m = mount([PLENTY], { updateStatus: (id) => { got = id; } });
    m.API.act('p');
    ok('E3 the host action received the id', got === 'p', 'got ' + got);
    /* POSITIVE CONTROL for the absence check above: the module CAN call out,
       so "no callable" is about authority, not about being inert. */
    ok('E3 control: the action ran at all', got !== null);
  });

  /* ── Summary ─────────────────────────────────────────────────────── */
  if (ASSERTS < MIN_ASSERTIONS) {
    FAIL++;
    FAILURES.push('Suite ran only ' + ASSERTS + ' assertions; at least ' + MIN_ASSERTIONS + ' expected.');
  }

  console.log('\n' + '='.repeat(66));
  console.log('  ADMINOS PRODUCTS WORKSPACE — CERTIFICATION');
  console.log('='.repeat(66));
  console.log('  assertions : ' + ASSERTS);
  console.log('  passed     : ' + PASS);
  console.log('  failed     : ' + FAIL);
  if (FAILURES.length) {
    console.log('\n  FAILURES');
    FAILURES.forEach((f) => console.log('   ✗ ' + f));
  }
  console.log('='.repeat(66));
  console.log(FAIL === 0 ? '  RESULT: CERTIFIED\n' : '  RESULT: NOT CERTIFIED\n');
  process.exit(FAIL === 0 ? 0 : 1);
})();
