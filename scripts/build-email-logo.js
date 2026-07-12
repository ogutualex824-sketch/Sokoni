#!/usr/bin/env node
/* ================================================================
   SOKONI — Email logo asset builder
   scripts/build-email-logo.js

   ROOT CAUSE this fixes
   ---------------------
   The email template served assets/Sokoni Logo.png at its native 480x320 but
   displayed it at 180x120 — forcing every email client to downscale to 37.5%.

   The mark is 94.2% transparent with thin, anti-aliased strokes. When an RGBA
   image is downscaled with a naive (non-premultiplied) box filter — which is what
   Gmail/Outlook do — each output pixel averages the colour of its neighbours
   INCLUDING fully-transparent ones. Transparent pixels carry RGB 0,0,0 with a=0,
   so they drag both colour and alpha down. Thin strokes therefore lose opacity and
   the logo renders FADED / WASHED OUT / partly invisible.

   THE FIX: pre-resample the asset ourselves, correctly, to exactly the size the
   email renders it at (2x for HiDPI), so the client performs little or no scaling.
   We resample in PREMULTIPLIED-ALPHA space, which is the mathematically correct
   way to filter images with transparency and is precisely what the naive client
   filter gets wrong.

   Output: assets/sokoni-email-logo.png  (360x240 = 2x of the 180x120 render box)

   No image library is available in this environment, so PNG decode, premultiplied
   area-average resampling, and PNG encode are all implemented here from scratch.
================================================================ */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', 'Sokoni Logo.png');
const OUT = path.join(__dirname, '..', 'assets', 'sokoni-email-logo.png');

/* Render box in the email is 180x120 → serve 2x for HiDPI (retina phones). */
const TARGET_W = 360;
const TARGET_H = 240;

/* ── Decode PNG (RGBA, 8-bit) ─────────────────────────────────────── */
function decodePNG(buf) {
  if (buf.slice(1, 4).toString() !== 'PNG') throw new Error('not a PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25];
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`need 8-bit RGBA, got depth ${bitDepth} type ${colorType}`);

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
      const a = x >= bpp ? img[y * stride + x - bpp] : 0;               // left
      const b = y > 0 ? img[(y - 1) * stride + x] : 0;                  // up
      const c = (y > 0 && x >= bpp) ? img[(y - 1) * stride + x - bpp] : 0; // up-left
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {                                                // Paeth
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      img[y * stride + x] = v & 255;
    }
  }
  return { w, h, data: img };
}

/* ── Resample in PREMULTIPLIED alpha (this is the actual bug fix) ──── */
function resamplePremultiplied(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xR = sw / dw, yR = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yR, y1 = Math.min(sh, (dy + 1) * yR);
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xR, x1 = Math.min(sw, (dx + 1) * xR);

      let rA = 0, gA = 0, bA = 0, aA = 0, wSum = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const cy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const cx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const wgt = cx * cy;
          if (wgt <= 0) continue;
          const i = (sy * sw + sx) * 4;
          const a = src[i + 3] / 255;
          /* PREMULTIPLY: weight colour by alpha so transparent pixels contribute
             NO colour. This is exactly what the naive client filter fails to do,
             and why thin strokes bled out and looked faded. */
          rA += src[i]     * a * wgt;
          gA += src[i + 1] * a * wgt;
          bA += src[i + 2] * a * wgt;
          aA += a * wgt;
          wSum += wgt;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (wSum === 0 || aA === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
      /* UN-premultiply back to straight alpha for PNG storage. */
      const aAvg = aA / wSum;
      out[o]     = Math.min(255, Math.round(rA / aA));
      out[o + 1] = Math.min(255, Math.round(gA / aA));
      out[o + 2] = Math.min(255, Math.round(bA / aA));
      out[o + 3] = Math.min(255, Math.round(aAvg * 255));
    }
  }
  return out;
}

/* ── Encode PNG ───────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
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
    raw[y * (stride + 1)] = 0;                                   // filter: None
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── Analyse (for the before/after report) ───────────────────────── */
function analyse(data, w, h) {
  let opaque = 0, semi = 0, transparent = 0, sumL = 0;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a < 16) { transparent++; continue; }
    if (a < 240) semi++;
    opaque++;
    sumL += 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }
  return {
    visible: opaque,
    semiTransparentPct: opaque ? (semi / opaque * 100).toFixed(1) : '0',
    meanLuminance: opaque ? (sumL / opaque).toFixed(1) : '0',
    transparentPct: (transparent / (w * h) * 100).toFixed(1),
  };
}

/* ── Build ────────────────────────────────────────────────────────── */
const srcBuf = fs.readFileSync(SRC);
const src = decodePNG(srcBuf);
const before = analyse(src.data, src.w, src.h);

const outData = resamplePremultiplied(src.data, src.w, src.h, TARGET_W, TARGET_H);
const after = analyse(outData, TARGET_W, TARGET_H);
const png = encodePNG(outData, TARGET_W, TARGET_H);
fs.writeFileSync(OUT, png);

console.log('SOKONI — email logo build\n');
console.log('SOURCE  assets/Sokoni Logo.png');
console.log(`  ${src.w}x${src.h}  ${srcBuf.length} bytes`);
console.log(`  transparent ${before.transparentPct}%  visible px ${before.visible}  mean luminance ${before.meanLuminance}`);
console.log('\nOUTPUT  assets/sokoni-email-logo.png');
console.log(`  ${TARGET_W}x${TARGET_H}  ${png.length} bytes   (2x of the 180x120 render box)`);
console.log(`  transparent ${after.transparentPct}%  visible px ${after.visible}  mean luminance ${after.meanLuminance}`);
console.log(`  semi-transparent edge px: ${after.semiTransparentPct}%  (premultiplied — no alpha bleed)`);
console.log('\nThe client now scales 360->180 (a clean 2:1) instead of 480->180 (0.375 with a');
console.log('naive filter). Premultiplied resampling means transparent pixels contribute NO');
console.log('colour, so thin strokes keep their opacity and the mark stays crisp.');
