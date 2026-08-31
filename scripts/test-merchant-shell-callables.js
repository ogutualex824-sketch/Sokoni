#!/usr/bin/env node
/**
 * MERCHANT SHELL — the module contract.
 *
 *   node scripts/test-merchant-shell-callables.js
 *
 * Two ways a module surface dies on open, both invisible until a merchant taps the tab:
 *
 *   1. THE SHELL NAMES A CALLABLE THAT DOES NOT EXIST. Staff asked for
 *      listShopEmployees, listShopInvites and removeShopEmployee. None of the three was
 *      ever implemented, so the first call 404s and the client SDK reports it as the
 *      opaque code "internal" — which tells the merchant, and the log, nothing.
 *
 *   2. THE SHELL OMITS SOMETHING THE MODULE REQUIRES. Messages routes every operation
 *      through one callable and refuses without it: "merchant messages: dispatch is
 *      required". The shell passed scope/shopName/origin/db/onToast and no dispatch, so
 *      the inbox could never load.
 *
 * Both are contract breaks between two files that no single file can catch.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const SHELL = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

/* Every name the shell hands to _callable(). */
function calledNames () {
  const out = [];
  const parts = SHELL.split("_callable('");
  for (let i = 1; i < parts.length; i++) {
    const j = parts[i].indexOf("'");
    if (j > 0) out.push(parts[i].slice(0, j));
  }
  return out.filter((v, i, a) => a.indexOf(v) === i).sort();
}

/* Everything functions/ actually exports, following the re-export style used in index.js. */
function exportedNames () {
  const seen = {};
  const dir = path.join(ROOT, 'functions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')); } catch (_) { return seen; }
  files.forEach((f) => {
    let src = '';
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return; }
    const parts = src.split('exports.');
    for (let i = 1; i < parts.length; i++) {
      const m = parts[i].match(/^([A-Za-z0-9_$]+)\s*=/);
      if (m) seen[m[1]] = f;
    }
  });
  return seen;
}

console.log(NL + 'MERCHANT SHELL — MODULE CONTRACT' + NL + '='.repeat(62));

head('1 · every callable the shell names must exist in functions/');
const NAMES = calledNames();
const EXPORTED = exportedNames();
ck('the shell names callables', NAMES.length > 0, NAMES.length + ' distinct');
ck('functions/ was read', Object.keys(EXPORTED).length > 50, Object.keys(EXPORTED).length + ' exports');

const missing = NAMES.filter((n) => !EXPORTED[n]);
ck('none of them is missing', missing.length === 0,
   missing.length ? 'MISSING: ' + missing.join(', ') : 'all ' + NAMES.length + ' resolve');

ck('CONTROL the check can actually fail',
   !EXPORTED['definitelyNotARealCallable_' + Date.now()],
   'a lookup that always succeeds would pass over any missing name');
ck('CONTROL a known-good callable does resolve',
   !!EXPORTED['inviteShopEmployee'],
   'proves the export scan reads the real files rather than matching nothing');

head('2 · every module gets what it requires');
/* module global -> a ctx key it refuses to run without, and the message it refuses with */
const REQUIRED = [
  { key: 'messages', global: 'SokoniMerchantMessagesUI', needs: 'dispatch',
    because: 'merchant messages: dispatch is required' },
];
REQUIRED.forEach((r) => {
  const i = SHELL.indexOf("    " + r.key + ":");
  const block = i === -1 ? '' : SHELL.slice(i, i + 700);
  ck(r.key + " ctx supplies '" + r.needs + "'",
     block.indexOf(r.needs + ':') > -1, r.because);
});

/* The refusal the module makes must still be a real refusal — if the guard were deleted,
   the assertion above would be checking a requirement that no longer exists. */
(function () {
  let mm = '';
  try { mm = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-messages.js'), 'utf8'); } catch (_) {}
  ck('CONTROL the messages module still refuses without dispatch',
     mm.indexOf('merchant messages: dispatch is required') > -1,
     'the requirement is real, not a stale assertion');
})();

head('3 · the messages ops the client sends are ops the server registers');
(function () {
  let client = '', server = '';
  try { client = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-messages.js'), 'utf8'); } catch (_) {}
  try { server = fs.readFileSync(path.join(ROOT, 'functions/messages.js'), 'utf8'); } catch (_) {}
  const i = client.indexOf('var OPS = {');
  const block = i === -1 ? '' : client.slice(i, client.indexOf('}', i));
  const ops = [];
  block.split(NL).forEach((l) => {
    const m = l.match(/:\s*'([A-Za-z]+)'/);
    if (m) ops.push(m[1]);
  });
  ck('the client declares its ops', ops.length >= 4, ops.join(', '));
  const unregistered = ops.filter((o) => server.indexOf('_h.' + o + ' =') === -1);
  ck('every op has a server handler', unregistered.length === 0,
     unregistered.length ? 'NOT REGISTERED: ' + unregistered.join(', ') : ops.length + ' ops route');
  ck('CONTROL an invented op would not resolve',
     server.indexOf('_h.notARealOp =') === -1,
     'or the previous assertion passes regardless of what the client sends');
})();

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
