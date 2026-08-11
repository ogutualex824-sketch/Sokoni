#!/usr/bin/env node
/* Repo-wide executable scan for the two retired wishlist localStorage keys.
 *
 *   node scripts/scan-legacy-wishlist.js          → report + exit 1 if any survive
 *   require('./scan-legacy-wishlist.js').scan()   → [{file,line,key,kind,text}]
 *
 * WHY THIS IS NOT A GREP
 * grep counted a comment that DOCUMENTS a removed reader as that reader — three separate
 * times during this migration. It also cannot tell a read from a write, and it misses
 * inline <script> blocks unless you already know the file is HTML. So this strips comments
 * and strings-that-are-not-the-key first, then classifies each surviving hit.
 *
 * WHAT COUNTS AS EXECUTABLE
 *   .js files                 — whole file
 *   .html files               — ONLY the contents of <script> elements without a src
 *   block comments            — excluded
 *   line comments             — excluded
 *   the service's own file    — sokoni-wishlist.js declares LEGACY_KEYS so clearCache()
 *                               can DELETE them. Deletion is the opposite of a writer, so
 *                               it is excluded by path, and asserted separately in the
 *                               tests rather than waved through by the scanner.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KEYS = ['wishlist', 'sokoniWishlist'];
const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.firebase', 'dist', 'build', 'coverage', 'scripts']);
/* The canonical service is the one place allowed to name these keys — to remove them. */
const ALLOW = new Set(['sokoni-wishlist.js']);

/* ── comment stripping ────────────────────────────────────────────────────────
   Character-by-character, because a "//" inside a string and a quote inside a comment
   both desynchronise a naive scan. Stripped regions are BLANKED, not deleted, so line
   numbers stay true.

   The hard case is that JavaScript cannot be lexed without parsing: in

       .replace(/"/g,'&quot;').replace(/'/g,'&#x27;')

   the quotes are regex bodies, not strings. A first version of this scanner opened a
   string on that `"`, ran past the closing quote, and swallowed the next 200 lines of
   real code — reporting three migrated files as still holding legacy readers. The fix
   is a property, not a special case: a normal JS string cannot contain a raw newline,
   so `'` and `"` open a string ONLY when a matching unescaped quote exists later on the
   SAME line. A misread can then never propagate past the end of its line. Template
   literals may legitimately span lines and are tracked normally.

   Direction of error matters. Every remaining inaccuracy makes the scanner blank MORE
   than it should — a false negative, the dangerous kind — so scan() cross-checks the
   stripped result against the raw file and surfaces the difference as `suppressed`
   instead of discarding it. Nothing disappears quietly. */
function _closesOnSameLine(src, i, q) {
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '\n') return false;
    if (ch === q) return true;
  }
  return false;
}

function stripComments(src) {
  let out = '', i = 0, n = src.length;
  let inS = null, inLine = false, inBlock = false;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; i++; continue; }
    if (inBlock) {
      if (c === '*' && d === '/') { inBlock = false; out += '  '; i += 2; continue; }
      out += (c === '\n' ? c : ' '); i++; continue;
    }
    if (inS) {
      out += c;
      if (c === '\\') { out += (d === undefined ? '' : d); i += 2; continue; }
      if (c === inS) inS = null;
      i++; continue;
    }
    if (c === '/' && d === '/') { inLine = true; i += 2; out += '  '; continue; }
    if (c === '/' && d === '*') { inBlock = true; i += 2; out += '  '; continue; }
    if (c === '`') { inS = c; out += c; i++; continue; }
    if ((c === '"' || c === "'") && _closesOnSameLine(src, i, c)) { inS = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/* Executable regions of an HTML file: inline <script> only. External <script src>
   bodies live in their own .js file and are scanned there; a src tag has no body. */
function htmlScriptRegions(src) {
  const regions = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1] || '';
    const end = src.indexOf('</script', m.index);
    if (end === -1) break;
    const bodyStart = m.index + m[0].length;
    re.lastIndex = end;
    if (/\bsrc\s*=/i.test(attrs)) continue;                 /* no body */
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue;  /* ld+json etc */
    regions.push([bodyStart, end]);
  }
  return regions;
}

