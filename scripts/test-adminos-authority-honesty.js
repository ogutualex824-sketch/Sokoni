#!/usr/bin/env node
/* ADMINOS — AUTHORITY HONESTY certification.
 *
 * Two defect classes were PROVEN by the provenance audit of live 604e481:
 *
 *  1. Reject Payout called `finosRequestBankPayout({payoutId, action:'reject'})` — a
 *     SELLER bank-payout request, not an admin rejection path, and with the wrong
 *     parameter name. super-admin.html already carried the correct mapping.
 *
 *  2. Four security-panel controls wrote to `approvalRequests` / `activeSessions`,
 *     which have NO rules in the served ruleset (705 explicit top-level matches, zero
 *     wildcards) and are therefore default-denied. Each swallowed the denial with
 *     `.catch(e => _toast(...))` and then fired an UNCONDITIONAL success toast, so a
 *     refused security action reported as done. `revokeAllSessions` was worse: a denied
 *     READ became "No active sessions to revoke" — an absence the client cannot know.
 *
 * THE PROPERTY UNDER TEST is that a refused operation can never render as a completed
 * one. The source is read from the shipped `sokoni-aos.js`, so this cannot drift from it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sokoni-aos.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, note) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};

/* extract an `async function NAME(...) { ... }` body at 2-space indent */
function fnBody(src, name) {
  const re = new RegExp('\\n  (?:async )?function ' + name + '\\s*\\(');
  const m = src.match(re);
  if (!m) return null;
  const start = m.index;
  const end = src.indexOf('\n  }', start);
  return end < 0 ? null : src.slice(start, end + 4);
}

/* a body is HONEST when no success toast is reachable from a swallowed failure:
   no inline `.catch(... _toast ...)` swallow, and every catch block returns */
function isHonest(body) {
  if (/\.catch\(\s*(?:e|err|_e)?\s*=>\s*_toast/.test(body)) return false;      /* inline swallow */
  const catches = body.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?\}/g) || [];
  if (!catches.length) return false;                                            /* no handling */
  return catches.every(function (c) { return /\breturn\b/.test(c); });
}

console.log('');
console.log('  ADMINOS — authority honesty');
console.log('');

