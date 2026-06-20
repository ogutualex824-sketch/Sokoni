const { chromium } = require('playwright');
(async () => {
  const br  = await chromium.launch({ headless: true, args: ['--no-sandbox','--no-proxy-server'] });
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 } });
  const pg  = await ctx.newPage();
  await pg.goto('http://localhost:3000/index.html', { waitUntil: 'commit', timeout: 10000 });
  await pg.waitForTimeout(1800);

  const hits = await pg.evaluate(() => {
    const out = [];
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      if (r.width < 1 || r.height < 1) return;
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return;
      // visible elements in the top-right area: x > 280, y < 180
      if (r.left > 280 && r.top < 180) {
        const txt = (el.textContent || '').trim().replace(/\s+/g,' ').substring(0, 40);
        out.push({
          id: el.id || '',
          cls: el.className.toString().substring(0, 60),
          tag: el.tagName,
          txt,
          x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
          bg: s.backgroundColor,
          color: s.color,
          display: s.display,
        });
      }
    });
    return out;
  });

  console.log('Top-right visible elements on phone:');
  hits.forEach(h => console.log(`  [${h.tag}#${h.id}.${h.cls.split(' ')[0]}] "${h.txt}" at (${h.x},${h.y}) ${h.w}x${h.h} bg=${h.bg}`));
  await br.close();
})().catch(e => console.error(e.message));
