/* ═══════════════════════════════════════════════════════════════════════════
   creator-publishing.js — PURE rules for the Creator Hub catalogue and
   playback: publication state machine, film field contract, creator states,
   country availability, and playback-session decisions.

   UMD: required by functions/creator-hub.js and loaded by creator.html /
   creator-studio.html as window.SokoniCreatorRules, so the vocabulary the UI
   offers is the vocabulary the server enforces — one copy, not two.

   No I/O and no clock: `nowMs` is always an argument.
   Proven by scripts/test-creator-publishing.js.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SokoniCreatorRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Subcategories of the Creator category. The canonical browse registry
     (category.js categoryMeta) owns the TOP-level key `creator`; this list is
     the one place the subcategory vocabulary lives. */
  const SUBCATEGORIES = Object.freeze({
    movies:            'Movies',
    films:             'Films',
    series:            'Series',
    documentaries:     'Documentaries',
    short_films:       'Short Films',
    music_videos:      'Music Videos',
    theatre_stage:     'Theatre / Stage',
    educational_films: 'Educational Films',
    other_media:       'Other Media',
  });

  const FILM_STATE = Object.freeze({
    DRAFT: 'DRAFT', SUBMITTED: 'SUBMITTED', UNDER_REVIEW: 'UNDER_REVIEW', APPROVED: 'APPROVED',
    PUBLISHED: 'PUBLISHED', SUSPENDED: 'SUSPENDED', REJECTED: 'REJECTED',
  });

  /* Who may move a film from → to. A client can NEVER reach PUBLISHED without
     an admin APPROVED step in between. */
  const FILM_TRANSITIONS = Object.freeze({
    creator: {
      DRAFT:     ['SUBMITTED'],
      REJECTED:  ['DRAFT'],
      APPROVED:  ['PUBLISHED'],
    },
    admin: {
      SUBMITTED:    ['UNDER_REVIEW', 'REJECTED'],
      UNDER_REVIEW: ['APPROVED', 'REJECTED'],
      APPROVED:     ['PUBLISHED', 'SUSPENDED'],
      PUBLISHED:    ['SUSPENDED'],
      SUSPENDED:    ['PUBLISHED'],
    },
  });

  const CREATOR_STATE = Object.freeze({ PENDING: 'PENDING', ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', REJECTED: 'REJECTED' });
  const CREATOR_TRANSITIONS = Object.freeze({
    PENDING:   ['ACTIVE', 'REJECTED'],
    ACTIVE:    ['SUSPENDED'],
    SUSPENDED: ['ACTIVE'],
    REJECTED:  ['PENDING'],
  });

  const AGE_RATINGS = Object.freeze(['G', 'PG', '7', '13', '16', '18']);
  const ACCESS_TYPES = Object.freeze(['purchase', 'rental']);

  /* Settlement is KES end to end today (payments, STK, entitlement engine —
     docs/CREATOR_HUB_OWNERSHIP_MAP.md §4 B2). Accepting another currency here
     would price in one currency and settle in another, which is exactly what
     §9 forbids. Widen this list only when the payment core settles it. */
  const SUPPORTED_CURRENCIES = Object.freeze(['KES']);

  const PRICE_MIN_CENTS = 100;            /* KES 1   — payment-purposes MIN_KES */
  const PRICE_MAX_CENTS = 15000000;       /* KES 150,000 — payment-purposes MAX_KES */

  const PLAYBACK = Object.freeze({
    MAX_CONCURRENT_SESSIONS: 2,
    SESSION_IDLE_MS:         2 * 60 * 1000,    /* a session without heartbeat for 2 min is dead */
    GRANT_TTL_MS:            10 * 60 * 1000,   /* signed media URL lifetime */
    MAX_AUTHORIZATIONS_PER_HOUR: 30,
    SUSPICIOUS_DEVICES_24H:  4,
    SUSPICIOUS_NETWORKS_1H:  3,
  });

  /* Server-owned: never accepted from a client payload, on any op. */
  const SERVER_OWNED = Object.freeze([
    'creatorUid', 'creatorId', 'pubState', 'status', 'entType', 'streamingUrl', 'media', 'mediaPath',
    'agreementVersion', 'ownershipStatus', 'createdAt', 'updatedAt', 'publishedAt', 'approvedBy',
    'purchaseCount', 'viewCount', 'rating', 'reviewCount', 'price', 'commissionRate',
  ]);

  const ISO2 = /^[A-Z]{2}$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  function _err(code, message) { const e = new Error(message); e.code = code; return e; }
  function _str(v, max) { return v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }

  /* A poster/trailer must live in SOKONI storage under the creator's own public
     prefix — never an arbitrary URL (tracking pixels, mixed content, hotlinks). */
  function isOwnedPublicAsset(url, uid) {
    if (typeof url !== 'string' || url.length > 1200) return false;
    let u; try { u = new URL(url); } catch (_) { return false; }
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'firebasestorage.googleapis.com') return false;
    const decoded = decodeURIComponent(u.pathname);
    return decoded.includes('/o/creator-public/' + uid + '/');
  }

  /**
   * Validate + normalise a creator's film payload (draft create/update).
   * Unknown keys are ignored; server-owned keys are REFUSED so a forged field
   * fails loudly instead of being silently dropped.
   */
  function sanitizeFilmInput(data, { uid, partial = false } = {}) {
    const d = data && typeof data === 'object' ? data : {};
    const refused = SERVER_OWNED.filter((k) => Object.prototype.hasOwnProperty.call(d, k));
    if (refused.length) throw _err('field_server_owned', 'server-owned field(s): ' + refused.join(', '));
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(d, k);
    const need = (k) => !partial || has(k);

    if (need('title')) { const t = _str(d.title, 140); if (t.length < 2) throw _err('title_invalid', 'title required (2–140 chars)'); out.title = t; }
    if (has('description')) out.description = _str(d.description, 5000);
    if (need('subcategory')) {
      if (!Object.prototype.hasOwnProperty.call(SUBCATEGORIES, d.subcategory)) throw _err('subcategory_invalid', 'unknown subcategory');
      out.subcategory = d.subcategory;
    }
    if (has('genre')) out.genre = _str(d.genre, 40);
    if (has('language')) out.language = _str(d.language, 40);
    if (has('country')) { const c = _str(d.country, 2).toUpperCase(); if (c && !ISO2.test(c)) throw _err('country_invalid', 'country must be ISO-3166 alpha-2'); out.country = c || null; }
    if (has('releaseDate')) { if (d.releaseDate && !DATE.test(String(d.releaseDate))) throw _err('date_invalid', 'releaseDate must be YYYY-MM-DD'); out.releaseDate = d.releaseDate || null; }
    if (has('runtimeMinutes')) {
      const r = d.runtimeMinutes;
      if (!(Number.isSafeInteger(r) && r >= 1 && r <= 1000)) throw _err('runtime_invalid', 'runtimeMinutes must be an integer 1–1000');
      out.runtimeMinutes = r;
    }
    if (has('ageRating')) { if (!AGE_RATINGS.includes(d.ageRating)) throw _err('age_rating_invalid', 'unknown age rating'); out.ageRating = d.ageRating; }
    if (has('classification')) out.classification = _str(d.classification, 80);
    if (has('posterUrl')) { if (d.posterUrl && !isOwnedPublicAsset(d.posterUrl, uid)) throw _err('asset_not_owned', 'poster must be uploaded to your SOKONI creator storage'); out.posterUrl = d.posterUrl || null; }
    if (has('trailerUrl')) { if (d.trailerUrl && !isOwnedPublicAsset(d.trailerUrl, uid)) throw _err('asset_not_owned', 'trailer must be uploaded to your SOKONI creator storage'); out.trailerUrl = d.trailerUrl || null; }
    if (has('previewSeconds')) {
      const p = d.previewSeconds;
      if (!(Number.isSafeInteger(p) && p >= 0 && p <= 600)) throw _err('preview_invalid', 'previewSeconds must be 0–600');
      out.previewSeconds = p;
    }
    if (need('priceCents')) {
      const p = d.priceCents;
      if (!(Number.isSafeInteger(p) && p >= PRICE_MIN_CENTS && p <= PRICE_MAX_CENTS)) throw _err('price_invalid', `priceCents must be an integer ${PRICE_MIN_CENTS}–${PRICE_MAX_CENTS}`);
      if (p % 100 !== 0) throw _err('price_invalid', 'price must be whole shillings (the payment rail settles whole KES)');
      out.priceCents = p;
    }
    if (need('currency')) {
      const c = String(d.currency || '').toUpperCase();
      if (!SUPPORTED_CURRENCIES.includes(c)) throw _err('currency_unsupported', `currency ${c || '(none)'} is not settled by the payment rail yet`);
      out.currency = c;
    }
    if (need('accessType')) {
      if (!ACCESS_TYPES.includes(d.accessType)) throw _err('access_type_invalid', 'accessType must be purchase or rental');
      out.accessType = d.accessType;
    }
    /* A partial update is re-validated by the server on the MERGED document
       (partial:false), so the rental rule is decided against the full picture. */
    if (d.accessType === 'rental') {
      const r = d.rentalDays;
      if (!(Number.isSafeInteger(r) && r >= 1 && r <= 30)) throw _err('rental_days_invalid', 'rentalDays must be 1–30 for a rental');
      out.rentalDays = r;
    } else if (has('accessType') || has('rentalDays')) {
      out.rentalDays = null;
    }
    if (has('availability')) out.availability = normalizeAvailability(d.availability);
    return out;
  }

  /* Availability is an explicit CONTENT rule, not an accident of payment. */
  function normalizeAvailability(a) {
    const mode = a && a.mode;
    if (mode === 'worldwide' || mode == null) return { mode: 'worldwide', countries: [] };
    if (mode !== 'allow' && mode !== 'deny') throw _err('availability_invalid', 'availability.mode must be worldwide, allow or deny');
    const list = Array.isArray(a.countries) ? a.countries : [];
    if (list.length === 0 || list.length > 250) throw _err('availability_invalid', 'allow/deny needs 1–250 countries');
    const countries = [...new Set(list.map((c) => String(c).toUpperCase()))];
    if (countries.some((c) => !ISO2.test(c))) throw _err('availability_invalid', 'countries must be ISO-3166 alpha-2');
    return { mode, countries: countries.sort() };
  }

  /**
   * @returns {{available:boolean, reason:string}}
   * An unknown viewer country is REFUSED for a restricted title: a licence
   * restriction that fails open is not a restriction.
   */
  function isAvailableIn(availability, countryCode) {
    const a = availability || { mode: 'worldwide' };
    if (a.mode === 'worldwide') return { available: true, reason: 'worldwide' };
    const c = String(countryCode || '').toUpperCase();
    if (!ISO2.test(c)) return { available: false, reason: 'country_unknown' };
    const listed = (a.countries || []).includes(c);
    if (a.mode === 'allow') return listed ? { available: true, reason: 'allowed' } : { available: false, reason: 'not_licensed_here' };
    return listed ? { available: false, reason: 'not_licensed_here' } : { available: true, reason: 'not_denied' };
  }

  function assertFilmTransition(actor, from, to) {
    const table = FILM_TRANSITIONS[actor];
    if (!table) throw _err('actor_invalid', 'unknown actor');
    if (!(table[from] || []).includes(to)) throw _err('transition_refused', `${actor} cannot move a film ${from} → ${to}`);
    return true;
  }

  function assertCreatorTransition(from, to) {
    if (!(CREATOR_TRANSITIONS[from] || []).includes(to)) throw _err('transition_refused', `creator ${from} → ${to} is not allowed`);
    return true;
  }

  /** What must be true before a film may be SUBMITTED (and again at PUBLISH). */
  function publishReadiness(film, { creatorState, lockedVersion, draftAgreementOk, mediaReady } = {}) {
    const missing = [];
    if (creatorState !== CREATOR_STATE.ACTIVE) missing.push('creator_not_active');
    if (!film || !film.title) missing.push('title');
    if (!film || !film.subcategory) missing.push('subcategory');
    if (!film || !Number.isSafeInteger(film.priceCents)) missing.push('price');
    if (!film || !SUPPORTED_CURRENCIES.includes(film.currency)) missing.push('currency');
    if (!film || !film.posterUrl) missing.push('poster');
    if (!mediaReady) missing.push('media');
    if (!(lockedVersion || draftAgreementOk)) missing.push('royalty_agreement');
    return { ready: missing.length === 0, missing };
  }

  /**
   * Playback authorisation decision — the ONLY place "may this viewer watch"
   * is answered. Entitlement comes from the server ledger, never the client.
   */
  function decidePlayback({ entitlement, film, viewerUid, nowMs, activeSessions = [], authorizationsLastHour = 0, sessionId = null }) {
    if (!viewerUid) return { allow: false, reason: 'unauthenticated' };
    if (!film || film.pubState !== FILM_STATE.PUBLISHED) return { allow: false, reason: 'film_unavailable' };
    if (!entitlement) return { allow: false, reason: 'no_entitlement' };
    if (entitlement.ownerUid !== viewerUid) return { allow: false, reason: 'not_owner' };
    if (entitlement.resourceId !== film.id) return { allow: false, reason: 'wrong_title' };
    if (entitlement.status !== 'ACTIVE') return { allow: false, reason: 'entitlement_' + String(entitlement.status || 'none').toLowerCase() };
    if (entitlement.expiresAtMs != null && nowMs >= entitlement.expiresAtMs) return { allow: false, reason: 'entitlement_expired' };
    if (authorizationsLastHour >= PLAYBACK.MAX_AUTHORIZATIONS_PER_HOUR) return { allow: false, reason: 'rate_limited' };
    const live = activeSessions.filter((s) => s && !s.ended && nowMs - s.lastSeenMs < PLAYBACK.SESSION_IDLE_MS && s.sessionId !== sessionId);
    if (live.length >= PLAYBACK.MAX_CONCURRENT_SESSIONS) return { allow: false, reason: 'too_many_sessions' };
    return { allow: true, reason: 'entitled' };
  }

  /** Flag (not block) patterns that look like credential sharing or scraping. */
  function assessSessionRisk({ devices24h = [], networks1h = [] }) {
    const flags = [];
    if (new Set(devices24h).size >= PLAYBACK.SUSPICIOUS_DEVICES_24H) flags.push('many_devices_24h');
    if (new Set(networks1h).size >= PLAYBACK.SUSPICIOUS_NETWORKS_1H) flags.push('many_networks_1h');
    return { suspicious: flags.length > 0, flags };
  }

  return {
    SUBCATEGORIES, FILM_STATE, FILM_TRANSITIONS, CREATOR_STATE, CREATOR_TRANSITIONS,
    AGE_RATINGS, ACCESS_TYPES, SUPPORTED_CURRENCIES, PRICE_MIN_CENTS, PRICE_MAX_CENTS, PLAYBACK, SERVER_OWNED,
    isOwnedPublicAsset, sanitizeFilmInput, normalizeAvailability, isAvailableIn,
    assertFilmTransition, assertCreatorTransition, publishReadiness, decidePlayback, assessSessionRisk,
  };
}));
