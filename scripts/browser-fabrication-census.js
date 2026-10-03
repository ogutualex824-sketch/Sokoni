#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   GATE 13 — BROWSER FABRICATION CENSUS (read-only)
   ═══════════════════════════════════════════════════════════════════════════
   Finds every place client code (hosting .html/.js) writes a payment-success state — paid, completed,
   confirmed, verified, paymentStatus, isPaid — and prints each with context, so a human classifies it as:

     DISPLAY_ONLY       local UI text or a local cache that nothing authoritative reads as payment proof
     INITIATION_ONLY    the record of a payment being STARTED (pending), not finished
     SERVER_CONFIRMED   written only after a server/provider confirmation the client cannot forge
     BROWSER_AUTHORITY  the browser itself decides the payment succeeded  ← blocker

   Heuristic pre-labels are printed to speed review; the census file records the human verdict.

     node scripts/browser-fabrication-census.js [treePath] [--brief]
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..'));
const BRIEF = process.argv.includes('--brief');
const SKIP = new Set(['node_modules', '.git', 'functions', 'scripts', 'tests', 'test', 'docs', 'test-results', 'playwright-report', 'backups', 'coverage']);

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
                      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
                      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const WRITE = /(\bpaid\s*:\s*true|\bstatus\s*:\s*['"](paid|completed|confirmed|success)['"]|\bpaymentStatus\s*:\s*['"](paid|completed|confirmed)['"]|\bpaymentVerified\s*:\s*true|\bisPaid\s*:\s*true|\bstatus\s*=\s*['"](paid|completed)['"])/g;

function walk(d, o = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), o); }
    else if (/\.(html|js)$/.test(e.name)) o.push(path.join(d, e.name));
  }
  return o;
}

/* Pre-label from the surrounding code (±600 chars). A human confirms. */
function prelabel(ctx) {
  if (/setTimeout\(/.test(ctx) && /(confirmed|Confirmed|paid)/.test(ctx) && !/(verify|Verify|callVerify|posCheckPaymentStatus|verifyIntasendPayment|status\s*===\s*['"]completed['"])/.test(ctx)) return 'BROWSER_AUTHORITY?';
  if (/\.on\(\s*['"]COMPLETE['"]/.test(ctx) && !/(verifyIntasendPayment|callVerify|verifyPaymentStatus|posCheckPaymentStatus|httpsCallable)/.test(ctx)) return 'BROWSER_AUTHORITY?';
  if (/(onSuccess|outcome\s*===\s*['"]success['"])/.test(ctx) && /SokoniMpesa/.test(ctx)) return 'INITIATION_ONLY? (retired engine)';
  if (/(verifyIntasendPayment|callVerify|verifyPaymentStatus|posCheckPaymentStatus|onSnapshot|status\s*===\s*['"]completed['"])/.test(ctx)) return 'SERVER_CONFIRMED?';
  if (/(localStorage|sessionStorage)/.test(ctx)) return 'DISPLAY_ONLY? (local)';
  return 'REVIEW';
}

const rows = [];
for (const f of walk(ROOT)) {
  const raw = fs.readFileSync(f, 'utf8');
  const code = strip(raw);
  let m; WRITE.lastIndex = 0;
  while ((m = WRITE.exec(code))) {
    const line = code.slice(0, m.index).split('\n').length;
    const ctx = code.slice(Math.max(0, m.index - 600), m.index + 200);
    rows.push({ file: path.relative(ROOT, f).split(path.sep).join('/'), line, write: m[0], label: prelabel(ctx), text: raw.split('\n')[line - 1].trim().slice(0, 140) });
  }
}
const byLabel = rows.reduce((a, r) => ((a[r.label] = (a[r.label] || 0) + 1), a), {});
console.log('\nBROWSER FABRICATION CENSUS — ' + ROOT);
console.log('  ' + rows.length + ' client writes of a payment-success state in ' + new Set(rows.map((r) => r.file)).size + ' files');
Object.keys(byLabel).sort().forEach((k) => console.log('    ' + String(byLabel[k]).padStart(4) + '  ' + k));
if (!BRIEF) {
  console.log('');
  for (const r of rows.sort((a, b) => a.label.localeCompare(b.label) || a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log('  [' + r.label + '] ' + r.file + ':' + r.line + '  ' + r.write + '\n        ' + r.text);
  }
}
