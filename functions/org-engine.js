'use strict';

/**
 * SOKONI Enterprise Organization Engine v1.0
 *
 * "One Person. One Identity. Unlimited Organizations."
 *
 * Manages the full enterprise organizational layer:
 *   - Organization Directory (corporate profile, legal, banking)
 *   - Departments & Teams
 *   - Reporting Structure (hierarchy tree)
 *   - Approval Workflows (configurable chains per operation)
 *   - Permission Requests (employee-initiated, manager-approved)
 *   - Temporary Access (time-bounded, auto-expiring)
 *   - Authority Delegation (handover with date range)
 *   - Employment Lifecycle (probation → confirmed → terminated → archived)
 *   - Immutable Audit Log
 *   - Organization Analytics Dashboard
 *
 * Firestore Collections:
 *   orgDepartments/{deptId}              departments per organization
 *   orgTeams/{teamId}                    teams within departments
 *   orgApprovalWorkflows/{workflowId}    configurable approval chains
 *   orgPermissionRequests/{reqId}        employee permission requests
 *   orgTempAccess/{accessId}             time-limited permission grants
 *   orgDelegations/{delegId}             authority delegations
 *   orgAuditLog/{logId}                  immutable audit trail
 *
 * New Composite Indexes required:
 *   orgTeams:     businessId ASC + departmentId ASC
 *   orgAuditLog:  businessId ASC + timestamp DESC
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }        = require('firebase-functions/v2/scheduler');
const admin                 = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const db        = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp  = admin.firestore.Timestamp;

/* ─────────────────────────────────────────────────────────────────────
   Internal helpers
   ───────────────────────────────────────────────────────────────────── */

function _assertAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth.uid;
}

function _callerName(req) {
  return req.auth.token.name || req.auth.token.email || '';
}

/** Resolve the caller's role in a business. Returns { role, isBizOwner, membership }. */
async function _resolveRole(uid, businessId) {
  const bizSnap = await db.collection('businesses').doc(businessId).get();
  if (!bizSnap.exists) throw new Error('Organization not found.');
  const biz = bizSnap.data();

  const isOwner = biz.owner === uid || biz.ownerId === uid;
  if (isOwner) return { role: 'owner', isBizOwner: true, biz };

  const memSnap = await db.collection('workspaceMemberships')
    .where('uid', '==', uid)
    .where('businessId', '==', businessId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (memSnap.empty) throw new Error('Access denied — not a member of this organization.');
  const mem = memSnap.docs[0].data();
  return { role: mem.role, isBizOwner: false, membership: mem, membershipId: memSnap.docs[0].id, biz };
}

/** Throw if caller does not have manager-level access (owner, manager, supervisor). */
async function _assertAdmin(uid, businessId) {
  const info = await _resolveRole(uid, businessId);
  const ADMIN_ROLES = ['owner', 'manager', 'supervisor'];
  if (!ADMIN_ROLES.includes(info.role)) throw new Error('Manager-level access required.');
  return info;
}

/** Return the active membership doc snapshot for targetUid in businessId. */
async function _getMemberSnap(targetUid, businessId) {
  const snap = await db.collection('workspaceMemberships')
    .where('uid', '==', targetUid)
    .where('businessId', '==', businessId)
    .where('status', '==', 'active')
    .limit(1)
    .get();
  if (snap.empty) throw new Error('Employee not found in this organization.');
  return snap.docs[0];
}

/** Write a record to the immutable org audit log. Never throws. */
async function _audit(businessId, actorUid, actorName, action, details, targetUid) {
  try {
    await db.collection('orgAuditLog').add({
      businessId,
      actorUid,
      actorName:  actorName || '',
      targetUid:  targetUid || null,
      action,
      details:    details || {},
      timestamp:  FieldValue.serverTimestamp(),
    });
  } catch (_) { /* audit must never block */ }
}

/** Convert a Firestore Timestamp → epoch ms, or return null. */
function _ms(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate().getTime();
  return null;
}

/* ─────────────────────────────────────────────────────────────────────
   ORGANIZATION DIRECTORY
   ───────────────────────────────────────────────────────────────────── */

/**
 * Get the full organization profile for a business.
 * Available to any authenticated caller (used for workspace branding).
 */
exports.orgGetDirectory = onCall(async (req) => {
  _assertAuth(req);
  const { businessId } = req.data;
  if (!businessId) throw new Error('businessId required.');

  const snap = await db.collection('businesses').doc(businessId).get();
  if (!snap.exists) throw new Error('Organization not found.');
  const b = snap.data();

  return {
    businessId,
    name:             b.businessName  || b.name || '',
    tradingName:      b.tradingName   || '',
    logo:             b.businessLogo  || b.logo || '',
    industry:         b.category      || '',
    type:             b.businessType  || '',
    country:          b.country       || 'Kenya',
    county:           b.orgCounty     || b.county || '',
    city:             b.orgCity       || b.city   || '',
    physicalAddress:  b.orgPhysicalAddress || b.address || '',
    postalAddress:    b.orgPostalAddress   || '',
    website:          b.orgWebsite    || b.website || '',
    email:            b.businessEmail || b.email  || '',
    phone:            b.businessPhone || b.phone  || '',
    kraPin:           b.orgKraPin     || '',
    etimsStatus:      b.orgEtimsStatus     || 'inactive',
    vatStatus:        b.orgVatStatus        || 'not_registered',
    regNumber:        b.orgRegNumber        || '',
    companyCertUrl:   b.orgCompanyCertUrl   || '',
    bankAccounts:     b.orgBankAccounts     || [],
    settlementAccount: b.orgSettlementAccount || null,
    subscriptionPlan: b.subscriptionPlan    || '',
    createdAt:        _ms(b.createdAt),
  };
});

/**
 * Update the organization's directory profile.
 * Requires owner or manager access.
 */
exports.orgUpdateDirectory = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, ...data } = req.data;
  if (!businessId) throw new Error('businessId required.');
  await _assertAdmin(uid, businessId);

  const FIELD_MAP = {
    tradingName:       'tradingName',
    county:            'orgCounty',
    city:              'orgCity',
    physicalAddress:   'orgPhysicalAddress',
    postalAddress:     'orgPostalAddress',
    website:           'orgWebsite',
    kraPin:            'orgKraPin',
    etimsStatus:       'orgEtimsStatus',
    vatStatus:         'orgVatStatus',
    regNumber:         'orgRegNumber',
    companyCertUrl:    'orgCompanyCertUrl',
    bankAccounts:      'orgBankAccounts',
    settlementAccount: 'orgSettlementAccount',
  };

  const patch = {};
  for (const [input, firestoreKey] of Object.entries(FIELD_MAP)) {
    if (data[input] !== undefined) patch[firestoreKey] = data[input];
  }
  patch.updatedAt = FieldValue.serverTimestamp();

  await db.collection('businesses').doc(businessId).update(patch);
  await _audit(businessId, uid, _callerName(req), 'org.directory.updated', patch);
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────
   DEPARTMENTS
   ───────────────────────────────────────────────────────────────────── */

