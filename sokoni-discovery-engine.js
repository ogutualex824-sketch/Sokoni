/**
 * SOKONI Discovery Engine v1.0
 *
 * Passive device detection — discovers devices that were previously granted
 * permission, matches them to device profiles, and surfaces smart hints.
 *
 * Rules:
 *   - NEVER calls requestDevice / requestPort — those require a user gesture
 *     and must be initiated explicitly from a user click.
 *   - Uses only getDevices() / getPorts() / getHIDDevices() — all passive.
 *   - Returns a Discovery result so the UI can show "Detected: P58E" instead
 *     of "No printers configured".
 *
 * Discovery result shape:
 *   {
 *     detected: [
 *       {
 *         transport:  'usb' | 'bluetooth' | 'serial' | 'hid',
 *         rawDevice:  <original browser object>,
 *         profile:    <SokoniDeviceProfiles entry> | null,
 *         profileId:  string | null,
 *         deviceName: string,
 *         driver:     string | null,   // driverId
 *         canConnect: boolean,         // whether silent reconnect is possible
 *       }
 *     ],
 *     hints: [
 *       { transport: string, message: string, icon: string }
 *     ],
 *     canDiscover: {
 *       usb:       boolean,
 *       bluetooth: boolean,
 *       serial:    boolean,
 *       hid:       boolean,
 *     },
 *     capturedAt: ISO string,
 *   }
 */

