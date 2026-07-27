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
============================================================================ */

(function () {
  'use strict';

  var FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  /* Reads are gated by firestore.rules on `status`; a list query that cannot
     prove it is safe is denied outright, not merely slow. Keep in sync with
     the providers rule and with SPECS in sokoni-firestore-search.js. */
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

  var _sdk = null, _cache = null, _cacheAt = 0, _inflight = null;

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
  var LS_KEY = 'sokoniProvidersLastGood';
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

  /* ── Category aliases ──────────────────────────────────────────────────────
     Hub pages ask for a bucket, not a slug: the Cleaning hub must show both
     cleaners and mamafua. Aliases are expanded before matching so a provider
     filed under `laundry` still surfaces on a `cleaning` page. */
  var CATEGORY_ALIASES = {
    cleaning:      ['cleaning', 'laundry', 'housekeeping'],
    laundry:       ['laundry', 'mamafua', 'cleaning'],
    'home-repairs':['home-repairs', 'handyman', 'plumbing', 'electrical'],
    entertainment: ['entertainment', 'mc', 'dj', 'live-band', 'comedian', 'dancer'],
    beauty:        ['beauty', 'hair-beauty'],
    tech:          ['phone-repair', 'computer-repair', 'electronics-repair'],
    health:        ['healthcare', 'clinic', 'pharmacy', 'home-doctor'],
  };

  /* Display labels. A provider carries its own categoryLabel; this is the
     fallback for records written before that field existed. */
  var CATEGORY_LABEL = {
    laundry: 'Mama Fua (Laundry)', cleaning: 'Cleaning', plumbing: 'Plumbing',
    electrical: 'Electrical Work', 'phone-repair': 'Phone Repair',
    'computer-repair': 'IT Repair', 'hair-beauty': 'Hair & Beauty',
    photography: 'Photography', videography: 'Videography', tutoring: 'Tutoring',
    fitness: 'Fitness Training', catering: 'Catering', events: 'Event Planning',
    marketing: 'Marketing', accounting: 'Accounting', legal: 'Legal',
    'delivery-service': 'Delivery', 'home-repairs': 'Home Repairs',
    mc: 'MC / Emcee', dj: 'DJ / Disc Jockey', mechanics: 'Mechanic',
    gardening: 'Gardening', security: 'Security',
  };

  var CATEGORY_EMOJI = {
    laundry: '🧺', cleaning: '🧹', plumbing: '🔧', electrical: '⚡',
    'phone-repair': '📱', 'computer-repair': '💻', 'hair-beauty': '💇',
    photography: '📸', videography: '🎥', tutoring: '📚', fitness: '🏋️',
    catering: '🍲', events: '🎉', marketing: '📈', accounting: '🧮',
    legal: '⚖️', 'delivery-service': '🚚', 'home-repairs': '🔨',
    mc: '🎤', dj: '🎧', mechanics: '🔧', gardening: '🌿', security: '🛡️',
  };

  /* ── XSS-safe escape. Provider names and bios are user-supplied and land in
     innerHTML on every page that renders a card. ───────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function loadSdk() {
    if (!_sdk) _sdk = import(FIREBASE_SDK);
    return _sdk;
  }

  function db() {
    return window.firebaseDB || null;
  }

  /* ── Normalisation ─────────────────────────────────────────────────────────
     Documents were written by more than one path over time, so field names
     vary (name / businessName / fullName, location / city, photo / photoURL).
     Every consumer gets one stable shape instead of repeating this guesswork.
     Absent fields stay absent — nothing is invented to fill a card. */
  function normalize(id, d) {
    d = d || {};
    var cats = Array.isArray(d.categories) && d.categories.length
      ? d.categories
      : (d.category ? [d.category] : []);
    var primary = d.category || cats[0] || '';
    return {
      uid:           d.uid || id,
      id:            id,
      providerId:    d.providerId || id,
      name:          d.name || d.businessName || d.fullName || d.displayName || '',
      businessName:  d.businessName || '',
      category:      primary,
      categories:    cats,
      categoryLabel: d.categoryLabel || CATEGORY_LABEL[primary] || primary || 'Professional',
      emoji:         CATEGORY_EMOJI[primary] || '👷',
      serviceType:   d.serviceType || '',
      description:   d.description || d.bio || '',
      location:      d.location || d.city || '',
      city:          d.city || '',
      phone:         d.phone || '',
      skills:        Array.isArray(d.skills) ? d.skills : [],
      /* Counters are shown only when real. A provider with no completed jobs
         renders no jobs figure rather than a flattering zero-dressed-as-new. */
      rating:        typeof d.rating === 'number' && d.rating > 0 ? d.rating : null,
      reviewCount:   Number(d.reviewCount || d.ratingCount || 0),
      jobsCompleted: Number(d.jobsCompleted || d.bookingCount || 0),
      rate:          d.rate != null && d.rate !== '' ? Number(d.rate) : null,
      rateType:      d.rateType || '',
      photo:         d.photo || d.photoURL || d.image || '',
      verified:      d.verified === true,
      featured:      d.featured === true,
      available:     d.available !== false && d.isAvailable !== false,
      acceptsBookings: d.acceptsBookings !== false,
      chatEnabled:   d.chatEnabled !== false,
      profileUrl:    'provider-profile.html?uid=' + encodeURIComponent(d.uid || id),
      /* Fields the provider has still to supply — lets a page prompt rather
         than render a hole. */
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
      var d = db();
      if (!d) {
        return Promise.resolve(degrade(new Error('Firestore is not initialised on this page')));
      }
      return loadSdk().then(function (m) {
        var q = m.query(
          m.collection(d, 'providers'),
          m.where('status', 'in', VISIBLE_STATUS),
          m.orderBy('updatedAt', 'desc'),
          m.limit(SCAN_LIMIT)
        );
        /* App Check on this project 403s intermittently, and its token
           auto-refreshes — so a read that fails now frequently succeeds a
           second later with a fresh token. One transparent retry converts most
           of those transient failures into a normal load, before any cache or
           error path is considered. */
        return withTimeout(m.getDocs(q), 'providers list').catch(function (e1) {
          return new Promise(function (res) { setTimeout(res, 1500); })
            .then(function () { return withTimeout(m.getDocs(q), 'providers list (retry)'); });
        });
      }).then(function (snap) {
        /* An unreachable backend does NOT reject. getDocs falls back to the
           local persistence cache and resolves normally — on a cold page that
           cache is empty, so a blocked read (App Check rejection, offline,
           rules denial at the transport layer) arrives here as a perfectly
           successful snapshot of zero documents. Rendered naively that becomes
           "No providers yet", which tells the visitor something false about
           the marketplace and hides the outage.

           snap.metadata.fromCache is the discriminator: served from cache AND
           empty means we never heard from the server and genuinely do not know
           whether the registry is empty. Report that as an error. An empty
           result that DID come from the server is a real, trustworthy empty. */
        if (snap.metadata && snap.metadata.fromCache && snap.size === 0) {
          var err = new Error('Firestore unreachable — served an empty cache, not an empty registry');
          err.code = 'unavailable';
          console.warn('[SokoniProviders] ' + err.message);
          return degrade(err);
        }
        var out = [];
        snap.forEach(function (doc) {
          var p = normalize(doc.id, doc.data());
          /* A record with no name cannot be rendered as a card and must not
             become a blank tile in the grid. */
          if (p.name) out.push(p);
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
    var key = String(cat).toLowerCase();
    return (CATEGORY_ALIASES[key] || [key]).map(String);
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

    var d = db();
    if (!d) return Promise.resolve(degradeOne(new Error('Firestore is not initialised')));
    return loadSdk().then(function (m) {
      var ref = m.doc(d, 'providers', String(uid));
      /* One transparent retry, same reasoning as list(): intermittent App
         Check failures usually clear on the next token. */
      return withTimeout(m.getDoc(ref), 'provider read').catch(function () {
        return new Promise(function (res) { setTimeout(res, 1500); })
          .then(function () { return withTimeout(m.getDoc(ref), 'provider read (retry)'); });
      });
    }).then(function (snap) {
      /* Same trap as list(): offline, getDoc resolves from an empty cache and
         reports the document as non-existent. "This provider does not exist"
         is a much worse thing to tell a visitor than "we could not load it". */
      if (!snap.exists() && snap.metadata && snap.metadata.fromCache) {
        return degradeOne(new Error('Firestore unreachable — cannot confirm this provider exists'));
      }
      if (!snap.exists()) return { provider: null, error: null };
      var raw = snap.data();
      if (VISIBLE_STATUS.indexOf(String(raw.status)) === -1) {
        return { provider: null, error: null };   /* not publicly visible */
      }
      return { provider: normalize(snap.id, raw), error: null };
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
         + '<a href="provider-onboarding.html" style="display:inline-block;padding:10px 20px;'
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
    categoryLabel: function (c) { return CATEGORY_LABEL[c] || c; },
    categoryEmoji: function (c) { return CATEGORY_EMOJI[c] || '👷'; },
    invalidate: function () { _cache = null; _cacheAt = 0; },
    VISIBLE_STATUS: VISIBLE_STATUS.slice(),
  };
}());
