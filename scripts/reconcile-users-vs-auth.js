/* RECONCILE — Firestore users/{uid} against Firebase Authentication accounts.
   ==========================================================================
   Run (needs Admin SDK credentials):
     GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json \
       node scripts/reconcile-users-vs-auth.js
     ... --json > docs/users-reconciliation.json

   READ-ONLY. It lists, compares and classifies. It never writes, never deletes, and
   has no flag that would let it.

   WHY
   The Admin dashboard's "Total Users" is db.collection('users').count() — a count of
   FIRESTORE DOCUMENTS. Reported 83 against fewer than 20 Auth accounts. Those two
   numbers measure different things, so the gap is a question, not yet a defect:

       a Firestore users document  !=  a Firebase Auth account

   scripts/census-users-doc-writers.js established WHICH code can mint a document:
   39 production write sites can create one, 25 of them narrow set(..., {merge:true})
   calls that leave behind only the handful of fields they touched. set+merge creates
   on absence; update() does not. This script decides which live documents actually
   came from those paths.

   CLASSIFICATION
     AUTH MATCH        uid resolves to a Firebase Auth account
     ORPHAN            uid does not resolve, and the document looks like a stub
     EXPECTED SYSTEM   a known non-account document (allowlist below; deliberately tiny)
     UNCLASSIFIED      everything else — NOT a synonym for orphan

   UNCLASSIFIED exists so the report cannot quietly round uncertainty down into a
   category that invites deletion. A document nobody can explain is a document nobody
   should delete.

   WHAT THIS SCRIPT WILL NOT DO
   If credentials are absent it EXITS NON-ZERO and prints what is missing. It does not
   sample, estimate, or fall back to the client SDK, and it never emits a count it did
   not read. An unproven number reported as a result is worse than no number.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const JSON_OUT = process.argv.includes('--json');
const ROOT = path.join(__dirname, '..');

/* ── credentials gate ─────────────────────────────────────────────────────── */
function credentialsPresent() {
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && fs.existsSync(gac)) return { ok: true, how: 'GOOGLE_APPLICATION_CREDENTIALS' };
  if (process.env.FIREBASE_CONFIG || process.env.GCLOUD_PROJECT) {
    return { ok: true, how: 'ambient (FIREBASE_CONFIG / GCLOUD_PROJECT)' };
  }
  return { ok: false };
}

/* ── emulator-redirection gate ─────────────────────────────────────────────────
   The Admin SDK silently retargets when these are set. A Firestore emulator runs on
   this machine for an unrelated project, so the failure is live, not theoretical:
   with either variable set this script would enumerate the EMULATOR's accounts and
   documents and print a tally that looks exactly like a production result. A
   confidently wrong number is worse than a refusal — and worse than no number,
   because it would be acted on.

   FIREBASE_AUTH_EMULATOR_HOST matters as much as the Firestore one: auth.listUsers()
   is what decides AUTH MATCH, so redirecting it alone would misclassify every row
   while the document side stayed real. */
const REDIRECTS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'];
const redirected = REDIRECTS.filter((v) => process.env[v]);
if (redirected.length) {
  console.error('\n  RECONCILIATION NOT RUN — the Admin SDK is pointed at an emulator.\n');
  for (const v of redirected) console.error('    ' + v + '=' + process.env[v]);
  console.error('\n  With these set this script would enumerate emulator data and report it');
  console.error('  as production. Clear them in this shell and re-run:\n');
  console.error('    PowerShell   Remove-Item Env:' + redirected[0] + '  -ErrorAction SilentlyContinue');
  console.error('    bash         unset ' + redirected.join(' '));
  console.error('\n  Do NOT stop any emulator that is running — it may belong to another');
  console.error('  session. Clearing the variables is enough; the processes are unrelated.\n');
  process.exit(2);
}

const cred = credentialsPresent();
if (!cred.ok) {
  console.error('\n  RECONCILIATION NOT RUN — Admin SDK credentials are absent.\n');
  console.error('  This script enumerates Firebase Authentication, which requires the Admin');
  console.error('  SDK. It will not substitute the client SDK, sample, or estimate.\n');
  console.error('  Provide one of:');
  console.error('    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json');
  console.error('    an ambient Google Cloud credential (FIREBASE_CONFIG / GCLOUD_PROJECT)\n');
  console.error('  Until then the Auth-side count is UNPROVEN, and the dashboard\'s "83"');
  console.error('  remains a Firestore DOCUMENT count with no account count to compare it to.\n');
  process.exit(2);
}

