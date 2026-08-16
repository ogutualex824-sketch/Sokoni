#!/usr/bin/env node
/* Role authority — does a granted role actually reach BOTH places it must?
 *
 *   node scripts/test-role-authority.js
 *
 * No emulator, no network, no credentials: firebase-admin/firestore,
 * firebase-admin/auth and firebase-functions/logger are stubbed, so this runs
 * anywhere and asserts on the exact payload the SDK would have been handed.
 *
 * WHY
 * A role is two facts that must agree — `users/{uid}.roles[]` (what the server,
 * dashboards and analytics read) and the Auth custom claim (what firestore.rules
 * and the client role gate read). Three paths granted a role; two of them
 * (automation-engine auto-approval, wap seller.activate) wrote only
 * `role: "seller"` and never minted a claim, and the third (application-lifecycle)
 * swallowed its own claim failure with a logger.warn. Every one of those produced
 * an account that looked approved everywhere an operator looks and behaved as a
 * buyer for the person who owned it.
 *
 * Two kinds of assertion here, and they are not interchangeable:
 *
 *   PART A  behavioural — drives the real ./functions/role-authority against
 *           stubbed SDKs and asserts the written payload and the failure record.
 *   PART B  static contract on the two call sites, WITH A NEGATIVE CONTROL:
 *           every detector is re-run against a deliberately mutated copy of the
 *           source and must flag it. A detector that cannot fail proves nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ─────────────────────────────────────────────────────────────────────────────
   Stubbed SDK. `ENV` is swapped per scenario; role-authority resolves it at
   call time through getFirestore()/getAuth(), so one require is enough.
   ────────────────────────────────────────────────────────────────────────── */
const S = (kind, extra = {}) => ({ __sentinel: kind, ...extra });
const FieldValue = {
  serverTimestamp: () => S('serverTimestamp'),
  arrayUnion: (...values) => S('arrayUnion', { values }),
  arrayRemove: (...values) => S('arrayRemove', { values }),
  increment: (by) => S('increment', { by }),
  delete: () => S('delete'),
};

let ENV = null;
function makeEnv({ claims = {}, getUserThrows = null, setClaimsThrows = null } = {}) {
  const log = [];  /* every side effect, in order — ordering is part of the contract */
  const db = {
    collection: (coll) => ({
      doc: (id) => ({
        set: async (data, opts) => { log.push({ op: 'set', coll, id, data, opts }); },
        delete: async () => { log.push({ op: 'delete', coll, id }); },
      }),
    }),
  };
  const auth = {
    getUser: async (uid) => {
      log.push({ op: 'getUser', uid });
      if (getUserThrows) throw new Error(getUserThrows);
      return { uid, customClaims: claims };
    },
    setCustomUserClaims: async (uid, next) => {
      log.push({ op: 'setClaims', uid, claims: next });
      if (setClaimsThrows) throw new Error(setClaimsThrows);
    },
  };
  return { db, auth, log, errors: [] };
}

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
  if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
  if (id === 'firebase-functions/logger') {
    return {
      info: () => {}, warn: () => {}, debug: () => {},
      error: (...a) => ENV.errors.push(a),
    };
  }
  return origRequire.apply(this, arguments);
};

const RA = require(path.join(FUNCTIONS_DIR, 'role-authority.js'));
Module.prototype.require = origRequire;

const isSentinel = (v, kind) => !!v && typeof v === 'object' && v.__sentinel === kind;
const find = (log, op, coll) => log.filter(e => e.op === op && (coll === undefined || e.coll === coll));

/* ─────────────────────────────────────────────────────────────────────────────
   PART A — behaviour of the primitive
   ────────────────────────────────────────────────────────────────────────── */
console.log('\nPART A — role-authority primitive\n');

/* A1-A5: the Firestore half. */
{
  const p = RA.roleFieldPatch('seller', true);

  ck('A1  grant writes roles[] via arrayUnion (not a role string)',
    isSentinel(p.roles, 'arrayUnion') && p.roles.values.join() === 'seller' && !('role' in p),
    JSON.stringify(p.roles));

  ck('A2  registeredAs is a NESTED map, never a dotted key',
    p.registeredAs && p.registeredAs.seller === true
      && Object.keys(p).every(k => !k.includes('.')),
    Object.keys(p).join(','));

  ck('A3  patch is transaction-safe: plain values and sentinels only',
    Object.values(p).every(v => typeof v !== 'function')
      && typeof p.then !== 'function');

  const d = RA.roleFieldPatch('driver', true);
  ck('A4  driver maps to the "rider" key and keeps the legacy booleans',
    isSentinel(d.roles, 'arrayUnion') && d.roles.values[0] === 'rider'
      && d.isDriver === true && d.isRider === true);

  const r = RA.roleFieldPatch('seller', false);
  ck('A5  revoke uses arrayRemove, clears registeredAs, does not set approved',
    isSentinel(r.roles, 'arrayRemove') && r.roles.values[0] === 'seller'
      && r.registeredAs.seller === false && !('approved' in r));
}

