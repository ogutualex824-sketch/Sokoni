/* BEFORE-PROOF — the admin.html password/pattern/PIN lock.
   ==========================================================================
   Run:  node scripts/before-admin-lock.js

   super-admin.html's master passcode was removed earlier on the evidence that it
   appeared in 0 Cloud Functions and 0 rules, so nothing server-side could observe
   it. admin.html's lock is a DIFFERENT construct — it stores a real per-device
   credential hash — so it gets its own measurement rather than the same conclusion
   by assumption.

   The six questions:
     1  what does it store and validate
     2  does any Cloud Function observe it
     3  do the Firestore rules observe it
     4  does it grant authority, or only unlock the local Admin UI
     5  what remains if it is removed
     6  is it a device-local convenience factor

   ON NEGATIVE RESULTS. "0 Cloud Functions observe it" is only evidence if the same
   search would have FOUND something that is present. Every zero below is paired with
   a positive control searching the same corpus for a token known to be there. A
   detector that finds nothing because it is broken reports the same zero as a
   detector that finds nothing because there is nothing.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* Recursive grep over a directory, skipping node_modules. */
function grepDir(dir, re) {
  const hits = [];
  (function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|cjs|mjs|ts|json)$/.test(e.name)) continue;
      let s = ''; try { s = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      if (re.test(s)) hits.push(path.relative(ROOT, p));
    }
  }(path.join(ROOT, dir)));
  return hits;
}

const admin = read('admin.html');

console.log('\n  admin.html lock — before-proof\n');
console.log('  ── 1. what it stores and validates');

const CRED = /CRED_KEYS\s*=\s*\{[^}]*sokoniAdminPinHash[^}]*\}/.test(admin);
ck('credential keys are localStorage names, not a server record', CRED,
  'sokoniAdminPinHash / PatternHash / PwHash');
ck('the stored value is a HASH, produced by SHA-256',
  /crypto\.subtle\.digest\(\s*['"]SHA-256['"]/.test(admin), '');
/* An unsalted digest of a 4-digit PIN has 10,000 candidates; the whole keyspace is
   enumerable in milliseconds by anyone holding the stored hash. That is a property of
   the construct, not a claim about anyone's device. */
const SALTED = /salt/i.test(admin.slice(
  Math.max(0, admin.indexOf('async function _sha256') - 400),
  admin.indexOf('async function _sha256') + 600));
ck('the hash is UNSALTED (recorded, not a pass/fail of the product)', !SALTED,
  '4-digit PIN = 10^4 candidates');

console.log('\n  ── 2. does any Cloud Function observe it');
const LOCK_TOKENS = /sokoniAdminPinHash|sokoniAdminPatternHash|sokoniAdminPwHash|['"]3026['"]|sokoniAdminUnlocked/;
const fnHits = grepDir('functions', LOCK_TOKENS);
/* CONTROL: the same walker over the same corpus must find a token that IS there. */
const fnControl = grepDir('functions', /adminOsDispatch/);
ck('CONTROL the functions walker finds a token that IS present',
  fnControl.length > 0, 'adminOsDispatch in ' + fnControl.length + ' file(s)');
ck('0 Cloud Functions observe the lock', fnHits.length === 0,
  fnHits.length ? fnHits.join(', ') : 'searched ' + 'functions/');

console.log('\n  ── 3. do the Firestore rules observe it');
for (const f of ['firestore.rules.served-current', 'firestore.rules']) {
  const src = read(f);
  if (!src) { ck('rules file present: ' + f, false, 'not found'); continue; }
  /* CONTROL: a token known to be in the served ruleset. */
  const ctl = /activeRoleApproved/.test(src);
  ck('CONTROL ' + f + ' search finds a rule token that IS present', ctl, 'activeRoleApproved');
  ck('0 references to the lock in ' + f, !LOCK_TOKENS.test(src), '');
}

console.log('\n  ── 4/5. does it grant authority, or only unlock the local UI');
const flow = admin.slice(admin.indexOf('async function _tryUnlock'),
  admin.indexOf('async function _tryUnlock') + 3200);
const iCred  = flow.indexOf('entered === stored');
const iClaim = flow.indexOf('getIdTokenResult');
const iCtx   = flow.indexOf('SokoniAdminEntry.guard');
const iShow  = flow.indexOf('adminDash');
ck('the claim check runs AFTER the credential is accepted',
  iCred > -1 && iClaim > iCred, 'cred@' + iCred + ' claim@' + iClaim);
ck('the F4 adminContext gate runs after the claim',
  iCtx > iClaim, 'ctx@' + iCtx);
ck('the dashboard is revealed only after BOTH',
  iShow > iCtx && iCtx > -1, 'reveal@' + iShow);
ck('a missing claim DENIES even with a correct credential',
  /Firebase admin claim not found[\s\S]{0,80}return/.test(flow), '');
ck('a claim-verification ERROR denies rather than admitting',
  /catch\s*\(claimErr\)[\s\S]{0,300}return/.test(flow), 'no offline bypass');

console.log('\n  ── 6. device-local convenience factor');
ck('the credential is set on the device by the admin, not issued',
  /localStorage\.setItem\(CRED_KEYS\.(pin|password|pattern)\s*,/.test(admin), '');
ck('no server ever receives the credential or its hash',
  fnHits.length === 0 && !/fetch\([^)]*CRED_KEYS|CRED_KEYS[^;]*fetch\(/.test(admin), '');

console.log('\n  ── the master passcode');
const MASTER = /String\(secret\)\s*===\s*['"]3026['"]/.test(admin);
ck('RECORDED: the 3026 master passcode is still in admin.html', MASTER,
  MASTER ? 'accepted as PIN or password, bypasses the stored hash' : '');
ck('it is compiled into shipped client source (not a secret)', MASTER, '');

console.log('\n  ── what removal would leave');
ck('Firebase claim check present and independent of the lock', iClaim > -1, '');
ck('adminContext gate present and independent of the lock', iCtx > -1, '');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
console.log('  Static measurement of admin.html, functions/ and the SERVED ruleset.');
console.log('  It does not prove runtime behaviour for a real signed-in administrator.\n');
process.exit(fail ? 1 : 0);
