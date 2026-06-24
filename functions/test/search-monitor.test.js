'use strict';

/**
 * Regression tests for search-monitor.js
 *
 * Verifies that searchSystemHealth uses require('firebase-functions/logger')
 * and not admin.logger (undefined in firebase-admin v13). Primary regression:
 * TypeError "Cannot read properties of undefined (reading 'info')" must not occur.
 */

const assert = require('assert').strict;
const Module  = require('module');

/* ── Spy infrastructure ──────────────────────────────────────────────────── */

const loggerCalls = [];
const mockLogger  = {
  info:  (...a) => loggerCalls.push({ level: 'info',  args: a }),
  warn:  (...a) => loggerCalls.push({ level: 'warn',  args: a }),
  error: (...a) => loggerCalls.push({ level: 'error', args: a }),
  debug: (...a) => loggerCalls.push({ level: 'debug', args: a }),
  log:   (...a) => loggerCalls.push({ level: 'log',   args: a }),
  write: (...a) => loggerCalls.push({ level: 'write', args: a }),
};

function clearLogs() { loggerCalls.length = 0; }

/* ── Firestore mock factory ──────────────────────────────────────────────── */

function makeFirestoreMock({ docSnaps = {} } = {}) {
  const writes = [];

  function buildWhereChain(col) {
    return {
      where:  function() { return buildWhereChain(col); },
      count:  function() { return { get: () => Promise.resolve({ data: () => ({ count: 0 }) }) }; },
      limit:  function() { return buildWhereChain(col); },
      orderBy: function() { return buildWhereChain(col); },
      get:    function() { return Promise.resolve({ empty: true, docs: [] }); },
    };
  }

  let addCount = 0;
  const db = {
    doc: function(path) {
      return {
        get: function() {
          const snap = docSnaps[path] || { exists: false, data: () => ({}) };
          return Promise.resolve(snap);
        },
        set: function(data, opts) {
          writes.push({ op: 'set', path, data, opts });
          return Promise.resolve();
        },
        update: function(data) {
          writes.push({ op: 'update', path, data });
          return Promise.resolve();
        },
      };
    },
    collection: function(col) {
      const chain = buildWhereChain(col);
      chain.add = function(data) {
        const id = `mock-${col}-${++addCount}`;
        writes.push({ op: 'add', col, data, id });
        return Promise.resolve({ id });
      };
      return chain;
    },
    _writes: writes,
  };

  return db;
}

/* ── Module._load patch ──────────────────────────────────────────────────── */

let _firestoreDb;

const _origLoad = Module._load.bind(Module);
Module._load = function(request, parent, isMain) {
  if (request === 'firebase-admin') {
    const firestore = Object.assign(
      function() { return _firestoreDb; },
      { FieldValue: { serverTimestamp: () => 'SERVER_TS', delete: () => 'DELETE' } }
    );
    return { apps: [{}], initializeApp: () => {}, firestore, logger: undefined };
  }
  if (request === 'firebase-functions/logger') {
    return mockLogger;
  }
  if (request === 'firebase-functions/v2/https') {
    return {
      onCall: (opts, handler) => {
        const fn = async (req) => handler(req);
        fn.run = handler;
        return fn;
      },
      HttpsError: class HttpsError extends Error {
        constructor(code, msg) { super(msg); this.code = code; }
      },
    };
  }
  if (request === 'firebase-functions/v2/scheduler') {
    return {
      onSchedule: (opts, handler) => {
        const fn = async () => {};
        fn.run = handler;
        return fn;
      },
    };
  }
  if (request === 'firebase-functions/params') {
    return { defineSecret: (name) => ({ value: () => `mock_secret_${name}` }) };
  }
  return _origLoad(request, parent, isMain);
};

/* ── Load module under test ──────────────────────────────────────────────── */

const monitor = require('../search-monitor');

/* ─────────────────────────────────────────────────────────────────────────────
   TEST SUITE
──────────────────────────────────────────────────────────────────────────── */

