/* SOKONI — the canonical Entertainment category registry.
 * ============================================================================================
 * Before this there were ELEVEN independent lists of Entertainment categories (entertainment-hub,
 * creator-publishing, three copies inside entertainment.html, ent-organizer, event-hub,
 * hub-register, provider.html, provider-onboarding, sokoni-providers) using different ids for the
 * same things (band / live-band, photographer / photography, concert / concerts …), no Streaming
 * category anywhere, and no mapping from a category to the dashboard an approved applicant lands
 * in. This registry is the ONE place the Entertainment TOP-LEVEL categories and their lifecycle
 * live. Sub-vocabularies stay with their owners (Creator subcategories in creator-publishing.js,
 * event categories in event-hub.js) and are referenced, not copied.
 *
 * INVARIANT (brief §3, enforced by scripts/test-entertainment-registry.js): every category names
 *   an application path · an approval authority · a granted role · a dashboard · a payment rail
 *   (or an explicit "none") · a refund rail (or "n/a") · a commercial policy (or an explicit
 *   "none") · an AdminOS surface. No category may be offered in an application without a
 *   dashboard, or have a dashboard without an application path.
 *
 * UMD so a page can load it later (add it to scripts/sync-creator-shared.js when one does —
 * functions/** is not served). Today AdminOS reads it through the entAdminMatrix op.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SokoniEntertainment = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Dashboard tier vocabulary (brief §8). PREMIUM = the professional workspace for the approved
     category; EQUIPPED = the full operational workspace (finance, marketing, analytics,
     communications). A category declares which tier its dashboard provides TODAY — no category is
     promoted to EQUIPPED by a label; the dashboard matrix in docs records what each really has. */
  const TIER = Object.freeze({ PREMIUM: 'PREMIUM', EQUIPPED: 'EQUIPPED' });

  const CATEGORIES = Object.freeze([
    Object.freeze({
      id: 'creator', label: 'Film & Creator',
      summary: 'Films, series, documentaries and other titles sold per view or rented.',
      application: { path: '/creator-studio.html', record: 'creators/{uid} + creatorVerifications/{uid}', op: 'creatorDispatch creator.register · verification.submit' },
      approval: { authority: 'AdminOS › Creator Hub', ops: ['creatorAdminVerificationDecision', 'creatorAdminSetState'], states: 'NOT_APPLIED → DRAFT → SUBMITTED → UNDER_REVIEW → MORE_INFORMATION_REQUIRED → APPROVED / REJECTED / SUSPENDED' },
      role: { grant: 'creators/{uid}.state = ACTIVE (Firestore state — no custom claim)', key: 'creator' },
      dashboard: { path: '/creator-studio.html', tier: TIER.EQUIPPED },
      content: { states: 'DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PUBLISHED (admin approval required)', subcategories: 'creator-publishing.SUBCATEGORIES' },
      payment: { purpose: 'film_access', rails: 'M-PESA STK + hosted checkout (proven methods only)' },
      refund: 'financial-os fos* → creator-hub.onFilmRefundProcessed',
      commercialPolicy: 'creator_ppv',
      settlement: 'royalty ledger → quarterly statement → wallets.balance (dual control)',
      communications: 'none in-dashboard (public support contact on the creator profile)',
      search: 'catalog.list / Creator search (PUBLISHED titles only)',
      adminos: 'sokoni-aos-creator.js',
    }),
    Object.freeze({
      id: 'streaming', label: 'Streaming',
      summary: 'Series and episodic releases streamed on demand — a Creator content type.',
      contentTypeOf: 'creator',
      application: { path: '/creator-studio.html', record: 'creators/{uid}', op: 'creatorDispatch creator.register (then choose subcategory "streaming")' },
      approval: { authority: 'AdminOS › Creator Hub', ops: ['creatorAdminVerificationDecision', 'creatorAdminFilmTransition'], states: 'as Creator' },
      role: { grant: 'creators/{uid}.state = ACTIVE', key: 'creator' },
      dashboard: { path: '/creator-studio.html', tier: TIER.EQUIPPED },
      content: { states: 'as Creator', subcategories: 'creator-publishing.SUBCATEGORIES.streaming' },
      payment: { purpose: 'film_access', rails: 'as Creator' },
      refund: 'financial-os fos* → creator-hub.onFilmRefundProcessed',
      commercialPolicy: 'creator_ppv',
      settlement: 'as Creator',
      communications: 'as Creator',
      search: 'catalog.list subcategory=streaming',
      adminos: 'sokoni-aos-creator.js',
      limits: 'On-demand playback only. Live broadcast is not implemented.',
    }),
    Object.freeze({
      id: 'events', label: 'Events & Ticketing',
      summary: 'Concerts, festivals, conferences and other ticketed events.',
      application: { path: '/event-manager.html', record: 'applications/{id} (type event_organizer)', op: 'event-manager organizer intake → applicationLifecycle' },
      approval: { authority: 'AdminOS › Applications', ops: ['applicationDecide'], states: 'pending → info_requested → approved / rejected / suspended' },
      role: { grant: 'users/{uid}.roles += event_organizer (grantAccountRole)', key: 'event_organizer' },
      dashboard: { path: '/event-manager.html', tier: TIER.PREMIUM },
      content: { states: 'draft → live → ended / cancelled', subcategories: 'event-hub.VALID_CATEGORIES' },
      payment: { purpose: 'event_ticket', rails: 'M-PESA STK + hosted checkout (proven methods only)' },
      refund: 'financial-os fos* → event-settlement.onEventRefundProcessed',
      commercialPolicy: 'event_ticket',
      settlement: 'held until event end + 24 h → wallets.balance',
      communications: 'none in-dashboard',
      search: 'listEvents / searchEvents (live events)',
      adminos: 'sokoni-aos-entertainment.js',
    }),
    Object.freeze({
      id: 'performers', label: 'Performers & Artists',
      summary: 'DJs, MCs, bands, comedians, dancers, photographers and other bookable talent.',
      application: { path: '/provider-onboarding.html?category=entertainment', record: 'applications/{id} (role provider)', op: 'provider onboarding → applicationLifecycle' },
      approval: { authority: 'AdminOS › Applications', ops: ['applicationDecide'], states: 'pending → info_requested → approved / rejected / suspended' },
      role: { grant: 'provider claim + users.roles += provider (grantAccountRole)', key: 'provider' },
      dashboard: { path: '/provider-dashboard.html', tier: TIER.EQUIPPED },
      content: { states: 'service listings (active / inactive)', subcategories: 'PERFORMER_TYPES' },
      payment: { purpose: 'service_booking', rails: 'M-PESA STK (booking flow)' },
      refund: 'merchant/provider refund authority (not owned by Entertainment)',
      commercialPolicy: 'provider_services (commission-config — the provider hub\'s own rate)',
      settlement: 'provider booking settlement',
      communications: 'provider dashboard: contact customer',
      search: 'provider search (approved, searchable providers)',
      adminos: 'sokoni-aos.js › Providers / Applications',
    }),
    Object.freeze({
      id: 'venues', label: 'Venues',
      summary: 'Halls, rooftops, gardens and other spaces listed for events.',
      application: { path: '/ent-organizer.html#venue', record: 'entVenues/{id} (status pending)', op: 'EntHub.listVenue' },
      approval: { authority: 'AdminOS › Entertainment', ops: ['entAdminSetListingStatus'], states: 'pending → active / rejected / suspended' },
      role: { grant: 'venue owner = entVenues/{id}.uid (no role claim)', key: 'venue_owner' },
      dashboard: { path: '/venue-manager.html', tier: TIER.PREMIUM },
      content: { states: 'pending → active / suspended', subcategories: 'VENUE_TYPES' },
      payment: { purpose: null, rails: 'none — venue booking requests carry no payment (enquiry only)' },
      refund: 'n/a (no payment)',
      commercialPolicy: 'none (no payment path)',
      settlement: 'n/a',
      communications: 'booking request → owner',
      search: 'entertainment.html venues (active only)',
      adminos: 'sokoni-aos-entertainment.js',
    }),
  ]);

  /* The performer vocabulary, reconciled from the eleven legacy lists (ids are the canonical
     spelling; legacy aliases map onto them so old records still resolve). */
  const PERFORMER_TYPES = Object.freeze({
    dj: 'DJ', mc: 'MC', band: 'Live Band', musician: 'Musician', singer: 'Singer', comedian: 'Comedian',
    dancer: 'Dancer', magician: 'Magician', influencer: 'Influencer', photographer: 'Photographer',
    videographer: 'Videographer', sound_engineer: 'Sound Engineer', lighting: 'Lighting Technician',
    voiceover: 'Voice-over Artist', producer: 'Producer', event_planner: 'Event Planner', makeup: 'Make-up Artist',
  });
  const PERFORMER_ALIASES = Object.freeze({
    'live-band': 'band', 'photography': 'photographer', 'videography': 'videographer', 'soundeng': 'sound_engineer',
    'planner': 'event_planner', 'event-planner': 'event_planner', 'content-creator': 'influencer',
  });
  const VENUE_TYPES = Object.freeze({
    hall: 'Hall', rooftop: 'Rooftop', outdoor: 'Outdoor', beach: 'Beach', garden: 'Garden', club: 'Club',
    hotel: 'Hotel', restaurant: 'Restaurant', stadium: 'Stadium', other: 'Other',
  });

  const REQUIRED = ['application', 'approval', 'role', 'dashboard', 'payment', 'refund', 'commercialPolicy', 'adminos', 'search'];

  function get(id) { return CATEGORIES.find((c) => c.id === String(id || '')) || null; }
  function ids() { return CATEGORIES.map((c) => c.id); }
  function dashboardFor(id) { const c = get(id); return c ? c.dashboard.path : null; }
  /* role key (as granted by the approval authority) → the dashboard that role lands in. */
  function dashboardForRole(roleKey) {
    const c = CATEGORIES.find((x) => x.role.key === String(roleKey || '') && !x.contentTypeOf);
    return c ? c.dashboard.path : null;
  }
  function performerType(raw) {
    const k = String(raw || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PERFORMER_TYPES, k)) return k;
    return PERFORMER_ALIASES[k] || null;
  }
  /** Every category that is missing a lifecycle field. Empty = the invariant holds. */
  function orphans() {
    const out = [];
    for (const c of CATEGORIES) for (const f of REQUIRED) {
      const v = c[f];
      if (v == null || v === '' || (typeof v === 'object' && !Object.keys(v).length)) out.push(`${c.id}.${f}`);
    }
    return out;
  }

  return { TIER, CATEGORIES, PERFORMER_TYPES, PERFORMER_ALIASES, VENUE_TYPES, REQUIRED, get, ids, dashboardFor, dashboardForRole, performerType, orphans };
}));
