'use strict';
/**
 * SOKONI Universal Enterprise Onboarding Engine — backend handlers.
 * Collections: accounts/{uid}, accountDrafts/{uid}_{role},
 *              accountProfiles/{profileId}, accountSubscriptions/{id},
 *              accountHandles/{handle}
 */
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { HttpsError } = require('firebase-functions/v2/https');

const _CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function _genId(prefix, len = 8) {
  let s = prefix + '-';
  for (let i = 0; i < len; i++) s += _CHARS[Math.floor(Math.random() * _CHARS.length)];
  return s;
}
function _san(v, max = 500) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>"'`]/g, '').trim().slice(0, max);
}
function _assertAuth(req) {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return req.auth.uid;
}

const ID_PREFIX = {
  buyer: 'BUY', merchant: 'BIZ', provider: 'PRV', rider: 'RDR',
  driver: 'DRV', courier: 'CUR', property: 'PRP', hotel: 'HTL',
  restaurant: 'RST', pharmacy: 'PHM', events: 'EVT', employer: 'EMP',
  freelancer: 'FRL', distributor: 'DST', wholesaler: 'WSL',
  manufacturer: 'MFR', ngo: 'NGO', school: 'SCH', healthcare: 'MED',
  finance: 'FIN',
};
const VALID_ROLES = new Set(Object.keys(ID_PREFIX));

/* Post-onboarding landing page per role.
   RC1 STABILITY FIX: 12 of these previously pointed at *-dashboard.html files that
   DO NOT EXIST (hotel/restaurant/pharmacy/driver/courier/employer/freelancer/
   healthcare/manufacturer/ngo/school/finance), so those roles completed onboarding
   and landed on a 404 — a dead-end journey. Every entry below is now an EXISTING
   page. When a purpose-built dashboard ships, point the role back at it. */
const DASHBOARD_MAP = {
  buyer: 'index.html', merchant: 'pos.html', provider: 'provider-dashboard.html',
  rider: 'rider-dashboard.html', driver: 'driver.html',
  courier: 'driver.html', property: 'property-dashboard.html',
  hotel: 'bnb-manage.html', restaurant: 'pos.html',
  pharmacy: 'pos.html', events: 'event-manager.html',
  employer: 'job-post.html', freelancer: 'jobs.html',
  distributor: 'pos.html', wholesaler: 'pos.html',
  manufacturer: 'business-os.html', ngo: 'business-os.html',
  school: 'education.html', healthcare: 'healthcare.html',
  finance: 'business-os.html',
};

const CLAIM_KEY = {
  merchant: 'merchantId', provider: 'providerId', rider: 'riderId',
  driver: 'driverId', courier: 'courierId', property: 'propertyId',
  hotel: 'hotelId', restaurant: 'restaurantId', pharmacy: 'pharmacyId',
  events: 'eventsId', employer: 'employerId', freelancer: 'freelancerId',
  distributor: 'distributorId', wholesaler: 'wholesalerId',
  manufacturer: 'manufacturerId', ngo: 'ngoId', school: 'schoolId',
  healthcare: 'healthcareId', finance: 'financeId', buyer: 'buyerId',
};

