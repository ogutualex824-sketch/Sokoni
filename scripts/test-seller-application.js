#!/usr/bin/env node
/* Seller application intake (E2 stage 1) — the request must never become the authority.
 *
 *   npm run test:seller:application
 *
 * THE INVARIANT UNDER TEST
 *   `applications` is the REQUEST.  The `seller` claim is the AUTHORITY.
 *
 * Four things are NOT seller authority, and each has a live counter-example:
 *   - an application document           — 3 accounts hold one with no role, no claim
 *   - sellers/{uid}.status === 'active' — the applicant writes it themselves
 *   - roles[] containing 'seller'       — historical, not what the server reads
 *   - a stray seller:true claim         — one test account holds one with no application
 *
 * The module runs in a browser and dynamically imports the Firestore SDK, so the
 * harness rewrites that one import to an injected stub. The rewrite is asserted, and
 * the rest of the module is the REAL source — not a re-implementation.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n-- ' + t + ' --');

const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-seller-application.js'), 'utf8');

/* The module resolves everything through its `global` alias, so the injected stub has
   to be reached the same way — a bare `__FS()` is not in the sandbox's scope. */
const IMPORT_RE = /await import\(FS\)/g;
const STUB_CALL = 'await global.__FS()';

/* -- harness ---------------------------------------------------------------- */
function load(opts) {
  const o = opts || {};
  const written = [];
  const fsMod = {
    collection: (db, name) => ({ __col: name }),
    query: (col, ...w) => ({ __col: col.__col, __where: w }),
    where: (f, op, v) => ({ f, op, v }),
    getDocs: async (q) => ({
      forEach: (cb) => (o.applications || []).forEach((a, i) => cb({ id: a.id || 'app' + i, data: () => a })),
      __q: q,
    }),
    addDoc: async (col, doc) => { written.push({ col: col.__col, doc }); return { id: 'newApp1' }; },
    serverTimestamp: () => '__ts__',
  };

  const g = {
    firebaseDB: {},
    firebaseAuth: o.signedOut ? { currentUser: null }
      : { currentUser: { uid: o.uid || 'uidBuyer', email: 'b@example.com', displayName: 'Buyer One' } },
    SokoniRoleAuthority: o.noAuthority ? undefined : {
      ready: async () => true,
      isApproved: (r) => !!(o.claims || {})[r],
    },
    __FS: async () => fsMod,
  };

  const patched = SRC.replace(IMPORT_RE, STUB_CALL);
  if (patched === SRC) throw new Error('harness rewrite did not apply - module shape changed');
  new Function('window', patched + '\n')(g);
  return { api: g.SokoniSellerApplication, written, g };
}

