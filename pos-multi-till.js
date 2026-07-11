/* ================================================================
   SOKONI SmartPOS — Multi-Till Client SDK v1.0
   pos-multi-till.js

   Manages register identity, real-time till state broadcasting,
   live floor monitoring, and cross-till inventory awareness.

   Public API: window.PosMultiTill
     init(opts)                     — boot with merchant/branch context
     getRegisterId()                — this till's register ID
     getRegisterName()              — this till's display name
     setRegister(id, name)          — assign/change register (persists)
     broadcastState(state)          — push live state to Firestore (debounced)
     stopBroadcast()                — clean up on page unload
     getConfig()                    — current register config from Firestore
     watchFloor(fn)                 — onSnapshot live floor (manager view)
     unwatchFloor()                 — remove floor listener
     on(event, fn) / off(...)       — event subscriptions

   Firestore paths:
     posRegisters/{merchantId}_{registerId}   — static config
     posTillState/{merchantId}_{registerId}   — live till state (TTL: 5 min)
================================================================ */
'use strict';

(function (root) {

  /* ── Constants ──────────────────────────────────────────────────── */
  const LS_KEY_ID   = 'sokoni_register_id';
  const LS_KEY_NAME = 'sokoni_register_name';
  const BROADCAST_INTERVAL_MS = 15000;   // push state every 15 s
  const STATE_TTL_MS          = 300000;  // 5 min — stale tile hidden

  /* ── Module state ───────────────────────────────────────────────── */
  let _merchantId   = null;
  let _branchId     = null;
  let _registerId   = null;
  let _registerName = null;
  let _db           = null;     // Firestore instance
  let _broadcastTimer  = null;
  let _floorUnsubscribe= null;
  let _lastState    = null;
  let _sessionSales = 0;        // sales count this browser session
  let _sessionTotal = 0;        // total KES this browser session
  let _listeners    = {};

  /* ── Event emitter ──────────────────────────────────────────────── */
  const _emit = (ev, data) => (_listeners[ev] || []).forEach(fn => { try { fn(data); } catch (_) {} });

  /* ── Helpers ────────────────────────────────────────────────────── */
  function _tillDocId()  { return `${_merchantId}_${_registerId}`; }
  function _regDocId()   { return `${_merchantId}_${_registerId}`; }

  function _fs() {
    if (_db) return _db;
    if (root.firebase) { _db = root.firebase.firestore(); return _db; }
    return null;
  }

  /* ── Register assignment ────────────────────────────────────────── */
  function _loadFromStorage() {
    _registerId   = localStorage.getItem(LS_KEY_ID)   || _generateId();
    _registerName = localStorage.getItem(LS_KEY_NAME) || `Register ${_registerId.slice(-4)}`;
  }

  function _generateId() {
    const id = 'REG' + Math.random().toString(36).slice(2, 7).toUpperCase();
    localStorage.setItem(LS_KEY_ID, id);
    return id;
  }

  function _saveToStorage(id, name) {
    localStorage.setItem(LS_KEY_ID,   id);
    localStorage.setItem(LS_KEY_NAME, name || `Register ${id.slice(-4)}`);
  }

  /* ── State broadcasting ─────────────────────────────────────────── */
  let _broadcastDebounce = null;

  function _doBroadcast(state) {
    const fs = _fs();
    if (!fs || !_registerId || !_merchantId) return;
    const doc = {
      registerId:     _registerId,
      registerName:   _registerName,
      merchantId:     _merchantId,
      branchId:       _branchId,
      cashierId:      state.cashierId    || null,
      cashierName:    state.cashierName  || null,
      shiftId:        state.shiftId      || null,
      currentState:   state.currentState || 'IDLE',
      cartItemCount:  state.cartItemCount || 0,
      cartTotal:      state.cartTotal    || 0,
      salesCount:     _sessionSales,
      salesTotal:     _sessionTotal,
      printerStatus:  state.printerStatus  || 'unknown',
      drawerStatus:   state.drawerStatus   || 'unknown',
      scannerStatus:  state.scannerStatus  || 'unknown',
      online:         navigator.onLine,
      lastSeen:       root.firebase?.firestore.FieldValue.serverTimestamp() || new Date().toISOString(),
      clientTs:       Date.now(),
    };
    _lastState = doc;
    fs.collection('posTillState').doc(_tillDocId()).set(doc, { merge: true }).catch(() => {});
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  const PosMultiTill = {

    async init(opts = {}) {
      _merchantId = opts.merchantId || null;
      _branchId   = opts.branchId   || 'default';
      _loadFromStorage();

      // Override from opts if provided (setup flow)
      if (opts.registerId) {
        _registerId   = opts.registerId;
        _registerName = opts.registerName || _registerName;
        _saveToStorage(_registerId, _registerName);
      }

      // Start periodic state broadcast
      if (_broadcastTimer) clearInterval(_broadcastTimer);
      _broadcastTimer = setInterval(() => {
        if (_lastState) _doBroadcast(_lastState);
      }, BROADCAST_INTERVAL_MS);

      // Mark offline on page hide
      root.addEventListener('beforeunload', () => PosMultiTill.stopBroadcast());
      root.addEventListener('offline', () => {
        if (_lastState) _doBroadcast({ ..._lastState, online: false });
      });
      root.addEventListener('online', () => {
        if (_lastState) _doBroadcast({ ..._lastState, online: true });
      });

      _emit('ready', { registerId: _registerId, registerName: _registerName });
      return this;
    },

    getRegisterId()    { return _registerId; },
    getRegisterName()  { return _registerName; },
    getMerchantId()    { return _merchantId; },
    getBranchId()      { return _branchId; },

    setRegister(id, name) {
      _registerId   = id;
      _registerName = name || `Register ${id.slice(-4)}`;
      _saveToStorage(_registerId, _registerName);
      _emit('register_changed', { registerId: _registerId, registerName: _registerName });
      return this;
    },

    /* Called by pos-checkout.html on every state change */
    broadcastState(state = {}) {
      clearTimeout(_broadcastDebounce);
      _broadcastDebounce = setTimeout(() => _doBroadcast(state), 200);
    },

    /* Call after each completed sale */
    recordSale(total = 0) {
      _sessionSales++;
      _sessionTotal += total;
    },

    stopBroadcast() {
      clearInterval(_broadcastTimer);
      clearTimeout(_broadcastDebounce);
      const fs = _fs();
      if (fs && _registerId && _merchantId) {
        fs.collection('posTillState').doc(_tillDocId()).set(
          { online: false, currentState: 'OFFLINE', lastSeen: root.firebase?.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        ).catch(() => {});
      }
    },

    /* Load this register's static config from Firestore */
    async getConfig() {
      const fs = _fs();
      if (!fs || !_registerId || !_merchantId) return null;
      try {
        const snap = await fs.collection('posRegisters').doc(_regDocId()).get();
        return snap.exists ? snap.data() : null;
      } catch (_) { return null; }
    },

    /* Manager: subscribe to all till states for this merchant */
    watchFloor(fn) {
      const fs = _fs();
      if (!fs || !_merchantId) return;
      if (_floorUnsubscribe) _floorUnsubscribe();
      const cutoff = Date.now() - STATE_TTL_MS;
      _floorUnsubscribe = fs.collection('posTillState')
        .where('merchantId', '==', _merchantId)
        .where('clientTs', '>=', cutoff)
        .onSnapshot(snap => {
          const tills = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          fn(tills);
        }, () => {});
    },

    unwatchFloor() {
      if (_floorUnsubscribe) { _floorUnsubscribe(); _floorUnsubscribe = null; }
    },

    /* Manager: get all registers (static config) */
    async listRegisters() {
      const fs = _fs();
      if (!fs || !_merchantId) return [];
      try {
        const snap = await fs.collection('posRegisters')
          .where('merchantId', '==', _merchantId)
          .orderBy('registerName')
          .get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (_) { return []; }
    },

    on(ev, fn)  { (_listeners[ev] = _listeners[ev] || []).push(fn); return this; },
    off(ev, fn) {
      if (_listeners[ev]) _listeners[ev] = _listeners[ev].filter(f => f !== fn);
      return this;
    },

    get sessionSales() { return _sessionSales; },
    get sessionTotal() { return _sessionTotal; },
  };

  root.PosMultiTill = PosMultiTill;

})(window);
