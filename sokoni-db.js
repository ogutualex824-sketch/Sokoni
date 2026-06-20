/* ================================================================
   SOKONI â€” Firestore Data Layer  (sokoni-db.js)
   Shared real-time helpers for applications, providers,
   bookings, rides, GPS tracking and orders.
   Import as a module â€” exposes window.SokoniDB for inline scripts.
================================================================ */
import { db, auth } from './firebase.js';
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy, serverTimestamp, increment, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const _log = window.SokoniLogger || { log:()=>{}, warn:()=>{}, error:()=>{} };

/* Helper â€” returns the current authenticated user's UID.
   Prefers auth.currentUser (JWT-verified). Falls back to localStorage
   ONLY as a same-tick fallback before Firebase Auth initialises. */
function _uid() {
  if (auth.currentUser?.uid) return auth.currentUser.uid;
  /* Minimal localStorage fallback â€” only used for non-privileged metadata */
  try {
    return JSON.parse(localStorage.getItem('sokoniUser') || 'null')?.uid ?? null;
  } catch { return null; }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   WRITE THROTTLE â€” prevents flooding Firestore with duplicate writes
   keyed by (collection, docId or operation name).
   Minimum gap between identical writes: 2 seconds.
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   IDEMPOTENCY KEY STORE  â€” prevents duplicate order/review creation
   on network retry or double-click.
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
const _idemKeys = new Set();
function _idemGuard(key) {
  if (_idemKeys.has(key)) return false;
  _idemKeys.add(key);
  setTimeout(() => _idemKeys.delete(key), 10000); /* expire after 10 sec */
  return true;
}

const SokoniDB = {

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     APPLICATIONS  (providers, drivers, sellers)
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  async saveApplication(app) {
    const id = app.id || ('APP-' + Date.now());
    await setDoc(doc(db, 'applications', id), {
      ...app, id, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return id;
  },

  listenApplications(callback, limitN = 100) {
    const q = query(collection(db, 'applications'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] applications:', err.message)
    );
  },

  async updateApplicationStatus(fsId, status, meta = {}) {
    await updateDoc(doc(db, 'applications', fsId), {
      status, ...meta, updatedAt: serverTimestamp()
    });
  },

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     PROVIDERS
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  async saveProvider(profile) {
    const id = (profile.phone || profile.id || Date.now())
      .toString().replace(/\D/g, '');
    await setDoc(doc(db, 'providers', id), {
      ...profile, _localId: profile.id || id, uid: _uid(), updatedAt: serverTimestamp()
    }, { merge: true });
    return id;
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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     BOOKINGS
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  async saveBooking(booking) {
    const normalizedPhone = booking.clientPhone
      ? String(booking.clientPhone).replace(/\D/g, '')
      : null;
    const ref = await addDoc(collection(db, 'bookings'), {
      ...booking,
      clientPhone: normalizedPhone,
      uid: _uid(),
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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     PROVIDERS â€” listen for all registered providers
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  listenProviders(callback, limitN = 50) {
    const q = query(collection(db, 'providers'), orderBy('updatedAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] providers:', err.message)
    );
  },

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     RIDES
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     PACKAGES / DELIVERIES
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  async savePackage(pkg) {
    if (!pkg?.ref) throw new Error('Package reference missing');
    await setDoc(doc(db, 'packages', pkg.ref), {
      ...pkg, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return pkg.ref;
  },

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     DRIVER GPS  â€” real-time location
     Document keyed by sanitized driverId; the uid field is validated
     by Firestore rules so only the authenticated driver can write.
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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
    this._gpsWatchId = navigator.geolocation.watchPosition(
      pos => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        this.updateDriverLocation(driverId, lat, lng, { accuracy })
          .catch(e => _log.warn('[SokoniDB] GPS write:', e.message));
        if (onUpdate) onUpdate(lat, lng);
      },
      err => _log.warn('[SokoniDB] GPS error:', err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
    return this._gpsWatchId;
  },

  stopGPSTracking() {
    if (this._gpsWatchId !== null) {
      navigator.geolocation.clearWatch(this._gpsWatchId);
      this._gpsWatchId = null;
    }
  },

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     ORDERS  (marketplace)
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     REVIEWS  (platform / seller / product / provider)
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  async saveReview(review) {
    const id = review.id || ('REV-' + Date.now());
    await setDoc(doc(db, 'reviews', id), {
      ...review, id, uid: _uid(), createdAt: serverTimestamp()
    }, { merge: true });
    return id;
  },

  listenReviews(callback) {
    const q = query(collection(db, 'reviews'), orderBy('createdAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => _log.warn('[SokoniDB] reviews:', err.message)
    );
  },

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UNBOXING REVIEWS  (community photo wall)
     Photos are base64 â€” too large for Firestore (1 MB doc limit).
     Firestore stores text metadata + emoji placeholder only.
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  async saveUnboxingReview(review) {
    const id = review.id || ('UBR-' + Date.now());
    const { photos, ...meta } = review;
    await setDoc(doc(db, 'unboxingReviews', id), {
      ...meta, id,
      photoEmoji: (photos || []).find(p => !p.startsWith('data:')) || meta.photoEmoji || 'ðŸ“¦',
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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     FOLLOWS  (sellers + providers)
     Firestore: follows/{uid}--{type}--{entityId}
     Counter:   followerCounts/{type}--{entityId}  â†’ { count }
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     NOTIFICATIONS  (admin â†’ user alerts)
     Firestore: notifications/{id}
     Fields: targetUid ('broadcast' or uid), type, icon, heading, sub, link, createdAt
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     REFERRALS  (cross-device referral tracking)
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     PUBLIC PRODUCTS CATALOGUE
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  async saveProduct(product) {
    if (!product || !product.id) return;
    const uid = _uid();
    await setDoc(doc(db, 'products', String(product.id)), {
      ...product,
      sellerUid: uid || product.sellerUid || '',
      _syncedAt: serverTimestamp(),
    }, { merge: true });
    return product.id;
  },

  async deleteProduct(productId) {
    await deleteDoc(doc(db, 'products', String(productId)));
  },

  async loadProducts(opts = {}) {
    let q = collection(db, 'products');
    if (opts.category) q = query(q, where('category', '==', opts.category));
    if (opts.sellerUid) q = query(q, where('sellerUid', '==', opts.sellerUid));
    const snap = await getDocs ? getDocs(q) : null;
    if (!snap) return [];
    return snap.docs.map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; });
  },

  listenProducts(opts = {}, callback) {
    let q = collection(db, 'products');
    if (opts.category)  q = query(q, where('category', '==', opts.category));
    if (opts.sellerUid) q = query(q, where('sellerUid', '==', opts.sellerUid));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => { const v = { ...d.data() }; delete v._syncedAt; return v; })),
      err  => _log.warn('[SokoniDB] products:', err.message)
    );
  },

  async updateProductStock(productId, delta) {
    await setDoc(doc(db, 'products', String(productId)), {
      stock: increment(delta),
      sold:  increment(-delta > 0 ? -delta : 0),
    }, { merge: true });
  },

  /* â•â• SELLER BROADCASTS â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     sellerBroadcasts/{sellerUid}/broadcasts/{docId}
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  async saveSellerBroadcast(sellerName, payload) {
    /* Key by seller name â€” matches the key buyers use in sokoniFollowing */
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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     CURRENT USER UID  (public helper)
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  currentUid() { return _uid(); },

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     RIDE DRIVERS  â€” online/offline status + GPS
     Collection: rideDrivers/{sanitised-driverId}
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     RIDE REQUESTS
     Collection: rideRequests/{ref}
     Status flow:
       searching â†’ driver_assigned â†’ driver_accepted â†’
       driver_arrived â†’ in_progress â†’ completed | cancelled
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     PACKAGE REQUESTS
     Collection: packageRequests/{ref}
     Status flow:
       pending â†’ driver_assigned â†’ picked_up â†’ in_transit â†’ delivered | cancelled
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     DRIVER RATINGS
     Collection: driverRatings/{rideOrDeliveryRef}
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     ORDER EVENTS  (immutable audit trail)
     Subcollection: orderEvents/{orderId}/events/{autoId}
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     SELLER ORDERS  (incoming + active)
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     ADMIN â€” ALL ORDERS + DELIVERIES
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     DISPUTES
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     ESCROW RECORDS  (escrow/{orderId})
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     DRIVER EARNINGS  (from completed orders)
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     RIDER ACTIVE ORDERS  (new state machine statuses)
  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â”€â”€ queryUsers({ phone }) â”€â”€
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

