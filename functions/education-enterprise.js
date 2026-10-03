'use strict';
/* ══ EDUCATION E2 — ENTERPRISE TRAINING (owner brief 2026-10-03) ═══════════════════════════════════════════════════════
   A company BUYS training; it is never an Education provider and never owns a person's SOKONI account:
       Enterprise ──training assignment──▶ Learner        (never: Enterprise ──owns──▶ account)

   CONSENT, NOT LOOKUP. The company never searches SOKONI users and never names an account. It mints a single-use invite
   code (op 'inviteCreate', create() claim, 14 days); the EMPLOYEE redeems it from their own account (op 'joinCompany').
   Either side ends the assignment (op 'assignmentEnd' / 'leaveCompany'); the assignment record survives (status
   'ended'), nothing about the learner's account changes.

   WHAT THE COMPANY SEES about an assigned learner: the learner's chosen display name and the assignment's own fields —
   never their profile, age status, guardian, other enrolments, wallet or contact details.

   Gate: every company operation requires educationEnterprises/{uid} ACTIVE + approved (application-lifecycle writes it).
   Collections (server-only; rules: client write false, admin read): trainingInvites/{code}, trainingAssignments/{id}. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();
const _str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const _deny = (code, msg, reason) => { throw new HttpsError(code, msg, reason ? { reason } : undefined); };
const _code = () => { const b = crypto.randomBytes(10); let s = ''; for (let i = 0; i < 10; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length]; return s; };
const assignmentId = (enterpriseUid, learnerUid) => String(enterpriseUid) + '__' + String(learnerUid);

async function _assertActiveCompany(db, uid) {
  const e = await db.collection('educationEnterprises').doc(String(uid)).get();
  const d = e.exists ? e.data() || {} : {};
  if (!(d.status === 'active' && d.approved === true)) _deny('permission-denied', 'Only a SOKONI-verified company can manage staff training.', 'NOT_A_VERIFIED_COMPANY');
  return d;
}

async function handle(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) _deny('unauthenticated', 'Sign in to continue.');
  const d = req.data || {};
  const op = String(d.op || '');
  const db = _db();

  /* ── company operations ── */
  if (op === 'overview') {
    const co = await _assertActiveCompany(db, uid);
    const [a, i] = await Promise.all([
      db.collection('trainingAssignments').where('enterpriseUid', '==', uid).limit(500).get(),
      db.collection('trainingInvites').where('enterpriseUid', '==', uid).where('status', '==', 'open').limit(200).get(),
    ]);
    const active = a.docs.filter((x) => x.data().status === 'active').length;
    return { ok: true, company: { companyName: co.companyName || null, staffSeats: Number.isFinite(co.staffSeats) ? co.staffSeats : null }, counts: { activeLearners: active, openInvites: i.docs.filter((x) => Number(x.data().expiresAtMs) > Date.now()).length } };   /* an expired invite is not open */
  }
  if (op === 'inviteCreate') {
    await _assertActiveCompany(db, uid);
    const label = _str(d.label, 80) || null;   /* the company's own note, e.g. an employee name — never matched to an account */
    for (let n = 0; n < 4; n++) {
      const code = _code();
      try {
        await db.collection('trainingInvites').doc(code).create({ enterpriseUid: uid, label, status: 'open', expiresAtMs: Date.now() + INVITE_TTL_MS, createdAt: _ts() });
        return { ok: true, code, expiresInDays: INVITE_TTL_MS / 86400000 };
      } catch (e) { if (!(e && (e.code === 6 || /already exists|ALREADY_EXISTS/i.test(String(e.code || '') + ' ' + String(e.message || ''))))) throw e; }
    }
    _deny('unavailable', 'Please try again.', 'CODE_COLLISION');
  }
  if (op === 'inviteList') {
    await _assertActiveCompany(db, uid);
    const q = await db.collection('trainingInvites').where('enterpriseUid', '==', uid).limit(200).get();
    return { ok: true, invites: q.docs.map((x) => ({ code: x.id, label: x.data().label || null, status: Number(x.data().expiresAtMs) <= Date.now() && x.data().status === 'open' ? 'expired' : x.data().status })) };
  }
  if (op === 'inviteRevoke') {
    await _assertActiveCompany(db, uid);
    const ref = db.collection('trainingInvites').doc(_str(d.code, 12).toUpperCase());
    return db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists || s.data().enterpriseUid !== uid) _deny('not-found', 'No such invite.', 'INVITE_UNKNOWN');
      if (s.data().status !== 'open') _deny('failed-precondition', 'That invite is no longer open.', 'INVITE_CLOSED');
      t.set(ref, { status: 'revoked', revokedAt: _ts() }, { merge: true });
      return { ok: true };
    });
  }
  if (op === 'assignments') {
    await _assertActiveCompany(db, uid);
    const q = await db.collection('trainingAssignments').where('enterpriseUid', '==', uid).limit(500).get();
    const out = [];
    for (const x of q.docs) {
      const a = x.data();
      const lp = await db.collection('learnerProfiles').doc(String(a.learnerUid)).get();
      /* display name ONLY — no profile, age, guardian, enrolments or contact */
      out.push({ assignmentId: x.id, displayName: lp.exists ? (lp.data().displayName || null) : null, label: a.label || null, status: a.status });
    }
    return { ok: true, assignments: out };
  }
  if (op === 'assignmentEnd') {
    await _assertActiveCompany(db, uid);
    const ref = db.collection('trainingAssignments').doc(_str(d.assignmentId, 300));
    return db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists || s.data().enterpriseUid !== uid) _deny('not-found', 'No such assignment.', 'ASSIGNMENT_UNKNOWN');
      if (s.data().status !== 'active') _deny('failed-precondition', 'That assignment has already ended.', 'ASSIGNMENT_ENDED');
      t.set(ref, { status: 'ended', endedBy: 'company', endedAt: _ts() }, { merge: true });
      t.set(db.collection('educationAudit').doc(), { action: 'training_assignment_ended', enterpriseUid: uid, by: uid, at: _ts() });
      return { ok: true };
    });
  }

  /* ── learner operations (any signed-in account; acts only on ITS OWN assignments) ── */
  if (op === 'joinCompany') {
    const code = _str(d.code, 12).toUpperCase();
    if (!/^[A-Z2-9]{10}$/.test(code)) _deny('invalid-argument', 'Enter the 10-character code from your employer.', 'CODE_FORMAT');
    const iRef = db.collection('trainingInvites').doc(code);
    return db.runTransaction(async (t) => {
      const s = await t.get(iRef);
      if (!s.exists) _deny('not-found', 'That code is not valid.', 'CODE_UNKNOWN');
      const inv = s.data() || {};
      if (inv.status !== 'open') _deny('failed-precondition', 'That code has already been used or withdrawn.', 'CODE_USED');
      if (!(Number(inv.expiresAtMs) > Date.now())) _deny('failed-precondition', 'That code has expired. Ask your employer for a new one.', 'CODE_EXPIRED');
      if (inv.enterpriseUid === uid) _deny('permission-denied', 'A company cannot enrol itself.', 'SELF_ASSIGN');
      const co = await t.get(db.collection('educationEnterprises').doc(String(inv.enterpriseUid)));
      if (!(co.exists && co.data().status === 'active' && co.data().approved === true)) _deny('failed-precondition', 'That company is not active on SOKONI.', 'COMPANY_NOT_ACTIVE');
      const aRef = db.collection('trainingAssignments').doc(assignmentId(inv.enterpriseUid, uid));
      const a = await t.get(aRef);
      if (a.exists && a.data().status === 'active') _deny('already-exists', 'You are already in this company\'s training.', 'ALREADY_ASSIGNED');
      t.set(iRef, { status: 'used', usedAt: _ts() }, { merge: true });
      t.set(aRef, { enterpriseUid: inv.enterpriseUid, learnerUid: uid, label: inv.label || null, status: 'active', joinedAt: _ts(), code, _noIndex: true }, { merge: true });
      t.set(db.collection('educationAudit').doc(), { action: 'training_assignment_joined', enterpriseUid: inv.enterpriseUid, learnerUid: uid, at: _ts() });
      return { ok: true, companyName: co.data().companyName || null };
    });
  }
  if (op === 'myCompanies') {
    const q = await db.collection('trainingAssignments').where('learnerUid', '==', uid).where('status', '==', 'active').limit(20).get();
    const out = [];
    for (const x of q.docs) {
      const co = await db.collection('educationEnterprises').doc(String(x.data().enterpriseUid)).get();
      out.push({ assignmentId: x.id, companyName: co.exists ? (co.data().companyName || null) : null });
    }
    return { ok: true, companies: out };
  }
  if (op === 'leaveCompany') {
    const ref = db.collection('trainingAssignments').doc(_str(d.assignmentId, 300));
    return db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists || s.data().learnerUid !== uid) _deny('not-found', 'No such assignment.', 'ASSIGNMENT_UNKNOWN');
      if (s.data().status !== 'active') _deny('failed-precondition', 'You have already left.', 'ASSIGNMENT_ENDED');
      t.set(ref, { status: 'ended', endedBy: 'learner', endedAt: _ts() }, { merge: true });
      t.set(db.collection('educationAudit').doc(), { action: 'training_assignment_left', enterpriseUid: s.data().enterpriseUid, learnerUid: uid, at: _ts() });
      return { ok: true };
    });
  }
  _deny('invalid-argument', 'Unknown operation.', 'OP_UNKNOWN');
}

exports.educationEnterprise = onCall({ region: 'us-central1', enforceAppCheck: true, maxInstances: 20 }, handle);
exports._internal = { handle, assignmentId, INVITE_TTL_MS };
