/* ================================================================
   SOKONI KassShop — the canonical seller/shop boundary
   Firebase Cloud Functions — Gen 2, Node 22

     getShopProfile        — the caller's own shop, for KassShop Management
     saveShopProfile       — create-or-update the canonical shop  (onCall)
     setShopAvailability   — live state: accepting orders / online / delivery / pickup
     getShopAvailability   — the EFFECTIVE state (live + schedule + override)

   WHY THIS EXISTS AS A SERVER BOUNDARY
   ------------------------------------
   `firestore.rules` authorises `/shops/{uid}` by DOCUMENT ID:

       allow create: if isAdmin();
       allow update: if isAdmin() || (isAuthed() && request.auth.uid == uid && …hasOnly([…]))

   so a client can only ever write `shops/{its-own-uid}`, can never create a shop, and cannot
   write the availability fields at all — they are not in the permitted key list. A seller whose
   canonical shop is `shops/shop-A` with `sellerUid: A` therefore could not write to their own
   shop from the browser.

   That is why Shop Setup ended up writing `sellers/{uid}` + `businesses/{uid}` and reading
   `localStorage.sokoniStore`, and why the storefront drifted away from it: the canonical
   document was never writable. Rather than widen the rules, ownership is enforced here, the
   same way every other money- and identity-critical path in SOKONI already does it:

       Auth → sellerUid ownership assertion → canonical shops/{shopId}

   Ownership is ALWAYS `shops/{shopId}.sellerUid === request.auth.uid`. Never `shopId === uid`.

   AVAILABILITY IS TWO CONCEPTS, DELIBERATELY NOT MERGED
   -----------------------------------------------------
     live state  shops/{shopId}            acceptingOrders / online / delivery / pickup
     schedule    providerAvailability/{uid} opening hours, closures, date overrides

   A seller who flips "offline" means it right now, whatever the timetable says. A timetable
   says what happens when nobody is flipping switches. Collapsing them loses one or the other,
   so both are kept and an EFFECTIVE state is derived:

       effective = live AND schedule, with a same-day override winning outright

   The public storefront reads the effective result, so flipping the shop offline is visible to
   buyers immediately.
================================================================ */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

const REGION = 'us-central1';
const _db = () => getFirestore();

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function _requireAuth(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Login required.');
  return request.auth.uid;
}

