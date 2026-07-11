/* ================================================================
   SOKONI SmartPOS — Enterprise Cash Register Manager v1.0
   pos-cash-manager.js

   Full cash lifecycle:  denomination counting, event-sourced live
   balance, change calculation, safe drops, manager approval,
   offline-first queue, shift open/close with variance.

   Depends on CashDrawer (sokoni-cash-drawer.js) for hardware.

   Public API:  window.PosRegister
     init(opts)
     isOpen() / getSession() / getShiftId()
     openRegister(opts)          — denomination float + device check
     closeRegister(opts)         — denomination count + variance
     recordCashSale(cents, ref)  — auto-called on cash finalize
     recordCashRefund(cents, reason, ref)
     cashIn(opts)                — float topup / petty cash / misc
     cashOut(opts)               — petty cash / supplier / safe drop
     safeDrop(opts)              — formal safe drop workflow
     getLiveBalance()            — all components, computed from events
     getVariance(countedDenoms)  — expected vs counted
     calcDenomTotal(denoms)      — KES × qty → total cents
     calcChange(totalCents, receivedCents) → { changeCents, breakdown }
     DENOMS, DENOM_LABELS, CASH_IN_CATS, CASH_OUT_CATS
     on(ev, fn) / off(ev, fn)
================================================================ */
'use strict';

