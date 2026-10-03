'use strict';
/* moderation-media.js — a TAKEN-DOWN product's photos are PRIVATE while the hold exists (owner decision 2026-10-03).
 *
 * FACTS this design rests on (agreed with sokoni-5b, the checkout / till owner):
 *   1. A Firebase download-token URL (…/o/<path>?alt=media&token=<t>) BYPASSES storage rules. The token in the object's
 *      custom metadata `firebaseStorageDownloadTokens` is the only lever for every link that already exists.
 *   2. orders, posTransactions, receipts and cart snapshots COPY a product's image URL at sale time. Rotating the token
 *      would break those images FOREVER. So the token is never rotated: it is VAULTED, STRIPPED, and on restore the SAME
 *      value is put back — every copied URL works again and no document is rewritten (the product doc is never touched
 *      here).
 *   3. The original token is a BEARER CREDENTIAL. It lives only in `moderationMediaVault/{productId}`, a server-only
 *      collection (no client rule → default deny; the served Firestore ruleset has no top-level wildcard). It is never
 *      logged, never audited, never returned, never stored on the report. Audit rows carry sha16(objectPath) only.
 *
 * APPLY (after the take-down transaction commits; also the retry):
 *   product held by `holdRef` → the product's own image objects (images[] · image · imageUrl · thumbnail · thumbnailUrl ·
 *   thumbUrl), ONLY under product-images/{product.sellerUid}/ in the served bucket (a URL into another seller's prefix is
 *   that seller's photo: never touched, recorded `foreign`) → read each object's metadata → the vault doc is CREATED with
 *   every token BEFORE any object is changed (tx.create; a retry finds it and keeps the stored tokens — a token read after
 *   a strip is empty and must never overwrite the vaulted one) → each object: firebaseStorageDownloadTokens removed +
 *   custom metadata moderationHold='1' (generation + metageneration preconditions, so a concurrent replace fails the strip
 *   instead of vaulting the wrong token). Every object's state is recorded; anything not stripped makes the result
 *   `partial` / `failed` — never `held`.
 *
 * RELEASE (after the restore transaction commits; also the retry):
 *   product NOT held → for every vaulted object: firebaseStorageDownloadTokens = EXACTLY the vaulted value (never a new
 *   one), moderationHold removed (same preconditions). Only when every object reached a terminal state is the vault doc
 *   deleted (in a transaction that re-checks its holdRef). Anything else stays in the vault, recorded, for the retry.
 *
 * Storage access FAILS CLOSED outside a Functions runtime (as trust-safety's notifier): a local harness that loads this
 * file must never reach the live bucket through application-default credentials. Tests inject a fake through _setStorage.
 */
const crypto = require('crypto');

const VAULT = 'moderationMediaVault';
const BUCKETS = Object.freeze(['sokoni-aeb26.firebasestorage.app']);   /* the bucket with a served storage ruleset */
const PREFIX = 'product-images/';
const IMAGE_FIELDS = Object.freeze(['images', 'image', 'imageUrl', 'thumbnail', 'thumbnailUrl', 'thumbUrl']);
const MAX_OBJECTS = 24;                 /* the merchant UI allows 6; a bound, not a quota */
const TOKEN_KEY = 'firebaseStorageDownloadTokens';
const FLAG_KEY = 'moderationHold';
const FLAG = '1';
/* terminal states: nothing left to do for that object on RELEASE */
const RELEASE_DONE = Object.freeze(['released', 'missing', 'not_owned', 'handed_off', 'replaced', 'foreign', 'unsupported_bucket']);

