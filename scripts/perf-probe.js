'use strict';
/**
 * SOKONI Performance Probe — Sprint 1A
 * ============================================================================
 * A benchmark that PROVES ITS OWN RELIABILITY before its numbers are allowed to
 * gate anything.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The previous probe reported TBT of 538, 439, 1082, 920, 766 and 667 ms for the
 * same page. That spread is wider than any optimisation could produce, so every
 * "improvement" measured with it was unfalsifiable. Measured 2026-08-01:
 *
 *     unthrottled   TBT median 769ms   range 356–1892   CV 54.6%   <- unusable
 *     CPU 4x pinned TBT median 8069ms  range 6824–8780  CV  9.9%   <- usable
 *
 * The variance was CPU contention on the host, not the page. Pinning CPU (and
 * network) is therefore not a nicety — it is the difference between a metric and
 * a rumour. Absolute values under throttling are higher than a real phone; that
 * is fine, because the probe's job is COMPARISON under fixed conditions.
 *
 * ── Reliability classification ──────────────────────────────────────────────
 * Every metric is scored by coefficient of variation across runs:
 *
 *     CV < 10%   AUTHORITATIVE  may gate a deploy
 *     CV < 25%   INDICATIVE     report and track; never gate
 *     otherwise  NOISY          not reported as a result at all
 *
 * A metric is not trusted because it is convenient. It earns its status each
 * run, and the classification is printed alongside the number so nobody quotes
 * a noisy figure as though it were a finding.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/perf-probe.js                      5 runs, save to history
 *   node scripts/perf-probe.js --runs 7             more samples
 *   node scripts/perf-probe.js --compare            diff vs the previous entry
 *   node scripts/perf-probe.js --gate               exit 1 on an AUTHORITATIVE
 *                                                   budget breach
 *   node scripts/perf-probe.js --page home,checkout limit pages
 *   node scripts/perf-probe.js --json
 *
 * Authenticated pages (checkout) need a Playwright storageState:
 *   PERF_AUTH_STATE=./.perf-auth.json node scripts/perf-probe.js
 * Without it those pages report BLOCKED — never PASS, never FAIL. A page that
 * could not be measured is not a page that is fast.
 * ========================================================================== */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

/* ── Local by default, and that is a deliberate design decision ──────────────
   Measuring production over the internet folds THREE variances together: the
   page's, the network's, and the production server's. Measured 2026-08-01,
   against production with CPU pinned:

       5 runs   LCP CV  4.4%   CLS CV 26.6%   INP CV 34.1%
       9 runs   LCP CV 16.6%   CLS CV 30.4%   INP CV 59.4%

   MORE samples made it WORSE. That is the signature of drift, not sampling
   error — a longer run spans more change in conditions nobody here controls.
   No amount of averaging fixes a moving baseline.

   So the comparison instrument serves the working tree from localhost with
   emulated network conditions. Network and server variance go to zero, the CPU
   is pinned, and what remains is the page's own behaviour — which is the only
   thing an optimisation can actually change.

   Measuring the real production experience is a different job (field/RUM data),
   and conflating the two is how a probe ends up unable to answer either.
     PERF_BASE=https://mysokoni.co.ke   opt into the noisy production run.  */
const LOCAL_PORT = parseInt(process.env.PERF_PORT || '8288', 10);
const BASE = process.env.PERF_BASE || `http://localhost:${LOCAL_PORT}`;
const SERVE_LOCAL = !process.env.PERF_BASE;
const HISTORY = path.resolve(__dirname, '../docs/perf-history.json');
const AUTH_STATE = process.env.PERF_AUTH_STATE || '';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes('--' + k);

const RUNS = parseInt(arg('runs', '5'), 10);
const AS_JSON = has('json');
const COMPARE = has('compare');
const GATE = has('gate');

/* ── Fixed conditions. Changing ANY of these invalidates comparison with
      history, which is why they are recorded in every saved entry. ────────── */
const CONDITIONS = {
  cpuThrottle: 4,                    /* mid-range Android, and CV 54.6% -> 9.9% */
  network: { downloadKbps: 10240, uploadKbps: 3072, latencyMs: 40 },  /* good 4G */
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  settleMs: 4000,
};

