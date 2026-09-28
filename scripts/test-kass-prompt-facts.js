#!/usr/bin/env node
/* test-kass-prompt-facts.js — the public KASS prompt states no unverifiable commercial facts.
 *
 *   node scripts/test-kass-prompt-facts.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-kass-prompt-facts.js  # functions/index.js @ 4e9607b — failures ARE the defect
 *
 * Owner rule (2026-09-28): KASS must never invent delivery prices, must not claim all sellers are vetted unless the
 * underlying state proves it, and must not state facts no SOKONI authority backs. The prompt told every customer
 * "Delivery cost: From KES 150 (bike) to KES 800+", "All sellers vetted. Buyers protected by escrow" (the code notes
 * the escrows collection is empty in production), a "7-day hassle-free return", "17 cars", and to "flag 20%+ savings"
 * and "mention loyalty points earnable" with no tool supplying either.
 *
 * PROVES
 *   F1  no delivery price or delivery time is stated
 *   F2  no blanket "all sellers vetted" / "vetted buyers" claim and no escrow promise
 *   F3  no return window is promised (it defers to the Refund Policy)
 *   F4  no invented inventory count ("17 cars") and no invented savings / loyalty figures
 *   F5  the guardrails are present: delivery is computed at checkout; verified/escrow only from tools; returns from
 *       knowledge results; value claims only from returned results
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const X = require('./lib/xss-probe');
const ROOT = path.resolve(__dirname, '..');
const CPM = !!process.env.COUNTERPROOF;
const IDX = CPM ? cp.execFileSync('git', ['show', '4e9607b:functions/index.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256e6 }) : fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 240) : '')); } };
const P = X.tplAt(IDX, 'const systemPrompt = `You are KASS');
const hits = (re) => (P.match(re) || []);

console.log('\nSOURCE: functions/index.js @ ' + (CPM ? '4e9607b (before) — failures below ARE the defect' : 'working tree (fix)'));
ck('F1  no delivery price or delivery time is stated', hits(/Delivery (cost|fee|times?)[^\n]{0,80}(KES\s?\d|\d+\s?(day|hour)s?|Same-day)/gi).length === 0, hits(/Delivery (cost|fee|times?)[^\n]{0,80}/gi));
ck('F2  no blanket "vetted" claim and no escrow promise', hits(/All sellers vetted|vetted buyers|protected by escrow/gi).length === 0, hits(/All sellers vetted|vetted buyers|protected by escrow/gi));
ck('F3  no return window is promised', hits(/\d+-day[^\n]{0,20}return|hassle-free return/gi).length === 0, hits(/\d+-day[^\n]{0,30}/gi));
ck('F4  no invented inventory count or savings / loyalty figures', hits(/\b17 cars\b|flag 20%|loyalty points earnable/gi).length === 0, hits(/\b17 cars\b|flag 20%|loyalty points earnable/gi));
ck('F5  the guardrails are present',
  /NEVER quote a delivery price or delivery time/.test(P) && /never describe a payment as held in escrow/.test(P)
  && /Quote a return window or refund rule ONLY from your knowledge results/.test(P) && /ONLY among the results your tools actually returned/.test(P));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
