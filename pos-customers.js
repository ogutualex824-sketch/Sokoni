/* ================================================================
   SOKONI POS Customer Management Engine v2.0
   Customer profiles, loyalty, wallet, credit, statements
================================================================ */
/* global firebase */
window.PosCustomers = (() => {
  'use strict';

  const DB_NAME = 'sokoni_pos_customers_v2';
  const DB_VER  = 1;
  const S = {
    CUSTOMERS:    'customers',
    TRANSACTIONS: 'customer_transactions', /* loyalty + wallet ledger */
    STATEMENTS:   'statements',
  };

  const LOYALTY_RATE = 1;   /* 1 point per KES 100 spent */
  const POINT_VALUE  = 0.5; /* 1 point = KES 0.50 */

  let _db        = null;
  let _listeners = {};
  let _online    = navigator.onLine;

  const uid = () => { try { return crypto.randomUUID(); } catch (_) { return Date.now().toString(36)+Math.random().toString(36).slice(2); } };
  function on(e, fn)  { (_listeners[e] = _listeners[e] || []).push(fn); }
  function off(e, fn) { if (_listeners[e]) _listeners[e] = _listeners[e].filter(f => f !== fn); }
  function emit(e, d) { (_listeners[e] || []).forEach(fn => { try { fn(d); } catch (_) {} }); }

  /* ── IndexedDB ── */
  async function _openDB() {
    if (_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        const mk = (name, opts, idxs) => {
          if (db.objectStoreNames.contains(name)) return;
          const st = db.createObjectStore(name, opts);
          (idxs || []).forEach(([n, k, o]) => st.createIndex(n, k, o));
        };
        mk(S.CUSTOMERS, { keyPath: 'id' }, [
          ['phone','phone',{unique:false}], ['email','email',{unique:false}],
          ['name','name',{unique:false}],
        ]);
        mk(S.TRANSACTIONS, { keyPath: 'id' }, [
          ['customerId','customerId',{unique:false}], ['type','type',{unique:false}],
          ['timestamp','timestamp',{unique:false}],
        ]);
        mk(S.STATEMENTS, { keyPath: 'id' }, [['customerId','customerId',{unique:false}]]);
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _put(store, rec) {
    const db = await _openDB();
    return new Promise((res, rej) => { const tx = db.transaction(store,'readwrite'); const req = tx.objectStore(store).put(rec); req.onsuccess=()=>res(req.result); req.onerror=e=>rej(e.target.error); });
  }
  async function _get(store, id) {
    const db = await _openDB();
    return new Promise((res, rej) => { const tx = db.transaction(store,'readonly'); const req = tx.objectStore(store).get(id); req.onsuccess=()=>res(req.result||null); req.onerror=e=>rej(e.target.error); });
  }
  async function _all(store, indexName, value) {
    const db = await _openDB();
    return new Promise((res, rej) => { const tx = db.transaction(store,'readonly'); const st = tx.objectStore(store); const req = indexName ? st.index(indexName).getAll(value) : st.getAll(); req.onsuccess=()=>res(req.result||[]); req.onerror=e=>rej(e.target.error); });
  }
  async function _indexGet(store, indexName, value) {
    const db = await _openDB();
    return new Promise((res, rej) => { const tx = db.transaction(store,'readonly'); const req = tx.objectStore(store).index(indexName).get(value); req.onsuccess=()=>res(req.result||null); req.onerror=e=>rej(e.target.error); });
  }

  /* ── Sync ── */
  function _sync(col, id, data) {
    if (!_online || !window.firebase?.firestore) return;
    firebase.firestore().collection(col).doc(id).set(data, { merge: true }).catch(() => {});
  }

  /* ══════════════════════════════════════════
     CUSTOMER CRUD
  ══════════════════════════════════════════ */
  async function addCustomer(data) {
    const c = {
      id:             data.id || uid(),
      name:           data.name || '',
      phone:          _normalizePhone(data.phone || ''),
      email:          (data.email || '').toLowerCase(),
      address:        data.address || '',
      dateOfBirth:    data.dateOfBirth || null,
      gender:         data.gender || '',
      notes:          data.notes || '',
      loyaltyPoints:  Number(data.loyaltyPoints) || 0,
      lifetimePoints: 0,
      walletBalance:  Number(data.walletBalance) || 0,
      creditLimit:    Number(data.creditLimit) || 0,
      creditBalance:  Number(data.creditBalance) || 0,
      totalSpent:     0,
      totalOrders:    0,
      lastPurchaseAt: null,
      tier:           'bronze',    /* bronze|silver|gold|platinum */
      tags:           data.tags || [],
      preferredPayment: data.preferredPayment || '',
      marketingOptIn: data.marketingOptIn !== false,
      joinedAt:       Date.now(),
      updatedAt:      Date.now(),
      syncedAt:       null,
    };
    await _put(S.CUSTOMERS, c);
    _sync('posCustomers', c.id, c);
    emit('customer:added', c);
    return c;
  }

  async function updateCustomer(id, partial) {
    const c = await _get(S.CUSTOMERS, id);
    if (!c) throw new Error('Customer not found');
    const updated = Object.assign({}, c, partial, { updatedAt: Date.now() });
    await _put(S.CUSTOMERS, updated);
    _sync('posCustomers', id, updated);
    emit('customer:updated', updated);
    return updated;
  }

  async function getCustomer(id)      { return _get(S.CUSTOMERS, id); }
  async function findByPhone(phone)   { return _indexGet(S.CUSTOMERS, 'phone', _normalizePhone(phone)); }
  async function findByEmail(email)   { return _indexGet(S.CUSTOMERS, 'email', email.toLowerCase()); }

  async function searchCustomers(q, limit = 50) {
    const all = await _all(S.CUSTOMERS);
    const lq  = q.toLowerCase();
    return all.filter(c =>
      c.name.toLowerCase().includes(lq) ||
      c.phone.includes(q) ||
      c.email.includes(lq)
    ).slice(0, limit);
  }

  async function getAllCustomers() { return _all(S.CUSTOMERS); }

  function _normalizePhone(p) { return String(p || '').replace(/\D/g, '').slice(-9); }
  function _tier(totalSpent) {
    if (totalSpent >= 500000) return 'platinum';
    if (totalSpent >= 100000) return 'gold';
    if (totalSpent >= 20000)  return 'silver';
    return 'bronze';
  }

  /* ══════════════════════════════════════════
     PURCHASE TRACKING (called by PosSales)
  ══════════════════════════════════════════ */
  async function recordPurchase(customerId, saleId, amount, loyaltyEarned = 0, loyaltyRedeemed = 0) {
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c) return;
    c.totalSpent     += amount;
    c.totalOrders    += 1;
    c.lastPurchaseAt  = Date.now();
    c.loyaltyPoints   = Math.max(0, c.loyaltyPoints + loyaltyEarned - loyaltyRedeemed);
    c.lifetimePoints  = (c.lifetimePoints || 0) + loyaltyEarned;
    c.tier            = _tier(c.totalSpent);
    c.updatedAt       = Date.now();
    await _put(S.CUSTOMERS, c);
    _sync('posCustomers', customerId, c);

    await _addTransaction({ customerId, type: 'purchase', amount, saleId, points: loyaltyEarned });
    if (loyaltyRedeemed > 0) await _addTransaction({ customerId, type: 'loyalty_redeem', amount: loyaltyRedeemed, saleId, points: -loyaltyRedeemed });
  }

  /* ══════════════════════════════════════════
     LOYALTY POINTS
  ══════════════════════════════════════════ */
  function calcLoyaltyPoints(subtotal) {
    return Math.floor(subtotal / 100 * LOYALTY_RATE);
  }

  function loyaltyPointsValue(points) {
    return points * POINT_VALUE;
  }

  async function getLoyaltyBalance(customerId) {
    const c = await _get(S.CUSTOMERS, customerId);
    return c ? c.loyaltyPoints : 0;
  }

  async function redeemLoyaltyPoints(customerId, points, saleId) {
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c) throw new Error('Customer not found');
    if (c.loyaltyPoints < points) throw new Error(`Insufficient loyalty points. Available: ${c.loyaltyPoints}`);
    c.loyaltyPoints -= points;
    c.updatedAt = Date.now();
    await _put(S.CUSTOMERS, c);
    _sync('posCustomers', customerId, c);
    await _addTransaction({ customerId, type: 'loyalty_redeem', amount: loyaltyPointsValue(points), saleId, points: -points });
    return c.loyaltyPoints;
  }

  async function adjustLoyaltyPoints(customerId, points, reason, performedBy) {
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c) throw new Error('Customer not found');
    c.loyaltyPoints = Math.max(0, c.loyaltyPoints + points);
    c.updatedAt = Date.now();
    await _put(S.CUSTOMERS, c);
    _sync('posCustomers', customerId, c);
    await _addTransaction({ customerId, type: 'loyalty_adjust', points, reason, performedBy });
  }

  /* ══════════════════════════════════════════
     WALLET
  ══════════════════════════════════════════ */
  async function getWalletBalance(customerId) {
    const c = await _get(S.CUSTOMERS, customerId);
    return c ? c.walletBalance : 0;
  }

  async function topUpWallet(customerId, amount, paymentMethod, reference, performedBy) {
    if (amount <= 0) throw new Error('Top-up amount must be positive');
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c) throw new Error('Customer not found');
    c.walletBalance += amount;
    c.updatedAt = Date.now();
    await _put(S.CUSTOMERS, c);
    _sync('posCustomers', customerId, c);
    await _addTransaction({ customerId, type: 'wallet_topup', amount, paymentMethod, reference, performedBy });
    emit('wallet:topup', { customerId, amount, balance: c.walletBalance });
    return c.walletBalance;
  }

  async function debitWallet(customerId, amount, saleId) {
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c) throw new Error('Customer not found');
    if (c.walletBalance < amount) throw new Error(`Insufficient wallet balance. Available: ${c.walletBalance}`);
    c.walletBalance -= amount;
    c.updatedAt = Date.now();
    await _put(S.CUSTOMERS, c);
    _sync('posCustomers', customerId, c);
    await _addTransaction({ customerId, type: 'wallet_debit', amount: -amount, saleId });
    return c.walletBalance;
  }

  /* ══════════════════════════════════════════
     CREDIT ACCOUNTS
  ══════════════════════════════════════════ */
  async function getCreditBalance(customerId) {
    const c = await _get(S.CUSTOMERS, customerId);
    return c ? { limit: c.creditLimit, balance: c.creditBalance, available: c.creditLimit - c.creditBalance } : null;
  }

  async function chargeCredit(customerId, amount, saleId) {
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c) throw new Error('Customer not found');
    const available = c.creditLimit - c.creditBalance;
    if (amount > available) throw new Error(`Credit limit exceeded. Available: KES ${available.toFixed(2)}`);
    c.creditBalance += amount;
    c.updatedAt = Date.now();
    await _put(S.CUSTOMERS, c);
    _sync('posCustomers', customerId, c);
    await _addTransaction({ customerId, type: 'credit_charge', amount, saleId });
    emit('credit:charged', { customerId, amount, balance: c.creditBalance });
  }

  async function recordCreditPayment(customerId, amount, paymentMethod, reference, performedBy) {
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c) throw new Error('Customer not found');
    c.creditBalance = Math.max(0, c.creditBalance - amount);
    c.updatedAt = Date.now();
    await _put(S.CUSTOMERS, c);
    _sync('posCustomers', customerId, c);
    await _addTransaction({ customerId, type: 'credit_payment', amount: -amount, paymentMethod, reference, performedBy });
    emit('credit:paid', { customerId, amount, balance: c.creditBalance });
    return c.creditBalance;
  }

  async function setCreditLimit(customerId, limit, authorizedBy) {
    return updateCustomer(customerId, { creditLimit: Number(limit) || 0 });
  }

  /* ══════════════════════════════════════════
     TRANSACTION LEDGER
  ══════════════════════════════════════════ */
  async function _addTransaction(data) {
    const tx = {
      id:           uid(),
      customerId:   data.customerId,
      type:         data.type,
      amount:       Number(data.amount) || 0,
      points:       Number(data.points) || 0,
      saleId:       data.saleId || null,
      reference:    data.reference || '',
      paymentMethod:data.paymentMethod || '',
      reason:       data.reason || '',
      performedBy:  data.performedBy || '',
      timestamp:    Date.now(),
    };
    await _put(S.TRANSACTIONS, tx);
    _sync('posCustomerTransactions', tx.id, tx);
    return tx;
  }

  async function getTransactions(customerId, limit = 100) {
    const all = await _all(S.TRANSACTIONS, 'customerId', customerId);
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /* ══════════════════════════════════════════
     CUSTOMER STATEMENTS
  ══════════════════════════════════════════ */
  async function generateStatement(customerId, from, until) {
    const c  = await _get(S.CUSTOMERS, customerId);
    if (!c) throw new Error('Customer not found');
    const txs = (await getTransactions(customerId, 999)).filter(t => t.timestamp >= from && t.timestamp <= until);
    let balance = 0;
    const lines = txs.reverse().map(t => {
      balance += t.amount;
      return { date: new Date(t.timestamp).toLocaleDateString('en-KE'), type: t.type, amount: t.amount, balance, reference: t.reference || t.saleId || '' };
    });
    return {
      customer: c,
      from:     new Date(from).toLocaleDateString('en-KE'),
      until:    new Date(until).toLocaleDateString('en-KE'),
      lines,
      closingBalance: balance,
      loyaltyPoints: c.loyaltyPoints,
      creditBalance:  c.creditBalance,
    };
  }

  /* ══════════════════════════════════════════
     PURCHASE HISTORY (from PosSales)
  ══════════════════════════════════════════ */
  async function getPurchaseHistory(customerId, limit = 50) {
    if (window.PosSales) return PosSales.getSales(null, { customerId, limit });
    return [];
  }

  /* ══════════════════════════════════════════
     RECEIPT DELIVERY
  ══════════════════════════════════════════ */
  async function sendSMSReceipt(customerId, saleData) {
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c || !c.phone) return false;
    /* Delegate to Cloud Function */
    if (_online && window.firebase?.functions) {
      try {
        const fn = firebase.functions().httpsCallable('sendPOSReceipt');
        await fn({ customerId, phone: c.phone, sale: saleData, channel: 'sms' });
        return true;
      } catch (_) {}
    }
    return false;
  }

  async function sendEmailReceipt(customerId, saleData) {
    const c = await _get(S.CUSTOMERS, customerId);
    if (!c || !c.email) return false;
    if (_online && window.firebase?.functions) {
      try {
        const fn = firebase.functions().httpsCallable('sendPOSReceipt');
        await fn({ customerId, email: c.email, sale: saleData, channel: 'email' });
        return true;
      } catch (_) {}
    }
    return false;
  }

  /* ══════════════════════════════════════════
     FIRESTORE SYNC (pull customers on init)
  ══════════════════════════════════════════ */
  async function syncFromFirestore(limit = 500) {
    const fsDb = window.firebase?.firestore?.();
    if (!fsDb) return;
    try {
      const snap = await fsDb.collection('posCustomers').orderBy('updatedAt', 'desc').limit(limit).get();
      for (const doc of snap.docs) {
        const data = { id: doc.id, ...doc.data() };
        await _put(S.CUSTOMERS, data);
      }
    } catch (_) {}
  }

  /* ══════════════════════════════════════════
     INIT
  ══════════════════════════════════════════ */
  async function init() {
    await _openDB();
    window.addEventListener('online',  () => { _online = true;  syncFromFirestore(200).catch(() => {}); });
    window.addEventListener('offline', () => { _online = false; });
    if (_online) syncFromFirestore(200).catch(() => {});
    emit('ready', {});
  }

  return {
    init, on, off,
    /* CRUD */
    addCustomer, updateCustomer, getCustomer, findByPhone, findByEmail,
    searchCustomers, getAllCustomers,
    /* Purchase tracking */
    recordPurchase, getPurchaseHistory,
    /* Loyalty */
    calcLoyaltyPoints, loyaltyPointsValue, getLoyaltyBalance,
    redeemLoyaltyPoints, adjustLoyaltyPoints,
    /* Wallet */
    getWalletBalance, topUpWallet, debitWallet,
    /* Credit */
    getCreditBalance, chargeCredit, recordCreditPayment, setCreditLimit,
    /* Transactions */
    getTransactions, generateStatement,
    /* Receipts */
    sendSMSReceipt, sendEmailReceipt,
    /* Constants */
    LOYALTY_RATE, POINT_VALUE,
  };
})();
