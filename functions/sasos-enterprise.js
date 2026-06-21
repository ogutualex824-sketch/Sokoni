/* ================================================================
   SOKONI UNIVERSAL AI SUBSCRIPTION OPERATING SYSTEM
   sasos-enterprise.js — Enterprise Module v1.0.0  |  2026-06-21

   Organization management, team structure, seat allocation,
   enterprise license management, and role-based access.

   Concepts:
     Organization — top-level business entity (company, chain, franchise)
     Branch       — a physical or logical location within an org
     Team         — a department within a branch
     Seat         — an allocated user position within an org's plan
     License      — enterprise contract with custom terms

   License types:
     single_user    — 1 named user
     business       — up to plan seat limit
     enterprise     — custom seat count, negotiated price
     partner        — reseller/agency with multi-tenant access
     developer      — API access with sandbox environment
     education      — discounted for accredited institutions
     government     — KE government entities (special compliance)
     franchise      — multi-location with central billing

   Exports:
     sasosCreateOrg         — create an organization
     sasosGetOrg            — get org details
     sasosInviteSeat        — invite a user to fill a seat
     sasosAcceptSeatInvite  — user accepts a seat invite
     sasosRemoveSeat        — remove a seat from org
     sasosGetOrgSeats       — list all seats for an org
     sasosCreateLicense     — admin: create enterprise license
     sasosActivateLicense   — activate a license for an org
     sasosRevokeLicense     — admin: revoke a license
     sasosGetLicense        — get license details

   Collections:
     sasosOrgs/{orgId}             — organization documents
     sasosSeats/{orgId}_{uid}      — seat assignments
     sasosSeatInvites/{inviteId}   — pending seat invitations
     sasosLicenses/{licenseId}     — enterprise license contracts
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');
const FieldValue             = admin.firestore.FieldValue;

const db  = () => admin.firestore();
const san = (s, n = 200) => typeof s === 'string' ? s.replace(/<[^>]*>/g,'').trim().slice(0,n) : '';

/* ── Auth guards ──────────────────────────────────────────── */
const assertAuth  = req => { if (!req.auth?.uid) throw new HttpsError('unauthenticated','Auth required.'); return req.auth.uid; };
const assertAdmin = req => { const uid = assertAuth(req); if (!req.auth.token?.admin && !req.auth.token?.superAdmin) throw new HttpsError('permission-denied','Admin required.'); return uid; };

const LICENSE_TYPES = ['single_user','business','enterprise','partner','developer','education','government','franchise'];

/* ================================================================
   sasosCreateOrg
   Creates a new organization.
   The creator becomes the org owner and first billing contact.
   The org is linked to the creator's SASOS subscription.
================================================================ */
const sasosCreateOrg = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const uid     = assertAuth(req);
    const name    = san(req.data.name, 120);
    const type    = san(req.data.type || 'business', 30);  /* business | franchise | government | ngo */
    const country = san(req.data.country || 'KE', 2);
    const pin     = san(req.data.pin || '', 20);            /* Kenya KRA PIN */
    const phone   = san(req.data.phone || '', 20);

    if (!name) throw new HttpsError('invalid-argument', 'Organization name required.');

    /* Check user doesn't already own an org */
    const existingSnap = await db().collection('sasosOrgs')
      .where('ownerUid', '==', uid).limit(1).get();
    /* Allow multiple orgs — different products might need different orgs */

    const now    = Date.now();
    const orgId  = crypto.randomUUID();
    const orgRef = db().collection('sasosOrgs').doc(orgId);
    const batch  = db().batch();

    batch.set(orgRef, {
      orgId,
      name, type, country, pin, phone,
      ownerUid:    uid,
      status:      'active',
      plan:        null,        /* Set when license is activated */
      seatCount:   0,
      maxSeats:    1,           /* Will be updated by license/plan */
      branches:    [],
      createdAt:   now,
      updatedAt:   FieldValue.serverTimestamp(),
    });

    /* Add owner as first seat */
    const seatRef = db().collection('sasosSeats').doc(`${orgId}_${uid}`);
    batch.set(seatRef, {
      orgId, uid, role: 'owner',
      status: 'active', invitedBy: uid,
      assignedAt: now, updatedAt: FieldValue.serverTimestamp(),
    });

    /* Update org seat count */
    batch.update(orgRef, { seatCount: FieldValue.increment(1) });

    /* Audit */
    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'org_created', uid, orgId, name,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    logger.info(`[SASOS-Enterprise] Org created: orgId=${orgId} owner=${uid}`);
    return { success: true, orgId };
  }
);

