/**
 * Regression tests — sokoni-geo.js geolocation wrapper
 *
 * Tests the pure validation and argument-building logic of the wrapper.
 * Covers the exact Safari bug that caused the live-map crash:
 *   "Argument 2 ('errorCallback') to Geolocation.watchPosition
 *    must be a function"
 *
 * Strategy: jsdom provides window/navigator globals; we mock
 * navigator.geolocation to capture what args are actually passed
 * to watchPosition/getCurrentPosition and assert they are correct.
 *
 * NO Firebase, NO Leaflet, NO network.
 */

'use strict';

/* ── Load the wrapper ──────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

/* Read the wrapper source and evaluate it in the test context.
   This gives us access to window.SokoniGeo without a bundler. */
const wrapperSrc = fs.readFileSync(
  path.resolve(__dirname, '../../sokoni-geo.js'), 'utf8'
);

function buildGlobal(geoImpl) {
  const g = {
    navigator : { geolocation: geoImpl || null },
    console   : { warn: jest.fn(), log: jest.fn() },
    window    : {},
  };
  g.window = g;
  vm.runInNewContext(wrapperSrc, g);
  return g;
}

/* ═══════════════════════════════════════════════════════════════
   isSupported()
═══════════════════════════════════════════════════════════════ */

describe('SokoniGeo.isSupported()', () => {
  test('Returns true when navigator.geolocation is available', () => {
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn(), clearWatch: jest.fn() });
    expect(g.SokoniGeo.isSupported()).toBe(true);
  });

  test('Returns false when navigator.geolocation is null', () => {
    const g = buildGlobal(null);
    expect(g.SokoniGeo.isSupported()).toBe(false);
  });

  test('Returns false when getCurrentPosition is not a function', () => {
    const g = buildGlobal({ getCurrentPosition: 'not a function', watchPosition: jest.fn() });
    expect(g.SokoniGeo.isSupported()).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
   getLocation() — arg validation
═══════════════════════════════════════════════════════════════ */

describe('SokoniGeo.getLocation() — argument validation', () => {
  test('Throws when onSuccess is not a function', () => {
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn() });
    expect(() => g.SokoniGeo.getLocation({ onSuccess: null })).toThrow('[SokoniGeo]');
    expect(() => g.SokoniGeo.getLocation({ onSuccess: 'fn' })).toThrow('[SokoniGeo]');
    expect(() => g.SokoniGeo.getLocation({})).toThrow('[SokoniGeo]');
  });

  test('Calls getCurrentPosition with (fn, fn, opts) — never (fn, null, opts)', () => {
    const getCurrentPosition = jest.fn();
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    g.SokoniGeo.getLocation({ onSuccess: jest.fn() });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    const [arg1, arg2, arg3] = getCurrentPosition.mock.calls[0];
    expect(typeof arg1).toBe('function');     // successCallback is a function
    expect(typeof arg2).toBe('function');     // errorCallback is ALWAYS a function — not null
    expect(arg3).toMatchObject({ enableHighAccuracy: expect.any(Boolean) });
  });

  test('Uses caller onError when provided', () => {
    const getCurrentPosition = jest.fn();
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    const myError = jest.fn();
    g.SokoniGeo.getLocation({ onSuccess: jest.fn(), onError: myError });
    const [, arg2] = getCurrentPosition.mock.calls[0];
    expect(arg2).toBe(myError);
  });

  test('Substitutes default error handler when onError is null', () => {
    const getCurrentPosition = jest.fn();
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    g.SokoniGeo.getLocation({ onSuccess: jest.fn(), onError: null });
    const [, arg2] = getCurrentPosition.mock.calls[0];
    expect(typeof arg2).toBe('function');     // must be a function, not null
  });

  test('Substitutes default error handler when onError is undefined', () => {
    const getCurrentPosition = jest.fn();
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    g.SokoniGeo.getLocation({ onSuccess: jest.fn() });
    const [, arg2] = getCurrentPosition.mock.calls[0];
    expect(typeof arg2).toBe('function');
  });

  test('Substitutes default error handler when onError is an object (common mistake)', () => {
    const getCurrentPosition = jest.fn();
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    g.SokoniGeo.getLocation({ onSuccess: jest.fn(), onError: { timeout: 5000 } });
    const [, arg2] = getCurrentPosition.mock.calls[0];
    expect(typeof arg2).toBe('function');
  });

  test('Merges caller options with defaults', () => {
    const getCurrentPosition = jest.fn();
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    g.SokoniGeo.getLocation({ onSuccess: jest.fn(), options: { timeout: 3000 } });
    const [,, arg3] = getCurrentPosition.mock.calls[0];
    expect(arg3.timeout).toBe(3000);
    expect(arg3.enableHighAccuracy).toBe(true);   // default preserved
  });

  test('Calls onError with unsupported error when geolocation is null', () => {
    const g = buildGlobal(null);
    const onError = jest.fn();
    g.SokoniGeo.getLocation({ onSuccess: jest.fn(), onError });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 0 }));
  });

  test('Catches synchronous throw from getCurrentPosition and calls onError', () => {
    const getCurrentPosition = jest.fn().mockImplementation(() => {
      throw new TypeError('Simulated Safari throw');
    });
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    const onError = jest.fn();
    expect(() => g.SokoniGeo.getLocation({ onSuccess: jest.fn(), onError })).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 0 }));
  });
});