(function (global) {
    'use strict';

    function _now() { return new Date().toISOString(); }

    // ─── Profile matching ──────────────────────────────────────────────────────

    function _profiles() { return global.SokoniDeviceProfiles; }
    function _cap()      { return global.SokoniCapabilityDetector; }

    function _matchUSB(device) {
        var dp = _profiles();
        return dp ? dp.findByUSBDevice(device) : null;
    }

    function _matchBLE(device) {
        var dp = _profiles();
        return dp ? dp.findByBLEDevice(device) : null;
    }

    function _matchSerial(port) {
        var dp = _profiles();
        return dp ? dp.findBySerialPort(port && port.getInfo && port.getInfo()) : null;
    }

    function _matchHID(device) {
        var dp = _profiles();
        if (!dp) return null;
        var all = dp.ALL;
        for (var id in all) {
            var p = all[id];
            if (!p.usb) continue;
            var vids = p.usb.vendorIds || [];
            if (vids.includes(device.vendorId)) return p;
        }
        return null;
    }

    function _deviceLabel(profile, rawDevice, transport) {
        if (profile) return profile.name;
        if (transport === 'bluetooth' && rawDevice.name) return rawDevice.name;
        if (transport === 'usb') return 'USB Device (VID:0x' + (rawDevice.vendorId || 0).toString(16).toUpperCase().padStart(4,'0') + ')';
        return 'Unknown Device';
    }

    // ─── Collect granted devices per transport ─────────────────────────────────

    async function _scanUSB() {
        if (!('usb' in navigator)) return [];
        try {
            var perm = global.SokoniPermissionManager;
            var devices = perm ? await perm.getGrantedUSBDevices() : await navigator.usb.getDevices();
            return devices.map(function (d) {
                var profile = _matchUSB(d);
                return {
                    transport:  'usb',
                    rawDevice:  d,
                    profile:    profile,
                    profileId:  profile ? profile.id : null,
                    deviceName: _deviceLabel(profile, d, 'usb'),
                    driver:     profile ? profile.driver : null,
                    canConnect: true,
                };
            });
        } catch (_) { return []; }
    }

    async function _scanBluetooth() {
        if (!('bluetooth' in navigator)) return [];
        try {
            var perm = global.SokoniPermissionManager;
            var devices = perm ? await perm.getGrantedBluetoothDevices() : await navigator.bluetooth.getDevices();
            return devices.map(function (d) {
                var profile = _matchBLE(d);
                return {
                    transport:  'bluetooth',
                    rawDevice:  d,
                    profile:    profile,
                    profileId:  profile ? profile.id : null,
                    deviceName: _deviceLabel(profile, d, 'bluetooth'),
                    driver:     profile ? profile.driver : null,
                    canConnect: d.gatt !== undefined,
                };
            });
        } catch (_) { return []; }
    }

    async function _scanSerial() {
        if (!('serial' in navigator)) return [];
        try {
            var perm = global.SokoniPermissionManager;
            var ports = perm ? await perm.getGrantedSerialPorts() : await navigator.serial.getPorts();
            return ports.map(function (p) {
                var profile = _matchSerial(p);
                return {
                    transport:  'serial',
                    rawDevice:  p,
                    profile:    profile,
                    profileId:  profile ? profile.id : null,
                    deviceName: _deviceLabel(profile, p, 'serial'),
                    driver:     profile ? profile.driver : null,
                    canConnect: true,
                };
            });
        } catch (_) { return []; }
    }

    async function _scanHID() {
        if (!('hid' in navigator)) return [];
        try {
            var perm = global.SokoniPermissionManager;
            var devices = perm && perm.getGrantedHIDDevices ? await perm.getGrantedHIDDevices() : await navigator.hid.getDevices();
            return devices.map(function (d) {
                var profile = _matchHID(d);
                return {
                    transport:  'hid',
                    rawDevice:  d,
                    profile:    profile,
                    profileId:  profile ? profile.id : null,
                    deviceName: _deviceLabel(profile, d, 'hid'),
                    driver:     profile ? profile.driver : null,
                    canConnect: true,
                };
            });
        } catch (_) { return []; }
    }

    // ─── Build hints from capabilities ─────────────────────────────────────────

    function _buildHints(canDiscover, detected) {
        var cap     = _cap();
        var hints   = [];
        var hasAny  = detected.length > 0;

        if (!hasAny) {
            if (canDiscover.usb) {
                hints.push({ transport: 'usb', icon: '🔌', message: 'No USB printers detected. Connect a printer and tap "USB Printer" to pair.' });
            }
            if (canDiscover.bluetooth) {
                hints.push({ transport: 'bluetooth', icon: '📶', message: 'No Bluetooth printers detected. Tap "Bluetooth Printer" to scan nearby devices.' });
            }
            if (canDiscover.serial) {
                hints.push({ transport: 'serial', icon: '🔗', message: 'No serial printers detected. Connect via USB-Serial adapter and tap "Serial Printer".' });
            }
            if (!canDiscover.usb && !canDiscover.bluetooth && !canDiscover.serial) {
                hints.push({ transport: 'network', icon: '🌐', message: 'This device does not support USB, Bluetooth, or Serial. Use "Network Printer" or the browser print fallback.' });
            }
        }

        if (cap && cap.platform && cap.platform.isIOS) {
            hints.push({ transport: null, icon: '📱', message: 'iOS supports Network and AirPrint only. USB and Bluetooth hardware access requires the SOKONI iOS app.' });
        } else if (cap && cap.platform && cap.platform.isAndroid && !canDiscover.serial) {
            hints.push({ transport: null, icon: '🤖', message: 'Serial is not supported on Android Chrome. Use Bluetooth or USB.' });
        }

        return hints;
    }

    // =========================================================================
    // Public interface
    // =========================================================================

    var DiscoveryEngine = {

        /**
         * Perform a full passive discovery scan across all available transports.
         * Safe to call at any time — no permission dialogs will appear.
         *
         * @returns {Promise<DiscoveryResult>}
         */
        discover: async function () {
            var canDiscover = {
                usb:       'usb'       in navigator,
                bluetooth: 'bluetooth' in navigator,
                serial:    'serial'    in navigator,
                hid:       'hid'       in navigator,
            };

            var cap = _cap();
            if (cap) {
                var pl = cap.platform;
                if (pl.isIOS) { canDiscover.usb = false; canDiscover.bluetooth = false; canDiscover.serial = false; }
                if (pl.isAndroid) { canDiscover.serial = false; }
            }

            // Run all transport scans in parallel
            var results = await Promise.all([
                canDiscover.usb       ? _scanUSB()       : Promise.resolve([]),
                canDiscover.bluetooth ? _scanBluetooth() : Promise.resolve([]),
                canDiscover.serial    ? _scanSerial()    : Promise.resolve([]),
                canDiscover.hid       ? _scanHID()       : Promise.resolve([]),
            ]);

            var detected = [].concat(results[0], results[1], results[2], results[3]);
            var hints    = _buildHints(canDiscover, detected);

            return {
                detected:    detected,
                hints:       hints,
                canDiscover: canDiscover,
                capturedAt:  _now(),
            };
        },

        /**
         * Discover only devices of a specific type (e.g. 'printer').
         * Filters the full discovery result.
         *
         * @param {string} type
         * @returns {Promise<DiscoveryResult>}
         */
        discoverType: async function (type) {
            var full = await this.discover();
            var dp   = _profiles();
            var filtered = full.detected.filter(function (d) {
                if (!d.profile) return false;
                return d.profile.type === type;
            });
            return Object.assign({}, full, { detected: filtered });
        },

        /**
         * Find a raw device object in the granted set that matches a saved record.
         * Used during auto-reconnect to get the live device reference.
         *
         * @param {object} savedRecord  {transport, vendorId, productId, deviceId, networkHost}
         * @returns {Promise<object|null>}  Raw WebUSB/WebBluetooth/Serial device, or null
         */
        findSavedDevice: async function (savedRecord) {
            var t   = savedRecord.transport;
            var perm = global.SokoniPermissionManager;
            if (!perm) return null;

            try {
                switch (t) {
                    case 'usb': {
                        var usbList = await perm.getGrantedUSBDevices();
                        return usbList.find(function (d) {
                            return d.vendorId === savedRecord.vendorId && d.productId === savedRecord.productId;
                        }) || null;
                    }
                    case 'bluetooth': {
                        var btList = await perm.getGrantedBluetoothDevices();
                        return btList.find(function (d) { return d.id === savedRecord.deviceId; }) || null;
                    }
                    case 'serial': {
                        var ports = await perm.getGrantedSerialPorts();
                        return ports.find(function (p) {
                            var info = p.getInfo && p.getInfo() || {};
                            return info.usbVendorId === savedRecord.vendorId && info.usbProductId === savedRecord.productId;
                        }) || null;
                    }
                    default:
                        return null;
                }
            } catch (_) { return null; }
        },

        /**
         * Quick check: does any granted device look like a printer?
         * Used by setup wizard to show "Detected" badge before full discovery.
         *
         * @returns {Promise<boolean>}
         */
        hasGrantedPrinter: async function () {
            var r = await this.discoverType('printer');
            return r.detected.length > 0;
        },
    };

    global.SokoniDiscoveryEngine = DiscoveryEngine;

})(window);
