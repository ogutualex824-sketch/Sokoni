/* ============================================================================
   INVENTORY HAS EXACTLY ONE WRITER.

   Run:  node scripts/test-inventory-single-writer.js     (no emulator, no network)

   WHAT WAS WRONG
   seller-wiring.js patched checkout.html's saveAndRedirect and, from the BROWSER,
   ran on every order:

       updateDoc(doc(db, 'products', item.id), {
         stock: increment(-1),      // per LINE ITEM, ignoring item.qty
         sold:  increment(1),
       }).catch(() => {});          // fire-and-forget

   Three defects, all on the money path:

     1. QUANTITY-BLIND — an order for 3 units decremented 1 on the client and 3 on
        the server: stock -4, sold +4.
     2. FIRES BEFORE PAYMENT — it ran at cart-save time, so an abandoned or failed
        checkout permanently consumed stock with no order behind it.
     3. DUPLICATE AUTHORITY — _finalizeMarketplacePayment already deducts the true
        quantity in ONE transaction, floored at zero, with inventoryVersion,
        inventoryApplied idempotency and oversoldAlerts. The client writer had none
        of that.

   Reachability was MEASURED in a real browser on checkout.html, not assumed:
   seller-wiring loaded=true, scriptTag=true, saveAndRedirect.__sw=true. Whether each
   write landed depended only on the App Check token, which is valid for a real user.

   WHAT THIS TEST IS FOR
   The arithmetic below models the server transaction so the qty/idempotency rules are
   pinned. The half that matters more is the anti-drift section: it fails if ANY client
   file writes products/{id}.stock or .sold, so the second inventory authority cannot
   come back.
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* ── 1. The server transaction's rules ─────────────────────────────────────────
   Mirrors _finalizeMarketplacePayment: idempotent on inventoryApplied, floors stock
   at zero, records the shortfall rather than rejecting (payment already happened). */
function finalize(product, lines, order) {
  if (order.inventoryApplied) return { product, order, alerts: [], applied: false };
  const alerts = [];
  let p = { ...product };
  for (const { qty } of lines) {
    let dec = qty;
    if (typeof p.stock === 'number' && p.stock < qty) {
      dec = Math.max(0, p.stock);
      alerts.push({ requested: qty, available: p.stock });
    }
    if (typeof p.stock === 'number') p.stock = Math.max(0, p.stock - dec);
    p.sold = (p.sold || 0) + dec;
    p.inventoryVersion = (p.inventoryVersion || 0) + 1;
    if (p.stock === 0) p.outOfStock = true;
  }
  return { product: p, order: { ...order, inventoryApplied: true }, alerts, applied: true };
}

console.log('\nOne paid order → exactly one mutation, for the FULL quantity');
{
  const base = { stock: 10, sold: 0, inventoryVersion: 0 };

  const q1 = finalize(base, [{ qty: 1 }], { inventoryApplied: false });
  ck('qty 1 → stock 10→9',        q1.product.stock === 9, String(q1.product.stock));
  ck('qty 1 → sold 0→1',          q1.product.sold === 1);
  ck('qty 1 → inventoryVersion 1', q1.product.inventoryVersion === 1);

  const q3 = finalize(base, [{ qty: 3 }], { inventoryApplied: false });
  ck('qty 3 → stock 10→7 (NOT 10→9)', q3.product.stock === 7, String(q3.product.stock));
  ck('qty 3 → sold 0→3 (NOT +1)',     q3.product.sold === 3, String(q3.product.sold));
  ck('the decrement equals the quantity ordered',
     (10 - q3.product.stock) === 3);

  /* The old behaviour, for contrast: client -1 plus server -3 on a 3-unit order. */
  ck('a second client writer would have made it -4',
     (10 - q3.product.stock) + 1 === 4);
}

console.log('\nMultiple cart lines');
{
  const multi = finalize({ stock: 10, sold: 0, inventoryVersion: 0 },
                         [{ qty: 1 }, { qty: 3 }, { qty: 2 }], { inventoryApplied: false });
  ck('total decrement is 6', multi.product.stock === 4, String(multi.product.stock));
  ck('sold is 6',            multi.product.sold === 6);
  ck('one version bump per line', multi.product.inventoryVersion === 3);
}

