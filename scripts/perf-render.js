'use strict';
/**
 * Style / layout attribution via Chrome tracing — Sprint 2 Phase 1.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * Direct measurement (Performance.getMetrics) showed the homepage spends
 * ~10.5 s in style recalculation and ~6.9 s in layout — 64% of total task time —
 * while V8 compile is 97 ms. Aggregate durations say WHAT dominates; they cannot
 * say WHICH selector, WHICH mutation, or WHICH call site. This extracts that.
 *
 * ── What it reports ─────────────────────────────────────────────────────────
 *   • UpdateLayoutTree (style recalc) ranked by duration, with element counts
 *   • Layout ranked by duration, with dirty/total object counts
 *   • FORCED synchronous layout — Layout/UpdateLayoutTree carrying a JS stack,
 *     i.e. code that wrote to the DOM and then immediately read geometry. These
 *     are the ones with a named culprit and a known fix (read/write batching).
 *   • Invalidation reasons ranked, from invalidationTracking
 *
 * ── Stability calibration ───────────────────────────────────────────────────
 * Attribution is data too, and it earns trust the same way timings do. With
 * `--runs N` the same page is traced N times and each aggregate gets a
 * coefficient of variation:
 *
 *     CV < 5%    AUTHORITATIVE  act on it
 *     CV < 20%   INDICATIVE     a hint, not a plan
 *     otherwise  NOISY          do not rank work by it
 *
 * A ranking that reshuffles between runs is not a ranking.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/perf-render.js --page home --runs 3
 *   node scripts/perf-render.js --ref HEAD --page category
 * ========================================================================== */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PERF_PORT || '8291', 10);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

const PAGE = arg('page', 'home');
const REF  = arg('ref', 'working');
const RUNS = parseInt(arg('runs', '3'), 10);

const ROUTES = { home: '/', search: '/search?q=cleaning',
  category: '/category?cat=electronics', product: '/product' };

const CPU_THROTTLE = 4;
const NET = { latency: 40, downloadThroughput: 10240 * 128, uploadThroughput: 3072 * 128 };
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.woff2':'font/woff2' };

const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'disabled-by-default-devtools.timeline.stack',
  'blink.user_timing',
].join(',');

function serve(root, port) {
  const s = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    let f = path.join(root, u);
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    const st = fs.statSync(f);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(port, () => r(s)));
}

/* A Layout or UpdateLayoutTree that carries a JS stack was triggered
   SYNCHRONOUSLY by script — the browser had to flush because code asked for
   geometry it had just invalidated. Those have a named call site and a known
   remedy, which makes them the actionable subset. */
function frameOf(st) {
  if (!st || !st.length) return null;
  const f = st[0];
  const url = (f.url || '').split('/').pop() || '(inline)';
  return `${f.functionName || '(anon)'} @ ${url}:${f.lineNumber || 0}`;
}

