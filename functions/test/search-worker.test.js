'use strict';

/**
 * Regression tests for search-worker.js
 *
 * Verifies that searchQueueCoordinator and searchDLQSweep use
 * require('firebase-functions/logger') and not admin.logger (which is
 * undefined in firebase-admin v13). Primary regression: TypeError
 * "Cannot read properties of undefined (reading 'info')" must not occur.
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

function makeFirestoreMock({ pendingCounts = {}, docSnaps = {} } = {}) {
  const writes = [];

  function countGet(col) {
    return Promise.resolve({ data: () => ({ count: pendingCounts[col] ?? 0 }) });
  }

  function buildWhereChain(col) {
    return {
      where:  function() { return buildWhereChain(col); },
      count:  function() { return { get: () => countGet(col) }; },
      limit:  function() { return buildWhereChain(col); },
      get:    function() { return Promise.resolve({ empty: true, docs: [] }); },
    };
  }

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
      };
    },
    collection: function(col) {
      const chain = buildWhereChain(col);
      chain.add = function(data) {
        writes.push({ op: 'add', col, data });
        return Promise.resolve({ id: 'mock-alert-id' });
      };
      return chain;
    },
    batch: function() {
      return {
        set:    () => {},
        delete: () => {},
        commit: () => Promise.resolve(),
      };
    },
    _writes: writes,
  };

  return db;
}

/* ── Module._load patch ───────────────────────────────────────────────────── */

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

/* ── Load module under test ───────────────────────────────────────────────── */

const worker = require('../search-worker');

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

console.log('\nsearch-worker.js — module shape');

await test('exports searchQueueCoordinator', () => {
  assert.equal(typeof worker.searchQueueCoordinator, 'function');
});
await test('exports searchDLQSweep', () => {
  assert.equal(typeof worker.searchDLQSweep, 'function');
});
await test('exports searchQueueRecovery', () => {
  assert.equal(typeof worker.searchQueueRecovery, 'function');
});

/* ── 2. searchQueueCoordinator — primary regression ─────────────────────── */

console.log('\nsearch-worker.js — searchQueueCoordinator');

await test('completes without throwing (regression: admin.logger was undefined)', async () => {
  _firestoreDb = makeFirestoreMock({ pendingCounts: { algoliaQueue: 5, typesenseQueue: 3 } });
  await worker.searchQueueCoordinator.run({});
});

await test('calls logger.info at completion with queue depths', async () => {
  _firestoreDb = makeFirestoreMock({ pendingCounts: { algoliaQueue: 7, typesenseQueue: 2 } });
  await worker.searchQueueCoordinator.run({});

  const infoCall = loggerCalls.find(c => c.level === 'info' &&
    c.args[0] === 'searchQueueCoordinator: complete');
  assert.ok(infoCall, 'logger.info("searchQueueCoordinator: complete") was not called');
  assert.equal(infoCall.args[1].algoliaDepth,   7);
  assert.equal(infoCall.args[1].typesenseDepth, 2);
});

await test('writes workerStatus to Firestore', async () => {
  const db = makeFirestoreMock({ pendingCounts: { algoliaQueue: 4, typesenseQueue: 1 } });
  _firestoreDb = db;
  await worker.searchQueueCoordinator.run({});

  const write = db._writes.find(w => w.op === 'set' && w.path === 'searchConfig/workerStatus');
  assert.ok(write, 'searchConfig/workerStatus was not written');
  assert.equal(write.data.algoliaQueueDepth,   4);
  assert.equal(write.data.typesenseQueueDepth, 1);
});

await test('writes admin alert when algolia queue exceeds threshold', async () => {
  const db = makeFirestoreMock({ pendingCounts: { algoliaQueue: 1500, typesenseQueue: 0 } });
  _firestoreDb = db;
  await worker.searchQueueCoordinator.run({});

  const alert = db._writes.find(w =>
    w.op === 'add' && w.col === 'adminAlerts' &&
    w.data.message && w.data.message.includes('Algolia')
  );
  assert.ok(alert, 'adminAlerts write not found for algolia threshold breach');
  assert.equal(alert.data.category, 'search');
  assert.equal(alert.data.severity, 'warning');
});

await test('writes admin alert when typesense queue exceeds threshold', async () => {
  const db = makeFirestoreMock({ pendingCounts: { algoliaQueue: 0, typesenseQueue: 2000 } });
  _firestoreDb = db;
  await worker.searchQueueCoordinator.run({});

  const alert = db._writes.find(w =>
    w.op === 'add' && w.col === 'adminAlerts' &&
    w.data.message && w.data.message.includes('Typesense')
  );
  assert.ok(alert, 'adminAlerts write not found for typesense threshold breach');
});

await test('does not write alert when queues are within threshold', async () => {
  const db = makeFirestoreMock({ pendingCounts: { algoliaQueue: 100, typesenseQueue: 50 } });
  _firestoreDb = db;
  await worker.searchQueueCoordinator.run({});

  const alert = db._writes.find(w => w.op === 'add' && w.col === 'adminAlerts');
  assert.equal(alert, undefined, 'unexpected alert written when queues below threshold');
});

await test('respects queueControl disabled flags', async () => {
  _firestoreDb = makeFirestoreMock({
    pendingCounts: { algoliaQueue: 0, typesenseQueue: 0 },
    docSnaps: {
      'searchConfig/queueControl': {
        exists: true,
        data: () => ({ algoliaEnabled: false, typesenseEnabled: false }),
      },
    },
  });
  await worker.searchQueueCoordinator.run({});

  const infoCall = loggerCalls.find(c => c.level === 'info' &&
    c.args[0] === 'searchQueueCoordinator: complete');
  assert.ok(infoCall, 'logger.info not called');
  assert.deepEqual(infoCall.args[1].activeEngines, []);
});

/* ── 3. searchDLQSweep ───────────────────────────────────────────────────── */

console.log('\nsearch-worker.js — searchDLQSweep');

await test('completes without throwing', async () => {
  _firestoreDb = makeFirestoreMock();
  await worker.searchDLQSweep.run({});
});

await test('calls logger.info at start and at completion', async () => {
  _firestoreDb = makeFirestoreMock();
  await worker.searchDLQSweep.run({});

  const startLog = loggerCalls.find(c => c.level === 'info' &&
    c.args[0] === 'searchDLQSweep: starting daily DLQ sweep');
  const doneLog  = loggerCalls.find(c => c.level === 'info' &&
    c.args[0] === 'searchDLQSweep: complete');
  assert.ok(startLog, 'start log not found');
  assert.ok(doneLog,  'completion log not found');
});

/* ─────────────────────────────────────────────────────────────────────────── */

console.log(`\nsearch-worker: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})();
