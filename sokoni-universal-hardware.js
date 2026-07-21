/**
 * SOKONI Universal Hardware v1.0
 *
 * Top-level singleton. This is the ONLY hardware API that application code
 * should ever call. All device types, drivers, transports, and profiles are
 * completely hidden behind this interface.
 *
 * Architecture:
 *   SokoniHardware                 ← this file (application entry point)
 *     .printer                     ← type controller for printers
 *     .scanner                     ← type controller for scanners
 *     .drawer                      ← type controller for cash drawers
 *     .display                     ← type controller for customer displays
 *     .scale                       ← type controller for scales
 *     .nfc                         ← type controller for NFC readers
 *     .terminal                    ← type controller for payment terminals
 *     .biometric                   ← type controller for biometrics
 *
 * Per-type controller API:
 *   .connect(options)              → Promise<string>  deviceId in registry
 *   .connectPassive()              → Promise<string|null>  restore from saved session
 *   .execute(command, data)        → Promise<any>     dispatch to active driver
 *   .test()                        → Promise<TestResult>
 *   .status()                      → Promise<StatusResult>
 *   .disconnect()                  → Promise<void>
 *   .isConnected                   → boolean
 *   .getActive()                   → DeviceRecord | null
 *
 * Top-level API:
 *   SokoniHardware.init()          → Promise<void>
 *   SokoniHardware.discover()      → Promise<DiscoveryResult>
 *   SokoniHardware.request(type, transport, options) → Promise<{deviceId, driver, connection}>
 *   SokoniHardware.testAll()       → Promise<{type: TestResult}[]>
 *   SokoniHardware.diagnostics()   → Promise<DiagnosticsReport>
 *
 * Events emitted on window:
 *   hw:universal:ready
 *   hw:universal:connected   {type, deviceId, profile, transport}
 *   hw:universal:disconnected {type, deviceId, reason}
 *   hw:universal:error       {type, message}
 *
 * Rules:
 *   - NEVER call requestDevice/requestPort from init() or connectPassive().
 *   - request() may call requestDevice — it MUST be called from a user gesture.
 *   - All permission logic is delegated to SokoniPermissionManager.
 *   - All connection logic is delegated to SokoniConnectionManager.
 *   - All profile matching is delegated to SokoniDeviceProfiles.
 *   - All driver dispatch is delegated to SokoniDriverManager.
 */

