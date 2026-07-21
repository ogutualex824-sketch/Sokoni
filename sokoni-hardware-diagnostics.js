/**
 * SOKONI Hardware Diagnostics v1.0
 * Phase 10 — Hardware Abstraction Layer
 *
 * Generates a comprehensive hardware diagnostic report covering:
 *   - Browser identity and version
 *   - Platform (OS, PWA, WebView)
 *   - Supported browser APIs
 *   - Connected device state
 *   - Permission state for each transport
 *   - Selected transport
 *   - Detected printer profile
 *   - ESC/POS compatibility
 *   - Error history
 *   - Recovery suggestions
 *
 * Usage:
 *   const report = await SokoniHardwareDiagnostics.generate();
 *   SokoniHardwareDiagnostics.renderToElement(document.getElementById('diag'), report);
 */

(function (global) {
    'use strict';

    // ---------------------------------------------------------------------------
    // Error history — ring buffer of last 50 hw:error events
    // ---------------------------------------------------------------------------

    var _errors = [];
    var MAX_ERRORS = 50;

    function _onHwError(e) {
        _errors.push({ message: e.detail && e.detail.message, at: new Date().toISOString() });
        if (_errors.length > MAX_ERRORS) _errors.shift();
    }
    global.addEventListener('hw:error', _onHwError);

    // ---------------------------------------------------------------------------
    // Browser identity helpers
    // ---------------------------------------------------------------------------

    function _parseBrowserVersion(ua) {
        var matchers = [
            { name: 'Chrome',         re: /Chrome\/(\d+\.\d+)/      },
            { name: 'Edge',           re: /Edg\/(\d+\.\d+)/         },
            { name: 'Firefox',        re: /Firefox\/(\d+\.\d+)/     },
            { name: 'Safari',         re: /Version\/(\d+\.\d+).*Safari/ },
            { name: 'Samsung Internet', re: /SamsungBrowser\/(\d+\.\d+)/ },
            { name: 'Opera',          re: /OPR\/(\d+\.\d+)/         },
        ];
        var ua_ = navigator.userAgent;
        for (var i = 0; i < matchers.length; i++) {
            var m = ua_.match(matchers[i].re);
            if (m) return { name: matchers[i].name, version: m[1] };
        }
        return { name: 'Unknown', version: '?' };
    }

    // ---------------------------------------------------------------------------
    // Permission state queries
    // ---------------------------------------------------------------------------

    async function _queryPermissions() {
        var perm = global.SokoniPermissionManager;
        var results = {};

        // USB
        if ('usb' in navigator) {
            var grantedUSB = await (perm ? perm.getGrantedUSBDevices() : navigator.usb.getDevices().catch(function () { return []; }));
            results.usb = { supported: true, grantedDeviceCount: grantedUSB.length };
        } else {
            results.usb = { supported: false };
        }

        // Bluetooth
        if ('bluetooth' in navigator) {
            var grantedBT = await (perm ? perm.getGrantedBluetoothDevices() : navigator.bluetooth.getDevices().catch(function () { return []; }));
            var avail = false;
            try { avail = await navigator.bluetooth.getAvailability(); } catch (_) {}
            results.bluetooth = { supported: true, available: avail, grantedDeviceCount: grantedBT.length };
        } else {
            results.bluetooth = { supported: false };
        }

        // Serial
        if ('serial' in navigator) {
            var grantedSerial = await (perm ? perm.getGrantedSerialPorts() : navigator.serial.getPorts().catch(function () { return []; }));
            results.serial = { supported: true, grantedPortCount: grantedSerial.length };
        } else {
            results.serial = { supported: false };
        }

        // HID
        if ('hid' in navigator) {
            var grantedHID = await (perm ? perm.getGrantedHIDDevices() : navigator.hid.getDevices().catch(function () { return []; }));
            results.hid = { supported: true, grantedDeviceCount: grantedHID.length };
        } else {
            results.hid = { supported: false };
        }

        // Notifications
        results.notifications = {
            supported: 'Notification' in global,
            state:     ('Notification' in global) ? Notification.permission : 'unsupported',
        };

        return results;
    }

    // ---------------------------------------------------------------------------
    // Active printer state
    // ---------------------------------------------------------------------------

    function _getActivePrinterInfo() {
        var hm = global.HardwareManager;
        if (!hm) return null;
        var ap = hm.getActivePrinter();
        if (!ap) return null;
        return {
            model:           ap.descriptor.model     || 'Unknown',
            transport:       ap.descriptor.transport || (ap.provider && ap.provider.transport) || 'unknown',
            profile:         ap.escpos && ap.escpos._profile ? {
                id:          ap.escpos._profile.id,
                name:        ap.escpos._profile.name,
                paperWidth:  ap.escpos._profile.paperWidth,
                escposProfile: ap.escpos._profile.escposProfile,
            } : null,
            deviceId:        ap.descriptor.deviceId   || null,
            vendorId:        ap.descriptor.vendorId   ? '0x' + ap.descriptor.vendorId.toString(16).toUpperCase().padStart(4, '0') : null,
            productId:       ap.descriptor.productId  ? '0x' + ap.descriptor.productId.toString(16).toUpperCase().padStart(4, '0') : null,
            networkHost:     ap.descriptor.networkHost || null,
            savedId:         ap.savedId || null,
            connected:       true,
        };
    }

    // ---------------------------------------------------------------------------
    // Recovery suggestions
    // ---------------------------------------------------------------------------

    function _buildSuggestions(platform, capabilities, permissions, activePrinter) {
        var suggestions = [];
        var cap  = _cap();

        if (cap && cap.platform.isIOS) {
            suggestions.push({
                code:    'IOS_HARDWARE',
                severity:'info',
                message: 'iOS WebKit does not support USB, Bluetooth, or Serial APIs. Use Network printing or AirPrint (window.print).',
            });
        }

        if (cap && cap.platform.isAndroid) {
            suggestions.push({
                code:    'ANDROID_SERIAL',
                severity:'info',
                message: 'Web Serial is not supported on Android Chrome. Use USB or Bluetooth instead.',
            });
        }

        if (!activePrinter) {
            suggestions.push({
                code:    'NO_PRINTER',
                severity:'warning',
                message: 'No printer is connected. Open Hardware Setup to configure a printer.',
                action:  'pos-hardware-setup.html',
            });
        }

        if (permissions.usb && permissions.usb.supported && permissions.usb.grantedDeviceCount === 0 && !cap.platform.isIOS && !cap.platform.isAndroid) {
            suggestions.push({
                code:    'USB_NO_GRANT',
                severity:'info',
                message: 'No USB printer has been authorised. Go to Hardware Setup → USB to pair a USB printer.',
            });
        }

        if (permissions.bluetooth && permissions.bluetooth.supported && permissions.bluetooth.available === false) {
            suggestions.push({
                code:    'BT_UNAVAILABLE',
                severity:'warning',
                message: 'Bluetooth reports as unavailable. Ensure Bluetooth is enabled in the system settings.',
            });
        }

        if (_errors.length > 5) {
            suggestions.push({
                code:    'RECENT_ERRORS',
                severity:'warning',
                message: _errors.length + ' hardware errors recorded recently. Check printer power, cable, and range.',
            });
        }

        return suggestions;
    }

    function _cap() {
        return global.SokoniCapabilityDetector;
    }

    // ---------------------------------------------------------------------------
    // Main generate() function
    // ---------------------------------------------------------------------------

    async function generate() {
        var ua      = navigator.userAgent;
        var browser = _parseBrowserVersion(ua);
        var cap     = _cap();
        var capReport = cap ? cap.report() : {};

        var permissions   = await _queryPermissions();
        var activePrinter = _getActivePrinterInfo();
        var suggestions   = _buildSuggestions(capReport.platform, capReport.capabilities, permissions, activePrinter);

        var report = {
            capturedAt:    new Date().toISOString(),

            browser: {
                name:       browser.name,
                version:    browser.version,
                userAgent:  ua,
                language:   navigator.language,
                online:     navigator.onLine,
                cookieEnabled: navigator.cookieEnabled,
            },

            platform: capReport.platform || {},

            apis: {
                usb:             'usb'          in navigator,
                bluetooth:       'bluetooth'    in navigator,
                serial:          'serial'       in navigator,
                hid:             'hid'          in navigator,
                nfc:             'NDEFReader'   in global,
                share:           typeof navigator.share === 'function',
                shareFiles:      !!(navigator.share && navigator.canShare),
                barcodeDetector: 'BarcodeDetector' in global,
                wakeLock:        'wakeLock'     in navigator,
                serviceWorker:   'serviceWorker' in navigator,
                indexedDB:       'indexedDB'    in global,
                notifications:   'Notification' in global,
                webAuthn:        !!(navigator.credentials && global.PublicKeyCredential),
                webRTC:          'RTCPeerConnection' in global,
            },

            transports:       capReport.transports || {},
            recommendedTransport: capReport.recommended || 'browser',

            permissions:      permissions,
            activePrinter:    activePrinter,

            savedPrinters: (function () {
                var hm = global.HardwareManager;
                return hm ? hm.getSavedPrinters() : Promise.resolve([]);
            })(),

            recentErrors:  _errors.slice(-10),
            suggestions:   suggestions,
        };

        // Resolve savedPrinters promise
        report.savedPrinters = await report.savedPrinters;

        return report;
    }

    // ---------------------------------------------------------------------------
    // renderToElement() — renders report as styled HTML into a container
    // ---------------------------------------------------------------------------

    function renderToElement(el, report) {
        if (!el || !report) return;

        function bool(v) { return v ? '✓ Yes' : '✗ No'; }
        function unk(v)  { return v == null ? '—' : v; }

        var rows = function (obj, fmt) {
            return Object.entries(obj).map(function (kv) {
                var val = fmt ? fmt(kv[0], kv[1]) : (kv[1] === true ? '✓' : kv[1] === false ? '✗' : unk(kv[1]));
                return '<tr><td>' + kv[0] + '</td><td>' + val + '</td></tr>';
            }).join('');
        };

        var ap  = report.activePrinter;
        var pf  = ap && ap.profile;
        var sev = { info: '#71ff00', warning: '#ffaa00', error: '#ff4444' };

        el.innerHTML = '<style>' +
            '.hw-diag{font-family:monospace;font-size:13px;color:#ccc;background:#111;padding:16px;border-radius:8px}' +
            '.hw-diag h3{color:#71ff00;margin:16px 0 6px;font-size:14px;letter-spacing:.05em;text-transform:uppercase}' +
            '.hw-diag table{width:100%;border-collapse:collapse;margin-bottom:8px}' +
            '.hw-diag td{padding:3px 8px 3px 0;border-bottom:1px solid #222;vertical-align:top}' +
            '.hw-diag td:first-child{color:#888;width:55%;white-space:nowrap}' +
            '.hw-diag .ok{color:#71ff00}.hw-diag .warn{color:#ffaa00}.hw-diag .err{color:#ff4444}' +
            '.hw-diag .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}' +
            '.hw-diag .suggestion{margin:4px 0;padding:6px 10px;border-left:3px solid;border-radius:0 4px 4px 0;background:#1a1a1a}' +
        '</style>' +
        '<div class="hw-diag">' +

        '<h3>Browser</h3><table>' +
        '<tr><td>Browser</td><td>' + report.browser.name + ' ' + report.browser.version + '</td></tr>' +
        '<tr><td>Language</td><td>' + report.browser.language + '</td></tr>' +
        '<tr><td>Online</td><td class="' + (report.browser.online ? 'ok' : 'warn') + '">' + bool(report.browser.online) + '</td></tr>' +
        '</table>' +

        '<h3>Platform</h3><table>' +
        rows(report.platform) +
        '</table>' +

        '<h3>Supported APIs</h3><table>' +
        rows(report.apis, function (k, v) {
            return '<span class="' + (v ? 'ok' : '') + '">' + bool(v) + '</span>';
        }) +
        '</table>' +

        '<h3>Transport Availability</h3><table>' +
        rows(report.transports, function (k, v) {
            return '<span class="' + (v ? 'ok' : '') + '">' + bool(v) + '</span>';
        }) +
        '</table>' +

        '<h3>Connected Printer</h3>' + (ap ? '<table>' +
        '<tr><td>Model</td><td class="ok">' + unk(ap.model) + '</td></tr>' +
        '<tr><td>Transport</td><td>' + unk(ap.transport) + '</td></tr>' +
        (pf ? '<tr><td>Profile</td><td>' + pf.name + '</td></tr>' : '') +
        (pf ? '<tr><td>Paper Width</td><td>' + pf.paperWidth + '</td></tr>' : '') +
        (pf ? '<tr><td>ESC/POS Profile</td><td>' + pf.escposProfile + '</td></tr>' : '') +
        (ap.vendorId ? '<tr><td>Vendor ID</td><td>' + ap.vendorId + '</td></tr>' : '') +
        (ap.deviceId ? '<tr><td>Device ID</td><td>' + ap.deviceId + '</td></tr>' : '') +
        '</table>' : '<p style="color:#666">No printer connected.</p>') +

        '<h3>Permission State</h3><table>' +
        (report.permissions.usb ? '<tr><td>USB</td><td>' + (report.permissions.usb.supported ? (report.permissions.usb.grantedDeviceCount + ' device(s) granted') : 'Not supported') + '</td></tr>' : '') +
        (report.permissions.bluetooth ? '<tr><td>Bluetooth</td><td>' + (report.permissions.bluetooth.supported ? (report.permissions.bluetooth.grantedDeviceCount + ' device(s) granted, available=' + bool(report.permissions.bluetooth.available)) : 'Not supported') + '</td></tr>' : '') +
        (report.permissions.serial ? '<tr><td>Serial</td><td>' + (report.permissions.serial.supported ? (report.permissions.serial.grantedPortCount + ' port(s) granted') : 'Not supported') + '</td></tr>' : '') +
        '<tr><td>Notifications</td><td>' + (report.permissions.notifications.state || 'unknown') + '</td></tr>' +
        '</table>' +

        (report.suggestions.length ? '<h3>Suggestions</h3>' +
        report.suggestions.map(function (s) {
            return '<div class="suggestion" style="border-color:' + (sev[s.severity] || '#555') + '">' +
                   '<span style="color:' + (sev[s.severity] || '#ccc') + '">[' + s.severity.toUpperCase() + ']</span> ' +
                   s.message + (s.action ? ' <a href="' + s.action + '" style="color:#71ff00">Open →</a>' : '') +
                   '</div>';
        }).join('') : '') +

        (report.recentErrors.length ? '<h3>Recent Errors</h3>' +
        report.recentErrors.slice(-5).map(function (e) {
            return '<div style="color:#ff6666;font-size:11px;padding:2px 0">[' + (e.at || '').replace('T', ' ').slice(0, 19) + '] ' + (e.message || '?') + '</div>';
        }).join('') : '') +

        '<p style="color:#333;font-size:11px;margin-top:16px">' + report.capturedAt + '</p>' +
        '</div>';
    }

    // ---------------------------------------------------------------------------
    // Export
    // ---------------------------------------------------------------------------

    global.SokoniHardwareDiagnostics = {
        generate:       generate,
        renderToElement: renderToElement,
        getErrors:      function () { return _errors.slice(); },
        clearErrors:    function () { _errors = []; },
    };

})(window);
