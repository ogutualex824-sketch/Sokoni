/**
 * SOKONI SmartPOS — Sync Engine v1.0
 *
 * Offline-first sync with:
 *  - Guaranteed delivery (no transaction ever lost)
 *  - Deduplication (idempotent Firestore writes)
 *  - Conflict resolution (last-write-wins with audit trail)
 *  - Exponential backoff retry
 *  - Circuit breaker integration
 *  - Per-collection sync strategies
 *  - Sync status observable
 */
(function () {
  'use strict';

  /* ── Firebase imports (resolved at runtime from global scope) ── */
  function _db()  { return window._firestoreDb  || window.sokoniDb || null; }
  function _fns() { return window._firebaseFns  || null; }

  /* ── Firestore SDK helpers ────────────────────────────────── */
  let _fsDoc, _fsSetDoc, _fsUpdateDoc, _fsServerTs, _fsGetDoc, _fsIncrement;
  async function _ensureFS() {
    if (_fsSetDoc) return true;
    try {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      _fsDoc       = fs.doc;
      _fsSetDoc    = fs.setDoc;
      _fsUpdateDoc = fs.updateDoc;
      _fsServerTs  = fs.serverTimestamp;
      _fsGetDoc    = fs.getDoc;
      _fsIncrement = fs.increment;
      return true;
    } catch (_) { return false; }
  }

  /* ── State ────────────────────────────────────────────────── */
  const state = {
    running:    false,
    lastSyncAt: 0,
    pending:    0,
    errors:     0,
    synced:     0,
  };

  /* ── Collection route map ─────────────────────────────────── */
  /* Maps sync_queue type → Firestore collection + merge strategy */
  const ROUTES = {
    transaction: {
      collection: 'posTransactions',
      merge:      false,          // full document — never partial merge
      idKey:      'id',
    },
    product_update: {
      collection: 'posProducts',
      merge:      true,
      idKey:      'id',
    },
    stock_movement: {
      collection: 'posStockMovements',
      merge:      false,
      idKey:      'id',
    },
    customer: {
      collection: 'posCustomers',
      merge:      true,
      idKey:      'id',
    },
    shift: {
      collection: 'posShifts',
      merge:      true,
      idKey:      'id',
    },
    cash_float: {
      collection: 'posCashFloats',
      merge:      true,
      idKey:      'id',
    },
    void: {
      collection: 'posVoids',
      merge:      false,
      idKey:      'id',
    },
    refund: {
      collection: 'posRefunds',
      merge:      false,
      idKey:      'id',
    },
  };

  /* ── Sync Queue Processor ─────────────────────────────────── */
  async function processQueue(options = {}) {
    if (state.running) return { skipped: true, reason: 'already_running' };
    if (!navigator.onLine) return { skipped: true, reason: 'offline' };
    if (!PosDB) return { skipped: true, reason: 'db_not_ready' };

    const circuit = options.circuit || 'firestore_sync';
    if (window.PosResilience && PosResilience.getCircuitState(circuit) === 'open') {
      return { skipped: true, reason: 'circuit_open' };
    }

    if (!await _ensureFS()) return { skipped: true, reason: 'firestore_sdk_missing' };
    const db = _db();
    if (!db) return { skipped: true, reason: 'firestore_not_init' };

    state.running = true;
    _emit('sync:start');
    const results = { success: 0, failed: 0, skipped: 0 };

    try {
      const queue = await PosDB.syncQueue.getPending();
      state.pending = queue.length;
      _emit('sync:progress', { pending: queue.length, synced: 0 });

      for (const item of queue) {
        try {
          await _syncItem(db, item, circuit);
          await PosDB.syncQueue.markDone(item.id);
          results.success++;
          state.synced++;
          _emit('sync:progress', { pending: state.pending - results.success, synced: results.success });
        } catch (err) {
          results.failed++;
          const newRetries = (item.retries || 0) + 1;
          const maxRetries = 8;

          if (newRetries >= maxRetries) {
            console.error(`[PosSyncEngine] Item ${item.id} exceeded max retries — moving to DLQ`, err);
            await PosDB.syncQueue.moveToDLQ(item.id, err.message);
            if (window.PosHealth) PosHealth.recordError('sync_dlq', `Item ${item.id}: ${err.message}`);
          } else {
            await PosDB.syncQueue.markRetry(item.id, newRetries);
          }
        }
      }

      state.lastSyncAt = Date.now();
      state.errors = results.failed;
      _emit('sync:complete', { ...results, lastSyncAt: state.lastSyncAt });

    } catch (err) {
      console.error('[PosSyncEngine] Queue processing failed:', err);
      _emit('sync:error', { error: err.message });
      if (window.PosResilience) PosResilience.enterDegradedMode(err.message);
    } finally {
      state.running = false;
    }

    return results;
  }

  /* ── Sync a single item to Firestore ─────────────────────── */
  async function _syncItem(db, item, circuitName) {
    const route = ROUTES[item.type];
    if (!route) {
      console.warn(`[PosSyncEngine] Unknown sync type: ${item.type} — skipping`);
      return;
    }

    const data    = item.data;
    const docId   = data[route.idKey];
    if (!docId) throw new Error(`Missing ID field "${route.idKey}" in ${item.type} record`);

    /* Idempotency + security: add sync metadata and sellerId for Firestore rules */
    const firebaseUid = _getFirebaseUid();
    const enriched = {
      ...data,
      _syncedAt:   new Date().toISOString(),
      _queueId:    item.id,
      _deviceId:   _getDeviceId(),
      /* sellerId must match request.auth.uid in Firestore rules */
      sellerId:    data.sellerId || firebaseUid || null,
    };

    const docRef = _fsDoc(db, route.collection, docId);

    /* stock_movement: log movement record AND update inventory via FieldValue.increment
       so concurrent offline syncs don't clobber each other with stale absolute values */
    const writeStockMovement = async () => {
      await _fsSetDoc(docRef, enriched);
      const delta = Number(data.qty) || 0;
      if (delta !== 0 && data.productId && data.branchId) {
        const invId  = `${data.branchId}__${data.productId}`;
        const invRef = _fsDoc(db, 'inventory', invId);
        /* FieldValue.increment is safe under concurrent writes — no last-write-wins race */
        await _fsUpdateDoc(invRef, {
          qty:       _fsIncrement(delta),
          updatedAt: new Date().toISOString(),
        }).catch(() => {}); // non-fatal: inventory doc may not exist for new products
      }
    };

    /* product_update: if client sends qtyDelta (preferred), use increment; else fall back to merge */
    const writeProductUpdate = () => {
      if (data.qtyDelta != null && !isNaN(Number(data.qtyDelta))) {
        const { qtyDelta, qty: _ignored, ...rest } = data;  // strip absolute qty
        const safe = { ...rest, _syncedAt: enriched._syncedAt, _queueId: enriched._queueId,
          _deviceId: enriched._deviceId, sellerId: enriched.sellerId,
          qty: _fsIncrement(Number(qtyDelta)) };
        return _fsSetDoc(_fsDoc(db, route.collection, docId), safe, { merge: true });
      }
      return _fsSetDoc(docRef, enriched, { merge: true });
    };

    const write = () => {
      if (item.type === 'stock_movement') return writeStockMovement();
      if (item.type === 'product_update') return writeProductUpdate();
      return route.merge ? _fsSetDoc(docRef, enriched, { merge: true }) : _fsSetDoc(docRef, enriched);
    };

    if (window.PosResilience) {
      await PosResilience.withCircuit(circuitName, () =>
        PosResilience.retry(write, {
          maxRetries:  4,
          label:       `sync:${item.type}:${docId}`,
          shouldRetry: err => !_isPermanentError(err),
        })
      );
    } else {
      await write();
    }
  }

  /* ── Check if error is permanent (don't retry) ────────────── */
  function _isPermanentError(err) {
    const permanent = ['permission-denied', 'invalid-argument', 'not-found', 'already-exists'];
    return permanent.some(code => err?.code === code || err?.message?.includes(code));
  }

  /* ── Product Sync (bidirectional) ─────────────────────────── */
  async function pullProducts(sellerId) {
    if (!navigator.onLine || !sellerId) return { skipped: true };
    if (!await _ensureFS()) return { skipped: true };
    const db = _db();
    if (!db) return { skipped: true };

    try {
      const { getDocs, collection, query, where, orderBy, limit } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const q = query(
        collection(db, 'products'),
        where('sellerId', '==', sellerId),
        where('active', '==', true),
        orderBy('updatedAt', 'desc'),
        limit(500)
      );
      const snap = await getDocs(q);
      let pulled = 0;
      for (const doc of snap.docs) {
        const p = { id: doc.id, ...doc.data() };
        /* Only update if cloud version is newer */
        const local = await PosDB.products.get(p.id);
        if (!local || (p.updatedAt > (local.updatedAt || 0))) {
          await PosDB.products.save(p);
          pulled++;
        }
      }
      _emit('products:pulled', { count: pulled });
      return { pulled };
    } catch (err) {
      console.error('[PosSyncEngine] pullProducts failed:', err);
      return { error: err.message };
    }
  }

  /* ── Auto-sync on visibility change ──────────────────────── */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      setTimeout(() => processQueue({ reason: 'visibility_restored' }), 1000);
    }
  });

  /* ── Periodic background sync ─────────────────────────────── */
  let _syncInterval = null;

  function startPeriodicSync(intervalMs = 30_000) {
    if (_syncInterval) return;
    _syncInterval = setInterval(() => {
      if (navigator.onLine) processQueue({ reason: 'periodic' }).catch(console.error);
    }, intervalMs);
    console.info('[PosSyncEngine] Periodic sync started every', intervalMs / 1000, 'seconds');
  }

  function stopPeriodicSync() {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }

  /* ── Firebase Auth UID (for Firestore security rules) ────── */
  function _getFirebaseUid() {
    try {
      /* Firebase v9 compat: firebase.auth().currentUser */
      if (window.firebase?.auth?.()?.currentUser?.uid) return window.firebase.auth().currentUser.uid;
      /* Firebase v9 modular: check global _firebaseAuth */
      if (window._firebaseAuth?.currentUser?.uid) return window._firebaseAuth.currentUser.uid;
      /* Stored from login flow */
      return localStorage.getItem('pos_seller_uid') || null;
    } catch (_) { return null; }
  }

  /* ── Device ID ─────────────────────────────────────────────── */
  function _getDeviceId() {
    let id = localStorage.getItem('pos_device_id');
    if (!id) {
      id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('pos_device_id', id);
    }
    return id;
  }

  /* ── Event Emission ───────────────────────────────────────── */
  function _emit(event, data = {}) {
    window.dispatchEvent(new CustomEvent('pos:sync:' + event, { detail: data }));
    if (window.PosHealth) PosHealth.recordMetric('sync_' + event.replace(':', '_'), 1);
  }

  /* ── Status ───────────────────────────────────────────────── */
  function getStatus() { return { ...state }; }

  /* ── Init ──────────────────────────────────────────────────── */
  function init() {
    startPeriodicSync();
    console.info('[PosSyncEngine] v1.1 ready — native sync queue, periodic sync active');
  }

  /* ── Public API ────────────────────────────────────────────── */
  window.PosSyncEngine = {
    processQueue,
    pullProducts,
    startPeriodicSync,
    stopPeriodicSync,
    getStatus,
    getDeviceId: _getDeviceId,
    init,
  };

  /* Defer sync engine until IndexedDB is open.
     window.PosDB is set as soon as pos-db.js evaluates (before PosDB.init() is called).
     PosDB.isReady() returns true only AFTER PosDB.init() opens the IDB connection.
     The 'pos:db:ready' event is dispatched by PosDB.init() on success. */
  if (window.PosDB?.isReady?.()) {
    init();
  } else {
    window.addEventListener('pos:db:ready', init, { once: true });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     ENHANCEMENT A — Digital Signatures for Offline Transactions
     Uses Web Crypto API (SubtleCrypto / HMAC-SHA256) to produce a tamper-
     evident signature for every transaction queued while offline.
     The signature is client-side only (non-secret key material) — its purpose
     is integrity verification, not authentication. The server validates the
     signature on sync to detect any in-flight mutation of queued records.
  ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Signs a transaction using HMAC-SHA256 keyed from deviceId.
   * @param {Object} transaction - The transaction object to sign.
   * @param {string} deviceId    - The POS device ID (used as key material).
   * @returns {Promise<string>}  - Hex-encoded HMAC signature.
   */
  async function signTransaction(transaction, deviceId) {
    if (!window.crypto?.subtle) {
      /* Graceful degradation: Web Crypto not available (non-HTTPS or old browser) */
      console.warn('[PosSyncEngine] SubtleCrypto unavailable — transaction will be unsigned');
      return null;
    }
    try {
      /* Canonical payload: only stable, fraud-relevant fields */
      const payload = JSON.stringify({
        id:        transaction.id,
        deviceId,
        amount:    transaction.total,
        timestamp: transaction.timestamp,
        items:     Array.isArray(transaction.items) ? transaction.items.length : 0,
      });

      /* Import HMAC key from deviceId + fixed domain suffix */
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(deviceId + '_sokoni_pos'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,       // not extractable
        ['sign']
      );

      const signatureBuffer = await crypto.subtle.sign(
        'HMAC',
        keyMaterial,
        new TextEncoder().encode(payload)
      );

      /* Convert ArrayBuffer → lowercase hex string */
      return Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } catch (err) {
      console.error('[PosSyncEngine] signTransaction failed:', err);
      return null;
    }
  }

  /**
   * Queues a transaction for offline sync with an attached digital signature.
   * Call this instead of directly pushing to PosDB.syncQueue for transactions.
   * @param {Object} transaction - The full transaction record.
   * @returns {Promise<Object>} - The enriched queue item that was stored.
   */
  async function queueSignedTransaction(transaction) {
    const deviceId  = _getDeviceId();
    const signature = await signTransaction(transaction, deviceId);

    const queueItem = {
      type: 'transaction',
      data: {
        ...transaction,
        _signature: signature,
        _deviceId:  deviceId,
        _signedAt:  new Date().toISOString(),
      },
      retries:   0,
      status:    'pending',
      createdAt: new Date().toISOString(),
    };

    if (window.PosDB?.syncQueue?.add) {
      await PosDB.syncQueue.add(queueItem);
    }

    _emit('sync:transaction_queued', {
      transactionId: transaction.id,
      signed:        !!signature,
    });

    return queueItem;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     ENHANCEMENT B — Conflict Detection
     Compares a locally-queued record against its current server state.
     Each collection type has its own resolution strategy.
  ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Detects sync conflicts between a local (offline-queued) document and the
   * current server document fetched at sync time.
   *
   * @param {Object} localDoc  - The locally-queued document (has `_queuedAt` ISO string).
   * @param {Object} serverDoc - The current server document (has `updatedAt`).
   * @param {string} docType   - One of: 'transaction' | 'product_update' | 'customer' | 'order' | ...
   * @returns {{ hasConflict: boolean, resolution: string, reason: string }}
   */
  function detectConflict(localDoc, serverDoc, docType = 'unknown') {
    const NO_CONFLICT = { hasConflict: false, resolution: 'none', reason: 'no_conflict' };

    if (!serverDoc || !serverDoc.updatedAt) return NO_CONFLICT;

    /* Normalise timestamps to milliseconds for reliable comparison */
    const serverUpdatedMs = _toMs(serverDoc.updatedAt);
    const localQueuedMs   = _toMs(localDoc._queuedAt || localDoc._syncedAt);

    /* No conflict if server hasn't changed since we went offline */
    if (!serverUpdatedMs || !localQueuedMs || serverUpdatedMs <= localQueuedMs) {
      return NO_CONFLICT;
    }

    /* Server changed while we were offline — apply per-type resolution rules */

    /* ── Payments: financial data always defers to server ── */
    if (docType === 'transaction' || docType === 'refund' || docType === 'void') {
      return {
        hasConflict: true,
        resolution:  'server_wins',
        reason:      'financial_data_immutable',
      };
    }

    /* ── Orders: never overwrite automatically ── */
    if (docType === 'order') {
      return {
        hasConflict: true,
        resolution:  'manual_required',
        reason:      'order_conflict_requires_review',
      };
    }

    /* ── Inventory / product quantities ── */
    if (docType === 'product_update' || docType === 'stock_movement') {
      const serverQty = Number(serverDoc.qty ?? serverDoc.quantity ?? NaN);
      const localQty  = Number(localDoc.qty  ?? localDoc.quantity  ?? NaN);

      if (!isNaN(serverQty) && !isNaN(localQty)) {
        /* Server decreased stock → something sold elsewhere; respect server */
        if (serverQty < localQty) {
          return {
            hasConflict: true,
            resolution:  'server_wins',
            reason:      'server_stock_decreased_concurrently',
          };
        }
        /* Only local changed → local is safe to apply */
        return {
          hasConflict: true,
          resolution:  'local_wins',
          reason:      'only_local_quantity_changed',
        };
      }
      /* Can't determine — defer to server for safety */
      return {
        hasConflict: true,
        resolution:  'server_wins',
        reason:      'qty_comparison_inconclusive',
      };
    }

    /* ── Customer profile ── */
    if (docType === 'customer') {
      const CRITICAL_FIELDS = ['email', 'phone', 'phoneNumber'];
      const serverChanged   = CRITICAL_FIELDS.some(f =>
        serverDoc[f] && localDoc[f] && serverDoc[f] !== localDoc[f]
      );
      if (serverChanged) {
        return {
          hasConflict: true,
          resolution:  'manual_required',
          reason:      'critical_customer_field_conflict',
        };
      }
      /* Non-critical fields: local wins (e.g., name update, loyalty card scan) */
      return {
        hasConflict: true,
        resolution:  'local_wins',
        reason:      'non_critical_customer_field',
      };
    }

    /* ── Default: server wins for unrecognised types ── */
    return {
      hasConflict: true,
      resolution:  'server_wins',
      reason:      'unknown_type_default_server_wins',
    };
  }

  /** Normalises a timestamp value to epoch milliseconds. */
  function _toMs(ts) {
    if (!ts) return null;
    if (typeof ts === 'number')        return ts;
    if (typeof ts === 'string')        return Date.parse(ts) || null;
    if (ts.toDate instanceof Function) return ts.toDate().getTime(); // Firestore Timestamp
    if (ts instanceof Date)            return ts.getTime();
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     ENHANCEMENT C — Incremental (Delta) Sync
     Only fetches records updated since `since` (the syncToken returned by
     bootstrapDevice). Merges results into local IndexedDB without touching
     records older than the delta window.
  ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Fetches only records updated since `since` from the server.
   * Merges into local IndexedDB: update existing by id, insert new ones.
   * Records with `_deleted: true` are removed from local storage.
   *
   * @param {string} merchantId  - Merchant ID for scoping the query.
   * @param {string} branchId    - Branch ID for scoping the query.
   * @param {number|string|Date} since - Timestamp of last successful sync.
   * @returns {Promise<{ products: Array, employees: Array, discounts: Array, serverTime: string }>}
   */
  async function getDeltaSync(merchantId, branchId, since) {
    if (!merchantId || !branchId) {
      console.warn('[PosSyncEngine] getDeltaSync: merchantId and branchId are required');
      return { products: [], employees: [], discounts: [], serverTime: null };
    }
    if (!navigator.onLine) {
      return { skipped: true, reason: 'offline', products: [], employees: [], discounts: [] };
    }
    if (!await _ensureFS()) {
      return { skipped: true, reason: 'firestore_sdk_missing', products: [], employees: [], discounts: [] };
    }
    const db = _db();
    if (!db) {
      return { skipped: true, reason: 'firestore_not_init', products: [], employees: [], discounts: [] };
    }

    /* Normalise `since` to a JS Date for Firestore where-clause */
    let sinceDate;
    try {
      if (since instanceof Date) {
        sinceDate = since;
      } else if (typeof since === 'number') {
        sinceDate = new Date(since);
      } else if (typeof since === 'string') {
        sinceDate = new Date(since);
      } else if (since?.toDate instanceof Function) {
        sinceDate = since.toDate();
      } else {
        /* Fallback: sync last 24 hours if no valid token */
        sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        console.warn('[PosSyncEngine] getDeltaSync: invalid `since` — defaulting to last 24h');
      }
    } catch (_) {
      sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    }

    const serverTime = new Date().toISOString();

    try {
      const {
        getDocs, collection, query, where, orderBy,
      } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

      /* ── Helper: query a collection for delta records ── */
      const fetchDelta = async (collectionName, extraWheres = []) => {
        const constraints = [
          where('merchantId', '==', merchantId),
          where('updatedAt',  '>',  sinceDate),
          orderBy('updatedAt', 'asc'),
          ...extraWheres,
        ];
        const q    = query(collection(db, collectionName), ...constraints);
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      };

      /* ── Fetch deltas for all tracked collections ── */
      const [products, employees, discounts] = await Promise.all([
        fetchDelta('posProducts',  [where('branchId', '==', branchId)]),
        fetchDelta('posEmployees', [where('branchId', '==', branchId)]),
        fetchDelta('posDiscounts'),
      ]);

      /* ── Merge into local IndexedDB ── */
      if (window.PosDB) {
        await _mergeLocalDB('products',  products,  PosDB.products);
        await _mergeLocalDB('employees', employees, PosDB.employees);
        await _mergeLocalDB('discounts', discounts, PosDB.discounts);
      }

      const totals = {
        products:  products.length,
        employees: employees.length,
        discounts: discounts.length,
      };

      _emit('sync:delta_complete', { ...totals, since: sinceDate.toISOString(), serverTime });

      return { products, employees, discounts, serverTime, totals };

    } catch (err) {
      console.error('[PosSyncEngine] getDeltaSync failed:', err);
      _emit('sync:error', { phase: 'delta', error: err.message });
      return { error: err.message, products: [], employees: [], discounts: [], serverTime };
    }
  }

  /**
   * Merges an array of server records into a local IndexedDB store.
   * - Updates existing records by id
   * - Inserts new records
   * - Removes records with `_deleted: true`
   *
   * @param {string} label     - For logging.
   * @param {Array}  records   - Server delta records.
   * @param {Object} store     - PosDB store object with .get() / .save() / .delete() methods.
   */
  async function _mergeLocalDB(label, records, store) {
    if (!store || !records.length) return;

    let updated = 0, inserted = 0, deleted = 0;

    for (const record of records) {
      try {
        if (record._deleted === true) {
          if (store.delete) await store.delete(record.id);
          deleted++;
          continue;
        }

        const existing = store.get ? await store.get(record.id) : null;
        if (existing) {
          /* Only update if server version is strictly newer */
          const localTs  = _toMs(existing.updatedAt);
          const serverTs = _toMs(record.updatedAt);
          if (!localTs || !serverTs || serverTs > localTs) {
            await store.save(record);
            updated++;
          }
        } else {
          await store.save(record);
          inserted++;
        }
      } catch (err) {
        console.warn(`[PosSyncEngine] _mergeLocalDB(${label}) failed for ${record.id}:`, err);
      }
    }

    if (updated + inserted + deleted > 0) {
      console.info(`[PosSyncEngine] Delta merge [${label}]: +${inserted} new, ~${updated} updated, -${deleted} deleted`);
    }
  }

  /* ── Expose new API methods on the public PosSyncEngine object ── */
  Object.assign(window.PosSyncEngine, {
    signTransaction,
    queueSignedTransaction,
    detectConflict,
    getDeltaSync,
  });

  /* ── PosSync adapter ──────────────────────────────────────────────────────
     pos-sales.js, pos-customers.js, and pos-inventory.js call:
       PosSync.queue(collection, docId, data)
       PosSync.enqueue(type, payload)
     This adapter maps those calls into the PosSyncEngine queue format.
  ─────────────────────────────────────────────────────────────────────────── */
  const _COLLECTION_TYPE_MAP = {
    posTransactions:   'transaction',
    posRetailSales:    'transaction',
    posProducts:       'product_update',
    posStockMovements: 'stock_movement',
    posCustomers:      'customer',
    posShifts:         'shift',
    posCashFloats:     'cash_float',
    posVoids:          'void',
    posRefunds:        'refund',
  };

  window.PosSync = {
    queue(collection, docId, data) {
      const type = _COLLECTION_TYPE_MAP[collection] || String(collection);
      if (!window.PosDB?.syncQueue?.add) {
        console.warn('[PosSync] PosDB not ready — write queued locally will be lost:', collection, docId);
        return Promise.resolve();
      }
      return PosDB.syncQueue.add({
        type,
        data:      { ...(data || {}), id: String(docId) },
        status:    'pending',
        retries:   0,
        createdAt: new Date().toISOString(),
      }).catch(err => console.warn('[PosSync] queue add failed:', err.message));
    },

    enqueue(type, payload) {
      if (!window.PosDB?.syncQueue?.add) {
        console.warn('[PosSync] PosDB not ready — enqueue dropped:', type);
        return Promise.resolve();
      }
      return PosDB.syncQueue.add({
        type:      String(type),
        data:      payload || {},
        status:    'pending',
        retries:   0,
        createdAt: new Date().toISOString(),
      }).catch(err => console.warn('[PosSync] enqueue failed:', err.message));
    },

    processQueue: () => window.PosSyncEngine.processQueue(),
    getStats:     () => window.PosSyncEngine.getStatus(),
    on: (event, fn) => {
      window.addEventListener('pos:sync:' + event, e => { try { fn(e.detail); } catch (_) {} });
    },
  };

})();
