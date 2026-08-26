/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI MERCHANT MEDIA — product images (Products 2c)
   ══════════════════════════════════════════════════════════════════════════════
   The MECHANISM of putting an image in Storage. It owns no authority: ownership,
   the canonical product record and the projections all belong to
   SokoniMerchantData, which calls into this and never the other way round.

   ── IT IS NOT A SECOND MEDIA SYSTEM ─────────────────────────────────────────
   Every convention here is the one seller.js already established and production
   already contains. Nothing is re-invented:

       path            product-images/{sellerUid}/{productId}/{i}.jpg
       content type    image/jpeg after compression
       cacheControl    public, max-age=31536000, immutable

   That cacheControl is not decoration. Firebase Storage defaults uploads to
   `private, max-age=0`, which was measured on a live product image, and meant
   the browser revalidated every product photo on every view. A product photo is
   immutable once uploaded — a new photo is a new object path — so a year is
   safe, and it lets the browser, the service worker and any CDN keep it.

   ── THE LIMITS ARE THE DEPLOYED RULE'S LIMITS ───────────────────────────────
   storage.rules (verified against the SERVED ruleset, 2026-08-20) allows a write
   to product-images/{uid}/** only when:

       request.auth.uid == uid              the path segment IS the authority
       safeImageOnly()                      jpeg | jpg | png | webp | gif | avif
       request.resource.size < 15 MB        strictly less than

   Those three are mirrored here so the merchant is told "that file is too large"
   before a 14-second upload ends in a permission error — but they are mirrored,
   not invented, and the rule remains what actually stops the write.

   ── NO MEDIA QUOTA IS INVENTED ──────────────────────────────────────────────
   The catalogue has no media entitlement: `uploadLimit` / `uploadsUsed` count
   LISTINGS, which canPublishProduct already gates at creation. Attaching a photo
   to a product the merchant already owns creates no listing, so it consumes no
   allowance and asks for none. Inventing a per-product image cap here would be
   exactly the duplicated limit logic this conversion exists to remove.

   ── IDEMPOTENCY IS THE PATH ─────────────────────────────────────────────────
   Slot i always writes to .../{productId}/{i}.jpg. A retry overwrites that same
   object rather than adding another, so repeating a failed upload cannot leave a
   product with duplicate or orphaned media.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantMedia = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Mirrors safeImageOnly() in the deployed storage ruleset. */
  var ACCEPTED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
  /* The rule is `< 15 * 1024 * 1024`. Strictly less, so a file of exactly 15 MB
     is refused by the rule and must be refused here too. */
  var MAX_BYTES = 15 * 1024 * 1024;
  var MAX_PER_PRODUCT = 6;          /* a UI affordance, not an entitlement */

  function storagePath(sellerUid, productId, index) {
    if (!sellerUid) throw new Error('media: sellerUid is required');
    if (!productId) throw new Error('media: productId is required');
    /* The uid segment is what the rule checks against request.auth.uid, so it is
       taken from the resolved scope and never from anything the page supplied. */
    return 'product-images/' + sellerUid + '/' + productId + '/' + index + '.jpg';
  }

  /* Reasons are the merchant's, not the developer's: each says what to do. */
  function validate(file) {
    if (!file) return { ok: false, reason: 'No file was chosen.' };
    var type = String(file.type || '').toLowerCase();
    if (!type) return { ok: false, reason: 'That file has no recognisable type. Choose a photo.' };
    if (ACCEPTED.indexOf(type) === -1) {
      return { ok: false, reason: 'That file is a ' + type.replace('image/', '').replace(/^\w+\/.*/, 'document') +
        '. Photos must be JPEG, PNG, WebP, GIF or AVIF.' };
    }
    if (!(file.size < MAX_BYTES)) {
      return { ok: false, reason: 'That photo is ' + Math.round(file.size / 1048576) +
        ' MB. The limit is 15 MB — take the photo again at a smaller size.' };
    }
    if (file.size === 0) return { ok: false, reason: 'That file is empty.' };
    return { ok: true };
  }

  function validateAll(files) {
    var list = [].slice.call(files || []);
    if (!list.length) return { ok: false, reason: 'No photo was chosen.', accepted: [], rejected: [] };
    var accepted = [], rejected = [];
    list.forEach(function (f) {
      var v = validate(f);
      if (v.ok) accepted.push(f); else rejected.push({ name: f && f.name, reason: v.reason });
    });
    return { ok: accepted.length > 0, accepted: accepted, rejected: rejected };
  }

  /* Re-encode to JPEG at a sane width. Browser-only; anywhere without a canvas
     it resolves the ORIGINAL file rather than failing, because a slightly larger
     upload is a far better outcome than no photo at all. */
  function compress(file, opts) {
    opts = opts || {};
    var maxW = opts.maxWidth || 1400;
    var quality = opts.quality || 0.82;
    return new Promise(function (resolve) {
      try {
        if (typeof document === 'undefined' || typeof Image === 'undefined' ||
            typeof URL === 'undefined' || !URL.createObjectURL) return resolve(file);
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          try {
            var scale = Math.min(1, maxW / (img.width || maxW));
            var c = document.createElement('canvas');
            c.width = Math.round((img.width || maxW) * scale);
            c.height = Math.round((img.height || maxW) * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(url);
            if (!c.toBlob) return resolve(file);
            c.toBlob(function (blob) {
              /* Keep the re-encode only if it actually helped: a small source
                 can GROW when re-encoded. */
              resolve(blob && blob.size < file.size ? blob : file);
            }, 'image/jpeg', quality);
          } catch (e) { try { URL.revokeObjectURL(url); } catch (_) {} resolve(file); }
        };
        img.onerror = function () { try { URL.revokeObjectURL(url); } catch (_) {} resolve(file); };
        img.src = url;
      } catch (e) { resolve(file); }
    });
  }

  /**
   * upload({ storage, sellerUid, productId, files, startIndex, onProgress })
   *
   * Resolves to { urls: [...] } ONLY if every file uploaded. A partial upload
   * REJECTS, carrying `uploaded` so the caller knows what did land — because the
   * product record must never be told about an image that is not there, and the
   * decision about a partial result belongs to the writer, not to this module.
   *
   * `storage` is injected: { putImage({path, blob, contentType, cacheControl}) -> url }
   */
  async function upload(o) {
    o = o || {};
    if (!o.storage || typeof o.storage.putImage !== 'function') {
      throw new Error('media: no storage adapter — photos cannot be uploaded just now.');
    }
    var files = [].slice.call(o.files || []);
    if (!files.length) throw new Error('media: no files');

    var start = o.startIndex || 0;
    var urls = [];
    for (var i = 0; i < files.length; i++) {
      var index = start + i;
      var blob = await compress(files[i], o);
      /* Re-checked AFTER compression: compression can only shrink, but the
         contract the rule enforces is about what is actually sent. */
      if (!(blob.size < MAX_BYTES)) {
        var e1 = new Error('That photo is still too large after compression.');
        e1.uploaded = urls; throw e1;
      }
      try {
        var url = await o.storage.putImage({
          path: storagePath(o.sellerUid, o.productId, index),
          blob: blob,
          contentType: 'image/jpeg',
          cacheControl: 'public, max-age=31536000, immutable',
        });
        if (!url) throw new Error('the upload returned no address');
        urls.push(url);
        if (typeof o.onProgress === 'function') o.onProgress(urls.length, files.length);
      } catch (err) {
        /* Carries what DID land, so a caller can neither claim total success nor
           lose track of real objects. */
        var e2 = new Error((err && err.message) || 'The photo could not be uploaded.');
        e2.uploaded = urls;
        e2.failedAt = index;
        throw e2;
      }
    }
    return { urls: urls };
  }

  return {
    ACCEPTED: ACCEPTED,
    MAX_BYTES: MAX_BYTES,
    MAX_PER_PRODUCT: MAX_PER_PRODUCT,
    accept: ACCEPTED.join(','),      /* for the file input's accept attribute */
    storagePath: storagePath,
    validate: validate,
    validateAll: validateAll,
    compress: compress,
    upload: upload,
  };
}));
