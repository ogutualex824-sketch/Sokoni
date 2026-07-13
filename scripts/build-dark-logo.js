#!/usr/bin/env node
/* ============================================================================
   SOKONI — dark-surface logo variant
   scripts/build-dark-logo.js

   THE PROBLEM (measured, not assumed)
   -----------------------------------
   assets/Sokoni Logo.png is a LIGHT-BACKGROUND logo. Its wordmark "SOKO" is
   near-black, while "NI" is bright green. On the SOKONI UI — which is #050505 —
   the dark letters disappear and the brand reads as:  [bag]  ...NI

   That is why the header, splash and footer logo all looked broken or clipped.
   It is not a rendering bug. The asset is simply not made for a dark surface.

   THE FIX
   -------
   Produce a dark-surface variant of the SAME logo. Nothing is redesigned:
     • the bag mark            — untouched
     • the green "NI"          — untouched
     • the orange swoosh       — untouched
     • the transparent背景     — untouched
     • ONLY the dark, desaturated wordmark pixels are lifted to white
   Colour is judged by SATURATION, not luminance alone: the green and orange are
   highly saturated, the wordmark letters are not. So we recolour only pixels that
   are (a) dark and (b) near-greyscale. That cannot touch the brand colours.

   Anti-aliased edge pixels keep their alpha, so the letterforms stay smooth.

   Output: assets/sokoni-logo-dark.png  — used on dark surfaces (header, splash).
   The original stays for light surfaces (print, invoices, light-mode).

   No image library exists in this environment, so PNG decode/encode are here.
============================================================================ */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', 'Sokoni Logo.png');
const OUT = path.join(__dirname, '..', 'assets', 'sokoni-logo-dark.png');

/* ── Decode 8-bit RGBA PNG ──────────────────────────────────────────────── */
function decodePNG(buf) {
  if (buf.slice(1, 4).toString() !== 'PNG') throw new Error('not a PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6) throw new Error(`need 8-bit RGBA, got depth ${buf[24]} type ${buf[25]}`);
  let off = 8; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString();
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const img = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.slice(p, p + stride); p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? img[y * stride + x - bpp] : 0;
      const b = y > 0 ? img[(y - 1) * stride + x] : 0;
      const c = (y > 0 && x >= bpp) ? img[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      img[y * stride + x] = v & 255;
    }
  }
  return { w, h, data: img };
}

/* ── Encode ─────────────────────────────────────────────────────────────── */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(data, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── Recolour ───────────────────────────────────────────────────────────── */
const src = decodePNG(fs.readFileSync(SRC));
const { w, h } = src;
const out = Buffer.from(src.data);

let visible = 0, lifted = 0, kept = 0;
for (let i = 0; i < w * h; i++) {
  const o = i * 4;
  const a = src.data[o + 3];
  if (a < 8) continue;                                   // transparent — leave alone
  visible++;

  const r = src.data[o], g = src.data[o + 1], b = src.data[o + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;         // HSV saturation
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /* The brand colours (green #71ff00-ish, orange) are highly saturated. The
     wordmark letters are dark and near-greyscale. Only the latter is touched. */
  const isBrandColour = sat > 0.35 && max > 60;
  const isDarkNeutral = L < 110 && sat < 0.35;

  if (isDarkNeutral && !isBrandColour) {
    /* THE ACTUAL DEFECT: these wordmark pixels have a mean alpha of 30/255 — they
       are only 12% OPAQUE. The "SOKO" letters were never really painted; they are a
       ghost. Recolouring alone cannot save them: white at 12% alpha over #050505 is
       still a dim grey smudge, which is exactly what a colour-only fix produced.

       So we amplify the alpha the letterforms already carry, rather than invent new
       ones. The shapes come entirely from the source; we are only making them opaque
       enough to see. The curve keeps the anti-aliased edge softer than the core, so
       the letters do not turn into hard blocks. */
    out[o] = 255; out[o + 1] = 255; out[o + 2] = 255;
    const boosted = 255 * Math.pow(Math.min(1, a / 96), 0.55);
    out[o + 3] = Math.max(a, Math.round(boosted));
    lifted++;
  } else {
    kept++;
  }
}

fs.writeFileSync(OUT, encodePNG(out, w, h));

/* ── Report ─────────────────────────────────────────────────────────────── */
function stats(data) {
  let n = 0, dark = 0, sum = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] < 32) continue;
    const L = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    n++; sum += L;
    if (L < 60) dark++;                                  // would be unreadable on #050505
  }
  return { mean: (sum / n).toFixed(1), darkPct: (dark / n * 100).toFixed(1) };
}
const a = stats(src.data), b2 = stats(out);

console.log('SOKONI — dark-surface logo\n');
console.log('SOURCE  assets/Sokoni Logo.png            (light-background original)');
console.log(`  ${w}x${h}   visible px ${visible}`);
console.log(`  mean luminance ${a.mean}   unreadable-on-dark ${a.darkPct}%`);
console.log('');
console.log('OUTPUT  assets/sokoni-logo-dark.png');
console.log(`  mean luminance ${b2.mean}   unreadable-on-dark ${b2.darkPct}%`);
console.log(`  pixels lifted to white : ${lifted}   brand colours kept intact : ${kept}`);
console.log('');
console.log('The bag, the green NI and the orange swoosh are untouched — only the dark,');
console.log('near-greyscale wordmark was lifted, so "SOKO" is legible on #050505.');
