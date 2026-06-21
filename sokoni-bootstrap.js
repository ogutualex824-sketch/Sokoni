/**
 * SOKONI APPLICATION BOOTSTRAP v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic startup sequence for every page on the platform.
 *
 * Solves:
 *   - 55 DOMContentLoaded listeners firing in unpredictable order
 *   - Modules initializing before their dependencies are ready
 *   - Race conditions between Firebase Auth, Firestore, and UI rendering
 *   - Components rendering before data is available
 *   - Multiple independent "ready" checks across 178 JS files
 *
 * Startup order:
 *   1. Security            (synchronous — already loaded as first script)
 *   2. Config + Tokens     (CSS custom properties)
 *   3. Layout Manager      (dimensions, safe areas)
 *   4. UI Components       (toast, modal, spinner)
 *   5. Firebase Auth       (user session)
 *   6. Permissions         (role resolution)
 *   7. Shared Header       (navigation injection)
 *   8. Page Modules        (registered via Sokoni.register())
 *   9. Analytics           (after page is visually ready)
 *
 * Usage (on any page):
 *   Sokoni.register('my-module', ['auth', 'ui'], function(ctx) { ... });
 *   Sokoni.start();  ← called automatically from DOMContentLoaded
 *
 * Exposed on: window.Sokoni (namespace), window.SokoniBootstrap
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function(global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     PHASE CONSTANTS  (execution order)
  ───────────────────────────────────────────────────────────────────────── */
  var PHASES = {
    config:     10,
    tokens:     15,
    security:   20,
    layout:     30,
    ui:         40,
    firebase:   50,
    auth:       60,
    permissions:70,
    header:     80,
    page:       90,
    analytics:  95,
    idle:      100
  };

  /* ─────────────────────────────────────────────────────────────────────────
     MODULE REGISTRY
  ───────────────────────────────────────────────────────────────────────── */

  var _modules  = {};   /* name → { deps, phase, fn, status, promise } */
  var _ready    = {};   /* name → resolved value */
  var _started  = false;
  var _context  = {};   /* shared context passed to every module */

  /**
   * Register a module for deferred initialization.
   * @param {string}   name   - Unique module identifier
   * @param {string[]} deps   - Names of modules that must resolve first
   * @param {function} fn     - Init function. Receives context, returns value or Promise.
   * @param {number}  [phase] - Execution phase (use PHASES constant)
   */
  function register(name, deps, fn, phase) {
    if (_modules[name]) {
      console.warn('[Sokoni] Module "' + name + '" already registered — skipping duplicate.');
      return;
    }
    _modules[name] = {
      name:    name,
      deps:    deps || [],
      fn:      fn,
      phase:   phase || PHASES.page,
      status:  'pending',
      resolve: null,
      reject:  null,
      promise: null
    };
    var m = _modules[name];
    m.promise = new Promise(function(res, rej) { m.resolve = res; m.reject = rej; });
  }

  /**
   * Wait for a module (or built-in phase) to be ready.
   * @param {string|string[]} names
   * @returns {Promise}
   */
  function when(names) {
    if (typeof names === 'string') names = [names];
    return Promise.all(names.map(function(n) {
      if (_ready[n] !== undefined) return Promise.resolve(_ready[n]);
      if (_modules[n]) return _modules[n].promise;
      return Promise.resolve(null);
    }));
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BUILT-IN PHASES
     These resolve automatically when their corresponding subsystem is ready.
  ───────────────────────────────────────────────────────────────────────── */

  var _phasePromises = {};

  function _makePhase(name) {
    var res, rej;
    _phasePromises[name] = new Promise(function(r, e) { res = r; rej = e; });
    _phasePromises[name]._resolve = res;
    _phasePromises[name]._reject  = rej;
    _ready[name] = undefined;  /* mark as in-flight */
    return _phasePromises[name];
  }

  function _resolvePhase(name, value) {
    _ready[name] = value === undefined ? true : value;
    if (_phasePromises[name]) _phasePromises[name]._resolve(value);
    _context[name] = value;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     STARTUP SEQUENCE
  ───────────────────────────────────────────────────────────────────────── */

  function start() {
    if (_started) return;
    _started = true;

    _initPhases();
    _initBuiltins();
  }

  function _initPhases() {
    Object.keys(PHASES).forEach(function(p) { _makePhase(p); });
  }

  function _initBuiltins() {
    /* Phase: config */
    _resolvePhase('config', global.SokoniConfig || {});
    _resolvePhase('tokens', true);

    /* Phase: security (already loaded synchronously as first script) */
    _resolvePhase('security', global.SokoniSecurity || true);

    /* Phase: layout */
    when(['config']).then(function() {
      if (global.SokoniLayout) {
        global.SokoniLayout.init();
        _resolvePhase('layout', global.SokoniLayout);
      } else {
        _resolvePhase('layout', null);
      }
    });

    /* Phase: ui */
    when(['layout']).then(function() {
      if (global.SokoniUI) {
        global.SokoniUI.init();
        _resolvePhase('ui', global.SokoniUI);
      } else {
        _resolvePhase('ui', null);
      }
    });

    /* Phase: firebase — wait for Firebase SDK and Auth to settle */
    when(['ui']).then(function() {
      _initFirebasePhase();
    });

    /* Phase: analytics — after page is visually ready (avoid blocking LCP) */
    when(['header', 'page']).then(function() {
      setTimeout(function() {
        _resolvePhase('analytics', true);
        _runPhase(PHASES.analytics);
      }, 0);
    });
  }

  function _initFirebasePhase() {
    var timeout = setTimeout(function() {
      console.warn('[Sokoni] Firebase init timeout — proceeding as guest.');
      _resolvePhase('firebase', null);
      _resolvePhase('auth',    { user: null, uid: null, role: 'guest' });
      _resolvePhase('permissions', { role: 'guest' });
      _resolvePhase('header', true);
      _resolvePhase('page',   true);
      _runPhase(PHASES.page);
    }, 8000);

    function _proceed(firebaseApp) {
      clearTimeout(timeout);
      _resolvePhase('firebase', firebaseApp);

      /* Firebase Auth */
      try {
        var auth = global.firebase && global.firebase.auth ? global.firebase.auth() : null;
        if (auth) {
          auth.onAuthStateChanged(function(user) {
            var ctx = {
              user:  user,
              uid:   user ? user.uid : null,
              email: user ? user.email : null,
              role:  'guest'
            };

            /* Read role from localStorage (written by auth.js) */
            try {
              var stored = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
              if (stored && stored.role) ctx.role = stored.role;
              else if (stored && user)   ctx.role = stored.isAdmin ? 'admin' : 'buyer';
            } catch(e) {}

            _context.user = ctx;
            _resolvePhase('auth', ctx);

            when(['auth']).then(function() {
              _resolvePhase('permissions', { role: ctx.role, user: ctx.user });
              _resolvePhase('header', true);
              _runPhase(PHASES.header);
              _resolvePhase('page', true);
              _runPhase(PHASES.page);
            });
          }, function(err) {
            console.warn('[Sokoni] Auth error:', err.message);
            _resolvePhase('auth', { user: null, uid: null, role: 'guest' });
            _resolvePhase('permissions', { role: 'guest' });
            _resolvePhase('header', true);
            _resolvePhase('page',   true);
            _runPhase(PHASES.page);
          });
        } else {
          /* Firebase SDK not loaded or auth not available */
          _resolvePhase('auth', { user: null, uid: null, role: 'guest' });
          _resolvePhase('permissions', { role: 'guest' });
          _resolvePhase('header', true);
          _resolvePhase('page',   true);
          _runPhase(PHASES.page);
        }
      } catch(e) {
        console.error('[Sokoni] Auth init error:', e);
        _resolvePhase('auth', { user: null, uid: null, role: 'guest' });
        _resolvePhase('permissions', { role: 'guest' });
        _resolvePhase('header', true);
        _resolvePhase('page',   true);
        _runPhase(PHASES.page);
      }
    }

    /* Firebase app ready? */
    if (global.firebase && global.firebase.app) {
      try { _proceed(global.firebase.app()); }
      catch(e) { _proceed(null); }
    } else {
      /* Wait up to 5s for Firebase SDK to load */
      var attempts = 0;
      var poll = setInterval(function() {
        attempts++;
        if (global.firebase && global.firebase.app) {
          clearInterval(poll);
          try { _proceed(global.firebase.app()); }
          catch(e) { _proceed(null); }
        } else if (attempts > 50) {   /* 5s at 100ms intervals */
          clearInterval(poll);
          _proceed(null);
        }
      }, 100);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MODULE RUNNER
  ───────────────────────────────────────────────────────────────────────── */

  function _runPhase(phaseNum) {
    var mods = Object.keys(_modules)
      .map(function(k) { return _modules[k]; })
      .filter(function(m) { return m.phase === phaseNum && m.status === 'pending'; });

    mods.forEach(function(m) { _runModule(m); });
  }

  function _runModule(m) {
    m.status = 'running';

    var depPromises = m.deps.map(function(d) {
      if (_phasePromises[d]) return _phasePromises[d];
      if (_modules[d])       return _modules[d].promise;
      return Promise.resolve(null);
    });

    Promise.all(depPromises).then(function(depValues) {
      var depMap = {};
      m.deps.forEach(function(d, i) { depMap[d] = depValues[i]; });

      try {
        var result = m.fn(_context, depMap);
        if (result && typeof result.then === 'function') {
          result.then(function(val) {
            m.status = 'done';
            _ready[m.name] = val;
            m.resolve(val);
          }).catch(function(err) {
            m.status = 'failed';
            console.error('[Sokoni] Module "' + m.name + '" failed:', err);
            m.reject(err);
          });
        } else {
          m.status = 'done';
          _ready[m.name] = result;
          m.resolve(result);
        }
      } catch(err) {
        m.status = 'failed';
        console.error('[Sokoni] Module "' + m.name + '" threw:', err);
        m.reject(err);
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     LEGACY ADAPTER
     Replaces the ad-hoc DOMContentLoaded pattern used across 55 JS files.
     Existing code using DOMContentLoaded continues to work.
     New code uses Sokoni.ready() for guaranteed ordering.
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * Simple "run after page init" — replaces anonymous DOMContentLoaded.
   * @param {function} fn  - Called with (context) once auth + UI are ready
   * @param {string[]} [deps] - Optional: wait for specific phases first
   */
  function ready(fn, deps) {
    var waitFor = deps || ['auth', 'ui', 'layout'];
    when(waitFor).then(function() {
      try { fn(_context); }
      catch(e) { console.error('[Sokoni] ready() callback error:', e); }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     GLOBAL ERROR HANDLER
     Captures unhandled errors and (in dev mode) surfaces them.
  ───────────────────────────────────────────────────────────────────────── */

  function _initErrorHandler() {
    global.addEventListener('error', function(e) {
      _log('error', 'Unhandled error: ' + (e.message || 'Unknown'), {
        file: e.filename, line: e.lineno, col: e.colno
      });
    });
    global.addEventListener('unhandledrejection', function(e) {
      _log('error', 'Unhandled promise rejection', { reason: String(e.reason) });
    });
  }

  function _log(level, msg, meta) {
    var isDev = /localhost|127\.0\.0\.1/.test(global.location && global.location.hostname || '');
    if (isDev || level === 'error') {
      (console[level] || console.log)('[Sokoni]', msg, meta || '');
    }
    /* Forward to SokoniObservability if available */
    if (global.SokoniObservability && global.SokoniObservability.log) {
      global.SokoniObservability.log(level, msg, meta);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */

  var SokoniBootstrap = {
    PHASES:   PHASES,
    register: register,
    when:     when,
    ready:    ready,
    start:    start,
    context:  _context,
    log:      _log
  };

  /* Primary namespace */
  global.Sokoni = SokoniBootstrap;
  global.SokoniBootstrap = SokoniBootstrap;

  /* Auto-start on DOMContentLoaded */
  _initErrorHandler();

  if (document.readyState !== 'loading') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }

})(window);
