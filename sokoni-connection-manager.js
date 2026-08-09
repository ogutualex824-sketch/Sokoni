/**
 * SOKONI Connection Manager v1.0
 *
 * Returns transport-agnostic Connection objects with a uniform API:
 *   connection.write(bytes)        → Promise<void>
 *   connection.read(timeoutMs)     → Promise<Uint8Array>
 *   connection.close()             → Promise<void>
 *   connection.isConnected         → boolean
 *   connection.transport           → string
 *   connection.descriptor          → object   Raw device descriptor
 *
 * Supported transports:
 *   usb       — WebUSB bulk-OUT endpoint
 *   bluetooth — Web Bluetooth GATT characteristic write
 *   serial    — Web Serial port write stream
 *   network   — SOKONI Desktop bridge (localhost:9101) → Cloud Function fallback
 *   android   — window.SokoniAndroid.printESCPOS() (Bluetooth Classic SPP)
 *   browser   — window.print() text fallback
 *
 * Rules:
 *   - NEVER call requestDevice / requestPort here. This module only
 *     uses devices that were already granted.
 *   - Chunking and inter-chunk delays are driven by the profile, not
 *     hardcoded here.
 *   - read() returns an empty Uint8Array if the transport is write-only.
 */

(function (global) {
    'use strict';

    var BRIDGE_URL = 'http://localhost:9101';
    var PROXY_CF   = 'https://us-central1-sokoni-aeb26.cloudfunctions.net/posPrint';

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function _ab2u8(buf) {
        return buf instanceof Uint8Array ? buf : new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf);
    }

    function _u8b64(u8) {
        var bin = '';
        for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        return btoa(bin);
    }

    function _noop() { return Promise.resolve(new Uint8Array(0)); }

    // ─── Connection base ──────────────────────────────────────────────────────

    function Connection(transport, descriptor, opts) {
        this.transport    = transport;
        this.descriptor   = descriptor || {};
        this._opts        = opts || {};
        this.isConnected  = true;
        this._profile     = opts && opts.profile || null;
    }

    Connection.prototype.write = function () {
        return Promise.reject(new Error('write() not implemented for transport: ' + this.transport));
    };
    Connection.prototype.read = _noop;
    Connection.prototype.close = function () {
        this.isConnected = false;
        return Promise.resolve();
    };

    // =========================================================================
    // USB Connection
    // =========================================================================

    function USBConnection(device, descriptor, profile) {
        Connection.call(this, 'usb', descriptor, { profile: profile });
        this._device    = device;
        this._endpoint  = null;  // set by _findEndpoint()
        this._interface = null;
        this._chunkSize = (profile && profile.connection && profile.connection.usb && profile.connection.usb.chunkSize) || 512;
    }
    USBConnection.prototype = Object.create(Connection.prototype);
    USBConnection.prototype.constructor = USBConnection;

    USBConnection.prototype._findEndpoint = function () {
        var config = this._device.configuration;
        if (!config) return null;

        // Prefer USB printer class (class 7) interface
        for (var i = 0; i < config.interfaces.length; i++) {
            var intf = config.interfaces[i];
            for (var j = 0; j < intf.alternates.length; j++) {
                var alt = intf.alternates[j];
                if (alt.interfaceClass === 7) {
                    for (var k = 0; k < alt.endpoints.length; k++) {
                        var ep = alt.endpoints[k];
                        if (ep.direction === 'out') {
                            return { interfaceNumber: intf.interfaceNumber, endpointNumber: ep.endpointNumber };
                        }
                    }
                }
            }
        }

        // Fallback: first bulk-OUT endpoint on interface 0
        var intf0 = config.interfaces[0];
        if (intf0) {
            for (var m = 0; m < intf0.alternates.length; m++) {
                for (var n = 0; n < intf0.alternates[m].endpoints.length; n++) {
                    var ep2 = intf0.alternates[m].endpoints[n];
                    if (ep2.direction === 'out' && ep2.type === 'bulk') {
                        return { interfaceNumber: intf0.interfaceNumber, endpointNumber: ep2.endpointNumber };
                    }
                }
            }
        }
        return null;
    };

    USBConnection.prototype.setup = async function () {
        await this._device.open();
        if (this._device.configuration === null) {
            await this._device.selectConfiguration(1);
        }
        var ep = this._findEndpoint();
        if (!ep) throw new Error('No bulk-OUT endpoint found on USB printer');
        await this._device.claimInterface(ep.interfaceNumber);
        this._interface = ep.interfaceNumber;
        this._endpoint  = ep.endpointNumber;
    };

    USBConnection.prototype.write = async function (bytes) {
        if (!this.isConnected || !this._endpoint) throw new Error('USB connection not ready');
        var u8   = _ab2u8(bytes);
        var size = this._chunkSize;
        for (var i = 0; i < u8.length; i += size) {
            await this._device.transferOut(this._endpoint, u8.slice(i, i + size));
        }
    };

    USBConnection.prototype.close = async function () {
        this.isConnected = false;
        try {
            if (this._interface !== null) {
                await this._device.releaseInterface(this._interface);
            }
            await this._device.close();
        } catch (_) {}
    };

    // =========================================================================
    // Bluetooth (BLE) Connection
    // =========================================================================

    function BluetoothConnection(device, descriptor, profile) {
        Connection.call(this, 'bluetooth', descriptor, { profile: profile });
        this._device    = device;
        this._server    = null;
        this._char      = null;
        this._chunkSize = (profile && profile.connection && profile.connection.bluetooth && profile.connection.bluetooth.chunkSize) || 128;
        this._delayMs   = (profile && profile.connection && profile.connection.bluetooth && profile.connection.bluetooth.delayMs)   || 20;
        this._useResp   = !!(profile && profile.connection && profile.connection.bluetooth && profile.connection.bluetooth.useResponse);
    }
    BluetoothConnection.prototype = Object.create(Connection.prototype);
    BluetoothConnection.prototype.constructor = BluetoothConnection;

    var BLE_SERVICES    = ['0000ff00-0000-1000-8000-00805f9b34fb', '000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '6e400001-b5a3-f393-e0a9-e50e24dcca9e', '0000ffe0-0000-1000-8000-00805f9b34fb'];
    var BLE_WRITE_CHARS = ['0000ff02-0000-1000-8000-00805f9b34fb', '00002af1-0000-1000-8000-00805f9b34fb', 'bef8d6c9-92a3-4e29-9f6a-d2cc7e0fc3d1', '49535343-8841-43f4-a8d4-ecbe34729bb3', '6e400002-b5a3-f393-e0a9-e50e24dcca9e', '0000ffe1-0000-1000-8000-00805f9b34fb'];

    BluetoothConnection.prototype.setup = async function () {
        this._server = await this._device.gatt.connect();

        // Use profile's service/char lists if available
        var services = (this._profile && this._profile.bluetooth && this._profile.bluetooth.services) || BLE_SERVICES;
        var chars    = (this._profile && this._profile.bluetooth && this._profile.bluetooth.writeChars)|| BLE_WRITE_CHARS;

        for (var i = 0; i < services.length; i++) {
            try {
                var svc = await this._server.getPrimaryService(services[i]);
                for (var j = 0; j < chars.length; j++) {
                    try {
                        this._char = await svc.getCharacteristic(chars[j]);
                        return; // Found
                    } catch (_) {}
                }
                // Try all characteristics on this service
                var all = await svc.getCharacteristics();
                for (var k = 0; k < all.length; k++) {
                    var props = all[k].properties;
                    if (props.write || props.writeWithoutResponse) {
                        this._char = all[k];
                        return;
                    }
                }
            } catch (_) {}
        }

        throw new Error('No writable GATT characteristic found on ' + (this._device.name || 'Bluetooth device'));
    };

    BluetoothConnection.prototype.write = async function (bytes) {
        if (!this.isConnected || !this._char) throw new Error('Bluetooth connection not ready');
        var u8   = _ab2u8(bytes);
        var size = this._chunkSize;
        for (var i = 0; i < u8.length; i += size) {
            var chunk = u8.slice(i, i + size);
            if (this._useResp) {
                await this._char.writeValueWithResponse(chunk);
            } else {
                await this._char.writeValueWithoutResponse(chunk);
            }
            if (this._delayMs > 0 && i + size < u8.length) {
                await _wait(this._delayMs);
            }
        }
    };

    BluetoothConnection.prototype.close = async function () {
        this.isConnected = false;
        try {
            if (this._device.gatt.connected) {
                this._device.gatt.disconnect();
            }
        } catch (_) {}
    };

    // =========================================================================
    // Serial Connection (Web Serial)
    // =========================================================================

    function SerialConnection(port, descriptor, profile) {
        Connection.call(this, 'serial', descriptor, { profile: profile });
        this._port      = port;
        this._writer    = null;
        this._reader    = null;
        var sc          = profile && profile.connection && profile.connection.serial;
        this._baudRate  = (sc && sc.baudRate) || 115200;
    }
    SerialConnection.prototype = Object.create(Connection.prototype);
    SerialConnection.prototype.constructor = SerialConnection;

    SerialConnection.prototype.setup = async function () {
        await this._port.open({ baudRate: this._baudRate });
        this._writer = this._port.writable.getWriter();
        this._reader = this._port.readable.getReader();
    };

    SerialConnection.prototype.write = async function (bytes) {
        if (!this.isConnected || !this._writer) throw new Error('Serial connection not ready');
        await this._writer.write(_ab2u8(bytes));
    };

    SerialConnection.prototype.read = function (timeoutMs) {
        var self = this;
        timeoutMs = timeoutMs || 2000;
        return new Promise(function (resolve) {
            var timer = setTimeout(function () { resolve(new Uint8Array(0)); }, timeoutMs);
            if (!self._reader) { clearTimeout(timer); resolve(new Uint8Array(0)); return; }
            self._reader.read().then(function (result) {
                clearTimeout(timer);
                resolve(result.done ? new Uint8Array(0) : _ab2u8(result.value));
            }).catch(function () { clearTimeout(timer); resolve(new Uint8Array(0)); });
        });
    };

    SerialConnection.prototype.close = async function () {
        this.isConnected = false;
        try { if (this._writer) { await this._writer.close(); } } catch (_) {}
        try { if (this._reader) { this._reader.cancel(); } } catch (_) {}
        try { await this._port.close(); } catch (_) {}
    };

    // =========================================================================
    // Network Connection (bridge + CF proxy)
    // =========================================================================

    function NetworkConnection(host, descriptor, profile) {
        Connection.call(this, 'network', descriptor, { profile: profile });
        this._host    = host || '127.0.0.1';
        this._port    = (profile && profile.network && profile.network.defaultPort) || 9100;
        this._bridge  = null;  // set by setup() — 'bridge' | 'proxy' | null
        this._timeout = (profile && profile.connection && profile.connection.network && profile.connection.network.timeout) || 5000;
    }
    NetworkConnection.prototype = Object.create(Connection.prototype);
    NetworkConnection.prototype.constructor = NetworkConnection;

    NetworkConnection.prototype.setup = async function () {
        // Check if the local SOKONI Desktop bridge is alive
        try {
            var ctrl = new AbortController();
            var t = setTimeout(function () { ctrl.abort(); }, 2000);
            var resp = await fetch(BRIDGE_URL + '/ping', { signal: ctrl.signal });
            clearTimeout(t);
            if (resp.ok) { this._bridge = 'bridge'; return; }
        } catch (_) {}

        this._bridge = 'proxy';
    };

    NetworkConnection.prototype.write = async function (bytes) {
        if (!this.isConnected) throw new Error('Network connection not ready');
        var b64 = _u8b64(_ab2u8(bytes));

        if (this._bridge === 'bridge') {
            var ctrl = new AbortController();
            var t = setTimeout(function () { ctrl.abort(); }, this._timeout);
            try {
                var resp = await fetch(BRIDGE_URL + '/print', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ host: this._host, port: this._port, data: b64 }),
                    signal: ctrl.signal,
                });
                clearTimeout(t);
                if (!resp.ok) throw new Error('Bridge error: ' + resp.status);
                return;
            } catch (e) {
                clearTimeout(t);
                if (e.name !== 'AbortError') throw e;
            }
        }

        // Cloud Function proxy fallback
        var resp2 = await fetch(PROXY_CF, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: this._host, port: this._port, data: b64 }),
        });
        if (!resp2.ok) throw new Error('Network proxy error: ' + resp2.status);
    };

    NetworkConnection.prototype.close = function () {
        this.isConnected = false;
        return Promise.resolve();
    };

    // =========================================================================
    // Android Bridge Connection (Bluetooth Classic SPP)
    // =========================================================================

    function AndroidConnection(descriptor, profile) {
        Connection.call(this, 'android', descriptor, { profile: profile });
    }
    AndroidConnection.prototype = Object.create(Connection.prototype);
    AndroidConnection.prototype.constructor = AndroidConnection;

    AndroidConnection.prototype.setup = function () {
        if (!global.SokoniAndroid || typeof global.SokoniAndroid.printESCPOS !== 'function') {
            return Promise.reject(new Error('SokoniAndroid bridge is not available'));
        }
        return Promise.resolve();
    };

    AndroidConnection.prototype.write = function (bytes) {
        try {
            var u8  = _ab2u8(bytes);
            var b64 = _u8b64(u8);
            global.SokoniAndroid.printESCPOS(b64);
            return Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    };

    // =========================================================================
    // Browser Connection (window.print fallback)
    // =========================================================================

    function BrowserConnection(descriptor) {
        Connection.call(this, 'browser', descriptor || {}, {});
    }
    BrowserConnection.prototype = Object.create(Connection.prototype);
    BrowserConnection.prototype.constructor = BrowserConnection;

    BrowserConnection.prototype.setup = function () { return Promise.resolve(); };

    BrowserConnection.prototype.write = function (bytes) {
        try {
            var u8  = _ab2u8(bytes);
            var str = '';
            for (var i = 0; i < u8.length; i++) {
                var c = u8[i];
                // Strip control codes below 0x20 except LF (0x0A)
                if (c >= 0x20 || c === 0x0A) str += String.fromCharCode(c);
            }
            var win = global.open('', '_blank', 'width=400,height=600');
            if (!win) return Promise.reject(new Error('Popup blocked — allow popups for this site'));
            win.document.write('<pre>' + str + '</pre>');
            win.document.close();
            win.print();
            return Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    };

    // =========================================================================
    // ConnectionManager — factory
    // =========================================================================

    var ConnectionManager = {

        /**
         * Create a connection for an already-granted device.
         * The returned Connection is already set up and ready to write.
         *
         * @param {string}  transport  'usb' | 'bluetooth' | 'serial' | 'network' | 'android' | 'browser'
         * @param {*}       device     Raw WebUSB/WebBluetooth/Serial device object (or host string for network)
         * @param {object}  profile    SokoniDeviceProfiles entry (may be null for generic)
         * @param {object}  [opts]     Extra options: { host, port }
         * @returns {Promise<Connection>}
         */
        create: async function (transport, device, profile, opts) {
            opts = opts || {};
            var conn;

            switch (transport) {
                case 'usb': {
                    var usbDesc = {
                        transport:  'usb',
                        vendorId:   device.vendorId,
                        productId:  device.productId,
                        deviceId:   device.serialNumber || null,
                        model:      (profile && profile.name) || ('USB ' + device.vendorId.toString(16)),
                    };
                    conn = new USBConnection(device, usbDesc, profile);
                    await conn.setup();
                    break;
                }

                case 'bluetooth': {
                    var btDesc = {
                        transport: 'bluetooth',
                        deviceId:  device.id,
                        model:     device.name || (profile && profile.name) || 'Bluetooth Device',
                    };
                    conn = new BluetoothConnection(device, btDesc, profile);
                    conn._profile = profile;
                    await conn.setup();
                    break;
                }

                case 'serial': {
                    var portInfo = (device.getInfo && device.getInfo()) || {};
                    var serDesc  = {
                        transport: 'serial',
                        vendorId:  portInfo.usbVendorId  || null,
                        productId: portInfo.usbProductId || null,
                        model:     (profile && profile.name) || 'Serial Device',
                    };
                    conn = new SerialConnection(device, serDesc, profile);
                    await conn.setup();
                    break;
                }

                case 'network': {
                    var host = opts.host || (typeof device === 'string' ? device : '127.0.0.1');
                    var netDesc = {
                        transport:   'network',
                        networkHost: host,
                        networkPort: opts.port || (profile && profile.network && profile.network.defaultPort) || 9100,
                        model:       (profile && profile.name) || 'Network Printer',
                    };
                    conn = new NetworkConnection(host, netDesc, profile);
                    await conn.setup();
                    break;
                }

                case 'android': {
                    var andDesc = {
                        transport: 'android',
                        model:     (profile && profile.name) || 'Android Bridge Printer',
                    };
                    conn = new AndroidConnection(andDesc, profile);
                    await conn.setup();
                    break;
                }

                case 'browser': {
                    conn = new BrowserConnection({ transport: 'browser', model: 'Browser Print' });
                    await conn.setup();
                    break;
                }

                default:
                    throw new Error('Unknown transport: ' + transport);
            }

            return conn;
        },

        /**
         * Restore a connection to a previously-granted device (passive — no dialog).
         * Returns null if the device is no longer in the granted set.
         *
         * @param {object}  savedRecord   Persisted printer record from SokoniHardwarePersistence
         * @param {object}  profile       SokoniDeviceProfiles entry
         * @returns {Promise<Connection|null>}
         */
        restore: async function (savedRecord, profile) {
            var transport = savedRecord.transport;
            var perm = global.SokoniPermissionManager;
            if (!perm) return null;

            try {
                switch (transport) {
                    case 'usb': {
                        var usbDevices = await perm.getGrantedUSBDevices();
                        var match = usbDevices.find(function (d) {
                            return d.vendorId === savedRecord.vendorId && d.productId === savedRecord.productId;
                        });
                        if (!match) return null;
                        return ConnectionManager.create('usb', match, profile);
                    }

                    case 'bluetooth': {
                        var btDevices = await perm.getGrantedBluetoothDevices();
                        var btMatch = btDevices.find(function (d) {
                            return d.id === savedRecord.deviceId;
                        });
                        if (!btMatch) return null;
                        return ConnectionManager.create('bluetooth', btMatch, profile);
                    }

                    case 'serial': {
                        var ports = await perm.getGrantedSerialPorts();
                        var portMatch = ports.find(function (p) {
                            var info = p.getInfo && p.getInfo() || {};
                            return info.usbVendorId === savedRecord.vendorId && info.usbProductId === savedRecord.productId;
                        });
                        if (!portMatch) return null;
                        return ConnectionManager.create('serial', portMatch, profile);
                    }

                    case 'network':
                        return ConnectionManager.create('network', null, profile, {
                            host: savedRecord.networkHost,
                            port: savedRecord.networkPort,
                        });

                    case 'android':
                        return ConnectionManager.create('android', null, profile);

                    case 'browser':
                        return ConnectionManager.create('browser', null, null);

                    default:
                        return null;
                }
            } catch (_) {
                return null;
            }
        },
    };

    // =========================================================================
    // Export
    // =========================================================================

    global.SokoniConnectionManager = ConnectionManager;
    global._SokoniConnections = { USBConnection, BluetoothConnection, SerialConnection, NetworkConnection, AndroidConnection, BrowserConnection };

})(window);