(function (global) {
    'use strict';

    // ─── Lazy dependency accessors ────────────────────────────────────────────
    function _profiles() { return global.SokoniDeviceProfiles; }
    function _perm()     { return global.SokoniPermissionManager; }
    function _cap()      { return global.SokoniCapabilityDetector; }
    function _conn()     { return global.SokoniConnectionManager; }
    function _dm()       { return global.SokoniDriverManager; }
    function _reg()      { return global.SokoniDeviceRegistry; }
    function _store()    { return global.SokoniHardwarePersistence; }
    function _disc()     { return global.SokoniDiscoveryEngine; }
    function _rec()      { return global.SokoniHardwareRecovery; }

    function _emit(name, detail) {
        try { global.dispatchEvent(new CustomEvent(name, { detail: detail || {}, bubbles: false })); } catch (_) {}
    }

    function _log(msg, data) { console.info('[SOKONI UHW] ' + msg, data || ''); }

    // =========================================================================
    // TypeController — one per device type
    // =========================================================================

    function TypeController(type) {
        this.type       = type;
        this._deviceId  = null;   // active deviceId in registry
        this._driver    = null;
        this._connection= null;
    }

    Object.defineProperty(TypeController.prototype, 'isConnected', {
        get: function () {
            return !!this._driver && this._driver.isConnected && this._driver.isConnected();
        },
    });

    TypeController.prototype.getActive = function () {
        if (!this._deviceId) return null;
        return _reg() ? _reg().get(this._deviceId) : null;
    };

    /**
     * Request a new device connection — requires a user gesture on the call stack.
     *
     * @param {object} [options]
     * @param {string} [options.transport]   Force a specific transport
     * @param {string} [options.profileId]   Force a specific profile
     * @param {object} [options.networkOpts] { host, port } for network transport
     * @returns {Promise<string>}  deviceId
     */
    TypeController.prototype.connect = async function (options) {
        options = options || {};
        var transport = options.transport || _getDefaultTransport(this.type);
        var perm      = _perm();
        var connMgr   = _conn();
        var dm        = _dm();
        var reg       = _reg();

        if (!perm || !connMgr || !dm || !reg) {
            throw new Error('Hardware subsystem not initialised. Call SokoniHardware.init() first.');
        }

        // ── 1. Request permission / device picker (user gesture context) ────
        var rawDevice = null;
        var profile   = null;

        switch (transport) {
            case 'usb': {
                var dp = _profiles();
                var filters = [];
                if (options.profileId) {
                    var fp = dp && dp.getProfileById(options.profileId);
                    if (fp && fp.usb) filters = (fp.usb.vendorIds || []).map(function (v) { return { vendorId: v }; });
                }
                if (!filters.length) {
                    filters = perm.USB_PRINTER_VID_FILTERS || [{ classCode: 7 }];
                }
                rawDevice = await perm.requestUSBDevice(filters);
                profile   = dp ? dp.findByUSBDevice(rawDevice) : null;
                break;
            }

            case 'bluetooth': {
                var btOpts = options.bluetoothOptions;
                if (!btOpts) {
                    var allSvcs = _profiles() ? Object.values(_profiles().BLE.SVC) : [];
                    btOpts = {
                        filters:          (perm.BT_PRINTER_FILTERS  || []).concat([{ services: allSvcs }]),
                        optionalServices: allSvcs,
                    };
                }
                rawDevice = await perm.requestBluetoothDevice(btOpts);
                profile   = _profiles() ? _profiles().findByBLEDevice(rawDevice) : null;
                break;
            }

            case 'serial': {
                rawDevice = await perm.requestSerialPort(options.serialOptions || {});
                var info  = rawDevice.getInfo && rawDevice.getInfo();
                profile   = _profiles() ? _profiles().findBySerialPort(info) : null;
                break;
            }

            case 'network':
                rawDevice = options.networkOpts && options.networkOpts.host;
                if (!rawDevice) throw new Error('Network transport requires options.networkOpts.host');
                if (options.profileId) profile = _profiles() ? _profiles().getProfileById(options.profileId) : null;
                break;

            case 'android':
                profile = options.profileId ? (_profiles() ? _profiles().getProfileById(options.profileId) : null) : null;
                break;

            case 'browser':
                profile = null;
                break;

            default:
                throw new Error('Unknown transport: ' + transport);
        }

        // ── 2. Establish connection ──────────────────────────────────────────
        var connection = await connMgr.create(transport, rawDevice, profile, options.networkOpts);

        // ── 3. Instantiate driver ────────────────────────────────────────────
        var DriverClass = dm.getBestDriver(profile || { type: this.type, driver: this.type + '-driver', protocol: '' });
        if (!DriverClass) throw new Error('No driver registered for profile: ' + (profile ? profile.id : this.type));
        var driver = new DriverClass();
        await driver.onConnect(connection, profile);

        // ── 4. Register in device registry ──────────────────────────────────
        var deviceId = reg.register({
            type:       this.type,
            transport:  transport,
            profile:    profile,
            driver:     driver,
            connection: connection,
            state:      'connected',
            label:      profile ? profile.name : transport + ' device',
        });
        reg.markConnected(deviceId);

        this._deviceId  = deviceId;
        this._driver    = driver;
        this._connection= connection;

        _emit('hw:universal:connected', { type: this.type, deviceId: deviceId, profile: profile, transport: transport });
        _log(this.type + ' connected: ' + (profile ? profile.name : transport), { deviceId: deviceId });

        return deviceId;
    };

    /**
     * Restore the active device from a saved session (passive — no dialog).
     * Returns null if nothing could be restored.
     *
     * @returns {Promise<string|null>}  deviceId or null
     */
    TypeController.prototype.connectPassive = async function () {
        var store = _store();
        var reg   = _reg();
        var dm    = _dm();
        if (!store || !reg || !dm) return null;

        try {
            var saved = await store.getDefaultPrinter();
            if (!saved || saved.type !== this.type) {
                // Find any saved record of this type
                var all = await store.getAllPrinters();
                saved = all.find(function (r) { return r.type === this.type || !r.type; }.bind(this)) || null;
            }
            if (!saved) return null;

            var profile  = saved.profileId ? (_profiles() && _profiles().getProfileById(saved.profileId)) : null;
            var connMgr  = _conn();
            if (!connMgr) return null;

            var connection = await connMgr.restore(saved, profile);
            if (!connection) return null;

            var DriverClass = dm.getBestDriver(profile || { type: this.type, driver: this.type + '-driver', protocol: '' });
            if (!DriverClass) return null;

            var driver = new DriverClass();
            await driver.onConnect(connection, profile);

            var deviceId = reg.register({
                savedId:    saved.id,
                type:       this.type,
                transport:  saved.transport,
                profile:    profile,
                driver:     driver,
                connection: connection,
                state:      'connected',
                label:      saved.label || (profile && profile.name) || 'Restored device',
            });
            reg.markConnected(deviceId);

            this._deviceId  = deviceId;
            this._driver    = driver;
            this._connection= connection;

            _emit('hw:universal:connected', { type: this.type, deviceId: deviceId, profile: profile, transport: saved.transport });
            return deviceId;

        } catch (e) {
            _log(this.type + ' passive restore failed: ' + e.message);
            return null;
        }
    };

    TypeController.prototype.execute = function (command, data) {
        if (!this._driver) return Promise.reject(new Error(this.type + ' not connected'));
        return this._driver.execute(command, data);
    };

    TypeController.prototype.test = function () {
        if (!this._driver) return Promise.resolve({ ok: false, detail: this.type + ' not connected' });
        return this._driver.test();
    };

    TypeController.prototype.status = function () {
        if (!this._driver) return Promise.resolve({ state: 'offline', detail: this.type + ' not connected' });
        return this._driver.status();
    };

    TypeController.prototype.disconnect = async function () {
        if (this._driver) {
            try { await this._driver.disconnect(); } catch (_) {}
        }
        if (this._deviceId && _reg()) {
            _reg().markDisconnected(this._deviceId, 'manual');
        }
        _emit('hw:universal:disconnected', { type: this.type, deviceId: this._deviceId, reason: 'manual' });
        this._driver     = null;
        this._connection = null;
        this._deviceId   = null;
    };

    // ─── Default transport selector ───────────────────────────────────────────

    function _getDefaultTransport(type) {
        var cap = _cap();
        if (!cap) return 'browser';
        var t = cap.recommendedTransport();
        // Scanners prefer HID; payment terminals prefer network
        if (type === 'scanner')  return 'hid';
        if (type === 'terminal') return 'network';
        if (type === 'biometric') return 'browser';
        if (type === 'nfc')      return 'browser';
        return t;
    }

    // =========================================================================
    // Universal Hardware singleton
    // =========================================================================

    var _initialized = false;

    var UHW = {
        printer:   new TypeController('printer'),
        scanner:   new TypeController('scanner'),
        drawer:    new TypeController('drawer'),
        display:   new TypeController('display'),
        scale:     new TypeController('scale'),
        nfc:       new TypeController('nfc'),
        terminal:  new TypeController('terminal'),
        biometric: new TypeController('biometric'),

        /**
         * Initialise the hardware layer.
         * - Starts auto-recovery
         * - Passively restores previously connected devices
         * Safe to call multiple times.
         *
         * @returns {Promise<void>}
         */
        init: async function () {
            if (_initialized) return;
            _initialized = true;

            // Start recovery listener (USB connect/disconnect events + page visibility)
            var rec = _rec();
            if (rec && !rec.isRunning()) rec.start();

            // Passively restore saved devices
            try { await UHW.printer.connectPassive(); } catch (_) {}

            _emit('hw:universal:ready', {});
            _log('Universal hardware layer ready');
        },

        /**
         * Discover all previously-granted devices across all transports.
         * Passive — no permission dialogs.
         *
         * @returns {Promise<DiscoveryResult>}
         */
        discover: async function () {
            var disc = _disc();
            if (!disc) return { detected: [], hints: [], canDiscover: {}, capturedAt: new Date().toISOString() };
            return disc.discover();
        },

        /**
         * Request a new device connection for any type.
         * This MUST be called from a user gesture (button click).
         *
         * @param {string} type       Device type: 'printer', 'scanner', etc.
         * @param {string} transport  'usb' | 'bluetooth' | 'serial' | 'network' | 'android' | 'browser'
         * @param {object} [options]  Transport-specific options
         * @returns {Promise<{deviceId, driver, connection}>}
         */
        request: async function (type, transport, options) {
            var ctrl = UHW[type];
            if (!ctrl || !(ctrl instanceof TypeController)) {
                throw new Error('Unknown device type: ' + type);
            }
            options = Object.assign({}, options || {}, { transport: transport });
            var deviceId = await ctrl.connect(options);
            var record   = _reg() ? _reg().get(deviceId) : null;
            return {
                deviceId:   deviceId,
                driver:     record && record.driver,
                connection: record && record.connection,
            };
        },

        /**
         * Run test() on all connected devices.
         * @returns {Promise<object>}  { printer: TestResult, scanner: TestResult, ... }
         */
        testAll: async function () {
            var types   = ['printer', 'scanner', 'drawer', 'display', 'scale', 'nfc', 'terminal', 'biometric'];
            var results = {};
            await Promise.all(types.map(async function (t) {
                try {
                    results[t] = await UHW[t].test();
                } catch (e) {
                    results[t] = { ok: false, detail: e.message };
                }
            }));
            return results;
        },

        /**
         * Hardware-wide diagnostics report.
         * @returns {Promise<object>}
         */
        diagnostics: async function () {
            var diag = global.SokoniHardwareDiagnostics;
            if (!diag) return { error: 'SokoniHardwareDiagnostics not loaded' };

            var base     = await diag.generate();
            var reg      = _reg();
            var devices  = reg ? reg.getAll() : [];

            return Object.assign({}, base, {
                universalDevices: devices.map(function (d) {
                    return { deviceId: d.deviceId, type: d.type, transport: d.transport, state: d.state, label: d.label, isDefault: d.isDefault };
                }),
                registeredDrivers: _dm() ? _dm().listIds() : [],
            });
        },

        /** Convenience: get the active driver for a type directly. */
        getDriver: function (type) {
            var ctrl = UHW[type];
            return ctrl ? ctrl._driver : null;
        },

        /** True if any device of the given type is currently connected. */
        isConnected: function (type) {
            return !!UHW[type] && UHW[type].isConnected;
        },
    };

    // =========================================================================
    // Export
    // =========================================================================

    global.SokoniHardware = UHW;

    // Backwards compatibility: expose as HardwareManager so existing pos pages work.
    // The old HardwareManager interface is maintained below for existing code.
    if (!global.HardwareManager) {
        global.HardwareManager = {
            init:             function () { return UHW.init(); },
            isConnected:      function () { return UHW.isConnected('printer'); },
            getActivePrinter: function () { return UHW.printer.getActive(); },
            getSavedPrinters: function () { var s = _store(); return s ? s.getAllPrinters() : Promise.resolve([]); },
            connectPrinter:   function (transport, options) {
                return UHW.request('printer', transport, options);
            },
            confirmAndSave:   async function (pending, overrides) {
                // Legacy shim — save the active printer record to persistence
                var store   = _store();
                var active  = UHW.printer.getActive();
                if (!store || !active) throw new Error('No pending printer to save');
                var rec = Object.assign({
                    transport:  active.transport,
                    label:      (overrides && overrides.label) || active.label,
                    profileId:  active.profile ? active.profile.id : null,
                    model:      active.label,
                    paperWidth: (overrides && overrides.paperWidth) || (active.profile && active.profile.capabilities && active.profile.capabilities.paperWidth) || '58mm',
                }, active.connection ? active.connection.descriptor : {});
                var savedId = await store.savePrinter(rec);
                await store.saveSession(savedId);
                if (_reg()) _reg().update(active.deviceId, { savedId: savedId });
                return savedId;
            },
            testPrintPending: function () { return UHW.printer.test(); },
            reconnect:        function () { return UHW.printer.connectPassive(); },
        };
    }

})(window);
