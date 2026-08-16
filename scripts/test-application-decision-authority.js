#!/usr/bin/env node
/* A submitted application must not be able to approve itself.
 *
 *   node scripts/test-application-decision-authority.js
 *
 * No emulator, no credentials: firebase-functions and firebase-admin are
 * stubbed, the REAL applicationLifecycle trigger handler is captured as it
 * registers, and each test invokes it with a synthetic event. The assertions
 * are on what the handler actually wrote and on whether the Auth claim was
 * minted — not on source text.
 *
 * WHY
 * firestore.rules permits an applicant to update their own application:
 *
 *     allow update: if isAdmin() || (isOwner() && claimsOwner() && noAdminFields())
 *
 * `noAdminFields()` withholds `approved` / `role` / `verified`. The projection
 * reads NONE of those — it reads `status`, which the applicant may write. So
 * before the guard under test, any signed-in user could set status:'approved'
 * on their own request and be granted the role AND the seller claim. The rule's
 * own comment asserts self-approval is impossible; it guards a field the
 * decision engine never consults.
 *
 * The guard verifies the CLAIMS of the account named in `decidedBy`, because
 * `decidedBy` is itself client-writable and custom claims are not.
 *
 * PART C mutation-tests the guard by removing it from a copy of the source and
 * proving these tests then fail — a test that cannot fail proves nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Stubbed SDK ─────────────────────────────────────────────────────────── */
const S = (kind, extra = {}) => ({ __sentinel: kind, ...extra });
const FieldValue = {
  serverTimestamp: () => S('serverTimestamp'),
  arrayUnion: (...v) => S('arrayUnion', { values: v }),
  arrayRemove: (...v) => S('arrayRemove', { values: v }),
  increment: (by) => S('increment', { by }),
  delete: () => S('delete'),
};

let ENV;
function makeEnv({ accounts = {}, docs = {} } = {}) {
  const log = [];
  const mkDoc = (coll, id) => ({
    id,
    async get() {
      const d = docs[`${coll}/${id}`];
      return { exists: !!d, id, data: () => d };
    },
    async set(data, opts) { log.push({ op: 'set', coll, id, data, opts }); },
    async update(data) { log.push({ op: 'update', coll, id, data }); },
    async delete() { log.push({ op: 'delete', coll, id }); },
  });
  const mkColl = (coll) => ({
    doc: (id) => mkDoc(coll, id),
    async add(data) { log.push({ op: 'add', coll, data }); return { id: 'gen' }; },
    where() { return this; }, limit() { return this; }, orderBy() { return this; },
    async get() { return { docs: [], empty: true, forEach() {} }; },
  });
  return {
    log,
    db: { collection: mkColl, batch: () => ({ set() {}, update() {}, async commit() {} }) },
    auth: {
      async getUser(uid) {
        if (!accounts[uid]) { const e = new Error('There is no user record'); e.code = 'auth/user-not-found'; throw e; }
        return { uid, customClaims: accounts[uid] };
      },
      async setCustomUserClaims(uid, claims) { log.push({ op: 'MINT_CLAIM', uid, claims }); },
    },
  };
}

/* Capture the trigger handler as the module registers it. */
let TRIGGER = null;
const orig = Module.prototype.require;
function installStubs() {
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/firestore') {
      return { onDocumentWritten: (_opts, handler) => { TRIGGER = handler; return handler; } };
    }
    if (id === 'firebase-functions/v2/https') {
      return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    }
    if (id === './notify' || id === './search-terms') {
      return { notify: async () => {}, buildSearchTerms: () => [], searchTerms: () => [] };
    }
    return orig.apply(this, arguments);
  };
}
const removeStubs = () => { Module.prototype.require = orig; };

/* Load a (possibly mutated) copy of application-lifecycle.js and return its trigger. */
function loadLifecycle(sourceOverride) {
  TRIGGER = null;
  let file = path.join(FUNCTIONS_DIR, 'application-lifecycle.js');
  if (sourceOverride) {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'applc-')), 'application-lifecycle.js');
    fs.writeFileSync(file, sourceOverride);
    /* Its relative requires must still resolve to the real modules. */
    fs.writeFileSync(path.join(path.dirname(file), 'role-authority.js'),
      `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, 'role-authority.js'))});`);
  }
  delete require.cache[require.resolve(file)];
  installStubs();
  try { require(file); } finally { removeStubs(); }
  if (!TRIGGER) throw new Error('trigger handler was never registered');
  return TRIGGER;
}