/** Strip tags, trim, truncate. Non-strings become ''. */
function _san(s, max = 500) {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/**
 * The one ownership question: which shop does this uid own?
 * Returns { id, data } or null. Never consults a document id, a cached shop, or a handle.
 * Legacy owner fields are accepted only because older shop documents predate `sellerUid` —
 * each is still scoped BY UID, so none of them can return another seller's shop.
 */
async function _ownedShop(uid) {
  const db = _db();
  for (const field of ['sellerUid', 'ownerUid', 'ownerId']) {
    const snap = await db.collection('shops').where(field, '==', uid).limit(2).get();
    if (snap.empty) continue;
    if (snap.size > 1) {
      logger.warn('KassShop: uid owns multiple shops', { field, count: snap.size });
    }
    /* Deterministic when several match — never "whichever came back first". */
    const docs = snap.docs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { id: docs[0].id, data: docs[0].data() || {} };
  }
  return null;
}

/* Profile fields a seller may set. Anything not listed here cannot be written through this
   boundary — status, verification, commission, ratings and counters are all owned elsewhere. */
const TEXT_FIELDS = {
  name: 120, storeName: 120, tagline: 160, about: 2000, description: 2000, bio: 2000,
  phone: 32, email: 160, website: 200, address: 300, city: 80, mapsLink: 400,
  instagram: 120, tiktok: 120, facebook: 120, twitter: 120, youtube: 120, linkedin: 120,
  logo: 600, logoUrl: 600, banner: 600, bannerUrl: 600, themeColor: 32,
  shopType: 24, sellerType: 24, delMethod: 40, delTime: 60,
  returnPolicy: 40, returnText: 1000, packagingNote: 500, freeDelivery: 60,
};
const AVAILABILITY_FIELDS = ['acceptingOrders', 'online', 'delivery', 'pickup'];
/* Fields a seller may SEND but that this boundary does not accept (owner decision 2026-09-28). `category` on shops/{id}
   is written at APPROVAL (application-lifecycle.projectSeller); the SOKONI category is `business.category`, set there
   or in AdminOS. They are reported back as `ignored` so a client can say so, rather than dropped silently. */
const AUTHORITY_FIELDS = ['category', 'business', 'status', 'approved', 'verified', 'isVerified', 'searchable', 'isPublic',
  'discoveryEligible', 'featured', 'published', 'suspended', 'isVisible', 'active'];
/* ── Shop profile VALUES (2026-09-29, the merchant-v2 Shop details port) ─────────────────────────────────────────
   Each value below reaches the public storefront, so it is checked for what it IS, not only trimmed:
   · choice fields accept only the codes both wizards (seller.html, merchant-v2) send;
   · images must be https, website / maps links http(s) — never javascript:/data: (the storefront puts website in an
     href);
   · social fields are HANDLES (the storefront prefixes the network's URL) — a pasted profile URL is reduced to its
     handle, anything else refused;
   · themeColor is a #rrggbb accent (the storefront's --ms-brand). seller.html's gradient strings were 39–55 chars and
     truncated at 32 into invalid CSS; they are now refused and reported;
   · freeDelivery is a whole-shilling amount.
   A non-empty value that fails is DROPPED and reported in `invalid`; an empty string clears the field. */
const CHOICES = {
  shopType:     ['online', 'hybrid', 'physical'],
  sellerType:   ['longterm', 'shortterm', 'service', 'wholesale'],
  delMethod:    ['sokoni', 'own', 'both', 'pickup'],
  delTime:      ['30min', '1hr', '2hr', 'sameday', 'nextday', '2-3days', '1week'],
  returnPolicy: ['7day', 'exchange', 'noreturn', 'custom'],
};
const IMAGE_FIELDS = ['logo', 'logoUrl', 'banner', 'bannerUrl'];
const LINK_FIELDS = ['website', 'mapsLink'];
const SOCIAL_FIELDS = ['instagram', 'tiktok', 'facebook', 'twitter', 'youtube', 'linkedin'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function _url(v, schemes) {
  try { const u = new URL(String(v)); return schemes.includes(u.protocol) ? u.toString() : ''; } catch (_) { return ''; }
}
function _socialHandle(key, v) {
  const h = String(v || '').trim()
    .replace(/^https?:\/\/(www\.|m\.|mobile\.)?[a-z0-9.-]+\.[a-z]{2,}\//i, '')
    .replace(/^@/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  /* linkedin / youtube / facebook handles carry a path ("company/acme", "@acme", "pages/acme") */
  const re = ['linkedin', 'youtube', 'facebook'].includes(key) ? /^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)?$/ : /^[A-Za-z0-9._-]+$/;
  return h.length <= 100 && re.test(h) ? h : '';
}
function _checkValues(out, invalid) {
  const bad = (k) => { delete out[k]; invalid.push(k); };
  for (const [k, allowed] of Object.entries(CHOICES)) {
    if (k in out && out[k] !== '' && !allowed.includes(out[k])) bad(k);
  }
  for (const k of IMAGE_FIELDS) if (k in out && out[k] !== '') { const u = _url(out[k], ['https:']); u ? (out[k] = u) : bad(k); }
  for (const k of LINK_FIELDS) if (k in out && out[k] !== '') { const u = _url(out[k], ['https:', 'http:']); u ? (out[k] = u) : bad(k); }
  for (const k of SOCIAL_FIELDS) if (k in out && out[k] !== '') { const h = _socialHandle(k, out[k]); h ? (out[k] = h) : bad(k); }
  if ('themeColor' in out && out.themeColor !== '' && !HEX_COLOR.test(out.themeColor)) bad('themeColor');
  if ('freeDelivery' in out && out.freeDelivery !== '') {
    const n = String(out.freeDelivery).replace(/[,\s]/g, '');
    /^\d{1,9}$/.test(n) ? (out.freeDelivery = n) : bad('freeDelivery');
  }
  return out;
}

/* Permit documents (the wizard's "Permits" step): the seller uploads to kyc-documents/{uid}/… (storage.rules: owner
   writes, only the owner and administrators read) and this records WHICH object is which permit, in the owner-only
   compliance document. A path outside the caller's own kyc-documents folder is refused. */
const PERMIT_KINDS = ['kra', 'sbp', 'brs', 'fire', 'health'];
function _cleanPermits(raw, uid) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of PERMIT_KINDS) {
    const p = raw[k];
    if (typeof p !== 'string') continue;
    if (p === '') { out[k] = ''; continue; }
    if (p.length <= 300 && p.startsWith('kyc-documents/' + uid + '/') && !p.includes('..') && /^[A-Za-z0-9._\-/]+$/.test(p)) out[k] = p;
  }
  return out;
}

/* ── The STOREFRONT projection ───────────────────────────────────────────────────────────────────────────────────
   The public storefront (/shop/{handle} → getMinishopPublic) reads minishopConfig FIRST and the shop document only to
   fill gaps (minishop-config-schema.resolve), so a profile saved on the shop alone was hidden behind any older
   storefront config. After every save the server rebuilds the storefront's copy from the CANONICAL shop document —
   the one writer of these storefront fields — whichever wizard saved it (merchant-v2 or seller.html).
   Buyer-facing text is built only from what the seller chose. freeDelivery is NOT shown to buyers: no checkout path
   applies it yet, and a promise checkout does not keep is worse than none. */
const CITY_LABEL = { nairobi: 'Nairobi', mombasa: 'Mombasa', kisumu: 'Kisumu', nakuru: 'Nakuru', eldoret: 'Eldoret',
  thika: 'Thika', nyeri: 'Nyeri', machakos: 'Machakos', malindi: 'Malindi', garissa: 'Garissa', kisii: 'Kisii',
  kericho: 'Kericho', meru: 'Meru', nanyuki: 'Nanyuki', kakamega: 'Kakamega', bungoma: 'Bungoma', kitale: 'Kitale',
  bomet: 'Bomet', lamu: 'Lamu', naivasha: 'Naivasha', nationwide: 'Nationwide' };
const DEL_METHOD_TEXT = { sokoni: 'Delivered by SOKONI riders', own: 'Delivered by our own riders',
  both: 'Delivered by SOKONI riders or our own riders', pickup: 'Pickup only — no delivery' };
const DEL_TIME_TEXT = { '30min': 'within 30 minutes', '1hr': 'within 1 hour', '2hr': 'within 2 hours', sameday: 'same day',
  nextday: 'next day', '2-3days': 'in 2–3 days', '1week': 'within a week' };
const RETURN_TEXT = { '7day': '7-day returns on eligible items', exchange: 'Exchanges only — no refunds',
  noreturn: 'All sales final — no returns' };
function storefrontProjection(s) {
  const d = s || {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const p = {};
  p.tagline = str(d.tagline);
  p.description = str(d.about) || str(d.description);
  p.contactPhone = str(d.phone);
  p.contactEmail = str(d.email);
  p.logoUrl = _url(d.logoUrl || d.logo, ['https:']);
  p.coverUrl = _url(d.bannerUrl || d.banner, ['https:']);
  if (HEX_COLOR.test(str(d.themeColor))) p.brandColor = d.themeColor;
  const links = {};
  for (const k of SOCIAL_FIELDS) { const h = _socialHandle(k, d[k]); if (h) links[k] = h; }
  const web = _url(d.website, ['https:', 'http:']); if (web) links.website = web;
  p.socialLinks = links;
  p.location = [str(d.address), CITY_LABEL[str(d.city).toLowerCase()] || str(d.city)].filter(Boolean).join(', ');
  p.deliveryAreas = Array.isArray(d.zones) ? d.zones.filter((z) => typeof z === 'string' && z).slice(0, 20) : [];
  const del = [DEL_METHOD_TEXT[d.delMethod], d.delMethod !== 'pickup' && DEL_TIME_TEXT[d.delTime]
    ? 'Usually ' + DEL_TIME_TEXT[d.delTime] : '', str(d.packagingNote)].filter(Boolean);
  p.deliveryPolicy = del.join(' · ').slice(0, 500);
  p.policies = (d.returnPolicy === 'custom' ? str(d.returnText) : (RETURN_TEXT[d.returnPolicy] || '')).slice(0, 1000);
  return p;
}
async function _syncStorefront(db, shopId) {
  try {
    const ref = db.collection('shops').doc(shopId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    const shop = snap.data() || {};
    const proj = storefrontProjection(shop);
    const write = Object.assign(require('./minishop-config-schema').forWrite(proj), { profileSyncedAt: FieldValue.serverTimestamp() });
    /* A merge write keeps what this projection does not own (handle, announcement, responseTime, a WhatsApp link set
       elsewhere). The social links the PROFILE owns are written explicitly — a cleared one is DELETED, so it
       disappears from the storefront instead of surviving the deep merge. */
    const links = Object.assign({}, write.socialLinks || {});
    for (const k of SOCIAL_FIELDS.concat(['website'])) if (!links[k]) links[k] = FieldValue.delete();
    write.socialLinks = links;
    await db.collection('minishopConfig').doc(shopId).set(write, { merge: true });
    /* the storefront reads shops/{id}.location BEFORE the config — keep the shop's own copy in step */
    if (proj.location && shop.location !== proj.location) await ref.set({ location: proj.location }, { merge: true });
    return true;
  } catch (err) {
    logger.warn('KassShop storefront sync failed', { shopId, code: err && err.code, msg: err && err.message });
    return false;
  }
}

function _ignoredAuthority(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return AUTHORITY_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
}

/* Regulatory identifiers. Deliberately NOT in TEXT_FIELDS: `shops/{shopId}` is
   `allow read: if true`, so anything listed there is public. These are the seller's
   tax and registration numbers — they belong to the shop, but not to the storefront.
   They are stored in `shops/{shopId}/private/compliance`, which only this function
   (Admin SDK) writes and only the owner may read. */
const COMPLIANCE_FIELDS = { kraPin: 20, sbpNumber: 40, brsNumber: 40 };
const COMPLIANCE_DOC = 'compliance';

function _cleanCompliance(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, max] of Object.entries(COMPLIANCE_FIELDS)) {
    if (key in raw) out[key] = _san(raw[key], max);
  }
  return out;
}

/** Whitelist + sanitise an incoming profile patch. Absent keys are left untouched. */
function _cleanProfile(raw, invalid) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (key in raw) out[key] = _san(raw[key], max);
  }
  /* Opening hours: a plain map of day → { closed, periods[] }. Shape-checked, not trusted. */
  if (raw.openingHours && typeof raw.openingHours === 'object' && !Array.isArray(raw.openingHours)) {
    const hours = {};
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      const cfg = raw.openingHours[day];
      if (!cfg || typeof cfg !== 'object') continue;
      const periods = Array.isArray(cfg.periods) ? cfg.periods.slice(0, 6).map((p) => ({
        open: _san(p && p.open, 5), close: _san(p && p.close, 5),
      })).filter((p) => p.open && p.close) : [];
      hours[day] = { closed: !!cfg.closed, periods };
    }
    if (Object.keys(hours).length) out.openingHours = hours;
  }
  if (Array.isArray(raw.zones)) out.zones = raw.zones.slice(0, 40).map((z) => _san(z, 80)).filter(Boolean);
  return _checkValues(out, invalid || []);
}

