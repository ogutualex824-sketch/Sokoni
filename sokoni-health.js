/* ================================================================
   SOKONI — Healthcare Data Module  (sokoni-health.js)

   Firestore collections:
     healthProviders/{id}      — provider directory (doctors, clinics, hospitals …)
     healthAppointments/{id}   — appointment bookings
     healthLabBookings/{id}    — lab test bookings
     healthMedOrders/{id}      — pharmacy / medicine orders
     healthTelemedicine/{id}   — virtual consultation sessions
     healthHomeServices/{id}   — home nursing / caregiver / physio requests
     healthEmergency/{id}      — emergency requests (ambulance, SOS)
     healthReviews/{id}        — provider ratings & reviews
     healthProviderAvailability/{providerId} — real-time slot management

   Exposes: window.SokoniHealth  +  ES default export
================================================================ */
import { db, auth } from './firebase.js';
import {
  collection, doc, addDoc, setDoc, updateDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy, serverTimestamp, increment,
  limit, deleteDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── UID helper ── */
function _uid() {
  if (auth.currentUser?.uid) return auth.currentUser.uid;
  try {
    return JSON.parse(localStorage.getItem('sokoniUser') || 'null')?.uid ?? null;
  } catch { return null; }
}

/* ── Sanitize phone ── */
function _phone(p) { return String(p || '').replace(/\D/g, ''); }

/* ── Generate IDs ── */
function _id(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC API
───────────────────────────────────────────────────────────── */
const SokoniHealth = {

  /* ════════════════════════════════════════
     HEALTH PROVIDERS
     Public listing — patients discover without login.
     Create: claimsOwner.  Update: owner (no approval fields).
  ════════════════════════════════════════ */

  async saveProvider(provider) {
    const id = provider.id || _id('HCP-');
    await setDoc(doc(db, 'healthProviders', id), {
      ...provider,
      id,
      uid: _uid(),
      status:    provider.status    || 'pending',
      verified:  provider.verified  || false,
      rating:    provider.rating    || 0,
      reviewCount: provider.reviewCount || 0,
      createdAt: provider.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async getProvider(id) {
    const snap = await getDoc(doc(db, 'healthProviders', id));
    return snap.exists() ? { _fsId: snap.id, ...snap.data() } : null;
  },

  async updateProvider(id, data) {
    await updateDoc(doc(db, 'healthProviders', id), {
      ...data, updatedAt: serverTimestamp(),
    });
  },

  async updateProviderStatus(id, status) {
    await setDoc(doc(db, 'healthProviders', id), {
      status, updatedAt: serverTimestamp(),
    }, { merge: true });
  },

  async verifyProvider(id, verified = true) {
    await setDoc(doc(db, 'healthProviders', id), {
      verified,
      status: verified ? 'active' : 'pending',
      verifiedAt: serverTimestamp(),
      updatedAt:  serverTimestamp(),
    }, { merge: true });
  },

  listenProviders(callback, filters = {}, limitN = 100) {
    const q = query(collection(db, 'healthProviders'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => {
        let providers = snap.docs.map(d => ({ _fsId: d.id, ...d.data() }));
        if (filters.type)     providers = providers.filter(p => p.type === filters.type);
        if (filters.verified) providers = providers.filter(p => p.verified === true);
        callback(providers);
      },
      err => console.warn('[SokoniHealth] providers:', err.message)
    );
  },

  listenMyProviderProfile(callback) {
    const uid = _uid();
    if (!uid) { callback(null); return () => {}; }
    const q = query(collection(db, 'healthProviders'), where('uid', '==', uid), limit(1));
    return onSnapshot(q,
      snap => callback(snap.docs.length
        ? { _fsId: snap.docs[0].id, ...snap.docs[0].data() }
        : null
      ),
      err => console.warn('[SokoniHealth] myProvider:', err.message)
    );
  },

  async getAllProviders(limitN = 200) {
    const q = query(collection(db, 'healthProviders'), orderBy('createdAt', 'desc'), limit(limitN));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ _fsId: d.id, ...d.data() }));
  },

  /* ════════════════════════════════════════
     PROVIDER AVAILABILITY
     keyed by providerId; real-time slot management
  ════════════════════════════════════════ */

  async setAvailability(providerId, slots) {
    await setDoc(doc(db, 'healthProviderAvailability', providerId), {
      providerId,
      slots,
      uid: _uid(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  },

  async getAvailability(providerId) {
    const snap = await getDoc(doc(db, 'healthProviderAvailability', providerId));
    return snap.exists() ? snap.data().slots || [] : [];
  },

  listenAvailability(providerId, callback) {
    return onSnapshot(doc(db, 'healthProviderAvailability', providerId),
      snap => callback(snap.exists() ? snap.data().slots || [] : []),
      err  => console.warn('[SokoniHealth] availability:', err.message)
    );
  },

  /* ════════════════════════════════════════
     HEALTH APPOINTMENTS
  ════════════════════════════════════════ */

  async saveAppointment(appt) {
    const id = appt.id || _id('APPT-');
    await setDoc(doc(db, 'healthAppointments', id), {
      ...appt,
      id,
      uid:       _uid(),
      phone:     _phone(appt.phone),
      status:    appt.status || 'confirmed',
      createdAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateAppointment(id, data) {
    await updateDoc(doc(db, 'healthAppointments', id), {
      ...data, updatedAt: serverTimestamp(),
    });
  },

  async cancelAppointment(id, reason = '') {
    await updateDoc(doc(db, 'healthAppointments', id), {
      status: 'cancelled', cancelReason: reason, cancelledAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  },

  listenUserAppointments(callback, limitN = 50) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'healthAppointments'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.uid === uid)),
      err  => console.warn('[SokoniHealth] userAppts:', err.message)
    );
  },

  listenProviderAppointments(providerId, callback, limitN = 200) {
    const q = query(collection(db, 'healthAppointments'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.providerId === providerId)),
      err  => console.warn('[SokoniHealth] providerAppts:', err.message)
    );
  },

  /* ════════════════════════════════════════
     LAB BOOKINGS
  ════════════════════════════════════════ */

  async saveLabBooking(booking) {
    const id = booking.id || _id('LAB-');
    await setDoc(doc(db, 'healthLabBookings', id), {
      ...booking,
      id,
      uid:       _uid(),
      phone:     _phone(booking.phone),
      status:    booking.status || 'booked',
      createdAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateLabBooking(id, data) {
    await updateDoc(doc(db, 'healthLabBookings', id), {
      ...data, updatedAt: serverTimestamp(),
    });
  },

  listenUserLabBookings(callback, limitN = 50) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'healthLabBookings'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.uid === uid)),
      err  => console.warn('[SokoniHealth] labBookings:', err.message)
    );
  },

  listenProviderLabBookings(providerId, callback, limitN = 200) {
    const q = query(collection(db, 'healthLabBookings'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.providerId === providerId)),
      err  => console.warn('[SokoniHealth] provLabBookings:', err.message)
    );
  },

  /* ════════════════════════════════════════
     MEDICINE / PHARMACY ORDERS
  ════════════════════════════════════════ */

  async saveMedOrder(order) {
    const id = order.id || _id('MED-');
    await setDoc(doc(db, 'healthMedOrders', id), {
      ...order,
      id,
      uid:       _uid(),
      phone:     _phone(order.phone),
      status:    order.status || 'placed',
      createdAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateMedOrder(id, data) {
    await updateDoc(doc(db, 'healthMedOrders', id), {
      ...data, updatedAt: serverTimestamp(),
    });
  },

  listenUserMedOrders(callback, limitN = 50) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'healthMedOrders'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.uid === uid)),
      err  => console.warn('[SokoniHealth] medOrders:', err.message)
    );
  },

  listenPharmacyOrders(pharmacyId, callback, limitN = 200) {
    const q = query(collection(db, 'healthMedOrders'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.pharmacyId === pharmacyId)),
      err  => console.warn('[SokoniHealth] pharmacyOrders:', err.message)
    );
  },

  /* ════════════════════════════════════════
     TELEMEDICINE SESSIONS
  ════════════════════════════════════════ */

  async saveTelemedicine(session) {
    const id = session.id || _id('TLM-');
    await setDoc(doc(db, 'healthTelemedicine', id), {
      ...session,
      id,
      uid:       _uid(),
      phone:     _phone(session.phone),
      status:    session.status || 'scheduled',
      createdAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateTelemedicine(id, data) {
    await updateDoc(doc(db, 'healthTelemedicine', id), {
      ...data, updatedAt: serverTimestamp(),
    });
  },

  listenUserTelemedicine(callback, limitN = 30) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'healthTelemedicine'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.uid === uid)),
      err  => console.warn('[SokoniHealth] telemedicine:', err.message)
    );
  },

  listenProviderTelemedicine(providerId, callback, limitN = 100) {
    const q = query(collection(db, 'healthTelemedicine'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.providerId === providerId)),
      err  => console.warn('[SokoniHealth] provTele:', err.message)
    );
  },

  /* ════════════════════════════════════════
     HOME HEALTH SERVICES
     (home nursing, physiotherapy, caregiver, equipment rental)
  ════════════════════════════════════════ */

  async saveHomeService(service) {
    const id = service.id || _id('HHS-');
    await setDoc(doc(db, 'healthHomeServices', id), {
      ...service,
      id,
      uid:       _uid(),
      phone:     _phone(service.phone),
      status:    service.status || 'pending',
      createdAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateHomeService(id, data) {
    await updateDoc(doc(db, 'healthHomeServices', id), {
      ...data, updatedAt: serverTimestamp(),
    });
  },

  listenUserHomeServices(callback, limitN = 30) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'healthHomeServices'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.uid === uid)),
      err  => console.warn('[SokoniHealth] homeServices:', err.message)
    );
  },

  /* ════════════════════════════════════════
     EMERGENCY REQUESTS
     Authenticated users can create; admin reads/manages.
  ════════════════════════════════════════ */

  async saveEmergency(req) {
    const id = req.id || _id('EMG-');
    await setDoc(doc(db, 'healthEmergency', id), {
      ...req,
      id,
      uid:       _uid() || 'anonymous',
      phone:     _phone(req.phone),
      status:    'active',
      createdAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateEmergency(id, data) {
    await updateDoc(doc(db, 'healthEmergency', id), {
      ...data, updatedAt: serverTimestamp(),
    });
  },

  /* ════════════════════════════════════════
     PROVIDER REVIEWS & RATINGS
     Public read. claimsOwner create.
  ════════════════════════════════════════ */

  async saveReview(review) {
    const id = review.id || _id('HRV-');
    await setDoc(doc(db, 'healthReviews', id), {
      ...review,
      id,
      uid:       _uid(),
      createdAt: serverTimestamp(),
    }, { merge: true });
    await this._recalcProviderRating(review.providerId);
    return id;
  },

  listenProviderReviews(providerId, callback, limitN = 20) {
    const q = query(collection(db, 'healthReviews'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() })).filter(d => d.providerId === providerId)),
      err  => console.warn('[SokoniHealth] reviews:', err.message)
    );
  },

  async _recalcProviderRating(providerId) {
    if (!providerId) return;
    try {
      const snap = await getDocs(query(
        collection(db, 'healthReviews'),
        where('providerId', '==', providerId)
      ));
      const ratings = snap.docs.map(d => d.data().rating).filter(r => typeof r === 'number' && r > 0);
      if (!ratings.length) return;
      const avg = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
      await setDoc(doc(db, 'healthProviders', providerId), {
        rating: avg, reviewCount: ratings.length, updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.warn('[SokoniHealth] rating recalc:', e.message);
    }
  },

  /* ════════════════════════════════════════
     ADMIN HELPERS
  ════════════════════════════════════════ */

  listenAllProviders(callback, limitN = 200) {
    const q = query(collection(db, 'healthProviders'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniHealth] allProviders:', err.message)
    );
  },

  listenAllAppointments(callback, limitN = 200) {
    const q = query(collection(db, 'healthAppointments'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniHealth] allAppts:', err.message)
    );
  },

  listenAllEmergency(callback, limitN = 50) {
    const q = query(collection(db, 'healthEmergency'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniHealth] allEmg:', err.message)
    );
  },

  async deleteProvider(id) {
    await deleteDoc(doc(db, 'healthProviders', id));
  },

  /* ════════════════════════════════════════
     NOTIFICATION HELPERS
     Fires a Firestore notification when a booking is made.
  ════════════════════════════════════════ */

  async notifyBooking(targetUid, opts = {}) {
    if (!targetUid || typeof window.SokoniNotifications === 'undefined') return;
    try {
      await window.SokoniNotifications.push(targetUid, {
        type:    'order',
        icon:    opts.icon    || '📅',
        heading: opts.heading || 'New appointment',
        sub:     opts.sub     || '',
        link:    opts.link    || 'healthcare.html',
      });
    } catch (e) {
      console.warn('[SokoniHealth] notify:', e.message);
    }
  },

};

window.SokoniHealth = SokoniHealth;
export default SokoniHealth;
