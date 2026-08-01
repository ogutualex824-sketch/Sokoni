'use strict';
/**
 * SOKONI — INVITATION CORE
 * The ONE source of truth for "somebody was invited and can actually get in".
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The platform had TWO invitation systems that did not know about each other,
 * and neither closed the loop:
 *
 *   `invitations`     (admin-invitations.js) — creates the Auth account with a
 *                     deliberately random password, then emails a password-setup
 *                     link. Correct, but only reachable for VERTICAL roles.
 *   `platformInvites` (index.js invitePlatformEmployee) — writes a token document
 *                     and returns it to the caller. It creates NO Auth account and
 *                     sends NO email at all; the admin was expected to hand the
 *                     link over by some unspecified means.
 *
 * Diagnosed on ochisaac@gmail.com (2026-08-01): Auth account created 2026-07-21
 * by an ops script with a random password that was discarded, `admin` claim set
 * via identitytoolkit, and the ONLY mail ever delivered was `template=welcome`
 * with no setup link. Result: `lastSignInTime: null` — the account had never once
 * signed in, and every attempt returned `auth/invalid-credential` because the
 * password is a 32-byte random string nobody has ever known.
 *
 * That failure is silent by construction: in the Firebase console the account
 * looks perfectly healthy. It is simply unusable, and nothing recorded that.
 *
 * ── The guarantee ───────────────────────────────────────────────────────────
 * An invitation is not "sent" until the invitee can actually sign in. Concretely,
 * `provisionInvitee()` refuses to report success unless ONE of these holds:
 *   • the account has signed in before (it owns a password we never touched), or
 *   • a password-setup mail carrying a real reset link was queued for it.
 * If neither can be achieved the invitation is recorded as `blocked_no_setup_mail`
 * and the call FAILS. A stranded invitee is a defect, not a pending state.
 *
 * ── Role consistency ────────────────────────────────────────────────────────
 * Auth custom claims and the invitation role must agree BEFORE acceptance.
 * Accepting an invite must never silently change privileges someone already has:
 * a `moderator` invite landing on an account that already carries `admin` is a
 * contradiction to be resolved by a human, not resolved by whichever code ran
 * last. `assertRoleConsistency()` blocks that and explains it.
 */

const { HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const crypto = require('crypto');
const logger = require('firebase-functions/logger');
if (!admin.apps.length) admin.initializeApp();

const db  = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();

const emailSvc  = require('./email-service');
const templates = require('./email-templates');

const BASE_URL      = 'https://mysokoni.co.ke';
const FROM_IDENTITY = '"SOKONI" <support@mysokoni.co.ke>';
const REPLY_TO      = 'support@mysokoni.co.ke';
const INVITE_TTL_DAYS = 7;

/* ── Canonical collection ────────────────────────────────────────────────────
   `invitations` is the source of truth. `platformInvites` is retained READ-ONLY
   for links already in the wild; every new invite is written here. */
const COL = 'invitations';
const LEGACY_COL = 'platformInvites';

/* ── Role registry ───────────────────────────────────────────────────────────
   Two different kinds of role, which is precisely what made the previous
   "role mismatch" check meaningless:

     claim   — an Auth custom claim; grants privilege platform-wide. These are
               the ones a consistency check must actually police.
     vertical— a `users/{uid}.registeredAs.<key>` boolean. NOT a claim, so its
               absence from customClaims is normal and must not be reported as a
               mismatch (the first audit flagged three merchant invites for
               exactly that reason). */
const CLAIM_ROLES = {
  superAdmin: { label: 'Super Administrator', dest: '/super-admin' },
  admin:      { label: 'Administrator',       dest: '/admin' },
  moderator:  { label: 'Moderator',           dest: '/moderation' },
  support:    { label: 'Support Agent',       dest: '/support' },
  finance:    { label: 'Finance',             dest: '/finos-admin' },
};
/* Ordered least → most privileged. Acceptance may RAISE privilege to match an
   invitation, but never silently LOWER it. */
const CLAIM_RANK = ['support', 'finance', 'moderator', 'admin', 'superAdmin'];
const rankOf = (r) => CLAIM_RANK.indexOf(r);

const isClaimRole = (r) => Object.prototype.hasOwnProperty.call(CLAIM_ROLES, r);

/* ── Password-setup mail ─────────────────────────────────────────────────────
   `generatePasswordResetLink` does not send anything; it mints a link. The mail
   must then go through the normal queue so it inherits dedup, retries and
   logging. Returns { queueId, link } or throws — callers must not paper over a
   failure here, because a failure means the invitee cannot get in. */
async function sendPasswordSetupMail({ email, name, roleLabel, dest, reason }) {
  const link = await admin.auth().generatePasswordResetLink(email, {
    url: `${BASE_URL}/login`, handleCodeInApp: false,
  });

  const { html, text } = buildSetupEmail({ name, email, roleLabel, dest, link });

  const payload = {
    to: email,
    from: FROM_IDENTITY,
    replyTo: REPLY_TO,
    subject: `Activate your SOKONI ${roleLabel} account`,
    html, text,
    category: 'account',
    template: 'invitation-password-setup',
    /* Time-bucketed so a resend is a genuinely new mail while an accidental
       double-submit inside the same minute is deduped by email-service. */
    emailId: `pwsetup-${crypto.createHash('sha1').update(email).digest('hex').slice(0, 12)}-${Math.floor(Date.now() / 60000)}`,
  };

  /* Send IMMEDIATELY, do not merely enqueue.
     `queue()` writes a pending row that `processEmailQueue` drains on a 2-minute
     schedule. That is fine for bulk mail, but this message is the ONLY way the
     invitee can ever sign in, and "queued" is indistinguishable from "delivered"
     to the admin who just clicked Invite — which is precisely the ambiguity that
     let ochisaac sit stranded for eleven days. Sending inline means the caller
     learns the real outcome now.

     The queue remains the fallback: if the provider call fails we still leave a
     durable pending row for the scheduled worker to retry, and we report which
     of the two happened rather than claiming success either way. */
  try {
    const res = await emailSvc.send(payload);
    const messageId = (res && (res.messageId || res.id)) || null;
    logger.info('[invite] password setup mail SENT', { email, messageId, reason });
    return { queueId: messageId, messageId, delivery: 'sent', link };
  } catch (sendErr) {
    logger.warn('[invite] immediate send failed — falling back to queue', {
      email, error: sendErr.message,
    });
    const queueId = await emailSvc.queue(payload);   // throws → caller strands the invite
    logger.info('[invite] password setup mail queued for retry', { email, queueId, reason });
    return { queueId, messageId: null, delivery: 'queued', link };
  }
}

function buildSetupEmail({ name, email, roleLabel, dest, link }) {
  const html = templates.base({
    title: 'Activate your SOKONI account',
    preheader: 'Set your password to activate your SOKONI account.',
    cta: 'Set Your Password',
    ctaUrl: link,
    body: `
      <p>Hi ${escapeHtml(name || email)},</p>
      <p>You have been invited to SOKONI as a <strong>${escapeHtml(roleLabel)}</strong>.</p>
      <p>Your account has been created, but it has <strong>no password yet</strong>.
         Use the button below to set one — this is the only way to sign in.</p>
      <p style="color:#666;font-size:13px">If the button does not work, paste this into your browser:<br>
         <span style="word-break:break-all">${escapeHtml(link)}</span></p>
      <p style="color:#666;font-size:13px">After setting your password, sign in at
         <a href="${BASE_URL}/login">${BASE_URL}/login</a> and you will land on ${escapeHtml(dest || '/')}.</p>
      <p style="color:#999;font-size:12px">If you were not expecting this invitation you can ignore this email.</p>`,
  });
  const text = [
    `Hi ${name || email},`, '',
    `You have been invited to SOKONI as a ${roleLabel}.`,
    'Your account has been created but has NO password yet. Set one here:', link, '',
    `Then sign in at ${BASE_URL}/login`,
  ].join('\n');
  return { html, text };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ── Auth account ────────────────────────────────────────────────────────────
   The random password exists only to satisfy the createUser API. It is never
   returned, never logged and never usable — which is exactly why the setup mail
   below is not optional. */
async function getOrCreateAuthUser(email, displayName) {
  try {
    const existing = await admin.auth().getUserByEmail(email);
    return { uid: existing.uid, created: false, user: existing };
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  const temp = crypto.randomBytes(32).toString('base64') + 'Aa1!';
  const user = await admin.auth().createUser({
    email, password: temp, displayName: displayName || undefined, emailVerified: false,
  });
  return { uid: user.uid, created: true, user };
}

/**
 * Does this account have a password its owner could possibly know?
 *
 * The only positive evidence available server-side is a successful sign-in:
 * `lastSignInTime` is set by Firebase and cannot be faked by us. An account that
 * has a password provider but has NEVER signed in is exactly the ochisaac
 * shape — the credential is the discarded random string.
 */
function hasUsablePassword(userRecord) {
  const hasPasswordProvider = (userRecord.providerData || [])
    .some(p => p.providerId === 'password');
  const hasSignedIn = !!(userRecord.metadata && userRecord.metadata.lastSignInTime);
  const federatedOnly = !hasPasswordProvider && (userRecord.providerData || []).length > 0;
  /* Federated-only accounts (Google/Facebook) need no password at all. */
  return federatedOnly || hasSignedIn;
}

/**
 * Ensure the invitee can actually get in.
 * THE GUARANTEE (tasks 1 + 2): resolves only when the account is signable-into.
 * Throws otherwise — a silently stranded invitee is the bug being fixed.
 */
async function provisionInvitee({ email, name, role, roleLabel, dest }) {
  const auth = await getOrCreateAuthUser(email, name);
  const record = auth.user;

  if (hasUsablePassword(record)) {
    return { uid: auth.uid, created: auth.created, setupMail: null, reason: 'already_signable' };
  }

  /* No usable credential — a setup link is mandatory, not best-effort. */
  let mail;
  try {
    mail = await sendPasswordSetupMail({
      email, name, roleLabel, dest,
      reason: auth.created ? 'new_account' : 'existing_account_never_signed_in',
    });
  } catch (e) {
    logger.error('[invite] password setup mail FAILED — invitee would be stranded', {
      email, uid: auth.uid, error: e.message,
    });
    /* Record the stranding so it is visible instead of silent. */
    await db().collection(COL).doc(inviteIdFor(email)).set({
      email, role, status: 'blocked_no_setup_mail',
      blockedReason: String(e.message || e).slice(0, 300),
      uid: auth.uid, updatedAt: _ts(),
    }, { merge: true }).catch(() => {});
    throw new HttpsError('internal',
      `Account exists but the password-setup email could not be sent (${e.message}). ` +
      `The invitee would be unable to sign in, so the invitation was not completed.`);
  }
  return { uid: auth.uid, created: auth.created, setupMail: mail, reason: 'setup_mail_sent' };
}

const inviteIdFor = (email) =>
  crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 24);

/* ── Role consistency (task 4) ───────────────────────────────────────────────
   Compares the invitation's intent with the privilege the account already holds
   and refuses to proceed on a contradiction. Returns a verdict object rather
   than throwing, so callers can surface it in a dashboard as well as an error. */
function checkRoleConsistency(inviteRole, existingClaims) {
  const claims = existingClaims || {};
  if (!isClaimRole(inviteRole)) {
    return { ok: true, action: 'vertical_role', note: 'Vertical role — not an Auth claim.' };
  }
  const held = CLAIM_RANK.filter(r => claims[r] === true);
  if (!held.length) return { ok: true, action: 'grant' };
  if (claims[inviteRole] === true) return { ok: true, action: 'noop', note: 'Claim already matches.' };

  const highestHeld = held[held.length - 1];
  if (rankOf(highestHeld) > rankOf(inviteRole)) {
    /* The account is MORE privileged than the invitation. Accepting would be a
       silent demotion — the exact ochisaac case (admin holder, moderator invite). */
    return {
      ok: false, action: 'would_downgrade', held: highestHeld, inviteRole,
      note: `Account already holds "${highestHeld}"; accepting a "${inviteRole}" invitation ` +
            `would reduce their access. Resolve deliberately: revoke the invitation, ` +
            `or remove the higher claim first.`,
    };
  }
  return { ok: true, action: 'upgrade', from: highestHeld, to: inviteRole };
}

/* ── Create an invitation (one path for every role kind) ─────────────────── */
async function createInvitation({ email, role, invitedBy, name }) {
  email = String(email || '').toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'A valid email is required.');
  }
  if (!role) throw new HttpsError('invalid-argument', 'A role is required.');

  const meta = CLAIM_ROLES[role];
  const roleLabel = meta ? meta.label : role;
  const dest = meta ? meta.dest : '/';

  /* Consistency is checked at CREATE too, so a contradictory invitation is
     refused before anybody is emailed about it. */
  let existingClaims = {};
  try { existingClaims = (await admin.auth().getUserByEmail(email)).customClaims || {}; } catch (_) {}
  const verdict = checkRoleConsistency(role, existingClaims);
  if (!verdict.ok) {
    throw new HttpsError('failed-precondition', verdict.note);
  }

  const prov = await provisionInvitee({ email, name, role, roleLabel, dest });

  const token   = crypto.randomUUID();
  const inviteId = inviteIdFor(email);
  const ref = db().collection(COL).doc(inviteId);
  const prior = await ref.get();

  await ref.set({
    inviteId, token, email, name: name || '',
    role, roleKind: isClaimRole(role) ? 'claim' : 'vertical', label: roleLabel, dest,
    uid: prov.uid,
    status: 'sent',
    /* Proof the invitee can act on this invitation — the field whose absence
       made the original failure invisible. */
    setupMailQueueId: prov.setupMail ? prov.setupMail.queueId : null,
    setupMailRequired: !!prov.setupMail,
    signInReady: true,
    provisionReason: prov.reason,
    source: 'invitations-core',
    invitedBy: invitedBy || null,
    invitedAt: prior.exists ? (prior.data().invitedAt || _ts()) : _ts(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + INVITE_TTL_DAYS * 864e5),
    acceptedAt: null,
    resendCount: prior.exists ? (prior.data().resendCount || 0) + 1 : 0,
    lastSentAt: _ts(),
    updatedAt: _ts(),
  }, { merge: true });

  await writeAudit({
    action: 'invitation_sent', email, role, invitedBy,
    targetUid: prov.uid, authAccountCreated: prov.created,
    setupMailQueued: !!prov.setupMail, provisionReason: prov.reason,
  });

  return {
    ok: true, inviteId, token, uid: prov.uid, role, roleLabel,
    authAccountCreated: prov.created,
    setupMailQueueId: prov.setupMail ? prov.setupMail.queueId : null,
    signInReady: true,
    acceptUrl: `${BASE_URL}/join?type=platform&token=${token}`,
  };
}