/* A6b: an unmapped role still defaults (this branch's behaviour is unchanged)
   but the default is REPORTED. Phase 2 — which is not on this branch — replaces
   the default with a throw; see the merge-hazard note in role-authority.js. */
{
  ENV = makeEnv();
  const key = RA.roleKeyFor('mechanic');
  ck('A6b an unmapped role defaults to provider AND is logged, not silent',
    key === 'provider' && ENV.errors.length === 1, key);
}

/* A6: caller extras may not overwrite the canonical role fields. */
{
  const p = RA.roleFieldPatch('seller', true, { role: 'seller', roles: 'seller', sellerEnabled: true });
  ck('A6  caller extras cannot clobber roles[] (canonical fields win)',
    isSentinel(p.roles, 'arrayUnion') && p.role === 'seller' && p.sellerEnabled === true);
}

/* A7-A9: the claim half, success path. */
{
  ENV = makeEnv({ claims: { rider: true, admin: false } });
  RA.syncRoleClaim('u1', 'seller', true, { source: 'test' }).then((r) => {
    const set = find(ENV.log, 'setClaims')[0];
    ck('A7  success mints the claim and PRESERVES unrelated existing claims',
      !!set && set.claims.seller === true && set.claims.rider === true && set.claims.admin === false,
      JSON.stringify(set && set.claims));

    ck('A8  success retires any open divergence record',
      find(ENV.log, 'delete', 'roleClaimReconcile').length === 1
        && find(ENV.log, 'set', 'roleClaimReconcile').length === 0);

    ck('A9  success returns ok/minted', r.ok === true && r.claim === 'minted' && r.key === 'seller');

    partA2();
  });
}

/* A10-A14: the claim half, failure path — the whole point of the module. */
function partA2() {
  ENV = makeEnv({ setClaimsThrows: 'auth/internal-error' });
  RA.syncRoleClaim('u2', 'seller', true, { source: 'test', entityId: 'app_9' }).then((r) => {
    const rec = find(ENV.log, 'set', 'roleClaimReconcile')[0];
    const alert = find(ENV.log, 'set', 'adminAlerts')[0];

    ck('A10 a failed mint NEVER throws — the caller decides', r.ok === false && r.claim === 'failed');

    ck('A11 the divergence is RECORDED, not warned away',
      !!rec && rec.id === 'u2__seller' && rec.data.state === 'CLAIM_MISSING'
        && rec.data.uid === 'u2' && rec.data.desiredClaim === true
        && isSentinel(rec.data.attempts, 'increment')
        && rec.data.lastError === 'auth/internal-error'
        && rec.data.source === 'test' && rec.data.entityId === 'app_9',
      rec && rec.id);

    ck('A12 an operator-visible alert is raised, deduplicated by a deterministic id',
      !!alert && alert.id === 'role_claim_unminted__u2__seller'
        && alert.data.kind === 'role_claim_unminted' && alert.data.severity === 'high'
        && alert.data.reconcileId === 'u2__seller',
      alert && alert.id);

    ck('A13 the failure is logged at error level, not warn',
      ENV.errors.length >= 1);

    ck('A14 the caller is handed the reconcile id to report',
      r.reconcileId === 'u2__seller' && typeof r.error === 'string');

    partA3();
  });
}

/* A15-A16: a missing Auth account, and a failed REVOKE. */
function partA3() {
  ENV = makeEnv({ getUserThrows: 'auth/user-not-found' });
  RA.syncRoleClaim('ghost', 'seller', true, { source: 'test' }).then((r) => {
    ck('A15 a missing Auth account is a recorded divergence, not a crash',
      r.ok === false && find(ENV.log, 'set', 'roleClaimReconcile').length === 1,
      r.error);

    ENV = makeEnv({ setClaimsThrows: 'boom' });
    return RA.syncRoleClaim('u3', 'seller', false, { source: 'test' });
  }).then((r) => {
    const rec = find(ENV.log, 'set', 'roleClaimReconcile')[0];
    ck('A16 a failed REVOKE is classified CLAIM_STALE (privilege still live)',
      r.ok === false && rec.data.state === 'CLAIM_STALE' && rec.data.desiredClaim === false);

    partA4();
  });
}

