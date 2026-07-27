'use strict';
/**
 * scripts/check-inline-js.js — syntax-check every inline <script> in an HTML file.
 *
 * A syntax error inside inline HTML script is invisible to `node --check` and
 * to any bundler, because nothing ever parses these files as JavaScript. It
 * shows up only as a blank page in a browser. This extracts each inline block
 * and parses it, so a broken edit fails here instead of in production.
 *
 *   node scripts/check-inline-js.js providers.html services.html
 *   node scripts/check-inline-js.js            # checks a default page set
 */
const fs = require('fs');
const vm = require('vm');

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['providers.html', 'services.html', 'cleaning.html', 'provider-profile.html', 'index.html'];

let failures = 0;

for (const file of files) {
  if (!fs.existsSync(file)) { console.log('  SKIP  ' + file + ' (not found)'); continue; }
  const raw = fs.readFileSync(file, 'utf8');
  /* Blank out HTML comments before scanning, preserving byte offsets and
     newlines so reported line numbers still point at the real location.
     Without this, a <script> tag quoted inside a comment — this codebase has
     several, in notes explaining past fixes — is picked up as a real block and
     its surrounding prose is parsed as JavaScript. */
  const html = raw.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, n = 0, bad = 0;

  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body  = m[2] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;          /* external file */
    if (!body.trim()) continue;
    if (/\btype\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue;  /* JSON-LD etc */
    n++;
    /* Line number of this block's start, so the error points somewhere real. */
    const line = html.slice(0, m.index).split('\n').length;
    const isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
    try {
      /* vm.Script parses without executing. A module body is parsed with a
         script parse goal here, so top-level import/export statements are
         stripped first — they are declarations, not the logic being checked. */
      const src = isModule
        ? '(async()=>{' + body.replace(/^[ \t]*(import|export)\b.*$/gm, '') + '})()'
        : body;
      new vm.Script(src, { filename: file + ':' + line });
    } catch (e) {
      bad++; failures++;
      console.log('  FAIL  ' + file + '  block starting line ' + line);
      console.log('        ' + e.message);
    }
  }
  if (!bad) console.log('  OK    ' + file + '  (' + n + ' inline block' + (n === 1 ? '' : 's') + ')');
}

process.exit(failures ? 1 : 0);
