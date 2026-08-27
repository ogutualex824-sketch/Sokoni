#!/usr/bin/env node
/* Font Awesome is served from SOKONI, not from cdnjs.
 *
 * WHY THIS SUITE EXISTS
 * The stylesheet is render-blocking in <head> on 104 pages. While it came from
 * cdnjs, every one of those pages had a third-party origin sitting in front of
 * its first paint: a cdnjs outage or a slow handshake stalled the page before a
 * single pixel appeared. Measured 2026-08-27, cdnjs returned 503 under load.
 *
 * A grep for the CDN URL is not enough on its own — a detector that matches
 * nothing looks identical to a clean tree. Section A therefore carries a
 * NEGATIVE CONTROL that must find a planted string, and aborts if it cannot.
 *
 *   node scripts/test-fontawesome-selfhost.js
 */
'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const VER  = '6.5.1';
const DIR  = path.join('assets', 'vendor', 'fontawesome', VER);
const HREF = '/assets/vendor/fontawesome/' + VER + '/css/all.min.css';
const CDN  = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/';

/* The exact bytes cdnjs publishes for 6.5.1. Pinned so a future edit to the
   vendored copy — or a silent swap for a different build — is caught here. */
const CSS_SHA256 = 'c22cfb6520a7fdbb738632834019acf47c78b1279462c0eb4cb83bae83ecb5a7';

/* Walk the tree once; skip what is not shipped. */
const SKIP = new Set(['node_modules', '.git', 'functions', 'docs', 'scripts', 'tests']);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(d, e.name)); continue; }
    if (/\.(html|js|css)$/i.test(e.name)) files.push(path.join(d, e.name));
  }
})(ROOT);

const readRel = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ══ A. The CDN reference is gone — proved with a control ══════════════════ */
console.log('\nA. No page loads Font Awesome from cdnjs\n');
{
  const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes(CDN));
  ck('no file references the cdnjs Font Awesome URL', hits.length === 0,
     hits.slice(0, 3).map((f) => path.relative(ROOT, f)).join(', ') || 'clean');

  /* NEGATIVE CONTROL: the same scan, for a string that certainly IS present.
     If this finds nothing the scanner is broken and the check above is void. */
  const control = files.filter((f) => fs.readFileSync(f, 'utf8').includes(HREF));
  ck('  ↳ control: the scanner can find the LOCAL href', control.length > 0,
     control.length + ' files');
  if (control.length === 0) {
    console.error('\n  ABORT — the scanner matched nothing at all; check A proves nothing.\n');
    process.exit(1);
  }

  /* No page silently LOST its icons: the replacement preserved every ref. */
  ck('every page that had Font Awesome still has it', control.length >= 104,
     control.length + ' files (was 104)');
}

/* ══ B. The vendored copy is the real one ══════════════════════════════════ */
console.log('\nB. The vendored bytes are Font Awesome ' + VER + '\n');
{
  const cssPath = path.join(DIR, 'css', 'all.min.css');
  const exists  = fs.existsSync(path.join(ROOT, cssPath));
  ck('the stylesheet is vendored', exists, cssPath);

  if (exists) {
    const buf = fs.readFileSync(path.join(ROOT, cssPath));
    const h   = crypto.createHash('sha256').update(buf).digest('hex');
    ck('  ...byte-identical to the published ' + VER + ' build', h === CSS_SHA256, h.slice(0, 16));

    /* Every font the stylesheet asks for must be on disk, or icons render as
       empty boxes — a failure no HTTP check would catch. */
    const urls = [...new Set((buf.toString('utf8').match(/url\(([^)]+)\)/g) || [])
      .map((u) => u.slice(4, -1).replace(/["']/g, '').split(/[?#]/)[0]))];
    ck('the stylesheet asks for font files at all', urls.length > 0, urls.length + ' urls');
    const missing = urls.filter((u) => !fs.existsSync(path.join(ROOT, DIR, 'css', u)));
    ck('  ...every one of them resolves on disk', missing.length === 0,
       missing.join(', ') || urls.length + '/' + urls.length);
  }
}

/* ══ C. The reference works from any page depth ════════════════════════════ */
console.log('\nC. The href is root-absolute\n');
{
  ck('the href starts at /', HREF.startsWith('/'));
  const relRef = files.filter((f) => /["']\.{0,2}\/?assets\/vendor\/fontawesome/.test(fs.readFileSync(f, 'utf8'))
                                  && !fs.readFileSync(f, 'utf8').includes(HREF));
  ck('  ...no page uses a relative variant that would 404 under /shop/',
     relRef.length === 0, relRef.slice(0, 3).map((f) => path.relative(ROOT, f)).join(', ') || 'none');
}

/* ══ D. The policy matches reality ═════════════════════════════════════════ */
console.log('\nD. CSP narrowed to what is actually loaded\n');
{
  const fb  = readRel('firebase.json');
  const csp = (JSON.parse(fb).hosting.headers || [])
    .flatMap((g) => g.headers || [])
    .filter((h) => String(h.key).toLowerCase() === 'content-security-policy')
    .map((h) => h.value)[0] || '';
  ck('a CSP header is present', csp.length > 0);
  const dir = (name) => (csp.split(';').find((d) => d.trim().startsWith(name)) || '').trim();
  const CDNO = 'https://cdnjs.cloudflare.com';

  ck('style-src no longer trusts cdnjs', !dir('style-src').includes(CDNO), dir('style-src'));
  ck('font-src no longer trusts cdnjs',  !dir('font-src').includes(CDNO),  dir('font-src'));
  /* script-src MUST keep it — pdf.js and qrcodejs still load from cdnjs, and
     narrowing it here would break POS QR printing and the AI PDF reader. */
  ck('script-src still trusts cdnjs (pdf.js, qrcodejs)', dir('script-src').includes(CDNO));
  ck('  ...and those scripts genuinely still point there',
     files.some((f) => /cdnjs\.cloudflare\.com\/ajax\/libs\/(qrcodejs|pdf\.js)/.test(fs.readFileSync(f, 'utf8'))));
}

/* ══ E. Caching ════════════════════════════════════════════════════════════ */
console.log('\nE. The service worker will cache the fonts\n');
{
  const sw = readRel('service-worker.js');
  ck('fonts are Cache First', /\["woff","woff2","ttf","eot"\]\.includes\(ext\)/.test(sw));
  ck('  ...into the static cache', /cacheFirst\(request, STATIC_CACHE\)/.test(sw));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
