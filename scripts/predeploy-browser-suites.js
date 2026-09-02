#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   REQUIRED RELEASE SUITES — they must EXECUTE, not merely be discoverable.
   ══════════════════════════════════════════════════════════════════════════════
   THE FAILURE THIS EXISTS TO PREVENT (observed 2026-08-31)

   A Hosting release reported "GATE PASSED" and DEPLOY EXIT 0 while the browser
   certification suites had not run at all. They were auto-discovered by
   test-inventory.js — but test-inventory only runs when gate-inventory decides the
   change touches inventory:

       [gate-inventory] SKIPPED — none of 12 changed file(s) touch inventory.
       suite result lines: 0

   So a MiniShop, cart or overlay release skipped exactly the suites written to
   certify it, and the verdict still read PASSED. Nothing lied; the verdict simply
   described the other hooks. That is the worst kind of green: accurate, and
   completely misleading about the thing you cared about.

   This runs the required suites DIRECTLY in the hosting predeploy chain, so their
   execution does not depend on which files a particular change happened to touch.

   IT FAILS CLOSED, DELIBERATELY

   A suite that cannot run is not a pass. If the browser runner is unavailable the
   suites report ENV, and ENV here BLOCKS the release rather than waving it through —
   because these prove runtime properties (a control is clickable, no layer blocks
   the panel) that no static check can stand in for. An UNPROVEN release is not a
   green one.

   It does NOT touch gate-inventory, whose conditional behaviour is correct for the
   inventory gate, and it changes no financial hook.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

/* Required for a Hosting release. Each must EXECUTE and report zero failures. */
const REQUIRED = [
  { f: 'test-merchant-route-overlays.js',        why: 'no full-viewport layer blocks any merchant route',      browser: true,  ms: 600000 },
  { f: 'test-cart-browser-certification.js',     why: 'product card → cart is clickable, mobile and desktop',  browser: true,  ms: 300000 },
  { f: 'test-minishop-cart-browser.js',          why: 'MiniShop Add to Cart reaches the one cart',             browser: true,  ms: 240000 },
  { f: 'test-minishop-trust-honesty.js',         why: 'no trust badge without an authoritative source',        browser: true,  ms: 240000 },
  { f: 'test-merchant-v2-persistence-browser.js',why: 'route and device state survive a real reload',          browser: true,  ms: 240000 },
  { f: 'test-multicart-purchase-authority.js',   why: 'the client never asserts an amount',                    browser: false, ms: 120000 },
  { f: 'test-merchant-v2-persistence.js',        why: 'the shell persistence contract',                        browser: false, ms: 120000 },
  { f: 'test-merchant-consent-lifecycle.js',     why: 'consent is required, completable, and non-blocking',    browser: false, ms: 120000 },
  { f: 'test-pos-print-delegation.js',           why: 'a receipt reports what actually happened',              browser: false, ms: 120000 },
  { f: 'test-merchant-shell-callables.js',       why: 'every callable the shell names exists',                 browser: false, ms: 120000 },
  { f: 'test-availability-convergence.js',       why: 'one canonical schedule governs both surfaces',          browser: false, ms: 120000 },
  { f: 'test-inshell-chrome.js', why: 'framed modules must not paint shell chrome — the black layer', browser: false, ms: 120000 },
  { f: 'test-tenant-convergence-handler-surface.js', why: '_requireSeller moves the tenant key for 20 handlers', browser: false, ms: 120000 },
  { f: 'test-pos-entry-setup-first.js', why: 'the shell opens POS setup before selling, once', browser: false, ms: 120000 },
  { f: 'test-pos-inventory-denial-visibility.js', why: 'a denied POS inventory write must be observable', browser: false, ms: 120000 },
  { f: 'test-stock-adjustment-authority.js', why: 'stock adjustment ownership and transaction shape', browser: false, ms: 120000 },
  { f: 'test-approval-primitive.js', why: 'the approval binding names the exact operation and target', browser: false, ms: 120000 },
  { f: 'test-shop-card-actions.js', why: 'the shop cards reuse the canonical marketplace action rows', browser: false, ms: 120000 },
  { f: 'test-shop-details-convergence.js', why: 'every Shop Details field is schema-backed and saves once', browser: false, ms: 120000 },
  { f: 'test-shop-logo-identity.js', why: 'the shop logo reserves its space, scales, and is announced', browser: false, ms: 120000 },
  { f: 'test-pos-till-registry.js', why: 'saved is not connected', browser: false, ms: 120000 },
  { f: 'test-pos-boot-budget.js', why: 'the till boots inside budget', browser: false, ms: 120000 },
  { f: 'test-pos-lazy-manager-auth.js', why: 'manager auth loads lazily', browser: false, ms: 120000 },
  { f: 'test-pos-lazy-features.js', why: 'lazy modules stay off the boot path', browser: false, ms: 120000 },
  { f: 'test-pos-barcode-path.js', why: 'the scan path reaches the cart', browser: false, ms: 120000 },
  { f: 'test-premium-scanner.js', why: 'the scanner contract', browser: false, ms: 120000 },
  { f: 'test-sales-control-centre.js', why: 'the manager control surface', browser: false, ms: 120000 },
  { f: 'test-pos-sales-view.js', why: 'the sales view reads canonical data', browser: false, ms: 120000 },
  { f: 'test-adminos-authority-honesty.js', why: 'a refused admin action can never render as a completed one', browser: false, ms: 120000 },
  { f: 'test-adminos-tier1-dead-controls.js', why: 'the five dead AdminOS controls report failure, not success', browser: false, ms: 120000 },
  { f: 'test-adminos-tier2-action-honesty.js', why: 'a success toast is emitted only after the callable resolves', browser: false, ms: 120000 },
];

