/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI IMAGE — the single rendering abstraction for product (and general) images.

   WHY THIS EXISTS
   ---------------
   Image render behaviour was scattered: each page set loading/decoding/onerror its
   own way, so consistency, CLS prevention and fallback handling drifted. This is the
   ONE place every image is rendered, so behaviour is uniform and future capabilities
   (responsive variants, BlurHash, CDN rewriting, priority) can be added HERE without
   touching a single consumer again.

   It is deliberately a rendering layer, not an upload pipeline — the app already
   compresses uploads to ~800px, and no resize backend exists yet (Cloudflare Image
   Resizing off, no sharp), so real width `srcset` waits on a variant-generation step.
   The API already accepts `variants`, so that step lights up later with zero consumer
   changes.

   USAGE (string, for template-literal render sites — the common case):
     el.innerHTML = SokoniImage.render({ src: p.image, alt: p.name, aspectRatio: '1/1' });
     // or the named alias:  renderProductImage({ src, alt, width, height, priority })

   USAGE (element, for imperative paths):
     SokoniImage.apply(imgEl, { priority: true });

   ERROR HANDLING is centralized and CSP-safe: a single delegated capture-phase
   listener swaps any failed `.sk-img` to the placeholder once (no inline onerror).
   Loading the script auto-installs it.

   HOOKS (off until the supporting infra exists) — configure() to enable later:
     cdnRewrite(url, width)   responsive/CDN URL rewriting (e.g. Cloudflare resize)
     preferModernFormat       AVIF/WebP <picture> (today sokoni-performance.js does webp)
     reportErrors(info)       analytics for failed image loads
