/* ============================================================================
   SOKONI PROVIDERS  v1.0 — the one client for the `providers` registry
   ----------------------------------------------------------------------------
   `providers` is the canonical service-provider registry. Every provider-facing
   surface reads it through this file, so a provider onboarded once appears
   everywhere without a per-page implementation drifting out of step. Before
   this module the directory lived in five places that disagreed: hardcoded
   arrays in providers.html / services.html / cleaning.html, a localStorage
   list, and a second Firestore registry (providerProfiles).

   USAGE
     const { providers, error } = await SokoniProviders.list({ category:'laundry' });
     const p = await SokoniProviders.get(uid);

   WHY list() RETURNS `error` INSTEAD OF THROWING
   A failed read and an empty registry are different facts and must render
   differently: "we could not load providers, retry" versus "no providers in
   this category yet". Collapsing them is how a broken query starts looking
   like an empty category — the failure mode this codebase already has a
   standing rule against. Callers get both fields and must decide.

   THERE IS NO DEMO FALLBACK. If the read fails, this returns zero providers
   and an error. It never substitutes invented listings.

   THE SERVER DECIDES WHO IS LISTED (CHANGELOG 244, convergence C3a-2).
   The browser no longer reads `providers` and re-decides approval, category,
   suspension or searchability from whatever fields it could read. It asks
   providerDispatch { op:'providerDirectory' } (functions/provider-directory.js),
   which applies business-category.publicEligibility — the same predicate the
   search-index gate uses — and returns a public WHITELIST card under the
   SERVER's category (C1). A category asked for here must be a C1 key.
============================================================================ */

