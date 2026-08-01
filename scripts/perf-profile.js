'use strict';
/**
 * CPU attribution + V8 parse/compile accounting.
 *
 * ── What it answers ─────────────────────────────────────────────────────────
 * The probe says a task took 1356 ms. This says WHICH FUNCTION burned it, and —
 * since Sprint 1B closed with parse/compile identified as the dominant cost —
 * how much of startup is spent COMPILING JavaScript rather than running it.
 *
 *   • self-time per function — time in the function's OWN frames. Self-time is
 *     what can actually be deleted; total-time mostly says who called whom.
 *   • self-time per SCRIPT — the unit that can be deferred, split or dropped.
 *   • V8CompileDuration vs ScriptDuration — the metric pair that scores bundle
 *     splitting and staged boot. Sprint 1B showed TBT is too coarse and too
 *     noisy for this: removing 430 ms of self-time from the largest script moved
 *     the page less than the noise floor, because ~57-62% of sampled CPU is
 *     `(program)` — V8 parse and compile of ~2.4 MB of shared JavaScript.
 *
 * ── Reproducibility ─────────────────────────────────────────────────────────
 * `--ref` profiles any git ref in a temporary worktree, so a baseline profile
 * can be REGENERATED rather than kept as a transient artifact. This is not
 * hypothetical: the committed baseline in docs/ was once silently overwritten by
 * a post-change run, leaving an attribution comparison with nothing durable
 * behind it.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/perf-profile.js                        working tree, home
 *   node scripts/perf-profile.js --ref HEAD             reproducible baseline
 *   node scripts/perf-profile.js --page category --top 25
 *
 * Workflow (paired with scripts/perf-ab.js):
 *   perf-profile --ref HEAD          →  baseline attribution
 *   …make the change…
 *   perf-profile                     →  confirm self-time actually dropped
 *   perf-ab --a HEAD --b working     →  accept or reject on paired evidence
 * ========================================================================== */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PERF_PORT || '8289', 10);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

const PAGE = arg('page', 'home');
const REF  = arg('ref', 'working');
const TOP  = parseInt(arg('top', '18'), 10);

const ROUTES = { home: '/', search: '/search?q=cleaning',
  category: '/category?cat=electronics', product: '/product', checkout: '/checkout' };

/* Identical to scripts/perf-probe.js and perf-ab.js. A profile taken under
   different conditions cannot be compared with either. */
const CPU_THROTTLE = 4;
const NET = { latency: 40, downloadThroughput: 10240 * 128, uploadThroughput: 3072 * 128 };

const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.woff2':'font/woff2' };

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

/* Self-time comes from the SAMPLES (how often a node was on top of the stack),
   not from the node tree — the tree alone cannot distinguish a function that is
   slow from one that merely calls something slow. */
function selfTimes(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  const deltas = profile.timeDeltas || [];
  const samples = profile.samples || [];
  for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) || 0) + (deltas[i] || 0));
  const rows = [];
  for (const [id, us] of self) {
    const n = byId.get(id); if (!n) continue;
    const cf = n.callFrame || {};
    rows.push({ fn: cf.functionName || '(anonymous)', url: cf.url || '',
      line: cf.lineNumber != null ? cf.lineNumber + 1 : null, ms: us / 1000 });
  }
  return rows.sort((a, b) => b.ms - a.ms);
}

