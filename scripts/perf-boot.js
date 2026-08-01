'use strict';
/**
 * Boot sequence map — WHO mutates the DOM during startup, WHEN, and HOW MUCH.
 *
 * ── Why this instead of another optimisation ────────────────────────────────
 * Sprint 2 rejected three of four experiments. The fourth — the one that worked —
 * was architectural. The pattern in the rejections is consistent and was finally
 * proven on the last one:
 *
 *   `_measure` runs on requestAnimationFrame, so it is often the first code to
 *   ask for geometry after other modules mutate the DOM. The browser flushes
 *   then, and the trace charges the flush to whoever ASKED, not whoever DIRTIED.
 *
 * Forced-layout attribution therefore shows where the bill LANDS, not where the
 * cost ORIGINATES. Optimising the reader cannot work. The actionable target is
 * the mutation schedule — which means the first job is to see it.
 *
 * This answers: which modules mutate the DOM during startup, when, how much, and
 * what is actually needed before first paint.
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 * Every mutating DOM API is wrapped before any page script runs. Each call
 * records a timestamp and the first stack frame outside the instrumentation, so
 * mutations are attributed to a real script and line. Paint milestones (FCP,
 * LCP, DCL, load) are recorded on the same clock.
 *
 * ── Honest limits ───────────────────────────────────────────────────────────
 *   • Wrapping these APIs adds overhead, so ABSOLUTE timings here are inflated
 *     and must not be compared with perf-probe numbers. What is trustworthy is
 *     the ORDER, the ATTRIBUTION and the RELATIVE volume — which is the whole
 *     question being asked.
 *   • Mutations from parser-inserted HTML are not captured (no script performs
 *     them); this measures SCRIPT-DRIVEN mutation.
 *   • `innerHTML` counts as one mutation regardless of how many nodes it builds,
 *     so node-count is reported separately where it can be derived.
 *
 *   node scripts/perf-boot.js --page home
 *   node scripts/perf-boot.js --page home --ref HEAD --json
 */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PERF_PORT || '8293', 10);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const PAGE = arg('page', 'home');
const REF  = arg('ref', 'working');
const AS_JSON = process.argv.includes('--json');

const ROUTES = { home: '/', search: '/search?q=cleaning',
  category: '/category?cat=electronics', product: '/product' };
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

/* Installed before any page script. Wraps mutating APIs and attributes each call
   to the first stack frame that is not part of this shim. */
const INSTRUMENT = `
(function () {
  window.__boot = { m: [], marks: {} };
  var M = window.__boot.m;

  function site() {
    var st = (new Error()).stack || '';
    var lines = st.split('\\n');
    for (var i = 1; i < lines.length; i++) {
      var l = lines[i];
      if (l.indexOf('__boot') > -1 || l.indexOf('wrap') > -1 || l.indexOf('site') > -1) continue;
      var m = l.match(/((?:https?:\\/\\/|\\/)[^\\s):]+):(\\d+):(\\d+)/);
      if (!m) continue;
      var file = m[1].split('/').pop() || m[1];
      if (!file) continue;
      return file + ':' + m[2];
    }
    return '(unknown)';
  }

  function rec(kind, n) {
    M.push({ t: Math.round(performance.now()), k: kind, s: site(), n: n || 1 });
  }

  /* Structural mutations */
  ['appendChild', 'insertBefore', 'removeChild', 'replaceChild'].forEach(function (fn) {
    var orig = Node.prototype[fn];
    if (!orig) return;
    Node.prototype[fn] = function (a) {
      var n = (a && a.nodeType === 11 && a.childNodes) ? a.childNodes.length : 1;
      rec(fn, n);
      return orig.apply(this, arguments);
    };
  });
  ['append', 'prepend', 'before', 'after', 'replaceWith', 'remove'].forEach(function (fn) {
    var orig = Element.prototype[fn];
    if (!orig) return;
    Element.prototype[fn] = function () { rec(fn, arguments.length || 1); return orig.apply(this, arguments); };
  });

  /* innerHTML — one call, potentially many nodes. Node count is derived after
     the fact so bulk construction is not undercounted as a single mutation. */
  ['innerHTML', 'outerHTML'].forEach(function (prop) {
    var d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!d || !d.set) return;
    Object.defineProperty(Element.prototype, prop, {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) {
        var approx = typeof v === 'string' ? (v.match(/</g) || []).length : 1;
        rec(prop, approx);
        return d.set.call(this, v);
      }
    });
  });

  /* Attribute / style / class writes — these invalidate style. */
  var sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function () { rec('setAttribute'); return sa.apply(this, arguments); };
  ['add', 'remove', 'toggle'].forEach(function (fn) {
    var orig = DOMTokenList.prototype[fn];
    if (!orig) return;
    DOMTokenList.prototype[fn] = function () { rec('class.' + fn); return orig.apply(this, arguments); };
  });
  var sp = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function () { rec('setProperty'); return sp.apply(this, arguments); };

  /* Paint + lifecycle milestones on the same clock. */
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) {
        if (e.name === 'first-contentful-paint') window.__boot.marks.fcp = Math.round(e.startTime);
      });
    }).observe({ type: 'paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(function (l) {
      var es = l.getEntries();
      window.__boot.marks.lcp = Math.round(es[es.length - 1].startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  document.addEventListener('DOMContentLoaded', function () { window.__boot.marks.dcl = Math.round(performance.now()); });
  window.addEventListener('load', function () { window.__boot.marks.load = Math.round(performance.now()); });
})();
`;

