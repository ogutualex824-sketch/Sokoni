#!/usr/bin/env node
/* ============================================================================
   SOKONI — a health claim requires an observation
   ============================================================================
   "All Systems Operational" is a measurement or it is a decoration. A page that
   asserts it without observing anything says the same thing during an outage as
   on a good day, which makes it worse than silence: it is confidently wrong at
   exactly the moment a user is trying to find out what is broken.

   This gate keeps the claim tied to a source, platform-wide. Any file that
   RENDERS the phrase must either derive it from an observation or be listed
   below with a reason.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(name + (detail ? '  — ' + detail : ''));
  return false;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* The fixes are EXPLAINED in comments that quote the removed phrase. Asserting
   on raw text would read my own prose as the defect it describes. */
function stripAll(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const PHRASE = 'All Systems Operational';

/* Files allowed to render the phrase, each with the observation behind it. */
const OBSERVED = {
  'ecc.html':
    'derived from the observed service statuses — outage/degraded/ok branches',
  'platform.html':
    'derived from d.overallStatus returned by the platform health source',
};

/* KNOWN REMAINING DEFECT, deliberately not edited here. pos-observability.html
   sets the phrase inside _loadDefaults() — a placeholder path that fills the
   metrics with em dashes and then declares everything operational. It belongs
   to the POS observability slice, which another agent is actively working
   (pos.html and pos-setup.html are dirty in this tree), so it is RECORDED
   rather than quietly edited across a slice boundary. */
const KNOWN_UNFIXED = {
  'pos-observability.html':
    '_loadDefaults() asserts the phrase as a placeholder default — POS slice, not edited here',
};

/* ── 1. The two surfaces that were fixed ────────────────────────────────── */
[['support.html', 'spStatusDot'], ['status.html', 'overallDot']].forEach(function (pair) {
  const file = pair[0];
  const raw = read(file);
  const code = stripAll(raw);

  ok(file + ': CONTROL — the stripped file is readable', code.indexOf(pair[1]) !== -1);
  ok(file + ': does NOT render an unobserved health claim',
    code.indexOf(PHRASE) === -1,
    'the phrase survives outside a comment');
  ok(file + ': CONTROL — the phrase IS still present in the explanatory comment',
    raw.indexOf(PHRASE) !== -1,
    'the strip removed too much, so the assertion above proves nothing');
  ok(file + ': renders an explicit not-measured state',
    /not checked here|not yet measured/.test(code));
  ok(file + ': the indicator is neither green nor red',
    /unknown|unobserved/.test(code));
});

/* The specific claims that must not come back. */
{
  const sup = stripAll(read('support.html'));
  ok('support.html: the green dot is gone from the status row',
    !/sp-status-dot green/.test(sup));
  const st = stripAll(read('status.html'));
  ok('status.html: no longer asserts services are running normally',
    st.indexOf('running normally') === -1);
  ok('status.html: no longer claims a check is in progress forever',
    st.indexOf('Checked: loading') === -1);
  ok('status.html: the banner no longer carries the operational class',
    !/class="status-banner operational"/.test(st));
  /* And it still says nothing green: the page genuinely observes nothing. */
  /* Tightened: the first version matched the WORD "Firestore" inside a service
     DESCRIPTION — "Firebase Firestore, Cloud Functions, Storage" — which is a
     label naming a product, not a call that observes anything. A page is
     allowed to NAME the services it lists. Assert on the API surface instead. */
  ok('status.html: still performs no observation, and no longer pretends to',
    !/firebase\.firestore\(|getDocs\(|onSnapshot\(|httpsCallable\(|fetch\(/.test(st));
}

/* ── 2. Legitimate, observation-derived claims are untouched ────────────── */
Object.keys(OBSERVED).forEach(function (file) {
  const code = stripAll(read(file));
  ok(file + ': still renders the phrase (' + OBSERVED[file] + ')',
    code.indexOf(PHRASE) !== -1,
    'a legitimate observed claim was removed by mistake');
});
/* CONTROL: the detector CAN see the phrase. Without this, every "does not
   render" assertion above could pass simply because the sweep is blind. */
ok('CONTROL: the detector finds the phrase where it legitimately lives',
  stripAll(read('ecc.html')).indexOf(PHRASE) !== -1,
  'the absence assertions prove nothing');

/* ── 3. Platform-wide: no NEW unobserved claim may appear ───────────────── */
{
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  ok('CONTROL: the sweep found html files to scan', files.length > 20, String(files.length));

  const offenders = files.filter((f) => {
    if (OBSERVED[f] || KNOWN_UNFIXED[f]) return false;
    try { return stripAll(read(f)).indexOf(PHRASE) !== -1; } catch (e) { return false; }
  });
  ok('no file outside the reviewed set renders an unobserved health claim',
    offenders.length === 0, offenders.join(','));

  /* The known-unfixed entry is an inventory item, not a pass. It is asserted to
     STILL be there so that the day someone fixes it, this line goes red and the
     record is updated rather than silently rotting. */
  Object.keys(KNOWN_UNFIXED).forEach(function (f) {
    ok('RECORDED (not fixed): ' + f + ' — ' + KNOWN_UNFIXED[f],
      stripAll(read(f)).indexOf(PHRASE) !== -1,
      'it appears to have been fixed — remove it from KNOWN_UNFIXED');
  });
}

console.log('');
console.log('  SOKONI health-claim honesty');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
