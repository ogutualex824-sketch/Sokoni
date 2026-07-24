/* RC-01 SELLER JOURNEY — a seller's product reaches every surface it should.
   Authenticated steps run on production/emulator; on the static backend they
   report BLOCKED (no auth), never a false pass. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

module.exports = {
  id: 'RC-01', title: 'Seller Journey',
  steps: [
    { name: 'Seed seller identity (+ seller claim actually applied)', capability: 'Seller authentication', async run(ctx) {
        const id = ctx.dataset.IDENTITIES.seller;
        const uid = await ctx.backend.ensureUser(id);
        if (!uid) throw new Error('no uid returned for seller identity');
        /* Creating the user is not the same as AUTHORIZING it. Read the claim
           back so an authorization gap cannot pass as a successful seed. */
        const applied = await ctx.backend.verifyClaims(uid, id.claims);
        if (!applied.ok) throw new Error(`claims not applied: expected ${JSON.stringify(id.claims)}, got ${JSON.stringify(applied.actual)}`);
        ctx.record('identity', { role: 'seller', uid, claims: applied.actual });
        return { detail: `uid=${uid}, claims=${JSON.stringify(applied.actual)}` };
    }},
    { name: 'Create shop document', capability: 'Shop creation', async run(ctx) {
        const s = ctx.dataset.IDENTITIES.seller;
        await ctx.backend.setDoc(`shops/${s.profile.shopHandle}`,
          { handle: s.profile.shopHandle, name: 'RC Beta Shop', tier: s.profile.tier, ...ctx.dataset.RC_TAG });
        const got = await ctx.backend.getDoc(`shops/${s.profile.shopHandle}`);
        if (!got || got.handle !== s.profile.shopHandle) throw new Error('shop not persisted');
        ctx.record('firestore', { path: `shops/${s.profile.shopHandle}`, doc: got });
    }},
    { name: 'Upload product', capability: 'Product creation', async run(ctx) {
        const p = ctx.dataset.PRODUCTS[0];
        await ctx.backend.setDoc(`products/${p.id}`, { ...p, ...ctx.dataset.RC_TAG });
        const got = await ctx.backend.getDoc(`products/${p.id}`);
        if (!got) throw new Error('product not written');
        if (got.status !== 'active' || got.isVisible !== true) throw new Error('visibility contract not met');
        ctx.record('firestore', { path: `products/${p.id}`, doc: got });
    }},
    { name: 'Edit product (price persists AND search contract survives)', capability: 'Product mutation', async run(ctx) {
        const p = ctx.dataset.PRODUCTS[0];
        await ctx.backend.setDoc(`products/${p.id}`, { price: 111100 });
        const got = await ctx.backend.getDoc(`products/${p.id}`);
        if (got.price !== 111100) throw new Error(`edit not persisted (price=${got.price})`);
        /* A partial update must not silently strip the search contract — that is
           how a product becomes invisible to search while still looking fine in
           the seller's own list. Verified after EVERY mutation, not just create. */
        if (!Array.isArray(got.searchableTerms) || !got.searchableTerms.length)
          throw new Error('edit destroyed searchableTerms — product would vanish from search');
        if (got.status !== 'active' || got.isVisible !== true)
          throw new Error(`edit broke visibility contract (status=${got.status}, isVisible=${got.isVisible})`);
        ctx.record('assertion', { afterEdit: { price: got.price, terms: got.searchableTerms.length,
                                               status: got.status, isVisible: got.isVisible } });
        return { detail: `price=${got.price}, ${got.searchableTerms.length} terms intact` };
    }},
    { name: 'Search reflects the product (searchableTerms present)', capability: 'Search indexing', async run(ctx) {
        const rows = await ctx.backend.queryCol('products', [['_rcSeed', '==', true], ['status', '==', 'active']]);
        const hit = rows.find(r => r.id === ctx.dataset.PRODUCTS[0].id);
        if (!hit) throw new Error('active product not queryable');
        if (!Array.isArray(hit.searchableTerms) || !hit.searchableTerms.length)
          throw new Error('searchableTerms missing — product would be unfindable');
    }},
    { name: 'Delete product = archive (soft-delete contract)', capability: 'Product soft-delete', async run(ctx) {
        const p = ctx.dataset.PRODUCTS[0];
        await ctx.backend.setDoc(`products/${p.id}`, { status: 'archived', isVisible: false });
        const got = await ctx.backend.getDoc(`products/${p.id}`);
        if (got.status !== 'archived') throw new Error('archive not applied');
        /* Soft-delete, not hard-delete: the document must survive so orders that
           reference it still resolve. A missing doc here is a data-integrity bug. */
        if (!got.name) throw new Error('archive destroyed the document — orders referencing it would break');
        ctx.record('assertion', { afterArchive: { status: got.status, isVisible: got.isVisible } });
    }},
    { name: 'Search reflects the archive (datastore ↔ search consistency)', capability: 'Search invalidation', async run(ctx) {
        /* The primary datastore and the search surface must agree. Retries with a
           bounded wait so a legitimate indexing delay is tolerated, but a genuine
           inconsistency still fails rather than being papered over by a long sleep. */
        const id = ctx.dataset.PRODUCTS[0].id;
        const deadline = Date.now() + 15000;
        let lastSeen = null;
        while (Date.now() < deadline) {
          const active = await ctx.backend.queryCol('products',
            [['_rcSeed', '==', true], ['status', '==', 'active']]);
          lastSeen = active.map(r => r.id);
          if (!lastSeen.includes(id)) {
            ctx.record('assertion', { archivedExcludedFromActiveQuery: true, activeIds: lastSeen });
            return { detail: 'archived product excluded from active results' };
          }
          await new Promise(r => setTimeout(r, 1500));
        }
        throw new Error(`archived product still in active results after 15s (active=${JSON.stringify(lastSeen)})`);
    }},
    { name: 'Seller dashboard renders (UI)', capability: 'Seller dashboard rendering', async run(ctx) {
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