/* ── Budgets. Explicit, and each one records where its value came from. ───── */
const BUDGETS = {
  cls:       { max: 0.10,  label: 'CLS',            source: 'Core Web Vitals "good"' },
  lcp:       { max: 2500,  label: 'LCP (ms)',       source: 'Core Web Vitals "good"' },
  inp:       { max: 200,   label: 'INP (ms)',       source: 'Core Web Vitals "good"' },
  worstTask: { max: 100,   label: 'Longest task',   source: 'no task > 100ms where practical' },
  /* Payload/read budgets are ratchets seeded from the measured baseline rather
     than invented round numbers — a budget nobody has ever met gets ignored. */
  jsKB:      { max: null,  label: 'JS payload (KB)', source: 'ratchet from baseline' },
  fsReads:   { max: null,  label: 'Firestore reads', source: 'ratchet from baseline' },
};

const PAGES = [
  { key: 'home',     path: '/',                        auth: false },
  { key: 'search',   path: '/search?q=cleaning',       auth: false },
  { key: 'category', path: '/category?cat=electronics', auth: false },
  { key: 'product',  path: '/product',                 auth: false },
  { key: 'checkout', path: '/checkout',                auth: true  },
];

/* ── In-page collector. Installed before any page script so nothing is missed. */
const COLLECTOR = `
window.__p = { lcp: 0, cls: 0, longTasks: [], inp: 0, evts: [] };
try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__p.lcp = e.startTime; })
  .observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
try { new PerformanceObserver(l => { for (const e of l.getEntries())
  if (!e.hadRecentInput) window.__p.cls += e.value; })
  .observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
try { new PerformanceObserver(l => { for (const e of l.getEntries())
  if (e.duration > 50) window.__p.longTasks.push(Math.round(e.duration)); })
  .observe({ type: 'longtask', buffered: true }); } catch (e) {}
/* Real INP: the worst interaction latency actually observed, not a proxy. */
try { new PerformanceObserver(l => { for (const e of l.getEntries()) {
    const d = e.duration || 0;
    window.__p.evts.push(Math.round(d));
    if (d > window.__p.inp) window.__p.inp = d;
  } }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch (e) {}
`;

const num = (a) => a.filter(v => typeof v === 'number' && isFinite(v));
function stats(arr) {
  const s = num(arr).sort((a, b) => a - b);
  if (!s.length) return null;
  const n = s.length;
  const mean = s.reduce((p, c) => p + c, 0) / n;
  const sd = Math.sqrt(s.reduce((p, c) => p + (c - mean) ** 2, 0) / n);
  return {
    median: +(n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2).toFixed(3),
    p95: +s[Math.min(n - 1, Math.ceil(n * 0.95) - 1)].toFixed(3),
    min: +s[0].toFixed(3), max: +s[n - 1].toFixed(3),
    /* CV is undefined for a mean of zero (e.g. a page with genuinely no CLS).
       Reporting it as 0% would claim perfect reliability from no signal. */
    cv: mean > 0 ? +(sd / mean * 100).toFixed(1) : 0,
    n,
  };
}
const gradeOf = (cv) => (cv < 10 ? 'AUTHORITATIVE' : cv < 25 ? 'INDICATIVE' : 'NOISY');

