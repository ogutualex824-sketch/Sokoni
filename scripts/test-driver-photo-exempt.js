/* ══════════════════════════════════════════════════════════════════════════════
   DRIVER PHOTO EXEMPTION — IDENTITY KEY CERTIFICATION
   scripts/test-driver-photo-exempt.js      node scripts/test-driver-photo-exempt.js

   WHAT THIS PINS
   `driver.html` lets one owner test account complete rider onboarding without uploading
   ID/DL photos, so the dispatch path can be proven before the live gate. The exemption
   used to be keyed on a UID *or* an email address:

       _cu.uid === 'D5Ql…' || (_cu.email||'').toLowerCase() === 'alexochieng3030@gmail.com'

   That account is being renamed (alexochieng3030@gmail.com -> superadmin@mysokoni.co.ke).
   An email-keyed gate breaks in both directions on a rename: the owner loses the exemption,
   and whoever is later given the freed address gains it. `scripts/verify-claim-based-auth.js`
   flags exactly this, and states why a UID allowlist is acceptable where an email is not —
   a UID is stable across an address change.

   WHAT THIS IS NOT
   This exemption is NOT an authorization boundary. The ID/DL photos it gates are read to
   base64 and written to localStorage; the Firestore application carries no photos, and no
   Cloud Function reads `idPhoto`/`dlPhoto` — the fields exist only in driver.html and one
   QA dry-run. Whether driver documents should be transmitted and verified at all is a
   separate architectural question and is deliberately NOT addressed here.

   HOW IT IS ASSERTED
   The real statement is extracted from the page and EXECUTED against stub identities, so
   what is proven is the value the shipped expression produces — not the presence of a
   string that a comment could satisfy.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

const PAGE = 'driver.html';
const OWNER_UID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const OLD_EMAIL = 'alexochieng3030@gmail.com';
const html = fs.readFileSync(path.join(ROOT, PAGE), 'utf8');

/* Extract the shipped statement and build an evaluator for it. */
const STMT = (html.match(/var _photoExempt =[^\n]*;/) || [])[0];
const evaluate = (cu) => {
  /* eslint-disable no-new-func */
  const f = new Function('_cu', STMT + '\n return _photoExempt;');
  return f(cu);
};

console.log('══════════════════════════════════════════════════════════════════');
console.log('  DRIVER PHOTO EXEMPTION — IDENTITY KEY');
console.log('══════════════════════════════════════════════════════════════════');

head('0 - the shipped statement');
{
  ok('control — the statement was extracted', !!STMT && STMT.length > 20,
     STMT ? STMT.trim() : 'NOT FOUND');
  ok('control — it is evaluable', typeof evaluate({ uid: 'x' }) === 'boolean');
}

/* ── THE IDENTITY MATRIX ────────────────────────────────────────────────────── */
head('1 - who is exempt, and who is not');
{
  ok('owner UID + owner email  -> exempt',
     evaluate({ uid: OWNER_UID, email: OLD_EMAIL }) === true);
  /* The rename case: same person, new address. The exemption must survive it. */
  ok('owner UID + different email -> exempt (survives the rename)',
     evaluate({ uid: OWNER_UID, email: 'superadmin@mysokoni.co.ke' }) === true);
  ok('owner UID + no email at all -> exempt',
     evaluate({ uid: OWNER_UID }) === true);

  /* THE NEGATIVE THAT MATTERS: the freed-address case. Someone who is NOT the owner but
     holds the old address must gain nothing by it. */
  ok('different UID + owner\'s OLD email -> NOT exempt',
     evaluate({ uid: 'someone-else-entirely', email: OLD_EMAIL }) === false);
  ok('different UID + old email in MIXED CASE -> NOT exempt',
     evaluate({ uid: 'someone-else-entirely', email: 'AlexOchieng3030@Gmail.com' }) === false);

  ok('an ordinary rider -> NOT exempt',
     evaluate({ uid: 'rider-123', email: 'rider@example.com' }) === false);
  ok('an unauthenticated visitor -> NOT exempt', evaluate(null) === false);
  ok('a signed-in user with no uid -> NOT exempt', evaluate({ email: OLD_EMAIL }) === false);
}

/* ── THE KEY ITSELF ─────────────────────────────────────────────────────────── */
head('2 - the gate is keyed on the stable identifier');
{
  ok('the statement reads the uid', /_cu\.uid/.test(STMT));
  ok('and does NOT read an email', !/\.email/.test(STMT), STMT.trim());
  ok('no email literal appears in the statement', !/@/.test(STMT));
  /* CONTROL — the old form would have failed the two assertions above, so they
     discriminate rather than being trivially true of any statement. */
  const OLD = "var _photoExempt = !!_cu && (_cu.uid==='" + OWNER_UID +
              "' || (_cu.email||'').toLowerCase()==='" + OLD_EMAIL + "');";
  ok('control — the OLD form does read an email', /\.email/.test(OLD));
  const oldEval = new Function('_cu', OLD + '\n return _photoExempt;');
  ok('control — and the OLD form WOULD have exempted the freed address',
     oldEval({ uid: 'someone-else-entirely', email: OLD_EMAIL }) === true,
     'this is the defect being repaired');
}

/* ── WHAT THE EXEMPTION GATES — SCOPE, RE-PROVEN ────────────────────────────── */
head('3 - the exemption gates form validation, not an authorization boundary');
{
  ok('it is read only by the two photo checks',
     (html.match(/_photoExempt/g) || []).length === 3, /* declaration + 2 reads */
     (html.match(/_photoExempt/g) || []).length + ' occurrences');
  ok('both reads are upload prompts',
     /if\(!idPhotoFile && !_photoExempt\)/.test(html) &&
     /if\(!dlPhotoFile && !_photoExempt\)/.test(html));
  /* The photos never leave the device, so this gate grants no server-side privilege.
     Recorded here so the scope of the repair cannot be overstated later. */
  const fnDir = path.join(ROOT, 'functions');
  const reads = fs.readdirSync(fnDir).filter(f => f.endsWith('.js')).some(f => {
    try { return /idPhoto|dlPhoto/.test(fs.readFileSync(path.join(fnDir, f), 'utf8')); }
    catch (_) { return false; }
  });
  ok('no Cloud Function reads idPhoto/dlPhoto', !reads);
  ok('the Firestore application carries no photo field',
     /saveApplication\(\{[\s\S]{0,400}?\}\)/.test(html) &&
     !/saveApplication\(\{[\s\S]{0,400}?(idPhoto|dlPhoto)/.test(html));
}

console.log('\n  what this suite does NOT prove');
console.log('  OUT OF SCOPE  whether driver ID/DL documents should be transmitted and');
console.log('                verified at all. They are collected to localStorage and never');
console.log('                sent. That is a driver-verification ARCHITECTURE question with');
console.log('                its own design and authorization — not this hygiene repair.');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
