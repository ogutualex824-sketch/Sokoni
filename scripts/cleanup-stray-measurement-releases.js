#!/usr/bin/env node
/* DELETE THE STRAY MEASUREMENT RELEASES — cleanup only, nothing else.
 *
 * Twelve releases left behind by earlier rules-sizing work are still in the project, each
 * pinning a ruleset. They are inert — Firestore enforces `cloud.firestore` and nothing
 * else — but they are litter, and litter in a production project is how a later operator
 * mistakes a probe artifact for something load-bearing.
 *
 * ══ WHY THE TARGETS ARE ENUMERATED, NOT MATCHED ═════════════════════════════════════
 * A pattern like /^measure-/ would delete whatever happens to match on the day it runs,
 * including something created since the listing that nobody has looked at. The twelve
 * names below were each read off a listing and confirmed. Anything not on this list is
 * not touched, and if the project no longer contains exactly these twelve the script
 * REFUSES rather than proceeding with a partial match — a cleanup that quietly does less
 * (or more) than it reported is worse than one that stops.
 *
 * ══ PROTECTED, BY ASSERTION ═════════════════════════════════════════════════════════
 *   cloud.firestore                     live Firestore enforcement
 *   sokoni-aeb26.firebasestorage.app    live Storage enforcement
 *   sokoni-ops                          purpose unknown -> therefore untouchable
 *
 * A ruleset is deleted only after its release is gone AND no surviving release still
 * references it. Two releases can point at one ruleset; deleting it out from under a
 * survivor would break that release.
 *
 * This performs NO rules consolidation and NO publication. Cleanup only.
 *
 *   node scripts/cleanup-stray-measurement-releases.js [--apply]
 *   (dry run by default: it shows exactly what it would delete and changes nothing)
 */