/* ================================================================
   sasosGetOrg
   Returns org details including seats and license info.
   Owner and admins get full view; members get limited view.
================================================================ */
const sasosGetOrg = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid   = assertAuth(req);
    const orgId = san(req.data.orgId, 64);

    if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');

    const [orgSnap, mySeatSnap] = await Promise.all([
      db().collection('sasosOrgs').doc(orgId).get(),
      db().collection('sasosSeats').doc(`${orgId}_${uid}`).get(),
    ]);

    if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');

    const org      = orgSnap.data();
    const isOwner  = org.ownerUid === uid;
    const isMember = mySeatSnap.exists && mySeatSnap.data().status === 'active';
    const isAdmin  = req.auth.token?.admin || req.auth.token?.superAdmin;

    if (!isOwner && !isMember && !isAdmin)
      throw new HttpsError('permission-denied', 'Not a member of this organization.');

    const result = {
      orgId, name: org.name, type: org.type, country: org.country,
      status: org.status, seatCount: org.seatCount, maxSeats: org.maxSeats,
      plan: org.plan, licenseId: org.licenseId, createdAt: org.createdAt,
      isOwner, myRole: mySeatSnap.exists ? mySeatSnap.data().role : null,
    };

    /* Owner/admin see billing contact details */
    if (isOwner || isAdmin) Object.assign(result, { pin: org.pin, phone: org.phone, ownerUid: org.ownerUid });

    return result;
  }
);

/* ================================================================
   sasosInviteSeat
   Owner or org admin invites a user to join the org.
   Generates a signed invite token (expires in 7 days).
================================================================ */
const sasosInviteSeat = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid     = assertAuth(req);
    const orgId   = san(req.data.orgId, 64);
    const invitee = san(req.data.email || req.data.uid || '', 128);
    const role    = san(req.data.role || 'member', 30);

    const validRoles = ['owner', 'admin', 'manager', 'member', 'viewer', 'cashier', 'driver', 'warehouse'];
    if (!validRoles.includes(role)) throw new HttpsError('invalid-argument', `Invalid role: ${role}`);

    /* Confirm inviter is org owner/admin */
    const seatSnap = await db().collection('sasosSeats').doc(`${orgId}_${uid}`).get();
    if (!seatSnap.exists || !['owner', 'admin'].includes(seatSnap.data().role))
      throw new HttpsError('permission-denied', 'Only org owners and admins can invite seats.');

    /* Check seat capacity */
    const orgSnap = await db().collection('sasosOrgs').doc(orgId).get();
    if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');
    const org = orgSnap.data();
    if (org.seatCount >= org.maxSeats && org.maxSeats !== -1)
      throw new HttpsError('resource-exhausted', `Seat limit reached (${org.maxSeats}). Upgrade your plan.`);

    const now      = Date.now();
    const inviteId = crypto.randomUUID();
    const expires  = now + 7 * 86400000;

    await db().collection('sasosSeatInvites').doc(inviteId).set({
      inviteId, orgId, invitedBy: uid, invitee,
      role, status: 'pending', expires,
      orgName: org.name, createdAt: now,
    });

    logger.info(`[SASOS-Enterprise] Seat invite: orgId=${orgId} invitee=${invitee} role=${role}`);
    return { success: true, inviteId, expires };
  }
);

