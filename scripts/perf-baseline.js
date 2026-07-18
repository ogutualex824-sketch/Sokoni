/* PHASE 2 BASELINE v2 — cold AND warm, with a measurement-validity gate.
 *
 * Fixes two harness defects found 2026-07-18:
 *   1. v1 never asserted the landed URL, so RBAC-gated pages were measured as their
 *      redirect target (5 of 9 rows invalid). Runs that land off-target are DISCARDED.
 *   2. v1 created a fresh context per run, so it only ever measured COLD start —
 *      empty cache, empty localStorage. For a POS terminal (opened once, kept open all
 *      day) that is the unrepresentative case. Each session now measures cold, then
 *      reloads in the SAME context to measure warm.
 *
 * /pos is gated by localStorage, not auth (pos.html:28-36), so it is seeded here.
 * Read-only: no application code is modified.
 */
const { chromium } = require('c:/Users/USER1/OneDrive/Desktop/SOKONI/node_modules/playwright');
const BASE = 'https://sokoni-aeb26.web.app';
const SESSIONS = parseInt(process.argv[2] || '3', 10);
const WARM_LOADS = 2;
const SETTLE = 9000;

const PAGES = [
  ['/', 'Home'], ['/search', 'Search'], ['/track', 'Orders'],
  ['/pos-inventory', 'Inventory'], ['/pos', 'SmartPOS'],
];

/* Two keys, not credentials — pos.html redirects to the setup wizard without them. */
const SEED = () => {
  try {
    localStorage.setItem('sokoni_setup_complete', '1');
    localStorage.setItem('sokoni_merchant_id', 'SOK-PERFTEST');
  } catch (e) {}
  window.__lt = []; window.__lcp = 0;
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); })
    .observe({ type: 'longtask', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { const e = l.getEntries(); window.__lcp = e[e.length - 1].startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
};

const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const grab = (page) => page.evaluate(() => {
  const pa = performance.getEntriesByType('paint').find(z => z.name === 'first-contentful-paint');
  const lt = window.__lt || [];
  return {
    fcp: pa ? pa.startTime : 0,
    lcp: window.__lcp || 0,
    tbt: lt.reduce((s, d) => s + Math.max(0, d - 50), 0),
    heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0,
  };
}).catch(() => ({ fcp: 0, lcp: 0, tbt: 0, heap: 0 }));

(async () => {
  const browser = await chromium.launch();
  const out = [];

  for (const [path, label] of PAGES) {
    const cold = { fcp: [], lcp: [], tbt: [], heap: [], fail: [] };
    const warm = { fcp: [], lcp: [], tbt: [], heap: [], fail: [] };
    let offTarget = 0, landedOn = '';

    for (let s = 0; s < SESSIONS; s++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await page.addInitScript(SEED);
      let fail = 0;
      page.on('requestfailed', () => fail++);

      try { await page.goto(BASE + path, { waitUntil: 'load', timeout: 60000 }); } catch (e) {}
      await page.waitForTimeout(SETTLE);

      /* VALIDITY GATE — never report a number for a page we did not load. */
      const landed = new URL(page.url()).pathname.replace(/\.html$/, '');
      if (landed !== path) { offTarget++; landedOn = landed; await ctx.close(); continue; }

      const c = await grab(page);
      cold.fcp.push(c.fcp); cold.lcp.push(c.lcp); cold.tbt.push(c.tbt); cold.heap.push(c.heap); cold.fail.push(fail);

      /* Warm: same context, so cache + localStorage persist. */
      for (let w = 0; w < WARM_LOADS; w++) {
        fail = 0;
        try { await page.reload({ waitUntil: 'load', timeout: 60000 }); } catch (e) {}
        await page.waitForTimeout(SETTLE);
        const m = await grab(page);
        warm.fcp.push(m.fcp); warm.lcp.push(m.lcp); warm.tbt.push(m.tbt); warm.heap.push(m.heap); warm.fail.push(fail);
      }
      await ctx.close();
      process.stdout.write('.');
    }
    out.push({ label, cold, warm, offTarget, landedOn });
  }
  await browser.close();

  console.log('\n\n  PHASE 2 BASELINE v2 — ' + SESSIONS + ' sessions/page, cold + ' + WARM_LOADS + ' warm loads each\n');
  console.log('  page          ─────── COLD ───────    ─────── WARM ───────');
  console.log('                 FCP   LCP   TBT  fail    FCP   LCP   TBT  fail   heap(c/w)');
  for (const r of out) {
    if (r.offTarget === SESSIONS) {
      console.log('  ' + r.label.padEnd(13) + 'UNMEASURED — all runs redirected to ' + r.landedOn);
      continue;
    }
    const C = k => String(Math.round(med(r.cold[k]))).padStart(5);
    const W = k => String(Math.round(med(r.warm[k]))).padStart(5);
    console.log('  ' + r.label.padEnd(13) + C('fcp') + C('lcp') + C('tbt') + C('fail') + '  ' +
      W('fcp') + W('lcp') + W('tbt') + W('fail') + '   ' +
      med(r.cold.heap).toFixed(0) + '/' + med(r.warm.heap).toFixed(0) + ' MB');
  }

  console.log('\n  ── cold-start penalty (cold ÷ warm) ──');
  for (const r of out) {
    if (r.offTarget === SESSIONS) continue;
    const ratio = (k) => { const w = med(r.warm[k]); return w ? (med(r.cold[k]) / w).toFixed(1) + 'x' : 'n/a'; };
    console.log('  ' + r.label.padEnd(13) + 'FCP ' + ratio('fcp').padStart(5) + '   LCP ' + ratio('lcp').padStart(5) +
      '   TBT ' + ratio('tbt').padStart(5));
  }
  console.log('');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