/* Blank everything outside the given regions so offsets — and therefore line
   numbers — survive intact. */
function keepOnly(src, regions) {
  const keep = Buffer.alloc(src.length, 0);
  regions.forEach(([a, b]) => { for (let i = a; i < b; i++) keep[i] = 1; });
  let out = '';
  for (let i = 0; i < src.length; i++) out += keep[i] ? src[i] : (src[i] === '\n' ? '\n' : ' ');
  return out;
}

function classify(line, at) {
  const before = line.slice(0, at);
  if (/setItem\s*\(\s*$/.test(before)) return 'WRITE';
  if (/getItem\s*\(\s*$/.test(before)) return 'READ';
  if (/removeItem\s*\(\s*$/.test(before)) return 'DELETE';
  if (/localStorage\s*\[\s*$/.test(before)) {
    /* localStorage['k'] = …  is a write; anything else is a read. */
    return /\]\s*=[^=]/.test(line.slice(at)) ? 'WRITE' : 'READ';
  }
  return 'REF';
}

function scanSource(src, file) {
  const hits = [];
  const lines = src.split('\n');
  const re = new RegExp(
    'localStorage\\s*(?:\\.\\s*(?:get|set|remove)Item\\s*\\(\\s*|\\[\\s*)["\'](' + KEYS.join('|') + ')["\']', 'g');
  lines.forEach((line, idx) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const at = m.index + m[0].lastIndexOf(m[1]) - 1;
      hits.push({ file, line: idx + 1, key: m[1], kind: classify(line, at), text: line.trim().slice(0, 110) });
    }
  });
  return hits;
}

/* Returns { hits, suppressed }.
   hits       — executable references. Must be zero.
   suppressed — matched in the raw file but removed by comment stripping. Reported so a
                stripper bug shows up as a listed line to check rather than as silence. */
function scan() {
  const hits = [], suppressed = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && e.name[0] !== '.') walk(path.join(dir, e.name)); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== '.js' && ext !== '.html') continue;
      if (ALLOW.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      let src;
      try { src = fs.readFileSync(full, 'utf8'); } catch (e2) { continue; }
      if (ext === '.html') src = keepOnly(src, htmlScriptRegions(src));
      const exec = scanSource(stripComments(src), rel);
      const raw = scanSource(src, rel);
      hits.push(...exec);
      const live = new Set(exec.map(h => h.line + ':' + h.key));
      suppressed.push(...raw.filter(h => !live.has(h.line + ':' + h.key)));
    }
  })(ROOT);
  return { hits: hits, suppressed: suppressed };
}

module.exports = { scan, stripComments, htmlScriptRegions, keepOnly, KEYS };

if (require.main === module) {
  const { hits, suppressed } = scan();
  console.log('\nLEGACY WISHLIST KEY SCAN — executable code only\n' + '='.repeat(64));
  KEYS.forEach(k => {
    const mine = hits.filter(h => h.key === k);
    const w = mine.filter(h => h.kind === 'WRITE').length;
    const r = mine.filter(h => h.kind === 'READ').length;
    const o = mine.length - w - r;
    console.log('\nlocalStorage[\'' + k + '\']   writers: ' + w + '   readers: ' + r + '   other refs: ' + o);
    mine.forEach(h => console.log('    ' + h.kind.padEnd(8) + h.file + ':' + h.line + '   ' + h.text));
  });
  console.log('\n' + '-'.repeat(64));
  console.log('Suppressed as comment/doc (' + suppressed.length + ') — each must be prose, not code:');
  suppressed.forEach(h => console.log('    ' + h.file + ':' + h.line + '   ' + h.text));
  console.log('\n' + '='.repeat(64));
  console.log(hits.length === 0 ? 'CLEAN — zero executable readers or writers.'
                                : 'SURVIVING REFERENCES: ' + hits.length);
  process.exit(hits.length === 0 ? 0 : 1);
}