/* A synthetic applications/{id} write event. */
function eventFor(appId, data) {
  const ref = {
    async set(patch, opts) { ENV.log.push({ op: 'set', coll: 'applications', id: appId, data: patch, opts }); },
  };
  return { params: { appId }, data: { after: { exists: true, ref, data: () => data } } };
}

/* An application that has already been normalised, so the trigger reaches
   phase 2 instead of returning after the intake patch. */
const NORMALISED = {
  uid: 'SELLER_A',
  type: 'seller',
  role: 'seller',
  name: 'Shop B Traders',
  phone: '0726043059',
  phoneNumber: '+254726043059',
  intakeVersion: 1,
  roleResolvedBy: 'keyword',
  location: 'Nairobi',
};

const minted = (log) => log.filter(e => e.op === 'MINT_CLAIM');
const userWrites = (log) => log.filter(e => e.op === 'set' && e.coll === 'users');
const appWrites = (log) => log.filter(e => e.op === 'set' && e.coll === 'applications');
const alerts = (log) => log.filter(e => e.coll === 'adminAlerts');

/* ═════════════════════════════════════════════════════════════════════════
   PART A — the forged decision
   ═════════════════════════════════════════════════════════════════════════ */
async function partA(trigger, { quiet = false } = {}) {
  const results = {};

  /* A1 — the applicant writes status:'approved' on their own request. */
  ENV = makeEnv({ accounts: { SELLER_A: {} } });
  await trigger(eventFor('app_1', { ...NORMALISED, status: 'approved' }));
  results.selfApproveMinted = minted(ENV.log).length;
  results.selfApproveRoleWrites = userWrites(ENV.log).length;
  const blocked = appWrites(ENV.log).find(w => w.data.projectionStatus === 'blocked_unauthorised_decision');
  results.selfApproveBlocked = !!blocked;
  results.selfApproveAlert = alerts(ENV.log).length;

  if (!quiet) {
    ck('A1  self-approval mints NO claim', results.selfApproveMinted === 0, results.selfApproveMinted + ' mint(s)');
    ck('A2  self-approval writes NO role to users/{uid}', results.selfApproveRoleWrites === 0);
    ck('A3  the refusal is recorded on the application', results.selfApproveBlocked,
      blocked && blocked.data.projectionError);
    ck('A4  an operator alert is raised', results.selfApproveAlert === 1);
  }

  /* A5 — 'active' is canonStatus-equivalent to approved; the bypass must not
     survive by spelling the status differently. */
  ENV = makeEnv({ accounts: { SELLER_A: {} } });
  await trigger(eventFor('app_2', { ...NORMALISED, status: 'active' }));
  results.activeMinted = minted(ENV.log).length;
  if (!quiet) ck("A5  the synonym status 'active' is refused too", results.activeMinted === 0);

  /* A6 — forging `decidedBy` with a non-admin uid must not help. */
  ENV = makeEnv({ accounts: { SELLER_A: {}, ACCOMPLICE: { seller: true } } });
  await trigger(eventFor('app_3', { ...NORMALISED, status: 'approved', decidedBy: 'ACCOMPLICE' }));
  results.forgedDeciderMinted = minted(ENV.log).length;
  if (!quiet) ck('A6  a forged decidedBy without an admin claim is refused', results.forgedDeciderMinted === 0);

  /* A7 — a decidedBy naming an account that does not exist. */
  ENV = makeEnv({ accounts: { SELLER_A: {} } });
  await trigger(eventFor('app_4', { ...NORMALISED, status: 'approved', decidedBy: 'GHOST' }));
  results.ghostMinted = minted(ENV.log).length;
  if (!quiet) ck('A7  an unresolvable decidedBy is refused, not crashed on', results.ghostMinted === 0);

  return results;
}

/* ═════════════════════════════════════════════════════════════════════════
   PART B — the legitimate decision still works
   ═════════════════════════════════════════════════════════════════════════ */
