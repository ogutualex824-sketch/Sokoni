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

/* 2026-10-03: sokoni-mpesa.js, pos.js, pos.html and pos-printer-setup.html were cleaned (owner: "remove daraja code"). */
const PENDING = {
  'till.html':        'till callStk names darajaSTKPush; replaced by sokoni-pos-stk.js on sokoni-2f\'s union (20b92fa) — drop on merge',
  'merchant-v2.html': 'merchant till callStk names darajaSTKPush; same union fix — drop on merge',
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
for (const f of ['payments.html', 'seller.html', 'sokoni-endpoints.js', 'sokoni-dev-mock.js', 'checkout.html', 'bnb.html',
                 'sokoni-mpesa.js', 'pos.js', 'pos.html', 'pos-printer-setup.html', 'landlord.html']) {
  ck('D3  cleaned: ' + f, !hits[f], hits[f]);
}
/* Behaviour the cleanup must keep (comment-stripped source). */
{
  const pos = strip(fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8'));
  const send = (pos.match(/async sendSTK\(\)\s*\{[\s\S]*?\n    \},/) || [''])[0];
  ck('D5  POS sendSTK calls no payment function and never invents a checkout id',
     send.length > 0 && !/httpsCallable|SIMULATED_|payment\.complete/.test(send) && /Nothing was charged/.test(send));
  ck('D6  POS never completes a sale on a simulated M-PESA confirmation', !/SIMULATED_|mpesaRef\s*=\s*'SIM'/.test(pos));
  ck('D7  POS collects no Safaricom API keys', !/mpesa-ck|mpesa-cs|mpesa-passkey|cfg-mpesa-ck|cfg-mpesa-passkey/.test(pos + strip(fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8'))));
  const eng = strip(fs.readFileSync(path.join(ROOT, 'sokoni-mpesa.js'), 'utf8'));
  ck('D8  the retired engine refuses without any network call', /onFailure\('unavailable'\)/.test(eng) && !/httpsCallable|import\(|fetch\(/.test(eng));
  const ll = strip(fs.readFileSync(path.join(ROOT, 'landlord.html'), 'utf8'));
  /* The body of the no-processor branch only: from its opening brace to the matching close. */
  const llBody = (() => {
    const i = ll.indexOf('if(!LANDLORD_INTASEND_KEY){'); if (i < 0) return null;
    let d = 0;
    for (let j = ll.indexOf('{', i); j < ll.length; j++) { if (ll[j] === '{') d++; else if (ll[j] === '}' && --d === 0) return ll.slice(i, j + 1); }
    return null;
  })();
  ck('D9  landlord never marks rent paid without a processor', !!llBody && !/paid:true|Payment Confirmed/.test(llBody));
}
/* negative control: the detector finds a planted reference */
ck('D4  CONTROL the pattern catches a planted call', PATTERN.test(strip("httpsCallable(fn, 'darajaSTKPush')")) && !PATTERN.test(strip('/* darajaSTKPush */ var x;')));
console.log('\n  pending (' + Object.keys(PENDING).length + '): ' + Object.keys(PENDING).join(', '));
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
