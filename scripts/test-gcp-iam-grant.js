/* ══════════════════════════════════════════════════════════════════════════════
   GCP IAM GRANT — CERTIFICATION                scripts/test-gcp-iam-grant.js

   This is the only module in the repository that writes Google Cloud IAM, so
   this suite is almost entirely about what it REFUSES.

   THE FAILURE MODES BEING GUARDED
   -------------------------------
     escalation   granting a role whose holder can then grant themselves more
     self-grant   an operator widening their own access, which has no ceiling
     clobber      setIamPolicy without an etag overwriting a concurrent change,
                  in the worst case removing every other binding on the project
     silent loss  setIamPolicy replaces the WHOLE policy, so a grant that drops
                  auditConfigs disables audit logging as a side effect
     lockout      revoking the last holder of a project-admin role

   Every refusal is asserted with an INVERTING CONTROL: the same call shape must
   SUCCEED when the unsafe element is removed. A refusal that fires on
   everything is not a control, it is a broken function.

   NOTHING HERE OPENS A SOCKET, and nothing here writes real IAM. The transport
   is injected in every case and the writes are captured, so what is asserted is
   the request body this module actually produced.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const FAILURES = [];
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else   { fail++; FAILURES.push(n + (d ? '   [' + d + ']' : ''));
           console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = (t) => console.log('\n' + t);

const iam = require(path.join(ROOT, 'functions/gcp-iam-grant.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'functions/gcp-iam-grant.js'), 'utf8');

/* A scripted Cloud Resource Manager that CAPTURES what would be written. */
function makeApi (policy, opts) {
  const o = opts || {};
  const writes = [];
  return {
    writes,
    post: (req, body) => {
      if (/:getIamPolicy/.test(req.path)) {
        if (o.getFails) return Promise.reject(new Error('getIamPolicy refused'));
        return Promise.resolve(policy);
      }
      if (/:setIamPolicy/.test(req.path)) {
        writes.push(body);
        if (o.setFails) return Promise.reject(new Error('setIamPolicy refused'));
        return Promise.resolve(Object.assign({ etag: 'ETAG-AFTER' }, body.policy));
      }
      return Promise.reject(new Error('unexpected path ' + req.path));
    },
    get: () => Promise.reject(new Error('no GET expected')),
  };
}

const BASE_POLICY = () => ({
  version: 3,
  etag: 'ETAG-BEFORE',
  bindings: [
    { role: 'roles/owner',  members: ['user:founder@sokoni.co.ke'] },
    { role: 'roles/viewer', members: ['user:existing@sokoni.co.ke'] },
  ],
  auditConfigs: [
    { service: 'artifactregistry.googleapis.com',
      auditLogConfigs: [{ logType: 'ADMIN_READ' }, { logType: 'DATA_WRITE' }] },
  ],
});

