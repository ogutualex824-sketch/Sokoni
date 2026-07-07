/* SOKONI SmartPOS — IndexedDB Offline Storage v1.0
   Full offline-first architecture: all data written locally first,
   synced to Firestore when online. No transaction is ever lost. */

const PosDB = (function () {
  'use strict';

  const DB_NAME    = 'sokoni_smartpos';
  const DB_VERSION = 4;
  let _db = null;

  /* SHA-256 via Web Crypto — used for PIN storage */
  async function _sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* One-time migration: hash any plaintext PINs still in IndexedDB */
  async function _migrateHashPins() {
    try {
      const all = await _getAll('cashiers');
      const plain = all.filter(c => c.pin && !/^[0-9a-f]{64}$/.test(c.pin));
      for (const c of plain) {
        c.pin = await _sha256(c.pin);
        await _put('cashiers', c);
      }
    } catch (_) { /* non-fatal — migration retries on next open */ }
  }

  /* ── Schema ──────────────────────────────────────────────────── */
  const SCHEMA = {
    /* v1 stores */
    products:            { keyPath: 'id', indexes: [['barcode','barcode',{unique:false}],['category','category'],['name','name'],['sku','sku',{unique:false}]] },
    transactions:        { keyPath: 'id', indexes: [['status','status'],['date','date'],['cashierId','cashierId'],['synced','synced']] },
    customers:           { keyPath: 'id', indexes: [['phone','phone',{unique:true}],['email','email',{unique:false}]] },
    suppliers:           { keyPath: 'id', indexes: [['name','name']] },
    purchase_orders:     { keyPath: 'id', indexes: [['status','status'],['supplierId','supplierId']] },
    cashiers:            { keyPath: 'id', indexes: [['pin','pin',{unique:false}]] },
    shifts:              { keyPath: 'id', indexes: [['status','status'],['cashierId','cashierId']] },
    receipts:            { keyPath: 'id', indexes: [['transactionId','transactionId']] },
    categories:          { keyPath: 'id' },
    stock_movements:     { keyPath: 'id', indexes: [['productId','productId'],['type','type']] },
    sync_queue:          { keyPath: 'id', autoIncrement: true, indexes: [['status','status'],['type','type']] },
    settings:            { keyPath: 'key' },
    /* v2 stores — Finance, Audit, Repair, Serial, Marketing, Attendance */
    expenses:            { keyPath: 'id', indexes: [['category','category'],['date','date']] },
    audit_logs:          { keyPath: 'id', indexes: [['action','action'],['ts','ts'],['cashierId','cashierId']] },
    repairs:             { keyPath: 'id', indexes: [['status','status'],['customerId','customerId']] },
    serial_numbers:      { keyPath: 'id', indexes: [['serial','serial',{unique:false}],['productId','productId'],['transactionId','transactionId']] },
    attendance:          { keyPath: 'id', indexes: [['employeeId','employeeId'],['date','date']] },
    marketing_campaigns: { keyPath: 'id', indexes: [['type','type'],['sentAt','sentAt']] },
    /* v4 stores — Terminal Management */
    devices:              { keyPath: 'id', indexes: [['type','type'],['status','status'],['tillId','tillId']] },
    terminal_assignments: { keyPath: 'id' },
    terminal_queue:       { keyPath: 'id', indexes: [['status','status'],['enqueuedAt','enqueuedAt']] },
  };

  /* ── Init ────────────────────────────────────────────────────── */
  function init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        _db = req.result;
        _migrateHashPins().then(resolve).catch(resolve);
      };
      req.onupgradeneeded = e => {
        const db = e.target.result;
        for (const [name, cfg] of Object.entries(SCHEMA)) {
          let store;
          if (!db.objectStoreNames.contains(name)) {
            store = cfg.autoIncrement
              ? db.createObjectStore(name, { keyPath: cfg.keyPath, autoIncrement: true })
              : db.createObjectStore(name, { keyPath: cfg.keyPath });
          } else {
            store = e.target.transaction.objectStore(name);
          }
          for (const [idxName, keyPath, opts] of (cfg.indexes || [])) {
            if (!store.indexNames.contains(idxName)) {
              store.createIndex(idxName, keyPath, opts || {});
            }
          }
        }
      };
    });
  }

  /* ── Low-level helpers ───────────────────────────────────────── */
  function _store(name, mode = 'readonly') {
    return _db.transaction([name], mode).objectStore(name);
  }

  function _getAll(store) {
    return new Promise((res, rej) => {
      const r = _store(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  function _getByIndex(store, idx, val) {
    return new Promise((res, rej) => {
      const r = _store(store).index(idx).getAll(IDBKeyRange.only(val));
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  function _get(store, key) {
    return new Promise((res, rej) => {
      const r = _store(store).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror   = () => rej(r.error);
    });
  }

  function _put(store, data) {
    return new Promise((res, rej) => {
      const r = _store(store, 'readwrite').put(data);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  function _delete(store, key) {
    return new Promise((res, rej) => {
      const r = _store(store, 'readwrite').delete(key);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  function _uid(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }

  /* ── Products ────────────────────────────────────────────────── */
  const products = {
    getAll:      ()         => _getAll('products'),
    getById:     id         => _get('products', id),
    getByBarcode:barcode    => _getByIndex('products', 'barcode', barcode).then(r => r[0] || null),
    getByCategory:cat       => _getByIndex('products', 'category', cat),

    /* ── In-memory search index ─────────────────────────────────
       Rebuilt on first search and after every save/adjustStock.
       Each entry: { id, tokens: Set<string>, ...product }
       Token set is a union of name/barcode/sku/category word fragments
       for prefix matching without a full-scan IDB read.         */
    _index: null,

    _buildIndex: async () => {
      const all = await _getAll('products');
      products._index = all.map(p => ({
        ...p,
        _tokens: [
          p.name        || '',
          p.barcode     || '',
          p.sku         || '',
          p.category    || '',
          p.description || '',
        ].join(' ').toLowerCase(),
      }));
    },

    _invalidateIndex: () => { products._index = null; },

    search: async query => {
      if (!products._index) await products._buildIndex();
      if (!query || !query.trim()) return products._index.map(p => ({ ...p }));
      const q = query.toLowerCase().trim();
      return products._index.filter(p => p._tokens.includes(q) || p._tokens.startsWith(q) || products._tokenMatch(p._tokens, q));
    },

    _tokenMatch: (tokens, q) => tokens.split(' ').some(t => t.startsWith(q)) || tokens.includes(q),

    save: p => {
      if (!p.id) p.id = _uid('prd');
      p.updatedAt = Date.now();
      products._invalidateIndex();
      return _put('products', p).then(() => p);
    },

    delete: id => { products._invalidateIndex(); return _delete('products', id); },

    adjustStock: async (id, delta, reason, cashierId) => {
      const p = await _get('products', id);
      if (!p) return null;
      const before = p.stock || 0;
      p.stock = Math.max(0, before + delta);
      p.updatedAt = Date.now();
      products._invalidateIndex();
      await _put('products', p);
      await stock_movements.save({
        productId: id,
        productName: p.name,
        type: delta > 0 ? 'in' : 'out',
        qty: Math.abs(delta),
        before,
        after: p.stock,
        reason: reason || 'adjustment',
        cashierId,
      });
      return p;
    },

    get:    id => _get('products', id),
    add:    p  => products.save(p),
    update: async (id, data) => {
      const p = await _get('products', id);
      if (!p) return null;
      return _put('products', { ...p, ...data, id, updatedAt: Date.now() });
    },

    getLowStock: async (threshold) => {
      const all = await _getAll('products');
      return all.filter(p => {
        const limit = threshold || p.lowStockThreshold || 5;
        return p.stock !== undefined && p.stock <= limit;
      });
    },

    getExpiringSoon: async (days = 30) => {
      const all = await _getAll('products');
      const cutoff = Date.now() + days * 86400000;
      return all.filter(p => p.expiryDate && new Date(p.expiryDate).getTime() <= cutoff);
    },

    seedDemo: async () => {
      /* Safety gate: never run in production — requires explicit opt-in flag */
      if (localStorage.getItem('pos_demo_mode') !== '1') return;
      const existing = await _getAll('products');
      if (existing.length > 0) return;
      const demos = [
        { id:'prd_demo_1', name:'Unga Pembe 2kg',   barcode:'6183000000001', category:'cat_food',      price:230,  cost:190, stock:48, unit:'bag',   taxRate:0   },
        { id:'prd_demo_2', name:'Cooking Oil 2L',   barcode:'6183000000002', category:'cat_food',      price:380,  cost:310, stock:32, unit:'bottle', taxRate:0   },
        { id:'prd_demo_3', name:'Sugar 1kg',        barcode:'6183000000003', category:'cat_food',      price:155,  cost:125, stock:60, unit:'kg',     taxRate:0   },
        { id:'prd_demo_4', name:'Blue Band 500g',   barcode:'6183000000004', category:'cat_food',      price:145,  cost:115, stock:24, unit:'tub',    taxRate:0   },
        { id:'prd_demo_5', name:'Bread Supersloaf', barcode:'6183000000005', category:'cat_food',      price:65,   cost:50,  stock:15, unit:'piece',  taxRate:0   },
        { id:'prd_demo_6', name:'Milk Fresha 500ml',barcode:'6183000000006', category:'cat_food',      price:65,   cost:52,  stock:40, unit:'packet', taxRate:0   },
        { id:'prd_demo_7', name:'Colgate 75ml',     barcode:'6183000000007', category:'cat_personal',  price:115,  cost:88,  stock:20, unit:'piece',  taxRate:16  },
        { id:'prd_demo_8', name:'Sunlight Bar 800g',barcode:'6183000000008', category:'cat_cleaning',  price:95,   cost:72,  stock:30, unit:'bar',    taxRate:16  },
        { id:'prd_demo_9', name:'Panadol 500mg x10',barcode:'6183000000009', category:'cat_pharma',    price:55,   cost:38,  stock:50, unit:'strip',  taxRate:0   },
        { id:'prd_demo_10',name:'Pencil Box',       barcode:'6183000000010', category:'cat_stationery',price:45,   cost:28,  stock:25, unit:'piece',  taxRate:16  },
      ];
      for (const p of demos) { p.updatedAt = Date.now(); await _put('products', p); }
    },
  };

  /* ── Transactions ────────────────────────────────────────────── */
  const transactions = {
    getAll:    ()         => _getAll('transactions'),
    getById:   id         => _get('transactions', id),
    getUnsynced: async () => {
      const all = await _getAll('transactions');
      return all.filter(t => !t.synced && t.status === 'completed');
    },

    getByDateRange: async (startTs, endTs) => {
      const all = await _getAll('transactions');
      return all.filter(t => {
        const ts = t.completedAt || t.timestamp;
        return ts >= startTs && ts <= endTs;
      });
    },

    save: t => {
      if (!t.id) t.id = _uid('txn');
      const now = Date.now();
      if (!t.timestamp)   t.timestamp = now;
      if (!t.date)        t.date = new Date().toISOString().split('T')[0];
      if (t.status === 'completed' && !t.completedAt) t.completedAt = now;
      return _put('transactions', t).then(() => t);
    },

    markSynced: async id => {
      const t = await _get('transactions', id);
      if (t) { t.synced = true; return _put('transactions', t); }
    },

    get: id => _get('transactions', id),
    add: t  => transactions.save(t),
  };

  /* ── Customers ───────────────────────────────────────────────── */
  const customers = {
    getAll:    ()      => _getAll('customers'),
    getById:   id      => _get('customers', id),
    getByPhone:phone   => _getByIndex('customers', 'phone', phone).then(r => r[0] || null),

    search: async query => {
      const all = await _getAll('customers');
      if (!query) return all;
      const q = query.toLowerCase();
      return all.filter(c =>
        c.name?.toLowerCase().includes(q) ||
        c.phone?.includes(q) ||
        c.email?.toLowerCase().includes(q)
      );
    },

    save: c => {
      if (!c.id) c.id = _uid('cust');
      c.updatedAt = Date.now();
      return _put('customers', c).then(() => c);
    },

    get:    id => _get('customers', id),
    add:    c  => customers.save(c),
    update: async (id, data) => {
      const c = await _get('customers', id);
      return _put('customers', { ...c, ...data, id, updatedAt: Date.now() });
    },

    recordPurchase: async (id, amount, pointsEarned) => {
      const c = await _get('customers', id);
      if (!c) return;
      c.totalSpent  = (c.totalSpent  || 0) + amount;
      c.visits      = (c.visits      || 0) + 1;
      c.points      = (c.points      || 0) + (pointsEarned || 0);
      c.lastVisit   = Date.now();
      c.updatedAt   = Date.now();
      return _put('customers', c);
    },
  };

  /* ── Categories ──────────────────────────────────────────────── */
  const categories = {
    getAll: () => _getAll('categories'),
    save:   c  => { if (!c.id) c.id = _uid('cat'); return _put('categories', c); },
    delete: id => _delete('categories', id),

    seedDefaults: async () => {
      const existing = await _getAll('categories');
      if (existing.length > 0) return;
      const defaults = [
        { id:'cat_all',       name:'All Items',    icon:'📦', color:'#6366f1' },
        { id:'cat_food',      name:'Food & Drinks',icon:'🍎', color:'#22c55e' },
        { id:'cat_electronics',name:'Electronics', icon:'💻', color:'#3b82f6' },
        { id:'cat_pharma',    name:'Pharmacy',     icon:'💊', color:'#ef4444' },
        { id:'cat_cleaning',  name:'Cleaning',     icon:'🧹', color:'#f59e0b' },
        { id:'cat_personal',  name:'Personal Care',icon:'🪥', color:'#a8ff58' },
        { id:'cat_stationery',name:'Stationery',   icon:'📝', color:'#06b6d4' },
        { id:'cat_clothing',  name:'Clothing',     icon:'👕', color:'#f43f5e' },
        { id:'cat_wholesale', name:'Wholesale',    icon:'🏭', color:'#d97706' },
      ];
      for (const c of defaults) await _put('categories', c);
    },
  };

  /* ── Cashiers ────────────────────────────────────────────────── */
  const cashiers = {
    getAll:  () => _getAll('cashiers'),
    getById: id => _get('cashiers', id),

    authenticate: async pin => {
      const hashed = await _sha256(pin);
      const all = await _getAll('cashiers');
      return all.find(c => c.pin === hashed && c.active !== false) || null;
    },

    save: async c => {
      if (!c.id) c.id = _uid('cashier');
      /* Hash PIN unless it is already a SHA-256 hex digest */
      if (c.pin && !/^[0-9a-f]{64}$/.test(c.pin)) c.pin = await _sha256(c.pin);
      c.updatedAt = Date.now();
      return _put('cashiers', c).then(() => c);
    },

    delete: id => _delete('cashiers', id),
  };

  /* ── Shifts ──────────────────────────────────────────────────── */
  const shifts = {
    getAll: () => _getAll('shifts'),

    getCurrent: async cashierId => {
      const all = await _getAll('shifts');
      return all.find(s => s.status === 'open' && (!cashierId || s.cashierId === cashierId)) || null;
    },

    open: (cashierId, cashierName, openAmount) => {
      const shift = {
        id: _uid('shift'),
        cashierId,
        cashierName,
        openTime:         Date.now(),
        openAmount:       openAmount || 0,
        status:           'open',
        transactionCount: 0,
        totalSales:       0,
        totalCash:        0,
        totalMpesa:       0,
        totalCard:        0,
        totalDiscount:    0,
        totalRefunds:     0,
      };
      return _put('shifts', shift).then(() => shift);
    },

    update: s => _put('shifts', s),

    close: async (shiftId, closeAmount) => {
      const s = await _get('shifts', shiftId);
      if (!s) return null;
      s.status      = 'closed';
      s.closeTime   = Date.now();
      s.closeAmount = closeAmount || 0;
      s.variance    = (closeAmount || 0) - (s.openAmount + s.totalCash);
      await _put('shifts', s);
      return s;
    },

    addTransaction: async (shiftId, txn) => {
      const s = await _get('shifts', shiftId);
      if (!s) return;
      s.transactionCount++;
      s.totalSales    += txn.total || 0;
      s.totalDiscount += txn.discountAmount || 0;
      const pm = txn.paymentMethod || 'cash';
      if (pm === 'cash')  s.totalCash  += txn.total || 0;
      if (pm === 'mpesa') s.totalMpesa += txn.total || 0;
      if (pm === 'card')  s.totalCard  += txn.total || 0;
      return _put('shifts', s);
    },
  };

  /* ── Stock Movements ─────────────────────────────────────────── */
  const stock_movements = {
    getAll:        ()  => _getAll('stock_movements'),
    getByProduct:  pid => _getByIndex('stock_movements', 'productId', pid),

    save: m => {
      if (!m.id) m.id = _uid('mov');
      m.timestamp = Date.now();
      return _put('stock_movements', m);
    },
  };

  /* ── Suppliers ───────────────────────────────────────────────── */
  const suppliers = {
    getAll: ()  => _getAll('suppliers'),
    getById: id => _get('suppliers', id),
    save: s => {
      if (!s.id) s.id = _uid('sup');
      s.updatedAt = Date.now();
      return _put('suppliers', s).then(() => s);
    },
    delete: id => _delete('suppliers', id),
  };

  /* ── Purchase Orders ─────────────────────────────────────────── */
  const purchase_orders = {
    getAll:    ()     => _getAll('purchase_orders'),
    getById:   id     => _get('purchase_orders', id),
    getByStatus: status => _getByIndex('purchase_orders', 'status', status),

    save: po => {
      if (!po.id) po.id = _uid('po');
      po.updatedAt = Date.now();
      return _put('purchase_orders', po).then(() => po);
    },

    receive: async (id, receivedItems) => {
      const po = await _get('purchase_orders', id);
      if (!po) return;
      po.status = 'received';
      po.receivedAt = Date.now();
      for (const item of receivedItems) {
        await products.adjustStock(item.productId, item.qty, 'purchase_order:' + id, 'system');
      }
      return _put('purchase_orders', po);
    },
  };

  /* ── Settings ────────────────────────────────────────────────── */
  const settings = {
    get:    key  => _get('settings', key).then(r => r ? r.value : null),
    getAll: async () => {
      const all = await _getAll('settings');
      return Object.fromEntries(all.map(s => [s.key, s.value]));
    },
    set:    (key, value) => _put('settings', { key, value }),
    setMany: async obj => {
      for (const [k, v] of Object.entries(obj)) await _put('settings', { key: k, value: v });
    },
    delete: key => _delete('settings', key),
  };

  /* ── Receipts ────────────────────────────────────────────────── */
  const receipts = {
    getAll:          ()    => _getAll('receipts'),
    getById:         id    => _get('receipts', id),
    getByTransaction:tid   => _getByIndex('receipts', 'transactionId', tid).then(r => r[0] || null),
    save: r => {
      if (!r.id) r.id = _uid('rcpt');
      r.timestamp = Date.now();
      return _put('receipts', r).then(() => r);
    },
  };

  /* ── Sync Queue ──────────────────────────────────────────────── */
  const syncQueue = {
    add:      (type, data) => _put('sync_queue', { type, data, timestamp: Date.now(), retries: 0, status: 'pending' }),
    getAll:   ()           => _getAll('sync_queue'),
    markDone: id           => _delete('sync_queue', id),

    getPending: async () => {
      const all = await _getAll('sync_queue');
      /* Include 'pending' and 'retry' status; exclude dead-lettered items */
      return all.filter(i => (i.status === 'pending' || i.status === 'retry') && i.status !== 'dead');
    },

    markRetry: async (id, retryCount) => {
      const item = await _get('sync_queue', id);
      if (!item) return;
      item.retries    = retryCount != null ? retryCount : (item.retries || 0) + 1;
      item.status     = 'retry';
      item.lastError  = item.lastError || null;
      item.retriedAt  = Date.now();
      return _put('sync_queue', item);
    },

    moveToDLQ: async (id, reason) => {
      const item = await _get('sync_queue', id);
      if (!item) return;
      item.status    = 'dead';
      item.dlqReason = String(reason || 'max_retries').slice(0, 500);
      item.dlqAt     = Date.now();
      return _put('sync_queue', item);
    },

    getDLQ: async () => {
      const all = await _getAll('sync_queue');
      return all.filter(i => i.status === 'dead');
    },

    /* Legacy alias kept so existing callers don't break */
    markFailed: async id => {
      const item = await _get('sync_queue', id);
      if (item) {
        item.retries++;
        item.status = item.retries >= 8 ? 'dead' : 'retry';
        return _put('sync_queue', item);
      }
    },
  };

  /* ── Reports helpers ─────────────────────────────────────────── */
  const reports = {
    forDateRange: async (startTs, endTs) => {
      const all  = await transactions.getByDateRange(startTs, endTs);
      const done = all.filter(t => t.status === 'completed');
      const r = {
        count:    done.length,
        total:    0, tax: 0, discount: 0,
        cash: 0, mpesa: 0, card: 0,
        items: {},
      };
      done.forEach(t => {
        r.total    += t.total    || 0;
        r.tax      += t.taxAmount || 0;
        r.discount += t.discountAmount || 0;
        const pm = t.paymentMethod || 'cash';
        if (pm === 'cash')  r.cash  += t.total || 0;
        if (pm === 'mpesa') r.mpesa += t.total || 0;
        if (pm === 'card')  r.card  += t.total || 0;
        (t.items || []).forEach(item => {
          if (!r.items[item.id]) r.items[item.id] = { name: item.name, qty: 0, revenue: 0, profit: 0 };
          r.items[item.id].qty     += item.qty;
          r.items[item.id].revenue += item.qty * item.price;
          r.items[item.id].profit  += item.qty * (item.price - (item.cost || 0));
        });
      });
      r.profit = r.total - done.reduce((s, t) => s + (t.costTotal || 0), 0);
      r.topProducts = Object.values(r.items).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
      return r;
    },

    today: () => {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end   = new Date(); end.setHours(23, 59, 59, 999);
      return reports.forDateRange(start.getTime(), end.getTime());
    },
  };

  /* ── Generic store factory for v2 new stores ─────────────────── */
  function _makeStore(storeName) {
    return {
      getAll:  ()        => _getAll(storeName),
      get:     id        => _get(storeName, id),
      add:     data => {
        if (!data.id) data.id = _uid(storeName.slice(0, 4));
        data.createdAt = data.createdAt || Date.now();
        return _put(storeName, data).then(() => data.id);
      },
      update:  async (id, patch) => {
        const existing = await _get(storeName, id);
        if (!existing) return null;
        return _put(storeName, { ...existing, ...patch, id, updatedAt: Date.now() });
      },
      delete:  id        => _delete(storeName, id),
      save:    data => {
        if (!data.id) data.id = _uid(storeName.slice(0, 4));
        return _put(storeName, data).then(() => data.id);
      },
    };
  }

  /* ── Expenses ────────────────────────────────────────────────── */
  const expenses = _makeStore('expenses');

  /* ── Audit Logs ──────────────────────────────────────────────── */
  const audit_logs = _makeStore('audit_logs');

  /* ── Repairs ─────────────────────────────────────────────────── */
  const repairs = _makeStore('repairs');

  /* ── Serial Numbers ──────────────────────────────────────────── */
  const serial_numbers = _makeStore('serial_numbers');

  /* ── Marketing Campaigns ─────────────────────────────────────── */
  const marketing_campaigns = _makeStore('marketing_campaigns');

  /* ── Terminal Devices / Assignments / Queue ──────────────────── */
  const devices              = _makeStore('devices');
  const terminal_assignments = _makeStore('terminal_assignments');
  const terminal_queue       = _makeStore('terminal_queue');

  /* ── Attendance ──────────────────────────────────────────────── */
  const attendance = {
    ..._makeStore('attendance'),

    getActiveEntry: async employeeId => {
      const all = await _getAll('attendance');
      return all.find(a => a.employeeId === employeeId && !a.clockOut) || null;
    },

    getForEmployee: async (employeeId, startTs, endTs) => {
      const all = await _getAll('attendance');
      return all.filter(a => {
        if (a.employeeId !== employeeId) return false;
        if (startTs && a.clockIn < startTs) return false;
        if (endTs   && a.clockIn > endTs)   return false;
        return true;
      });
    },
  };

  return {
    init,
    products, transactions, customers, categories,
    cashiers, shifts, suppliers, purchase_orders,
    stock_movements, receipts, syncQueue, settings, reports,
    /* v2 */
    expenses, audit_logs, repairs, serial_numbers, attendance, marketing_campaigns,
    /* v4 */
    devices, terminal_assignments, terminal_queue,
    /* Low-level helpers exposed for enterprise modules (pos-sync, pos-health) */
    _get, _put, _delete, _getAll,
  };
})();

window.PosDB = PosDB;
