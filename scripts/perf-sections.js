'use strict';
/**
 * Section construction vs visibility — Phase 1 instrumentation.
 *
 * Answers, per homepage section:
 *   • when DOM construction began and completed
 *   • how many nodes it built
 *   • whether it ever entered the viewport
 *   • how long after construction it became visible (if ever)
 *   • NODES NEVER SEEN — construction the session never benefited from
 *
 * The last one is the point. Deferring below-fold work is compelling in
 * proportion to how often it is never reached, and that is a property of the
 * session, not of the layout. A grid that every user scrolls to is merely
 * mistimed; a grid most users never see is wasted outright.
 *
 * Two scenarios are run:
 *   no-scroll   the user lands, waits, leaves. The common bounce.
 *   full-scroll the user scrolls to the bottom. The best case for eager build.
 *
 * Counting only — no production code is changed by this script.
 *
 *   node scripts/perf-sections.js --page home
 *   node scripts/perf-sections.js --page home --json
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PERF_PORT || '8297', 10);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const PAGE = arg('page', 'home');
const AS_JSON = process.argv.includes('--json');
const SETTLE = parseInt(arg('settle', '14000'), 10);

const ROUTES = { home: '/', category: '/category?cat=electronics' };
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

/* Attribute each mutation to the nearest ancestor section, and observe when each
   section first intersects the viewport. */
const INSTRUMENT = `
(function () {
  window.__sec = { build: {}, seen: {}, order: [] };

  function sectionOf(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while (el && el !== document.body) {
      if (el.id) return el.id;
      el = el.parentElement;
    }
    return '(body)';
  }

  function note(target, nodes) {
    var id = sectionOf(target);
    var b = window.__sec.build[id];
    if (!b) {
      b = window.__sec.build[id] = { nodes: 0, calls: 0, start: Math.round(performance.now()), end: 0 };
      window.__sec.order.push(id);
    }
    b.nodes += nodes; b.calls++; b.end = Math.round(performance.now());
  }

  var d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (d && d.set) {
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) {
        var approx = typeof v === 'string' ? (v.match(/</g) || []).length : 1;
        if (approx > 0) note(this, approx);
        return d.set.call(this, v);
      }
    });
  }
  var ac = Node.prototype.appendChild;
  Node.prototype.appendChild = function (a) {
    var n = (a && a.nodeType === 11 && a.childNodes) ? a.childNodes.length : 1;
    note(this, n);
    return ac.apply(this, arguments);
  };

  /* Visibility. Observed on every element that has an id, so a section is
     matched to its construction record without a hard-coded list. */
  function observeAll() {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var id = e.target.id;
        if (!id || !e.isIntersecting) return;
        if (window.__sec.seen[id] == null) window.__sec.seen[id] = Math.round(performance.now());
      });
    }, { threshold: 0.01 });
    document.querySelectorAll('[id]').forEach(function (el) { try { io.observe(el); } catch (x) {} });
    window.__sec._io = io;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeAll);
  else observeAll();
  /* Re-observe late-created sections. */
  setInterval(observeAll, 2000);
})();
`;

async function run(browser, base, scroll) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NET });

  await page.goto(base + ROUTES[PAGE], { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(SETTLE);

  if (scroll) {
    /* Walk to the bottom the way a person would, giving lazy content a chance. */
    for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(500); }
    await page.waitForTimeout(2500);
  }

  const data = await page.evaluate(() => {
    const out = { build: window.__sec.build, seen: window.__sec.seen, viewportH: innerHeight,
                  docH: document.documentElement.scrollHeight, offsets: {} };
    Object.keys(window.__sec.build).forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        const r = el.getBoundingClientRect();
        out.offsets[id] = Math.round(r.top + scrollY);
      }
    });
    return out;
  });
  await ctx.close();
  return data;
}

(async () => {
  const server = await serve(REPO, PORT);
  const browser = await chromium.launch();
  try {
    const base = `http://localhost:${PORT}`;
    const noScroll = await run(browser, base, false);
    const scrolled = await run(browser, base, true);

    const rows = Object.entries(noScroll.build)
      .map(([id, b]) => ({
        id, nodes: b.nodes, calls: b.calls, start: b.start, end: b.end,
        offset: noScroll.offsets[id] != null ? noScroll.offsets[id] : null,
        seenNoScroll: noScroll.seen[id] != null,
        seenScrolled: scrolled.seen[id] != null,
      }))
      .filter(r => r.nodes >= 5)
      .sort((a, b) => b.nodes - a.nodes);

    const total = rows.reduce((s, r) => s + r.nodes, 0);
    const neverSeenNoScroll = rows.filter(r => !r.seenNoScroll);
    const wastedNoScroll = neverSeenNoScroll.reduce((s, r) => s + r.nodes, 0);
    const neverSeenEver = rows.filter(r => !r.seenScrolled);
    const wastedEver = neverSeenEver.reduce((s, r) => s + r.nodes, 0);

    const out = { page: PAGE, at: new Date().toISOString(),
      viewportH: noScroll.viewportH, docH: noScroll.docH,
      totalNodes: total,
      wastedIfNoScroll: wastedNoScroll,
      wastedPctIfNoScroll: total ? +(wastedNoScroll / total * 100).toFixed(1) : 0,
      wastedEvenIfScrolled: wastedEver, sections: rows };

    if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
    else {
      console.log(`\n══ Section construction vs visibility — ${PAGE} ══`);
      console.log(`viewport ${noScroll.viewportH}px · document ${noScroll.docH}px\n`);
      console.log('  nodes  calls  build(ms)      offset  seen?  seen if      section');
      console.log('                              from top  (land) scrolled');
      rows.slice(0, 18).forEach(r => {
        console.log('  ' + String(r.nodes).padStart(5) + String(r.calls).padStart(6) + '  ' +
          String(r.start + '-' + r.end).padEnd(13) +
          String(r.offset == null ? '-' : r.offset).padStart(7) + '   ' +
          (r.seenNoScroll ? ' YES ' : ' no  ') + '   ' + (r.seenScrolled ? 'YES' : 'NO ') + '      ' + r.id);
      });
      console.log(`\n  total nodes built                    : ${total}`);
      console.log(`  NEVER SEEN if the user does not scroll: ${wastedNoScroll}  (${out.wastedPctIfNoScroll}%)`);
      console.log(`  NEVER SEEN even after scrolling to end: ${wastedEver}`);
      console.log('\n  "Never seen" is the deferral case: work the session never benefited from.');
    }
    fs.writeFileSync(path.resolve(REPO, `docs/perf-sections-${PAGE}.json`), JSON.stringify(out, null, 2));
    if (!AS_JSON) console.log(`\nSaved: docs/perf-sections-${PAGE}.json`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