exports.orgCreateDepartment = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, name, description, headUid } = req.data;
  if (!businessId || !name?.trim()) throw new Error('businessId and name required.');
  const { biz } = await _assertAdmin(uid, businessId);

  /* Prevent duplicate active department names */
  const existSnap = await db.collection('orgDepartments')
    .where('businessId', '==', businessId)
    .get();
  const dup = existSnap.docs.find(d =>
    d.data().status !== 'archived' &&
    d.data().name.trim().toLowerCase() === name.trim().toLowerCase()
  );
  if (dup) throw new Error(`Department "${name.trim()}" already exists.`);

  const ref = await db.collection('orgDepartments').add({
    businessId,
    businessName: biz.businessName || biz.name || '',
    name:         name.trim(),
    description:  description?.trim() || '',
    headUid:      headUid || null,
    memberCount:  0,
    status:       'active',
    createdAt:    FieldValue.serverTimestamp(),
    createdBy:    uid,
  });

  await _audit(businessId, uid, _callerName(req), 'org.department.created', { name: name.trim(), deptId: ref.id });
  return { deptId: ref.id };
});

exports.orgGetDepartments = onCall(async (req) => {
  _assertAuth(req);
  const { businessId } = req.data;
  if (!businessId) throw new Error('businessId required.');

  const snap = await db.collection('orgDepartments')
    .where('businessId', '==', businessId)
    .get();

  const departments = snap.docs
    .map(d => ({ deptId: d.id, ...d.data(), createdAt: _ms(d.data().createdAt) }))
    .filter(d => d.status !== 'archived')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return { departments };
});

exports.orgUpdateDepartment = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, deptId, name, description, headUid } = req.data;
  if (!businessId || !deptId) throw new Error('businessId and deptId required.');
  await _assertAdmin(uid, businessId);

  const patch = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid };
  if (name        !== undefined) patch.name        = name.trim();
  if (description !== undefined) patch.description = description.trim();
  if (headUid     !== undefined) patch.headUid     = headUid;

  await db.collection('orgDepartments').doc(deptId).update(patch);
  await _audit(businessId, uid, _callerName(req), 'org.department.updated', { deptId, ...patch });
  return { success: true };
});

exports.orgArchiveDepartment = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, deptId } = req.data;
  if (!businessId || !deptId) throw new Error('businessId and deptId required.');
  await _assertAdmin(uid, businessId);

  await db.collection('orgDepartments').doc(deptId).update({
    status:     'archived',
    archivedAt: FieldValue.serverTimestamp(),
    archivedBy: uid,
  });
  await _audit(businessId, uid, _callerName(req), 'org.department.archived', { deptId });
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────
   TEAMS
   ───────────────────────────────────────────────────────────────────── */

exports.orgCreateTeam = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, departmentId, name, type, schedule, leadUid } = req.data;
  if (!businessId || !departmentId || !name?.trim()) {
    throw new Error('businessId, departmentId and name required.');
  }
  await _assertAdmin(uid, businessId);

  const deptSnap  = await db.collection('orgDepartments').doc(departmentId).get();
  const deptName  = deptSnap.exists ? deptSnap.data().name : '';

  const ref = await db.collection('orgTeams').add({
    businessId,
    departmentId,
    departmentName: deptName,
    name:           name.trim(),
    type:           type     || 'general',
    schedule:       schedule || null,
    leadUid:        leadUid  || null,
    memberCount:    0,
    status:         'active',
    createdAt:      FieldValue.serverTimestamp(),
    createdBy:      uid,
  });

  await _audit(businessId, uid, _callerName(req), 'org.team.created',
    { name: name.trim(), departmentId, teamId: ref.id });
  return { teamId: ref.id };
});

