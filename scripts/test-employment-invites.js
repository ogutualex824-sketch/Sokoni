/* ══════════════════════════════════════════════════════════════════════════════
   EMPLOYMENT INVITATIONS — Gate 3 mechanism #3
   scripts/test-employment-invites.js

   WHAT THIS PINS
   send / accept / revoke, each writing its state change and its history entry
   in ONE transaction, and establishment producing `pending + uid:null` rather
   than the `active + uid:null` record that runPayroll would have paid.

   THE OBSERVABLE IS THE COMMITTED WORLD, NOT THE THROW
   The stub applies a transaction's writes ONLY when the transaction function
   returns, and discards them when it throws. That is what makes the P0
   supersession assertions real: after a failure the previous invitation must
   still be `pending`, not stranded as `superseded`. Checking the documents
   independently would not establish that — the writes have to be shown to land
   together or not at all.

   SCOPE
   Mechanism #3 only. UID uniqueness (#1) is NOT enforced and is asserted as a
   KNOWN PRE-#1 GAP rather than quietly omitted; work status (#5), shop
   assignment (#7), payability (#6) and history reads are absent, and section 8
   asserts none appeared. shopInvites and acceptShopInvite are untouched.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

/* ── A Firestore stub with TRANSACTION SEMANTICS ───────────────────────────
   Writes are buffered and applied on return, discarded on throw. Without that
   the rollback assertions below would be untestable. */
let DOCS = {};
const key = (c, i) => c + '/' + i;
function snapOf (c, i) {
  const d = DOCS[key(c, i)];
  return { exists: d !== undefined, id: i, ref: { id: i, _c: c }, data: () => d };
}
function makeQuery (c, filters) {
  return {
    _c: c, _f: filters,
    where: (f, op, v) => makeQuery(c, filters.concat([[f, op, v]])),
    get: async () => {
      const docs = Object.keys(DOCS)
        .filter(k => k.startsWith(c + '/'))
        .filter(k => filters.every(([f, , v]) => DOCS[k][f] === v))
        .map(k => snapOf(c, k.slice(c.length + 1)));
      return { size: docs.length, empty: docs.length === 0, docs, forEach: fn => docs.forEach(fn) };
    },
  };
}
function collection (c) {
  const q = makeQuery(c, []);
  q.doc = (i) => ({
    id: i, _c: c,
    get: async () => snapOf(c, i),
    set: async (v) => { DOCS[key(c, i)] = v; },
    update: async (v) => { DOCS[key(c, i)] = Object.assign({}, DOCS[key(c, i)], v); },
  });
  return q;
}
let TXN_DEPTH = 0;
const fakeDb = {
  collection,
  runTransaction: async (fn) => {
    TXN_DEPTH++;
    const buffered = [];
    const t = {
      get: async (refOrQuery) => (refOrQuery && refOrQuery._f !== undefined)
        ? refOrQuery.get()
        : snapOf(refOrQuery._c, refOrQuery.id),
      set: (ref, v) => buffered.push(['set', ref._c, ref.id, v]),
      update: (ref, v) => buffered.push(['update', ref._c, ref.id, v]),
      /* create() FAILS IF THE DOCUMENT EXISTS — that is the whole point of the
         occupancy claim, and the stub must reproduce it or the uniqueness
         assertions below would pass against a set(). The throw is raised at
         call time, aborting the transaction function before it returns, so the
         buffer is discarded exactly as a real abort would discard it.

         NOTE: this stub SERIALISES transactions, so it proves the claim is
         ENFORCED, never that it serialises real contention. That is the
         emulator suite's job (test-employment-uid-claim-race.js). */
      create: (ref, v) => {
        if (DOCS[key(ref._c, ref.id)] !== undefined) {
          const e = new Error('ALREADY_EXISTS: entity already exists');
          e.code = 6;
          throw e;
        }
        buffered.push(['set', ref._c, ref.id, v]);
      },
    };
    try {
      const out = await fn(t);
      /* COMMIT — only now do the writes become visible. */
      buffered.forEach(([op, c, i, v]) => {
        DOCS[key(c, i)] = op === 'set' ? v : Object.assign({}, DOCS[key(c, i)], v);
      });
      return out;
    } finally { TXN_DEPTH--; }
    /* On throw the buffer is simply discarded — nothing is applied. */
  },
};
class HttpsError extends Error {
  constructor (code, message) { super(message); this.code = code; }
}
const STUBS = {
  'firebase-admin': (() => {
    const f = () => fakeDb;
    f.FieldValue = { serverTimestamp: () => '__TS__' };
    f.Timestamp = { fromDate: (d) => ({ toDate: () => d, _d: d }) };
    return { firestore: f, apps: [{}], initializeApp () {} };
  })(),
  'firebase-functions/v2/https': { onCall: (o, fn) => (typeof o === 'function' ? o : fn), HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '0'.repeat(64) }) },
};
const realLoad = Module._load;
Module._load = function (r, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, r)) return STUBS[r];
  return realLoad.call(this, r, parent, isMain);
};
let INV = null, HR = null, loadError = null;
try {
  ['functions/employment-invites.js', 'functions/employment-events.js',
   'functions/merchant-authority.js', 'functions/hr-payroll.js']
    .forEach(p => { delete require.cache[require.resolve(path.join(ROOT, p))]; });
  INV = require(path.join(ROOT, 'functions/employment-invites.js'));
  HR = require(path.join(ROOT, 'functions/hr-payroll.js'));
} catch (e) { loadError = e && e.message ? e.message.slice(0, 200) : 'load failed'; }
Module._load = realLoad;