function sha16(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

let _storageFactory = null;   /* test seam: exports._setStorage(fn(bucketName) → bucket-like) */
function _bucket(name) {
  if (_storageFactory) return _storageFactory(name);
  if (!(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.FUNCTIONS_EMULATOR === 'true')) return null;
  try { return require('firebase-admin/storage').getStorage().bucket(name); } catch (_) { return null; }
}

/* ── which objects belong to this listing ── */
function _urlToObject(u) {
  if (typeof u !== 'string' || u.length > 2048) return null;
  let m = u.match(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/?#]+)\/o\/([^?#]+)/);
  if (m) { try { return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) }; } catch (_) { return null; } }
  m = u.match(/^https:\/\/storage\.googleapis\.com\/([^/?#]+)\/([^?#]+)/);
  if (m) { try { return { bucket: m[1], path: decodeURIComponent(m[2]) }; } catch (_) { return null; } }
  m = u.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (m) return { bucket: m[1], path: m[2] };
  return null;
}
function _candidateUrls(p) {
  const out = [];
  const take = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') for (const k of ['url', 'src', 'downloadURL', 'downloadUrl']) if (typeof v[k] === 'string') out.push(v[k]);
  };
  for (const f of IMAGE_FIELDS) {
    const v = p[f];
    if (Array.isArray(v)) v.slice(0, MAX_OBJECTS * 2).forEach(take); else take(v);
  }
  return out;
}
/** The listing's own image objects: [{bucket, path, state?}] — `foreign` / `unsupported_bucket` are recorded, never touched. */
function objectsOf(product) {
  const p = product || {};
  const seller = typeof p.sellerUid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(p.sellerUid) ? p.sellerUid : null;
  const seen = new Set(); const out = [];
  for (const u of _candidateUrls(p)) {
    const o = _urlToObject(u);
    if (!o || !o.path.startsWith(PREFIX) || o.path.includes('..')) continue;     /* not a product photo in Storage */
    const key = o.bucket + '/' + o.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!BUCKETS.includes(o.bucket)) out.push({ bucket: o.bucket, path: o.path, state: 'unsupported_bucket' });
    else if (!seller || !o.path.startsWith(PREFIX + seller + '/')) out.push({ bucket: o.bucket, path: o.path, state: 'foreign' });
    else out.push({ bucket: o.bucket, path: o.path });
  }
  return { objects: out.slice(0, MAX_OBJECTS), truncated: out.length > MAX_OBJECTS };
}

/* ── storage primitives (no token ever leaves these except into the vault write) ── */
function _code(e) { return String((e && (e.code || e.status)) || 'error').slice(0, 40); }
function _notFound(e) { return !!e && (e.code === 404 || e.code === '404' || e.status === 404); }
async function _meta(bucket, path) {
  const [md] = await bucket.file(path).getMetadata();
  const custom = (md && md.metadata) || {};
  return {
    tokens: typeof custom[TOKEN_KEY] === 'string' && custom[TOKEN_KEY] !== '' ? custom[TOKEN_KEY] : null,
    flagged: custom[FLAG_KEY] === FLAG,
    generation: md && md.generation != null ? String(md.generation) : null,
    metageneration: md && md.metageneration != null ? String(md.metageneration) : null,
  };
}
function _pre(m) {
  const o = {};
  if (m.generation) o.ifGenerationMatch = m.generation;
  if (m.metageneration) o.ifMetagenerationMatch = m.metageneration;
  return o;
}

/* public-safe view of a vault entry (the ONLY shape that may reach a report, an audit row, a response or a log) */
function _safe(entries) { return entries.map((e) => ({ pathRef: sha16(e.path), state: e.state, reason: e.reason || null })); }
function _summary(entries, extra) {
  const n = entries.length;
  const count = (s) => entries.filter((e) => (Array.isArray(s) ? s.includes(e.state) : e.state === s)).length;
  return Object.assign({ objects: n }, extra || {}, {
    stripped: count('stripped'), released: count('released'),
    failed: count(['strip_failed', 'release_failed', 'unavailable']),
    skipped: count(['foreign', 'unsupported_bucket', 'not_owned', 'already_held']),
  });
}

async function _audit(deps, action, productId, holdRef, correlationId, actorUid, status, entries, extra) {
  try {
    await deps.db.collection('trustSafetyAudit').add(Object.assign({
      action, entityType: 'product', entityId: String(productId), targetType: 'product', targetId: String(productId),
      holdRef: holdRef || null, correlationId: correlationId || null, status,
      media: _summary(entries), objects: _safe(entries),
      performedBy: actorUid || 'system', createdAt: deps.FieldValue.serverTimestamp(),
    }, extra || {}));
    return true;
  } catch (e) { console.error('[moderation-media] audit write failed', _code(e)); return false; }
}

/**
 * APPLY the media hold for `productId`. Idempotent; safe to call again (that IS the retry).
 * @returns {{status:'held'|'partial'|'failed'|'none'|'skipped', reason?, objects, stripped, failed, skipped}}
 */
async function applyMediaHold(deps, { productId, holdRef: wantRef, correlationId, actorUid }) {
  const { db } = deps;
  const pid = String(productId);
  const psnap = await db.collection('products').doc(pid).get();
  const p = psnap.exists ? (psnap.data() || {}) : null;
  const hold = p && p.moderationHold;
  if (!hold) return Object.assign({ status: 'skipped', reason: 'not_held' }, _summary([]));
  const holdRef = hold.ref || null;
  if (wantRef && holdRef !== wantRef) return Object.assign({ status: 'skipped', reason: 'held_by_other_ref' }, _summary([]));

  const { objects, truncated } = objectsOf(p);
  const vref = db.collection(VAULT).doc(pid);
  const pre = await vref.get();
  const vaulted = pre.exists ? ((pre.data() || {}).objects || []) : [];
  if (!objects.length && !vaulted.length) {
    return Object.assign({ status: 'none' }, _summary([]));
  }

  /* 1 ── read the tokens of objects not yet in the vault (BEFORE anything is changed) ── */
  const known = new Set(vaulted.map((e) => e.path));
  const fresh = [];
  let unavailable = false;
  for (const o of objects) {
    if (known.has(o.path)) continue;
    if (o.state) { fresh.push({ path: o.path, bucket: o.bucket, tokens: null, generation: null, state: o.state }); continue; }
    const b = _bucket(o.bucket);
    if (!b) { unavailable = true; fresh.push({ path: o.path, bucket: o.bucket, tokens: null, generation: null, state: 'unavailable', reason: 'storage_unavailable' }); continue; }
    try {
      const m = await _meta(b, o.path);
      /* already flagged and not in OUR vault: another listing's hold owns this object (a shared photo) — its token is in
         that vault; ours must not claim an empty token */
      if (m.flagged) fresh.push({ path: o.path, bucket: o.bucket, tokens: null, generation: m.generation, state: 'already_held' });
      else fresh.push({ path: o.path, bucket: o.bucket, tokens: m.tokens, generation: m.generation, state: 'vaulted' });
    } catch (e) {
      if (_notFound(e)) fresh.push({ path: o.path, bucket: o.bucket, tokens: null, generation: null, state: 'missing' });
      else fresh.push({ path: o.path, bucket: o.bucket, tokens: null, generation: null, state: 'unavailable', reason: _code(e) });
    }
  }

  /* 2 ── the vault: CREATED (tx.create) with every token before any strip; a retry APPENDS only new paths and never
          rewrites a stored token. An entry that could not be read is not stored (the retry reads it again). ── */
  const storable = fresh.filter((e) => e.state !== 'unavailable');
  let entries;
  try {
    entries = await db.runTransaction(async (tx) => {
      const s = await tx.get(vref);
      const now = deps.FieldValue.serverTimestamp();
      if (!s.exists) {
        tx.create(vref, { productId: pid, holdRef, correlationId: correlationId || null, at: now, updatedAt: now,
          status: 'vaulted', paths: storable.map((e) => e.path), objects: storable });
        return storable.slice();
      }
      const v = s.data() || {};
      const have = v.objects || [];
      const add = storable.filter((e) => !have.some((h) => h.path === e.path));
      const next = have.concat(add);
      const patch = { objects: next, paths: next.map((e) => e.path), updatedAt: now };
      /* a vault left by an earlier hold whose release did not finish: its tokens are the ORIGINALS — adopt it */
      if (v.holdRef !== holdRef) Object.assign(patch, { holdRef, adoptedFromRef: v.holdRef || null });
      tx.update(vref, patch);
      return next;
    });
  } catch (e) {
    console.error('[moderation-media] vault write failed', _code(e));
    const all = fresh.map((x) => Object.assign({}, x, { state: x.state === 'vaulted' ? 'strip_failed' : x.state, reason: x.reason || 'vault_write_failed' }));
    await _audit(deps, 'media_hold_failed', pid, holdRef, correlationId, actorUid, 'failed', all);
    return Object.assign({ status: 'failed', reason: 'vault_write_failed' }, _summary(all));
  }
  entries = entries.map((e) => Object.assign({}, e)).concat(fresh.filter((e) => e.state === 'unavailable'));

  /* 3 ── strip: remove the token, set the flag. Preconditions pin the object generation that was vaulted. ── */
  for (const e of entries) {
    if (!['vaulted', 'strip_failed'].includes(e.state)) continue;
    const b = _bucket(e.bucket);
    if (!b) { e.state = 'strip_failed'; e.reason = 'storage_unavailable'; unavailable = true; continue; }
    try {
      const m = await _meta(b, e.path);
      if (e.generation && m.generation && m.generation !== e.generation) {
        /* replaced since it was vaulted: the vaulted token belonged to an object that no longer exists. Not stripped;
           the retry re-vaults it. */
        e.state = 'strip_failed'; e.reason = 'object_replaced'; e._revault = true; continue;
      }
      if (m.flagged && !m.tokens) { e.state = 'stripped'; delete e.reason; continue; }      /* an earlier attempt did it */
      await b.file(e.path).setMetadata({ metadata: { [TOKEN_KEY]: null, [FLAG_KEY]: FLAG } }, _pre(m));
      e.state = 'stripped'; delete e.reason;
    } catch (err) {
      if (_notFound(err)) { e.state = 'missing'; delete e.reason; } else { e.state = 'strip_failed'; e.reason = _code(err); }
    }
  }

  /* 4 ── record the per-object states in the vault (tokens untouched: re-read inside the transaction) ── */
  const revault = entries.filter((e) => e._revault).map((e) => e.path);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  try {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(vref);
      if (!s.exists) return;
      const v = s.data() || {};
      const objs = (v.objects || []).filter((o) => !revault.includes(o.path)).map((o) => {
        const e = byPath.get(o.path);
        if (!e) return o;
        const st = o.state === 'stripped' ? 'stripped' : e.state;        /* never downgrade a recorded strip */
        const out = Object.assign({}, o, { state: st });
        if (st === 'stripped' || !e.reason) delete out.reason; else out.reason = e.reason;
        return out;
      });
      tx.update(vref, { objects: objs, paths: objs.map((o) => o.path), status: 'recorded', updatedAt: deps.FieldValue.serverTimestamp() });
    });
  } catch (e) { console.error('[moderation-media] vault state write failed', _code(e)); }

  /* already_held = private through another listing's hold (its vault owns the token) — private, so done here */
  const notDone = entries.filter((e) => !['stripped', 'missing', 'already_held'].includes(e.state));
  const done = entries.filter((e) => e.state === 'stripped').length;
  const status = truncated || notDone.length ? (done ? 'partial' : 'failed') : 'held';
  const reason = unavailable ? 'storage_unavailable' : (truncated ? 'too_many_objects' : (notDone.length ? 'not_all_objects_private' : null));
  await _audit(deps, status === 'held' ? 'media_hold_applied' : 'media_hold_incomplete', pid, holdRef, correlationId, actorUid, status, entries);
  return Object.assign({ status }, reason ? { reason } : {}, _summary(entries, truncated ? { truncated: true } : {}));
}

