/**
 * SOKONI Hardware Persistence v1.0
 * Phase 9 — Hardware Abstraction Layer
 *
 * Single IndexedDB database for all hardware configuration.
 * Replaces the 15+ localStorage keys spread across the old stack.
 *
 * Database: sokoni_hw_v1
 * Stores:
 *   printers    — saved printer configurations
 *   sessions    — last-active printer per device
 *   diagnostics — historical diagnostic snapshots
 *
 * Printer record schema:
 *   id           {string}  — UUID v4
 *   transport    {string}  — 'usb'|'bluetooth'|'serial'|'network'|'browser'
 *   model        {string}  — detected or user-supplied model name
 *   paperWidth   {string}  — '58mm'|'76mm'|'80mm'
 *   escposProfile {string} — 'standard'|'p58e'|'star'|'zpl'|'cpcl'
 *   vendorId     {number}  — USB vendor ID (USB only)
 *   productId    {number}  — USB product ID (USB only)
 *   deviceId     {string}  — BT device ID / name (BT only)
 *   networkHost  {string}  — IP or hostname (network only)
 *   networkPort  {number}  — TCP port (network only)
 *   serialFilters {object} — serialPort.getInfo() snapshot (serial only)
 *   lastConnected {string} — ISO timestamp
 *   lastPrintAt  {string}  — ISO timestamp
 *   printCount   {number}
 *   isDefault    {boolean}
 *   label        {string}  — user-supplied friendly name
 */

