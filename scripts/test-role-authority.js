#!/usr/bin/env node
/* Client role authority — claims are the only authority  (Roles Phase 4)
 *
 *   node scripts/test-role-authority.js
 *
 * WHY THIS EXISTS
 * Phase 3 closed the WRITE path: the rules stopped a client granting itself a
 * role. This closes the READ path. sokoni-permissions.js deliberately resolves
 * seller/provider/driver-tier roles from the sessionStorage cache and the
 * localStorage sokoniUser.roles array for fast first paint, requiring a verified
 * token only for moderator-and-above. That trade is right for painting a nav bar
 * and wrong for deciding who may enter a seller workspace — the cache is
 * attacker-writable, so a forged entry would open a workspace the server never
 * granted.
 *
 * sokoni-role-authority.js makes no such trade, and these tests exist to prove it
 * by ATTACKING it: every forgery an attacker can actually perform in a browser
 * (sokoniUser.roles, sokoniUser.activeRole, the permissions cache) is attempted
 * against the module, and must change nothing.
 *
 * The module's state is in-memory only and never serialised, so the test drives
 * it the way reality does — by changing what the signed token says.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

/* ── Minimal browser harness ─────────────────────────────────────────────────
   Only what the module touches. The token is a variable the test controls, which
   is exactly the real threat model: the attacker controls storage, the server
   controls the token. */
const store = {};
let TOKEN = null;          /* {claims:{...}} or null */
let TOKEN_THROWS = null;   /* simulate a refresh failure */
let forcedSeen = [];

