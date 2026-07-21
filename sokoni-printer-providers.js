/**
 * SOKONI Printer Providers v1.0
 * Phase 2 + 5 + 6 — Hardware Abstraction Layer
 *
 * Provider hierarchy:
 *   PrinterProvider (abstract base)
 *   ├─ USBPrinterProvider
 *   ├─ BluetoothPrinterProvider
 *   ├─ NetworkPrinterProvider (local bridge + Cloud Function proxy)
 *   └─ BrowserPrinterProvider (window.print() fallback)
 *
 * ESCPosProvider — protocol layer used by USB and BT providers.
 *
 * Rules (Phase 5):
 *   - NEVER call requestDevice / requestPort outside a user gesture.
 *   - All request* methods delegate to SokoniPermissionManager.
 *   - getStoredDevices() is passive — no dialog, no gesture required.
 *   - Only USBPrinterProvider and BluetoothPrinterProvider reach hardware APIs.
 *   - NetworkPrinterProvider and BrowserPrinterProvider need no permissions.
 */

(function (global) {
    'use strict';

    // ---------------------------------------------------------------------------
    // ESC/POS byte constants
    // ---------------------------------------------------------------------------

    var ESC = 0x1B;
    var GS  = 0x1D;
    var FS  = 0x1C;
    var DLE = 0x10;
    var EOT = 0x04;

    var CMD = {
        INIT:       [ESC, 0x40],
        LF:         [0x0A],
        CR:         [0x0D],
        FEED_N:     function (n) { return [ESC, 0x64, n & 0xFF]; },
        CUT_FULL:   [GS, 0x56, 0x42, 0x00],
        CUT_PARTIAL:[GS, 0x56, 0x42, 0x01],
        ALIGN_L:    [ESC, 0x61, 0x00],
        ALIGN_C:    [ESC, 0x61, 0x01],
        ALIGN_R:    [ESC, 0x61, 0x02],
        BOLD_ON:    [ESC, 0x45, 0x01],
        BOLD_OFF:   [ESC, 0x45, 0x00],
        UL_ON:      [ESC, 0x2D, 0x01],
        UL_OFF:     [ESC, 0x2D, 0x00],
        SIZE_NORMAL:[GS,  0x21, 0x00],
        SIZE_DH:    [GS,  0x21, 0x01],
        SIZE_DW:    [GS,  0x21, 0x10],
        SIZE_DOUBLE:[GS,  0x21, 0x11],
        DRAWER_2:   [ESC, 0x70, 0x00, 0x19, 0xFA],
        DRAWER_5:   [ESC, 0x70, 0x01, 0x19, 0xFA],
        STATUS_PROBE:[DLE, EOT, 0x01],
    };

    // ---------------------------------------------------------------------------
    // Printer profiles (Phase 6)
    // ---------------------------------------------------------------------------

    var PRINTER_PROFILES = {
        P58E: {
            id:           'p58e',
            name:         'P58E',
            paperWidth:   '58mm',
            columns:      32,
            maxChunkSize: 128,
            interChunkMs: 20,
            transport:    ['usb', 'bluetooth'],
            escposProfile:'p58e',
            bleNamePatterns:   [/^P58/i, /^XP-58/i, /^HOP-/i, /^MTP-/i, /^PTP-/i, /^HOIN/i, /^RP-?58/i],
            usbVendorIds: [0x154F, 0x0FE6, 0x1FC9, 0x1B5F, 0x067B, 0x0403, 0x10C4, 0x1A86],
            bleServices: [
                '0000ff00-0000-1000-8000-00805f9b34fb',
                '000018f0-0000-1000-8000-00805f9b34fb',
                'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
                '49535343-fe7d-4ae5-8fa9-9fafd205e455',
                '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
                '0000ffe0-0000-1000-8000-00805f9b34fb',
            ],
            bleWriteChars: [
                '0000ff02-0000-1000-8000-00805f9b34fb',
                '00002af1-0000-1000-8000-00805f9b34fb',
                'bef8d6c9-92a3-4e29-9f6a-d2cc7e0fc3d1',
                '49535343-8841-43f4-a8d4-ecbe34729bb3',
                '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
                '0000ffe1-0000-1000-8000-00805f9b34fb',
            ],
        },
        TM_T20: {
            id:           'tm_t20',
            name:         'Epson TM-T20',
            paperWidth:   '80mm',
            columns:      48,
            maxChunkSize: 512,
            interChunkMs: 5,
            transport:    ['usb', 'serial', 'network'],
            escposProfile:'standard',
            usbVendorIds: [0x04B8],
            bleNamePatterns: [/^TM-T20/i],
        },
        TM_T88: {
            id:           'tm_t88',
            name:         'Epson TM-T88',
            paperWidth:   '80mm',
            columns:      48,
            maxChunkSize: 512,
            interChunkMs: 5,
            transport:    ['usb', 'serial', 'network'],
            escposProfile:'standard',
            usbVendorIds: [0x04B8],
            bleNamePatterns: [/^TM-T88/i],
        },
        TSP100: {
            id:           'tsp100',
            name:         'Star TSP100',
            paperWidth:   '80mm',
            columns:      48,
            maxChunkSize: 512,
            interChunkMs: 5,
            transport:    ['usb', 'serial', 'network'],
            escposProfile:'star',
            usbVendorIds: [0x0519],
            bleNamePatterns: [/^TSP/i, /^mPOP/i],
        },
        GENERIC_80: {
            id:           'generic_80',
            name:         'Generic 80mm Printer',
            paperWidth:   '80mm',
            columns:      48,
            maxChunkSize: 512,
            interChunkMs: 10,
            transport:    ['usb', 'bluetooth', 'serial', 'network'],
            escposProfile:'standard',
            usbVendorIds: [],
            bleNamePatterns: [/^RP-?80/i, /^TM-T/i, /^SRP/i, /^CT-S/i, /^BIXOLON/i],
        },
        GENERIC_58: {
            id:           'generic_58',
            name:         'Generic 58mm Printer',
            paperWidth:   '58mm',
            columns:      32,
            maxChunkSize: 128,
            interChunkMs: 20,
            transport:    ['usb', 'bluetooth', 'serial', 'network'],
            escposProfile:'standard',
            usbVendorIds: [],
            bleNamePatterns: [],
        },
    };

    // ---------------------------------------------------------------------------
    // Profile detection (Phase 6)
    // ---------------------------------------------------------------------------

    function detectProfileFromUSBDevice(device) {
        var vid = device.vendorId;
        // Exact Epson match
        if (vid === 0x04B8) return PRINTER_PROFILES.TM_T88;
        if (vid === 0x0519) return PRINTER_PROFILES.TSP100;
        // P58E chip manufacturers
        if ([0x154F, 0x0FE6, 0x1FC9, 0x1B5F].includes(vid)) return PRINTER_PROFILES.P58E;
        // USB-Serial bridges — likely a small thermal printer
        if ([0x067B, 0x0403, 0x10C4, 0x1A86].includes(vid)) return PRINTER_PROFILES.P58E;
        return PRINTER_PROFILES.GENERIC_58;
    }

    function detectProfileFromBLEDevice(device) {
        var name = (device.name || '').trim();
        // Try each profile's name patterns
        for (var profileId in PRINTER_PROFILES) {
            var profile = PRINTER_PROFILES[profileId];
            if (!profile.bleNamePatterns || !profile.bleNamePatterns.length) continue;
            for (var i = 0; i < profile.bleNamePatterns.length; i++) {
                if (profile.bleNamePatterns[i].test(name)) return profile;
            }
        }
        return PRINTER_PROFILES.GENERIC_58;
    }

    function detectProfileFromNetworkPrinter() {
        return PRINTER_PROFILES.GENERIC_80;
    }

    // ---------------------------------------------------------------------------
    // ESCPosProvider — protocol layer (Phase 2)
    // ---------------------------------------------------------------------------

    function ESCPosProvider(transportProvider, profile) {
        this._transport = transportProvider;
        this._profile   = profile || PRINTER_PROFILES.GENERIC_58;
    }

    ESCPosProvider.prototype._encoder = new TextEncoder();

    ESCPosProvider.prototype._buildBytes = function () {
        var self    = this;
        var bytes   = [];
        var args    = Array.prototype.slice.call(arguments);
        var encoder = self._encoder;

        for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (typeof a === 'string') {
                var encoded = encoder.encode(a);
                for (var j = 0; j < encoded.length; j++) bytes.push(encoded[j]);
            } else if (Array.isArray(a)) {
                for (var j2 = 0; j2 < a.length; j2++) bytes.push(a[j2]);
            } else if (a instanceof Uint8Array) {
                for (var j3 = 0; j3 < a.length; j3++) bytes.push(a[j3]);
            }
        }
        return new Uint8Array(bytes);
    };

    /**
     * Probe for ESC/POS compatibility.
     * Sends ESC @ (init) followed by a 1-line feed.
     * If the write succeeds without throwing, the printer is compatible.
     */
    ESCPosProvider.prototype.probe = async function (connection) {
        try {
            var initBytes = this._buildBytes(CMD.INIT, CMD.FEED_N(1));
            await this._transport.write(connection, initBytes);
            return { compatible: true, profile: this._profile };
        } catch (err) {
            return { compatible: false, error: err.message, profile: null };
        }
    };

    /** Build a test receipt as Uint8Array. */
    ESCPosProvider.prototype.buildTestReceipt = function () {
        var profile = this._profile;
        var cols    = profile.paperWidth === '80mm' ? 48 : 32;
        var sep     = '-'.repeat(cols);
        var ts      = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

        return this._buildBytes(
            CMD.INIT,
            CMD.ALIGN_C,
            CMD.BOLD_ON,
            CMD.SIZE_DH,
            'SOKONI POS\n',
            CMD.SIZE_NORMAL,
            CMD.BOLD_OFF,
            'Hardware Test Receipt\n',
            CMD.ALIGN_L,
            sep + '\n',
            ('Model     : ' + profile.name).slice(0, cols) + '\n',
            ('Transport : ' + this._transport.transport).slice(0, cols) + '\n',
            ('Paper     : ' + profile.paperWidth).slice(0, cols) + '\n',
            ('Protocol  : ESC/POS').slice(0, cols) + '\n',
            ('Date      : ' + ts).slice(0, cols) + '\n',
            sep + '\n',
            CMD.ALIGN_C,
            CMD.BOLD_ON,
            '*** TEST ONLY ***\n',
            CMD.BOLD_OFF,
            'ESC/POS VERIFIED\n',
            CMD.ALIGN_L,
            CMD.FEED_N(4),
            CMD.CUT_FULL
        );
    };

    /** Kick cash drawer. */
    ESCPosProvider.prototype.kickDrawer = async function (connection, pin) {
        var cmd = (pin === 5) ? CMD.DRAWER_5 : CMD.DRAWER_2;
        var bytes = this._buildBytes(CMD.INIT, cmd);
        await this._transport.write(connection, bytes);
    };

    /**
     * Send a pre-built Uint8Array receipt to the printer.
     */
    ESCPosProvider.prototype.send = async function (connection, bytes) {
        await this._transport.write(connection, bytes);
    };

    // ---------------------------------------------------------------------------
    // PrinterProvider — abstract base (Phase 2)
    // ---------------------------------------------------------------------------

    function PrinterProvider() {}

    PrinterProvider.prototype.transport = 'unknown';

    /** Returns true if this transport is supported on the current browser/platform. */
    PrinterProvider.prototype.supported = false;

    /**
     * Request a new device from the user.
     * MUST be called from within a user gesture handler (click).
     * @returns {Promise<DeviceDescriptor>}
     */
    PrinterProvider.prototype.requestDevice = async function () {
        throw new Error('requestDevice() is not implemented on PrinterProvider.');
    };

    /**
     * Return previously-granted devices (passive — no dialog).
     * @returns {Promise<DeviceDescriptor[]>}
     */
    PrinterProvider.prototype.getStoredDevices = async function () {
        return [];
    };

    /**
     * Open a connection to a device.
     * @param {DeviceDescriptor} descriptor
     * @returns {Promise<Connection>}
     */
    PrinterProvider.prototype.connect = async function () {
        throw new Error('connect() is not implemented on PrinterProvider.');
    };

    /**
     * Write bytes to an open connection.
     * @param {Connection} connection
     * @param {Uint8Array} bytes
     */
    PrinterProvider.prototype.write = async function () {
        throw new Error('write() is not implemented on PrinterProvider.');
    };

    /** Cleanly close a connection. */
    PrinterProvider.prototype.disconnect = async function () {};

    /** Detect printer profile from a device descriptor. */
    PrinterProvider.prototype.detectProfile = function () {
        return PRINTER_PROFILES.GENERIC_58;
    };

    // ---------------------------------------------------------------------------
    // USBPrinterProvider (Phase 2 + 5)
    // ---------------------------------------------------------------------------

    function USBPrinterProvider() {
        PrinterProvider.call(this);
    }
    USBPrinterProvider.prototype = Object.create(PrinterProvider.prototype);
    USBPrinterProvider.prototype.constructor = USBPrinterProvider;
    USBPrinterProvider.prototype.transport = 'usb';

    Object.defineProperty(USBPrinterProvider.prototype, 'supported', {
        get: function () { return 'usb' in navigator; },
    });

    /**
     * Opens the browser USB device picker.
     * MUST be called from a user gesture.
     */
    USBPrinterProvider.prototype.requestDevice = async function () {
        var pm = global.SokoniPermissionManager;
        if (!pm) throw new Error('SokoniPermissionManager is not loaded.');
        var device = await pm.requestUSBDevice();
        return {
            transport:  'usb',
            vendorId:   device.vendorId,
            productId:  device.productId,
            model:      device.productName || ('USB ' + device.vendorId.toString(16)),
            device:     device,
            profile:    detectProfileFromUSBDevice(device),
        };
    };

    /**
     * Returns USB devices previously granted — no dialog.
     */
    USBPrinterProvider.prototype.getStoredDevices = async function () {
        var pm = global.SokoniPermissionManager;
        if (!pm) return [];
        var devices = await pm.getGrantedUSBDevices();
        var USB_PRINTER_VIDS = [
            0x04B8, 0x0519, 0x154F, 0x0FE6, 0x1FC9, 0x0DD4,
            0x0456, 0x05CB, 0x0A5F, 0x1B5F, 0x067B, 0x0403, 0x10C4, 0x1A86,
        ];
        return devices
            .filter(function (d) {
                return USB_PRINTER_VIDS.includes(d.vendorId) ||
                       (d.configuration &&
                        d.configuration.interfaces.some(function (i) {
                            return i.alternates.some(function (a) { return a.interfaceClass === 7; });
                        }));
            })
            .map(function (d) {
                return {
                    transport: 'usb',
                    vendorId:  d.vendorId,
                    productId: d.productId,
                    model:     d.productName || 'USB Printer',
                    device:    d,
                    profile:   detectProfileFromUSBDevice(d),
                };
            });
    };

    USBPrinterProvider.prototype.connect = async function (descriptor) {
        var device = descriptor.device;
        if (!device) throw new Error('No USB device in descriptor.');

        await device.open();

        if (device.configuration === null) {
            await device.selectConfiguration(1);
        }

        // Find printer interface (USB class 7) or fall back to interface 0
        var iface = null;
        var configs = device.configurations || [];
        for (var ci = 0; ci < configs.length && !iface; ci++) {
            var intfs = configs[ci].interfaces || [];
            for (var ii = 0; ii < intfs.length && !iface; ii++) {
                var alts = intfs[ii].alternates || [];
                for (var ai = 0; ai < alts.length; ai++) {
                    if (alts[ai].interfaceClass === 7) {
                        iface = intfs[ii];
                        break;
                    }
                }
            }
        }
        if (!iface && device.configuration) {
            iface = device.configuration.interfaces[0];
        }
        if (!iface) throw new Error('No printer interface found on USB device.');

        await device.claimInterface(iface.interfaceNumber);

        var alternate = iface.alternates[0];
        var endpoint  = alternate.endpoints.find(function (ep) {
            return ep.direction === 'out' && ep.type === 'bulk';
        });
        if (!endpoint) throw new Error('No bulk-OUT endpoint found on USB device.');

        return {
            type:            'usb',
            device:          device,
            interfaceNumber: iface.interfaceNumber,
            endpointNumber:  endpoint.endpointNumber,
            packetSize:      endpoint.packetSize || 512,
        };
    };

    USBPrinterProvider.prototype.write = async function (connection, bytes) {
        var device    = connection.device;
        var endpoint  = connection.endpointNumber;
        var chunkSize = connection.packetSize || 512;

        for (var i = 0; i < bytes.length; i += chunkSize) {
            var chunk = bytes.slice(i, i + chunkSize);
            var result = await device.transferOut(endpoint, chunk);
            if (result.status !== 'ok') {
                throw new Error('USB transferOut failed with status: ' + result.status);
            }
        }
    };

    USBPrinterProvider.prototype.disconnect = async function (connection) {
        if (!connection || !connection.device) return;
        try {
            await connection.device.releaseInterface(connection.interfaceNumber);
            await connection.device.close();
        } catch (_) {}
    };

    USBPrinterProvider.prototype.detectProfile = function (descriptor) {
        if (descriptor && descriptor.device) return detectProfileFromUSBDevice(descriptor.device);
        return PRINTER_PROFILES.GENERIC_58;
    };

    // ---------------------------------------------------------------------------
    // BluetoothPrinterProvider (Phase 2 + 5 + 6)
    // ---------------------------------------------------------------------------

    function BluetoothPrinterProvider() {
        PrinterProvider.call(this);
    }
    BluetoothPrinterProvider.prototype = Object.create(PrinterProvider.prototype);
    BluetoothPrinterProvider.prototype.constructor = BluetoothPrinterProvider;
    BluetoothPrinterProvider.prototype.transport = 'bluetooth';

    Object.defineProperty(BluetoothPrinterProvider.prototype, 'supported', {
        get: function () { return 'bluetooth' in navigator; },
    });

    /**
     * Opens the browser Bluetooth device picker.
     * MUST be called from a user gesture.
     */
    BluetoothPrinterProvider.prototype.requestDevice = async function () {
        var pm = global.SokoniPermissionManager;
        if (!pm) throw new Error('SokoniPermissionManager is not loaded.');
        var device  = await pm.requestBluetoothDevice();
        var profile = detectProfileFromBLEDevice(device);
        return {
            transport:  'bluetooth',
            deviceId:   device.id,
            deviceName: device.name || 'Bluetooth Printer',
            model:      device.name || profile.name,
            device:     device,
            profile:    profile,
        };
    };

    /**
     * Returns previously-granted Bluetooth devices — no dialog.
     */
    BluetoothPrinterProvider.prototype.getStoredDevices = async function () {
        var pm = global.SokoniPermissionManager;
        if (!pm) return [];
        var devices = await pm.getGrantedBluetoothDevices();
        return devices.map(function (d) {
            return {
                transport:  'bluetooth',
                deviceId:   d.id,
                deviceName: d.name || 'Bluetooth Printer',
                model:      d.name || 'Bluetooth Printer',
                device:     d,
                profile:    detectProfileFromBLEDevice(d),
            };
        });
    };

    BluetoothPrinterProvider.prototype.connect = async function (descriptor) {
        var device  = descriptor.device;
        var profile = descriptor.profile || PRINTER_PROFILES.GENERIC_58;

        if (!device) throw new Error('No Bluetooth device in descriptor.');
        if (!device.gatt) throw new Error('Device does not support GATT.');

        var server = await device.gatt.connect();

        // Try each service UUID until one is found
        var serviceUuids = profile.bleServices || [
            '000018f0-0000-1000-8000-00805f9b34fb',
            '0000ff00-0000-1000-8000-00805f9b34fb',
            'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
            '49535343-fe7d-4ae5-8fa9-9fafd205e455',
            '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
            '0000ffe0-0000-1000-8000-00805f9b34fb',
        ];

        var writeCharUuids = profile.bleWriteChars || [
            '0000ff02-0000-1000-8000-00805f9b34fb',
            '00002af1-0000-1000-8000-00805f9b34fb',
            'bef8d6c9-92a3-4e29-9f6a-d2cc7e0fc3d1',
            '49535343-8841-43f4-a8d4-ecbe34729bb3',
            '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
            '0000ffe1-0000-1000-8000-00805f9b34fb',
        ];

        var service   = null;
        var writeChar = null;

        for (var si = 0; si < serviceUuids.length; si++) {
            try {
                service = await server.getPrimaryService(serviceUuids[si]);
                break;
            } catch (_) {}
        }
        if (!service) throw new Error('No compatible BLE service found on this printer.');

        for (var ci = 0; ci < writeCharUuids.length; ci++) {
            try {
                var c = await service.getCharacteristic(writeCharUuids[ci]);
                var props = c.properties;
                if (props.write || props.writeWithoutResponse) {
                    writeChar = c;
                    break;
                }
            } catch (_) {}
        }
        if (!writeChar) throw new Error('No writable BLE characteristic found on this printer.');

        return {
            type:        'bluetooth',
            device:      device,
            server:      server,
            service:     service,
            writeChar:   writeChar,
            useResponse: !writeChar.properties.writeWithoutResponse,
            chunkSize:   profile.maxChunkSize || 128,
            interChunkMs:profile.interChunkMs || 20,
        };
    };

    BluetoothPrinterProvider.prototype.write = async function (connection, bytes) {
        var writeChar    = connection.writeChar;
        var chunkSize    = connection.chunkSize    || 128;
        var interChunkMs = connection.interChunkMs || 20;
        var useResponse  = connection.useResponse;

        for (var i = 0; i < bytes.length; i += chunkSize) {
            var chunk = bytes.slice(i, i + chunkSize);
            if (useResponse) {
                await writeChar.writeValueWithResponse(chunk);
            } else {
                await writeChar.writeValueWithoutResponse(chunk);
            }
            if (i + chunkSize < bytes.length && interChunkMs > 0) {
                await new Promise(function (r) { setTimeout(r, interChunkMs); });
            }
        }
    };

    BluetoothPrinterProvider.prototype.disconnect = async function (connection) {
        if (!connection) return;
        try {
            if (connection.device && connection.device.gatt && connection.device.gatt.connected) {
                connection.device.gatt.disconnect();
            }
        } catch (_) {}
    };

    BluetoothPrinterProvider.prototype.detectProfile = function (descriptor) {
        if (descriptor && descriptor.device) return detectProfileFromBLEDevice(descriptor.device);
        return PRINTER_PROFILES.GENERIC_58;
    };

    // ---------------------------------------------------------------------------
    // NetworkPrinterProvider (Phase 2)
    // Prints via SOKONI Desktop bridge (localhost:9101) or Cloud Function proxy.
    // No browser permissions required — user supplies IP address.
    // ---------------------------------------------------------------------------

    var BRIDGE_URL  = 'http://localhost:9101';
    var PROXY_URL   = 'https://us-central1-sokoni-aeb26.cloudfunctions.net/posPrint';

    function NetworkPrinterProvider() {
        PrinterProvider.call(this);
    }
    NetworkPrinterProvider.prototype = Object.create(PrinterProvider.prototype);
    NetworkPrinterProvider.prototype.constructor = NetworkPrinterProvider;
    NetworkPrinterProvider.prototype.transport = 'network';

    Object.defineProperty(NetworkPrinterProvider.prototype, 'supported', {
        get: function () { return 'fetch' in global; },
    });

    /**
     * "Request device" for network = user provides host/port.
     * No browser permission dialog.
     */
    NetworkPrinterProvider.prototype.requestDevice = async function (options) {
        var host = (options && options.host) || '';
        var port = (options && options.port) || 9100;
        if (!host) throw Object.assign(new Error('Network host is required.'), {
            userMessage: 'Please enter the printer\'s IP address.',
        });
        return {
            transport:   'network',
            networkHost: host,
            networkPort: port,
            model:       'Network Printer (' + host + ':' + port + ')',
            profile:     detectProfileFromNetworkPrinter(),
        };
    };

    /** Network printers are stateless — no stored devices concept. */
    NetworkPrinterProvider.prototype.getStoredDevices = async function () {
        return [];
    };

    NetworkPrinterProvider.prototype.connect = async function (descriptor) {
        // Check if local bridge is running
        var bridgeAvailable = false;
        try {
            var resp = await fetch(BRIDGE_URL + '/ping', { method: 'GET', signal: AbortSignal.timeout(2000) });
            bridgeAvailable = resp.ok;
        } catch (_) {}

        return {
            type:           'network',
            host:           descriptor.networkHost,
            port:           descriptor.networkPort || 9100,
            bridgeAvailable:bridgeAvailable,
        };
    };

    NetworkPrinterProvider.prototype.write = async function (connection, bytes) {
        var b64 = btoa(String.fromCharCode.apply(null, bytes));
        var payload = {
            host: connection.host,
            port: connection.port,
            data: b64,
        };

        var url = connection.bridgeAvailable ? (BRIDGE_URL + '/print') : PROXY_URL;
        var resp = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
        if (!resp.ok) {
            var body = {};
            try { body = await resp.json(); } catch (_) {}
            throw new Error('Network print failed: ' + (body.error || resp.statusText));
        }
    };

    NetworkPrinterProvider.prototype.disconnect = async function () {};

    // ---------------------------------------------------------------------------
    // BrowserPrinterProvider (Phase 2)
    // Always available — uses window.print() via a hidden iframe.
    // ---------------------------------------------------------------------------

    function BrowserPrinterProvider() {
        PrinterProvider.call(this);
    }
    BrowserPrinterProvider.prototype = Object.create(PrinterProvider.prototype);
    BrowserPrinterProvider.prototype.constructor = BrowserPrinterProvider;
    BrowserPrinterProvider.prototype.transport = 'browser';

    Object.defineProperty(BrowserPrinterProvider.prototype, 'supported', {
        get: function () { return true; },
    });

    BrowserPrinterProvider.prototype.requestDevice = async function () {
        return { transport: 'browser', model: 'System Printer (window.print)', profile: PRINTER_PROFILES.GENERIC_80 };
    };

    BrowserPrinterProvider.prototype.getStoredDevices = async function () {
        return [{ transport: 'browser', model: 'System Printer', profile: PRINTER_PROFILES.GENERIC_80 }];
    };

    BrowserPrinterProvider.prototype.connect = async function () {
        return { type: 'browser' };
    };

    BrowserPrinterProvider.prototype.write = async function (connection, content) {
        // Content may be a Uint8Array (ESC/POS — converted to HTML) or an HTML string
        var html;
        if (content instanceof Uint8Array) {
            // Convert ESC/POS bytes to plain-text HTML approximation
            var decoder = new TextDecoder('utf-8', { fatal: false });
            var text = decoder.decode(content)
                .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '') // strip control chars
                .replace(/\n/g, '<br>');
            html = '<html><body style="font-family:monospace;font-size:12px;white-space:pre">' + text + '</body></html>';
        } else {
            html = content;
        }

        var iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.top      = '-9999px';
        iframe.style.left     = '-9999px';
        iframe.style.width    = '80mm';
        document.body.appendChild(iframe);

        iframe.contentDocument.open();
        iframe.contentDocument.write(html);
        iframe.contentDocument.close();

        await new Promise(function (resolve) { setTimeout(resolve, 300); });
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        await new Promise(function (resolve) { setTimeout(resolve, 500); });
        document.body.removeChild(iframe);
    };

    // ---------------------------------------------------------------------------
    // Exports
    // ---------------------------------------------------------------------------

    global.SokoniPrinterProviders = Object.freeze({
        PrinterProvider:         PrinterProvider,
        USBPrinterProvider:      USBPrinterProvider,
        BluetoothPrinterProvider:BluetoothPrinterProvider,
        NetworkPrinterProvider:  NetworkPrinterProvider,
        BrowserPrinterProvider:  BrowserPrinterProvider,
        ESCPosProvider:          ESCPosProvider,
        PRINTER_PROFILES:        Object.freeze(PRINTER_PROFILES),
        detectProfileFromUSBDevice:      detectProfileFromUSBDevice,
        detectProfileFromBLEDevice:      detectProfileFromBLEDevice,
        detectProfileFromNetworkPrinter: detectProfileFromNetworkPrinter,
    });

})(window);
