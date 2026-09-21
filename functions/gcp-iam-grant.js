/* ══════════════════════════════════════════════════════════════════════════════
   GCP IAM GRANT — functions/gcp-iam-grant.js                               v1.0.0
   ══════════════════════════════════════════════════════════════════════════════
   The ONLY module in this repository that writes Google Cloud IAM.

   WHY IT IS A SEPARATE FILE
   -------------------------
   `functions/gcp-evidence.js` is certified read-only: its token is scoped
   `cloud-platform.read-only`, and its suite asserts that `:setIamPolicy` and
   every other mutating twin appear nowhere in it. That guarantee is worth more
   than the convenience of one file. So the write path lives here, alone, with
   its own write-capable scope, and the reader keeps its proof.

   WHAT THIS IS FOR
   ----------------
   Granting a person access to the SOKONI project without anyone having to open
   the Google Cloud console. That is a real operational win and it is also a
   privilege-escalation surface, so almost all of this file is refusals.

   THE REFUSALS, AND WHY EACH ONE EXISTS
   -------------------------------------
   1. DENY BY DEFAULT. A role must be on GRANTABLE_ROLES. An unknown role is
      refused, never passed through.

   2. ESCALATION-CAPABLE ROLES ARE FORBIDDEN TWICE. roles/owner and the IAM-admin
      roles let their holder grant themselves anything else, which would make
      every other guard here decorative. They are checked against a separate
      FORBIDDEN list as well, so adding one to GRANTABLE_ROLES by mistake still
      does not grant it.

   3. NO SELF-GRANT. The actor may not add a binding for themselves. An operator
      who can widen their own access has no ceiling.

   4. ETAG IS MANDATORY. setIamPolicy without the etag from the policy you read
      will happily overwrite a concurrent change — including, in the worst case,
      removing every other binding on the project. A policy with no etag is
      refused rather than written optimistically.

   5. AUDIT CONFIGS ARE CARRIED THROUGH UNTOUCHED. setIamPolicy replaces the
      WHOLE policy. A grant that forgot to carry `auditConfigs` would silently
      disable audit logging as a side effect of adding a viewer.

   6. IDEMPOTENT. A member who already holds the role is reported as already
      granted, and nothing is written.

   Every one of those is asserted by scripts/test-gcp-iam-grant.js against a
   mutation that removes it.

   DEPLOYMENT STATE
   ----------------
   Writing this module is one thing; DEPLOYING it is a separate decision that
   this file does not take. It also requires a service account with
   `resourcemanager.projects.setIamPolicy`, which the evidence reader's
   read-only identity deliberately does not have.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const https = require('https');

const PROJECT = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'sokoni-aeb26';

/* Write-capable, and ONLY in this file. */
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/* ── WHAT MAY BE GRANTED ─────────────────────────────────────────────────────
   Deny by default. These are roles an operator can hold in order to SEE the
   estate and run the platform, none of which can widen its own holder's
   access. Adding to this list is a security decision, not a convenience. */
const GRANTABLE_ROLES = [
  'roles/viewer',
  'roles/logging.viewer',
  'roles/monitoring.viewer',
  'roles/errorreporting.viewer',
  'roles/cloudsql.viewer',
  'roles/firebase.viewer',
  'roles/firebase.developAdmin',
  'roles/datastore.viewer',
  'roles/run.viewer',
  'roles/cloudfunctions.viewer',
  'roles/artifactregistry.reader',
  'roles/secretmanager.viewer',
];

/* ── WHAT MAY NEVER BE GRANTED, whatever the list above says ─────────────────
   Each of these can grant further IAM, which makes every other control in this
   file decorative. Checked SEPARATELY so a mistaken addition to GRANTABLE_ROLES
   still cannot escalate. */
const FORBIDDEN_ROLES = [
  'roles/owner',
  'roles/editor',
  'roles/resourcemanager.projectIamAdmin',
  'roles/resourcemanager.organizationAdmin',
  'roles/resourcemanager.folderIamAdmin',
  'roles/iam.securityAdmin',
  'roles/iam.roleAdmin',
  'roles/iam.organizationRoleAdmin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountKeyAdmin',
  'roles/iam.serviceAccountTokenCreator',
  'roles/iam.workloadIdentityPoolAdmin',
];

