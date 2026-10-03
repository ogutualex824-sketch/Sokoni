#!/usr/bin/env node
'use strict';
/**
 * P0 2026-10-03 — account deactivate / reactivate can never SELF-ACTIVATE a provider or SELF-UNFREEZE an admin freeze.
 *
 * Runs the REAL accountDeactivate / accountReactivate / adminSetAccountActive handlers (functions/account-status.js)
 * against an in-memory Firestore + Auth stub. No network, no emulator, no production.
 *
 *   node scripts/test-account-reactivate-authority.js            → this tree (must pass)
 *   BASE=de6888b node scripts/test-account-reactivate-authority.js → the LIVE lineage (must FAIL the attack rows)
 */
const path = require('path'); const fs = require('fs'); const Module = require('module'); const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0; const say = (m) => process.stdout.write(m + '\n');
const ck = (id, ok, msg, got) => { if (ok) { pass++; say('  PASS  ' + id + '  ' + msg); } else { fail++; say('  FAIL  ' + id + '  ' + msg + '  got=' + JSON.stringify(got)); } };

/* ── stubs ── */
const TS = { __ts: true }; const DEL = { __del: true };
let DOCS = {}; let CLAIMS = {}; let REVOKED = [];
const clone = (o) => JSON.parse(JSON.stringify(o));
const db = { collection: (c) => ({
  doc: (id) => { const k = c + '/' + id; return {
    get: async () => ({ exists: k in DOCS, data: () => (k in DOCS ? clone(DOCS[k]) : undefined) }),
    set: async (data, opt) => { const base = opt && opt.merge && DOCS[k] ? DOCS[k] : {}; const out = Object.assign({}, base);
      for (const [f, v] of Object.entries(data)) { if (v === DEL) delete out[f]; else out[f] = v === TS ? 'TS' : v; } DOCS[k] = out; },
  }; },
}) };
class HttpsError extends Error { constructor(code, msg, details) { super(msg); this.code = code; this.details = details; } }
const adminStub = {
  apps: [1], initializeApp() {},
  firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => TS, delete: () => DEL } }),
  auth: () => ({ getUser: async (uid) => ({ customClaims: CLAIMS[uid] || {} }), setCustomUserClaims: async (uid, c) => { CLAIMS[uid] = c; }, revokeRefreshTokens: async (uid) => { REVOKED.push(uid); } }),
};
const fnStub = { onCall: (_o, fn) => ({ run: fn }), HttpsError };
const load0 = Module._load;
Module._load = function (req, parent, isMain) { if (req === 'firebase-admin') return adminStub; if (req === 'firebase-functions/v2/https') return fnStub; return load0.call(this, req, parent, isMain); };

let file = path.join(ROOT, 'functions', 'account-status.js');
if (process.env.BASE) { file = path.join(ROOT, 'functions', '.account-status.base.' + process.pid + '.js'); fs.writeFileSync(file, execSync('git show ' + process.env.BASE + ':functions/account-status.js', { cwd: ROOT })); }
let AS; try { AS = require(file); } finally { if (process.env.BASE) fs.unlinkSync(file); }

const call = async (fn, uid, data, token) => { try { return await AS[fn].run({ auth: uid ? { uid, token: token || {} } : null, data: data || {} }); } catch (e) { return { err: e.code, reason: e.details && e.details.reason, msg: e.message, supportUrl: e.details && e.details.supportUrl }; } };
const ADMIN = ['admin_1', { admin: true }];
const reset = (docs) => { DOCS = clone(docs || {}); CLAIMS = {}; REVOKED = []; };
const prov = (uid) => DOCS['providers/' + uid] || {};
const shop = (uid) => DOCS['shops/' + uid] || {};

