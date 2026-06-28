/* ============================================================
   SOKONI SmartPOS 2.0 — Multi-Device Session Management
   Cloud Functions: create/join/leave sessions, sync state,
   device registry, shift management, conflict resolution.
============================================================ */
'use strict';

const { onCall, HttpsError }         = require('firebase-functions/v2/https');
const { onDocumentWritten }          = require('firebase-functions/v2/firestore');
const { onSchedule }                 = require('firebase-functions/v2/scheduler');
const admin                          = require('firebase-admin');
const crypto                         = require('crypto');

const fdb   = () => admin.firestore();
const _now      = () => admin.firestore.FieldValue.serverTimestamp();
const _incr     = (n) => admin.firestore.FieldValue.increment(n);
const _del      = () => admin.firestore.FieldValue.delete();
const _arrUnion = (...items) => admin.firestore.FieldValue.arrayUnion(...items);
const _arrRemove = (...items) => admin.firestore.FieldValue.arrayRemove(...items);
const _san  = (s, n) => String(s || '').replace(/[<>"'&]/g, '').trim().slice(0, n || 200);

const _isAuthed = (auth) => !!(auth && auth.uid);
const _isAdmin  = (auth) => auth && (auth.token?.admin === true || auth.token?.superAdmin === true);

/* ── Device roles ── */
const DEVICE_ROLES = ['cashier', 'supervisor', 'manager', 'owner', 'display', 'kitchen'];

/* ── Session document schema (posSessions/{sessionId}) ──
   {
     sessionId, sellerId, sellerName, shopName,
     status: 'open' | 'closed' | 'suspended',
     deviceCount, maxDevices: 10,
     devices: { [deviceId]: { uid, name, role, lastSeen, joinedAt } },
     cart: { [itemKey]: { productId, name, price, qty, discount, addedBy, addedAt } },
     cartTotal, cartTax, cartSubtotal, cartItemCount,
     currentOrderId, shiftId,
     cashDrawerOpen,
     openedAt, closedAt, lastActivityAt
   }
─────────────────────────────────────────────────────────── */

/* ═══════════════════════════════════════════════════════════
   CF 1 — createPosSession
   Seller opens a new POS session. Returns sessionId + sessionCode.
════════════════════════════════════════════════════════════ */
exports.createPosSession = onCall(
  { region: 'us-central1', memory: '256MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { deviceName, deviceType, role = 'cashier', shiftId } = request.data;
    if (!DEVICE_ROLES.includes(role)) throw new HttpsError('invalid-argument', 'Invalid device role');

    /* Fetch seller info */
    const sellerSnap = await fdb().collection('sellers').doc(auth.uid).get();
    const seller     = sellerSnap.exists ? sellerSnap.data() : {};

    const sessionId   = crypto.randomBytes(8).toString('hex').toUpperCase();
    const sessionCode = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit join code
    const deviceId    = `${auth.uid.slice(-6)}_${crypto.randomBytes(4).toString('hex')}`;

    await fdb().collection('posSessions').doc(sessionId).set({
      sessionId,
      sessionCode,
      sellerId:         auth.uid,
      sellerName:       _san(seller.shopName || seller.businessName || seller.displayName, 80),
      shopName:         _san(seller.shopName || seller.businessName, 60),
      sellerLogo:       seller.logoUrl || seller.logo || '',
      status:           'open',
      maxDevices:       10,
      deviceCount:      1,
      devices: {
        [deviceId]: {
          uid:       auth.uid,
          name:      _san(deviceName || 'Main POS', 40),
          type:      _san(deviceType || 'unknown', 20),
          role:      role,
          isHost:    true,
          joinedAt:  _now(),
          lastSeen:  _now(),
        }
      },
      cart:             {},
      cartTotal:        0,
      cartSubtotal:     0,
      cartTax:          0,
      cartDiscount:     0,
      cartItemCount:    0,
      currentOrderId:   null,
      shiftId:          shiftId ? _san(shiftId, 40) : null,
      cashDrawerOpen:   false,
      currency:         'KES',
      memberUids:       [auth.uid], /* flat array for Firestore security rules */
      openedAt:         _now(),
      closedAt:         null,
      lastActivityAt:   _now(),
    });

    return { sessionId, sessionCode, deviceId };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 2 — joinPosSession
   Additional device joins an existing session using code or ID.
════════════════════════════════════════════════════════════ */
exports.joinPosSession = onCall(
  { region: 'us-central1', memory: '128MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { sessionId, sessionCode, deviceName, deviceType, role = 'cashier' } = request.data;
    if (!DEVICE_ROLES.includes(role)) throw new HttpsError('invalid-argument', 'Invalid device role');

    /* Lookup by code or ID */
    let snap;
    if (sessionCode && !sessionId) {
      const q = await fdb().collection('posSessions')
        .where('sessionCode', '==', sessionCode)
        .where('status', '==', 'open')
        .limit(1)
        .get();
      if (q.empty) throw new HttpsError('not-found', 'Invalid session code or session is closed');
      snap = q.docs[0];
    } else if (sessionId) {
      snap = await fdb().collection('posSessions').doc(sessionId).get();
    } else {
      throw new HttpsError('invalid-argument', 'sessionId or sessionCode required');
    }

    if (!snap || !snap.exists) throw new HttpsError('not-found', 'Session not found');
    const session = snap.data();
    const sId     = snap.id;

    if (session.status !== 'open') throw new HttpsError('failed-precondition', 'Session is not open');
    if (Object.keys(session.devices || {}).length >= session.maxDevices) {
      throw new HttpsError('resource-exhausted', `Maximum ${session.maxDevices} devices allowed`);
    }

    const deviceId = `${auth.uid.slice(-6)}_${crypto.randomBytes(4).toString('hex')}`;

    await fdb().collection('posSessions').doc(sId).update({
      [`devices.${deviceId}`]: {
        uid:       auth.uid,
        name:      _san(deviceName || 'Device', 40),
        type:      _san(deviceType || 'unknown', 20),
        role:      role,
        isHost:    false,
        joinedAt:  _now(),
        lastSeen:  _now(),
      },
      deviceCount:      _incr(1),
      memberUids:       _arrUnion(auth.uid),
      lastActivityAt:   _now(),
    });

    return {
      sessionId:   sId,
      deviceId,
      sellerName:  session.sellerName,
      shopName:    session.shopName,
      sellerLogo:  session.sellerLogo,
    };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 3 — leavePosSession
   Device disconnects from session.
════════════════════════════════════════════════════════════ */
exports.leavePosSession = onCall(
  { region: 'us-central1', memory: '128MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { sessionId, deviceId } = request.data;
    if (!sessionId || !deviceId) throw new HttpsError('invalid-argument', 'sessionId and deviceId required');

    const ref  = fdb().collection('posSessions').doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists) return { status: 'not_found' };

    const session = snap.data();
    const device  = session.devices?.[deviceId];
    if (!device) return { status: 'already_left' };
    if (device.uid !== auth.uid && !_isAdmin(auth)) {
      throw new HttpsError('permission-denied', 'Cannot remove another device');
    }

    /* Check if the user has other devices still in session before removing from memberUids */
    const remainingDevices = Object.entries(session.devices || {})
      .filter(([id, d]) => id !== deviceId && d.uid === device.uid);

    await ref.update({
      [`devices.${deviceId}`]: _del(),
      deviceCount: _incr(-1),
      ...(remainingDevices.length === 0 ? { memberUids: _arrRemove(device.uid) } : {}),
      lastActivityAt: _now(),
    });

    return { status: 'left' };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 4 — closePosSession
   Host closes the session for all devices.
════════════════════════════════════════════════════════════ */
exports.closePosSession = onCall(
  { region: 'us-central1', memory: '128MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { sessionId, reason } = request.data;
    if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required');

    const ref  = fdb().collection('posSessions').doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found');

    const session = snap.data();
    if (session.sellerId !== auth.uid && !_isAdmin(auth)) {
      throw new HttpsError('permission-denied', 'Only the session owner can close it');
    }

    await ref.update({
      status:          'closed',
      closedAt:        _now(),
      closeReason:     _san(reason || '', 200),
      lastActivityAt:  _now(),
    });

    return { status: 'closed' };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 5 — posHeartbeat
   Device sends heartbeat every 30s. Used for presence tracking.
   Also handles device removal on stale heartbeat.
════════════════════════════════════════════════════════════ */
exports.posHeartbeat = onCall(
  { region: 'us-central1', memory: '128MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { sessionId, deviceId } = request.data;
    if (!sessionId || !deviceId) throw new HttpsError('invalid-argument', 'sessionId and deviceId required');

    const ref  = fdb().collection('posSessions').doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().status !== 'open') return { status: 'session_closed' };

    await ref.update({
      [`devices.${deviceId}.lastSeen`]: _now(),
      lastActivityAt: _now(),
    });

    return { status: 'alive' };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 6 — updatePosCart
   Authoritative cart update (called by any device in session).
   Validates + writes to Firestore → all listeners receive update.
════════════════════════════════════════════════════════════ */
exports.updatePosCart = onCall(
  { region: 'us-central1', memory: '256MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { sessionId, action, item } = request.data;
    /* action: 'add' | 'remove' | 'update_qty' | 'clear' | 'apply_discount' */
    if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required');

    const db  = fdb();
    const ref = db.collection('posSessions').doc(sessionId);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Session not found');

      const session = snap.data();
      if (session.status !== 'open') throw new HttpsError('failed-precondition', 'Session is closed');

      /* Validate device is in session */
      const isInSession = Object.values(session.devices || {}).some(d => d.uid === auth.uid);
      if (!isInSession && !_isAdmin(auth)) {
        throw new HttpsError('permission-denied', 'Not a member of this session');
      }

      const cart = { ...(session.cart || {}) };

      if (action === 'clear') {
        tx.update(ref, {
          cart: {},
          cartTotal: 0, cartSubtotal: 0, cartTax: 0, cartDiscount: 0, cartItemCount: 0,
          lastActivityAt: _now(),
        });
        return { cart: {}, total: 0 };
      }

      if (action === 'add' || action === 'update_qty') {
        if (!item || !item.productId) throw new HttpsError('invalid-argument', 'item.productId required');
        const key   = _san(item.productId, 100);
        const price = Math.max(0, parseFloat(item.price || 0));
        const qty   = Math.max(1, parseInt(item.qty || 1, 10));
        const disc  = Math.min(Math.max(0, parseFloat(item.discount || 0)), price * qty);

        if (action === 'add' && cart[key]) {
          cart[key].qty += qty;
        } else {
          cart[key] = {
            productId: key,
            name:      _san(item.name || item.productName || 'Item', 120),
            price,
            qty:       action === 'add' ? ((cart[key]?.qty || 0) + qty) : qty,
            discount:  disc,
            sku:       _san(item.sku || '', 50),
            addedBy:   auth.uid,
            updatedAt: Date.now(),
          };
        }
      }

      if (action === 'remove') {
        const key = _san(item?.productId || '', 100);
        delete cart[key];
      }

      if (action === 'apply_discount') {
        const key  = _san(item?.productId || '', 100);
        const disc = Math.max(0, parseFloat(item?.discount || 0));
        if (cart[key]) cart[key].discount = Math.min(disc, cart[key].price * cart[key].qty);
      }

      /* Recalculate totals */
      let subtotal = 0, discount = 0;
      Object.values(cart).forEach(ci => {
        subtotal += ci.price * ci.qty;
        discount += ci.discount || 0;
      });
      const tax   = Math.round((subtotal - discount) * 0.16 * 100) / 100;
      const total = Math.round((subtotal - discount + tax) * 100) / 100;

      tx.update(ref, {
        cart,
        cartSubtotal:  Math.round(subtotal * 100) / 100,
        cartDiscount:  Math.round(discount * 100) / 100,
        cartTax:       tax,
        cartTotal:     total,
        cartItemCount: Object.keys(cart).length,
        lastActivityAt: _now(),
      });

      return { cart, total, subtotal, tax, discount };
    });
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 7 — getPosSession
   Fetch current session state (for initial device load).
════════════════════════════════════════════════════════════ */
exports.getPosSession = onCall(
  { region: 'us-central1', memory: '128MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { sessionId } = request.data;
    if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required');

    const snap = await fdb().collection('posSessions').doc(sessionId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found');

    const session = snap.data();

    /* Verify device is in session or is admin */
    const isInSession = Object.values(session.devices || {}).some(d => d.uid === auth.uid);
    if (!isInSession && !_isAdmin(auth)) {
      throw new HttpsError('permission-denied', 'Not a member of this session');
    }

    return {
      sessionId:     session.sessionId,
      sellerName:    session.sellerName,
      shopName:      session.shopName,
      sellerLogo:    session.sellerLogo,
      status:        session.status,
      cart:          session.cart || {},
      cartTotal:     session.cartTotal,
      cartSubtotal:  session.cartSubtotal,
      cartTax:       session.cartTax,
      cartDiscount:  session.cartDiscount,
      cartItemCount: session.cartItemCount,
      devices:       session.devices || {},
      deviceCount:   session.deviceCount,
      currency:      session.currency || 'KES',
      cashDrawerOpen: session.cashDrawerOpen,
    };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 8 — removeDeviceFromSession (admin/manager action)
════════════════════════════════════════════════════════════ */
exports.removeDeviceFromSession = onCall(
  { region: 'us-central1', memory: '128MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const { sessionId, targetDeviceId } = request.data;
    if (!sessionId || !targetDeviceId) throw new HttpsError('invalid-argument', 'sessionId and targetDeviceId required');

    const ref  = fdb().collection('posSessions').doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found');

    const session = snap.data();
    if (session.sellerId !== auth.uid && !_isAdmin(auth)) {
      throw new HttpsError('permission-denied', 'Only the session owner can remove devices');
    }

    if (!session.devices?.[targetDeviceId]) {
      return { status: 'device_not_found' };
    }

    await ref.update({
      [`devices.${targetDeviceId}`]: _del(),
      deviceCount: _incr(-1),
      lastActivityAt: _now(),
    });

    return { status: 'removed' };
  }
);

/* ═══════════════════════════════════════════════════════════
   CF 9 — listActiveSessions (seller views their open sessions)
════════════════════════════════════════════════════════════ */
exports.listActiveSessions = onCall(
  { region: 'us-central1', memory: '128MiB' },
  async (request) => {
    const auth = request.auth;
    if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Login required');

    const sellerId = (_isAdmin(auth) && request.data?.sellerId) ? request.data.sellerId : auth.uid;

    const snap = await fdb().collection('posSessions')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'open')
      .orderBy('openedAt', 'desc')
      .limit(10)
      .get();

    const sessions = snap.docs.map(d => {
      const s = d.data();
      return {
        sessionId:    s.sessionId,
        sessionCode:  s.sessionCode,
        deviceCount:  s.deviceCount,
        cartTotal:    s.cartTotal,
        cartItemCount: s.cartItemCount,
        openedAt:     s.openedAt?.toMillis?.() || null,
      };
    });

    return { sessions };
  }
);

/* ═══════════════════════════════════════════════════════════
   Scheduled — Clean up stale open sessions (>24h with no activity)
════════════════════════════════════════════════════════════ */
exports.posSessionCleanup = onSchedule(
  { schedule: 'every 6 hours', region: 'us-central1', memory: '128MiB' },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const snap   = await fdb().collection('posSessions')
      .where('status', '==', 'open')
      .where('lastActivityAt', '<', cutoff)
      .limit(50)
      .get();

    const batch = fdb().batch();
    snap.docs.forEach(d => {
      batch.update(d.ref, { status: 'closed', closedAt: _now(), closeReason: 'auto_timeout' });
    });
    await batch.commit();
    console.log(`[posSessionCleanup] Closed ${snap.size} stale sessions`);
  }
);
