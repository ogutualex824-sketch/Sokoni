#!/usr/bin/env node
/* ============================================================================
   scripts/test-integrations-browser.js
   ============================================================================
   The BROWSER-RENDER certification the other console suites explicitly do not
   provide. scripts/test-integrations-console.js mounts the module in a minimal
   DOM and proves the HTML it emits; it says nothing about how that HTML LOOKS,
   and has always said so.

   This drives scripts/harness-integrations.html — which already existed for
   exactly this purpose — in a real Chromium at real viewport sizes, so the
   module injects its own real stylesheet and lays out for real.

   WHAT IT MEASURES, AND WHY FROM THE DOM
   ---------------------------------------
   Every assertion reads geometry: getBoundingClientRect, scrollWidth,
   clientWidth, computed styles. Asserting on markup here would just repeat the
   in-memory suite in a slower process. The questions that only a browser can
   answer are: does anything overflow, does anything clip, and does the table
   scroll INSIDE its container rather than dragging the page sideways.

   RESOURCE DISCIPLINE
   --------------------
   One browser, one context, closed in a finally. This machine has ~6 GB of
   headroom and a documented history of orphaned browser processes exhausting
   commit, so the suite refuses to start if commit is already high, and never
   leaves a process behind.

   Scope: the harness page, not the authenticated console. admin-os.html and
   super-admin.html sit behind Firebase Auth and App Check, which cannot be
   satisfied headlessly.
   ============================================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const sec = (s) => console.log('\n' + s + '\n' + '-'.repeat(s.length));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml' };

function freePort (p) {
  return new Promise((r) => {
    const s = net.createServer();
    s.once('error', () => r(false));
    s.once('listening', () => s.close(() => r(true)));
    s.listen(p, '127.0.0.1');
  });
}

/* Serves the repository read-only over loopback. Deliberately minimal and
   deliberately NOT a dependency: a static server is ten lines, and the harness
   only needs GET. Path traversal is refused rather than sanitised. */