(function (global) {
    'use strict';

    var DB_NAME    = 'sokoni_hw_v1';
    var DB_VERSION = 1;
    var STORES = {
        PRINTERS:    'printers',
        SESSIONS:    'sessions',
        DIAGNOSTICS: 'diagnostics',
    };

    // ---------------------------------------------------------------------------
    // IndexedDB open / upgrade
    // ---------------------------------------------------------------------------

    var _dbPromise = null;

    function _openDB() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise(function (resolve, reject) {
            if (!('indexedDB' in global)) {
                reject(new Error('IndexedDB is not supported on this browser.'));
                return;
            }
            var req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onerror = function () {
                reject(req.error);
            };

            req.onupgradeneeded = function (e) {
                var db = e.target.result;

                // printers store — keyed by id
                if (!db.objectStoreNames.contains(STORES.PRINTERS)) {
                    var ps = db.createObjectStore(STORES.PRINTERS, { keyPath: 'id' });
                    ps.createIndex('transport',  'transport',  { unique: false });
                    ps.createIndex('isDefault',  'isDefault',  { unique: false });
                    ps.createIndex('lastConnected', 'lastConnected', { unique: false });
                }

                // sessions store — keyed by deviceSessionId (tab/device identifier)
                if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
                    db.createObjectStore(STORES.SESSIONS, { keyPath: 'sessionId' });
                }

                // diagnostics store — auto-increment key
                if (!db.objectStoreNames.contains(STORES.DIAGNOSTICS)) {
                    var ds = db.createObjectStore(STORES.DIAGNOSTICS, { autoIncrement: true });
                    ds.createIndex('capturedAt', 'capturedAt', { unique: false });
                }
            };

            req.onsuccess = function () {
                resolve(req.result);
            };
        });
        return _dbPromise;
    }

    // ---------------------------------------------------------------------------
    // Low-level helpers
    // ---------------------------------------------------------------------------

    async function _tx(storeName, mode, callback) {
        var db = await _openDB();
        return new Promise(function (resolve, reject) {
            var tx  = db.transaction(storeName, mode);
            var st  = tx.objectStore(storeName);
            var req = callback(st);

            if (req && typeof req.onsuccess === 'undefined') {
                // callback returned a plain value (e.g. getAll result via cursor)
                tx.oncomplete = function () { resolve(req); };
                tx.onerror    = function () { reject(tx.error); };
                return;
            }

            if (req) {
                req.onsuccess = function () { resolve(req.result); };
                req.onerror   = function () { reject(req.error); };
            } else {
                tx.oncomplete = function () { resolve(undefined); };
            }
            tx.onerror = function () { reject(tx.error); };
        });
    }

    async function _getAll(storeName) {
        var db = await _openDB();
        return new Promise(function (resolve, reject) {
            var tx    = db.transaction(storeName, 'readonly');
            var store = tx.objectStore(storeName);
            var req   = store.getAll();
            req.onsuccess = function () { resolve(req.result || []); };
            req.onerror   = function () { reject(req.error); };
        });
    }

    function _generateId() {
        if (global.crypto && global.crypto.randomUUID) {
            return global.crypto.randomUUID();
        }
        // Fallback UUID v4
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    // ---------------------------------------------------------------------------
    // Printer schema validation
    // ---------------------------------------------------------------------------

    var ALLOWED_TRANSPORTS = ['usb', 'bluetooth', 'serial', 'network', 'browser'];
    var ALLOWED_WIDTHS     = ['58mm', '76mm', '80mm'];
    var ALLOWED_PROFILES   = ['standard', 'p58e', 'star', 'zpl', 'cpcl'];

    function _validate(record) {
        if (!record || typeof record !== 'object') throw new Error('Printer record must be an object.');
        if (!ALLOWED_TRANSPORTS.includes(record.transport)) {
            throw new Error('Invalid transport: ' + record.transport);
        }
        if (record.paperWidth && !ALLOWED_WIDTHS.includes(record.paperWidth)) {
            throw new Error('Invalid paperWidth: ' + record.paperWidth);
        }
        if (record.escposProfile && !ALLOWED_PROFILES.includes(record.escposProfile)) {
            throw new Error('Invalid escposProfile: ' + record.escposProfile);
        }
    }

    function _sanitize(record) {
        return {
            id:            record.id           || _generateId(),
            transport:     record.transport,
            model:         String(record.model || 'Unknown Printer').slice(0, 128),
            label:         String(record.label || '').slice(0, 64),
            paperWidth:    record.paperWidth   || '58mm',
            escposProfile: record.escposProfile || 'standard',

            // USB
            vendorId:      typeof record.vendorId  === 'number' ? record.vendorId  : null,
            productId:     typeof record.productId === 'number' ? record.productId : null,

            // Bluetooth
            deviceId:      record.deviceId   ? String(record.deviceId).slice(0, 128)  : null,
            deviceName:    record.deviceName ? String(record.deviceName).slice(0, 128) : null,

            // Network
            networkHost:   record.networkHost ? String(record.networkHost).slice(0, 255) : null,
            networkPort:   typeof record.networkPort === 'number' ? record.networkPort : 9100,

            // Serial
            serialFilters: record.serialFilters || null,

            // Metadata
            lastConnected: record.lastConnected || new Date().toISOString(),
            lastPrintAt:   record.lastPrintAt   || null,
            printCount:    typeof record.printCount === 'number' ? record.printCount : 0,
            isDefault:     !!record.isDefault,
            createdAt:     record.createdAt    || new Date().toISOString(),
        };
    }

    // ---------------------------------------------------------------------------
    // localStorage fallback (for browsers without IDB support)
    // ---------------------------------------------------------------------------

    var LS_KEY = 'sokoni_hw_printers_v1';

    var _lsFallback = {
        getAll: function () {
            try {
                return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
            } catch (_) { return []; }
        },
        save: function (records) {
            try {
                localStorage.setItem(LS_KEY, JSON.stringify(records));
            } catch (_) {}
        },
        put: function (record) {
            var all = this.getAll();
            var idx = all.findIndex(function (r) { return r.id === record.id; });
            if (idx >= 0) all[idx] = record; else all.push(record);
            this.save(all);
        },
        delete: function (id) {
            var all = this.getAll().filter(function (r) { return r.id !== id; });
            this.save(all);
        },
        clear: function () {
            try { localStorage.removeItem(LS_KEY); } catch (_) {}
        },
    };

    var _hasIDB = 'indexedDB' in global;

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    var HardwarePersistence = {

        // -------------------------------------------------------------------
        // Printers
        // -------------------------------------------------------------------

        /** Save or update a printer configuration. Returns the saved record. */
        savePrinter: async function (record) {
            _validate(record);
            var clean = _sanitize(record);
            if (_hasIDB) {
                await _tx(STORES.PRINTERS, 'readwrite', function (s) { return s.put(clean); });
            } else {
                _lsFallback.put(clean);
            }
            return clean;
        },

        /** Get a single printer by ID. Returns null if not found. */
        getPrinter: async function (id) {
            if (!id) return null;
            if (_hasIDB) {
                return await _tx(STORES.PRINTERS, 'readonly', function (s) { return s.get(id); }) || null;
            }
            return _lsFallback.getAll().find(function (r) { return r.id === id; }) || null;
        },

        /** Get all saved printers. */
        getAllPrinters: async function () {
            if (_hasIDB) {
                return await _getAll(STORES.PRINTERS);
            }
            return _lsFallback.getAll();
        },

        /** Get the default printer. Returns null if none is marked default. */
        getDefaultPrinter: async function () {
            var all = await this.getAllPrinters();
            return all.find(function (r) { return r.isDefault; }) || (all[0] || null);
        },

        /** Set a printer as the default. Clears isDefault on all others. */
        setDefaultPrinter: async function (id) {
            var all = await this.getAllPrinters();
            for (var i = 0; i < all.length; i++) {
                all[i].isDefault = (all[i].id === id);
                await this.savePrinter(all[i]);
            }
        },

        /** Remove a printer by ID. */
        removePrinter: async function (id) {
            if (_hasIDB) {
                await _tx(STORES.PRINTERS, 'readwrite', function (s) { return s.delete(id); });
            } else {
                _lsFallback.delete(id);
            }
        },

        /** Update lastConnected and printCount fields. */
        recordConnection: async function (id) {
            var record = await this.getPrinter(id);
            if (!record) return;
            record.lastConnected = new Date().toISOString();
            await this.savePrinter(record);
        },

        /** Increment print count and update lastPrintAt. */
        recordPrint: async function (id) {
            var record = await this.getPrinter(id);
            if (!record) return;
            record.printCount  = (record.printCount || 0) + 1;
            record.lastPrintAt = new Date().toISOString();
            await this.savePrinter(record);
        },

        /** Remove all saved printers. */
        clearPrinters: async function () {
            if (_hasIDB) {
                var db = await _openDB();
                await new Promise(function (resolve, reject) {
                    var tx  = db.transaction(STORES.PRINTERS, 'readwrite');
                    var req = tx.objectStore(STORES.PRINTERS).clear();
                    req.onsuccess = resolve;
                    req.onerror   = function () { reject(req.error); };
                });
            } else {
                _lsFallback.clear();
            }
        },

        // -------------------------------------------------------------------
        // Session (which printer was active at last page load)
        // -------------------------------------------------------------------

        SESSION_KEY: 'sokoni_hw_session',

        /** Save the ID of the currently active printer for this browser session. */
        saveSession: async function (printerId) {
            var record = { sessionId: this.SESSION_KEY, printerId: printerId, at: new Date().toISOString() };
            if (_hasIDB) {
                await _tx(STORES.SESSIONS, 'readwrite', function (s) { return s.put(record); });
            } else {
                try { sessionStorage.setItem(this.SESSION_KEY, JSON.stringify(record)); } catch (_) {}
            }
        },

        /** Return the last-active printer ID for this session. */
        getSession: async function () {
            if (_hasIDB) {
                var rec = await _tx(STORES.SESSIONS, 'readonly', function (s) {
                    return s.get(HardwarePersistence.SESSION_KEY);
                });
                return (rec && rec.printerId) || null;
            }
            try {
                var raw = sessionStorage.getItem(this.SESSION_KEY);
                var parsed = raw ? JSON.parse(raw) : null;
                return (parsed && parsed.printerId) || null;
            } catch (_) { return null; }
        },

        // -------------------------------------------------------------------
        // Diagnostics history
        // -------------------------------------------------------------------

        /** Append a diagnostic snapshot. Keeps the last 50. */
        saveDiagnosticSnapshot: async function (snapshot) {
            if (!_hasIDB) return;
            snapshot.capturedAt = snapshot.capturedAt || new Date().toISOString();
            var db = await _openDB();
            await new Promise(function (resolve, reject) {
                var tx    = db.transaction(STORES.DIAGNOSTICS, 'readwrite');
                var store = tx.objectStore(STORES.DIAGNOSTICS);
                store.add(snapshot);
                tx.oncomplete = resolve;
                tx.onerror    = function () { reject(tx.error); };
            });
            // Trim to last 50
            await this._trimDiagnostics(50);
        },

        /** Return the N most recent diagnostic snapshots. */
        getRecentDiagnostics: async function (n) {
            n = n || 10;
            if (!_hasIDB) return [];
            var all = await _getAll(STORES.DIAGNOSTICS);
            return all.sort(function (a, b) {
                return (b.capturedAt || '').localeCompare(a.capturedAt || '');
            }).slice(0, n);
        },

        _trimDiagnostics: async function (maxCount) {
            if (!_hasIDB) return;
            var db = await _openDB();
            await new Promise(function (resolve, reject) {
                var tx    = db.transaction(STORES.DIAGNOSTICS, 'readwrite');
                var store = tx.objectStore(STORES.DIAGNOSTICS);
                var allReq = store.getAllKeys();
                allReq.onsuccess = function () {
                    var keys = allReq.result || [];
                    if (keys.length > maxCount) {
                        var toDelete = keys.slice(0, keys.length - maxCount);
                        toDelete.forEach(function (k) { store.delete(k); });
                    }
                };
                tx.oncomplete = resolve;
                tx.onerror    = function () { reject(tx.error); };
            });
        },

        // -------------------------------------------------------------------
        // Migration helper — import from old localStorage keys
        // -------------------------------------------------------------------

        /**
         * One-time migration from old localStorage keys to new persistence layer.
         * Called by HardwareManager.init() if no printers are found in IDB.
         */
        migrateFromLegacy: async function () {
            var migrated = [];
            var existing = await this.getAllPrinters();
            if (existing.length > 0) return migrated; // already migrated

            // Old keys: spp_config, p58e_paired_device, sokoni_print_settings_v3, _posHardware
            var legacyKeys = ['spp_config', 'p58e_paired_device', 'sokoni_print_settings_v3'];
            for (var i = 0; i < legacyKeys.length; i++) {
                try {
                    var raw = localStorage.getItem(legacyKeys[i]);
                    if (!raw) continue;
                    var data = JSON.parse(raw);
                    if (!data) continue;

                    // Best-effort extraction
                    var record = {
                        transport:    data.transport || data.type || 'bluetooth',
                        model:        data.model || data.name || data.printerName || 'Imported Printer',
                        paperWidth:   data.paperWidth || data.width || '58mm',
                        deviceId:     data.deviceId || data.id || data.btName || null,
                        deviceName:   data.deviceName || data.btName || null,
                        networkHost:  data.host || data.ip || null,
                        networkPort:  data.port || 9100,
                        lastConnected: data.lastConnected || new Date().toISOString(),
                    };
                    var saved = await this.savePrinter(record);
                    migrated.push({ source: legacyKeys[i], id: saved.id });
                } catch (_) {}
            }
            return migrated;
        },
    };

    global.SokoniHardwarePersistence = HardwarePersistence;

})(window);
