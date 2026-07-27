/**
 * scripts/scan-xss-sinks.js
 *
 * Inventories HTML-rendering sinks and reports interpolations that reach them
 * without output encoding.
 *
 * WHY THIS EXISTS
 * Output escaping is a standing platform rule, but nothing enforced it. A stored
 * XSS lived in wishlist.html — product names interpolated raw into the card
 * template — while cart.js, rendering the same products, escaped correctly. The
 * rule depended on whoever wrote the file remembering it.
 *
 * WHAT IT DOES NOT DO
 * It does not prove exploitability. It reports *sinks* and whether encoding is
 * visibly applied. A value may be safe because it is escaped upstream, is not
 * user-controlled, or the path is unreachable — none of which a static scan can
 * see. Findings are therefore split:
 *
 *   CONFIRMED — an interpolation with no encoding anywhere in the expression,
 *               in a file that has no escape helper at all. High confidence.
 *   REVIEW    — an interpolation without visible encoding, in a file that does
 *               escape elsewhere. Could be an oversight or deliberately safe.
 *
 * CONTEXT MATTERS — the same value needs different treatment per sink:
 *   js-handler : onclick="...${x}..."  HTML-escaping is NOT sufficient here.
 *                A value must never be serialised into an inline handler; pass
 *                an index/id and look it up in JS instead.
 *   url-attr   : src/href="${x}"       needs scheme validation (javascript:,
 *                data:) — HTML-escaping alone does not stop those.
 *   attr       : alt="${x}"            needs quote-aware HTML escaping.
 *   text       : <h3>${x}</h3>         needs HTML escaping.
 *
 * Run: node scripts/scan-xss-sinks.js [--all]
 *      --all also lists REVIEW findings (default shows CONFIRMED + a count).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOW_ALL = process.argv.includes('--all');

/* PRECISION OVER RECALL.
   A first version flagged 1011 sites and was useless: it counted `${esc(x)}`
   (escaped), `${JSON.stringify(x)}` (encoded), `${def.label}` (an internal
   constant) and ternaries returning literals. A scanner nobody can trust is
   worse than none — the same lesson the overlay-blur scanner taught.
   So: flag ONLY a BARE property access reaching an HTML sink. Anything passed
   through a call of any kind is out of scope here; if that call is not an
   escaper, that is a different (and much rarer) review. */
const BARE_PROPERTY = /^[A-Za-z_$][\w$]*(\?\.|\.)[\w$.?]+$/;   /* p.name, o.seller.name */

/* Field names that are user- or seller-supplied free text. Numeric ids and
   internal flags are excluded deliberately — they are not injection vectors in
   practice and would drown the signal. */
/* `label` and `desc` are deliberately EXCLUDED: in this codebase they are almost
   always internal enum/config text (`st.label`, `role.description`, `f.label`),
   and including them buried the real signal under ~150 constants. Precision is
   the point — a list nobody triages protects nothing. */
const USER_FIELD = /\.(name|title|description|category|subcategory|brand|comment|body|message|notes|address|bio|about|tagline|storeName|shopName|businessName|sellerName|providerName|reviewerName|authorName|question|answer)\b/;

function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    /* Temp/ holds extracted scratch copies of page scripts — scanning them
       double-counts the real file and pollutes the report. */
    if (['node_modules', '.git', '.claude', 'Temp', 'backups', 'dist'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (dir === ROOT) listFiles(p, out); continue; }
    if (/\.(html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Classify the sink by what precedes the interpolation on its line. */
function classify(before) {
  if (/on[a-z]+\s*=\s*["'][^"']*$/i.test(before))            return 'js-handler';
  if (/\b(src|href|action|formaction|data|poster)\s*=\s*["'][^"']*$/i.test(before)) return 'url-attr';
  if (/\b[a-zA-Z-]+\s*=\s*["'][^"']*$/.test(before))         return 'attr';
  return 'text';
}

const SEVERITY = { 'js-handler': 3, 'url-attr': 2, 'attr': 1, 'text': 1 };

const confirmed = [];
const review = [];

for (const file of listFiles(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');

  /* Does this file know how to escape at all? Any of the several helper names
     in use across the codebase counts — _esc, esc, _h, escapeHtml, escapeHTML.
     (That five-way naming spread is itself part of the problem: no shared
      abstraction means no obvious thing to reach for.) */
  const hasEscaper = /(_esc|\besc|_h|escapeHtml|escapeHTML)\s*\(/.test(src);

  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    /* Only lines that look like HTML being built */
    if (!/[<>]/.test(line)) return;

    const re = /\$\{([^}]{1,160})\}/g;
    let m;
    while ((m = re.exec(line))) {
      const expr = m[1].trim();
      if (!BARE_PROPERTY.test(expr)) continue;   // any call/operator → out of scope
      if (!USER_FIELD.test(expr)) continue;      // not free user text

      const ctx = classify(line.slice(0, m.index));
      const rec = {
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: i + 1, ctx, expr: expr.trim().slice(0, 60),
        sev: SEVERITY[ctx],
      };
      (hasEscaper ? review : confirmed).push(rec);
    }
  });
}

const bySev = (a, b) => b.sev - a.sev || a.file.localeCompare(b.file);
confirmed.sort(bySev); review.sort(bySev);

function print(title, rows) {
  console.log('\n  ' + title + ' (' + rows.length + ')');
  if (!rows.length) { console.log('    none'); return; }
  const byFile = {};
  rows.forEach(r => { (byFile[r.file] = byFile[r.file] || []).push(r); });
  for (const [f, rs] of Object.entries(byFile)) {
    console.log('    ' + f);
    rs.slice(0, 6).forEach(r =>
      console.log('      L' + String(r.line).padEnd(5) + r.ctx.padEnd(11) + '${' + r.expr + '}'));
    if (rs.length > 6) console.log('      … +' + (rs.length - 6) + ' more');
  }
}

console.log('\n  XSS sink inventory — interpolation into HTML without visible encoding');
print('CONFIRMED — file has NO escape helper at all', confirmed);
if (SHOW_ALL) {
  print('REVIEW — file escapes elsewhere; these do not', review);
} else {
  console.log('\n  REVIEW (file escapes elsewhere): ' + review.length +
              '  — run with --all to list');
}

const handlers = [...confirmed, ...review].filter(r => r.ctx === 'js-handler');
if (handlers.length) {
  console.log('\n  !! ' + handlers.length + ' interpolation(s) inside inline event handlers.');
  console.log('     HTML-escaping does NOT make these safe — pass an index/id and');
  console.log('     look the value up in JS (see shareWish() in wishlist.html).');
}
console.log('');
process.exit(0);
