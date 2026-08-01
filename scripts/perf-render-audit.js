'use strict';
/**
 * displayProducts() render audit — counting, not changing.
 *
 * The boot map showed script.js creating ~3330 DOM nodes (79% of all mutation)
 * in 62 calls spread over 18 seconds, on a page that renders only 20 products
 * (~320 nodes per pass). That is an order of magnitude more than one render, and
 * `displayProducts` has ten call sites.
 *
 * This answers, with evidence rather than inference:
 *   1. How many times is each product card rendered?
 *   2. Are identical products rendered repeatedly?
 *   3. Which callers overlap?
 *   4. Could later passes patch existing cards instead of rebuilding them?
 *
 * ── Render reason without touching production code ──────────────────────────
 * The caller's line number identifies the purpose, so the reason is DERIVED from
 * the stack rather than added as a parameter. No production change is needed to
 * get the same insight, which matters because this is a measurement step.
 *
 *   node scripts/perf-render-audit.js --page home
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PERF_PORT || '8295', 10);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const PAGE = arg('page', 'home');
const AS_JSON = process.argv.includes('--json');

const ROUTES = { home: '/', category: '/category?cat=electronics', product: '/product' };
const CPU_THROTTLE = 4;
const NET = { latency: 40, downloadThroughput: 10240 * 128, uploadThroughput: 3072 * 128 };
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.woff2':'font/woff2' };

/* script.js call sites → purpose. Derived from reading each site's context. */
const REASONS = {
  402:  'initial_load',
  501:  'distance_update',
  623:  'city_selected',
  1068: 'trending_filter',
  1095: 'category_all',
  1115: 'category_filter',
  1135: 'search_cleared',
  1148: 'search_filter',
  1304: 'wishlist_toggle',
};

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

/* Installed before any page script. displayProducts is a top-level function
   declaration, so it cannot be intercepted by defineProperty before script.js
   parses — the declaration would overwrite the accessor. Polling from the very
   first microtask wraps it within a few ms, and the first real call does not
   arrive until ~11.7s, so nothing is missed. */
const INSTRUMENT = `
(function () {
  window.__render = { calls: [], wrappedAt: null };

  function callerLine() {
    var st = (new Error()).stack || '';
    var lines = st.split('\\n');
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].indexOf('__render') > -1 || lines[i].indexOf('wrapped') > -1) continue;
      var m = lines[i].match(/script\\.js:(\\d+):/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  function countNodes(el) { return el ? el.getElementsByTagName('*').length : 0; }

  function idsOf(list) {
    try {
      return (list || []).map(function (p) {
        return (p && (p.id || p._id || p.productId || p.sku || p.name)) || '?';
      });
    } catch (e) { return []; }
  }

  function wrap() {
    if (typeof window.displayProducts !== 'function' || window.displayProducts.__wrapped) return false;
    var orig = window.displayProducts;
    var wrapped = function (list) {
      var c = document.getElementById('productsContainer');
      var before = countNodes(c);
      var t = Math.round(performance.now());
      var line = callerLine();
      var ids = idsOf(list);
      var r = orig.apply(this, arguments);
      /* innerHTML replacement is synchronous, so the delta is readable now.
         The idle-batched remainder lands later and is captured by the next call
         or the final snapshot. */
      var after = countNodes(document.getElementById('productsContainer'));
      window.__render.calls.push({
        t: t, line: line, count: (list || []).length, ids: ids,
        nodesBefore: before, nodesAfter: after, created: Math.max(0, after - before),
        replaced: before > 0
      });
      return r;
    };
    wrapped.__wrapped = true;
    window.displayProducts = wrapped;
    window.__render.wrappedAt = Math.round(performance.now());
    return true;
  }

  if (!wrap()) {
    var iv = setInterval(function () { if (wrap()) clearInterval(iv); }, 5);
    setTimeout(function () { clearInterval(iv); }, 40000);
  }
})();
`;

(async () => {
  const server = await serve(REPO, PORT);
  const browser = await chromium.launch();
  try {
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
    await page.waitForTimeout(12000);   /* well past the 11.7s first render */
    const data = await page.evaluate(() => window.__render);

    const calls = data.calls || [];
    /* How many times was each product rendered? */
    const perProduct = new Map();
    calls.forEach(c => c.ids.forEach(id => perProduct.set(id, (perProduct.get(id) || 0) + 1)));
    const renderCounts = [...perProduct.values()];
    const maxRenders = renderCounts.length ? Math.max(...renderCounts) : 0;
    const repeated = [...perProduct.entries()].filter(([, n]) => n > 1);

    const out = {
      page: PAGE, at: new Date().toISOString(), wrappedAt: data.wrappedAt,
      totalCalls: calls.length,
      totalNodesCreated: calls.reduce((s, c) => s + c.created, 0),
      distinctProducts: perProduct.size,
      productsRenderedMoreThanOnce: repeated.length,
      maxRendersOfOneProduct: maxRenders,
      calls: calls.map(c => ({ ...c, reason: REASONS[c.line] || ('line ' + c.line) })),
    };

    if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
    else {
      console.log(`\n══ displayProducts render audit — ${PAGE} ══`);
      console.log(`wrapper installed at ${data.wrappedAt}ms · ${calls.length} calls captured\n`);
      if (!calls.length) {
        console.log('  No calls captured. Either the feed never rendered in this window,');
        console.log('  or the wrapper installed too late — check wrappedAt above.');
      } else {
        console.log('   t(ms)  reason              n   ids(sample)          nodes  action');
        calls.forEach(c => {
          console.log('  ' + String(c.t).padStart(6) + '  ' +
            (REASONS[c.line] || ('line ' + c.line)).padEnd(18) +
            String(c.count).padStart(3) + '   ' +
            (c.ids.slice(0, 3).join(',') || '-').slice(0, 20).padEnd(20) +
            String(c.created).padStart(5) + '  ' + (c.replaced ? 'FULL REBUILD' : 'first render'));
        });
        console.log(`\n  distinct products seen        : ${out.distinctProducts}`);
        console.log(`  rendered more than once       : ${out.productsRenderedMoreThanOnce}`);
        console.log(`  max renders of a single product: ${out.maxRendersOfOneProduct}`);
        console.log(`  total nodes created           : ${out.totalNodesCreated}`);
      }
    }
    fs.writeFileSync(path.resolve(REPO, `docs/perf-render-audit-${PAGE}.json`), JSON.stringify(out, null, 2));
    if (!AS_JSON) console.log(`\nSaved: docs/perf-render-audit-${PAGE}.json`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
