/* Stories authorization — emulator-backed, against the DEPLOYABLE artifact.
 *
 *   firebase emulators:exec --only firestore "node scripts/test-stories-rules.js"
 *   RULES_FILE=firestore.rules.build  (default — the artifact a release actually carries)
 *   COUNTERPROOF=1  loads HEAD's rules instead, where the Stories block does not exist
 *
 * WHY THIS EXISTS
 * ---------------
 * Stories had no server authority at all until recently: every read and write went to
 * localStorage, so a story was visible only in the browser that posted it. The canonical
 * rule now exists in `firestore.rules` — but `firestore.rules.build`, the artifact the RC
 * manifest and the rules test suites consume, was generated BEFORE that block was added and
 * did not contain it. A rule that exists only in source is a rule the tests never exercise.
 *
 * So these run against the BUILT artifact by default, not the source. If the build is stale,
 * this suite fails — which is the point.
 *
 * WHAT IS BEING PROVEN
 * Stories is a PLATFORM capability, available to every authenticated user and therefore to
 * all three Healthcare tiers. There is deliberately no tier gate in the rule, so "Clinic can
 * post" and "Enterprise can post" are the same assertion made three times — and that is worth
 * asserting, because the failure mode being guarded against is somebody adding an
 * Enterprise-only restriction later and calling it a feature.
 *
 * Ownership, immutability of `uid`, and the 24h expiry ceiling ARE enforced, server-side, and
 * each is exercised from the other user's session rather than inferred from the rule text.
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const COUNTERPROOF = !!process.env.COUNTERPROOF;
const RULES_FILE = process.env.RULES_FILE || 'firestore.rules.build';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const ok_ = async (l, p) => { try { await assertSucceeds(p); ck(l, true); } catch (e) { ck(l, false, e.message); } };
const no_ = async (l, p) => { try { await assertFails(p); ck(l, true); } catch (e) { ck(l, false, e.message); } };

const DAY = 86400000;
const story = (uid, extra) => Object.assign({
  uid, postedAt: Date.now(), expiresAt: Date.now() + DAY - 60000,
  mediaUrl: 'https://example.invalid/s.jpg', caption: 'Flu clinic open Saturday',
}, extra || {});

function rulesSource() {
  if (COUNTERPROOF) {
    try { return execFileSync('git', ['show', 'HEAD:' + RULES_FILE], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch (_) { return 'rules_version="2";service cloud.firestore{match /databases/{d}/documents{}}'; }
  }
  return fs.readFileSync(path.join(ROOT, RULES_FILE), 'utf8');
}

(async () => {
  console.log('STORIES AUTHORIZATION — emulator-backed');
  console.log(COUNTERPROOF ? 'MODE: COUNTERPROOF — HEAD ' + RULES_FILE : 'MODE: verification — ' + RULES_FILE);

  const env = await initializeTestEnvironment({
    projectId: 'sokoni-stories-rules-test',
    firestore: { rules: rulesSource(), host: '127.0.0.1', port: 8080 },
  });
  await env.clearFirestore();

  /* Three healthcare accounts, one per tier. The tier is carried only to make the intent of
     each assertion legible — the rule does not read it, and that is the property under test. */
  const clinic = env.authenticatedContext('HC_CLINIC').firestore();
  const hospital = env.authenticatedContext('HC_HOSPITAL').firestore();
  const enterprise = env.authenticatedContext('HC_ENTERPRISE').firestore();
  const otherUser = env.authenticatedContext('SOMEONE_ELSE').firestore();
  const anon = env.unauthenticatedContext().firestore();

  console.log('\nA. All three Healthcare tiers may publish  (1-3, 8)');
  await ok_('S1   Clinic can create a Story',     clinic.doc('stories/s_clinic').set(story('HC_CLINIC')));
  await ok_('S2   Hospital can create a Story',   hospital.doc('stories/s_hospital').set(story('HC_HOSPITAL')));
  await ok_('S3   Enterprise can create a Story', enterprise.doc('stories/s_ent').set(story('HC_ENTERPRISE')));
  await ok_('S8   no tier gate blocks the basic capability — a 4th account also works',
    otherUser.doc('stories/s_other').set(story('SOMEONE_ELSE')));

  console.log('\nB. Ownership and authentication are enforced SERVER-SIDE  (4-6, 9)');
  await no_('S4   unauthenticated cannot create',
    anon.doc('stories/s_anon').set(story('HC_CLINIC')));
  await no_('S4b  authenticated cannot create a Story owned by someone else',
    otherUser.doc('stories/s_forged').set(story('HC_CLINIC')));
  await no_('S5   cannot modify another user\'s Story',
    otherUser.doc('stories/s_clinic').update({ caption: 'defaced' }));
  await no_('S5b  cannot seize ownership on update',
    otherUser.doc('stories/s_clinic').set(story('SOMEONE_ELSE'), { merge: true }));
  await no_('S6   cannot delete another user\'s Story',
    otherUser.doc('stories/s_clinic').delete());
  await no_('S6b  unauthenticated cannot delete',
    anon.doc('stories/s_clinic').delete());
  await ok_('S9   the OWNER may update their own Story',
    clinic.doc('stories/s_clinic').update({ caption: 'Flu clinic open Sunday too',
      expiresAt: Date.now() + DAY - 60000 }));
  await ok_('S9b  the OWNER may delete their own Story',
    clinic.doc('stories/s_clinic').delete());

  console.log('\nC. The 24h ceiling is enforced by the SERVER, not the client  (7, 9)');
  await no_('S7   a permanent Story is refused (expiresAt far future)',
    hospital.doc('stories/s_forever').set(story('HC_HOSPITAL', { expiresAt: Date.now() + 365 * DAY })));
  await no_('S7b  an already-expired Story is refused',
    hospital.doc('stories/s_past').set(story('HC_HOSPITAL', { expiresAt: Date.now() - 1000 })));
  await no_('S7c  a non-numeric expiresAt is refused',
    hospital.doc('stories/s_bad').set(story('HC_HOSPITAL', { expiresAt: 'never' })));
  await no_('S7d  expiry cannot be extended past the ceiling on UPDATE',
    hospital.doc('stories/s_hospital').update({ expiresAt: Date.now() + 365 * DAY }));

  console.log('\nD. Reads are public — the feed is public by design  (7)');
  await ok_('S7e  anonymous can READ the public feed', anon.doc('stories/s_hospital').get());
  await ok_('S7f  a signed-in stranger can READ', otherUser.doc('stories/s_hospital').get());

  await env.cleanup();

  /* ── Structural: the artifact, its size, and the absence of a second authority ───────── */
  console.log('\nE. Artifact, size, and single authority  (10, 12-15)');
  const built = fs.readFileSync(path.join(ROOT, 'firestore.rules.build'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const LIMIT = 256 * 1024;
  const builtBytes = Buffer.byteLength(built, 'utf8');

  ck('S13  the DEPLOYABLE artifact contains the Stories block',
    /match \/stories\/\{storyId\}/.test(built), 'firestore.rules.build');
  ck('S12  braces balance in the built artifact (it parses as a ruleset)',
    (built.match(/\{/g) || []).length === (built.match(/\}/g) || []).length,
    (built.match(/\{/g) || []).length + ' open / ' + (built.match(/\}/g) || []).length + ' close');
  ck('S14  built artifact is within the 256 KiB ceiling',
    builtBytes < LIMIT, builtBytes + ' bytes = ' + (builtBytes / LIMIT * 100).toFixed(1) + '%');
  ck('S14b the RAW source is over the ceiling — which is why release strips comments',
    Buffer.byteLength(src, 'utf8') > LIMIT,
    Buffer.byteLength(src, 'utf8') + ' bytes = ' + (Buffer.byteLength(src, 'utf8') / LIMIT * 100).toFixed(1) + '%');

  /* No second Stories authorization system. sokoni-db.js performs the WRITE; the rule is the
     AUTHORITY. A server-side gate elsewhere would be a second authority to keep in step. */
  const dbjs = fs.readFileSync(path.join(ROOT, 'sokoni-db.js'), 'utf8');
  ck('S10  the client helper enforces no authorization of its own',
    !/isAdmin|hasRole|tier\s*===|plan\s*===/.test(
      (/async publishStory[\s\S]*?\n  \},/.exec(dbjs) || [''])[0]),
    'publishStory writes; the rule decides');
  const storiesRuleBlocks = (built.match(/match \/stories\//g) || []).length;
  ck('S10b exactly ONE stories rule block in the artifact',
    storiesRuleBlocks === 1, storiesRuleBlocks + ' block(s)');

  console.log('\n' + '─'.repeat(72));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (COUNTERPROOF) {
    console.log(fail > 0
      ? `COUNTER-PROOF HOLDS — ${fail} check(s) fail against HEAD's artifact.`
      : 'COUNTER-PROOF FAILED — HEAD passed everything; the detectors prove nothing.');
    process.exit(fail > 0 ? 0 : 1);
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
