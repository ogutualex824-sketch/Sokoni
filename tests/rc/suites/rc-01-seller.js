/* RC-01 SELLER JOURNEY — a seller's product reaches every surface it should.
   Authenticated steps run on production/emulator; on the static backend they
   report BLOCKED (no auth), never a false pass. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

module.exports = {
  id: 'RC-01', title: 'Seller Journey',
  steps: [
    { name: 'Seed seller identity (+ premium claim)', async run(ctx) {
        const uid = await ctx.backend.ensureUser(ctx.dataset.IDENTITIES.seller);
        ctx.record('identity', { role: 'seller', uid });
        return { detail: `uid=${uid}` };
    }},
    { name: 'Create shop document', async run(ctx) {
        const s = ctx.dataset.IDENTITIES.seller;
        await ctx.backend.setDoc(`shops/${s.profile.shopHandle}`,
          { handle: s.profile.shopHandle, name: 'RC Beta Shop', tier: s.profile.tier, ...ctx.dataset.RC_TAG });
        const got = await ctx.backend.getDoc(`shops/${s.profile.shopHandle}`);
        if (!got || got.handle !== s.profile.shopHandle) throw new Error('shop not persisted');
        ctx.record('firestore', { path: `shops/${s.profile.shopHandle}`, doc: got });
    }},
    { name: 'Upload product', async run(ctx) {
        const p = ctx.dataset.PRODUCTS[0];
        await ctx.backend.setDoc(`products/${p.id}`, { ...p, ...ctx.dataset.RC_TAG });
        const got = await ctx.backend.getDoc(`products/${p.id}`);
        if (!got) throw new Error('product not written');
        if (got.status !== 'active' || got.isVisible !== true) throw new Error('visibility contract not met');
        ctx.record('firestore', { path: `products/${p.id}`, doc: got });
    }},
    { name: 'Edit product (price change persists)', async run(ctx) {
        const p = ctx.dataset.PRODUCTS[0];
        await ctx.backend.setDoc(`products/${p.id}`, { price: 111100 });
        const got = await ctx.backend.getDoc(`products/${p.id}`);
        if (got.price !== 111100) throw new Error(`edit not persisted (price=${got.price})`);
    }},
    { name: 'Search reflects the product (searchableTerms present)', async run(ctx) {
        const rows = await ctx.backend.queryCol('products', [['_rcSeed', '==', true], ['status', '==', 'active']]);
        const hit = rows.find(r => r.id === ctx.dataset.PRODUCTS[0].id);
        if (!hit) throw new Error('active product not queryable');
        if (!Array.isArray(hit.searchableTerms) || !hit.searchableTerms.length)
          throw new Error('searchableTerms missing — product would be unfindable');
    }},
    { name: 'Delete product = archive (soft-delete contract)', async run(ctx) {
        const p = ctx.dataset.PRODUCTS[0];
        await ctx.backend.setDoc(`products/${p.id}`, { status: 'archived', isVisible: false });
        const got = await ctx.backend.getDoc(`products/${p.id}`);
        if (got.status !== 'archived') throw new Error('archive not applied');
    }},
    { name: 'Seller dashboard renders (UI)', async run(ctx) {
        if (!ctx.backendUp) throw new BlockedError('needs authenticated backend to render seller.html as the seller');
        const page = await ctx.ui();
        await page.goto(ctx.baseUrl() + '/seller.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        await ctx.shot('seller-dashboard');
        // Without a signed-in session the page shows the auth gate — that is the
        // BLOCKED signal, captured but not asserted as pass.
        throw new BlockedError('seller session injection into the browser is the next backend capability');
    }},
  ],
};