exports.orgGetTeams = onCall(async (req) => {
  _assertAuth(req);
  const { businessId, departmentId } = req.data;
  if (!businessId) throw new Error('businessId required.');

  let q = db.collection('orgTeams').where('businessId', '==', businessId);
  if (departmentId) q = q.where('departmentId', '==', departmentId);

  const snap  = await q.get();
  const teams = snap.docs
    .map(d => ({ teamId: d.id, ...d.data(), createdAt: _ms(d.data().createdAt) }))
    .filter(t => t.status !== 'archived')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return { teams };
});

exports.orgUpdateTeam = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, teamId, name, type, schedule, leadUid } = req.data;
  if (!businessId || !teamId) throw new Error('businessId and teamId required.');
  await _assertAdmin(uid, businessId);

  const patch = { updatedAt: FieldValue.serverTimestamp() };
  if (name     !== undefined) patch.name     = name.trim();
  if (type     !== undefined) patch.type     = type;
  if (schedule !== undefined) patch.schedule = schedule;
  if (leadUid  !== undefined) patch.leadUid  = leadUid;

  await db.collection('orgTeams').doc(teamId).update(patch);
  return { success: true };
});

exports.orgArchiveTeam = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, teamId } = req.data;
  if (!businessId || !teamId) throw new Error('businessId and teamId required.');
  await _assertAdmin(uid, businessId);
  await db.collection('orgTeams').doc(teamId).update({
    status: 'archived', archivedAt: FieldValue.serverTimestamp(), archivedBy: uid,
  });
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────
   REPORTING STRUCTURE
   ───────────────────────────────────────────────────────────────────── */

/**
 * Set the direct reporting line for one employee.
 * reportsToUid = null removes the reporting line.
 */
exports.orgSetReportingLine = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, targetUid, reportsToUid } = req.data;
  if (!businessId || !targetUid) throw new Error('businessId and targetUid required.');
  await _assertAdmin(uid, businessId);

  const memSnap = await _getMemberSnap(targetUid, businessId);

  await memSnap.ref.update({
    reportsToUid:  reportsToUid || null,
    updatedAt:     FieldValue.serverTimestamp(),
  });

  await _audit(businessId, uid, _callerName(req), 'org.reporting.set',
    { targetUid, reportsToUid: reportsToUid || null }, targetUid);
  return { success: true };
});

/**
 * Return all active members with their reporting structure fields,
 * so the client can render the org chart tree.
 */
exports.orgGetReportingTree = onCall(async (req) => {
  _assertAuth(req);
  const { businessId } = req.data;
  if (!businessId) throw new Error('businessId required.');

  const snap = await db.collection('workspaceMemberships')
    .where('businessId', '==', businessId)
    .where('status', '==', 'active')
    .get();

  const members = snap.docs.map(d => {
    const m = d.data();
    return {
      uid:              m.uid,
      name:             m.userName    || '',
      role:             m.role        || '',
      roleTitle:        m.roleTitle   || '',
      department:       m.department  || '',
      branchId:         m.branchId    || null,
      branchName:       m.branchName  || '',
      reportsToUid:     m.reportsToUid || null,
      employmentStatus: m.employmentStatus || 'active',
      addedAt:          _ms(m.addedAt),
    };
  });

  return { members };
});

/* ─────────────────────────────────────────────────────────────────────
   APPROVAL WORKFLOWS
   ───────────────────────────────────────────────────────────────────── */

/** Create or update an approval workflow for a specific operation type. */
exports.orgSaveApprovalWorkflow = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, workflowId, type, name, steps } = req.data;
  if (!businessId || !type || !Array.isArray(steps)) {
    throw new Error('businessId, type and steps required.');
  }
  await _assertAdmin(uid, businessId);

  const payload = {
    businessId,
    type,
    name:     name || type,
    steps:    steps.map((s, i) => ({
      order:        i + 1,
      approverRole: s.approverRole || '',
      approverUid:  s.approverUid  || null,
      label:        s.label        || `Step ${i + 1}`,
    })),
    isActive:  true,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  };

  if (workflowId) {
    await db.collection('orgApprovalWorkflows').doc(workflowId).set(payload, { merge: true });
    await _audit(businessId, uid, _callerName(req), 'org.workflow.updated', { workflowId, type });
    return { workflowId };
  }

  payload.createdAt = FieldValue.serverTimestamp();
  payload.createdBy = uid;
  const ref = await db.collection('orgApprovalWorkflows').add(payload);
  await _audit(businessId, uid, _callerName(req), 'org.workflow.created', { workflowId: ref.id, type });
  return { workflowId: ref.id };
});

exports.orgGetApprovalWorkflows = onCall(async (req) => {
  _assertAuth(req);
  const { businessId } = req.data;
  if (!businessId) throw new Error('businessId required.');

  const snap = await db.collection('orgApprovalWorkflows')
    .where('businessId', '==', businessId)
    .get();

  const workflows = snap.docs
    .map(d => ({ workflowId: d.id, ...d.data(), createdAt: _ms(d.data().createdAt), updatedAt: _ms(d.data().updatedAt) }))
    .filter(w => w.isActive !== false);

  return { workflows };
});

