/* Regression guard: every notification type ANY caller passes to notify() must be
 * registered in notify.js TYPES. An UNregistered type makes notify() throw
 * "Unknown notification type", and callers wrap it in .catch() — so the notification
 * vanishes (this is exactly why providers were never pinged when a booking was paid).
 *
 * WHY THIS WAS WIDENED (2026-09-30)
 * The original guard checked a hand-written list of four booking types and scanned two
 * hard-coded files with the regex  notify\(\s*\{[^}]*?type:\s*'([^']+)'  . That regex
 * could not see:
 *   - double-quoted types, so all four calls in index.js's webhookIntasend were invisible
 *     — including `booking_confirmed`, which was unregistered and silently failing;
 *   - a nested object, because [^}] stops at the first inner brace;
 *   - the ternary form in pos-marketplace-sync.js (order_ready_pickup/order_dispatching);
 *   - the lookup-table form in wallet.js (payout_paid/payout_failed).
 * A census on 2026-09-30 found SIX unregistered types in live callers. A guard that
 * maintains its own list of what to check will always lag the code it guards, so this
 * version DERIVES the caller set and the type set from the source instead.
 *
 * It also reads every file as latin1: functions/payment-success.js contains a raw NUL
 * byte, which makes some tooling treat it as binary and skip it silently.
 *
 *   node scripts/test-notify-booking-types.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (n, v, d) => {
  v ? (pass++, console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')))
    : (fail++, console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')));
};

const FN = path.resolve('functions');
const read = (f) => fs.readFileSync(f, 'latin1');

/* ── brace-matched object literal starting at the '{' at index i ── */
function objAt (s, i) {
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (!d) return s.slice(i, k + 1); }
  }
  return '';
}

/* ── TYPES, parsed from SOURCE rather than require()d ──
   The guard used to `require('functions/notify.js')`, which pulls in firebase-admin and
   initialises an app. That makes a purely static check depend on functions/node_modules
   being installed — which it is not in a fresh worktree, so the guard could not run at
   all on the live lineage. Parsing the table keeps the check runnable anywhere.
   What that would otherwise lose — "does the module actually load" — is covered by
   compiling it below, which catches a syntax error without needing its dependencies. */
function parseTypes (src) {
  const start = src.indexOf('const TYPES');
  if (start === -1) return null;
  const tbl = objAt(src, src.indexOf('{', start));
  const out = {};
  for (const m of tbl.matchAll(/([A-Za-z_0-9]+)\s*:\s*\{([^}]*)\}/g)) {
    out[m[1]] = {
      priority: (m[2].match(/priority:\s*'([^']+)'/) || [])[1] || null,
      category: (m[2].match(/category:\s*'([^']+)'/) || [])[1] || null,
      smsTemplate: (m[2].match(/smsTemplate:\s*'([^']+)'/) || [])[1] || null,
    };
  }
  return out;
}

/* ── DERIVED: every module that pulls in the notify engine ── */
const NOTIFY_SRC = read(path.join(FN, 'notify.js'));
const TYPES = parseTypes(NOTIFY_SRC) || {};