/* ── Accept an invitation (THE one acceptance flow) ──────────────────────────
   Reads the canonical collection first, then the legacy `platformInvites`
   collection so links already in circulation keep working. */
async function findInvitation(token) {
  const q = await db().collection(COL).where('token', '==', token).limit(1).get();
  if (!q.empty) return { ref: q.docs[0].ref, data: q.docs[0].data(), legacy: false };

  const byId = await db().collection(COL).doc(String(token)).get();
  if (byId.exists) return { ref: byId.ref, data: byId.data(), legacy: false };

  const legacy = await db().collection(LEGACY_COL).doc(String(token)).get();
  if (legacy.exists) return { ref: legacy.ref, data: legacy.data(), legacy: true };

  return null;
}

async function acceptInvitation({ token, uid, callerEmail }) {
  token = String(token || '').trim();
  if (!token) throw new HttpsError('invalid-argument', 'Token required.');

  const found = await findInvitation(token);
  if (!found) throw new HttpsError('not-found', 'Invalid invite link.');
  const { ref, data, legacy } = found;

  const status = String(data.status || '').toLowerCase();
  if (['accepted', 'revoked', 'expired'].includes(status)) {
    throw new HttpsError('failed-precondition', `Invite already ${status}.`);
  }
  if (data.expiresAt && data.expiresAt.toDate && data.expiresAt.toDate() < new Date()) {
    await ref.set({ status: 'expired', updatedAt: _ts() }, { merge: true }).catch(() => {});
    throw new HttpsError('deadline-exceeded', 'Invite expired. Ask an administrator for a new one.');
  }
  if (String(data.email || '').toLowerCase() !== String(callerEmail || '').toLowerCase()) {
    throw new HttpsError('permission-denied',
      `This invite was sent to ${data.email}. Sign in with that email.`);
  }

  const role = data.role;
  const prevClaims = (await admin.auth().getUser(uid)).customClaims || {};

  /* Task 4 — the gate. A contradiction is surfaced, never silently applied. */
  const verdict = checkRoleConsistency(role, prevClaims);
  if (!verdict.ok) {
    await ref.set({
      status: 'blocked_role_conflict', roleConflict: verdict, updatedAt: _ts(),
    }, { merge: true }).catch(() => {});
    await writeAudit({
      action: 'invitation_blocked_role_conflict',
      email: data.email, role, targetUid: uid, verdict,
    });
    throw new HttpsError('failed-precondition', verdict.note);
  }

  if (isClaimRole(role)) {
    await admin.auth().setCustomUserClaims(uid, {
      ...prevClaims, [role]: true, platformEmployee: true, platformRole: role,
    });
    await db().collection('platformEmployees').doc(uid).set({
      uid, email: data.email, displayName: data.name || '', role,
      invitedBy: data.invitedBy || null, active: true, joinedAt: _ts(),
    }, { merge: true });
  } else {
    await db().collection('users').doc(uid).set({
      [`registeredAs.${role}`]: true, updatedAt: _ts(),
    }, { merge: true });
  }

  await ref.set({
    status: 'accepted', acceptedByUid: uid, acceptedAt: _ts(), updatedAt: _ts(),
  }, { merge: true });

  /* A legacy record that has just been honoured is mirrored into the canonical
     collection, so the consolidated view is complete without a migration. */
  if (legacy) {
    await db().collection(COL).doc(inviteIdFor(data.email)).set({
      inviteId: inviteIdFor(data.email), token, email: data.email, role,
      roleKind: isClaimRole(role) ? 'claim' : 'vertical',
      uid, status: 'accepted', source: 'platformInvites(legacy)',
      invitedBy: data.invitedBy || null, acceptedAt: _ts(), updatedAt: _ts(),
    }, { merge: true }).catch(() => {});
  }

  await writeAudit({ action: 'invitation_accepted', email: data.email, role, targetUid: uid, legacy });
  return { success: true, role, roleAction: verdict.action };
}

