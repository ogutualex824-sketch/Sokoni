/* test-syntax-gate-classification.js — a crashed parser is never a syntax failure.
 *
 *   node scripts/test-syntax-gate-classification.js
 *
 * The syntax gate must answer one of three things about a `node --check` child:
 *   PASS       exit 0
 *   FAIL       exit 1 with a SyntaxError on stderr        (a fact about the code)
 *   UNPROVEN   signal / OOM / any other crash               (a fact about the machine → STOP)
 * 2026-09-30: an OOM child ("Fatal process out of memory") was reported as "does not parse".
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify, runCheck } = require('./predeploy-syntax-gate.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };

console.log('\nSYNTAX GATE — CLASSIFICATION');
console.log('='.repeat(60));

/* fabricated child results — the shapes spawnSync returns */
ck('exit 0 → PASS', classify({ status: 0, signal: null, stderr: '' }).kind === 'PASS');
ck('exit 1 + SyntaxError → FAIL', classify({ status: 1, signal: null, stderr: 'C:\\x\\a.js:3\n  foo(\n     ^\nSyntaxError: Unexpected end of input' }).kind === 'FAIL');
const oom = classify({ status: 134, signal: null, stderr: '\n#\n# Fatal process out of memory: Re-embedded builtins: set permissions\n#\n' });
ck('OOM child → UNPROVEN (never FAIL)', oom.kind === 'UNPROVEN', oom.kind);
ck('killed by signal → UNPROVEN', classify({ status: null, signal: 'SIGKILL', stderr: '' }).kind === 'UNPROVEN');
ck('spawn error (ENOENT / EAGAIN) → UNPROVEN', classify({ status: null, signal: null, error: new Error('spawn EAGAIN'), stderr: '' }).kind === 'UNPROVEN');
ck('VirtualAlloc failure → UNPROVEN', classify({ status: 1, signal: null, stderr: 'FATAL ERROR: VirtualAlloc Allocation failed - process out of memory' }).kind === 'UNPROVEN');
ck('exit 1 with SyntaxError AND an OOM banner → UNPROVEN (the crash wins)', classify({ status: 1, signal: null, stderr: 'SyntaxError: x\n# Fatal process out of memory' }).kind === 'UNPROVEN');
ck('exit 1 with no SyntaxError on stderr → UNPROVEN, not FAIL', classify({ status: 1, signal: null, stderr: 'internal/modules/cjs/loader: something else' }).kind === 'UNPROVEN');

/* real children */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-syntax-'));
const good = path.join(dir, 'good.js'); fs.writeFileSync(good, 'const a = 1;\nmodule.exports = a;\n');
const bad = path.join(dir, 'bad.js'); fs.writeFileSync(bad, 'function f( {\n');
const rg = classify(runCheck(good)), rb = classify(runCheck(bad));
ck('a real parseable file → PASS', rg.kind === 'PASS', rg.kind);
ck('a real syntax error → FAIL with the SyntaxError text', rb.kind === 'FAIL' && /SyntaxError/.test(rb.msg), rb.kind);
const missing = classify(runCheck(path.join(dir, 'missing.js')));
ck('a file node cannot open is not a syntax failure → UNPROVEN', missing.kind === 'UNPROVEN', missing.kind);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

/* the gate's contract, from its source */
const src = fs.readFileSync(path.join(__dirname, 'predeploy-syntax-gate.js'), 'utf8');
ck('the gate stops the sweep on UNPROVEN and never retries', /if \(unproven\) return;/.test(src) && /No retry is attempted/.test(src) && !/for \(let attempt/.test(src));
ck('the gate runs the environment preflight (--for syntax) before sweeping', /environment-preflight\.js'\), '--for', 'syntax'/.test(src));
ck('a real failure is labelled SYNTAX_FAIL, a crash SYNTAX_UNPROVEN — never conflated', /SYNTAX_FAIL — DEPLOY BLOCKED/.test(src) && /SYNTAX_UNPROVEN — the parser process crashed/.test(src));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