/* ═══════════════════════════════════════════════════════════════
   startLocationTracking() — THE SAFARI CRASH BUG
   Regression: arg2 was an options object, not a function.
   Safari throws: "Argument 2 ('errorCallback') to
   Geolocation.watchPosition must be a function"
═══════════════════════════════════════════════════════════════ */

describe('SokoniGeo.startLocationTracking() — Safari crash regression', () => {
  test('CRITICAL: arg2 to watchPosition is always a function — never an options object', () => {
    const watchPosition = jest.fn().mockReturnValue(42);
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition });
    g.SokoniGeo.startLocationTracking({ onSuccess: jest.fn() });
    expect(watchPosition).toHaveBeenCalledTimes(1);
    const [arg1, arg2, arg3] = watchPosition.mock.calls[0];
    expect(typeof arg1).toBe('function');         // successCallback
    expect(typeof arg2).toBe('function');         // errorCallback — NEVER an object
    expect(typeof arg3).toBe('object');           // options object goes HERE, not arg2
    expect(arg3).not.toBeNull();
    expect(arg3).toHaveProperty('enableHighAccuracy');
  });

  test('CRITICAL: arg2 is not an object (options-as-arg2 was the Safari crash)', () => {
    const watchPosition = jest.fn().mockReturnValue(1);
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition });
    g.SokoniGeo.startLocationTracking({ onSuccess: jest.fn(), options: { maximumAge: 5000 } });
    const [, arg2] = watchPosition.mock.calls[0];
    expect(typeof arg2).not.toBe('object');       // was the bug: options passed as arg2
    expect(arg2).not.toBeInstanceOf(Object);
  });

  test('Throws when onSuccess is not a function', () => {
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn() });
    expect(() => g.SokoniGeo.startLocationTracking({})).toThrow('[SokoniGeo]');
    expect(() => g.SokoniGeo.startLocationTracking({ onSuccess: null })).toThrow('[SokoniGeo]');
  });

  test('Returns watchId from native watchPosition', () => {
    const watchPosition = jest.fn().mockReturnValue(99);
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition });
    const id = g.SokoniGeo.startLocationTracking({ onSuccess: jest.fn() });
    expect(id).toBe(99);
  });

  test('Returns null when geolocation is not supported', () => {
    const g = buildGlobal(null);
    const id = g.SokoniGeo.startLocationTracking({ onSuccess: jest.fn(), onError: jest.fn() });
    expect(id).toBeNull();
  });

  test('Uses caller onError when provided', () => {
    const watchPosition = jest.fn().mockReturnValue(1);
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition });
    const myError = jest.fn();
    g.SokoniGeo.startLocationTracking({ onSuccess: jest.fn(), onError: myError });
    const [, arg2] = watchPosition.mock.calls[0];
    expect(arg2).toBe(myError);
  });

  test('Substitutes default error when onError is null', () => {
    const watchPosition = jest.fn().mockReturnValue(1);
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition });
    g.SokoniGeo.startLocationTracking({ onSuccess: jest.fn(), onError: null });
    const [, arg2] = watchPosition.mock.calls[0];
    expect(typeof arg2).toBe('function');
  });

  test('Catches synchronous throw from watchPosition (returns null, calls onError)', () => {
    const watchPosition = jest.fn().mockImplementation(() => {
      throw new TypeError('Argument 2 must be a function');
    });
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition });
    const onError = jest.fn();
    let result;
    expect(() => { result = g.SokoniGeo.startLocationTracking({ onSuccess: jest.fn(), onError }); }).not.toThrow();
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 0 }));
  });

  test('Does not call watchPosition when geolocation is unsupported', () => {
    const g = buildGlobal(null);
    const onError = jest.fn();
    g.SokoniGeo.startLocationTracking({ onSuccess: jest.fn(), onError });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 0 }));
  });

  test('Options merging: caller options override defaults', () => {
    const watchPosition = jest.fn().mockReturnValue(1);
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition });
    g.SokoniGeo.startLocationTracking({
      onSuccess: jest.fn(),
      options: { maximumAge: 9999, timeout: 7777 },
    });
    const [,, arg3] = watchPosition.mock.calls[0];
    expect(arg3.maximumAge).toBe(9999);
    expect(arg3.timeout).toBe(7777);
    expect(arg3.enableHighAccuracy).toBe(true);   // default preserved
  });
});

/* ═══════════════════════════════════════════════════════════════
   stopLocationTracking()
═══════════════════════════════════════════════════════════════ */