console.log('\nFailed / abandoned payment decrements NOTHING');
{
  /* The server path only runs on a confirmed payment. With the client writer gone,
     nothing at all mutates inventory before that point. */
  const before = { stock: 10, sold: 0, inventoryVersion: 0 };
  const after = before;   /* no finalize() call — payment never confirmed */
  ck('stock unchanged',  after.stock === 10);
  ck('sold unchanged',   after.sold === 0);
  ck('version unchanged', after.inventoryVersion === 0);
  ck('no client path exists to consume stock pre-payment',
     !/increment\(-1\)/.test(code('seller-wiring.js')));
}

console.log('\nRetry / duplicate completion decrements ONCE');
{
  const first  = finalize({ stock: 10, sold: 0, inventoryVersion: 0 }, [{ qty: 3 }], { inventoryApplied: false });
  const second = finalize(first.product, [{ qty: 3 }], first.order);
  ck('first completion applied',        first.applied === true);
  ck('retry does NOT apply again',      second.applied === false);
  ck('stock still 7 after the retry',   second.product.stock === 7, String(second.product.stock));
  ck('sold still 3 after the retry',    second.product.sold === 3);
  ck('inventoryVersion still 1',        second.product.inventoryVersion === 1);
}

console.log('\nOversell is floored and recorded, never negative');
{
  const over = finalize({ stock: 2, sold: 0, inventoryVersion: 0 }, [{ qty: 5 }], { inventoryApplied: false });
  ck('stock floors at 0, never negative', over.product.stock === 0);
  ck('the shortfall is recorded',          over.alerts.length === 1);
  ck('the alert carries requested vs available',
     over.alerts[0].requested === 5 && over.alerts[0].available === 2);
  ck('sold reflects what was actually available', over.product.sold === 2);
  ck('depleted stock flags outOfStock',     over.product.outOfStock === true);
}

/* ── 2. ANTI-DRIFT — the half that outlives today's code ──────────────────── */
console.log('\nNo client file may write products/{id}.stock or .sold');
{
  const sw = code('seller-wiring.js');
  ck('_decrementStock is gone',            !/async function _decrementStock/.test(sw));
  ck('no increment(-1) anywhere',          !/increment\(-1\)/.test(sw));
  ck('no stock increment write',           !/stock:\s*increment/.test(sw));
  ck('no sold increment write',            !/sold:\s*increment/.test(sw));
  ck('saveAndRedirect is no longer wrapped',
     !/window\.saveAndRedirect\s*=\s*function/.test(sw));
  ck('the __sw marker is gone from the checkout patch',
     !/window\.saveAndRedirect\.__sw\s*=\s*true/.test(sw));
  ck('the header no longer advertises a stock decrement',
     !/Patches saveAndRedirect\(\)\s*→\s*decrements stock/.test(read('seller-wiring.js')));

  /* Repo-wide sweep: no browser file may mutate canonical inventory. */
  const skip = new Set(['sokoni-dev-mock.js', 'sokoni-test-suite.js']);
  const offenders = fs.readdirSync(ROOT)
    .filter(f => /\.(js|html)$/.test(f) && !skip.has(f))
    .filter(f => {
      const src = code(f);
      return /doc\(\s*db\s*,\s*['"]products['"][^)]*\)[\s\S]{0,160}?(stock|sold)\s*:\s*increment/.test(src)
          || /(stock|sold)\s*:\s*increment\(\s*-?\d/.test(src) && /['"]products['"]/.test(src);
    });
  ck('no client file increments products stock/sold', offenders.length === 0,
     offenders.join(',') || 'none');
}

console.log('\nThe server remains the sole writer, with its guarantees intact');
{
  const idx = code('functions/index.js');
  ck('deduction is inside a transaction',      /runTransaction/.test(idx));
  ck('it decrements by the line quantity',     /increment\(-dec\)/.test(idx));
  ck('sold increments by the same amount',     /sold:\s*admin\.firestore\.FieldValue\.increment\(dec\)/.test(idx));
  ck('inventoryVersion is bumped atomically',  /inventoryVersion:\s*admin\.firestore\.FieldValue\.increment\(1\)/.test(idx));
  ck('stock is floored at zero',               /Math\.max\(0, cur - dec\)/.test(idx));
  ck('idempotency guard exists',               /inventoryApplied/.test(idx));
  ck('shortfall is recorded, not rejected',    /oversoldAlerts/.test(idx));
  ck('quantity reaches the server via createCheckoutSession',
     /_availability\.clampQty\(qty, prod, shopState\[prod\.sellerUid\]\)/.test(idx));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