global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const listeners = {};
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = (o || {}).detail; } };
global.document = {
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  dispatchEvent: (e) => { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
};
global.window = {
  document: global.document,
  localStorage: global.localStorage,
  location: { replace: (u) => { global.window.__replaced = u; } },
  firebaseAuth: {
    currentUser: {
      uid: 'u_test',
      getIdTokenResult: async (force) => {
        forcedSeen.push(force);
        if (TOKEN_THROWS) throw Object.assign(new Error('boom'), { code: TOKEN_THROWS });
        if (!TOKEN) throw Object.assign(new Error('no token'), { code: 'unauthenticated' });
        return TOKEN;
      },
    },
  },
};
global.window.window = global.window;

require(path.join(ROOT, 'sokoni-role-authority.js'));
const RA = global.window.SokoniRoleAuthority;

const setToken = (claims) => { TOKEN = { claims: claims || {} }; };

(async () => {

  /* ══ 1 · canonical vocabulary preserved ══ */
  head('1 · the canonical vocabulary, not a new one');
  ['buyer', 'seller', 'provider', 'mechanic', 'rider', 'health', 'legal', 'landlord', 'tenant']
    .forEach((r) => ck(r + ' is canonical', RA.CANONICAL_ROLES.indexOf(r) > -1));
  ck('exactly the nine workspace roles', RA.CANONICAL_ROLES.length === 9, RA.CANONICAL_ROLES.join(','));
  ck('the new roles are NOT collapsed into provider',
     ['mechanic', 'health', 'legal', 'landlord', 'tenant'].every((r) => RA.canonicalise(r) === r));
  ck('legacy `driver` normalises to rider', RA.canonicalise('driver') === 'rider');
  ck('an unknown role does not normalise to anything', RA.canonicalise('wizard') === null);

  /* ══ 2 · approved-role discovery comes from CLAIMS ══ */
  head('2 · approved roles are derived from the signed token');
  setToken({ seller: true });
  await RA.refresh(true);
  ck('a seller claim yields seller', RA.isApproved('seller'));
  ck('...and buyer, the baseline', RA.isApproved('buyer'));
  ck('...and nothing else', !RA.isApproved('provider') && !RA.isApproved('landlord'));
  ck('the set is exactly [buyer, seller]',
     RA.getApprovedRoles().sort().join(',') === 'buyer,seller', RA.getApprovedRoles().join(','));
  ck('verification is recorded', RA.isVerified());

  setToken({ mechanic: true, landlord: true });
  await RA.refresh(true);
  ck('mechanic and landlord resolve as themselves',
     RA.isApproved('mechanic') && RA.isApproved('landlord'));
  ck('...and do NOT imply provider', !RA.isApproved('provider'));

  setToken({ driver: true });                        /* legacy claim only */
  await RA.refresh(true);
  ck('a legacy `driver` claim grants rider', RA.isApproved('rider'));

  /* ══ 3 · THE ATTACK SURFACE — storage must change nothing ══ */
  head('3 · forged client state grants nothing');
  setToken({});                                       /* no roles at all */
  await RA.refresh(true);
  ck('baseline only with an empty token',
     RA.getApprovedRoles().join(',') === 'buyer', RA.getApprovedRoles().join(','));

  /* Every forgery an attacker can actually perform in a browser. */
  localStorage.setItem('sokoniUser', JSON.stringify({
    uid: 'u_test', roles: ['buyer', 'seller', 'admin', 'superAdmin'],
    activeRole: 'admin', registeredAs: { admin: true, seller: true },
  }));
  localStorage.setItem('sokoniPermissionsCache', JSON.stringify({
    roles: ['superAdmin'], level: 100, claimsVerified: true,
  }));
  await RA.refresh(true);
  ck('a forged users.roles array grants NOTHING', !RA.isApproved('seller'));
  ck('a forged roles array cannot grant admin', !RA.isApproved('admin'));
  ck('a forged permissions cache grants nothing', !RA.isApproved('superAdmin'));
  ck('the approved set is still baseline only',
     RA.getApprovedRoles().join(',') === 'buyer', RA.getApprovedRoles().join(','));
  ck('a forged activeRole in storage is not the acting role',
     RA.getActiveRole() === 'buyer', RA.getActiveRole());
  ck('a forged workspace claim does not open the workspace',
     !(await RA.canEnterWorkspace('seller')));

  /* ══ 4 · token refresh makes a NEW approval appear ══ */
  head('4 · a newly approved role appears after refresh');
  setToken({});
  await RA.refresh(true);
  ck('not approved before', !RA.isApproved('provider'));
  setToken({ provider: true });                       /* server approves */
  ck('still not approved on the STALE token', !RA.isApproved('provider'));
  await RA.refresh(true);
  ck('approved after an explicit refresh', RA.isApproved('provider'));
  ck('the refresh was forced (round-trips for new claims)',
     forcedSeen[forcedSeen.length - 1] === true);

  /* ══ 5 · a REVOKED role disappears ══ */
  head('5 · a revoked role disappears after refresh');
  setToken({ seller: true, rider: true });
  await RA.refresh(true);
  ck('both roles present', RA.isApproved('seller') && RA.isApproved('rider'));
  await RA.setActiveRole('rider').catch(() => {});
  setToken({ seller: true });                         /* rider revoked */
  await RA.refresh(true);
  ck('the revoked role is gone', !RA.isApproved('rider'));
  ck('the surviving role remains', RA.isApproved('seller'));
  /* The acting role cannot outlive the grant that justified it. */
  ck('an acting role that was revoked falls back to buyer',
     RA.getActiveRole() === 'buyer', RA.getActiveRole());
  ck('the workspace closes too', !(await RA.canEnterWorkspace('rider')));

  /* ══ 6 · refresh FAILURE is safe ══ */
  head('6 · a failed refresh neither invents nor discards authority');
  setToken({ seller: true });
  await RA.refresh(true);
  ck('verified with seller', RA.isApproved('seller') && RA.isVerified());
  TOKEN_THROWS = 'unavailable';
  const snap = await RA.refresh(true);
  ck('a transient failure does NOT demote a verified user', RA.isApproved('seller'));
  ck('...and the error is reported rather than hidden', !!snap.error, snap.error);
  ck('...and it did not fall back to the forged storage roles', !RA.isApproved('admin'));
  TOKEN_THROWS = null;

  /* An AUTH-INVALIDATING failure is a different statement from a transient one:
     the session itself is dead (expired, revoked, account disabled). Coasting on
     roles proven by a session that has since died is exactly the hole a "keep the
     last verified set" rule would open if it did not distinguish the two. */
  setToken({ seller: true });
  await RA.refresh(true);
  ck('verified as seller before the session dies', RA.isApproved('seller'));
  await RA.setActiveRole('seller').catch(() => {});
  TOKEN_THROWS = 'auth/user-token-expired';
  await RA.refresh(true);
  ck('an EXPIRED token drops to baseline immediately', !RA.isApproved('seller'));
  ck('...and reports itself unverified', !RA.isVerified());
  ck('...and denies the workspace', !(await RA.canEnterWorkspace('seller')));
  ck('...and the acting role falls back to buyer', RA.getActiveRole() === 'buyer', RA.getActiveRole());
  TOKEN_THROWS = 'auth/user-disabled';
  await RA.refresh(true);
  ck('a DISABLED account grants nothing', RA.getApprovedRoles().join(',') === 'buyer');
  TOKEN_THROWS = null;

  /* Signed out entirely — currentUser gone — is a real answer, not a failure. */
  const savedAuth = global.window.firebaseAuth.currentUser;
  global.window.firebaseAuth.currentUser = null;
  await RA.refresh(true);
  ck('a signed-out session grants baseline only', RA.getApprovedRoles().join(',') === 'buyer');
  ck('...and is not marked verified', !RA.isVerified());
  global.window.firebaseAuth.currentUser = savedAuth;

  /* ══ 7 · activeRole selection ══ */
  head('7 · a multi-role user switches only among approved roles');
  setToken({ seller: true, rider: true, landlord: true });
  await RA.refresh(true);
  const r1 = await RA.setActiveRole('provider');
  ck('an UNapproved role is refused', !r1.ok && r1.reason === 'not-approved', r1.reason);
  const r2 = await RA.setActiveRole('wizard');
  ck('an unknown role is refused', !r2.ok && r2.reason === 'unknown-role', r2.reason);
  const r3 = await RA.setActiveRole('admin');
  ck('admin is not a workspace role here', !r3.ok, r3.reason);
  ck('a refused switch does not change the acting role',
     RA.getActiveRole() === 'buyer', RA.getActiveRole());
  ck('the three approved roles are all selectable in principle',
     RA.isApproved('seller') && RA.isApproved('rider') && RA.isApproved('landlord'));

  /* ══ 8 · per-role profile paths ══ */
  head('8 · canonical profile paths');
  [['mechanic', 'mechanics'], ['landlord', 'landlordProfiles'], ['tenant', 'tenantProfiles'],
   ['seller', 'sellers'], ['provider', 'providers'], ['rider', 'drivers'],
   ['health', 'healthProviders'], ['legal', 'legalProviders']].forEach(([role, col]) => {
    const p = RA.getProfilePath(role, 'u_test');
    ck(role + ' → ' + col + '/{uid}', p && p.collection === col && p.id === 'u_test', p && p.path);
  });
  ck('buyer has no uid-keyed profile', RA.getProfilePath('buyer', 'u_test') === null);
  ck('an unknown role yields no path (no plausible-looking guess)',
     RA.getProfilePath('wizard', 'u_test') === null);
  ck('legal points at the AUTHORITY, not the search projection',
     RA.getProfilePath('legal', 'u_test').collection === 'legalProviders');
  ck('mechanic is uid-keyed (legacy mechanics/{docId} untouched)',
     RA.getProfilePath('mechanic', 'u_test').path === 'mechanics/u_test');

  /* ══ 9 · tenant privacy ══ */
  head('9 · a rental tenant stays private');
  ck('tenant is flagged private', RA.isPrivateRole('tenant'));
  ck('no other role is', !RA.isPrivateRole('landlord') && !RA.isPrivateRole('seller'));
  const SYNC = fs.readFileSync(path.join(ROOT, 'functions', 'algolia-sync.js'), 'utf8');
  const TS = fs.readFileSync(path.join(ROOT, 'functions', 'typesense-sync.js'), 'utf8');
  ck('tenantProfiles is not registered with Algolia', !/_makeTriggers\('tenantProfiles'\)/.test(SYNC));
  ck('tenantProfiles is not registered with Typesense', !/_makeTriggers\('tenantProfiles'\)/.test(TS));
  ck('riders are still not indexed',
     !/_makeTriggers\('drivers'\)/.test(SYNC) && !/_makeTriggers\('drivers'\)/.test(TS));

  /* ══ 10 · the module never persists authority ══ */
  head('10 · authority is never written to storage');
  setToken({ seller: true });
  await RA.refresh(true);
  const dump = JSON.stringify(store);
  ck('no storage key records the approved set',
     !/"approved"/.test(dump) && !/claimsVerified/.test(JSON.parse(store.sokoniUser || '{}')._x || ''),
     'keys: ' + Object.keys(store).join(','));
  /* The one thing it DOES mirror is the acting role, for the existing UI — and it
     is never read back, so corrupting it cannot elevate anyone. */
  const before = RA.getApprovedRoles().join(',');
  localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'u_test', roles: ['superAdmin'], activeRole: 'superAdmin' }));
  ck('corrupting the mirror does not change the approved set',
     RA.getApprovedRoles().join(',') === before);
  ck('...and does not change the acting role', RA.getActiveRole() !== 'superAdmin');

  /* ══ 11 · workspace isolation is separate from EMPLOYMENT workspaces ══ */
  head('11 · role workspaces do not touch the business/employment layer');
  const WS = fs.readFileSync(path.join(ROOT, 'sokoni-workspace.js'), 'utf8');
  ck('sokoni-workspace.js still owns business memberships', /getWorkspaces/.test(WS));
  ck('...and was not repurposed for roles', !/SokoniRoleAuthority/.test(WS));
  const RASRC = fs.readFileSync(path.join(ROOT, 'sokoni-role-authority.js'), 'utf8');
  ck('role authority does not reach into the employment layer', !/SokoniWorkspace/.test(RASRC));
  ck('role authority never reads sokoniUser for authority',
     !/getItem\('sokoniUser'\)[^;]*roles/.test(RASRC));
  ck('role authority never reads the permissions cache', !/sokoniPermissionsCache/.test(RASRC));

  /* ══ 12 · setActiveRole SUCCESS path — the actual persistence, not just the rule ══
     Previously only the refusal branches were exercised, because the module
     hard-coded a URL import the runner cannot resolve. The loader seam lets the
     real write path run against a recording fake, so "it persisted" is observed
     rather than inferred from the rules passing. */
  head('12 · setActiveRole persists through the server-authorized path');
  const writes = [];
  let writeError = null;
  RA.__setFirestoreLoader(async () => ({
    doc: (db, col, id) => ({ col, id }),
    setDoc: async (ref, data, opts) => {
      if (writeError) throw Object.assign(new Error('denied'), { code: writeError });
      writes.push({ ref, data, opts });
    },
    getDoc: async (ref) => ({
      exists: () => ref.id === 'u_test' && ref.col === 'tenantProfiles',
      data: () => ({ name: 'Alpha Tenant', location: 'Nairobi', approved: true, _noIndex: true }),
    }),
  }));
  global.window.firebaseDB = { __fake: true };

  setToken({ seller: true, rider: true });
  await RA.refresh(true);
  writes.length = 0;
  const ok1 = await RA.setActiveRole('seller');
  ck('an approved role persists', ok1.ok === true, ok1.reason || 'ok');
  ck('...to users/{uid}', writes.length === 1 && writes[0].ref.col === 'users' && writes[0].ref.id === 'u_test',
     writes[0] && writes[0].ref.col + '/' + writes[0].ref.id);
  ck('...writing ONLY activeRole — never the roles array',
     writes[0] && Object.keys(writes[0].data).join(',') === 'activeRole', writes[0] && Object.keys(writes[0].data).join(','));
  ck('...with the canonical value', writes[0] && writes[0].data.activeRole === 'seller');
  ck('...as a merge (never clobbering the document)', writes[0] && writes[0].opts && writes[0].opts.merge === true);
  ck('the acting role is now seller', RA.getActiveRole() === 'seller', RA.getActiveRole());

  writes.length = 0;
  const ok2 = await RA.setActiveRole('provider');
  ck('an UNapproved role never reaches the network', writes.length === 0 && !ok2.ok, ok2.reason);
  ck('...and does not change the acting role', RA.getActiveRole() === 'seller');

  /* The server having the final say is the point: even if the local check were
     bypassed, a rules refusal must not be papered over locally. */
  writeError = 'permission-denied';
  const ok3 = await RA.setActiveRole('rider');
  ck('a server refusal is reported honestly', !ok3.ok && ok3.reason === 'rejected-by-server', ok3.reason);
  ck('...and the acting role does NOT move to the refused role',
     RA.getActiveRole() === 'seller', RA.getActiveRole());
  writeError = null;

  /* ══ 13 · fetchRoleProfile ══ */
  head('13 · role profiles are read through the authority');
  setToken({ tenant: true });
  await RA.refresh(true);
  const prof = await RA.fetchRoleProfile('tenant');
  ck('an approved tenant reads its own profile', prof.ok === true && prof.exists === true, prof.reason);
  ck('...from tenantProfiles/{uid}', prof.path === 'tenantProfiles/u_test', prof.path);
  ck('...and the profile is flagged non-indexable at rest', prof.data && prof.data._noIndex === true);
  const profDenied = await RA.fetchRoleProfile('landlord');
  ck('an UNapproved role cannot read that role\'s profile',
     !profDenied.ok && profDenied.reason === 'not-approved', profDenied.reason);
  const profNone = await RA.fetchRoleProfile('buyer');
  ck('buyer has no profile to fetch', !profNone.ok && profNone.reason === 'no-profile-for-role', profNone.reason);

  /* ══ 14 · page guard ══ */
  head('14 · workspace page guard');
  ck('only true workspaces are routed', Object.keys(RA.WORKSPACE_ROUTES).sort().join(',') ===
     'driver.html,landlord.html,provider.html,seller.html', Object.keys(RA.WORKSPACE_ROUTES).join(','));
  ck('driver.html maps to the CANONICAL rider, not legacy driver',
     RA.WORKSPACE_ROUTES['driver.html'] === 'rider');
  ck('landlord.html maps to landlord, NOT collapsed to business',
     RA.WORKSPACE_ROUTES['landlord.html'] === 'landlord');
  ['healthcare.html', 'legal-hub.html', 'car-hub.html', 'property.html', 'index.html'].forEach((p) => {
    ck('public hub ' + p + ' is NOT gated', !RA.WORKSPACE_ROUTES[p]);
  });

  setToken({ seller: true });
  await RA.refresh(true);
  global.window.__replaced = null;
  const g1 = await RA.guardWorkspace('seller');
  ck('an approved seller passes the guard', g1.ok === true);
  ck('...with no redirect', !global.window.__replaced);

  const g2 = await RA.guardWorkspace('landlord');
  ck('an unapproved role is denied', !g2.ok && g2.reason === 'not-approved', g2.reason);
  ck('...and IS redirected somewhere useful', global.window.__replaced === '/profile', global.window.__replaced);

  /* THE REDIRECT-LOOP GUARD: "cannot verify" must never bounce. */
  global.window.__replaced = null;
  TOKEN_THROWS = 'unavailable';
  TOKEN = null;
  global.window.firebaseAuth.currentUser = null;
  await RA.refresh(true);
  const g3 = await RA.guardWorkspace('seller');
  ck('an unverifiable session is denied', !g3.ok && g3.reason === 'not-verified', g3.reason);
  ck('...but is NOT redirected (no bounce loop on "don\'t know")',
     global.window.__replaced === null, String(global.window.__replaced));
  TOKEN_THROWS = null;
  global.window.firebaseAuth.currentUser = { uid: 'u_test',
    getIdTokenResult: async () => { if (!TOKEN) throw Object.assign(new Error('x'), { code: 'unauthenticated' }); return TOKEN; } };

  /* ══ 15 · declarative gating ══ */
  head('15 · [data-require-approved-role] hides until the token proves it');
  const made = [];
  const mkEl = (attr) => {
    const el = { style: {}, _attrs: { 'data-require-approved-role': attr },
      getAttribute: (k) => el._attrs[k], setAttribute: (k, v) => { el._attrs[k] = v; } };
    made.push(el); return el;
  };
  const elLandlord = mkEl('landlord');
  const elTenant = mkEl('tenant');
  const elEither = mkEl('seller,landlord');
  global.document.querySelectorAll = () => made;

  setToken({ landlord: true });
  await RA.refresh(true);
  RA.applyDeclarativeGates();
  ck('an approved landlord sees the landlord block', elLandlord.style.display === '');
  ck('...and the block records that it opened', elLandlord.getAttribute('data-approved-gate') === 'open');
  ck('an unapproved tenant block stays hidden', elTenant.style.display === 'none');
  ck('a multi-role attribute opens on ANY approved role', elEither.style.display === '');

  setToken({});
  await RA.refresh(true);
  RA.applyDeclarativeGates();
  ck('revoking the role closes the block again', elLandlord.style.display === 'none');
  ck('...and it records that it closed', elLandlord.getAttribute('data-approved-gate') === 'closed');
  global.document.querySelectorAll = () => [];

  /* ══ 16 · legacy agent/business are RETIRED BY AUTHORITY, not deleted ══
     Deleting them was considered and rejected on evidence:
       `business` is still consumed — admin.html renders a role badge for it,
       profile.html gates product display on it, and sokoni-permissions.js maps
       landlord.html/property.html onto it in GUARDED_ROUTES and MANAGEMENT_PAGES.
       `agent` survives only inside profile.html (the hubAgent checkbox and the
       ROLES entry), but removing the ROLES entry would make getRoleDef() fall back
       to Buyer for any cached account still carrying it.
     So neither is deleted. Instead they are made UNREACHABLE: no approval grants
     them, so they can never enter the approved set, never open a workspace and
     never be selected. That is retirement without breaking compatibility. */
  head('16 · legacy agent/business cannot be granted');
  ['agent', 'business', 'business_owner', 'professional'].forEach((r) => {
    ck(r + ' is not canonical', RA.CANONICAL_ROLES.indexOf(r) < 0);
    ck(r + ' does not normalise to a canonical role', RA.canonicalise(r) === null);
  });
  setToken({ agent: true, business: true, professional: true });
  await RA.refresh(true);
  ck('a token claiming agent grants nothing', !RA.isApproved('agent'));
  ck('a token claiming business grants nothing', !RA.isApproved('business'));
  ck('the approved set stays baseline', RA.getApprovedRoles().join(',') === 'buyer',
     RA.getApprovedRoles().join(','));
  ck('neither can open a workspace', !(await RA.canEnterWorkspace('agent')) && !(await RA.canEnterWorkspace('business')));
  const legacySel = await RA.setActiveRole('agent');
  ck('neither can be selected as the acting role', !legacySel.ok, legacySel.reason);
  /* Compatibility preserved: the definitions are still THERE for cached accounts. */
  const PROF = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');
  ck("profile.html still defines `agent` (cached accounts render correctly)", /key:'agent'/.test(PROF));
  ck("profile.html still defines `business`", /key:'business'/.test(PROF));
  const PERMS = fs.readFileSync(path.join(ROOT, 'sokoni-permissions.js'), 'utf8');
  ck('sokoni-permissions.js was NOT modified by Phase 4', /GUARDED_ROUTES/.test(PERMS) && /MANAGEMENT_PAGES/.test(PERMS));

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
