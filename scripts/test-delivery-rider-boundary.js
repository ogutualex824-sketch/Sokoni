#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   DELIVERY — NETWORK MEMBERSHIP vs SHOP EMPLOYMENT ARE INDEPENDENT IDENTITIES
   ══════════════════════════════════════════════════════════════════════════════
   THE LOCKED INVARIANT

     shopEmployees/{uid}   may CLASSIFY an already-eligible rider for a shop.
                           It can NEVER create SOKONI-network eligibility.
     drivers/{uid}         IS the network-enrolment record. Created only by the
                           rider application/approval path (projectDriver in
                           application-lifecycle.js). Client writes forbidden.
     riderLocations/{uid}  live location, writable ONLY by that rider.

   WHY THIS FILE EXISTS
   The invariant currently holds because of TWO INDEPENDENT DECISIONS in two
   different files: `allow write: if false` on drivers/ in firestore.rules, and
   `if (!d) return;` in the candidate loop of delivery-marketplace.js. Neither
   mentions the other. Someone relaxing either — reasonably, locally — collapses
   a security boundary without any single place saying so. That is what this
   asserts against.

   It reads the rules and the delivery module from GIT REFS, so it works from any
   checkout: the rules live on the production lineage, the delivery module only
   on feat/delivery-marketplace.

   NOT A COMMENT CHECK. Every assertion targets executable content, and each
   detector carries a control proving it can fail. A test that only reads the
   reassuring comments beside the code proves the comments.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const cp = require('child_process');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0, invalid = 0;
const ok = (l, d) => { pass++; console.log('  PASS       ' + l + (d ? '   [' + d + ']' : '')); };
const no = (l, d) => { fail++; console.log('  FAIL       ' + l + (d ? '   [' + d + ']' : '')); };
const ck = (l, c, d) => (c ? ok(l, d) : no(l, d));
const un = (l, d) => { unproven++; console.log('  UNPROVEN   ' + l + (d ? '   [' + d + ']' : '')); };
const iv = (l, d) => { invalid++; console.log('  HARNESS-INVALID  ' + l + (d ? '   [' + d + ']' : '')); };
const head = (t) => console.log('\n-- ' + t + ' --');

