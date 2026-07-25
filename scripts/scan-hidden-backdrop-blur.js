/**
 * scripts/scan-hidden-backdrop-blur.js
 *
 * Finds CSS rules that hide an element with `opacity:0` while a descendant (or
 * the element itself) still applies `backdrop-filter`.
 *
 * WHY THIS MATTERS
 * WebKit composites `backdrop-filter` EVEN AT OPACITY 0. The element is
 * invisible, but its blur keeps rendering — producing a full-screen frosted
 * layer with nothing visible on it. The page content is still there, just
 * behind glass, and usually untappable because the hidden element is also
 * `position:fixed; inset:0`.
 *
 * This was recorded once in security.js (the privacy scrim, reported from
 * iPhone Safari) and hit a second time in wallet.html, where ten closed
 * overlays each carried a blurring backdrop.
 *
 * NOTE ON TESTING: Playwright's `webkit` build does NOT reproduce this — it
 * renders such pages correctly and will give you a false negative. The bug is
 * specific to real iOS Safari. Treat this static scan as the detector.
 *
 * Fix pattern:
 *   1. add `visibility:hidden` to the closed state (and `visible` when open)
 *   2. scope `backdrop-filter` to the OPEN state only
 *   3. include `-webkit-backdrop-filter`
 *
 * Run: node scripts/scan-hidden-backdrop-blur.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const files = fs.readdirSync(ROOT).filter(f => /\.(html|css)$/.test(f));

/** Split a stylesheet-ish blob into `selector { body }` pairs.
    Comments MUST be stripped first — otherwise a `/* ... *\/` banner is parsed
    as part of the next selector, and every rule matches everything. That
    produced 139 findings on the first run, nearly all of them noise. */
function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;     // skip at-rules
    out.push({ sel, body: m[2] });
  }
  return out;
}

/** Is `blurSel` the same element as `base`, or a descendant of it? */
function targetsSameOrDescendant(blurSel, base) {
  if (blurSel === base) return true;
  /* ".overlay .ovl-backdrop" or ".overlay > x" — base followed by a combinator */
  return new RegExp('(^|,\\s*)' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[>\\s]').test(blurSel);
}

const findings = [];

for (const file of files) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');

  /* Only look inside <style> blocks for HTML; a .css file is all style. */
  const blocks = /\.css$/.test(file)
    ? [src]
    : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);

  for (const block of blocks) {
    const rs = rules(block);

    /* A hidden COVERING layer: opacity:0, no visibility/display escape hatch,
       and positioned so it actually covers something. A hidden inline element
       cannot produce a full-screen glass sheet, so it is not interesting. */
    const hidden = rs.filter(r =>
      /opacity\s*:\s*0(\s*;|\s*$|\s*!)/.test(r.body) &&
      !/visibility\s*:\s*hidden/.test(r.body) &&
      !/display\s*:\s*none/.test(r.body) &&
      /position\s*:\s*(fixed|absolute)/.test(r.body)
    );
    if (!hidden.length) continue;

    const blurred = rs.filter(r => /backdrop-filter\s*:\s*[^;]*blur/.test(r.body));
    if (!blurred.length) continue;

    for (const h of hidden) {
      for (const base of h.sel.split(',').map(s => s.trim()).filter(Boolean)) {
        /* Ignore a base that is itself already an open/active state. */
        if (/\.(open|active|show|visible)\b/.test(base)) continue;

        const hits = blurred.filter(b => {
          const gated = /\.(open|active|show|visible)\b/.test(b.sel);
          if (gated) return false;                       // already state-scoped: safe
          return b.sel.split(',').map(s => s.trim())
                  .some(s => targetsSameOrDescendant(s, base));
        });

        for (const hit of hits) findings.push({ file, hidden: base, blur: hit.sel.trim() });
      }
    }
  }
}

console.log('\n  Hidden-but-blurring elements (opacity:0 + un-gated backdrop-filter)\n');
if (!findings.length) {
  console.log('    none found\n');
} else {
  const byFile = {};
  findings.forEach(f => { (byFile[f.file] = byFile[f.file] || []).push(f); });
  for (const [file, list] of Object.entries(byFile)) {
    console.log('    ' + file);
    list.forEach(f => console.log('      hidden: ' + f.hidden.padEnd(24) + 'blur rule: ' + f.blur));
  }
  console.log('\n    ' + findings.length + ' finding(s). Gate the blur on the open state, and add visibility:hidden.\n');
}
process.exit(0);
