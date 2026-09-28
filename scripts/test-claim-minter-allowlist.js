#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   Merchant V2 Canonicalization Slice 20 — WHO MAY MINT A CUSTOM CLAIM.

   A custom claim is this platform's authority primitive. firestore.rules trusts
   `superAdmin`, `admin`, `moderator`, `seller`, `posRole`, `tenantId`, `sellerId`
   and `merchantId`; callables trust `driver`, `provider` and more. Every one of
   those trusts the claim BECAUSE no client can write it.

   That premise is not enforced by the type system, the rules, or review. It is
   enforced by there being a countable, deliberate set of places that call
   setCustomUserClaims — so this suite counts them, and fails when the set grows.

   Slice 20 exists because the set had grown without anyone noticing:
   universal-onboarding.js's onbActivateRole minted `{ [role]: true }` for twenty
   role names after checking only that the caller was signed in.

   This is a STATIC guard on purpose. The emulator suite
   (test-onboarding-selfmint-emulator.js) proves the behaviour; this one runs
   anywhere, in a second, and fails the moment a new minter appears — including
   in a file nobody thought to write an emulator test for.

   Run:  node scripts/test-claim-minter-allowlist.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '   [' + detail + ']' : '')); }
};
const head = (t) => console.log('\n-- ' + t + ' --');

/* ── The allowlist ──────────────────────────────────────────────────────────
   Every entry is a file that may call setCustomUserClaims, and the reason it is
   allowed to. Adding a file here is a deliberate act that shows up in review as
   "I am granting a new thing the power to create authority". */
const ALLOWED = {
  'functions/account-status.js':
    'deactivation flag; admin/system path, never role authority',
  'functions/admin-os.js':
    'admin console role grant — admin-gated',
  /* LINEAGE NOTE (port onto feat/creator-hub, CHANGELOG 237): on this lineage grantAccountRole lives in
     functions/role-authority.js (application-lifecycle.js calls it), not in application-lifecycle.js. */
  'functions/role-authority.js':
    'THE role authority rail — grantAccountRole, reached only via an admin decision',
  'functions/beta-access.js':
    'betaReview — _assertAdmin before the mint',
  'functions/index.js':
    'admin/superAdmin grants + the self-locking bootstrap',
  'functions/invitations-core.js':
    'platform employee invitation — admin-issued',
  'functions/super-admin.js':
    'setUserRole — super-admin gated; merges rather than replaces since ad90678',
  'functions/security-incident-response.js':
    'incident containment; admin/system',
  'functions/scripts/set-admin-claim.js':
    'operator CLI, not deployed code',
  /* ── A KNOWN, GATED SELF-SERVICE EXCEPTION, recorded rather than hidden ──
     providerPublish mints `provider: true` + providerId with no admin decision.
     It is NOT the same class as the hole this slice closes: it requires a
     completed profile step, a completed coverage step, an activated subscription,
     and it refuses when providers/{uid}.status is 'suspended'. That is a product
     rail with preconditions, not an open door.
     It does mean `provider: true` is not proof of ADMIN approval — which matters
     to the provider convergence slice, and is why it is written down here. */
  'functions/provider-onboarding.js':
    'providerPublish — self-service but gated on draft completeness, an active '
    + 'plan, and a not-suspended listing. See the provider convergence slice.',
};

/* Files that must NEVER mint, with the reason each one is dangerous. */
const FORBIDDEN = {
  'functions/universal-onboarding.js':
    'self-service role activation — any signed-in user reaches it',
  'functions/onboarding-dispatch.js':
    'the public router in front of it',
};

head('1 · the census — every setCustomUserClaims call site in functions/');

function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const files = walk('functions', []).filter((f) => !f.includes('/test/'));
ck('the census found the functions tree', files.length > 20, files.length + ' files');

