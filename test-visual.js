const { chromium } = require('playwright');
(async () => {
  const br = await chromium.launch({ headless: false });

  for (const [label, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await br.newContext({ viewport: vp });
    const pg  = await ctx.newPage();

    // HOME
    await pg.goto('http://localhost:3000/index.html', { waitUntil: 'commit', timeout: 10000 });
    await pg.waitForTimeout(1800);
    await pg.screenshot({ path: `C:/tmp/vis_${label}_home.png` });

    // SERVICES – provider cards
    await pg.goto('http://localhost:3000/services.html', { waitUntil: 'commit', timeout: 10000 });
    await pg.waitForTimeout(1800);
    // Click a service category to load cards
    const firstCat = pg.locator('.sv-cat-btn').first();
    if (await firstCat.isVisible()) { await firstCat.click(); await pg.waitForTimeout(1000); }
    await pg.screenshot({ path: `C:/tmp/vis_${label}_services.png` });

    // TRACK
    await pg.goto('http://localhost:3000/track.html', { waitUntil: 'commit', timeout: 10000 });
    await pg.waitForTimeout(800);
    const demo = pg.locator('button:has-text("Try Demo Track")');
    if (await demo.isVisible()) { await demo.click(); await pg.waitForTimeout(4000); }
    await pg.screenshot({ path: `C:/tmp/vis_${label}_track.png` });

    await ctx.close();
  }

  await br.close();
  console.log('Done — screenshots at C:/tmp/vis_*.png');
})().catch(e => console.error(e.message));
