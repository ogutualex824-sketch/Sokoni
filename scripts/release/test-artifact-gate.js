/* ============================================================================
   CONTROLS — artifact-completeness reference extraction
   scripts/release/test-artifact-gate.js
   ============================================================================
   The gate decides what counts as a fetch. Widening it to runtime loaders means
   it now matches STRING ARGUMENTS, which is exactly how a reference checker
   starts reporting things nobody fetches. So every recognised form has a
   positive control and every rejected form has a negative one.

   The extraction logic is lifted from the gate's own source rather than
   retyped, so a pass here is a statement about the gate and not about a copy
   of it that could drift.

   POSITIVE — must be reported
     <script src="x.js">            attribute
     <link href="x.css">            attribute
     loadScript('x.js')             runtime loader
     lazyGlobal('Name', 'x.js')     runtime loader, filename is the 2nd arg
     await loadScript("x.js")       awaited call
     loadScript( 'x.js' )           whitespace

   NEGATIVE — must NOT be reported
     // loadScript('x.js')          whole-line comment
     /* loadScript('x.js') *​/       block comment
     const note = 'x.js'            string constant, no loader
     fetchScript('x.js')            a loader NOT on the allow-list
     https://cdn.example.com/x.js   absolute URL
     /__/firebase/x.js              Hosting reserved path

   RUN  node scripts/release/test-artifact-gate.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const GATE = path.resolve(__dirname, 'artifact-completeness.js');
const src = fs.readFileSync(GATE, 'utf8');

function lift(name, re) {
  const m = re.exec(src);
  if (!m) { console.error('could not lift ' + name + ' from the gate — did it change?'); process.exit(2); }
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

const ATTR    = lift('ATTR',    /const ATTR = (\/.*\/[gi]*);/);
const LOADER  = lift('LOADER',  /const LOADER = (\/.*\/[gi]*);/);
const ARGSTR  = lift('ARGSTR',  /const ARGSTR = (\/.*\/[gi]*);/);
const SKIP    = lift('SKIP',    /const SKIP = (\/.*\/[gi]*);/);
const RESERVED= lift('RESERVED',/const RESERVED = (\/.*\/[gi]*);/);

/* Lift the comment stripper too — a control that used its own copy would not
   prove the gate ignores comments. */
const stripSrc = /function stripComments\(body\) \{[\s\S]*?\n\}/.exec(src);
if (!stripSrc) { console.error('could not lift stripComments'); process.exit(2); }
// eslint-disable-next-line no-eval
const stripComments = eval('(' + stripSrc[0].replace('function stripComments', 'function') + ')');

/** Everything the gate would treat as a fetchable reference in one body. */
function extract(body) {
  const scan = stripComments(body);
  const out = [];
  const take = (raw) => {
    if (!raw || SKIP.test(raw) || RESERVED.test(raw)) return;
    const clean = raw.split('#')[0].split('?')[0];
    if (!/\.[a-z0-9]{2,5}$/i.test(clean)) return;
    out.push(clean);
  };

  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(scan)) !== null) take((m[1] != null ? m[1] : m[2] || '').trim());

  LOADER.lastIndex = 0;
  while ((m = LOADER.exec(scan)) !== null) {
    let a;
    ARGSTR.lastIndex = 0;
    while ((a = ARGSTR.exec(m[1])) !== null) {
      if (/\.[a-z0-9]{2,5}$/i.test(a[2])) take(a[2].trim());
    }
  }
  return out;
}

const BLOCK_OPEN = '/*';
const BLOCK_CLOSE = '*/';

const CASES = [
  /* ── positive ─────────────────────────────────────────────────────── */
  { pos: true, label: 'script src attribute',   body: '<script src="a.js"></script>',            want: 'a.js' },
  { pos: true, label: 'link href attribute',    body: '<link rel="stylesheet" href="b.css">',    want: 'b.css' },
  { pos: true, label: 'loadScript single quote',body: "  await loadScript('c.js').catch(function(){});", want: 'c.js' },
  { pos: true, label: 'loadScript double quote',body: '  await loadScript("d.js");',             want: 'd.js' },
  { pos: true, label: 'lazyGlobal second arg',  body: '  window.X = lazyGlobal("XName", "e.js");', want: 'e.js' },
  { pos: true, label: 'loadScript whitespace',  body: "  loadScript( 'f.js' )",                  want: 'f.js' },

  /* ── negative ─────────────────────────────────────────────────────── */
  { pos: false, label: 'whole-line // comment', body: "  // loadScript('g.js')",                 want: 'g.js' },
  { pos: false, label: 'block comment',         body: '  ' + BLOCK_OPEN + " loadScript('h.js') " + BLOCK_CLOSE, want: 'h.js' },
  { pos: false, label: 'bare string constant',  body: "  const note = 'i.js';",                  want: 'i.js' },
  { pos: false, label: 'loader not allow-listed', body: "  fetchScript('j.js');",                want: 'j.js' },
  { pos: false, label: 'absolute URL',          body: '<script src="https://cdn.example.com/k.js"></script>', want: 'k.js' },
  { pos: false, label: 'Hosting reserved path', body: '<script src="/__/firebase/9.22.2/l.js"></script>', want: 'l.js' },
];

let pass = 0, fail = 0;
console.log('\n' + '='.repeat(70));
console.log('  ARTIFACT GATE — REFERENCE EXTRACTION CONTROLS');
console.log('='.repeat(70));

for (const c of CASES) {
  const got = extract(c.body);
  const hit = got.some((r) => r.indexOf(c.want) !== -1);
  const ok = c.pos ? hit : !hit;
  console.log((ok ? '  ✓ ' : '  ✗ ') +
    (c.pos ? 'MUST REPORT   ' : 'MUST IGNORE   ') + c.label.padEnd(26) +
    (hit ? 'reported' : 'ignored'));
  ok ? pass++ : fail++;
}

/* A stripper that blanked everything would pass every negative control while
   proving nothing, so assert it leaves real code behind. */
const kept = stripComments("  loadScript('m.js');\n  // loadScript('n.js')\n");
const keptOk = kept.indexOf('m.js') !== -1 && kept.indexOf('n.js') === -1;
console.log((keptOk ? '  ✓ ' : '  ✗ ') +
  'CONTROL       stripper keeps code, drops the commented line');
keptOk ? pass++ : fail++;

console.log('='.repeat(70));
console.log('  passed ' + pass + '   failed ' + fail);
console.log(fail === 0
  ? '  RESULT: EXTRACTION CONTROLLED\n'
  : '  RESULT: NOT CONTROLLED — do not trust the gate’s output\n');
process.exit(fail === 0 ? 0 : 1);
