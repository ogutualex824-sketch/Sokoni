const { chromium } = require('playwright');
(async () => {
  const br = await chromium.launch({ headless: false });

  for (const [label, vp] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]]) {
    const ctx = await br.newContext({ viewport: vp });
    const page = await ctx.newPage();

    await page.goto('http://localhost:3000/track.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.click('button:has-text("Try Demo Track")');
    await page.waitForTimeout(4500);

    // Get zoom via TrackingManager internals
    const info = await page.evaluate(() => {
      const T = window.SokoniTracking;
      const lmap = T && T._map && T._map._map;  // TrackingManager._map (MapManager), MapManager._map (Leaflet)
      return {
        hasTracking: !!T,
        hasLmap: !!lmap,
        zoom: lmap ? lmap.getZoom() : null,
        center: lmap ? lmap.getCenter() : null,
        dragging: lmap ? lmap.dragging.enabled() : null,
        scrollZoom: lmap ? lmap.scrollWheelZoom.enabled() : null,
        touchZoom: lmap ? lmap.touchZoom.enabled() : null,
      };
    });
    console.log(label, '— map info:', JSON.stringify(info));

    const mapBox = await page.evaluate(() => {
      const el = document.getElementById('deliveryMap');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    await page.screenshot({ path: `C:/tmp/nav_${label}_before.png` });

    const cx = mapBox.x + mapBox.w / 2;
    const cy = mapBox.y + mapBox.h / 2;

    // Pan the map
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 90, cy + 70, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(700);

    const afterPan = await page.evaluate(() => {
      const T = window.SokoniTracking;
      const lmap = T && T._map && T._map._map;
      return lmap ? lmap.getCenter() : null;
    });
    console.log(label, '— center after pan:', JSON.stringify(afterPan));

    await page.screenshot({ path: `C:/tmp/nav_${label}_panned.png` });

    // Zoom with scroll wheel
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(600);

    const afterZoom = await page.evaluate(() => {
      const T = window.SokoniTracking;
      const lmap = T && T._map && T._map._map;
      return lmap ? lmap.getZoom() : null;
    });
    console.log(label, '— zoom after scroll:', afterZoom);

    await page.screenshot({ path: `C:/tmp/nav_${label}_zoomed.png` });
    await ctx.close();
  }

  await br.close();
  console.log('Done.');
})().catch(e => console.error('FATAL:', e.message));
