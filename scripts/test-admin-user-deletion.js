/* ══════════════════════════════════════════════════════════════════════════════
   ADMIN USER DELETION — certification
   scripts/test-admin-user-deletion.js    node scripts/test-admin-user-deletion.js

   WHAT THIS CERTIFIES
   An administrator can schedule the deletion of a user account from either console.
   It SCHEDULES; it does not delete. The irreversible work stays with the pipeline that
   already exists in account-manager.js:

       status:'pending_deletion' + deletionScheduledAt
           -> finaliseExpiredDeletions (scheduled 23:00 UTC)
           -> redact -> anonymise -> retain statutory -> purge Storage
           -> auth.deleteUser(uid)          <- irreversible step, LAST

   TWO THINGS THE UI MUST NEVER DO, both of which firestore.rules would PERMIT:

     1. delete users/{uid} directly. The rules allow it (`allow delete: if isAdmin()`),
        but the Firebase Auth account survives, the person can still sign in, and the
        client re-creates a baseline document. It destroys the record and leaves the
        account live.

     2. write status/deletionScheduledAt from the client. The rules allow it
        (`allow update: if isAdmin()`), and writing that document IS the deletion order —
        the same shape as refundRequests, where creating the document IS the refund. An
        arbitrary date would also bypass the grace period entirely.

   So the handler computes the date server-side and both consoles call the SAME op.

   The handler is EXECUTED against stub Firestore/Auth objects: what is proven is the
   write it actually performs and the cases it actually refuses.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const adminOs = read('functions/admin-os.js');
const accountMgr = read('functions/account-manager.js');
const rules = read('firestore.rules');
const aos = read('sokoni-aos.js');
const sa = read('super-admin.html');
const mod = read('sokoni-aos-users.js');

/* ── HANDLER HARNESS ─────────────────────────────────────────────────────────
   Loads admin-os.js with a stubbed firebase-admin, then drives the registered
   handler through require.cache interception. */
function loadHandler () {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const state = { writes: [], audits: [], authUser: null, profile: null };

  const stubFirestore = () => ({
    collection: (c) => ({
      doc: (id) => ({
        get: async () => ({
          exists: state.profile !== null,
          data: () => state.profile || {},
        }),
        set: async (data, opts) => { state.writes.push({ collection: c, id, data, opts }); },
      }),
      add: async (data) => { state.audits.push({ collection: c, data }); },
    }),
  });
  const FieldValue = { serverTimestamp: () => '<serverTimestamp>' };
  const stubAuth = () => ({
    getUser: async (uid) => {
      if (state.authUser === 'missing') { const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; }
      return state.authUser || { uid, customClaims: {} };
    },
  });
  class HttpsError extends Error {
    constructor (code, message) { super(message); this.code = code; }
  }

  const fake = {
    'firebase-functions/v2/https': { onCall: (_o, fn) => fn, HttpsError },
    'firebase-functions/v2/scheduler': { onSchedule: (_o, fn) => fn },
    'firebase-admin/firestore': { getFirestore: stubFirestore, FieldValue, Timestamp: { now: () => 0 } },
    'firebase-admin/auth': { getAuth: stubAuth },
  };
  Module._resolveFilename = function (req, ...rest) {
    if (fake[req]) return req;
    return origResolve.call(this, req, ...rest);
  };
  Object.keys(fake).forEach(k => { require.cache[k] = { id: k, exports: fake[k], loaded: true }; });

  delete require.cache[require.resolve(path.join(ROOT, 'functions', 'admin-os.js'))];
  let mod;
  try { mod = require(path.join(ROOT, 'functions', 'admin-os.js')); }
  finally { Module._resolveFilename = origResolve; }
  return { handler: mod._h.adminScheduleUserDeletion, state, HttpsError };
}

const H = loadHandler();

