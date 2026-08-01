'use strict';
/**
 * Long-task attribution — Sprint 1B step 1.
 *
 * The probe tells us a task took 1356 ms. It cannot say WHICH FUNCTION burned
 * it, and "make the page faster" without attribution is guesswork. This captures
 * a V8 CPU profile over page load under the SAME pinned conditions the probe
 * uses (CPU 4x, emulated network, local working tree) and reports:
 *
 *   • self-time per function — time in the function's OWN frames, excluding
 *     children. Self-time is what you can actually delete; total-time mostly
 *     tells you who called whom.
 *   • self-time aggregated per SCRIPT, which is the unit we can defer or split.
 *   • the long tasks themselves, so a fix can be tied to a specific task.
 *
 * Usage:
 *   node scripts/perf-profile.js                  home
 *   node scripts/perf-profile.js --page category
 *   node scripts/perf-profile.js --top 25
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = parseInt(process.env.PERF_PORT || '8289', 10);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const PAGE = arg('page', 'home');
const TOP = parseInt(arg('top', '18'), 10);

const ROUTES = { home: '/', search: '/search?q=cleaning',
  category: '/category?cat=electronics', product: '/product', checkout: '/checkout' };

/* Same fixed conditions as scripts/perf-probe.js — a profile taken under
   different conditions cannot be compared with the probe's numbers. */
const CPU_THROTTLE = 4;
const NET = { latency: 40, downloadThroughput: 10240 * 128, uploadThroughput: 3072 * 128 };

const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.woff2':'font/woff2' };

function serve() {
  const root = path.resolve(__dirname, '..');
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
  return new Promise(r => s.listen(PORT, () => r(s)));
}

/* V8 returns a node tree plus a flat sample array. Self-time is derived from the
   SAMPLES (how often each node was on top of the stack), not from the tree —
   the tree alone cannot distinguish a function that is slow from one that merely
   calls something slow. */
function selfTimes(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  const deltas = profile.timeDeltas || [];
  const samples = profile.samples || [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = deltas[i] || 0;
    self.set(id, (self.get(id) || 0) + dt);
  }
  const rows = [];
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame || {};
    rows.push({
      fn: cf.functionName || '(anonymous)',
      url: cf.url || '',
      line: cf.lineNumber != null ? cf.lineNumber + 1 : null,
      ms: us / 1000,
    });
  }
  return rows.sort((a, b) => b.ms - a.ms);
}

const shortUrl = (u) => {
  if (!u) return '(vm)';
  try { const p = new URL(u); return p.hostname.includes('localhost') ? p.pathname.replace(/^\//, '') : p.hostname + p.pathname.slice(-28); }
  catch (_) { return u.slice(-40); }
};

(async () => {
  const server = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  await ctx.addInitScript(`window.__lt=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())
    if(e.duration>50)window.__lt.push({d:Math.round(e.duration),s:Math.round(e.startTime)});})
    .observe({type:'longtask',buffered:true});}catch(e){}`);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NET });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });   /* 0.2ms */
  await cdp.send('Profiler.start');

  await page.goto(`http://localhost:${PORT}${ROUTES[PAGE]}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(4000);

  const { profile } = await cdp.send('Profiler.stop');
  const tasks = await page.evaluate(() => window.__lt || []);
  await browser.close();
  server.close();

  const rows = selfTimes(profile);
  const totalMs = rows.reduce((s, r) => s + r.ms, 0);

  console.log(`\nLong-task attribution — ${PAGE}  (CPU ${CPU_THROTTLE}x, local working tree)`);
  console.log(`Total sampled CPU: ${Math.round(totalMs)}ms across ${rows.length} frames\n`);

  console.log(`Long tasks (>50ms): ${tasks.length}`);
  tasks.sort((a, b) => b.d - a.d).slice(0, 6)
    .forEach(t => console.log(`   ${String(t.d).padStart(5)}ms  at +${t.s}ms`));

  console.log(`\nTop ${TOP} functions by SELF time (what you can actually delete):`);
  console.log('     self  share  function                          script');
  rows.slice(0, TOP).forEach(r => {
    console.log('  ' + (Math.round(r.ms) + 'ms').padStart(7) +
      (((r.ms / totalMs) * 100).toFixed(1) + '%').padStart(7) + '  ' +
      (r.fn || '(anon)').slice(0, 32).padEnd(32) + ' ' +
      shortUrl(r.url) + (r.line ? ':' + r.line : ''));
  });

  /* Per-script aggregate: the unit that can be deferred, split or dropped. */
  const byScript = new Map();
  rows.forEach(r => {
    const k = shortUrl(r.url);
    byScript.set(k, (byScript.get(k) || 0) + r.ms);
  });
  const scripts = [...byScript.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\nSelf time by SCRIPT (the unit you can defer or split):');
  scripts.slice(0, 14).forEach(([k, ms]) => {
    console.log('  ' + (Math.round(ms) + 'ms').padStart(7) +
      (((ms / totalMs) * 100).toFixed(1) + '%').padStart(7) + '  ' + k);
  });

  const out = path.resolve(__dirname, `../docs/perf-profile-${PAGE}.json`);
  fs.writeFileSync(out, JSON.stringify({
    page: PAGE, at: new Date().toISOString(), cpuThrottle: CPU_THROTTLE,
    totalSampledMs: Math.round(totalMs), longTasks: tasks,
    topFunctions: rows.slice(0, 60), byScript: scripts.slice(0, 40),
  }, null, 2));
  console.log(`\nSaved: docs/perf-profile-${PAGE}.json`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
