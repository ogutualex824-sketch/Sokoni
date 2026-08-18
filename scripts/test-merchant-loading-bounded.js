#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   NO UNBOUNDED LOADING STATE — a surface must always reach an outcome
   ------------------------------------------------------------------------------
   The authenticated containment gate found two surfaces still showing a loading
   state after 25 seconds:

     Availability  a .sk-line skeleton — styling with no text — and an empty
                   `.catch(function () {})` that swallowed whatever went wrong.
     Returns       "Authenticating…", behind an unguarded forced token refresh
                   sitting between the auth callback and the ONLY line that
                   dismisses the loading screen.

   Both had the same shape: an async step with no deadline and no failure path,
   gating the sole exit from a loading screen. Neither could ever say anything
   went wrong, because the code that would say so was never reached — and in
   Returns' case _returnsError() writes into #app-root, which is display:none
   until the very line that would have dismissed the spinner.

   This is a SOURCE-CONTRACT test, deliberately. Reproducing the failure needs a
   stalled backend against a real authenticated production session, which is not
   something a regression suite should require to protect the invariant. What it
   pins is the structure that made an indefinite spinner possible:

     · the load is bounded by a deadline
     · a failure renders an explicit, human-readable state
     · that state offers a way out
     · no empty catch swallows the reason

   Negative controls in section 3 re-introduce each defect against a copy of the
   source and require this suite to reject it.

     node scripts/test-merchant-loading-bounded.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail) => {
  console.log('    ' + (cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 90) + ']' : ''));
  if (cond) pass++; else { fail++; failures.push(label + (detail ? '  → ' + detail : '')); }
  return cond;
};

/* Only the Availability block, so a stray `.catch(function () {})` elsewhere in a
   3,000-line shell neither passes this nor fails it by accident. */
const sliceAvailability = (src) => {
  const a = src.indexOf('function _avLoad');
  if (a < 0) return null;
  const b = src.indexOf('function _avPaint', a);
  return b > a ? src.slice(a, b) : src.slice(a, a + 4000);
};
/* Returns' auth callback, from the handler to the line that dismisses the spinner. */
const sliceReturnsAuth = (src) => {
  const a = src.indexOf('auth.onAuthStateChanged');
  if (a < 0) return null;
  const b = src.indexOf("getElementById('auth-loading').style.display = 'none'", a);
  return b > a ? src.slice(a, b) : src.slice(a, a + 6000);
};

const merchantSrc = fs.readFileSync(path.join(ROOT, 'merchant.html'), 'utf8');
const returnsSrc  = fs.readFileSync(path.join(ROOT, 'returns.html'), 'utf8');

console.log('\n' + '='.repeat(72));
console.log('  NO UNBOUNDED LOADING STATE');
console.log('='.repeat(72));

/* THE CONTRACT, as pure predicates over source. Stated once, so section 1-2 can assert
   each holds for the real files and section 3 can assert each FAILS for a source with the
   defect re-introduced. A predicate that cannot be made to fail is decorative, and the
   only way to know is to try. */
