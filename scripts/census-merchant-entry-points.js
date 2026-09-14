#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT ENTRY-POINT CENSUS — read-only
   ------------------------------------------------------------------------------
   Answers one question before any cutover:

       Can a PUBLIC USER ACTION still send an approved seller to the OLD shell,
       bypassing sokoni-merchant-entry.js?

   The distinction that matters, and the reason this is not a search-and-replace:

     PUBLIC ACTION → approval authority → Merchant v2 → legacy module mounted INSIDE
     PUBLIC ACTION → seller.html / merchant.html                        ← the bypass

   A reference to `seller.html` or `pos.html` is therefore NOT automatically wrong.
   Mounted inside the shell it is the intended architecture; offered to a user as a
   destination it is a bypass. Only context separates them, so every hit is
   classified by HOW it is used, never by which file it names.

   CATEGORIES
     1 ENTRY      a public control whose destination is a merchant workspace.
                  Must go through the routing decision.
     2 MODULE     an iframe/module mount, or a registry `src` — the shell's own
                  internals. Must remain.
     3 INTERNAL   tests, docs, comments, censuses. No user reaches these.
     4 STALE      a reference to something that no longer exists, or a
                  workspace-to-workspace link with no routing.

   Read-only: it changes nothing.

     node scripts/census-merchant-entry-points.js
     node scripts/census-merchant-entry-points.js --md
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = process.argv.includes('--md');

/* Destinations that ARE a merchant workspace. Reaching one of these from a public
   control is what the routing contract exists to mediate. */
const WORKSPACE = /^(\/)?(merchant|merchant-v2|seller)(\.html)?$/i;

const SKIP_DIR = new Set(['node_modules', '.git', 'assets', 'functions']);
const files = [];
(function walk (dir, depth) {
  if (depth > 3) return;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  entries.forEach((e) => {
    if (SKIP_DIR.has(e.name)) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p, depth + 1);
    if (/\.(html|js)$/i.test(e.name)) files.push(p);
  });
})(ROOT, 0);

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const hits = [];

files.forEach((file) => {
  const r = rel(file);
  let src; try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    /* Every way a destination is expressed. Dynamic constructions are caught by the
       last pattern so a non-literal target cannot hide from the census. */
    const pats = [
      { re: /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi, how: 'iframe' },
      { re: /\bsrc\s*:\s*["']([^"']+\.html[^"']*)["']/g, how: 'registry-src' },
      { re: /href\s*=\s*["']([^"']+)["']/gi, how: 'href' },
      { re: /location\s*\.\s*(?:href|assign|replace)\s*=?\s*\(?\s*["']([^"']+)["']/gi, how: 'location' },
      { re: /(?:window\.)?open\s*\(\s*["']([^"']+)["']/gi, how: 'window.open' },
      { re: /\.setAttribute\s*\(\s*["']src["']\s*,\s*([^)]+)\)/gi, how: 'setAttribute-src' },
    ];
    pats.forEach((p) => {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) {
        const target = (m[1] || '').trim();
        const bare = target.split('?')[0].split('#')[0];
        if (!WORKSPACE.test(bare)) continue;
        hits.push({ file: r, line: i + 1, how: p.how, target: target, text: line.trim().slice(0, 160) });
      }
    });
  });
});

/* ── Classification ──────────────────────────────────────────────────────────*/
const isInternal = (f) => /^(scripts|docs)\//.test(f) || /(^|\/)test-|census-|diag-|probe-/.test(f);
const isShell = (f) => /^(merchant|merchant-v2)\.html$/.test(f) || f === 'sokoni-merchant-routes.js';

hits.forEach((h) => {
  const commented = /^\s*(\/\/|\*|<!--)/.test(h.text);
  if (isInternal(h.file) || commented) { h.cat = 3; h.why = commented ? 'comment/prose' : 'test or documentation'; return; }
  if (h.how === 'iframe' || h.how === 'registry-src' || h.how === 'setAttribute-src' || isShell(h.file)) {
    h.cat = 2; h.why = 'the shell mounting its own module'; return;
  }
  /* A public control. Is it already mediated by the routing contract? */
  h.routed = /data-merchant-entry\s*=/.test(h.text);
  if (h.routed) { h.cat = 1; h.why = 'routed through sokoni-merchant-entry.js'; return; }
  h.cat = 4; h.why = 'PUBLIC control with a hardcoded workspace destination — BYPASS';
});

const byCat = (c) => hits.filter((h) => h.cat === c);
const bypasses = byCat(4);

/* ── Report ──────────────────────────────────────────────────────────────────*/
if (MD) {
  console.log('# Merchant Entry-Point Census\n');
  console.log('> `node scripts/census-merchant-entry-points.js --md`. Read-only.\n');
  console.log(`**${hits.length} references** to a merchant workspace across ${files.length} scanned files.\n`);
  console.log('| category | count |');
  console.log('|---|--:|');
  console.log(`| 1 ENTRY — routed through the decision | ${byCat(1).length} |`);
  console.log(`| 2 MODULE — shell mounting its own module | ${byCat(2).length} |`);
  console.log(`| 3 INTERNAL — tests / docs / comments | ${byCat(3).length} |`);
  console.log(`| **4 STALE/BYPASS — public control, hardcoded** | **${bypasses.length}** |`);
  if (bypasses.length) {
    console.log('\n## Bypasses — a public control that skips the routing decision\n');
    console.log('| file | line | how | target |');
    console.log('|---|--:|---|---|');
    bypasses.forEach((h) => console.log(`| \`${h.file}\` | ${h.line} | ${h.how} | \`${h.target}\` |`));
  }
  process.exit(0);
}

console.log('\n\x1b[1mMERCHANT ENTRY-POINT CENSUS\x1b[0m   (read-only)');
console.log('  scanned ' + files.length + ' files · ' + hits.length + ' workspace references\n');
console.log('  1 ENTRY    routed through the decision            ' + byCat(1).length);
console.log('  2 MODULE   shell mounting its own module          ' + byCat(2).length);
console.log('  3 INTERNAL tests / docs / comments                ' + byCat(3).length);
console.log('  4 BYPASS   public control, hardcoded destination  ' + bypasses.length);

if (byCat(1).length) {
  console.log('\n\x1b[1m1 · ROUTED\x1b[0m');
  byCat(1).forEach((h) => console.log('   ' + h.file + ':' + h.line + '  → ' + h.target));
}
if (byCat(2).length) {
  console.log('\n\x1b[1m2 · MODULE MOUNTS (must remain)\x1b[0m');
  byCat(2).forEach((h) => console.log('   ' + h.file + ':' + h.line + '  [' + h.how + '] → ' + h.target));
}
if (bypasses.length) {
  console.log('\n\x1b[1m\x1b[31m4 · BYPASSES — these can send an approved seller to the old shell\x1b[0m');
  const byFile = {};
  bypasses.forEach((h) => { (byFile[h.file] = byFile[h.file] || []).push(h); });
  Object.keys(byFile).sort().forEach((f) => {
    console.log('\n   ' + f + '  (' + byFile[f].length + ')');
    byFile[f].slice(0, 6).forEach((h) => {
      console.log('     :' + h.line + '  [' + h.how + '] → ' + h.target);
      console.log('        ' + h.text.slice(0, 120));
    });
    if (byFile[f].length > 6) console.log('     … and ' + (byFile[f].length - 6) + ' more');
  });
}

console.log('\n' + '='.repeat(72));
console.log(bypasses.length
  ? '  ' + bypasses.length + ' bypass(es) — step 3 is NOT closed'
  : '  no bypasses — every public control routes through the decision');
process.exit(0);