exports.orgDeleteApprovalWorkflow = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, workflowId } = req.data;
  if (!businessId || !workflowId) throw new Error('businessId and workflowId required.');
  await _assertAdmin(uid, businessId);
  await db.collection('orgApprovalWorkflows').doc(workflowId).update({ isActive: false, deletedBy: uid });
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────
   PERMISSION REQUESTS
   ───────────────────────────────────────────────────────────────────── */

/** Employee requests a permission they don't currently have. */
exports.orgRequestPermission = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, permission, reason } = req.data;
  if (!businessId || !permission) throw new Error('businessId and permission required.');

  const memSnap = await _getMemberSnap(uid, businessId);
  const mem = memSnap.data();

  /* Block duplicate pending requests */
  const existSnap = await db.collection('orgPermissionRequests')
    .where('businessId', '==', businessId)
    .where('uid', '==', uid)
    .where('permission', '==', permission)
    .get();
  const hasPending = existSnap.docs.some(d => d.data().status === 'pending');
  if (hasPending) throw new Error('You already have a pending request for this permission.');

  const ref = await db.collection('orgPermissionRequests').add({
    businessId,
    uid,
    userName:   mem.userName   || '',
    userEmail:  mem.userEmail  || '',
    role:       mem.role       || '',
    department: mem.department || '',
    permission,
    reason:     reason?.trim() || '',
    status:     'pending',
    reviewedBy:     null,
    reviewedByName: null,
    reviewedAt:     null,
    grantedUntil:   null,
    createdAt:  FieldValue.serverTimestamp(),
  });

  await _audit(businessId, uid, _callerName(req), 'org.permission.requested',
    { permission, reason: reason?.trim() || '' });
  return { requestId: ref.id };
});

/** Manager approves or rejects a permission request. */
exports.orgReviewPermissionRequest = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { requestId, action, grantDays } = req.data;
  if (!requestId || !['approved', 'rejected'].includes(action)) {
    throw new Error('requestId and action (approved|rejected) required.');
  }

  const reqDoc  = await db.collection('orgPermissionRequests').doc(requestId).get();
  if (!reqDoc.exists) throw new Error('Permission request not found.');
  const reqData = reqDoc.data();

  await _assertAdmin(uid, reqData.businessId);

  const patch = {
    status:         action,
    reviewedBy:     uid,
    reviewedByName: _callerName(req),
    reviewedAt:     FieldValue.serverTimestamp(),
  };

  if (action === 'approved') {
    if (grantDays) {
      const exp = new Date(Date.now() + grantDays * 86400000);
      patch.grantedUntil = Timestamp.fromDate(exp);
    }
    /* Append the permission to the membership */
    const memSnap = await db.collection('workspaceMemberships')
      .where('uid', '==', reqData.uid)
      .where('businessId', '==', reqData.businessId)
      .where('status', '==', 'active')
      .limit(1)
      .get();
    if (!memSnap.empty) {
      const perms = Array.isArray(memSnap.docs[0].data().permissions)
        ? memSnap.docs[0].data().permissions : [];
      if (!perms.includes(reqData.permission)) {
        await memSnap.docs[0].ref.update({
          permissions: [...perms, reqData.permission],
          updatedAt:   FieldValue.serverTimestamp(),
        });
      }
    }
    await _audit(reqData.businessId, uid, _callerName(req), 'org.permission.granted',
      { targetUid: reqData.uid, permission: reqData.permission, grantDays: grantDays || null },
      reqData.uid);
  } else {
    await _audit(reqData.businessId, uid, _callerName(req), 'org.permission.rejected',
      { targetUid: reqData.uid, permission: reqData.permission }, reqData.uid);
  }

  await reqDoc.ref.update(patch);
  return { success: true };
});

/** List permission requests for a business (managers only). */
exports.orgGetPermissionRequests = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, status } = req.data;
  if (!businessId) throw new Error('businessId required.');
  await _assertAdmin(uid, businessId);

  const snap = await db.collection('orgPermissionRequests')
    .where('businessId', '==', businessId)
    .get();

  let requests = snap.docs.map(d => ({
    requestId:    d.id,
    ...d.data(),
    createdAt:    _ms(d.data().createdAt),
    reviewedAt:   _ms(d.data().reviewedAt),
    grantedUntil: _ms(d.data().grantedUntil),
  }));

  if (status) requests = requests.filter(r => r.status === status);
  requests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { requests };
});

/* ─────────────────────────────────────────────────────────────────────
   TEMPORARY ACCESS
   ───────────────────────────────────────────────────────────────────── */