'use strict';
const { spawnSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const API = 'https://firebaserules.googleapis.com/v1/projects/' + PROJECT;
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
const APPLY = process.argv.indexOf('--apply') > -1;

const PROTECTED = ['cloud.firestore', 'sokoni-aeb26.firebasestorage.app', 'sokoni-ops'];

const TARGETS = [
  'measure-ballast-all3-23280',
  'measure-ballast-base-18804',
  'measure-ballast-ledger-12424',
  'measure-ballast-optA-23060',
  'measure-ballast-optB-18152',
  'measure-ballast-orders-23980',
  'measure-ballast-units-21280',
  'measure-live-baseline-10128',
  'measure-live-nocomments-18508',
  'measure-candidate-final-10908',
  'measure-no-landlorddata-6112',
  'diagnostic-control-1786705005'
];

let TOKEN = '';
function api (method, path) {
  const r = spawnSync('curl', ['-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'x-goog-user-project: ' + PROJECT,
    API + path], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  try { return JSON.parse(String(r.stdout || '')); }
  catch (_) { return { __raw: String(r.stdout || '').slice(0, 300) }; }
}

/* AN ERROR IS NOT AN EMPTY PROJECT.
   The first run of this script asked for pageSize=200, which the API rejects (max 100),
   and `(j.releases || [])` turned that 400 into "0 releases" — reporting cloud.firestore
   itself as ABSENT. The refusal guard caught it, but only by luck of direction: the same
   swallow on a DIFFERENT call could have reported a protected release as already gone.
   Any non-list response now throws. */
function listAll (kind) {
  const out = [];
  let token = '';
  do {
    const j = api('GET', '/' + kind + '?pageSize=100' + (token ? '&pageToken=' + token : ''));
    if (j.error) throw new Error(kind + ' list failed: ' + j.error.status + ' ' + j.error.message);
    if (!Array.isArray(j[kind])) throw new Error(kind + ' list returned no array :: ' + JSON.stringify(j).slice(0, 200));
    out.push.apply(out, j[kind]);
    token = j.nextPageToken || '';
  } while (token);
  return out;
}

function listReleases () {
  return listAll('releases').map((r) => ({
    name: r.name.split('/').pop(),
    ruleset: String(r.rulesetName || '').split('/').pop(),
    updateTime: r.updateTime
  }));
}

/* the guard, applied to every single delete — not once at the top */
function assertDeletable (name) {
  if (PROTECTED.indexOf(name) > -1) throw new Error('REFUSED: "' + name + '" is protected.');
  if (TARGETS.indexOf(name) === -1) throw new Error('REFUSED: "' + name + '" is not a named target.');
}

const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { console.log('  no access token'); process.exit(1); }

const before = listReleases();
const beforeMap = {};
before.forEach((r) => { beforeMap[r.name] = r; });

/* ── the record that the post-check is measured against ───────────────────── */
const baseline = {};
PROTECTED.forEach((p) => { baseline[p] = beforeMap[p] || null; });

console.log('');
console.log('  releases in project : ' + before.length);
console.log('');
console.log('  PROTECTED — recorded now, compared after');
PROTECTED.forEach((p) => {
  const r = beforeMap[p];
  console.log('    ' + p.padEnd(34) + (r ? r.ruleset.slice(0, 8) + '…  ' + r.updateTime : 'ABSENT'));
});

const found = TARGETS.filter((t) => beforeMap[t]);
const missing = TARGETS.filter((t) => !beforeMap[t]);
console.log('');
console.log('  TARGETS — ' + found.length + ' of ' + TARGETS.length + ' present');
found.forEach((t) => console.log('    ' + t.padEnd(34) + beforeMap[t].ruleset));
if (missing.length) missing.forEach((t) => console.log('    ' + t.padEnd(34) + 'ALREADY ABSENT'));

/* refuse a partial match rather than doing a bit of the job */
if (found.length !== TARGETS.length) {
  console.log('');
  console.log('  REFUSING: expected all ' + TARGETS.length + ' targets present, found ' + found.length + '.');
  console.log('  The project is not in the state this cleanup was authorised against.');
  process.exit(1);
}

/* a ruleset may be shared; only delete one nothing surviving still needs */
const targetRulesets = found.map((t) => beforeMap[t].ruleset);
const survivors = before.filter((r) => TARGETS.indexOf(r.name) === -1);
const pinned = {};
survivors.forEach((r) => { pinned[r.ruleset] = r.name; });
const shared = targetRulesets.filter((id) => pinned[id]);
if (shared.length) {
  console.log('');
  console.log('  These rulesets are ALSO referenced by a surviving release — release will be');
  console.log('  deleted, ruleset KEPT:');
  shared.forEach((id) => console.log('    ' + id + '  <- ' + pinned[id]));
}
const deletableRulesets = targetRulesets.filter((id) => !pinned[id]);

if (!APPLY) {
  console.log('');
  console.log('  DRY RUN — nothing changed. Would delete ' + found.length + ' releases and ' +
              deletableRulesets.length + ' rulesets.');
  console.log('  Re-run with --apply to perform it.');
  console.log('');
  process.exit(0);
}

/* NEGATIVE CONTROL — prove the post-check can SEE these before claiming it saw them go.
   "All 12 rulesets absent" is satisfied by a listing that returns nothing at all, so the
   assertion is worthless unless the same call finds them while they still exist. This is
   the converse test, run before anything is deleted. */
const rsBefore = listAll('rulesets').map((r) => r.name.split('/').pop());
const visible = deletableRulesets.filter((id) => rsBefore.indexOf(id) > -1);
console.log('');
console.log('  CONTROL — ' + visible.length + ' of ' + deletableRulesets.length +
            ' target rulesets visible in the listing BEFORE deletion');
if (visible.length !== deletableRulesets.length) {
  console.log('  REFUSING: the post-check cannot see what it is meant to verify the removal');
  console.log('  of, so its absence assertion would pass vacuously.');
  console.log('  not visible: ' + deletableRulesets.filter((id) => rsBefore.indexOf(id) === -1).join(', '));
  process.exit(1);
}

console.log('');
console.log('  DELETING');
let errors = 0;
found.forEach((t) => {
  assertDeletable(t);
  const d = api('DELETE', '/releases/' + t);
  const ok = !(d && d.error);
  if (!ok) errors++;
  console.log('    release  ' + t.padEnd(34) + (ok ? 'deleted' : 'ERROR ' + d.error.status));
});
deletableRulesets.forEach((id) => {
  const d = api('DELETE', '/rulesets/' + id);
  const ok = !(d && d.error);
  if (!ok) errors++;
  console.log('    ruleset  ' + id.padEnd(34) + (ok ? 'deleted' : 'ERROR ' + d.error.status));
});

/* ── independent post-check: re-list, do not trust the deletes' own replies ── */
console.log('');
console.log('  POST-CHECK — re-listed from the API, not inferred from the calls above');
const after = listReleases();
const afterMap = {};
after.forEach((r) => { afterMap[r.name] = r; });

let pass = 0, fail = 0;
const ck = (label, cond, note) => {
  if (cond) { pass++; console.log('    PASS  ' + label); }
  else { fail++; console.log('    FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};

ck('all 12 targeted releases absent',
   TARGETS.every((t) => !afterMap[t]),
   TARGETS.filter((t) => afterMap[t]).join(', '));

/* Through listAll, so a rejected page throws instead of yielding []. Left as a bare
   api() call, this assertion passed VACUOUSLY: pageSize=200 is refused, the empty array
   contains none of the ids, and "all rulesets absent" reads PASS whether or not a single
   one was deleted. An absence check is only worth anything if the list was real. */
const rsIds = listAll('rulesets').map((r) => r.name.split('/').pop());
ck('all ' + deletableRulesets.length + ' associated rulesets absent',
   deletableRulesets.every((id) => rsIds.indexOf(id) === -1),
   deletableRulesets.filter((id) => rsIds.indexOf(id) > -1).join(', '));

PROTECTED.forEach((p) => {
  const b = baseline[p], a = afterMap[p];
  if (!b) { ck(p + ' — was absent before, still absent', !a); return; }
  ck(p + ' — ruleset unchanged', a && a.ruleset === b.ruleset,
     a ? b.ruleset + ' -> ' + a.ruleset : 'MISSING AFTER');
  ck(p + ' — updateTime unchanged', a && a.updateTime === b.updateTime,
     a ? b.updateTime + ' -> ' + a.updateTime : 'MISSING AFTER');
});

ck('no delete reported an error', errors === 0, errors + ' error(s)');
ck('releases went ' + before.length + ' -> ' + (before.length - TARGETS.length),
   after.length === before.length - TARGETS.length,
   'actual ' + after.length);

console.log('');
console.log('  surviving releases:');
after.forEach((r) => console.log('    ' + r.name));
console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