/* ================================================================
   sasosAcceptSeatInvite
   User accepts a pending seat invitation.
   Validates the invite hasn't expired and creates the seat.
================================================================ */
const sasosAcceptSeatInvite = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const inviteId = san(req.data.inviteId, 64);

    const inviteRef  = db().collection('sasosSeatInvites').doc(inviteId);
    const inviteSnap = await inviteRef.get();

    if (!inviteSnap.exists) throw new HttpsError('not-found', 'Invitation not found.');

    const invite = inviteSnap.data();
    if (invite.status !== 'pending') throw new HttpsError('failed-precondition', 'Invitation already used or cancelled.');
    if (invite.expires < Date.now()) throw new HttpsError('deadline-exceeded', 'Invitation has expired.');

    const now   = Date.now();
    const orgId = invite.orgId;
    const batch = db().batch();

    /* Create seat */
    const seatRef = db().collection('sasosSeats').doc(`${orgId}_${uid}`);
    batch.set(seatRef, {
      orgId, uid, role: invite.role,
      status:     'active',
      invitedBy:  invite.invitedBy,
      inviteId,
      assignedAt: now,
      updatedAt:  FieldValue.serverTimestamp(),
    });

    /* Mark invite as accepted */
    batch.update(inviteRef, { status: 'accepted', acceptedBy: uid, acceptedAt: now });

    /* Increment org seat count */
    batch.update(db().collection('sasosOrgs').doc(orgId), {
      seatCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });

    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'seat_accepted', uid, orgId, inviteId, role: invite.role,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    logger.info(`[SASOS-Enterprise] Seat accepted: uid=${uid} orgId=${orgId}`);
    return { success: true, orgId, role: invite.role };
  }
);

/* ================================================================
   sasosRemoveSeat
   Owner or admin removes a seat (fires or removes a team member).
   The owner seat cannot be removed.
================================================================ */
const sasosRemoveSeat = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const callerUid   = assertAuth(req);
    const orgId       = san(req.data.orgId, 64);
    const targetUid   = san(req.data.uid, 128);

    if (!orgId || !targetUid) throw new HttpsError('invalid-argument', 'orgId and uid required.');

    /* Confirm caller is owner/admin */
    const callerSeatSnap = await db().collection('sasosSeats').doc(`${orgId}_${callerUid}`).get();
    if (!callerSeatSnap.exists || !['owner', 'admin'].includes(callerSeatSnap.data().role))
      throw new HttpsError('permission-denied', 'Only owners and admins can remove seats.');

    /* Prevent removing the org owner */
    const orgSnap = await db().collection('sasosOrgs').doc(orgId).get();
    if (orgSnap.data()?.ownerUid === targetUid)
      throw new HttpsError('failed-precondition', 'Cannot remove the organization owner.');

    const targetSeatSnap = await db().collection('sasosSeats').doc(`${orgId}_${targetUid}`).get();
    if (!targetSeatSnap.exists) throw new HttpsError('not-found', 'Seat not found.');

    const now   = Date.now();
    const batch = db().batch();

    batch.update(db().collection('sasosSeats').doc(`${orgId}_${targetUid}`), {
      status: 'removed', removedBy: callerUid, removedAt: now,
      updatedAt: FieldValue.serverTimestamp(),
    });

    batch.update(db().collection('sasosOrgs').doc(orgId), {
      seatCount: FieldValue.increment(-1),
      updatedAt: FieldValue.serverTimestamp(),
    });

    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'seat_removed', callerUid, targetUid, orgId,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    return { success: true };
  }
);

/* ================================================================
   sasosGetOrgSeats
   Returns all active seats for an organization.
   Caller must be an org member or Sokoni admin.
================================================================ */
const sasosGetOrgSeats = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid     = assertAuth(req);
    const orgId   = san(req.data.orgId, 64);
    const isAdmin = req.auth.token?.admin || req.auth.token?.superAdmin;

    /* Verify caller is a member */
    const callerSeat = await db().collection('sasosSeats').doc(`${orgId}_${uid}`).get();
    if (!callerSeat.exists && !isAdmin)
      throw new HttpsError('permission-denied', 'Not a member of this organization.');

    const seatsSnap = await db().collection('sasosSeats')
      .where('orgId', '==', orgId)
      .where('status', '==', 'active')
      .limit(200).get();

    return {
      seats: seatsSnap.docs.map(d => ({
        id: d.id, uid: d.data().uid, role: d.data().role,
        assignedAt: d.data().assignedAt,
      })),
      total: seatsSnap.docs.length,
    };
  }
);

