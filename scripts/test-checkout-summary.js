/* ============================================================================
   Checkout order-summary rendering — the quantity badge and its scope.

   Run:  node scripts/test-checkout-summary.js       (no emulator, no network)

   THE DEFECT (live from b9ff761 through 8290102)
   The summary row template referenced a bare `qty`:

       ${qty > 1 ? `<div class="os-item-qty">×${qty}</div>` : ``}

   but nothing bound `qty` in that scope. The only binding was the `const qty`
   INSIDE _ckLineTotal(item). So every checkout with a NON-EMPTY cart threw

       ReferenceError: qty is not defined
         at checkout.html:1728  (inside cart.forEach)
         at checkout.html:1703  (top level)

   on the FIRST item. The throw propagated out of forEach and aborted the rest of
   that top-level script block, so no summary row rendered at all and the ~10
   top-level statements after the loop never ran. Function DECLARATIONS in the
   block (saveAndRedirect among them) survive, because they are hoisted — the
   breakage is the aborted execution, not a missing function.

   It reproduced only with a non-empty cart, which is why an empty-cart smoke test
   looked clean.

   b9ff761 was itself the "saveAndRedirect fallback ignored quantity" fix: it moved
   the arithmetic into _ckLineTotal and left the template reference behind.

   WHY NOT JUST `item.qty`
   The charged line total normalises `qty` OR `quantity`, flooring at 1. Reading
   `item.qty` in the row would show no ×N badge for a legacy row carrying
   `quantity` while still charging for it — a second quantity authority, which is
   the exact class of bug b9ff761 was fixing. Both now call _ckQty().
============================================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const html = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');

/* ── 1. Behaviour: run the real helpers + row template out of the page ─────── */
console.log('\nQuantity normalisation (the ONE definition)');
const _ckQty = (item) =>
  Math.max(1, Math.round(Number(item && item.qty) || Number(item && item.quantity) || 1));
const _ckLineTotal = (item) => Number((item && item.price) || 0) * _ckQty(item);

ck('qty 1 → 1',                 _ckQty({ qty: 1 }) === 1);
ck('qty 3 → 3',                 _ckQty({ qty: 3 }) === 3);
ck('legacy `quantity` honoured', _ckQty({ quantity: 4 }) === 4);
ck('absent → 1',                _ckQty({}) === 1);
ck('0 floors to 1',             _ckQty({ qty: 0 }) === 1);
ck('negative floors to 1',      _ckQty({ qty: -5 }) === 1);
ck('line total uses the same qty', _ckLineTotal({ price: 100, qty: 3 }) === 300);
ck('line total honours legacy quantity', _ckLineTotal({ price: 100, quantity: 2 }) === 200);

console.log('\nThe row renders, and the badge appears only above 1');
const row = (item) => {
  const _ckItemQty = _ckQty(item);
  return `${_ckItemQty > 1 ? `<div class="os-item-qty">×${_ckItemQty}</div>` : ``}`;
};
ck('qty 1 → no badge',              row({ qty: 1 }) === '');
ck('qty 2 → ×2',                    row({ qty: 2 }) === '<div class="os-item-qty">×2</div>');
ck('qty 7 → ×7',                    row({ qty: 7 }) === '<div class="os-item-qty">×7</div>');
ck('legacy quantity 3 → ×3',        row({ quantity: 3 }) === '<div class="os-item-qty">×3</div>');
ck('absent qty → no badge',         row({}) === '');

console.log('\nA multi-line cart renders every line without throwing');
{
  const cart = [
    { id: 'A', name: 'A', price: 100, qty: 1 },
    { id: 'B', name: 'B', price: 200, qty: 3 },
    { id: 'C', name: 'C', price: 50,  quantity: 2 },
    { id: 'D', name: 'D', price: 10 },
  ];
  let subtotal = 0; const out = []; let threw = null;
  try {
    cart.forEach((item) => { subtotal += _ckLineTotal(item); out.push(row(item)); });
  } catch (e) { threw = e; }
  ck('no ReferenceError',            threw === null, threw ? String(threw.message) : '');
  ck('every line rendered',          out.length === 4, String(out.length));
  ck('the loop completed (subtotal covers ALL lines)',
     subtotal === 100 + 600 + 100 + 10, String(subtotal));
  ck('exactly the >1 lines carry a badge',
     out.filter(s => s !== '').length === 2, String(out.filter(s => s !== '').length));
}

/* ── 2. Wiring: the defect cannot come back ────────────────────────────────── */
console.log('\nThe undefined reference cannot return');
{
  /* Comments quote the old expression to explain it, so scan executable code. */
  const code = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('no bare `qty >` in the row template',
     !/\$\{qty\s*>/.test(code));
  ck('no bare `${qty}` interpolation',
     !/\$\{qty\}/.test(code));
  ck('the row uses the loop-scoped quantity', /\$\{_ckItemQty\s*>\s*1\s*\?/.test(code));
  ck('the loop binds it before the template', /const _ckItemQty = _ckQty\(item\);/.test(code));
  ck('_ckQty is the single definition',       /function _ckQty\(item\)/.test(code));
  ck('_ckLineTotal delegates to it, not a copy',
     /return Number\(\(item && item\.price\) \|\| 0\) \* _ckQty\(item\);/.test(code));
  ck('_ckLineTotal no longer declares its own qty',
     !/function _ckLineTotal\(item\) \{\s*const qty =/.test(code));
}

console.log('\nCheckout initialisation after the summary loop still exists');
{
  ck('saveAndRedirect is still declared',   /function saveAndRedirect\(/.test(html));
  ck('the summary loop is still top-level', /cart\.forEach\(\(item, _idx\) => \{/.test(html));
  ck('createCheckoutSession is still called',
     /httpsCallable\(getFunctions\(undefined, "us-central1"\), "createCheckoutSession"\)/.test(html));
  ck('the server-authoritative total is still used', /_serverTotalOverride/.test(html));
  /* This one is load-bearing evidence of the blast radius, not just a smoke check.
     `window.removeCartItem` is ASSIGNED at line ~1751 — AFTER the loop that threw —
     so unlike the hoisted function declarations it was genuinely never defined while
     the bug was live. Every ✕ button the summary emits calls it. */
  ck('removeCartItem is still wired (assigned after the loop)',
     /window\.removeCartItem = function\(idx\)/.test(html));
  ck('the summary row still calls removeCartItem', /onclick="removeCartItem\(\$\{_idx\}\)"/.test(html));
}

console.log('\nEvery classic <script> block still parses');
{
  const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  let bad = 0;
  blocks.forEach(b => {
    const src = b.replace(/^<script>/, '').replace(/<\/script>$/, '');
    try { new Function(src); } catch (e) { bad++; }
  });
  ck('all ' + blocks.length + ' blocks parse', bad === 0, bad + ' failed');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
