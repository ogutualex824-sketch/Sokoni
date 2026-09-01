#!/usr/bin/env node
/**
 * POS BOOT BUDGET — how much JavaScript a till must parse before it can sell.
 *
 *   node scripts/test-pos-boot-budget.js
 *
 * WHY A BYTE BUDGET AND NOT A SCRIPT COUNT
 * perf-guard already counts scripts on pos.html. It reported 70 against a baseline of 63 —
 * and passed, because that particular check is warn-only. It measured the growth, said so,
 * and did not stop it. A count is also the wrong unit: ten small modules are not the problem,
 * one 200 KB module is. What correlates with the Android OOM crash on a low-memory till is
 * BYTES PARSED BEFORE FIRST INTERACTIVITY.
 *
 * WHAT THIS IS AND IS NOT
 * This is a RATCHET. It is not the whole fix. POS shipped 2,148 KB on 2026-09-01 and now
 * ships 1,987 KB after two lazy-loading slices; the remaining payload is still the defect.
 * It pins the number so the next change cannot quietly make it worse, and so each
 * improvement is measurable when it lands. The 560 KB printer stack is untouched.
 *
 * The budget is set marginally ABOVE today's measured size on purpose. A ratchet set below
 * reality fails immediately and gets disabled, which is how a gate becomes noise — and a
 * disabled gate protects nothing. It is tightened as the payload comes down, never loosened
 * to accommodate growth.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

/* Today's measured reality, pinned. LOWER these as modules move behind lazy loading.
   RAISING either number is a deliberate act that needs a reason in the commit. */
const BUDGET_KB = 2040;      /* 2,148 → 2,089 (ManagerAuth) → 1,987 (5 feature modules) */
const BUDGET_COUNT = 66;     /* 70 → 69 → 64 as modules moved behind lazy loading */
const BLOCKING_MAX = 4;      /* perf-guard baseline; a 5th blocking script delays first paint */

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

function measure (page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const tags = html.match(/<script[^>]*\bsrc=[^>]*>/g) || [];
  let bytes = 0, resolved = 0, unresolved = 0, blocking = 0;
  const sizes = [];
  tags.forEach((tag) => {
    /* type="module" is DEFERRED BY DEFAULT — it does not block the parser. An earlier
       version of this counter missed that and reported 5 blocking scripts against
       perf-guard's 4, which would have been a false failure about firebase.js. The page
       was right and the probe was wrong; adding `defer` to a module script would have
       been a no-op "fix" for a defect that did not exist. */
    const isModule = /\btype\s*=\s*["']module["']/.test(tag);
    if (!isModule && !/\bdefer\b|\basync\b/.test(tag)) blocking++;
    const m = tag.match(/src=["']([^"']+)["']/);
    if (!m) return;
    const file = m[1].replace(/^\//, '').split('?')[0];
    if (/^https?:/i.test(file)) return;          /* CDN — not our payload to pin */
    try {
      const b = fs.statSync(path.join(ROOT, file)).size;
      bytes += b; resolved++; sizes.push([b, file]);
    } catch (_) { unresolved++; }
  });
  sizes.sort((a, b) => b[0] - a[0]);
  return { count: tags.length, bytes, resolved, unresolved, blocking, sizes };
}

console.log(NL + 'POS BOOT BUDGET' + NL + '='.repeat(60));

const pos = measure('pos.html');
const kb = Math.round(pos.bytes / 1024);

head('1 · what a till parses before it can sell');
console.log('  scripts   : ' + pos.count + '   (blocking ' + pos.blocking + ')');
console.log('  payload   : ' + kb + ' KB');
console.log('  heaviest  :');
pos.sizes.slice(0, 5).forEach(([b, f]) =>
  console.log('    ' + String(Math.round(b / 1024)).padStart(4) + ' KB  ' + f));

ck('every script resolves on disk', pos.unresolved === 0,
   pos.unresolved + ' unresolved — a 404 on a till is a blank POS');
ck('the payload is within budget', kb <= BUDGET_KB,
   kb + ' KB of ' + BUDGET_KB + ' KB');
ck('the script count is within budget', pos.count <= BUDGET_COUNT,
   pos.count + ' of ' + BUDGET_COUNT);
ck('blocking scripts have not grown', pos.blocking <= BLOCKING_MAX,
   pos.blocking + ' of ' + BLOCKING_MAX + ' — a 5th delays first paint');

/* ── 2 · the ratchet must be able to bite ─────────────────────────────────── */
head('2 · the budget is a real constraint, not decoration');
ck('the budget is not set absurdly above reality', BUDGET_KB - kb < 300,
   'headroom ' + (BUDGET_KB - kb) + ' KB — a budget far above the measurement never fires');
ck('CONTROL the measurement is non-trivial', kb > 500 && pos.count > 10,
   'if this read near zero the extractor would be broken, not the page thin');

/* ── 3 · the concentrations worth naming ──────────────────────────────────── */
head('3 · where the weight actually is');
const printerKB = Math.round(pos.sizes
  .filter(([, f]) => /print|receipt|bluetooth/i.test(f))
  .reduce((n, [b]) => n + b, 0) / 1024);
console.log('  printer stack: ' + printerKB + ' KB across ' +
  pos.sizes.filter(([, f]) => /print|receipt|bluetooth/i.test(f)).length + ' modules');
ck('the printer stack is measured, so lazy-loading it is measurable',
   printerKB > 0);
/* This asserted the OPPOSITE until 2026-09-01: that the manager-auth module was part of the
   startup payload, as evidence that lazy-loading it would be a real saving. It is now lazy, so
   the assertion is inverted — the module must NOT be fetched to open a till, and the control
   is still present behind a shim. The saving is 59 KB. */
const eagerMgr = pos.sizes.some(([, f]) => /pos-manager-auth/.test(f));
ck('the manager-approval module is NOT in the startup payload', !eagerMgr,
   'a cashier reaches it only on a privileged operation; 60 KB to open a till is 60 KB wasted');
ck('CONTROL the control still exists — deferred, not deleted',
   fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8').indexOf("URL_ = 'pos-manager-auth.js'") > -1 &&
   fs.existsSync(path.join(ROOT, 'pos-manager-auth.js')),
   'lazy means the bytes move, never that the approval requirement goes away');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
console.log('  NOTE: this pins today\'s size. It is NOT a claim that POS boot is fixed.');
process.exit(fail ? 1 : 0);
