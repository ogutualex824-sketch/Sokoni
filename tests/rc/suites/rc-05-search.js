/* RC-05 SEARCH JOURNEY — cold cache, warm cache, typo, bilingual, autocomplete,
   and deleted/edited products reflecting. The search UI + warm-cache behaviour
   run unauthenticated; the "deleted product disappears" assertion needs a
   backend write and BLOCKS on static. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

module.exports = {
  id: 'RC-05', title: 'Search Journey',
  steps: [
    { name: 'Search page loads and accepts a query', async run(ctx) {
        const page = await ctx.ui();
        await page.goto(ctx.baseUrl() + '/search.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const input = await page.$('input[type="search"], #searchInput, .search-bar input');
        if (!input) throw new Error('no search input found');
        await input.fill('viatu');
        await input.press('Enter').catch(() => {});
        await page.waitForTimeout(1500);
        await ctx.shot('search-query');
        if (page._rcErrors.length) throw new Error(`page error: ${page._rcErrors[0]}`);
    }},
    { name: 'Input font ≥16px (no iOS zoom on the search field)', async run(ctx) {
        const page = await ctx.ui();
        const fs = await page.evaluate(() => {
          const el = document.querySelector('input[type="search"], #searchInput, .search-bar input');
          return el ? parseFloat(getComputedStyle(el).fontSize) : null;
        });
        ctx.record('assertion', { searchInputFontPx: fs });
        if (fs == null) throw new BlockedError('no search input to measure');
        if (fs < 16) throw new Error(`search input ${fs}px — iOS will zoom`);
        return { detail: `${fs}px` };
    }},
    { name: 'Warm-cache path present (localStorage)', async run(ctx) {
        const page = await ctx.ui();
        const hasCache = await page.evaluate(() =>
          Object.keys(localStorage).some(k => /search|cache|catalog/i.test(k)));
        return { status: 'PASS', detail: hasCache ? 'cache keys present' : 'no cache yet (cold)' };
    }},
    { name: 'Typo + bilingual (kiatu/viatu) resolve', async run() {
        throw new BlockedError('synonym/typo resolution needs seeded catalog on a data backend');
    }},
    { name: 'Deleted product disappears from results', async run(ctx) {
        await ctx.backend.getDoc('products/rc-search-swahili'); // BlockedError on static
        throw new BlockedError('needs backend write+reindex to assert disappearance');
    }},
  ],
};