const SRC = fs.readFileSync(path.join(ROOT, 'functions/employment-invites.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HRSRC = fs.readFileSync(path.join(ROOT, 'functions/hr-payroll.js'), 'utf8');

/* ── Identities ─────────────────────────────────────────────────────────── */
const BIZ = 'SOK-MINE', STAFF = 'SOK-MINE_E001';
const OWNER = 'U_OWNER', MEMBER = 'U_MEMBER', STRANGER = 'U_STRANGER';
const EMP = 'U_EMP', EMAIL = 'jane@example.com';

const asOwner = { uid: OWNER, token: { email: 'owner@example.com' } };
const asMember = { uid: MEMBER, token: { email: 'member@example.com' } };
const asPlatform = { uid: 'U_PLATFORM', token: { admin: true, email: 'admin@sokoni' } };
const asInvitee = { uid: EMP, token: { email: EMAIL } };
const asWrongEmail = { uid: 'U_OTHER', token: { email: 'someone.else@example.com' } };

function seed (staffOverrides) {
  DOCS = {};
  DOCS['businesses/' + BIZ] = { ownerId: OWNER, adminUids: [MEMBER] };
  DOCS['hrStaff/' + STAFF] = Object.assign({
    merchantId: BIZ, employeeNumber: 'E001', name: 'Jane', email: EMAIL,
    employmentStatus: 'pending', workStatus: null, uid: null,
  }, staffOverrides || {});
}
const staff = () => DOCS['hrStaff/' + STAFF];
const invites = () => Object.keys(DOCS).filter(k => k.startsWith('employmentInvites/'))
  .map(k => Object.assign({ _id: k.slice(18) }, DOCS[k]));
const events = () => Object.keys(DOCS).filter(k => k.startsWith('employmentEvents/'))
  .map(k => Object.assign({ _id: k.slice(17) }, DOCS[k]));

async function call (fn, auth, data) {
  try { return { out: await fn({ auth, data }), code: null }; }
  catch (e) { return { out: null, code: e.code || 'throw', msg: e.message }; }
}

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  EMPLOYMENT INVITATIONS — mechanism #3');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - controls');
  ok('the modules loaded', loadError === null && !!INV && !!HR, loadError || '');
  ok('all three operations are exposed', !!INV &&
     ['sendEmploymentInvite', 'acceptEmploymentInvite', 'revokeEmploymentInvite']
       .every(n => typeof INV._h[n] === 'function'));
  {
    /* POSITIVE CONTROL for the transaction stub: a throwing transaction must
       apply NOTHING, or every rollback assertion below is unattributable. */
    DOCS = {};
    let threw = false;
    try {
      await fakeDb.runTransaction(async (t) => {
        t.set({ _c: 'probe', id: 'x' }, { v: 1 });
        throw new Error('boom');
      });
    } catch (_) { threw = true; }
    ok('CONTROL — a throwing transaction commits NOTHING',
       threw && DOCS['probe/x'] === undefined, JSON.stringify(DOCS));
    await fakeDb.runTransaction(async (t) => { t.set({ _c: 'probe', id: 'y' }, { v: 2 }); });
    ok('CONTROL — a returning transaction DOES commit', !!DOCS['probe/y']);
  }

  /* ── 1. ESTABLISHMENT ──────────────────────────────────────────────────── */
  head('1 - establishment produces pending, never active');
  {
    DOCS = {}; DOCS['businesses/' + BIZ] = { ownerId: OWNER, adminUids: [MEMBER] };
    const r = await call(HR._h.addStaffMember, Object.assign({}, asOwner, { token: { admin: false, email: 'owner@example.com' } }), {
      merchantId: BIZ, name: 'Jane', employeeNumber: 'E001', department: 'Ops',
      position: 'Clerk', grossSalary: 50000, startDate: '2026-01-01',
      email: EMAIL, reason: 'replacing Mary',
    });
    ok('addStaffMember succeeds for the owner', r.code === null, r.code + ': ' + (r.msg || ''));
    const s = staff();
    ok('employmentStatus is pending', !!s && s.employmentStatus === 'pending', s && s.employmentStatus);
    ok('workStatus is null', !!s && s.workStatus === null);
    ok('uid is null — nothing is bound yet', !!s && s.uid === null);
    ok('the OLD `status: active` field is gone', !!s && s.status === undefined, s && s.status);
    const ev = events();
    ok('exactly one employment_established event', ev.length === 1 && ev[0].event === 'employment_established',
       ev.map(e => e.event).join(','));
    ok('  …recorded in the SAME transaction as the record', ev.length === 1 && !!s);
    ok('  …with changedVia owner, from the resolver', ev[0] && ev[0].changedVia === 'owner', ev[0] && ev[0].changedVia);
    ok('  …and the supplied reason', ev[0] && ev[0].reason === 'replacing Mary', ev[0] && ev[0].reason);
  }

  head('1b - establishment authority and reason');
  {
    const base = { merchantId: BIZ, name: 'J', employeeNumber: 'E9', department: 'Ops',
                   position: 'C', grossSalary: 1, startDate: '2026-01-01', reason: 'r' };
    DOCS = {}; DOCS['businesses/' + BIZ] = { ownerId: OWNER, adminUids: [MEMBER] };
    const mem = await call(HR._h.addStaffMember, { uid: MEMBER, token: { manager: true } }, base);
    ok('DENIES an adminUids member — access is not employment authority',
       mem.code === 'permission-denied', mem.code);
    DOCS = {}; DOCS['businesses/' + BIZ] = { ownerId: OWNER, adminUids: [MEMBER] };
    const plat = await call(HR._h.addStaffMember, { uid: 'U_P', token: { admin: true } }, base);
    ok('ALLOWS a platform admin — ratified 2a', plat.code === null, plat.code);
    DOCS = {}; DOCS['businesses/' + BIZ] = { ownerId: OWNER, adminUids: [MEMBER] };
    const noReason = await call(HR._h.addStaffMember, { uid: OWNER, token: { manager: true } },
      Object.assign({}, base, { reason: '  ' }));
    ok('DENIES a blank reason', noReason.code === 'invalid-argument', noReason.code);

    /* NO ORPHAN EVENT. The event is built before the transaction but WRITTEN
       inside it, so a transaction that aborts must leave no history entry.
       Writing it before the transaction instead would strand an
       employment_established event for an employment that was never created. */
    DOCS = {}; DOCS['businesses/' + BIZ] = { ownerId: OWNER, adminUids: [MEMBER] };
    const ok1 = await call(HR._h.addStaffMember, { uid: OWNER, token: {} }, base);
    const dup = await call(HR._h.addStaffMember, { uid: OWNER, token: {} }, base);
    ok('a duplicate employee number is refused', dup.code === 'already-exists', dup.code);
    ok('  …and the failed attempt wrote NO second event',
       ok1.code === null && events().length === 1,
       events().length + ' event(s) after one success and one failure');

    /* THE ORPHAN CASE, and it needs a DIFFERENT employment to be visible. The
       event key is deterministic, so a retry of the SAME employment overwrites
       its own event and an orphan cannot be counted. Seeding an employment
       directly — with no event — and then failing establishment for it means an
       orphan would be the ONLY event for that staffId. Measured: without this,
       writing the event before the transaction scored GREEN. */
    DOCS = {}; DOCS['businesses/' + BIZ] = { ownerId: OWNER, adminUids: [MEMBER] };
    DOCS['hrStaff/' + BIZ + '_E7'] = { merchantId: BIZ, employeeNumber: 'E7', employmentStatus: 'pending' };
    const clash = await call(HR._h.addStaffMember, { uid: OWNER, token: {} },
      Object.assign({}, base, { employeeNumber: 'E7' }));
    ok('establishing over an existing employment is refused',
       clash.code === 'already-exists', clash.code);
    ok('  …leaving NO ORPHAN event for an employment it did not create',
       events().filter(e => e.staffId === BIZ + '_E7').length === 0,
       events().map(e => e.staffId + ':' + e.event).join(',') || 'no events');
  }

  /* ── 2. SEND ───────────────────────────────────────────────────────────── */
  head('2 - send');
  {
    seed();
    const r = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'onboarding' });
    ok('the owner may send', r.code === null, r.code + ': ' + (r.msg || ''));
    const inv = invites();
    ok('exactly one invitation exists', inv.length === 1, String(inv.length));
    ok('it is pending, token-keyed, and carries the employment', !!inv[0] &&
       inv[0].status === 'pending' && inv[0]._id === inv[0].token && inv[0].staffId === STAFF);
    ok('the email came from the EMPLOYMENT RECORD, not the request', inv[0] && inv[0].email === EMAIL);
    ok('NO payroll data is copied onto the invitation',
       !!inv[0] && ['grossSalary', 'bankAccount', 'kraPin', 'salary'].every(k => inv[0][k] === undefined),
       Object.keys(inv[0] || {}).join(','));
    ok('the employment is still pending', staff().employmentStatus === 'pending');
    const ev = events().filter(e => e.event === 'invite_sent');
    ok('one invite_sent event, keyed by the token', ev.length === 1 &&
       ev[0]._id === STAFF + '_invite_sent_' + inv[0].token, ev[0] && ev[0]._id);

    seed({ employmentStatus: 'terminated', workStatus: null });
    const term = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'x' });
    ok('DENIES sending for a terminated employment', term.code === 'failed-precondition', term.code);

    seed({ email: null });
    const noEmail = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'x' });
    ok('DENIES sending when the record has no email', noEmail.code === 'failed-precondition', noEmail.code);

    seed();
    const mem = await call(INV._h.sendEmploymentInvite, asMember, { staffId: STAFF, reason: 'x' });
    ok('DENIES an adminUids member', mem.code === 'permission-denied', mem.code);
    seed();
    const plat = await call(INV._h.sendEmploymentInvite, asPlatform, { staffId: STAFF, reason: 'x' });
    ok('ALLOWS a platform admin', plat.code === null, plat.code);
    seed();
    const noReason = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: '' });
    ok('DENIES a blank reason', noReason.code === 'invalid-argument', noReason.code);
  }

  /* ── 3. SUPERSESSION — the P0 atomicity assertions ─────────────────────── */
  head('3 - resend supersedes atomically  [P0]');
  {
    seed();
    const first = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'first' });
    const second = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'resend' });
    /* FAIL CLOSED. Dereferencing a null `out` throws a TypeError that kills the
       run before its summary and prints NO FAIL line — which a sabotage runner
       counting FAIL lines reads as a PASS. Measured: a mutation moving the
       supersession outside the transaction scored GREEN exactly this way. */
    ok('both sends returned a result', !!first.out && !!second.out,
       'first=' + first.code + ' second=' + second.code);
    const tokenA = first.out ? first.out.token : null;
    const tokenB = second.out ? second.out.token : null;

    ok('SUCCESS — a second token is issued', second.code === null && !!tokenB && tokenB !== tokenA);
    const byId = Object.fromEntries(invites().map(i => [i._id, i]));
    ok('SUCCESS — the old invitation is superseded', byId[tokenA] && byId[tokenA].status === 'superseded',
       byId[tokenA] && byId[tokenA].status);
    ok('SUCCESS — the new invitation is pending', byId[tokenB] && byId[tokenB].status === 'pending');
    ok('SUCCESS — EXACTLY ONE invitation is acceptable',
       invites().filter(i => i.status === 'pending').length === 1);
    ok('SUCCESS — the employment is UNCHANGED, still pending',
       staff().employmentStatus === 'pending' && staff().uid === null);
    const sent = events().filter(e => e.event === 'invite_sent');
    ok('SUCCESS — exactly TWO invite_sent events, one per issuance', sent.length === 2,
       String(sent.length));
    ok('SUCCESS — and exactly ONE new event was added by the resend',
       sent.filter(e => e._id.endsWith(tokenB)).length === 1);
    ok('SUCCESS — the supersession is recorded on the INVITATION, not as an event',
       byId[tokenA].supersededByToken === tokenB &&
       !events().some(e => /supersed/i.test(String(e.event))),
       'no invite_superseded event, by design');

    /* THE OLD TOKEN MUST BE DEAD. */
    const stale = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: tokenA, reason: 'x' });
    ok('SUCCESS — the superseded token can no longer be accepted',
       stale.code === 'failed-precondition', stale.code);
  }

  head('3b - supersession ROLLBACK  [P0]');
  {
    /* Make the NEW event fail while the supersession write is already buffered.
       A non-transactional implementation would leave the old invitation
       stranded as `superseded` with nothing acceptable in its place. */
    seed();
    const first = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'first' });
    const tokenA = first.out.token;
    const before = JSON.stringify(DOCS);

    /* The employment flips to terminated between the pre-read and the
       transaction — the in-transaction guard must abort the whole thing. */
    const origRunTxn = fakeDb.runTransaction;
    fakeDb.runTransaction = async (fn) => {
      DOCS['hrStaff/' + STAFF].employmentStatus = 'terminated';
      const r = await origRunTxn(fn);
      return r;
    };
    const failed = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'resend' });
    fakeDb.runTransaction = origRunTxn;
    DOCS['hrStaff/' + STAFF].employmentStatus = 'pending';   /* undo the fixture poke */

    ok('FAILURE — the resend is refused', failed.code === 'failed-precondition', failed.code);
    const byId = Object.fromEntries(invites().map(i => [i._id, i]));
    ok('FAILURE — the OLD invitation is still pending, not stranded as superseded',
       byId[tokenA] && byId[tokenA].status === 'pending', byId[tokenA] && byId[tokenA].status);
    ok('FAILURE — no second invitation was created',
       invites().length === 1, String(invites().length));
    ok('FAILURE — no second invite_sent event exists',
       events().filter(e => e.event === 'invite_sent').length === 1);
    ok('FAILURE — the world is byte-identical to before the attempt',
       JSON.stringify(DOCS) === before, 'compared whole store');
  }

  /* ── 4. ACCEPT ─────────────────────────────────────────────────────────── */
  head('4 - accept');
  {
    seed();
    const s = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'onboard' });
    const token = s.out.token;

    const wrong = await call(INV._h.acceptEmploymentInvite, asWrongEmail, { token, reason: 'me' });
    ok('DENIES a different email — the identity anchor', wrong.code === 'permission-denied', wrong.code);
    ok('  …and nothing was bound', staff().uid === null && staff().employmentStatus === 'pending');

    const good = await call(INV._h.acceptEmploymentInvite, asInvitee, { token, reason: 'accepting' });
    ok('ALLOWS the invitee', good.code === null, good.code + ': ' + (good.msg || ''));
    ok('the uid is bound', staff().uid === EMP, staff().uid);
    ok('employmentStatus becomes active', staff().employmentStatus === 'active');
    ok('workStatus becomes working', staff().workStatus === 'working');
    ok('the invitation is accepted', invites()[0].status === 'accepted' && invites()[0].acceptedByUid === EMP);
    const ev = events().filter(e => e.event === 'invite_accepted');
    ok('one invite_accepted event', ev.length === 1);
    ok('  …actor is the INVITEE, not the owner',
       ev[0] && ev[0].changedBy === EMP && ev[0].changedVia === 'invitee',
       ev[0] && ev[0].changedBy + '/' + ev[0].changedVia);
    ok('  …newUid records the binding', ev[0] && ev[0].newUid === EMP);

    const replay = await call(INV._h.acceptEmploymentInvite, asInvitee, { token, reason: 'again' });
    ok('REPLAY is refused', replay.code === 'failed-precondition', replay.code);
    ok('  …and the binding is unchanged', staff().uid === EMP);
  }

  head('4b - accept fails closed');
  {
    seed();
    const s = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'x' });
    DOCS['hrStaff/' + STAFF].employmentStatus = 'terminated';
    const r = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: s.out.token, reason: 'x' });
    ok('THE RESURRECTION GUARD — a terminated employment cannot be accepted into',
       r.code === 'failed-precondition', r.code);
    ok('  …the employment stays terminated', staff().employmentStatus === 'terminated');
    ok('  …and no uid was bound', staff().uid === null);

    seed();
    const s2 = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'x' });
    DOCS['employmentInvites/' + s2.out.token].expiresAt =
      { toDate: () => new Date(Date.now() - 1000) };
    const exp = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: s2.out.token, reason: 'x' });
    ok('an EXPIRED invitation is refused', exp.code === 'deadline-exceeded', exp.code);

    seed();
    const s3 = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'x' });
    delete DOCS['employmentInvites/' + s3.out.token].expiresAt;
    const noExp = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: s3.out.token, reason: 'x' });
    ok('a MISSING expiry REFUSES rather than throwing TypeError',
       noExp.code === 'failed-precondition', noExp.code);

    seed();
    const s4 = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'x' });
    const noEmail = await call(INV._h.acceptEmploymentInvite,
      { uid: 'U_NOEMAIL', token: {} }, { token: s4.out.token, reason: 'x' });
    ok('an account with no email cannot accept', noEmail.code === 'failed-precondition', noEmail.code);
  }

  /* ── 5. REVOKE ─────────────────────────────────────────────────────────── */
  head('5 - revoke');
  {
    seed();
    const s = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'x' });
    const token = s.out.token;

    const mem = await call(INV._h.revokeEmploymentInvite, asMember, { token, reason: 'x' });
    ok('DENIES an adminUids member', mem.code === 'permission-denied', mem.code);
    const inv = await call(INV._h.revokeEmploymentInvite, asInvitee, { token, reason: 'x' });
    ok('DENIES the invitee — revocation is owner authority', inv.code === 'permission-denied', inv.code);

    const r = await call(INV._h.revokeEmploymentInvite, asOwner, { token, reason: 'changed our mind' });
    ok('ALLOWS the owner', r.code === null, r.code + ': ' + (r.msg || ''));
    ok('the invitation is revoked', invites()[0].status === 'revoked');
    ok('the employment is TERMINATED — ratified pending → terminated',
       staff().employmentStatus === 'terminated' && staff().workStatus === null,
       staff().employmentStatus + '/' + staff().workStatus);
    const ev = events().filter(e => e.event === 'invite_revoked');
    ok('one invite_revoked event, changedVia owner', ev.length === 1 && ev[0].changedVia === 'owner');

    const after = await call(INV._h.acceptEmploymentInvite, asInvitee, { token, reason: 'x' });
    ok('a REVOKED invitation can never be accepted', after.code === 'failed-precondition', after.code);
  }

  /* ── 6. THE KNOWN PRE-#1 GAP, asserted rather than omitted ─────────────── */
  /* WAS "KNOWN PRE-#1 GAP: uid uniqueness is NOT enforced". Mechanism #1 closed
     it, so the assertion that DOCUMENTED the gap becomes the assertion that
     PROVES the invariant — the same fixtures, the opposite expectation. */
  head('6 - uid occupancy uniqueness IS enforced');
  {
    seed();
    const s1 = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF, reason: 'x' });
    await call(INV._h.acceptEmploymentInvite, asInvitee, { token: s1.out.token, reason: 'x' });

    /* A SECOND employment in the SAME business, invited to the SAME email. */
    const STAFF2 = BIZ + '_E002';
    DOCS['hrStaff/' + STAFF2] = {
      merchantId: BIZ, employeeNumber: 'E002', name: 'Jane again', email: EMAIL,
      employmentStatus: 'pending', workStatus: null, uid: null,
    };
    const s2 = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF2, reason: 'x' });
    const a2 = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: s2.out.token, reason: 'x' });

    ok('a SECOND active employment for the same uid in one business is REFUSED',
       a2.code === 'failed-precondition', a2.code);
    ok('  …the second employment is untouched — still pending, still unbound',
       DOCS['hrStaff/' + STAFF2].uid === null
       && DOCS['hrStaff/' + STAFF2].employmentStatus === 'pending'
       && DOCS['hrStaff/' + STAFF2].workStatus === null);
    ok('  …its invitation is still pending, not accepted',
       DOCS['employmentInvites/' + s2.out.token].status === 'pending');
    ok('  …and NO invite_accepted event was written for it',
       events().filter(e => e.staffId === STAFF2 && e.event === 'invite_accepted').length === 0);
    ok('  …while the FIRST employment keeps its binding', staff().uid === EMP
       && staff().employmentStatus === 'active');

    /* THE CLAIM ITSELF. */
    const claims = Object.keys(DOCS).filter(k => k.startsWith('employmentUidClaims/'));
    ok('exactly ONE occupancy claim exists', claims.length === 1, claims.join(','));
    ok('  …keyed {businessId}_{uid}',
       claims[0] === 'employmentUidClaims/' + BIZ + '_' + EMP, claims[0]);
    const claim = DOCS[claims[0]];
    ok('  …its provenance names the WINNING staffId', claim.staffId === STAFF,
       claim.staffId + ' vs winner ' + STAFF);
    ok('  …provenance fields only — businessId, uid, staffId, createdAt',
       Object.keys(claim).sort().join(',') === 'businessId,createdAt,staffId,uid',
       Object.keys(claim).sort().join(','));
    ok('  …NO status or lifecycle field on the claim',
       claim.status === undefined && claim.employmentStatus === undefined
       && claim.workStatus === undefined && claim.released === undefined);

    /* ACROSS BUSINESSES the same uid is unaffected — the invariant is scoped
       per organization, and a global lock would be a different, wrong rule. */
    const BIZ2 = 'SOK-OTHER', STAFF3 = BIZ2 + '_E001';
    DOCS['businesses/' + BIZ2] = { ownerId: OWNER, adminUids: [] };
    DOCS['hrStaff/' + STAFF3] = {
      merchantId: BIZ2, employeeNumber: 'E001', name: 'Jane elsewhere', email: EMAIL,
      employmentStatus: 'pending', workStatus: null, uid: null,
    };
    const s3 = await call(INV._h.sendEmploymentInvite, asOwner, { staffId: STAFF3, reason: 'x' });
    const a3 = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: s3.out.token, reason: 'x' });
    ok('the SAME uid may be active in a DIFFERENT business', a3.code === null, a3.code);
    ok('  …and that business gets its own claim',
       DOCS['employmentUidClaims/' + BIZ2 + '_' + EMP] !== undefined);
  }

  /* ── 7. SHOP INVITATIONS ARE UNTOUCHED ─────────────────────────────────── */
  head('7 - the shop invitation system is not reused and not modified');
  {
    ok('this module references no shop collection',
       !/shopInvites|shopEmployees|acceptShopInvite|inviteShopEmployee/.test(CODE));
    ok('it writes no users document — no platform re-roling',
       !/collection\('users'\)|employeeRole|employeeShopId/.test(CODE));
    /* ── THE SCOPE ANCHOR, RE-ANCHORED 2026-09-20 ───────────────────────────
       This asserted `git status --porcelain` on the LIVE WORKING TREE. That
       answered the wrong question. The invariant is historical —

           did the MECHANISM #3 LANDING touch the shop-invitation system?

       — but a live-tree check answers

           is the shop-invitation system dirty RIGHT NOW?

       which any later authorized work makes false. It did: the shop/POS till
       authority repair (1ce3fcd) legitimately modified shop-employees.js, and
       this suite went 95/1 on a file mechanism #3 never touched. The finding
       was real about the ANCHOR and said nothing about mechanism #3.

       The assertion is NOT weakened — it is pointed at the frozen boundary. It
       still fails if the landing had touched either file. */
    const git = (...a) => require('child_process')
      .execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();

    /* THE ANCHOR IS SELF-VERIFYING. A bare SHA would silently check the wrong
       commit if history were ever rewritten, and an empty diff would then read
       as a pass. The landing is identified by WHAT IT DID — it is the commit
       that ADDED functions/employment-invites.js — so a moved ref fails closed
       instead of quietly proving nothing. */
    const M3 = '33c0f59';
    let anchorOk = false, added = '';
    try {
      added = git('show', '--name-status', '--format=', M3, '--', 'functions/employment-invites.js');
      anchorOk = /^A\s+functions\/employment-invites\.js$/m.test(added);
    } catch (e) { added = 'ref unresolved: ' + (e && e.message || '').slice(0, 60); }
    ok('the mechanism #3 landing resolves, and is the commit that ADDED this module',
       anchorOk, added || 'no output');

    if (!anchorOk) {
      ok('SCOPE ANCHOR UNVERIFIABLE — refusing to report a scope verdict', false,
         'the boundary could not be established, so "untouched" would be unproven');
    } else {
      const touched = git('diff', '--name-only', M3 + '~1', M3,
                          '--', 'functions/index.js', 'functions/shop-employees.js');
      ok('functions/index.js and shop-employees.js are untouched BY THE #3 LANDING',
         touched === '', touched || 'neither file is in the landing');

      /* POSITIVE CONTROL. An empty diff is equally consistent with a working
         comparison and with one that can never match anything. This names a
         file the landing certainly DID change, and must come back non-empty. */
      const control = git('diff', '--name-only', M3 + '~1', M3, '--', 'functions/hr-payroll.js');
      ok('CONTROL: the same comparison DOES report a file the landing changed',
         control === 'functions/hr-payroll.js', control || 'EMPTY — the detector is blind');
    }
  }

  /* ── 8. STRICT SCOPE ───────────────────────────────────────────────────── */
  head('8 - no later mechanism leaked in');
  {
    ok('no work-status transition appears (#5)',
       !/on_leave|suspended|leave_granted|employment_suspended/.test(CODE));
    ok('no shop assignment appears (#7)', !/shopId|branchId|assignShop/.test(CODE));
    ok('no payability change appears (#6)', !/runPayroll|payslip|grossSalary/.test(CODE));
    ok('no history-read callable appears', !/getEmploymentHistory|listEmploymentEvents/.test(CODE));
    /* hrTraining has its OWN `status` field. A blanket rename of
       `.where('status','==','active')` hit this line too and would have made
       every training invisible — measured during implementation. The window is
       generous because a comment now sits between the two lines. */
    ok('hrTraining.status was NOT renamed with the employment axis',
       /\.collection\('hrTraining'\)[\s\S]{0,600}?\.where\('status', '==', 'active'\)/.test(HRSRC));
    ok('  …and no hrTraining query uses employmentStatus',
       !/\.collection\('hrTraining'\)[\s\S]{0,600}?\.where\('employmentStatus'/.test(HRSRC));
    ok('hr-payroll still selects payroll on employmentStatus',
       /\.where\('employmentStatus', '==', 'active'\)/.test(HRSRC));
    ok('runPayroll still does NOT consult uid — that is #6',
       !/where\('uid'/.test(HRSRC));
    const MUST = ['sendEmploymentInvite', 'acceptEmploymentInvite', 'revokeEmploymentInvite', "'invitee'"];
    ok('CONTROL — stripping left every load-bearing statement intact',
       MUST.every(m => CODE.includes(m)), MUST.filter(m => !CODE.includes(m)).join(',') || 'all present');
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live call. firebase-admin is stubbed at the require boundary.');
  console.log('  UNPROVEN  real Firestore contention. The stub serialises transactions, so');
  console.log('            two SIMULTANEOUS accepts are not reproduced — only that the');
  console.log('            implementation performs its reads and writes in one.');
  console.log('  SEPARATE  the employmentInvites rules are certified against the real rules');
  console.log('            ENGINE in scripts/test-employment-invites-rules.js.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
