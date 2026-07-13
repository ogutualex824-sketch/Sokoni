'use strict';

/**
 * SOKONI Workforce Identity Engine v1.0
 *
 * "One Person. One Account. Unlimited Businesses."
 *
 * Implements the enterprise employment layer: invitations, memberships,
 * permissions, shift tracking, and audit trails — all server-authorised.
 *
 * Collections:
 *   workspaceInvitations/{invitationId}   pending/accepted/declined invitations
 *   workspaceMemberships/{membershipId}   active and historical employment records
 *   shiftSessions/{sessionId}             clock-in/clock-out records
 *   auditLog/{logId}                      immutable audit trail
 *
 * Firestore indexes required (add to firestore.indexes.json):
 *   workspaceMemberships:  uid ASC + status ASC
 *   workspaceMemberships:  businessId ASC + status ASC
 *   workspaceInvitations:  businessId ASC + status ASC
 *   workspaceInvitations:  invitedEmail ASC + status ASC
 *   workspaceInvitations:  invitedUid ASC + status ASC
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');

if (!admin.apps.length) admin.initializeApp();
const db   = admin.firestore();
const auth = admin.auth();

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════ */

/** Canonical permission set — mirrors sokoni-workspace.js PERMISSIONS */
const ALL_PERMISSIONS = [
  'view_products','manage_products','pos','inventory','refunds','discounts',
  'finance','payroll','reports','customers','bookings','drivers','deliveries',
  'branches','users','analytics','settings',
];

/** Default permissions by role */
const ROLE_PERMISSIONS = {
  owner:            ALL_PERMISSIONS,
  manager:          ['view_products','manage_products','pos','inventory','refunds','discounts','reports','customers','bookings','drivers','deliveries','branches','users','analytics'],
  supervisor:       ['view_products','manage_products','pos','inventory','refunds','discounts','reports','customers','analytics'],
  cashier:          ['pos','view_products','customers','refunds'],
  inventory_officer:['view_products','manage_products','inventory','reports'],
  accountant:       ['finance','payroll','reports','analytics'],
  driver:           ['drivers','deliveries'],
  receptionist:     ['bookings','customers','view_products'],
  waiter:           ['pos','bookings','customers','view_products'],
  security:         ['customers'],
  cleaner:          [],
};

const VALID_EMPLOYMENT_TYPES = ['permanent','contract','seasonal','one_week','one_day','one_shift'];
const INVITATION_TTL_DAYS    = 7;

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

function _assertAuth(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to perform this action.');
  return uid;
}

