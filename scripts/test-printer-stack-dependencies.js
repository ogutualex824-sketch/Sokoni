#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   PRINTER STACK DEPENDENCIES

   sokoni-printer-manager.js is a THIN WRAPPER over the universal engine:

       get connected () { return !!(window.SokoniPrinter?.connected); }
       printRaw (bytes) { return _eng().printRaw(bytes); }
       function _eng () { if (!window.SokoniPrinter) throw ...('not loaded'); }

   sokoni-pos-print-service.js has the same dependency: its _eng() IS
   window.SokoniPrinter, and _sendBytes writes through SokoniPrinter.printRaw.

   So a page that loads either WITHOUT sokoni-universal-printer.js gets a stack that
   reports "not connected" FOREVER and throws on every call. That is exactly what
   happened to pos.html — the till had a wrapper around a missing engine, which is
   indistinguishable from a printer fault unless you read the script tags.

   This gate exists so the next page cannot repeat it.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE  = 'sokoni-universal-printer.js';
const WRAPPERS = ['sokoni-printer-manager.js', 'sokoni-pos-print-service.js'];

let pass = 0, fail = 0, invalid = 0;
const ok = (l, d) => { pass++; console.log('  PASS       ' + l + (d ? '   [' + d + ']' : '')); };
const no = (l, d) => { fail++; console.log('  FAIL       ' + l + (d ? '   [' + d + ']' : '')); };
const ck = (l, c, d) => (c ? ok(l, d) : no(l, d));
const head = (t) => console.log('\n-- ' + t + ' --');

const loadsScript = (html, name) =>
  new RegExp('src=["\\\']/?' + name.replace(/[.]/g, '[.]') + '["\\\']').test(html);

head('0 - harness integrity');
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
ck('HTML pages found', pages.length > 0, pages.length + ' pages');

/* A control: the detector must actually SEE a known-good page, or a green result
   below would only mean the regex matches nothing anywhere. */
const known = fs.existsSync(path.join(ROOT, 'pos-printer-setup.html'))
  ? fs.readFileSync(path.join(ROOT, 'pos-printer-setup.html'), 'utf8') : '';
ck('CONTROL detector sees a page that DOES load the engine',
   known && loadsScript(known, ENGINE),
   'pos-printer-setup.html - if this fails the scan below is vacuous');

head('1 - every page using the wrapper must load the engine');
const violations = [];
const users = [];
pages.forEach(function (p) {
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const uses = WRAPPERS.filter((w) => loadsScript(html, w));
  if (!uses.length) return;
  users.push(p);
  if (!loadsScript(html, ENGINE)) violations.push({ page: p, uses: uses.join(', ') });
});

ck('at least one page uses the printer stack', users.length > 0,
   users.length + ' pages: ' + users.join(', '));

if (violations.length) {
  violations.forEach(function (v) {
    no('MISSING ENGINE: ' + v.page, 'loads ' + v.uses + ' but not ' + ENGINE);
  });
} else {
  ok('no page loads a wrapper without the engine', users.length + ' checked');
}

head('2 - the engine must load BEFORE its wrappers (defer preserves order)');
users.forEach(function (p) {
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  if (!loadsScript(html, ENGINE)) return;          /* already reported above */
  /* Compare SCRIPT TAG positions, not bare filename positions. A filename mentioned in
     a COMMENT would otherwise be read as a load site — which is exactly what happened
     here: an explanatory comment naming sokoni-printer-manager.js sat before the real
     tag and made a correctly-ordered page look mis-ordered. */
  const tagAt = (name) => {
    const m = html.match(new RegExp('<script[^>]*src=["\\\']/?' + name.replace(/[.]/g, '[.]') + '["\\\']'));
    return m ? m.index : -1;
  };
  const iEng = tagAt(ENGINE);
  ck(p + ': engine script tag located', iEng > -1, 'if -1 the ordering checks below are vacuous');
  WRAPPERS.forEach(function (w) {
    if (!loadsScript(html, w)) return;
    const iW = tagAt(w);
    ck(p + ': engine precedes ' + w, iEng > -1 && iW > -1 && iEng < iW, 'eng@' + iEng + ' wrapper@' + iW);
  });
});

head('what this suite does NOT prove');
console.log('  UNPROVEN   that a physical printer connects   [needs the handset]');
console.log('  NOTE       pos-hardware-setup.html uses a SEPARATE stack (SokoniHardware,');
console.log('             14 scripts) and is deliberately out of scope here.');

console.log('\n' + '-'.repeat(62));
console.log('  PASS ' + pass + '   FAIL ' + fail + '   HARNESS-INVALID ' + invalid);
process.exit((fail || invalid) ? 1 : 0);
