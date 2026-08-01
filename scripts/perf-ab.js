'use strict';
/**
 * Interleaved A/B performance comparison.
 *
 * ── The problem this exists to solve ────────────────────────────────────────
 * scripts/perf-probe.js reports a within-run coefficient of variation, and that
 * is genuinely useful — it catches a metric too noisy to mean anything. But it
 * measures variance BETWEEN THE SAMPLES OF ONE INVOCATION, and it is blind to
 * drift BETWEEN invocations.
 *
 * Measured 2026-08-01 on IDENTICAL code, five consecutive invocations:
 *
 *     TBT   10642 -> 11579 -> 12438 -> 13087 -> 13115      (+23%)
 *
 * Every one of those was AUTHORITATIVE at 5-9% CV internally. The host was
 * simply getting slower — thermal throttling and accumulated load. A change
 * measured before that drift and compared against a run after it shows a
 * "regression" that is purely the machine. That mistake was made for real: a
 * layout fix which reduced its own script's self-time by 34% was reverted
 * because the total looked 9% worse, when the baseline had moved further than
 * the effect being measured.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * Measure A and B ALTERNATELY inside a single invocation: A,B,A,B,A,B. Drift
 * applies to both arms equally, so while the absolute numbers still wander, the
 * DIFFERENCE between them stays valid. Absolutes are reported for context and
 * explicitly marked untrustworthy; only the delta is a result.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/perf-ab.js --a HEAD --b working        working tree vs HEAD
 *   node scripts/perf-ab.js --a HEAD~1 --b HEAD --pairs 6
 *   node scripts/perf-ab.js --a HEAD --b working --page category
 *
 * "working" means the current working tree. Any other value is a git ref, which
 * is materialised in a temporary worktree and removed afterwards.
 * ========================================================================== */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

const REF_A = arg('a', 'HEAD');
const REF_B = arg('b', 'working');
/* Pairs are forced EVEN. Order alternates A,B / B,A so neither arm is
   systematically measured second — but with an odd count one arm still goes
   first once more than the other, and the null control showed that bias alone
   producing a '3/3 consistent' 2% LCP difference between identical trees. */
let PAIRS = parseInt(arg('pairs', '6'), 10);
if (PAIRS % 2) PAIRS++;
const PAGE = arg('page', 'home');
const ROOT = path.resolve(__dirname, '..');
const ROUTES = { home: '/', search: '/search?q=cleaning',
  category: '/category?cat=electronics', product: '/product' };

const CPU_THROTTLE = 4;
const NET = { latency: 40, downloadThroughput: 10240 * 128, uploadThroughput: 3072 * 128 };
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.woff2':'font/woff2' };

const COLLECTOR = `
window.__p={lcp:0,cls:0,lt:[]};
try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__p.lcp=e.startTime;})
 .observe({type:'largest-contentful-paint',buffered:true});}catch(e){}
try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__p.cls+=e.value;})
 .observe({type:'layout-shift',buffered:true});}catch(e){}
try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(e.duration>50)window.__p.lt.push(e.duration);})
 .observe({type:'longtask',buffered:true});}catch(e){}`;

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