(async () => {
  head('0 - harness integrity');
  const base = load({});
  ck('module loads and exposes the API', !!(base.api && base.api.state && base.api.submit));
  ck('the SDK import was actually stubbed', SRC.replace(IMPORT_RE, STUB_CALL).includes(STUB_CALL));

  /* == 1 - a buyer has nothing == */
  head('1 - buyer with no application and no claim');
  let r = await load({}).api.state();
  ck('state = none', r.state === 'none', r.state);
  ck('may apply', r.canApply === true);

  /* == 2 - pending blocks a duplicate == */
  head('2 - an active application blocks a second one');
  for (const st of ['pending', 'info_requested', 'in_review', 'submitted']) {
    const h = load({ applications: [{ id: 'a1', requestedRole: 'seller', status: st, createdAt: 2 }] });
    const s = await h.api.state();
    ck(`status '${st}' -> pending, cannot re-apply`, s.state === 'pending' && s.canApply === false, s.state);
    let threw = null;
    try { await h.api.submit({}); } catch (e) { threw = e; }
    ck(`status '${st}' -> submit() refuses`, !!threw && /application-not-allowed/.test(threw.message));
    ck(`status '${st}' -> nothing was written`, h.written.length === 0);
  }

  /* == 3 - THE INVARIANTS: none of these is authority == */
  head('3 - request is not authority');

  r = await load({ applications: [{ id: 'a1', requestedRole: 'seller', status: 'approved', createdAt: 2 }] }).api.state();
  ck('approved application WITHOUT the claim -> pending, not approved', r.state === 'pending', r.state);

  /* The claim IS the authority, so it stands alone. An approved seller whose
     applications/{appId} row is missing entirely — pre-dating the intake, or
     deleted — must still read as approved, or the UI would invite the platform's
     existing merchants to re-apply for access they already hold. */
  const hClaimOnly = load({ claims: { seller: true } });
  r = await hClaimOnly.api.state();
  ck('seller CLAIM with NO application document at all -> approved', r.state === 'approved', r.state);
  ck('...and the application record is simply absent', r.application === null);
  ck('...and cannot re-apply', r.canApply === false);
  let tClaim = null;
  try { await hClaimOnly.api.submit({ shopName: 'x' }); } catch (e) { tClaim = e; }
  ck('...and submit() refuses (no duplicate request from an approved seller)',
     !!tClaim && /application-not-allowed:approved/.test(tClaim.message));
  ck('...and nothing was written', hClaimOnly.written.length === 0);

  ck('module never reads sellers/{uid} as authority', !/collection\([^)]*['"`]sellers['"`]/.test(SRC));
  ck('module never reads roles[] as authority', !/\broles\b/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
  ck('approval is sourced from the claim via SokoniRoleAuthority',
     /SokoniRoleAuthority/.test(SRC) && /isApproved\(ROLE\)/.test(SRC));

  /* "cannot tell" must never read as "yes" */
  r = await load({ noAuthority: true }).api.state();
  ck('no authority module -> NOT approved', r.state !== 'approved', r.state);

  /* == 4 - rejected / suspended == */
  head('4 - rejected may re-apply, suspended may not');
  r = await load({ applications: [{ id: 'a1', requestedRole: 'seller', status: 'rejected', createdAt: 2 }] }).api.state();
  ck('rejected -> canApply', r.state === 'rejected' && r.canApply === true, r.state);
  ck('rejected grants NO claim', r.state !== 'approved');
  r = await load({ applications: [{ id: 'a1', requestedRole: 'seller', status: 'suspended', createdAt: 2 }] }).api.state();
  ck('suspended -> cannot apply', r.state === 'suspended' && r.canApply === false, r.state);

  /* == 5 - what submit() writes == */
  head('5 - the submitted document is applicant-writable only');
  const h5 = load({});
  const res = await h5.api.submit({ shopName: 'Maina Groceries', phone: '0722', location: 'Nairobi' });
  ck('submit returns pending', res && res.state === 'pending');
  ck('exactly one document written, to applications',
     h5.written.length === 1 && h5.written[0].col === 'applications');
  const doc = h5.written[0].doc;
  ck('declares requestedRole = seller', doc.requestedRole === 'seller');
  ck('status = pending', doc.status === 'pending');
  ck('uid = caller', doc.uid === 'uidBuyer');
  for (const forbidden of ['role', 'approved', 'approvedAt', 'approvedBy', 'roles', 'seller', 'isAdmin', 'commissionRate']) {
    ck(`does NOT write '${forbidden}' (refused by noAdminFields)`, doc[forbidden] === undefined);
  }

  /* == 6 - signed out == */
  head('6 - signed out');
  const h6 = load({ signedOut: true });
  r = await h6.api.state();
  ck('state = signed-out, cannot apply', r.state === 'signed-out' && r.canApply === false);
  let t6 = null; try { await h6.api.submit({}); } catch (e) { t6 = e; }
  ck('submit refuses', !!t6 && /not-signed-in/.test(t6.message));

  /* == 7 - NEGATIVE CONTROL == */
  head('7 - negative control: treat the application as authority, invariant breaks');
  const NEUTERED = SRC.replace(
    "if (claim) return { state: 'approved', application: latest, canApply: false, reason: 'claim-held' };",
    "if (claim || (latest && _norm(latest.status) === 'approved')) return { state: 'approved', application: latest, canApply: false, reason: 'claim-held' };"
  );
  ck('the substitution applied', NEUTERED !== SRC);
  const gN = {
    firebaseDB: {}, firebaseAuth: { currentUser: { uid: 'uidBuyer' } },
    SokoniRoleAuthority: { ready: async () => true, isApproved: () => false },
    __FS: async () => ({
      collection: () => ({}), query: () => ({}), where: () => ({}),
      getDocs: async () => ({ forEach: (cb) => cb({ id: 'a1', data: () => ({ requestedRole: 'seller', status: 'approved', createdAt: 1 }) }) }),
      addDoc: async () => ({ id: 'x' }), serverTimestamp: () => '__ts__',
    }),
  };
  new Function('window', NEUTERED.replace(IMPORT_RE, STUB_CALL) + '\n')(gN);
  const rN = await gN.SokoniSellerApplication.state();
  ck('with the substitution, an approved APPLICATION alone reads as approved (defect reproduced)',
     rN.state === 'approved', rN.state);

  /* == 8 - surface wiring == */
  head('8 - surfaces are wired and imply no unearned access');
  const PROFILE = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');
  const AUTH = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');

  ck('profile.html loads the intake module', /<script src="sokoni-seller-application\.js"><\/script>/.test(PROFILE));
  ck('...after sokoni-role-authority.js (claim check dependency)',
     PROFILE.indexOf('sokoni-role-authority.js') < PROFILE.indexOf('sokoni-seller-application.js'));
  ck('profile.html has the seller card container', /id="skSellerAppCard"/.test(PROFILE));
  ck('profile.html defines the renderer', /function renderSellerApplicationCard\(\)/.test(PROFILE));
  ck('renderer runs on sokoniRoleAuthorityReady (claims verified first)',
     /sokoniRoleAuthorityReady[\s\S]{0,400}?renderSellerApplicationCard\(\)/.test(PROFILE));
  ck('the card renders approved ONLY from the module state, not roles[]/sellers doc',
     !/skSellerAppCard[\s\S]{0,4000}?sellers\//.test(PROFILE));

  /* the signup success card must not imply seller access */
  const successCard = AUTH.slice(AUTH.indexOf('Replace the auth card with the success screen'));
  const cardEnd = successCard.indexOf('</div>`');
  const cardHtml = successCard.slice(0, cardEnd > 0 ? cardEnd : 2500);
  ck('signup success card no longer offers a Seller Dashboard',
     !/Open Seller Dashboard/.test(cardHtml) && !/seller\.html/.test(cardHtml));
  ck('signup success card offers Go to Profile', /Go to Profile/.test(cardHtml) && /profile\.html/.test(cardHtml));

  /* The success card is built inside a TEMPLATE LITERAL, so a stray backtick in the
     markup silently terminates it and breaks the whole file. A source-regex suite
     will happily pass against a file that no longer parses — this caught exactly
     that during E2 stage 1, so the parse is asserted, not assumed. */
  const { execFileSync } = require('child_process');
  const parses = (f) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); return true; }
    catch (e) { return false; }
  };
  ck('auth.js parses', parses('auth.js'));
  ck('sokoni-seller-application.js parses', parses('sokoni-seller-application.js'));
  const tplStart = AUTH.indexOf('card.innerHTML = `');
  const tplEnd = AUTH.indexOf('`;', tplStart);
  ck('no backtick inside the success-card template literal',
     tplStart > -1 && tplEnd > tplStart && AUTH.slice(tplStart + 18, tplEnd).indexOf('`') === -1);

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
