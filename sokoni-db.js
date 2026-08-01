/* ================================================================
   SOKONI — Firestore Data Layer  (sokoni-db.js)
   Shared real-time helpers for applications, providers,
   bookings, rides, GPS tracking and orders.
   Import as a module — exposes window.SokoniDB for inline scripts.
================================================================ */
import { db, auth } from './firebase.js';
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy, serverTimestamp, increment, limit, documentId,
  getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const _log = window.SokoniLogger || { log:()=>{}, warn:()=>{}, error:()=>{} };

/* Search keeps a warm catalogue cache (in-session 10 min, localStorage 30 min)
   so queries match locally instead of hitting the network. Without an explicit
   invalidation a seller who adds or removes a product and searches for it
   immediately is served the pre-write scan and concludes search is broken —
   the write succeeded, the cache simply had not expired. Any product write must
   therefore drop that collection's cached copy. */
function _invalidateProductSearchCache() {
  try { window.SokoniFirestoreSearch?.invalidateScanCache?.('products'); } catch (_) {}
}

/* Helper — returns the current authenticated user's UID.
   Prefers auth.currentUser (JWT-verified). Falls back to localStorage
   ONLY as a same-tick fallback before Firebase Auth initialises. */
function _uid() {
  if (auth.currentUser?.uid) return auth.currentUser.uid;
  /* Minimal localStorage fallback — only used for non-privileged metadata */
  try {
    return JSON.parse(localStorage.getItem('sokoniUser') || 'null')?.uid ?? null;
  } catch { return null; }
}