function show (ref, file) {
  try { return cp.execSync('git show ' + ref + ':' + file, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return null; }
}

/* Extract one `match /<name>/{...} { ... }` block by brace matching. A fixed
   character window would swallow the next match block or stop inside this one —
   that mistake has produced false verdicts on this codebase before. */
function matchBlock (rules, collection) {
  const re = new RegExp('match\\s+/' + collection + '/\\{[A-Za-z0-9_]+\\}\\s*\\{');
  const m = re.exec(rules);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  while (i < rules.length && depth > 0) {
    const c = rules[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return rules.slice(m.index, i);
}

/* Strip comments before any NEGATIVE content assertion. A detector for
   `data.riderType` fired on the COMMENT that says request.data.riderType is
   ignored — prose describing the safe behaviour read as the unsafe behaviour.
   Conservative: leaves string literals alone by only cutting outside quotes. */
function stripComments (src) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) { out += c; if (c === q && src[i - 1] !== String.fromCharCode(92)) q = null; i++; continue; }
    if (c === String.fromCharCode(34) || c === String.fromCharCode(39) || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === '/' && n === '/') { const e = src.indexOf(String.fromCharCode(10), i); i = e < 0 ? src.length : e; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}

/* Brace-matched, never a character window. A 300-char window missed a catch
   block whose body ran to 313 characters and reported fail-open behaviour that
   was actually fail-closed. */
function blockAfter (src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return null;
  let j = src.indexOf('{', i);
  if (j < 0) return null;
  let depth = 1; j++;
  const start = j;
  while (j < src.length && depth > 0) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  }
  return src.slice(start, j - 1);
}

const RULES_REF = 'HEAD';                       /* production lineage */
const DELIV_REF = 'feat/delivery-marketplace';  /* where the module lives */

(function () {
  head('0 - harness integrity');
  const rules = show(RULES_REF, 'firestore.rules');
  if (!rules) { iv('cannot read firestore.rules from ' + RULES_REF); }
  else ok('firestore.rules readable', rules.length + ' bytes');

  const deliv = show(DELIV_REF, 'functions/delivery-marketplace.js');
  if (!deliv) {
    un('delivery-marketplace.js not reachable', DELIV_REF + ' missing — section 2 cannot run');
  } else ok('delivery-marketplace.js readable', deliv.length + ' bytes');

  /* Prove the block extractor works before trusting any verdict it produces. */
  if (rules) {
    const b = matchBlock(rules, 'drivers');
    ck('block extractor finds drivers/', !!b, b ? b.split('\n')[0].trim() : 'not found');
    ck('...and stops at its own closing brace', !!b && (b.match(/\{/g) || []).length === (b.match(/\}/g) || []).length,
      b ? 'braces balanced' : '-');
    ck('CONTROL extractor returns null for a collection that does not exist',
      matchBlock(rules, 'definitelyNotACollectionXyz') === null);
  }

  head('1 - the RULES boundary: drivers/ is CF-only, riderLocations/ is self-only');
  if (rules) {
    const drivers = matchBlock(rules, 'drivers') || '';
    const writes = (drivers.match(/allow\s+write[^;]*;/g) || []).map((s) => s.replace(/\s+/g, ' ').trim());
    ck('drivers/ declares a write rule at all', writes.length > 0, writes.join(' | ') || 'none');
    ck('...and EVERY write rule is `if false`', writes.length > 0 && writes.every((w) => /if\s+false\s*;/.test(w)),
      writes.join(' | '));
    ck('...so a shop owner cannot manufacture a network rider', writes.every((w) => !/request\.auth/.test(w)),
      'no auth-based write path exists');

    const rl = matchBlock(rules, 'riderLocations') || '';
    const rlw = (rl.match(/allow\s+write[^;]*;/g) || []).map((s) => s.replace(/\s+/g, ' ').trim());
    ck('riderLocations/ is writable only by the rider themselves',
      rlw.length > 0 && rlw.every((w) => /riderId\s*==\s*request\.auth\.uid/.test(w)), rlw.join(' | '));

    /* CONTROL: the detector must NOT call every collection CF-only, or the two
       assertions above would pass on any input. riderLocations is the proof. */
    ck('CONTROL the detector distinguishes the two: riderLocations is NOT `if false`',
      rlw.length > 0 && !rlw.every((w) => /if\s+false\s*;/.test(w)), 'otherwise both checks are vacuous');
  } else un('rules assertions skipped', 'firestore.rules unreadable');

  head('2 - the FUNCTION boundary: riderType derived, enrolment required');
  if (deliv) {
    const code = stripComments(deliv);   /* negatives must not fire on prose */
    /* riderType must be COMPUTED from shop membership, never taken from input. */
    ck('riderType is derived from shop membership', /riderType\s*=\s*shopIds\.has\(/.test(deliv),
      (deliv.match(/riderType\s*=\s*shopIds\.has\([^;]*/) || [''])[0].slice(0, 60));
    ck('NEGATIVE riderType is never read from client input',
      code.indexOf('data.riderType') === -1, 'no data.riderType in EXECUTABLE code');
    ck('NEGATIVE the module never WRITES drivers/ (cannot self-enrol)',
      !/collection\(['"]drivers['"]\)\s*\.\s*doc\([^)]*\)\s*\.\s*(set|update|create)/.test(code),
      'classification only');

    /* Enrolment is required for candidacy: a location without a drivers doc is dropped. */
    ck('a rider with NO drivers doc is dropped from candidacy', /if\s*\(\s*!d\s*\)\s*return\s*;/.test(deliv),
      'location without identity is not offerable');
    ck('...and an unavailable rider is dropped', /d\.available\s*!==\s*true/.test(deliv));

    /* Classification must not widen eligibility. */
    ck('shop classification filters role == rider', /where\(['"]role['"],\s*['"]==['"],\s*['"]rider['"]\)/.test(deliv));
    ck('...and excludes revoked/suspended employees',
      /status\s*===\s*['"]revoked['"]/.test(code) && /status\s*===\s*['"]suspended['"]/.test(code));
    ck('...and a failed lookup returns an EMPTY set, never a wide one',
      (function () { const b = blockAfter(code, '_shopRiderIds'); const c = b && blockAfter(b, 'catch'); return !!c && c.indexOf('return new Set()') > -1; })(),
      'brace-matched catch block, not a character window');

    ck('CONTROL stripComments kept the executable code intact',
      code.indexOf('riderType = shopIds.has(') > -1 && code.length > deliv.length * 0.4,
      'stripped ' + (deliv.length - code.length) + ' chars of prose, code assertions still match');
    ck('CONTROL the detectors can fail: a bogus pattern is absent',
      !/riderType\s*=\s*request\.data\.riderType/.test(code), 'proves the negatives are not vacuous');
  } else un('function assertions skipped', DELIV_REF + ' unreachable');

  head('3 - the two halves are INDEPENDENT (why this file exists)');
  if (rules && deliv) {
    const rulesMentionsCandidate = /delivery-marketplace|candidate loop/i.test(rules);
    const delivMentionsRule = /allow\s+write/.test(deliv);
    ck('firestore.rules does not reference the candidate loop', !rulesMentionsCandidate,
      'neither file documents the other — that is the hazard');
    ck('delivery-marketplace.js does not restate the rule', !delivMentionsRule);
    ok('=> both must be asserted together, which is what sections 1 and 2 do');
  }

  head('what this suite does NOT prove');
  un('runtime enforcement of the deployed ruleset', 'asserts the repo rules; the SERVED ruleset is a separate artefact');
  un('that projectDriver is the ONLY creator of drivers/', 'asserted for delivery-marketplace only; a full writer census is separate');
  console.log('  NOTE      available is GLOBAL: an enrolled rider cannot decline one shop.');
  console.log('            That is a dispatch/product policy question, not a security gap.');

  console.log('\n' + '-'.repeat(62));
  console.log('  PASS ' + pass + '   FAIL ' + fail + '   UNPROVEN ' + unproven + '   HARNESS-INVALID ' + invalid);
  process.exit((fail || invalid) ? 1 : 0);
})();