/* ── 1 · the retired seller-bank-payout callable is not INVOKED ─────────────── */
{
  const called = /_call\(\s*["']finosRequestBankPayout["']/.test(SRC) ||
                 /httpsCallable\(\s*["']finosRequestBankPayout["']/.test(SRC);
  ok('finosRequestBankPayout is never invoked from AdminOS', !called);
  /* A per-line prefix test is wrong: a CONTINUATION line inside a block comment starts
     with neither `/*` nor `*`. Strip comments instead and require zero mentions in the
     code that remains. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const inCode = (CODE.match(/finosRequestBankPayout/g) || []).length;
  ok('no mention survives in CODE (comments stripped)', inCode === 0, inCode + ' in code');
  ok('the retired name is still documented for future readers',
     /finosRequestBankPayout/.test(SRC));
}

/* ── 2 · Reject Payout uses the contract super-admin.html already proved ────── */
{
  const b = fnBody(SRC, 'rejectPayout');
  ok('rejectPayout exists', !!b);
  if (b) {
    ok('rejectPayout calls adminProcessPayout', /_call\(\s*["']adminProcessPayout["']/.test(b));
    ok('rejectPayout sends requestId (not payoutId)',
       /requestId\s*:/.test(b) && !/payoutId\s*:/.test(b));
    ok('rejectPayout sends status:"rejected"', /status\s*:\s*["']rejected["']/.test(b));
    ok('rejectPayout aborts on a cancelled prompt (null)', /===\s*null\s*\)\s*return/.test(b));
    ok('rejectPayout keeps try/catch/return discipline', isHonest(b));
  }
}

/* ── 3 · approvePayout was already correct and must STAY correct ────────────── */
{
  const b = fnBody(SRC, 'approvePayout');
  ok('approvePayout still uses adminProcessPayout', !!b && /adminProcessPayout/.test(b));
  ok('approvePayout still returns before claiming success', !!b && isHonest(b));
}

/* ── 4 · the four denied-collection controls cannot fabricate success ───────── */
['approveRequest', 'rejectRequest', 'revokeSession', 'revokeAllSessions'].forEach(function (n) {
  const b = fnBody(SRC, n);
  ok(n + ' exists', !!b);
  if (b) ok(n + ' cannot report success after a refused write', isHonest(b),
            'inline .catch swallow, or a catch without return');
});

/* ── 5 · a denied READ is not reported as an absence ────────────────────────── */
{
  const b = fnBody(SRC, 'revokeAllSessions') || '';
  ok('revokeAllSessions no longer coerces a failed read to null',
     !/\.get\(\)\.catch\(\s*\(\)\s*=>\s*null\s*\)/.test(b));
  ok('revokeAllSessions separates "cannot read" from "none exist"',
     /read active sessions/.test(b) && /No active sessions to revoke/.test(b));
  const em = b.match(/if\s*\([^)]*\)\s*\{\s*_toast\("No active sessions/);
  ok('the empty-state branch tests snap.empty only, not a null snapshot',
     !!em && em[0].indexOf('!snap ||') < 0, em ? em[0] : 'absent');
}

/* ── 6 · _writeFailure renders a denial honestly ────────────────────────────── */
{
  const src = fnBody(SRC, '_writeFailure');
  ok('_writeFailure exists', !!src);
  if (src) {
    /* eslint-disable no-eval */
    const _writeFailure = eval('(function(){' + src + '\nreturn _writeFailure;})()');
    const denied = _writeFailure({ code: 'permission-denied' }, 'revoke the session');
    ok('permission-denied says nothing was changed', /Nothing was changed/.test(denied), denied);
    ok('permission-denied does not claim absence',
       !/no (active )?sessions|not found|already/i.test(denied), denied);
    ok('a generic error keeps its own message',
       _writeFailure({ message: 'network down' }, 'x') === 'network down');
    let threw = false;
    try { _writeFailure(null, 'x'); _writeFailure(undefined, 'y'); } catch (_) { threw = true; }
    ok('_writeFailure never throws on a missing error object', !threw);
    ok('a null error still names the operation', /Could not x\./.test(_writeFailure(null, 'x')));
  }
}

/* ══ CONTROLS ═════════════════════════════════════════════════════════════ */
console.log('  CONTROLS');
let controlsOk = true;
{
  const before = fail;
  ok('__negative_control__ (expected to fail)', 1 === 2);
  const detected = fail === before + 1;
  fail = before;
  console.log('    ' + (detected ? 'PASS' : 'FAIL') + '  assertions can fail');
  if (!detected) controlsOk = false;
}
{
  /* the PRE-FIX shape must be REJECTED — otherwise the detector is vacuous */
  const preFix = [
    '  async function approveRequest(id) {',
    '    await _db.collection("approvalRequests").doc(id).update({ status:"approved" })',
    '      .catch(e => _toast(e.message,"error"));',
    '    _toast("Request approved","success");',
    '  }'].join('\n');
  const rejected = !isHonest(preFix);
  console.log('    ' + (rejected ? 'PASS' : 'FAIL') +
              '  the pre-fix swallow-then-succeed shape is REJECTED');
  if (!rejected) controlsOk = false;
}
{
  const noReturn = [
    '  async function x(id) {',
    '    try { await f(); } catch (e) { _toast(e.message,"error"); }',
    '    _toast("done","success");',
    '  }'].join('\n');
  const rejected = !isHonest(noReturn);
  console.log('    ' + (rejected ? 'PASS' : 'FAIL') +
              '  a catch block without return is REJECTED');
  if (!rejected) controlsOk = false;
}
{
  /* a genuinely correct shape must be ACCEPTED — else everything "passes" by refusal */
  const good = [
    '  async function x(id) {',
    '    try { await f(); } catch (e) { _toast(e.message,"error"); return; }',
    '    _toast("done","success");',
    '  }'].join('\n');
  const accepted = isHonest(good);
  console.log('    ' + (accepted ? 'PASS' : 'FAIL') +
              '  a correct try/catch/return shape is ACCEPTED');
  if (!accepted) controlsOk = false;
}
{
  /* the comment-stripper must actually strip, and must not eat code */
  const C = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const stripped = C.indexOf('AUTHORITY HONESTY') < 0 && C.indexOf('SELLER bank-payout') < 0;
  const kept = C.indexOf('adminProcessPayout') > -1 && C.indexOf('revokeAllSessions') > -1;
  console.log('    ' + (stripped && kept ? 'PASS' : 'FAIL') +
              '  the comment-stripper removes comments and keeps code');
  if (!(stripped && kept)) controlsOk = false;
}
{
  /* the extractor must actually find bodies — a null body passes vacuously above */
  const found = ['rejectPayout', 'approveRequest', 'revokeAllSessions', '_writeFailure']
    .filter(function (n) { return !!fnBody(SRC, n); }).length;
  console.log('    ' + (found === 4 ? 'PASS' : 'FAIL') +
              '  the extractor located all 4 target functions (' + found + '/4)');
  if (found !== 4) controlsOk = false;
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
console.log('  SCOPE, stated honestly: this certifies the 4 PROVEN paths + the payout rail.');
console.log('  24 other AdminOS call sites share the swallow-then-succeed shape and are NOT');
console.log('  covered here (TIER 2 — their backends EXIST). The 5 TIER-1 dead controls are');
console.log('  corrected and certified by test-adminos-tier1-dead-controls.js.');
if (!controlsOk) {
  console.log('');
  console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
  process.exit(1);
}
process.exit(fail > 0 ? 1 : 0);
