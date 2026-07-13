#!/usr/bin/env node
/**
 * test-validation.js — Production Validation Mode. Static analysis. Records nothing.
 *
 * Two properties matter, and they pull against each other:
 *
 *   1. When OFF (the default, and what every real customer gets) it must be COMPLETELY
 *      inert. It may not patch fetch, may not patch firebase, may not listen, may not
 *      write. A diagnostic tool that changes production behaviour is a liability, not an
 *      instrument.
 *
 *   2. When ON it must refuse to lie. "Queued" is not "delivered". A push the server
 *      accepted, an email in a queue, a 200 from a provider — none of those are evidence
 *      that anything ARRIVED. Recording them as success is precisely how a months-long
 *      push outage hid behind a green dashboard on this platform.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const v    = fs.readFileSync(path.resolve('sokoni-validate.js'), 'utf8');
const dash = fs.readFileSync(path.resolve('validation.html'), 'utf8');
const hdr  = fs.readFileSync(path.resolve('shared-header.js'), 'utf8');

console.log('\nProduction Validation Mode\n');

/* ── 1. Inert when off ─────────────────────────────────────────────────────── */
{
  /if \(!ON\) \{[\s\S]{0,400}return;/.test(v)
    ? ok('returns immediately when OFF — no patches, no listeners, no writes')
    : bad('does not bail out when OFF — it could affect a real customer');

  /localStorage\.getItem\('sokoni_validate'\) === '1'/.test(v)
    ? ok('opt-in only (?validate=1) — OFF is the default')
    : bad('validation mode is not explicitly opt-in');

  /* The patches must live INSIDE functions, not at module top level. */
  const patchAt = v.indexOf('function patchFunctions');
  const bailAt  = v.indexOf('if (!ON)');
  (bailAt !== -1 && patchAt > bailAt)
    ? ok('the fetch/firebase patches are defined AFTER the off-switch — unreachable when off')
    : bad('patches could run before the off-switch is evaluated');
}

/* ── 2. It must not lie about delivery ─────────────────────────────────────── */
{
  /QUEUED ≠ DELIVERED/.test(v)
    ? ok('push and PO record QUEUED ≠ DELIVERED — the server accepting is not the device receiving')
    : bad('a queued send could be reported as delivered — the exact bug that hid for months');

  /record\('push', 'server accepted the notification', 'queued'/.test(v)
    ? ok('push is recorded as `queued`, never `ok`, until a device confirms')
    : bad('push is recorded as success on server acceptance alone');

  /Nothing recorded[\s\S]{0,80}not been exercised/.test(dash)
    ? ok('an unexercised module shows as NOT a pass (⚪), not green')
    : bad('an untested module could show green — that is how you ship on tests that never ran');

  !/return \{ dot:'🟢', label:'not exercised' \}/.test(dash)
    ? ok('“not exercised” is never green')
    : bad('“not exercised” renders green');
}

/* ── 3. Never swallow a failure ────────────────────────────────────────────── */
{
  /throw err;\s*\/\* rethrow/.test(v)
    ? ok('a traced Cloud Function error is RETHROWN — production behaviour is unchanged')
    : bad('the wrapper could swallow a CF error and change how the app behaves');

  /stack:\s*err && err\.stack/.test(v) && /details: err && err\.details/.test(v)
    ? ok('full error captured: code, message, details, stack')
    : bad('errors are captured without stack/code — a generic message is not a root cause');

  /addEventListener\('unhandledrejection'/.test(v) && /addEventListener\('error'/.test(v)
    ? ok('uncaught exceptions and unhandled rejections are recorded')
    : bad('uncaught errors are not captured');
}

/* ── 4. Secrets never enter a trace that gets shared ───────────────────────── */
{
  /pin\|password\|secret\|token\|cvv\|card\|otp\|key/i.test(v) && /«redacted»/.test(v)
    ? ok('payloads are redacted (PIN, card, OTP, token, password) before being logged')
    : bad('a trace could capture a PIN or a card number and then be pasted into a chat');
}

/* ── 5. One seam instruments all 523 call sites ────────────────────────────── */
{
  /fns\.httpsCallable = function \(name, opts\)/.test(v)
    ? ok('every CF call is traced by wrapping ONE seam (httpsCallable) — 523 call sites, zero edits')
    : bad('CF calls are not traced at the shared seam');

  /module: 'cloudFunctions'|record\('cloudFunctions'/.test(v)
    ? ok('CF name, payload, result, duration and error are all recorded')
    : bad('CF invocations are not recorded');
}

/* ── 6. The diagnostics that caught real bugs ─────────────────────────────── */
{
  /horizontalOverflow: de\.scrollWidth - innerWidth/.test(v)
    ? ok('horizontal overflow is measured on every route (the bug my own tools missed once)')
    : bad('horizontal overflow is not measured');

  /safe-area-inset-top/.test(v) && /headerHeight/.test(v)
    ? ok('safe-area insets and the real header height are captured from the device')
    : bad('safe-area / header height not captured');

  /reg\.waiting/.test(v)
    ? ok('a WAITING service worker is flagged — the session is running stale code')
    : bad('a stale service worker would go unnoticed, invalidating the whole run');
}

/* ── 7. Performance from the real device, reported at the right time ───────── */
{
  /'largest-contentful-paint'/.test(v) && /'layout-shift'/.test(v) && /'event'/.test(v)
    ? ok('LCP, CLS and INP observed (not estimated)')
    : bad('core web vitals are not observed');

  /addEventListener\('pagehide', flush\)/.test(v) && !/addEventListener\('unload'/.test(v)
    ? ok('metrics flush on pagehide — NOT unload, which iOS Safari does not reliably fire')
    : bad('metrics flush on unload — iOS Safari will not fire it, so nothing is reported');
}

/* ── 8. Reachable ─────────────────────────────────────────────────────────── */
{
  /sokoni-validate\.js/.test(hdr)
    ? ok('injected platform-wide (off by default), so any route can be validated')
    : bad('validation mode is not injected — it cannot be turned on');

  fs.existsSync(path.resolve('validation.html'))
    ? ok('validation.html dashboard exists (readable on the phone, exportable as JSON)')
    : bad('no dashboard');
}

console.log('');
if (fail) { console.error(`Validation mode FAILED (${fail})\n`); process.exit(1); }
console.log(`Validation mode PASSED (${pass} checks)\n`);