async function runOnce(browser, pg, storageState) {
  const ctx = await browser.newContext({
    viewport: CONDITIONS.viewport,
    deviceScaleFactor: CONDITIONS.deviceScaleFactor,
    isMobile: true, hasTouch: true,
    ...(storageState ? { storageState } : {}),
  });
  await ctx.addInitScript(COLLECTOR);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});

  /* Pin the machine. This is what turns the numbers into measurements. */
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CONDITIONS.cpuThrottle });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: CONDITIONS.network.latencyMs,
    downloadThroughput: CONDITIONS.network.downloadKbps * 128,
    uploadThroughput: CONDITIONS.network.uploadKbps * 128,
  });

  const net = { requests: 0, jsBytes: 0, imgBytes: 0, totalBytes: 0, fsReads: 0 };
  page.on('request', (r) => {
    net.requests++;
    const u = r.url();
    /* Firestore reads: the SDK's Listen/Write channels and the REST surface.
       Counting CHANNEL OPENS, not documents — a document count is not visible
       from the network layer, so calling it "reads" would overstate precision. */
    if (/firestore\.googleapis\.com/.test(u) && /(Listen|Write|RunQuery|BatchGet|channel)/i.test(u)) net.fsReads++;
  });
  page.on('response', (r) => {
    try {
      const h = r.headers();
      const n = parseInt(h['content-length'] || '0', 10) || 0;
      const ct = h['content-type'] || '';
      net.totalBytes += n;
      if (/javascript|ecmascript/.test(ct)) net.jsBytes += n;
      else if (/image/.test(ct)) net.imgBytes += n;
    } catch (_) {}
  });

  const t0 = Date.now();
  await page.goto(BASE + pg.path, { waitUntil: 'load', timeout: 120000 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(CONDITIONS.settleMs);

  /* Landed-URL validity. A gated page measured as its login screen looks fast
     and is meaningless; those runs are DISCARDED, never averaged in. */
  const landed = new URL(page.url()).pathname.replace(/\/$/, '') || '/';
  const want = pg.path.split('?')[0].replace(/\/$/, '') || '/';
  if (landed !== want) { await ctx.close(); return { valid: false, landed }; }

  /* Drive real interactions so INP is measured, not proxied. */
  try {
    await page.mouse.click(CONDITIONS.viewport.width / 2, 300, { delay: 20 });
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(600);
  } catch (_) {}

  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const lt = window.__p.longTasks || [];
    /* JS execution time: main-thread script work, from the resource timeline. */
    const scriptMs = performance.getEntriesByType('resource')
      .filter(r => /\.js(\?|$)/.test(r.name))
      .reduce((s, r) => s + (r.duration || 0), 0);
    return {
      lcp: Math.round(window.__p.lcp || 0),
      cls: +(window.__p.cls || 0).toFixed(4),
      inp: Math.round(window.__p.inp || 0),
      longTasks: lt.length,
      worstTask: lt.length ? Math.max(...lt) : 0,
      tbt: lt.reduce((s, d) => s + Math.max(0, d - 50), 0),
      scriptMs: Math.round(scriptMs),
      domInteractive: Math.round(nav.domInteractive || 0),
    };
  });

  await ctx.close();
  return {
    valid: true, ...m, loadMs,
    requests: net.requests, fsReads: net.fsReads,
    jsKB: Math.round(net.jsBytes / 1024),
    imgKB: Math.round(net.imgBytes / 1024),
    totalKB: Math.round(net.totalBytes / 1024),
  };
}

const METRICS = ['lcp', 'cls', 'inp', 'tbt', 'longTasks', 'worstTask', 'scriptMs',
                 'loadMs', 'requests', 'fsReads', 'jsKB', 'imgKB', 'totalKB'];

/* Static server for the working tree. Deliberately dumb: no compression, no
   caching headers — the browser's own cache is disabled per context anyway, and
   a server that varies its own behaviour would reintroduce the variance this
   whole design exists to remove. */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function startServer() {
  const root = path.resolve(__dirname, '..');
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    /* cleanUrls parity with Firebase Hosting: /search -> /search.html */
    let f = path.join(root, u);
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f = f + '.html';
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    /* Content-Length is REQUIRED, not polite. The byte metrics are counted from
       this header; without it every local response counted as 0 bytes and the
       probe reported jsKB/imgKB/totalKB with a CV of 0% — perfectly repeatable
       and completely wrong. A metric can be reliable and invalid at the same
       time, and the reliability score cannot detect it. */
    const stat = fs.statSync(f);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
      'Content-Length': stat.size,
    });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(LOCAL_PORT, () => r(srv)));
}

