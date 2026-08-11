#!/usr/bin/env node
/* Repo-level cart-persistence scanner. Guard infrastructure for Track 2.
 *
 *   node scripts/scan-cart-writers.js            → report, exit 1 if unmigrated writers remain
 *   node scripts/scan-cart-writers.js --page food.html   → page scope: that page + its scripts
 *   require('./scan-cart-writers.js').scan()     → [{file,line,key,kind,via,text}]
 *
 * WHY THIS EXISTS
 * The previous scan required a STRING LITERAL inside the localStorage call. sokoni-food.js
 * writes the same 'cart' key through `const SHARED_CART_KEY = 'cart'`, so it was invisible
 * — a complete parallel cart implementation across five pages, missed for three migration
 * slices while the reports quoted confident writer counts. The counts were not wrong about
 * what they measured; they were measuring the wrong thing.
 *
 * So this resolves indirection rather than assuming there is none:
 *
 *   localStorage.getItem('cart')          literal
 *   localStorage['cart']                  bracket
 *   const K = 'cart'; localStorage.getItem(K)     key constant
 *   const ls = localStorage; ls.setItem('cart',…) storage alias
 *   inline <script> in HTML                       (external src scanned as its own file)
 *
 * Comments and unrelated strings are excluded via the hardened stripper built for the
 * Track 3 wishlist sweep — the one that had to survive `.replace(/"/g,'&quot;')`.
 *
 * scripts/test-cart-scanner.js holds positive controls for every form above. A scanner
 * that reports zero is only worth having if it can be shown to report non-zero, and this
 * one has already been silently weaker than it looked once.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { stripComments, keepOnly, htmlScriptRegions } = require('./scan-legacy-wishlist.js');

const ROOT = path.resolve(__dirname, '..');
const KEYS = ['cart', 'sokoniCart', 'retrievedCart', 'sokoniCartReminded'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.firebase', 'dist', 'build', 'coverage']);

/* ── indirection resolution ───────────────────────────────────────────────── */

/* `const SHARED_CART_KEY = 'cart'` → { SHARED_CART_KEY: 'cart' } */
function keyConstants(src) {
  const out = {};
  const re = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*["\'](' + KEYS.join('|') + ')["\']', 'g');
  let m;
  while ((m = re.exec(src))) out[m[1]] = m[2];
  return out;
}

/* `const ls = localStorage` / `= window.localStorage` → Set{'ls'}.
   Always includes localStorage itself. */
function storageAliases(src) {
  const out = new Set(['localStorage']);
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\s*\.\s*)?localStorage\b/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

function classify(method, line, at) {
  if (method === 'set') return 'WRITE';
  if (method === 'get') return 'READ';
  if (method === 'remove') return 'DELETE';
  /* bracket form: `x['cart'] = …` is a write, anything else a read */
  return /\]\s*=[^=]/.test(line.slice(at)) ? 'WRITE' : 'READ';
}

function scanSource(src, file) {
  const hits = [];
  const consts = keyConstants(src);
  const aliases = [...storageAliases(src)];
  const lines = src.split('\n');

  /* Every (alias, key-expression) combination. The key expression is either a quoted
     literal or an identifier that resolves to one. */
  const keyAlt = KEYS.join('|');
  const constAlt = Object.keys(consts);
  const aliasAlt = aliases.map(a => a.replace(/\$/g, '\\$')).join('|');

  const patterns = [
    { re: new RegExp('(?:' + aliasAlt + ')\\s*\\.\\s*(get|set|remove)Item\\s*\\(\\s*["\'](' + keyAlt + ')["\']', 'g'),
      key: m => m[2], method: m => m[1], via: () => 'literal' },
    { re: new RegExp('(?:' + aliasAlt + ')\\s*\\[\\s*["\'](' + keyAlt + ')["\']\\s*\\]', 'g'),
      key: m => m[1], method: () => 'bracket', via: () => 'bracket' },
  ];
  if (constAlt.length) {
    const c = constAlt.map(x => x.replace(/\$/g, '\\$')).join('|');
    patterns.push(
      { re: new RegExp('(?:' + aliasAlt + ')\\s*\\.\\s*(get|set|remove)Item\\s*\\(\\s*(' + c + ')\\b', 'g'),
        key: m => consts[m[2]], method: m => m[1], via: m => 'const ' + m[2] },
      { re: new RegExp('(?:' + aliasAlt + ')\\s*\\[\\s*(' + c + ')\\s*\\]', 'g'),
        key: m => consts[m[1]], method: () => 'bracket', via: m => 'const ' + m[1] });
  }

  lines.forEach((line, i) => {
    patterns.forEach(p => {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) {
        const key = p.key(m);
        if (!key) continue;
        hits.push({ file, line: i + 1, key, via: p.via(m),
          kind: classify(p.method(m), line, m.index), text: line.trim().slice(0, 100) });
      }
    });
  });
  return hits;
}

function readExecutable(rel) {
  const full = path.join(ROOT, rel);
  let src = fs.readFileSync(full, 'utf8');
  if (path.extname(rel).toLowerCase() === '.html') src = keepOnly(src, htmlScriptRegions(src));
  return stripComments(src);
}

function scan(opts) {
  opts = opts || {};
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && e.name[0] !== '.') walk(path.join(dir, e.name)); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== '.js' && ext !== '.html') continue;
      const rel = path.relative(dir === ROOT ? ROOT : ROOT, path.join(dir, e.name)).replace(/\\/g, '/');
      if (/^scripts\//.test(rel) && !opts.includeScripts) continue;
      let src; try { src = readExecutable(rel); } catch (_) { continue; }
      hits.push(...scanSource(src, rel));
    }
  })(ROOT);
  return hits;
}

