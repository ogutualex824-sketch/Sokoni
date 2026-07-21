/**
 * SOKONI Capability Detector v1.0
 * Phase 3 — Hardware Abstraction Layer
 *
 * Single authority for browser and platform capability detection.
 * Evaluated once at parse time; all results are frozen.
 *
 * Rules:
 *  - Never call requestDevice / requestPort here. Detection only.
 *  - Never show UI options for unsupported APIs.
 *  - supportsUSB / supportsBluetooth / supportsSerial drive the wizard.
 */

(function (global) {
    'use strict';

    // ---------------------------------------------------------------------------
    // Platform fingerprint
    // ---------------------------------------------------------------------------

    var ua = navigator.userAgent;
    var maxTouch = navigator.maxTouchPoints || 0;

    var PLATFORM = Object.freeze({
        isIOS: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && maxTouch > 1),
        isAndroid: /Android/.test(ua),
        isMacOS: /Macintosh/.test(ua) && maxTouch < 2,
        isWindows: /Windows/.test(ua),
        isLinux: /Linux/.test(ua) && !/Android/.test(ua),
        isSafari: /Safari/.test(ua) && !/Chrome/.test(ua) && !/CriOS/.test(ua),
        isChrome: /Chrome/.test(ua) && !/Edge\//.test(ua) && !/Edg\//.test(ua) && !/OPR/.test(ua),
        isEdge: /Edg\//.test(ua),
        isFirefox: /Firefox/.test(ua),
        isSamsungInternet: /SamsungBrowser/.test(ua),
        isOpera: /OPR\//.test(ua),
        isChromiumBased: !!(global.chrome && (global.chrome.webstore || global.chrome.runtime)),
        isPWA: (
            global.matchMedia('(display-mode: standalone)').matches ||
            global.matchMedia('(display-mode: fullscreen)').matches ||
            navigator.standalone === true
        ),
        isWebView: (
            /wv/.test(ua) ||
            (/Android/.test(ua) && /Version\/\d+\.\d+/.test(ua) && !/Chrome\/\d+/.test(ua))
        ),
        get isDesktop() {
            return !this.isIOS && !this.isAndroid;
        },
        get isMobile() {
            return this.isIOS || this.isAndroid;
        },
    });

    // ---------------------------------------------------------------------------
    // Browser API capability flags
    // Evaluated once — these never change during a page session.
    // ---------------------------------------------------------------------------

    var CAPABILITIES = Object.freeze({
        // Hardware transport APIs
        supportsUSB:             'usb'        in navigator,
        supportsBluetooth:       'bluetooth'  in navigator,
        supportsSerial:          'serial'     in navigator,
        supportsHID:             'hid'        in navigator,
        supportsNFC:             'NDEFReader' in global,

        // Network & real-time
        supportsWebSocket:       'WebSocket'  in global,
        supportsWebRTC:          'RTCPeerConnection' in global,

        // Media & camera
        supportsBarcodeDetector: 'BarcodeDetector' in global,
        supportsMediaDevices:    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        supportsImageCapture:    'ImageCapture' in global,

        // Sharing & printing
        supportsShare:           typeof navigator.share === 'function',
        supportsShareFiles:      !!(navigator.share && navigator.canShare),

        // Storage
        supportsIndexedDB:       'indexedDB' in global,
        supportsLocalStorage:    (function () {
            try { localStorage.setItem('__cap', '1'); localStorage.removeItem('__cap'); return true; }
            catch (_) { return false; }
        })(),

        // Security & identity
        supportsCrypto:          'crypto' in global && !!(global.crypto && global.crypto.subtle),
        supportsWebAuthn:        !!(navigator.credentials && global.PublicKeyCredential),

        // System
        supportsWakeLock:        'wakeLock'       in navigator,
        supportsServiceWorker:   'serviceWorker'  in navigator,
        supportsNotifications:   'Notification'   in global,
        supportsGeolocation:     'geolocation'    in navigator,
    });

    // ---------------------------------------------------------------------------
    // Transport availability matrix
    // Maps transport name → whether it can function on this platform/browser.
    // Network and browser are always available.
    // ---------------------------------------------------------------------------

    var TRANSPORT_AVAILABILITY = Object.freeze({
        usb:       CAPABILITIES.supportsUSB       && !PLATFORM.isIOS,
        bluetooth: CAPABILITIES.supportsBluetooth && !PLATFORM.isIOS,
        serial:    CAPABILITIES.supportsSerial    && !PLATFORM.isIOS && !PLATFORM.isAndroid,
        hid:       CAPABILITIES.supportsHID       && !PLATFORM.isIOS,
        network:   CAPABILITIES.supportsWebSocket,
        browser:   true,
    });

    // ---------------------------------------------------------------------------
    // Android-specific constraints
    // ---------------------------------------------------------------------------

    var ANDROID_CONSTRAINTS = PLATFORM.isAndroid ? Object.freeze({
        usbRequiresGesture:       true,
        bluetoothRequiresGesture: true,
        serialUnsupported:        true,
        hidUnsupported:           true,
        bleChunkSizeRecommended:  128,
        btPermissionRequired:     true, // Android 12+ BLUETOOTH_CONNECT permission
    }) : null;

    // ---------------------------------------------------------------------------
    // iOS constraints (informational — these APIs simply don't exist)
    // ---------------------------------------------------------------------------

    var IOS_CONSTRAINTS = PLATFORM.isIOS ? Object.freeze({
        usbUnsupported:       true,
        bluetoothUnsupported: true,
        serialUnsupported:    true,
        hidUnsupported:       true,
        printViaAirPrint:     true,
        printViaWebShare:     CAPABILITIES.supportsShare,
    }) : null;

    // ---------------------------------------------------------------------------
    // Permission Queries
    // ---------------------------------------------------------------------------

    /**
     * Queries the Permissions API for a named permission.
     * Returns 'granted' | 'denied' | 'prompt' | 'unknown'.
     * Does NOT trigger a permission dialog.
     */
    async function queryPermission(name) {
        if (!navigator.permissions) return 'unknown';
        try {
            var status = await navigator.permissions.query({ name: name });
            return status.state;
        } catch (_) {
            return 'unknown';
        }
    }

    // ---------------------------------------------------------------------------
    // Public interface
    // ---------------------------------------------------------------------------

    global.SokoniCapabilityDetector = Object.freeze({

        platform: PLATFORM,
        capabilities: CAPABILITIES,
        transports: TRANSPORT_AVAILABILITY,
        androidConstraints: ANDROID_CONSTRAINTS,
        iosConstraints: IOS_CONSTRAINTS,

        /** Returns true if the named capability key is supported. */
        supports: function (key) {
            return !!CAPABILITIES[key];
        },

        /** Returns true if the named transport is available on this platform. */
        transportAvailable: function (transport) {
            return !!TRANSPORT_AVAILABILITY[transport];
        },

        /** Returns the list of transports that can function on this platform. */
        availableTransports: function () {
            return Object.keys(TRANSPORT_AVAILABILITY).filter(function (t) {
                return TRANSPORT_AVAILABILITY[t];
            });
        },

        /** Returns the recommended transport for this platform. */
        recommendedTransport: function () {
            if (PLATFORM.isIOS)     return 'browser';
            if (PLATFORM.isAndroid) return CAPABILITIES.supportsBluetooth ? 'bluetooth' : 'browser';
            if (PLATFORM.isWindows) return CAPABILITIES.supportsSerial ? 'serial' : 'usb';
            if (PLATFORM.isMacOS)   return CAPABILITIES.supportsBluetooth ? 'bluetooth' : 'browser';
            return CAPABILITIES.supportsUSB ? 'usb' : 'browser';
        },

        /** Queries the current state of a permission without triggering a dialog. */
        queryPermission: queryPermission,

        /** Returns a complete snapshot of all detected capabilities. */
        report: function () {
            return {
                platform:            PLATFORM,
                capabilities:        CAPABILITIES,
                transports:          TRANSPORT_AVAILABILITY,
                availableTransports: this.availableTransports(),
                recommended:         this.recommendedTransport(),
                androidConstraints:  ANDROID_CONSTRAINTS,
                iosConstraints:      IOS_CONSTRAINTS,
                userAgent:           navigator.userAgent,
                timestamp:           new Date().toISOString(),
            };
        },
    });

})(window);