async function call (over) {
  const o = Object.assign({
    actorUid: 'admin-1', targetUid: 'user-9', reason: 'Fraudulent account',
    authUser: { uid: 'user-9', customClaims: {} }, profile: { role: 'buyer' },
  }, over || {});
  H.state.writes = []; H.state.audits = [];
  H.state.authUser = o.authUser;
  H.state.profile = o.profile;
  const req = { auth: { uid: o.actorUid, token: o.token || { admin: true } },
                data: { targetUid: o.targetUid, reason: o.reason } };
  try { return { ok: true, result: await H.handler(req) }; }
  catch (e) { return { ok: false, error: e }; }
}

(async function () {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  ADMIN USER DELETION');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - the handler exists and is reachable');
  {
    ok('control — the handler was loaded', typeof H.handler === 'function');
    ok('it is registered in the _h dispatch registry',
       /exports\._h\.adminScheduleUserDeletion/.test(adminOs));
    ok('the client whitelists the op', /'adminScheduleUserDeletion'/.test(aos));
  }

  /* ── 1. THE HAPPY PATH ────────────────────────────────────────────────────── */
  head('1 - scheduling writes the fields the existing pipeline consumes');
  {
    const r = await call();
    ok('it succeeds for an ordinary account', r.ok, r.ok ? '' : String(r.error && r.error.message));
    const w = H.state.writes[0] || {};
    ok('exactly one user document is written', H.state.writes.length === 1);
    ok('it writes to users', w.collection === 'users' && w.id === 'user-9');
    ok('it MERGES rather than replacing the profile', w.opts && w.opts.merge === true);
    ok('status becomes pending_deletion', w.data && w.data.status === 'pending_deletion');
    ok('a deletion date is set', w.data && w.data.deletionScheduledAt instanceof Date);
    ok('the reason is recorded', w.data && /Fraudulent/.test(w.data.deletionReason));
    ok('the requesting admin is recorded', w.data && w.data.deletionRequestedBy === 'admin-1');

    /* THE SAME FIELDS the self-service path writes — one pipeline, not two. */
    ok('control — self-service writes the same two fields',
       /deletionScheduledAt:/.test(accountMgr) && /status:\s*'pending_deletion'/.test(accountMgr));
    ok('control — the worker consumes exactly those',
       /where\('status', '==', 'pending_deletion'\)/.test(accountMgr) &&
       /where\('deletionScheduledAt', '<=', now\)/.test(accountMgr));
  }

  /* ── 2. THE GRACE PERIOD IS SERVER-SIDE ───────────────────────────────────── */
  head('2 - the date is computed by the server, not accepted from the caller');
  {
    const r = await call();
    const when = H.state.writes[0].data.deletionScheduledAt;
    const days = Math.round((when - Date.now()) / 86400000);
    ok('the grace period is 30 days', days === 30, days + ' days');
    ok('and the response states it', r.result && r.result.graceDays === 30);

    /* A caller-supplied date must not be honoured — that is how the grace period
       would be bypassed. Asserted on STRIPPED source so the comment explaining the
       hazard cannot satisfy it. */
    const src = strip(adminOs);
    const fn = src.slice(src.indexOf('adminScheduleUserDeletion = async'),
                         src.indexOf('exports.adminGetAuditLogs'));
    ok('control — the handler body was isolated', fn.length > 200);
    ok('the handler reads no date from req.data', !/data\).*deletionScheduledAt|scheduledAt\s*=\s*req/.test(fn));
    ok('it destructures only targetUid and reason',
       /const \{ targetUid, reason \} = req\.data/.test(fn));
  }

  /* ── 3. WHO MAY BE DELETED ────────────────────────────────────────────────── */
  head('3 - the refusals');
  {
    const noAuth = await (async () => {
      H.state.authUser = { uid: 'x', customClaims: {} }; H.state.profile = {};
      try { await H.handler({ auth: { uid: 'a', token: {} }, data: { targetUid: 'b', reason: 'x' } }); return null; }
      catch (e) { return e; }
    })();
    ok('a non-admin caller is refused', !!noAuth && /admin required/.test(noAuth.message));

    const self = await call({ targetUid: 'admin-1' });
    ok('an admin cannot delete their own account', !self.ok &&
       /your own account/i.test(self.error.message));

    const otherAdminClaim = await call({ authUser: { uid: 'user-9', customClaims: { admin: true } } });
    ok('an account with an admin CLAIM is refused', !otherAdminClaim.ok &&
       /administrator/i.test(otherAdminClaim.error.message));

    const otherAdminRole = await call({ profile: { role: 'admin' } });
    ok('an account with an admin ROLE is refused', !otherAdminRole.ok &&
       /administrator/i.test(otherAdminRole.error.message));

    const superClaim = await call({ authUser: { uid: 'user-9', customClaims: { superAdmin: true } } });
    ok('a superAdmin claim is refused', !superClaim.ok);

    const missing = await call({ authUser: 'missing' });
    ok('a non-existent account is refused', !missing.ok && /No such account/i.test(missing.error.message));

    const already = await call({ profile: { role: 'buyer', status: 'pending_deletion' } });
    ok('an already-scheduled account is refused', !already.ok &&
       /already scheduled/i.test(already.error.message));

    const noReason = await call({ reason: '  ' });
    ok('a blank reason is refused', !noReason.ok && /reason is required/i.test(noReason.error.message));
    const noTarget = await call({ targetUid: '' });
    ok('a missing targetUid is refused', !noTarget.ok);

    /* INVERTING CONTROL — an ordinary account still succeeds, so the refusals above
       are not simply a handler that refuses everybody. */
    const fine = await call();
    ok('control — an ordinary buyer is still accepted', fine.ok);
  }

  /* ── 4. NOTHING IS WRITTEN WHEN REFUSED ───────────────────────────────────── */
  head('4 - a refusal leaves the account untouched');
  {
    await call({ profile: { role: 'admin' } });
    ok('an admin-target refusal writes nothing', H.state.writes.length === 0);
    ok('and audits nothing', H.state.audits.length === 0);
    await call({ reason: '' });
    ok('a blank-reason refusal writes nothing', H.state.writes.length === 0);
  }

  /* ── 5. THE AUDIT ─────────────────────────────────────────────────────────── */
  head('5 - who did it, to whom, and why');
  {
    await call();
    const a = H.state.audits[0] || {};
    ok('an audit row is written', H.state.audits.length === 1 && a.collection === 'adminAudit');
    ok('it names the action', a.data && a.data.action === 'user_deletion_scheduled');
    ok('it names the target', a.data && a.data.targetUid === 'user-9');
    ok('it names the administrator', a.data && a.data.performedBy === 'admin-1');
    ok('it records the reason', a.data && /Fraudulent/.test(a.data.reason));
    ok('and the scheduled date', a.data && a.data.scheduledAt instanceof Date);
  }

  /* ── 6. THE TWO THINGS THE CLIENT MUST NOT DO ─────────────────────────────── */
  head('6 - neither console deletes or schedules by writing Firestore itself');
  {
    /* Both hazards are PERMITTED by the rules, which is exactly why they need asserting. */
    /* Scoped to the users block itself rather than a character window — the block is
       ~600 chars and a short window silently fails to reach `allow delete`. */
    const usersBlock = (() => {
      const i = rules.indexOf('match /users/{userId} {');
      return i === -1 ? '' : rules.slice(i, rules.indexOf('match /users/{uid}/analytics', i));
    })();
    ok('control — the users rules block was located', usersBlock.length > 200,
       usersBlock.length + ' chars');
    ok('control — rules DO allow an admin to delete users/{uid}',
       /allow delete:\s*if isAdmin\(\)/.test(usersBlock));
    ok('control — rules DO allow an admin to update users/{uid}',
       /allow update:\s*if isAdmin\(\)/.test(usersBlock));

    const aosSrc = strip(aos), saSrc = strip(sa);
    ok('AdminOS never deletes a user document', !/collection\(["']users["']\)[\s\S]{0,80}\.delete\(/.test(aosSrc));
    ok('Super Admin never deletes a user document', !/collection\(["']users["']\)[\s\S]{0,80}\.delete\(/.test(saSrc));
    ok('AdminOS never writes pending_deletion itself', !/pending_deletion/.test(aosSrc));
    ok('Super Admin never writes pending_deletion itself', !/pending_deletion/.test(saSrc));
    ok('AdminOS never writes deletionScheduledAt', !/deletionScheduledAt/.test(aosSrc));
    ok('Super Admin never writes deletionScheduledAt', !/deletionScheduledAt/.test(saSrc));
    /* CONTROL — the server DOES write them, so the absence above is about the client. */
    ok('control — the handler writes both fields',
       /deletionScheduledAt:/.test(adminOs) && /status:\s+'pending_deletion'/.test(adminOs));
  }

  /* ── 7. ONE MECHANISM, TWO CONSOLES ───────────────────────────────────────── */
  head('7 - both consoles call the same authority');
  {
    /* DOUBLE quotes deliberately: test-admin-os-wiring's D0 enumerates ops by matching
       `_call("`, so a single-quoted call site is invisible to that audit. This asserts the
       form the audit can actually see, not merely that the op is called somehow. */
    ok('AdminOS calls the op', /_call\("adminScheduleUserDeletion"/.test(aos));
    ok('Super Admin calls the op', /op:'adminScheduleUserDeletion'/.test(sa));
    ok('Super Admin routes through adminOsDispatch', /httpsCallable\('adminOsDispatch'\)/.test(sa));
    ok('neither invents a second callable',
       !/deleteUserAccount|adminHardDelete|purgeUser/.test(aos + sa));

    /* The module offers the action only when a host supplies it. */
    ok('capability is derived from the supplied action',
       /del: !!A0\.deleteUser/.test(strip(mod)));
    ok('and it dispatches to it', /k === 'del' && A\.deleteUser/.test(strip(mod)));
  }

  /* ── 8. THE UI CONTRACT ───────────────────────────────────────────────────── */
  head('8 - what the operator is told before it happens');
  {
    [['AdminOS', aos], ['Super Admin', sa]].forEach(([label, src]) => {
      ok(label + ' requires a typed DELETE confirmation', /Type DELETE to confirm/.test(src));
      ok(label + ' names the account in the confirmation', /deletion of "'\s*\+\s*who/.test(src));
      ok(label + ' states the 30-day grace period', /30 days/.test(src));
      ok(label + ' says signing in cancels it', /cancels it simply by signing in/.test(src));
      ok(label + ' requires a reason', /Reason \(required/.test(src));
      ok(label + ' refuses a too-short reason client-side', /reason is required/i.test(src));
      /* The op cannot resolve until the dispatcher is redeployed — say so rather than
         showing a generic failure for a button that cannot yet work. */
      ok(label + ' explains the undeployed state', /has not been redeployed/.test(src));
    });

    /* A row already scheduled offers no second Delete button. */
    ok('the module hides Delete for a scheduled account',
       /pending_deletion'\s*\n?\s*\?\s*'<button class="usx-btn sm usx-btn--danger" data-usx="del"|can\.del && \(u\.status \|\| ''\) !== 'pending_deletion'/.test(mod));
    ok('and marks the row as scheduled', /usx-pend/.test(mod) && /usx-pend/.test(read('sokoni-aos-users.css')));
    /* The resulting state must read as serious, not fall through to the neutral
       "unknown status" tone a typo would also get. */
    const D = require(path.join(ROOT, 'sokoni-aos-users.js'));
    ok('pending_deletion reads as a bad status', D._statusTone
       ? D._statusTone('pending_deletion') === 'bad'
       : /id: 'pending_deletion', label: 'Pending deletion', tone: 'bad'/.test(mod));
    ok('control — an unrecognised status is still neutral',
       /return 'muted';/.test(mod));
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live round-trip — adminOsDispatch must be REDEPLOYED before');
  console.log('            this op resolves, and the Functions deploy freeze (Artifact');
  console.log('            Registry forensics) is in force. This lands COMMITTED, NOT DEPLOYED.');
  console.log('  OUT OF SCOPE  the irreversible work itself belongs to finaliseExpiredDeletions');
  console.log('            in account-manager.js and is unchanged by this feature.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