/** A member string Google will accept, and that we are willing to write. */
const MEMBER_RE = /^(user|group|serviceAccount):[^\s:]+@[^\s:]+$/;

function httpsJson (opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(b || '{}'); }
        catch (e) { return reject(new Error('Malformed response from ' + opts.host)); }
        if (j.error) return reject(new Error(j.error.message || 'API error'));
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        resolve(j);
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function adcToken () {
  return httpsJson({
    host: 'metadata.google.internal',
    path: '/computeMetadata/v1/instance/service-accounts/default/token?scopes=' +
          encodeURIComponent(SCOPE),
    headers: { 'Metadata-Flavor': 'Google' },
    method: 'GET',
  }).then((j) => {
    if (!j.access_token) throw new Error('The metadata server returned no access token.');
    return j.access_token;
  });
}

/** Refuse loudly. A grant that half-happens is worse than one that never did. */
function refuse (code, message) {
  const e = new Error(message);
  e.code = code;
  e.refused = true;
  return e;
}

function assertGrantable (role) {
  if (typeof role !== 'string' || !role) {
    throw refuse('invalid-role', 'A role is required.');
  }
  /* FORBIDDEN is checked FIRST and independently, so it holds even if the
     grantable list is edited carelessly. */
  if (FORBIDDEN_ROLES.indexOf(role) !== -1) {
    throw refuse('forbidden-role',
      role + ' can grant further IAM access and is never grantable from this surface. ' +
      'Granting it would make every other control here decorative. Use the Google Cloud ' +
      'console, deliberately, with a second pair of eyes.');
  }
  if (GRANTABLE_ROLES.indexOf(role) === -1) {
    throw refuse('role-not-allowlisted',
      role + ' is not on the grantable allowlist. This surface denies by default: ' +
      'a role is added to the list as a security decision, not to make a request succeed.');
  }
}

function assertMember (member) {
  if (typeof member !== 'string' || !MEMBER_RE.test(member)) {
    throw refuse('invalid-member',
      'A member must look like user:someone@example.com, group:… or serviceAccount:… .');
  }
}

/**
 * Add a role binding to the project IAM policy.
 *
 * @param {object} o
 *   o.member     'user:a@b.com' | 'group:…' | 'serviceAccount:…'
 *   o.role       must be on GRANTABLE_ROLES and not on FORBIDDEN_ROLES
 *   o.actorEmail the caller, so a self-grant can be refused
 *   o.get/o.post injected transport, for certification
 *   o.token      injected token minter
 *   o.dryRun     compute the new policy and return it WITHOUT writing
 */