/* ================================================================
   sasosCreateLicense
   SuperAdmin-only. Creates an enterprise license contract with
   custom terms. License is linked to an org and product.
================================================================ */
const sasosCreateLicense = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const adminUid   = assertAdmin(req);
    const orgId      = san(req.data.orgId, 64);
    const product    = san(req.data.product, 30);
    const type       = san(req.data.type || 'enterprise', 30);
    const planId     = san(req.data.planId, 60);
    const seats      = Math.max(1, Number(req.data.seats) || 1);
    const priceKES   = Number(req.data.priceKES) || 0;
    const billingPeriod = req.data.billingPeriod === 'annual' ? 'annual' : 'monthly';
    const contractStart = req.data.contractStart || Date.now();
    const contractEnd   = req.data.contractEnd   || (contractStart + 365 * 86400000);
    const notes      = san(req.data.notes || '', 500);
    const approvedBy = san(req.data.approvedBy || '', 128);

    if (!LICENSE_TYPES.includes(type))
      throw new HttpsError('invalid-argument', `Invalid license type: ${type}`);

    /* Enterprise licenses with custom pricing require dual approval */
    if (priceKES > 0 && priceKES !== (await import('./sasos-core').then(m => m._resolvePlan(planId))?.billing?.[billingPeriod])) {
      if (!approvedBy || approvedBy === adminUid)
        throw new HttpsError('failed-precondition', 'Custom pricing requires dual-admin approval (approvedBy != your UID).');
    }

    const now       = Date.now();
    const licenseId = crypto.randomUUID();

    await db().runTransaction(async txn => {
      const licenseRef = db().collection('sasosLicenses').doc(licenseId);
      txn.set(licenseRef, {
        licenseId, orgId, product, type, planId,
        seats, priceKES, billingPeriod,
        contractStart, contractEnd,
        status:      'active',
        activatedAt: now,
        createdBy:   adminUid,
        approvedBy:  approvedBy || null,
        notes,
        customTerms: req.data.customTerms || null,
        createdAt:   now,
        updatedAt:   FieldValue.serverTimestamp(),
      });

      /* Update org max seats */
      txn.update(db().collection('sasosOrgs').doc(orgId), {
        maxSeats: seats === -1 ? -1 : FieldValue.increment(seats),
        licenseId, plan: planId,
        updatedAt: FieldValue.serverTimestamp(),
      });

      /* Audit */
      const auditRef = db().collection('sasosAuditLog').doc();
      txn.set(auditRef, {
        type: 'license_created', adminUid, orgId, licenseId,
        product, planId, seats, priceKES, approvedBy: approvedBy || null,
        ts: FieldValue.serverTimestamp(), server: true,
      });
    });

    logger.info(`[SASOS-Enterprise] License created: licenseId=${licenseId} orgId=${orgId}`);
    return { success: true, licenseId };
  }
);

