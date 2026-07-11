/**
 * SOKONI Provider SDK v1.0
 * Client-side SDK for all provider operations.
 * All calls route through providerDispatch Cloud Function.
 *
 * Usage:
 *   const sdk = new SokoniProvider();
 *   await sdk.saveDraft('profile', { name: 'John Doe', category: 'Home Services' });
 *   await sdk.publish();
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SokoniProvider = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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

  class SokoniProvider {
    constructor() {
      this._fn = null;
    }

    _call(op, data = {}) {
      if (!this._fn) {
        if (typeof firebase === 'undefined') throw new Error('Firebase not loaded.');
        this._fn = firebase.functions().httpsCallable('providerDispatch');
      }
      return this._fn({ op, ...data }).then(r => r.data);
    }

    // ── Draft management ──────────────────────────────────────────────────────
    saveDraft(step, data)   { return this._call('providerSaveDraft', { step, data }); }
    getDraft()              { return this._call('providerGetDraft'); }

    // ── Plan selection ────────────────────────────────────────────────────────
    selectPlan(plan, billingCycle) { return this._call('providerSelectPlan', { plan, billingCycle }); }
    activateSubscription(plan, billingCycle, paymentRef) {
      return this._call('providerActivateSubscription', { plan, billingCycle, paymentRef });
    }

    // ── Publish ───────────────────────────────────────────────────────────────
    publish()               { return this._call('providerPublish'); }

    // ── Profile ───────────────────────────────────────────────────────────────
    getProfile()            { return this._call('providerGetProfile'); }
    updateProfile(section, data) { return this._call('providerUpdateProfile', { section, data }); }

    // ── Dashboard & bookings ──────────────────────────────────────────────────
    getDashboard()          { return this._call('providerDashboard'); }
    getBookings(opts = {})  { return this._call('providerGetBookings', opts); }

    // ── Specific updates ──────────────────────────────────────────────────────
    updateAvailability(data)  { return this._call('providerUpdateAvailability', { data }); }
    updatePricing(data)       { return this._call('providerUpdatePricing', { data }); }
    connectPayment(method, details) { return this._call('providerConnectPayment', { method, details }); }
    updateNotifications(prefs)      { return this._call('providerUpdateNotifications', prefs); }

    // ── QR & verification ─────────────────────────────────────────────────────
    generateQR()            { return this._call('providerGenerateQR'); }
    submitVerification(docs){ return this._call('providerSubmitVerification', docs); }

    // ── Public / discovery ────────────────────────────────────────────────────
    getPublicProfile(providerId)  { return this._call('providerGetPublicProfile', { providerId }); }
    search(opts = {})             { return this._call('providerSearchProviders', opts); }
    getAnalytics()                { return this._call('providerGetAnalytics'); }
    getPlans()                    { return this._call('providerGetPlans'); }

    // ── Static helpers ────────────────────────────────────────────────────────
    static get categories()       { return SERVICE_CATEGORIES; }
    static categoryList()         { return Object.keys(SERVICE_CATEGORIES); }
    static subcategoryList(cat)   { return SERVICE_CATEGORIES[cat] || []; }
  }

  return SokoniProvider;
}));