/**
 * RELEASE the media hold for `productId` after a restore. Puts back EXACTLY the vaulted token(s); deletes the vault only
 * when every object reached a terminal state.
 */
async function releaseMediaHold(deps, { productId, holdRef: wantRef, correlationId, actorUid }) {
  const { db } = deps;
  const pid = String(productId);
  const psnap = await db.collection('products').doc(pid).get();
  const p = psnap.exists ? (psnap.data() || {}) : null;
  if (p && p.moderationHold) return Object.assign({ status: 'skipped', reason: 'still_held' }, _summary([]));
  const vref = db.collection(VAULT).doc(pid);
  const vs = await vref.get();
  if (!vs.exists) return Object.assign({ status: 'none' }, _summary([]));
  const v = vs.data() || {};
  if (wantRef && v.holdRef !== wantRef) return Object.assign({ status: 'skipped', reason: 'vault_ref_mismatch' }, _summary([]));
  const holdRef = v.holdRef || null;
  const entries = (v.objects || []).map((e) => Object.assign({}, e));
  let unavailable = false;

  for (const e of entries) {
    if (RELEASE_DONE.includes(e.state)) continue;
    if (e.state === 'already_held') { e.state = 'not_owned'; continue; }
    /* a shared photo also held by ANOTHER listing's vault: hand our token to it instead of making the photo public */
    try {
      const others = await db.collection(VAULT).where('paths', 'array-contains', e.path).limit(5).get();
      const other = others.docs.find((d) => d.id !== pid);
      if (other) {
        const handed = await db.runTransaction(async (tx) => {
          const s = await tx.get(other.ref);
          if (!s.exists) return false;
          const ov = s.data() || {};
          const objs = (ov.objects || []).map((o) => (o.path === e.path && o.state === 'already_held'
            ? Object.assign({}, o, { tokens: e.tokens, generation: e.generation, state: 'stripped', handedFrom: sha16(pid) }) : o));
          if (!objs.some((o, i) => o !== (ov.objects || [])[i])) return false;
          tx.update(other.ref, { objects: objs, updatedAt: deps.FieldValue.serverTimestamp() });
          return true;
        });
        if (handed) { e.state = 'handed_off'; delete e.reason; continue; }
      }
    } catch (err) { e.state = 'release_failed'; e.reason = 'handoff_check_failed'; continue; }

    const b = _bucket(e.bucket);
    if (!b) { e.state = 'release_failed'; e.reason = 'storage_unavailable'; unavailable = true; continue; }
    try {
      const m = await _meta(b, e.path);
      if (e.generation && m.generation && m.generation !== e.generation) {
        /* a different object now lives at this path: the vaulted token was never its token. Lift the flag only. */
        if (m.flagged) await b.file(e.path).setMetadata({ metadata: { [FLAG_KEY]: null } }, _pre(m));
        e.state = 'replaced'; delete e.reason; continue;
      }
      /* EXACTLY the stored value — never generated, never rotated (null when the object had no token) */
      await b.file(e.path).setMetadata({ metadata: { [TOKEN_KEY]: e.tokens == null ? null : e.tokens, [FLAG_KEY]: null } }, _pre(m));
      e.state = 'released'; delete e.reason;
    } catch (err) {
      if (_notFound(err)) { e.state = 'missing'; delete e.reason; } else { e.state = 'release_failed'; e.reason = _code(err); }
    }
  }

  const allDone = entries.every((e) => RELEASE_DONE.includes(e.state));
  try {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(vref);
      if (!s.exists) return;
      const cur = s.data() || {};
      if (cur.holdRef !== holdRef) return;           /* adopted by a NEW hold meanwhile — it owns these tokens now */
      if (allDone) { tx.delete(vref); return; }
      const byPath = new Map(entries.map((e) => [e.path, e]));
      const objs = (cur.objects || []).map((o) => {
        const e = byPath.get(o.path); if (!e) return o;
        const out = Object.assign({}, o, { state: e.state });
        if (e.reason) out.reason = e.reason; else delete out.reason;
        return out;
      });
      tx.update(vref, { objects: objs, status: 'release_partial', updatedAt: deps.FieldValue.serverTimestamp() });
    });
  } catch (e) {
    console.error('[moderation-media] vault release write failed', _code(e));
    await _audit(deps, 'media_release_incomplete', pid, holdRef, correlationId, actorUid, 'failed', entries);
    return Object.assign({ status: 'failed', reason: 'vault_write_failed' }, _summary(entries));
  }
  const released = entries.filter((e) => e.state === 'released').length;
  const status = allDone ? 'released' : (released ? 'partial' : 'failed');
  const reason = allDone ? null : (unavailable ? 'storage_unavailable' : 'not_all_objects_released');
  await _audit(deps, allDone ? 'media_hold_released' : 'media_release_incomplete', pid, holdRef, correlationId, actorUid, status, entries);
  return Object.assign({ status }, reason ? { reason } : {}, _summary(entries));
}

module.exports = {
  applyMediaHold, releaseMediaHold, objectsOf,
  VAULT, BUCKETS, IMAGE_FIELDS, FLAG_KEY, FLAG, TOKEN_KEY,
  _sha16: sha16,
  _setStorage: (fn) => { _storageFactory = fn || null; },
};
