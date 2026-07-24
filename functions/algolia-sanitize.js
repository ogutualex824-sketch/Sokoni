'use strict';

/**
 * Record sanitisation for Algolia — shared by the LIVE queue path and the
 * backfill script.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Algolia rejects an **entire batch** when a single record exceeds 10,000 bytes.
 * On 2026-07-24 one product ("PEACH MANGO ICE") stored a base64 `data:` URI as
 * its image — 195,425 bytes in `images`, 195,397 in `image` — producing a
 * 195,884-byte record. Every product batched with it failed:
 *
 *     ERR: Record at the position 4 objectID=products_1784487444890 is too big
 *          size=195884/10000 bytes
 *
 * 26+ consecutive queue upserts failed on that one document. New and edited
 * products stopped reaching the index.
 *
 * The defences below already existed in `scripts/algolia-backfill.js` and had
 * never been ported to the live path — the recovery path was hardened, the
 * runtime path was not. They live here now so that cannot happen a third time.
 *
 * A malformed document must degrade ITSELF, never its neighbours.
 */

const MAX_RECORD_BYTES = 9000;   /* headroom under Algolia's 10,000 */

/* An image reference is only safe if it is an ordinary http(s) URL of sane
   length. `data:` URIs are the specific failure this module exists to stop;
   `javascript:` and friends are rejected by the same rule. */
function safeImageUrl(v) {
  const s = String(v == null ? '' : v);
  return /^https?:\/\//i.test(s) && s.length <= 500 ? s : '';
}

function recordBytes(rec) {
  return Buffer.byteLength(JSON.stringify(rec), 'utf8');
}

/* Walk the image-bearing fields the transformers actually produce and drop
   anything that is not a safe URL. Handles both record shapes: the live
   transformer's `images: [{url}]` + `thumbnail`, and the backfill's flat
   `imageUrl`. */
function stripUnsafeImages(rec) {
  const out = Array.isArray(rec) ? rec.slice() : Object.assign({}, rec);
  const actions = [];

  ['imageUrl', 'thumbnail', 'image', 'photo', 'coverImage', 'logo'].forEach(k => {
    if (typeof out[k] === 'string' && out[k] && !safeImageUrl(out[k])) {
      out[k] = '';
      actions.push('dropped unsafe ' + k);
    }
  });

  if (Array.isArray(out.images)) {
    const before = out.images.length;
    out.images = out.images
      .map(img => {
        if (typeof img === 'string') return safeImageUrl(img) ? img : null;
        if (img && typeof img === 'object') {
          const url = safeImageUrl(img.url);
          return url ? Object.assign({}, img, { url }) : null;
        }
        return null;
      })
      .filter(Boolean);
    if (out.images.length !== before) {
      actions.push(`dropped ${before - out.images.length} unsafe image(s)`);
    }
  }

  if (out.seller && typeof out.seller === 'object' && typeof out.seller.logo === 'string') {
    if (out.seller.logo && !safeImageUrl(out.seller.logo)) {
      out.seller = Object.assign({}, out.seller, { logo: '' });
      actions.push('dropped unsafe seller.logo');
    }
  }

  return { record: out, actions };
}

/* Last line of defence: whatever the mapping produced, make it fit. Trim the
   biggest text first, then drop it. `objectID` is always preserved so a
   degraded record is still findable and repairable. */
function enforceSize(rec, max) {
  const limit = max || MAX_RECORD_BYTES;
  const actions = [];
  if (recordBytes(rec) <= limit) return { record: rec, actions, ok: true };

  const out = Object.assign({}, rec);

  if (Array.isArray(out.images) && out.images.length > 1) {
    out.images = out.images.slice(0, 1);
    actions.push('kept only the first image');
    if (recordBytes(out) <= limit) return { record: out, actions, ok: true };
  }
  ['imageUrl', 'thumbnail'].forEach(k => {
    if (recordBytes(out) > limit && out[k]) { out[k] = ''; actions.push('cleared ' + k); }
  });
  if (recordBytes(out) <= limit) return { record: out, actions, ok: true };

  if (typeof out.description === 'string' && out.description.length > 200) {
    out.description = out.description.slice(0, 200);
    actions.push('truncated description');
    if (recordBytes(out) <= limit) return { record: out, actions, ok: true };
    delete out.description;
    actions.push('dropped description');
    if (recordBytes(out) <= limit) return { record: out, actions, ok: true };
  }

  /* Strip every remaining long string, longest first so the fewest fields are
     harmed. Arrays of terms go last. */
  const longKeys = Object.keys(out)
    .filter(k => k !== 'objectID' && typeof out[k] === 'string' && out[k].length > 100)
    .sort((a, b) => out[b].length - out[a].length);
  for (const k of longKeys) {
    out[k] = '';
    actions.push('cleared ' + k);
    if (recordBytes(out) <= limit) return { record: out, actions, ok: true };
  }
  for (const k of Object.keys(out)) {
    if (k === 'objectID' || !Array.isArray(out[k])) continue;
    out[k] = [];
    actions.push('emptied ' + k);
    if (recordBytes(out) <= limit) return { record: out, actions, ok: true };
  }

  /* Irreducible — the caller must isolate it rather than batch it. */
  return { record: out, actions, ok: false };
}

/**
 * Full pass. Returns:
 *   { record, ok, bytes, actions, reason }
 *
 * `ok:false` means the record cannot be made to fit and MUST NOT be placed in a
 * shared batch — isolate it and report `reason`.
 */
function sanitizeRecord(rec, max) {
  if (!rec || typeof rec !== 'object') {
    return { record: rec, ok: false, bytes: 0, actions: [], reason: 'not an object' };
  }
  const stripped = stripUnsafeImages(rec);
  const sized    = enforceSize(stripped.record, max);
  const actions  = stripped.actions.concat(sized.actions);
  const bytes    = recordBytes(sized.record);

  return {
    record: sized.record,
    ok:     sized.ok,
    bytes,
    actions,
    reason: sized.ok ? null
      : `record is ${bytes} bytes after sanitisation (limit ${max || MAX_RECORD_BYTES})`,
  };
}

module.exports = {
  MAX_RECORD_BYTES,
  safeImageUrl,
  recordBytes,
  stripUnsafeImages,
  enforceSize,
  sanitizeRecord,
};
