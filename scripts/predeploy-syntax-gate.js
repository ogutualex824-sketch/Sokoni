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
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const failures = [];
let checked = 0;
let inlineChecked = 0;
let inlineSkipped = 0;

function check(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    checked++;
  } catch (e) {
    const msg = String((e.stderr && e.stderr.toString()) || e.message)
      .split('\n').filter((l) => l.trim()).slice(0, 3).join('\n      ');
    failures.push({ file: path.relative(ROOT, file), msg });
  }
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
    try {
      fs.writeFileSync(tmp, body);
      execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
      inlineChecked++;
    } catch (e) {
      const msg = String((e.stderr && e.stderr.toString()) || e.message)
        .split('\n').filter((l) => l.trim()).slice(0, 3).join('\n      ')
        .replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<inline>');
      failures.push({ file: path.relative(ROOT, file) + ' (inline <script> at line ' + line + ')', msg });
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

console.log('[predeploy] syntax gate — checking JavaScript…');
sweep(ROOT, 0);
sweep(path.join(ROOT, 'functions'), 1);
sweepHtml(ROOT, 0);

if (failures.length) {
  console.error('\n  DEPLOY BLOCKED — ' + failures.length + ' file(s) do not parse:\n');
  failures.forEach((f) => console.error('    ' + f.file + '\n      ' + f.msg + '\n'));
  console.error('  Fix the syntax and re-run. Nothing was deployed.\n');
  process.exit(1);
}

console.log('[predeploy] ' + checked + ' JavaScript files and ' + inlineChecked + ' inline <script> blocks parse cleanly'
  + (inlineSkipped ? ' (' + inlineSkipped + ' markup-building blocks skipped — regex extraction is ambiguous there).' : '.'));
process.exit(0);
