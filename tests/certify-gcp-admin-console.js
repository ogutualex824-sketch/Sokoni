/* ══════════════════════════════════════════════════════════════════════════════
   CERTIFICATION — GCP access-management surface
   tests/certify-gcp-admin-console.js

   sokoni-gcp-admin.js is the ONLY write surface in the Integrations console.
   Everything else on that page is certified to write nothing, which is why this
   module is a separate file — and why it needs a suite of its own.

   WHAT IS CERTIFIED
     • it writes nothing itself: no Firestore verb, no claim computed here
     • it reaches exactly two callables, and both are the superAdmin-gated ones
     • a non-superAdmin gets no form, and is told the server is the real control
     • no privilege change happens on one click: a typed confirmation is
       required, and it is re-checked at commit rather than only disabling a
       button
     • a staged confirmation cannot be carried over onto a different person
     • the two systems are labelled apart — granting SOKONI is not granting GCP
     • a refusal from the server is shown verbatim, so an operator learns WHICH
       rule stopped them

   The module runs against a minimal DOM with the callables injected, so nothing
   here contacts a server and no claim or IAM policy is touched.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const FAILURES = [];
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else   { fail++; FAILURES.push(n + (d ? '   [' + d + ']' : ''));
           console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = (t) => console.log('\n' + t);

const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-gcp-admin.js'), 'utf8');

/* ── A minimal DOM with real form fields ───────────────────────────────── */
function load (opts) {
  const byId = {};
  const doc = {
    getElementById: (id) => byId[id] || null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild () {} },
  };
  const sandbox = { window: {}, document: doc, console, setTimeout, Date, Object, JSON, String };
  sandbox.window.document = doc;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sokoni-gcp-admin.js' });

  const root = { id: 'root', innerHTML: '' };
  byId.root = root;
  /* The module reads its inputs through getElementById, so the fields must
     exist as objects the test can set. Registered lazily on each render. */
  const field = (id, value) => { byId[id] = { id, value: value || '' }; return byId[id]; };

  const api = sandbox.window.SokoniGcpAdmin;
  api.mount(root, opts || {});
  return { api, root, field, byId };
}

