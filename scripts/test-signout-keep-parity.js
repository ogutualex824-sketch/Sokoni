#!/usr/bin/env node
/* SIGN-OUT KEEP-LIST PARITY
   ─────────────────────────────────────────────────────────────────────────────
   Sign-out wipes every storage key EXCEPT an allow-list of non-user infra keys.
   That list exists twice:

     firebase.js      _SOKONI_LS_KEEP   canonical, used by sokoniSignOut()
     shared-header.js _SK_LS_KEEP       fallback, used on pages without firebase.js

   The duplication is not gratuitous: 181 pages load shared-header.js and not
   firebase.js, so the fallback cannot read the canonical copy at runtime. But a
   duplicated allow-list that drifts is a data-leak-shaped bug — a key kept in one
   path and wiped in the other means one account's data can survive a sign-out on a
   device the next account then uses, and it would survive exactly on the pages
   nobody thinks to test.

   This asserts they are byte-identical, so drift fails a gate instead of shipping.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\nSign-out keep-list parity\n' + '='.repeat(60));

const canonical = read('firebase.js').match(/const _SOKONI_LS_KEEP\s*=\s*(\/.*\/[a-z]*);/);
const mirror    = read('shared-header.js').match(/var _SK_LS_KEEP\s*=\s*(\/.*\/[a-z]*);/);

ck('firebase.js declares _SOKONI_LS_KEEP', !!canonical);
ck('shared-header.js declares _SK_LS_KEEP', !!mirror);

if (canonical && mirror) {
  ck('the two keep-lists are byte-identical', canonical[1] === mirror[1],
     canonical[1] === mirror[1] ? '' : canonical[1] + '  vs  ' + mirror[1]);

  /* The keys that must NEVER survive a sign-out, whichever path ran. Named
     explicitly so the intent survives a future edit to the regex itself. */
  const MUST_WIPE = ['sokoniUser', 'sokoniActiveWorkspace', 'activeRole', 'sokoniRole',
                     'permissions', 'authCache', 'cart', 'sellerProfile', '_walletBal'];
  let re = null;
  try { re = eval(canonical[1]); } catch (_) {}
  ck('the canonical pattern compiles', !!re);
  if (re) {
    const leaked = MUST_WIPE.filter((k) => re.test(k));
    ck('no user-scoped key is kept across sign-out', leaked.length === 0, leaked.join(', '));
  }
}

/* The fallback is the whole point: it must actually clear, not merely navigate. */
const sh = read('shared-header.js');
ck('the no-firebase.js fallback wipes storage rather than only redirecting',
   /_skLocalSignOutFallback[\s\S]{0,900}removeItem/.test(sh));
ck('sign-out uses location.replace so Back cannot re-render the authed page',
   /_skSignOutFromAcct[\s\S]{0,700}location\.replace\('login\.html'\)/.test(sh));

console.log('\n' + '='.repeat(60));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