const minters = files.filter((f) => {
  /* Comments discussing the call must not count as calling it — that is how a
     guard like this quietly becomes unfalsifiable. */
  const code = R(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /setCustomUserClaims\s*\(/.test(code);
}).sort();

console.log('      minters: ' + minters.length);
minters.forEach((m) => console.log('        ' + m + (ALLOWED[m] ? '' : '   <-- NOT ALLOWLISTED')));

const unexpected = minters.filter((m) => !ALLOWED[m]);
ck('NO un-allowlisted file mints a custom claim', unexpected.length === 0, unexpected.join(', '));

/* The allowlist must not rot either: an entry for a file that no longer mints is
   a permission nobody is using, and it hides the next real one. */
const stale = Object.keys(ALLOWED).filter((f) => minters.indexOf(f) === -1);
ck('no stale allowlist entry — every listed file really does mint', stale.length === 0, stale.join(', '));

head('2 · the self-service rail mints nothing, and cannot');

Object.keys(FORBIDDEN).forEach((f) => {
  const src = R(f);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck(`${f} does not call setCustomUserClaims`, !/setCustomUserClaims\s*\(/.test(code), FORBIDDEN[f]);
  ck(`${f} does not even import firebase-admin/auth`,
     !/require\(['"]firebase-admin\/auth['"]\)/.test(code)
     && !/from ['"]firebase-admin\/auth['"]/.test(code));
});

const UO = R('functions/universal-onboarding.js');
const UO_CODE = UO.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ck('the certification is not vacuous — onbActivateRole was located',
   /_h\.onbActivateRole = async \(req\) => \{/.test(UO_CODE));
ck('no getAuth() handle is taken anywhere in the rail', !/getAuth\s*\(\s*\)/.test(UO_CODE));
ck('CLAIM_KEY is gone — a table of claims nothing writes invites someone to trust it',
   !/const CLAIM_KEY\s*=/.test(UO_CODE));

head('3 · the onboarding PRODUCT is untouched');

/* Closing the hole must not have closed the feature. These are the writes
   onboarding.html depends on, and the route that reaches them. */
ck('accountProfiles is still written', /collection\('accountProfiles'\)/.test(UO_CODE));
ck('accounts/{uid} still records the role', /roles: FieldValue\.arrayUnion\(role\)/.test(UO_CODE));
ck('the draft is still completed', /collection\('accountDrafts'\)/.test(UO_CODE));
ck('the handler still returns profileId + dashboard',
   /return \{ profileId, role, activated: true, dashboard:/.test(UO_CODE));
ck('the dispatcher still routes onbActivateRole',
   /'onbActivateRole'/.test(R('functions/onboarding-dispatch.js')));
ck('…and the dispatcher is still exported',
   /exports\.onboardingDispatch = onbDisp\.onboardingDispatch;/.test(R('functions/index.js')));
ck('the client SDK method is unchanged',
   /activateRole\(role, profileData\)\s*\{ return this\._call\('onbActivateRole'/.test(R('sokoni-onboarding.js')));

head('4 · approval is still the only role-authority rail');

/* feat/creator-hub: grantAccountRole is in functions/role-authority.js and mints through claimsFor(). */
const AL = R('functions/role-authority.js');
const AL_CODE = AL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ck('grantAccountRole still mints', /async function grantAccountRole\(/.test(AL_CODE) && /await auth\.setCustomUserClaims\(uid, claimsFor\(role, approved, user\.customClaims\)\);/.test(AL_CODE));
/* LINEAGE NOTE (hotfix port onto ship/catalogue-port-on-live 61912dd, 2026-09-26).
   The original two assertions matched feature/merchant-provider-identity's grantAccountRole,
   which carries a `merchant` key and SUPPRESSES its claim. The live lineage's grantAccountRole
   (functions/application-lifecycle.js, byte-identical at this function to the serving archive)
   has NO `merchant` key: an unmapped role throws. The property is the same — approval never
   mints a merchant claim — so it is asserted in the form this lineage actually has. */
/* feat/creator-hub declares it as `const ROLE_KEY = Object.freeze({ … });` */
const ROLE_KEY_SRC = (AL_CODE.match(/const ROLE_KEY = (?:Object\.freeze\()?\{([\s\S]*?)\}\)?;/) || [])[1] || '';
ck('…the approval role map was located (not vacuous)', /seller:\s*'seller'/.test(ROLE_KEY_SRC));
ck('…and it maps NO merchant key, so approval mints no merchant claim',
   !/\bmerchant\s*:/.test(ROLE_KEY_SRC));

/* The reason that suppression must survive Slice 20: it can only be lifted once
   NOTHING can self-mint. This suite is what will say so. */
ck('nothing in the whole functions tree mints a merchant claim',
   !files.some((f) => {
     const code = R(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
     return /merchant:\s*true/.test(code);
   }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