/** Grant time-limited permissions to an employee. */
exports.orgGrantTempAccess = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, targetUid, permissions, durationMinutes } = req.data;
  if (!businessId || !targetUid || !Array.isArray(permissions) || !durationMinutes) {
    throw new Error('businessId, targetUid, permissions[] and durationMinutes required.');
  }

  const VALID_DURATIONS = [30, 120, 480, 1440, 10080, 43200];
  if (!VALID_DURATIONS.includes(Number(durationMinutes))) {
    throw new Error('Invalid duration. Allowed: 30m, 2h, 8h, 1d, 1w, 1mo (in minutes).');
  }

  await _assertAdmin(uid, businessId);
  const memSnap = await _getMemberSnap(targetUid, businessId);
  const mem = memSnap.data();

  const expiresAt = Timestamp.fromDate(new Date(Date.now() + durationMinutes * 60000));

  const ref = await db.collection('orgTempAccess').add({
    businessId,
    uid:           targetUid,
    userName:      mem.userName || '',
    permissions,
    grantedBy:     uid,
    grantedByName: _callerName(req),
    durationMinutes,
    expiresAt,
    revokedAt:     null,
    revokedBy:     null,
    isActive:      true,
    createdAt:     FieldValue.serverTimestamp(),
  });

  /* Merge temp permissions into active membership immediately */
  const current = Array.isArray(mem.permissions) ? mem.permissions : [];
  await memSnap.ref.update({
    permissions:  [...new Set([...current, ...permissions])],
    tempAccessId: ref.id,
    tempAccessExp: expiresAt,
    updatedAt:    FieldValue.serverTimestamp(),
  });

  await _audit(businessId, uid, _callerName(req), 'org.tempaccess.granted',
    { targetUid, permissions, durationMinutes, expiresAt: expiresAt.toDate().getTime() }, targetUid);

  return { accessId: ref.id, expiresAt: expiresAt.toDate().getTime() };
});

/** Revoke a temporary access grant before it expires. */
exports.orgRevokeTempAccess = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { accessId } = req.data;
  if (!accessId) throw new Error('accessId required.');

  const accessDoc = await db.collection('orgTempAccess').doc(accessId).get();
  if (!accessDoc.exists) throw new Error('Temp access record not found.');
  const access = accessDoc.data();

  await _assertAdmin(uid, access.businessId);
  await accessDoc.ref.update({ isActive: false, revokedAt: FieldValue.serverTimestamp(), revokedBy: uid });

  /* Remove temp-only permissions from membership */
  const memSnap = await db.collection('workspaceMemberships')
    .where('uid', '==', access.uid)
    .where('businessId', '==', access.businessId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (!memSnap.empty) {
    const perms = memSnap.docs[0].data().permissions || [];
    await memSnap.docs[0].ref.update({
      permissions:   perms.filter(p => !access.permissions.includes(p)),
      tempAccessId:  null,
      tempAccessExp: null,
      updatedAt:     FieldValue.serverTimestamp(),
    });
  }

  await _audit(access.businessId, uid, _callerName(req), 'org.tempaccess.revoked',
    { accessId, targetUid: access.uid }, access.uid);
  return { success: true };
});

/** List active temporary access grants for a business. */
exports.orgGetTempAccessGrants = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId } = req.data;
  if (!businessId) throw new Error('businessId required.');
  await _assertAdmin(uid, businessId);

  const snap = await db.collection('orgTempAccess')
    .where('businessId', '==', businessId)
    .get();

  const now    = Date.now();
  const grants = snap.docs
    .map(d => ({ accessId: d.id, ...d.data(), expiresAt: _ms(d.data().expiresAt), createdAt: _ms(d.data().createdAt) }))
    .filter(g => g.isActive && g.expiresAt > now)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return { grants };
});

/* ─────────────────────────────────────────────────────────────────────
   AUTHORITY DELEGATION
   ───────────────────────────────────────────────────────────────────── */

/** Delegate a set of permissions to another employee for a defined period. */
exports.orgCreateDelegation = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, toUid, permissions, reason, startDate, endDate } = req.data;
  if (!businessId || !toUid || !Array.isArray(permissions) || !endDate) {
    throw new Error('businessId, toUid, permissions[] and endDate required.');
  }

  await _assertAdmin(uid, businessId);
  const toMemSnap = await _getMemberSnap(toUid, businessId);
  const toMem     = toMemSnap.data();

  const startTs = startDate
    ? Timestamp.fromDate(new Date(startDate))
    : FieldValue.serverTimestamp();
  const endTs   = Timestamp.fromDate(new Date(endDate));

  const ref = await db.collection('orgDelegations').add({
    businessId,
    fromUid:  uid,
    fromName: _callerName(req),
    toUid,
    toName:   toMem.userName || '',
    permissions,
    reason:   reason?.trim() || '',
    startDate: startTs,
    endDate:   endTs,
    status:   'active',
    createdAt: FieldValue.serverTimestamp(),
  });

  /* Apply delegated permissions immediately */
  const current = Array.isArray(toMem.permissions) ? toMem.permissions : [];
  await toMemSnap.ref.update({
    permissions:  [...new Set([...current, ...permissions])],
    delegationId: ref.id,
    updatedAt:    FieldValue.serverTimestamp(),
  });

  await _audit(businessId, uid, _callerName(req), 'org.delegation.created',
    { toUid, permissions, endDate, delegationId: ref.id }, toUid);
  return { delegationId: ref.id };
});

/** Revoke a delegation early. */
exports.orgRevokeDelegation = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { delegationId } = req.data;
  if (!delegationId) throw new Error('delegationId required.');

  const delDoc = await db.collection('orgDelegations').doc(delegationId).get();
  if (!delDoc.exists) throw new Error('Delegation not found.');
  const del = delDoc.data();

  /* Only the delegator or a business admin can revoke */
  if (del.fromUid !== uid) await _assertAdmin(uid, del.businessId);

  await delDoc.ref.update({ status: 'revoked', revokedAt: FieldValue.serverTimestamp(), revokedBy: uid });

  /* Strip delegated permissions from the delegate's membership */
  const memSnap = await db.collection('workspaceMemberships')
    .where('uid', '==', del.toUid)
    .where('businessId', '==', del.businessId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (!memSnap.empty) {
    const perms = memSnap.docs[0].data().permissions || [];
    await memSnap.docs[0].ref.update({
      permissions:  perms.filter(p => !del.permissions.includes(p)),
      delegationId: null,
      updatedAt:    FieldValue.serverTimestamp(),
    });
  }

  await _audit(del.businessId, uid, _callerName(req), 'org.delegation.revoked',
    { delegationId, toUid: del.toUid }, del.toUid);
  return { success: true };
});