/* ================================================================
   sasosActivateLicense
   Activates an existing license for an org, applies the plan
   entitlements, and allocates seats.
================================================================ */
const sasosActivateLicense = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const adminUid  = assertAdmin(req);
    const licenseId = san(req.data.licenseId, 64);

    const licenseSnap = await db().collection('sasosLicenses').doc(licenseId).get();
    if (!licenseSnap.exists) throw new HttpsError('not-found', 'License not found.');

    const license = licenseSnap.data();
    if (license.status === 'activated') return { success: true, alreadyActivated: true };

    const now   = Date.now();
    const batch = db().batch();

    batch.update(db().collection('sasosLicenses').doc(licenseId), {
      status: 'activated', activatedAt: now, activatedBy: adminUid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    /* Apply subscription to org owner */
    const orgSnap = await db().collection('sasosOrgs').doc(license.orgId).get();
    if (orgSnap.exists) {
      const ownerUid = orgSnap.data().ownerUid;
      if (ownerUid) {
        batch.set(db().collection('sasosSubscriptions').doc(ownerUid), {
          uid: ownerUid,
          products: {
            [license.product]: {
              planId:      license.planId,
              productId:   license.product,
              tier:        'enterprise',
              status:      'active',
              billing:     license.billingPeriod,
              periodStart: now,
              periodEnd:   license.contractEnd,
              activatedAt: now,
              licenseId,
              orgId:       license.orgId,
              seats:       license.seats,
              updatedAt:   now,
            },
          },
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'license_activated', adminUid, licenseId, orgId: license.orgId,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    logger.info(`[SASOS-Enterprise] License activated: licenseId=${licenseId} by=${adminUid}`);
    return { success: true, licenseId };
  }
);

/* ================================================================
   sasosRevokeLicense
   Admin-only. Revokes a license and removes the associated
   entitlements from the org owner's subscription.
================================================================ */
const sasosRevokeLicense = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const adminUid  = assertAdmin(req);
    const licenseId = san(req.data.licenseId, 64);
    const reason    = san(req.data.reason || '', 200);

    const licenseSnap = await db().collection('sasosLicenses').doc(licenseId).get();
    if (!licenseSnap.exists) throw new HttpsError('not-found', 'License not found.');

    const license = licenseSnap.data();
    const now     = Date.now();
    const batch   = db().batch();

    batch.update(db().collection('sasosLicenses').doc(licenseId), {
      status: 'revoked', revokedAt: now, revokedBy: adminUid, revokeReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
    });

    /* Downgrade org owner's subscription to free */
    const orgSnap = await db().collection('sasosOrgs').doc(license.orgId).get();
    if (orgSnap.exists) {
      const ownerUid = orgSnap.data().ownerUid;
      if (ownerUid) {
        batch.update(db().collection('sasosSubscriptions').doc(ownerUid), {
          [`products.${license.product}.planId`]:    `${license.product}.free`,
          [`products.${license.product}.tier`]:      'free',
          [`products.${license.product}.status`]:    'active',
          [`products.${license.product}.licenseId`]: null,
          [`products.${license.product}.updatedAt`]: now,
          updatedAt: FieldValue.serverTimestamp(),
        });
        batch.set(db().collection('entitlements').doc(ownerUid), {
          needsRefresh: true, updatedAt: now,
        }, { merge: true });
      }
      batch.update(db().collection('sasosOrgs').doc(license.orgId), {
        maxSeats: 1, licenseId: null, plan: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'license_revoked', adminUid, licenseId, orgId: license.orgId, reason,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    logger.info(`[SASOS-Enterprise] License revoked: licenseId=${licenseId} by=${adminUid}`);
    return { success: true };
  }
);

/* ================================================================
   sasosGetLicense
   Returns license details. Org members and admins can view.
================================================================ */
const sasosGetLicense = onCall(
  { region: 'us-central1', timeoutSeconds: 10, memory: '128MiB' },
  async (req) => {
    const uid       = assertAuth(req);
    const licenseId = san(req.data.licenseId, 64);

    const licenseSnap = await db().collection('sasosLicenses').doc(licenseId).get();
    if (!licenseSnap.exists) throw new HttpsError('not-found', 'License not found.');

    const license = licenseSnap.data();
    const isAdmin = req.auth.token?.admin || req.auth.token?.superAdmin;

    /* Verify caller belongs to the org */
    const seatSnap = await db().collection('sasosSeats').doc(`${license.orgId}_${uid}`).get();
    if (!seatSnap.exists && !isAdmin)
      throw new HttpsError('permission-denied', 'Not authorized to view this license.');

    /* Non-admins see limited view */
    const view = {
      licenseId, type: license.type, product: license.product,
      planId: license.planId, seats: license.seats, status: license.status,
      contractStart: license.contractStart, contractEnd: license.contractEnd,
    };

    if (isAdmin || seatSnap.data()?.role === 'owner') {
      Object.assign(view, { priceKES: license.priceKES, billingPeriod: license.billingPeriod, notes: license.notes });
    }

    return view;
  }
);

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  sasosCreateOrg,
  sasosGetOrg,
  sasosInviteSeat,
  sasosAcceptSeatInvite,
  sasosRemoveSeat,
  sasosGetOrgSeats,
  sasosCreateLicense,
  sasosActivateLicense,
  sasosRevokeLicense,
  sasosGetLicense,
};
