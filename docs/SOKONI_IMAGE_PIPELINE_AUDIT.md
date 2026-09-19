# SOKONI — product image pipeline audit

**READ-ONLY. No mutation. No image converted, no variant generated, no Storage/Firestore/Hosting change.**
Date: 2026-09-19 · Project `sokoni-aeb26`

Prompted by the cost contract's `p95 product image < 150 KB` target. Companion to
`docs/SOKONI_IMAGE_API.md` and `GCP_COST_ARCHITECTURE_AUDIT.md`.

---

## 1. What was NOT wrong

Three things were assumed broken and are not:

| Assumption | Reality |
|---|---|
| Base64 images are leaking into Firestore | **0 of 126** image values are `data:` URIs. Longest value is **201 chars**. Already a predeploy gate: `scripts/audit-base64-writes.js` |
| No client-side compression exists | `sokoni-upload.js` compresses (1200px, WebP, q0.82); `seller.js:_compressToBlob` compresses (800px, JPEG, q0.82) |
| Images aren't cached | `seller.js` sets `cacheControl: public, immutable, max-age=1yr`. A code comment records the prior defect — production returned `private, max-age=0` and re-downloaded every product image on every view. **Already fixed** |

Firestore stores references and metadata only. **That invariant holds today.**

---

## 2. Measured Storage footprint

`gs://sokoni-aeb26.firebasestorage.app/product-images/**`, metadata only — nothing downloaded:

```
objects : 20            total : 15.56 MB
mean    : 796.7 KB      median: 678.1 KB
p95     : 2,326.7 KB    max   : 2.27 MB     min: 82.8 KB

> 150 KB  16/20 (80%)   > 500 KB  10/20 (50%)   > 2 MB  3/20 (15%)
> 300 KB  11/20 (55%)   > 1 MB     6/20 (30%)

contentType: image/jpeg x20      already WebP: 0/20
```

**The audit's `p95 ≈ 1.2 MB` understates it — measured p95 is 2.33 MB.** 80% breach the <150 KB target.

### But this is not a storage-cost problem

**Total product-image storage is 15.56 MB.** Cloud Storage was **$0.14 net** across the entire
measured billing window. Deleting every original would save nothing meaningful.

> **The <150 KB contract row should be read as a DELIVERY/BANDWIDTH target, not a storage-cost
> requirement.** On the listing grid a ~797 KB mean image is a user-experience and mobile-data cost
> — for buyers on Kenyan mobile networks — not a GCP bill.

### Scope limit: most catalogue images are not ours

```
126 product image references
├──  96  images.unsplash.com          (76% — external, not stored, not resizable by SOKONI)
└──  30  firebasestorage.googleapis.com
```

This census covers ~24% of the catalogue. Whether the 96 Unsplash URLs are seed/demo data or
merchant-supplied external URLs is **unresolved**, and it changes what any pipeline can serve.

---

## 3. Upload provenance — the actual finding

All 20 objects are JPEG despite a WebP compressor existing. The cause is **not** a bypass.

**There are two compressors with divergent output contracts:**

| | `sokoni-upload.js` | `seller.js:_compressToBlob` |
|---|---|---|
| Max width | **1200** | **800** |
| Quality | 0.82 | 0.82 |
| **Format** | **`image/webp`** | **`image/jpeg`** |
| Callers | `bnb-manage.html`, `creative-studio.html`, `digital-esoko-seller.html` | **`seller.js:461` — exactly one, the product path** |
| Storage path | `…photo.webp` | `product-images/{uid}/{pid}/{i}.jpg` — **`.jpg` hardcoded** |

The product path **does** compress — through its own duplicate implementation that emits JPEG. The
JPEGs are the intended output of the live code, not an accident.

### Object cohorts corroborate this

```
2026-07-19   3 objects   2.12-2.38 MB    pre-compressor
2026-07-22   7 objects   694 KB-1.93 MB  large
2026-07-25  10 objects   84-308 KB       10 uploads in 49s - scripted/bulk, post-compressor
```

`_compressToBlob`'s own comment describes the repair: *"The raw file was being stored and then
served full-size into thumbnail-sized cards."*