const callers = fs.readdirSync(FN)
  .filter((f) => f.endsWith('.js') && f !== 'notify.js')
  .filter((f) => /require\(['"]\.\/notify['"]\)/.test(read(path.join(FN, f))));

/* ── DERIVED: every type literal reachable from a notify() call ──
   Handles 'single', "double", the ternary form, and the lookup-table form where the
   call passes `map.type` and the table is declared nearby. Anything it cannot resolve
   is reported as UNRESOLVED and fails, rather than being quietly skipped — an
   unreadable call site is a gap in the guard, not a pass. */
function typesUsedIn (src) {
  const found = new Set();
  const unresolved = [];
  const re = /\b(?:notify|notifyFn|_notify|_notifyEngine\.notify|notify\.notify)\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    const blk = objAt(src, open);
    if (!blk) continue;
    const line = src.slice(0, m.index).split('\n').length;

    const lit = blk.match(/\btype:\s*['"]([^'"]+)['"]/);
    if (lit) { found.add(lit[1]); continue; }

    const tern = blk.match(/\btype:\s*[^,\n]*\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/);
    if (tern) { found.add(tern[1]); found.add(tern[2]); continue; }

    /* `type: map.type` — resolve through the table the call reads from. */
    const viaMap = blk.match(/\btype:\s*([A-Za-z_$][\w$]*)\.type/);
    if (viaMap) {
      const decl = src.lastIndexOf('const ' + viaMap[1], m.index);
      if (decl !== -1) {
        const tbl = objAt(src, src.indexOf('{', decl));
        const inner = [...tbl.matchAll(/\btype:\s*['"]([^'"]+)['"]/g)].map((x) => x[1]);
        if (inner.length) { inner.forEach((x) => found.add(x)); continue; }
      }
    }

    /* A caller-supplied type with a literal default still pins the default. */
    const dflt = blk.match(/\btype:\s*[A-Za-z_$][\w$]*\s*\|\|\s*['"]([^'"]+)['"]/);
    if (dflt) { found.add(dflt[1]); continue; }

    /* Fully dynamic: the guard cannot verify it statically. Report it. */
    unresolved.push(line);
  }
  return { found, unresolved };
}

console.log('\n=== the guard derives its own inputs ===');
t('caller modules discovered, not hard-coded', callers.length >= 8, callers.length + ' modules');
t('TYPES table parsed from source', Object.keys(TYPES).length > 30, Object.keys(TYPES).length + ' types');
/* Compiling proves the module is syntactically valid without needing its dependencies. */
/* Compile from UTF-8: the latin1 read above is only there so a NUL-bearing file is not
   skipped as binary, and latin1-decoding genuine UTF-8 produces mojibake that will not
   compile. Text matching is unaffected by that; compiling is. */
let compiles = true, compileErr = '';
try { new vm.Script(fs.readFileSync(path.join(FN, 'notify.js'), 'utf8'), { filename: 'notify.js' }); }
catch (e) { compiles = false; compileErr = e.message; }
t('notify.js compiles', compiles, compileErr);
/* control — the parser must be able to fail, or "parsed" proves nothing */
t('control — the parser rejects a table it cannot find',
  parseTypes('const NOTHING = 1;') === null);

/* control — the extractor must actually find calls, or every assertion below is vacuous */
let allTypes = new Set(), allUnresolved = [];
for (const f of callers) {
  const { found, unresolved } = typesUsedIn(read(path.join(FN, f)));
  found.forEach((x) => allTypes.add(x));
  unresolved.forEach((l) => allUnresolved.push(f + ':' + l));
}
t('control — the extractor found notify() types', allTypes.size >= 10, allTypes.size + ' distinct types');

/* ── DEPLOYMENT SCOPE ─────────────────────────────────────────────────────────
   Every function ships the WHOLE functions/ tree, so "a caller exists in this tree" is
   true for every type and is therefore useless as a scope. What decides whether a type
   must be registered is which FUNCTION is being deployed: a type is required only if a
   notify() call reaching it lies inside that function's own exported body.

   Set NOTIFY_TARGET to the exported function name to scope the suite to one deployable
   unit. Unset, the suite checks the whole tree (the pre-incident behaviour).

   This exists because the 2026-09-30 incident was caused by treating one tree as
   authoritative for six functions with six different production lineages. */
const TARGET = process.env.NOTIFY_TARGET || null;

/* types whose notify() call site sits inside TARGET's exported body in index.js */
function typesInExport (src, name) {
  const i = src.indexOf('exports.' + name + ' =');
  if (i === -1) return null;
  const re = /^exports\.[A-Za-z_$]/gm; re.lastIndex = i + 10;
  const m = re.exec(src);
  const seg = src.slice(i, m ? m.index : src.length);
  return typesUsedIn(seg).found;
}

let requiredTypes = allTypes;
if (TARGET) {
  const inTarget = typesInExport(read(path.join(FN, 'index.js')) || '', TARGET);
  t(`control — target "${TARGET}" found in index.js`, inTarget !== null);
  requiredTypes = inTarget || new Set();
  console.log('  scoped to ' + TARGET + ' — types it calls: ' +
    ([...requiredTypes].join(', ') || '(none)'));
}

console.log('\n=== every type REQUIRED BY THIS DEPLOYMENT is registered ===');
[...requiredTypes].sort().forEach((ty) => {
  t(`"${ty}" is registered`, !!TYPES[ty] &&
    typeof TYPES[ty].category === 'string' && typeof TYPES[ty].priority === 'string');
});
if (TARGET) {
  const otherLineage = [...allTypes].filter((x) => !requiredTypes.has(x) && !TYPES[x]);
  console.log('  NOT required by this deployment (other lineages, unregistered here): ' +
    (otherLineage.join(', ') || 'none'));
}

/* ── THE SIX CENSUS TYPES ARE LINEAGE-SCOPED ─────────────────────────────────
   The 2026-09-30 census found six unregistered types. They do NOT all belong to one
   deployable unit: each is reached only through the function that calls it, and those
   functions are deployed from DIFFERENT production lineages. Asserting all six against
   any single candidate is therefore wrong — it fails a correct webhookIntasend recovery
   for not carrying types that belong to providerDispatch and updateClickAndCollectStatus.

   Which lineage this suite is checking is derived from the source under test, not
   configured, so the suite cannot drift from the tree it is run against. */
const LINEAGE_OWNER = {
  booking_confirmed:  'webhookIntasend',
  booking_affected:   'providerDispatch',          /* via booking-resolution.js */
  order_ready_pickup: 'updateClickAndCollectStatus',
  order_dispatching:  'updateClickAndCollectStatus',
  payout_paid:        'adminProcessPayout',        /* now on the guarded 45a837d lineage */
  payout_failed:      'adminProcessPayout',
};
/* A census type is EXPECTED here only if THIS DEPLOYMENT calls it (see NOTIFY_TARGET).
   Tree membership is not the test — every function ships the whole tree. */
const expectedHere = Object.keys(LINEAGE_OWNER).filter((ty) => requiredTypes.has(ty));
const notExpectedHere = Object.keys(LINEAGE_OWNER).filter((ty) => !requiredTypes.has(ty));

console.log('\n=== census types THIS lineage calls — must be registered ===');
t('control — the lineage has at least one census caller', expectedHere.length > 0,
  expectedHere.join(',') || 'none');
expectedHere.forEach((ty) => {
  t(`"${ty}" registered (caller present in this tree)`, !!TYPES[ty]);
  t(`"${ty}" has no invented SMS template`, TYPES[ty] ? TYPES[ty].smsTemplate === null : false);
});

console.log('\n=== census types THIS lineage does NOT call — must stay ABSENT ===');
/* Registering a type whose caller is not in this tree would be scope creep into another
   function's lineage, which is what caused the 2026-09-30 incident in the first place. */
notExpectedHere.forEach((ty) => {
  t(`"${ty}" correctly NOT registered here (owner: ${LINEAGE_OWNER[ty]})`, !TYPES[ty]);
});

console.log('\n=== the original four booking types stay registered ===');
['booking_new', 'booking_paid', 'booking_refund', 'booking_released'].forEach((ty) => {
  t(`TYPES has "${ty}"`, !!TYPES[ty] && typeof TYPES[ty].category === 'string');
});

console.log('\n=== no call site is invisible to the guard ===');
t('every notify() call resolves to a checkable type', allUnresolved.length === 0,
  allUnresolved.join(' · ') || 'none unresolved');

console.log('\n=== registered categories stay within the existing vocabulary ===');
/* CATEGORIES is DERIVED from TYPES (notify.js), and notifyPrefs is built per category —
   so inventing a category silently changes the preferences schema for every user. */
const KNOWN = ['security', 'payments', 'wallet', 'orders', 'delivery', 'marketplace',
               'loyalty', 'procurement', 'support', 'ai', 'system', 'promotions', 'subscriptions'];
const strays = [...new Set(Object.values(TYPES).map((x) => x.category))].filter((c) => !KNOWN.includes(c));
t('no new notification category was introduced', strays.length === 0, strays.join(',') || 'none');

console.log('\n=== an SMS template named by a type must actually exist ===');
const smsSrc = read(path.join(FN, 'sms-service.js'));
const tplIdx = smsSrc.indexOf('TEMPLATES');
const tplKeys = new Set([...objAt(smsSrc, smsSrc.indexOf('{', tplIdx))
  .matchAll(/^\s{2}([a-z_0-9]+):\s*\{/gm)].map((x) => x[1]));
t('control — SMS templates were read', tplKeys.size > 15, tplKeys.size + ' templates');
const missingTpl = Object.entries(TYPES)
  .filter(([, v]) => v.smsTemplate && !tplKeys.has(v.smsTemplate))
  .map(([k, v]) => k + '->' + v.smsTemplate);
t('every smsTemplate referenced by a type exists', missingTpl.length === 0, missingTpl.join(' · ') || 'all present');

/* ── REJECTION OBSERVABILITY ─────────────────────────────────────────────────
   The defect: notify() threw for an unknown type at the TOP of the function, before
   the first notifyLog write, and every caller wrapped the call in .catch(){}. No
   delivery, no notifyLog row, no console line, no error escaping — six live types were
   lost that way with nothing in the platform able to show it. The repair must make the
   failure observable WITHOUT softening it into a silent success. */
console.log('\n=== an unknown type fails HARD, and leaves a trace ===');
{
  const src = NOTIFY_SRC;
  const fnIdx = src.indexOf('async function _recordRejection');
  t('a rejection recorder exists', fnIdx !== -1);
  /* The FIRST '{' after the name is the destructured parameter list, not the body —
     skip past the parameter parens before brace-matching, or every assertion below
     silently inspects the wrong text. */
  let rec = '';
  if (fnIdx !== -1) {
    let p = src.indexOf('(', fnIdx), depth = 0, close = -1;
    for (let k = p; k < src.length; k++) {
      if (src[k] === '(') depth++;
      else if (src[k] === ')') { depth--; if (!depth) { close = k; break; } }
    }
    rec = close === -1 ? '' : objAt(src, src.indexOf('{', close));
  }
  t('control — the recorder BODY was extracted, not its parameter list',
    /logger|collection\(/.test(rec), rec.slice(0, 40).replace(/\n/g, ' '));

  /* the unknown-type branch: records FIRST, then throws */
  const guardIdx = src.indexOf('if (!t) {');
  t('control — the unknown-type guard was found', guardIdx !== -1);
  const guard = guardIdx === -1 ? '' : objAt(src, src.indexOf('{', guardIdx));
  t('it still THROWS — an unregistered type is not delivered as a default',
    /throw new HttpsError\('invalid-argument'/.test(guard));
  t('it records the rejection', /_recordRejection\('unknown_type'/.test(guard));
  t('and records BEFORE it throws',
    guard.indexOf('_recordRejection') !== -1 &&
    guard.indexOf('_recordRejection') < guard.indexOf('throw new HttpsError'));
  t('the missing-uid guard is recorded too', /_recordRejection\('missing_uid'/.test(src));

  /* no new logging authority: the existing logger and the existing LOG collection */
  t('it uses the existing logger', /logger\.error\('\[notify\] rejected'/.test(rec));
  t('it writes to the existing notifyLog collection', /collection\(LOG\)/.test(rec));
  t('it introduces no new collection constant',
    (src.match(/^const LOG\s*=/gm) || []).length === 1);

  /* totality: an audit fault must not replace the real error */
  t('the recorder cannot throw — every step is guarded',
    (rec.match(/catch \(_\)/g) || []).length >= 2);
  t('its log id is namespaced so it cannot collide with a real notification',
    /`rejected:\$\{reason\}/.test(rec));
  t('it is deterministic, so a retry updates one row rather than growing the log',
    /_contentHash\(title, body\)/.test(rec) && /\{ merge: true \}/.test(rec));

  /* the pre-existing paths that were ALREADY observable must stay that way */
  t('mid-flight failures still leave a processing row', /status: 'processing'/.test(src));
  t('completion still closes the row', /status: 'done'/.test(src));
  t('background delivery failures are still logged',
    /runDelivery\(\)\.catch\(\(err\) => logger\.error/.test(src));

  /* control — these detectors can fail */
  t('control — the detector rejects a file with no recorder',
    !/async function _recordRejection/.test('function notify(){}'));
}

console.log('\n=== notify() exposes the awaitDelivery seam (durable write vs background delivery) ===');
const notifySrc = read(path.join(FN, 'notify.js'));
t('awaitDelivery param exists', /awaitDelivery\s*=\s*true/.test(notifySrc));
t('background delivery path exists', /runDelivery\(\)\.catch/.test(notifySrc));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
process.exitCode = fail ? 1 : 0;
