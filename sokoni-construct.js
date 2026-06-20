/* ================================================================
   SOKONI — Construction Hub Data Module  (sokoni-construct.js)

   Firestore collections:
     constructProviders/{id}    — contractors & professionals directory
     constructEquipment/{id}    — equipment rental listings
     constructProjects/{id}     — client project records
     constructRFQs/{id}         — requests for quotation
     constructQuotations/{id}   — contractor quotations on RFQs
     constructOrders/{id}       — material & equipment orders
     constructReviews/{id}      — provider ratings & reviews

   Exposes: window.SokoniConstruct  +  ES default export
================================================================ */
import { db, auth } from './firebase.js';
import {
  collection, doc, addDoc, setDoc, updateDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy, serverTimestamp,
  limit, deleteDoc, increment,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

function _uid() {
  if (auth.currentUser?.uid) return auth.currentUser.uid;
  try { return JSON.parse(localStorage.getItem('sokoniUser') || 'null')?.uid ?? null; }
  catch { return null; }
}
function _phone(p) { return String(p || '').replace(/\D/g, ''); }
function _id(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
}

const SokoniConstruct = {

  /* ════════════════════════════════════════
     PROVIDERS (contractors + professionals)
  ════════════════════════════════════════ */

  async saveProvider(p) {
    const id = p.id || _id('CNP-');
    await setDoc(doc(db, 'constructProviders', id), {
      ...p, id, uid: _uid(),
      status:      p.status      || 'pending',
      verified:    p.verified    || false,
      rating:      p.rating      || 0,
      reviewCount: p.reviewCount || 0,
      createdAt:   p.createdAt   || serverTimestamp(),
      updatedAt:   serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async getProvider(id) {
    const s = await getDoc(doc(db, 'constructProviders', id));
    return s.exists() ? { _fsId: s.id, ...s.data() } : null;
  },

  async updateProvider(id, data) {
    await updateDoc(doc(db, 'constructProviders', id), { ...data, updatedAt: serverTimestamp() });
  },

  async verifyProvider(id, verified = true) {
    await setDoc(doc(db, 'constructProviders', id), {
      verified, status: verified ? 'active' : 'pending',
      verifiedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }, { merge: true });
  },

  listenProviders(callback, filters = {}, limitN = 100) {
    let constraints = [orderBy('createdAt', 'desc'), limit(limitN)];
    if (filters.type)     constraints = [where('type',     '==', filters.type),     ...constraints];
    if (filters.verified) constraints = [where('verified', '==', true),             ...constraints];
    if (filters.area)     constraints = [where('area',     '==', filters.area),     ...constraints];
    const q = query(collection(db, 'constructProviders'), ...constraints);
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] providers:', e.message)
    );
  },

  listenMyProviderProfile(callback) {
    const uid = _uid();
    if (!uid) { callback(null); return () => {}; }
    const q = query(collection(db, 'constructProviders'), where('uid', '==', uid), limit(1));
    return onSnapshot(q,
      s => callback(s.docs.length ? { _fsId: s.docs[0].id, ...s.docs[0].data() } : null),
      e => console.warn('[SokoniConstruct] myProvider:', e.message)
    );
  },

  async deleteProvider(id) { await deleteDoc(doc(db, 'constructProviders', id)); },

  /* alias used by contractor registration form */
  async saveContractor(c) { return this.saveProvider({ ...c, providerType: 'contractor' }); },

  /* ════════════════════════════════════════
     EQUIPMENT RENTAL LISTINGS
  ════════════════════════════════════════ */

  async saveEquipment(eq) {
    const id = eq.id || _id('CEQ-');
    await setDoc(doc(db, 'constructEquipment', id), {
      ...eq, id, uid: _uid(),
      available: eq.available ?? true,
      createdAt: eq.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateEquipment(id, data) {
    await updateDoc(doc(db, 'constructEquipment', id), { ...data, updatedAt: serverTimestamp() });
  },

  listenEquipment(callback, filters = {}, limitN = 80) {
    let constraints = [orderBy('createdAt', 'desc'), limit(limitN)];
    if (filters.type) constraints = [where('type', '==', filters.type), ...constraints];
    const q = query(collection(db, 'constructEquipment'), ...constraints);
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] equipment:', e.message)
    );
  },

  /* ════════════════════════════════════════
     PROJECTS
  ════════════════════════════════════════ */

  async saveProject(project) {
    const id = project.id || _id('CPJ-');
    await setDoc(doc(db, 'constructProjects', id), {
      ...project, id, uid: _uid(),
      phone:     _phone(project.phone),
      status:    project.status || 'open',
      createdAt: project.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateProject(id, data) {
    await updateDoc(doc(db, 'constructProjects', id), { ...data, updatedAt: serverTimestamp() });
  },

  listenUserProjects(callback, limitN = 30) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'constructProjects'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] userProjects:', e.message)
    );
  },

  /* ════════════════════════════════════════
     RFQs (Request for Quotation)
  ════════════════════════════════════════ */

  async saveRFQ(rfq) {
    const id = rfq.id || _id('RFQ-');
    await setDoc(doc(db, 'constructRFQs', id), {
      ...rfq, id, uid: _uid(),
      phone:  _phone(rfq.phone),
      status: rfq.status || 'open',
      quotationCount: 0,
      createdAt: rfq.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateRFQ(id, data) {
    await updateDoc(doc(db, 'constructRFQs', id), { ...data, updatedAt: serverTimestamp() });
  },

  async closeRFQ(id) {
    await updateDoc(doc(db, 'constructRFQs', id), { status: 'closed', updatedAt: serverTimestamp() });
  },

  listenUserRFQs(callback, limitN = 30) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'constructRFQs'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] userRFQs:', e.message)
    );
  },

  listenOpenRFQs(callback, limitN = 50) {
    const q = query(
      collection(db, 'constructRFQs'),
      where('status', '==', 'open'),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] openRFQs:', e.message)
    );
  },

  /* ════════════════════════════════════════
     QUOTATIONS
  ════════════════════════════════════════ */

  async saveQuotation(quot) {
    const id = quot.id || _id('QT-');
    await setDoc(doc(db, 'constructQuotations', id), {
      ...quot, id, uid: _uid(),
      phone:  _phone(quot.phone),
      status: quot.status || 'submitted',
      createdAt: quot.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    /* increment quotation count on the RFQ */
    if (quot.rfqId) {
      try {
        await updateDoc(doc(db, 'constructRFQs', quot.rfqId), {
          quotationCount: increment(1), updatedAt: serverTimestamp(),
        });
      } catch {}
    }
    return id;
  },

  async updateQuotation(id, data) {
    await updateDoc(doc(db, 'constructQuotations', id), { ...data, updatedAt: serverTimestamp() });
  },

  listenRFQQuotations(rfqId, callback, limitN = 20) {
    const q = query(
      collection(db, 'constructQuotations'),
      where('rfqId', '==', rfqId),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] quotations:', e.message)
    );
  },

  listenProviderQuotations(providerUid, callback, limitN = 50) {
    const q = query(
      collection(db, 'constructQuotations'),
      where('providerUid', '==', providerUid),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] providerQuots:', e.message)
    );
  },

  /* ════════════════════════════════════════
     ORDERS (materials + equipment hire)
  ════════════════════════════════════════ */

  async saveOrder(order) {
    const id = order.id || _id('ORD-');
    await setDoc(doc(db, 'constructOrders', id), {
      ...order, id, uid: _uid(),
      phone:  _phone(order.phone),
      status: order.status || 'placed',
      createdAt: order.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateOrder(id, data) {
    await updateDoc(doc(db, 'constructOrders', id), { ...data, updatedAt: serverTimestamp() });
  },

  listenUserOrders(callback, limitN = 50) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'constructOrders'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] userOrders:', e.message)
    );
  },

  /* ════════════════════════════════════════
     REVIEWS
  ════════════════════════════════════════ */

  async saveReview(review) {
    const id = review.id || _id('CRV-');
    await setDoc(doc(db, 'constructReviews', id), {
      ...review, id, uid: _uid(), createdAt: serverTimestamp(),
    }, { merge: true });
    await this._recalcRating(review.providerId);
    return id;
  },

  listenProviderReviews(providerId, callback, limitN = 20) {
    const q = query(
      collection(db, 'constructReviews'),
      where('providerId', '==', providerId),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] reviews:', e.message)
    );
  },

  async _recalcRating(providerId) {
    if (!providerId) return;
    try {
      const snap = await getDocs(query(
        collection(db, 'constructReviews'),
        where('providerId', '==', providerId)
      ));
      const ratings = snap.docs.map(d => d.data().rating).filter(r => typeof r === 'number' && r > 0);
      if (!ratings.length) return;
      const avg = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
      await setDoc(doc(db, 'constructProviders', providerId), {
        rating: avg, reviewCount: ratings.length, updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.warn('[SokoniConstruct] rating recalc:', e.message);
    }
  },

  /* ════════════════════════════════════════
     ADMIN HELPERS
  ════════════════════════════════════════ */

  listenAllProviders(callback, limitN = 200) {
    const q = query(collection(db, 'constructProviders'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] allProviders:', e.message)
    );
  },

  listenAllRFQs(callback, limitN = 100) {
    const q = query(collection(db, 'constructRFQs'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] allRFQs:', e.message)
    );
  },

  listenAllOrders(callback, limitN = 200) {
    const q = query(collection(db, 'constructOrders'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniConstruct] allOrders:', e.message)
    );
  },

  /* ════════════════════════════════════════
     NOTIFICATION HELPER
  ════════════════════════════════════════ */

  async notifyRFQ(targetUid, opts = {}) {
    if (!targetUid || typeof window.SokoniNotifications === 'undefined') return;
    try {
      await window.SokoniNotifications.push(targetUid, {
        type:    'order',
        icon:    opts.icon    || '📋',
        heading: opts.heading || 'New RFQ',
        sub:     opts.sub     || '',
        link:    opts.link    || 'construction.html',
      });
    } catch (e) { console.warn('[SokoniConstruct] notify:', e.message); }
  },
};

window.SokoniConstruct = SokoniConstruct;
export default SokoniConstruct;
