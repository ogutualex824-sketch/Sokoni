#!/usr/bin/env node
/* test-daraja-leftovers.js — no hosting page sets up, calls or advertises Daraja (owner, 2026-10-03: IntaSend only)
 *
 *   node scripts/test-daraja-leftovers.js
 *
 * Scans every hosting .html/.js (not functions/, scripts/, tests/, docs/) with comments stripped. A file may still
 * reference Daraja ONLY if it is listed in PENDING with the reason and owner. The list can only shrink: a listed
 * file that no longer references Daraja fails too, so it must be removed from the list when cleaned.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['functions', 'scripts', 'tests', 'docs', 'node_modules', '.git', '.firebase', 'test-results', 'playwright-report', 'backups']);

/* Executable or user-visible Daraja: the deleted / Daraja-only callables, the callback URL, setup UI wording. */
const PATTERN = /darajaSTKPush|darajaSTKCallback|validateDarajaCredentials|sendTestSTKPush|webhookMpesa|mpesaC2B(Validation|Confirmation)|Safaricom Daraja|Daraja (API|portal|credentials)|developer\.safaricom\.co\.ke|sellerDarajaOverlay|saveSellerDarajaSettings/;

const PENDING = {
  'sokoni-mpesa.js':       'retired client engine still called by hub pages below; removed with the hub IntaSend purposes',
  'till.html':             'till STK fallback names darajaSTKPush; till owner (sokoni-2f / ec71c3c lineage)',
  'merchant-v2.html':      'merchant till callStk names darajaSTKPush; till owner',
  'pos.js':                'legacy POS mpesa.sendSTK / saveConfig; POS owner',
  'pos.html':              'POS wizard copy; POS owner',
  'pos-printer-setup.html':'printer console copy mentions a Daraja app; POS owner',
};

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`])\/\/[^\n]*/g, '$1');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); continue; }
    if (/\.(html|js)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}
const hits = {};
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const code = strip(fs.readFileSync(f, 'utf8'));
  const m = code.match(PATTERN);
  if (m) hits[rel] = m[0];
}

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
console.log('\nDARAJA LEFTOVERS — hosting\n');
const unexpected = Object.keys(hits).filter((f) => !PENDING[f]);
ck('D1  no unlisted hosting file references Daraja', unexpected.length === 0, unexpected.map((f) => f + ': ' + hits[f]).join('; '));
const stale = Object.keys(PENDING).filter((f) => !hits[f]);
ck('D2  every PENDING entry still needs cleaning (the list only shrinks)', stale.length === 0, stale.join(', '));
for (const f of ['payments.html', 'seller.html', 'sokoni-endpoints.js', 'sokoni-dev-mock.js', 'checkout.html', 'bnb.html']) {
  ck('D3  cleaned: ' + f, !hits[f], hits[f]);
}
/* negative control: the detector finds a planted reference */
ck('D4  CONTROL the pattern catches a planted call', PATTERN.test(strip("httpsCallable(fn, 'darajaSTKPush')")) && !PATTERN.test(strip('/* darajaSTKPush */ var x;')));
console.log('\n  pending (' + Object.keys(PENDING).length + '): ' + Object.keys(PENDING).join(', '));
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