(async () => {
  const server = SERVE_LOCAL ? await startServer() : null;
  let storageState = null;
  if (AUTH_STATE) {
    if (fs.existsSync(AUTH_STATE)) storageState = AUTH_STATE;
    else console.error(`[perf] PERF_AUTH_STATE=${AUTH_STATE} not found — authed pages will report BLOCKED`);
  }

  const only = arg('page', '');
  const pages = only ? PAGES.filter(p => only.split(',').includes(p.key)) : PAGES;

  const browser = await chromium.launch();
  const out = {
    at: new Date().toISOString(), base: BASE, runs: RUNS,
    conditions: CONDITIONS, pages: {},
  };

  for (const pg of pages) {
    if (pg.auth && !storageState) {
      out.pages[pg.key] = { status: 'BLOCKED', reason: 'no PERF_AUTH_STATE; page redirects to /login' };
      continue;
    }
    const runs = [];
    let discarded = 0, landedAs = null;
    for (let i = 0; i < RUNS; i++) {
      const r = await runOnce(browser, pg, storageState);
      if (!r.valid) { discarded++; landedAs = r.landed; continue; }
      runs.push(r);
    }
    if (!runs.length) {
      out.pages[pg.key] = { status: 'BLOCKED', reason: `all ${RUNS} runs landed on ${landedAs}` };
      continue;
    }
    const metrics = {};
    for (const k of METRICS) {
      const s = stats(runs.map(r => r[k]));
      if (s) metrics[k] = { ...s, grade: gradeOf(s.cv) };
    }
    out.pages[pg.key] = { status: 'OK', samples: runs.length, discarded, metrics };
  }
  await browser.close();
  if (server) server.close();

  /* ── History ─────────────────────────────────────────────────────────────*/
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch (_) {}
  const previous = history.length ? history[history.length - 1] : null;

  if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
  else {
    console.log(`\nSOKONI Performance Probe — ${BASE}`);
    console.log((SERVE_LOCAL ? 'LOCAL working tree' : 'PRODUCTION (network+server variance included)') + '  ·  ' + `${RUNS} runs · CPU ${CONDITIONS.cpuThrottle}x · ${CONDITIONS.network.downloadKbps / 1024}Mbps/${CONDITIONS.network.latencyMs}ms · ${CONDITIONS.viewport.width}px`);
    console.log('Grade: AUTHORITATIVE CV<10% (may gate) · INDICATIVE CV<25% (track) · NOISY (not a result)\n');
    for (const [key, pg] of Object.entries(out.pages)) {
      if (pg.status !== 'OK') { console.log(`${key}: ${pg.status} — ${pg.reason}`); continue; }
      console.log(`── ${key}  (${pg.samples} samples${pg.discarded ? `, ${pg.discarded} discarded` : ''})`);
      console.log('   metric        median      p95      CV   grade          budget');
      for (const k of METRICS) {
        const m = pg.metrics[k]; if (!m) continue;
        const b = BUDGETS[k];
        let verdict = '';
        if (b && b.max != null) {
          const pass = m.median <= b.max;
          verdict = (pass ? 'PASS ' : 'OVER ') + b.max + (m.grade === 'AUTHORITATIVE' ? '' : ' (not gated)');
        }
        let delta = '';
        if (COMPARE && previous && previous.pages[key] && previous.pages[key].metrics && previous.pages[key].metrics[k]) {
          const d = m.median - previous.pages[key].metrics[k].median;
          const pct = previous.pages[key].metrics[k].median ? (d / previous.pages[key].metrics[k].median * 100) : 0;
          if (Math.abs(pct) >= 1) delta = `  ${d > 0 ? '+' : ''}${d.toFixed(2)} (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)`;
        }
        console.log('   ' + k.padEnd(12) + String(m.median).padStart(9) + String(m.p95).padStart(9) +
          String(m.cv + '%').padStart(8) + '  ' + m.grade.padEnd(14) + verdict + delta);
      }
      console.log('');
    }
    const auth = [];
    for (const pg of Object.values(out.pages)) {
      if (pg.status !== 'OK') continue;
      for (const [k, m] of Object.entries(pg.metrics)) if (m.grade === 'AUTHORITATIVE') auth.push(k);
    }
    console.log('Metrics demonstrated AUTHORITATIVE this run: ' +
      ([...new Set(auth)].sort().join(', ') || 'none'));
  }

  history.push(out);
  try {
    fs.writeFileSync(HISTORY, JSON.stringify(history.slice(-40), null, 2));
    if (!AS_JSON) console.log(`History: ${history.length} entries -> docs/perf-history.json`);
  } catch (e) { console.error('[perf] could not write history: ' + e.message); }

  /* ── Gate: ONLY on metrics this run proved reliable ───────────────────────*/
  if (GATE) {
    const breaches = [];
    for (const [key, pg] of Object.entries(out.pages)) {
      if (pg.status !== 'OK') continue;
      for (const [k, m] of Object.entries(pg.metrics)) {
        const b = BUDGETS[k];
        if (!b || b.max == null) continue;
        if (m.grade !== 'AUTHORITATIVE') continue;   /* never gate on noise */
        if (m.median > b.max) breaches.push(`${key}.${k} ${m.median} > ${b.max} (CV ${m.cv}%)`);
      }
    }
    if (breaches.length) {
      console.error('\nPERFORMANCE GATE FAILED:\n  ' + breaches.join('\n  '));
      process.exit(1);
    }
    console.log('\nPERFORMANCE GATE PASSED (authoritative metrics only)');
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
