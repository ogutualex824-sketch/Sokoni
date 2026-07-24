'use strict';
/**
 * SOKONI Provider Onboarding — 18 onCall handlers.
 * All route through providerDispatch; no individual Cloud Run services.
 *
 * Collections written:
 *   providerProfiles / providerSubscriptions / providerAvailability
 *   providerPortfolio / providerBookings / providerVerification
 *   providerSettings  / providerNotifications / providerCalendar
 *   providerServices  / providerPayouts / providerAnalytics
 *   providerReviews
 */

const { HttpsError }      = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }         = require('firebase-admin/auth');
const logger              = require('firebase-functions/logger');

const _db  = () => getFirestore();
const _auth = () => getAuth();
const _ts  = () => FieldValue.serverTimestamp();
const _san = (v, n = 200) => String(v || '').slice(0, n).replace(/[<>"']/g, '');

/* ── Subscription plan catalogue ────────────────────────────────────────────── */
const PLANS = {
  free_trial: {
    name: 'Free Trial', monthly: 0, yearly: 0, trialDays: 14,
    commissionRate: 0.20,
    limits: { listings: 1, leadsPerMonth: 5, staff: 0 },
    features: {
      bookings: true, calendar: false, portfolio: false, ai: false,
      analytics: false, invoices: false, messaging: true,
      verification: false, featured: false, priorityRanking: false,
      api: false, whiteLabel: false,
    },
  },
  starter: {
    name: 'Starter', monthly: 99900, yearly: 999000, trialDays: 0,
    commissionRate: 0.15,
    limits: { listings: 3, leadsPerMonth: 20, staff: 0 },
    features: {
      bookings: true, calendar: true, portfolio: false, ai: false,
      analytics: 'basic', invoices: false, messaging: true,
      verification: true, featured: false, priorityRanking: false,
      api: false, whiteLabel: false,
    },
  },
  professional: {
    name: 'Professional', monthly: 249900, yearly: 2499000, trialDays: 0,
    commissionRate: 0.10,
    limits: { listings: 10, leadsPerMonth: 50, staff: 1 },
    features: {
      bookings: true, calendar: true, portfolio: true, ai: true,
      analytics: 'advanced', invoices: true, messaging: true,
      verification: true, featured: false, priorityRanking: true,
      api: false, whiteLabel: false,
    },
  },
  business: {
    name: 'Business', monthly: 499900, yearly: 4999000, trialDays: 0,
    commissionRate: 0.07,
    limits: { listings: 25, leadsPerMonth: 100, staff: 3 },
    features: {
      bookings: true, calendar: true, portfolio: true, ai: true,
      analytics: 'advanced', invoices: true, messaging: true,
      verification: true, featured: true, priorityRanking: true,
      api: false, whiteLabel: false,
    },
  },
  enterprise: {
    name: 'Enterprise', monthly: 999900, yearly: 9999000, trialDays: 0,
    commissionRate: 0.05,
    limits: { listings: -1, leadsPerMonth: -1, staff: -1 },
    features: {
      bookings: true, calendar: true, portfolio: true, ai: true,
      analytics: 'enterprise', invoices: true, messaging: true,
      verification: true, featured: true, priorityRanking: true,
      api: true, whiteLabel: true,
    },
  },
};

/* ── Service category catalogue ──────────────────────────────────────────────── */
const SERVICE_CATEGORIES = {
  'Home Services':         ['Electrician','Plumber','Carpenter','Painter','Welder','Cleaner','Gardener','Pest Control','Appliance Repair','HVAC','Mover'],
  'Security':              ['Security Guard','CCTV Installation','Access Control','Security Consultant'],
  'Education':             ['Tutor','Private Teacher','Skills Trainer','Music Teacher','Language Teacher'],
  'Creative & Media':      ['Photographer','Videographer','Graphic Designer','Content Creator','DJ','MC'],
  'Technology':            ['Software Developer','Web Designer','IT Support','Network Engineer','Data Analyst'],
  'Business Services':     ['Marketing Agency','PR Consultant','Business Consultant','Accountant','Bookkeeper'],
  'Legal':                 ['Lawyer','Legal Consultant','Notary','Arbitrator'],
  'Healthcare':            ['Doctor','Nurse','Clinical Officer','Dentist','Therapist','Physiotherapist','Nutritionist'],
  'Beauty & Wellness':     ['Salon','Barber','Makeup Artist','Nail Technician','Spa Therapist'],
  'Fashion & Textiles':    ['Tailor','Fashion Designer','Laundry Service','Dry Cleaner'],
  'Construction & Design': ['Architect','Interior Designer','Structural Engineer','Quantity Surveyor'],
  'Events':                ['Event Planner','Caterer','Decorator','Sound Engineer','Lighting Technician'],
  'Logistics':             ['Delivery Service','Courier','Freight Agent'],
  'Freelance':             ['Virtual Assistant','Copywriter','Translator','Research Analyst','Data Entry'],
};

/* ── Auth helpers ────────────────────────────────────────────────────────────── */
function _uid(req) {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return uid;
}
function _isAdmin(token) {
  return !!(token?.admin || token?.superAdmin);
}

/* ── Generate unique provider ID ─────────────────────────────────────────────── */
async function _genProviderId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  for (let i = 0; i < 5; i++) {
    id = 'PRV-' + Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const snap = await _db().collection('providerProfiles').where('providerId', '==', id).limit(1).get();
    if (snap.empty) return id;
  }
  throw new HttpsError('internal', 'Could not generate unique provider ID.');
}

/* ────────────────────────────────────────────────────────────────────────────── */
/* HANDLER REGISTRY                                                               */
/* ────────────────────────────────────────────────────────────────────────────── */
const _h = {};
exports._h = _h;

/* ── 1. providerSaveDraft ─────────────────────────────────────────────────────
   Save any step's data to Firestore draft; idempotent.
   step: 'profile'|'coverage'|'availability'|'pricing'|'subscription'|
         'verification'|'payment'|'portfolio'|'bookings'|'notifications'
*/
exports._h.providerSaveDraft = _h.providerSaveDraft = async (req) => {
  const uid  = _uid(req);
  const { step, data } = req.data || {};
  if (!step || typeof step !== 'string') throw new HttpsError('invalid-argument', '"step" required.');
  if (!data || typeof data !== 'object')  throw new HttpsError('invalid-argument', '"data" required.');

  const ALLOWED_STEPS = ['profile','coverage','availability','pricing','subscription',
                         'verification','payment','portfolio','bookings','notifications'];
  if (!ALLOWED_STEPS.includes(step)) throw new HttpsError('invalid-argument', `Invalid step: ${step}`);

  const ref = _db().collection('providerProfiles').doc(uid);
  await ref.set({
    uid,
    [`draft.${step}`]: data,
    [`draftCompletedSteps.${step}`]: true,
    draftUpdatedAt: _ts(),
    status: 'draft',
    updatedAt: _ts(),
  }, { merge: true });

  logger.info('[provider] draft saved', { uid, step });
  return { success: true, step };
};

/* ── 2. providerGetDraft ─────────────────────────────────────────────────────── */
exports._h.providerGetDraft = _h.providerGetDraft = async (req) => {
  const uid = _uid(req);
  const snap = await _db().collection('providerProfiles').doc(uid).get();
  if (!snap.exists) return { draft: {}, completedSteps: {}, status: 'none' };
  const d = snap.data();
  return { draft: d.draft || {}, completedSteps: d.draftCompletedSteps || {}, status: d.status || 'draft' };
};

/* ── 3. providerSelectPlan ───────────────────────────────────────────────────── */
exports._h.providerSelectPlan = _h.providerSelectPlan = async (req) => {
  const uid = _uid(req);
  const { plan, billingCycle } = req.data || {};
  if (!plan || !PLANS[plan])       throw new HttpsError('invalid-argument', `Invalid plan: ${plan}. Valid: ${Object.keys(PLANS).join(', ')}`);
  if (!['monthly','yearly'].includes(billingCycle)) throw new HttpsError('invalid-argument', '"billingCycle" must be monthly or yearly.');

  const p = PLANS[plan];
  const price = billingCycle === 'yearly' ? p.yearly : p.monthly;

  await _db().collection('providerProfiles').doc(uid).set({
    uid,
    'draft.subscription': { plan, billingCycle, price, selectedAt: new Date().toISOString() },
    'draftCompletedSteps.subscription': true,
    draftUpdatedAt: _ts(),
  }, { merge: true });

  return { plan, billingCycle, price, features: p.features, limits: p.limits, commissionRate: p.commissionRate };
};

/* ── 4. providerActivateSubscription ─────────────────────────────────────────── */
exports._h.providerActivateSubscription = _h.providerActivateSubscription = async (req) => {
  const uid = _uid(req);
  const { plan, billingCycle, paymentRef } = req.data || {};
  if (!plan || !PLANS[plan]) throw new HttpsError('invalid-argument', 'Invalid plan.');

  const p   = PLANS[plan];
  const now = new Date();
  const renewalDate = plan === 'free_trial'
    ? new Date(now.getTime() + p.trialDays * 86400000)
    : billingCycle === 'yearly'
      ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
      : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

  const subId = `SUB-${uid.slice(0, 8).toUpperCase()}-${Date.now()}`;
  const price = billingCycle === 'yearly' ? p.yearly : (p.monthly || 0);

  const batch = _db().batch();

  batch.set(_db().collection('providerSubscriptions').doc(uid), {
    uid, subscriptionId: subId, plan, billingCycle, status: plan === 'free_trial' ? 'trialing' : 'active',
    price, renewalDate: renewalDate.toISOString(), expiryDate: renewalDate.toISOString(),
    paymentMethod: paymentRef || null, trialStatus: plan === 'free_trial' ? 'active' : null,
    features: p.features, commissionRate: p.commissionRate, limits: p.limits,
    createdAt: _ts(), updatedAt: _ts(),
  }, { merge: true });

  batch.set(_db().collection('providerProfiles').doc(uid), {
    subscriptionId: subId, plan, billingCycle, subscriptionStatus: plan === 'free_trial' ? 'trialing' : 'active',
    commissionRate: p.commissionRate, planLimits: p.limits, planFeatures: p.features,
    updatedAt: _ts(),
  }, { merge: true });

  await batch.commit();
  logger.info('[provider] subscription activated', { uid, plan, subId });
  return { subscriptionId: subId, plan, status: plan === 'free_trial' ? 'trialing' : 'active', renewalDate: renewalDate.toISOString() };
};

/* ── 5. providerPublish ──────────────────────────────────────────────────────── */
exports._h.providerPublish = _h.providerPublish = async (req) => {
  const uid = _uid(req);
  await require('./legal-agreements').assertLegalCompliance(uid, 'provider'); // publish profile — dark-launched
  const snap = await _db().collection('providerProfiles').doc(uid).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No draft profile found. Complete the onboarding first.');

  const d    = snap.data();
  const draft = d.draft || {};

  if (!draft.profile)  throw new HttpsError('failed-precondition', 'Profile step incomplete.');
  if (!draft.coverage) throw new HttpsError('failed-precondition', 'Coverage step incomplete.');
  if (!d.plan)         throw new HttpsError('failed-precondition', 'Subscription not activated.');

  const providerId = d.providerId || await _genProviderId();
  /* /provider/{providerId} has no hosting rewrite — firebase.json routes
     /shop, /@, /card and /pay, but not /provider — so every QR code and
     profile link built from it resolved to a 404. The public profile page is
     provider-profile.html and it is keyed by uid. */
  const qrData     = `https://mysokoni.co.ke/provider-profile.html?uid=${uid}`;

  const batch = _db().batch();
  const ref   = _db().collection('providerProfiles').doc(uid);

  batch.set(ref, {
    uid, providerId, status: 'active', publishedAt: _ts(),
    name:         _san(draft.profile.name, 120),
    bio:          _san(draft.profile.bio, 2000),
    type:         draft.profile.type || 'individual',
    category:     _san(draft.profile.category, 100),
    subcategory:  _san(draft.profile.subcategory, 100),
    experience:   draft.profile.experience || null,
    qualifications: (draft.profile.qualifications || []).slice(0, 10).map(q => _san(q, 200)),
    certifications: (draft.profile.certifications || []).slice(0, 10).map(c => _san(c, 200)),
    languages:    (draft.profile.languages || []).slice(0, 10).map(l => _san(l, 50)),
    coverage:     draft.coverage || {},
    pricing:      draft.pricing || {},
    bookingConfig: draft.bookings || {},
    notifications: draft.notifications || { sms: true, email: true, push: true },
    qrCode: qrData, rating: 0, reviewCount: 0, bookingCount: 0,
    featured: false, verified: false, searchable: true,
    updatedAt: _ts(),
  }, { merge: true });

  /* ── Publish to the canonical discovery registry ──────────────────────────
     `providers` is the registry every provider-facing surface reads: global
     search (sokoni-firestore-search.js), providers.html, services.html, the
     Cleaning hub and the homepage strip, all via sokoni-providers.js.

     Publishing wrote only providerProfiles until now, so a provider who
     completed this entire flow — subscription, legal agreement, custom auth
     claim and all — was invisible everywhere a customer could look. The two
     collections are not rivals: providerProfiles holds the private working
     record (draft, plan, coverage, pricing config), `providers` holds the
     public listing. This is the one place that projects one onto the other.

     Keyed by uid, matching scripts/onboard-providers.js, so a provider who was
     onboarded by script and later publishes through this flow updates the same
     document instead of gaining a second listing. */
  const cats = [draft.profile.category, draft.profile.subcategory]
    .map(c => _san(c, 100)).filter(Boolean);
  batch.set(_db().collection('providers').doc(uid), {
    uid, providerId,
    name:        _san(draft.profile.name, 120),
    category:    cats[0] || '',
    categories:  cats,
    description: _san(draft.profile.bio, 2000),
    location:    _san((draft.coverage && (draft.coverage.area || draft.coverage.city)) || '', 160),
    city:        _san((draft.coverage && draft.coverage.city) || '', 100),
    skills:      (draft.profile.qualifications || []).slice(0, 10).map(q => _san(q, 200)),
    status:      'active',
    searchable:  true,
    isPublic:    true,
    acceptsBookings: true,
    available:   true,
    /* Verification and featuring are admin decisions and are never granted by
       the act of publishing. merge:true leaves an existing admin value alone. */
    rating: 0, reviewCount: 0, jobsCompleted: 0,
    publishedAt: _ts(), updatedAt: _ts(),
  }, { merge: true });

  // Create availability doc
  if (draft.availability) {
    batch.set(_db().collection('providerAvailability').doc(uid), {
      uid, ...draft.availability, updatedAt: _ts(),
    }, { merge: true });
  }

  // Create settings doc
  if (draft.bookings) {
    batch.set(_db().collection('providerSettings').doc(uid), {
      uid, ...draft.bookings, updatedAt: _ts(),
    }, { merge: true });
  }

  // Create notifications doc
  batch.set(_db().collection('providerNotifications').doc(uid), {
    uid, ...(draft.notifications || { sms: true, email: true, push: true }), updatedAt: _ts(),
  }, { merge: true });

  // Set custom auth claim
  await _auth().setCustomUserClaims(uid, { ...(await _auth().getUser(uid)).customClaims, provider: true, providerId });

  await batch.commit();
  logger.info('[provider] profile published', { uid, providerId });
  return { success: true, providerId, qrCode: qrData, profileUrl: `https://mysokoni.co.ke/provider-profile.html?uid=${uid}` };
};

/* ── 6. providerGetProfile ───────────────────────────────────────────────────── */
exports._h.providerGetProfile = _h.providerGetProfile = async (req) => {
  const uid  = _uid(req);
  const snap = await _db().collection('providerProfiles').doc(uid).get();
  if (!snap.exists) return { exists: false };
  return { exists: true, ...snap.data() };
};

/* ── 7. providerUpdateProfile ────────────────────────────────────────────────── */
exports._h.providerUpdateProfile = _h.providerUpdateProfile = async (req) => {
  const uid = _uid(req);
  const { section, data } = req.data || {};
  const ALLOWED = ['profile','coverage','availability','pricing','portfolio','bookings','notifications'];
  if (!ALLOWED.includes(section)) throw new HttpsError('invalid-argument', 'Invalid section.');
  if (!data || typeof data !== 'object') throw new HttpsError('invalid-argument', 'data required.');

  const updates = {};
  if (section === 'profile') {
    if (data.name)           updates.name          = _san(data.name, 120);
    if (data.bio)            updates.bio           = _san(data.bio, 2000);
    if (data.category)       updates.category      = _san(data.category, 100);
    if (data.subcategory)    updates.subcategory   = _san(data.subcategory, 100);
    if (data.experience)     updates.experience    = data.experience;
    if (data.qualifications) updates.qualifications = data.qualifications.slice(0, 10).map(q => _san(q, 200));
    if (data.languages)      updates.languages     = data.languages.slice(0, 10).map(l => _san(l, 50));
  } else if (section === 'availability') {
    await _db().collection('providerAvailability').doc(uid).set({ uid, ...data, updatedAt: _ts() }, { merge: true });
  } else if (section === 'notifications') {
    await _db().collection('providerNotifications').doc(uid).set({ uid, ...data, updatedAt: _ts() }, { merge: true });
  } else {
    updates[section] = data;
  }

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = _ts();
    await _db().collection('providerProfiles').doc(uid).update(updates);
  }

  return { success: true, section };
};

