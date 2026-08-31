#!/usr/bin/env node
/**
 * MERCHANT ROUTES — no unintended full-viewport blocking layer.
 *
 *   node scripts/test-merchant-route-overlays.js
 *
 * Reported repeatedly: the module is visible but a dark layer sits over it and swallows
 * taps — on Fulfilment, Verification, POS Setup and others at once. Simultaneous failure
 * across unrelated modules points at a SHARED lifecycle, not each page, so this mounts
 * EVERY route and asserts that nothing full-viewport is left intercepting pointer events.
 *
 * WHAT COUNTS AS A BLOCKER, and why each clause is there:
 *   · fixed/absolute, visible, opacity > 0        — a layer that is actually painted
 *   · >= 80% of the width AND >= 60% of the height — full-viewport, not a toast or sheet
 *   · pointer-events !== 'none'                    — it INTERCEPTS; this is the difference
 *                                                    between a legitimate transparent
 *                                                    consent sheet and a trap
 *
 * A legitimate overlay is not a defect. The consent bottom sheet the shell shows is
 * pointer-events:none over a transparent background — visible, completable, and it does
 * NOT block. An orphaned scrim has no actionable UI and blocks everything. This suite
 * separates those two by behaviour rather than by name.
 *
 * THE PROBE IS CONTROLLED. It injects a real scrim and requires that it be caught, and
 * injects a harmless transparent overlay and requires that it be IGNORED. Without both,
 * "no blockers found" on every route would be indistinguishable from a broken probe —
 * which is exactly how a uniform pass lies.
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0, env = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

const ROUTES = ['dashboard', 'fulfilment', 'verification', 'pos-setup', 'deliveries', 'plan',
                'returns', 'stories', 'customers', 'staff', 'revenue', 'reports', 'shop', 'pos'];

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* The probe, as source, so it can run inside the page and inside each frame. */
const PROBE = `(function () {
  var vw = innerWidth, vh = innerHeight, out = [];
  var all = document.querySelectorAll('body *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i], s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'absolute') continue;
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    if (parseFloat(s.opacity || '1') === 0) continue;
    if (s.pointerEvents === 'none') continue;
    var r = el.getBoundingClientRect();
    if (r.width < vw * 0.8 || r.height < vh * 0.6) continue;
    out.push(((el.id || el.className || el.tagName) + '').slice(0, 34) + ' z=' + s.zIndex);
  }
  return out;
})()`;

(async () => {
  console.log(NL + 'MERCHANT ROUTES — BLOCKING OVERLAYS' + NL + '='.repeat(62));

  let webkit;
  try { ({ webkit } = require('playwright')); }
  catch (_) {
    console.log(NL + '  ENV  playwright is not installed — cannot mount routes.');
    console.log('  ENV  This suite proves a RUNTIME property; it must not pass statically.');
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  const server = http.createServer((rq, rs) => {
    let name = (rq.url.split('?')[0] || '/').replace(/^\//, '') || 'index.html';
    if (name === 'merchant-v2') name = 'merchant-v2.html';
    if (!path.extname(name)) name += '.html';
    fs.readFile(path.join(ROOT, name), (e, d) => {
      if (e) { rs.writeHead(404); return rs.end('nf'); }
      rs.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'text/plain' });
      rs.end(d);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;

  let br;
  try { br = await webkit.launch(); }
  catch (e) {
    console.log(NL + '  ENV  browser could not launch: ' + (e && e.message || e).slice(0, 70));
    server.close();
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  try {
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(base + '/merchant-v2', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);          /* past the 1.5s consent mount */

    head('1 · the probe must be able to SEE a blocker');
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'INJECTED_SCRIM';
      d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.66);z-index:300001;pointer-events:auto';
      document.body.appendChild(d);
    });
    await page.waitForTimeout(200);
    const caught = await page.evaluate(PROBE);
    ck('CONTROL an injected full-screen scrim IS caught',
       caught.some((x) => x.indexOf('INJECTED_SCRIM') > -1), caught.join(' | '));

    await page.evaluate(() => {
      const s = document.getElementById('INJECTED_SCRIM'); if (s) s.remove();
      const d = document.createElement('div');
      d.id = 'INJECTED_HARMLESS';
      d.style.cssText = 'position:fixed;inset:0;background:transparent;z-index:9;pointer-events:none';
      document.body.appendChild(d);
    });
    await page.waitForTimeout(200);
    const ignored = await page.evaluate(PROBE);
    ck('CONTROL a pointer-events:none overlay is IGNORED', ignored.length === 0,
       'a legitimate consent sheet must not be reported as a trap');
    await page.evaluate(() => {
      const h = document.getElementById('INJECTED_HARMLESS'); if (h) h.remove();
    });

    head('2 · every route, mounted');
    /* THE CONTRACT IS "MUST NOT STRAND", NOT "MUST BE INSTANT". .frame-load legitimately
       covers the panel WHILE a module loads; the defect was that it never came off. The
       bounded reveal fires at 8s, so probing at 1.8s failed a slow frame that was behaving
       correctly — which it did, intermittently, on stories. Poll past the reveal window
       and fail only if the cover SURVIVES it. */
    const REVEAL_MS = 8000, GRACE = 2500;
    for (const r of ROUTES) {
      await page.evaluate((id) => { location.hash = id; }, r);
      let found = [], waited = 0;
      while (waited <= REVEAL_MS + GRACE) {
        await page.waitForTimeout(700); waited += 700;
        const shell = await page.evaluate(PROBE);
        let frame = [];
        const frames = page.frames().filter((f) => f !== page.mainFrame());
        if (frames.length) {
          try { frame = await frames[frames.length - 1].evaluate(PROBE); } catch (_) { frame = []; }
        }
        found = shell.concat(frame);
        if (found.length === 0) break;          /* revealed — done */
      }
      ck(r + ': no full-viewport blocker survives the reveal window',
         found.length === 0, found.join(' | ') || 'clear in ' + waited + 'ms');
    }
  } finally {
    try { await br.close(); } catch (_) {}
    server.close();
  }

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
