#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   INTASEND-ONLY PAYMENT GATE — read-only evidence for one source tree
   ═══════════════════════════════════════════════════════════════════════════
   Owner direction 2026-10-03: SOKONI payments are IntaSend everywhere; Daraja is not an active rail; the
   browser never manufactures a paid/completed state or a payment reference; every functions deploy names its
   functions explicitly until all trees converge.

     node scripts/intasend-only-gate.js [treePath] [--json]

   Classifies every Daraja reference (comment-stripped code) as:
     ACTIVE      executable Daraja: a Daraja export / callable name / Safaricom endpoint / Daraja config read
     HISTORY     comments and docs only (not counted)
   and separately reports:
     OLD_GUARD   scripts/deploy/guard-functions-safety.js still protects Daraja (a different migration condition)
     FABRICATE   client code that invents a payment: SIMULATED_ refs, or a timer that announces payment / writes paid
     BLANKET     a script that runs `firebase deploy` for functions without --only
   initiateSTKPush is IntaSend (generic name) and is reported as allowed, never as Daraja.
   Exit 0 only when ACTIVE, OLD_GUARD and FABRICATE are all empty. Never writes anything.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..'));
const JSON_OUT = process.argv.includes('--json');
const SKIP = new Set(['node_modules', '.git', '.firebase', 'docs', 'tests', 'test', 'test-results', 'playwright-report', 'backups', 'coverage', 'lib']);

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

function walk(dir, out = [], depth = 0) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      if (depth === 0 && e.name === 'scripts') continue;   /* scripts are scanned separately */
      walk(path.join(dir, e.name), out, depth + 1);
    } else if (/\.(html|js|mjs)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

const DARAJA_ACTIVE = [
  /exports\.(darajaSTKPush|darajaSTKCallback|validateDarajaCredentials|sendTestSTKPush|webhookMpesa|mpesaC2BValidation|mpesaC2BConfirmation)\s*=/,
  /['"`](darajaSTKPush|darajaSTKCallback|validateDarajaCredentials|sendTestSTKPush|webhookMpesa|mpesaC2BValidation|mpesaC2BConfirmation)['"`]/,
  /(api|sandbox)\.safaricom\.co\.ke|oauth\/v1\/generate|mpesa\/stkpush|mpesa\/c2b/,
  /process\.env\.DARAJA_|darajaConsumerKey|darajaConsumerSecret|darajaPassKey|_darajaToken/,
  /require\(\s*['"]\.\/mpesa-c2b['"]\s*\)/,
  /Safaricom Daraja|Daraja (API|portal|credentials)|developer\.safaricom\.co\.ke/,
];
const FABRICATE = [
  /['"`]SIMULATED_['"`]\s*\+/,
  /setTimeout\([^;]{0,400}?(Payment confirmed|Payment Confirmed|paid\s*:\s*true|status\s*:\s*['"](paid|completed)['"])/,
];

const files = walk(ROOT);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const result = { tree: ROOT, files: files.length, active: [], fabricate: [], intasendStk: 0, oldGuard: null, blanket: [], history: 0 };

for (const f of files) {
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  const code = strip(raw);
  if (/daraja/i.test(raw) && !/daraja/i.test(code)) result.history++;
  for (const re of DARAJA_ACTIVE) { const m = code.match(re); if (m) { result.active.push(rel(f) + ': ' + m[0].slice(0, 60)); break; } }
  for (const re of FABRICATE) { const m = code.match(re); if (m) { result.fabricate.push(rel(f) + ': ' + m[0].replace(/\s+/g, ' ').slice(0, 70)); break; } }
  if (/initiateSTKPush/.test(code)) result.intasendStk++;
}

/* the old guard is a separate migration condition */
const guardPath = path.join(ROOT, 'scripts', 'deploy', 'guard-functions-safety.js');
if (fs.existsSync(guardPath)) {
  const g = fs.readFileSync(guardPath, 'utf8');
  if (/_DARAJA_SANDBOX_SELLER_UIDS|darajaSTKPush must REFUSE/.test(g)) result.oldGuard = 'protects Daraja (pre-2026-10-03)';
  else if (/retired rails stay retired|no Daraja function is exported/.test(g)) result.oldGuard = null, result.guard = 'Daraja-absent guard';
  else result.guard = 'unrecognised guard';
} else result.guard = 'no guard file';

/* blanket functions deploys in scripts */
const scriptsDir = path.join(ROOT, 'scripts');
(function scan(d) {
  let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) scan(p); continue; }
    if (!/\.(sh|js|mjs|ps1|cmd|bat)$/.test(e.name)) continue;
    /* JS files are comment-stripped, so prose that mentions `firebase deploy` is not a command. */
    const s = /\.(js|mjs)$/.test(e.name) ? strip(fs.readFileSync(p, 'utf8')) : fs.readFileSync(p, 'utf8');
    for (const line of s.split('\n')) {
      if (/firebase\s+deploy/.test(line) && /functions/.test(line) && !/--only/.test(line) && !/^\s*(#|\/\/|\*)/.test(line)) {
        result.blanket.push(rel(p) + ': ' + line.trim().slice(0, 80)); break;
      }
      if (/firebase\s+deploy\s*(["'`]|$)/.test(line) && !/--only/.test(line) && !/^\s*(#|\/\/|\*)/.test(line)) { result.blanket.push(rel(p) + ': ' + line.trim().slice(0, 80)); break; }
    }
  }
}(scriptsDir));

const clean = !result.active.length && !result.fabricate.length && !result.oldGuard;
if (JSON_OUT) { console.log(JSON.stringify(Object.assign(result, { clean }))); process.exit(clean ? 0 : 1); }
console.log('\nINTASEND-ONLY GATE — ' + ROOT + '  (' + result.files + ' files)');
const list = (label, arr) => { console.log('  ' + label + ': ' + arr.length); arr.slice(0, 12).forEach((x) => console.log('      ' + x)); if (arr.length > 12) console.log('      … ' + (arr.length - 12) + ' more'); };
list('ACTIVE Daraja (code)', result.active);
list('FABRICATED payment (client)', result.fabricate);
console.log('  OLD Daraja guard: ' + (result.oldGuard || 'no') + (result.guard ? '   [' + result.guard + ']' : ''));
list('BLANKET functions deploy scripts', result.blanket);
console.log('  allowed: initiateSTKPush (IntaSend) in ' + result.intasendStk + ' files · history-only Daraja mentions in ' + result.history + ' files');
console.log('  ' + (clean ? 'CLEAN' : 'NOT CLEAN') + '\n');
process.exit(clean ? 0 : 1);
