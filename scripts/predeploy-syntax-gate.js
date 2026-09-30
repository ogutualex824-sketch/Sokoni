#!/usr/bin/env node
/* Predeploy gate — refuse to ship JavaScript that does not parse.
 *
 * WHY THIS EXISTS
 * A syntax error reached production: comment prose sat outside its comment
 * block, `node --check` caught it, and the deploy went ahead anyway because the
 * check ran as a separate shell command rather than as part of the guarded
 * chain. script.js failing to parse takes the entire homepage with it — no
 * products, no cart, no navigation.
 *
 * The lesson is not "be more careful with && chains". It is that a deploy must
 * be structurally incapable of proceeding after a failed check. Firebase runs
 * predeploy hooks and aborts on a non-zero exit, so the gate belongs here where
 * it cannot be forgotten or reordered.
 *
 * A hook already existed (verify-commission-single-source.js) and checked
 * something else entirely. This extends that array rather than replacing it.
 *
 * SCOPE
 * Root-level browser scripts and functions/*.js. Deliberately fast — a gate
 * that takes a minute gets bypassed, which defeats it. Inline <script> blocks in
 * HTML ARE covered (a mangled regex once became a line comment and disabled a
 * boundary flag with no parse error anywhere) — except blocks that build markup,
 * where regex extraction is ambiguous and would produce false failures.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const failures = [];
let checked = 0;
let inlineChecked = 0;
let inlineSkipped = 0;

/* CLASSIFICATION — a child-process crash is never a syntax failure.
   On 2026-09-30 this gate reported "1 file(s) do not parse: functions/algolia-analytics.js" and
   blocked an authorized deploy. The child had printed "Fatal process out of memory": the machine
   was at its commit ceiling (parent-dead WebKit orphans), and the file parses. execFileSync threw
   the same way for a real SyntaxError and for a crashed child, so the two were indistinguishable.

     node --check exits 0                                   → SYNTAX_PASS
     node --check exits 1 with a SyntaxError on stderr      → SYNTAX_FAIL   (a code fact)
     node --check dies by signal / OOM / any other crash    → SYNTAX_UNPROVEN — STOP, no retry

   UNPROVEN stops the sweep at once: there is no point checking 1,700 more files on a machine that
   cannot spawn a parser, and retrying until it happens to fit would turn a machine state into a
   green light. Fix the machine (scripts/test-environment-preflight.js names the reason), re-run. */
const { spawnSync } = require('child_process');
let unproven = null;
function classify(r) {
  const err = String((r.stderr && r.stderr.toString()) || '');
  if (r.status === 0 && !r.signal) return { kind: 'PASS' };
  const crash = r.signal || r.error || /Fatal process out of memory|FATAL ERROR|VirtualAlloc|Allocation failed|Aborted|Segmentation fault/i.test(err);
  const syntax = /SyntaxError/.test(err);
  if (!crash && syntax && r.status === 1) return { kind: 'FAIL', msg: err };
  return { kind: 'UNPROVEN', msg: (r.error ? r.error.message + '\n' : '') + (r.signal ? 'signal ' + r.signal + '\n' : '') + err, status: r.status, signal: r.signal || null };
}
function runCheck(file) {
  return spawnSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 60000 });
}
function stopUnproven(file, c) {
  unproven = { file, msg: String(c.msg || '').split('\n').filter((l) => l.trim()).slice(0, 4).join('\n      '), status: c.status, signal: c.signal };
}

function check(file) {
  if (unproven) return;
  const c = classify(runCheck(file));
  if (c.kind === 'PASS') { checked++; return; }
  if (c.kind === 'UNPROVEN') { stopUnproven(path.relative(ROOT, file), c); return; }
  const msg = c.msg.split('\n').filter((l) => l.trim()).slice(0, 3).join('\n      ');
  failures.push({ file: path.relative(ROOT, file), msg });
}

/* INLINE <script> blocks in HTML.
   The gate used to check .js files only, so a broken inline script sailed straight through:
   a mangled regex became `//merchant(.html)?$/` — a line comment — which silently disabled an
   in-shell boundary flag with no parse error anywhere in the build. Inline scripts run just as
   much of the page as an external one, and a syntax error in <head> can stop a document dead.

   Skips non-JS script types (application/json, text/template, importmap) and module scripts
   with bare imports, which --check cannot resolve. Only genuine syntax errors fail. */
