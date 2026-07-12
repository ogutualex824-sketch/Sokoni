/**
 * SOKONI Universal Onboarding SDK v1.0
 * All account/role/onboarding ops via onboardingDispatch.
 *
 * Usage:
 *   const sdk = new SokoniOnboarding();
 *   const { account } = await sdk.getAccount();
 *   await sdk.saveDraft('merchant', 2, { businessName: 'Acme Ltd' });
 *   const { profileId } = await sdk.activateRole('merchant', profileData);
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SokoniOnboarding = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROLES = [
    'buyer','merchant','provider','rider','driver','courier',
    'property','hotel','restaurant','pharmacy','events',
    'employer','freelancer','distributor','wholesaler',
    'manufacturer','ngo','school','healthcare','finance',
  ];

  const ROLE_META = {
    buyer:        { label: 'Shop on SOKONI',      icon: '🛍️',  desc: 'Browse products, place orders, track deliveries' },
    merchant:     { label: 'Sell Products',        icon: '🏪',  desc: 'Run a store with POS, inventory, analytics' },
    provider:     { label: 'Offer Services',       icon: '🔧',  desc: 'Get discovered and booked by customers' },
    rider:        { label: 'Ride & Deliver',       icon: '🏍️', desc: 'Earn by delivering orders on a motorbike' },
    driver:       { label: 'Drive & Deliver',      icon: '🚗',  desc: 'Earn by driving passengers or deliveries' },
    courier:      { label: 'Courier Services',     icon: '📦',  desc: 'Parcel collection and delivery network' },
    property:     { label: 'Manage Property',      icon: '🏘️', desc: 'Rentals, tenant management, maintenance' },
    hotel:        { label: 'Manage Hotel',         icon: '🏨',  desc: 'Rooms, bookings, channel management' },
    restaurant:   { label: 'Manage Restaurant',    icon: '🍽️', desc: 'Digital menu, orders, KDS, delivery' },
    pharmacy:     { label: 'Open Pharmacy',        icon: '💊',  desc: 'Prescription management, inventory, POS' },
    events:       { label: 'Organize Events',      icon: '🎪',  desc: 'Ticketing, gate check-in, analytics' },
    employer:     { label: 'Hire Staff',           icon: '💼',  desc: 'Post jobs, screen applicants, onboard talent' },
    freelancer:   { label: 'Find Jobs',            icon: '💻',  desc: 'Your professional profile and job matches' },
    distributor:  { label: 'Distribute Products',  icon: '🚛',  desc: 'Wholesale distribution and supply chain' },
    wholesaler:   { label: 'Wholesale',            icon: '🏭',  desc: 'Bulk sales to retailers and businesses' },
    manufacturer: { label: 'Manufacture',          icon: '⚙️',  desc: 'Production, supply chain, B2B sales' },
    ngo:          { label: 'NGO / Charity',        icon: '❤️',  desc: 'Fundraising, beneficiaries, impact tracking' },
    school:       { label: 'School / Training',    icon: '📚',  desc: 'Enrolment, courses, fee collection' },
    healthcare:   { label: 'Healthcare Facility',  icon: '🏥',  desc: 'Appointments, EMR, lab, pharmacy' },
    finance:      { label: 'Financial Institution',icon: '🏦',  desc: 'Loans, savings, insurance, payments' },
  };

  class SokoniOnboarding {
    constructor() { this._fn = null; }

    _call(op, data = {}) {
      if (!this._fn) {
        if (!window.sokoniCallable) throw new Error('Firebase SDK not ready.');
        this._fn = window.sokoniCallable('onboardingDispatch');
      }
      return this._fn({ op, ...data }).then(r => r.data);
    }

    // ── Account ───────────────────────────────────────────────────────────
    getAccount()                     { return this._call('onbGetAccount'); }
    getDashboard()                   { return this._call('onbGetDashboard'); }
    getProfiles()                    { return this._call('onbGetProfiles'); }

    // ── Draft management ──────────────────────────────────────────────────
    saveDraft(role, step, data)      { return this._call('onbSaveDraft', { role, step, data }); }
    getDraft(role)                   { return this._call('onbGetDraft', { role }); }

    // ── Role lifecycle ────────────────────────────────────────────────────
    activateRole(role, profileData)  { return this._call('onbActivateRole', { role, profileData }); }
    switchRole(role)                 { return this._call('onbSwitchRole', { role }); }
    updateProfile(profileId, data)   { return this._call('onbUpdateProfile', { profileId, data }); }

    // ── Subscriptions ─────────────────────────────────────────────────────
    getPlans(role)                   { return this._call('onbGetPlans', { role }); }
    activateSubscription(role, tier, billingCycle, profileId, paymentRef, paymentMethod) {
      return this._call('onbActivateSubscription',
        { role, tier, billingCycle, profileId, paymentRef, paymentMethod });
    }

    // ── Utilities ─────────────────────────────────────────────────────────
    checkHandle(handle)              { return this._call('onbCheckHandle', { handle }); }

    // ── Static helpers ────────────────────────────────────────────────────
    static get roles()               { return ROLES; }
    static get roleMeta()            { return ROLE_META; }
    static metaFor(role)             { return ROLE_META[role] || { label: role, icon: '🔲', desc: '' }; }
    static labelFor(role)            { return (ROLE_META[role] || {}).label || role; }
    static iconFor(role)             { return (ROLE_META[role] || {}).icon  || '🔲'; }
  }

  return SokoniOnboarding;
}));