// ── Subscription plans ──────────────────────────────────────────────────────
const PLANS = {
  buyer: [
    { tier: 'free',    label: 'Free',    price: 0,      commission: 0,    features: ['Browse & Buy', 'Order Tracking', 'Reviews'] },
    { tier: 'plus',    label: 'Plus',    price: 29900,  commission: 0,    features: ['Priority Support', 'Exclusive Deals', 'Early Access'], popular: false },
    { tier: 'premium', label: 'Premium', price: 59900,  commission: 0,    features: ['Free Delivery', '5% Cashback', 'AI Concierge'], popular: true },
  ],
  merchant: [
    { tier: 'free_trial',   label: 'Free Trial',   price: 0,      days: 14, commission: 0.20, limits: { branches: 1,  listings: 50   }, features: ['1 Branch', 'Basic POS', 'Analytics'] },
    { tier: 'starter',      label: 'Starter',      price: 99900,  commission: 0.15, limits: { branches: 2,  listings: 200  }, features: ['2 Branches', 'SmartPOS', 'Reports'] },
    { tier: 'professional', label: 'Professional', price: 249900, commission: 0.10, limits: { branches: 5,  listings: 500  }, features: ['5 Branches', 'AI', 'eTIMS', 'Advanced Analytics'], popular: true },
    { tier: 'business',     label: 'Business',     price: 499900, commission: 0.07, limits: { branches: 20, listings: 2000 }, features: ['20 Branches', 'Priority Support', 'Featured'] },
    { tier: 'enterprise',   label: 'Enterprise',   price: 999900, commission: 0.05, limits: { branches: -1, listings: -1   }, features: ['Unlimited', 'White-label', 'API', 'Dedicated Support'] },
  ],
  provider: [
    { tier: 'free_trial',   label: 'Free Trial',   price: 0,      days: 14, commission: 0.20, limits: { listings: 1,  leads: 5   }, features: ['1 Listing', '5 Leads/month'] },
    { tier: 'starter',      label: 'Starter',      price: 99900,  commission: 0.15, limits: { listings: 3,  leads: 20  }, features: ['3 Listings', '20 Leads', 'Calendar'] },
    { tier: 'professional', label: 'Professional', price: 249900, commission: 0.10, limits: { listings: 10, leads: 50  }, features: ['10 Listings', 'AI Matching', 'Portfolio'], popular: true },
    { tier: 'business',     label: 'Business',     price: 499900, commission: 0.07, limits: { listings: 25, leads: 100 }, features: ['25 Listings', 'Featured', 'Analytics'] },
    { tier: 'enterprise',   label: 'Enterprise',   price: 999900, commission: 0.05, limits: { listings: -1, leads: -1  }, features: ['Unlimited', 'API', 'White-label'] },
  ],
  rider: [
    { tier: 'basic',    label: 'Basic',    price: 0,     commission: 0.25, features: ['Unlimited Deliveries', 'Basic Support'] },
    { tier: 'standard', label: 'Standard', price: 49900, commission: 0.20, features: ['Priority Dispatch', 'Earnings Dashboard'] },
    { tier: 'premium',  label: 'Premium',  price: 99900, commission: 0.15, features: ['Top Priority', 'Insurance Cover', 'Fuel Discount'], popular: true },
  ],
  property: [
    { tier: 'starter',      label: 'Starter',      price: 99900,  commission: 0.05, limits: { units: 5   }, features: ['5 Units', 'Rent Collection', 'Maintenance'] },
    { tier: 'professional', label: 'Professional', price: 249900, commission: 0.04, limits: { units: 25  }, features: ['25 Units', 'Analytics', 'Tenant Portal'], popular: true },
    { tier: 'business',     label: 'Business',     price: 499900, commission: 0.03, limits: { units: 100 }, features: ['100 Units', 'Multi-Property', 'AI Insights'] },
    { tier: 'enterprise',   label: 'Enterprise',   price: 999900, commission: 0.02, limits: { units: -1  }, features: ['Unlimited', 'API', 'White-label'] },
  ],
  hotel: [
    { tier: 'starter',      label: 'Starter',      price: 199900, commission: 0.05, limits: { rooms: 20  }, features: ['20 Rooms', 'Booking Engine', 'Calendar'] },
    { tier: 'professional', label: 'Professional', price: 399900, commission: 0.04, limits: { rooms: 100 }, features: ['100 Rooms', 'Channel Manager', 'Analytics'], popular: true },
    { tier: 'enterprise',   label: 'Enterprise',   price: 799900, commission: 0.03, limits: { rooms: -1  }, features: ['Unlimited', 'API', 'Dedicated Support'] },
  ],
  restaurant: [
    { tier: 'starter',      label: 'Starter',      price: 99900,  commission: 0.08, limits: { outlets: 1 }, features: ['1 Outlet', 'Digital Menu', 'Orders'] },
    { tier: 'professional', label: 'Professional', price: 249900, commission: 0.06, limits: { outlets: 5 }, features: ['5 Outlets', 'KDS', 'Analytics'], popular: true },
    { tier: 'enterprise',   label: 'Enterprise',   price: 499900, commission: 0.04, limits: { outlets: -1}, features: ['Unlimited', 'White-label App', 'API'] },
  ],
  healthcare: [
    { tier: 'clinic',    label: 'Clinic',    price: 249900, commission: 0.03, limits: { doctors: 5  }, features: ['5 Doctors', 'Appointments', 'EMR'] },
    { tier: 'hospital',  label: 'Hospital',  price: 499900, commission: 0.02, limits: { doctors: 20 }, features: ['20 Doctors', 'Full EMR', 'Lab', 'Pharmacy'], popular: true },
    { tier: 'enterprise',label: 'Enterprise',price: 999900, commission: 0.01, limits: { doctors: -1 }, features: ['Unlimited', 'API', 'NHIF Integration'] },
  ],
  employer: [
    { tier: 'free',       label: 'Free',       price: 0,      commission: 0, limits: { jobs: 1  }, features: ['1 Active Job', 'Basic Search'] },
    { tier: 'starter',    label: 'Starter',    price: 249900, commission: 0, limits: { jobs: 5  }, features: ['5 Jobs', 'Featured Listing', 'Applicant Tracking'] },
    { tier: 'business',   label: 'Business',   price: 499900, commission: 0, limits: { jobs: 25 }, features: ['25 Jobs', 'Analytics', 'AI Screening'], popular: true },
    { tier: 'enterprise', label: 'Enterprise', price: 999900, commission: 0, limits: { jobs: -1 }, features: ['Unlimited', 'API', 'Dedicated Recruiter'] },
  ],
};
// Default generic plan for roles without a specific plan set
const _genericPlan = (role) => [
  { tier: 'starter',      label: 'Starter',      price: 99900,  commission: 0.05, features: ['Core Features', 'Analytics', 'Support'] },
  { tier: 'professional', label: 'Professional', price: 249900, commission: 0.04, features: ['All Starter', 'AI Tools', 'Priority Support'], popular: true },
  { tier: 'enterprise',   label: 'Enterprise',   price: 499900, commission: 0.03, features: ['Unlimited', 'API', 'White-label'] },
];
['driver','courier','pharmacy','events','freelancer','distributor',
 'wholesaler','manufacturer','ngo','school','finance'].forEach(r => { PLANS[r] = _genericPlan(r); });