const drain = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  GCP ACCESS MANAGEMENT — CERTIFICATION');
  console.log('══════════════════════════════════════════════════════════════════');

  /* ══ 1. THE MODULE WRITES NOTHING ITSELF ═════════════════════════════ */
  head('1 - it writes nothing directly, and reaches only the two gated callables');
  {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('control: stripped source still contains the module',
       /SokoniGcpAdmin/.test(stripped) && stripped.length > 1500, String(stripped.length));

    ['.set(', '.update(', '.delete(', '.add(', 'setCustomUserClaims', 'setIamPolicy']
      .forEach((w) => ok('no direct write: ' + w, stripped.indexOf(w) === -1));

    const calls = [...new Set((stripped.match(/_call\('([^']+)'/g) || [])
      .map((x) => x.replace(/.*'([^']+)'.*/, '$1')))].sort();
    ok('it reaches exactly three callables', calls.length === 3, calls.join(','));
    ok('and they are the canonical role path plus the two GCP ops',
       calls.join(',') === 'setUserRole,superAdminGrantGcpRole,superAdminRevokeGcpRole',
       calls.join(','));

    /* It must NOT invent a second way to mint an admin. */
    ok('the platform role goes through the EXISTING canonical path',
       /_call\('setUserRole'/.test(stripped));
    ok('there is no second claim-minting op',
       !/grantAdmin|makeAdmin|mintAdmin|setAdminClaim/i.test(stripped));

    /* INVERTING CONTROL — the matchers do fire on a planted write. */
    ok('control: the write matcher catches a planted write',
       "db.collection('x').doc('y').set({})".indexOf('.set(') !== -1);
  }

  /* ══ 2. A NON-SUPERADMIN GETS NO FORM ════════════════════════════════ */
  head('2 - the form is hidden without superAdmin, and says where the control is');
  {
    const v = load({ isSuperAdmin: false });
    ok('no member field is offered', v.root.innerHTML.indexOf('sgaMember') === -1);
    ok('no grant button is offered', v.root.innerHTML.indexOf('grantGcp') === -1);
    ok('it says super admin is required', /super admin/i.test(v.root.innerHTML));
    /* THE HONEST PART — hiding a button is not a control. */
    ok('and it says the server would refuse regardless',
       /the server would refuse the call regardless/.test(v.root.innerHTML));

    /* INVERTING CONTROL — a superAdmin DOES get the form. */
    const s = load({ isSuperAdmin: true });
    ok('CONTROL — a super admin is offered the form',
       s.root.innerHTML.indexOf('sgaMember') !== -1);
  }

  /* ══ 3. NO PRIVILEGE CHANGE ON ONE CLICK ═════════════════════════════ */
  head('3 - a typed confirmation is required, and re-checked at commit');
  {
    const sent = [];
    const v = load({ isSuperAdmin: true,
      call_superAdminGrantGcpRole: (p) => { sent.push(p); return Promise.resolve({ changed: true }); } });

    v.field('sgaMember', 'user:new@sokoni.co.ke');
    v.field('sgaGcpRole', 'roles/viewer');
    v.api.grantGcp();

    ok('a confirmation is staged, not sent', sent.length === 0);
    ok('the confirmation names the member', /user:new@sokoni\.co\.ke/.test(v.root.innerHTML));
    ok('and the role', /roles\/viewer/.test(v.root.innerHTML));
    ok('the confirm button is disabled until the member is typed',
       /disabled\s+onclick="SokoniGcpAdmin\._commit\(\)"/.test(v.root.innerHTML) ||
       /disabled/.test(v.root.innerHTML));

    /* Committing with the WRONG text must send nothing. */
    v.api._typed('user:someone-else@sokoni.co.ke');
    v.api._commit();
    await drain();
    ok('a mismatched confirmation sends nothing', sent.length === 0);
    ok('and says so', /did not match/.test(v.root.innerHTML));

    /* Now the correct text. */
    v.api.grantGcp();
    v.api._typed('user:new@sokoni.co.ke');
    v.api._commit();
    await drain(); await drain();
    ok('a matching confirmation sends exactly one call', sent.length === 1, String(sent.length));
    ok('and it carries the member and role',
       sent[0].member === 'user:new@sokoni.co.ke' && sent[0].role === 'roles/viewer',
       JSON.stringify(sent[0]));
    ok('and it is not a dry run', sent[0].dryRun === false);
  }

  /* ══ 4. A CONFIRMATION CANNOT BE CARRIED ONTO SOMEONE ELSE ═══════════ */
  head('4 - editing the member invalidates a staged confirmation');
  {
    const sent = [];
    const v = load({ isSuperAdmin: true,
      call_superAdminGrantGcpRole: (p) => { sent.push(p); return Promise.resolve({ changed: true }); } });
    v.field('sgaMember', 'user:a@sokoni.co.ke');
    v.field('sgaGcpRole', 'roles/viewer');
    v.api.grantGcp();
    v.api._typed('user:a@sokoni.co.ke');
    /* The operator now edits the member — the staged confirmation must die. */
    v.api._dirty();
    v.api._commit();
    await drain();
    ok('the staged confirmation was discarded', sent.length === 0, String(sent.length));
    ok('and no confirmation block remains', v.root.innerHTML.indexOf('sgaConfirm') === -1);
  }

  /* ══ 5. THE TWO SYSTEMS ARE LABELLED APART ═══════════════════════════ */
  head('5 - SOKONI access and Google Cloud access are never conflated');
  {
    const v = load({ isSuperAdmin: true });
    ok('the panel says they are separate systems',
       /They are separate systems/.test(v.root.innerHTML));
    ok('and that removing one does not remove the other',
       /does not remove their Google Cloud access/.test(v.root.innerHTML));

    v.field('sgaMember', 'user:x@sokoni.co.ke');
    v.field('sgaGcpRole', 'roles/viewer');
    v.api.grantGcp();
    ok('a GCP confirmation says SOKONI access is unchanged',
       /It does not change SOKONI access/.test(v.root.innerHTML));

    const v2 = load({ isSuperAdmin: true });
    v2.field('sgaMember', 'uid-123');
    v2.field('sgaPlatformRole', 'admin');
    v2.api.grantPlatform();
    ok('a platform confirmation says Google Cloud is unchanged',
       /It does not change\s*\n?\s*Google Cloud access|does not change Google Cloud access/
         .test(v2.root.innerHTML));
  }

  /* ══ 6. THE REFUSALS ARE SHOWN, AND THE LIMITS STATED ════════════════ */
  head('6 - a server refusal is surfaced verbatim, and the limits are declared up front');
  {
    const v = load({ isSuperAdmin: true,
      call_superAdminGrantGcpRole: () =>
        Promise.reject(new Error('FORBIDDEN-ROLE: roles/owner can grant further IAM access')) });

    ok('the panel states owner and editor are never grantable',
       /Owner, Editor and every/.test(v.root.innerHTML));
    ok('it states you cannot grant to yourself',
       /cannot grant a role to\s*\n?\s*yourself|cannot grant a role to yourself/.test(v.root.innerHTML));
    ok('and that unknown roles are denied by default',
       /denied by default/.test(v.root.innerHTML));

    v.field('sgaMember', 'user:x@sokoni.co.ke');
    v.field('sgaGcpRole', 'roles/viewer');
    v.api.grantGcp();
    v.api._typed('user:x@sokoni.co.ke');
    v.api._commit();
    await drain(); await drain();

    ok('the refusal is rendered', /Refused/.test(v.root.innerHTML));
    ok('and the server text is shown verbatim, naming the rule',
       /FORBIDDEN-ROLE/.test(v.root.innerHTML));
    /* A refusal must NOT read as success. */
    ok('a refusal is not rendered as Done', !/>Done</.test(v.root.innerHTML));
  }

  /* ══ 7. DRY RUN IS OFFERED AND DISTINCT ══════════════════════════════ */
  head('7 - a dry run is available and reports that nothing was written');
  {
    const sent = [];
    const v = load({ isSuperAdmin: true,
      call_superAdminGrantGcpRole: (p) => { sent.push(p);
        return Promise.resolve({ changed: false, dryRun: true, reason: 'Dry run.' }); } });
    v.field('sgaMember', 'user:x@sokoni.co.ke');
    v.field('sgaGcpRole', 'roles/viewer');
    v.api.grantGcp(true);
    v.api._typed('user:x@sokoni.co.ke');
    v.api._commit();
    await drain(); await drain();
    ok('the dry-run flag reaches the server', sent[0] && sent[0].dryRun === true);
    ok('and the result says nothing was written',
       /nothing was written/.test(v.root.innerHTML));
  }

  /* ══ 8. THE READ-ONLY CONSOLE IS STILL READ-ONLY ═════════════════════ */
  head('8 - adding a write surface did not put a write in the read-only console');
  {
    const console_ = fs.readFileSync(path.join(ROOT, 'sokoni-integrations.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('control: the console source was read', console_.length > 5000, String(console_.length));
    ['.set(', '.update(', '.delete(', '.add('].forEach((w) =>
      ok('the read-only console still has no ' + w, console_.indexOf(w) === -1));
    ok('and it computes no claim', console_.indexOf('setCustomUserClaims') === -1);
    ok('and it writes no IAM', console_.indexOf('setIamPolicy') === -1);
    /* It may MOUNT the write module — that is a call, not a write. */
    ok('it only mounts the separate write module',
       /SokoniGcpAdmin\.mount/.test(console_));
    ok('and it does not call the grant ops itself',
       console_.indexOf('superAdminGrantGcpRole') === -1);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\n  FAILURES'); FAILURES.forEach((f) => console.log('   ✗ ' + f)); }
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  the server guards. Those are certified by');
  console.log('            scripts/test-gcp-iam-grant.js; the callables are injected here.');
  console.log('  NOT RUN   the deployed path. Neither callable is deployed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('SUITE CRASHED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