async function partB(trigger) {
  /* B1 — applicationDecide stamps decidedBy = an admin uid. */
  ENV = makeEnv({ accounts: { SELLER_A: { rider: true }, ADMIN_1: { admin: true } } });
  await trigger(eventFor('app_ok', { ...NORMALISED, status: 'approved', decidedBy: 'ADMIN_1' }));
  const mint = minted(ENV.log)[0];
  ck('B1  an admin decision DOES grant the role', userWrites(ENV.log).length === 1);
  ck('B2  ...and mints the seller claim', !!mint && mint.claims.seller === true, mint && JSON.stringify(mint.claims));
  ck('B3  ...preserving unrelated existing claims', !!mint && mint.claims.rider === true);
  const applied = appWrites(ENV.log).find(w => w.data.projectionStatus === 'applied');
  ck('B4  ...and records the projection as applied', !!applied);

  /* B5 — superAdmin is equally authoritative. */
  ENV = makeEnv({ accounts: { SELLER_A: {}, ROOT: { superAdmin: true } } });
  await trigger(eventFor('app_ok2', { ...NORMALISED, status: 'approved', decidedBy: 'ROOT' }));
  ck('B5  superAdmin is accepted as a decider', minted(ENV.log).length === 1);

  /* B6 — a pending application still grants nothing. */
  ENV = makeEnv({ accounts: { SELLER_A: {} } });
  await trigger(eventFor('app_p', { ...NORMALISED, status: 'pending' }));
  ck('B6  a pending application grants nothing and is not flagged',
    minted(ENV.log).length === 0 && alerts(ENV.log).length === 0);

  /* B7 — an already-applied decision is not re-applied (idempotent). */
  ENV = makeEnv({ accounts: { SELLER_A: {}, ADMIN_1: { admin: true } } });
  await trigger(eventFor('app_done', {
    ...NORMALISED, status: 'approved', decidedBy: 'ADMIN_1',
    decisionAppliedFor: 'approved', projectionStatus: 'applied',
  }));
  ck('B7  repeated approval is idempotent — no second grant', ENV.log.length === 0, ENV.log.length + ' writes');

  /* B8 — a blocked document is not re-written on the next fire, or the
     trigger's own write would re-fire it forever. */
  ENV = makeEnv({ accounts: { SELLER_A: {} } });
  await trigger(eventFor('app_blk', {
    ...NORMALISED, status: 'approved',
    projectionStatus: 'blocked_unauthorised_decision', blockedFor: 'approved',
  }));
  ck('B8  an already-blocked application does not loop', ENV.log.length === 0, ENV.log.length + ' writes');
}

/* ═════════════════════════════════════════════════════════════════════════
   PART C — mutation control
   ═════════════════════════════════════════════════════════════════════════ */
async function partC() {
  const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'application-lifecycle.js'), 'utf8');

  const mutants = [
    {
      label: 'M1  the authority check always passes',
      src: src.replace('const authority = await decisionAuthority(after);',
        'const authority = { ok: true, by: after.decidedBy || null };'),
    },
    {
      label: 'M2  the guard trusts decidedBy without reading its claims',
      src: src.replace(
        /    const user = await getAuth\(\)\.getUser\(by\);[\s\S]*?return \{ ok: false, reason: `decidedBy "\$\{by\}" holds no admin claim` \};/,
        '    return { ok: true, by };'),
    },
  ];

  for (const mu of mutants) {
    if (mu.src === src) { ck(mu.label + ' → mutation applied', false, 'no-op replace — the anchor moved'); continue; }
    let caught = false, detail = '';
    try {
      const trigger = loadLifecycle(mu.src);
      const r = await partA(trigger, { quiet: true });
      /* Under the mutation the forged approval must succeed — that is what
         proves PART A would have failed. M2 is only reached by A6/A7, which
         name a decidedBy. */
      caught = r.selfApproveMinted > 0 || r.forgedDeciderMinted > 0 || r.ghostMinted > 0;
      detail = `selfApprove=${r.selfApproveMinted} forgedDecider=${r.forgedDeciderMinted} ghost=${r.ghostMinted}`;
    } catch (e) {
      detail = 'mutant failed to load: ' + e.message;
    }
    ck(mu.label + ' → the suite catches it', caught, detail);
  }
}

(async () => {
  console.log('\nPART A — a submitted application cannot approve itself\n');
  const trigger = loadLifecycle();
  await partA(trigger);
  console.log('\nPART B — a real admin decision still works\n');
  await partB(trigger);
  console.log('\nPART C — mutation control\n');
  await partC();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