const RULES = [
  { id: 'av-bounded',    file: 'merchant',
    label: 'Availability: the read is bounded by a deadline',
    why:   'no Promise.race + setTimeout — a stalled read would hang forever',
    test:  (s) => { const a = sliceAvailability(s); return !!a && /Promise\.race\s*\(/.test(a) && /setTimeout/.test(a); } },

  { id: 'av-failstate',  file: 'merchant',
    label: 'Availability: failure renders an explicit state',
    why:   'nothing renders a failure state',
    test:  (s) => { const a = sliceAvailability(s); return !!a && /_avFail\s*\(/.test(a); } },

  { id: 'av-nocatch',    file: 'merchant',
    label: 'Availability: no empty catch swallows the reason',
    why:   'an empty catch is present',
    test:  (s) => { const a = sliceAvailability(s); return !!a && !/\.catch\(\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)/.test(a); } },

  { id: 'av-service',    file: 'merchant',
    label: 'Availability: a missing service is reported, not silently returned',
    why:   'the combined guard silently returns when the service is absent',
    test:  (s) => { const a = sliceAvailability(s); return !!a && !/!body\s*\|\|\s*!window\.AvailabilityService\)\s*return/.test(a); } },

  { id: 'av-retry',      file: 'merchant',
    label: 'Availability: retry clears the render guard so the surface reloads',
    why:   'retry would re-run the read while leaving the error on screen',
    test:  (s) => /__avRetry[\s\S]{0,300}delete\s+host\.dataset\.av/.test(s) },

  { id: 'rt-bounded',    file: 'returns',
    label: 'Returns: the forced token refresh is bounded',
    why:   'getIdTokenResult is awaited with no deadline',
    test:  (s) => { const r = sliceReturnsAuth(s); return !!r && /_deadline\s*\(\s*user\.getIdTokenResult/.test(r); } },

  { id: 'rt-failpath',   file: 'returns',
    label: 'Returns: the token refresh has a failure path',
    why:   'a rejection would strand the loading screen',
    test:  (s) => { const r = sliceReturnsAuth(s); return !!r && /catch\s*\([\s\S]{0,160}_authFatal/.test(r); } },

  { id: 'rt-replaces',   file: 'returns',
    label: 'Returns: the fatal state replaces the loading screen itself',
    why:   'rendering into #app-root is invisible — it is display:none until the spinner is dismissed',
    test:  (s) => /function _authFatal[\s\S]{0,500}getElementById\('auth-loading'\)/.test(s) },

  { id: 'rt-deadline',   file: 'returns',
    label: 'Returns: _deadline actually races a timer',
    why:   'a deadline that never fires is not a deadline',
    test:  (s) => /function _deadline[\s\S]{0,400}Promise\.race[\s\S]{0,260}setTimeout/.test(s) },
];

const SRC = { merchant: merchantSrc, returns: returnsSrc };

console.log('\n1. THE CONTRACT HOLDS FOR THE REAL FILES');
ok('Availability block located', !!sliceAvailability(merchantSrc));
ok('Returns auth callback located', !!sliceReturnsAuth(returnsSrc));
RULES.forEach((r) => ok(r.label, r.test(SRC[r.file]), r.why));

/* ── 3 · Negative controls ────────────────────────────────────────────────── */
console.log('\n2. NEGATIVE CONTROLS — each defect re-introduced MUST be caught');
/* Each mutation is ANCHORED on text unique to the block under test. String.replace
   rewrites the FIRST match in the whole file, and merchant.html has dozens of
   `.catch(function (e) {` and `if (!body) return;` — three of these controls originally
   mutated some unrelated renderer, changed the file, and proved nothing. A control that
   edits the wrong function is worse than no control: it reports green. */
const MUTATIONS = [
  { id: 'av-nocatch',  file: 'merchant', what: 'restore the empty catch',
    apply: (s) => s.replace(/\.catch\(function \(e\) \{[\s\S]*?_avFail\([\s\S]*?\n    \}\);/,
                            '.catch(function () {});') },

  { id: 'av-bounded',  file: 'merchant', what: 'drop the deadline race',
    apply: (s) => s.replace('Promise.race([', 'Promise.all([') },

  { id: 'av-service',  file: 'merchant', what: 'restore the silent combined guard',
    apply: (s) => s.replace(/if \(!body\) return;[\s\S]*?_avFail\('The availability service did not load[\s\S]*?\n    \}/,
                            'if (!body || !window.AvailabilityService) return;') },

  { id: 'rt-bounded',  file: 'returns',  what: 'unguard the token refresh',
    apply: (s) => s.replace(/_deadline\(user\.getIdTokenResult\(true\), \d+, '[^']*'\)/,
                            'user.getIdTokenResult(true)') },

  /* _authFatal is defined before the auth callback, so the first occurrence of this
     getElementById is the one inside it — which is the line under test. */
  { id: 'rt-replaces', file: 'returns',  what: 'render the fatal error into hidden #app-root',
    apply: (s) => s.replace("getElementById('auth-loading')", "getElementById('app-root')") },
];

MUTATIONS.forEach((m) => {
  const rule = RULES.find((r) => r.id === m.id);
  const original = SRC[m.file];
  const mutated = m.apply(original);
  /* A mutation that changed nothing proves nothing — the regex drifted from the source. */
  if (!ok('mutation applied: ' + m.what, mutated !== original, 'source unchanged — this control is inert')) return;
  ok('  → caught by "' + rule.id + '"', rule.test(mutated) === false,
     'the defect was re-introduced and the rule still passed');
});

console.log('\n' + '='.repeat(72));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\n  FAILURES:'); failures.forEach(f => console.log('    ✗ ' + f)); }
console.log('='.repeat(72) + '\n');
process.exit(fail ? 1 : 0);
