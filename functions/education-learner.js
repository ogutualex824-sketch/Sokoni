'use strict';
/* ══ EDUCATION — LEARNER PROFILE + GUARDIAN LINKS (owner decisions 2026-10-03) ═══════════════════════════════════════
   A learner is NOT an application: any signed-in account creates its learner profile at once (educationLearner
   {op:'save'}). The profile is the learner's own; nobody else reads it through this callable.

   AGE IS NEVER A BROWSER CLAIM. The only server-verified age fact on the platform is users/{uid}.ageVerified === true
   (age-verification.ageVerifySubmit: 18+, server-written). So:
     · ageStatus 'verified_adult'  — users.ageVerified === true;
     · ageStatus 'guardian_linked' — an ACTIVE guardianLinks record names this learner;
     · ageStatus 'unverified'      — everything else.
   Access (owner): an 'unverified' learner gets FREE SELF-PACED learning only. Live classes, private tutoring, messaging
   teachers and paid learning need 'verified_adult' or 'guardian_linked' — learnerAccess() is the ONE predicate the
   later Education gates call.

   GUARDIAN LINKS. The learner asks for a one-time code (op 'guardianCode'); a guardian who is a VERIFIED ADULT confirms
   it from their own account (op 'guardianConfirm'). The code is single-use (create() claim), expires in 48h, and can
   never link an account to itself. Either side, or an administrator, can end the link (op 'guardianRevoke').
   Guardian data lives ONLY in guardianLinks (server-only, never indexed): a learner sees "linked", never the guardian's
   contact details; a teacher sees nothing through enrolment.

   Collections (rules: client write false; learnerProfiles readable by owner/admin; guardianLinks admin-only):
     learnerProfiles/{uid}   guardianLinks/{linkId}   guardianCodes/{code}   */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

const REGION = 'us-central1';
const LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced']);
const FORMATS = Object.freeze(['self_paced', 'live_online', 'in_person']);
const LANGUAGES = Object.freeze(['en', 'sw']);
const CODE_TTL_MS = 48 * 3600 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();
const _str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const _list = (v, maxItems, maxLen) => (Array.isArray(v) ? v : [])
  .map((x) => _str(x, maxLen)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, maxItems);
const _deny = (code, msg, reason) => { throw new HttpsError(code, msg, reason ? { reason } : undefined); };

/* A profile photo is a STORAGE PATH in the learner's OWN folder (learner-photos/{uid}/…) — never a download URL: a
   download token opens the file for anyone with the link, and learners may be MINORS. storage.rules let only the owner
   and admins read it (f3 storage review, 2026-10-03). */
function _photo(v, uid) {
  if (v === null || v === '') return null;
  const s = String(v || '');
  const prefix = 'learner-photos/' + uid + '/';
  return s.startsWith(prefix) && !s.includes('..') && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(jpg|jpeg|png|webp)$/i.test(s.slice(prefix.length)) ? s : undefined;
}

/* → the sanitised patch, or throws. Unknown keys are ignored; no age / guardian / status key is ever accepted. */
function sanitizeProfile(input, uid) {
  const d = input && typeof input === 'object' ? input : {};
  const out = {};
  if ('displayName' in d) out.displayName = _str(d.displayName, 80);
  if ('photoPath' in d) {
    const p = _photo(d.photoPath, uid);
    if (p === undefined) _deny('invalid-argument', 'Upload your photo through SOKONI.', 'PHOTO_NOT_OWN');
    out.photoPath = p;
  }
  if ('interests' in d) out.interests = _list(d.interests, 10, 40);
  if ('subjects' in d) out.subjects = _list(d.subjects, 15, 40);
  if ('level' in d) {
    if (d.level !== null && !LEVELS.includes(d.level)) _deny('invalid-argument', 'Choose a learning level.', 'LEVEL_INVALID');
    out.level = d.level || null;
  }
  if ('formats' in d) {
    const f = _list(d.formats, FORMATS.length, 20);
    if (f.some((x) => !FORMATS.includes(x))) _deny('invalid-argument', 'Unknown learning format.', 'FORMAT_INVALID');
    out.formats = f;
  }
  if ('language' in d) {
    if (d.language !== null && !LANGUAGES.includes(d.language)) _deny('invalid-argument', 'Unsupported language.', 'LANGUAGE_INVALID');
    out.language = d.language || null;
  }
  if ('location' in d) out.location = _str(d.location, 80) || null;
  if ('goals' in d) out.goals = _str(d.goals, 300) || null;
  return out;
}

/* THE access predicate (pure over the two server facts). */
function accessFor(ageVerified, guardianLinked) {
  const ageStatus = ageVerified === true ? 'verified_adult' : guardianLinked ? 'guardian_linked' : 'unverified';
  return { ageStatus, selfPacedFree: true, interactive: ageStatus !== 'unverified' };
}

async function _activeLinkFor(db, learnerUid) {
  const q = await db.collection('guardianLinks').where('learnerUid', '==', learnerUid).where('status', '==', 'active').limit(1).get();
  return q.empty ? null : { id: q.docs[0].id, ...q.docs[0].data() };
}

/* Exported for the later Education gates (live classes, tutoring, messaging, paid): ONE answer, from server facts. */
async function learnerAccess(db, uid) {
  const u = await db.collection('users').doc(String(uid)).get();
  const link = await _activeLinkFor(db, String(uid));
  return accessFor(u.exists && (u.data() || {}).ageVerified === true, !!link);
}