// ── Handlers ─────────────────────────────────────────────────────────────────
const _h = {};

_h.onbGetAccount = async (req) => {
  const uid = _assertAuth(req);
  const db = getFirestore();
  const snap = await db.collection('accounts').doc(uid).get();
  if (!snap.exists) {
    const doc = {
      uid, roles: [], currentRole: null, currentProfileId: null, profiles: {},
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    };
    await db.collection('accounts').doc(uid).set(doc);
    return { account: { ...doc }, isNew: true };
  }
  return { account: snap.data(), isNew: false };
};

_h.onbSaveDraft = async (req) => {
  const uid = _assertAuth(req);
  const role = _san(req.data?.role || '');
  const step = parseInt(req.data?.step) || 0;
  const data = req.data?.data || {};
  if (!VALID_ROLES.has(role)) throw new HttpsError('invalid-argument', 'Invalid role.');
  const db = getFirestore();
  await db.collection('accountDrafts').doc(`${uid}_${role}`).set({
    accountId: uid, role, currentStep: step,
    [`stepData.step${step}`]: data,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { saved: true };
};

_h.onbGetDraft = async (req) => {
  const uid = _assertAuth(req);
  const role = _san(req.data?.role || '');
  if (!VALID_ROLES.has(role)) throw new HttpsError('invalid-argument', 'Invalid role.');
  const db = getFirestore();
  const snap = await db.collection('accountDrafts').doc(`${uid}_${role}`).get();
  return snap.exists ? snap.data() : null;
};

_h.onbActivateRole = async (req) => {
  const uid = _assertAuth(req);
  const role = _san(req.data?.role || '');
  if (!VALID_ROLES.has(role)) throw new HttpsError('invalid-argument', 'Invalid role.');
  const db = getFirestore();
  const auth = getAuth();
  const prefix = ID_PREFIX[role];
  let profileId, attempts = 0;
  do {
    profileId = _genId(prefix);
    const ex = await db.collection('accountProfiles').doc(profileId).get();
    if (!ex.exists) break;
  } while (++attempts < 5);
  if (attempts >= 5) throw new HttpsError('internal', 'Could not generate unique profile ID.');
  const profileData = req.data?.profileData || {};
  const now = FieldValue.serverTimestamp();
  await db.runTransaction(async (tx) => {
    tx.set(db.collection('accountProfiles').doc(profileId), {
      profileId, accountId: uid, role, status: 'active',
      onboardingComplete: true, data: profileData,
      createdAt: now, updatedAt: now,
    });
    tx.set(db.collection('accounts').doc(uid), {
      roles: FieldValue.arrayUnion(role),
      currentRole: role, currentProfileId: profileId,
      [`profiles.${role}`]: profileId,
      updatedAt: now,
    }, { merge: true });
    tx.set(db.collection('accountDrafts').doc(`${uid}_${role}`), {
      completed: true, profileId, updatedAt: now,
    }, { merge: true });
  });
  const existing = await auth.getUser(uid);
  const claims = existing.customClaims || {};
  const ck = CLAIM_KEY[role] || `${role}Id`;
  await auth.setCustomUserClaims(uid, { ...claims, [role]: true, [ck]: profileId });
  return { profileId, role, activated: true, dashboard: DASHBOARD_MAP[role] || 'index.html' };
};

_h.onbSwitchRole = async (req) => {
  const uid = _assertAuth(req);
  const role = _san(req.data?.role || '');
  const db = getFirestore();
  const snap = await db.collection('accounts').doc(uid).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Account not found.');
  const account = snap.data();
  if (!account.roles?.includes(role)) throw new HttpsError('permission-denied', 'Role not activated for this account.');
  const profileId = account.profiles?.[role] || null;
  await db.collection('accounts').doc(uid).update({
    currentRole: role, currentProfileId: profileId,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { role, profileId, dashboard: DASHBOARD_MAP[role] || 'index.html' };
};

_h.onbGetProfiles = async (req) => {
  const uid = _assertAuth(req);
  const db = getFirestore();
  const snap = await db.collection('accounts').doc(uid).get();
  if (!snap.exists) return { profiles: [], account: null };
  const account = snap.data();
  const ids = Object.values(account.profiles || {});
  if (!ids.length) return { profiles: [], account };
  const snaps = await Promise.all(ids.map(id => db.collection('accountProfiles').doc(id).get()));
  return { profiles: snaps.filter(s => s.exists).map(s => s.data()), account };
};

_h.onbGetPlans = async (req) => {
  const role = _san(req.data?.role || '');
  return { plans: PLANS[role] || _genericPlan(role) };
};

_h.onbActivateSubscription = async (req) => {
  const uid = _assertAuth(req);
  const role      = _san(req.data?.role || '');
  const tier      = _san(req.data?.tier || '');
  const cycle     = _san(req.data?.billingCycle || 'monthly');
  const profileId = _san(req.data?.profileId || '');
  const payRef    = _san(req.data?.paymentRef || '');
  if (!VALID_ROLES.has(role)) throw new HttpsError('invalid-argument', 'Invalid role.');
  const plans = PLANS[role] || _genericPlan(role);
  const plan = plans.find(p => p.tier === tier);
  if (!plan) throw new HttpsError('not-found', `Plan "${tier}" not found for role "${role}".`);
  const db = getFirestore();
  const subId = _genId('SUB');
  const now = new Date();
  const end = new Date(now);
  if (plan.days) end.setDate(end.getDate() + plan.days);
  else end.setMonth(end.getMonth() + (cycle === 'yearly' ? 12 : 1));
  const price = cycle === 'yearly' ? Math.round((plan.price || 0) * 10) : (plan.price || 0);
  await getFirestore().collection('accountSubscriptions').doc(subId).set({
    subscriptionId: subId, accountId: uid, profileId, role,
    product: `${role}_plans`, tier, billingCycle: cycle, price, currency: 'KES',
    status: plan.days ? 'trialing' : 'active', trial: !!plan.days,
    trialEndsAt: plan.days ? Timestamp.fromDate(end) : null,
    currentPeriodStart: FieldValue.serverTimestamp(),
    currentPeriodEnd: Timestamp.fromDate(end),
    renewalAt: Timestamp.fromDate(end),
    paymentRef, paymentMethod: req.data?.paymentMethod || null,
    commissionRate: plan.commission ?? 0,
    limits: plan.limits || {}, features: plan.features || [],
    cancelledAt: null,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  if (profileId) {
    await db.collection('accountProfiles').doc(profileId).update({
      subscriptionId: subId, subscriptionTier: tier,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
  return { subscriptionId: subId, tier, status: plan.days ? 'trialing' : 'active', endsAt: end.toISOString() };
};

_h.onbGetDashboard = async (req) => {
  const uid = _assertAuth(req);
  const snap = await getFirestore().collection('accounts').doc(uid).get();
  if (!snap.exists) return { url: 'onboarding.html', roles: [], currentRole: null };
  const a = snap.data();
  const role = a.currentRole || (a.roles?.[0] ?? null);
  return {
    url: role ? (DASHBOARD_MAP[role] || 'index.html') : 'onboarding.html',
    role, profileId: a.currentProfileId, roles: a.roles || [], profiles: a.profiles || {},
  };
};

_h.onbUpdateProfile = async (req) => {
  const uid = _assertAuth(req);
  const profileId = _san(req.data?.profileId || '');
  const data = req.data?.data || {};
  if (!profileId) throw new HttpsError('invalid-argument', 'profileId required.');
  const db = getFirestore();
  const snap = await db.collection('accountProfiles').doc(profileId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Profile not found.');
  if (snap.data().accountId !== uid) throw new HttpsError('permission-denied', 'Not your profile.');
  await db.collection('accountProfiles').doc(profileId).update({
    data: { ...snap.data().data, ...data },
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { updated: true };
};

_h.onbCheckHandle = async (req) => {
  const handle = _san(req.data?.handle || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (handle.length < 3) throw new HttpsError('invalid-argument', 'Handle too short (min 3 chars).');
  const snap = await getFirestore().collection('accountHandles').doc(handle).get();
  return { handle, available: !snap.exists };
};

module.exports = { _h };
