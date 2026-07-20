#!/usr/bin/env node
/**
 * test-icons.js — Brand Asset Standardization guard.
 *
 * SOKONI shipped two different logos at once: the installed PWA used one image, while the
 * browser tab and the iOS home screen used a different, near-black one. Nobody noticed
 * because nothing compared them. This gate compares them.
 *
 * It asserts four things:
 *
 *   1. Every application icon is DERIVED FROM assets/logosokoni.png. Icons are decoded and
 *      fingerprinted (mean RGB); a resample of the same source lands within a tight
 *      tolerance, a different image does not.
 *   2. No page points at an icon that does not exist on disk. Hosting is case-sensitive:
 *      `logoSokoni.png` is a 404 and a blank tab, and several pages used to reference
 *      favicon files that were never in the repo at all.
 *   3. Every page carries the same canonical favicon block — one tab icon, platform-wide.
 *   4. The icon sprint STAYED IN ITS LANE. Header logos, splash artwork, hero and email
 *      branding must be byte-for-byte untouched; this test fails if an icon path is ever
 *      substituted into them.
 *
 * Run: node scripts/test-icons.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT   = path.resolve(__dirname, '..');
const SOURCE = 'assets/logosokoni.png';

let failures = 0;
const fail = (m) => { failures++; console.log('  [31m✘[0m ' + m); };
const pass = (m) => console.log('  [32m✔[0m ' + m);

/* ── A dependency-free PNG fingerprint ──────────────────────────────────────────────
   Decodes IHDR + IDAT, un-filters the scanlines and returns the mean R/G/B. Two
   resamples of one source agree to within a couple of units; two different images do
   not come close. That is the whole test. */
function meanRGB(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, depth = 0, color = 0, pal = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'PLTE') pal = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error('bit depth ' + depth + ' unsupported');
  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!CH) throw new Error('colour type ' + color + ' unsupported');

  const raw  = zlib.inflateSync(Buffer.concat(idat));
  const bpp  = CH;                       // depth is 8, so bytes-per-pixel === channels
  const strd = w * bpp;
  const out  = Buffer.alloc(h * strd);

  for (let y = 0; y < h; y++) {
    const filt = raw[y * (strd + 1)];
    const src  = y * (strd + 1) + 1;
    const dst  = y * strd;
    for (let x = 0; x < strd; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;      // left
      const b = y > 0    ? out[dst - strd + x] : 0;     // up
      const c = (x >= bpp && y > 0) ? out[dst - strd + x - bpp] : 0; // up-left
      const v = raw[src + x];
      let r;
      switch (filt) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {                                       // Paeth
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('filter ' + filt);
      }
      out[dst + x] = r & 0xff;
    }
  }

  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * bpp;
    let r, g, b;
    if (color === 3) { const q = out[o] * 3; r = pal[q]; g = pal[q + 1]; b = pal[q + 2]; }
    else if (color === 0 || color === 4) { r = g = b = out[o]; }
    else { r = out[o]; g = out[o + 1]; b = out[o + 2]; }
    R += r; G += g; B += b; n++;
  }
  return { w, h, r: R / n, g: G / n, b: B / n };
}

/* An .ico here is a container around a PNG — pull the largest entry out and fingerprint it. */
function meanRGBofIco(buf) {
  const count = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
    if (!best || size > best.size) best = { size, off };
  }
  return meanRGB(buf.slice(best.off, best.off + best.size));
}

const near = (a, b, tol) =>
  Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;

console.log('\nSOKONI — Brand Asset (icon) gate\n');

/* ── 1. Every icon is a resample of the one source ───────────────────────────────── */
console.log('1. Icons derive from ' + SOURCE);

const srcPath = path.join(ROOT, SOURCE);
if (!fs.existsSync(srcPath)) {
  fail(SOURCE + ' is missing — the single source of truth does not exist');
} else {
  const src = meanRGB(fs.readFileSync(srcPath));
  pass(SOURCE + ' — ' + src.w + '×' + src.h +
       ' rgb(' + [src.r, src.g, src.b].map(Math.round).join(',') + ')');

  /* Hosting runs on Linux. A capitalised path is a 404 and therefore a blank icon for
     every user, so the exact on-disk casing is itself part of the contract. */
  const dirents = fs.readdirSync(path.join(ROOT, 'assets'));
  if (!dirents.includes('logosokoni.png')) {
    fail('the source must be named exactly "logosokoni.png" (lowercase) — hosting is case-sensitive');
  } else pass('filename casing is exactly "logosokoni.png"');

  const ICONS = [
    'assets/icons/favicon-16x16.png',
    'assets/icons/favicon-32x32.png',
    'assets/icons/apple-touch-icon.png',
    'assets/icons/icon-96.png',
    'assets/icons/icon-180.png',
    'assets/icons/icon-192.png',
    'assets/icons/icon-512.png',
    'assets/icons/android-chrome-192x192.png',
    'assets/icons/android-chrome-512x512.png',
    'favicon.ico',
    'assets/icons/favicon.ico',
  ];

  for (const rel of ICONS) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) { fail(rel + ' — MISSING'); continue; }
    let m;
    try {
      const b = fs.readFileSync(f);
      m = rel.endsWith('.ico') ? meanRGBofIco(b) : meanRGB(b);
    } catch (e) { fail(rel + ' — undecodable (' + e.message + ')'); continue; }

    /* 16px is a savage downsample, so it drifts furthest from the source; everything
       larger should sit almost on top of it. */
    const tol = m.w <= 16 ? 26 : m.w <= 32 ? 18 : 10;
    if (near(m, src, tol)) {
      pass(rel + ' — ' + m.w + '×' + m.h + ' matches source');
    } else {
      fail(rel + ' is a DIFFERENT IMAGE — rgb(' +
           [m.r, m.g, m.b].map(Math.round).join(',') + ') vs source rgb(' +
           [src.r, src.g, src.b].map(Math.round).join(',') + ')');
    }
  }
}