/* ================================================================
   1. getShopProfile — load KassShop Management from the canonical document
================================================================ */
exports.getShopProfile = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const owned = await _ownedShop(uid);

    /* "No shop" is a real, reportable answer — never an error, and never an empty form that
       looks identical to a slow read. The client distinguishes exists:false from a failure. */
    if (!owned) {
      return { exists: false, shopId: null, ownerUid: null, profile: null, availability: null, handle: null };
    }

    const db = _db();
    const [cfgSnap, schedSnap, compSnap] = await Promise.all([
      db.collection('minishopConfig').doc(owned.id).get(),
      db.collection('providerAvailability').doc(uid).get(),
      db.collection('shops').doc(owned.id).collection('private').doc(COMPLIANCE_DOC).get(),
    ]);
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};

    const profile = {};
    for (const key of Object.keys(TEXT_FIELDS)) {
      if (owned.data[key] !== undefined) profile[key] = owned.data[key];
    }
    if (owned.data.openingHours) profile.openingHours = owned.data.openingHours;
    if (owned.data.zones) profile.zones = owned.data.zones;

    const availability = {};
    for (const key of AVAILABILITY_FIELDS) {
      availability[key] = owned.data[key] !== undefined ? !!owned.data[key] : true;
    }

    /* Owner-only. This response is already gated by the ownership assertion above,
       so returning it here does not widen who can see it. */
    const compliance = {};
    if (compSnap.exists) {
      const c = compSnap.data() || {};
      for (const key of Object.keys(COMPLIANCE_FIELDS)) {
        if (c[key] !== undefined) compliance[key] = c[key];
      }
      if (c.permits && typeof c.permits === 'object') compliance.permits = c.permits;
    }

    /* `ownerUid` below is the AUTHENTICATED uid, so comparing it to auth.currentUser.uid
       proves nothing — it is the same value by construction. The invariant that actually
       matters is against the stored document:

           auth.currentUser.uid  ==  shops/{shopId}.sellerUid

       _ownedShop accepts the legacy `ownerUid` / `ownerId` fields for shops that predate
       `sellerUid`, and each is scoped by uid so none can return another seller's shop —
       but a document matched on a legacy field may carry a DIFFERENT `sellerUid`, in which
       case the invariant does not hold and the client should be able to see that rather
       than infer it. Returned for that comparison; null on legacy shops that never had it. */
    const shopSellerUid = owned.data.sellerUid || null;
    if (shopSellerUid && shopSellerUid !== uid) {
      logger.warn('KassShop: owned shop carries a different sellerUid', {
        shopId: owned.id, authUid: uid, shopSellerUid,
      });
    }

    return {
      exists: true,
      shopId: owned.id,
      ownerUid: uid,
      sellerUid: shopSellerUid,
      profile,
      compliance,
      availability,
      /* Read-only for the seller: the status and the SOKONI category are decided by approval / AdminOS
         (business-category.shopEligibility). Shown so the page can say so instead of offering an editor. */
      status: owned.data.status || null,
      sokoniCategory: (() => { const e = require('./business-category').shopEligibility(owned.data);
        return { id: e.category, label: e.category ? require('./business-category').label(e.category) : null, listed: e.eligible, reasons: e.reasons }; })(),
      schedule: schedSnap.exists ? (schedSnap.data() || null) : null,
      handle: cfg.handle || owned.data.minishopHandle || null,
      storefrontUrl: cfg.handle ? `/shop/${encodeURIComponent(cfg.handle)}` : null,
    };
  }
);

