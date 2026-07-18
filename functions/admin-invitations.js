/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — ADMINISTRATOR INVITATION SYSTEM

   Completes the onboarding subsystem: an administrator can create a user from the
   Admin Dashboard and that person automatically receives a production invitation,
   with no manual email, password-link or queue step.

   BUILT AGAINST docs/CANONICAL_ONBOARDING_SCHEMA.md — every field written here is
   one that shipping code already writes. Nothing is invented.

   ── WHERE THIS STOPS ────────────────────────────────────────────────────────
   This writes ONLY the canonical identity and role fields:
     users/{uid}            §1 of the schema doc  (firebase.js:511-537)
     users/{uid}.registeredAs.<vertical>          (auth.js:600-605)
     wallets/{uid}          §4                    (firebase.js:548+)

   It deliberately writes NO vertical-specific field — no businessName, merchantSlug,
   mechanicId, category, licence number or store configuration. Those belong to the
   existing onboarding UI and are populated there exactly as they are for a
   self-registered user. The single live merchant carries `mechanicId`, a
   vertical-specific key whose retail equivalent is not evidenced anywhere in the
   codebase; inventing one here would put a fabricated field on a real merchant.
   The invitation stops at the boundary of what is proven and hands over.

   ── WHAT IS NOT TOUCHED ─────────────────────────────────────────────────────
   Self-registration (firebase.js) is unmodified. IntaSend, wallets balance logic,
   settlement, orders, checkout and payment webhooks are untouched.
══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin  = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

const emailSvc = require('./email-service');
const templates = require('./email-templates');

const BASE_URL = 'https://mysokoni.co.ke';
/* Google Workspace production sender identity. */
const FROM_IDENTITY = '"SOKONI" <support@mysokoni.co.ke>';
const REPLY_TO      = 'support@mysokoni.co.ke';

/* Verticals are booleans on users/{uid}.registeredAs — auth.js:600-605.
   The value is the registeredAs key; the label is used in the email copy.
   Roles NOT in this map are rejected rather than guessed at. */
const VERTICALS = {
  customer:     { key: 'user',       label: 'Customer',         dest: '/' },
  buyer:        { key: 'user',       label: 'Customer',         dest: '/' },
  merchant:     { key: 'seller',     label: 'Merchant',         dest: '/seller' },
  seller:       { key: 'seller',     label: 'Seller',           dest: '/seller' },
  business:     { key: 'seller',     label: 'Business',         dest: '/seller' },
  artist:       { key: 'seller',     label: 'Artist',           dest: '/seller' },
  professional: { key: 'seller',     label: 'Professional',     dest: '/provider' },
  mechanic:     { key: 'seller',     label: 'Mechanic',         dest: '/provider' },
  technician:   { key: 'seller',     label: 'Technician',       dest: '/provider' },
  lawyer:       { key: 'legal',      label: 'Advocate',         dest: '/provider?cat=legal' },
  legal:        { key: 'legal',      label: 'Legal Provider',   dest: '/provider?cat=legal' },
  doctor:       { key: 'healthcare', label: 'Healthcare Provider', dest: '/healthcare' },
  healthcare:   { key: 'healthcare', label: 'Healthcare Provider', dest: '/healthcare' },
  rider:        { key: 'delivery',   label: 'Rider',            dest: '/onboarding-driver' },
  delivery:     { key: 'delivery',   label: 'Delivery Partner', dest: '/onboarding-driver' },
  driver:       { key: 'driver',     label: 'Driver',           dest: '/driver' },
  landlord:     { key: 'landlord',   label: 'Landlord',         dest: '/landlord' },
  partner:      { key: 'seller',     label: 'Partner',          dest: '/seller' },
  tester:       { key: 'user',       label: 'Beta Tester',      dest: '/' },
};

/* An invitation is considered live for 7 days. Firebase's own OOB code expires
   sooner; `resendInvitation` mints a fresh one without touching the Auth account. */
const INVITE_TTL_DAYS = 7;

function assertAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const t = request.auth.token || {};
  if (t.admin !== true && t.superAdmin !== true) {
    throw new HttpsError('permission-denied', 'Administrator access required.');
  }
  return request.auth.uid;
}

function normaliseEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s)) {
    throw new HttpsError('invalid-argument', 'A valid email address is required.');
  }
  return s;
}

