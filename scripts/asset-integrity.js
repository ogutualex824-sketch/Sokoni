#!/usr/bin/env node
'use strict';
/* SOKONI — asset integrity validator.
 *
 *   node scripts/asset-integrity.js          report
 *   node scripts/asset-integrity.js --gate   exit 1 on any BROKEN asset
 *
 * Checks what can be checked from the filesystem, and says plainly what it
 * cannot. Image DIMENSIONS are read only from PNG/JPEG/GIF headers — no decode
 * — so an SVG or WEBP reports dimensions UNKNOWN rather than a guessed number.
 *
 * Hosting-ignored paths are excluded: firebase.json's ignore list means those
 * files are never served, so a reference to one IS broken even though the file
 * exists on disk. That distinction is the point of the check.
 */
const fs = require('fs');
const path = require('path');

const GATE = process.argv.includes('--gate');

/* ── which assets does the deploy actually serve? ────────────────────────── */
let IGNORE = [];
try { IGNORE = (JSON.parse(fs.readFileSync('firebase.json', 'utf8')).hosting || {}).ignore || []; } catch (_) {}
const ignored = (p) => IGNORE.some((g) => {
  const re = new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::').replace(/\*/g, '[^/]*').replace(/::/g, '.*') + '$');
  return re.test(p.replace(/\\/g, '/'));
});

const ASSET = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp' };

/* ── dimensions from headers only ────────────────────────────────────────── */
function dims(file) {
  let b;
  try { b = fs.readFileSync(file); } catch (_) { return null; }
  if (b.length < 24) return null;
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG')
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.toString('ascii', 0, 3) === 'GIF')
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return null;   /* svg / webp / ico — not parsed, reported UNKNOWN */
}

/* ── collect references ──────────────────────────────────────────────────── */
const SKIP = new Set(['node_modules', '.git', '.claude', 'Temp', 'coverage', 'screenshots']);
function walk(dir, filter, out) {
  out = out || [];
  let e = [];
  try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const x of e) {
    if (SKIP.has(x.name)) continue;
    const p = path.join(dir, x.name);
    if (x.isDirectory()) walk(p, filter, out);
    else if (filter(x.name)) out.push(p);
  }
  return out;
}

const sources = walk('.', (n) => /\.(html|js|css|json|webmanifest)$/i.test(n))
  .filter((p) => !/[\\/]scripts[\\/]|[\\/]docs[\\/]/.test(p));

const refs = new Map();   /* asset path -> Set(referencing files) */
const RE = /["'(]\s*(\/?[\w\-./@]+\.(?:png|jpe?g|gif|webp|svg|ico|avif|bmp))(?:\?[^"')]*)?\s*["')]/gi;

for (const f of sources) {
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  for (const m of src.matchAll(RE)) {
    let a = m[1];
    if (/^(https?:|data:|\/\/)/i.test(a)) continue;      /* external */
    if (a.includes('${') || a.includes('+')) continue;    /* runtime-built */
    a = a.replace(/^\//, '');
    if (!refs.has(a)) refs.set(a, new Set());
    refs.get(a).add(f);
  }
}

/* ── evaluate ────────────────────────────────────────────────────────────── */
const rows = [];
for (const [asset, by] of [...refs].sort()) {
  const exists = fs.existsSync(asset);
  let size = null, d = null, hash = null, status = 'OK';

  if (!exists) status = 'MISSING';
  else {
    const st = fs.statSync(asset);
    size = st.size;
    if (st.size === 0) status = 'EMPTY';
    else {
      d = dims(asset);
      const crypto = require('crypto');
      hash = crypto.createHash('sha1').update(fs.readFileSync(asset)).digest('hex').slice(0, 8);
      if (ignored(asset)) status = 'NOT SERVED';       /* exists but hosting-ignored */
      else if (size > 2 * 1024 * 1024) status = 'OVERSIZE';
    }
  }
  const ext = (asset.split('.').pop() || '').toLowerCase();
  rows.push({ asset, by: [...by], exists, size, d, hash, status, mime: MIME[ext] || 'UNKNOWN' });
}

/* duplicate logical assets: same bytes, different paths */
const byHash = {};
rows.filter((r) => r.hash).forEach((r) => { (byHash[r.hash] = byHash[r.hash] || []).push(r.asset); });
const dupes = Object.entries(byHash).filter(([, a]) => a.length > 1);

/* ── report ──────────────────────────────────────────────────────────────── */
const broken = rows.filter((r) => r.status === 'MISSING' || r.status === 'EMPTY' || r.status === 'NOT SERVED');

console.log('\n  ASSET INTEGRITY — ' + rows.length + ' referenced assets\n');
console.log('  ' + 'STATUS'.padEnd(12) + 'ASSET'.padEnd(44) + 'SIZE'.padStart(9) + '  DIMS'.padEnd(13) + 'REFERENCED BY');
console.log('  ' + '-'.repeat(104));
for (const r of broken.slice(0, 30)) {
  console.log('  ' + r.status.padEnd(12) + r.asset.slice(0, 42).padEnd(44) +
    String(r.size === null ? '-' : r.size).padStart(9) + '  ' +
    (r.d ? (r.d.w + 'x' + r.d.h) : 'UNKNOWN').padEnd(13) +
    r.by.length + ' file(s): ' + path.basename(r.by[0]));
}
if (!broken.length) console.log('  no missing, empty or unserved assets');
if (broken.length > 30) console.log('  … ' + (broken.length - 30) + ' more');

const counts = rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
console.log('\n  ' + Object.entries(counts).map(([k, v]) => k + ' ' + v).join('  ·  '));

if (dupes.length) {
  console.log('\n  DUPLICATE LOGICAL ASSETS (identical bytes, different paths): ' + dupes.length);
  dupes.slice(0, 6).forEach(([h, a]) => console.log('    ' + h + '  ' + a.join('  =  ')));
}

console.log('\n  NOT CHECKED — stated rather than assumed:');
console.log('    · SVG/WEBP/ICO dimensions (header parsing covers PNG, JPEG, GIF only)');
console.log('    · cache headers and service-worker precache currency (need a live fetch)');
console.log('    · whether an OG image renders correctly in a social preview\n');

console.log('  GATE: ' + (broken.length === 0 ? 'PASS' : 'FAIL — ' + broken.length + ' broken reference(s)') + '\n');
process.exit(GATE && broken.length ? 1 : 0);