(function (root) {

  /* ── KES Denominations ─────────────────────────────────────────── */
  const DENOMS = [1000, 500, 200, 100, 50, 20, 10, 5, 1];
  const DENOM_LABELS = {
    1000: 'KES 1,000 note', 500: 'KES 500 note', 200: 'KES 200 note',
    100:  'KES 100 note',    50: 'KES 50 note',    20: 'KES 20 coin',
    10:   'KES 10 coin',      5: 'KES 5 coin',      1: 'KES 1 coin',
  };

  /* ── Event types ───────────────────────────────────────────────── */
  const EV = {
    OPEN:    'register_open',
    CLOSE:   'register_close',
    SALE:    'cash_sale',
    REFUND:  'cash_refund',
    IN:      'cash_in',
    OUT:     'cash_out',
    DROP:    'safe_drop',
    PICKUP:  'cash_pickup',
    ADJUST:  'float_adjustment',
  };
  const VALID_EV = new Set(Object.values(EV));

  /* ── Categories ────────────────────────────────────────────────── */
  const CASH_IN_CATS  = ['float_topup','petty_cash_return','bank_change','misc_deposit','other'];
  const CASH_OUT_CATS = ['petty_cash','supplier_payment','safe_drop','bank_deposit','emergency','other'];
  const CAT_LABELS = {
    float_topup: 'Float Top-Up', petty_cash_return: 'Petty Cash Return',
    bank_change: 'Change from Bank', misc_deposit: 'Miscellaneous Deposit',
    petty_cash: 'Petty Cash', supplier_payment: 'Supplier Payment',
    safe_drop: 'Safe Drop', bank_deposit: 'Bank Deposit',
    emergency: 'Emergency Removal', other: 'Other',
  };

  /* ── Default variance tolerance (KES) ─────────────────────────── */
  const DEFAULT_TOLERANCE_KES = 50;

  /* ── Blank session ─────────────────────────────────────────────── */
  function _blank() {
    return {
      id: null, shiftId: null, registerId: null, registerName: null,
      cashierId: null, cashierName: null, merchantId: null, branchId: 'default',
      openedAt: null, closedAt: null, status: 'closed',
      openingFloatCents: 0, openingDenoms: {},
      devices: {}, approvedBy: null, approvedAt: null,
      events: [],
    };
  }

  /* ── Module state ──────────────────────────────────────────────── */
  let _s   = _blank();
  let _idb = null;
  let _ls  = {};   // listener map

  /* ── Event emitter ─────────────────────────────────────────────── */
  const _emit = (ev, d) => (_ls[ev] || []).forEach(fn => { try { fn(d); } catch(_){} });

  /* ── IndexedDB ─────────────────────────────────────────────────── */
  function _openIDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('sokoni_cash_mgr_v1', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        ['sessions','queue'].forEach(name => {
          if (!db.objectStoreNames.contains(name))
            db.createObjectStore(name, name === 'sessions'
              ? { keyPath: 'id' } : { autoIncrement: true, keyPath: '_qk' });
        });
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror   = () => rej(req.error);
    });
  }

  function _idbGet(store, key) {
    return new Promise((res, rej) => {
      if (!_idb) return res(null);
      const tx  = _idb.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  function _idbPut(store, val) {
    return new Promise((res, rej) => {
      if (!_idb) return res();
      const tx  = _idb.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(val);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  function _idbAdd(store, val) {
    return new Promise((res, rej) => {
      if (!_idb) return res();
      const tx  = _idb.transaction(store, 'readwrite');
      const req = tx.objectStore(store).add(val);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  /* ── Persist session (IDB + localStorage) ──────────────────────── */
  async function _save() {
    if (!_s.id) return;
    await _idbPut('sessions', { ..._s }).catch(() => {});
    try {
      localStorage.setItem('sokoni_cash_session', JSON.stringify({
        id: _s.id, shiftId: _s.shiftId, registerId: _s.registerId,
        merchantId: _s.merchantId, status: _s.status,
        openingFloatCents: _s.openingFloatCents,
      }));
    } catch(_) {}
  }

  async function _loadFromIDB(sessionId) {
    const data = await _idbGet('sessions', sessionId).catch(() => null);
    if (data && data.status === 'open') { _s = data; return true; }
    return false;
  }

  /* ── Offline queue ─────────────────────────────────────────────── */
  async function _enqueue(cfName, data) {
    await _idbAdd('queue', { cfName, data, ts: Date.now() }).catch(() => {});
  }

  async function _syncQueue() {
    if (!_idb || !navigator.onLine) return;
    try {
      const tx    = _idb.transaction('queue', 'readwrite');
      const store = tx.objectStore('queue');
      const items = await new Promise(res => {
        const r = store.getAll(); r.onsuccess = () => res(r.result || []);
      });
      if (!items.length) return;
      const fns = root.firebase?.functions();
      if (!fns) return;
      for (const item of items) {
        try {
          await fns.httpsCallable(item.cfName)(item.data);
          store.delete(item._qk);
        } catch(_) { /* retry next time */ }
      }
    } catch(_) {}
  }

  /* ── Live balance (event sourcing) ─────────────────────────────── */
  function _compute(session) {
    let openingFloat = session.openingFloatCents || 0;
    let cashSales = 0, cashRefunds = 0, cashIn = 0, cashOut = 0,
        safeDrops = 0, cashPickups = 0, adjustments = 0;

    for (const ev of (session.events || [])) {
      switch (ev.type) {
        case EV.SALE:    cashSales    += ev.amountCents; break;
        case EV.REFUND:  cashRefunds  += ev.amountCents; break;
        case EV.IN:      cashIn       += ev.amountCents; break;
        case EV.OUT:     cashOut      += ev.amountCents; break;
        case EV.DROP:    safeDrops    += ev.amountCents; break;
        case EV.PICKUP:  cashPickups  += ev.amountCents; break;
        case EV.ADJUST:  adjustments  += (ev.adjustmentCents || 0); break;
      }
    }

    const expected = openingFloat + cashSales - cashRefunds
                   + cashIn - cashOut - safeDrops - cashPickups + adjustments;
    return {
      openingFloat, cashSales, cashRefunds, cashIn,
      cashOut, safeDrops, cashPickups, adjustments, expected,
    };
  }

  /* ── CF call helper ─────────────────────────────────────────────── */
  async function _cf(name, data) {
    const fns = root.firebase?.functions();
    if (!fns) return null;
    try {
      const res = await fns.httpsCallable(name)(data);
      return res.data;
    } catch (_) { return null; }
  }

  /* ── Add event helper ──────────────────────────────────────────── */
  async function _addEvent(type, amountCents, extra = {}) {
    if (!PosRegister.isOpen()) throw new Error('Register is not open');
    const ev = {
      type, amountCents: Math.round(amountCents),
      shiftId:      _s.shiftId,
      registerId:   _s.registerId,
      merchantId:   _s.merchantId,
      branchId:     _s.branchId,
      cashierId:    _s.cashierId,
      cashierName:  _s.cashierName,
      clientTs:     Date.now(),
      ...extra,
    };
    _s.events.push(ev);
    await _save();
    await _enqueue('cmRecordCashEvent', ev);
    if (navigator.onLine) _syncQueue();
    _emit('balance_changed', PosRegister.getLiveBalance());
    return ev;
  }

  /* ════════════════════════════════════════════════════════════════
     Public API
  ════════════════════════════════════════════════════════════════ */
  const PosRegister = {
    DENOMS, DENOM_LABELS, EV,
    CASH_IN_CATS, CASH_OUT_CATS, CAT_LABELS,
    DEFAULT_TOLERANCE_KES,

    /* ── Init ────────────────────────────────────────────────────── */
    async init(opts = {}) {
      _idb = await _openIDB().catch(() => null);

      // Try to restore in-progress session
      if (opts.merchantId && opts.registerId) {
        const sessionId = `${opts.merchantId}_${opts.registerId}`;
        const restored  = await _loadFromIDB(sessionId);
        if (!restored) {
          _s = _blank();
          _s.merchantId  = opts.merchantId;
          _s.branchId    = opts.branchId || 'default';
          _s.registerId  = opts.registerId;
          _s.registerName= opts.registerName || opts.registerId;
        }
      }

      root.addEventListener('online', () => _syncQueue());
      _emit('ready', _s);
      return this;
    },

    isOpen()       { return _s.status === 'open'; },
    getSession()   { return { ..._s }; },
    getShiftId()   { return _s.shiftId; },
    getRegisterId(){ return _s.registerId; },

    /* ── Denomination helpers ─────────────────────────────────────── */
    calcDenomTotal(denoms = {}) {
      return DENOMS.reduce((sum, d) =>
        sum + d * (Math.max(0, parseInt(denoms[d]) || 0)) * 100, 0);
    },

    /* KES string (e.g. "KES 1,234.00") */
    formatKES(cents) {
      return 'KES ' + (cents / 100).toLocaleString('en-KE',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    /* ── Change calculation with denomination breakdown ─────────── */
    calcChange(totalCents, receivedCents) {
      const changeCents = Math.round(receivedCents - totalCents);
      if (changeCents < 0) return { changeCents: 0, changeKES: 0, breakdown: {}, insufficient: true };
      const breakdown = {};
      let rem = changeCents;
      for (const d of DENOMS) {
        const dCents = d * 100;
        const qty    = Math.floor(rem / dCents);
        if (qty > 0) { breakdown[d] = qty; rem -= qty * dCents; }
      }
      return { changeCents, changeKES: changeCents / 100, breakdown, insufficient: false };
    },

    /* ── Variance ─────────────────────────────────────────────────── */
    getVariance(countedDenoms = {}) {
      const bal      = _compute(_s);
      const expected = bal.expected;
      const counted  = this.calcDenomTotal(countedDenoms);
      const variance = counted - expected;
      return {
        expectedCents:  expected,
        countedCents:   counted,
        varianceCents:  variance,
        varianceKES:    variance / 100,
        status:         variance === 0 ? 'balanced' : variance > 0 ? 'over' : 'short',
        pctVariance:    expected !== 0 ? Math.abs(variance / expected) * 100 : 0,
        requiresExplanation: Math.abs(variance / 100) > DEFAULT_TOLERANCE_KES,
      };
    },

    /* ── Live balance ─────────────────────────────────────────────── */
    getLiveBalance() { return _compute(_s); },

    /* ── Open register ────────────────────────────────────────────── */
    async openRegister(opts = {}) {
      const {
        cashierId, cashierName, registerId, registerName, merchantId, branchId,
        denoms = {}, approvedBy = null, devices = {},
      } = opts;

      if (!merchantId || !registerId || !cashierId)
        throw new Error('merchantId, registerId, and cashierId are required');

      if (this.isOpen())
        throw new Error('Register is already open — close current shift first');

      const shiftId    = `${merchantId}_${registerId}_${Date.now()}`;
      const floatCents = this.calcDenomTotal(denoms);

      _s = {
        ..._blank(),
        id:                `${merchantId}_${registerId}`,
        shiftId,
        merchantId,
        branchId:          branchId || 'default',
        registerId,
        registerName:      registerName || registerId,
        cashierId,
        cashierName,
        openedAt:          new Date().toISOString(),
        status:            'open',
        openingFloatCents: floatCents,
        openingDenoms:     { ...denoms },
        approvedBy,
        devices,
        events:            [],
      };

      await _save();
      await _enqueue('cmRecordCashEvent', {
        type:         EV.OPEN,
        shiftId,      merchantId, branchId: _s.branchId,
        registerId,   cashierId, cashierName,
        amountCents:  floatCents,
        openingDenoms: denoms,
        approvedBy,   devices,
        reason:       'Register opened',
        clientTs:     Date.now(),
      });
      if (navigator.onLine) _syncQueue();

      _emit('register_opened', { ..._s });
      return { ok: true, shiftId, floatCents };
    },

    /* ── Cash events ──────────────────────────────────────────────── */
    recordCashSale(amountCents, transactionRef = '') {
      return _addEvent(EV.SALE, amountCents, { transactionRef });
    },

    recordCashRefund(amountCents, reason = '', transactionRef = '') {
      return _addEvent(EV.REFUND, amountCents, { reason, transactionRef });
    },

    cashIn(opts = {}) {
      const { amountCents, category = 'other', reason = '', note = '', approvedBy = null } = opts;
      if (!amountCents || amountCents <= 0) throw new Error('Amount must be greater than zero');
      if (!CASH_IN_CATS.includes(category)) throw new Error('Invalid category');
      return _addEvent(EV.IN, amountCents, { category, reason, note, approvedBy });
    },

    cashOut(opts = {}) {
      const { amountCents, category = 'other', reason = '', note = '', approvedBy = null } = opts;
      if (!amountCents || amountCents <= 0) throw new Error('Amount must be greater than zero');
      if (!CASH_OUT_CATS.includes(category)) throw new Error('Invalid category');
      return _addEvent(EV.OUT, amountCents, { category, reason, note, approvedBy });
    },

    safeDrop(opts = {}) {
      const { amountCents, safeLocation = '', witness = '', note = '', approvedBy = null } = opts;
      if (!amountCents || amountCents <= 0) throw new Error('Amount must be greater than zero');
      return _addEvent(EV.DROP, amountCents, { safeLocation, witness, note, approvedBy });
    },

    /* ── Close register ───────────────────────────────────────────── */
    async closeRegister(opts = {}) {
      if (!this.isOpen()) throw new Error('No open register to close');

      const {
        countedDenoms = {}, varianceExplanation = '',
        approvedBy = null, note = '',
      } = opts;

      const bal      = _compute(_s);
      const counted  = this.calcDenomTotal(countedDenoms);
      const variance = this.getVariance(countedDenoms);

      const closeEv = {
        type:              EV.CLOSE,
        amountCents:       counted,
        shiftId:           _s.shiftId,
        merchantId:        _s.merchantId,
        branchId:          _s.branchId,
        registerId:        _s.registerId,
        cashierId:         _s.cashierId,
        cashierName:       _s.cashierName,
        expectedCents:     bal.expected,
        varianceCents:     variance.varianceCents,
        varianceExplanation,
        countedDenoms,     approvedBy,
        note,              clientTs: Date.now(),
      };

      _s.events.push(closeEv);
      _s.status              = 'closed';
      _s.closedAt            = new Date().toISOString();
      _s.closingCountedCents = counted;
      _s.closingDenoms       = { ...countedDenoms };
      _s.varianceCents       = variance.varianceCents;

      await _save();
      await _enqueue('cmRecordCashEvent', closeEv);
      if (navigator.onLine) _syncQueue();

      const closed = { ..._s };
      _s = _blank();
      try { localStorage.removeItem('sokoni_cash_session'); } catch(_) {}

      _emit('register_closed', { session: closed, variance, balance: bal });
      return { ok: true, variance, balance: bal };
    },

    /* ── Server reports ───────────────────────────────────────────── */
    async getShiftReport(shiftId) {
      return _cf('cmGetShiftReport', { shiftId: shiftId || _s.shiftId,
        merchantId: _s.merchantId, registerId: _s.registerId });
    },

    async getEndOfDay(merchantId, branchId, dateStr) {
      return _cf('cmGetEndOfDay', { merchantId, branchId, dateStr });
    },

    /* ── Queue sync (called externally on reconnect) ─────────────── */
    syncQueue: _syncQueue,

    /* ── Event subscriptions ──────────────────────────────────────── */
    on (ev, fn) { (_ls[ev] = _ls[ev] || []).push(fn); return this; },
    off(ev, fn) {
      if (_ls[ev]) _ls[ev] = _ls[ev].filter(f => f !== fn);
      return this;
    },
  };

  root.PosRegister = PosRegister;

})(window);
