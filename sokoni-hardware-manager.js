/**
 * SOKONI Hardware Manager v1.0
 * Phase 1 — Hardware Abstraction Layer
 *
 * Owns all hardware. The single entry point for all POS hardware operations.
 *
 * All other modules must interact with hardware exclusively through HardwareManager.
 * No POS page, component, or service should import providers, permission manager,
 * or persistence directly.
 *
 * Load order:
 *   1. sokoni-capability-detector.js
 *   2. sokoni-permission-manager.js
 *   3. sokoni-hardware-persistence.js
 *   4. sokoni-printer-providers.js
 *   5. sokoni-hardware-diagnostics.js   (optional — enhances report())
 *   6. sokoni-hardware-recovery.js      (optional — enables auto-reconnect)
 *   7. sokoni-hardware-manager.js       ← this file
 *
 * Rules:
 *   - init() is safe to call any time. It does NOT request permissions.
 *   - connect(transport) MUST be called from a user gesture handler.
 *   - reconnect() uses only passive getStored* calls — no dialog.
 *   - All errors are emitted as 'hw:error' events on window.
 */

(function (global) {
    'use strict';

    // ---------------------------------------------------------------------------
    // Lazy subsystem accessors
    // ---------------------------------------------------------------------------

    function _cap()   { return global.SokoniCapabilityDetector;  }
    function _perm()  { return global.SokoniPermissionManager;   }
    function _store() { return global.SokoniHardwarePersistence; }
    function _provs() { return global.SokoniPrinterProviders;    }
    function _diag()  { return global.SokoniHardwareDiagnostics; }
    function _rec()   { return global.SokoniHardwareRecovery;    }

    // ---------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------

    var _activePrinter    = null;  // { descriptor, connection, provider, escpos, savedId }
    var _providers        = {};    // transport → PrinterProvider instance
    var _initDone         = false;
    var _initPromise      = null;

    // ---------------------------------------------------------------------------
    // Event helpers
    // ---------------------------------------------------------------------------

    function _emit(name, detail) {
        try {
            global.dispatchEvent(new CustomEvent('hw:' + name, { detail: detail, bubbles: false }));
        } catch (_) {}
    }

    function _log(level, msg, data) {
        var prefix = '[SOKONI HW] ';
        if (level === 'error') {
            console.error(prefix + msg, data || '');
            _emit('error', { message: msg, data: data });
        } else if (level === 'warn') {
            console.warn(prefix + msg, data || '');
        } else {
            console.info(prefix + msg, data || '');
        }
    }

    // ---------------------------------------------------------------------------
    // Provider registry
    // ---------------------------------------------------------------------------

    function _getProvider(transport) {
        if (_providers[transport]) return _providers[transport];
        var P = _provs();
        if (!P) throw new Error('SokoniPrinterProviders is not loaded.');

        var provider;
        switch (transport) {
            case 'usb':       provider = new P.USBPrinterProvider();       break;
            case 'bluetooth': provider = new P.BluetoothPrinterProvider(); break;
            case 'serial':    provider = null;                              break; // Serial not yet in providers — TODO
            case 'network':   provider = new P.NetworkPrinterProvider();   break;
            case 'browser':   provider = new P.BrowserPrinterProvider();   break;
            default: throw new Error('Unknown transport: ' + transport);
        }
        if (!provider) throw new Error('Transport not yet implemented: ' + transport);
        _providers[transport] = provider;
        return provider;
    }

    // ---------------------------------------------------------------------------
    // init() — safe to call any time, never requests permissions
    // ---------------------------------------------------------------------------

    async function _init() {
        if (_initDone)    return;
        if (_initPromise) return _initPromise;

        _initPromise = (async function () {
            _log('info', 'Initialising...');

            // Migrate from legacy localStorage keys (one-time, no-op if already done)
            var s = _store();
            if (s) {
                try { await s.migrateFromLegacy(); } catch (_) {}
            }

            // Start auto-recovery listener (USB connect/disconnect events — passive)
            var r = _rec();
            if (r) {
                try { r.start(); } catch (_) {}
            }

            // Passive restore: try to reconnect last-session printer using stored devices
            try {
                await _restoreFromSession();
            } catch (e) {
                _log('warn', 'Passive restore failed: ' + e.message);
            }

            _initDone = true;
            _log('info', 'Ready. Active printer: ' + (_activePrinter ? _activePrinter.descriptor.model : 'none'));
            _emit('ready', { hasPrinter: !!_activePrinter });
        })();

        return _initPromise;
    }

    // ---------------------------------------------------------------------------
    // Passive restore from last session
    // ---------------------------------------------------------------------------

    async function _restoreFromSession() {
        var s = _store();
        if (!s) return;

        // Which printer was active last time?
        var lastId = await s.getSession();
        var record = lastId ? await s.getPrinter(lastId) : await s.getDefaultPrinter();
        if (!record) return;

        _log('info', 'Attempting passive restore for printer: ' + record.model + ' (' + record.transport + ')');

        // Only USB and BT support passive restore via getStored*
        if (record.transport !== 'usb' && record.transport !== 'bluetooth') return;

        var provider = _getProvider(record.transport);
        var storedDevices = await provider.getStoredDevices();

        // Match by deviceId (BT) or vendorId/productId (USB)
        var matched = storedDevices.find(function (d) {
            if (record.transport === 'bluetooth') return d.deviceId === record.deviceId;
            if (record.transport === 'usb')
                return d.vendorId === record.vendorId && d.productId === record.productId;
            return false;
        });

        if (!matched) {
            _log('info', 'Stored device not found — user must reconnect manually.');
            return;
        }

        _log('info', 'Stored device found — connecting silently...');
        try {
            var P = _provs();
            var connection = await provider.connect(matched);
            var profile    = record.escposProfile ? _resolveProfile(record.escposProfile) : (matched.profile || P.PRINTER_PROFILES.GENERIC_58);
            var escpos     = new P.ESCPosProvider(provider, profile);

            _setActivePrinter({ descriptor: matched, connection, provider, escpos, savedId: record.id });
            await s.recordConnection(record.id);

            _log('info', 'Silent restore succeeded: ' + matched.model);
            _emit('connected', { transport: record.transport, model: matched.model, restored: true });
        } catch (e) {
            _log('warn', 'Silent restore failed (device may be off): ' + e.message);
        }
    }

    function _resolveProfile(profileIdOrName) {
        var P = _provs();
        if (!P) return null;
        var profiles = P.PRINTER_PROFILES;
        return Object.values(profiles).find(function (p) {
            return p.id === profileIdOrName || p.escposProfile === profileIdOrName;
        }) || profiles.GENERIC_58;
    }

    function _setActivePrinter(printerState) {
        _activePrinter = printerState;
        // Attach disconnect listener for BT (gattserverdisconnected)
        if (printerState && printerState.descriptor && printerState.descriptor.device) {
            var device = printerState.descriptor.device;
            if (device.addEventListener) {
                device.addEventListener('gattserverdisconnected', function () {
                    _log('warn', 'Bluetooth printer disconnected (gattserverdisconnected).');
                    _emit('disconnected', { transport: 'bluetooth', model: printerState.descriptor.model });
                    // Recovery module handles reconnect — see sokoni-hardware-recovery.js
                });
            }
        }
    }

    // ---------------------------------------------------------------------------
    // connect() — Phase 4 connection flow (MUST be called from user gesture)
    // ---------------------------------------------------------------------------

    /**
     * Start the full connection flow for a transport.
     *
     * Steps:
     *  1. Validate transport is supported
     *  2. Get provider
     *  3. Call provider.requestDevice() — opens browser picker (user gesture required)
     *  4. Connect to device
     *  5. Detect profile (Phase 6 — P58E auto-detect)
     *  6. Probe ESC/POS compatibility
     *  7. Return connection info
     *
     * The caller is responsible for running test print and saving
     * (to separate user-confirmed test from automatic save).
     *
     * @param {string} transport  'usb'|'bluetooth'|'network'|'browser'
     * @param {object} [options]  Transport-specific options (e.g. {host, port} for network)
     * @returns {Promise<PendingPrinter>}
     */
    async function _connectPrinter(transport, options) {
        var cap = _cap();
        if (cap && !cap.transportAvailable(transport) && transport !== 'browser' && transport !== 'network') {
            throw Object.assign(
                new Error(transport + ' is not supported on this browser.'),
                { userMessage: _transportUnsupportedMsg(transport) }
            );
        }

        var provider = _getProvider(transport);
        _log('info', 'Requesting device via ' + transport + '...');

        // requestDevice() must be in the call stack of this user gesture
        var descriptor = await provider.requestDevice(options);
        _log('info', 'Device selected: ' + descriptor.model);

        // Detect profile (Phase 6)
        var P       = _provs();
        var profile = descriptor.profile || P.PRINTER_PROFILES.GENERIC_58;
        _log('info', 'Profile detected: ' + profile.name);

        // Connect
        var connection = await provider.connect(descriptor, profile);
        _log('info', 'Connected.');

        // ESC/POS probe
        var escpos = new P.ESCPosProvider(provider, profile);
        var probeResult = await escpos.probe(connection);
        _log('info', 'ESC/POS probe: ' + (probeResult.compatible ? 'COMPATIBLE' : 'FAILED'));

        var pending = {
            descriptor:     descriptor,
            connection:     connection,
            provider:       provider,
            escpos:         escpos,
            profile:        profile,
            probeResult:    probeResult,
            transport:      transport,
        };

        _emit('pending', {
            transport: transport,
            model:     descriptor.model,
            profile:   profile.name,
            compatible:probeResult.compatible,
        });

        return pending;
    }

    /**
     * After the user has confirmed the test receipt printed correctly,
     * save the printer and make it active.
     *
     * @param {PendingPrinter} pending  — returned from connectPrinter()
     * @param {object}         [overrides]  — user-supplied label, paperWidth
     * @returns {Promise<string>}  saved printer ID
     */
    async function _confirmAndSave(pending, overrides) {
        var s = _store();
        overrides = overrides || {};

        var record = {
            transport:    pending.transport,
            model:        pending.descriptor.model,
            label:        overrides.label || pending.descriptor.model,
            paperWidth:   overrides.paperWidth || pending.profile.paperWidth,
            escposProfile:pending.profile.escposProfile || 'standard',
            vendorId:     pending.descriptor.vendorId  || null,
            productId:    pending.descriptor.productId || null,
            deviceId:     pending.descriptor.deviceId  || null,
            deviceName:   pending.descriptor.deviceName || null,
            networkHost:  pending.descriptor.networkHost || null,
            networkPort:  pending.descriptor.networkPort || null,
            isDefault:    true,
        };

        var saved = s ? await s.savePrinter(record) : { id: 'unsaved' };

        // If this is the first printer, it becomes default
        if (s) {
            var all = await s.getAllPrinters();
            if (all.length === 1) await s.setDefaultPrinter(saved.id);
            await s.saveSession(saved.id);
        }

        _setActivePrinter({
            descriptor: pending.descriptor,
            connection: pending.connection,
            provider:   pending.provider,
            escpos:     pending.escpos,
            savedId:    saved.id,
        });

        _log('info', 'Printer saved and activated: ' + saved.id);
        _emit('saved', { id: saved.id, model: record.model, transport: record.transport });

        return saved.id;
    }

    // ---------------------------------------------------------------------------
    // print() — sends a job to the active printer
    // ---------------------------------------------------------------------------

    /**
     * Print a receipt job.
     *
     * @param {Uint8Array|string} jobBytes  Pre-built ESC/POS bytes or HTML string
     * @param {string}            [printerId]  Optional — print to a specific saved printer
     */
    async function _print(jobBytes, printerId) {
        var ap = _activePrinter;
        if (!ap) {
            throw Object.assign(
                new Error('No printer is connected.'),
                { userMessage: 'No printer is connected. Please set up a printer first.' }
            );
        }
        _log('info', 'Printing job (' + jobBytes.length + ' bytes)...');
        try {
            await ap.escpos.send(ap.connection, jobBytes);
            var s = _store();
            if (s && ap.savedId) await s.recordPrint(ap.savedId);
            _emit('printed', { bytes: jobBytes.length });
        } catch (err) {
            _log('error', 'Print failed: ' + err.message, err);
            throw Object.assign(err, {
                userMessage: err.userMessage || 'Print failed: ' + err.message,
            });
        }
    }

    /**
     * Print a test receipt on the active printer.
     */
    async function _testPrint() {
        var ap = _activePrinter;
        if (!ap) throw new Error('No printer connected — cannot print test receipt.');
        var bytes = ap.escpos.buildTestReceipt();
        await _print(bytes);
        _emit('testPrint', { success: true });
        return true;
    }

    /**
     * Print test receipt on a pending (not yet saved) printer.
     * Used by the setup wizard between probe and save.
     *
     * @param {PendingPrinter} pending
     */
    async function _testPrintPending(pending) {
        var bytes = pending.escpos.buildTestReceipt();
        await pending.escpos.send(pending.connection, bytes);
        _emit('testPrint', { success: true, pending: true });
        return true;
    }

    // ---------------------------------------------------------------------------
    // openCashDrawer()
    // ---------------------------------------------------------------------------

    async function _openCashDrawer(pin) {
        var ap = _activePrinter;
        if (!ap) throw new Error('No printer connected — cannot open cash drawer.');
        await ap.escpos.kickDrawer(ap.connection, pin || 2);
        _emit('drawerKicked', { pin: pin || 2 });
    }

    // ---------------------------------------------------------------------------
    // forgetPrinter()
    // ---------------------------------------------------------------------------

    async function _forgetPrinter(printerId) {
        var s = _store();
        if (s && printerId) await s.removePrinter(printerId);

        // If the current active printer is being forgotten, disconnect it
        if (_activePrinter && _activePrinter.savedId === printerId) {
            try { await _activePrinter.provider.disconnect(_activePrinter.connection); } catch (_) {}
            _activePrinter = null;
            _emit('disconnected', { reason: 'forgotten', id: printerId });
        }
        _emit('printerRemoved', { id: printerId });
    }

    // ---------------------------------------------------------------------------
    // getCapabilities() — delegates to SokoniCapabilityDetector
    // ---------------------------------------------------------------------------

    function _getCapabilities() {
        var cap = _cap();
        return cap ? cap.report() : {};
    }

    // ---------------------------------------------------------------------------
    // report() — full diagnostic snapshot
    // ---------------------------------------------------------------------------

    async function _report() {
        var diag = _diag();
        if (diag) return diag.generate();

        // Minimal fallback if diagnostics module not loaded
        return {
            activePrinter: _activePrinter ? {
                model:     _activePrinter.descriptor.model,
                transport: _activePrinter.descriptor.transport || _activePrinter.provider.transport,
                connected: true,
            } : null,
            capabilities: _getCapabilities(),
            timestamp:    new Date().toISOString(),
        };
    }

    // ---------------------------------------------------------------------------
    // Error messages per transport
    // ---------------------------------------------------------------------------

    function _transportUnsupportedMsg(transport) {
        var msgs = {
            usb:       'USB printing is not supported on this browser. Use Chrome or Edge on desktop or Android.',
            bluetooth: 'Bluetooth printing is not supported on this browser. Use Chrome on Android or desktop.',
            serial:    'Serial printing requires Chrome or Edge on desktop (Windows/Mac/Linux only).',
            hid:       'HID device access requires Chrome or Edge on desktop.',
        };
        return msgs[transport] || ('The ' + transport + ' transport is not supported on this device.');
    }

    // ---------------------------------------------------------------------------
    // Public interface
    // ---------------------------------------------------------------------------

    global.HardwareManager = {

        /** Initialise the hardware layer. Safe to call multiple times. Does not request permissions. */
        init: function () { return _init(); },

        /**
         * Connect a new printer.
         * MUST be called from a user gesture (button click).
         *
         * @param {string} transport  'usb'|'bluetooth'|'network'|'browser'
         * @param {object} [options]  Transport options (e.g. {host, port} for network)
         * @returns {Promise<PendingPrinter>}
         */
        connectPrinter: function (transport, options) { return _connectPrinter(transport, options); },

        /**
         * After test receipt is confirmed, save and activate the printer.
         *
         * @param {PendingPrinter} pending
         * @param {object}         [overrides]
         * @returns {Promise<string>}  saved printer ID
         */
        confirmAndSave: function (pending, overrides) { return _confirmAndSave(pending, overrides); },

        /**
         * Print pre-built bytes or HTML via the active printer.
         *
         * @param {Uint8Array|string} jobBytes
         */
        print: function (jobBytes) { return _print(jobBytes); },

        /** Print a test receipt via the active printer. */
        testPrint: function () { return _testPrint(); },

        /** Print a test receipt on a pending (not yet saved) connection. */
        testPrintPending: function (pending) { return _testPrintPending(pending); },

        /** Kick the cash drawer connected to the active printer. */
        openCashDrawer: function (pin) { return _openCashDrawer(pin); },

        /** Remove a saved printer by ID. */
        forgetPrinter: function (id) { return _forgetPrinter(id); },

        /** Returns all saved printer records. */
        getSavedPrinters: function () {
            var s = _store();
            return s ? s.getAllPrinters() : Promise.resolve([]);
        },

        /** Returns the default saved printer record. */
        getDefaultPrinter: function () {
            var s = _store();
            return s ? s.getDefaultPrinter() : Promise.resolve(null);
        },

        /** Returns the currently active printer state (null if none). */
        getActivePrinter: function () { return _activePrinter; },

        /** Returns true if a printer is currently connected and active. */
        isConnected: function () { return !!_activePrinter; },

        /** Returns capability report from SokoniCapabilityDetector. */
        getCapabilities: function () { return _getCapabilities(); },

        /** Returns full hardware diagnostic report. */
        report: function () { return _report(); },

        /** Returns only transport-available options (for wizard UI). */
        getAvailableTransports: function () {
            var cap = _cap();
            return cap ? cap.availableTransports() : ['network', 'browser'];
        },

        /** Returns recommended transport for this device. */
        getRecommendedTransport: function () {
            var cap = _cap();
            return cap ? cap.recommendedTransport() : 'browser';
        },

        /**
         * Reconnect a specific saved printer (passive — no dialog).
         * Called automatically by HardwareRecovery on USB reconnect event.
         *
         * @param {string} savedId
         */
        reconnect: async function (savedId) {
            var s = _store();
            if (!s) return false;
            var record = await s.getPrinter(savedId);
            if (!record) return false;

            try {
                var provider      = _getProvider(record.transport);
                var storedDevices = await provider.getStoredDevices();
                var matched       = storedDevices.find(function (d) {
                    if (record.transport === 'bluetooth') return d.deviceId === record.deviceId;
                    if (record.transport === 'usb')
                        return d.vendorId === record.vendorId && d.productId === record.productId;
                    return false;
                });
                if (!matched) return false;

                var P          = _provs();
                var connection = await provider.connect(matched);
                var profile    = _resolveProfile(record.escposProfile) || P.PRINTER_PROFILES.GENERIC_58;
                var escpos     = new P.ESCPosProvider(provider, profile);

                _setActivePrinter({ descriptor: matched, connection, provider, escpos, savedId: record.id });
                await s.recordConnection(record.id);

                _log('info', 'Reconnected: ' + record.model);
                _emit('connected', { transport: record.transport, model: record.model, restored: true });
                return true;
            } catch (e) {
                _log('warn', 'Reconnect failed: ' + e.message);
                return false;
            }
        },

        /** Expose subsystems for diagnostics and testing only. */
        _internals: {
            get activePrinter()  { return _activePrinter; },
            get providers()      { return _providers;     },
            resetForTesting: function () {
                _activePrinter = null;
                _providers     = {};
                _initDone      = false;
                _initPromise   = null;
            },
        },
    };

})(window);
