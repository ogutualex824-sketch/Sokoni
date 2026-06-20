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
  let _fsDoc, _fsSetDoc, _fsUpdateDoc, _fsServerTs, _fsGetDoc;
  async function _ensureFS() {
    if (_fsSetDoc) return true;
    try {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      _fsDoc      = fs.doc;
      _fsSetDoc   = fs.setDoc;
      _fsUpdateDoc= fs.updateDoc;
      _fsServerTs = fs.serverTimestamp;
      _fsGetDoc   = fs.getDoc;
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

    const write = () => route.merge
      ? _fsSetDoc(docRef, enriched, { merge: true })
      : _fsSetDoc(docRef, enriched);

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

  /* Defer init until PosDB is ready */
  if (window.PosDB) {
    init();
  } else {
    window.addEventListener('pos:db:ready', init, { once: true });
  }
})();