/** Check the caller owns this business or has the required permission */
async function _assertBusinessPermission(callerUid, businessId, requiredPermission) {
  const bizSnap = await db.collection('businesses').doc(businessId).get();
  if (!bizSnap.exists) throw new HttpsError('not-found', 'Business not found.');

  const biz = bizSnap.data();
  if (biz.ownerId === callerUid) return; // owner has all permissions

  const q = await db.collection('workspaceMemberships')
    .where('uid', '==', callerUid)
    .where('businessId', '==', businessId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (q.empty) throw new HttpsError('permission-denied', 'You are not a member of this business.');

  const membership = q.docs[0].data();
  if (!Array.isArray(membership.permissions) || !membership.permissions.includes(requiredPermission)) {
    throw new HttpsError('permission-denied', `Permission '${requiredPermission}' required for this action.`);
  }
}

/** Generate a human-readable 10-character invite code */
function _makeInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
  const bytes = crypto.randomBytes(16);
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

function _normaliseEmail(email) {
  return (email || '').toLowerCase().trim();
}

function _sanitise(s, max = 200) {
  return String(s || '').substring(0, max).replace(/[<>]/g, '');
}

async function _auditLog(action, data) {
  try {
    await db.collection('auditLog').add(Object.assign({
      action,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    }, data));
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════
   wfInviteEmployee
   Owner invites a person to join their business.
═══════════════════════════════════════════════════════════════ */
exports.wfInviteEmployee = onCall({ region: 'us-central1' }, async (request) => {
  const callerUid = _assertAuth(request);
  const d         = request.data || {};

  const businessId     = _sanitise(d.businessId, 100);
  const invitedEmail   = _normaliseEmail(d.email);
  const invitedPhone   = _sanitise(d.phone, 20);
  const role           = _sanitise(d.role, 50) || 'cashier';
  const roleTitle      = _sanitise(d.roleTitle, 100);
  const employmentType = VALID_EMPLOYMENT_TYPES.includes(d.employmentType) ? d.employmentType : 'permanent';
  const message        = _sanitise(d.message, 500);

  if (!businessId) throw new HttpsError('invalid-argument', 'businessId is required.');
  if (!invitedEmail && !invitedPhone) throw new HttpsError('invalid-argument', 'email or phone is required.');
  if (!role) throw new HttpsError('invalid-argument', 'role is required.');

  /* Verify caller can invite (owner or has 'users' permission) */
  await _assertBusinessPermission(callerUid, businessId, 'users');

  /* Get business metadata */
  const bizSnap = await db.collection('businesses').doc(businessId).get();
  const biz     = bizSnap.data();

  /* Validate permissions override or use role defaults */
  let permissions = Array.isArray(d.permissions)
    ? d.permissions.filter(p => ALL_PERMISSIONS.includes(p))
    : (ROLE_PERMISSIONS[role] || []);

  /* Owner permissions cannot be modified */
  if (role === 'owner') permissions = ALL_PERMISSIONS;

  /* Validate branches */
  const branches = Array.isArray(d.branches) ? d.branches.map(b => _sanitise(b, 100)) : [];

  /* Check if person already has an active membership in this business */
  if (invitedEmail) {
    const existingQ = await db.collection('workspaceMemberships')
      .where('businessId', '==', businessId)
      .where('userEmail', '==', invitedEmail)
      .where('status', '==', 'active')
      .limit(1)
      .get();

    if (!existingQ.empty) {
      throw new HttpsError('already-exists', 'This person is already a member of your business.');
    }
  }

  /* Check for pending invitation to same email */
  if (invitedEmail) {
    const pendingQ = await db.collection('workspaceInvitations')
      .where('businessId', '==', businessId)
      .where('invitedEmail', '==', invitedEmail)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (!pendingQ.empty) {
      throw new HttpsError('already-exists', 'A pending invitation already exists for this email.');
    }
  }

  /* Look up if the invitee already has a SOKONI account */
  let invitedUid   = null;
  let invitedToken = null;
  if (invitedEmail) {
    try {
      const userRecord = await auth.getUserByEmail(invitedEmail);
      invitedUid = userRecord.uid;
    } catch (_) { /* not found — they'll create an account on acceptance */ }
  }

  const invitationCode = _makeInviteCode();
  const expiresAt      = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITATION_TTL_DAYS);

  /* Create invitation document */
  const invRef = await db.collection('workspaceInvitations').add({
    invitationCode,
    businessId,
    businessName:    biz.name || '',
    businessType:    biz.type || '',
    businessLogo:    biz.logo || biz.logoUrl || '',
    invitedEmail:    invitedEmail || '',
    invitedPhone:    invitedPhone || '',
    invitedUid:      invitedUid || '',
    role,
    roleTitle:       roleTitle || '',
    permissions,
    branches,
    employmentType,
    startDate:       d.startDate ? admin.firestore.Timestamp.fromDate(new Date(d.startDate)) : null,
    endDate:         d.endDate   ? admin.firestore.Timestamp.fromDate(new Date(d.endDate))   : null,
    salary:          d.salary ? Number(d.salary) : null,
    salaryType:      _sanitise(d.salaryType, 20) || null,
    message,
    status:          'pending',
    sentAt:          admin.firestore.FieldValue.serverTimestamp(),
    expiresAt:       admin.firestore.Timestamp.fromDate(expiresAt),
    invitedBy:       callerUid,
    inviterName:     _sanitise(d.inviterName, 100),
    notificationSent:false,
  });

  /* Send notification to invitee (if they have a SOKONI account) */
  if (invitedUid) {
    try {
      await db.collection('notifications').add({
        uid:        invitedUid,
        targetUid:  invitedUid,
        type:       'workspace_invitation',
        title:      `Job Invitation: ${biz.name || 'A business'} wants you to join`,
        body:       `You've been invited as ${roleTitle || role} at ${biz.name}. Tap to view and accept.`,
        data: {
          type:           'workspace_invitation',
          invitationId:   invRef.id,
          invitationCode,
          businessId,
          businessName:   biz.name || '',
          businessLogo:   biz.logo || '',
          role,
          deepLink:       `workspace-invite.html?code=${invitationCode}`,
        },
        read:      false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {}
  }

  /* Queue email / SMS via notification engine */
  try {
    await db.collection('notificationQueue').add({
      to:       invitedEmail || invitedPhone,
      type:     'workspace_invitation_email',
      invitationId: invRef.id,
      invitationCode,
      businessName: biz.name || '',
      role,
      expiresAt: expiresAt.toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}

  await _auditLog('workspace_invitation_sent', {
    callerUid, businessId, invitedEmail, invitedPhone, invitedUid, role,
    invitationId: invRef.id, invitationCode,
  });

  return {
    success:        true,
    invitationId:   invRef.id,
    invitationCode,
    deepLink:       `workspace-invite.html?code=${invitationCode}`,
    message:        `Invitation sent to ${invitedEmail || invitedPhone}.`,
  };
});

/* ═══════════════════════════════════════════════════════════════
   wfGetInvitation
   Public: load invitation details by code (before accepting).
═══════════════════════════════════════════════════════════════ */
exports.wfGetInvitation = onCall({ region: 'us-central1' }, async (request) => {
  const code = _sanitise(request.data?.code, 20);
  if (!code) throw new HttpsError('invalid-argument', 'Invitation code is required.');

  const q = await db.collection('workspaceInvitations')
    .where('invitationCode', '==', code)
    .limit(1)
    .get();

  if (q.empty) throw new HttpsError('not-found', 'Invitation not found or has expired.');

  const inv = q.docs[0].data();

  if (inv.status === 'expired' || (inv.expiresAt && inv.expiresAt.toDate() < new Date())) {
    if (inv.status === 'pending') {
      await q.docs[0].ref.update({ status: 'expired' });
    }
    throw new HttpsError('deadline-exceeded', 'This invitation has expired. Ask your employer to resend it.');
  }
  if (inv.status === 'accepted') {
    throw new HttpsError('already-exists', 'This invitation has already been accepted.');
  }
  if (inv.status === 'declined' || inv.status === 'cancelled') {
    throw new HttpsError('failed-precondition', 'This invitation is no longer active.');
  }

  return {
    invitationId:    q.docs[0].id,
    invitationCode:  inv.invitationCode,
    businessId:      inv.businessId,
    businessName:    inv.businessName,
    businessType:    inv.businessType,
    businessLogo:    inv.businessLogo,
    role:            inv.role,
    roleTitle:       inv.roleTitle,
    employmentType:  inv.employmentType,
    message:         inv.message,
    inviterName:     inv.inviterName,
    expiresAt:       inv.expiresAt ? inv.expiresAt.toDate().toISOString() : null,
  };
});

/* ═══════════════════════════════════════════════════════════════
   wfAcceptInvitation
   Employee accepts an invitation — creates workspace membership.
═══════════════════════════════════════════════════════════════ */
exports.wfAcceptInvitation = onCall({ region: 'us-central1' }, async (request) => {
  const uid  = _assertAuth(request);
  const code = _sanitise(request.data?.code, 20);
  if (!code) throw new HttpsError('invalid-argument', 'Invitation code is required.');

  const q = await db.collection('workspaceInvitations')
    .where('invitationCode', '==', code)
    .limit(1)
    .get();

  if (q.empty) throw new HttpsError('not-found', 'Invitation not found.');

  const invDoc = q.docs[0];
  const inv    = invDoc.data();

  /* Validate status and expiry */
  if (inv.status !== 'pending') {
    throw new HttpsError('failed-precondition', `This invitation is ${inv.status}.`);
  }
  if (inv.expiresAt && inv.expiresAt.toDate() < new Date()) {
    await invDoc.ref.update({ status: 'expired' });
    throw new HttpsError('deadline-exceeded', 'This invitation has expired.');
  }

  /* Validate invitee email matches (if targeted) */
  const userRecord = await auth.getUser(uid);
  if (inv.invitedEmail && inv.invitedEmail !== _normaliseEmail(userRecord.email || '')) {
    throw new HttpsError('permission-denied', `This invitation was sent to ${inv.invitedEmail}.`);
  }

  /* Check not already a member of this business */
  const existingQ = await db.collection('workspaceMemberships')
    .where('uid', '==', uid)
    .where('businessId', '==', inv.businessId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (!existingQ.empty) {
    throw new HttpsError('already-exists', 'You are already a member of this business.');
  }

  /* Get caller's profile from users collection */
  const userSnap = await db.collection('users').doc(uid).get();
  const userProfile = userSnap.exists ? userSnap.data() : {};

  /* Create the membership */
  const memberRef = await db.collection('workspaceMemberships').add({
    uid,
    userEmail:      _normaliseEmail(userRecord.email || inv.invitedEmail),
    userName:       userProfile.name || userRecord.displayName || '',
    businessId:     inv.businessId,
    businessName:   inv.businessName,
    businessType:   inv.businessType,
    businessLogo:   inv.businessLogo || '',
    role:           inv.role,
    roleTitle:      inv.roleTitle || '',
    permissions:    inv.permissions || (ROLE_PERMISSIONS[inv.role] || []),
    branches:       inv.branches || [],
    activeBranchId: (inv.branches || [])[0] || null,
    activeBranchName: null,
    employmentType: inv.employmentType,
    startDate:      inv.startDate || admin.firestore.FieldValue.serverTimestamp(),
    endDate:        inv.endDate || null,
    salary:         inv.salary || null,
    salaryType:     inv.salaryType || null,
    status:         'active',
    clockedIn:      false,
    clockedInAt:    null,
    shiftSessionId: null,
    invitationId:   invDoc.id,
    addedAt:        admin.firestore.FieldValue.serverTimestamp(),
    addedBy:        inv.invitedBy,
    lastActive:     admin.firestore.FieldValue.serverTimestamp(),
  });

  /* Update invitation status */
  await invDoc.ref.update({
    status:       'accepted',
    acceptedUid:  uid,
    respondedAt:  admin.firestore.FieldValue.serverTimestamp(),
    membershipId: memberRef.id,
  });

  /* Notify the employer */
  try {
    await db.collection('notifications').add({
      uid:       inv.invitedBy,
      targetUid: inv.invitedBy,
      type:      'invitation_accepted',
      title:     'Staff Accepted',
      body:      `${userProfile.name || userRecord.email} has accepted your invitation to join ${inv.businessName} as ${inv.roleTitle || inv.role}.`,
      data: { businessId: inv.businessId, membershipId: memberRef.id },
      read:      false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}

  await _auditLog('workspace_invitation_accepted', {
    uid, businessId: inv.businessId, role: inv.role,
    invitationId: invDoc.id, membershipId: memberRef.id,
  });

  return {
    success:      true,
    membershipId: memberRef.id,
    businessId:   inv.businessId,
    businessName: inv.businessName,
    role:         inv.role,
    message:      `Welcome to ${inv.businessName}! You are now a ${inv.roleTitle || inv.role}.`,
  };
});

/* ═══════════════════════════════════════════════════════════════
   wfDeclineInvitation
═══════════════════════════════════════════════════════════════ */
exports.wfDeclineInvitation = onCall({ region: 'us-central1' }, async (request) => {
  const uid  = _assertAuth(request);
  const code = _sanitise(request.data?.code, 20);

  const q = await db.collection('workspaceInvitations')
    .where('invitationCode', '==', code)
    .limit(1)
    .get();

  if (q.empty) throw new HttpsError('not-found', 'Invitation not found.');
  const inv = q.docs[0].data();
  if (inv.status !== 'pending') throw new HttpsError('failed-precondition', `Invitation is ${inv.status}.`);

  await q.docs[0].ref.update({
    status:      'declined',
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await _auditLog('workspace_invitation_declined', { uid, invitationId: q.docs[0].id, businessId: inv.businessId });

  return { success: true };
});

/* ═══════════════════════════════════════════════════════════════
   wfCancelInvitation
   Owner cancels a pending invitation before it is accepted.
═══════════════════════════════════════════════════════════════ */
exports.wfCancelInvitation = onCall({ region: 'us-central1' }, async (request) => {
  const callerUid    = _assertAuth(request);
  const invitationId = _sanitise(request.data?.invitationId, 100);

  const snap = await db.collection('workspaceInvitations').doc(invitationId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Invitation not found.');

  const inv = snap.data();
  if (inv.invitedBy !== callerUid) {
    throw new HttpsError('permission-denied', 'Only the sender can cancel this invitation.');
  }
  if (inv.status !== 'pending') {
    throw new HttpsError('failed-precondition', `Invitation is already ${inv.status}.`);
  }

  await snap.ref.update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
  await _auditLog('workspace_invitation_cancelled', { callerUid, invitationId, businessId: inv.businessId });

  return { success: true };
});

/* ═══════════════════════════════════════════════════════════════
   wfRevokeMembership
   Owner removes an employee. Their personal account is unaffected.
═══════════════════════════════════════════════════════════════ */
exports.wfRevokeMembership = onCall({ region: 'us-central1' }, async (request) => {
  const callerUid    = _assertAuth(request);
  const membershipId = _sanitise(request.data?.membershipId, 100);
  const reason       = _sanitise(request.data?.reason, 500);

  const snap = await db.collection('workspaceMemberships').doc(membershipId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Membership not found.');

  const m = snap.data();

  /* Verify caller is the business owner or has 'users' permission */
  await _assertBusinessPermission(callerUid, m.businessId, 'users');

  /* Prevent revoking the owner's own membership */
  const bizSnap = await db.collection('businesses').doc(m.businessId).get();
  if (bizSnap.exists && bizSnap.data().ownerId === m.uid) {
    throw new HttpsError('permission-denied', 'Cannot remove the business owner.');
  }

  /* Set membership to terminated — this triggers onSnapshot on the employee's device */
  await snap.ref.update({
    status:      'terminated',
    terminatedAt: admin.firestore.FieldValue.serverTimestamp(),
    terminatedBy: callerUid,
    terminationReason: reason || '',
  });

  /* Notify the employee */
  try {
    await db.collection('notifications').add({
      uid:       m.uid,
      targetUid: m.uid,
      type:      'workspace_removed',
      title:     'Employment Ended',
      body:      `Your access to ${m.businessName} has been removed. Your personal account is unaffected.`,
      data:      { businessId: m.businessId },
      read:      false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}

  await _auditLog('workspace_membership_revoked', {
    callerUid, targetUid: m.uid, businessId: m.businessId, membershipId, reason,
  });

  return {
    success: true,
    message: `${m.userName || m.userEmail}'s access to ${m.businessName} has been revoked.`,
  };
});

/* ═══════════════════════════════════════════════════════════════
   wfUpdatePermissions
   Owner updates a specific member's permissions (fine-grained).
═══════════════════════════════════════════════════════════════ */
exports.wfUpdatePermissions = onCall({ region: 'us-central1' }, async (request) => {
  const callerUid    = _assertAuth(request);
  const membershipId = _sanitise(request.data?.membershipId, 100);
  const newPerms     = Array.isArray(request.data?.permissions)
    ? request.data.permissions.filter(p => ALL_PERMISSIONS.includes(p))
    : null;

  if (!newPerms) throw new HttpsError('invalid-argument', 'permissions array is required.');

  const snap = await db.collection('workspaceMemberships').doc(membershipId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Membership not found.');

  const m = snap.data();
  await _assertBusinessPermission(callerUid, m.businessId, 'users');

  /* Owner permissions cannot be changed */
  if (m.role === 'owner') {
    throw new HttpsError('permission-denied', 'Owner permissions cannot be modified.');
  }

  await snap.ref.update({
    permissions: newPerms,
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    updatedBy:   callerUid,
  });

  await _auditLog('workspace_permissions_updated', {
    callerUid, targetUid: m.uid, businessId: m.businessId, membershipId, newPerms,
  });

  return { success: true, permissions: newPerms };
});

/* ═══════════════════════════════════════════════════════════════
   wfUpdateRole
   Owner changes an employee's role (resets permissions to role defaults).
═══════════════════════════════════════════════════════════════ */
exports.wfUpdateRole = onCall({ region: 'us-central1' }, async (request) => {
  const callerUid    = _assertAuth(request);
  const membershipId = _sanitise(request.data?.membershipId, 100);
  const newRole      = _sanitise(request.data?.role, 50);
  const newTitle     = _sanitise(request.data?.roleTitle, 100);

  if (!newRole) throw new HttpsError('invalid-argument', 'role is required.');

  const snap = await db.collection('workspaceMemberships').doc(membershipId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Membership not found.');

  const m = snap.data();
  await _assertBusinessPermission(callerUid, m.businessId, 'users');

  if (m.role === 'owner') throw new HttpsError('permission-denied', 'Cannot change the owner role.');

  const newPerms = ROLE_PERMISSIONS[newRole] || [];

  await snap.ref.update({
    role:        newRole,
    roleTitle:   newTitle || '',
    permissions: newPerms,
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    updatedBy:   callerUid,
  });

  /* Notify the employee */
  try {
    await db.collection('notifications').add({
      uid: m.uid, targetUid: m.uid,
      type: 'role_updated',
      title: 'Role Updated',
      body: `Your role at ${m.businessName} has been updated to ${newTitle || newRole}.`,
      data: { businessId: m.businessId, membershipId },
      read: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}

  await _auditLog('workspace_role_updated', {
    callerUid, targetUid: m.uid, businessId: m.businessId, membershipId, oldRole: m.role, newRole,
  });

  return { success: true, role: newRole, permissions: newPerms };
});

/* ═══════════════════════════════════════════════════════════════
   wfGetBusinessMembers
   Owner / manager fetches all members of a business.
═══════════════════════════════════════════════════════════════ */
exports.wfGetBusinessMembers = onCall({ region: 'us-central1' }, async (request) => {
  const callerUid = _assertAuth(request);
  const businessId = _sanitise(request.data?.businessId, 100);
  if (!businessId) throw new HttpsError('invalid-argument', 'businessId is required.');

  await _assertBusinessPermission(callerUid, businessId, 'users');

  const [membersSnap, invitesSnap] = await Promise.all([
    db.collection('workspaceMemberships')
      .where('businessId', '==', businessId)
      .orderBy('addedAt', 'desc')
      .get(),
    db.collection('workspaceInvitations')
      .where('businessId', '==', businessId)
      .where('status', '==', 'pending')
      .orderBy('sentAt', 'desc')
      .get(),
  ]);

  const members = membersSnap.docs.map(d => {
    const data = d.data();
    return {
      membershipId:   d.id,
      uid:            data.uid,
      userName:       data.userName,
      userEmail:      data.userEmail,
      role:           data.role,
      roleTitle:      data.roleTitle,
      employmentType: data.employmentType,
      status:         data.status,
      clockedIn:      data.clockedIn,
      addedAt:        data.addedAt?.seconds ? data.addedAt.seconds * 1000 : null,
      permissions:    data.permissions,
    };
  });

  const pendingInvites = invitesSnap.docs.map(d => {
    const data = d.data();
    return {
      invitationId:  d.id,
      invitedEmail:  data.invitedEmail,
      invitedPhone:  data.invitedPhone,
      role:          data.role,
      roleTitle:     data.roleTitle,
      employmentType:data.employmentType,
      sentAt:        data.sentAt?.seconds ? data.sentAt.seconds * 1000 : null,
      expiresAt:     data.expiresAt?.seconds ? data.expiresAt.seconds * 1000 : null,
    };
  });

  return { members, pendingInvites };
});

/* ═══════════════════════════════════════════════════════════════
   wfGetMyWorkspaces
   Employee fetches all their own workspace memberships.
═══════════════════════════════════════════════════════════════ */
exports.wfGetMyWorkspaces = onCall({ region: 'us-central1' }, async (request) => {
  const uid = _assertAuth(request);

  const [membershipsSnap, invitesSnap] = await Promise.all([
    db.collection('workspaceMemberships')
      .where('uid', '==', uid)
      .orderBy('addedAt', 'desc')
      .get(),
    db.collection('workspaceInvitations')
      .where('invitedUid', '==', uid)
      .where('status', '==', 'pending')
      .orderBy('sentAt', 'desc')
      .get(),
  ]);

  const memberships = membershipsSnap.docs.map(d => {
    const data = d.data();
    return {
      membershipId:    d.id,
      businessId:      data.businessId,
      businessName:    data.businessName,
      businessType:    data.businessType,
      businessLogo:    data.businessLogo,
      role:            data.role,
      roleTitle:       data.roleTitle,
      permissions:     data.permissions,
      branches:        data.branches,
      activeBranchId:  data.activeBranchId,
      employmentType:  data.employmentType,
      status:          data.status,
      clockedIn:       data.clockedIn,
      addedAt:         data.addedAt?.seconds ? data.addedAt.seconds * 1000 : null,
      startDate:       data.startDate?.seconds ? data.startDate.seconds * 1000 : null,
      endDate:         data.endDate?.seconds ? data.endDate.seconds * 1000 : null,
    };
  });

  const pendingInvites = invitesSnap.docs.map(d => {
    const data = d.data();
    return {
      invitationId:   d.id,
      invitationCode: data.invitationCode,
      businessId:     data.businessId,
      businessName:   data.businessName,
      businessType:   data.businessType,
      businessLogo:   data.businessLogo,
      role:           data.role,
      roleTitle:      data.roleTitle,
      employmentType: data.employmentType,
      message:        data.message,
      inviterName:    data.inviterName,
      sentAt:         data.sentAt?.seconds ? data.sentAt.seconds * 1000 : null,
      expiresAt:      data.expiresAt?.seconds ? data.expiresAt.seconds * 1000 : null,
    };
  });

  return { memberships, pendingInvites };
});

/* ═══════════════════════════════════════════════════════════════
   wfClockIn / wfClockOut
   Shift time tracking.
═══════════════════════════════════════════════════════════════ */
exports.wfClockIn = onCall({ region: 'us-central1' }, async (request) => {
  const uid          = _assertAuth(request);
  const membershipId = _sanitise(request.data?.membershipId, 100);
  const businessId   = _sanitise(request.data?.businessId, 100);
  const branchId     = _sanitise(request.data?.branchId, 100);

  const snap = await db.collection('workspaceMemberships').doc(membershipId).get();
  if (!snap.exists || snap.data().uid !== uid) {
    throw new HttpsError('not-found', 'Membership not found.');
  }
  if (snap.data().clockedIn) {
    throw new HttpsError('already-exists', 'Already clocked in.');
  }

  const sessionRef = await db.collection('shiftSessions').add({
    uid, membershipId, businessId, branchId: branchId || null,
    clockedInAt:  admin.firestore.FieldValue.serverTimestamp(),
    clockedOutAt: null,
    durationMinutes: null,
    status:       'active',
  });

  await snap.ref.update({
    clockedIn:      true,
    clockedInAt:    admin.firestore.FieldValue.serverTimestamp(),
    shiftSessionId: sessionRef.id,
  });

  await _auditLog('shift_clock_in', { uid, businessId, branchId, sessionId: sessionRef.id });

  return { success: true, sessionId: sessionRef.id };
});

exports.wfClockOut = onCall({ region: 'us-central1' }, async (request) => {
  const uid          = _assertAuth(request);
  const membershipId = _sanitise(request.data?.membershipId, 100);
  const sessionId    = _sanitise(request.data?.shiftSessionId, 100);

  const [mSnap, sSnap] = await Promise.all([
    db.collection('workspaceMemberships').doc(membershipId).get(),
    sessionId ? db.collection('shiftSessions').doc(sessionId).get() : Promise.resolve(null),
  ]);

  if (!mSnap.exists || mSnap.data().uid !== uid) {
    throw new HttpsError('not-found', 'Membership not found.');
  }
  if (!mSnap.data().clockedIn) {
    throw new HttpsError('failed-precondition', 'Not currently clocked in.');
  }

  const now          = new Date();
  const clockedInAt  = mSnap.data().clockedInAt?.toDate() || now;
  const durationMin  = Math.round((now - clockedInAt) / 60000);

  const updates = [
    mSnap.ref.update({ clockedIn: false, clockedInAt: null, shiftSessionId: null }),
  ];
  if (sSnap && sSnap.exists) {
    updates.push(sSnap.ref.update({
      clockedOutAt:    admin.firestore.FieldValue.serverTimestamp(),
      durationMinutes: durationMin,
      status:          'completed',
    }));
  }
  await Promise.all(updates);

  await _auditLog('shift_clock_out', { uid, membershipId, sessionId, durationMin });

  return {
    success:         true,
    durationMinutes: durationMin,
    hoursWorked:     (durationMin / 60).toFixed(2),
  };
});

/* ═══════════════════════════════════════════════════════════════
   wfGetPendingInvitationsByEmail
   Fetch pending invitations for a user by email (for registration flow).
═══════════════════════════════════════════════════════════════ */
exports.wfGetPendingInvitationsByEmail = onCall({ region: 'us-central1' }, async (request) => {
  const uid = _assertAuth(request);

  const userRecord = await auth.getUser(uid);
  const email      = _normaliseEmail(userRecord.email || '');
  if (!email) return { invitations: [] };

  /* Link invitations to this uid now that we know they have an account */
  const q = await db.collection('workspaceInvitations')
    .where('invitedEmail', '==', email)
    .where('status', '==', 'pending')
    .orderBy('sentAt', 'desc')
    .limit(20)
    .get();

  const invitations = [];
  for (const d of q.docs) {
    const data = d.data();
    /* Backfill the uid if not already set */
    if (!data.invitedUid) {
      await d.ref.update({ invitedUid: uid });
    }
    invitations.push({
      invitationId:   d.id,
      invitationCode: data.invitationCode,
      businessId:     data.businessId,
      businessName:   data.businessName,
      businessLogo:   data.businessLogo,
      role:           data.role,
      roleTitle:      data.roleTitle,
      message:        data.message,
      inviterName:    data.inviterName,
      sentAt:         data.sentAt?.seconds ? data.sentAt.seconds * 1000 : null,
      expiresAt:      data.expiresAt?.seconds ? data.expiresAt.seconds * 1000 : null,
    });
  }

  return { invitations };
});