/**
 * Guarantee the shop has a public address.
 *
 * WHY A SHOP MUST HAVE A HANDLE THE MOMENT IT EXISTS
 * "Preview Store" resolves seller → owned shop → handle → /shop/{handle}. A shop with
 * no handle has no public URL, so the button had nowhere to send the seller and quietly
 * routed them back to Shop Setup — they saved their details, pressed Preview, and the
 * page did not move. The shop was correct the whole time; it was simply unreachable.
 *
 * Claiming a handle was a separate, optional step the seller had to discover. That made
 * the storefront opt-in without ever saying so. It is now provisioned here, from the
 * name the seller already typed, so a saved shop is always previewable and always
 * shareable.
 *
 * BEST EFFORT, NEVER FATAL. A shop that saved correctly must not be reported as failed
 * because its vanity URL could not be minted, so every failure path returns null and
 * leaves the save intact.
 */
function _slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : '';
}

async function _ensureHandle(db, shopId, uid, name) {
  try {
    /* Already has one — either mirrored on the config, or reserved under this uid. */
    const cfgSnap = await db.collection('minishopConfig').doc(shopId).get();
    const existing = cfgSnap.exists ? (cfgSnap.data() || {}).handle : null;
    if (existing) return existing;

    const owned = await db.collection('shopHandles').where('uid', '==', uid).limit(1).get();
    if (!owned.empty) {
      const h = owned.docs[0].id;
      /* The reservation landed but the config mirror did not, so the storefront
         resolver could not find it. Repair rather than mint a second handle. */
      await db.collection('minishopConfig').doc(shopId)
        .set({ handle: h, shopId, ownerUid: uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return h;
    }

    const slug = _slugify(name);
    if (!slug) return null;

    let reserved = null;
    const { RESERVED_HANDLES } = require('./minishop');   /* lazy: avoids a require cycle */
    /* Deterministic first, then suffixed. Bounded: a seller whose name collides ten
       times gets no handle rather than an unbounded scan of the collection. */
    for (let i = 0; i < 10 && !reserved; i++) {
      const candidate = (i === 0 ? slug : (slug + '-' + (i + 1))).slice(0, 30).replace(/-+$/g, '');
      if (candidate.length < 3) continue;
      if (RESERVED_HANDLES && RESERVED_HANDLES.has(candidate)) continue;

      const ref = db.collection('shopHandles').doc(candidate);
      /* Transactional so two concurrent first saves cannot both take the same name —
         the loser sees the document and moves to the next candidate. */
      const won = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) return (snap.data() || {}).uid === uid;
        tx.set(ref, { shopId, uid, handle: candidate, createdAt: FieldValue.serverTimestamp() });
        return true;
      });
      if (won) reserved = candidate;
    }
    if (!reserved) return null;

    await db.collection('minishopConfig').doc(shopId)
      .set({ handle: reserved, shopId, ownerUid: uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    logger.info('KassShop handle provisioned', { shopId, handle: reserved });
    return reserved;
  } catch (err) {
    logger.warn('KassShop handle provisioning failed', { shopId, code: err && err.code });
    return null;
  }
}

/* ================================================================
   2. saveShopProfile — create on first setup, update thereafter
================================================================ */
exports.saveShopProfile = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const data = request.data || {};
    const invalid = [];
    const patch = _cleanProfile(data.profile, invalid);
    const ignored = _ignoredAuthority(data.profile);
    /* Compliance may arrive nested (`{compliance:{…}}`) or flattened into the profile
       by an older client. Both are accepted; neither reaches the public document. */
    const compliance = Object.assign(_cleanCompliance(data.profile), _cleanCompliance(data.compliance));
    const permits = _cleanPermits(data.compliance && data.compliance.permits, uid);
    if (Object.keys(permits).length) compliance.permits = permits;

    if (!Object.keys(patch).length && !Object.keys(compliance).length) {
      throw new HttpsError('invalid-argument', 'Nothing to save.');
    }
    /* A shop needs a name to exist. Enforced here rather than in the form, because the form is
       not the authority on what a valid shop is. */
    const owned = await _ownedShop(uid);
    const name = patch.name || patch.storeName || (owned && (owned.data.name || owned.data.storeName));
    if (!name) throw new HttpsError('invalid-argument', 'A shop name is required.');

    const db = _db();
    const now = FieldValue.serverTimestamp();

    if (owned) {
      /* UPDATE. _ownedShop already proved ownership; re-assert inside the write so a shop that
         changed hands between the read and the write cannot be overwritten. */
      const ref = db.collection('shops').doc(owned.id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError('not-found', 'Shop not found.');
        const d = snap.data() || {};
        if (!(d.sellerUid === uid || d.ownerUid === uid || d.ownerId === uid)) {
          throw new HttpsError('permission-denied', 'You do not own this shop.');
        }
        /* Backfill the canonical owner field on a legacy document, so the next read resolves
           through sellerUid like everything else. */
        const write = Object.assign({}, patch, { sellerUid: uid, updatedAt: now });
        tx.set(ref, write, { merge: true });
        /* Same transaction: the storefront copy and the regulatory identifiers commit
           together or not at all, so a half-saved form can never be reported as saved. */
        if (Object.keys(compliance).length) {
          tx.set(ref.collection('private').doc(COMPLIANCE_DOC),
            Object.assign({}, compliance, { sellerUid: uid, updatedAt: now }), { merge: true });
        }
      });
      logger.info('KassShop profile updated', { shopId: owned.id, fields: Object.keys(patch).length });
      const handle = await _ensureHandle(db, owned.id, uid, name);
      const storefrontSynced = await _syncStorefront(db, owned.id);
      return {
        success: true, created: false, shopId: owned.id, ownerUid: uid,
        ignored, invalid, storefrontSynced,
        handle: handle || null,
        storefrontUrl: handle ? '/shop/' + encodeURIComponent(handle) : null,
      };
    }

    /* CREATE — first-time setup. Exactly one shop per seller: the ownership query above found
       none, and the transaction re-checks before committing so two concurrent first saves
       cannot mint two shops.

       THE DOCUMENT ID IS THE OWNER'S UID, AND THAT IS NOT THE BUG WE FIXED.
       This first used an auto-generated id, and the shop then vanished from everything
       downstream: store.html, product.js and the seller analytics reader all fetch
       `shops/{uid}` directly, and firestore.rules only ever authorises a client to write
       `shops/{request.auth.uid}`. A newly created KassShop existed and was owned correctly, yet
       no buyer surface could find it.

       The rule that matters is "ownership is never INFERRED from the document id" — every
       resolver still asks `where sellerUid == uid` and still requires a doc reached by id to
       name the caller as owner. Choosing the uid AS the id does not weaken that; it just stops
       the canonical shop being invisible to every consumer that already keys on it. Shops whose
       id is not a uid remain fully supported — they are resolved by sellerUid like everything
       else, which is exactly what the suite asserts. */
    const ref = db.collection('shops').doc(uid);
    await db.runTransaction(async (tx) => {
      const dupe = await tx.get(db.collection('shops').where('sellerUid', '==', uid).limit(1));
      if (!dupe.empty) {
        /* Someone else's request created it first — fold into that shop rather than adding one. */
        const existing = dupe.docs[0];
        tx.set(existing.ref, Object.assign({}, patch, { sellerUid: uid, updatedAt: now }), { merge: true });
        if (Object.keys(compliance).length) {
          tx.set(existing.ref.collection('private').doc(COMPLIANCE_DOC),
            Object.assign({}, compliance, { sellerUid: uid, updatedAt: now }), { merge: true });
        }
        return;
      }
      tx.set(ref, Object.assign({}, patch, {
        sellerUid: uid,
        name: name,
        /* PENDING, not active (owner decision 2026-09-28: a seller never activates or approves itself). Setting up a
           shop is not approval: this callable only needs a signed-in caller. The shop becomes active — and gets its
           SOKONI category and discovery flags — only when AdminOS approves the application (projectSeller merges
           status:'active', business, searchable, isPublic onto this same shops/{uid}). No isVisible is written: an
           explicit `false` would outlive the approval, and visibility is not the seller's to grant. */
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }));
      if (Object.keys(compliance).length) {
        tx.set(ref.collection('private').doc(COMPLIANCE_DOC),
          Object.assign({}, compliance, { sellerUid: uid, updatedAt: now }), { merge: true });
      }
    });

    /* Re-resolve rather than assume: if the transaction folded into a concurrently-created
       shop, `ref.id` is not the seller's shop and returning it would be a lie. */
    const settled = await _ownedShop(uid);
    const settledId = settled ? settled.id : ref.id;
    logger.info('KassShop created', { shopId: settledId });
    const handle = await _ensureHandle(db, settledId, uid, name);
    const storefrontSynced = await _syncStorefront(db, settledId);
    return {
      success: true, created: true, shopId: settledId, ownerUid: uid,
        ignored, invalid, storefrontSynced,
      handle: handle || null,
      storefrontUrl: handle ? '/shop/' + encodeURIComponent(handle) : null,
    };
  }
);

