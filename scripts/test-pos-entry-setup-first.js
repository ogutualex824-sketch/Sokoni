#!/usr/bin/env node
/* POS ENTRY — the shell must open setup BEFORE selling, once.
 *
 * WHAT THIS COVERS
 * merchant-v2's POS route framed `pos.html` unconditionally and never consulted the
 * `posSetupComplete` latch, so a merchant who had never certified their hardware went
 * straight to selling and the "Complete Retail Operating System" wizard was reachable only
 * by a detour through pos-setup.html. The latch was already written by
 * pos-hardware-wizard.html and already read by pos-v2.html — the shell route was simply
 * not wired to it.
 *
 * HOW IT EXECUTES
 * The POS branch of the shell router is SLICED out of merchant-v2.html and compiled with
 * its collaborators injected, so the decision is observed from the shipping bytes rather
 * than asserted from a comment.
 *
 * DECISIONS THIS ENCODES (operator, 2026-09-01)
 *  - "Start Selling" opens pos.html — the POS staff already use.
 *  - The latch stays ONCE-EVER. This slice does not add a daily expiry.
 *
 * ARCHITECTURAL NOTE, DELIBERATE AND RECORDED
 * pos.html is the Rail 2 (client-authoritative) sale path. Routing daily selling to it is a
 * TEMPORARY state accepted under ADR-013, whose Option A migrates Rail 2 to
 * posCompleteCheckout. This suite must NOT be read as endorsing Rail 2 as the destination.
 */
'use strict';
const path = require('path');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..');
const SHELL  = path.join(ROOT, 'merchant-v2.html');
const WIZARD = path.join(ROOT, 'pos-hardware-wizard.html');

let pass = 0, fail = 0, unproven = 0;
function head (t) { console.log('\n' + t); }
function ck (label, cond, note) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}

/* Slice the POS branch of the router out of the shell. */
function slicePosRoute () {
  const src = fs.readFileSync(SHELL, 'utf8');
  const a = src.indexOf("if (m.kind === 'pos')");
  const b = src.indexOf("if (m.kind === 'seller')");
  if (a < 0 || b < 0 || b <= a) return null;
  return { branch: src.slice(a, b), whole: src };
}

/* Run the sliced branch with collaborators injected; report what it framed. */
function runRoute (branchSrc, latchValue, m) {
  const framed = [];
  const showOnly = (x) => x;
  const framePanel = (key, src, label) => { framed.push({ key, src, label }); return { key, src }; };
  const localStorage = {
    getItem: (k) => (k === 'posSetupComplete' ? latchValue : null),
    setItem: () => {},
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('m', 'showOnly', 'framePanel', 'localStorage',
    branchSrc + '\nreturn null;');
  fn(m, showOnly, framePanel, localStorage);
  return framed;
}

const M = { kind: 'pos', tab: 'pos', name: 'POS' };

(function () {

/* ── 1 · CONTROL ─────────────────────────────────────────────────────────────── */
head('1 · CONTROL — the router branch must be real and executable');
const sliced = slicePosRoute();
ck('the POS branch was located in merchant-v2.html', !!sliced,
   'a null slice would make every assertion below vacuous');
ck('CONTROL the slice is the branch, not the whole file',
   !!sliced && sliced.branch.length > 40 && sliced.branch.length < 2000,
   sliced ? sliced.branch.length + ' chars' : 'null');
let ran = null;
try { ran = runRoute(sliced.branch, 'x', M); } catch (e) { ran = null; }
ck('CONTROL the sliced branch compiles and frames something',
   Array.isArray(ran) && ran.length === 1, ran ? JSON.stringify(ran) : 'threw');

/* ── 2 · UNCONFIGURED — setup must come first ────────────────────────────────── */
head('2 · a merchant who has NOT certified hardware');
{
  const framed = runRoute(sliced.branch, null, M);
  const src = framed.length ? framed[0].src : '(nothing)';
  ck('exactly one panel is framed', framed.length === 1, JSON.stringify(framed));
  ck('THE SETUP WIZARD opens, not the till',
     src.indexOf('pos-hardware-wizard') > -1,
     'unfixed behaviour frames ' + src + ' and never reads the latch');
  ck('NEGATIVE the till is NOT framed while unconfigured',
     src.indexOf('pos.html') === -1, 'framed ' + src);
}

/* ── 3 · CONFIGURED — the wizard must not reappear ───────────────────────────── */
head('3 · a merchant who HAS certified hardware (latch present)');
{
  const latch = JSON.stringify({ v: 1, at: Date.now(), sellerId: 'uid_1' });
  const framed = runRoute(sliced.branch, latch, M);
  const src = framed.length ? framed[0].src : '(nothing)';
  ck('the till opens directly', src.indexOf('pos.html') > -1, 'framed ' + src);
  ck('NEGATIVE the wizard does NOT reappear',
     src.indexOf('pos-hardware-wizard') === -1,
     'the latch is once-ever by operator decision; no daily expiry in this slice');
}

/* ── 4 · PANEL IDENTITY — the two must not share a cached panel ──────────────── */
head('4 · the wizard and the till are separate panels');
{
  const unconf = runRoute(sliced.branch, null, M);
  const conf   = runRoute(sliced.branch, '{"v":1}', M);
  const kU = unconf.length ? unconf[0].key : null;
  const kC = conf.length ? conf[0].key : null;
  ck('they use DIFFERENT panel keys', !!kU && !!kC && kU !== kC,
     'same key would let framePanel serve a cached wizard frame after setup — keys: ' +
     kU + ' / ' + kC);
}

/* ── 5 · THE TAB DEEP-LINK MUST SURVIVE ──────────────────────────────────────── */
head('5 · deep-linking into a POS tab still works once configured');
{
  const framed = runRoute(sliced.branch, '{"v":1}', { kind: 'pos', tab: 'inventory', name: 'POS' });
  const src = framed.length ? framed[0].src : '';
  ck('a non-default tab is still appended', src.indexOf('#inventory') > -1, 'framed ' + src);
}

/* ── 6 · START SELLING ───────────────────────────────────────────────────────── */
head('6 · the wizard hands off to the till');
{
  const W = fs.readFileSync(WIZARD, 'utf8');
  const at = W.indexOf('Start Selling');
  /* Ends AT the label: the href precedes the text, and running past it captured the
     following "Manage Devices" anchor, making the diagnostic name the wrong href. */
  const around = W.slice(Math.max(0, at - 260), at);
  ck('CONTROL the Start Selling action was located', at > -1);
  ck('Start Selling opens pos.html',
     /href="pos\.html"/.test(around),
     'operator decision; currently: ' + (around.match(/href="[^"]*"/g) || []).slice(-1));
  ck('NEGATIVE it no longer routes to pos-v2',
     !/href="pos-v2"/.test(around));
  ck('Manage Devices still returns to the wizard',
     W.indexOf('goToStep(1)') > -1, 'the only way back once the latch is set');
}

head('RESULT');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);

})();
