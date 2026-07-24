/* RC-04 INVENTORY JOURNEY — the decrement contract.
   Stock 10 → buy 2 → stock 8, and that one truth propagates to search, the
   seller view and (later) POS + realtime listeners. Firestore-backed, so it
   runs on production/emulator; BLOCKED on static. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

module.exports = {
  id: 'RC-04', title: 'Inventory Journey',
  steps: [
    { name: 'Seed probe product at stock 10', capability: 'Inventory seed', async run(ctx) {
        const p = ctx.dataset.PRODUCTS.find(x => x.id === 'rc-stock-10');
        await ctx.backend.setDoc(`products/${p.id}`, { ...p, ...ctx.dataset.RC_TAG });
        const got = await ctx.backend.getDoc(`products/${p.id}`);
        if (!got || got.stock !== 10) throw new Error(`seed failed (stock=${got && got.stock})`);
        ctx.record('firestore', { path: `products/${p.id}`, stock: got.stock });
    }},
    /* ARCHITECTURAL NOTE (traced 2026-07-24, not assumed).
       Marketplace stock is decremented ONLY inside the payment webhooks
       `verifyIntasendPayment` (index.js:2727) and `darajaSTKCallback`
       (index.js:3599) — both onRequest, inside a TOCTOU-safe transaction with an
       insufficient-stock guard. There is NO callable that decrements marketplace
       stock, so placing an order does not move stock; CONFIRMING PAYMENT does.

       Consequence: RC-04's marketplace decrement is NOT independently testable.
       It is gated on the same INTASEND secrets as RC-03, because certifying it
       requires a validly-signed webhook. RC-04 and RC-03 are one certification.

       Two callables DO decrement stock and are reachable with the browser
       session: `recordPOSSale` (pos-retail-engine.js) and `createClickAndCollect`
       (pos-marketplace-sync.js). Those are the POS/click-and-collect paths — a
       DIFFERENT capability from marketplace checkout, and certifying them writes
       real sale + receipt records, so they belong in their own suite. */
    { name: 'Place order for qty 2 (decrement path)', capability: 'Inventory mutation', async run(ctx) {
        // Prefer the real transaction/function. Until callable invocation is
        // wired, drive the documented decrement path via a transaction-style
        // write, then assert. If the backend cannot, it BLOCKS.
        const ord = ctx.dataset.KNOWN_ORDER;
        await ctx.backend.setDoc(`orders/${ord.id}`, { ...ord, ...ctx.dataset.RC_TAG });
        // NOTE: the authoritative decrement is a Cloud Function / rules-guarded
        // transaction. Asserting it via the real function is the next capability;
        // here we verify the order landed so the chain is inspectable.
        const got = await ctx.backend.getDoc(`orders/${ord.id}`);
        if (!got) throw new Error('order not written');
        throw new BlockedError(
          'marketplace stock moves on PAYMENT CONFIRMATION, not order placement — ' +
          'the decrement lives in verifyIntasendPayment/darajaSTKCallback (onRequest). ' +
          'Certifying 10→8 requires a validly-signed IntaSend webhook, i.e. the same ' +
          'secrets as RC-03. Gated on RC-03, not on a generic "functions backend".');
    }},
    { name: 'Stock is now 8', capability: 'Inventory decrement', async run(ctx) {
        const got = await ctx.backend.getDoc('products/rc-stock-10');
        if (!got) throw new BlockedError('no backend read');
        if (got.stock === 8) return { detail: 'stock decremented to 8' };
        throw new BlockedError(`stock still ${got.stock} — decrement function not exercised here`);
    }},
    { name: 'Search + seller view agree on 8', capability: 'Inventory consistency', async run(ctx) {
        const rows = await ctx.backend.queryCol('products', [['_rcSeed', '==', true]]);
        const hit = rows.find(r => r.id === 'rc-stock-10');
        if (!hit) throw new BlockedError('no backend query');
        return hit.stock === 8 ? { detail: 'surfaces agree' }
          : { status: 'BLOCKED', detail: `stock=${hit.stock}; gated on decrement step` };
    }},
    { name: 'Realtime + offline cache reflect change', capability: 'Realtime/offline sync', async run() {
        throw new BlockedError('realtime listener + IndexedDB offline assertion is a later capability');
    }},
  ],
};
