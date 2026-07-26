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
    window.SOKONI_IMAGE_VERSION = api.version; // production diagnostics: which helper is running
    api._autoInit();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';   // bump on any behaviour change; surfaced for prod diagnostics
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

  /* A src is unusable if empty or a base64 data: URI (which the whole catalog work
     exists to keep out of product docs) — fall back to the placeholder. */
  function isBadSrc(src) {
    return !src || typeof src !== 'string' || src.slice(0, 5).toLowerCase() === 'data:';
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
    var src = isBadSrc(opts.src) ? CONFIG.placeholder : opts.src;
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
    var fb = t.getAttribute('data-sk-fallback') || CONFIG.placeholder;
    if (t.getAttribute('src') !== fb) t.setAttribute('src', fb);
    if (t.hasAttribute('srcset')) t.removeAttribute('srcset');   // don't re-resolve to the broken variant
    if (typeof CONFIG.reportErrors === 'function') {
      try { CONFIG.reportErrors({ src: t.currentSrc || t.src, el: t }); } catch (_) {}
    }
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
    if (typeof document === 'undefined' || isBadSrc(src)) return;
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