function serve (port) {
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(String(req.url).split('?')[0]);
    if (rel === '/') rel = '/scripts/harness-integrations.html';
    const abs = path.join(ROOT, rel);
    if (!path.resolve(abs).startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
    fs.readFile(abs, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

(async function main () {
  /* ── RESOURCE GUARD ───────────────────────────────────────────────────── */
  const os = require('os');
  /* AVAILABLE PHYSICAL, not commit headroom. Measured on this machine:
     commit sat at 76% with ~6 GB free, which looks comfortable — but that
     headroom is PAGEFILE. Physical was 5.9 GB total with 0.39 GB available, and
     launching Chromium into that thrashes rather than fails, which is worse:
     a slow suite that eventually passes teaches nothing and takes the machine
     down with it. */
  const freeGB = os.freemem() / 1024 / 1024 / 1024;
  console.log('\n  free memory: ' + freeGB.toFixed(1) + ' GB');
  if (freeGB < 0.8) {
    console.error('  REFUSING to launch a browser with under 0.8 GB free — this machine has a');
    console.error('  history of orphaned browser processes exhausting commit.\n');
    process.exit(2);
  }

  let port = null;
  for (const p of [8130, 8131, 8132, 8133, 8134]) {
    /* eslint-disable no-await-in-loop */
    if (await freePort(p)) { port = p; break; }
  }
  if (!port) { console.error('  no free port in 8130-8134'); process.exit(2); }

  const srv = await serve(port);
  const url = 'http://127.0.0.1:' + port + '/scripts/harness-integrations.html';
  console.log('  serving ' + url + '\n');

  const { chromium } = require('playwright');
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });

    /* ══ DESKTOP ══════════════════════════════════════════════════════════ */
    sec('1 · DESKTOP — 1440 x 900');
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const d = await desk.newPage();
    const errors = [];
    d.on('pageerror', (e) => errors.push(String(e.message)));
    d.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await d.goto(url, { waitUntil: 'networkidle' });
    await d.waitForSelector('.sic-itable tbody tr', { timeout: 15000 });

    await T('the page renders with no JavaScript errors', () => {
      eq(errors.length, 0, 'errors: ' + errors.slice(0, 3).join(' | ') + ' — ');
    });

    await T('one row per catalogue entry, counted in the DOM', async () => {
      const n = await d.locator('.sic-itable tbody tr').count();
      const catN = await d.evaluate(() => window.SokoniIntegrationCatalogue.integrations.length);
      eq(n, catN, 'rows vs catalogue: ');
      ok(catN >= 60, 'the catalogue should be at least 60 by now, got ' + catN);
    });

    await T('the headline tiles are laid out side by side, not stacked or overlapping', async () => {
      const boxes = await d.locator('.sic-tile').evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
      ok(boxes.length >= 4, 'expected 4 tiles, got ' + boxes.length);
      ok(boxes.every((b) => b.w > 80 && b.h > 40), 'a tile collapsed: ' + JSON.stringify(boxes));
      /* Same row at desktop width. */
      const ys = new Set(boxes.map((b) => Math.round(b.y)));
      eq(ys.size, 1, 'tiles should share one row at 1440px, found ' + ys.size + ' rows: ');
    });

    await T('NOTHING overflows the page horizontally', async () => {
      const o = await d.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        win: window.innerWidth,
      }));
      ok(o.doc <= o.win + 1, 'page scrolls sideways: scrollWidth ' + o.doc + ' > innerWidth ' + o.win);
    });

    await T('the category column renders a chip for every row', async () => {
      const rows = await d.locator('.sic-itable tbody tr').count();
      const chips = await d.locator('.sic-itable tbody tr td:nth-child(2) .sic-chip').count();
      eq(chips, rows, 'category chips vs rows: ');
    });

    await T('unknown Environment renders an em-dash, and is visible', async () => {
      const dashes = await d.locator('.sic-itable tbody tr td:nth-child(3) .sic-none').count();
      const rows = await d.locator('.sic-itable tbody tr').count();
      eq(dashes, rows, 'every environment cell should be neutral: ');
      const txt = await d.locator('.sic-itable tbody tr td:nth-child(3) .sic-none').first().textContent();
      eq(txt.trim(), '—', '');
      /* Visible, not merely present: opacity .65 must still paint. */
      const vis = await d.locator('.sic-itable tbody tr td:nth-child(3) .sic-none').first().isVisible();
      ok(vis, 'the em-dash is not visible');
    });

    await T('OSRM and Google Charts rows carry their operator note, unclipped', async () => {
      for (const id of ['OSRM', 'Google Charts']) {
        const row = d.locator('.sic-itable tbody tr', { hasText: id }).first();
        ok(await row.count() > 0, id + ' row is missing');
        const note = row.locator('.sic-rownote').first();
        ok(await note.count() > 0, id + ' has no operator note');
        /* Clipping check: the rendered box must be tall enough for its text. */
        const m = await note.evaluate((e) => ({
          h: e.getBoundingClientRect().height, sh: e.scrollHeight, txt: e.textContent.length,
        }));
        ok(m.h >= m.sh - 1, id + ' note is clipped: box ' + m.h + ' < content ' + m.sh);
        ok(m.txt > 20, id + ' note is suspiciously short: ' + m.txt + ' chars');
      }
    });

    await T('the note is CLAMPED, so one long entry cannot dominate the table', async () => {
      const lens = await d.locator('.sic-rownote').evaluateAll((els) =>
        els.map((e) => e.textContent.trim().length));
      ok(lens.length > 0, 'no notes rendered');
      const longest = Math.max.apply(null, lens);
      ok(longest <= 140, 'a note rendered at ' + longest + ' chars; it should be clamped');
    });

    await T('rows are not absurdly tall — the table stays dense', async () => {
      const hs = await d.locator('.sic-itable tbody tr').evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect().height));
      const median = hs.slice().sort((a, b) => a - b)[Math.floor(hs.length / 2)];
      ok(median < 140, 'median row height ' + Math.round(median) + 'px is not a dense table');
      ok(median > 24, 'median row height ' + Math.round(median) + 'px — rows have collapsed');
      console.log('        median row ' + Math.round(median) + 'px · tallest ' +
        Math.round(Math.max.apply(null, hs)) + 'px');
    });

    await desk.close();

    /* ══ MOBILE ═══════════════════════════════════════════════════════════ */
    sec('2 · NARROW — 390 x 844');
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const m = await mob.newPage();
    const merr = [];
    m.on('pageerror', (e) => merr.push(String(e.message)));
    await m.goto(url, { waitUntil: 'networkidle' });
    await m.waitForSelector('.sic-itable tbody tr', { timeout: 15000 });

    await T('no JavaScript errors at narrow width', () => eq(merr.length, 0, merr.join(' | ')));

    await T('THE PAGE still does not scroll sideways', async () => {
      const o = await m.evaluate(() => ({
        doc: document.documentElement.scrollWidth, win: window.innerWidth,
      }));
      ok(o.doc <= o.win + 1,
        'the PAGE scrolls sideways at 390px: ' + o.doc + ' > ' + o.win +
        ' — the table must scroll inside its own container, not drag the page');
    });

    await T('the TABLE scrolls inside .sic-scroll instead', async () => {
      const s = await m.locator('.sic-scroll').first().evaluate((e) => ({
        sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX,
      }));
      ok(s.sw > s.cw, 'the table is not wider than its container, so nothing is being contained');
      ok(s.ox === 'auto' || s.ox === 'scroll',
        '.sic-scroll overflow-x is ' + s.ox + ' — the overflow has nowhere to go');
      console.log('        table ' + s.sw + 'px inside a ' + s.cw + 'px scroller (' + s.ox + ')');
    });

    await T('the tiles reflow to more than one row and stay legible', async () => {
      const boxes = await m.locator('.sic-tile').evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect()).map((r) => ({ y: Math.round(r.y), w: r.width, h: r.height })));
      ok(boxes.length >= 4, 'tiles missing at narrow width');
      ok(boxes.every((b) => b.w >= 100), 'a tile is too narrow to read: ' + JSON.stringify(boxes));
      ok(new Set(boxes.map((b) => b.y)).size > 1, 'tiles did not reflow at 390px');
    });

    await T('the tile VALUE is still readable, not shrunk away', async () => {
      const fs_ = await m.locator('.sic-tile-v').first().evaluate((e) =>
        parseFloat(getComputedStyle(e).fontSize));
      ok(fs_ >= 18, 'tile value font-size is ' + fs_ + 'px at narrow width');
    });

    await T('nothing is clipped out of the viewport on the left', async () => {
      const bad = await m.evaluate(() => {
        const out = [];
        document.querySelectorAll('.sic-tile, .sic-itable thead th').forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.x < -1) out.push(e.className + '@' + Math.round(r.x));
        });
        return out;
      });
      eq(bad.length, 0, 'elements pushed off the left edge: ' + bad.join(', ') + ' — ');
    });

    await mob.close();
  } finally {
    /* One browser, always closed — the orphan-process history on this machine
       is why this is a finally and not a happy-path close. */
    if (browser) await browser.close();
    srv.close();
  }

  console.log('\n' + '='.repeat(66));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(66));
  console.log('\n  PROVEN    a real Chromium render of the real module and the real');
  console.log('            catalogue at 1440x900 and 390x844: no page-level horizontal');
  console.log('            overflow at either width, the table scrolling inside its own');
  console.log('            container rather than dragging the page, tiles laid out and');
  console.log('            reflowing, the em-dash visible, and the OSRM and Google Charts');
  console.log('            notes present and unclipped.');
  console.log('  SCOPE     the harness page. admin-os.html and super-admin.html sit behind');
  console.log('            Firebase Auth and App Check, which cannot be satisfied');
  console.log('            headlessly, so the authenticated SHELL is NOT covered here.');
  console.log('  NOT DONE  no catalogue change, no data-model change, no deployment.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  SUITE CRASHED — a crash is not a pass\n', e); process.exit(1); });
