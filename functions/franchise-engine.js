/* ================================================================
   SOKONI Franchise Management Engine v1.0
   7 Cloud Functions (Gen 2, us-central1):

     franchiseCreateBrand          — admin: create a franchise brand
     franchiseApplyForLocation     — auth:  franchisee applies for a location
     franchiseReviewApplication    — admin: approve or reject an application
     franchiseRecordRoyalty        — auth:  record monthly revenue + calculate royalty due
     franchiseGetMyLocations       — auth:  franchisee's own locations
     franchiseGetBrandDashboard    — admin: aggregate stats for one brand
     franchiseGetLocations         — admin: all locations, optional brandId/status filter

   Collections:
     franchiseBrands/{brandId}
     franchiseApplications/{appId}
     franchiseLocations/{locId}
     royaltyPayments/{payId}
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';

/* ── Lazy Firestore ── */
const db  = () => admin.firestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();

/* ── Auth helpers ── */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required.');
  return req.auth;
}

function _requireAdmin(req) {
  const auth = _requireAuth(req);
  if (!auth.token?.admin && !auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
  return auth;
}

/* ── Audit logger ── */
async function _audit(action, actorUid, meta = {}) {
  try {
    await db().collection('franchiseAudit').add({
      action, actorUid, ...meta, createdAt: now(),
    });
  } catch (e) {
    logger.warn('audit write failed', { action, actorUid, err: e.message });
  }
}

/* ── Notification helper ── */
async function _notify(uid, type, payload) {
  try {
    await db().collection('notifications').add({
      uid, type, ...payload, read: false, createdAt: now(),
    });
  } catch (_) {}
}

/* ── Input sanitiser (basic XSS guard for strings stored in Firestore) ── */
function _sanitise(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&(?!(?:amp|lt|gt|quot|#\d+);)/g, '&amp;')
    .trim()
    .slice(0, maxLen);
}

/* ── Numeric guard ── */
function _requireNumber(val, name, min = 0, max = Infinity) {
  if (typeof val !== 'number' || !isFinite(val) || val < min || val > max) {
    throw new HttpsError('invalid-argument', `${name} must be a number between ${min} and ${max}.`);
  }
}

/* ── Alphanumeric month guard: "2026-07" ── */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function _requireMonth(val) {
  if (!val || !MONTH_RE.test(val)) {
    throw new HttpsError('invalid-argument', 'month must be in YYYY-MM format (e.g. "2026-07").');
  }
}

/* ════════════════════════════════════════════════════════════
   CF 1.  franchiseCreateBrand
   Admin creates a new franchise brand record.
   Input: { name, description, royaltyPct, techFeePct, minInvestment, territories }
════════════════════════════════════════════════════════════ */
exports.franchiseCreateBrand = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    const admin_ = _requireAdmin(req);
    const { name, description, royaltyPct, techFeePct, minInvestment, territories } = req.data || {};

    /* Validate */
    const safeName = _sanitise(name, 120);
    if (!safeName) throw new HttpsError('invalid-argument', 'name is required.');
    _requireNumber(royaltyPct,    'royaltyPct',    0, 50);
    _requireNumber(techFeePct,    'techFeePct',    0, 30);
    _requireNumber(minInvestment, 'minInvestment', 0);

    const safeDesc        = _sanitise(description || '', 1000);
    const safeTerritories = Array.isArray(territories)
      ? territories.map(t => _sanitise(String(t), 100)).filter(Boolean)
      : [];

    const doc = {
      name:          safeName,
      description:   safeDesc,
      royaltyPct,
      techFeePct,
      minInvestment,
      territories:   safeTerritories,
      status:        'active',
      createdBy:     admin_.uid,
      createdAt:     now(),
      updatedAt:     now(),
    };

    const ref  = await db().collection('franchiseBrands').add(doc);
    const brandId = ref.id;

    await _audit('franchise_brand_created', admin_.uid, { brandId, name: safeName });
    logger.info('franchiseCreateBrand', { brandId, name: safeName, actor: admin_.uid });

    return { success: true, brandId, message: `Franchise brand "${safeName}" created.` };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 2.  franchiseApplyForLocation
   Authenticated user submits an application for a franchise location.
   Input: { brandId, proposedLocation, investmentAmount, businessPlan }
════════════════════════════════════════════════════════════ */
exports.franchiseApplyForLocation = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    const auth = _requireAuth(req);
    const { brandId, proposedLocation, investmentAmount, businessPlan } = req.data || {};

    /* Validate */
    if (!brandId || typeof brandId !== 'string') throw new HttpsError('invalid-argument', 'brandId required.');

    const safeLoc  = _sanitise(proposedLocation || '', 300);
    if (!safeLoc)  throw new HttpsError('invalid-argument', 'proposedLocation required.');

    _requireNumber(investmentAmount, 'investmentAmount', 1);

    const safePlan = _sanitise(businessPlan || '', 5000);

    /* Confirm brand exists and is active */
    const brandSnap = await db().collection('franchiseBrands').doc(brandId).get();
    if (!brandSnap.exists) throw new HttpsError('not-found', 'Franchise brand not found.');
    const brand = brandSnap.data();
    if (brand.status !== 'active') throw new HttpsError('failed-precondition', 'Franchise brand is not accepting applications.');

    /* Investment floor check */
    if (investmentAmount < brand.minInvestment) {
      throw new HttpsError('invalid-argument',
        `Minimum investment for this brand is KES ${brand.minInvestment.toLocaleString()}.`);
    }

    const doc = {
      brandId,
      brandName:        brand.name,
      applicantUid:     auth.uid,
      applicantEmail:   auth.token?.email || '',
      proposedLocation: safeLoc,
      investmentAmount,
      businessPlan:     safePlan,
      status:           'pending',
      submittedAt:      now(),
      updatedAt:        now(),
      reviewNotes:      '',
    };

    const ref   = await db().collection('franchiseApplications').add(doc);
    const appId = ref.id;

    await _audit('franchise_application_submitted', auth.uid, { appId, brandId, brandName: brand.name });
    logger.info('franchiseApplyForLocation', { appId, brandId, applicant: auth.uid });

    return { success: true, applicationId: appId, message: 'Application submitted. You will be notified once reviewed.' };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 3.  franchiseReviewApplication
   Admin approves or rejects a pending application.
   Input: { applicationId, action: 'approve'|'reject', notes }
   On approve: creates franchiseLocations/{locId} with status:'active'
════════════════════════════════════════════════════════════ */
exports.franchiseReviewApplication = onCall(
  { region: REGION, timeoutSeconds: 45 },
  async (req) => {
    const admin_ = _requireAdmin(req);
    const { applicationId, action, notes } = req.data || {};

    if (!applicationId || typeof applicationId !== 'string') throw new HttpsError('invalid-argument', 'applicationId required.');
    if (!['approve', 'reject'].includes(action)) throw new HttpsError('invalid-argument', 'action must be "approve" or "reject".');

    const safeNotes = _sanitise(notes || '', 1000);

    const appRef  = db().collection('franchiseApplications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) throw new HttpsError('not-found', 'Application not found.');

    const app = appSnap.data();
    if (app.status !== 'pending') {
      throw new HttpsError('failed-precondition', `Application is already "${app.status}" and cannot be reviewed again.`);
    }

    /* Load brand for royalty metadata */
    const brandSnap = await db().collection('franchiseBrands').doc(app.brandId).get();
    if (!brandSnap.exists) throw new HttpsError('not-found', 'Associated brand not found.');
    const brand = brandSnap.data();

    let locationId = null;

    if (action === 'approve') {
      /* Transactional: update application + create location atomically */
      const batch = db().batch();

      const locRef = db().collection('franchiseLocations').doc();
      locationId   = locRef.id;

      /* Estimate monthly royalty as % of reported gross — seeded at 0 until first revenue record */
      const locDoc = {
        brandId:           app.brandId,
        brandName:         brand.name,
        ownerId:           app.applicantUid,
        ownerEmail:        app.applicantEmail,
        address:           app.proposedLocation,
        investmentAmount:  app.investmentAmount,
        royaltyPct:        brand.royaltyPct,
        techFeePct:        brand.techFeePct,
        status:            'active',
        monthlyRoyaltyDue: 0,          /* updated when revenue is recorded */
        lastRevenueMonth:  null,
        applicationId,
        activatedAt:       now(),
        createdAt:         now(),
        updatedAt:         now(),
      };

      batch.set(locRef, locDoc);
      batch.update(appRef, {
        status:     'approved',
        locationId,
        reviewedBy: admin_.uid,
        reviewNotes: safeNotes,
        reviewedAt: now(),
        updatedAt:  now(),
      });

      await batch.commit();

      /* Notify franchisee */
      await _notify(app.applicantUid, 'franchise_approved', {
        title:   'Franchise Application Approved!',
        body:    `Your application for ${brand.name} at ${app.proposedLocation} has been approved.`,
        locationId,
      });

    } else {
      /* Reject */
      await appRef.update({
        status:      'rejected',
        reviewedBy:  admin_.uid,
        reviewNotes: safeNotes,
        reviewedAt:  now(),
        updatedAt:   now(),
      });

      await _notify(app.applicantUid, 'franchise_rejected', {
        title:  'Franchise Application Update',
        body:   `Your application for ${brand.name} was not approved at this time.`,
        notes:  safeNotes,
      });
    }

    await _audit('franchise_application_reviewed', admin_.uid, {
      applicationId, action, locationId, brandId: app.brandId,
    });

    logger.info('franchiseReviewApplication', { applicationId, action, actor: admin_.uid, locationId });
    return {
      success: true,
      action,
      locationId,
      message: action === 'approve'
        ? `Application approved. Location ${locationId} created.`
        : 'Application rejected. Franchisee notified.',
    };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 4.  franchiseRecordRoyalty
   Franchisee records their monthly gross revenue.
   Royalty = grossRevenue × brand.royaltyPct / 100.
   Input: { locationId, month, grossRevenue }
════════════════════════════════════════════════════════════ */
exports.franchiseRecordRoyalty = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    const auth = _requireAuth(req);
    const { locationId, month, grossRevenue } = req.data || {};

    if (!locationId || typeof locationId !== 'string') throw new HttpsError('invalid-argument', 'locationId required.');
    _requireMonth(month);
    _requireNumber(grossRevenue, 'grossRevenue', 0);

    /* Load location and verify ownership */
    const locRef  = db().collection('franchiseLocations').doc(locationId);
    const locSnap = await locRef.get();
    if (!locSnap.exists) throw new HttpsError('not-found', 'Franchise location not found.');

    const loc = locSnap.data();
    if (loc.ownerId !== auth.uid) {
      throw new HttpsError('permission-denied', 'You do not own this franchise location.');
    }
    if (loc.status !== 'active') {
      throw new HttpsError('failed-precondition', 'Franchise location is not active.');
    }

    /* Prevent duplicate revenue submission for same month */
    const dupCheck = await db()
      .collection('royaltyPayments')
      .where('locationId', '==', locationId)
      .where('month', '==', month)
      .limit(1)
      .get();

    if (!dupCheck.empty) {
      throw new HttpsError('already-exists', `Revenue for ${month} at this location has already been recorded.`);
    }

    /* Calculate royalty */
    const royaltyAmt  = Math.round((grossRevenue * loc.royaltyPct) / 100 * 100) / 100;  /* 2 d.p. */
    const techFeeAmt  = Math.round((grossRevenue * loc.techFeePct)  / 100 * 100) / 100;
    const totalDue    = Math.round((royaltyAmt + techFeeAmt) * 100) / 100;

    /* Create royalty payment record */
    const payDoc = {
      locationId,
      locationAddress: loc.address,
      brandId:         loc.brandId,
      brandName:       loc.brandName,
      ownerId:         auth.uid,
      month,
      grossRevenue,
      royaltyPct:      loc.royaltyPct,
      royaltyAmount:   royaltyAmt,
      techFeePct:      loc.techFeePct,
      techFeeAmount:   techFeeAmt,
      totalDue,
      status:          'due',
      currency:        'KES',
      recordedAt:      now(),
      createdAt:       now(),
      updatedAt:       now(),
    };

    const payRef = await db().collection('royaltyPayments').add(payDoc);

    /* Update location with latest royalty due and month */
    await locRef.update({
      monthlyRoyaltyDue: totalDue,
      lastRevenueMonth:  month,
      updatedAt:         now(),
    });

    await _audit('franchise_royalty_recorded', auth.uid, {
      paymentId: payRef.id, locationId, month, grossRevenue, totalDue,
    });

    logger.info('franchiseRecordRoyalty', {
      paymentId: payRef.id, locationId, month, grossRevenue, royaltyAmt, techFeeAmt,
    });

    return {
      success:        true,
      paymentId:      payRef.id,
      month,
      grossRevenue,
      royaltyAmount:  royaltyAmt,
      techFeeAmount:  techFeeAmt,
      totalDue,
      currency:       'KES',
      message:        `Revenue recorded. Total due: KES ${totalDue.toLocaleString()}.`,
    };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 5.  franchiseGetMyLocations
   Returns all franchise locations owned by the calling user,
   along with recent royalty payment history per location.
════════════════════════════════════════════════════════════ */
exports.franchiseGetMyLocations = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    const auth = _requireAuth(req);

    const locSnap = await db()
      .collection('franchiseLocations')
      .where('ownerId', '==', auth.uid)
      .orderBy('createdAt', 'desc')
      .get();

    const locations = [];

    for (const doc of locSnap.docs) {
      const loc = { id: doc.id, ...doc.data() };

      /* Timestamps → ISO strings (safe for JSON serialisation) */
      if (loc.createdAt?.toDate)  loc.createdAt  = loc.createdAt.toDate().toISOString();
      if (loc.activatedAt?.toDate) loc.activatedAt = loc.activatedAt.toDate().toISOString();
      if (loc.updatedAt?.toDate)  loc.updatedAt  = loc.updatedAt.toDate().toISOString();

      /* Fetch last 6 royalty payments for this location */
      const paySnap = await db()
        .collection('royaltyPayments')
        .where('locationId', '==', doc.id)
        .orderBy('month', 'desc')
        .limit(6)
        .get();

      loc.royaltyHistory = paySnap.docs.map(p => {
        const d = { id: p.id, ...p.data() };
        if (d.recordedAt?.toDate) d.recordedAt = d.recordedAt.toDate().toISOString();
        if (d.createdAt?.toDate)  d.createdAt  = d.createdAt.toDate().toISOString();
        if (d.updatedAt?.toDate)  d.updatedAt  = d.updatedAt.toDate().toISOString();
        return d;
      });

      locations.push(loc);
    }

    return { success: true, locations };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 6.  franchiseGetBrandDashboard
   Admin aggregated stats for a single franchise brand.
   Input: { brandId }
   Returns: { totalLocations, totalRoyaltiesThisMonth, topLocations, complianceRate }
════════════════════════════════════════════════════════════ */
exports.franchiseGetBrandDashboard = onCall(
  { region: REGION, timeoutSeconds: 45 },
  async (req) => {
    _requireAdmin(req);
    const { brandId } = req.data || {};
    if (!brandId || typeof brandId !== 'string') throw new HttpsError('invalid-argument', 'brandId required.');

    /* Brand record */
    const brandSnap = await db().collection('franchiseBrands').doc(brandId).get();
    if (!brandSnap.exists) throw new HttpsError('not-found', 'Franchise brand not found.');
    const brand = { id: brandId, ...brandSnap.data() };
    if (brand.createdAt?.toDate) brand.createdAt = brand.createdAt.toDate().toISOString();

    /* All locations for this brand */
    const locSnap = await db()
      .collection('franchiseLocations')
      .where('brandId', '==', brandId)
      .get();

    const totalLocations = locSnap.size;
    const activeLocations = locSnap.docs.filter(d => d.data().status === 'active').length;

    /* Current month key */
    const now_  = new Date();
    const currentMonth = `${now_.getFullYear()}-${String(now_.getMonth() + 1).padStart(2, '0')}`;

    /* Royalty payments this month */
    const roySnap = await db()
      .collection('royaltyPayments')
      .where('brandId', '==', brandId)
      .where('month', '==', currentMonth)
      .get();

    let totalRoyaltiesThisMonth = 0;
    const locationRevenue = {};   /* locationId → { grossRevenue, totalDue, address } */

    for (const doc of roySnap.docs) {
      const p = doc.data();
      totalRoyaltiesThisMonth += p.totalDue || 0;
      locationRevenue[p.locationId] = {
        grossRevenue:  (locationRevenue[p.locationId]?.grossRevenue || 0) + (p.grossRevenue || 0),
        totalDue:      (locationRevenue[p.locationId]?.totalDue     || 0) + (p.totalDue     || 0),
        address:       p.locationAddress || '',
      };
    }

    /* Top 5 locations by gross revenue this month */
    const topLocations = Object.entries(locationRevenue)
      .sort((a, b) => b[1].grossRevenue - a[1].grossRevenue)
      .slice(0, 5)
      .map(([id, data]) => ({ locationId: id, ...data }));

    /* Compliance rate: % of active locations that submitted revenue this month */
    const submittedCount   = new Set(roySnap.docs.map(d => d.data().locationId)).size;
    const complianceRate   = activeLocations > 0
      ? Math.round((submittedCount / activeLocations) * 100)
      : 0;

    /* Pending applications */
    const pendingSnap = await db()
      .collection('franchiseApplications')
      .where('brandId', '==', brandId)
      .where('status', '==', 'pending')
      .get();

    return {
      success: true,
      brand,
      currentMonth,
      totalLocations,
      activeLocations,
      totalRoyaltiesThisMonth: Math.round(totalRoyaltiesThisMonth * 100) / 100,
      topLocations,
      complianceRate,
      pendingApplications: pendingSnap.size,
    };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 7.  franchiseGetLocations
   Admin retrieves all franchise locations, with optional filters.
   Input: { brandId?, status? }
════════════════════════════════════════════════════════════ */
exports.franchiseGetLocations = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    _requireAdmin(req);
    const { brandId, status } = req.data || {};

    let q = db().collection('franchiseLocations').orderBy('createdAt', 'desc');
    if (brandId) q = q.where('brandId', '==', brandId);
    if (status)  q = q.where('status',  '==', status);

    const snap = await q.limit(200).get();

    const locations = snap.docs.map(doc => {
      const d = { id: doc.id, ...doc.data() };
      if (d.createdAt?.toDate)   d.createdAt   = d.createdAt.toDate().toISOString();
      if (d.activatedAt?.toDate) d.activatedAt = d.activatedAt.toDate().toISOString();
      if (d.updatedAt?.toDate)   d.updatedAt   = d.updatedAt.toDate().toISOString();
      return d;
    });

    return { success: true, total: locations.length, locations };
  }
);
