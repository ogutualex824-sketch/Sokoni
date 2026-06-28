/* ============================================================
   SOKONI SmartPOS 2.0 — Multi-Device Session Manager
   Real-time multi-device sync via Firestore listeners.
   Handles: cart sync, device presence, conflict resolution,
   payment status broadcasting, shift management.

   Usage:
     const session = await SokoniPosSession.create({ deviceName, role });
     // or
     const session = await SokoniPosSession.join({ code: '123456', deviceName });
     session.onUpdate(({ cart, devices, status }) => { ... });
     await session.addItem({ productId, name, price, qty });
     await session.removeItem(productId);
     await session.checkout();
============================================================ */
window.SokoniPosSession = (function () {
  'use strict';

  /* ── Config ── */
  var HEARTBEAT_INTERVAL_MS = 30_000; /* 30s heartbeat */
  var MAX_RETRY             = 3;

  /* ── State ── */
  var _sessionId   = null;
  var _deviceId    = null;
  var _unsubscribe = null;
  var _heartbeatT  = null;
  var _listeners   = [];
  var _state       = null;
  var _fn          = null;  /* Firebase callable getter */
  var _db          = null;  /* Firestore instance */

  /* ── Firebase callable helper ── */
  function _cf(name) {
    if (!_fn) {
      if (window.firebase && window.firebase.functions) {
        _fn = window.firebase.functions();
      } else if (window.SPos && window.SPos._firebase && window.SPos._firebase.functions) {
        _fn = window.SPos._firebase.functions();
      } else {
        throw new Error('Firebase not initialized');
      }
    }
    return _fn.httpsCallable(name);
  }

  function _firestoreDb() {
    if (!_db) {
      if (window.firebase && window.firebase.firestore) {
        _db = window.firebase.firestore();
      } else if (window.SPos && window.SPos._firebase && window.SPos._firebase.firestore) {
        _db = window.SPos._firebase.firestore();
      }
    }
    return _db;
  }

  /* ── Notify all listeners ── */
  function _emit(eventName, data) {
    _listeners.forEach(function (l) {
      if (!eventName || l._event === eventName || l._event === '*') {
        try { l._fn(data); } catch (e) { /* never crash on listener errors */ }
      }
    });
  }

  /* ── Start Firestore real-time listener ── */
  function _startListener() {
    if (_unsubscribe) _unsubscribe();
    var db = _firestoreDb();
    if (!db || !_sessionId) return;

    _unsubscribe = db.collection('posSessions').doc(_sessionId).onSnapshot(
      function (snap) {
        if (!snap.exists) {
          _emit('session_closed', { reason: 'deleted' });
          return;
        }
        var prev = _state;
        _state = snap.data();

        /* Emit specific events based on what changed */
        if (prev) {
          if (prev.status !== _state.status && _state.status === 'closed') {
            _emit('session_closed', { reason: _state.closeReason });
          }
          if (JSON.stringify(prev.cart) !== JSON.stringify(_state.cart)) {
            _emit('cart_updated', { cart: _state.cart, total: _state.cartTotal });
          }
          if (JSON.stringify(prev.devices) !== JSON.stringify(_state.devices)) {
            _emit('devices_changed', { devices: _state.devices, count: _state.deviceCount });
          }
          if (prev.cashDrawerOpen !== _state.cashDrawerOpen) {
            _emit('drawer_changed', { open: _state.cashDrawerOpen });
          }
        }

        _emit('update', _state);
      },
      function (err) {
        console.error('[PosSession] Listener error:', err.code || err.message);
        _emit('error', { code: err.code, message: err.message });
      }
    );
  }

  /* ── Start heartbeat ── */
  function _startHeartbeat() {
    clearInterval(_heartbeatT);
    _heartbeatT = setInterval(function () {
      if (!_sessionId || !_deviceId) return;
      _cf('posHeartbeat')({ sessionId: _sessionId, deviceId: _deviceId })
        .then(function (r) {
          if (r.data.status === 'session_closed') {
            _emit('session_closed', { reason: 'host_closed' });
            destroy();
          }
        })
        .catch(function () { /* network blip — ignore */ });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /* ── Create a new POS session ── */
  async function create(opts) {
    opts = opts || {};
    var result = await _cf('createPosSession')({
      deviceName:  opts.deviceName || 'Main POS',
      deviceType:  opts.deviceType || _detectDeviceType(),
      role:        opts.role || 'cashier',
      shiftId:     opts.shiftId || null,
    });

    _sessionId = result.data.sessionId;
    _deviceId  = result.data.deviceId;

    _startListener();
    _startHeartbeat();

    return {
      sessionId:   _sessionId,
      sessionCode: result.data.sessionCode,
      deviceId:    _deviceId,
    };
  }

  /* ── Join an existing session ── */
  async function join(opts) {
    opts = opts || {};
    var result = await _cf('joinPosSession')({
      sessionId:  opts.sessionId  || null,
      sessionCode: opts.code      || null,
      deviceName:  opts.deviceName || 'Secondary Device',
      deviceType:  opts.deviceType || _detectDeviceType(),
      role:        opts.role || 'cashier',
    });

    _sessionId = result.data.sessionId;
    _deviceId  = result.data.deviceId;

    _startListener();
    _startHeartbeat();

    return {
      sessionId:  _sessionId,
      deviceId:   _deviceId,
      sellerName: result.data.sellerName,
    };
  }

  /* ── Leave session (this device disconnects) ── */
  async function leave() {
    if (!_sessionId || !_deviceId) return;
    clearInterval(_heartbeatT);
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    try {
      await _cf('leavePosSession')({ sessionId: _sessionId, deviceId: _deviceId });
    } catch (e) { /* best-effort */ }
    _sessionId = null;
    _deviceId  = null;
    _state     = null;
  }

  /* ── Close session (all devices) — host only ── */
  async function close(reason) {
    if (!_sessionId) throw new Error('No active session');
    await _cf('closePosSession')({ sessionId: _sessionId, reason: reason || 'manual' });
    destroy();
  }

  /* ── Add item to shared cart ── */
  async function addItem(item) {
    if (!_sessionId) throw new Error('No active session');
    return _cf('updatePosCart')({ sessionId: _sessionId, action: 'add', item });
  }

  /* ── Remove item from shared cart ── */
  async function removeItem(productId) {
    if (!_sessionId) throw new Error('No active session');
    return _cf('updatePosCart')({ sessionId: _sessionId, action: 'remove', item: { productId } });
  }

  /* ── Update quantity ── */
  async function updateQty(productId, qty) {
    if (!_sessionId) throw new Error('No active session');
    return _cf('updatePosCart')({
      sessionId: _sessionId, action: 'update_qty',
      item: { productId, qty }
    });
  }

  /* ── Apply item discount ── */
  async function applyDiscount(productId, discount) {
    if (!_sessionId) throw new Error('No active session');
    return _cf('updatePosCart')({
      sessionId: _sessionId, action: 'apply_discount',
      item: { productId, discount }
    });
  }

  /* ── Clear cart ── */
  async function clearCart() {
    if (!_sessionId) throw new Error('No active session');
    return _cf('updatePosCart')({ sessionId: _sessionId, action: 'clear' });
  }

  /* ── Register event listener ── */
  /* Events: 'update', 'cart_updated', 'devices_changed', 'session_closed', 'drawer_changed', 'error', '*' */
  function on(event, fn) {
    _listeners.push({ _event: event, _fn: fn });
    return function () { /* unsubscribe */ _listeners = _listeners.filter(function (l) { return l._fn !== fn; }); };
  }

  /* ── Get current state snapshot ── */
  function getState() { return _state; }
  function getSessionId() { return _sessionId; }
  function getDeviceId() { return _deviceId; }
  function isActive() { return !!(  _sessionId && _state && _state.status === 'open'); }

  /* ── Destroy all local state ── */
  function destroy() {
    clearInterval(_heartbeatT);
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    _sessionId = null;
    _deviceId  = null;
    _state     = null;
    _listeners = [];
    _fn        = null;
    _db        = null;
  }

  /* ── Restore session from localStorage (survives page refresh) ── */
  function saveToStorage() {
    if (!_sessionId || !_deviceId) return;
    try {
      localStorage.setItem('_posSession', JSON.stringify({ sessionId: _sessionId, deviceId: _deviceId }));
    } catch (e) {}
  }

  async function restoreFromStorage() {
    try {
      var stored = JSON.parse(localStorage.getItem('_posSession') || 'null');
      if (!stored || !stored.sessionId || !stored.deviceId) return false;

      /* Verify session still open via CF */
      var result = await _cf('getPosSession')({ sessionId: stored.sessionId });
      if (result.data.status !== 'open') {
        localStorage.removeItem('_posSession');
        return false;
      }

      _sessionId = stored.sessionId;
      _deviceId  = stored.deviceId;
      _state     = result.data;

      _startListener();
      _startHeartbeat();
      return true;
    } catch (e) {
      localStorage.removeItem('_posSession');
      return false;
    }
  }

  /* ── Detect device type ── */
  function _detectDeviceType() {
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    if (/Mobile|iPhone|Android/i.test(ua)) return 'phone';
    return 'desktop';
  }

  /* ── Page unload — graceful leave ── */
  window.addEventListener('beforeunload', function () {
    saveToStorage();
    /* Attempt sync leave — fire and forget */
    if (_sessionId && _deviceId) {
      navigator.sendBeacon &&
        navigator.sendBeacon(
          '/api/posLeave',
          JSON.stringify({ sessionId: _sessionId, deviceId: _deviceId })
        );
    }
  });

  return {
    create, join, leave, close,
    addItem, removeItem, updateQty, applyDiscount, clearCart,
    on, getState, getSessionId, getDeviceId, isActive,
    saveToStorage, restoreFromStorage, destroy,
  };
}());