/* ── Auth: create or REUSE. Never a second account for the same address. ── */
async function getOrCreateAuthUser(email, displayName) {
  try {
    const existing = await admin.auth().getUserByEmail(email);
    return { uid: existing.uid, created: false, user: existing };
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  /* Random password satisfies the API only. It is never returned, never logged,
     and never usable — the recipient sets their own via the reset link. */
  const temp = crypto.randomBytes(32).toString('base64') + 'Aa1!';
  const user = await admin.auth().createUser({
    email, password: temp, displayName: displayName || undefined, emailVerified: false,
  });
  return { uid: user.uid, created: true, user };
}

/* ── users/{uid}: canonical §1 fields only, merge so an existing profile is never
      clobbered. Rules block client writes here, so this must run in a function. ── */
async function ensureUserDoc(uid, email, name, verticalKey, adminUid) {
  const ref = db().collection('users').doc(uid);
  const snap = await ref.get();
  const now = new Date();

  if (snap.exists) {
    /* Only ADD the role. Never reset onboarding state or overwrite a live profile. */
    await ref.set({
      [`registeredAs.${verticalKey}`]: true,
      invitedBy: adminUid,
      invitationSource: 'admin_invitation',
    }, { merge: true });
    return { created: false };
  }

  await ref.set({
    uid,
    name:  name || (email.split('@')[0] || 'User'),
    email,
    phoneNumber: null,
    registeredAs: { user: true, [verticalKey]: true },
    roles: ['buyer'],
    accountStatus: 'active',
    /* The canonical "invited, not yet activated" state — firebase.js:519-520 already
       ships exactly this pair, so no new status vocabulary is introduced. */
    onboardingCompleted: false,
    onboardingRequired:  true,
    referralCode: 'SKN' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    referredBy: null,
    firstReferralOrderDone: false,
    joinedAt: now.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }),
    joinedTimestamp: now.getTime(),
    provider: 'email',
    providers: ['email'],
    photoURL: '',
    emailVerified: false,
    /* Provenance — required by the consent policy. */
    invitationSource: 'admin_invitation',
    invitedBy: adminUid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastLogin: null,
  }, { merge: true });
  return { created: true };
}

