# SOKONI Image — `renderProductImage()` v1 API

**Status:** v1.0.0 · public API frozen · file: [`sokoni-image.js`](../sokoni-image.js) · tests: [`scripts/test-sokoni-image.js`](../scripts/test-sokoni-image.js)

`sokoni-image.js` is the **single rendering abstraction** for product (and general)
images. Every image on a product surface should be rendered through it so that
lazy-loading, `decoding`, CLS reservation, and fallback behaviour are uniform — and
so future capabilities (responsive variants, BlurHash, CDN resizing) land **once,
behind this interface**, instead of in every consumer.

It is a **render layer, not an upload pipeline**. Uploads are already compressed to
~800px; there is no resize backend yet (Cloudflare Image Resizing off, no `sharp`),
so real width `srcset` is deferred — but the API already accepts `variants`, so that
step lights up later with **zero consumer changes**.

Related: [[Product Validation Contract]] (keeps `data:` URIs out of image fields),
[[Storage Integrity Auditor]] (flags image URLs with no Storage object).

---

## The API

```js
// Browser globals (set when the script loads):
window.SokoniImage            // the module
window.renderProductImage     // alias of SokoniImage.render
window.SOKONI_IMAGE_VERSION   // "1.0.0"
```

### `renderProductImage(opts) → string`

Returns an `<img>` HTML string (wrapped in a CLS box when no dimensions are given).
Alias: `SokoniImage.render` / `SokoniImage.html`.

```js
el.innerHTML = renderProductImage({ src: p.image, alt: p.name, aspectRatio: '1/1' });
```

### Options and defaults

| Option | Type | Default | Purpose |
|---|---|---|---|
| `src` | string | — | Image URL. Empty or a `data:` URI → `placeholder`. |
| `alt` | string | `''` | Escaped into the tag. |
| `width` / `height` | number/string | — | When given, set on the img and **no wrapper** is added. |
| `aspectRatio` | string | `'1 / 1'` | CLS box ratio when `width`/`height` are absent. |
| `priority` | boolean | `false` | `loading="eager"` + `fetchpriority="high"` (above-the-fold/LCP). |
| `className` | string | — | Extra classes (added alongside `sk-img`). |
| `variants` | `{200,600,1200}` | `null` | Width→URL map → `srcset` + `sizes`. Ignored today; **future**. |
| `sizes` | string | `(max-width:768px) 100vw, 400px` | Used only when `variants` are supplied. |
| `placeholder` | string | `assets/default-product.png` | Fallback image. |
| `wrap` | boolean | `true` | `false` = drop-in `<img>` (no CLS wrapper); use when the card CSS already sizes the image. |

### Always applied
- `loading="lazy"` (unless `priority`) · `decoding="async"`
- class `sk-img` + `data-sk-fallback` (drives centralized error handling)
- CLS: explicit `width`/`height` **or** an `aspect-ratio` box

### Other methods
- `SokoniImage.apply(imgEl, opts)` — apply the same behaviour to an existing `<img>`.
- `SokoniImage.preload(src)` — inject `<link rel=preload as=image>` for a hero image.
- `SokoniImage.configure(patch)` — set config / enable hooks.
- `SokoniImage.checkAdoption(selector?)` — returns `{ unmanaged, examples }`; warns in console. **Auto-runs on localhost only.**
- `SokoniImage.buildSrcset(variants)` · `SokoniImage.isBadSrc(src)` · `SokoniImage.version`

### Centralized error handling
One delegated **capture-phase** `error` listener swaps any failed `.sk-img` to its
`data-sk-fallback` **once** (guarded against loops), drops the broken `srcset`, and
optionally calls `reportErrors`. No inline `onerror` → CSP-safe. Installed
automatically when the script loads.

---

## Compatibility guarantee (v1)

1. `renderProductImage(opts)` stays **backward compatible** within v1 — the option
   object only **gains** optional keys; existing keys never change meaning.
2. New capabilities arrive as **new optional options** or **config hooks**, defaulted
   off, so no consumer is migrated twice.
3. `sk-img`, `data-sk-fallback`, and the global names above are part of the contract.
4. Behaviour changes bump `SokoniImage.version`.

## Extension points (seams already in place, off until infra exists)

| Hook / option | Lights up | Notes |
|---|---|---|
| `variants` | Responsive `srcset` | Needs a variant-generation step (client multi-size or a resize service). Interface is ready. |
| `CONFIG.cdnRewrite(url,width)` | CDN / on-the-fly resize | e.g. Cloudflare Image Resizing when enabled. |
| `CONFIG.preferModernFormat` | AVIF/WebP `<picture>` | Today `sokoni-performance.js` does WebP globally. |
| `CONFIG.reportErrors(info)` | Failed-load analytics | Called from the central error handler. |
| BlurHash | LQIP placeholder | Add as an option + a decode step; render slot reserved by the CLS box. |

---

## Rollout status

| Surface | Status |
|---|---|
| `store.html` product grid | ✅ Migrated (structure-preserving, `wrap:false`) — **pending real-browser release gate** |
| `index.html` trending/popular | ⏳ Next |
| `sokoni-recommendations.js` | ⏳ |
| Minishop | ⏳ |
| Seller dashboard previews | ⏳ |
| Remaining consumers | ⏳ |

**Release gate (must pass in a real browser before further rollout):** images render;
placeholder only for genuinely-missing images; no layout shift while scrolling; lazy
loading works; console clean; no unexpected image 404s/retries; Safari + Chrome match;
`window.SOKONI_IMAGE_VERSION === "1.0.0"`; `document.querySelectorAll('.st-product-card img.sk-img').length > 0`.

## Migration pattern for a new page

1. Load the module early: `<script src="sokoni-image.js"></script>` (before the render code).
2. Replace each `<img …>` in the card render with
   `${window.renderProductImage ? renderProductImage({ src, alt, wrap:false }) : '<img …>'}`
   — the guard keeps the page working if the module hasn't parsed yet.
3. Use `wrap:false` when the card CSS already sizes the image; omit it to get the CLS box.
4. On `localhost`, open the console: `checkAdoption()` should report `unmanaged: 0` for that page.
5. Verify the page (render, placeholder, CLS, lazy, console, network) before the next surface.

Do **not** big-bang. One surface at a time; verify each.