function _code() {
  const b = crypto.randomBytes(8); let s = '';
  for (let i = 0; i < 8; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}

async function handle(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) _deny('unauthenticated', 'Sign in to continue.');
  const d = req.data || {};
  const op = String(d.op || '');
  const db = _db();
  const ref = db.collection('learnerProfiles').doc(uid);

  if (op === 'load') {
    const [snap, access] = [await ref.get(), await learnerAccess(db, uid)];
    const p = snap.exists ? snap.data() : null;
    /* the learner's own view: never the guardian's identity, only that a link exists */
    return { ok: true, profile: p ? Object.fromEntries(Object.entries(p).filter(([k]) => !['ownerUid', '_noIndex'].includes(k))) : null, access };
  }

  if (op === 'save') {
    const patch = sanitizeProfile(d.profile, uid);
    const snap = await ref.get();
    await ref.set(Object.assign({}, patch, {
      ownerUid: uid, _noIndex: true, updatedAt: _ts(), ...(snap.exists ? {} : { createdAt: _ts() }),
    }), { merge: true });
    return { ok: true, access: await learnerAccess(db, uid) };
  }

  if (op === 'guardianCode') {
    const u = await db.collection('users').doc(uid).get();
    if (u.exists && (u.data() || {}).ageVerified === true) _deny('failed-precondition', 'Your account is age-verified; no guardian link is needed.', 'ALREADY_ADULT');
    if (await _activeLinkFor(db, uid)) _deny('failed-precondition', 'A guardian is already linked.', 'ALREADY_LINKED');
    for (let i = 0; i < 4; i++) {
      const code = _code();
      try {
        await db.collection('guardianCodes').doc(code).create({ learnerUid: uid, status: 'open', expiresAtMs: Date.now() + CODE_TTL_MS, createdAt: _ts() });
        return { ok: true, code, expiresInHours: CODE_TTL_MS / 3600000 };
      } catch (e) { if (!(e && (e.code === 6 || /already exists|ALREADY_EXISTS/i.test(String(e.code || '') + ' ' + String(e.message || ''))))) throw e; }
    }
    _deny('unavailable', 'Please try again.', 'CODE_COLLISION');
  }

  if (op === 'guardianConfirm') {
    const code = _str(d.code, 12).toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(code)) _deny('invalid-argument', 'Enter the 8-character code.', 'CODE_FORMAT');
    const g = await db.collection('users').doc(uid).get();
    if (!(g.exists && (g.data() || {}).ageVerified === true)) {
      _deny('failed-precondition', 'Only an age-verified adult account can be a guardian. Verify your age first.', 'GUARDIAN_NOT_VERIFIED');
    }
    const cRef = db.collection('guardianCodes').doc(code);
    return db.runTransaction(async (t) => {
      const c = await t.get(cRef);
      if (!c.exists) _deny('not-found', 'That code is not valid.', 'CODE_UNKNOWN');
      const cd = c.data() || {};
      if (cd.status !== 'open') _deny('failed-precondition', 'That code has already been used.', 'CODE_USED');
      if (!(Number(cd.expiresAtMs) > Date.now())) _deny('failed-precondition', 'That code has expired. Ask for a new one.', 'CODE_EXPIRED');
      if (cd.learnerUid === uid) _deny('permission-denied', 'You cannot be your own guardian.', 'SELF_LINK');
      const linkRef = db.collection('guardianLinks').doc(cd.learnerUid + '__' + uid);
      t.set(cRef, { status: 'used', usedBy: uid, usedAt: _ts() }, { merge: true });
      t.set(linkRef, { learnerUid: cd.learnerUid, guardianUid: uid, status: 'active', confirmedAt: _ts(), code, _noIndex: true }, { merge: true });
      t.set(db.collection('educationAudit').doc(), { action: 'guardian_link_confirmed', learnerUid: cd.learnerUid, guardianUid: uid, at: _ts() });
      return { ok: true, linked: true };
    });
  }

  /* The GUARDIAN's own view (rules deny raw guardianLinks reads to everyone but admins): the learners THIS caller
     guards — learner uid + display name only. It is keyed on the caller, so no teacher, learner or stranger can list
     anyone else's links, and nothing here ever returns a guardian's identity to anyone. */
  if (op === 'guardianOf') {
    const q = await db.collection('guardianLinks').where('guardianUid', '==', uid).where('status', '==', 'active').limit(20).get();
    const out = [];
    for (const x of q.docs) {
      const lp = await db.collection('learnerProfiles').doc(String(x.data().learnerUid)).get();
      out.push({ learnerUid: x.data().learnerUid, displayName: lp.exists ? (lp.data().displayName || null) : null });
    }
    return { ok: true, learners: out };
  }

  if (op === 'guardianRevoke') {
    const isAdmin = !!(req.auth.token && (req.auth.token.admin === true || req.auth.token.superAdmin === true));
    const learnerUid = _str(d.learnerUid || uid, 128);
    const q = await db.collection('guardianLinks').where('learnerUid', '==', learnerUid).where('status', '==', 'active').limit(5).get();
    const mine = q.docs.filter((x) => isAdmin || x.data().learnerUid === uid || x.data().guardianUid === uid);
    if (!mine.length) _deny('not-found', 'No active guardian link.', 'NO_LINK');
    for (const x of mine) {
      await x.ref.set({ status: 'revoked', revokedBy: uid, revokedAt: _ts() }, { merge: true });
      await db.collection('educationAudit').add({ action: 'guardian_link_revoked', learnerUid: x.data().learnerUid, guardianUid: x.data().guardianUid, by: uid, admin: isAdmin, at: _ts() });
    }
    return { ok: true, revoked: mine.length };
  }

  _deny('invalid-argument', 'Unknown operation.', 'OP_UNKNOWN');
}

exports.educationLearner = onCall({ region: REGION, enforceAppCheck: true, maxInstances: 20 }, handle);
exports._internal = { sanitizeProfile, accessFor, learnerAccess, handle, LEVELS, FORMATS, LANGUAGES, CODE_TTL_MS };