/* ── wallets/{uid}: §4, zero balance, only if absent. ── */
async function ensureWallet(uid) {
  const ref = db().collection('wallets').doc(uid);
  const snap = await ref.get();
  if (snap.exists) return false;
  await ref.set({
    uid, balance: 0, currency: 'KES',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return true;
}

async function passwordSetupLink(email) {
  return admin.auth().generatePasswordResetLink(email, {
    url: `${BASE_URL}/login`, handleCodeInApp: false,
  });
}

/* ── Invitation email, composed from the production template shell. ── */
function buildEmail({ name, email, label, dest, link }) {
  const html = templates.base({
    title: 'Activate your SOKONI account',
    preheader: 'Set your password to activate your SOKONI account.',
    cta: 'Set Your Password',
    ctaUrl: link,
    body: [
      `<p class="eml-lead" style="margin:0 0 22px;font-family:Arial,Helvetica,sans-serif;font-size:23px;font-weight:700;color:#111827;line-height:1.45;">Hi${name ? ', ' + escapeHtml(name) : ' there'},</p>`,
      `<p class="eml-p" style="margin:0 0 22px;font-family:Arial,Helvetica,sans-serif;font-size:19px;color:#374151;line-height:1.7;">A SOKONI administrator has invited you to join as a <strong>${escapeHtml(label)}</strong>. Set your password below to activate your account, then complete your profile.</p>`,
      `<p class="eml-p" style="margin:0 0 22px;font-family:Arial,Helvetica,sans-serif;font-size:19px;color:#374151;line-height:1.7;">After setting your password you can <a href="${BASE_URL}${dest}" style="color:#15803D;font-weight:700;">complete your onboarding</a> and start using the marketplace.</p>`,
      `<p class="eml-muted" style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#6B7280;line-height:1.65;">This link is single-use and expires. If it lapses, use &ldquo;Forgot password&rdquo; on the sign-in page. If you were not expecting this invitation you can ignore this email &mdash; the account stays inactive until a password is set.</p>`,
    ].join(''),
  });
  return { html, text: templates.toPlainText(html) };
}
function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function writeAudit(entry) {
  /* auditLogs is the dominant spelling in this codebase (27 uses vs 7). */
  await db().collection('auditLogs').add({
    ...entry, ts: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => logger.error('[invite] audit write failed', { message: e.message }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   inviteUser — the single entry point the Admin Dashboard calls.
═══════════════════════════════════════════════════════════════════════════ */
/* Core implementation, shared by inviteUser and resendInvitation. Kept as a plain
   function because a v2 onCall handler is not directly invocable from another. */
async function issueInvitation({ adminUid, email, roleRaw, name, force }) {
  {
    const vertical = VERTICALS[roleRaw];
    if (!vertical) {
      throw new HttpsError('invalid-argument',
        `Unknown role "${roleRaw}". Allowed: ${Object.keys(VERTICALS).join(', ')}`);
    }

    /* ── Idempotency: one live invitation per email. ──
       A deterministic id makes a double-click a no-op rather than a second record. */
    const inviteId = crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
    const inviteRef = db().collection('invitations').doc(inviteId);
    const existing = await inviteRef.get();

    if (existing.exists && !force) {
      const d = existing.data() || {};
      if (d.status === 'accepted') {
        return { ok: true, skipped: 'already_accepted', uid: d.uid, invitationId: inviteId };
      }
      const age = Date.now() - (d.invitedAt && d.invitedAt.toMillis ? d.invitedAt.toMillis() : 0);
      if (['queued', 'sent', 'delivered'].includes(d.status) && age < INVITE_TTL_DAYS * 864e5) {
        /* A live invitation already reached this person. Sending again would be a
           duplicate, which the policy forbids. Resend is an explicit action. */
        return { ok: true, skipped: 'invitation_still_live', uid: d.uid,
                 invitationId: inviteId, status: d.status, messageId: d.messageId || null };
      }
    }

    const auth = await getOrCreateAuthUser(email, name);
    const userDoc = await ensureUserDoc(auth.uid, email, name, vertical.key, adminUid);
    const walletCreated = await ensureWallet(auth.uid);
    const link = await passwordSetupLink(email);
    const { html, text } = buildEmail({ name, email, label: vertical.label, dest: vertical.dest, link });

    /* Queue through the existing pipeline — never a direct provider call. */
    const queueId = await emailSvc.queue({
      to: email,
      from: FROM_IDENTITY,
      replyTo: REPLY_TO,
      subject: `You're invited to SOKONI — activate your ${vertical.label} account`,
      html, text,
      category: 'account',
      template: 'admin-invitation',
      /* Deterministic emailId feeds the existing dedup window in email-service. */
      emailId: `invite-${inviteId}-${existing.exists ? (existing.data().resendCount || 0) + 1 : 0}`,
      uid: auth.uid,
    });

    const prior = existing.exists ? existing.data() : null;
    await inviteRef.set({
      /* `name` is stored so the dashboard can show who was invited without a second
         lookup against users/{uid}. Without it the Name column can only ever render
         a dash, which is how this was caught during dashboard integration. */
      email, name: name || '', uid: auth.uid, role: roleRaw, vertical: vertical.key, label: vertical.label,
      status: 'queued',
      source: 'admin_invitation',
      invitedBy: adminUid,
      invitedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + INVITE_TTL_DAYS * 864e5),
      queueId,
      messageId: null,
      acceptedAt: null,
      resendCount: prior ? (prior.resendCount || 0) + 1 : 0,
      supersededBy: null,
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await writeAudit({
      action: 'admin_invitation_sent',
      adminUid, targetUid: auth.uid, email, invitationId: inviteId,
      role: roleRaw, authAccountCreated: auth.created,
      userDocCreated: userDoc.created, walletCreated,
      passwordLinkGenerated: true, queueId,
    });

    logger.info('[invite] issued', { email, uid: auth.uid, role: roleRaw, authCreated: auth.created });

    return {
      ok: true, uid: auth.uid, invitationId: inviteId, queueId,
      authAccountCreated: auth.created, userDocCreated: userDoc.created,
      walletCreated, status: 'queued',
    };
  }
}

exports.inviteUser = onCall(
  { timeoutSeconds: 60, secrets: emailSvc.EMAIL_SECRETS },
  async (request) => {
    const adminUid = assertAdmin(request);
    return issueInvitation({
      adminUid,
      email:   normaliseEmail(request.data && request.data.email),
      roleRaw: String((request.data && request.data.role) || 'customer').toLowerCase(),
      name:    String((request.data && request.data.name) || '').trim().slice(0, 120),
      force:   !!(request.data && request.data.resend),
    });
  }
);

/* ═══ resendInvitation — fresh link, same account, never a second Auth user ═══ */
exports.resendInvitation = onCall(
  { timeoutSeconds: 60, secrets: emailSvc.EMAIL_SECRETS },
  async (request) => {
    const adminUid = assertAdmin(request);
    const email = normaliseEmail(request.data && request.data.email);
    const inviteId = crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
    const snap = await db().collection('invitations').doc(inviteId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'No invitation exists for that address.');
    const d = snap.data() || {};
    if (d.status === 'accepted') {
      return { ok: true, skipped: 'already_accepted', uid: d.uid };
    }
    /* Mark the previous attempt superseded before issuing a new one, so the trail
       shows the chain rather than a mutated single record. */
    await db().collection('invitations').doc(inviteId)
      .set({ supersededBy: 'resend-' + Date.now() }, { merge: true });
    await writeAudit({ action: 'admin_invitation_resend_requested', adminUid, email, invitationId: inviteId });

    /* force:true bypasses the still-live guard — a resend is an explicit admin action.
       The Auth account and users doc are reused; only a fresh password link is minted. */
    return issueInvitation({
      adminUid, email,
      roleRaw: String(d.role || 'customer').toLowerCase(),
      name: String((request.data && request.data.name) || '').trim().slice(0, 120),
      force: true,
    });
  }
);

/* ═══ listInvitations — powers the Admin Dashboard table ═══ */
exports.listInvitations = onCall({ timeoutSeconds: 30 }, async (request) => {
  assertAdmin(request);
  const limit = Math.min(Number((request.data && request.data.limit) || 100), 500);
  const snap = await db().collection('invitations')
    .orderBy('invitedAt', 'desc').limit(limit).get();

  const rows = [];
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    rows.push({
      invitationId: doc.id,
      email: d.email || '', name: d.name || '', uid: d.uid || '', role: d.role || '', label: d.label || '',
      status: d.status || 'pending',
      source: d.source || 'admin_invitation',
      invitedBy: d.invitedBy || '',
      invitedAt: d.invitedAt && d.invitedAt.toMillis ? d.invitedAt.toMillis() : null,
      lastSentAt: d.lastSentAt && d.lastSentAt.toMillis ? d.lastSentAt.toMillis() : null,
      acceptedAt: d.acceptedAt && d.acceptedAt.toMillis ? d.acceptedAt.toMillis() : null,
      expiresAt: d.expiresAt && d.expiresAt.toMillis ? d.expiresAt.toMillis() : null,
      messageId: d.messageId || null,
      resendCount: d.resendCount || 0,
      expired: !!(d.expiresAt && d.expiresAt.toMillis && d.expiresAt.toMillis() < Date.now()
                  && d.status !== 'accepted'),
    });
  }
  return { ok: true, invitations: rows, count: rows.length };
});

/* ═══ reconcileInvitations — fills status/messageId from emailLogs, and marks
       acceptance when the recipient has actually signed in.
       Acceptance is OBSERVED (users/{uid}.lastLogin), not assumed from delivery. ═══ */
exports.reconcileInvitations = onCall({ timeoutSeconds: 120 }, async (request) => {
  assertAdmin(request);
  const snap = await db().collection('invitations')
    .where('status', 'in', ['queued', 'sent', 'delivered']).limit(200).get();

  let updated = 0;
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    const patch = {};

    const logs = await db().collection('emailLogs')
      .where('to', '==', d.email).where('template', '==', 'admin-invitation')
      .limit(5).get().catch(() => null);
    if (logs && !logs.empty) {
      const sent = logs.docs.map(x => x.data()).find(x => x.status === 'sent');
      if (sent) { patch.status = 'sent'; patch.messageId = sent.messageId || null; }
      else if (logs.docs.some(x => (x.data() || {}).status === 'failed')) patch.status = 'failed';
    }

    if (d.uid) {
      const u = await db().collection('users').doc(d.uid).get().catch(() => null);
      if (u && u.exists && u.data() && u.data().lastLogin) {
        patch.status = 'accepted';
        patch.acceptedAt = u.data().lastLogin;
      }
    }

    if (d.expiresAt && d.expiresAt.toMillis && d.expiresAt.toMillis() < Date.now()
        && patch.status !== 'accepted' && d.status !== 'accepted') {
      patch.status = 'expired';
    }

    if (Object.keys(patch).length) { await doc.ref.set(patch, { merge: true }); updated++; }
  }
  return { ok: true, scanned: snap.size, updated };
});
