'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   PRINT THE EXPECTED M-PESA NARRATIVE — offline, read-only, sends nothing.

   WHAT THIS IS FOR
   The handset verification needs an expected string to compare against. Writing that string into
   a document by hand would make the document a TRANSCRIPTION, and a transcription drifts from the
   code the first time the ladder is tuned — at which point the verification is checking against a
   figure nobody maintains. This prints it from `functions/shared/merchant-identity.js` itself, so
   the expectation and the implementation cannot disagree.

   WHAT THIS IS NOT
   It has no network capability and cannot cause a prompt to be sent. It imports exactly one
   module — the pure string authority — and touches no gateway, no credentials, no Firestore.
   Sending a real STK prompt requires an explicitly authorised, separate action that does not
   exist in this repository.

   Run:  node scripts/print-expected-stk-narrative.js
         node scripts/print-expected-stk-narrative.js --shop "KASS SHOP" --amount 1 --channel till
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const MI = require(path.join(__dirname, '..', 'functions', 'shared', 'merchant-identity.js'));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

/* A resolved identity exactly as `resolveMerchantIdentity` returns one. Built here rather than
   read from Firestore: this script must not need credentials to tell a tester what to expect. */
const identityOf = (name) => ({
  v: 1, resolved: true, name: String(name).slice(0, MI.MAX_NAME),
  sellerUid: '<sellerUid>', authority: 'shops/<sellerUid>.name', reason: null,
});

function line(label, narrative) {
  const len = String(narrative).length;
  console.log('  ' + label.padEnd(26) + '[' + String(len).padStart(3) + '/' + MI.MAX_NARRATIVE + ']  ' + narrative);
}

if (argv.includes('--shop')) {
  const shop = arg('shop', 'KASS SHOP');
  const amount = Number(arg('amount', 1));
  const channel = arg('channel', 'online');
  console.log('\n  EXPECTED NARRATIVE — offline computation, nothing sent\n');
  line(channel + ' / ' + shop, MI.narrativeFor(identityOf(shop), { channel, amountKES: amount }));
  console.log('');
  process.exit(0);
}

console.log('\n════════════════════════════════════════════════════════════════════════════════');
console.log('  EXPECTED M-PESA NARRATIVE — computed from functions/shared/merchant-identity.js');
console.log('  Offline. No network, no credentials, no prompt sent.');
console.log('════════════════════════════════════════════════════════════════════════════════\n');

console.log('  PRIMARY CASE — one push, real shop, smallest chargeable amount');
line('online, KES 1', MI.narrativeFor(identityOf('KASS SHOP'), { channel: 'online', amountKES: 1 }));
line('till/POS, KES 1', MI.narrativeFor(identityOf('KASS SHOP'), { channel: 'till', amountKES: 1 }));

console.log('\n  EXTENDED CASES — only if more than one push is authorised');
line('online, KES 4,566', MI.narrativeFor(identityOf('KASS SHOP'), { channel: 'online', amountKES: 4566 }));
line('long shop name', MI.narrativeFor(
  identityOf('MAMA NJERI FRESH GROCERIES AND GENERAL STORE'), { channel: 'till', amountKES: 4566 }));
line('unresolved shop', MI.narrativeFor({ resolved: false }, { channel: 'online', amountKES: 1 }));

console.log('\n  WHAT EACH CASE WOULD ESTABLISH');
console.log('    primary          does `narrative` reach the handset AT ALL — the only question that matters first');
console.log('    KES 4,566        the amount in the sentence tracks the real charge');
console.log('    long shop name   where the gateway truncates, which is the only way to learn the REAL budget');
console.log('    unresolved       the fail-closed string is legible and names nobody it cannot prove');

console.log('\n  CHARACTER SAFETY');
console.log('    mark             ' + MI.MARK + '  U+' + MI.MARK.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  + '  (BMP — inside the plane a SIM toolkit can draw)');
console.log('    astral stripped  ' + JSON.stringify(MI.sanitiseForHandset('KASS 🛍️ SHOP'))
  + '  ← emoji above U+FFFF are removed before sending');
console.log('');
