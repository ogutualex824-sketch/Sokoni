'use strict';
/**
 * SOKONI Universal Enterprise Onboarding Engine — backend handlers.
 * Collections: accounts/{uid}, accountDrafts/{uid}_{role},
 *              accountProfiles/{profileId}, accountSubscriptions/{id},
 *              accountHandles/{handle}
 */
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
/* firebase-admin/auth is deliberately NOT imported. This module is the
   self-service onboarding rail: it writes account and profile DOCUMENTS, and it
   has no business holding a handle that can mint custom claims. Custom claims
   come from application-lifecycle.js's grantAccountRole, behind an admin
   decision, and from nowhere else. Re-adding this import is the first step of
   reopening the hole scripts/test-onboarding-selfmint-emulator.js closes. */
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
/* CHANGELOG 240 (convergence C2c) — owner decision 2026-09-28: a SELF-SELECTED onboarding role never determines
   dashboard routing or authority. Every business role now resolves through ONE place, workspace.html, which asks the
   server (business-workspace.homeFor) what this account has actually been APPROVED for. The previous per-role table
   (hotel → bnb-manage, restaurant/pharmacy → pos, healthcare → healthcare.html, …) routed on a role anyone could pick. */
const DASHBOARD_MAP = new Proxy({ buyer: 'index.html' }, { get: (t, k) => (k === 'buyer' ? 'index.html' : 'workspace.html') });

/* CLAIM_KEY was here. It mapped each role to the identifier CLAIM this rail
   minted alongside the role claim — merchant -> merchantId, provider ->
   providerId, and so on. Both mints are gone (see onbActivateRole below), so the
   table described something that no longer happens, and a table of claims nothing
   writes is a table that will eventually be trusted by someone reading it.

   The identifier it carried still exists as DATA: accountProfiles/{profileId},
   reached through accounts/{uid}.profiles[role]. That is a document gated on
   request.auth.uid by firestore.rules:5177-5191 — not a claim, and not authority. */

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
  /* Healthcare is defined ONCE, in functions/healthcare-plans.js — the canonical table for
     the Healthcare hub. It used to be inline here with `commission: 0.03 / 0.02 / 0.01`,
     which contradicted the ratified 5% Healthcare booking rate (ADR-015) and would have
     become a second rate authority the moment anything read it. The plans now carry capacity
     only: `limits.doctors` (practitioner seats) and `limits.services` (publishable services),
     never `limits.listings`, whose absence used to make the service cap evaluate to NaN and
     silently disappear. */
  healthcare: require('./healthcare-plans').clientPlanList(),
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
  /* No `getAuth()` here any more — this handler no longer touches custom claims,
     and holding an Auth admin handle in a self-service path is exactly the shape
     that invited the mint back. */
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
  /* ── NO CUSTOM CLAIM IS MINTED HERE. THIS IS THE POINT OF THE FUNCTION'S
        SECURITY MODEL, NOT AN OMISSION. ──────────────────────────────────────
     This line used to be:

         await auth.setCustomUserClaims(uid, { ...claims, [role]: true, [ck]: profileId });

     ...reached after `_assertAuth(req)` and a VALID_ROLES membership test, and
     nothing else. VALID_ROLES is the key set of ID_PREFIX — twenty entries
     including `merchant`, `provider`, `rider` and `driver` — and this handler is
     live, routed as op `onbActivateRole` through onboarding-dispatch.js:21 and
     exported at index.js:12436. So any account that could sign in could give
     itself any of those twenty claims.

     A custom claim is this platform's authority primitive. Every security rule
     and every callable that trusts one trusts it BECAUSE no client can write it.
     Minting one from a self-service call breaks that premise for every reader at
     once, including readers that do not exist yet — which is the real cost, since
     the escalation lands the day someone reasonably decides `token.merchant`
     means merchant.

     WHAT WAS ACTUALLY REACHABLE, established by census rather than assumed:
       · `driver` was read at api-gateway.js:116 (a display string) and
         shared/errors.js:172 (rate budget 20/min instead of 10) — minor, real.
       · `merchantId` is read by firestore.rules:5017-5037 and
         marketing-engine.js:123, and THIS was its only minter anywhere in
         functions/. The value it wrote is BIZ-shaped; a real merchantId is
         SOK-shaped (business-bootstrap), so it matched no live document.
       · every other one of the twenty was read by nothing at all.
     The hole was therefore mostly latent — and it also OVERWROTE a real
     merchant's live merchantId claim with a fresh BIZ- id, costing them the POS
     cash-session reads those four rules grant.

     WHAT IS LOST BY MINTING NOTHING: nothing. accounts/{uid},
     accountDrafts/{id} and accountProfiles/{id} are the collections this rail
     actually uses, and firestore.rules:5177-5191 gates all three on
     request.auth.uid or public read — not one of them consults a claim. The
     transaction above still records the role, the profile and the draft, and the
     return value below is unchanged, so onboarding.html is untouched.

     WHERE A ROLE CLAIM COMES FROM INSTEAD: grantAccountRole in
     application-lifecycle.js, reached only through an admin decision. That is the
     whole of the authority rail, and it stays the whole of it.

     scripts/test-onboarding-selfmint-emulator.js reproduces the original hole
     against this handler before asserting it is shut. */
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

  /* ── THE TYPO AND THE SECURITY MUST LAND TOGETHER ──────────────────────────────────────
   * Below, the write said `paymentRef,` while the only binding in scope was `payRef`. In
   * strict mode that is a ReferenceError, so this handler threw on EVERY call, for every
   * role — verified by execution. The three Healthcare plans were returned by onbGetPlans
   * and displayed to customers, but could not be purchased.
   *
   * Repairing that one character alone would NOT have restored a feature. It would have
   * armed an unverified paid-subscription path for every role at once: the handler took
   * `paymentRef` from the request, never verified it, and wrote status:'active' with the
   * plan's commissionRate and limits. Its deadness was, accidentally, the only thing
   * containing it.
   *
   * So the guard lands with the fix. A priced plan cannot be activated from the client;
   * money becomes capability only through the canonical path — createPaymentIntent (the
   * server derives the amount) -> IntaSend -> entitlement-engine verification -> activation.
   * For Healthcare that is purpose `healthcare_subscription`, whose engine handler writes
   * accountSubscriptions itself.
   *
   * A zero-price tier stays self-serve: there is no payment to verify, so nothing to forge. */
  const planPriceCents = Math.max(0, Math.round(Number(plan.price) || 0));
  if (planPriceCents > 0) {
    throw new HttpsError('failed-precondition',
      'A paid plan cannot be activated from the client. Start a payment with '
      + 'createPaymentIntent; the subscription activates once the payment is verified.');
  }

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
    paymentRef: payRef || null,   /* was `paymentRef,` — an undeclared binding; see the guard above */
    paymentMethod: req.data?.paymentMethod || null,
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