(function () {
  'use strict';

  /* Informational only since CHANGELOG 244 — eligibility is the server's
     (providerDirectory), never re-derived from this list in the browser. */
  var VISIBLE_STATUS = ['active', 'approved'];
  var SCAN_LIMIT     = 200;
  var CACHE_TTL_MS   = 2 * 60 * 1000;

  /* A blocked Firestore read does not always reject and does not always fall
     back to cache — getDoc in particular can simply never settle while the SDK
     retries a backend it will never reach (App Check rejection is the case
     seen here). Without a ceiling the caller waits forever and the page sits
     on its loading skeleton, which is a worse outcome than an error: the
     visitor cannot tell whether to wait or reload. */
  var READ_TIMEOUT_MS = 8000;

  function withTimeout(promise, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error(label + ' timed out after ' + (READ_TIMEOUT_MS / 1000) + 's');
        e.code = 'deadline-exceeded';
        reject(e);
      }, READ_TIMEOUT_MS);
      promise.then(function (v) {
        if (done) return;
        done = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(t); reject(e);
      });
    });
  }

  var _cache = null, _cacheAt = 0, _inflight = null;

  /* ── Last-good persistent cache ─────────────────────────────────────────────
     App Check is enforced on Firestore and, on this project, fails
     intermittently (an identical session can succeed then 403). Before the
     directory was Firestore-backed the pages rendered hardcoded data and never
     cared. Now a single failed read would leave a returning visitor staring at
     "Could not load providers" on a page that worked a minute ago.

     So the last SUCCESSFUL read is persisted — REAL provider records, never
     fabricated — and served when a later read fails. A visitor who has ever
     loaded the directory keeps seeing it through an App Check hiccup, flagged
     `stale` so the UI can note it is not fresh. This is not a demo fallback:
     nothing here is invented, and a visitor who has never had a successful
     read still gets the honest error state, because there is nothing real to
     show them yet. */
  var LS_KEY = 'sokoniProvidersLastGood.v2';
  try { localStorage.removeItem('sokoniProvidersLastGood'); } catch (e) { /* private mode */ }
  var LS_TTL_MS = 24 * 60 * 60 * 1000;   /* a day: stale-but-real beats broken */

  function saveLastGood(list) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ at: Date.now(), providers: list }));
    } catch (e) { /* quota / private mode — the in-memory cache still stands */ }
  }
  function loadLastGood() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.providers) || !parsed.providers.length) return null;
      if (Date.now() - parsed.at > LS_TTL_MS) return null;   /* too old to trust */
      return parsed;
    } catch (e) { return null; }
  }

  /* ── Categories ─────────────────────────────────────────────────────────────
     The SERVER's C1 categories (functions/business-category.js). Labels come
     from the server card; the emoji is presentation only. There are no aliases:
     a provider's self-described "laundry" or "mamafua" is its displayCategory,
     not a filter key, and a page asks for the C1 key (e.g. 'cleaning'). */
  var CATEGORY_EMOJI = {
    clinician: '👩‍⚕️', facility: '🏥', pharmacy: '💊', laboratory: '🔬', telemedicine: '📱', home_care: '🏠',
    hotel: '🏨', restaurant: '🍽️', trades: '🔧', cleaning: '🧹', it_services: '💻', salon: '💇',
    lawyer: '⚖️', professional_services: '💼', education: '📚', auto_services: '🚗', fitness_studio: '🏋️',
    service_business: '🛠️', artist_creator: '🎤', event_services: '🎉', event_organizer: '🎟️', venue: '🏟️',
    retail_store: '🏪', property: '🏠', delivery: '🚚',
  };
  var _labels = {};   /* C1 key → label, learnt from the server's reply */

  /* ── XSS-safe escape. Provider names and bios are user-supplied and land in
     innerHTML on every page that renders a card. ───────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* firebase.js (a module) installs window.sokoniCallable; this deferred script
     may run first, so wait briefly for it rather than failing the read. */
  function directory(data) {
    var waited = 0;
    return new Promise(function (resolve, reject) {
      (function poll() {
        if (typeof window.sokoniCallable === 'function') {
          var p = { op: 'providerDirectory' };
          for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) p[k] = data[k];
          window.sokoniCallable('providerDispatch')(p).then(function (r) { resolve((r && r.data) || {}); }, reject);
          return;
        }
        if ((waited += 100) > READ_TIMEOUT_MS) { var e = new Error('SOKONI is still loading'); e.code = 'unavailable'; reject(e); return; }
        setTimeout(poll, 100);
      })();
    });
  }

  /* ── Normalisation ─────────────────────────────────────────────────────────
     The server card (functions/provider-directory.publicCard) is already the
     public whitelist under the C1 category; this maps it onto the shape pages
     render. Absent fields stay absent — nothing is invented to fill a card. A
     rating is present only when the reputation authority derived it; there is
     no phone (contact is in-app) and no self-declared `featured`. */
  function normalize(id, d) {
    d = d || {};
    var uid = String(d.uid || id || '');
    var cat = d.category || '';
    if (cat && d.categoryLabel) _labels[cat] = d.categoryLabel;
    return {
      uid:           uid,
      id:            uid,
      providerId:    d.providerId || uid,
      name:          d.name || '',
      businessName:  d.businessName || '',
      category:      cat,
      categories:    cat ? [cat] : [],
      categoryLabel: d.categoryLabel || 'Professional',
      displayCategory: d.displayCategory || '',
      emoji:         CATEGORY_EMOJI[cat] || '👷',
      serviceType:   d.serviceType || d.displayCategory || '',
      description:   d.description || '',
      location:      d.location || d.city || '',
      city:          d.city || '',
      phone:         '',
      skills:        Array.isArray(d.skills) ? d.skills : [],
      rating:        typeof d.rating === 'number' && d.rating > 0 && Number(d.reviewCount) > 0 ? d.rating : null,
      reviewCount:   Number(d.reviewCount || 0),
      followerCount: typeof d.followerCount === 'number' ? d.followerCount : null,
      jobsCompleted: Number(d.jobsCompleted || 0),
      rate:          d.rate != null && d.rate !== '' ? Number(d.rate) : null,
      rateType:      d.rateType || '',
      photo:         d.photo || '',
      verified:      d.verified === true,
      featured:      false,
      available:     d.available !== false,
      acceptsBookings: d.acceptsBookings !== false,
      chatEnabled:   d.chatEnabled !== false,
      profileUrl:    'provider-profile.html?uid=' + encodeURIComponent(uid),
      profilePending: Array.isArray(d.profilePending) ? d.profilePending : [],
    };
  }

  /* ── The single read ───────────────────────────────────────────────────────
     One bounded query per TTL window, shared by every caller on the page.
     Concurrent callers join the in-flight promise instead of each issuing
     their own query. */
  function fetchAll(force) {
    if (!force && _cache && (Date.now() - _cacheAt) < CACHE_TTL_MS) {
      return Promise.resolve({ providers: _cache, error: null });
    }
    if (_inflight) return _inflight;

    /* A read failed (App Check hiccup, offline, uninitialised SDK). Serve the
       last SUCCESSFUL real result if we have a recent one, so the page stays
       usable through an intermittent failure; only surface the error when
       there is nothing real to fall back to. */
    function degrade(err) {
      var lg = loadLastGood();
      if (lg) {
        _cache = lg.providers;   /* seed the in-memory cache so retries are instant */
        _cacheAt = Date.now();
        console.warn('[SokoniProviders] read failed — serving last-good cache from ' +
          new Date(lg.at).toISOString());
        return { providers: lg.providers, error: null, stale: true, staleSince: lg.at };
      }
      return { providers: [], error: err };
    }

    _inflight = (function () {
      /* One transparent retry: App Check on this project fails intermittently
         and its token auto-refreshes, so a second attempt usually succeeds. */
      return withTimeout(directory({ limit: SCAN_LIMIT }), 'providers list').catch(function () {
        return new Promise(function (res) { setTimeout(res, 1500); })
          .then(function () { return withTimeout(directory({ limit: SCAN_LIMIT }), 'providers list (retry)'); });
      }).then(function (r) {
        if (!r || !Array.isArray(r.providers)) throw new Error('providers list: malformed reply');
        (r.categories || []).forEach(function (c) { if (c && c.id) _labels[c.id] = c.label; });
        var out = [];
        r.providers.forEach(function (c) {
          var p = normalize(c && c.uid, c);
          /* A record with no name cannot be rendered as a card. */
          if (p.name && p.uid) out.push(p);
        });
        _cache = out;
        _cacheAt = Date.now();
        saveLastGood(out);   /* remember this success for the next hiccup */
        return { providers: out, error: null };
      }).catch(function (e) {
        console.warn('[SokoniProviders] read failed:', e && e.message);
        return degrade(e);
      });
    })().then(function (r) { _inflight = null; return r; },
             function (e) { _inflight = null; throw e; });

    return _inflight;
  }

  function expandCategory(cat) {
    if (!cat || cat === 'all') return null;
    return [String(cat)];
  }

  function matchesCategory(p, wanted) {
    if (!wanted) return true;
    var have = [p.category].concat(p.categories).filter(Boolean)
      .map(function (c) { return String(c).toLowerCase(); });
    return wanted.some(function (w) { return have.indexOf(w) !== -1; });
  }

  function matchesQuery(p, q) {
    if (!q) return true;
    var s = String(q).toLowerCase().trim();
    if (!s) return true;
    var hay = [p.name, p.businessName, p.categoryLabel, p.category,
               p.serviceType, p.description, p.location, p.city,
               p.skills.join(' ')].join(' ').toLowerCase();
    return hay.indexOf(s) !== -1;
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */

  /**
   * list({ category, query, limit, featuredOnly, force })
   *   → Promise<{ providers: Provider[], error: Error|null }>
   * Verified providers sort first, then those with a rating, then the rest.
   */
  function list(opts) {
    opts = opts || {};
    return fetchAll(opts.force).then(function (r) {
      var wanted = expandCategory(opts.category);
      if (wanted && !CATEGORY_EMOJI[wanted[0]]) {
        var ue = new Error('Unknown category: ' + wanted[0]); ue.code = 'invalid-argument';
        return { providers: [], error: ue, stale: false };
      }
      var out = r.providers.filter(function (p) {
        if (!matchesCategory(p, wanted)) return false;
        if (!matchesQuery(p, opts.query)) return false;
        if (opts.featuredOnly && !p.featured) return false;
        return true;
      });
      out.sort(function (a, b) {
        if (a.verified !== b.verified) return a.verified ? -1 : 1;
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        return (b.rating || 0) - (a.rating || 0);
      });
      if (opts.limit) out = out.slice(0, opts.limit);
      /* Propagate staleness so a page can note it is showing cached data. */
      return { providers: out, error: r.error, stale: r.stale || false, staleSince: r.staleSince };
    });
  }

  /** get(uid) → Promise<{ provider: Provider|null, error: Error|null }> */
  function get(uid) {
    if (!uid) return Promise.resolve({ provider: null, error: null });

    /* If the last-good list holds this provider, keep it ready as a fallback so
       an App Check hiccup on the profile page shows the real provider instead
       of "not available". */
    function fromLastGood() {
      var lg = loadLastGood();
      if (!lg) return null;
      for (var i = 0; i < lg.providers.length; i++) {
        if (String(lg.providers[i].uid) === String(uid)) return lg.providers[i];
      }
      return null;
    }
    function degradeOne(err) {
      var hit = fromLastGood();
      if (hit) {
        console.warn('[SokoniProviders] get failed — serving last-good record for ' + uid);
        return { provider: hit, error: null, stale: true };
      }
      return { provider: null, error: err };
    }

    return withTimeout(directory({ providerId: String(uid) }), 'provider read').catch(function () {
      return new Promise(function (res) { setTimeout(res, 1500); })
        .then(function () { return withTimeout(directory({ providerId: String(uid) }), 'provider read (retry)'); });
    }).then(function (r) {
      /* null = the server does not list this provider (not approved, suspended,
         hidden or unclassified) — "not available", which is a real answer. */
      if (!r || !r.provider) return { provider: null, error: null };
      return { provider: normalize(r.provider.uid, r.provider), error: null };
    }).catch(function (e) {
      console.warn('[SokoniProviders] get failed:', e && e.message);
      return degradeOne(e);
    });
  }

  /** Count by category — for category tiles and "(n found)" labels. */
  function counts() {
    return fetchAll().then(function (r) {
      var byCat = {};
      r.providers.forEach(function (p) {
        [p.category].concat(p.categories).filter(Boolean).forEach(function (c) {
          c = String(c).toLowerCase();
          byCat[c] = (byCat[c] || 0) + 1;
        });
      });
      return { total: r.providers.length, byCategory: byCat, error: r.error };
    });
  }

  /**
   * Standard empty/error block. Centralised so every page distinguishes a
   * failed read from a genuinely empty category in the same words.
   */
  function emptyStateHtml(error, categoryLabel) {
    if (error) {
      return '<div class="sp-empty" style="grid-column:1/-1;text-align:center;padding:36px 16px;">'
           + '<div style="font-size:34px;margin-bottom:10px;">⚠️</div>'
           + '<h3 style="margin:0 0 6px;color:#fff;font-size:15px;">Could not load providers</h3>'
           + '<p style="margin:0 0 14px;color:rgba(255,255,255,0.55);font-size:13px;">'
           + 'This is a connection problem on our side, not an empty category.</p>'
           + '<button type="button" onclick="location.reload()" style="padding:10px 20px;'
           + 'background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.25);'
           + 'color:#71ff00;border-radius:10px;font-weight:700;font-family:inherit;'
           + 'font-size:13px;cursor:pointer;">Retry</button></div>';
    }
    return '<div class="sp-empty" style="grid-column:1/-1;text-align:center;padding:36px 16px;">'
         + '<div style="font-size:34px;margin-bottom:10px;">👷</div>'
         + '<h3 style="margin:0 0 6px;color:#fff;font-size:15px;">No providers'
         + (categoryLabel ? ' in ' + esc(categoryLabel) : '') + ' yet</h3>'
         + '<p style="margin:0 0 14px;color:rgba(255,255,255,0.55);font-size:13px;">'
         + 'Be the first to offer this service on SOKONI.</p>'
         + '<a href="/services.html#register" style="display:inline-block;padding:10px 20px;'
         + 'background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.25);'
         + 'color:#71ff00;border-radius:10px;font-weight:700;font-size:13px;'
         + 'text-decoration:none;">+ Register as a provider</a></div>';
  }

  window.SokoniProviders = {
    list: list,
    get: get,
    counts: counts,
    normalize: normalize,
    esc: esc,
    emptyStateHtml: emptyStateHtml,
    categoryLabel: function (c) { return _labels[c] || c; },
    categoryEmoji: function (c) { return CATEGORY_EMOJI[c] || '👷'; },
    invalidate: function () { _cache = null; _cacheAt = 0; },
    VISIBLE_STATUS: VISIBLE_STATUS.slice(),
  };
}());
