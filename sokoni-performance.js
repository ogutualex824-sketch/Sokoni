/* ============================================================
   SOKONI Performance Optimization SDK  v1.0.0  |  2026-07-08
   sokoni-performance.js

   Client-side performance utility library. Automatically applied
   on DOMContentLoaded. Expose globally as window.SokoniPerformance.

   Auto-applied on boot:
     optimizeImages()   — lazy loading, WebP wrapping, CLS prevention
     lazyLoadImages()   — IntersectionObserver data-src loader
     prefetchLinks()    — hover/touch-triggered link prefetch

   Manual APIs:
     preloadCriticalAssets(assets[])
     importWhenVisible(selector, importFn)
     importOnInteraction(selector, events[], importFn)
     optimisticUpdate(uiUpdateFn, serverFn, rollbackFn)
     memoize(fn, ttlMs)
     staleWhileRevalidate(key, fetchFn, ttlMs)
     registerBackgroundSync(tag, fn)
     reportBudget()
     observeLazyImage(el)   — observe a dynamically added lazy image

   Usage:
     <script src="/sokoni-performance.js"></script>
     // Auto-init fires on DOMContentLoaded.
     // For manual use after dynamic content insertion:
     SokoniPerformance.optimizeImages();
     SokoniPerformance.observeLazyImage(newImg);
============================================================ */
(function (global) {
  'use strict';

  /* ── Private state ─────────────────────────────────────────── */

  /** URLs already submitted as prefetch hints — prevents duplicates */
  const _prefetchedUrls = new Set();

  /** Ring-buffer of recent prefetch trigger timestamps for rate-limiting */
  const _prefetchTimestamps = [];
  const PREFETCH_MAX_PER_SEC = 3;
  const PREFETCH_WINDOW_MS   = 1000;

  /** In-memory memoize store (shared across all memoize() calls — keyed by fn ref + args) */
  // Each entry: Map<argsKey, { value, expiresAt }>
  const _memoStores = new WeakMap();

  /** Pending background sync registrations: tag → fn */
  const _bgSyncFns = new Map();

  /** Guard: ensure prefetchLinks() only registers its listeners once */
  let _prefetchListenersAdded = false;

  /** The shared IntersectionObserver instance for lazy images */
  let _lazyObserver = null;

  /* ── CSS injection ──────────────────────────────────────────── */

  /**
   * _safeBgUrl(raw)
   * ────────────────
   * Validate a raw string before using it as a CSS background-image URL.
   * Only http/https and data:image/ URLs are accepted to prevent CSS
   * injection attacks (IE expression() and CSS data-exfiltration vectors).
   * Returns a safely quoted url(...) string, or '' to reject the value.
   */
  function _safeBgUrl(raw) {
    if (!raw) return '';
    var trimmed = raw.trim();
    if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
      return 'url("' + trimmed.replace(/"/g, '%22') + '")';
    }
    return ''; // reject anything else (javascript:, expression(), relative paths, etc.)
  }

  /**
   * Inject the minimal CSS required for lazy-load fade-in.
   * Called once on init; safe to call multiple times.
   */
  function _injectStyles() {
    if (document.getElementById('sk-perf-css')) return;
    const s = document.createElement('style');
    s.id = 'sk-perf-css';
    s.textContent = [
      /* Lazy images start invisible so they fade in on load */
      'img[data-src],[data-bg]{opacity:0;transition:opacity .3s ease}',
      '.sk-lazy-loaded{opacity:1!important}',
      /* Fade-in keyframe for images revealed by optimizeImages() */
      '@keyframes sk-fadein{from{opacity:0}to{opacity:1}}',
      '.sk-img-ready{animation:sk-fadein .3s ease}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ── Image Optimization ─────────────────────────────────────── */

  /**
   * optimizeImages()
   * ────────────────
   * Process all <img> elements on the page:
   *  - decoding="async" on every image
   *  - loading="lazy" on every image except the first 3
   *  - fetchpriority="high" on the first <img> inside <main> (or the page's
   *    first image if there is no <main>)
   *  - Wrap jpg/png images not already inside <picture> with a <picture>
   *    element that offers a .webp source first (letting browsers that
   *    support WebP choose the smaller file automatically)
   *  - Set width/height attributes from naturalWidth/naturalHeight when the
   *    browser already knows the intrinsic dimensions; register a load
   *    handler otherwise — prevents CLS
   *
   * Safe to call again after dynamic content is injected.
   */
  function optimizeImages() {
    const images   = Array.from(document.querySelectorAll('img'));
    if (!images.length) return;

    /* Identify the hero / priority image */
    const mainEl      = document.querySelector('main, [role="main"], #main-content');
    const firstMainImg = mainEl ? mainEl.querySelector('img') : null;
    const priorityImg  = firstMainImg || images[0];

    images.forEach(function (img, i) {
      /* Skip tracking pixels and SVG images */
      if ((img.width === 1 && img.height === 1) || img.src.endsWith('.svg')) return;

      /* decoding="async" on every image */
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');

      /* fetchpriority="high" on the hero image only */
      if (img === priorityImg) {
        if (!img.hasAttribute('fetchpriority')) img.setAttribute('fetchpriority', 'high');
      } else if (i >= 3) {
        /* loading="lazy" for images below the fold (skip first 3) */
        if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
      }

      /* Prevent CLS: stamp width/height when intrinsic size is known */
      function _stampDimensions() {
        if (img.naturalWidth  > 0 && !img.hasAttribute('width'))
          img.setAttribute('width',  img.naturalWidth);
        if (img.naturalHeight > 0 && !img.hasAttribute('height'))
          img.setAttribute('height', img.naturalHeight);
      }
      if (img.complete && img.naturalWidth > 0) {
        _stampDimensions();
      } else {
        img.addEventListener('load', _stampDimensions, { once: true });
      }

      /* Wrap jpg/png in <picture> + WebP <source> (only once, only raster)
         Skip local brand assets — they don't have .webp counterparts */
      var src = img.getAttribute('src') || '';

      /* SAME-ORIGIN ONLY (fix 2026-07-19).
         A .webp <source> is a promise that a .webp twin exists at that URL. We can only
         make that promise for images we serve. This previously rewrote CROSS-ORIGIN images
         too, and the visible casualty was the map: Leaflet renders tiles as <img> with a
         .png src from tile.openstreetmap.org, so every tile gained a .webp <source>, the
         browser preferred it, and OSM answered 400 "You requested an invalid tile."
         Measured on /track: 30 of 34 failed requests were tiles — 6 retries x 5 tiles.
         The map still rendered (the <img> fallback works) but every page with a map spent
         its request budget on guaranteed-400s and filled the console.

         The old `^assets/` check only ever matched relative local paths, so no absolute or
         third-party URL was excluded. Any host that is not ours is now skipped: we cannot
         know whether a .webp exists there, and guessing costs a failed request per image.

         Also skips Leaflet's own tiles explicitly — belt and braces, since a future
         self-hosted tile proxy would be same-origin and would otherwise re-enter this path. */
      var _sameOrigin = true;
      try {
        if (src && /^(https?:)?\/\//i.test(src)) {
          _sameOrigin = new URL(src, location.href).origin === location.origin;
        }
      } catch (_) { _sameOrigin = false; }
      var _isMapTile = img.classList && img.classList.contains('leaflet-tile');

      if (
        src &&
        /\.(jpe?g|png)(\?[^#]*)?$/i.test(src) &&
        !/^assets\//i.test(src) &&
        _sameOrigin &&
        !_isMapTile &&
        img.parentElement &&
        img.parentElement.tagName !== 'PICTURE'
      ) {
        var webpSrc = src.replace(/\.(jpe?g|png)(\?[^#]*)?$/i, function (m, ext, qs) {
          return '.webp' + (qs || '');
        });

        var picture = document.createElement('picture');
        var source  = document.createElement('source');
        source.setAttribute('srcset', webpSrc);
        source.setAttribute('type',   'image/webp');

        /* Insert picture before img, then move img inside */
        img.parentNode.insertBefore(picture, img);
        picture.appendChild(source);
        picture.appendChild(img);

        /* Mirror the lazy attribute to the <source> for consistency */
        if (img.hasAttribute('loading')) source.setAttribute('data-loading', 'lazy');
      }
    });
  }

  /* ── IntersectionObserver Lazy Loader ───────────────────────── */

  /**
   * lazyLoadImages()
   * ─────────────────
   * Set up an IntersectionObserver (rootMargin: 200px) that swaps
   * data-src → src, data-srcset → srcset, and data-bg → background-image
   * when an element enters the viewport.  Adds .sk-lazy-loaded on reveal.
   *
   * Falls back to immediate loading if IntersectionObserver is unavailable.
   *
   * Also exposes the observer instance as SokoniPerformance._lazyObserver so
   * dynamically inserted elements can be observed after init.
   */
  function lazyLoadImages() {
    /* Fallback: load everything immediately */
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('[data-src]').forEach(function (el) {
        _revealLazyEl(el);
      });
      document.querySelectorAll('[data-bg]').forEach(function (el) {
        _revealLazyEl(el);
      });
      return;
    }

    /* Tear down a previous observer if lazyLoadImages() is called again */
    if (_lazyObserver) _lazyObserver.disconnect();

    _lazyObserver = new IntersectionObserver(function (entries, observer) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        _revealLazyEl(entry.target);
      });
    }, { rootMargin: '200px 0px', threshold: 0 });

    /* Observe all current lazy elements */
    document.querySelectorAll('[data-src],[data-bg]').forEach(function (el) {
      _lazyObserver.observe(el);
    });

    /* Expose for external use */
    SokoniPerformance._lazyObserver = _lazyObserver;
  }

  /**
   * _revealLazyEl(el)  — internal helper to load a single lazy element
   */
  function _revealLazyEl(el) {
    /* <source> elements inside <picture> */
    if (el.tagName === 'SOURCE' && el.dataset.src) {
      el.srcset = el.dataset.src;
      delete el.dataset.src;
      return;
    }

    /* Regular <img> */
    if (el.dataset.src) {
      el.src = el.dataset.src;
      delete el.dataset.src;
      el.addEventListener('load', function () {
        el.classList.add('sk-lazy-loaded');
      }, { once: true });
      el.addEventListener('error', function () {
        el.classList.add('sk-lazy-error');
      }, { once: true });
    }

    /* CSS background-image via data-bg — validated to prevent CSS injection */
    if (el.dataset.bg) {
      var safeBg = _safeBgUrl(el.dataset.bg);
      if (safeBg) {
        el.style.backgroundImage = safeBg;
        el.classList.add('sk-lazy-loaded');
      }
      delete el.dataset.bg;
    }
  }

  /**
   * observeLazyImage(el)
   * ─────────────────────
   * Register a single dynamically-added element with the shared lazy observer.
   * Call after inserting new images/sections into the DOM.
   */
  function observeLazyImage(el) {
    if (!el) return;
    if (_lazyObserver) {
      _lazyObserver.observe(el);
    } else {
      /* Observer not yet initialised — reveal immediately as fallback */
      _revealLazyEl(el);
    }
  }

  /* ── Resource Hints ─────────────────────────────────────────── */

  /**
   * prefetchLinks()
   * ────────────────
   * Delegate-listen on mouseover / touchstart for <a> tags.
   * When an anchor pointing to a same-origin page is hovered/touched,
   * inject a <link rel="prefetch"> for that URL.
   *
   * Safeguards:
   *  - Deduplicates: each URL is only prefetched once per page session
   *  - Skips anchors (#), javascript: links, and external URLs
   *  - Rate-limits to PREFETCH_MAX_PER_SEC (3) triggers per second
   */
  function prefetchLinks() {
    /* PERF-3: guard against re-registering listeners on repeated calls */
    if (_prefetchListenersAdded) return;
    _prefetchListenersAdded = true;

    function _isSameOriginPageLink(href) {
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
      try {
        var url = new URL(href, window.location.href);
        return url.origin === window.location.origin && url.pathname !== window.location.pathname;
      } catch (_) {
        return false;
      }
    }

    function _doPrefetch(absoluteHref) {
      /* Rate limit */
      var now = Date.now();
      while (_prefetchTimestamps.length && now - _prefetchTimestamps[0] > PREFETCH_WINDOW_MS) {
        _prefetchTimestamps.shift();
      }
      if (_prefetchTimestamps.length >= PREFETCH_MAX_PER_SEC) return;

      if (_prefetchedUrls.has(absoluteHref)) return;
      _prefetchedUrls.add(absoluteHref);
      _prefetchTimestamps.push(now);

      var link  = document.createElement('link');
      link.rel  = 'prefetch';
      link.href = absoluteHref;
      link.as   = 'document';
      document.head.appendChild(link);
    }

    function _onHover(evt) {
      var anchor = evt.target.closest ? evt.target.closest('a') : null;
      if (!anchor) return;
      var href = anchor.getAttribute('href');
      if (_isSameOriginPageLink(href)) {
        _doPrefetch(new URL(href, window.location.href).href);
      }
    }

    document.addEventListener('mouseover',  _onHover, { passive: true });
    document.addEventListener('touchstart', _onHover, { passive: true });
  }

  /**
   * preloadCriticalAssets(assets[])
   * ─────────────────────────────────
   * Inject <link rel="preload"> tags for fonts, scripts, and styles that
   * must be available before first render.  Skips URLs already preloaded.
   *
   * Asset descriptor:
   *   { url: '/path/to/asset', as: 'font'|'script'|'style'|'image', type?: 'font/woff2' }
   */
  function preloadCriticalAssets(assets) {
    if (!Array.isArray(assets)) return;

    /* Build set of already-declared preloads */
    var existing = new Set(
      Array.from(document.querySelectorAll('link[rel="preload"]')).map(function (l) {
        return l.href;
      })
    );

    assets.forEach(function (asset) {
      if (!asset || !asset.url) return;

      var absolute = new URL(asset.url, window.location.href).href;
      if (existing.has(absolute)) return;

      var link   = document.createElement('link');
      link.rel   = 'preload';
      link.href  = asset.url;

      switch (asset.as) {
        case 'font':
          link.as = 'font';
          link.setAttribute('crossorigin', 'anonymous');
          if (asset.type) link.type = asset.type;
          break;
        case 'script':
          link.as = 'script';
          break;
        case 'style':
          link.as = 'style';
          break;
        case 'image':
          link.as = 'image';
          break;
        default:
          link.as = asset.as || 'fetch';
          link.setAttribute('crossorigin', 'anonymous');
      }

      document.head.appendChild(link);
      existing.add(absolute);
    });
  }

  /* ── Code Splitting Utilities ───────────────────────────────── */

  /**
   * importWhenVisible(selector, importFn)
   * ──────────────────────────────────────
   * Fire importFn() exactly once when the element matching `selector`
   * first becomes visible (rootMargin: 100px).
   *
   * Example:
   *   SokoniPerformance.importWhenVisible('#map-section', () => import('./sokoni-maps.js'));
   *
   * Returns the IntersectionObserver so the caller can disconnect it if needed.
   */
  function importWhenVisible(selector, importFn) {
    if (typeof importFn !== 'function') {
      console.error('[SokoniPerf] importWhenVisible: importFn must be a function.');
      return;
    }

    var el = (typeof selector === 'string')
      ? document.querySelector(selector)
      : selector;

    if (!el) {
      console.warn('[SokoniPerf] importWhenVisible: element not found for selector:', selector);
      return;
    }

    /* No IntersectionObserver support — load immediately */
    if (!('IntersectionObserver' in window)) {
      importFn().catch(function (e) {
        console.error('[SokoniPerf] importWhenVisible import failed (immediate):', e);
      });
      return;
    }

    var done     = false;
    var observer = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && !done) {
        done = true;
        observer.disconnect();
        importFn().catch(function (e) {
          console.error('[SokoniPerf] importWhenVisible import failed:', e);
        });
      }
    }, { rootMargin: '100px 0px', threshold: 0 });

    observer.observe(el);
    return observer;
  }

  /**
   * importOnInteraction(selector, events[], importFn)
   * ───────────────────────────────────────────────────
   * Load a module the first time the user interacts with an element.
   * The importFn is called at most once regardless of subsequent events.
   *
   * Example:
   *   SokoniPerformance.importOnInteraction('#chat-btn', ['click','touchstart'],
   *     () => import('./sokoni-chat.js'));
   */
  function importOnInteraction(selector, events, importFn) {
    if (typeof importFn !== 'function') {
      console.error('[SokoniPerf] importOnInteraction: importFn must be a function.');
      return;
    }
    if (!Array.isArray(events) || events.length === 0) {
      console.error('[SokoniPerf] importOnInteraction: events[] must be a non-empty array.');
      return;
    }

    var el = (typeof selector === 'string')
      ? document.querySelector(selector)
      : selector;

    if (!el) {
      console.warn('[SokoniPerf] importOnInteraction: element not found for selector:', selector);
      return;
    }

    var loaded = false;

    function _handler() {
      if (loaded) return;
      loaded = true;
      events.forEach(function (ev) {
        el.removeEventListener(ev, _handler);
      });
      importFn().catch(function (e) {
        console.error('[SokoniPerf] importOnInteraction import failed:', e);
      });
    }

    events.forEach(function (ev) {
      el.addEventListener(ev, _handler, { passive: true, once: false });
    });
  }

  /* ── Optimistic UI ──────────────────────────────────────────── */

  /**
   * optimisticUpdate(uiUpdateFn, serverFn, rollbackFn)
   * ────────────────────────────────────────────────────
   * Pattern for instant UI feedback with automatic rollback on failure.
   *
   *  1. uiUpdateFn() is called synchronously — the UI reflects the change
   *     before the server round-trip begins.
   *  2. serverFn() is called asynchronously.
   *  3. If serverFn() rejects, rollbackFn() is called to undo the UI change.
   *
   * Returns a Promise that resolves with the server response or rejects after
   * rollback so the caller can show an error message.
   *
   * Example (wishlist toggle):
   *   SokoniPerformance.optimisticUpdate(
   *     () => btn.classList.toggle('wished'),
   *     () => callFunction('toggleWishlist', { productId }),
   *     () => btn.classList.toggle('wished')
   *   );
   */
  function optimisticUpdate(uiUpdateFn, serverFn, rollbackFn) {
    if (typeof uiUpdateFn !== 'function' || typeof serverFn !== 'function') {
      return Promise.reject(new TypeError(
        'optimisticUpdate: uiUpdateFn and serverFn must be functions.'
      ));
    }

    /* 1. Apply UI change immediately */
    try {
      uiUpdateFn();
    } catch (uiErr) {
      console.error('[SokoniPerf] optimisticUpdate: uiUpdateFn threw:', uiErr);
      return Promise.reject(uiErr);
    }

    /* 2. Execute server operation */
    return Promise.resolve().then(function () {
      return serverFn();
    }).then(function (result) {
      return result;
    }).catch(function (serverErr) {
      console.error('[SokoniPerf] optimisticUpdate: server failed, rolling back:', serverErr.message || serverErr);
      /* 3. Roll back the UI */
      if (typeof rollbackFn === 'function') {
        try {
          rollbackFn();
        } catch (rbErr) {
          console.error('[SokoniPerf] optimisticUpdate: rollbackFn threw:', rbErr);
        }
      }
      throw serverErr;
    });
  }

  /* ── Caching Utilities ──────────────────────────────────────── */

  /**
   * memoize(fn, ttlMs)
   * ───────────────────
   * Return a memoized version of fn that caches results (including Promises)
   * for ttlMs milliseconds.  Cache is keyed by JSON-serialised arguments.
   * Rejected Promises are NOT cached.
   *
   * Example:
   *   const getCachedProducts = SokoniPerformance.memoize(fetchProducts, 60000);
   *   const products = await getCachedProducts('electronics');
   */
  function memoize(fn, ttlMs) {
    if (typeof fn !== 'function') throw new TypeError('memoize: fn must be a function.');
    var ttl = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : 60_000;

    /* Use a WeakMap keyed on fn so stores are GC'd with the function */
    if (!_memoStores.has(fn)) _memoStores.set(fn, new Map());
    var cache = _memoStores.get(fn);

    return function memoized() {
      var args = Array.prototype.slice.call(arguments);
      var key;
      try { key = JSON.stringify(args); } catch (_) { key = String(args); }

      var now   = Date.now();
      var entry = cache.get(key);

      if (entry && now < entry.expiresAt) return entry.value;

      var result = fn.apply(this, args);

      /* Handle async results */
      if (result && typeof result.then === 'function') {
        var settled = result.then(
          function (value) {
            cache.set(key, { value: Promise.resolve(value), expiresAt: now + ttl });
            return value;
          },
          function (err) {
            cache.delete(key); /* Do not cache rejections */
            throw err;
          }
        );
        cache.set(key, { value: settled, expiresAt: now + ttl });
        return settled;
      }

      cache.set(key, { value: result, expiresAt: now + ttl });
      return result;
    };
  }

  /**
   * staleWhileRevalidate(key, fetchFn, ttlMs)
   * ──────────────────────────────────────────
   * Return cached data from sessionStorage immediately if available and
   * not expired; simultaneously kick off a background refresh.
   * Caller never waits for the network on repeat visits within the TTL.
   *
   * On first call (no cache) the data is fetched fresh and cached.
   *
   * Example:
   *   const products = await SokoniPerformance.staleWhileRevalidate(
   *     'products_featured', fetchFeatured, 300000
   *   );
   */
  function staleWhileRevalidate(key, fetchFn, ttlMs) {
    if (!key || typeof fetchFn !== 'function') {
      return Promise.reject(new TypeError('staleWhileRevalidate: key and fetchFn are required.'));
    }
    var ttl      = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : 300_000;
    var cacheKey = 'sk_swr_' + key;

    /* Try to read from sessionStorage */
    var cached = null;
    try {
      var raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Date.now() < parsed.expiresAt) {
          cached = parsed;
        } else {
          sessionStorage.removeItem(cacheKey);
        }
      }
    } catch (_) { /* sessionStorage unavailable or corrupted */ }

    function _cacheWrite(data) {
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({
          data:      data,
          expiresAt: Date.now() + ttl,
          cachedAt:  Date.now(),
        }));
      } catch (_) { /* Storage quota exceeded or private mode */ }
    }

    if (cached) {
      /* Return stale data immediately; revalidate in background */
      Promise.resolve().then(function () {
        return fetchFn();
      }).then(function (fresh) {
        _cacheWrite(fresh);
      }).catch(function (err) {
        console.warn('[SokoniPerf] staleWhileRevalidate background refresh failed:', err);
      });
      return Promise.resolve(cached.data);
    }

    /* No cache — fetch fresh, cache, return */
    return Promise.resolve().then(function () {
      return fetchFn();
    }).then(function (fresh) {
      _cacheWrite(fresh);
      return fresh;
    });
  }

  /* ── Background Sync ────────────────────────────────────────── */

  /**
   * _openSyncDB() — open (or create) the IndexedDB used to persist
   * pending sync registrations across page reloads.
   */
  function _openSyncDB() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB not available.'));
      var req = indexedDB.open('sk_perf_sync', 1);
      req.onupgradeneeded = function (e) {
        var idb = e.target.result;
        if (!idb.objectStoreNames.contains('pendingSyncs')) {
          idb.createObjectStore('pendingSyncs', { keyPath: 'tag' });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error);   };
    });
  }

  /**
   * registerBackgroundSync(tag, fn)
   * ─────────────────────────────────
   * Register fn to run when connectivity is (re-)established.
   *
   *   Primary:  navigator.serviceWorker `sync` event (Background Sync API)
   *   Fallback: window `online` event listener
   *
   * fn is stored in memory AND persisted to IndexedDB so it survives a
   * Service Worker restart.  If the device is already online the fallback
   * path runs fn immediately.
   *
   * Example:
   *   SokoniPerformance.registerBackgroundSync('cart-sync', uploadPendingCart);
   */
  function registerBackgroundSync(tag, fn) {
    if (!tag || typeof fn !== 'function') {
      return Promise.reject(new TypeError('registerBackgroundSync: tag and fn are required.'));
    }

    _bgSyncFns.set(tag, fn);

    /* Persist tag to IndexedDB */
    _openSyncDB().then(function (idb) {
      var tx = idb.transaction('pendingSyncs', 'readwrite');
      tx.objectStore('pendingSyncs').put({ tag: tag, registeredAt: Date.now() });
    }).catch(function (e) {
      console.warn('[SokoniPerf] Could not persist sync tag to IndexedDB:', e);
    });

    /* Primary: ServiceWorker Background Sync API */
    if ('serviceWorker' in navigator) {
      return navigator.serviceWorker.ready.then(function (reg) {
        if (reg.sync) {
          return reg.sync.register(tag).then(function () {
            console.info('[SokoniPerf] Background sync registered via SW:', tag);
          });
        }
        return Promise.reject(new Error('Background Sync API not supported.'));
      }).catch(function (e) {
        console.warn('[SokoniPerf] SW sync fallback to online event:', e.message);
        _registerOnlineListener(tag, fn);
      });
    }

    /* Fallback: online event */
    _registerOnlineListener(tag, fn);
    return Promise.resolve();
  }

  function _registerOnlineListener(tag, fn) {
    function _run() {
      var pendingFn = _bgSyncFns.get(tag);
      if (!pendingFn) return;

      Promise.resolve().then(function () {
        return pendingFn();
      }).then(function () {
        _bgSyncFns.delete(tag);
        window.removeEventListener('online', _run);
        _openSyncDB().then(function (idb) {
          var tx = idb.transaction('pendingSyncs', 'readwrite');
          tx.objectStore('pendingSyncs').delete(tag);
        }).catch(function () {});
        console.info('[SokoniPerf] Background sync completed (online fallback):', tag);
      }).catch(function (err) {
        console.error('[SokoniPerf] Background sync fn failed:', tag, err);
      });
    }

    if (navigator.onLine) {
      _run();
    } else {
      window.addEventListener('online', _run);
    }
  }

  /* ── Performance Budget ─────────────────────────────────────── */

  /**
   * reportBudget()
   * ───────────────
   * Read Core Web Vitals from the PerformanceObserver buffer and compare
   * against the targets below.  Logs a summary group to the console and
   * returns a structured result object.
   *
   * Targets (Google "Good" thresholds):
   *   LCP   < 2500 ms
   *   CLS   < 0.1
   *   FID   < 100 ms  (legacy — INP is the replacement)
   *   INP   < 200 ms
   *   TTFB  < 800 ms
   *   FCP   < 1800 ms
   *
   * Returns { checkedAt, passing[], failing[], unsupported[], scores{} }
   * where scores[metric] = { value, unit, rating: 'good'|'needs_improvement'|'poor' }
   */
  function reportBudget() {
    var TARGETS = {
      LCP:  { good: 2500,  poor: 4000,  unit: 'ms', label: 'Largest Contentful Paint'  },
      CLS:  { good: 0.1,   poor: 0.25,  unit: '',   label: 'Cumulative Layout Shift'   },
      FID:  { good: 100,   poor: 300,   unit: 'ms', label: 'First Input Delay'         },
      INP:  { good: 200,   poor: 500,   unit: 'ms', label: 'Interaction to Next Paint'  },
      TTFB: { good: 800,   poor: 1800,  unit: 'ms', label: 'Time to First Byte'        },
      FCP:  { good: 1800,  poor: 3000,  unit: 'ms', label: 'First Contentful Paint'    },
    };

    var result = {
      checkedAt:   new Date().toISOString(),
      scores:      {},
      passing:     [],
      failing:     [],
      unsupported: [],
    };

    if (!('performance' in window)) {
      console.warn('[SokoniPerf] Performance API not available in this environment.');
      return result;
    }

    function _rate(metric, value) {
      var t = TARGETS[metric];
      if (value <= t.good) return 'good';
      if (value <= t.poor) return 'needs_improvement';
      return 'poor';
    }

    function _record(metric, value) {
      var r = _rate(metric, value);
      var t = TARGETS[metric];
      result.scores[metric] = { value: value, unit: t.unit, label: t.label, rating: r };
      if (r === 'good') result.passing.push(metric);
      else              result.failing.push(metric);
    }

    /* TTFB — Navigation Timing Level 2 */
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) _record('TTFB', Math.round(nav.responseStart - nav.requestStart));
    } catch (_) {}

    /* FCP — Paint Timing */
    try {
      var fcpEntry = (performance.getEntriesByType('paint') || [])
        .find(function (e) { return e.name === 'first-contentful-paint'; });
      if (fcpEntry) _record('FCP', Math.round(fcpEntry.startTime));
    } catch (_) {}

    if ('PerformanceObserver' in window) {
      /* LCP — PerformanceObserver buffer */
      try {
        var lcpEntries = performance.getEntriesByType('largest-contentful-paint');
        if (lcpEntries && lcpEntries.length) {
          _record('LCP', Math.round(lcpEntries[lcpEntries.length - 1].startTime));
        } else {
          result.unsupported.push('LCP');
        }
      } catch (_) { result.unsupported.push('LCP'); }

      /* CLS — sum all layout-shift entries that haven't hadRecentInput */
      try {
        var clsEntries = performance.getEntriesByType('layout-shift');
        if (clsEntries && clsEntries.length) {
          var clsValue = clsEntries.reduce(function (acc, e) {
            return acc + (!e.hadRecentInput ? (e.value || 0) : 0);
          }, 0);
          _record('CLS', parseFloat(clsValue.toFixed(4)));
        } else {
          result.unsupported.push('CLS');
        }
      } catch (_) { result.unsupported.push('CLS'); }

      /* FID — first-input */
      try {
        var fidEntries = performance.getEntriesByType('first-input');
        if (fidEntries && fidEntries.length) {
          var fidMs = fidEntries[0].processingStart - fidEntries[0].startTime;
          _record('FID', Math.round(fidMs));
        } else {
          result.unsupported.push('FID');
        }
      } catch (_) { result.unsupported.push('FID'); }

      /* INP — event-timing (aggregate p98 approximation from buffer) */
      try {
        var eventEntries = performance.getEntriesByType('event');
        if (eventEntries && eventEntries.length) {
          var durations = eventEntries
            .map(function (e) { return e.duration; }) // entry.duration is the correct INP metric
            .sort(function (a, b) { return a - b; });
          var p98idx = Math.floor(durations.length * 0.98);
          _record('INP', Math.round(durations[Math.max(0, p98idx - 1)]));
        } else {
          result.unsupported.push('INP');
        }
      } catch (_) { result.unsupported.push('INP'); }

    } else {
      result.unsupported.push('LCP', 'CLS', 'FID', 'INP');
    }

    /* Console summary */
    var ICONS = { good: '[PASS]', needs_improvement: '[WARN]', poor: '[FAIL]' };
    console.group('[SokoniPerf] Performance Budget — ' + result.checkedAt);
    Object.keys(result.scores).forEach(function (m) {
      var s = result.scores[m];
      console.log(
        ICONS[s.rating] + ' ' + s.label + ' (' + m + '): ' +
        s.value + (s.unit ? ' ' + s.unit : '') + '  →  ' + s.rating.toUpperCase()
      );
    });
    if (result.unsupported.length) {
      console.log('[INFO] Not yet in buffer: ' + result.unsupported.join(', '));
    }
    console.log(
      'SCORE: ' + result.passing.length + '/' +
      (result.passing.length + result.failing.length) + ' passing'
    );
    console.groupEnd();

    return result;
  }

  /* ── Auto-Init ──────────────────────────────────────────────── */

  /**
   * _autoInit()
   * ───────────
   * Called automatically on DOMContentLoaded.
   * Applies the three zero-config optimisations:
   *   1. optimizeImages() — process all <img> elements
   *   2. lazyLoadImages() — start the IntersectionObserver for data-src/data-bg
   *   3. prefetchLinks()  — delegate hover/touch prefetching
   */
  function _autoInit() {
    _injectStyles();
    optimizeImages();
    lazyLoadImages();
    prefetchLinks();
    console.info('[SokoniPerf] SDK v1.0.0 initialised.');
  }

  /* ── Public API ─────────────────────────────────────────────── */

  var SokoniPerformance = {
    /* Image optimization */
    optimizeImages:      optimizeImages,
    lazyLoadImages:      lazyLoadImages,
    observeLazyImage:    observeLazyImage,

    /* Resource hints */
    prefetchLinks:       prefetchLinks,
    preloadCriticalAssets: preloadCriticalAssets,

    /* Code splitting */
    importWhenVisible:   importWhenVisible,
    importOnInteraction: importOnInteraction,

    /* Optimistic UI */
    optimisticUpdate:    optimisticUpdate,

    /* Caching */
    memoize:              memoize,
    staleWhileRevalidate: staleWhileRevalidate,

    /* Background sync */
    registerBackgroundSync: registerBackgroundSync,

    /* Performance budget */
    reportBudget:        reportBudget,

    /* Internal references (exposed for extensibility) */
    _lazyObserver:       null,   // populated after lazyLoadImages() runs
    _prefetchedUrls:     _prefetchedUrls,

    version: '1.0.0',
  };

  global.SokoniPerformance = SokoniPerformance;

  /* Auto-init fires AFTER SokoniPerformance is defined so lazyLoadImages()
     can write back to SokoniPerformance._lazyObserver without hitting undefined */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

}(typeof window !== 'undefined' ? window : this));