function checkInlineScripts(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  /* Blank out HTML comments FIRST. Comments routinely quote markup — index.html carries a note
     explaining "A <script> element with a src still requires a closing tag" — and the scanner
     would otherwise open a match inside that prose and close it at the next real </script>,
     reporting a syntax error in text the browser never executes. Newlines are preserved so the
     reported line numbers still point at the real file. */
  const html = raw.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, idx = 0;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '', body = m[2] || '';
    idx++;
    if (/\bsrc\s*=/i.test(attrs)) continue;                      /* external — swept as .js */
    if (/type\s*=\s*["']?(?!text\/javascript|application\/javascript|module)/i.test(attrs)) continue;
    if (/\bimport\s|\bexport\s/.test(body)) continue;            /* module semantics */
    if (!body.trim()) continue;
    /* A regex is not an HTML parser. When a script BUILDS markup — `'<script src=…>'` inside a
       string — extraction is ambiguous: the body we carve out can end mid-literal and then
       "fail" to parse for a reason that does not exist in the browser. Rather than emit a false
       DEPLOY BLOCKED (the fastest way to get a gate disabled), skip those and count them, so
       the limitation is visible instead of silently pretending to cover them. */
    if (/<\s*\/?\s*script|\\\/script/i.test(body)) { inlineSkipped++; continue; }
    const line = html.slice(0, m.index).split('\n').length;
    const tmp = path.join(os.tmpdir(), 'sk-inline-' + process.pid + '-' + idx + '.js');
    if (unproven) return;
    try {
      fs.writeFileSync(tmp, body);
      const c = classify(runCheck(tmp));
      if (c.kind === 'PASS') inlineChecked++;
      else {
        const clean = (s) => String(s || '').replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<inline>');
        if (c.kind === 'UNPROVEN') { stopUnproven(path.relative(ROOT, file) + ' (inline <script> at line ' + line + ')', Object.assign({}, c, { msg: clean(c.msg) })); return; }
        const msg = clean(c.msg).split('\n').filter((l) => l.trim()).slice(0, 3).join('\n      ');
        failures.push({ file: path.relative(ROOT, file) + ' (inline <script> at line ' + line + ')', msg });
      }
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
}

function sweepHtml(dir, depth) {
  if (depth > 2) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (/^(node_modules|\.git|dist|build|\.firebase|\.claude|Temp|temp)$/.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { sweepHtml(full, depth + 1); continue; }
    if (!/\.html$/i.test(e.name)) continue;
    checkInlineScripts(full);
  }
}

function sweep(dir, depth) {
  if (depth > 2) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    /* Temp/ holds scratch extracts that are never deployed. Gating on files
       hosting does not serve would block every deploy for no safety gain. */
    if (/^(node_modules|\.git|dist|build|\.firebase|\.claude|Temp|temp)$/.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { sweep(full, depth + 1); continue; }
    if (!e.name.endsWith('.js')) continue;
    /* ES modules and browser globals still parse under --check; only genuine
       syntax errors fail, which is exactly what this gate is for. */
    check(full);
  }
}

/* As a module (scripts/test-syntax-gate-classification.js) only the classifier is exported; the
   sweep runs when this file is the entry point. */
if (require.main !== module) { module.exports = { classify, runCheck }; return; }

console.log('[predeploy] syntax gate — checking JavaScript…');
/* Resource preflight FIRST: a parser sweep on a machine at its commit ceiling dies halfway and
   proves nothing. RAM / orphan / node-capacity only (--for syntax); fail closed. */
{
  const pf = spawnSync(process.execPath, [path.join(__dirname, 'test-environment-preflight.js'), '--for', 'syntax'], { encoding: 'utf8', timeout: 120000 });
  process.stdout.write(String(pf.stdout || ''));
  if (pf.status !== 0) {
    console.error('\n  SYNTAX_UNPROVEN — environment not fit to run the parser sweep (see RESULT above).');
    console.error('  Nothing was checked, nothing was deployed. Fix the machine, then re-run.\n');
    process.exit(1);
  }
}
sweep(ROOT, 0);
sweep(path.join(ROOT, 'functions'), 1);
sweepHtml(ROOT, 0);

if (unproven) {
  console.error('\n  SYNTAX_UNPROVEN — the parser process crashed; this is a MACHINE state, not a syntax result.\n');
  console.error('    stopped at ' + unproven.file + '\n      exit=' + unproven.status + ' signal=' + unproven.signal + '\n      ' + unproven.msg + '\n');
  console.error('  ' + checked + ' files and ' + inlineChecked + ' inline blocks had passed before the crash; the rest were NOT checked.');
  console.error('  No retry is attempted. Run scripts/test-environment-preflight.js --for syntax, fix the reason it names, re-run.\n');
  process.exit(1);
}

if (failures.length) {
  console.error('\n  SYNTAX_FAIL — DEPLOY BLOCKED — ' + failures.length + ' file(s) do not parse (SyntaxError from node --check):\n');
  failures.forEach((f) => console.error('    ' + f.file + '\n      ' + f.msg + '\n'));
  console.error('  Fix the syntax and re-run. Nothing was deployed.\n');
  process.exit(1);
}

console.log('[predeploy] ' + checked + ' JavaScript files and ' + inlineChecked + ' inline <script> blocks parse cleanly'
  + (inlineSkipped ? ' (' + inlineSkipped + ' markup-building blocks skipped — regex extraction is ambiguous there).' : '.'));
process.exit(0);
