/**
 * SOKONI Device Driver Base v1.0
 *
 * All device drivers extend DeviceDriver. Adding a new peripheral type
 * requires only implementing this interface — no changes to HardwareManager,
 * DriverManager, or application code.
 *
 * Static interface (on the class itself):
 *   driverType        {string}   'printer' | 'scanner' | 'drawer' | 'display' | 'scale' | 'nfc' | 'terminal' | 'biometric'
 *   driverId          {string}   Unique driver identifier (kebab-case)
 *   supportedTransports {string[]} ['usb', 'bluetooth', 'serial', 'network', 'browser']
 *   supportedProfileIds {string[]} Profile IDs this driver handles ([] = any for its type)
 *   detect(profile)   Returns true if this driver can handle the given profile
 *
 * Instance interface (on driver instances):
 *   onConnect(connection, profile)   →  Promise<void>   Called after a Connection is established
 *   test()                           →  Promise<TestResult>
 *   status()                         →  Promise<StatusResult>
 *   execute(command, data)           →  Promise<any>    Dispatch named commands
 *   recover()                        →  Promise<boolean>
 *   diagnostics()                    →  Promise<DiagnosticsResult>
 *   disconnect()                     →  Promise<void>
 */

(function (global) {
    'use strict';

    // =========================================================================
    // Result shape constructors
    // =========================================================================

    function TestResult(ok, detail, raw) {
        return { ok: !!ok, detail: detail || (ok ? 'Test passed' : 'Test failed'), raw: raw || null, at: new Date().toISOString() };
    }

    function StatusResult(state, detail, meta) {
        // state: 'online' | 'offline' | 'busy' | 'error' | 'unknown'
        return { state: state || 'unknown', detail: detail || '', meta: meta || {}, at: new Date().toISOString() };
    }

    function DiagnosticsResult(driverId, transport, profile, checks, errors) {
        return { driverId: driverId, transport: transport, profile: profile, checks: checks || {}, errors: errors || [], at: new Date().toISOString() };
    }

    // =========================================================================
    // DeviceDriver base class
    // =========================================================================

    function DeviceDriver() {
        this._connection = null;
        this._profile    = null;
        this._connected  = false;
    }

    // ── Static interface — subclasses MUST override these ───────────────────

    DeviceDriver.driverType         = 'generic';
    DeviceDriver.driverId           = 'base-driver';
    DeviceDriver.supportedTransports = [];
    DeviceDriver.supportedProfileIds = [];

    DeviceDriver.detect = function (profile) {
        // eslint-disable-next-line no-invalid-this
        return profile && profile.driver === this.driverId;
    };

    // ── Instance interface — subclasses SHOULD override these ───────────────

    DeviceDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;
        return Promise.resolve();
    };

    DeviceDriver.prototype.test = function () {
        return Promise.resolve(TestResult(false, 'test() not implemented in ' + this.constructor.driverId));
    };

    DeviceDriver.prototype.status = function () {
        return Promise.resolve(StatusResult(this._connected ? 'online' : 'offline', '', {}));
    };

    /**
     * Dispatch a named command to the device.
     * Subclasses should switch on `command` and call the appropriate internal method.
     *
     * @param {string} command
     * @param {*} data
     * @returns {Promise<any>}
     */
    DeviceDriver.prototype.execute = function (command, data) {
        return Promise.reject(new Error('execute(' + command + ') not implemented in ' + this.constructor.driverId));
    };

    DeviceDriver.prototype.recover = function () {
        return Promise.resolve(false);
    };

    DeviceDriver.prototype.diagnostics = function () {
        return Promise.resolve(DiagnosticsResult(
            this.constructor.driverId,
            this._connection ? this._connection.transport : 'none',
            this._profile ? this._profile.id : 'none',
            { connected: this._connected },
            []
        ));
    };

    DeviceDriver.prototype.disconnect = function () {
        this._connected  = false;
        this._connection = null;
        return Promise.resolve();
    };

    // ── Helpers available to all subclasses ─────────────────────────────────

    DeviceDriver.prototype.isConnected = function () {
        return this._connected && this._connection !== null;
    };

    DeviceDriver.prototype.getProfile = function () {
        return this._profile;
    };

    DeviceDriver.prototype.getConnection = function () {
        return this._connection;
    };

    /**
     * Write bytes through the active connection.
     * @param {Uint8Array} bytes
     */
    DeviceDriver.prototype._write = function (bytes) {
        if (!this._connection) return Promise.reject(new Error('Not connected'));
        return this._connection.write(bytes);
    };

    /**
     * Read bytes from the active connection with a timeout.
     * @param {number} [timeoutMs=2000]
     */
    DeviceDriver.prototype._read = function (timeoutMs) {
        if (!this._connection) return Promise.reject(new Error('Not connected'));
        return this._connection.read(timeoutMs || 2000);
    };

    // ── Subclass factory ─────────────────────────────────────────────────────

    /**
     * Create a subclass of DeviceDriver.
     *
     * Usage:
     *   var MyDriver = DeviceDriver.extend({
     *       driverType:         'printer',
     *       driverId:           'my-printer',
     *       supportedTransports:['usb', 'bluetooth'],
     *       supportedProfileIds:['MY_DEVICE'],
     *       detect: function(profile) { return profile.id === 'MY_DEVICE'; },
     *       proto: {
     *           test:    function() { ... },
     *           execute: function(cmd, data) { ... },
     *       }
     *   });
     */
    DeviceDriver.extend = function (spec) {
        var Parent = this;

        var Ctor = function () { Parent.call(this); };

        // Inherit prototype
        Ctor.prototype = Object.create(Parent.prototype);
        Ctor.prototype.constructor = Ctor;

        // Static properties
        Ctor.driverType          = spec.driverType          || Parent.driverType;
        Ctor.driverId            = spec.driverId            || Parent.driverId;
        Ctor.supportedTransports = spec.supportedTransports || Parent.supportedTransports.slice();
        Ctor.supportedProfileIds = spec.supportedProfileIds || Parent.supportedProfileIds.slice();
        Ctor.detect              = spec.detect              || Parent.detect.bind(Ctor);
        Ctor.extend              = Parent.extend.bind(Ctor);

        // Instance methods from proto
        var proto = spec.proto || {};
        for (var key in proto) {
            if (proto.hasOwnProperty(key)) {
                Ctor.prototype[key] = proto[key];
            }
        }

        return Ctor;
    };

    // =========================================================================
    // Export
    // =========================================================================

    global.SokoniDriverBase = {
        DeviceDriver:     DeviceDriver,
        TestResult:       TestResult,
        StatusResult:     StatusResult,
        DiagnosticsResult: DiagnosticsResult,
    };

})(window);