/* ── the deliberately tiny allowlist ──────────────────────────────────────────
   A document belongs here only when something in the repo demonstrably creates it
   for a non-account purpose. Nothing qualifies today, and an empty allowlist is the
   honest state: widening it to make a report look tidy would relabel unknowns as
   expected. Entries need a `why` naming the writer. */
const EXPECTED_SYSTEM = [
  /* { id: 'some-fixed-id', why: 'functions/x.js:NN creates this for <reason>' } */
];

/* Field signatures of the narrow writers, from census-users-doc-writers.js. A stub
   whose entire field set is covered by one signature is attributable to that writer. */
const SIGNATURES = [
  { writer: 'functions/booking-payment-sweep.js:53', fields: ['walletBalance'] },
  { writer: 'functions/index.js:4720',               fields: ['lastSeen'] },
  { writer: 'functions/invitations-core.js:319',     fields: ['updatedAt'] },
  { writer: 'functions/index.js:220 / 4693',         fields: ['roles'] },
  { writer: 'functions/index.js:139',                fields: ['role', 'adminGrantedAt'] },
  { writer: 'functions/super-admin.js:110',          fields: ['role', 'roleUpdatedAt'] },
  { writer: 'functions/wallet-engine.js:704',        fields: ['phoneNumber', 'phoneVerifiedAt'] },
  { writer: 'functions/age-verification.js:79',      fields: ['ageVerified', 'ageVerifiedAt', 'ageVerifiedMethod'] },
  { writer: 'auth.js:379',                           fields: ['googleLinked', 'googleLinkedAt'] },
  { writer: 'auth.js:1608',                          fields: ['linkedProviders', 'linkedAt'] },
  { writer: 'firebase.js:877',                       fields: ['fcmToken', 'fcmPlatform', 'fcmUpdatedAt'] },
  { writer: 'functions/sub-billing.js:331',          fields: ['tier', 'features', 'expiresAt', 'updatedAt'] },
];

/* A document created by real signup carries identity. If any of these is present the
   document is not a bare stub, whatever else is missing. */
const IDENTITY_FIELDS = ['email', 'phoneNumber', 'name', 'displayName', 'provider', 'createdAt'];

function attribute(fields) {
  const set = new Set(fields);
  const hits = [];
  for (const s of SIGNATURES) {
    /* every field the doc has is accounted for by this writer */
    if (fields.length && fields.every((f) => s.fields.includes(f))) hits.push(s.writer);
  }
  return hits;
}

