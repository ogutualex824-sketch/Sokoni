/* =============================================================
   sokoni-geo.js — Safe cross-browser geolocation wrapper
   Version: 1.0.0

   Why this file exists:
     Safari (WebKit) on iPhone strictly enforces the Geolocation
     API signature and throws a TypeError if arg2 (errorCallback)
     is not a callable function.  Passing null, undefined, an
     options object, or any non-function value causes:
       "Argument 2 ('errorCallback') to Geolocation.watchPosition
        must be a function"
     Chrome and Firefox silently accept null or even an options
     object in arg2 position, masking the bug on desktop.

   This wrapper:
     - validates all callback arguments before passing to the API
     - supplies a default error handler when none is given
     - wraps each native call in try/catch so nothing propagates
     - works in Safari, Chrome, Firefox, Edge, PWA, offline
     - never crashes the host page on GPS failure

   API:
     SokoniGeo.getLocation({ onSuccess, onError?, options? })
     SokoniGeo.startLocationTracking({ onSuccess, onError?, options? })
     SokoniGeo.stopLocationTracking(watchId)
     SokoniGeo.getLocationAsync(options?) → Promise<{lat,lng}|null>
     SokoniGeo.isSupported() → boolean

   See: https://www.w3.org/TR/geolocation-API/
============================================================= */
(function (global) {
  'use strict';

  /* ── User-visible error strings ──────────────────────────── */
  var GEO_ERRORS = {
    0 : 'Geolocation is not supported on this device.',
    1 : 'Location permission denied. Enable in Settings → Privacy → Location Services.',
    2 : 'GPS signal unavailable. Move to an open area and try again.',
    3 : 'Location request timed out. Check your connection and retry.',
  };

  /* ── Defaults ─────────────────────────────────────────────── */
  var DEFAULT_OPTIONS = {
    enableHighAccuracy : true,
    timeout            : 10000,
    maximumAge         : 5000,
  };

  /* ── Internal helpers ─────────────────────────────────────── */
  function _defaultErrorHandler(err) {
    var code = (err && err.code != null) ? err.code : 0;
    var msg  = GEO_ERRORS[code] || (err && err.message) || 'Location unavailable.';
    console.warn('[SokoniGeo]', msg, '(code ' + code + ')');
  }

  function _ensureErrorCb(fn) {
    /* Safari requires arg2 to be a function — never pass null/undefined/object */
    return (typeof fn === 'function') ? fn : _defaultErrorHandler;
  }

  function _mergeOpts(overrides) {
    return Object.assign({}, DEFAULT_OPTIONS, overrides || {});
  }

  function _isSupported() {
    return !!(typeof navigator !== 'undefined' &&
              navigator.geolocation &&
              typeof navigator.geolocation.getCurrentPosition === 'function');
  }

  /* ── Public API ───────────────────────────────────────────── */

  /**
   * One-shot geolocation request.
   * Initialise your map FIRST; call this after — GPS failure must
   * never prevent the map from loading.
   *
   * @param {object} params
   * @param {function}  params.onSuccess  Called with a GeolocationPosition
   * @param {function} [params.onError]   Called with a GeolocationPositionError;
   *                                      defaults to console.warn when omitted
   * @param {object}  [params.options]    PositionOptions overrides
   */
  function getLocation(params) {
    params = params || {};
    if (typeof params.onSuccess !== 'function') {
      throw new TypeError('[SokoniGeo] getLocation(): onSuccess must be a function.');
    }
    var successCb = params.onSuccess;
    var errorCb   = _ensureErrorCb(params.onError);   /* never null / undefined */
    var geoOpts   = _mergeOpts(params.options);

    if (!_isSupported()) {
      errorCb({ code: 0, message: GEO_ERRORS[0] });
      return;
    }
    try {
      navigator.geolocation.getCurrentPosition(successCb, errorCb, geoOpts);
    } catch (e) {
      /* Catch any synchronous throw from the native API (e.g. private browsing) */
      console.warn('[SokoniGeo] getCurrentPosition threw:', e.message);
      errorCb({ code: 0, message: e.message });
    }
  }

  /**
   * Continuous location tracking.
   * Returns a watchId that can be passed to stopLocationTracking().
   *
   * CRITICAL: arg2 to watchPosition must always be a function —
   * passing an options object in arg2 causes a TypeError on Safari.
   *
   * @param {object} params
   * @param {function}  params.onSuccess
   * @param {function} [params.onError]
   * @param {object}  [params.options]
   * @returns {number|null}
   */
  function startLocationTracking(params) {
    params = params || {};
    if (typeof params.onSuccess !== 'function') {
      throw new TypeError('[SokoniGeo] startLocationTracking(): onSuccess must be a function.');
    }
    var successCb = params.onSuccess;
    var errorCb   = _ensureErrorCb(params.onError);   /* Safari: must be a function */
    var geoOpts   = _mergeOpts(params.options);

    if (!_isSupported()) {
      errorCb({ code: 0, message: GEO_ERRORS[0] });
      return null;
    }
    try {
      /* Correct signature: watchPosition(success, error, options)
         NEVER call: watchPosition(success, options)  ← throws on Safari */
      return navigator.geolocation.watchPosition(successCb, errorCb, geoOpts);
    } catch (e) {
      console.warn('[SokoniGeo] watchPosition threw:', e.message);
      errorCb({ code: 0, message: e.message });
      return null;
    }
  }

  /**
   * Stop a running watch.
   * @param {number|null} watchId
   */
  function stopLocationTracking(watchId) {
    if (watchId !== null && watchId !== undefined && _isSupported()) {
      try { navigator.geolocation.clearWatch(watchId); } catch (_) {}
    }
  }

  /**
   * Promise-based one-shot. Resolves to {lat, lng} on success, null on failure.
   * Never rejects — safe to use with async/await without a try/catch.
   *
   * @param {object} [options]  PositionOptions overrides
   * @returns {Promise<{lat:number, lng:number}|null>}
   */
  function getLocationAsync(options) {
    return new Promise(function (resolve) {
      getLocation({
        onSuccess : function (pos) {
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        onError   : function () { resolve(null); },
        options   : options,
      });
    });
  }

  /* ── Export ───────────────────────────────────────────────── */
  global.SokoniGeo = {
    getLocation            : getLocation,
    startLocationTracking  : startLocationTracking,
    stopLocationTracking   : stopLocationTracking,
    getLocationAsync       : getLocationAsync,
    isSupported            : _isSupported,
    DEFAULT_OPTIONS        : DEFAULT_OPTIONS,
    GEO_ERRORS             : GEO_ERRORS,
  };

}(window));