console.log(NL + '[predeploy] required release suites — ' + REQUIRED.length + ' declared');

const rows = [];
let blocked = 0;

/* Each browser suite launches its own WebKit and its own HTTP server. Run back to back,
   a later suite met a browser that had 'been closed' mid-run, a hung launch, and clicks
   that could not land — while every one of them passed ALONE. The suites were not flaky;
   the runner was starving them. Let the previous one's processes reap before the next. */
const COOLDOWN_MS = 5000;
/* A REAL sleep, not a spin. The first version burned a core for the whole cooldown,
   which is the opposite of letting the previous suite's processes reap — it made the
   contention it was meant to relieve. Atomics.wait blocks without consuming CPU, and
   spawnSync is synchronous so there is nothing to await. */
const sleep = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const until = Date.now() + ms; while (Date.now() < until) {} }
};

for (const s of REQUIRED) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', s.f)],
    { cwd: ROOT, encoding: 'utf8', timeout: s.ms, maxBuffer: 1024 * 1024 * 24 });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (s.browser) sleep(COOLDOWN_MS);
  const out = String((r.stdout || '') + (r.stderr || ''));

  /* the suite's own tally is the evidence — an exit code alone cannot show
     whether anything was asserted */
  const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  const passed = m ? Number(m[1]) : null;
  const failed = m ? Number(m[2]) : null;
  const envd   = /\bENV\b/.test(out) && (passed === null || passed === 0);

  let verdict;
  if (r.error && r.error.code === 'ETIMEDOUT') verdict = 'TIMEOUT';
  else if (envd)                               verdict = 'UNPROVEN';
  else if (m === null)                         verdict = 'NO-TALLY';
  else if (failed > 0)                         verdict = 'FAIL';
  else if (passed === 0)                       verdict = 'EMPTY';
  else                                         verdict = 'EXECUTED';

  if (verdict !== 'EXECUTED') blocked++;
  /* A verdict without evidence cannot be acted on. When a suite does not execute
     cleanly, keep the tail of what it DID say — that is the difference between
     'something went wrong' and a diagnosis. */
  const tail = verdict === 'EXECUTED' ? null
    : out.split(NL).filter((l) => l.trim()).slice(-6).join(NL + '            ');
  rows.push({ f: s.f, verdict, passed, failed, secs, why: s.why, tail,
              exit: r.status, sig: r.signal || null });
}

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('');
rows.forEach((r) => {
  console.log('  ' + pad(r.verdict, 9) + pad(r.f, 44) +
    (r.passed === null ? '' : r.passed + '/' + r.failed) + '  ' + r.secs + 's');
  if (r.verdict !== 'EXECUTED') {
    console.log('            ^ ' + r.why);
    console.log('            exit=' + r.exit + ' signal=' + r.sig);
    if (r.tail) console.log('            ' + r.tail);
  }
});

console.log('');
if (blocked === 0) {
  console.log('  required browser suites : EXECUTED (' + rows.filter((r) => r.verdict === 'EXECUTED').length + '/' + rows.length + ')');
  console.log('  browser assertions      : 0 FAIL');
  console.log('  [predeploy] REQUIRED SUITES APPROVED');
  process.exit(0);
}

console.log('  RELEASE BLOCKED — ' + blocked + ' required suite(s) did not execute cleanly.');
console.log('');
console.log('  UNPROVEN / TIMEOUT / EMPTY are NOT passes. These prove runtime properties');
console.log('  no static check replaces — a control being clickable, a panel not being');
console.log('  covered. A release that could not run them is not a green release.');
console.log('  Do not bypass: fix the suite or the environment it needs.');
process.exit(1);