async function measure(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.addInitScript(COLLECTOR);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NET });
  /* Style/layout duration. Sprint 2 measurement showed these are 64% of total
     task time on the homepage while V8 compile is 2% - so a change that reduces
     browser layout work is invisible to TBT/LCP alone. Rejecting an optimisation
     on metrics that cannot see its effect is how a real improvement gets thrown
     away; the sokoni-layout.js ResizeObserver change was very likely such a case. */
  await cdp.send('Performance.enable');

  const t0 = Date.now();
  await page.goto(base + ROUTES[PAGE], { waitUntil: 'load', timeout: 120000 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(4000);
  const m = await page.evaluate(() => {
    const lt = window.__p.lt || [];
    return { lcp: Math.round(window.__p.lcp || 0), cls: +(window.__p.cls || 0).toFixed(4),
      tbt: Math.round(lt.reduce((s, d) => s + Math.max(0, d - 50), 0)),
      longTasks: lt.length, worstTask: Math.round(lt.length ? Math.max(...lt) : 0) };
  });
  const perf = await cdp.send('Performance.getMetrics');
  const M = {}; (perf.metrics || []).forEach(x => { M[x.name] = x.value; });
  await ctx.close();
  return { ...m, loadMs,
    layoutMs: Math.round((M.LayoutDuration || 0) * 1000),
    styleMs:  Math.round((M.RecalcStyleDuration || 0) * 1000),
    scriptMs: Math.round((M.ScriptDuration || 0) * 1000),
    compileMs: Math.round((M.V8CompileDuration || 0) * 1000) };
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length;
  return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/* Paired differences: for each A,B pair measured back to back, compute B-A. The
   MEDIAN of those differences is robust to the baseline wandering underneath. */
function pairedDelta(aArr, bArr) {
  const d = [];
  for (let i = 0; i < Math.min(aArr.length, bArr.length); i++) d.push(bArr[i] - aArr[i]);
  const wins = d.filter(x => x < 0).length;
  return { median: med(d), all: d, improvedIn: wins, of: d.length };
}

(async () => {
  const tmp = [];
  const mkTree = (ref) => {
    if (ref === 'working') return ROOT;
    const dir = path.join(os.tmpdir(), 'perfab-' + ref.replace(/[^a-z0-9]/gi, '') + '-' + Date.now());
    execSync(`git worktree add -q --detach "${dir}" ${ref}`, { cwd: ROOT, stdio: 'pipe' });
    tmp.push(dir);
    return dir;
  };

  let sA, sB;
  try {
    const rootA = mkTree(REF_A), rootB = mkTree(REF_B);
    sA = await serve(rootA, 8301);
    sB = await serve(rootB, 8302);
    const baseA = 'http://localhost:8301', baseB = 'http://localhost:8302';

    const browser = await chromium.launch();
    const A = [], B = [];
    process.stdout.write(`Interleaving ${PAIRS} pairs on /${PAGE}  (A=${REF_A}  B=${REF_B})\n  `);
    for (let i = 0; i < PAIRS; i++) {
      /* Order alternates so neither arm is systematically favoured by a warm
         browser or a machine that slows within the pair. */
      if (i % 2 === 0) { A.push(await measure(browser, baseA)); B.push(await measure(browser, baseB)); }
      else             { B.push(await measure(browser, baseB)); A.push(await measure(browser, baseA)); }
      process.stdout.write('.');
    }
    process.stdout.write('\n\n');
    await browser.close();

    const METRICS = ['tbt', 'lcp', 'cls', 'longTasks', 'worstTask', 'loadMs',
                     'layoutMs', 'styleMs', 'scriptMs', 'compileMs'];
    console.log('metric        A(med)     B(med)   paired-delta   B better in');
    console.log('--------------------------------------------------------------');
    for (const k of METRICS) {
      const av = A.map(r => r[k]), bv = B.map(r => r[k]);
      const d = pairedDelta(av, bv);
      const pct = med(av) ? (d.median / med(av) * 100) : 0;
      const sig = d.improvedIn === d.of ? '  ***' : d.improvedIn === 0 ? '  (none)' : '';
      console.log(k.padEnd(12) +
        String(+med(av).toFixed(3)).padStart(9) + String(+med(bv).toFixed(3)).padStart(11) +
        (String(d.median > 0 ? '+' : '') + (+d.median.toFixed(3))).padStart(12) +
        ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)` +
        String(`${d.improvedIn}/${d.of}`).padStart(9) + sig);
    }
    console.log('\nAbsolute medians drift between invocations and are NOT comparable across runs.');
    console.log('The paired delta is the result: it is measured inside one invocation, so host');
    console.log('drift applies to both arms equally. "B better in n/n" is the consistency check —');
    console.log('a delta that only wins in half the pairs is not an improvement.');
  } finally {
    if (sA) sA.close();
    if (sB) sB.close();
    for (const d of tmp) {
      try { execSync(`git worktree remove -f "${d}"`, { cwd: ROOT, stdio: 'pipe' }); } catch (_) {}
    }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