/* ── 8. providerDashboard ────────────────────────────────────────────────────── */
exports._h.providerDashboard = _h.providerDashboard = async (req) => {
  const uid = _uid(req);

  const [profileSnap, subSnap, bookingsSnap] = await Promise.all([
    _db().collection('providerProfiles').doc(uid).get(),
    _db().collection('providerSubscriptions').doc(uid).get(),
    _db().collection('providerBookings')
      .where('providerId', '==', uid)
      .where('status', 'in', ['pending','confirmed','in_progress'])
      .orderBy('scheduledAt', 'asc')
      .limit(10)
      .get(),
  ]);

  if (!profileSnap.exists) throw new HttpsError('not-found', 'Provider profile not found.');
  const profile = profileSnap.data();
  const sub     = subSnap.exists ? subSnap.data() : null;

  // Aggregate earnings (last 30d)
  const since = new Date(Date.now() - 30 * 86400000);
  const earningsSnap = await _db().collection('providerPayouts')
    .where('providerId', '==', uid)
    .where('createdAt', '>=', since)
    .get();

  const earnings30d = earningsSnap.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);

  return {
    profile: {
      name: profile.name, category: profile.category, providerId: profile.providerId,
      status: profile.status, rating: profile.rating, reviewCount: profile.reviewCount,
      bookingCount: profile.bookingCount, verified: profile.verified, featured: profile.featured,
      profilePhotoUrl: profile.profilePhotoUrl || null, qrCode: profile.qrCode || null,
    },
    subscription: sub ? {
      plan: sub.plan, status: sub.status, renewalDate: sub.renewalDate,
      commissionRate: sub.commissionRate, limits: sub.limits, features: sub.features,
    } : null,
    bookings: bookingsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    earnings: { last30dKes: earnings30d, currency: 'KES' },
    profileCompletion: _calcProfileCompletion(profile),
  };
};