/* A17-A18: grantAccountRole ordering — Firestore commits BEFORE the mint. */
function partA4() {
  ENV = makeEnv({ claims: {} });
  RA.grantAccountRole(ENV.db, 'u4', 'seller', true, { source: 'test' }).then((r) => {
    const userWrite = ENV.log.findIndex(e => e.op === 'set' && e.coll === 'users');
    const mint = ENV.log.findIndex(e => e.op === 'setClaims');

    ck('A17 the Firestore role write happens BEFORE the claim mint',
      userWrite >= 0 && mint >= 0 && userWrite < mint, `${userWrite} < ${mint}`);

    ck('A18 grantAccountRole returns the claim outcome (not a bare key string)',
      typeof r === 'object' && r.ok === true && r.key === 'seller');

    partB();
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   PART B — the two bypasses, with a negative control

   These are source-level detectors: loading automation-engine.js / wap.js would
   register Cloud Functions. Every detector is proven by mutation below — if a
   mutant that reintroduces the original defect still passes, the detector is
   worthless and this suite says so.
   ────────────────────────────────────────────────────────────────────────── */

/* All violations a bypass site can commit. Returns [] when the file is clean. */
function auditSource(src) {
  const v = [];

  if (!/require\(['"]\.\/role-authority['"]\)/.test(src)) v.push('does not require ./role-authority');

  /* Two legal shapes: the two-phase form (own transaction/batch) or the
     all-in-one grantAccountRole (no transaction of its own). */
  const twoPhase = /\broleFieldPatch\s*\(/.test(src);
  const allInOne = /\bgrantAccountRole\s*\(/.test(src);
  if (!twoPhase && !allInOne) v.push('never builds the canonical role patch');
  if (!/\bsyncRoleClaim\s*\(/.test(src) && !allInOne) v.push('never mints the Auth claim');

  /* Any users/{uid} write that grants a role must go through the primitive. */
  const userWrite = /collection\(['"]users['"]\)/g;
  let m;
  while ((m = userWrite.exec(src)) !== null) {
    const slice = src.slice(m.index, m.index + 500);
    const grantsRole = /\brole\s*:|\broles\s*:|sellerEnabled|registeredAs/.test(slice);
    if (grantsRole && !/roleFieldPatch\s*\(/.test(slice)) {
      v.push('users write grants a role without roleFieldPatch at offset ' + m.index);
    }
  }

  /* setCustomUserClaims is an Auth call: it must never sit inside a Firestore
     transaction. Bound the slice to the transaction's own braces rather than
     scanning the whole file. */
  const tx = src.indexOf('runTransaction(');
  if (tx >= 0) {
    const open = src.indexOf('{', tx);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(open, end < 0 ? src.length : end);
    if (/syncRoleClaim\s*\(|setCustomUserClaims\s*\(/.test(body)) {
      v.push('mints an Auth claim INSIDE a Firestore transaction');
    }
  }

  /* A result that is never inspected is a result that lies. */
  if ((/\bsyncRoleClaim\s*\(/.test(src) || allInOne)
      && !/\.ok\b/.test(src) && !/if\s*\(\s*!\w*claim/.test(src)) {
    v.push('does not branch on the claim outcome');
  }

  return v;
}

function partB() {
  console.log('\nPART B — bypass call sites\n');

  const targets = [
    { name: 'functions/automation-engine.js', file: path.join(FUNCTIONS_DIR, 'automation-engine.js') },
    { name: 'functions/wap.js', file: path.join(FUNCTIONS_DIR, 'wap.js') },
    { name: 'functions/application-lifecycle.js', file: path.join(FUNCTIONS_DIR, 'application-lifecycle.js') },
  ];

  for (const t of targets) {
    const src = fs.readFileSync(t.file, 'utf8');
    const v = auditSource(src);
    ck('B1  ' + t.name + ' honours the role contract', v.length === 0, v.join(' | '));
  }

  /* ── Claim-writer registry ────────────────────────────────────────────────
     Every module that mints an account-role claim, recorded deliberately. This
     is a REGISTRY GUARD, not a clean bill of health: a NEW claim writer fails
     the suite, and the known ones carry their status so they cannot quietly
     become "fine". Stage 1's bypass audit covered role GRANTS that skipped the
     claim; these are the mirror image — claim writers outside the primitive —
     and they are reported, not silently accepted.

       super-admin.js         setUserRole: builds the whole claims object for
                              seller/driver/provider/moderator. A genuine second
                              account-role authority. OPEN for Stage 2.
       provider-onboarding.js publishes a provider and mints `provider: true`
                              BEFORE batch.commit(), and the batch never writes
                              users.roles[] — the ROLE_MISSING mirror defect.
                              OPEN for Stage 2.
       universal-onboarding.js the `accounts/{uid}` role model (a different
                              collection from users/{uid}). Parallel model, not
                              yet converged. OPEN for Stage 2.
       admin-os.js            adminSetUserRole accepts seller/provider/driver and
                              mints `{ [role]: true }` WITHOUT spreading the
                              existing claims, then writes users.role (string),
                              never roles[]. Third account-role authority, and
                              destructive to unrelated claims. OPEN for Stage 2.
       invitations-core.js    platform-employee roles (CLAIM_ROLES), not account
                              roles — separate layer. NOT a convergence target.
       index.js               admin / superAdmin / platformRole claims — a
                              different security layer, correctly separate from
                              account roles. NOT a convergence target.

     The trigger is deliberately narrow: minting a claim is not itself a
     violation (deactivated, suspended, betaStatus are legitimate non-role
     claims). What is registered here is minting a claim keyed on a ROLE. */
  const mintsRoleClaim = (src) =>
    /setCustomUserClaims\s*\(/.test(src)
    && (/\b(seller|rider|driver|provider)\s*:\s*(true|false|!!|cleanRole|role\b)/.test(src)
        || /\[\s*role\s*\]\s*:\s*true/.test(src));

  const KNOWN_CLAIM_WRITERS = [
    'super-admin.js', 'provider-onboarding.js', 'universal-onboarding.js',
    'admin-os.js', 'invitations-core.js', 'index.js',
  ];
  const unregistered = [];
  for (const f of fs.readdirSync(FUNCTIONS_DIR)) {
    if (!f.endsWith('.js') || f === 'role-authority.js' || KNOWN_CLAIM_WRITERS.includes(f)) continue;
    if (mintsRoleClaim(fs.readFileSync(path.join(FUNCTIONS_DIR, f), 'utf8'))) unregistered.push(f);
  }
  ck('B2  no NEW role-claim authority outside the primitive', unregistered.length === 0, unregistered.join(','));

  /* The registry must stay honest: a listed writer that no longer mints a role
     claim gets delisted, rather than leaving a stale exemption that could hide
     a new authority appearing in the same file. */
  const stale = KNOWN_CLAIM_WRITERS.filter(f =>
    !mintsRoleClaim(fs.readFileSync(path.join(FUNCTIONS_DIR, f), 'utf8')));
  ck('B3  the claim-writer registry has no stale exemptions', stale.length === 0, stale.join(','));

  /* ── Negative control ──────────────────────────────────────────────────────
     Reintroduce each original defect in a copy of the source. A detector that
     does not flag its own mutant is not a detector. */
  const ae = fs.readFileSync(path.join(FUNCTIONS_DIR, 'automation-engine.js'), 'utf8');
  const wp = fs.readFileSync(path.join(FUNCTIONS_DIR, 'wap.js'), 'utf8');

  const mutants = [
    {
      label: 'M1  automation-engine writes role:"seller" without the patch',
      src: ae.replace(/roleFieldPatch\('seller', true, \{/, '({'),
      expect: /roleFieldPatch|users write grants a role/,
    },
    {
      label: 'M2  automation-engine never mints the claim',
      src: ae.replace(/const claim = await syncRoleClaim\([\s\S]*?\}\);/, 'const claim = { ok: true };'),
      expect: /never mints the Auth claim/,
    },
    {
      label: 'M3  automation-engine mints the claim inside the transaction',
      src: ae.replace(
        /(await _db\(\)\.runTransaction\(async tx => \{)/,
        '$1\n        await syncRoleClaim(app.userId, "seller", true, {});'),
      expect: /INSIDE a Firestore transaction/,
    },
    {
      label: 'M4  wap seller.activate drops the claim mint',
      src: wp.replace(/const claim = await syncRoleClaim\([\s\S]*?\}\);/, 'const claim = { ok: true, key: "seller" };'),
      expect: /never mints the Auth claim/,
    },
    {
      label: 'M5  wap seller.activate reverts to the bare role string',
      src: wp.replace(/roleFieldPatch\("seller", true, \{/, '({'),
      expect: /roleFieldPatch|users write grants a role/,
    },
  ];

  for (const mu of mutants) {
    const v = auditSource(mu.src);
    const caught = v.some(x => mu.expect.test(x));
    ck(mu.label + ' → detected', caught, v.join(' | ') || 'mutation produced NO violation');
  }

  /* The mutants must actually differ from the source, or "detected" is an
     artefact of a no-op replace. */
  ck('M0  every mutation actually changed the source',
    mutants.every(mu => mu.src !== ae && mu.src !== wp));

  done();
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}
