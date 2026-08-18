/* ══════════════════════════════════════════════════════════════════════════════
   EXIT CONTRACT — MUTATION CONTROLS
   ══════════════════════════════════════════════════════════════════════════════
   The route gate now PASSES both shells on the navigation rules. That is only
   meaningful if those rules can still fail. A security assertion that has quietly
   become unfalsifiable is worse than no assertion, because it reports safety.

   So this script deliberately breaks a copy of a shell, one defect at a time, and
   requires the gate to CATCH each one. Each mutation is a real regression somebody
   could plausibly introduce — not a synthetic string designed to trip a regex:

     M1  restore the hardcoded '/login?next=/merchant-v2.html' the v2 shell shipped
         with   -> literal-URL rule AND .html-target rule must both fire
     M2  drop the kind!=='exit' guard from the navigation primitive
         (the module-postMessage escalation, re-expressed)   -> guard rule fires
     M3  navigate on a session-terminating exit without awaiting the sign-out
         -> terminatesSession rule fires
     M4  point a navigation at /login directly, bypassing the contract entirely
         -> literal-URL rule AND the login/auth rule both fire

   The originals are never modified: every mutant is written to a scratch file and
   the gate is pointed at it through MERCHANT_SHELL.

   Run: node scripts/test-merchant-exit-contract.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '..');
const GATE  = path.join(ROOT, 'scripts', 'test-merchant-routes.js');
const SHELL = path.join(ROOT, 'merchant-v2.html');
const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'sokoni-exit-'));

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\nEXIT CONTRACT — MUTATION CONTROLS');
console.log('='.repeat(78));

const original = fs.readFileSync(SHELL, 'utf8');

/* Run the real gate against a shell file and return its FAIL lines. */
function gateFailures (shellPath) {
  let out;
  try {
    out = execFileSync(process.execPath, [GATE], {
      cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { MERCHANT_SHELL: shellPath })
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');   /* non-zero exit is expected for a mutant */
  }
  return out.split('\n').filter(l => l.includes('FAIL  ')).map(l => l.trim());
}

function mutate (name, transform) {
  const src = transform(original);
  if (src === original) { check(name + ': mutation actually changed the shell', false, 'no-op transform'); return null; }
  const p = path.join(TMP, name + '.html');
  fs.writeFileSync(p, src);
  return gateFailures(p);
}

/* ── Baseline — the unmutated shell must be clean, or nothing below means anything ─ */
console.log('\n0. Baseline');
const base = gateFailures(SHELL);
check('unmutated merchant-v2.html passes the gate', base.length === 0,
      base.length ? base.join(' | ') : 'clean');

/* ── M1 — the exact line the v2 shell shipped with ───────────────────────── */
console.log('\n1. M1 — restore the hardcoded /login?next=/merchant-v2.html');
const m1 = mutate('m1-hardcoded-login', s =>
  s.replace("leaveShell('signout', true);", "location.assign('/login?next=/merchant-v2.html');"));
if (m1) {
  check('M1 caught: navigation to a literal URL',
        m1.some(l => /literal URL/.test(l)), m1.length + ' failure(s)');
  check('M1 caught: .html exit target (cleanUrls 301s it)',
        m1.some(l => /\.html exit target/.test(l)));
  check('M1 caught: unguarded navigation site',
        m1.some(l => /guarded by a contract exit check/.test(l)));
}

/* ── M2 — remove the guard from the navigation primitive ─────────────────── */
console.log('\n2. M2 — drop the kind!=="exit" guard from the primitive');
const m2 = mutate('m2-unguarded-primitive', s =>
  s.replace(/if \(!m \|\| m\.kind !== 'exit'\) \{[\s\S]*?\n    \}\n/, ''));
if (m2) {
  check('M2 caught: navigation site no longer proves the route is an exit',
        m2.some(l => /guarded by a contract exit check/.test(l)), m2.length + ' failure(s)');
}

/* ── M3 — leave before the sign-out resolves ─────────────────────────────── */
console.log('\n3. M3 — navigate on a session-terminating exit without awaiting sign-out');
const m3 = mutate('m3-session-not-ended', s =>
  s.replace(/if \(m\.terminatesSession && !sessionEnded\) \{[\s\S]*?\n    \}\n/, ''));
if (m3) {
  check('M3 caught: session-terminating exit is no longer guarded',
        m3.some(l => /session-terminating exits are guarded/.test(l)), m3.length + ' failure(s)');
}

/* ── M4 — bypass the contract entirely ───────────────────────────────────── */
console.log('\n4. M4 — a bare navigation to /login, the escalation shape');
const m4 = mutate('m4-bare-login', s =>
  s.replace('function go (id) {', "function go (id) {\n    if (!window.__ready) location.href = '/login';"));
if (m4) {
  check('M4 caught: bare navigation to an auth destination',
        m4.some(l => /navigates the tab to login\/auth/.test(l)), m4.length + ' failure(s)');
  check('M4 caught: literal URL target',
        m4.some(l => /literal URL/.test(l)));
  check('M4 caught: unguarded navigation site',
        m4.some(l => /guarded by a contract exit check/.test(l)));
}

/* ── Contract-level controls — the validator itself must be falsifiable ──── */
console.log('\n5. Contract validation controls');
const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const signout = C.get('signout');
check('signout is a declared exit route', !!signout && signout.kind === 'exit',
      signout ? signout.kind : 'MISSING');
check('...that terminates the session', !!signout && signout.terminatesSession === true);
check('...with a clean-URL href and next (no .html, root-relative)',
      !!signout && /^\/[^/]*$/.test(signout.href) && !/\.html$/.test(signout.href) &&
      signout.next.charAt(0) === '/' && !/\.html$/.test(signout.next) && signout.next.indexOf('//') < 0,
      signout ? signout.href + '?next=' + signout.next : '');
/* auth.js re-validates ?next= against its own charset and rejects '//'. A `next` this
   contract accepts but auth.js rejects would drop the return trip silently. */
check('...and auth.js would accept that next value',
      /^[a-zA-Z0-9_\-.\/?=&%#]+$/.test(signout.next) && !signout.next.includes('//'),
      signout.next);

/* Prove validate() rejects the bad shapes rather than tolerating them. */
function validateWith (mutateRoute) {
  const clone = JSON.parse(JSON.stringify(C.ROUTES.map(r => {
    const o = {}; for (const k in r) if (typeof r[k] !== 'function') o[k] = r[k]; return o;
  })));
  const target = clone.find(r => r.id === 'signout');
  mutateRoute(target);
  /* Re-run the same rules the contract applies to an exit route. */
  const errs = [];
  const at = 'route "signout"';
  if (!target.href) errs.push(at + ': exit route has no href');
  else if (!/^\/[^/]*$/.test(target.href)) errs.push(at + ': href must be root-relative');
  else if (/\.html$/.test(target.href)) errs.push(at + ': href ends in .html');
  if (target.next != null) {
    if (target.next.charAt(0) !== '/' || target.next.indexOf('//') > -1) errs.push(at + ': next must be root-relative');
    else if (/\.html$/.test(target.next)) errs.push(at + ': next ends in .html');
    else if (!/^[a-zA-Z0-9_\-.\/?=&%#]+$/.test(target.next)) errs.push(at + ': next has characters auth.js rejects');
  }
  return errs;
}
check('C1 a .html next is rejected', validateWith(r => { r.next = '/merchant-v2.html'; }).length > 0);
check('C2 an absolute next is rejected', validateWith(r => { r.next = '//evil.example/merchant'; }).length > 0);
check('C3 a .html href is rejected',  validateWith(r => { r.href = '/login.html'; }).length > 0);
/* And the converse — the real values must NOT be rejected, or C1-C3 prove nothing. */
check('C4 the shipped values are accepted', validateWith(() => {}).length === 0);

/* Live check that the real validator agrees, not just this transcription of it. */
const live = C.validate();
check('C5 the real contract validates clean', live.length === 0, live.join(' | ') || 'clean');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log('\n' + '='.repeat(78));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(78) + '\n');
process.exit(fail ? 1 : 0);