async function traceOnce(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NET });

  const events = [];
  cdp.on('Tracing.dataCollected', (d) => { if (d.value) events.push(...d.value); });
  const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));

  await cdp.send('Tracing.start', {
    categories: CATEGORIES, transferMode: 'ReportEvents',
    options: 'sampling-frequency=10000',
  });
  await page.goto(base + ROUTES[PAGE], { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(4000);
  await cdp.send('Tracing.end');
  await done;
  await ctx.close();

  const styleEv = [], layoutEv = [], forced = new Map(), reasons = new Map();
  let styleUs = 0, layoutUs = 0, elements = 0;

  for (const e of events) {
    const dur = e.dur || 0;
    if (e.name === 'UpdateLayoutTree') {
      styleUs += dur;
      elements += (e.args && e.args.elementCount) || 0;
      const st = e.args && e.args.beginData && e.args.beginData.stackTrace;
      const key = frameOf(st);
      if (key) {
        const cur = forced.get(key) || { styleUs: 0, layoutUs: 0, n: 0 };
        cur.styleUs += dur; cur.n++; forced.set(key, cur);
      }
      styleEv.push({ dur, elements: (e.args && e.args.elementCount) || 0, at: e.ts });
    } else if (e.name === 'Layout') {
      layoutUs += dur;
      const bd = (e.args && e.args.beginData) || {};
      const key = frameOf(bd.stackTrace);
      if (key) {
        const cur = forced.get(key) || { styleUs: 0, layoutUs: 0, n: 0 };
        cur.layoutUs += dur; cur.n++; forced.set(key, cur);
      }
      layoutEv.push({ dur, dirty: bd.dirtyObjects || 0, total: bd.totalObjects || 0, at: e.ts });
    } else if (e.name === 'ScheduleStyleInvalidationTracking' ||
               e.name === 'StyleRecalcInvalidationTracking' ||
               e.name === 'LayoutInvalidationTracking') {
      const d = (e.args && e.args.data) || {};
      const r = d.reason || e.name;
      const node = d.nodeName ? String(d.nodeName).slice(0, 40) : '';
      const key = `${r}${node ? '  ' + node : ''}`;
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
  }

  return {
    styleMs: styleUs / 1000, layoutMs: layoutUs / 1000,
    styleCount: styleEv.length, layoutCount: layoutEv.length, elements,
    topStyle: styleEv.sort((a, b) => b.dur - a.dur).slice(0, 6).map(x => ({ ms: +(x.dur / 1000).toFixed(1), elements: x.elements })),
    topLayout: layoutEv.sort((a, b) => b.dur - a.dur).slice(0, 6).map(x => ({ ms: +(x.dur / 1000).toFixed(1), dirty: x.dirty, total: x.total })),
    forced: [...forced.entries()].map(([k, v]) => ({ site: k, ms: +((v.styleUs + v.layoutUs) / 1000).toFixed(1), n: v.n }))
      .sort((a, b) => b.ms - a.ms).slice(0, 12),
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length;
  return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
function cvOf(a) {
  if (a.length < 2) return null;
  const m = a.reduce((p, c) => p + c, 0) / a.length;
  if (!m) return 0;
  return +(Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length) / m * 100).toFixed(1);
}
const grade = (cv) => cv == null ? 'SINGLE-RUN' : cv < 5 ? 'AUTHORITATIVE' : cv < 20 ? 'INDICATIVE' : 'NOISY';

(async () => {
  let wt = null, server = null, browser = null;
  try {
    let root = REPO;
    if (REF !== 'working') {
      wt = path.join(os.tmpdir(), 'perfrender-' + REF.replace(/[^a-z0-9]/gi, '') + '-' + Date.now());
      execSync(`git worktree add -q --detach "${wt}" ${REF}`, { cwd: REPO, stdio: 'pipe' });
      root = wt;
    }
    server = await serve(root, PORT);
    browser = await chromium.launch();
    const base = `http://localhost:${PORT}`;

    const runs = [];
    process.stdout.write(`Tracing ${RUNS} run(s) of /${PAGE} (ref=${REF}, CPU ${CPU_THROTTLE}x)\n  `);
    for (let i = 0; i < RUNS; i++) { runs.push(await traceOnce(browser, base)); process.stdout.write('.'); }
    process.stdout.write('\n');

    const styleArr = runs.map(r => r.styleMs), layoutArr = runs.map(r => r.layoutMs);
    const sCv = cvOf(styleArr), lCv = cvOf(layoutArr);
    const last = runs[runs.length - 1];

    console.log(`\n══ Style / layout attribution — ${PAGE} ══`);
    console.log(`  style recalc   ${med(styleArr).toFixed(0)}ms   CV ${sCv == null ? '-' : sCv + '%'}  ${grade(sCv)}`);
    console.log(`  layout         ${med(layoutArr).toFixed(0)}ms   CV ${lCv == null ? '-' : lCv + '%'}  ${grade(lCv)}`);
    console.log(`  recalcs ${med(runs.map(r => r.styleCount))} · layouts ${med(runs.map(r => r.layoutCount))} · elements styled ${med(runs.map(r => r.elements))}`);

    console.log('\n── Worst individual STYLE recalculations ──');
    last.topStyle.forEach(s => console.log(`   ${String(s.ms).padStart(7)}ms   ${s.elements} elements`));

    console.log('\n── Worst individual LAYOUTS ──');
    last.topLayout.forEach(s => console.log(`   ${String(s.ms).padStart(7)}ms   ${s.dirty} dirty / ${s.total} objects`));

    console.log('\n── FORCED synchronous style/layout, by call site ──');
    console.log('   (script wrote the DOM then immediately read geometry — the actionable subset)');
    if (!last.forced.length) console.log('   none captured');
    last.forced.forEach(f => console.log(`   ${String(f.ms).padStart(7)}ms  x${String(f.n).padEnd(4)} ${f.site}`));

    console.log('\n── Invalidation reasons (most frequent) ──');
    if (!last.reasons.length) console.log('   none captured (invalidationTracking may be unavailable)');
    last.reasons.forEach(([k, n]) => console.log(`   ${String(n).padStart(6)}x  ${k}`));

    const out = path.resolve(REPO, `docs/perf-render-${PAGE}.json`);
    fs.writeFileSync(out, JSON.stringify({
      page: PAGE, ref: REF, at: new Date().toISOString(), runs: RUNS,
      styleMs: { median: med(styleArr), cv: sCv, grade: grade(sCv), all: styleArr },
      layoutMs: { median: med(layoutArr), cv: lCv, grade: grade(lCv), all: layoutArr },
      detail: last,
    }, null, 2));
    console.log(`\nSaved: docs/perf-render-${PAGE}.json`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    if (wt) { try { execSync(`git worktree remove -f "${wt}"`, { cwd: REPO, stdio: 'pipe' }); } catch (_) {} }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