async function grantProjectRole (o) {
  const opts = o || {};
  const { member, role, actorEmail } = opts;

  assertGrantable(role);
  assertMember(member);

  /* NO SELF-GRANT. An operator who can widen their own access has no ceiling. */
  if (actorEmail && member.toLowerCase() === ('user:' + String(actorEmail).toLowerCase())) {
    throw refuse('self-grant',
      'You cannot grant a role to yourself. Ask another super admin — a privilege change ' +
      'with no second party is not a control.');
  }

  let get = opts.get, post = opts.post;
  if (!get || !post) {
    const at = opts.token ? await opts.token() : await adcToken();
    const auth = { Authorization: 'Bearer ' + at };
    get  = (x)    => httpsJson(Object.assign({ method: 'GET',  headers: auth }, x));
    post = (x, b) => httpsJson(Object.assign({ method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth) }, x), b);
  }

  /* READ the current policy. */
  const policy = await post({ host: 'cloudresourcemanager.googleapis.com',
    path: '/v3/projects/' + PROJECT + ':getIamPolicy' },
    { options: { requestedPolicyVersion: 3 } });

  /* ETAG IS MANDATORY. Writing without it can silently overwrite a concurrent
     change — including removing every other binding on the project. */
  if (!policy || !policy.etag) {
    throw refuse('no-etag',
      'The IAM policy came back without an etag, so a write could overwrite a concurrent ' +
      'change. Refusing rather than writing optimistically.');
  }

  const bindings = (policy.bindings || []).map((b) => ({
    role: b.role,
    members: (b.members || []).slice(),
    condition: b.condition,
  }));

  const existing = bindings.find((b) => b.role === role && !b.condition);
  if (existing && existing.members.indexOf(member) !== -1) {
    return { changed: false, alreadyGranted: true, role, member,
             reason: 'That member already holds this role. Nothing was written.' };
  }

  if (existing) existing.members.push(member);
  else bindings.push({ role, members: [member] });

  /* CARRY AUDIT CONFIGS THROUGH. setIamPolicy replaces the WHOLE policy — a
     grant that dropped `auditConfigs` would disable audit logging as a side
     effect of adding a viewer. */
  const next = {
    policy: {
      version: 3,
      etag: policy.etag,
      bindings,
      auditConfigs: policy.auditConfigs || [],
    },
  };

  if (opts.dryRun) {
    return { changed: false, dryRun: true, role, member,
             wouldWrite: next.policy,
             reason: 'Dry run. The policy above is what WOULD be written; nothing was sent.' };
  }

  const written = await post({ host: 'cloudresourcemanager.googleapis.com',
    path: '/v3/projects/' + PROJECT + ':setIamPolicy' }, next);

  return { changed: true, alreadyGranted: false, role, member,
           etagBefore: policy.etag, etagAfter: (written && written.etag) || null,
           bindingCount: (written && (written.bindings || []).length) || null,
           auditConfigsPreserved: ((written && written.auditConfigs) || []).length };
}

/**
 * Remove a role binding. A grant path with no revoke path is a trap: access
 * that can only be added accumulates.
 */
async function revokeProjectRole (o) {
  const opts = o || {};
  const { member, role } = opts;

  assertMember(member);
  /* Revocation is deliberately NOT limited to the grantable allowlist — being
     able to take away a role this surface cannot give is a safety property, not
     a gap. But the forbidden roles are still refused: removing the last owner
     would lock everyone out of the project. */
  if (FORBIDDEN_ROLES.indexOf(role) !== -1) {
    throw refuse('forbidden-role',
      'Removing ' + role + ' from this surface is refused. Revoking the last holder of a ' +
      'project-admin role can lock everyone out, and that must be a deliberate action taken ' +
      'in the Google Cloud console.');
  }

  let post = opts.post;
  if (!post) {
    const at = opts.token ? await opts.token() : await adcToken();
    const auth = { Authorization: 'Bearer ' + at };
    post = (x, b) => httpsJson(Object.assign({ method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth) }, x), b);
  }

  const policy = await post({ host: 'cloudresourcemanager.googleapis.com',
    path: '/v3/projects/' + PROJECT + ':getIamPolicy' },
    { options: { requestedPolicyVersion: 3 } });

  if (!policy || !policy.etag) {
    throw refuse('no-etag', 'The IAM policy came back without an etag. Refusing to write.');
  }

  let found = false;
  const bindings = (policy.bindings || []).map((b) => {
    if (b.role !== role || b.condition) return b;
    const members = (b.members || []).filter((m) => {
      if (m === member) { found = true; return false; }
      return true;
    });
    return Object.assign({}, b, { members });
  /* A binding with no members left is dropped — Google rejects an empty one. */
  }).filter((b) => (b.members || []).length > 0);

  if (!found) {
    return { changed: false, role, member,
             reason: 'That member does not hold this role. Nothing was written.' };
  }

  const written = await post({ host: 'cloudresourcemanager.googleapis.com',
    path: '/v3/projects/' + PROJECT + ':setIamPolicy' },
    { policy: { version: 3, etag: policy.etag, bindings,
                auditConfigs: policy.auditConfigs || [] } });

  return { changed: true, role, member,
           etagBefore: policy.etag, etagAfter: (written && written.etag) || null,
           auditConfigsPreserved: ((written && written.auditConfigs) || []).length };
}

module.exports = {
  grantProjectRole, revokeProjectRole,
  GRANTABLE_ROLES, FORBIDDEN_ROLES, PROJECT,
  _internal: { assertGrantable, assertMember, refuse, MEMBER_RE },
};