/** List active delegations for a business. */
exports.orgGetDelegations = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId } = req.data;
  if (!businessId) throw new Error('businessId required.');
  await _assertAdmin(uid, businessId);

  const snap = await db.collection('orgDelegations')
    .where('businessId', '==', businessId)
    .get();

  const delegations = snap.docs
    .map(d => ({ delegationId: d.id, ...d.data(), createdAt: _ms(d.data().createdAt), endDate: _ms(d.data().endDate) }))
    .filter(d => d.status === 'active')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return { delegations };
});

/* ─────────────────────────────────────────────────────────────────────
   EMPLOYMENT LIFECYCLE
   ───────────────────────────────────────────────────────────────────── */

const LIFECYCLE_STATES = [
  'probation', 'confirmed', 'suspended', 'on_leave',
  'transferred', 'resigned', 'terminated', 'archived', 'active',
];
const TERMINAL_STATES = ['resigned', 'terminated', 'archived'];

/**
 * Advance or update an employee's employment lifecycle state.
 * Terminal states (resigned, terminated, archived) also set membership.status = 'terminated'.
 */
exports.orgUpdateEmploymentStatus = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { membershipId, businessId, newStatus, reason, effectiveDate } = req.data;
  if (!membershipId || !newStatus) throw new Error('membershipId and newStatus required.');
  if (!LIFECYCLE_STATES.includes(newStatus)) throw new Error(`Invalid status: "${newStatus}".`);

  const memDoc = await db.collection('workspaceMemberships').doc(membershipId).get();
  if (!memDoc.exists) throw new Error('Membership not found.');
  const mem = memDoc.data();

  await _assertAdmin(uid, mem.businessId || businessId);

  const prev  = mem.employmentStatus || mem.status || 'active';
  const patch = {
    employmentStatus:  newStatus,
    statusReason:      reason?.trim() || '',
    statusUpdatedAt:   FieldValue.serverTimestamp(),
    statusUpdatedBy:   uid,
    statusUpdatedByName: _callerName(req),
  };

  if (TERMINAL_STATES.includes(newStatus)) {
    patch.status           = 'terminated';
    patch.terminatedAt     = effectiveDate
      ? Timestamp.fromDate(new Date(effectiveDate))
      : FieldValue.serverTimestamp();
    patch.terminationReason = reason?.trim() || '';
  }

  await memDoc.ref.update(patch);
  await _audit(
    mem.businessId || businessId,
    uid,
    _callerName(req),
    `org.employment.${newStatus}`,
    { membershipId, targetUid: mem.uid, reason: reason?.trim() || '', from: prev },
    mem.uid
  );

  return { success: true, from: prev, to: newStatus };
});

/* ─────────────────────────────────────────────────────────────────────
   AUDIT LOG
   ───────────────────────────────────────────────────────────────────── */

/** Return the most recent audit log entries for a business (managers only). */
exports.orgGetAuditLog = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, limitN, targetUid } = req.data;
  if (!businessId) throw new Error('businessId required.');
  await _assertAdmin(uid, businessId);

  let q = db.collection('orgAuditLog')
    .where('businessId', '==', businessId)
    .orderBy('timestamp', 'desc')
    .limit(Math.min(limitN || 50, 200));

  if (targetUid) q = q.where('targetUid', '==', targetUid);

  const snap    = await q.get();
  const entries = snap.docs.map(d => ({
    logId:     d.id,
    ...d.data(),
    timestamp: _ms(d.data().timestamp),
  }));

  return { entries };
});

/* ─────────────────────────────────────────────────────────────────────
   ORGANIZATION ANALYTICS DASHBOARD
   ───────────────────────────────────────────────────────────────────── */