function _calcProfileCompletion(p) {
  const checks = [
    !!p.name, !!p.bio, !!p.category, !!p.subcategory,
    !!p.profilePhotoUrl, !!(p.coverage), !!(p.pricing),
    !!(p.availability || true), p.verified,
    !!(p.portfolio?.length),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

/* ── 9. providerGetBookings ──────────────────────────────────────────────────── */
exports._h.providerGetBookings = _h.providerGetBookings = async (req) => {
  const uid = _uid(req);
  const { status, limit = 20, startAfter } = req.data || {};

  let q = _db().collection('providerBookings').where('providerId', '==', uid);
  if (status) q = q.where('status', '==', status);
  q = q.orderBy('scheduledAt', 'desc').limit(Math.min(Number(limit), 100));
  if (startAfter) q = q.startAfter(new Date(startAfter));

  const snap = await q.get();
  return { bookings: snap.docs.map(d => ({ id: d.id, ...d.data() })), hasMore: snap.size === limit };
};

/* ── 10. providerUpdateAvailability ──────────────────────────────────────────── */
exports._h.providerUpdateAvailability = _h.providerUpdateAvailability = async (req) => {
  const uid  = _uid(req);
  const data = req.data?.data;
  if (!data) throw new HttpsError('invalid-argument', 'data required.');
  await _db().collection('providerAvailability').doc(uid).set({ uid, ...data, updatedAt: _ts() }, { merge: true });
  return { success: true };
};

/* ── 11. providerUpdatePricing ───────────────────────────────────────────────── */
exports._h.providerUpdatePricing = _h.providerUpdatePricing = async (req) => {
  const uid  = _uid(req);
  const data = req.data?.data;
  if (!data) throw new HttpsError('invalid-argument', 'data required.');
  const pricing = {
    hourly:        data.hourly        ? { enabled: true, amount: Number(data.hourly.amount) || 0 }        : null,
    fixed:         data.fixed         ? { enabled: true, amount: Number(data.fixed.amount) || 0 }         : null,
    quotation:     !!data.quotation,
    inspectionFee: data.inspectionFee ? { enabled: true, amount: Number(data.inspectionFee.amount) || 0 } : null,
    emergencyFee:  data.emergencyFee  ? { enabled: true, amount: Number(data.emergencyFee.amount) || 0 }  : null,
    travelFee:     data.travelFee     ? { enabled: true, amount: Number(data.travelFee.amount) || 0 }     : null,
    packages:      (data.packages || []).slice(0, 10).map(pkg => ({
      name: _san(pkg.name, 100), price: Number(pkg.price) || 0, description: _san(pkg.description, 500),
    })),
    currency: 'KES',
  };
  await _db().collection('providerProfiles').doc(uid).update({ pricing, updatedAt: _ts() });
  return { success: true, pricing };
};

/* ── 12. providerConnectPayment ──────────────────────────────────────────────── */
exports._h.providerConnectPayment = _h.providerConnectPayment = async (req) => {
  const uid = _uid(req);
  const { method, details } = req.data || {};
  const ALLOWED_METHODS = ['mpesa','bank','wallet','paypal','stripe','intasend'];
  if (!ALLOWED_METHODS.includes(method)) throw new HttpsError('invalid-argument', `Invalid method: ${method}`);

  const sanitised = {
    mpesa:    details?.mpesa    ? { phone: _san(details.mpesa.phone, 20) } : null,
    bank:     details?.bank     ? { name: _san(details.bank.name, 100), account: _san(details.bank.account, 50), branch: _san(details.bank.branch, 100) } : null,
    wallet:   details?.wallet   ? { enabled: true } : null,
    paypal:   details?.paypal   ? { email: _san(details.paypal.email, 200) } : null,
    stripe:   details?.stripe   ? { accountId: _san(details.stripe.accountId, 100) } : null,
    intasend: details?.intasend ? { accountId: _san(details.intasend.accountId, 100) } : null,
  };

  await _db().collection('providerProfiles').doc(uid).set({
    paymentMethods: sanitised, updatedAt: _ts(),
  }, { merge: true });

  return { success: true, method };
};

/* ── 13. providerUpdateNotifications ─────────────────────────────────────────── */
exports._h.providerUpdateNotifications = _h.providerUpdateNotifications = async (req) => {
  const uid = _uid(req);
  const { sms, email, push } = req.data || {};
  const prefs = { uid, sms: !!sms, email: !!email, push: !!push, updatedAt: _ts() };
  await _db().collection('providerNotifications').doc(uid).set(prefs, { merge: true });
  await _db().collection('providerProfiles').doc(uid).update({ notifications: { sms: !!sms, email: !!email, push: !!push }, updatedAt: _ts() });
  return { success: true };
};

/* ── 14. providerGenerateQR ──────────────────────────────────────────────────── */
exports._h.providerGenerateQR = _h.providerGenerateQR = async (req) => {
  const uid  = _uid(req);
  const snap = await _db().collection('providerProfiles').doc(uid).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Profile not found.');
  const { providerId } = snap.data();
  if (!providerId) throw new HttpsError('failed-precondition', 'Publish your profile first.');
  /* Same 404 as providerPublish — see the note there. */
  const qrData = `https://mysokoni.co.ke/provider-profile.html?uid=${uid}`;
  await _db().collection('providerProfiles').doc(uid).update({ qrCode: qrData, updatedAt: _ts() });
  return { qrCode: qrData, providerId };
};

/* ── 15. providerSubmitVerification ──────────────────────────────────────────── */
exports._h.providerSubmitVerification = _h.providerSubmitVerification = async (req) => {
  const uid = _uid(req);
  const { nationalIdUrl, businessRegUrl, licenceUrl, kraPinUrl, selfieUrl } = req.data || {};
  if (!nationalIdUrl) throw new HttpsError('invalid-argument', 'National ID / Passport upload required.');

  await _db().collection('providerVerification').doc(uid).set({
    uid,
    nationalIdUrl:   _san(nationalIdUrl, 500),
    businessRegUrl:  businessRegUrl  ? _san(businessRegUrl, 500)  : null,
    licenceUrl:      licenceUrl      ? _san(licenceUrl, 500)      : null,
    kraPinUrl:       kraPinUrl       ? _san(kraPinUrl, 500)       : null,
    selfieUrl:       selfieUrl       ? _san(selfieUrl, 500)       : null,
    status:          'pending_review',
    submittedAt:     _ts(),
    updatedAt:       _ts(),
  }, { merge: true });

  await _db().collection('providerProfiles').doc(uid).update({
    verificationStatus: 'pending_review', updatedAt: _ts(),
  });

  logger.info('[provider] verification submitted', { uid });
  return { success: true, status: 'pending_review' };
};

/* ── 16. providerGetPublicProfile ────────────────────────────────────────────── */
exports._h.providerGetPublicProfile = _h.providerGetPublicProfile = async (req) => {
  const { providerId } = req.data || {};
  if (!providerId) throw new HttpsError('invalid-argument', '"providerId" required.');
  const snap = await _db().collection('providerProfiles')
    .where('providerId', '==', _san(providerId, 30))
    .where('status', '==', 'active')
    .limit(1)
    .get();
  if (snap.empty) throw new HttpsError('not-found', 'Provider not found or not yet active.');
  const d = snap.docs[0].data();
  return {
    providerId: d.providerId, name: d.name, bio: d.bio, category: d.category,
    subcategory: d.subcategory, experience: d.experience, qualifications: d.qualifications,
    languages: d.languages, coverage: d.coverage, pricing: d.pricing,
    profilePhotoUrl: d.profilePhotoUrl || null, rating: d.rating,
    reviewCount: d.reviewCount, bookingCount: d.bookingCount,
    verified: d.verified, featured: d.featured, plan: d.plan,
    portfolio: d.portfolioHighlights || [], qrCode: d.qrCode,
  };
};

/* ── 17. providerSearchProviders ─────────────────────────────────────────────── */
exports._h.providerSearchProviders = _h.providerSearchProviders = async (req) => {
  const { category, subcategory, county, verified, limit = 20 } = req.data || {};

  let q = _db().collection('providerProfiles').where('status', '==', 'active').where('searchable', '==', true);
  if (category)    q = q.where('category', '==', _san(category, 100));
  if (subcategory) q = q.where('subcategory', '==', _san(subcategory, 100));
  if (verified)    q = q.where('verified', '==', true);
  q = q.orderBy('rating', 'desc').limit(Math.min(Number(limit), 50));

  const snap = await q.get();
  return {
    providers: snap.docs.map(d => {
      const p = d.data();
      return {
        providerId: p.providerId, name: p.name, category: p.category,
        subcategory: p.subcategory, rating: p.rating, reviewCount: p.reviewCount,
        verified: p.verified, featured: p.featured, pricing: p.pricing,
        profilePhotoUrl: p.profilePhotoUrl || null, coverage: p.coverage,
      };
    }),
    count: snap.size,
  };
};

/* ── 18. providerGetAnalytics ────────────────────────────────────────────────── */
exports._h.providerGetAnalytics = _h.providerGetAnalytics = async (req) => {
  const uid = _uid(req);

  // Enforce plan feature
  const subSnap = await _db().collection('providerSubscriptions').doc(uid).get();
  const plan = subSnap.exists ? subSnap.data().plan : null;
  if (plan && plan === 'free_trial') throw new HttpsError('permission-denied', 'Upgrade to Starter or above for analytics.');

  const [bookingsSnap, payoutsSnap, reviewsSnap] = await Promise.all([
    _db().collection('providerBookings').where('providerId', '==', uid).get(),
    _db().collection('providerPayouts').where('providerId', '==', uid).get(),
    _db().collection('providerReviews').where('providerId', '==', uid).get(),
  ]);

  const totalEarnings = payoutsSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
  const avgRating     = reviewsSnap.empty ? 0 : reviewsSnap.docs.reduce((s, d) => s + (d.data().rating || 0), 0) / reviewsSnap.size;

  return {
    totalBookings:  bookingsSnap.size,
    totalEarnings:  totalEarnings,
    avgRating:      Math.round(avgRating * 10) / 10,
    totalReviews:   reviewsSnap.size,
    currency: 'KES',
  };
};

/* ── 19. providerGetPlans (public, no auth) ──────────────────────────────────── */
exports._h.providerGetPlans = _h.providerGetPlans = async () => {
  return { plans: PLANS, categories: SERVICE_CATEGORIES };
};