/* ══════════════════════════════════════════════════════════════
   WRITE THROTTLE — prevents flooding Firestore with duplicate writes
   keyed by (collection, docId or operation name).
   Minimum gap between identical writes: 2 seconds.
══════════════════════════════════════════════════════════════ */
const _writeThrottle = new Map();
function _throttleKey(col, id) { return `${col}::${id}`; }
function _canWrite(col, id, gapMs = 2000) {
  const key  = _throttleKey(col, id);
  const last = _writeThrottle.get(key) || 0;
  const now  = Date.now();
  if (now - last < gapMs) return false;
  _writeThrottle.set(key, now);
  /* Auto-clean keys older than 30 seconds to prevent memory growth */
  if (_writeThrottle.size > 500) {
    const cutoff = now - 30000;
    _writeThrottle.forEach((ts, k) => { if (ts < cutoff) _writeThrottle.delete(k); });
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════
   IDEMPOTENCY KEY STORE  — prevents duplicate order/review creation
   on network retry or double-click.
══════════════════════════════════════════════════════════════ */
const _idemKeys = new Set();
function _idemGuard(key) {
  if (_idemKeys.has(key)) return false;
  _idemKeys.add(key);
  setTimeout(() => _idemKeys.delete(key), 10000); /* expire after 10 sec */
  return true;
}

const SokoniDB = {

  /* Server-clock sentinel for callers (e.g. driver.html) that need an
     authoritative event time without importing the Firestore SDK. Resolved by
     Firestore on the server at commit — the client never supplies the value. */
  serverTimestamp: () => serverTimestamp(),

  /* ════════════════════════════════════════
     APPLICATIONS  (providers, drivers, sellers)
  ════════════════════════════════════════ */

  async saveApplication(app) {
    const id = app.id || ('APP-' + Date.now());
    await setDoc(doc(db, 'applications', id), {
      ...app, id, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return id;
  },

  /* onError is not optional here. This used to warn to the console and stop,
     so a rules rejection or a missing index left the caller holding whatever
     it had before — usually nothing — with no way to tell "failed to load"
     from "nobody has applied". The caller now gets told, and can say so.

     orderBy(createdAt) is load-bearing: Firestore omits documents that lack
     the ordering field entirely, so a write path that forgets createdAt makes
     its own record invisible here rather than erroring. Verified against
     production 2026-08-01: 4/4 application documents carry createdAt.
     (orderBy(updatedAt) on the same collection returns 1 of 4.) */
  listenApplications(callback, limitN = 100, onError) {
    const q = query(collection(db, 'applications'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })), { source: 'firestore' }),
      err  => {
        _log.warn('[SokoniDB] applications:', err.message);
        if (typeof onError === 'function') { try { onError(err); } catch (e) {} }
      }
    );
  },

  async updateApplicationStatus(fsId, status, meta = {}) {
    await updateDoc(doc(db, 'applications', fsId), {
      status, ...meta, updatedAt: serverTimestamp()
    });
  },

  /* ════════════════════════════════════════
     PROVIDERS
  ════════════════════════════════════════ */

  /**
   * `providers` is the canonical service-provider registry and holds ONE
   * document per account, keyed by Auth uid.
   *
   * This used to key the document by the phone number's digits. Two
   * consequences, both live: a provider who re-registered with a different
   * number got a second listing, and an account already onboarded under its
   * uid got a second, competing document the moment it used this form. Keying
   * by uid makes the write idempotent — re-registering updates the one record
   * that account owns.
   *
   * firestore.rules require `uid == request.auth.uid` on create, so an
   * unauthenticated caller cannot write here at all; failing fast with a clear
   * error beats a rules rejection surfacing as a silent catch upstream.
   */
  async saveProvider(profile) {
    const uid = _uid();
    if (!uid) throw new Error('Sign in before saving a provider profile');
    await setDoc(doc(db, 'providers', uid), {
      ...profile, _localId: profile.id || null, uid, updatedAt: serverTimestamp()
    }, { merge: true });
    return uid;
  },

  async getProvider(id) {
    const snap = await getDoc(doc(db, 'providers', id));
    return snap.exists() ? { _fsId: snap.id, ...snap.data() } : null;
  },

  async updateProviderStatus(id, status) {
    const safeId = String(id || '').replace(/\D/g, '');
    await setDoc(doc(db, 'providers', safeId), {
      status, statusUpdatedAt: serverTimestamp()
    }, { merge: true });
  },

  listenProvider(id, callback) {
    const safeId = String(id || '').replace(/\D/g, '');
    return onSnapshot(doc(db, 'providers', safeId),
      snap => { if (snap.exists()) callback({ _fsId: snap.id, ...snap.data() }); },
      err  => _log.warn('[SokoniDB] provider:', err.message)
    );
  },

  /* ════════════════════════════════════════
     BOOKINGS
  ════════════════════════════════════════ */

  async saveBooking(booking) {
    const normalizedPhone = booking.clientPhone
      ? String(booking.clientPhone).replace(/\D/g, '')
      : null;
    const ref = await addDoc(collection(db, 'bookings'), {
      ...booking,
      clientPhone: normalizedPhone,
      uid: _uid(),
      /* WS4b — tag the legacy free-request create path so it is MEASURABLE for the
         Phase F retirement decision (a client can't write systemHealth directly, so
         it's counted server-side via a .count() on this tag). Observational only. */
      bookingSource: 'legacy-request',
      createdAt: serverTimestamp()
    });
    return ref.id;
  },

  listenProviderBookings(providerId, callback, limitN = 100) {
    const q = query(
      collection(db, 'bookings'),
      where('providerId', '==', providerId),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] bookings:', err.message)
    );
  },

  async updateBooking(fsId, data) {
    await updateDoc(doc(db, 'bookings', fsId), {
      ...data, updatedAt: serverTimestamp()
    });
  },

  listenClientBookings(clientPhone, callback, limitN = 100) {
    const normalizedPhone = String(clientPhone || '').replace(/\D/g, '');
    const q = query(
      collection(db, 'bookings'),
      where('clientPhone', '==', normalizedPhone),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] client bookings:', err.message)
    );
  },

  /* ════════════════════════════════════════
     PROVIDERS — listen for all registered providers
  ════════════════════════════════════════ */
  listenProviders(callback, limitN = 50) {
    /* status guard is required by /providers; ordering moves to the client so
       no composite index is needed. */
    const q = query(collection(db, 'providers'), where('status', 'in', ['active', 'approved']), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] providers:', err.message)
    );
  },

  /* ════════════════════════════════════════
     RIDES
  ════════════════════════════════════════ */

  async saveRide(ride) {
    if (!ride?.ref) throw new Error('Ride reference missing');
    await setDoc(doc(db, 'rides', ride.ref), {
      ...ride, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return ride.ref;
  },

  async updateRide(ref, data) {
    await setDoc(doc(db, 'rides', ref), {
      ...data, updatedAt: serverTimestamp()
    }, { merge: true });
  },

  listenRide(ref, callback) {
    return onSnapshot(doc(db, 'rides', ref),
      snap => { if (snap.exists()) callback(snap.data()); },
      err  => _log.warn('[SokoniDB] ride:', err.message)
    );
  },

  /* ════════════════════════════════════════
     PACKAGES / DELIVERIES
  ════════════════════════════════════════ */

  async savePackage(pkg) {
    if (!pkg?.ref) throw new Error('Package reference missing');
    await setDoc(doc(db, 'packages', pkg.ref), {
      ...pkg, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return pkg.ref;
  },

  /* ════════════════════════════════════════
     DRIVER GPS  — real-time location
     Document keyed by sanitized driverId; the uid field is validated
     by Firestore rules so only the authenticated driver can write.
  ════════════════════════════════════════ */

  _gpsWatchId: null,

  async updateDriverLocation(driverId, lat, lng, extra = {}) {
    const uid = _uid();
    if (!uid) {
      _log.warn('[SokoniDB] Must be authenticated to update driver location');
      return;
    }
    const id = String(driverId || 'unknown_driver').replace(/\W/g, '_');
    await setDoc(doc(db, 'driverLocations', id), {
      lat, lng, driverId, uid, updatedAt: serverTimestamp(), ...extra
    }, { merge: true });
  },

  listenDriverLocation(driverId, callback) {
    const id = String(driverId || 'unknown_driver').replace(/\W/g, '_');
    return onSnapshot(doc(db, 'driverLocations', id),
      snap => { if (snap.exists()) callback(snap.data()); },
      err  => _log.warn('[SokoniDB] driverLocation:', err.message)
    );
  },

  startGPSTracking(driverId, onUpdate) {
    if (!navigator.geolocation) return;
    if (this._gpsWatchId !== null) navigator.geolocation.clearWatch(this._gpsWatchId);
    /* Throttle Firestore writes: max 1 write per 5 seconds per driver */
    let _lastGpsWrite = 0;
    const _watchCb = pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      if (onUpdate) onUpdate(lat, lng);
      const now = Date.now();
      if (now - _lastGpsWrite < 5000) return;
      _lastGpsWrite = now;
      this.updateDriverLocation(driverId, lat, lng, { accuracy })
        .catch(e => _log.warn('[SokoniDB] GPS write:', e.message));
    };
    try {
      /* Correct 3-arg signature — passing options as arg2 crashes Safari */
      this._gpsWatchId = navigator.geolocation.watchPosition(
        _watchCb,
        err => _log.warn('[SokoniDB] GPS error:', err.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
      );
    } catch (e) {
      _log.warn('[SokoniDB] watchPosition threw:', e.message);
      this._gpsWatchId = null;
    }
    return this._gpsWatchId;
  },

  stopGPSTracking() {
    if (this._gpsWatchId !== null) {
      navigator.geolocation.clearWatch(this._gpsWatchId);
      this._gpsWatchId = null;
    }
  },

  /* ════════════════════════════════════════
     ORDERS  (marketplace)
  ════════════════════════════════════════ */

  async saveOrder(order) {
    await setDoc(doc(db, 'orders', order.id), {
      ...order, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
  },

  async updateOrder(orderId, data) {
    await setDoc(doc(db, 'orders', orderId), {
      ...data, updatedAt: serverTimestamp()
    }, { merge: true });
  },

  listenOrder(orderId, callback) {
    return onSnapshot(doc(db, 'orders', orderId),
      snap => { if (snap.exists()) callback(snap.data()); },
      err  => _log.warn('[SokoniDB] order:', err.message)
    );
  },

  listenUserOrders(uid, callback) {
    const q = query(
      collection(db, 'orders'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] userOrders:', err.message)
    );
  },

  listenPOSOrders(callback) {
    const q = query(
      collection(db, 'orders'),
      where('type', '==', 'pos'),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] posOrders:', err.message)
    );
  },

  /* ════════════════════════════════════════
     REVIEWS  (platform / seller / product / provider)
  ════════════════════════════════════════ */

  async saveReview(review) {
    const id = review.id || ('REV-' + Date.now());
    await setDoc(doc(db, 'reviews', id), {
      ...review, id, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return id;
  },

  /* Approved reviews only — /reviews gates reads on status, so the previous
     unfiltered listener was denied for every caller and delivered nothing.
     A single equality filter needs no composite index; ordering is done on the
     client so none is required, and the limit stops an unbounded read of the
     whole collection as review volume grows. */
  listenReviews(callback) {
    const q = query(
      collection(db, 'reviews'),
      where('status', '==', 'approved'),
      limit(100)
    );
    return onSnapshot(q,
      snap => callback(
        snap.docs
          .map(d => ({ _fsId: d.id, ...d.data() }))
          .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      ),
      err  => _log.warn('[SokoniDB] reviews:', err.message)
    );
  },

  /* ════════════════════════════════════════
     UNBOXING REVIEWS  (community photo wall)
     Photos are base64 — too large for Firestore (1 MB doc limit).
     Firestore stores text metadata + emoji placeholder only.
  ════════════════════════════════════════ */

  async saveUnboxingReview(review) {
    const id = review.id || ('UBR-' + Date.now());
    const { photos, ...meta } = review;
    await setDoc(doc(db, 'unboxingReviews', id), {
      ...meta, id,
      photoEmoji: (photos || []).find(p => !p.startsWith('data:')) || meta.photoEmoji || '📦',
      uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return id;
  },

  listenUnboxingReviews(callback) {
    const q = query(collection(db, 'unboxingReviews'), orderBy('createdAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] unboxingReviews:', err.message)
    );
  },

  /* ════════════════════════════════════════
     FOLLOWS  (sellers + providers)
     Firestore: follows/{uid}--{type}--{entityId}
     Counter:   followerCounts/{type}--{entityId}  → { count }
  ════════════════════════════════════════ */

  _followDocId(type, entityId) {
    const uid = _uid() || 'guest';
    return `${uid}--${type}--${entityId.replace(/[^a-zA-Z0-9]/g,'_')}`;
  },

  async follow(type, entityId, entityName) {
    const fid    = this._followDocId(type, entityId);
    const uid    = _uid();
    const cntRef = doc(db, 'followerCounts', `${type}--${entityId}`);
    const fRef   = doc(db, 'follows', fid);
    await Promise.all([
      setDoc(fRef, { uid, type, entityId, entityName, createdAt: serverTimestamp() }, { merge: true }),
      setDoc(cntRef, { count: increment(1), type, entityId, entityName }, { merge: true }),
    ]);
    /* optimistic localStorage update */
    try {
      const key = type === 'seller' ? 'sokoniStoreFollowers' : 'sokoniProviderFollowers';
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      all[entityId] = (all[entityId] || 0) + 1;
      localStorage.setItem(key, JSON.stringify(all));
      const myKey = 'sokoniFollowing';
      const my = JSON.parse(localStorage.getItem(myKey) || '{}');
      my[`${type}--${entityId}`] = { type, entityId, entityName, followedAt: Date.now() };
      localStorage.setItem(myKey, JSON.stringify(my));
    } catch(e) {}
  },

  async unfollow(type, entityId) {
    const fid    = this._followDocId(type, entityId);
    const cntRef = doc(db, 'followerCounts', `${type}--${entityId}`);
    const fRef   = doc(db, 'follows', fid);
    await Promise.all([
      deleteDoc(fRef).catch(()=>{}),
      setDoc(cntRef, { count: increment(-1) }, { merge: true }),
    ]);
    try {
      const key = type === 'seller' ? 'sokoniStoreFollowers' : 'sokoniProviderFollowers';
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      all[entityId] = Math.max((all[entityId] || 1) - 1, 0);
      localStorage.setItem(key, JSON.stringify(all));
      const my = JSON.parse(localStorage.getItem('sokoniFollowing') || '{}');
      delete my[`${type}--${entityId}`];
      localStorage.setItem('sokoniFollowing', JSON.stringify(my));
    } catch(e) {}
  },

  async isFollowing(type, entityId) {
    const fid  = this._followDocId(type, entityId);
    const snap = await getDoc(doc(db, 'follows', fid)).catch(() => null);
    return snap ? snap.exists() : !!JSON.parse(localStorage.getItem('sokoniFollowing')||'{}')[`${type}--${entityId}`];
  },

  async getFollowerCount(type, entityId) {
    const snap = await getDoc(doc(db, 'followerCounts', `${type}--${entityId}`)).catch(() => null);
    if (snap && snap.exists()) return snap.data().count || 0;
    const key = type === 'seller' ? 'sokoniStoreFollowers' : 'sokoniProviderFollowers';
    return JSON.parse(localStorage.getItem(key) || '{}')[entityId] || 0;
  },

  listenFollowerCount(type, entityId, callback) {
    return onSnapshot(
      doc(db, 'followerCounts', `${type}--${entityId}`),
      snap => callback(snap.exists() ? (snap.data().count || 0) : 0),
      ()   => callback(0)
    );
  },

  getMyFollowing() {
    try { return JSON.parse(localStorage.getItem('sokoniFollowing') || '{}'); } catch(e) { return {}; }
  },

  /* ════════════════════════════════════════
     NOTIFICATIONS  (admin → user alerts)
     Firestore: notifications/{id}
     Fields: targetUid ('broadcast' or uid), type, icon, heading, sub, link, createdAt
  ════════════════════════════════════════ */

  listenNotifications(uid, callback) {
    if (!uid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'notifications'),
      where('targetUid', 'in', [uid, 'broadcast']),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] notifications:', err.message)
    );
  },

  async saveNotification(notif) {
    const id = notif.id || ('NTF-' + Date.now());
    await setDoc(doc(db, 'notifications', id), {
      ...notif, id, createdAt: serverTimestamp()
    }, { merge: true });
    return id;
  },

  async markNotificationRead(fsId) {
    await setDoc(doc(db, 'notifications', fsId), { read: true }, { merge: true });
  },

  /* ════════════════════════════════════════
     REFERRALS  (cross-device referral tracking)
  ════════════════════════════════════════ */

  async saveReferral(referral) {
    const id = referral.id || ('REF-' + Date.now());
    await setDoc(doc(db, 'referrals', id), {
      ...referral, id, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return id;
  },

  listenMyReferrals(callback) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'referrals'),
      where('referrerUid', '==', uid),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] referrals:', err.message)
    );
  },

  /* ════════════════════════════════════════
     PUBLIC PRODUCTS CATALOGUE
  ════════════════════════════════════════ */

  async saveProduct(product) {
    if (!product || !product.id) return;
    const uid = _uid();
    await setDoc(doc(db, 'products', String(product.id)), {
      ...product,
      sellerUid: uid || product.sellerUid || '',
      _syncedAt: serverTimestamp(),
    }, { merge: true });
    _invalidateProductSearchCache();
    return product.id;
  },

  async deleteProduct(productId) {
    await deleteDoc(doc(db, 'products', String(productId)));
    _invalidateProductSearchCache();
  },

  async loadProducts(opts = {}) {
    let q = collection(db, 'products');
    if (opts.category)  q = query(q, where('category', '==', opts.category));
    if (opts.sellerUid) q = query(q, where('sellerUid', '==', opts.sellerUid));
    if (opts.status)    q = query(q, where('status', '==', opts.status));
    q = query(q, limit(opts.limit || 100));
    /* Was `await getDocs ? getDocs(q) : null`, which parses as
       `(await getDocs) ? getDocs(q) : null` — it awaited the imported function
       (truthy), then called getDocs(q) WITHOUT awaiting, so snap was an
       unresolved Promise, snap.docs was undefined, and the read returned
       nothing. The storefront convergence caught it: a seller with 7 live
       products showed an empty store because this one-shot read silently
       failed. Await the query itself. */
    const snap = await getDocs(q);
    return snap.docs.map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; });
  },

  listenProducts(opts = {}, callback) {
    /* The catalogue is public (products is `allow read: if true`), yet
       anonymous first-load returned nothing and this handler swallowed the
       reason into a warning with only err.message. App Check is ENFORCED on
       firestore.googleapis.com (verified server-side), and its token is
       acquired asynchronously and fire-and-forget in firebase.js while `db` is
       created synchronously — so a listener attached at page load can fire
       before the attestation token exists.

       This now surfaces the Firestore error CODE, not just the message, and
       distinguishes the two failure modes the codes separate:
         permission-denied / unauthenticated  → App Check rejected the read
         unavailable / deadline-exceeded       → token not ready yet, transient

       ALL of these are retried once after a short delay, by which time the App
       Check token has normally arrived or refreshed. The earlier version
       retried only unavailable/deadline and treated permission-denied as final,
       but App Check 403s intermittently on this project and surfaces as
       permission-denied, so a single hiccup permanently broke the load — see the
       error handler below and fix 5d21705. One retry, then the error state.
       Neither weakens App Check. */
    const t0 = Date.now();
    const emit = (phase, detail) => {
      const payload = { phase, ...detail, appCheck: (typeof window !== 'undefined' && window.__sokoniAppCheckState) || 'unknown', ms: Date.now() - t0 };
      _log.warn('[SokoniDB] catalogue', payload);
      try { window.dispatchEvent(new CustomEvent('sokoni:catalogue', { detail: payload })); } catch (_) {}
    };

    const attach = (attempt) => {
      let q = collection(db, 'products');
      if (opts.category)  q = query(q, where('category', '==', opts.category));
      if (opts.sellerUid) q = query(q, where('sellerUid', '==', opts.sellerUid));

      /* BOUND the live subscription. Unbounded, this was `onSnapshot` over the
         ENTIRE products collection: the SDK retained every doc (many still
         carrying heavy base64 image blobs) in the mobile renderer's heap, the
         home merge re-serialized the whole array to localStorage on every
         snapshot, and as the catalogue grows the heap saturated on load —
         scrolling then forced layout/paint/decode and tipped the renderer into
         OOM (the reported "Chrome crashes when I scroll the homepage", same
         class as the Android Aw-Snap sentinel). Product ids are Date.now()
         timestamps, so `orderBy(documentId(),'desc')` returns the NEWEST N with
         the built-in __name__ index (no composite index needed) — active
         inventory, which is also where client-side boosts (sokoniAds) live, so
         boosted cards still float. Filtered paths already narrow the set, so a
         plain bounded limit keeps them index-safe (no orderBy → no composite
         index). Override with opts.limit where a caller needs a different cap. */
      const cap = Number(opts.limit) > 0 ? Number(opts.limit) : 200;
      if (opts.category || opts.sellerUid) {
        q = query(q, limit(cap));
      } else {
        q = query(q, orderBy(documentId(), 'desc'), limit(cap));
      }

      emit('listener-attached', { attempt });
      return onSnapshot(q,
        snap => {
          /* SUCCESS path — the case the earlier instrumentation could not see.
             A zero-doc snapshot from cache is the shape that was leaving demo
             data in place with no error. Report source and count so an empty
             authoritative read is distinguishable from a cached empty one. */
          emit('snapshot', {
            attempt,
            docs: snap.size,
            fromCache: snap.metadata.fromCache,
            pendingWrites: snap.metadata.hasPendingWrites,
          });
          /* An empty snapshot from cache with the App Check token not yet
             exchanged is a not-ready read, not an authoritative empty catalogue
             — retry once rather than accept it as the real state. */
          if (snap.size === 0 && snap.metadata.fromCache && attempt < 2) {
            emit('retry-empty-cache', { attempt });
            setTimeout(() => attach(attempt + 1), 1500);
            return;
          }
          callback(snap.docs.map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; }));
        },
        err  => {
          const code = err && err.code || 'unknown';
          _log.warn('[SokoniDB] products listener failed', { code, message: err && err.message, attempt });
          try {
            window.dispatchEvent(new CustomEvent('sokoni:catalogue-error', {
              detail: { code, message: err && err.message, transient: /unavailable|deadline/.test(code), attempt }
            }));
          } catch (_) {}

          /* permission-denied / unauthenticated are included here deliberately.
             The original code excluded them, reasoning that a denied read is
             genuine and retrying only "hammers a wall". That is true for a real
             rules rejection, but App Check is ENFORCED on Firestore on this
             project and 403s INTERMITTENTLY — an identical session can succeed,
             then be denied, then succeed again — and a denied App Check read
             surfaces as permission-denied. The App Check token auto-refreshes, so
             a read that 403s now usually succeeds ~1.5s later. This is the same
             finding that fix 5d21705 acted on for providers.html/services.html;
             the home + category catalogue listener never got the same resilience,
             so an App Check hiccup during a normal browse left the grid stuck —
             "the loading sometimes breaks". One transparent retry converts most
             of those intermittent denials into a normal load.

             Bounded to a single retry (attempt < 2): if it still fails on the
             second attempt, the token has normally arrived, so a persistent
             failure is a genuine rejection and is left to the error state rather
             than retried into a loop. App Check is not weakened — the client just
             stops treating a transient 403 as permanent. */
          const transient = /unavailable|deadline-exceeded|internal|permission-denied|unauthenticated/.test(code);
          if (transient && attempt < 2) {
            _log.warn('[SokoniDB] retrying products listener (App Check token likely not ready)', { code, attempt });
            setTimeout(() => attach(attempt + 1), 1500);
          }
        }
      );
    };
    return attach(1);
  },

  /* True catalogue size without loading the catalogue. Since the home listener
     is now bounded to the newest 200, `products.length` no longer reflects the
     real total; this server-side count aggregate (one lightweight RPC, no docs
     read) gives the honest number for the "N+ products" labels. Fail-safe:
     returns null so the caller falls back to the in-memory length. */
  async countProducts() {
    try {
      const snap = await getCountFromServer(collection(db, 'products'));
      return snap.data().count;
    } catch (e) {
      _log.warn('[SokoniDB] countProducts failed', e && e.message);
      return null;
    }
  },

  async updateProductStock(productId, delta) {
    await setDoc(doc(db, 'products', String(productId)), {
      stock: increment(delta),
      sold:  increment(-delta > 0 ? -delta : 0),
    }, { merge: true });
  },

  /* ══ SELLER BROADCASTS ══════════════════════════════════════
     sellerBroadcasts/{sellerUid}/broadcasts/{docId}
  ══════════════════════════════════════════════════════════ */
  async saveSellerBroadcast(sellerName, payload) {
    /* Key by seller name — matches the key buyers use in sokoniFollowing */
    const safeKey  = (sellerName || 'unknown').trim();
    const docId    = 'broadcast_' + Date.now();
    const uid      = auth.currentUser?.uid || null;
    /* sellerUid required by Firestore rule to verify broadcast ownership */
    await setDoc(
      doc(db, 'sellerBroadcasts', safeKey, 'broadcasts', docId),
      { ...payload, sellerName: safeKey, sellerUid: uid, createdAt: serverTimestamp() }
    );
  },

  listenSellerBroadcasts(sellerNames, callback) {
    if (!sellerNames || !sellerNames.length) return () => {};
    /* Listen to each followed seller's broadcasts subcollection */
    const unsubs = sellerNames.map(name =>
      onSnapshot(
        collection(db, 'sellerBroadcasts', name, 'broadcasts'),
        snap => snap.docChanges().forEach(change => {
          if (change.type === 'added') callback({ ...change.doc.data(), _sellerName: name, _id: change.doc.id });
        }),
        () => {}
      )
    );
    return () => unsubs.forEach(u => u());
  },

  /* ════════════════════════════════════════
     CURRENT USER UID  (public helper)
  ════════════════════════════════════════ */
  currentUid() { return _uid(); },

  /* ════════════════════════════════════════
     RIDE DRIVERS  — online/offline status + GPS
     Collection: rideDrivers/{sanitised-driverId}
  ════════════════════════════════════════ */

  async setDriverOnline(driverId, isOnline, vehicleType, lat, lng, extra) {
    const id = String(driverId || _uid() || 'unknown').replace(/\W/g, '_');
    await setDoc(doc(db, 'rideDrivers', id), {
      driverId: id,
      uid: _uid() || id,
      isOnline: !!isOnline,
      vehicleType: vehicleType || 'moto',
      lat: (lat != null ? lat : null),
      lng: (lng != null ? lng : null),
      updatedAt: serverTimestamp(),
      ...(extra || {}),
    }, { merge: true });
  },

  async getOnlineDrivers(vehicleType) {
    const q = vehicleType
      ? query(collection(db, 'rideDrivers'), where('isOnline', '==', true), where('vehicleType', '==', vehicleType))
      : query(collection(db, 'rideDrivers'), where('isOnline', '==', true));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ _fsId: d.id, ...d.data() }));
  },

  listenOnlineDrivers(vehicleType, callback) {
    const q = vehicleType
      ? query(collection(db, 'rideDrivers'), where('isOnline', '==', true), where('vehicleType', '==', vehicleType))
      : query(collection(db, 'rideDrivers'), where('isOnline', '==', true));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] onlineDrivers:', err.message)
    );
  },

  /* ════════════════════════════════════════
     RIDE REQUESTS
     Collection: rideRequests/{ref}
     Status flow:
       searching → driver_assigned → driver_accepted →
       driver_arrived → in_progress → completed | cancelled
  ════════════════════════════════════════ */

  async saveRideRequest(req) {
    if (!req?.ref) throw new Error('Ride request ref missing');
    await setDoc(doc(db, 'rideRequests', req.ref), {
      ...req, uid: _uid(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }, { merge: true });
    return req.ref;
  },

  async updateRideRequest(ref, data) {
    await setDoc(doc(db, 'rideRequests', ref), {
      ...data, updatedAt: serverTimestamp(),
    }, { merge: true });
  },

  listenRideRequest(ref, callback) {
    return onSnapshot(doc(db, 'rideRequests', ref),
      snap => { if (snap.exists()) callback({ _fsId: snap.id, ...snap.data() }); },
      err  => _log.warn('[SokoniDB] rideRequest:', err.message)
    );
  },

  listenDriverActiveRequests(driverId, callback) {
    const id = String(driverId || '').replace(/\W/g, '_');
    const q = query(
      collection(db, 'rideRequests'),
      where('assignedDriverId', '==', id),
      where('status', 'in', ['driver_assigned', 'driver_accepted', 'driver_arrived', 'in_progress']),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] driverActiveRequests:', err.message)
    );
  },

  listenUserRideHistory(uid, callback) {
    const q = query(
      collection(db, 'rideRequests'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] userRideHistory:', err.message)
    );
  },

  /* ════════════════════════════════════════
     PACKAGE REQUESTS
     Collection: packageRequests/{ref}
     Status flow:
       pending → driver_assigned → picked_up → in_transit → delivered | cancelled
  ════════════════════════════════════════ */

  async savePackageRequest(pkg) {
    if (!pkg?.ref) throw new Error('Package ref missing');
    await setDoc(doc(db, 'packageRequests', pkg.ref), {
      ...pkg, uid: _uid(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }, { merge: true });
    return pkg.ref;
  },

  async updatePackageRequest(ref, data) {
    await setDoc(doc(db, 'packageRequests', ref), {
      ...data, updatedAt: serverTimestamp(),
    }, { merge: true });
  },

  listenPackageRequest(ref, callback) {
    return onSnapshot(doc(db, 'packageRequests', ref),
      snap => { if (snap.exists()) callback({ _fsId: snap.id, ...snap.data() }); },
      err  => _log.warn('[SokoniDB] packageRequest:', err.message)
    );
  },

  listenUserPackageHistory(uid, callback) {
    const q = query(
      collection(db, 'packageRequests'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] userPackageHistory:', err.message)
    );
  },

  /* Active delivery assignments for a specific driver.
     Status set: driver_assigned, driver_accepted, driver_at_seller, in_transit */
  listenDriverDeliveryRequests(driverId, callback) {
    const id = String(driverId || '').replace(/\W/g, '_');
    const q  = query(
      collection(db, 'packageRequests'),
      where('assignedDriverId', '==', id),
      where('status', 'in', ['driver_assigned','driver_accepted','driver_at_seller','in_transit']),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] driverDeliveryRequests:', err.message)
    );
  },

  /* ════════════════════════════════════════
     DRIVER RATINGS
     Collection: driverRatings/{rideOrDeliveryRef}
  ════════════════════════════════════════ */

  async saveDriverRating(ref, driverId, rating, comment, ratingType) {
    const safeId = String(driverId || 'unknown').replace(/\W/g, '_');
    await setDoc(doc(db, 'driverRatings', ref), {
      ref,
      driverId:   safeId,
      rating:     Number(rating) || 5,
      comment:    comment || '',
      type:       ratingType || 'ride',   /* 'ride' | 'delivery' */
      uid:        _uid(),
      createdAt:  serverTimestamp(),
    }, { merge: true });

    /* Increment running average in rideDrivers */
    try {
      await setDoc(doc(db, 'rideDrivers', safeId), {
        _ratingSum:   increment(Number(rating) || 5),
        _ratingCount: increment(1),
      }, { merge: true });
    } catch(e){}
  },

  listenDriverRatings(driverId, callback) {
    const id = String(driverId || '').replace(/\W/g, '_');
    const q  = query(
      collection(db, 'driverRatings'),
      where('driverId', '==', id),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] driverRatings:', err.message)
    );
  },

  /* ════════════════════════════════════════
     ORDER EVENTS  (immutable audit trail)
     Subcollection: orderEvents/{orderId}/events/{autoId}
  ════════════════════════════════════════ */

  async saveOrderEvent(orderId, event) {
    await addDoc(collection(db, 'orderEvents', orderId, 'events'), {
      ...event,
      actorUid: event.actorUid || _uid() || 'system',
      createdAt: serverTimestamp(),
    });
  },

  listenOrderEvents(orderId, callback) {
    const q = query(
      collection(db, 'orderEvents', orderId, 'events'),
      orderBy('createdAt', 'asc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] orderEvents:', err.message)
    );
  },

  /* ════════════════════════════════════════
     SELLER ORDERS  (incoming + active)
  ════════════════════════════════════════ */

  listenSellerOrders(sellerUid, callback, statusFilter) {
    let q;
    if (statusFilter) {
      q = query(
        collection(db, 'orders'),
        where('sellerUid', '==', sellerUid),
        where('status', '==', statusFilter),
        orderBy('createdAt', 'desc')
      );
    } else {
      q = query(
        collection(db, 'orders'),
        where('sellerUid', '==', sellerUid),
        orderBy('createdAt', 'desc')
      );
    }
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] sellerOrders:', err.message)
    );
  },

  /* ════════════════════════════════════════
     ADMIN — ALL ORDERS + DELIVERIES
  ════════════════════════════════════════ */

  /* ── Users, for the admin console ──────────────────────────────────────────
     Deliberately NOT ordered server-side. Firestore omits any document that
     lacks the ordering field, and measured against production on 2026-08-01:

         orderBy('createdAt') -> 59 of 61 documents
         orderBy('updatedAt') -> 13 of 61
         orderBy('joined')    ->  0 of 61   (the field does not exist)

     Two real people would simply not appear in the admin Users list, with no
     error to explain it — the same failure that made the Applications panel look
     empty. The collection is small enough to sort in the caller, so it does.

     If this ever needs server-side ordering for pagination, backfill createdAt
     FIRST and verify the count matches, rather than accepting a query that
     silently hides accounts. */
  listenUsers(callback, onError, limitN = 500) {
    const _q = query(collection(db, 'users'), limit(limitN));
    return onSnapshot(_q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, uid: d.id, ...d.data() }))),
      err  => {
        _log.warn('[SokoniDB] users:', err.message);
        if (typeof onError === 'function') { try { onError(err); } catch (e) {} }
      }
    );
  },

  /* ── BnB listings & bookings, for the admin console ────────────────────────
     Same shape as listenUsers, and unordered for the same reason: Firestore
     omits documents that lack the ordering field, so a listing written without
     createdAt would be invisible with nothing to explain it.

     For users that risk was measured (59 of 61 carried createdAt). Here it
     CANNOT be measured — both collections are empty in production as of
     2026-08-01 — and an unmeasurable risk is not an acceptable one to take on a
     query that hides rows silently. Sorting happens in the caller.

     Before adding a server-side orderBy later: verify createdAt coverage against
     real data first, and backfill if it is not 100%. bnb-hub.html and
     bnb-manage.html both write serverTimestamp() today, so new documents should
     be safe — but "should be" is not the standard for a query that drops rows. */
  listenBnbListings(callback, onError, limitN = 500) {
    return onSnapshot(query(collection(db, 'bnbListings'), limit(limitN)),
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, id: d.id, ...d.data() }))),
      err => {
        _log.warn('[SokoniDB] bnbListings:', err.message);
        if (typeof onError === 'function') { try { onError(err); } catch (e) {} }
      }
    );
  },

  listenBnbBookings(callback, onError, limitN = 500) {
    return onSnapshot(query(collection(db, 'bnbBookings'), limit(limitN)),
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err => {
        _log.warn('[SokoniDB] bnbBookings:', err.message);
        if (typeof onError === 'function') { try { onError(err); } catch (e) {} }
      }
    );
  },

  listenAllOrders(callback, statusFilter, limitN) {
    let _q;
    if (statusFilter && limitN) {
      _q = query(collection(db, 'orders'), where('status', '==', statusFilter), orderBy('createdAt', 'desc'), limit(limitN));
    } else if (statusFilter) {
      _q = query(collection(db, 'orders'), where('status', '==', statusFilter), orderBy('createdAt', 'desc'));
    } else if (limitN) {
      _q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(limitN));
    } else {
      _q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
    }
    return onSnapshot(_q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] allOrders:', err.message)
    );
  },

  listenAllDeliveries(callback, statusFilter) {
    let _q;
    if (statusFilter) {
      _q = query(collection(db, 'packageRequests'), where('status', '==', statusFilter), orderBy('createdAt', 'desc'));
    } else {
      _q = query(collection(db, 'packageRequests'), orderBy('createdAt', 'desc'));
    }
    return onSnapshot(_q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] allDeliveries:', err.message)
    );
  },

  /* ════════════════════════════════════════
     DISPUTES
  ════════════════════════════════════════ */

  async saveDispute(dispute) {
    const id = dispute.id || ('DSP-' + Date.now().toString(36).toUpperCase());
    await setDoc(doc(db, 'disputes', id), {
      ...dispute, id, uid: _uid(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateDispute(id, data) {
    await updateDoc(doc(db, 'disputes', id), { ...data, updatedAt: serverTimestamp() });
  },

  listenDisputes(callback, statusFilter) {
    let _q;
    if (statusFilter) {
      _q = query(collection(db, 'disputes'), where('status', '==', statusFilter), orderBy('createdAt', 'desc'));
    } else {
      _q = query(collection(db, 'disputes'), orderBy('createdAt', 'desc'));
    }
    return onSnapshot(_q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] disputes:', err.message)
    );
  },

  /* ════════════════════════════════════════
     ESCROW RECORDS  (escrow/{orderId})
  ════════════════════════════════════════ */

  async saveEscrow(orderId, data) {
    await setDoc(doc(db, 'escrow', orderId), {
      orderId,
      ...data,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  },

  async releaseEscrow(orderId, adminUid, amount) {
    await setDoc(doc(db, 'escrow', orderId), {
      status:     'released',
      releasedBy: adminUid || _uid(),
      releasedAt: serverTimestamp(),
      amount:     amount || 0,
      updatedAt:  serverTimestamp(),
    }, { merge: true });
  },

  listenEscrow(orderId, callback) {
    return onSnapshot(doc(db, 'escrow', orderId),
      snap => callback(snap.exists() ? { _fsId: snap.id, ...snap.data() } : null),
      err  => _log.warn('[SokoniDB] escrow:', err.message)
    );
  },

  /* ════════════════════════════════════════
     DRIVER EARNINGS  (from completed orders)
  ════════════════════════════════════════ */

  listenDriverEarnings(driverUid, callback) {
    if (!driverUid) { callback({ today: 0, week: 0, month: 0, total: 0, trips: 0 }); return () => {}; }
    const q = query(
      collection(db, 'orders'),
      where('assignedDriverUid', '==', driverUid),
      where('status', 'in', ['delivered', 'completed']),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q, snap => {
      const orders  = snap.docs.map(d => d.data());
      const today   = new Date(); today.setHours(0, 0, 0, 0);
      const week    = new Date(today); week.setDate(week.getDate() - 7);
      const month   = new Date(today); month.setDate(1);
      let tE = 0, wE = 0, mE = 0, total = 0;
      orders.forEach(o => {
        const ts  = o.createdAt ? new Date(o.createdAt) : new Date();
        const net = Number(o.driverNet || 0);
        total += net;
        if (ts >= today) tE += net;
        if (ts >= week)  wE += net;
        if (ts >= month) mE += net;
      });
      callback({ today: tE, week: wE, month: mE, total, trips: orders.length, orders });
    }, err => _log.warn('[SokoniDB] driverEarnings:', err.message));
  },

  /* ════════════════════════════════════════
     RIDER ACTIVE ORDERS  (new state machine statuses)
  ════════════════════════════════════════ */

  listenRiderActiveOrders(driverUid, callback) {
    if (!driverUid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'orders'),
      where('assignedDriverUid', '==', driverUid),
      where('status', 'in', ['rider_assigned', 'rider_en_route', 'picked_up', 'in_transit']),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] riderActiveOrders:', err.message)
    );
  },

  /* Unassigned orders waiting for a rider */
  listenPendingRiderOrders(callback) {
    const q = query(
      collection(db, 'orders'),
      where('status', '==', 'confirmed'),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] pendingRiderOrders:', err.message)
    );
  },

  /* ── queryUsers({ phone }) ──
     Look up registered users by phone number.
     Used by POS to find a customer's UID for push receipt delivery. */
  async queryUsers({ phone } = {}) {
    if (!phone) return [];
    const clean = phone.replace(/\D/g, '');
    /* Try both 07XX and 254XX formats */
    const variants = [clean, '0' + clean.slice(-9), '254' + clean.slice(-9)];
    const results = [];
    for (const v of variants) {
      try {
        const q = query(collection(db, 'users'), where('phone', '==', v), limit(1));
        const snap = await getDocs(q);
        snap.forEach(d => { if (!results.find(r => r.uid === d.id)) results.push({ uid: d.id, ...d.data() }); });
      } catch (e) { /* ignore per-variant errors */ }
    }
    return results;
  },
};

if (typeof window !== 'undefined') {
  window.SokoniDB = SokoniDB;
  window.dispatchEvent(new CustomEvent('sokoniDbReady'));
}

export default SokoniDB;