/* ================================================================
   3. setShopAvailability — the LIVE state
================================================================ */
exports.setShopAvailability = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const raw = (request.data || {}).availability || request.data || {};

    const patch = {};
    for (const key of AVAILABILITY_FIELDS) {
      if (key in raw) patch[key] = !!raw[key];
    }
    if (!Object.keys(patch).length) {
      throw new HttpsError('invalid-argument', 'No availability fields supplied.');
    }

    const owned = await _ownedShop(uid);
    /* Refuse rather than invent. A toggle with nothing to toggle is an error; creating a shop
       as a side effect of flipping a switch is how stray documents appear. */
    if (!owned) throw new HttpsError('not-found', 'No shop found for your account.');

    await _db().collection('shops').doc(owned.id)
      .set(Object.assign({}, patch, { sellerUid: uid, updatedAt: FieldValue.serverTimestamp() }), { merge: true });

    logger.info('KassShop availability set', { shopId: owned.id });
    return { success: true, shopId: owned.id, availability: patch };
  }
);

/* ================================================================
   4. Effective availability — live + schedule + override
================================================================ */

const _DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Combine the live state with the schedule.
 *
 *   · An explicit date override wins outright — it exists precisely to contradict the timetable.
 *   · Otherwise the shop is open only if the live state says so AND the timetable agrees.
 *
 * `at` is milliseconds; `tzOffsetMin` shifts UTC to the shop's local clock (Kenya = +180).
 * Returns the decision AND the reason, because "closed" with no reason is unactionable for the
 * seller and unexplainable to the buyer.
 */
