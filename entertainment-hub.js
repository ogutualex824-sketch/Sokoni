/* ================================================================
   SOKONI Entertainment Hub — Firestore Data Layer  v1.0
   Collections: entArtists, entEvents, entTickets, entVenues,
                entVenueBookings, entArtistBookings, entReviews, entContent
   Exposes: window.EntHub
================================================================ */
import { db, auth } from './firebase.js';
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, increment, limit, runTransaction, arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

function _uid() {
  if (auth.currentUser?.uid) return auth.currentUser.uid;
  try { return JSON.parse(localStorage.getItem('sokoniUser') || 'null')?.uid ?? null; } catch { return null; }
}
function _user() {
  try { return JSON.parse(localStorage.getItem('sokoniUser') || 'null') || {}; } catch { return {}; }
}

/* ── Unique ticket code ── */
function _genCode() {
  return 'TK-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

const EntHub = {

  /* ═══════════════════════════════════════════════════════════
     ARTISTS / CREATORS
  ═══════════════════════════════════════════════════════════ */

  async registerArtist(data) {
    const uid = _uid();
    const u = _user();
    const ref = await addDoc(collection(db, 'entArtists'), {
      ...data,
      uid,
      email: u.email || data.email || '',
      rating: 0,
      reviewCount: 0,
      bookingCount: 0,
      verified: false,
      featured: false,
      available: true,
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  },

  async updateArtist(fsId, data) {
    await updateDoc(doc(db, 'entArtists', fsId), {
      ...data,
      updatedAt: serverTimestamp(),
    });
  },

  async getArtist(fsId) {
    const snap = await getDoc(doc(db, 'entArtists', fsId));
    return snap.exists() ? { _id: snap.id, ...snap.data() } : null;
  },

  listenArtists(filters, callback, limitN = 80) {
    /* Query only by single equality field to avoid composite index requirements.
       Status filtering (approved/active) is applied client-side. */
    let q = query(collection(db, 'entArtists'), orderBy('createdAt', 'desc'), limit(limitN));
    if (filters?.type) q = query(collection(db, 'entArtists'), where('type', '==', filters.type), orderBy('createdAt', 'desc'), limit(limitN));
    if (filters?.city) q = query(collection(db, 'entArtists'), where('city', '==', filters.city), orderBy('createdAt', 'desc'), limit(limitN));
    const allowAll = filters?.all;
    return onSnapshot(q,
      snap => {
        let artists = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
        if (!allowAll) artists = artists.filter(a => a.status === 'approved' || a.status === 'active');
        callback(artists);
      },
      err => console.warn('[EntHub] artists:', err.message)
    );
  },

  /* Book a hardcoded/static performer (no Firestore artistId) */
  async bookArtistDirect(data) {
    const uid = _uid();
    const u = _user();
    const ref = await addDoc(collection(db, 'entArtistBookings'), {
      uid: uid || 'guest',
      artistId: data.artistId || 'static_' + (data.artistName || '').toLowerCase().replace(/\s+/g, '_'),
      artistUid: '',
      artistName: data.artistName || '',
      artistType: data.artistType || '',
      bookerName: data.bookerName || u.name || '',
      bookerPhone: data.bookerPhone || u.phone || '',
      bookerEmail: data.bookerEmail || u.email || '',
      eventDate: data.eventDate || '',
      eventTime: data.eventTime || '',
      eventType: data.eventType || '',
      eventVenue: data.eventVenue || '',
      notes: data.notes || '',
      budget: data.budget || 0,
      status: 'pending',
      source: 'static_performer',
      depositPaid: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  },

  /* Save an Ask-Hub entertainment request */
  async saveRequest(data) {
    const uid = _uid();
    const u = _user();
    const ref = await addDoc(collection(db, 'entRequests'), {
      uid: uid || 'guest',
      requesterName: u.name || '',
      phone: data.phone || u.phone || '',
      text: data.text || '',
      type: data.type || 'General',
      status: 'open',
      createdAt: serverTimestamp(),
    });
    return ref.id;
  },

  async getMyArtistProfile() {
    const uid = _uid();
    if (!uid) return null;
    const q = query(collection(db, 'entArtists'), where('uid', '==', uid), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { _id: d.id, ...d.data() };
  },

  /* ═══════════════════════════════════════════════════════════
     EVENTS
  ═══════════════════════════════════════════════════════════ */

  async createEvent(data) {
    const uid = _uid();
    const u = _user();
    const ref = await addDoc(collection(db, 'entEvents'), {
      ...data,
      uid,
      organizerName: u.name || data.organizerName || 'Organizer',
      organizerPhone: data.organizerPhone || u.phone || '',
      ticketsSold: 0,
      revenue: 0,
      status: 'published',
      approved: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  },

  async updateEvent(fsId, data) {
    await updateDoc(doc(db, 'entEvents', fsId), {
      ...data,
      updatedAt: serverTimestamp(),
    });
  },

  async getEvent(fsId) {
    const snap = await getDoc(doc(db, 'entEvents', fsId));
    return snap.exists() ? { _id: snap.id, ...snap.data() } : null;
  },

  listenEvents(filters, callback, limitN = 60) {
    let q = query(collection(db, 'entEvents'), where('status', '==', 'published'), orderBy('date', 'asc'), limit(limitN));
    if (filters?.type && filters.type !== 'all') {
      q = query(collection(db, 'entEvents'), where('type', '==', filters.type), where('status', '==', 'published'), orderBy('date', 'asc'), limit(limitN));
    }
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] events:', err.message)
    );
  },

  getMyEvents(callback) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'entEvents'), where('uid', '==', uid), orderBy('createdAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] myEvents:', err.message)
    );
  },

  async deleteEvent(fsId) {
    await updateDoc(doc(db, 'entEvents', fsId), { status: 'cancelled', updatedAt: serverTimestamp() });
  },

  /* ═══════════════════════════════════════════════════════════
     TICKETS
  ═══════════════════════════════════════════════════════════ */

  async purchaseTicket(eventId, buyerData) {
    const uid = _uid();
    const u = _user();
    const eventDoc = await getDoc(doc(db, 'entEvents', eventId));
    if (!eventDoc.exists()) throw new Error('Event not found');
    const ev = eventDoc.data();

    const ticketType = buyerData.ticketType || 'General';
    const tier = (ev.ticketTypes || []).find(t => t.name === ticketType);
    if (tier && (tier.sold || 0) >= tier.capacity) throw new Error('Ticket type sold out');

    const ticketCode = _genCode();
    const qrData = JSON.stringify({ t: 'SOKONI-TICKET', id: '', e: eventId, c: ticketCode, ts: Date.now() });

    const ref = await addDoc(collection(db, 'entTickets'), {
      uid: uid || 'guest',
      buyerName: buyerData.buyerName || u.name || '',
      buyerPhone: buyerData.buyerPhone || u.phone || '',
      buyerEmail: buyerData.buyerEmail || u.email || '',
      eventId,
      eventTitle: ev.title || ev.name || '',
      eventDate: ev.date || '',
      eventTime: ev.time || '',
      venueName: ev.venueName || ev.venue || '',
      ticketType,
      price: buyerData.price || (tier?.price ?? ev.price ?? 0),
      quantity: buyerData.quantity || 1,
      ticketCode,
      qrData,
      status: 'valid',
      paymentRef: buyerData.paymentRef || '',
      paymentMethod: buyerData.paymentMethod || 'M-Pesa',
      purchasedAt: serverTimestamp(),
      usedAt: null,
      scannedBy: null,
    });

    /* Update qrData with the doc id */
    const fullQr = JSON.stringify({ t: 'SOKONI-TICKET', id: ref.id, e: eventId, c: ticketCode, ts: Date.now() });
    await updateDoc(ref, { qrData: fullQr });

    /* Increment ticketsSold + revenue on event */
    const ticketPrice = buyerData.price || tier?.price || 0;
    const ticketQty   = buyerData.quantity || 1;
    const totalAmount = ticketPrice * ticketQty;
    const tierIdx     = (ev.ticketTypes || []).findIndex(t => t.name === ticketType);
    const eventUpdate = {
      ticketsSold: increment(ticketQty),
      revenue:     increment(totalAmount),
      updatedAt:   serverTimestamp(),
    };
    if (tierIdx >= 0) eventUpdate[`ticketTypes.${tierIdx}.sold`] = increment(ticketQty);
    await updateDoc(doc(db, 'entEvents', eventId), eventUpdate);

    /* Trigger M-Pesa STK push if amount > 0 and IntaSend is configured */
    if (totalAmount > 0) {
      const cfg = window.SOKONI_CONFIG || {};
      const phone = (buyerData.buyerPhone || '').replace(/^0/, '254').replace(/^\+/, '');
      if (cfg.intasendKey && phone) {
        try {
          const IS = new window.IntaSend({ publicAPIKey: cfg.intasendKey, live: cfg.intasendLive !== false });
          IS.mpesa().stkPush({
            amount:      totalAmount,
            phone_number: phone,
            email:       buyerData.buyerEmail || '',
            narrative:   `Ticket: ${ev.title || ev.name || 'Event'} × ${ticketQty}`,
          }).then(r => {
            if (r?.invoice?.invoice_id) {
              updateDoc(ref, { paymentRef: r.invoice.invoice_id, paymentMethod: 'M-Pesa STK' }).catch(() => {});
            }
          }).catch(e => console.warn('[EntHub] STK push failed:', e.message));
        } catch (e) {
          console.warn('[EntHub] IntaSend not loaded:', e.message);
        }
      }
    }

    /* Notify buyer */
    if (uid) {
      this.notify(uid, {
        title: '🎟️ Ticket Confirmed!',
        body: `${ev.title || ev.name || 'Event'} · ${ev.date || ''} · ${ticketType} × ${ticketQty}`,
        type: 'ticket', ticketId: ref.id, eventId,
      }).catch(() => {});
    }

    return {
      _id: ref.id, ticketId: ref.id, ticketCode, qrData: fullQr,
      eventId, eventTitle: ev.title || ev.name || '',
      eventDate: ev.date || '', eventVenue: ev.venueName || ev.venue || '',
      buyerName: buyerData.buyerName || _user().name || '',
      buyerPhone: buyerData.buyerPhone || '',
      ticketType, quantity: ticketQty,
      price: ticketPrice,
      status: 'valid',
    };
  },

  listenMyTickets(callback) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'entTickets'), where('uid', '==', uid), orderBy('purchasedAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] tickets:', err.message)
    );
  },

  async validateTicket(ticketId, ticketCode) {
    const uid = _uid();
    const ticketRef = doc(db, 'entTickets', ticketId);
    const snap = await getDoc(ticketRef);
    if (!snap.exists()) return { ok: false, reason: 'Ticket not found' };
    const t = snap.data();
    if (t.ticketCode !== ticketCode) return { ok: false, reason: 'Invalid ticket code' };
    if (t.status === 'used') return { ok: false, reason: 'Ticket already used', usedAt: t.usedAt, scannedBy: t.scannedBy };
    if (t.status === 'cancelled') return { ok: false, reason: 'Ticket cancelled' };
    await updateDoc(ticketRef, { status: 'used', usedAt: serverTimestamp(), scannedBy: uid });
    return { ok: true, ticket: { _id: snap.id, ...t } };
  },

  getEventAttendees(eventId, callback) {
    const q = query(collection(db, 'entTickets'), where('eventId', '==', eventId), orderBy('purchasedAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] attendees:', err.message)
    );
  },

  /* ═══════════════════════════════════════════════════════════
     VENUES
  ═══════════════════════════════════════════════════════════ */

  async listVenue(data) {
    const uid = _uid();
    const u = _user();
    const ref = await addDoc(collection(db, 'entVenues'), {
      ...data,
      uid,
      ownerName: u.name || data.ownerName || '',
      ownerPhone: u.phone || data.ownerPhone || '',
      rating: 0,
      reviewCount: 0,
      verified: false,
      available: true,
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  },

  listenVenues(filters, callback, limitN = 40) {
    let q = query(collection(db, 'entVenues'), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(limitN));
    if (filters?.type) {
      q = query(collection(db, 'entVenues'), where('type', '==', filters.type), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(limitN));
    } else if (filters?.city) {
      q = query(collection(db, 'entVenues'), where('city', '==', filters.city), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(limitN));
    }
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] venues:', err.message)
    );
  },

  async getVenue(fsId) {
    const snap = await getDoc(doc(db, 'entVenues', fsId));
    return snap.exists() ? { _id: snap.id, ...snap.data() } : null;
  },

  async bookVenue(venueId, bookingData) {
    const uid = _uid();
    const u = _user();
    const venueDoc = await getDoc(doc(db, 'entVenues', venueId));
    if (!venueDoc.exists()) throw new Error('Venue not found');
    const v = venueDoc.data();
    const ref = await addDoc(collection(db, 'entVenueBookings'), {
      uid: uid || 'guest',
      venueId,
      venueName: v.name || '',
      venueOwnerId: v.uid || '',
      bookerName: bookingData.bookerName || u.name || '',
      bookerPhone: bookingData.bookerPhone || u.phone || '',
      eventDate: bookingData.eventDate || '',
      eventType: bookingData.eventType || '',
      duration: bookingData.duration || 1,
      totalPrice: bookingData.totalPrice || 0,
      message: bookingData.message || '',
      status: 'pending',
      paymentRef: bookingData.paymentRef || '',
      createdAt: serverTimestamp(),
    });
    return ref.id;
  },

  listenMyVenueBookings(callback) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'entVenueBookings'), where('uid', '==', uid), orderBy('createdAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] venueBookings:', err.message)
    );
  },

  /* ═══════════════════════════════════════════════════════════
     ARTIST BOOKINGS
  ═══════════════════════════════════════════════════════════ */

  async bookArtist(artistId, data) {
    const uid = _uid();
    const u = _user();
    const artistDoc = await getDoc(doc(db, 'entArtists', artistId));
    const a = artistDoc.exists() ? artistDoc.data() : {};
    const ref = await addDoc(collection(db, 'entArtistBookings'), {
      uid: uid || 'guest',
      artistId,
      artistUid: a.uid || '',
      artistName: a.name || data.artistName || '',
      artistType: a.type || '',
      bookerName: data.bookerName || u.name || '',
      bookerPhone: data.bookerPhone || u.phone || '',
      bookerEmail: data.bookerEmail || u.email || '',
      eventDate: data.eventDate || '',
      eventTime: data.eventTime || '',
      eventType: data.eventType || '',
      eventVenue: data.eventVenue || '',
      eventCity: data.eventCity || '',
      notes: data.notes || '',
      budget: data.budget || 0,
      status: 'pending',
      depositPaid: false,
      paymentRef: data.paymentRef || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    /* Increment bookingCount on artist */
    if (artistDoc.exists()) await updateDoc(doc(db, 'entArtists', artistId), { bookingCount: increment(1) });
    return ref.id;
  },

  listenMyArtistBookings(callback) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(collection(db, 'entArtistBookings'), where('uid', '==', uid), orderBy('createdAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] artistBookings:', err.message)
    );
  },

  getArtistBookings(artistId, callback) {
    const q = query(collection(db, 'entArtistBookings'), where('artistId', '==', artistId), orderBy('createdAt', 'desc'));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] artistInbox:', err.message)
    );
  },

  async updateArtistBookingStatus(fsId, status) {
    await updateDoc(doc(db, 'entArtistBookings', fsId), { status, updatedAt: serverTimestamp() });
  },

  /* ═══════════════════════════════════════════════════════════
     REVIEWS
  ═══════════════════════════════════════════════════════════ */

  async submitReview(data) {
    const uid = _uid();
    const u = _user();
    const ref = await addDoc(collection(db, 'entReviews'), {
      uid: uid || 'guest',
      targetType: data.targetType,
      targetId: data.targetId,
      reviewerName: u.name || data.reviewerName || 'Anonymous',
      rating: data.rating,
      comment: data.comment || '',
      approved: true,
      createdAt: serverTimestamp(),
    });
    /* Update average rating on target */
    const targetCol = data.targetType === 'artist' ? 'entArtists' : data.targetType === 'venue' ? 'entVenues' : 'entEvents';
    const targetRef = doc(db, targetCol, data.targetId);
    const targetSnap = await getDoc(targetRef);
    if (targetSnap.exists()) {
      const { rating: curRating = 0, reviewCount: curCount = 0 } = targetSnap.data();
      const newCount = curCount + 1;
      const newRating = ((curRating * curCount) + data.rating) / newCount;
      await updateDoc(targetRef, { rating: newRating, reviewCount: newCount, updatedAt: serverTimestamp() });
    }
    return ref.id;
  },

  listenReviews(targetId, callback, limitN = 20) {
    const q = query(collection(db, 'entReviews'), where('targetId', '==', targetId), where('approved', '==', true), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] reviews:', err.message)
    );
  },

  /* ═══════════════════════════════════════════════════════════
     DIGITAL CONTENT
  ═══════════════════════════════════════════════════════════ */

  async publishContent(data) {
    const uid = _uid();
    const u = _user();
    const ref = await addDoc(collection(db, 'entContent'), {
      ...data,
      uid,
      creatorName: u.name || data.creatorName || '',
      views: 0,
      likes: 0,
      status: 'active',
      createdAt: serverTimestamp(),
    });
    return ref.id;
  },

  listenContent(filters, callback, limitN = 30) {
    let q = query(collection(db, 'entContent'), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(limitN));
    if (filters?.type) q = query(collection(db, 'entContent'), where('type', '==', filters.type), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(limitN));
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
      err => console.warn('[EntHub] content:', err.message)
    );
  },

  async likeContent(fsId) {
    await updateDoc(doc(db, 'entContent', fsId), { likes: increment(1) });
  },

  async incrementViews(fsId) {
    await updateDoc(doc(db, 'entContent', fsId), { views: increment(1) });
  },

  /* ═══════════════════════════════════════════════════════════
     NOTIFICATIONS
  ═══════════════════════════════════════════════════════════ */

  async notify(targetUid, data) {
    await addDoc(collection(db, 'notifications'), {
      targetUid,
      ...data,
      read: false,
      createdAt: serverTimestamp(),
    });
  },

  /* ═══════════════════════════════════════════════════════════
     STATS (for organizer dashboard)
  ═══════════════════════════════════════════════════════════ */

  async getEventStats(eventId) {
    const [eventSnap, ticketSnap] = await Promise.all([
      getDoc(doc(db, 'entEvents', eventId)),
      getDocs(query(collection(db, 'entTickets'), where('eventId', '==', eventId))),
    ]);
    if (!eventSnap.exists()) return null;
    const ev = eventSnap.data();
    const tickets = ticketSnap.docs.map(d => d.data());
    const validTickets = tickets.filter(t => t.status === 'valid');
    const usedTickets  = tickets.filter(t => t.status === 'used');
    const revenue = tickets.reduce((s, t) => s + ((t.price || 0) * (t.quantity || 1)), 0);
    const capacity = (ev.ticketTypes || []).reduce((s, t) => s + (t.capacity || 0), 0) || ev.totalCapacity || 0;
    return { ev, tickets, validTickets, usedTickets, revenue, capacity, totalSold: tickets.length };
  },
};

window.EntHub = EntHub;
export default EntHub;