/* Page scope: an HTML page plus every LOCAL script it statically loads. Dynamically
   injected scripts (security.js injects provider-wiring.js and sokoni-sync.js on ~288
   pages) are not visible here — that is why provider-wiring.js is tracked separately as a
   frozen surface rather than trusted to show up in a page scan. */
function pageScope(page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)]
    .map(m => m[1]).filter(s => !/^https?:|^\/\//.test(s))
    .map(s => s.replace(/^\.?\//, '').split('?')[0])
    .filter(s => fs.existsSync(path.join(ROOT, s)));
  const files = [page, ...new Set(srcs)];
  const hits = [];
  files.forEach(f => { try { hits.push(...scanSource(readExecutable(f), f)); } catch (_) {} });
  return { files, hits };
}

module.exports = { scan, scanSource, pageScope, keyConstants, storageAliases, KEYS };

/* ── CLI ──────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  const STATE = require('./cart-migration-state.js');
  const pageArg = process.argv.indexOf('--page');

  if (pageArg > -1) {
    const page = process.argv[pageArg + 1];
    const { files, hits } = pageScope(page);
    console.log('\nPAGE SCOPE — ' + page + '\n' + '='.repeat(70));
    console.log('scanned ' + files.length + ' local files');
    const cart = hits.filter(h => h.key === 'cart');
    const w = cart.filter(h => h.kind === 'WRITE'), r = cart.filter(h => h.kind === 'READ');
    console.log('\nWRITERS (' + w.length + '):');
    w.forEach(h => console.log('   ' + h.file + ':' + h.line + '  via ' + h.via + '   ' + h.text));
    console.log('\nREADERS (' + r.length + '):');
    r.forEach(h => console.log('   ' + h.file + ':' + h.line + '  via ' + h.via + '   ' + h.text));
    console.log('\nNote: dynamically injected scripts (provider-wiring.js, sokoni-sync.js via');
    console.log('security.js) are NOT in this scope — they are tracked as frozen surfaces.');
    process.exit(0);
  }

  const hits = scan().filter(h => h.key === 'cart');
  const byFile = {};
  hits.forEach(h => { (byFile[h.file] = byFile[h.file] || []).push(h); });

  const classify = (f) => {
    if (f === 'sokoni-cart.js') return 'SERVICE';
    if (STATE.FROZEN_FILES.includes(f)) return 'FROZEN';
    if (STATE.TEST_HARNESS.includes(f)) return 'HARNESS';
    if (STATE.DEFERRED_FILES.includes(f)) return 'DEFERRED';
    if (STATE.BLOCKED_FILES.includes(f)) return 'BLOCKED';
    if (STATE.MIGRATED.includes(f)) return 'MIGRATED';
    return 'UNACCOUNTED';
  };

  console.log('\nCART PERSISTENCE — repo-wide, indirection resolved\n' + '='.repeat(70));
  const ORDER = ['UNACCOUNTED', 'BLOCKED', 'DEFERRED', 'FROZEN', 'SERVICE', 'HARNESS', 'MIGRATED'];
  const groups = {}; ORDER.forEach(g => { groups[g] = []; });
  Object.keys(byFile).sort().forEach(f => groups[classify(f)].push(f));

  const wrap = (text, indent) => {
    const words = text.split(' '); const out = []; let line = '';
    words.forEach(w => {
      if ((line + ' ' + w).trim().length > 84) { out.push(line.trim()); line = w; }
      else line += ' ' + w;
    });
    if (line.trim()) out.push(line.trim());
    return out.map(l => indent + l).join('\n');
  };

  ORDER.forEach(g => {
    if (!groups[g].length) return;
    console.log('\n' + g + ':');
    groups[g].forEach(f => {
      const m = byFile[f];
      const w = m.filter(h => h.kind === 'WRITE').length;
      const r = m.filter(h => h.kind === 'READ').length;
      const d = m.filter(h => h.kind === 'DELETE').length;
      const via = [...new Set(m.map(h => h.via))].join(', ');
      const own = STATE.survivorFor(f);
      console.log('   ' + f.padEnd(30) + ' w=' + w + ' r=' + r + (d ? ' d=' + d : '') +
                  '   via ' + via + (own ? '   → ' + own.phase : ''));
      /* Every survivor prints WHY. A name on its own reads as an oversight; the reason is
         what makes "not migrated" a decision somebody can audit. */
      if (own) console.log(wrap(own.reason, '        '));
    });
  });

  /* UNACCOUNTED is the only failing state. BLOCKED / DEFERRED / FROZEN each carry an
     owning phase and a reason in cart-migration-state.js — they are decisions, not
     leftovers, and a sweep that treated them as failures would pressure someone into
     unfreezing a boundary just to make this print zero. */
  const rogue = groups.UNACCOUNTED;
  console.log('\n' + '='.repeat(70));
  if (rogue.length) {
    console.log('UNACCOUNTED — direct cart access with no owning phase: ' + rogue.length);
    rogue.forEach(f => console.log('   ' + f));
    console.log('\nEither migrate these or record them in cart-migration-state.js with a phase');
    console.log('and a reason. An unexplained survivor is the failure this scan exists to catch.');
  } else {
    console.log('ACCOUNTED — every direct cart access is the service, or carries an owning phase.');
    console.log('  BLOCKED  ' + (groups.BLOCKED.length || 0) + '   ' + groups.BLOCKED.join(', '));
    console.log('  DEFERRED ' + (groups.DEFERRED.length || 0) + '   ' + groups.DEFERRED.join(', '));
    console.log('  FROZEN   ' + (groups.FROZEN.length || 0) + '   ' + groups.FROZEN.join(', '));
  }
  process.exit(rogue.length ? 1 : 0);
}