═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.SokoniImage = api;
    window.renderProductImage = api.render;   // named alias per the design
    window.pickProductImage = api.pick;       // canonical field resolver for raw <img> sites
    window.SOKONI_IMAGE_VERSION = api.version; // production diagnostics: which helper is running
    api._autoInit();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.1.0';   // bump on any behaviour change; surfaced for prod diagnostics
  /* v1.1.0 — added the optional `fallbackMode` (placeholder | css-hide | remove).
     Backward compatible: default is 'placeholder' (v1.0 behaviour). This lets an
     existing page keep its OWN intended fallback (a branded CSS placeholder via a
     failed-class, or removing the img and revealing a CSS layer) so migrating to the
     helper is a true no-regression standardisation rather than a downgrade. */
  var CLASS = 'sk-img';

  var CONFIG = {
    placeholder:   'assets/default-product.png',
    defaultAspect: '1 / 1',                 // product cards are square
    defaultSizes:  '(max-width: 768px) 100vw, 400px',
    /* ── hooks, all OFF until their infra exists ── */
    cdnRewrite:        null,   // function(url, width) -> url
    preferModernFormat: false, // AVIF/WebP <picture>
    reportErrors:      null    // function({ src, el })
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isData(src) {
    return typeof src === 'string' && src.slice(0, 5).toLowerCase() === 'data:';
  }

  /* A src is unusable only if empty/blank. base64 data: URIs are ALLOWED to render
     now: the homepage OOM was fixed by BOUNDING the catalogue listener (newest 200)
     + stripping base64 from the warm cache, not by hiding images — so rejecting
     base64 here only produced placeholders for products whose upload fell back to
     base64, and made the same item show on some pages but not others. Prefer real
     Storage URLs via pick(); base64 is the last-resort source and still renders. */
  function isBadSrc(src) {
    return !src || typeof src !== 'string' || !src.trim();
  }

  /* CANONICAL image-field resolver. Products/providers store their image under a
     drifting set of fields (image, images[], imageStorageUrls, imageUrl, thumbnail,
     photo/photoURL, coverImage, logo, avatar) and a doc can legitimately have
     image:'' while imageStorageUrls[0] holds the real URL (seller.js strips base64
     from `image` before the Firestore write and on cache degradation). Reading a
     single field is why real photos rendered as placeholders. This returns the BEST
     source: first real URL (http/https or root-absolute) wins; base64 only if no URL
     exists; '' if nothing. One resolver so every surface reads the same thing. */
  function pick(o) {
    if (!o || typeof o !== 'object') return (typeof o === 'string' ? o.trim() : '');
    var c = [];
    if (Array.isArray(o.imageStorageUrls)) c.push(o.imageStorageUrls[0]);
    if (Array.isArray(o.images)) o.images.forEach(function (x) { c.push(x && typeof x === 'object' ? (x.url || x.src) : x); });
    c.push(o.image, o.imageUrl, o.imageURL, o.thumbnail, o.photo, o.photoURL, o.coverImage, o.logo, o.avatar);
    var data = '';
    for (var i = 0; i < c.length; i++) {
      var v = c[i];
      if (typeof v !== 'string') continue;
      v = v.trim();
      if (!v || v === 'null' || v === 'undefined') continue;
      if (v.charAt(0) === '/' || v.slice(0, 4).toLowerCase() === 'http') return v;   // real URL — best
      if (isData(v) && !data) data = v;                                              // remember base64
    }
    return data;   // base64 only when no URL was found
  }

  /* Optionally route a URL through the (future) CDN/resize hook. No-op today. */
  function _resolve(url, width) {
    if (CONFIG.cdnRewrite && typeof CONFIG.cdnRewrite === 'function') {
      try { return CONFIG.cdnRewrite(url, width) || url; } catch (e) { return url; }
    }
    return url;
  }

  /* Build a width-descriptor srcset from `variants` = { 200:url, 600:url, 1200:url }.
     Returns '' when no variants — so today's single-image render is unchanged and
     the exact same call gains responsive srcset the day variants are produced. */
  function buildSrcset(variants) {
    if (!variants || typeof variants !== 'object') return '';
    return Object.keys(variants)
      .map(function (w) { return parseInt(w, 10); })
      .filter(function (w) { return w > 0 && variants[w]; })
      .sort(function (a, b) { return a - b; })
      .map(function (w) { return esc(_resolve(variants[w], w)) + ' ' + w + 'w'; })
      .join(', ');
  }

  /* ── MAIN: return an <img> (CLS-wrapped when dimensions are unknown) HTML string ── */
  function render(opts) {
    opts = opts || {};
    /* Pass {product: p} to resolve the canonical image field automatically, or a
       plain {src}. product wins when it yields something, else fall back to src. */
    var chosen = opts.product ? (pick(opts.product) || opts.src) : opts.src;
    var src = isBadSrc(chosen) ? CONFIG.placeholder : chosen;
    var fallback = opts.placeholder || CONFIG.placeholder;
    var cls = CLASS + (opts.className ? ' ' + opts.className : '');

    var a = [];
    a.push('class="' + esc(cls) + '"');
    a.push('src="' + esc(src) + '"');
    a.push('alt="' + esc(opts.alt != null ? opts.alt : '') + '"');
    a.push('loading="' + (opts.priority ? 'eager' : 'lazy') + '"');
    a.push('decoding="async"');
    if (opts.priority) a.push('fetchpriority="high"');

    var srcset = buildSrcset(opts.variants);
    if (srcset) {
      a.push('srcset="' + srcset + '"');
      a.push('sizes="' + esc(opts.sizes || CONFIG.defaultSizes) + '"');
    }

    /* CLS: explicit dimensions when known — the browser reserves the box. */
    if (opts.width  != null) a.push('width="'  + esc(opts.width)  + '"');
    if (opts.height != null) a.push('height="' + esc(opts.height) + '"');

    a.push('data-sk-fallback="' + esc(fallback) + '"');

    /* Fallback strategy on load error — default 'placeholder' preserves v1.0. Other
       modes let a migrated page keep its own fallback behaviour. */
    var fmode = opts.fallbackMode || 'placeholder';
    if (fmode !== 'placeholder') a.push('data-sk-fallmode="' + esc(fmode) + '"');
    if (fmode === 'css-hide' && opts.failClass) a.push('data-sk-failclass="' + esc(opts.failClass) + '"');

    var img = '<img ' + a.join(' ') + '>';

    /* CLS: when no explicit size, reserve space with an aspect-ratio box so the
       card never jumps as the image loads. */
    if (opts.width == null && opts.height == null && opts.wrap !== false) {
      var ar = opts.aspectRatio || CONFIG.defaultAspect;
      return '<span class="sk-img-box" style="display:block;position:relative;width:100%;' +
             'aspect-ratio:' + esc(ar) + ';overflow:hidden;background:rgba(255,255,255,0.04)">' +
             img.replace('<img ', '<img style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" ') +
             '</span>';
    }
    return img;
  }

  /* ── Apply the same behaviour to an existing <img> element (imperative paths). ── */
  function apply(imgEl, opts) {
    if (!imgEl || imgEl.tagName !== 'IMG') return imgEl;
    opts = opts || {};
    imgEl.classList.add(CLASS);
    if (opts.className) String(opts.className).split(/\s+/).forEach(function (c) { if (c) imgEl.classList.add(c); });
    if (!imgEl.getAttribute('decoding')) imgEl.setAttribute('decoding', 'async');
    if (!imgEl.getAttribute('loading'))  imgEl.setAttribute('loading', opts.priority ? 'eager' : 'lazy');
    if (opts.priority) imgEl.setAttribute('fetchpriority', 'high');
    imgEl.setAttribute('data-sk-fallback', opts.placeholder || CONFIG.placeholder);
    if (opts.fallbackMode && opts.fallbackMode !== 'placeholder') {
      imgEl.setAttribute('data-sk-fallmode', opts.fallbackMode);
      if (opts.fallbackMode === 'css-hide' && opts.failClass) imgEl.setAttribute('data-sk-failclass', opts.failClass);
    }
    var srcset = buildSrcset(opts.variants);
    if (srcset) {
      imgEl.setAttribute('srcset', srcset);
      imgEl.setAttribute('sizes', opts.sizes || CONFIG.defaultSizes);
    }
    if (isBadSrc(imgEl.getAttribute('src'))) imgEl.setAttribute('src', opts.placeholder || CONFIG.placeholder);
    return imgEl;
  }

  /* ── Centralized, CSP-safe error handling ──────────────────────────────────
     `error` does not bubble, so the delegated listener runs in the CAPTURE phase.
     Each image is swapped to its fallback at most once (guarded), preventing an
     infinite error loop if the placeholder itself is missing. */
  function _onError(e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG' || !t.classList || !t.classList.contains(CLASS)) return;
    if (t.dataset.skFailed) return;
    t.dataset.skFailed = '1';
    if (t.hasAttribute('srcset')) t.removeAttribute('srcset');   // don't re-resolve to the broken variant

    var mode = t.getAttribute('data-sk-fallmode') || 'placeholder';
    var info = { src: t.currentSrc || t.src, el: t, mode: mode };

    if (mode === 'remove') {
      if (typeof CONFIG.reportErrors === 'function') { try { CONFIG.reportErrors(info); } catch (_) {} }
      try { t.remove(); } catch (_) {}
      return;
    }
    if (mode === 'css-hide') {
      t.style.display = 'none';
      var fc = t.getAttribute('data-sk-failclass');
      if (fc && t.parentNode && t.parentNode.classList) t.parentNode.classList.add(fc);
      if (typeof CONFIG.reportErrors === 'function') { try { CONFIG.reportErrors(info); } catch (_) {} }
      return;
    }
    /* default: 'placeholder' — swap to the fallback image (v1.0 behaviour). */
    var fb = t.getAttribute('data-sk-fallback') || CONFIG.placeholder;
    if (t.getAttribute('src') !== fb) t.setAttribute('src', fb);
    if (typeof CONFIG.reportErrors === 'function') { try { CONFIG.reportErrors(info); } catch (_) {} }
  }

  var _inited = false;
  function init() {
    if (_inited || typeof document === 'undefined') return;
    _inited = true;
    document.addEventListener('error', _onError, true);
  }

  function _isDev() {
    try { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname); }
    catch (e) { return false; }
  }

  /* Dev-only adoption check: flags product images rendered OUTSIDE the abstraction
     (an <img> without .sk-img under a product-image selector), so new code adopts
     renderProductImage() and lazy/decoding/CLS/fallback stay consistent. Runs
     automatically ONLY on localhost, so it never warns or costs anything in
     production. Callable by hand anywhere: SokoniImage.checkAdoption(). */
  function checkAdoption(selector) {
    if (typeof document === 'undefined') return { unmanaged: 0, examples: [] };
    var sel = selector || '.st-product-card img, .product-card img, .ptrend-grid img, [class*="product"] img';
    var imgs = [].slice.call(document.querySelectorAll(sel));
    var unmanaged = imgs.filter(function (i) { return !i.classList.contains(CLASS); });
    if (unmanaged.length && typeof console !== 'undefined') {
      try {
        console.warn('[SokoniImage v' + VERSION + '] ' + unmanaged.length +
          ' product image(s) rendered outside the helper (missing .' + CLASS +
          '). Adopt renderProductImage() so lazy/decoding/CLS/fallback stay consistent.',
          unmanaged.slice(0, 5));
      } catch (_) {}
    }
    return { unmanaged: unmanaged.length, examples: unmanaged.slice(0, 5) };
  }

  function _autoInit() {
    if (typeof document === 'undefined') return;
    var start = function () {
      init();
      if (_isDev()) setTimeout(function () { checkAdoption(); }, 2500);  // after cards render
    };
    if (document.readyState !== 'loading') start();
    else document.addEventListener('DOMContentLoaded', start);
  }

  /* Preload a hero/LCP image — call for above-the-fold priority images. */
  function preload(src) {
    if (typeof document === 'undefined' || isBadSrc(src) || isData(src)) return;
    var l = document.createElement('link');
    l.rel = 'preload'; l.as = 'image'; l.href = src;
    try { l.setAttribute('fetchpriority', 'high'); } catch (_) {}
    document.head.appendChild(l);
  }

  function configure(patch) {
    if (!patch) return CONFIG;
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) CONFIG[k] = patch[k];
    return CONFIG;
  }

  return {
    version: VERSION,
    render: render,
    renderProductImage: render,
    html: render,
    pick: pick,
    apply: apply,
    preload: preload,
    configure: configure,
    checkAdoption: checkAdoption,
    buildSrcset: buildSrcset,
    isBadSrc: isBadSrc,
    init: init,
    _autoInit: _autoInit,
    _isDev: _isDev,
    CLASS: CLASS,
    CONFIG: CONFIG
  };
}));
