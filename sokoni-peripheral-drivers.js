/**
 * SOKONI Peripheral Drivers v1.0
 *
 * All non-printer peripheral drivers:
 *   - Scanner (keyboard wedge / BarcodeDetector / camera)
 *   - Cash Drawer (via printer port ESC/POS)
 *   - NFC (Web NFC NDEFReader)
 *   - Scale (Web Serial RS-232)
 *   - Customer Display (Serial ASCII)
 *   - Payment Terminal (IntaSend + hardware stubs)
 *   - Biometric (WebAuthn)
 *
 * Each driver is registered with SokoniDriverManager at load time.
 * Application code never imports these directly — it calls
 *   SokoniHardware.<type>.execute(command, data)
 */

(function (global) {
    'use strict';

    function _db()   { return global.SokoniDriverBase || {}; }
    function _dm()   { return global.SokoniDriverManager; }
    function _wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _ok(msg, raw)  { return (_db().TestResult   || function (v, d) { return {ok:v, detail:d}; })(true,  msg, raw); }
    function _fail(msg, raw){ return (_db().TestResult   || function (v, d) { return {ok:v, detail:d}; })(false, msg, raw); }
    function _stat(state, detail) {
        return (_db().StatusResult || function (s, d) { return {state:s, detail:d}; })(state, detail);
    }
    function _diag(id, transport, profile, checks, errors) {
        return (_db().DiagnosticsResult || function (a, b, c, d, e) { return {driverId:a, transport:b, profile:c, checks:d, errors:e}; })(id, transport, profile, checks, errors);
    }

    // =========================================================================
    // 1. SCANNER DRIVERS
    // =========================================================================

    // ── 1a. Keyboard-wedge scanner (input event listener) ────────────────────

    function KeyboardScannerDriver() {
        this._connection = null;
        this._profile    = null;
        this._connected  = false;
        this._buffer     = '';
        this._timer      = null;
        this._handler    = null;
        this._listeners  = [];
    }

    KeyboardScannerDriver.driverType          = 'scanner';
    KeyboardScannerDriver.driverId            = 'keyboard-scanner';
    KeyboardScannerDriver.supportedTransports = ['hid', 'usb'];
    KeyboardScannerDriver.supportedProfileIds = ['KEYBOARD_WEDGE'];
    KeyboardScannerDriver.detect = function (p) {
        return p && (p.protocol === 'keyboard' || p.driver === 'keyboard-scanner');
    };

    KeyboardScannerDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;

        var self = this;
        this._handler = function (e) {
            if (e.key === 'Enter') {
                if (self._buffer.length > 0) {
                    self._emit(self._buffer);
                    self._buffer = '';
                }
                clearTimeout(self._timer);
                return;
            }
            if (e.key.length === 1) {
                self._buffer += e.key;
                clearTimeout(self._timer);
                // Auto-commit after 100ms gap (some scanners don't send Enter)
                self._timer = setTimeout(function () {
                    if (self._buffer.length > 3) {
                        self._emit(self._buffer);
                        self._buffer = '';
                    }
                }, 100);
            }
        };
        document.addEventListener('keydown', this._handler);
        return Promise.resolve();
    };

    KeyboardScannerDriver.prototype._emit = function (barcode) {
        var e = new CustomEvent('hw:scanner:scan', { detail: { barcode: barcode, driver: 'keyboard-scanner' }, bubbles: true });
        global.dispatchEvent(e);
        this._listeners.forEach(function (fn) { try { fn(barcode); } catch (_) {} });
    };

    KeyboardScannerDriver.prototype.execute = function (command, data) {
        if (command === 'onScan' && typeof data.callback === 'function') {
            this._listeners.push(data.callback);
            return Promise.resolve({ unsubscribe: function () {
                var i = this._listeners.indexOf(data.callback);
                if (i !== -1) this._listeners.splice(i, 1);
            }.bind(this) });
        }
        if (command === 'status') return this.status();
        return Promise.reject(new Error('keyboard-scanner: unknown command ' + command));
    };

    KeyboardScannerDriver.prototype.test = function () {
        return Promise.resolve(_ok('Keyboard scanner active — scan a barcode to test'));
    };
    KeyboardScannerDriver.prototype.status = function () {
        return Promise.resolve(_stat(this._connected ? 'online' : 'offline', 'Keyboard scanner listens for keydown events'));
    };
    KeyboardScannerDriver.prototype.recover = function () { return Promise.resolve(true); };
    KeyboardScannerDriver.prototype.diagnostics = function () {
        return Promise.resolve(_diag('keyboard-scanner', 'hid', this._profile ? this._profile.id : 'none', { connected: this._connected }, []));
    };
    KeyboardScannerDriver.prototype.disconnect = function () {
        this._connected = false;
        if (this._handler) document.removeEventListener('keydown', this._handler);
        return Promise.resolve();
    };
    KeyboardScannerDriver.prototype.isConnected = function () { return this._connected; };

    // ── 1b. HID Scanner ───────────────────────────────────────────────────────

    function HIDScannerDriver() {
        KeyboardScannerDriver.call(this);
        this._hidDevice = null;
    }
    HIDScannerDriver.prototype = Object.create(KeyboardScannerDriver.prototype);
    HIDScannerDriver.prototype.constructor = HIDScannerDriver;

    HIDScannerDriver.driverType          = 'scanner';
    HIDScannerDriver.driverId            = 'hid-scanner';
    HIDScannerDriver.supportedTransports = ['hid', 'usb'];
    HIDScannerDriver.supportedProfileIds = ['HONEYWELL_VOYAGER', 'DATALOGIC_GRYPHON', 'ZEBRA_LS2208'];
    HIDScannerDriver.detect = function (p) {
        return p && (p.protocol === 'hid' || p.driver === 'hid-scanner');
    };

    HIDScannerDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;

        // HID scanners typically output as keyboard — fall through to keydown
        var self = this;
        this._handler = function (e) {
            if (e.key === 'Enter' && self._buffer.length > 0) {
                self._emit(self._buffer);
                self._buffer = '';
                return;
            }
            if (e.key.length === 1) { self._buffer += e.key; }
        };
        document.addEventListener('keydown', this._handler);
        return Promise.resolve();
    };

    // =========================================================================
    // 2. CASH DRAWER DRIVER (via printer's ESC/POS kick command)
    // =========================================================================

    function PrinterCashDrawerDriver() {
        this._connection = null;
        this._profile    = null;
        this._connected  = false;
    }

    PrinterCashDrawerDriver.driverType          = 'drawer';
    PrinterCashDrawerDriver.driverId            = 'printer-drawer';
    PrinterCashDrawerDriver.supportedTransports = ['usb', 'bluetooth', 'serial', 'network'];
    PrinterCashDrawerDriver.supportedProfileIds = ['PRINTER_DRAWER', 'APG_VASARIO', 'MMF_225'];
    PrinterCashDrawerDriver.detect = function (p) {
        return p && (p.type === 'drawer' || p.driver === 'printer-drawer' || p.driver === 'escpos-drawer');
    };

    PrinterCashDrawerDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;
        return Promise.resolve();
    };

    PrinterCashDrawerDriver.prototype.execute = function (command, data) {
        data = data || {};
        if (command === 'open' || command === 'kick') {
            var pin = data.pin || 2;
            var cmds = this._profile && this._profile.commands;
            var kick = cmds ? (pin === 5 ? cmds.kick5 : cmds.kick2) : [0x1B, 0x70, 0x00, 0x19, 0xFA];
            if (!kick) return Promise.resolve();
            return this._connection.write(new Uint8Array(kick));
        }
        if (command === 'status') return this.status();
        return Promise.reject(new Error('printer-drawer: unknown command ' + command));
    };

    PrinterCashDrawerDriver.prototype.test = async function () {
        try {
            await this.execute('kick', { pin: 2 });
            return _ok('Cash drawer kick sent (pin 2)');
        } catch (e) {
            return _fail('Cash drawer kick failed: ' + e.message);
        }
    };
    PrinterCashDrawerDriver.prototype.status = function () {
        return Promise.resolve(_stat(this._connected ? 'online' : 'offline', 'Drawer state is not readable via ESC/POS kick'));
    };
    PrinterCashDrawerDriver.prototype.recover = function () { return Promise.resolve(false); };
    PrinterCashDrawerDriver.prototype.diagnostics = function () {
        return Promise.resolve(_diag('printer-drawer', this._connection ? this._connection.transport : 'none', this._profile ? this._profile.id : 'none', { connected: this._connected }, []));
    };
    PrinterCashDrawerDriver.prototype.disconnect = function () {
        this._connected = false;
        return Promise.resolve();
    };
    PrinterCashDrawerDriver.prototype.isConnected = function () { return this._connected; };

    // =========================================================================
    // 3. NFC DRIVER (Web NFC — NDEFReader)
    // =========================================================================

    function WebNFCDriver() {
        this._connection = null;
        this._profile    = null;
        this._connected  = false;
        this._reader     = null;
        this._abort      = null;
        this._listeners  = [];
    }

    WebNFCDriver.driverType          = 'nfc';
    WebNFCDriver.driverId            = 'web-nfc';
    WebNFCDriver.supportedTransports = ['browser'];
    WebNFCDriver.supportedProfileIds = ['WEB_NFC'];
    WebNFCDriver.detect = function (p) {
        return p && (p.protocol === 'ndef' || p.driver === 'web-nfc');
    };

    WebNFCDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = 'NDEFReader' in global;
        if (!this._connected) return Promise.reject(new Error('Web NFC is not supported on this device'));

        var self = this;
        this._reader = new global.NDEFReader();
        this._abort  = new AbortController();

        this._reader.addEventListener('reading', function (event) {
            self._listeners.forEach(function (fn) {
                try { fn({ serialNumber: event.serialNumber, records: event.message.records }); } catch (_) {}
            });
            global.dispatchEvent(new CustomEvent('hw:nfc:read', { detail: { serialNumber: event.serialNumber, records: event.message.records }, bubbles: false }));
        });

        return this._reader.scan({ signal: this._abort.signal }).then(function () { self._connected = true; });
    };

    WebNFCDriver.prototype.execute = function (command, data) {
        data = data || {};
        if (command === 'onRead' && typeof data.callback === 'function') {
            this._listeners.push(data.callback);
            return Promise.resolve();
        }
        if (command === 'write' && data.records) {
            return this._reader.write({ records: data.records });
        }
        if (command === 'status') return this.status();
        return Promise.reject(new Error('web-nfc: unknown command ' + command));
    };

    WebNFCDriver.prototype.test = function () {
        return Promise.resolve(_ok('NFC scanning active — tap an NFC tag to test'));
    };
    WebNFCDriver.prototype.status = function () {
        return Promise.resolve(_stat(this._connected ? 'online' : 'offline', 'NDEFReader' in global ? 'Web NFC available' : 'Web NFC not supported'));
    };
    WebNFCDriver.prototype.recover = function () { return Promise.resolve(false); };
    WebNFCDriver.prototype.diagnostics = function () {
        return Promise.resolve(_diag('web-nfc', 'browser', 'WEB_NFC', { supported: 'NDEFReader' in global, connected: this._connected }, []));
    };
    WebNFCDriver.prototype.disconnect = function () {
        this._connected = false;
        if (this._abort) this._abort.abort();
        return Promise.resolve();
    };
    WebNFCDriver.prototype.isConnected = function () { return this._connected; };

    // =========================================================================
    // 4. SCALE DRIVER (Web Serial RS-232)
    // =========================================================================

    function SerialScaleDriver() {
        this._connection = null;
        this._profile    = null;
        this._connected  = false;
        this._lastWeight = null;
    }

    SerialScaleDriver.driverType          = 'scale';
    SerialScaleDriver.driverId            = 'serial-scale';
    SerialScaleDriver.supportedTransports = ['serial'];
    SerialScaleDriver.supportedProfileIds = ['OHAUS_RANGER', 'CAS_SW1'];
    SerialScaleDriver.detect = function (p) {
        return p && (p.protocol === 'serial-ascii' && p.type === 'scale');
    };

    SerialScaleDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;
        return Promise.resolve();
    };

    SerialScaleDriver.prototype.execute = async function (command, data) {
        data = data || {};
        var cmds = this._profile && this._profile.commands;
        if (!cmds) return Promise.reject(new Error('No command profile for scale'));

        switch (command) {
            case 'read':
            case 'weigh': {
                var enc = new TextEncoder();
                await this._connection.write(enc.encode(cmds.read || 'P\r\n'));
                await _wait(200);
                var resp = await this._connection.read(1000);
                var text = new TextDecoder().decode(resp).trim();
                var weight = parseFloat(text.replace(/[^\d.-]/g, ''));
                if (!isNaN(weight)) this._lastWeight = weight;
                return { weight: weight, raw: text, unit: 'kg' };
            }
            case 'tare':
                await this._connection.write(new TextEncoder().encode(cmds.tare || 'T\r\n'));
                return { tared: true };
            case 'zero':
                await this._connection.write(new TextEncoder().encode(cmds.zero || 'Z\r\n'));
                return { zeroed: true };
            case 'status':
                return this.status();
            default:
                return Promise.reject(new Error('serial-scale: unknown command ' + command));
        }
    };

    SerialScaleDriver.prototype.test = async function () {
        try {
            var result = await this.execute('read');
            return _ok('Scale read: ' + result.weight + ' kg');
        } catch (e) {
            return _fail('Scale read failed: ' + e.message);
        }
    };
    SerialScaleDriver.prototype.status = function () {
        return Promise.resolve(_stat(this._connected ? 'online' : 'offline', 'Last weight: ' + (this._lastWeight !== null ? this._lastWeight + ' kg' : 'not read')));
    };
    SerialScaleDriver.prototype.recover = function () { return Promise.resolve(false); };
    SerialScaleDriver.prototype.diagnostics = function () {
        return Promise.resolve(_diag('serial-scale', 'serial', this._profile ? this._profile.id : 'none', { connected: this._connected, lastWeight: this._lastWeight }, []));
    };
    SerialScaleDriver.prototype.disconnect = function () {
        this._connected = false;
        if (this._connection) { try { this._connection.close(); } catch (_) {} }
        return Promise.resolve();
    };
    SerialScaleDriver.prototype.isConnected = function () { return this._connected; };

    // =========================================================================
    // 5. CUSTOMER DISPLAY DRIVER (Serial ASCII)
    // =========================================================================

    function SerialDisplayDriver() {
        this._connection = null;
        this._profile    = null;
        this._connected  = false;
    }

    SerialDisplayDriver.driverType          = 'display';
    SerialDisplayDriver.driverId            = 'serial-display';
    SerialDisplayDriver.supportedTransports = ['serial', 'usb'];
    SerialDisplayDriver.supportedProfileIds = ['EPSON_DM_D110', 'GENERIC_VFD'];
    SerialDisplayDriver.detect = function (p) {
        return p && (p.type === 'display' && (p.protocol === 'serial-ascii' || !p.protocol));
    };

    SerialDisplayDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;
        return Promise.resolve();
    };

    SerialDisplayDriver.prototype.execute = async function (command, data) {
        data = data || {};
        var enc = new TextEncoder();
        switch (command) {
            case 'clear':
                return this._connection.write(enc.encode('\x0C'));
            case 'write': {
                var rows = data.rows || [];
                var text = rows.slice(0, 2).map(function (r) { return r.slice(0, 20).padEnd(20); }).join('');
                await this._connection.write(enc.encode('\x0C' + text));
                return;
            }
            case 'message': {
                var msg = (data.line1 || '').slice(0, 20).padEnd(20);
                var sub = (data.line2 || '').slice(0, 20).padEnd(20);
                await this._connection.write(enc.encode('\x0C' + msg + sub));
                return;
            }
            case 'status':
                return this.status();
            default:
                return Promise.reject(new Error('serial-display: unknown command ' + command));
        }
    };

    SerialDisplayDriver.prototype.test = async function () {
        try {
            await this.execute('message', { line1: '   SOKONI POS   ', line2: '  Hardware Test  ' });
            return _ok('Customer display test message sent');
        } catch (e) {
            return _fail('Display write failed: ' + e.message);
        }
    };
    SerialDisplayDriver.prototype.status = function () {
        return Promise.resolve(_stat(this._connected ? 'online' : 'offline', 'VFD display via serial'));
    };
    SerialDisplayDriver.prototype.recover = function () { return Promise.resolve(false); };
    SerialDisplayDriver.prototype.diagnostics = function () {
        return Promise.resolve(_diag('serial-display', 'serial', this._profile ? this._profile.id : 'none', { connected: this._connected }, []));
    };
    SerialDisplayDriver.prototype.disconnect = function () {
        this._connected = false;
        if (this._connection) { try { this._connection.close(); } catch (_) {} }
        return Promise.resolve();
    };
    SerialDisplayDriver.prototype.isConnected = function () { return this._connected; };

    // =========================================================================
    // 6. PAYMENT TERMINAL DRIVER
    // =========================================================================

    // ── 6a. IntaSend (cloud M-Pesa + card) ────────────────────────────────────

    function IntaSendTerminalDriver() {
        this._connection = null;
        this._profile    = null;
        this._connected  = false;
    }

    IntaSendTerminalDriver.driverType          = 'terminal';
    IntaSendTerminalDriver.driverId            = 'intasend-terminal';
    IntaSendTerminalDriver.supportedTransports = ['network', 'browser'];
    IntaSendTerminalDriver.supportedProfileIds = ['INTASEND'];
    IntaSendTerminalDriver.detect = function (p) {
        return p && (p.driver === 'intasend-terminal' || p.id === 'INTASEND');
    };

    IntaSendTerminalDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;
        return Promise.resolve();
    };

    IntaSendTerminalDriver.prototype.execute = function (command, data) {
        data = data || {};
        switch (command) {
            case 'requestPayment':
                return this._requestPayment(data);
            case 'queryStatus':
                return this._queryStatus(data.invoiceId);
            case 'status':
                return this.status();
            default:
                return Promise.reject(new Error('intasend-terminal: unknown command ' + command));
        }
    };

    IntaSendTerminalDriver.prototype._requestPayment = async function (data) {
        // Calls the SOKONI Cloud Function which wraps IntaSend SDK
        var resp = await fetch('https://us-central1-sokoni-aeb26.cloudfunctions.net/initiatePayment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                amount:   data.amount,
                currency: data.currency || 'KES',
                phone:    data.phone,
                method:   data.method || 'mpesa',
                ref:      data.ref,
            }),
        });
        if (!resp.ok) throw new Error('Payment request failed: ' + resp.status);
        return resp.json();
    };

    IntaSendTerminalDriver.prototype._queryStatus = async function (invoiceId) {
        var resp = await fetch('https://us-central1-sokoni-aeb26.cloudfunctions.net/getPaymentStatus?invoiceId=' + encodeURIComponent(invoiceId));
        if (!resp.ok) throw new Error('Status query failed: ' + resp.status);
        return resp.json();
    };

    IntaSendTerminalDriver.prototype.test = function () {
        return Promise.resolve(_ok('IntaSend terminal ready (cloud)'));
    };
    IntaSendTerminalDriver.prototype.status = function () {
        return Promise.resolve(_stat('online', 'IntaSend cloud terminal'));
    };
    IntaSendTerminalDriver.prototype.recover = function () { return Promise.resolve(false); };
    IntaSendTerminalDriver.prototype.diagnostics = function () {
        return Promise.resolve(_diag('intasend-terminal', 'network', 'INTASEND', { connected: this._connected }, []));
    };
    IntaSendTerminalDriver.prototype.disconnect = function () {
        this._connected = false;
        return Promise.resolve();
    };
    IntaSendTerminalDriver.prototype.isConnected = function () { return this._connected; };

    // =========================================================================
    // 7. BIOMETRIC DRIVER (WebAuthn)
    // =========================================================================

    function WebAuthnBiometricDriver() {
        this._connection = null;
        this._profile    = null;
        this._connected  = false;
    }

    WebAuthnBiometricDriver.driverType          = 'biometric';
    WebAuthnBiometricDriver.driverId            = 'webauthn-biometric';
    WebAuthnBiometricDriver.supportedTransports = ['browser'];
    WebAuthnBiometricDriver.supportedProfileIds = ['WEBAUTHN_PLATFORM'];
    WebAuthnBiometricDriver.detect = function (p) {
        return p && (p.protocol === 'webauthn' || p.driver === 'webauthn-biometric');
    };

    WebAuthnBiometricDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = !!(navigator.credentials && global.PublicKeyCredential);
        return this._connected ? Promise.resolve() : Promise.reject(new Error('WebAuthn not supported on this platform'));
    };

    WebAuthnBiometricDriver.prototype.execute = function (command, data) {
        data = data || {};
        switch (command) {
            case 'verify':
                return this._verify(data);
            case 'register':
                return this._register(data);
            case 'available':
                return global.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            case 'status':
                return this.status();
            default:
                return Promise.reject(new Error('webauthn: unknown command ' + command));
        }
    };

    WebAuthnBiometricDriver.prototype._verify = async function (data) {
        var challenge = data.challenge || crypto.getRandomValues(new Uint8Array(32));
        var credential = await navigator.credentials.get({
            publicKey: {
                challenge:        challenge,
                rpId:             data.rpId || global.location.hostname,
                userVerification: 'required',
                timeout:          60000,
                allowCredentials: data.allowCredentials || [],
            },
        });
        return { verified: true, credentialId: credential.id };
    };

    WebAuthnBiometricDriver.prototype._register = async function (data) {
        var challenge = data.challenge || crypto.getRandomValues(new Uint8Array(32));
        var credential = await navigator.credentials.create({
            publicKey: {
                challenge:              challenge,
                rp:                     { name: data.rpName || 'SOKONI', id: data.rpId || global.location.hostname },
                user:                   { id: new TextEncoder().encode(data.userId || 'user'), name: data.userName || 'user', displayName: data.displayName || 'User' },
                pubKeyCredParams:       [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
                authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
                timeout:                60000,
            },
        });
        return { registered: true, credentialId: credential.id };
    };

    WebAuthnBiometricDriver.prototype.test = async function () {
        try {
            var avail = await global.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            return avail ? _ok('Platform biometric is available') : _fail('Platform biometric is not available on this device');
        } catch (e) {
            return _fail('Biometric check failed: ' + e.message);
        }
    };
    WebAuthnBiometricDriver.prototype.status = function () {
        var avail = !!(navigator.credentials && global.PublicKeyCredential);
        return Promise.resolve(_stat(avail ? 'online' : 'offline', 'WebAuthn platform authenticator'));
    };
    WebAuthnBiometricDriver.prototype.recover = function () { return Promise.resolve(false); };
    WebAuthnBiometricDriver.prototype.diagnostics = function () {
        return Promise.resolve(_diag('webauthn-biometric', 'browser', 'WEBAUTHN_PLATFORM', {
            supported: !!(navigator.credentials && global.PublicKeyCredential),
            connected: this._connected,
        }, []));
    };
    WebAuthnBiometricDriver.prototype.disconnect = function () {
        this._connected = false;
        return Promise.resolve();
    };
    WebAuthnBiometricDriver.prototype.isConnected = function () { return this._connected; };

    // =========================================================================
    // Register all peripheral drivers
    // =========================================================================

    var ALL_DRIVERS = [
        KeyboardScannerDriver,
        HIDScannerDriver,
        PrinterCashDrawerDriver,
        WebNFCDriver,
        SerialScaleDriver,
        SerialDisplayDriver,
        IntaSendTerminalDriver,
        WebAuthnBiometricDriver,
    ];

    function _registerAll() {
        var dm = _dm();
        if (!dm) return;
        ALL_DRIVERS.forEach(function (D) { try { dm.register(D); } catch (_) {} });
    }

    if (global.SokoniDriverManager) {
        _registerAll();
    } else {
        global.addEventListener('DOMContentLoaded', function () {
            if (global.SokoniDriverManager) _registerAll();
        });
    }

    // =========================================================================
    // Export
    // =========================================================================

    global.SokoniPeripheralDrivers = {
        KeyboardScannerDriver:   KeyboardScannerDriver,
        HIDScannerDriver:        HIDScannerDriver,
        PrinterCashDrawerDriver: PrinterCashDrawerDriver,
        WebNFCDriver:            WebNFCDriver,
        SerialScaleDriver:       SerialScaleDriver,
        SerialDisplayDriver:     SerialDisplayDriver,
        IntaSendTerminalDriver:  IntaSendTerminalDriver,
        WebAuthnBiometricDriver: WebAuthnBiometricDriver,
    };

})(window);
