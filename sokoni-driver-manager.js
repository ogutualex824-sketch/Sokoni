/**
 * SOKONI Driver Manager v1.0
 *
 * Plugin registry for device drivers.
 *
 * To add support for a new device type, register its driver class here.
 * No other files need to change.
 *
 * Usage:
 *   SokoniDriverManager.register(MyPrinterDriver);
 *   const driver = SokoniDriverManager.getBestDriver(profile);
 *   await driver.onConnect(connection, profile);
 */

(function (global) {
    'use strict';

    var _drivers = {};   // driverId → DriverClass

    var DriverManager = {

        /**
         * Register a driver class.
         * The class must extend DeviceDriver and expose static properties:
         *   driverType, driverId, supportedTransports, supportedProfileIds, detect(profile)
         *
         * @param {Function} DriverClass
         */
        register: function (DriverClass) {
            if (!DriverClass || !DriverClass.driverId) {
                throw new Error('DriverManager.register: class must have a static driverId');
            }
            _drivers[DriverClass.driverId] = DriverClass;
        },

        /**
         * Unregister a driver (e.g. for testing or hot-reload).
         * @param {string} driverId
         */
        unregister: function (driverId) {
            delete _drivers[driverId];
        },

        /**
         * Get the driver class registered under driverId.
         * @param {string} driverId
         * @returns {Function|null}
         */
        get: function (driverId) {
            return _drivers[driverId] || null;
        },

        /**
         * Get all drivers that can handle the given profile.
         * @param {object} profile  SokoniDeviceProfiles entry
         * @returns {Function[]}    Array of DriverClass constructors
         */
        getDriversForDevice: function (profile) {
            if (!profile) return [];
            return Object.values(_drivers).filter(function (D) {
                try { return D.detect(profile); } catch (_) { return false; }
            });
        },

        /**
         * Get the single best driver for a profile.
         * Priority:
         *   1. Profile explicitly specifies driver ID → use that if registered
         *   2. First driver whose detect() returns true
         *   3. null
         *
         * @param {object} profile
         * @returns {Function|null}  DriverClass constructor (instantiate with `new`)
         */
        getBestDriver: function (profile) {
            if (!profile) return null;

            // Profile-specified driver
            if (profile.driver && _drivers[profile.driver]) {
                return _drivers[profile.driver];
            }

            // First matching driver
            var matches = this.getDriversForDevice(profile);
            return matches.length ? matches[0] : null;
        },

        /**
         * Instantiate the best driver for a profile.
         * Returns null if no driver is found.
         *
         * @param {object} profile
         * @returns {DeviceDriver|null}
         */
        createDriver: function (profile) {
            var D = this.getBestDriver(profile);
            if (!D) return null;
            return new D();
        },

        /**
         * Get all registered drivers of a given type.
         * @param {string} type  'printer' | 'scanner' | ...
         * @returns {Function[]}
         */
        getDriversForType: function (type) {
            return Object.values(_drivers).filter(function (D) { return D.driverType === type; });
        },

        /**
         * Get all registered driver classes.
         * @returns {Function[]}
         */
        getAll: function () {
            return Object.values(_drivers);
        },

        /**
         * List of all registered driver IDs.
         * @returns {string[]}
         */
        listIds: function () {
            return Object.keys(_drivers);
        },

        /**
         * Check if a driver is registered.
         * @param {string} driverId
         * @returns {boolean}
         */
        has: function (driverId) {
            return !!_drivers[driverId];
        },
    };

    global.SokoniDriverManager = DriverManager;

})(window);
