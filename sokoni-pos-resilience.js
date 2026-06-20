/**
 * SOKONI SmartPOS Resilience Engine v1.0
 * Phase 4: Offline transaction queue for SmartPOS (pos.html).
 * Queues sales transactions locally when offline, syncs automatically
 * on reconnect with duplicate prevention (idempotency keys).
 *
 * Usage:
 *   SokoniPOSResilience.registerSyncHandler(async txData => serverRef);
 *   const localId = await SokoniPOSResilience.queueTransaction({ amount, items, ... });
 *   SokoniPOSResilience.startHeartbeat(status => updateUI(status));
 */
const SokoniPOSResilience = (function () {
  "use strict";

  const DB_NAME   = "sokoni_pos_v1";
  const TX_STORE  = "transactions";
  const ACK_STORE = "acks";
  const VERSION   = 1;

  const MAX_RETRIES       = 5;
  const HEARTBEAT_INTERVAL = 30000;
  const SYNC_BATCH        = 15;

  let _db          = null;
  let _syncing     = false;
  let _heartbeatId = null;
  let _syncHandler = null;
  let _heartbeatCb = null;

  /* ── IndexedDB ──────────────────────────────────────────── */
  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(TX_STORE)) {
          const s = db.createObjectStore(TX_STORE, { keyPath: "localId" });
          s.createIndex("status",    "status");
          s.createIndex("timestamp", "timestamp");
        }
        if (!db.objectStoreNames.contains(ACK_STORE)) {
          db.createObjectStore(ACK_STORE, { keyPath: "idemKey" });
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* ── Lightweight obfuscation for sensitive cart data at rest ── */
  const _K = 0x3F;
  function _enc(str) {
    return btoa(String.fromCharCode(...[...str].map(c => c.charCodeAt(0) ^ _K)));
  }
  function _dec(b64) {
    try {
      return [...atob(b64)].map(c => String.fromCharCode(c.charCodeAt(0) ^ _K)).join("");
    } catch { return b64; }
  }

  /* ── Core operations ────────────────────────────────────── */
  async function _put(store_name, item) {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store_name, "readwrite").objectStore(store_name).put(item);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function _get(store_name, key) {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store_name, "readonly").objectStore(store_name).get(key);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function _del(store_name, key) {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store_name, "readwrite").objectStore(store_name).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function _getPendingTx() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const rows = [];
      db.transaction(TX_STORE, "readonly")
        .objectStore(TX_STORE)
        .index("status")
        .openCursor(IDBKeyRange.only("pending"))
        .onsuccess = e => {
          const c = e.target.result;
          if (c && rows.length < SYNC_BATCH) {
            const v = c.value;
            if (!v.nextRetryAt || v.nextRetryAt <= Date.now()) rows.push(v);
            c.continue();
          } else {
            resolve(rows.sort((a, b) => a.timestamp - b.timestamp));
          }
        };
    });
  }

  /* ── Public API ─────────────────────────────────────────── */
  async function queueTransaction(txData) {
    /* Generate a stable idempotency key from POS terminal + timestamp */
    const idemKey = txData.idemKey || `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    /* Reject if already acknowledged on server */
    const ack = await _get(ACK_STORE, idemKey);
    if (ack) return { localId: ack.localId, serverRef: ack.serverRef, duplicate: true };

    const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      localId,
      idemKey,
      status:     "pending",
      timestamp:  Date.now(),
      retries:    0,
      payload:    _enc(JSON.stringify(txData)),
      amount:     txData.amount || 0,
      type:       txData.type   || "sale",
    };

    await _put(TX_STORE, item);
    _scheduleSync(300);
    return { localId, idemKey, queued: true };
  }

  function registerSyncHandler(fn) { _syncHandler = fn; }

  async function sync() {
    if (_syncing || !navigator.onLine || !_syncHandler) return { synced: 0, failed: 0 };
    _syncing = true;
    let synced = 0, failed = 0;

    try {
      const pending = await _getPendingTx();
      for (const item of pending) {
        /* Mark in-flight */
        await _put(TX_STORE, { ...item, status: "syncing" });

        let txData;
        try { txData = JSON.parse(_dec(item.payload)); }
        catch { await _del(TX_STORE, item.localId); continue; }

        txData.idemKey = item.idemKey;
        txData.localId = item.localId;

        try {
          const serverRef = await _syncHandler(txData);

          /* Record ACK so this idemKey is never re-sent */
          await _put(ACK_STORE, { idemKey: item.idemKey, serverRef, localId: item.localId, ackedAt: Date.now() });
          await _del(TX_STORE, item.localId);
          synced++;
        } catch (err) {
          const retries = item.retries + 1;
          if (retries > MAX_RETRIES) {
            await _put(TX_STORE, { ...item, status: "failed", retries, error: String(err.message).slice(0, 200) });
          } else {
            const delay = Math.min(1000 * Math.pow(2, retries) + Math.random() * 500, 120000);
            await _put(TX_STORE, { ...item, status: "pending", retries, nextRetryAt: Date.now() + delay });
          }
          failed++;
        }
      }
    } finally {
      _syncing = false;
    }

    return { synced, failed };
  }

  async function getPendingCount() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(TX_STORE, "readonly")
        .objectStore(TX_STORE)
        .index("status")
        .count(IDBKeyRange.only("pending"));
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function getStats() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const counts = { pending: 0, syncing: 0, synced: 0, failed: 0, total: 0 };
      db.transaction(TX_STORE, "readonly")
        .objectStore(TX_STORE)
        .openCursor()
        .onsuccess = e => {
          const c = e.target.result;
          if (c) {
            counts[c.value.status] = (counts[c.value.status] || 0) + 1;
            counts.total++;
            c.continue();
          } else resolve(counts);
        };
    });
  }

  /* ── Heartbeat ───────────────────────────────────────────── */
  function startHeartbeat(cb) {
    _heartbeatCb = cb || _heartbeatCb;
    if (_heartbeatId) clearInterval(_heartbeatId);
    _heartbeatId = setInterval(async () => {
      const stats  = await getStats();
      const status = {
        online:    navigator.onLine,
        pending:   stats.pending,
        failed:    stats.failed,
        total:     stats.total,
        timestamp: Date.now(),
      };
      if (_heartbeatCb) _heartbeatCb(status);
      if (navigator.onLine && stats.pending > 0) sync();
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (_heartbeatId) { clearInterval(_heartbeatId); _heartbeatId = null; }
  }

  /* ── Reconciliation: re-queue all failed items ───────────── */
  async function requeue() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      let count = 0;
      db.transaction(TX_STORE, "readwrite")
        .objectStore(TX_STORE)
        .index("status")
        .openCursor(IDBKeyRange.only("failed"))
        .onsuccess = e => {
          const c = e.target.result;
          if (c) {
            const item  = c.value;
            item.status  = "pending";
            item.retries = 0;
            item.nextRetryAt = Date.now();
            delete item.error;
            c.update(item);
            count++;
            c.continue();
          } else {
            resolve(count);
            _scheduleSync(500);
          }
        };
    });
  }

  function _scheduleSync(delay) {
    setTimeout(() => { if (navigator.onLine) sync(); }, delay);
  }

  window.addEventListener("online",  () => _scheduleSync(800));
  window.addEventListener("offline", () => { _syncing = false; });

  return { queueTransaction, registerSyncHandler, sync, getPendingCount, getStats, startHeartbeat, stopHeartbeat, requeue };
})();

if (typeof module !== "undefined") module.exports = SokoniPOSResilience;
