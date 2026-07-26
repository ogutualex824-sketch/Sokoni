/*!
 * sokoni-recommendations.js
 * Cross-hub personalised recommendation engine for SOKONI
 * Exposes: window.SokoniRecs
 */
(function (window) {
  'use strict';

  /* Self-bootstrap the shared image render helper (sokoni-image.js) if the host page
     didn't load it — so this engine's renderProductImage() upgrade activates on any
     page, independent of a per-page <script> tag (which, on index.html, is subject to a
     multi-agent deploy race on the shared file). Idempotent + fail-open: the render is
     already guarded (falls back to an inline <img>) if the helper isn't ready. */
  (function ensureSokoniImage(){
    try {
      if (typeof document === 'undefined' || window.renderProductImage) return;
      if (document.querySelector('script[data-sk-image-boot],script[src*="sokoni-image.js"]')) return;
      var s = document.createElement('script');
      s.src = 'sokoni-image.js';
      s.async = false;
      s.setAttribute('data-sk-image-boot','1');
      (document.head || document.documentElement).appendChild(s);
    } catch (_) { /* fail open */ }
  })();

  /* ── Firebase config (project sokoni-aeb26) ── */
  const FB_CONFIG = {
    apiKey:            'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE',
    authDomain: 'auth.mysokoni.co.ke',
    projectId:         'sokoni-aeb26',
    storageBucket:     'sokoni-aeb26.firebasestorage.app',
    messagingSenderId: '24799054989',
    appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4",measurementId:"G-QT32H65TJS",
  };

  /* ── localStorage keys ── */
  const KEY_VIEW   = 'sokoniViewHistory';
  const KEY_SEARCH = 'sokoniSearchHistory';
  const KEY_CART   = 'sokoniCart';
  const KEY_USER   = 'sokoniUser';
  const MAX_VIEW_HISTORY   = 100;
  const MAX_SEARCH_HISTORY = 50;

  /* ── Category → emoji mapping ── */
  const CAT_EMOJI = {
    fashion: '👗', electronics: '📱', beauty: '💄', food: '🍔',
    accessories: '👜', furniture: '🛋️', health: '💊', agriculture: '🌾',
    books: '📚', services: '🔧', cars: '🚗', property: '🏘️',
    sports: '⚽', fitness: '💪', entertainment: '🎵', banking: '🏦',
    legal: '⚖️', tech: '📱', digital: '💻', construction: '🏗️',
    cleaning: '🧹', plumbing: '🔧', electrical: '⚡', photography: '📷',
    catering: '🍳', default: '🛍️',
  };

  /* ── Inject CSS once ── */
  function _injectCSS() {
    if (document.getElementById('sk-recs-style')) return;
    const s = document.createElement('style');
    s.id = 'sk-recs-style';
    s.textContent = `
.sk-recs-widget{margin:24px 0;padding:0 16px;}
.sk-recs-title{font-size:15px;font-weight:800;color:white;margin-bottom:14px;}
.sk-recs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;}
.sk-rec-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;text-decoration:none;color:inherit;transition:all .2s;display:block;}
.sk-rec-card:hover{border-color:rgba(113,255,0,0.25);transform:translateY(-3px);}
.sk-rec-thumb{height:100px;display:flex;align-items:center;justify-content:center;font-size:40px;background:rgba(255,255,255,0.03);position:relative;overflow:hidden;}
.sk-rec-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
.sk-rec-body{padding:10px 12px;}
.sk-rec-name{font-size:13px;font-weight:700;color:white;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sk-rec-meta{font-size:10px;color:rgba(255,255,255,0.4);margin-bottom:4px;}
.sk-rec-price{font-size:13px;font-weight:900;color:#71ff00;}
.sk-recs-empty{font-size:13px;color:rgba(255,255,255,0.35);text-align:center;padding:24px 0;}
    `;
    document.head.appendChild(s);
  }

  /* ── XSS-safe escape ── */
  function _esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Read localStorage safely ── */
  function _ls(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }

  /* ── Write localStorage safely ── */
  function _lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ── Current unix timestamp (seconds) ── */
  function _now() { return Math.floor(Date.now() / 1000); }

  /* ── Recency decay factor: returns 0–1 (1 = just now, ~0 = 30 days ago) ── */
  function _decayFactor(ts) {
    const ageSeconds = _now() - (ts || 0);
    const halfLifeSeconds = 7 * 24 * 3600; // 7 days half-life
    return Math.pow(0.5, ageSeconds / halfLifeSeconds);
  }

  /* ── Emoji for item ── */
  function _emoji(item) {
    const cat = (item.category || item.type || '').toLowerCase();
    for (const key of Object.keys(CAT_EMOJI)) {
      if (cat.includes(key)) return CAT_EMOJI[key];
    }
    return item.emoji || CAT_EMOJI.default;
  }

  /* ── Build page URL for item type ── */
  function _itemUrl(item) {
    if (item.url) return item.url;
    const type = (item.type || 'product').toLowerCase();
    const id = item.id || '';
    if (type === 'service')  return 'services.html?id=' + encodeURIComponent(id);
    /* provider-profile.html is the public profile; provider.html is the
       provider's own dashboard and ignores an id entirely. */
    if (type === 'provider') return 'provider-profile.html?uid=' + encodeURIComponent(id);
    if (type === 'business' || type === 'mechanic')
                             return 'mechanic.html?id=' + encodeURIComponent(id);
    return 'product.html?id=' + encodeURIComponent(id);
  }

  /* ────────────────────────────────────────────────
     INTERNAL STATE
  ──────────────────────────────────────────────── */
  let _pool       = [];    // all fetched items from Firestore (or fallback)
  let _viewHist   = [];    // [{type,id,category,price,ts}]
  let _searchHist = [];    // [{q,ts}]
  let _cartItems  = [];    // array
  let _userRole   = 'guest';
  let _userCounty = '';
  let _ready      = false;
  let _initPromise = null;

  /* ────────────────────────────────────────────────
     FIREBASE FETCH
  ──────────────────────────────────────────────── */
  async function _fetchFirestore() {
    try {
      const { initializeApp, getApps } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'
      );
      const { getFirestore, collection, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );

      /* ══ APP CHECK — the reason every recommendation query was denied ══════
         This created a SECOND Firebase app ('sk-recs') and never initialised
         App Check on it. App Check is ENFORCED on Firestore, so every request
         from that app carried no App Check token and was rejected — surfacing
         as "Missing or insufficient permissions" even though products and
         mechanics are `allow read: if true` (firestore.rules:511, :493). The
         rules were never the problem; the request never got far enough to be
         evaluated against them.

         All four collections failed identically, which is what pointed away
         from a per-collection rules issue: products, services, providers and
         mechanics were all dead, so the homepage recommendation engine had
         never worked.

         Prefer the MAIN app where a page provides one — it already has App
         Check initialised (firebase.js:111), and reusing it avoids a second
         Firebase app entirely. index.html loads neither firebase.js nor
         sokoni-appcheck.js, so on the homepage we must initialise App Check
         ourselves, which is what the fallback below does.

         The site key is a reCAPTCHA v3 SITE key — public by design, and already
         present in firebase.js:112 and sokoni-appcheck.js:6. It is not a secret. */
      const APPCHECK_SITE_KEY = '6Lf93TktAAAAAIqCj8l3YM3dIoS1MIXpilsdnsxj';

      let app = (typeof window !== 'undefined' && window.firebaseApp) || null;

      if (!app) {
        const existingApp = getApps().find(a => a.name === 'sk-recs');
        app = existingApp || initializeApp(FB_CONFIG, 'sk-recs');

        /* Only initialise App Check on an app WE created — calling it twice on
           the same app throws, and a page-provided app already has it. */
        if (!existingApp) {
          try {
            const { initializeAppCheck, ReCaptchaV3Provider } = await import(
              'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js'
            );
            initializeAppCheck(app, {
              provider: new ReCaptchaV3Provider(APPCHECK_SITE_KEY),
              isTokenAutoRefreshEnabled: true,
            });
          } catch (e) {
            /* Non-fatal: without a token the reads below fail and the caller
               falls back to its static recommendations, which is the behaviour
               that has been in production all along. Logged so a future App
               Check change does not silently reinstate the original defect. */
            console.warn('[SokoniRecs] App Check init failed — reads will be denied:', e && e.message);
          }
        }
      }

      const db  = getFirestore(app);

      /* ══ WHICH COLLECTIONS A VISITOR CAN ACTUALLY READ ═══════════════════
         With App Check fixed above, `products` and `mechanics` load — both are
         `allow read: if true` (firestore.rules:511, :493).

         The other two remained denied, and the rules say that is CORRECT:

           providers  firestore.rules:153  allow read: if isAuthed()
                      Deliberately gated. An anonymous homepage visitor should
                      not be able to enumerate providers. The rule is right; the
                      unconditional query was wrong.
           services   NO match block anywhere in firestore.rules, and no
                      server-side use of collection('services') either. A
                      phantom collection — the query could never have succeeded.

         So this does NOT open the rules. Provider data is not anonymously
         browsable by design, and `providerProfiles` (the canonical provider
         record) is owner-only, so there is no public provider source to switch
         to. Least privilege is preserved: the engine simply stops asking for
         what the visitor may not have.

         `providers` is still queried for SIGNED-IN visitors, who are entitled
         to it — so no capability is lost, only failed requests. */
      const _signedIn = !!(typeof window !== 'undefined'
        && window.firebaseAuth && window.firebaseAuth.currentUser);

      const SPECS = [
        {
          col: 'products', type: 'product',
          title: d => d.title || d.name || '',
          category: d => d.category || '',
          location: d => d.location || d.city || '',
          price: d => d.price,
          sellerId: d => d.sellerId || d.uid || '',
          image: d => d.imageUrl || d.image || (Array.isArray(d.images) && d.images[0] && (d.images[0].url || d.images[0])) || d.thumbnail || d.photo || d.coverImage || '',
        },
        {
          col: 'services', type: 'service', _skip: true,   /* phantom collection — no rule, no server-side use */
          title: d => d.name || d.title || '',
          category: d => d.category || '',
          location: d => d.location || d.city || '',
          price: d => d.price,
          sellerId: d => d.providerId || d.uid || '',
          image: d => d.image || d.imageUrl || d.thumbnail || d.photo || '',
        },
        {
          col: 'providers', type: 'provider', _authOnly: true,  /* firestore.rules:153 — isAuthed() */
          title: d => d.name || '',
          category: d => d.category || '',
          location: d => d.location || '',
          price: d => d.rate,
          sellerId: d => d.uid || d.id || '',
          image: d => d.image || d.imageUrl || d.thumbnail || d.photo || d.avatar || '',
        },
        {
          col: 'mechanics', type: 'business',
          title: d => d.name || '',
          category: d => d.type || d.spec || 'Business',
          location: d => d.location || '',
          price: d => null,
          sellerId: d => d.uid || d.id || '',
          image: d => d.image || d.imageUrl || d.thumbnail || d.logo || d.photo || '',
        },
      ];

      /* Drop collections this visitor cannot read, rather than firing requests
         that are guaranteed to be denied and logged as errors. */
      const READABLE = SPECS.filter(s => !s._skip && (!s._authOnly || _signedIn));

      const results = await Promise.all(
        READABLE.map(async spec => {
          try {
            const snap = await getDocs(collection(db, spec.col));
            const items = [];
            snap.forEach(docSnap => {
              const d = docSnap.data();
              items.push({
                id:         docSnap.id,
                type:       spec.type,
                title:      spec.title(d)    || '(Untitled)',
                category:   spec.category(d) || '',
                location:   spec.location(d) || '',
                price:      spec.price(d)    != null ? Number(spec.price(d)) : null,
                sellerId:   spec.sellerId(d) || '',
                viewCount:  Number(d.viewCount || 0),
                county:     (d.county || d.location || '').toLowerCase(),
                image:      spec.image ? spec.image(d) : '',
              });
            });
            return items;
          } catch (e) {
            console.warn('[SokoniRecs] Fetch error for', spec.col, e.message);
            return [];
          }
        })
      );

      return results.flat();
    } catch (e) {
      console.warn('[SokoniRecs] Firebase unavailable, using localStorage-only pool:', e.message);
      return [];
    }
  }

  /* ── Build a local pool from view history when Firestore is unavailable ── */
  function _buildLocalPool() {
    return _viewHist.map(v => ({
      id:        v.id,
      type:      v.type || 'product',
      title:     v.title || v.id || 'Item',
      category:  v.category || '',
      location:  v.location || '',
      price:     v.price || null,
      sellerId:  v.sellerId || '',
      viewCount: 0,
      county:    '',
    }));
  }

  /* ────────────────────────────────────────────────
     SCORING ENGINE
  ──────────────────────────────────────────────── */

  /**
   * Build a category affinity map from view + cart history.
   * Returns { category: score } where score is the sum of decay-weighted hits.
   */
  function _categoryAffinity() {
    const aff = {};
    _viewHist.forEach(v => {
      if (!v.category) return;
      const cat = v.category.toLowerCase();
      aff[cat] = (aff[cat] || 0) + _decayFactor(v.ts);
    });
    _cartItems.forEach(c => {
      const cat = (c.category || '').toLowerCase();
      if (cat) aff[cat] = (aff[cat] || 0) + 1.5; // cart is strong signal
    });
    return aff;
  }

  /** Top-N categories by affinity score */
  function _topCategories(aff, n) {
    return Object.entries(aff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(e => e[0]);
  }

  /** Price range affinity: returns {min, max} based on history */
  function _priceRange() {
    const prices = _viewHist
      .filter(v => v.price && v.price > 0)
      .map(v => v.price);
    if (!prices.length) return null;
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { min: avg * 0.3, max: avg * 3 };
  }

  /** Already-viewed item IDs (to avoid re-recommending very recently seen) */
  function _recentlyViewedIds() {
    const cutoff = _now() - 3600; // last hour
    return new Set(_viewHist.filter(v => v.ts > cutoff).map(v => v.id));
  }

  /**
   * Score a single item given the current affinity context.
   * Returns a numeric score (higher = better recommendation).
   */
  function _scoreItem(item, ctx) {
    let score = 0;

    // 1. Category affinity (top-3 categories get a strong boost)
    const cat = (item.category || '').toLowerCase();
    if (ctx.topCats[0] && cat.includes(ctx.topCats[0])) score += 3.0;
    else if (ctx.topCats[1] && cat.includes(ctx.topCats[1])) score += 2.0;
    else if (ctx.topCats[2] && cat.includes(ctx.topCats[2])) score += 1.0;
    else {
      // partial match from full affinity map
      const rawAff = ctx.aff[cat] || 0;
      score += rawAff * 0.5;
    }

    // 2. Location affinity — same county as user
    if (ctx.county && item.county && item.county.includes(ctx.county)) {
      score += 1.2;
    }

    // 3. Price range affinity
    if (ctx.priceRange && item.price != null) {
      if (item.price >= ctx.priceRange.min && item.price <= ctx.priceRange.max) {
        score += 0.8;
      }
    }

    // 4. Popular boost (viewCount, capped at 1.0)
    score += Math.min(item.viewCount / 100, 1.0);

    // 5. Penalty for very recently viewed items
    if (ctx.recentIds.has(item.id)) score -= 2.0;

    return score;
  }

  /**
   * Apply diversity constraint: at most 2 items per seller/provider.
   */
  function _applyDiversity(ranked, limit) {
    const sellerCount = {};
    const result = [];
    for (const item of ranked) {
      const sid = item.sellerId || item.id;
      if ((sellerCount[sid] || 0) >= 2) continue;
      sellerCount[sid] = (sellerCount[sid] || 0) + 1;
      result.push(item);
      if (result.length >= limit) break;
    }
    return result;
  }

  /* ────────────────────────────────────────────────
     PUBLIC API
  ──────────────────────────────────────────────── */
  const SokoniRecs = {};

  /**
   * SokoniRecs.init()
   * Load history from localStorage, fetch pool from Firestore.
   * Returns a Promise that resolves when ready.
   */
  SokoniRecs.init = function () {
    if (_initPromise) return _initPromise;

    _initPromise = (async function () {
      _injectCSS();

      // Load local data
      _viewHist   = _ls(KEY_VIEW,   []);
      _searchHist = _ls(KEY_SEARCH, []);
      _cartItems  = _ls(KEY_CART,   []);
      const user  = _ls(KEY_USER,   {});
      _userRole   = user.activeRole || user.role || 'guest';
      _userCounty = (user.county || user.location || '').toLowerCase();

      // Fetch content pool
      const firestorePool = await _fetchFirestore();
      _pool = firestorePool.length ? firestorePool : _buildLocalPool();
      _ready = true;
    })();

    return _initPromise;
  };

  /**
   * SokoniRecs.getForYou(limit=8)
   * Returns Promise<item[]> — top personalised picks.
   */
  SokoniRecs.getForYou = function (limit) {
    limit = limit || 8;
    return SokoniRecs.init().then(function () {
      if (!_pool.length) return [];

      const aff     = _categoryAffinity();
      const topCats = _topCategories(aff, 3);
      const ctx = {
        aff,
        topCats,
        county:     _userCounty,
        priceRange: _priceRange(),
        recentIds:  _recentlyViewedIds(),
      };

      const scored = _pool
        .map(item => ({ item, score: _scoreItem(item, ctx) }))
        .sort((a, b) => b.score - a.score)
        .map(s => s.item);

      return _applyDiversity(scored, limit);
    });
  };

  /**
   * SokoniRecs.getRelated(itemId, itemType, limit=6)
   * Returns Promise<item[]> — items similar to a given one (same category,
   * different seller, different id).
   */
  SokoniRecs.getRelated = function (itemId, itemType, limit) {
    limit = limit || 6;
    return SokoniRecs.init().then(function () {
      // Find the source item
      const src = _pool.find(p => p.id === itemId && p.type === (itemType || p.type));
      if (!src && !_pool.length) return [];

      const srcCat = src ? src.category.toLowerCase() : '';
      const srcSeller = src ? src.sellerId : '';

      const candidates = _pool.filter(p => {
        if (p.id === itemId) return false;
        if (srcSeller && p.sellerId === srcSeller) return false;
        if (srcCat) return (p.category || '').toLowerCase().includes(srcCat) ||
                          srcCat.includes((p.category || '').toLowerCase());
        return p.type === (itemType || p.type);
      });

      // Sort by viewCount desc (popularity)
      candidates.sort((a, b) => b.viewCount - a.viewCount);
      return _applyDiversity(candidates, limit);
    });
  };

  /**
   * SokoniRecs.getRelatedServices(category, limit=4)
   * Returns Promise<item[]> — services in the given category.
   */
  SokoniRecs.getRelatedServices = function (category, limit) {
    limit = limit || 4;
    return SokoniRecs.init().then(function () {
      const cat = (category || '').toLowerCase();
      return _pool
        .filter(p => p.type === 'service' &&
                     (cat === '' || (p.category || '').toLowerCase().includes(cat)))
        .sort((a, b) => b.viewCount - a.viewCount)
        .slice(0, limit);
    });
  };

  /**
   * SokoniRecs.getRelatedBusinesses(category, limit=4)
   * Returns Promise<item[]> — businesses/providers in the given category.
   */
  SokoniRecs.getRelatedBusinesses = function (category, limit) {
    limit = limit || 4;
    return SokoniRecs.init().then(function () {
      const cat = (category || '').toLowerCase();
      return _pool
        .filter(p => (p.type === 'business' || p.type === 'provider') &&
                     (cat === '' || (p.category || '').toLowerCase().includes(cat)))
        .sort((a, b) => b.viewCount - a.viewCount)
        .slice(0, limit);
    });
  };

  /**
   * SokoniRecs.trackView(type, id, category, price)
   * Record that the user viewed an item. Call on page/item open.
   */
  SokoniRecs.trackView = function (type, id, category, price) {
    if (!id) return;
    _viewHist = _ls(KEY_VIEW, []);
    // Remove existing entry for this id
    _viewHist = _viewHist.filter(v => !(v.id === id && v.type === type));
    _viewHist.unshift({ type, id, category: category || '', price: price || null, ts: _now() });
    if (_viewHist.length > MAX_VIEW_HISTORY) _viewHist.length = MAX_VIEW_HISTORY;
    _lsSet(KEY_VIEW, _viewHist);
  };

  /**
   * SokoniRecs.trackSearch(q)
   * Record a search query.
   */
  SokoniRecs.trackSearch = function (q) {
    if (!q || !q.trim()) return;
    _searchHist = _ls(KEY_SEARCH, []);
    _searchHist = _searchHist.filter(s => s.q !== q.trim());
    _searchHist.unshift({ q: q.trim(), ts: _now() });
    if (_searchHist.length > MAX_SEARCH_HISTORY) _searchHist.length = MAX_SEARCH_HISTORY;
    _lsSet(KEY_SEARCH, _searchHist);
  };

  /**
   * SokoniRecs.renderWidget(containerId, items, title, opts)
   * Renders a card grid into an element with the given id.
   * opts.viewCount — number of items in view history (drives AI confidence badge)
   */
  SokoniRecs.renderWidget = function (containerId, items, title, opts) {
    _injectCSS();
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!items || !items.length) {
      container.innerHTML =
        '<div class="sk-recs-widget"><div class="sk-recs-empty">No recommendations yet — browse a few items to personalise your feed.</div></div>';
      return;
    }

    /* AI Policy: recommendations are PREDICTED — derive confidence from browse history */
    let policyBadge = '';
    if (window.SokoniAIPolicy) {
      const p = window.SokoniAIPolicy;
      const viewCount = (opts && opts.viewCount != null) ? opts.viewCount : _viewHist.length;
      const conf = p.scoreConfidence({
        dataPoints:  viewCount,
        hasRealTime: false,
        ageMs:       viewCount > 0 ? ((_now() - (_viewHist[0] && _viewHist[0].ts || _now())) * 1000) : Infinity,
      });
      const pv = p.predicted(null, {
        confidence: conf,
        model:      'sokoni-collab-filter',
        reason:     viewCount
          ? 'Based on your browsing, cart and search history (' + viewCount + ' interactions)'
          : 'Based on trending items and location — browse more to personalise',
      });
      policyBadge = p.badge(pv);
    }

    const cards = items.map(function (item) {
      const url      = _esc(_itemUrl(item));
      const emoji    = _esc(_emoji(item));
      const name     = _esc(item.title || 'Item');
      const cat      = _esc(item.category || '');
      const loc      = _esc(item.location || '');
      const meta     = [cat, loc].filter(Boolean).join(' · ');
      const price    = item.price != null
        ? 'KES ' + _esc(Number(item.price).toLocaleString())
        : '';
      const trackClick = 'SokoniRecs.trackView(' +
        JSON.stringify(item.type) + ',' +
        JSON.stringify(item.id)   + ',' +
        JSON.stringify(item.category) + ',' +
        (item.price != null ? item.price : 'null') + ')';
      /* Emoji sits in the thumb as text; if image is present the <img> overlays it
         via absolute positioning (CSS). If the image fails to load, onerror removes
         the img element and the emoji underneath is revealed automatically. */
      const imgTag = item.image
        ? (window.renderProductImage
            ? window.renderProductImage({ src: item.image, alt: name, wrap: false, fallbackMode: 'remove' })
            : '<img src="' + _esc(item.image) + '" loading="lazy" decoding="async" alt="' + name + '" onerror="this.remove()">')
        : '';

      return `<a href="${url}" class="sk-rec-card" onclick="${trackClick}">
  <div class="sk-rec-thumb">${emoji}${imgTag}</div>
  <div class="sk-rec-body">
    <div class="sk-rec-name">${name}</div>
    <div class="sk-rec-meta">${meta}</div>
    ${price ? '<div class="sk-rec-price">' + price + '</div>' : ''}
  </div>
</a>`;
    }).join('\n');

    container.innerHTML =
      '<section class="sk-recs-widget">' +
        '<h3 class="sk-recs-title">✨ ' + _esc(title || 'Recommended For You') + policyBadge + '</h3>' +
        '<div class="sk-recs-grid">' + cards + '</div>' +
      '</section>';
  };

  /**
   * SokoniRecs.injectRelatedSection(type, id, category)
   * Finds #sk-related-inject on the page and renders a "You May Also Like" widget.
   */
  SokoniRecs.injectRelatedSection = function (type, id, category) {
    SokoniRecs.getRelated(id, type, 6).then(function (items) {
      if (!items.length) {
        // Fall back to same-category recommendations
        return SokoniRecs.getForYou(6);
      }
      return items;
    }).then(function (items) {
      SokoniRecs.renderWidget('sk-related-inject', items, 'You May Also Like');
    });
  };

  /* Export */
  window.SokoniRecs = SokoniRecs;

})(window);