/* ── Audit (task 6) ──────────────────────────────────────────────────────────
   Finds accounts that cannot sign in: a password provider, no successful
   sign-in ever, and no setup mail on record. */
const SETUP_RE = /oobCode|resetPassword|mode=resetPassword|password[-_ ]?setup|invitation-password-setup|activate your sokoni/i;

async function auditOnboarding() {
  const mailByAddr = new Map();
  for (const col of ['emailQueue', 'emailLogs']) {
    let snap; try { snap = await db().collection(col).get(); } catch (_) { continue; }
    snap.docs.forEach(d => {
      const x = d.data();
      const to = String(x.to || x.email || '').toLowerCase();
      if (!to) return;
      if (!mailByAddr.has(to)) mailByAddr.set(to, []);
      mailByAddr.get(to).push({ template: x.template || '', isSetup: SETUP_RE.test(JSON.stringify(x)) });
    });
  }

  const invitesByEmail = new Map();
  for (const col of [COL, LEGACY_COL]) {
    let snap; try { snap = await db().collection(col).get(); } catch (_) { continue; }
    snap.docs.forEach(d => {
      const x = d.data(); const e = String(x.email || '').toLowerCase(); if (!e) return;
      if (!invitesByEmail.has(e)) invitesByEmail.set(e, []);
      invitesByEmail.get(e).push({ source: col, role: x.role, status: x.status });
    });
  }

  const stranded = [], conflicts = [];
  let scanned = 0, next;
  do {
    const page = await admin.auth().listUsers(1000, next);
    next = page.pageToken;
    for (const u of page.users) {
      scanned++;
      const email = (u.email || '').toLowerCase();
      const claims = u.customClaims || {};
      const mails = mailByAddr.get(email) || [];

      if (!hasUsablePassword(u) && !mails.some(m => m.isSetup)) {
        stranded.push({
          email, uid: u.uid, created: u.metadata.creationTime,
          claims: Object.keys(claims).filter(k => claims[k] === true),
          invites: (invitesByEmail.get(email) || []).map(i => `${i.source}:${i.role}/${i.status}`),
        });
      }
      /* Only CLAIM roles can conflict — a vertical role is not a claim. */
      (invitesByEmail.get(email) || []).forEach(i => {
        if (!isClaimRole(i.role)) return;
        if (['accepted', 'revoked', 'expired'].includes(String(i.status))) return;
        const v = checkRoleConsistency(i.role, claims);
        if (!v.ok) conflicts.push({ email, uid: u.uid, inviteRole: i.role, source: i.source, verdict: v });
      });
    }
  } while (next);

  return { scanned, stranded, conflicts, strandedCount: stranded.length, conflictCount: conflicts.length };
}

async function writeAudit(entry) {
  try {
    await db().collection('adminAudit').add({ ...entry, createdAt: _ts() });
  } catch (e) { logger.warn('[invite] audit write failed', { error: e.message }); }
}

module.exports = {
  createInvitation, acceptInvitation, auditOnboarding,
  checkRoleConsistency, provisionInvitee, sendPasswordSetupMail,
  hasUsablePassword, getOrCreateAuthUser, findInvitation,
  CLAIM_ROLES, CLAIM_RANK, isClaimRole, inviteIdFor, COL, LEGACY_COL,
};