(async () => {
  /* firebase-admin is a dependency of functions/, not of the repo root — measured:
     it does NOT resolve from the root but DOES resolve from ./functions. Requiring
     it by bare name alone made this script report "not installed" and exit even
     with valid credentials, which would have looked like a missing dependency
     rather than a resolution path. Try both before concluding it is absent. */
  let admin = null;
  for (const attempt of [
    () => require('firebase-admin'),
    () => require(require.resolve('firebase-admin', { paths: [path.join(ROOT, 'functions')] })),
  ]) {
    try { admin = attempt(); break; } catch (_) { /* try the next path */ }
  }
  if (!admin) {
    console.error('\n  firebase-admin could not be resolved from the repo root or ./functions.');
    console.error('  Install it, or run this script from an environment that has it.\n');
    process.exit(2);
  }
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();
  const auth = admin.auth();

  /* ── enumerate Auth ──────────────────────────────────────────────────────────
     Claims are captured alongside the uid, not just membership. The writer census
     (eb2f05f) showed the platform has THREE role representations populated by
     different promotion paths, so the same sitting that answers "is this uid real"
     can answer "what shape is this account" — and running the Admin SDK twice for
     two halves of one question wastes the scarcer resource, which is the session. */
  const authUids = new Set();
  const authClaims = new Map();
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    page.users.forEach((u) => {
      authUids.add(u.uid);
      authClaims.set(u.uid, u.customClaims || {});
    });
    pageToken = page.pageToken;
  } while (pageToken);

  /* ── enumerate Firestore ── */
  const docs = [];
  const snap = await db.collection('users').get();
  snap.forEach((d) => {
    const data = d.data() || {};
    docs.push({
      uid: d.id,
      /* The three representations, kept apart. `role` is a string, `roles` is an
         array, and neither is the claim — conflating them is what hid this. */
      role: typeof data.role === 'string' ? data.role : null,
      roles: Array.isArray(data.roles) ? data.roles.slice() : null,
      fields: Object.keys(data).sort(),
      createdAt: data.createdAt ? String(data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null,
      updatedAt: data.updatedAt ? String(data.updatedAt.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt) : null,
      lastLogin: data.lastLogin ? String(data.lastLogin.toDate ? data.lastLogin.toDate().toISOString() : data.lastLogin) : null,
    });
  });

  /* ── role SHAPE ───────────────────────────────────────────────────────────────
     Describes which promotion path an account looks like it came through. It does
     NOT judge: a shape is not a defect, and the point is to discover what exists in
     production rather than to confirm an expectation. `unknown` is a real answer and
     is never collapsed into one of the named shapes.

     From the writer census (docs/ROLE_SOURCE_POPULATION.md):
       setUserRole        users.role + boolean claims,  no roles[], no claims.role
       grantAdminClaim    users.role + roles[]
       bootstrap          claims.role present */
  const BOOL_CLAIMS = ['admin', 'superAdmin', 'seller', 'driver', 'moderator', 'buyer'];
  function shapeOf(doc, claims) {
    const hasRole = !!doc.role;
    const hasRoles = Array.isArray(doc.roles) && doc.roles.length > 0;
    const hasClaimRole = typeof claims.role === 'string' && claims.role.length > 0;
    const hasBools = BOOL_CLAIMS.some((k) => claims[k] === true);
    if (hasClaimRole) return 'bootstrap-shaped';
    if (hasRole && hasRoles) return 'grantAdminClaim-shaped';
    if (hasRole && !hasRoles && hasBools) return 'setUserRole-shaped';
    if (!hasRole && !hasRoles && !hasBools) return 'no-role-state';
    return 'unknown-shape';
  }

  /* Which consumer sites this account can actually satisfy.

     CORRECTION to the first version, which lumped all seven roles[] readers
     together. Verified line by line, they are not one group:

       STRICT roles[] — 5 sites, need the ARRAY and nothing else
         functions/notify.js x2, functions/sms-service.js
         business-analytics.html, seller-analytics.html
           `const roles = u.data().roles || []`   no fallback

       roles[] WITH A SINGULAR FALLBACK — 2 sites, satisfied by users.role alone
         functions/promotions.js, functions/kass-knowledge.js
           `Array.isArray(u.roles) ? u.roles : (u.role ? [u.role] : [])`

       claims.role — 2 sites
         functions/delivery-authority.js, functions/pos-integrations-api.js

     So a setUserRole-shaped account is NOT invisible to all nine: the two fallback
     sites see it through the singular field. Reporting otherwise would have turned
     a shape into a defect, which is exactly what this census must not do.

     The two analytics pages also lowercase the array before comparing, so their
     lowercase 'superadmin' test does match a stored 'superAdmin'. */
  function satisfies(doc, claims) {
    const hasArray = Array.isArray(doc.roles) && doc.roles.length > 0;
    const hasSingular = typeof doc.role === 'string' && doc.role.length > 0;
    return {
      strictRolesArray: hasArray,                    /* 5 sites */
      rolesWithSingularFallback: hasArray || hasSingular,  /* 2 sites */
      claimRoleReaders: typeof claims.role === 'string' && claims.role.length > 0,  /* 2 */
    };
  }

  /* ── classify ── */
  const rows = docs.map((d) => {
    const inAuth = authUids.has(d.uid);
    const expected = EXPECTED_SYSTEM.find((e) => e.id === d.uid);
    const hasIdentity = d.fields.some((f) => IDENTITY_FIELDS.includes(f));
    const writers = attribute(d.fields);
    let cls;
    if (inAuth) cls = 'AUTH MATCH';
    else if (expected) cls = 'EXPECTED SYSTEM';
    else if (writers.length || (!hasIdentity && d.fields.length <= 6)) cls = 'ORPHAN';
    else cls = 'UNCLASSIFIED';
    const claims = authClaims.get(d.uid) || {};
    return Object.assign({}, d, {
      classification: cls,
      inAuth,
      hasIdentity,
      likelyWriters: writers,
      expectedWhy: expected ? expected.why : null,
      claims: inAuth ? claims : null,
      elevated: BOOL_CLAIMS.filter((k) => claims[k] === true),
      shape: inAuth ? shapeOf(d, claims) : 'no-auth-account',
      satisfies: inAuth ? satisfies(d, claims) : null,
    });
  });

  const tally = rows.reduce((a, r) => { a[r.classification] = (a[r.classification] || 0) + 1; return a; }, {});

  if (JSON_OUT) {
    console.log(JSON.stringify({
      generated: 'reconcile-users-vs-auth',
      credentials: cred.how,
      authAccounts: authUids.size,
      firestoreDocuments: docs.length,
      tally, rows,
    }, null, 2));
    return;
  }

  console.log('\n  users/{uid}  vs  Firebase Authentication\n');
  console.log('  credentials              ' + cred.how);
  console.log('  Firebase Auth accounts   ' + authUids.size + '   (enumerated, not estimated)');
  console.log('  Firestore users docs     ' + docs.length + '   (this is what the dashboard counts)');
  console.log('  difference               ' + (docs.length - authUids.size));
  console.log('\n  ── classification');
  for (const k of ['AUTH MATCH', 'ORPHAN', 'EXPECTED SYSTEM', 'UNCLASSIFIED']) {
    console.log('  ' + k.padEnd(18) + (tally[k] || 0));
  }

  const orphans = rows.filter((r) => r.classification === 'ORPHAN');
  if (orphans.length) {
    console.log('\n  ── orphan candidates, with attribution');
    for (const o of orphans) {
      console.log('  ' + o.uid);
      console.log('      fields    {' + o.fields.join(', ') + '}');
      console.log('      created   ' + (o.createdAt || '(absent)')
        + '   updated ' + (o.updatedAt || '(absent)'));
      console.log('      writer    ' + (o.likelyWriters.length
        ? o.likelyWriters.join(' | ') + '   (set+merge, creates on absence)'
        : 'NOT ATTRIBUTED — no writer signature covers this field set'));
    }
  }

  /* ── role shape, for the accounts that actually matter ──────────────────────── */
  const real = rows.filter((r) => r.inAuth);
  const shapes = real.reduce((a, r) => { a[r.shape] = (a[r.shape] || 0) + 1; return a; }, {});
  console.log('\n  ── role SHAPE across ' + real.length + ' account(s) with an Auth record');
  for (const k of Object.keys(shapes).sort()) console.log('  ' + k.padEnd(24) + shapes[k]);

  const elevated = real.filter((r) => r.elevated.some((c) => c === 'admin' || c === 'superAdmin'));
  console.log('\n  ── the ' + elevated.length + ' account(s) holding admin or superAdmin');
  if (!elevated.length) console.log('  (none)');
  for (const e of elevated) {
    console.log('  ' + e.uid);
    console.log('      claims        ' + (e.elevated.join(', ') || '(none)')
      + (e.claims && e.claims.role ? '   claims.role=' + e.claims.role : '   claims.role=(absent)'));
    console.log('      users.role    ' + (e.role || '(absent)'));
    console.log('      users.roles   ' + (e.roles ? '[' + e.roles.join(', ') + ']' : '(absent)'));
    console.log('      shape         ' + e.shape);
    console.log('      satisfies     strict roles[]      '
      + (e.satisfies.strictRolesArray ? 'YES' : 'no ') + '  (5 sites)');
    console.log('                    roles[] w/ fallback '
      + (e.satisfies.rolesWithSingularFallback ? 'YES' : 'no ') + '  (2 sites)');
    console.log('                    claims.role         '
      + (e.satisfies.claimRoleReaders ? 'YES' : 'no ') + '  (2 sites)');
  }
  const blind = elevated.filter((e) => !e.satisfies.strictRolesArray
    && !e.satisfies.rolesWithSingularFallback && !e.satisfies.claimRoleReaders);
  console.log('\n  elevated accounts satisfying NO consumer group at all: ' + blind.length
    + ' of ' + elevated.length);
  console.log('  A shape is NOT a defect on its own. Some of these consumers may be stale or');
  console.log('  non-authoritative, and a gap here can mean the CHECK is wrong rather than');
  console.log('  the account. This reports what exists; which representation is authoritative');
  console.log('  is decided after the evidence, not from this output.');

  const unknown = rows.filter((r) => r.classification === 'UNCLASSIFIED');
  if (unknown.length) {
    console.log('\n  ── UNCLASSIFIED — explain before acting on any of these');
    for (const u of unknown) console.log('  ' + u.uid + '   {' + u.fields.join(', ') + '}');
  }

  console.log('\n  Nothing was written or deleted. A document nobody can explain is a document');
  console.log('  nobody should delete — settle UNCLASSIFIED before any cleanup is considered.\n');
})().catch((e) => {
  console.error('\n  RECONCILIATION FAILED: ' + (e && e.message || e));
  console.error('  No partial result is reported — a partial enumeration would understate');
  console.error('  both sides and could not be told apart from a clean one.\n');
  process.exit(1);
});
