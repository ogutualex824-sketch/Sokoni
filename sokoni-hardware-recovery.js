/**
 * SOKONI Hardware Recovery v1.0
 * Phase 11 — Hardware Abstraction Layer
 *
 * Automatic recovery for transient hardware disconnections.
 *
 * Handles:
 *  - USB printer removed → reconnect automatically when replugged
 *  - Bluetooth printer disconnected → reconnect when device re-enters range
 *  - Page hidden → pause health polling; visible → re-probe active printer
 *
 * Rules:
 *  - All reconnect attempts use PASSIVE getStored* calls only.
 *  - NEVER call requestDevice / requestPort here — that requires a user gesture.
 *  - If the permissions were revoked (device not in getStored*), emit a 'hw:needsSetup'
 *    event but do NOT open a picker automatically.
 *  - Recovery is silent — no user interaction unless the device is truly gone.
 */

(function (global) {
    'use strict';

    var _running = false;
    var _cleanups = [];         // unsubscribe functions to call on stop()
    var _pendingUSBDevices = new Map(); // vendorId+productId → savedPrinterId

    var MAX_RECONNECT_ATTEMPTS = 5;
    var BASE_BACKOFF_MS        = 3000;
    var MAX_BACKOFF_MS         = 60000;

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    function _hm()  { return global.HardwareManager;             }
    function _per() { return global.SokoniHardwarePersistence;   }
    function _log(msg, data) {
        console.info('[SOKONI HW Recovery] ' + msg, data || '');
    }
    function _emit(name, detail) {
        try {
            global.dispatchEvent(new CustomEvent('hw:' + name, { detail: detail, bubbles: false }));
        } catch (_) {}
    }

    function _wait(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function _backoff(attempt) {
        return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
    }

    // Build a device key from USB descriptor
    function _usbKey(d) {
        return (d.vendorId || 0).toString(16) + ':' + (d.productId || 0).toString(16);
    }

    // ---------------------------------------------------------------------------
    // USB event handlers (Phase 11)
    // ---------------------------------------------------------------------------

    async function _onUSBConnect(device) {
        _log('USB connect event', { vendorId: device.vendorId, productId: device.productId });

        var hm = _hm();
        if (!hm) return;

        // Already have an active printer? Don't auto-switch.
        if (hm.isConnected()) {
            _log('Already connected — skipping auto-reconnect.');
            return;
        }

        // Is this a known/saved printer?
        var per = _per();
        if (!per) return;

        var saved = await per.getAllPrinters();
        var match = saved.find(function (r) {
            return r.transport === 'usb' &&
                   r.vendorId  === device.vendorId &&
                   r.productId === device.productId;
        });

        if (!match) {
            _log('USB device not in saved printers — no auto-reconnect.');
            return;
        }

        _log('Found saved printer matching USB device: ' + match.model + ' — reconnecting...');
        _emit('reconnecting', { id: match.id, model: match.model, transport: 'usb' });

        var attempts = 0;
        while (attempts < MAX_RECONNECT_ATTEMPTS) {
            try {
                var ok = await hm.reconnect(match.id);
                if (ok) {
                    _log('USB reconnect succeeded after ' + (attempts + 1) + ' attempt(s).');
                    _emit('reconnected', { id: match.id, model: match.model, transport: 'usb' });
                    return;
                }
            } catch (e) {
                _log('USB reconnect attempt ' + (attempts + 1) + ' failed: ' + e.message);
            }
            attempts++;
            if (attempts < MAX_RECONNECT_ATTEMPTS) {
                await _wait(_backoff(attempts));
            }
        }

        _log('USB reconnect failed after ' + MAX_RECONNECT_ATTEMPTS + ' attempts.');
        _emit('reconnectFailed', { id: match.id, model: match.model, transport: 'usb' });
    }

    async function _onUSBDisconnect(device) {
        _log('USB disconnect event', { vendorId: device.vendorId, productId: device.productId });

        var hm = _hm();
        if (!hm) return;

        var ap = hm.getActivePrinter();
        if (!ap) return;

        var d = ap.descriptor;
        if (d.vendorId === device.vendorId && d.productId === device.productId) {
            _log('Active USB printer was unplugged.');
            _emit('disconnected', { transport: 'usb', model: d.model, reason: 'unplugged' });
            // Do NOT call forgetPrinter — the printer is just unplugged, not forgotten.
            // When it's replugged, _onUSBConnect fires and _reconnect handles it.
        }
    }

    // ---------------------------------------------------------------------------
    // Bluetooth reconnect (Phase 11)
    // ---------------------------------------------------------------------------

    /**
     * Called when a Bluetooth gattserverdisconnected event fires.
     * This is wired in HardwareManager._setActivePrinter().
     * Here we provide the retry loop.
     *
     * @param {string} savedId
     */
    async function _onBTDisconnect(savedId) {
        var hm = _hm();
        if (!hm) return;

        _log('Bluetooth disconnect — will attempt reconnect for: ' + savedId);
        _emit('reconnecting', { id: savedId, transport: 'bluetooth' });

        var attempts = 0;
        while (attempts < MAX_RECONNECT_ATTEMPTS) {
            // Bluetooth devices return to range — try passive getDevices reconnect
            await _wait(_backoff(attempts));
            try {
                var ok = await hm.reconnect(savedId);
                if (ok) {
                    _log('Bluetooth reconnect succeeded after ' + (attempts + 1) + ' attempt(s).');
                    _emit('reconnected', { id: savedId, transport: 'bluetooth' });
                    return;
                }
            } catch (e) {
                _log('Bluetooth reconnect attempt ' + (attempts + 1) + ' failed: ' + e.message);
            }
            attempts++;
        }

        // After exhausting retries, emit needsSetup only if grantedDevices is empty
        _log('Bluetooth reconnect failed — checking if permission was revoked...');
        var per = global.SokoniPermissionManager;
        if (per) {
            var granted = await per.getGrantedBluetoothDevices();
            if (granted.length === 0) {
                _log('Permission appears to have been revoked — emitting needsSetup.');
                _emit('needsSetup', { transport: 'bluetooth', reason: 'permission_revoked' });
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Page visibility handler
    // ---------------------------------------------------------------------------

    function _onVisibilityChange() {
        if (document.visibilityState !== 'visible') return;

        var hm = _hm();
        if (!hm || !hm.isConnected()) return;

        var ap = hm.getActivePrinter();
        if (!ap || !ap.savedId) return;

        // Re-probe the active printer after the page becomes visible again.
        // This detects printers that went to sleep or were switched off.
        setTimeout(async function () {
            _log('Page became visible — probing active printer...');
            try {
                var probeResult = await ap.escpos.probe(ap.connection);
                if (!probeResult.compatible) {
                    _log('Active printer did not respond to probe — attempting reconnect.');
                    _emit('reconnecting', { id: ap.savedId, transport: ap.provider.transport });
                    await hm.reconnect(ap.savedId);
                } else {
                    _log('Active printer probe OK.');
                }
            } catch (e) {
                _log('Post-visibility probe failed: ' + e.message);
                if (ap.savedId) {
                    setTimeout(function () { _onBTDisconnect(ap.savedId); }, 1000);
                }
            }
        }, 1500);
    }

    // ---------------------------------------------------------------------------
    // Public interface
    // ---------------------------------------------------------------------------

    var HardwareRecovery = {

        /**
         * Start listening for hardware events.
         * Called automatically by HardwareManager.init().
         */
        start: function () {
            if (_running) return;
            _running = true;

            // USB events — passive, no permission needed
            if ('usb' in navigator) {
                var perm = global.SokoniPermissionManager;
                var unwatch = perm
                    ? perm.watchUSBEvents(_onUSBConnect, _onUSBDisconnect)
                    : (function () {
                        var onC = function (e) { _onUSBConnect(e.device); };
                        var onD = function (e) { _onUSBDisconnect(e.device); };
                        navigator.usb.addEventListener('connect',    onC);
                        navigator.usb.addEventListener('disconnect', onD);
                        return function () {
                            navigator.usb.removeEventListener('connect',    onC);
                            navigator.usb.removeEventListener('disconnect', onD);
                        };
                    })();
                _cleanups.push(unwatch);
            }

            // Page visibility
            document.addEventListener('visibilitychange', _onVisibilityChange);
            _cleanups.push(function () {
                document.removeEventListener('visibilitychange', _onVisibilityChange);
            });

            _log('Recovery listeners started.');
        },

        /** Stop all recovery listeners. */
        stop: function () {
            _cleanups.forEach(function (fn) { try { fn(); } catch (_) {} });
            _cleanups = [];
            _running  = false;
            _log('Recovery listeners stopped.');
        },

        /** Manually trigger a Bluetooth reconnect (e.g. from gattserverdisconnected). */
        onBluetoothDisconnect: function (savedId) {
            return _onBTDisconnect(savedId);
        },

        isRunning: function () { return _running; },
    };

    global.SokoniHardwareRecovery = HardwareRecovery;

})(window);