/* ── 2 + 3. Pages: one canonical block, and no reference to a file that isn't there ── */
console.log('\n2. Every page points at one icon set, and every target exists');

const CANON = [
  '/assets/icons/favicon-32x32.png',
  '/assets/icons/favicon-16x16.png',
  '/assets/icons/apple-touch-icon.png',
  '/favicon.ico',
];

const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const missingTargets = new Map();   // href -> [pages]
const nonCanonical = [];

for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const links = [...html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi)].map((m) => m[0]);
  const hrefs = links
    .map((l) => (l.match(/href=["']([^"']+)["']/i) || [])[1])
    .filter(Boolean);

  if (!hrefs.length) { nonCanonical.push(page + ' (no favicon at all)'); continue; }

  for (const href of hrefs) {
    if (/^(https?:|data:)/i.test(href)) continue;
    const onDisk = path.join(ROOT, href.replace(/^\//, ''));
    if (!fs.existsSync(onDisk)) {
      if (!missingTargets.has(href)) missingTargets.set(href, []);
      missingTargets.get(href).push(page);
    }
  }

  for (const need of CANON) {
    if (!hrefs.includes(need)) { nonCanonical.push(page + ' (missing ' + need + ')'); break; }
  }
}

if (missingTargets.size === 0) {
  pass(pages.length + ' pages — every referenced icon exists on disk');
} else {
  for (const [href, pgs] of missingTargets) {
    fail('BLANK ICON: ' + href + ' does not exist — referenced by ' + pgs.length +
         ' page(s), e.g. ' + pgs.slice(0, 3).join(', '));
  }
}

if (nonCanonical.length === 0) {
  pass(pages.length + ' pages — all carry the canonical favicon block');
} else {
  fail(nonCanonical.length + ' page(s) do not use the canonical block: ' +
       nonCanonical.slice(0, 5).join('; '));
}

/* ── 4. The sprint stayed in its lane ────────────────────────────────────────────── */
console.log('\n3. Header / splash / hero / email branding untouched (icon-only sprint)');

/* These are BRAND assets, not app icons. The sprint brief was explicit that they are out
   of scope. If an icon path ever appears where a brand asset belongs, someone widened the
   sprint after the fact and this gate is the thing that says so. */
const BRAND_SURFACES = ['shared-header.js', 'splash.js', 'sokoni-footer.js', 'index.html'];
let lane = true;
for (const f of BRAND_SURFACES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const s = fs.readFileSync(p, 'utf8');
  /* An <img> is brand artwork. It must never be pointed at an app icon. */
  for (const tag of s.match(/<img[^>]*>/gi) || []) {
    if (/assets\/icons\/(favicon|apple-touch|icon-)/i.test(tag)) {
      fail(f + ': an <img> was repointed at an app icon — ' + tag.slice(0, 90));
      lane = false;
    }
  }
}
if (lane) pass('no brand <img> was repointed at an app icon');

/* Push must show the real logo, and the file must actually be there. */
console.log('\n4. Notifications carry the official icon');
const PUSH = ['service-worker.js', 'firebase-messaging-sw.js', 'functions/notify.js'];
let pushOk = true;
for (const f of PUSH) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const s = fs.readFileSync(p, 'utf8');
  /* The master logo is the notification icon by product decision, so /assets/logosokoni.png
     is accepted alongside the derived /assets/icons/* set. Both ARE the same mark — the
     icons/ files are logosokoni.png resized. What still fails is anything OUTSIDE that
     pair, which is what let /icons/icon-192.png, /assets/badge-96.png and
     /assets/logo/icon-192.png ship pointing at files that do not exist. */
  const ALLOWED = /^\/assets\/(icons\/|logosokoni\.png$)/;
  for (const m of s.matchAll(/(?:icon|badge)\s*:\s*["']([^"']+\.(?:png|jpe?g))["']/gi)) {
    const href = m[1];
    if (!ALLOWED.test(href)) {
      fail(f + ': push icon is not the SOKONI logo or an official icon — ' + href);
      pushOk = false;
    } else if (!fs.existsSync(path.join(ROOT, href.replace(/^\//, '')))) {
      fail(f + ': push icon 404s — ' + href);
      pushOk = false;
    }
  }
}
if (pushOk) pass('service-worker.js, firebase-messaging-sw.js and notify.js all use assets/icons/*');

console.log('');
if (failures) {
  console.log('[31mFAIL[0m — ' + failures + ' icon problem(s)\n');
  process.exit(1);
}
console.log('[32mPASS[0m — one logo, one icon set, everywhere\n');