/** Return aggregated stats for the organization dashboard. */
exports.orgGetDashboard = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId } = req.data;
  if (!businessId) throw new Error('businessId required.');
  await _assertAdmin(uid, businessId);

  const [membersSnap, deptsSnap, teamsSnap, invSnap, shiftsSnap] = await Promise.all([
    db.collection('workspaceMemberships').where('businessId', '==', businessId).get(),
    db.collection('orgDepartments').where('businessId', '==', businessId).get(),
    db.collection('orgTeams').where('businessId', '==', businessId).get(),
    db.collection('workspaceInvitations').where('businessId', '==', businessId).get(),
    db.collection('shiftSessions').where('businessId', '==', businessId).limit(500).get(),
  ]);

  const members        = membersSnap.docs.map(d => d.data());
  const activeMembers  = members.filter(m => m.status === 'active');
  const pastMembers    = members.filter(m => m.status !== 'active');
  const depts          = deptsSnap.docs.map(d => d.data()).filter(d => d.status !== 'archived');
  const teams          = teamsSnap.docs.map(d => d.data()).filter(t => t.status !== 'archived');
  const invitations    = invSnap.docs.map(d => d.data());
  const pendingInvites = invitations.filter(i => i.status === 'pending');

  /* Distributions */
  const byRole = {}, byDepartment = {}, byEmpType = {}, byStatus = {};
  for (const m of activeMembers) {
    byRole[m.role || 'unassigned']               = (byRole[m.role || 'unassigned']               || 0) + 1;
    byDepartment[m.department || 'Unassigned']   = (byDepartment[m.department || 'Unassigned']   || 0) + 1;
    byEmpType[m.employmentType || 'unspecified'] = (byEmpType[m.employmentType || 'unspecified'] || 0) + 1;
    byStatus[m.employmentStatus || 'active']     = (byStatus[m.employmentStatus || 'active']     || 0) + 1;
  }

  /* Recent hires (last 30 days) */
  const thirtyAgo    = Date.now() - 30 * 86400000;
  const recentHires  = activeMembers.filter(m => {
    const ts = m.addedAt?.toDate ? m.addedAt.toDate().getTime() : null;
    return ts && ts > thirtyAgo;
  });

  /* Clock-in today */
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const clockedInToday = shiftsSnap.docs.filter(d => {
    const s = d.data();
    const clockIn = s.clockedInAt?.toDate ? s.clockedInAt.toDate() : null;
    return clockIn && clockIn >= todayStart && !s.clockedOut;
  }).length;

  return {
    summary: {
      totalEmployees:    activeMembers.length,
      totalPastEmployees: pastMembers.length,
      totalDepartments:  depts.length,
      totalTeams:        teams.length,
      pendingInvitations: pendingInvites.length,
      recentHires:       recentHires.length,
      clockedInToday,
    },
    distributions: {
      byRole,
      byDepartment,
      byEmploymentType: byEmpType,
      byStatus,
    },
  };
});

/* ═══════════════════════════════════════════════════════════════════════
   CUSTOM ROLES ENGINE
   ───────────────────────────────────────────────────────────────────────
   Organizations can define unlimited custom roles beyond the 11 built-in
   presets. Custom roles are stored in orgRoles/{roleId} and merged with
   built-in roles when listing.
   Collection: orgRoles/{roleId}
   Index: single-field businessId (auto-indexed, no composite needed)
   ═══════════════════════════════════════════════════════════════════════ */

const BUILT_IN_ROLES = [
  { roleId:'owner',             name:'Owner',             isBuiltIn:true },
  { roleId:'manager',           name:'Manager',           isBuiltIn:true },
  { roleId:'supervisor',        name:'Supervisor',        isBuiltIn:true },
  { roleId:'cashier',           name:'Cashier',           isBuiltIn:true },
  { roleId:'inventory_officer', name:'Inventory Officer', isBuiltIn:true },
  { roleId:'accountant',        name:'Accountant',        isBuiltIn:true },
  { roleId:'driver',            name:'Driver',            isBuiltIn:true },
  { roleId:'receptionist',      name:'Receptionist',      isBuiltIn:true },
  { roleId:'waiter',            name:'Waiter / Server',   isBuiltIn:true },
  { roleId:'security',          name:'Security Officer',  isBuiltIn:true },
  { roleId:'cleaner',           name:'Cleaner',           isBuiltIn:true },
  { roleId:'sales_agent',       name:'Sales Agent',       isBuiltIn:true },
  { roleId:'chef',              name:'Chef / Cook',       isBuiltIn:true },
  { roleId:'nurse',             name:'Nurse',             isBuiltIn:true },
  { roleId:'pharmacist',        name:'Pharmacist',        isBuiltIn:true },
  { roleId:'support_agent',     name:'Support Agent',     isBuiltIn:true },
  { roleId:'dispatcher',        name:'Dispatcher',        isBuiltIn:true },
  { roleId:'property_manager',  name:'Property Manager',  isBuiltIn:true },
];

/** List all roles — built-in + custom — for a business. */
exports.orgGetRoles = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId } = req.data;
  if (!businessId) throw new HttpsError('invalid-argument', 'businessId required.');
  await _assertAdmin(uid, businessId);

  const snap = await db.collection('orgRoles')
    .where('businessId', '==', businessId)
    .where('isActive', '==', true)
    .get();

  const custom = snap.docs.map(d => ({ roleId: d.id, ...d.data() }));

  return {
    builtIn: BUILT_IN_ROLES,
    custom,
  };
});

/** Create a custom role. */
exports.orgCreateRole = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, name, description, permissions } = req.data;
  if (!businessId) throw new HttpsError('invalid-argument', 'businessId required.');
  if (!name || !name.trim()) throw new HttpsError('invalid-argument', 'Role name required.');
  await _assertAdmin(uid, businessId);

  const roleName = name.trim();

  // Reject names that collide with built-in roles
  const builtInNames = BUILT_IN_ROLES.map(r => r.name.toLowerCase());
  if (builtInNames.includes(roleName.toLowerCase())) {
    throw new HttpsError('already-exists', `"${roleName}" is a built-in role and cannot be duplicated.`);
  }

  // Check for duplicate custom role names
  const dupSnap = await db.collection('orgRoles')
    .where('businessId', '==', businessId)
    .where('nameLower', '==', roleName.toLowerCase())
    .where('isActive', '==', true)
    .get();
  if (!dupSnap.empty) throw new HttpsError('already-exists', `A custom role named "${roleName}" already exists.`);

  const roleRef = db.collection('orgRoles').doc();
  await roleRef.set({
    businessId,
    name: roleName,
    nameLower: roleName.toLowerCase(),
    description: (description || '').trim(),
    permissions: Array.isArray(permissions) ? permissions : [],
    isBuiltIn: false,
    isActive: true,
    createdBy: uid,
    createdByName: _callerName(req),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await _audit('orgCreateRole', uid, req, { businessId, roleId: roleRef.id, name: roleName });

  return { roleId: roleRef.id, name: roleName };
});

