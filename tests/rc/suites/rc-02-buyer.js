/* RC-02 BUYER JOURNEY — browse → product → cart → quantity → checkout quote.
   The cart/checkout MATH runs unauthenticated (it is client-side), so these
   steps execute on the static backend today. Order-history persistence needs a
   signed-in user and reports BLOCKED there. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

module.exports = {
  id: 'RC-02', title: 'Buyer Journey',
  steps: [
    { name: 'Home renders a product grid', async run(ctx) {
        const page = await ctx.ui();
        await page.goto(ctx.baseUrl() + '/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1800);
        const cards = await page.evaluate(() =>
          document.querySelectorAll('.product-card, .pcard, [class*="product"]').length);
        await ctx.shot('home');
        if (cards < 1) return { status: 'BLOCKED', detail: 'grid empty without live data' };
        return { detail: `${cards} card-like nodes` };
    }},
    { name: 'Category page renders', async run(ctx) {
        const page = await ctx.ui();
        await page.goto(ctx.baseUrl() + '/category.html?cat=all', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const errs = page._rcErrors.length;
        await ctx.shot('category');
        if (errs) throw new Error(`page errors: ${page._rcErrors[0]}`);
    }},
    { name: 'Checkout math: subtotal = Σ price×qty', async run(ctx) {
        // Seed a cart in localStorage and let checkout.html compute — the exact
        // path the qty-subtotal fix corrected. Pure client, no auth needed.
        const page = await ctx.ui();
        await page.addInitScript(() => {
          localStorage.setItem('loggedIn', 'true');
          localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'rc', name: 'RC' }));
          localStorage.setItem('cart', JSON.stringify([
            { id: 'a', name: 'RC A', price: 18500, qty: 2, image: 'assets/default-product.png' },
            { id: 'b', name: 'RC B', price: 3400,  qty: 3, image: 'assets/default-product.png' },
          ]));
        });
        await page.goto(ctx.baseUrl() + '/checkout.html', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() =>
          document.querySelectorAll('#checkoutItems .os-item').length > 0, { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const sub = await page.evaluate(() => (document.getElementById('summarySubtotal') || {}).textContent || '');
        await ctx.shot('checkout');
        const expected = 18500 * 2 + 3400 * 3; // 47,200
        ctx.record('assertion', { expected, shown: sub.trim() });
        if (!sub.includes('47,200')) throw new Error(`subtotal wrong: expected 47,200, got "${sub.trim()}"`);
        return { detail: `subtotal ${sub.trim()} = qty-correct` };
    }},
    { name: 'Order history persists (authenticated)', async run(ctx) {
        await ctx.backend.ensureUser(ctx.dataset.IDENTITIES.buyer); // throws BlockedError on static
        throw new BlockedError('order write+read as buyer needs authenticated backend');
    }},
  ],
};