### The limit of this conclusion

**No product image has been uploaded in 56 days** (nothing since 2026-07-25). The live path is
**inferred from source, not observed in production**. Any consolidation must include a focused
upload test rather than assuming the code behaves as written.

---

## 4. Impact analysis for canonicalising on WebP

| Surface | Risk |
|---|---|
| `_compressToBlob` callers | **1** — `seller.js:461`. Nowhere else |
| Path construction sites | **2** — `seller.js:457`, `sokoni-merchant-media.js:65` |
| Backend Storage trigger | **Safe.** `media-engine.js` filters by `MEDIA_PREFIXES.some(p => filePath.startsWith(p))` — prefix, not extension — and passes `contentType` through to `mimeType` without branching |
| Deletion / replacement | **No risk found.** Nothing reconstructs a product-image path to delete it; the only `deleteObject` calls use a *stored* `storageRef` |
| Image rendering | **Safe.** `sokoni-image.js` resolves any URL; no extension logic |
| Existing Firestore references | **Safe.** Absolute download URLs with tokens; new uploads never rewrite old documents |
| Cache logic | **Unaffected** — set per-upload, format-independent |
| `sokoni-merchant-products.js:1413/:1817` | **Comments only** — they explain why photos attach post-create. Not executable `.jpg` dependencies |

### Migration boundary — clean, no mass rewrite

```
existing .jpg  ->  remain readable indefinitely, untouched
new uploads    ->  canonical WebP
variants       ->  a separate, later layer
```

**Keep the 20 existing JPEGs.** At 15.56 MB, migrating them to save storage is not worth the
compatibility risk of changing live URLs.

### Contract wording

> **New SOKONI-managed product uploads must pass through the canonical image compressor and produce
> an optimized supported format. Existing image URLs remain valid.**

Deliberately *not* "every product image must be WebP" — that would make the 96 Unsplash URLs and
the 20 legacy JPEGs permanent violations and force a destructive conversion.

---

## 5. Proposed change — NOT IMPLEMENTED

**Option (a), the architectural fix:** export the compression primitive from `sokoni-upload.js` and
call it from `seller.js`, keeping seller's existing `uploadBytes` loop, `cacheControl` and URL
collection. One compressor, one contract.

**Option (b), rejected:** change three literals in `seller.js` (`image/jpeg`→`image/webp`,
`800`→`1200`, `.jpg`→`.webp`). It gets WebP into new uploads but **leaves two independently
maintained compressors — the exact duplication this audit demonstrated.**

### Required regression coverage before shipping

JPEG input → WebP output · max width ≤ 1200 · quality 0.82 · `cacheControl: public, immutable`
still set · Storage path ends `.webp` · existing `.jpg` references untouched · video path
(`product-images/vid_*`) unchanged · no Base64 reaches Firestore · the upload still collects the
generated Storage URL correctly.

Then **one controlled upload test** — the 56-day gap means production behaviour is unproven.

---

## 6. Ownership status at time of writing

`seller.js` (last modified 09-09) and `sokoni-upload.js` are **both clean and not being edited**.
Another agent is actively writing `product.js`, `sokoni-merchant-products.js` and
`sokoni-merchant-media.js`.

**The blocker is not file locking — it is contract completeness.** `sokoni-merchant-media.js:65`
also hardcodes `.jpg`. Canonicalising `seller.js` alone would re-create the divergence in a second
writer. The consolidation should cover both writers, and one of them is not ours to change yet.

---

## 7. Sequencing

1. **Canonicalise the compressor** (option a) — small, bounded, needs the media-module ownership resolved.
2. **Measure delivery afterwards.** If the product grid still transfers hundreds of KB per image,
   then and only then:
3. **Build the 200/600/1200 variant layer.** `sokoni-image.js:124` already accepts
   `variants = {200:url, 600:url, 1200:url}` — the consumer exists; nothing produces them.
   `sokoni-image.js:13` states it: *"no resize backend exists yet … real width `srcset` waits on a
   variant-generation step."*

Two independent optimizations with independently verifiable effects — not one image-system rewrite.