const caught = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  GCP IAM GRANT — CERTIFICATION');
  console.log('══════════════════════════════════════════════════════════════════');

  /* ══ 1. THE HAPPY PATH ═══════════════════════════════════════════════ */
  head('1 - a permitted grant writes exactly one binding, and nothing else');
  {
    const api = makeApi(BASE_POLICY());
    const r = await iam.grantProjectRole({ member: 'user:new@sokoni.co.ke',
      role: 'roles/logging.viewer', actorEmail: 'boss@sokoni.co.ke',
      get: api.get, post: api.post });

    ok('it reports a change', r.changed === true);
    ok('exactly one write was sent', api.writes.length === 1, String(api.writes.length));

    const w = api.writes[0].policy;
    ok('the write carries the etag it read', w.etag === 'ETAG-BEFORE', w.etag);
    ok('the new binding is present',
       w.bindings.some((b) => b.role === 'roles/logging.viewer' &&
         b.members.indexOf('user:new@sokoni.co.ke') !== -1));
    /* THE PRE-EXISTING BINDINGS MUST SURVIVE. setIamPolicy replaces everything. */
    ok('the owner binding survives',
       w.bindings.some((b) => b.role === 'roles/owner' &&
         b.members.indexOf('user:founder@sokoni.co.ke') !== -1));
    ok('the existing viewer survives',
       w.bindings.some((b) => b.role === 'roles/viewer' &&
         b.members.indexOf('user:existing@sokoni.co.ke') !== -1));
    /* AND SO MUST THE AUDIT CONFIG. */
    /* Read defensively. If a mutation DROPS auditConfigs this must FAIL on
       this assertion, not throw three lines earlier — a crash is a failure but
       it names the wrong cause, and the next reader chases the wrong bug. */
    ok('auditConfigs are carried through untouched',
       (w.auditConfigs || []).length === 1 &&
       (((w.auditConfigs || [])[0] || {}).auditLogConfigs || []).length === 2,
       JSON.stringify(w.auditConfigs || null).slice(0, 60));
    ok('the result reports audit configs preserved', r.auditConfigsPreserved === 1);
  }

  /* ══ 2. ESCALATION IS REFUSED ════════════════════════════════════════ */
  head('2 - no role that can grant further IAM may be granted here');
  {
    for (const role of ['roles/owner', 'roles/editor',
                        'roles/resourcemanager.projectIamAdmin', 'roles/iam.securityAdmin',
                        'roles/iam.serviceAccountKeyAdmin']) {
      const api = makeApi(BASE_POLICY());
      const e = await caught(() => iam.grantProjectRole({
        member: 'user:new@sokoni.co.ke', role, actorEmail: 'boss@sokoni.co.ke',
        get: api.get, post: api.post }));
      ok('refused: ' + role, !!e && e.code === 'forbidden-role', e && e.code);
      ok('and nothing was written for ' + role, api.writes.length === 0);
    }

    /* An unknown role is refused too — DENY BY DEFAULT. */
    const api2 = makeApi(BASE_POLICY());
    const e2 = await caught(() => iam.grantProjectRole({
      member: 'user:new@sokoni.co.ke', role: 'roles/compute.admin',
      actorEmail: 'boss@sokoni.co.ke', get: api2.get, post: api2.post }));
    ok('an unknown role is refused, not passed through',
       !!e2 && e2.code === 'role-not-allowlisted', e2 && e2.code);
    ok('and nothing was written', api2.writes.length === 0);

    /* INVERTING CONTROL — a permitted role in the SAME call shape succeeds. */
    const api3 = makeApi(BASE_POLICY());
    const good = await iam.grantProjectRole({ member: 'user:new@sokoni.co.ke',
      role: 'roles/viewer', actorEmail: 'boss@sokoni.co.ke', get: api3.get, post: api3.post });
    ok('CONTROL — a permitted role in the same shape DOES succeed', good.changed === true);

    /* The two lists must not overlap, or the allowlist is lying. */
    const overlap = iam.GRANTABLE_ROLES.filter((r) => iam.FORBIDDEN_ROLES.indexOf(r) !== -1);
    ok('no role is both grantable and forbidden', overlap.length === 0, overlap.join(','));
    ok('owner is on the forbidden list', iam.FORBIDDEN_ROLES.indexOf('roles/owner') !== -1);
    ok('the grantable list is non-empty', iam.GRANTABLE_ROLES.length > 0);
  }

  /* ══ 3. NO SELF-GRANT ════════════════════════════════════════════════ */
  head('3 - an operator may not widen their own access');
  {
    const api = makeApi(BASE_POLICY());
    const e = await caught(() => iam.grantProjectRole({
      member: 'user:boss@sokoni.co.ke', role: 'roles/viewer',
      actorEmail: 'boss@sokoni.co.ke', get: api.get, post: api.post }));
    ok('a self-grant is refused', !!e && e.code === 'self-grant', e && e.code);
    ok('and nothing was written', api.writes.length === 0);

    /* Case must not defeat it. */
    const api2 = makeApi(BASE_POLICY());
    const e2 = await caught(() => iam.grantProjectRole({
      member: 'user:BOSS@Sokoni.co.ke', role: 'roles/viewer',
      actorEmail: 'boss@sokoni.co.ke', get: api2.get, post: api2.post }));
    ok('a differently-cased self-grant is still refused',
       !!e2 && e2.code === 'self-grant', e2 && e2.code);

    /* INVERTING CONTROL — granting to SOMEONE ELSE works. */
    const api3 = makeApi(BASE_POLICY());
    const good = await iam.grantProjectRole({ member: 'user:other@sokoni.co.ke',
      role: 'roles/viewer', actorEmail: 'boss@sokoni.co.ke', get: api3.get, post: api3.post });
    ok('CONTROL — granting to another person succeeds', good.changed === true);
  }

  /* ══ 4. ETAG IS MANDATORY ════════════════════════════════════════════ */
  head('4 - a policy with no etag is refused, never written optimistically');
  {
    const noEtag = BASE_POLICY();
    delete noEtag.etag;
    const api = makeApi(noEtag);
    const e = await caught(() => iam.grantProjectRole({
      member: 'user:new@sokoni.co.ke', role: 'roles/viewer',
      actorEmail: 'boss@sokoni.co.ke', get: api.get, post: api.post }));
    ok('an etag-less policy is refused', !!e && e.code === 'no-etag', e && e.code);
    ok('and NOTHING was written', api.writes.length === 0);
    ok('the refusal explains the clobber risk',
       !!e && /overwrite a concurrent change/.test(e.message || ''),
       e ? String(e.message).slice(0, 60) : 'no error thrown');

    /* INVERTING CONTROL — with an etag the same call writes. */
    const api2 = makeApi(BASE_POLICY());
    await iam.grantProjectRole({ member: 'user:new@sokoni.co.ke', role: 'roles/viewer',
      actorEmail: 'boss@sokoni.co.ke', get: api2.get, post: api2.post });
    ok('CONTROL — with an etag the same call does write', api2.writes.length === 1);
  }

  /* ══ 5. MEMBER VALIDATION ════════════════════════════════════════════ */
  head('5 - a malformed member is refused before any read');
  {
    for (const m of ['', 'boss@sokoni.co.ke', 'user:notanemail', 'allUsers',
                     'allAuthenticatedUsers', 'user:a@b.com:extra']) {
      const api = makeApi(BASE_POLICY());
      const e = await caught(() => iam.grantProjectRole({
        member: m, role: 'roles/viewer', actorEmail: 'boss@sokoni.co.ke',
        get: api.get, post: api.post }));
      ok('refused member: ' + JSON.stringify(m), !!e && e.code === 'invalid-member',
         e && e.code);
      ok('and nothing was written for ' + JSON.stringify(m), api.writes.length === 0);
    }
    /* allUsers deserves its own note: granting it would make the project public. */
    ok('allUsers can never be written', !iam._internal.MEMBER_RE.test('allUsers'));
    /* INVERTING CONTROL — a well-formed member passes the matcher. */
    ok('CONTROL — a well-formed member is accepted',
       iam._internal.MEMBER_RE.test('user:a@b.com') &&
       iam._internal.MEMBER_RE.test('serviceAccount:x@y.iam.gserviceaccount.com'));
  }

  /* ══ 6. IDEMPOTENCE AND DRY RUN ══════════════════════════════════════ */
  head('6 - an existing grant writes nothing; a dry run writes nothing');
  {
    const api = makeApi(BASE_POLICY());
    const r = await iam.grantProjectRole({ member: 'user:existing@sokoni.co.ke',
      role: 'roles/viewer', actorEmail: 'boss@sokoni.co.ke', get: api.get, post: api.post });
    ok('an already-granted role reports no change', r.changed === false && r.alreadyGranted === true);
    ok('and writes nothing', api.writes.length === 0);

    const api2 = makeApi(BASE_POLICY());
    const d = await iam.grantProjectRole({ member: 'user:new@sokoni.co.ke',
      role: 'roles/viewer', actorEmail: 'boss@sokoni.co.ke', dryRun: true,
      get: api2.get, post: api2.post });
    ok('a dry run reports no change', d.changed === false && d.dryRun === true);
    ok('a dry run writes NOTHING', api2.writes.length === 0);
    ok('but it returns the policy it WOULD have written',
       ((((d || {}).wouldWrite || {}).bindings) || []).some((b) => b.role === 'roles/viewer' &&
         (b.members || []).indexOf('user:new@sokoni.co.ke') !== -1));
    ok('and the dry-run policy still carries auditConfigs',
       (((d || {}).wouldWrite || {}).auditConfigs || []).length === 1);
  }

  /* ══ 7. REVOCATION ═══════════════════════════════════════════════════ */
  head('7 - access can be taken away, but a lockout cannot be caused');
  {
    const api = makeApi(BASE_POLICY());
    const r = await iam.revokeProjectRole({ member: 'user:existing@sokoni.co.ke',
      role: 'roles/viewer', post: api.post });
    ok('a held role is revoked', r.changed === true);
    const w = ((api.writes[0] || {}).policy) || {};
    ok('the binding is removed or emptied',
       !(w.bindings || []).some((b) => b.role === 'roles/viewer' &&
         (b.members || []).indexOf('user:existing@sokoni.co.ke') !== -1));
    /* An empty binding is dropped — Google rejects one with no members. */
    ok('no empty binding is left behind',
       (w.bindings || []).every((b) => (b.members || []).length > 0));
    ok('the owner binding is untouched',
       (w.bindings || []).some((b) => b.role === 'roles/owner'));
    ok('auditConfigs survive a revoke too', ((w || {}).auditConfigs || []).length === 1);

    /* Revoking an admin role could lock everyone out. */
    const api2 = makeApi(BASE_POLICY());
    const e = await caught(() => iam.revokeProjectRole({
      member: 'user:founder@sokoni.co.ke', role: 'roles/owner', post: api2.post }));
    ok('revoking owner is refused', !!e && e.code === 'forbidden-role', e && e.code);
    ok('and nothing was written', api2.writes.length === 0);
    ok('the refusal names the lockout risk', !!e && /lock everyone out/.test(e.message || ''));

    /* Revoking something not held changes nothing. */
    const api3 = makeApi(BASE_POLICY());
    const n = await iam.revokeProjectRole({ member: 'user:nobody@sokoni.co.ke',
      role: 'roles/viewer', post: api3.post });
    ok('revoking a role not held writes nothing', n.changed === false && api3.writes.length === 0);
  }

  /* ══ 8. FAILURES DO NOT HALF-APPLY ═══════════════════════════════════ */
  head('8 - a failed read or write surfaces, it does not report success');
  {
    const api = makeApi(BASE_POLICY(), { getFails: true });
    const e = await caught(() => iam.grantProjectRole({ member: 'user:new@sokoni.co.ke',
      role: 'roles/viewer', actorEmail: 'boss@sokoni.co.ke', get: api.get, post: api.post }));
    ok('a failed policy read throws', !!e, e && e.message);
    ok('and nothing was written', api.writes.length === 0);

    const api2 = makeApi(BASE_POLICY(), { setFails: true });
    const e2 = await caught(() => iam.grantProjectRole({ member: 'user:new@sokoni.co.ke',
      role: 'roles/viewer', actorEmail: 'boss@sokoni.co.ke', get: api2.get, post: api2.post }));
    ok('a failed write throws rather than reporting a change', !!e2, e2 && e2.message);
  }

  /* ══ 9. THE READER STAYS READ-ONLY ═══════════════════════════════════ */
  head('9 - the write path is isolated from the evidence reader');
  {
    /* STRIP COMMENTS FIRST. Both files DISCUSS `:setIamPolicy` and
       `cloud-platform.read-only` in prose — the reader's header explains that
       the write twin appears nowhere in it, and this module's header explains
       why the reader is scoped read-only. A scan over raw source counts that
       prose as the thing it describes, which is the certification machinery
       reading itself. Only code may be evidence about code. */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const readerRaw = fs.readFileSync(path.join(ROOT, 'functions/gcp-evidence.js'), 'utf8');
    const reader = strip(readerRaw);
    const mine   = strip(SRC);

    /* POSITIVE CONTROLS — the stripper left real code behind in both files.
       Without these, every absence check below passes on an empty string. */
    ok('control: the stripped reader still contains its code',
       /readGcpEvidence/.test(reader) && reader.length > 1500, String(reader.length));
    ok('control: this stripped module still contains its code',
       /grantProjectRole/.test(mine) && mine.length > 1000, String(mine.length));
    /* CONTROL ON THE STRIPPER ITSELF — the prose really was there, and really
       was removed. Otherwise "stripped" could be a no-op and prove nothing. */
    ok('control: the prose that would false-positive was actually stripped',
       readerRaw.indexOf(':setIamPolicy') !== -1 && reader.indexOf(':setIamPolicy') === -1);

    ok('the evidence reader CODE contains no setIamPolicy',
       reader.indexOf(':setIamPolicy') === -1);
    ok('the evidence reader is scoped read-only',
       /cloud-platform\.read-only/.test(reader));

    /* And this module is NOT read-only scoped — that is the point of splitting. */
    ok('this module carries the write-capable scope',
       /auth\/cloud-platform'/.test(mine) && !/cloud-platform\.read-only/.test(mine));
    ok('and it is the only file that writes IAM', mine.indexOf(':setIamPolicy') !== -1);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\n  FAILURES'); FAILURES.forEach((f) => console.log('   ✗ ' + f)); }
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  any real IAM write. Every transport is injected and every');
  console.log('            setIamPolicy body is captured rather than sent.');
  console.log('  NOT RUN   the deployed path. This module is NOT deployed, and it needs');
  console.log('            a service account with setIamPolicy that the read-only');
  console.log('            evidence identity deliberately does not have.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('SUITE CRASHED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