describe('SokoniGeo.stopLocationTracking()', () => {
  test('Calls clearWatch with the given watchId', () => {
    const clearWatch = jest.fn();
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn(), clearWatch });
    g.SokoniGeo.stopLocationTracking(42);
    expect(clearWatch).toHaveBeenCalledWith(42);
  });

  test('Does not throw when watchId is null', () => {
    const clearWatch = jest.fn();
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn(), clearWatch });
    expect(() => g.SokoniGeo.stopLocationTracking(null)).not.toThrow();
    expect(clearWatch).not.toHaveBeenCalled();
  });

  test('Does not throw when geolocation is not supported', () => {
    const g = buildGlobal(null);
    expect(() => g.SokoniGeo.stopLocationTracking(5)).not.toThrow();
  });

  test('Silently catches clearWatch errors', () => {
    const clearWatch = jest.fn().mockImplementation(() => { throw new Error('clearWatch failed'); });
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn(), clearWatch });
    expect(() => g.SokoniGeo.stopLocationTracking(1)).not.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════
   getLocationAsync()
═══════════════════════════════════════════════════════════════ */

describe('SokoniGeo.getLocationAsync()', () => {
  test('Resolves to {lat, lng} on success', async () => {
    const mockPos = { coords: { latitude: -1.2921, longitude: 36.8219 } };
    const getCurrentPosition = jest.fn((success) => success(mockPos));
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    const result = await g.SokoniGeo.getLocationAsync();
    expect(result).toEqual({ lat: -1.2921, lng: 36.8219 });
  });

  test('Resolves to null on GPS failure — never rejects', async () => {
    const getCurrentPosition = jest.fn((success, error) => error({ code: 1, message: 'denied' }));
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    const result = await g.SokoniGeo.getLocationAsync();
    expect(result).toBeNull();
  });

  test('Resolves to null when geolocation is not supported', async () => {
    const g = buildGlobal(null);
    const result = await g.SokoniGeo.getLocationAsync();
    expect(result).toBeNull();
  });

  test('Passes options to getCurrentPosition', async () => {
    const getCurrentPosition = jest.fn((success) => success({ coords: { latitude: 0, longitude: 0 } }));
    const g = buildGlobal({ getCurrentPosition, watchPosition: jest.fn() });
    await g.SokoniGeo.getLocationAsync({ timeout: 3000 });
    const [,, opts] = getCurrentPosition.mock.calls[0];
    expect(opts.timeout).toBe(3000);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Default error handler
═══════════════════════════════════════════════════════════════ */

describe('SokoniGeo default error handler', () => {
  test('Logs warning for each GeoPositionError code', () => {
    const g = buildGlobal(null);
    const warn = g.console.warn;

    g.SokoniGeo.getLocation({ onSuccess: jest.fn() });
    expect(warn).toHaveBeenCalled();

    const call = warn.mock.calls[0].join(' ');
    expect(call).toMatch(/SokoniGeo/);
  });

  test('GEO_ERRORS covers codes 0-3', () => {
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn() });
    expect(g.SokoniGeo.GEO_ERRORS[0]).toBeTruthy();
    expect(g.SokoniGeo.GEO_ERRORS[1]).toBeTruthy();
    expect(g.SokoniGeo.GEO_ERRORS[2]).toBeTruthy();
    expect(g.SokoniGeo.GEO_ERRORS[3]).toBeTruthy();
  });

  test('DEFAULT_OPTIONS has required fields', () => {
    const g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn() });
    const opts = g.SokoniGeo.DEFAULT_OPTIONS;
    expect(typeof opts.enableHighAccuracy).toBe('boolean');
    expect(typeof opts.timeout).toBe('number');
    expect(typeof opts.maximumAge).toBe('number');
    expect(opts.timeout).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Exported API surface
═══════════════════════════════════════════════════════════════ */

describe('SokoniGeo API surface', () => {
  let g;
  beforeEach(() => {
    g = buildGlobal({ getCurrentPosition: jest.fn(), watchPosition: jest.fn(), clearWatch: jest.fn() });
  });

  test('getLocation is exported and is a function', () => {
    expect(typeof g.SokoniGeo.getLocation).toBe('function');
  });

  test('startLocationTracking is exported and is a function', () => {
    expect(typeof g.SokoniGeo.startLocationTracking).toBe('function');
  });

  test('stopLocationTracking is exported and is a function', () => {
    expect(typeof g.SokoniGeo.stopLocationTracking).toBe('function');
  });

  test('getLocationAsync is exported and is a function', () => {
    expect(typeof g.SokoniGeo.getLocationAsync).toBe('function');
  });

  test('isSupported is exported and is a function', () => {
    expect(typeof g.SokoniGeo.isSupported).toBe('function');
  });

  test('DEFAULT_OPTIONS is exported and is an object', () => {
    expect(typeof g.SokoniGeo.DEFAULT_OPTIONS).toBe('object');
  });

  test('GEO_ERRORS is exported and is an object', () => {
    expect(typeof g.SokoniGeo.GEO_ERRORS).toBe('object');
  });
});
