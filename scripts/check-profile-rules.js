#!/usr/bin/env node
'use strict';

/**
 * Regression guard for the 2026-07-24 profile-save fix (emulator-free).
 *
 * The bug: noAdminFields / noSelfGrant / noPrivilegeEscalation checked the
 * PRESENCE of protected fields on request.resource.data — which on a
 * setDoc(merge:true) UPDATE is the whole merged document. Any user whose doc
 * already carried role/verified/featured/ageVerified/… had EVERY self-update
 * denied. The founder's own account (field `role`) could never save a profile.
 *
 * The fix makes each guard create/update-aware: presence on create
 * (resource == null), and diff(resource.data).affectedKeys() on update — so only
 * a CHANGE to a protected field is rejected, never its mere presence.
 *
 * A full behavioural test needs the Firestore emulator, which this environment
 * cannot run (firebase-tools requires JDK 21; Java 17 present). This static guard
 * asserts the fix is in place so it cannot silently regress to the presence form.
 *
 *   node scripts/check-profile-rules.js
 */
const fs = require('fs');
const path = require('path');
const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

function body(fn) {
  const m = new RegExp('function ' + fn + '\\(\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(rules);
  return m ? m[1] : null;
}

let failed = 0;
const check = (name, cond) => { if (cond) { console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name); } };

console.log('\nProfile-save rule guard\n');

['noAdminFields', 'noSelfGrant'].forEach(fn => {
  const b = body(fn);
  check(fn + ' exists', !!b);
  if (!b) return;
  check(fn + ' is create/update-aware (resource == null)', /resource == null/.test(b));
  check(fn + ' uses diff().affectedKeys() on update',
    /diff\(resource\.data\)\s*\.?\s*\n?\s*\.?affectedKeys\(\)/.test(b) || /diff\(resource\.data\)\.affectedKeys\(\)/.test(b));
});

const pe = body('noPrivilegeEscalation');
check('noPrivilegeEscalation exists', !!pe);
if (pe) check('noPrivilegeEscalation diff-guards registeredAs on update',
  /resource == null/.test(pe) && /diff\(resource\.data\)\.affectedKeys\(\)\.hasAny\(\['registeredAs'\]\)/.test(pe));

/* The protected-field lists must still be enforced (fix must not have dropped
   the fields it guards). */
['isAdmin', 'verified', 'role', 'commissionRate'].forEach(f =>
  check('noAdminFields still guards ' + f, (body('noAdminFields') || '').includes("'" + f + "'")));
['ageVerified', 'role', 'permissions'].forEach(f =>
  check('noSelfGrant still guards ' + f, (body('noSelfGrant') || '').includes("'" + f + "'")));

console.log(failed ? `\n${failed} FAILED\n` : '\nAll checks passed\n');
process.exit(failed ? 1 : 0);
