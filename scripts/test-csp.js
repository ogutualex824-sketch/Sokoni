#!/usr/bin/env node
/**
 * test-csp.js — one Content Security Policy, and it must let Firebase Auth work.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * SOKONI shipped TWO policies: the HTTP header from firebase.json ("source": "**", so it is
 * on every response) and a second one that security.js injected as a <meta> tag.
 *
 * When a page carries two policies the browser enforces BOTH — the effective policy is
 * their INTERSECTION. A meta tag can therefore never loosen anything; it can only silently
 * make the real policy stricter than intended. And this one had drifted:
 *
 *   directive     header                                  meta        effective
 *   frame-src     … https://auth.mysokoni.co.ke           MISSING     BLOCKED
 *   connect-src   … https://payment.intasend.com          MISSING     BLOCKED
 *   form-action   'self' https://payment.intasend.com     'self'      BLOCKED
 *
 * The frame-src gap broke sign-in. Firebase Auth loads a helper IFRAME on the configured
 * authDomain to complete popup/redirect OAuth and restore the session; blocking it produced
 * "Framing 'https://auth.mysokoni.co.ke/' violates ... frame-src" in production. Email and
 * password sign-in still worked (a plain XHR to identitytoolkit), which is exactly why this
 * presented as a mysterious, partial login failure rather than an obviously broken policy.
 *
 * This gate asserts: exactly ONE policy, and that the one policy permits what auth and
 * payments actually need.
 *
 * Run: node scripts/test-csp.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const fail = (m) => { failures++; console.log('  \x1b[31m✘\x1b[0m ' + m); };
const pass = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);

console.log('\nSOKONI — Content Security Policy gate\n');

/* ── 1. Exactly one policy ───────────────────────────────────────────────────────── */
console.log('1. One policy, not two');

const sec = fs.readFileSync(path.join(ROOT, 'security.js'), 'utf8');
/* A meta CSP is only a problem if it is actually INJECTED. Comments explaining why we
   don't are not offenders (a gate that punishes documentation teaches people to delete it). */
const secCode = sec.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/Content-Security-Policy/i.test(secCode) && /createElement\(\s*["']meta["']\s*\)/.test(secCode)
  ? fail('security.js injects a <meta> CSP. It is INTERSECTED with the firebase.json header, ' +
         'so it can only silently remove origins the platform depends on — it broke the ' +
         'Firebase Auth iframe once already.')
  : pass('security.js does not inject a meta CSP — the HTTP header is the single source of truth');

const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const metaPages = pages.filter((f) =>
  /<meta[^>]+http-equiv=["']Content-Security-Policy["']/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
metaPages.length === 0
  ? pass(pages.length + ' pages — none hard-codes a second CSP in its markup')
  : fail('page(s) carry their own <meta> CSP, which is intersected with the header: ' +
         metaPages.slice(0, 5).join(', '));

/* ── 2. The one policy must actually permit auth ─────────────────────────────────── */
console.log('\n2. The header permits what sign-in and payment need');

const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const headers = (fb.hosting.headers || []);
const cspEntry = headers.find((h) => (h.headers || []).some((k) => k.key === 'Content-Security-Policy'));

if (!cspEntry) {
  fail('firebase.json sends no Content-Security-Policy header — with the meta gone there would be NO policy at all');
} else {
  cspEntry.source === '**'
    ? pass('the CSP header is served on every route ("**")')
    : fail('the CSP header is scoped to "' + cspEntry.source + '" — pages outside it would have no policy');

  const csp = cspEntry.headers.find((k) => k.key === 'Content-Security-Policy').value;
  const directive = (name) => {
    const m = new RegExp(name + '\\s+([^;]+)').exec(csp);
    return m ? m[1] : '';
  };

  /* The authDomain the app actually uses — read it, do not assume. */
  const cfg = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
  const ad = /authDomain:\s*["']([^"']+)["']/.exec(cfg);
  const authDomain = ad ? ad[1] : null;

  if (!authDomain) {
    fail('could not read authDomain from firebase.js');
  } else {
    const frameSrc = directive('frame-src');
    frameSrc.includes(authDomain)
      ? pass('frame-src allows the authDomain (' + authDomain + ') — Firebase Auth\'s iframe can load')
      : fail('frame-src does NOT allow the authDomain (' + authDomain + '). Firebase Auth loads a ' +
             'helper iframe there to complete OAuth and restore the session — popup/redirect ' +
             'sign-in will fail while email/password appears to work.');
  }

  /* Sign-in and token refresh are plain XHR — these must be reachable. */
  for (const origin of ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com']) {
    directive('connect-src').includes(origin)
      ? pass('connect-src allows ' + origin.replace('https://', ''))
      : fail('connect-src blocks ' + origin + ' — sign-in / token refresh cannot complete');
  }
}

console.log('');
if (failures) {
  console.log('\x1b[31mFAIL\x1b[0m — ' + failures + ' CSP problem(s)\n');
  process.exit(1);
}
console.log('\x1b[32mPASS\x1b[0m — one policy, and it lets authentication work\n');