(async () => {
  say('\nP0 account status — no self-activation, no self-unfreeze   ' + (process.env.BASE ? 'BASE ' + process.env.BASE : 'this tree') + '\n');

  /* A-1 THE ATTACK: a self-created providers doc with NO status → deactivate → reactivate */
  reset({ 'users/u1': { uid: 'u1' }, 'providers/u1': { name: 'x' } });
  await call('accountDeactivate', 'u1', { confirm: true }); await call('accountReactivate', 'u1');
  ck('A-1', prov('u1').status !== 'active' && prov('u1').status === 'pending', 'THE ATTACK: a status-less providers doc never comes back ACTIVE (→ pending)', prov('u1'));

  /* A-2 a PRE-WRITTEN stash 'active' on a pending provider is ignored */
  reset({ 'users/u2': { uid: 'u2' }, 'providers/u2': { status: 'pending', preDeactivationStatus: 'active' } });
  await call('accountDeactivate', 'u2', { confirm: true }); await call('accountReactivate', 'u2');
  ck('A-2', prov('u2').status === 'pending', 'a client pre-written preDeactivationStatus "active" is ignored — the stash is the CURRENT server status', prov('u2'));

  /* A-3 control: an ACTIVE (approved) provider round-trips to active */
  reset({ 'users/u3': { uid: 'u3' }, 'providers/u3': { status: 'active' } });
  await call('accountDeactivate', 'u3', { confirm: true });
  const mid = prov('u3').status;
  const r3 = await call('accountReactivate', 'u3');
  ck('A-3', mid === 'deactivated' && prov('u3').status === 'active' && !r3.err && !('preDeactivationStatus' in prov('u3')), 'CONTROL: an approved provider self-deactivates and self-reactivates back to active, stash cleared', [mid, prov('u3'), r3]);

  /* A-4 control: a suspended provider round-trips to suspended (never upgraded) */
  reset({ 'users/u4': { uid: 'u4' }, 'providers/u4': { status: 'suspended' } });
  await call('accountDeactivate', 'u4', { confirm: true }); await call('accountReactivate', 'u4');
  ck('A-4', prov('u4').status === 'suspended', 'a suspended provider comes back suspended', prov('u4'));

  /* A-5 ADMIN FREEZE → self-reactivate REFUSED */
  reset({ 'users/u5': { uid: 'u5' }, 'providers/u5': { status: 'active' } });
  await call('adminSetAccountActive', ADMIN[0], { uid: 'u5', active: false }, ADMIN[1]);
  const r5 = await call('accountReactivate', 'u5');
  ck('A-5', r5.err === 'failed-precondition' && r5.reason === 'ADMIN_FROZEN' && CLAIMS.u5 && CLAIMS.u5.deactivated === true && prov('u5').status === 'deactivated',
    'an ADMIN freeze cannot be lifted by the account holder (claim + provider stay frozen)', [r5, CLAIMS.u5, prov('u5')]);

  /* A-6 admin freeze → self "deactivate" again cannot downgrade it to a self freeze */
  const r6a = await call('accountDeactivate', 'u5', { confirm: true }); const r6b = await call('accountReactivate', 'u5');
  ck('A-6', r6b.err && prov('u5').status === 'deactivated' && (DOCS['accountFreezes/u5'] || {}).by === 'admin', 'self-deactivating over an admin freeze cannot launder it into a self freeze', [r6a, r6b, DOCS['accountFreezes/u5']]);

  /* A-7 control: only adminSetAccountActive(true) lifts the admin freeze */
  const r7 = await call('adminSetAccountActive', ADMIN[0], { uid: 'u5', active: true }, ADMIN[1]);
  ck('A-7', !r7.err && prov('u5').status === 'active' && !(CLAIMS.u5 || {}).deactivated, 'CONTROL: the administrator lifts the freeze and the provider returns to its prior status', [r7, prov('u5'), CLAIMS.u5]);

  /* A-8 a banned / suspended user cannot self-reactivate */
  reset({ 'users/u8': { uid: 'u8' }, 'providers/u8': { status: 'active' } });
  await call('accountDeactivate', 'u8', { confirm: true }); DOCS['users/u8'].banned = true;
  const r8 = await call('accountReactivate', 'u8');
  ck('A-8', r8.err === 'permission-denied' && (CLAIMS.u8 || {}).deactivated === true, 'a BANNED account cannot self-reactivate', r8);

  /* A-9 no freeze record (never deactivated through accountDeactivate) → refused */
  reset({ 'users/u9': { uid: 'u9', deactivated: true, accountStatus: 'deactivated' }, 'providers/u9': { status: 'deactivated', preDeactivationStatus: 'active' } });
  const r9 = await call('accountReactivate', 'u9');
  ck('A-9', r9.err === 'failed-precondition' && r9.reason === 'NOT_SELF_DEACTIVATED' && prov('u9').status === 'deactivated', 'no server freeze record → reactivation refused (a forged deactivated state cannot be "restored" to active)', [r9, prov('u9')]);

  /* A-10 a deactivated provider with NO server stash restores PENDING, never active */
  reset({ 'users/u10': { uid: 'u10' }, 'providers/u10': { status: 'deactivated', deactivated: true }, 'accountFreezes/u10': { active: true, by: 'self' } });
  const r10 = await call('accountReactivate', 'u10');
  ck('A-10', !r10.err && prov('u10').status === 'pending', 'a deactivated provider with NO stash restores PENDING (restore never invents active)', [r10, prov('u10')]);

  /* A-11 owner 2026-10-03: the refusal sends the user to IN-APP support, never WhatsApp */
  ck('A-11', r9.supportUrl === '/support' && /Support/.test(r9.msg || '') && !/whatsapp|wa.me/i.test(r9.msg || ''), 'the refusal points to in-app Support (/support), never WhatsApp', r9);

  /* S-1 a MODERATION-hidden shop stays hidden after a self round-trip */
  reset({ 'users/s1': { uid: 's1' }, 'shops/s1': { isVisible: false } });
  await call('accountDeactivate', 's1', { confirm: true }); await call('accountReactivate', 's1');
  ck('S-1', shop('s1').isVisible === false, 'a shop HIDDEN before deactivation stays hidden after reactivation', shop('s1'));

  /* S-2 a pre-written stash preDeactivationVisible true on a hidden shop is ignored */
  reset({ 'users/s2': { uid: 's2' }, 'shops/s2': { isVisible: false, preDeactivationVisible: true } });
  await call('accountDeactivate', 's2', { confirm: true }); await call('accountReactivate', 's2');
  ck('S-2', shop('s2').isVisible === false, 'a client pre-written preDeactivationVisible true is ignored', shop('s2'));

  /* S-3 control: a visible shop round-trips visible */
  reset({ 'users/s3': { uid: 's3' }, 'shops/s3': { isVisible: true } });
  await call('accountDeactivate', 's3', { confirm: true }); const mids = shop('s3').isVisible; await call('accountReactivate', 's3');
  ck('S-3', mids === false && shop('s3').isVisible === true && !('preDeactivationVisible' in shop('s3')), 'CONTROL: a visible shop is hidden while deactivated and visible again after', [mids, shop('s3')]);

  /* S-4 a shop doc lacking isVisible is restored HIDDEN only if it was not visible; unknown visibility on restore → hidden */
  reset({ 'users/s4': { uid: 's4' }, 'shops/s4': { isVisible: false, deactivated: true } });
  DOCS['accountFreezes/s4'] = { active: true, by: 'self' };
  await call('accountReactivate', 's4');
  ck('S-4', shop('s4').isVisible === false, 'a deactivated shop with NO server stash restores HIDDEN (unknown never becomes visible)', shop('s4'));

  /* C-1 control: unauthenticated + deleted accounts still refused */
  reset({ 'users/d1': { uid: 'd1', accountStatus: 'deleted' } });
  const c1a = await call('accountReactivate', null); const c1b = await call('accountReactivate', 'd1');
  ck('C-1', c1a.err === 'unauthenticated' && c1b.err === 'failed-precondition', 'CONTROL: unauthenticated and deleted accounts are still refused', [c1a, c1b]);
  /* C-2 control: non-admin cannot use the admin override */
  const c2 = await call('adminSetAccountActive', 'u1', { uid: 'u1', active: true });
  ck('C-2', c2.err === 'permission-denied', 'CONTROL: adminSetAccountActive stays admin-only', c2);

  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
