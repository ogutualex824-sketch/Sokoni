/**
 * SOKONI Permission Manager v1.0
 * Phase 7 — Hardware Abstraction Layer
 *
 * Single authority for ALL browser permission requests.
 *
 * Rules:
 *  - NO other module may call navigator.usb.requestDevice(),
 *    navigator.bluetooth.requestDevice(), navigator.serial.requestPort(),
 *    navigator.hid.requestDevice(), Notification.requestPermission(),
 *    navigator.mediaDevices.getUserMedia(), or NDEFReader.scan() directly.
 *  - All request methods MUST be called from within a user gesture handler
 *    (click, pointerup, touchend). The browser enforces this natively.
 *  - "get" / "query" methods are passive — they return already-granted state
 *    without triggering any dialog.
 *  - Errors are enriched with human-readable .userMessage before rethrow.
 */

(function (global) {
    'use strict';

    // ---------------------------------------------------------------------------
    // USB Printer vendor filters
    // Used when requesting a USB printer device via the browser picker.
    // ---------------------------------------------------------------------------

    var USB_PRINTER_VID_FILTERS = [
        { vendorId: 0x04B8 }, // Epson
        { vendorId: 0x0519 }, // Star Micronics
        { vendorId: 0x154F }, // Xprinter
        { vendorId: 0x0FE6 }, // Sunmi / ICS
        { vendorId: 0x1FC9 }, // HOIN / NXP
        { vendorId: 0x0DD4 }, // Custom Engineering
        { vendorId: 0x0456 }, // Citizen Systems
        { vendorId: 0x05CB }, // TSC
        { vendorId: 0x0A5F }, // Zebra Technologies
        { vendorId: 0x1B5F }, // GOOJPRT
        { vendorId: 0x067B }, // Prolific USB-Serial
        { vendorId: 0x0403 }, // FTDI USB-Serial
        { vendorId: 0x10C4 }, // Silicon Labs USB-Serial
        { vendorId: 0x1A86 }, // CH340/CH341 USB-Serial
        { classCode: 0x07  }, // USB Printer class (catch-all)
    ];

    // ---------------------------------------------------------------------------
    // Bluetooth printer service UUID filters
    // ---------------------------------------------------------------------------

    var BT_PRINTER_SERVICES = [
        '000018f0-0000-1000-8000-00805f9b34fb', // Generic ESC/POS
        '0000ff00-0000-1000-8000-00805f9b34fb', // P58E / HOIN primary
        'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Epson
        '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip
        '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART (NUS)
        '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10
        'bef8d6c9-92a3-4e29-9f6a-d2cc7e0fc3d1', // Epson Mobile
    ];

    var BT_PRINTER_FILTERS = [
        { services: ['000018f0-0000-1000-8000-00805f9b34fb'] },
        { services: ['0000ff00-0000-1000-8000-00805f9b34fb'] },
        { services: ['e7810a71-73ae-499d-8c15-faa9aef0c3f2'] },
        { services: ['49535343-fe7d-4ae5-8fa9-9fafd205e455'] },
        { services: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'] },
        { services: ['0000ffe0-0000-1000-8000-00805f9b34fb'] },
        { namePrefix: 'P58' },
        { namePrefix: 'XP-' },
        { namePrefix: 'RP5' },
        { namePrefix: 'RP8' },
        { namePrefix: 'HOP' },
        { namePrefix: 'MTP' },
        { namePrefix: 'PTP' },
        { namePrefix: 'TM-' },
        { namePrefix: 'TSP' },
        { namePrefix: 'BTP' },
        { namePrefix: 'Printer' },
    ];

    // ---------------------------------------------------------------------------
    // Error enrichment
    // ---------------------------------------------------------------------------

    function enrichError(err, context) {
        var msg;
        var name = (err && err.name) || '';
        var code = (err && err.code) || '';

        if (name === 'NotFoundError' || code === 'NotFoundError') {
            msg = 'No device was selected. Please click the button and select your device from the dialog.';
        } else if (name === 'NotAllowedError' || code === 'NotAllowedError') {
            msg = 'Permission denied. ' + (context || 'Please try again and allow access when prompted.');
        } else if (name === 'SecurityError') {
            msg = 'Security error: ' + (context || 'This action must be triggered by a button click.') +
                  ' If the problem persists, reload the page.';
        } else if (name === 'NotSupportedError') {
            msg = 'This device or feature is not supported. Try a different connection type.';
        } else if (name === 'NetworkError') {
            msg = 'Connection failed. Check that the printer is powered on and within range.';
        } else if (err && err.message && /user gesture/i.test(err.message)) {
            msg = 'This action must be triggered by a button click — not called automatically.';
        } else {
            msg = (err && err.message) || 'An unknown error occurred.';
        }

        err = err || new Error(msg);
        err.userMessage = msg;
        return err;
    }

    // ---------------------------------------------------------------------------
    // PermissionManager
    // ---------------------------------------------------------------------------

    global.SokoniPermissionManager = Object.freeze({

        // -------------------------------------------------------------------
        // USB — Phase 5 (Android: requestDevice must be in user gesture)
        // -------------------------------------------------------------------

        /**
         * Requests access to a USB printer device.
         * MUST be called from a user gesture (button click).
         * Opens the browser's native USB device picker.
         *
         * @param {Array} [filters] - Optional vendor filters. Defaults to all known printer VIDs.
         * @returns {Promise<USBDevice>}
         */
        requestUSBDevice: async function (filters) {
            if (!('usb' in navigator)) {
                throw Object.assign(new Error('WebUSB is not supported on this browser.'), {
                    userMessage: 'USB printing is not supported on this browser. Try Chrome or Edge on desktop or Android.',
                });
            }
            try {
                return await navigator.usb.requestDevice({
                    filters: filters || USB_PRINTER_VID_FILTERS,
                });
            } catch (err) {
                throw enrichError(err, 'Please click "Connect USB Printer" and select your device.');
            }
        },

        /**
         * Returns USB devices that have already been granted permission.
         * Passive — never triggers a dialog.
         *
         * @returns {Promise<USBDevice[]>}
         */
        getGrantedUSBDevices: async function () {
            if (!('usb' in navigator)) return [];
            try {
                return await navigator.usb.getDevices();
            } catch (_) {
                return [];
            }
        },

        /** Passively registers USB connect/disconnect event listeners. */
        watchUSBEvents: function (onConnect, onDisconnect) {
            if (!('usb' in navigator)) return function () {};
            var attach = function (e) { if (onConnect) onConnect(e.device); };
            var detach = function (e) { if (onDisconnect) onDisconnect(e.device); };
            navigator.usb.addEventListener('connect',    attach);
            navigator.usb.addEventListener('disconnect', detach);
            return function () {
                navigator.usb.removeEventListener('connect',    attach);
                navigator.usb.removeEventListener('disconnect', detach);
            };
        },

        // -------------------------------------------------------------------
        // Bluetooth — Phase 5 (Android: requestDevice must be in user gesture)
        // -------------------------------------------------------------------

        /**
         * Requests access to a Bluetooth printer device.
         * MUST be called from a user gesture (button click).
         * Opens the browser's native Bluetooth device picker.
         *
         * @param {object} [options] - Optional requestDevice options.
         * @returns {Promise<BluetoothDevice>}
         */
        requestBluetoothDevice: async function (options) {
            if (!('bluetooth' in navigator)) {
                throw Object.assign(new Error('Web Bluetooth is not supported on this browser.'), {
                    userMessage: 'Bluetooth printing is not supported on this browser. Use Chrome on Android or desktop.',
                });
            }
            var defaults = {
                filters: BT_PRINTER_FILTERS,
                optionalServices: BT_PRINTER_SERVICES,
            };
            try {
                return await navigator.bluetooth.requestDevice(options || defaults);
            } catch (err) {
                throw enrichError(err, 'Please click "Connect Bluetooth Printer" and select your device.');
            }
        },

        /**
         * Returns Bluetooth devices that have already been granted permission.
         * Passive — never triggers a dialog.
         *
         * @returns {Promise<BluetoothDevice[]>}
         */
        getGrantedBluetoothDevices: async function () {
            if (!('bluetooth' in navigator)) return [];
            try {
                return await navigator.bluetooth.getDevices();
            } catch (_) {
                return [];
            }
        },

        // -------------------------------------------------------------------
        // Web Serial
        // -------------------------------------------------------------------

        /**
         * Requests access to a serial port.
         * MUST be called from a user gesture (button click).
         * Opens the browser's native serial port picker.
         *
         * @param {object} [options]
         * @returns {Promise<SerialPort>}
         */
        requestSerialPort: async function (options) {
            if (!('serial' in navigator)) {
                throw Object.assign(new Error('Web Serial is not supported on this browser.'), {
                    userMessage: 'Serial printing requires Chrome or Edge on desktop (not supported on Android or iOS).',
                });
            }
            try {
                return await navigator.serial.requestPort(options || {});
            } catch (err) {
                throw enrichError(err, 'Please click "Connect Serial Printer" and select your port.');
            }
        },

        /**
         * Returns serial ports that have already been granted permission.
         * Passive — never triggers a dialog.
         *
         * @returns {Promise<SerialPort[]>}
         */
        getGrantedSerialPorts: async function () {
            if (!('serial' in navigator)) return [];
            try {
                return await navigator.serial.getPorts();
            } catch (_) {
                return [];
            }
        },

        // -------------------------------------------------------------------
        // WebHID (Cash Drawer, Barcode Scanner)
        // -------------------------------------------------------------------

        /**
         * Requests access to a HID device.
         * MUST be called from a user gesture.
         *
         * @param {Array} [filters]
         * @returns {Promise<HIDDevice>}
         */
        requestHIDDevice: async function (filters) {
            if (!('hid' in navigator)) {
                throw Object.assign(new Error('WebHID is not supported on this browser.'), {
                    userMessage: 'HID device access requires Chrome or Edge on desktop.',
                });
            }
            try {
                var devices = await navigator.hid.requestDevice({ filters: filters || [] });
                return devices[0] || null;
            } catch (err) {
                throw enrichError(err, 'Please click the button and select your device.');
            }
        },

        /**
         * Returns HID devices that have already been granted permission.
         * Passive — never triggers a dialog.
         *
         * @returns {Promise<HIDDevice[]>}
         */
        getGrantedHIDDevices: async function () {
            if (!('hid' in navigator)) return [];
            try {
                return await navigator.hid.getDevices();
            } catch (_) {
                return [];
            }
        },

        // -------------------------------------------------------------------
        // Notifications
        // -------------------------------------------------------------------

        /**
         * Requests notification permission.
         * MUST be called from a user gesture in some browsers.
         *
         * @returns {Promise<'granted'|'denied'|'default'>}
         */
        requestNotificationPermission: async function () {
            if (!('Notification' in global)) return 'denied';
            try {
                return await Notification.requestPermission();
            } catch (_) {
                return 'denied';
            }
        },

        /** Returns current notification permission state without prompting. */
        getNotificationPermission: function () {
            if (!('Notification' in global)) return 'unsupported';
            return Notification.permission;
        },

        // -------------------------------------------------------------------
        // Camera
        // -------------------------------------------------------------------

        /**
         * Requests camera access for barcode scanning.
         * MUST be called from a user gesture.
         *
         * @returns {Promise<MediaStream>}
         */
        requestCamera: async function () {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw Object.assign(new Error('Camera access not supported.'), {
                    userMessage: 'Camera access is not available on this browser.',
                });
            }
            try {
                return await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'environment', width: { ideal: 1280 } },
                });
            } catch (err) {
                throw enrichError(err, 'Please allow camera access when prompted.');
            }
        },

        // -------------------------------------------------------------------
        // NFC
        // -------------------------------------------------------------------

        /**
         * Requests NFC scan permission by starting a scan session.
         * MUST be called from a user gesture.
         *
         * @returns {Promise<NDEFReader>}
         */
        requestNFC: async function () {
            if (!('NDEFReader' in global)) {
                throw Object.assign(new Error('NFC not supported.'), {
                    userMessage: 'NFC is not supported on this browser.',
                });
            }
            try {
                var reader = new NDEFReader();
                await reader.scan();
                return reader;
            } catch (err) {
                throw enrichError(err, 'Please allow NFC access when prompted.');
            }
        },

        // -------------------------------------------------------------------
        // Biometric (WebAuthn)
        // -------------------------------------------------------------------

        /**
         * Checks whether a platform authenticator (fingerprint/face) is available.
         * Passive — never triggers a dialog.
         *
         * @returns {Promise<boolean>}
         */
        checkBiometricAvailability: async function () {
            if (!('credentials' in navigator) || !global.PublicKeyCredential) return false;
            try {
                return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            } catch (_) {
                return false;
            }
        },

        // -------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------

        /**
         * Queries the Permissions API for a named permission without prompting.
         *
         * @param {string} name
         * @returns {Promise<'granted'|'denied'|'prompt'|'unknown'>}
         */
        query: async function (name) {
            if (!navigator.permissions) return 'unknown';
            try {
                var status = await navigator.permissions.query({ name: name });
                return status.state;
            } catch (_) {
                return 'unknown';
            }
        },

        /** Filter USB_PRINTER_VID_FILTERS for external use (read-only). */
        get usbPrinterFilters() { return USB_PRINTER_VID_FILTERS.slice(); },

        /** BT_PRINTER_SERVICES UUIDs for external use (read-only). */
        get btPrinterServices() { return BT_PRINTER_SERVICES.slice(); },

        /** BT_PRINTER_FILTERS for external use (read-only). */
        get btPrinterFilters() { return BT_PRINTER_FILTERS.slice(); },
    });

})(window);
