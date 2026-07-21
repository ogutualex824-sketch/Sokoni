/**
 * SOKONI Device Registry v1.0
 *
 * Runtime tracking of all devices that have been connected in this session.
 * Provides a single source of truth for what's connected, what driver is
 * in use, and current device state.
 *
 * This is an in-memory store — it does not persist to IndexedDB.
 * For persistence use SokoniHardwarePersistence.
 *
 * Events emitted on window:
 *   hw:registry:added     {device}
 *   hw:registry:updated   {deviceId, changes}
 *   hw:registry:removed   {deviceId}
 */

(function (global) {
    'use strict';

    // ─── Device state constants ────────────────────────────────────────────────
    var STATE = {
        CONNECTING:  'connecting',
        CONNECTED:   'connected',
        DISCONNECTED:'disconnected',
        ERROR:       'error',
        RECOVERING:  'recovering',
    };

    // ─── In-memory store ───────────────────────────────────────────────────────
    var _devices = {};      // deviceId → DeviceRecord
    var _seq     = 0;       // monotonic registry sequence

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _now() { return new Date().toISOString(); }

    function _emit(event, detail) {
        try {
            global.dispatchEvent(new CustomEvent(event, { detail: detail, bubbles: false }));
        } catch (_) {}
    }

    function _genId(type, transport) {
        _seq++;
        return type + '_' + transport + '_' + _seq.toString(16);
    }

    // ─── DeviceRecord shape ────────────────────────────────────────────────────
    //
    //   deviceId     {string}        Registry-assigned unique ID for this session
    //   savedId      {string|null}   Persistence ID (from SokoniHardwarePersistence)
    //   type         {string}        'printer' | 'scanner' | 'drawer' | ...
    //   transport    {string}        'usb' | 'bluetooth' | 'serial' | 'network' | 'browser'
    //   profile      {object|null}   SokoniDeviceProfiles entry
    //   driver       {object|null}   DeviceDriver instance
    //   connection   {object|null}   Connection object from SokoniConnectionManager
    //   state        {string}        STATE.*
    //   isDefault    {boolean}       Is this the default device for its type?
    //   label        {string}        Human-readable label
    //   connectedAt  {string|null}   ISO timestamp of last successful connect
    //   lastUsedAt   {string|null}   ISO timestamp of last operation
    //   error        {string|null}   Last error message (if state === 'error')
    //   meta         {object}        Driver/transport-specific metadata

    function _makeRecord(opts) {
        return {
            deviceId:    opts.deviceId    || _genId(opts.type || 'device', opts.transport || 'unknown'),
            savedId:     opts.savedId     || null,
            type:        opts.type        || 'generic',
            transport:   opts.transport   || 'unknown',
            profile:     opts.profile     || null,
            driver:      opts.driver      || null,
            connection:  opts.connection  || null,
            state:       opts.state       || STATE.CONNECTING,
            isDefault:   opts.isDefault   || false,
            label:       opts.label       || (opts.profile && opts.profile.name) || 'Unknown Device',
            connectedAt: opts.connectedAt || null,
            lastUsedAt:  opts.lastUsedAt  || null,
            error:       opts.error       || null,
            meta:        opts.meta        || {},
        };
    }

    // =========================================================================
    // Public interface
    // =========================================================================

    var DeviceRegistry = {

        STATE: STATE,

        /**
         * Register a new device. Returns the deviceId.
         *
         * @param {object} opts  Fields matching DeviceRecord (deviceId is optional — auto-assigned)
         * @returns {string}     The deviceId
         */
        register: function (opts) {
            var record = _makeRecord(opts);
            _devices[record.deviceId] = record;
            _emit('hw:registry:added', { device: record });
            return record.deviceId;
        },

        /**
         * Update fields on an existing record.
         *
         * @param {string} deviceId
         * @param {object} changes   Partial DeviceRecord fields
         */
        update: function (deviceId, changes) {
            var record = _devices[deviceId];
            if (!record) return;
            for (var key in changes) {
                if (changes.hasOwnProperty(key)) {
                    record[key] = changes[key];
                }
            }
            _emit('hw:registry:updated', { deviceId: deviceId, changes: changes });
        },

        /**
         * Mark a device as connected and stamp connectedAt.
         *
         * @param {string} deviceId
         * @param {object} [meta]   Optional extra metadata
         */
        markConnected: function (deviceId, meta) {
            this.update(deviceId, {
                state:       STATE.CONNECTED,
                connectedAt: _now(),
                error:       null,
                meta:        Object.assign(_devices[deviceId] ? _devices[deviceId].meta : {}, meta || {}),
            });
        },

        /**
         * Mark a device as disconnected.
         *
         * @param {string} deviceId
         * @param {string} [reason]
         */
        markDisconnected: function (deviceId, reason) {
            this.update(deviceId, {
                state:      STATE.DISCONNECTED,
                error:      reason || null,
                connection: null,
            });
        },

        /**
         * Mark a device as errored.
         *
         * @param {string} deviceId
         * @param {string|Error} error
         */
        markError: function (deviceId, error) {
            this.update(deviceId, {
                state: STATE.ERROR,
                error: (error instanceof Error ? error.message : String(error)) || 'Unknown error',
            });
        },

        /**
         * Mark a device as currently recovering.
         * @param {string} deviceId
         */
        markRecovering: function (deviceId) {
            this.update(deviceId, { state: STATE.RECOVERING, error: null });
        },

        /**
         * Record that an operation was performed on a device.
         * @param {string} deviceId
         */
        touchDevice: function (deviceId) {
            this.update(deviceId, { lastUsedAt: _now() });
        },

        /**
         * Set a device as the default for its type (and clear any previous default).
         * @param {string} deviceId
         */
        setDefault: function (deviceId) {
            var record = _devices[deviceId];
            if (!record) return;
            // Clear existing defaults of the same type
            for (var id in _devices) {
                if (_devices[id].type === record.type && _devices[id].isDefault) {
                    this.update(id, { isDefault: false });
                }
            }
            this.update(deviceId, { isDefault: true });
        },

        /**
         * Remove a device from the registry.
         * @param {string} deviceId
         */
        remove: function (deviceId) {
            if (!_devices[deviceId]) return;
            delete _devices[deviceId];
            _emit('hw:registry:removed', { deviceId: deviceId });
        },

        /**
         * Get a single device record by deviceId.
         * @param {string} deviceId
         * @returns {object|null}
         */
        get: function (deviceId) {
            return _devices[deviceId] || null;
        },

        /**
         * Get all registered devices.
         * @returns {object[]}
         */
        getAll: function () {
            return Object.values(_devices);
        },

        /**
         * Get all devices of a given type.
         * @param {string} type  e.g. 'printer', 'scanner'
         * @returns {object[]}
         */
        getByType: function (type) {
            return Object.values(_devices).filter(function (d) { return d.type === type; });
        },

        /**
         * Get the active (connected) default device for a type, or first connected.
         * @param {string} type
         * @returns {object|null}
         */
        getActive: function (type) {
            var byType = this.getByType(type);
            var connected = byType.filter(function (d) { return d.state === STATE.CONNECTED; });
            if (!connected.length) return null;
            var def = connected.find(function (d) { return d.isDefault; });
            return def || connected[0];
        },

        /**
         * Find a device by savedId (persistence ID).
         * @param {string} savedId
         * @returns {object|null}
         */
        findBySavedId: function (savedId) {
            for (var id in _devices) {
                if (_devices[id].savedId === savedId) return _devices[id];
            }
            return null;
        },

        /**
         * True if there is at least one connected device of the given type.
         * @param {string} type
         * @returns {boolean}
         */
        hasActive: function (type) {
            return !!this.getActive(type);
        },

        /** Clear all devices — used for hard reset. */
        clear: function () {
            _devices = {};
            _emit('hw:registry:cleared', {});
        },

        /** Snapshot for diagnostics. */
        snapshot: function () {
            return JSON.parse(JSON.stringify(_devices));
        },
    };

    global.SokoniDeviceRegistry = DeviceRegistry;

})(window);