const shortUrl = (u) => {
  if (!u) return '(vm)';
  try { const p = new URL(u); return p.hostname.includes('localhost') ? p.pathname.replace(/^\//, '') : p.hostname + p.pathname.slice(-28); }
  catch (_) { return u.slice(-40); }
};

(async () => {
  let worktree = null, server = null, browser = null;
  try {
    let root = REPO;
    if (REF !== 'working') {
      worktree = path.join(os.tmpdir(), 'perfprof-' + REF.replace(/[^a-z0-9]/gi, '') + '-' + Date.now());
      execSync(`git worktree add -q --detach "${worktree}" ${REF}`, { cwd: REPO, stdio: 'pipe' });
      root = worktree;
    }
    server = await serve(root, PORT);
    browser = await chromium.launch();
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await ctx.addInitScript(`window.__lt=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())
      if(e.duration>50)window.__lt.push({d:Math.round(e.duration),s:Math.round(e.startTime)});})
      .observe({type:'longtask',buffered:true});}catch(e){}`);
    const page = await ctx.newPage();
    page.on('pageerror', () => {});

    /* Bytes of JavaScript actually delivered — the input to parse/compile. */
    let jsBytes = 0, jsFiles = 0;
    page.on('response', (r) => {
      try {
        const ct = r.headers()['content-type'] || '';
        if (/javascript|ecmascript/.test(ct)) {
          jsBytes += parseInt(r.headers()['content-length'] || '0', 10) || 0;
          jsFiles++;
        }
      } catch (_) {}
    });

    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NET });
    await cdp.send('Performance.enable');      /* V8CompileDuration / ScriptDuration */
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');

    await page.goto(`http://localhost:${PORT}${ROUTES[PAGE]}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(4000);

    const { profile } = await cdp.send('Profiler.stop');
    const perf = await cdp.send('Performance.getMetrics');
    const M = {};
    (perf.metrics || []).forEach(m => { M[m.name] = m.value; });
    const tasks = await page.evaluate(() => window.__lt || []);

    const rows = selfTimes(profile);
    const totalMs = rows.reduce((s, r) => s + r.ms, 0);

    /* Chrome reports these in seconds. */
    const compileMs = Math.round((M.V8CompileDuration || 0) * 1000);
    const scriptMs  = Math.round((M.ScriptDuration || 0) * 1000);
    const taskMs    = Math.round((M.TaskDuration || 0) * 1000);
    const layoutMs  = Math.round((M.LayoutDuration || 0) * 1000);
    const styleMs   = Math.round((M.RecalcStyleDuration || 0) * 1000);

    console.log(`\nCPU attribution — ${PAGE}  (ref=${REF}, CPU ${CPU_THROTTLE}x)`);
    console.log(`Total sampled CPU: ${Math.round(totalMs)}ms across ${rows.length} frames`);

    console.log(`\n── JavaScript cost: parse/compile vs execute ──`);
    console.log(`  JS delivered        ${(jsBytes / 1024).toFixed(0)}KB across ${jsFiles} files`);
    console.log(`  V8 compile          ${compileMs}ms` +
      (scriptMs ? `   (${((compileMs / (compileMs + scriptMs)) * 100).toFixed(0)}% of JS cost)` : ''));
    console.log(`  Script execute      ${scriptMs}ms`);
    console.log(`  Layout / style      ${layoutMs}ms / ${styleMs}ms`);
    console.log(`  Total task time     ${taskMs}ms`);
    console.log(`  Compile per KB      ${jsBytes ? (compileMs / (jsBytes / 1024)).toFixed(2) : '-'}ms/KB`);

    console.log(`\nLong tasks (>50ms): ${tasks.length}`);
    tasks.sort((a, b) => b.d - a.d).slice(0, 6).forEach(t =>
      console.log(`   ${String(t.d).padStart(5)}ms  at +${t.s}ms`));

    console.log(`\nTop ${TOP} functions by SELF time:`);
    rows.slice(0, TOP).forEach(r => console.log('  ' + (Math.round(r.ms) + 'ms').padStart(7) +
      (((r.ms / totalMs) * 100).toFixed(1) + '%').padStart(7) + '  ' +
      (r.fn || '(anon)').slice(0, 32).padEnd(32) + ' ' + shortUrl(r.url) + (r.line ? ':' + r.line : '')));

    const byScript = new Map();
    rows.forEach(r => byScript.set(shortUrl(r.url), (byScript.get(shortUrl(r.url)) || 0) + r.ms));
    const scripts = [...byScript.entries()].sort((a, b) => b[1] - a[1]);
    console.log('\nSelf time by SCRIPT (the unit you can defer or split):');
    scripts.slice(0, 14).forEach(([k, ms]) => console.log('  ' + (Math.round(ms) + 'ms').padStart(7) +
      (((ms / totalMs) * 100).toFixed(1) + '%').padStart(7) + '  ' + k));

    const tag = REF === 'working' ? PAGE : `${PAGE}-${REF.replace(/[^a-z0-9]/gi, '')}`;
    const out = path.resolve(REPO, `docs/perf-profile-${tag}.json`);
    fs.writeFileSync(out, JSON.stringify({
      page: PAGE, ref: REF, at: new Date().toISOString(), cpuThrottle: CPU_THROTTLE,
      totalSampledMs: Math.round(totalMs),
      js: { deliveredKB: Math.round(jsBytes / 1024), files: jsFiles,
            compileMs, scriptMs, taskMs, layoutMs, styleMs,
            compilePerKB: jsBytes ? +(compileMs / (jsBytes / 1024)).toFixed(3) : null },
      longTasks: tasks, topFunctions: rows.slice(0, 60), byScript: scripts.slice(0, 40),
    }, null, 2));
    console.log(`\nSaved: docs/perf-profile-${tag}.json`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    if (worktree) { try { execSync(`git worktree remove -f "${worktree}"`, { cwd: REPO, stdio: 'pipe' }); } catch (_) {} }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