function computeEffectiveAvailability(live, schedule, at, tzOffsetMin) {
  const state = {
    acceptingOrders: live && live.acceptingOrders !== undefined ? !!live.acceptingOrders : true,
    online: live && live.online !== undefined ? !!live.online : true,
    delivery: live && live.delivery !== undefined ? !!live.delivery : true,
    pickup: live && live.pickup !== undefined ? !!live.pickup : true,
  };

  if (!state.online || !state.acceptingOrders) {
    return { open: false, reason: 'offline', source: 'live', state };
  }

  const local = new Date((at || 0) + (tzOffsetMin || 0) * 60000);
  const ymd = local.toISOString().slice(0, 10);
  const overrides = (schedule && schedule.overrides) || {};
  const ov = overrides[ymd];
  if (ov) {
    if (ov.closed === true) return { open: false, reason: 'closed_today', source: 'override', state, date: ymd };
    if (ov.closed === false) return { open: true, reason: 'special_hours', source: 'override', state, date: ymd };
  }

  const hours = (schedule && (schedule.hours || schedule.openingHours)) || null;
  if (!hours) return { open: true, reason: 'no_schedule', source: 'live', state };

  const cfg = hours[_DAYS[local.getUTCDay()]];
  if (!cfg || cfg.closed || !Array.isArray(cfg.periods) || !cfg.periods.length) {
    return { open: false, reason: 'outside_hours', source: 'schedule', state };
  }

  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = (hhmm) => {
    const parts = String(hhmm || '').split(':');
    const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  for (const p of cfg.periods) {
    const a = toMin(p && p.open), b = toMin(p && p.close);
    if (a === null || b === null) continue;
    /* A period that ends before it starts crosses midnight. */
    if (b >= a ? (mins >= a && mins < b) : (mins >= a || mins < b)) {
      return { open: true, reason: 'within_hours', source: 'schedule', state };
    }
  }
  return { open: false, reason: 'outside_hours', source: 'schedule', state };
}
exports.computeEffectiveAvailability = computeEffectiveAvailability;

/** Resolve the effective availability for any shop — used by the public storefront. */
async function effectiveForShop(shopId, atMs) {
  const db = _db();
  const shopSnap = await db.collection('shops').doc(String(shopId)).get();
  if (!shopSnap.exists) return null;
  const shop = shopSnap.data() || {};
  const ownerUid = shop.sellerUid || shop.ownerUid || shop.ownerId || null;

  let schedule = shop.openingHours ? { hours: shop.openingHours } : null;
  if (ownerUid) {
    const sched = await db.collection('providerAvailability').doc(ownerUid).get();
    if (sched.exists) {
      const d = sched.data() || {};
      /* The seller-managed timetable wins over the copy denormalised on the shop. */
      schedule = { hours: d.hours || d.openingHours || (schedule && schedule.hours) || null,
                   overrides: d.overrides || null };
    }
  }
  return computeEffectiveAvailability(shop, schedule, atMs || Date.now(), 180 /* EAT */);
}
exports.effectiveForShop = effectiveForShop;

/**
 * The one resolver the PUBLIC storefront uses for shop state.
 *
 * KassShop Management and the buyer-facing storefront are two views of one shop, not
 * two copies of it. The seller flips "offline" or edits opening hours in the console;
 * the buyer must see that same decision. That only holds if both sides derive state
 * from the same place, so the storefront calls this rather than re-reading the shop
 * and re-deciding for itself.
 *
 * Returns the effective open/closed decision AND the timetable behind it, because a
 * storefront calendar that is not the schedule the seller actually manages is
 * decoration — it would keep looking right while being wrong.
 *
 * NEVER THROWS. A storefront that 500s because availability could not be resolved is
 * worse than one that omits the badge: callers get null and render a neutral state,
 * per the platform rule that unknown is never rendered as a value.
 */
async function publicShopState(shopId, ownerUid) {
  try {
    const db = _db();
    const uid = ownerUid || null;
    const [eff, schedSnap] = await Promise.all([
      effectiveForShop(shopId, Date.now()),
      uid ? db.collection('providerAvailability').doc(uid).get() : Promise.resolve(null),
    ]);
    if (!eff) return { availability: null, schedule: null };

    const sched = schedSnap && schedSnap.exists ? (schedSnap.data() || {}) : {};
    const shopSnap = await db.collection('shops').doc(String(shopId)).get();
    const shopHours = shopSnap.exists ? (shopSnap.data() || {}).openingHours : null;

    return {
      availability: {
        open: eff.open, reason: eff.reason, source: eff.source,
        acceptingOrders: eff.state.acceptingOrders,
        delivery: eff.state.delivery,
        pickup: eff.state.pickup,
      },
      /* The seller-managed timetable wins over the copy denormalised on the shop —
         the same precedence effectiveForShop() applies, so the calendar a buyer sees
         and the decision they are given cannot disagree. */
      schedule: {
        hours: sched.hours || sched.openingHours || shopHours || null,
        overrides: sched.overrides || null,
      },
    };
  } catch (err) {
    logger.warn('KassShop publicShopState failed', { code: err && err.code });
    return { availability: null, schedule: null };
  }
}
exports.publicShopState = publicShopState;

exports.getShopAvailability = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const shopId = (request.data || {}).shopId;
    /* Public by design — a buyer must be able to see whether a shop is open. Reads only. */
    if (typeof shopId !== 'string' || !shopId.trim()) {
      throw new HttpsError('invalid-argument', 'shopId is required.');
    }
    const eff = await effectiveForShop(shopId.trim(), Date.now());
    if (!eff) throw new HttpsError('not-found', 'Shop not found.');
    return eff;
  }
);

/* Pure helpers, for scripts/test-shop-profile-storefront.js (not a Cloud Function: index.js re-exports by name). */
exports._profile = { storefrontProjection, _cleanProfile, _cleanPermits, CHOICES };