(async () => {

let passed = 0;
let failed = 0;

async function test(label, fn) {
  clearLogs();
  try {
    await fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${label}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

/* ── 1. Module shape ─────────────────────────────────────────────────────── */

console.log('\nsearch-monitor.js — module shape');

await test('exports searchGetUnifiedDashboard', () => {
  assert.equal(typeof monitor.searchGetUnifiedDashboard, 'function');
});
await test('exports searchSystemHealth', () => {
  assert.equal(typeof monitor.searchSystemHealth, 'function');
});
await test('exports searchGetHealthHistory', () => {
  assert.equal(typeof monitor.searchGetHealthHistory, 'function');
});
await test('exports searchResolveAlert', () => {
  assert.equal(typeof monitor.searchResolveAlert, 'function');
});

/* ── 2. searchSystemHealth — primary regression ──────────────────────────── */

console.log('\nsearch-monitor.js — searchSystemHealth');

await test('completes without throwing (regression: admin.logger was undefined)', async () => {
  _firestoreDb = makeFirestoreMock({
    docSnaps: {
      'platformMetrics/algoliaMonitor':   { exists: true, data: () => ({ status: 'ok',   latencyMs: 120 }) },
      'platformMetrics/typesenseMonitor': { exists: true, data: () => ({ status: 'ok',   latencyMs: 95  }) },
    },
  });
  await monitor.searchSystemHealth.run({});
});

await test('calls logger.info at completion with status fields', async () => {
  _firestoreDb = makeFirestoreMock({
    docSnaps: {
      'platformMetrics/algoliaMonitor':   { exists: true, data: () => ({ status: 'ok' }) },
      'platformMetrics/typesenseMonitor': { exists: true, data: () => ({ status: 'ok' }) },
    },
  });
  await monitor.searchSystemHealth.run({});

  const infoCall = loggerCalls.find(c => c.level === 'info' &&
    c.args[0] === 'searchSystemHealth: snapshot written');
  assert.ok(infoCall, 'logger.info("searchSystemHealth: snapshot written") was not called');
  assert.equal(infoCall.args[1].overallStatus,    'healthy');
  assert.equal(infoCall.args[1].algoliaStatus,    'ok');
  assert.equal(infoCall.args[1].typesenseStatus,  'ok');
});

await test('writes time-series snapshot to searchHealthHistory', async () => {
  const db = makeFirestoreMock({
    docSnaps: {
      'platformMetrics/algoliaMonitor':   { exists: true, data: () => ({ status: 'ok' }) },
      'platformMetrics/typesenseMonitor': { exists: true, data: () => ({ status: 'ok' }) },
    },
  });
  _firestoreDb = db;
  await monitor.searchSystemHealth.run({});

  const historyWrite = db._writes.find(w =>
    w.op === 'add' && w.col === 'searchHealthHistory'
  );
  assert.ok(historyWrite, 'searchHealthHistory document was not added');
  assert.equal(historyWrite.data.algoliaStatus,   'ok');
  assert.equal(historyWrite.data.typesenseStatus, 'ok');
  assert.equal(historyWrite.data.overallStatus,   'healthy');
});

await test('overwrites searchConfig/systemHealth document', async () => {
  const db = makeFirestoreMock({
    docSnaps: {
      'platformMetrics/algoliaMonitor':   { exists: true, data: () => ({ status: 'ok' }) },
      'platformMetrics/typesenseMonitor': { exists: true, data: () => ({ status: 'ok' }) },
    },
  });
  _firestoreDb = db;
  await monitor.searchSystemHealth.run({});

  const healthWrite = db._writes.find(w =>
    w.op === 'set' && w.path === 'searchConfig/systemHealth'
  );
  assert.ok(healthWrite, 'searchConfig/systemHealth was not written');
  assert.equal(healthWrite.data.overallStatus, 'healthy');
  assert.equal(healthWrite.opts?.merge, false, 'systemHealth must use merge:false');
});

await test('writes degraded alert when one engine is down', async () => {
  const db = makeFirestoreMock({
    docSnaps: {
      'platformMetrics/algoliaMonitor':   { exists: true, data: () => ({ status: 'down' }) },
      'platformMetrics/typesenseMonitor': { exists: true, data: () => ({ status: 'ok'   }) },
    },
  });
  _firestoreDb = db;
  await monitor.searchSystemHealth.run({});

  const alert = db._writes.find(w =>
    w.op === 'add' && w.col === 'adminAlerts' &&
    w.data.category === 'search'
  );
  assert.ok(alert, 'degraded alert was not written');
  assert.equal(alert.data.severity, 'warning');
  assert.ok(alert.data.message.includes('degraded'), 'alert message should mention degraded');
});

await test('writes critical alert when both engines are down', async () => {
  const db = makeFirestoreMock({
    docSnaps: {
      'platformMetrics/algoliaMonitor':   { exists: true, data: () => ({ status: 'down' }) },
      'platformMetrics/typesenseMonitor': { exists: true, data: () => ({ status: 'down' }) },
    },
  });
  _firestoreDb = db;
  await monitor.searchSystemHealth.run({});

  const alert = db._writes.find(w =>
    w.op === 'add' && w.col === 'adminAlerts' &&
    w.data.category === 'search'
  );
  assert.ok(alert, 'critical alert was not written');
  assert.equal(alert.data.severity, 'critical');
});

await test('does not write alert when both engines are healthy', async () => {
  const db = makeFirestoreMock({
    docSnaps: {
      'platformMetrics/algoliaMonitor':   { exists: true, data: () => ({ status: 'ok' }) },
      'platformMetrics/typesenseMonitor': { exists: true, data: () => ({ status: 'ok' }) },
    },
  });
  _firestoreDb = db;
  await monitor.searchSystemHealth.run({});

  const alert = db._writes.find(w =>
    w.op === 'add' && w.col === 'adminAlerts'
  );
  assert.equal(alert, undefined, 'unexpected alert written when both engines healthy');
});

await test('treats missing monitor documents as down', async () => {
  _firestoreDb = makeFirestoreMock(); // no docSnaps → both monitors missing
  await monitor.searchSystemHealth.run({});

  const infoCall = loggerCalls.find(c => c.level === 'info' &&
    c.args[0] === 'searchSystemHealth: snapshot written');
  assert.ok(infoCall, 'logger.info not called');
  assert.equal(infoCall.args[1].overallStatus, 'critical');
});

/* ─────────────────────────────────────────────────────────────────────────── */

console.log(`\nsearch-monitor: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})();