(async () => {
  let wt = null, server = null, browser = null;
  try {
    let root = REPO;
    if (REF !== 'working') {
      wt = path.join(os.tmpdir(), 'perfboot-' + REF.replace(/[^a-z0-9]/gi, '') + '-' + Date.now());
      execSync(`git worktree add -q --detach "${wt}" ${REF}`, { cwd: REPO, stdio: 'pipe' });
      root = wt;
    }
    server = await serve(root, PORT);
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await ctx.addInitScript(INSTRUMENT);
    const page = await ctx.newPage();
    page.on('pageerror', () => {});
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NET });

    await page.goto(`http://localhost:${PORT}${ROUTES[PAGE]}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(5000);
    const boot = await page.evaluate(() => window.__boot);

    const marks = boot.marks || {};
    const muts = boot.m || [];
    const fcp = marks.fcp || 0;

    /* Aggregate by script. */
    const byScript = new Map();
    muts.forEach(m => {
      const f = m.s.split(':')[0];
      if (!byScript.has(f)) byScript.set(f, { calls: 0, nodes: 0, beforeFcp: 0, afterFcp: 0, first: Infinity, last: 0, kinds: {} });
      const r = byScript.get(f);
      r.calls++; r.nodes += m.n;
      if (fcp && m.t <= fcp) r.beforeFcp++; else r.afterFcp++;
      r.first = Math.min(r.first, m.t); r.last = Math.max(r.last, m.t);
      r.kinds[m.k] = (r.kinds[m.k] || 0) + 1;
    });
    const scripts = [...byScript.entries()].sort((a, b) => b[1].nodes - a[1].nodes);

    /* Timeline buckets. */
    const BUCKETS = [[0,50],[50,150],[150,300],[300,600],[600,1200],[1200,2500],[2500,5000],[5000,Infinity]];
    const timeline = BUCKETS.map(([lo, hi]) => {
      const inB = muts.filter(m => m.t >= lo && m.t < hi);
      const top = new Map();
      inB.forEach(m => { const f = m.s.split(':')[0]; top.set(f, (top.get(f) || 0) + m.n); });
      return { lo, hi, calls: inB.length, nodes: inB.reduce((s, m) => s + m.n, 0),
               top: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) };
    });

    const out = { page: PAGE, ref: REF, at: new Date().toISOString(), marks,
      totalCalls: muts.length, totalNodes: muts.reduce((s, m) => s + m.n, 0),
      beforeFcp: muts.filter(m => fcp && m.t <= fcp).length,
      scripts: scripts.map(([f, r]) => ({ file: f, ...r, first: r.first === Infinity ? null : r.first })),
      timeline };

    if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
    else {
      console.log(`\n══ Boot sequence map — ${PAGE} (ref=${REF}, CPU ${CPU_THROTTLE}x) ══`);
      console.log(`Milestones: FCP ${marks.fcp||'-'}ms · LCP ${marks.lcp||'-'}ms · DCL ${marks.dcl||'-'}ms · load ${marks.load||'-'}ms`);
      console.log(`Script-driven DOM mutations: ${out.totalCalls} calls / ~${out.totalNodes} nodes` +
                  `   (${out.beforeFcp} calls BEFORE first paint)\n`);

      console.log('── Timeline ──');
      console.log('  window        calls   nodes   top mutators');
      timeline.forEach(b => {
        if (!b.calls) return;
        const lbl = (b.hi === Infinity ? `${b.lo}ms+` : `${b.lo}-${b.hi}ms`).padEnd(13);
        console.log('  ' + lbl + String(b.calls).padStart(5) + String(b.nodes).padStart(8) + '   ' +
          b.top.map(([f, n]) => `${f} (${n})`).join(', '));
      });

      console.log('\n── Mutators, ranked by nodes created ──');
      console.log('  nodes  calls  before/after FCP   window        script');
      scripts.slice(0, 16).forEach(([f, r]) => {
        console.log('  ' + String(r.nodes).padStart(5) + String(r.calls).padStart(7) +
          '   ' + String(r.beforeFcp + '/' + r.afterFcp).padStart(11) +
          '     ' + String(r.first + '-' + r.last + 'ms').padEnd(14) + f);
      });

      console.log('\nNOTE: absolute times are inflated by instrumentation overhead and are NOT');
      console.log('comparable with perf-probe. Order, attribution and relative volume are the result.');
    }

    fs.writeFileSync(path.resolve(REPO, `docs/perf-boot-${PAGE}.json`), JSON.stringify(out, null, 2));
    if (!AS_JSON) console.log(`\nSaved: docs/perf-boot-${PAGE}.json`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    if (wt) { try { execSync(`git worktree remove -f "${wt}"`, { cwd: REPO, stdio: 'pipe' }); } catch (_) {} }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
