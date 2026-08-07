#!/usr/bin/env node
/**
 * Money-path toast-safety guard.
 *
 * Flags the "swallow-then-succeed" antipattern on FINANCIAL operations:
 *
 *     await _call("finosReleaseEscrow", {...}).catch(e => _toast(e.message, "error"));
 *     _toast("Escrow released", "success");   // <-- fires even when the call failed
 *
 * A failed irreversible money action must NEVER show a success toast. The correct
 * shape branches on outcome:
 *
 *     try { await _call("finosReleaseEscrow", {...}); }
 *     catch (e) { _toast(e.message, "error"); return; }
 *     _toast("Escrow released", "success");
 *
 * Rule: on a money-related backend call, an INLINE `.catch(... _toast ...)` swallows the
 * error and lets execution fall through to a success toast. Money actions must use
 * try/catch instead. Read-only fallbacks (`.catch(() => default)`, no toast) are allowed.
 *
 * Exit 1 if any violation is found. Wire into predeploy / CI.
 * Scope is intentionally MONEY-ONLY (see docs/DESIGN_SYSTEM_CONSISTENCY_AUDIT.md and
 * memory project_escrow_success_toast_defect); non-money admin ops share the shape at
 * lower severity and are tracked separately.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
/* Backend-name keywords that mean "money moves". */
const MONEY = /(escrow|payout|refund|dispute|commission|settle|withdraw|disburse|bankpayout)/i;
/* A call site that swallows the error into a toast (vs a silent read fallback). */
const INLINE_CATCH_TOAST = /await\b[^\n]*\)\s*\.catch\s*\([^)]*(_toast|Toast|showToast)[^\n]*/i;

const EXTS = new Set(['.js', '.html', '.mjs']);
const SKIP_DIR = /(^|[\\/])(node_modules|\.git|dist|build|coverage)([\\/]|$)/;
const SKIP_FILE = /\.min\.(js|css)$/;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (SKIP_DIR.test(full)) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(name)) && !SKIP_FILE.test(name)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(ROOT)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return; // comment/doc example
    if (!INLINE_CATCH_TOAST.test(line)) return;   // not a swallow-to-toast call
    if (!MONEY.test(line)) return;                // not a money-related call
    violations.push({
      file: path.relative(ROOT, file),
      line: i + 1,
      text: line.trim().slice(0, 120),
    });
  });
}

if (violations.length) {
  console.error('\n✗ Money-path toast-safety: ' + violations.length + ' violation(s) — a failed');
  console.error('  financial call can fall through to a success toast. Use try/catch (branch on');
  console.error('  outcome), not an inline .catch that swallows the error.\n');
  for (const v of violations) console.error('  ' + v.file + ':' + v.line + '  ' + v.text);
  console.error('');
  process.exit(1);
}
console.log('✓ Money-path toast-safety: no swallow-then-succeed on financial calls.');