/** Update a custom role's name, description, or permissions. */
exports.orgUpdateRole = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, roleId, name, description, permissions } = req.data;
  if (!businessId || !roleId) throw new HttpsError('invalid-argument', 'businessId and roleId required.');
  await _assertAdmin(uid, businessId);

  const ref  = db.collection('orgRoles').doc(roleId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().businessId !== businessId) throw new HttpsError('not-found', 'Custom role not found.');
  if (snap.data().isBuiltIn) throw new HttpsError('failed-precondition', 'Cannot edit built-in roles.');

  const patch = { updatedAt: FieldValue.serverTimestamp() };
  if (name !== undefined) {
    patch.name      = name.trim();
    patch.nameLower = name.trim().toLowerCase();
  }
  if (description !== undefined) patch.description = description.trim();
  if (Array.isArray(permissions)) patch.permissions = permissions;

  await ref.update(patch);
  await _audit('orgUpdateRole', uid, req, { businessId, roleId });

  return { ok: true };
});

/** Soft-delete a custom role. */
exports.orgDeleteRole = onCall(async (req) => {
  const uid = _assertAuth(req);
  const { businessId, roleId } = req.data;
  if (!businessId || !roleId) throw new HttpsError('invalid-argument', 'businessId and roleId required.');
  await _assertAdmin(uid, businessId);

  const ref  = db.collection('orgRoles').doc(roleId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().businessId !== businessId) throw new HttpsError('not-found', 'Custom role not found.');
  if (snap.data().isBuiltIn) throw new HttpsError('failed-precondition', 'Cannot delete built-in roles.');

  await ref.update({ isActive: false, deletedAt: FieldValue.serverTimestamp(), deletedBy: uid });
  await _audit('orgDeleteRole', uid, req, { businessId, roleId, name: snap.data().name });

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════════
   AUTOMATIC EXPIRY — TEMP ACCESS & DELEGATIONS
   ───────────────────────────────────────────────────────────────────────
   Runs every hour. Finds temp access grants and delegations whose
   expiry has passed and strips the elevated permissions from the
   relevant workspaceMemberships documents.

   Query strategy (avoids composite indexes at the 199/200 limit):
     - Query by expiresAt / endDate alone (single-field range, auto-indexed)
     - Filter isActive / status in JavaScript
   ═══════════════════════════════════════════════════════════════════════ */
exports.orgExpireAccess = onSchedule({ schedule: 'every 60 minutes', region: 'us-central1' }, async () => {
  const now      = Timestamp.now();
  const batch    = db.batch();
  let   expired  = 0;

  /* ── Temp Access ── */
  const tempSnap = await db.collection('orgTempAccess')
    .where('expiresAt', '<=', now)
    .get();

  for (const doc of tempSnap.docs) {
    const access = doc.data();
    if (!access.isActive) continue; // already revoked

    // Strip granted permissions from membership
    const memSnap = await db.collection('workspaceMemberships')
      .where('businessId', '==', access.businessId)
      .where('uid', '==', access.targetUid)
      .limit(1)
      .get();

    if (!memSnap.empty) {
      const mem  = memSnap.docs[0];
      const cur  = mem.data().permissions || [];
      const keep = cur.filter(p => !(access.grantedPermissions || []).includes(p));
      batch.update(mem.ref, {
        permissions:  keep,
        tempAccessId: FieldValue.delete(),
        tempAccessExp: FieldValue.delete(),
        updatedAt:    FieldValue.serverTimestamp(),
      });
    }

    batch.update(doc.ref, {
      isActive:   false,
      expiredAt:  FieldValue.serverTimestamp(),
      expiredBy:  'scheduler',
    });
    expired++;
  }

  /* ── Delegations ── */
  const delgSnap = await db.collection('orgDelegations')
    .where('endDate', '<=', now)
    .get();

  for (const doc of delgSnap.docs) {
    const delg = doc.data();
    if (delg.status !== 'active') continue;

    const memSnap = await db.collection('workspaceMemberships')
      .where('businessId', '==', delg.businessId)
      .where('uid', '==', delg.toUid)
      .limit(1)
      .get();

    if (!memSnap.empty) {
      const mem  = memSnap.docs[0];
      const cur  = mem.data().permissions || [];
      const keep = cur.filter(p => !(delg.delegatedPermissions || []).includes(p));
      batch.update(mem.ref, {
        permissions:  keep,
        delegationId: FieldValue.delete(),
        updatedAt:    FieldValue.serverTimestamp(),
      });
    }

    batch.update(doc.ref, {
      status:    'expired',
      expiredAt: FieldValue.serverTimestamp(),
    });
    expired++;
  }

  if (expired > 0) await batch.commit();
  console.log(`[orgExpireAccess] Expired ${expired} access grants / delegations.`);
});
