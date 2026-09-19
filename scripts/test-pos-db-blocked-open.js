/* ============================================================================
   REGRESSION — PosDB blocked-open must fail closed, never hang
   scripts/test-pos-db-blocked-open.js
   ============================================================================
   THE DEFECT

     req.onblocked = () => { /* resolve on the next success *​/ };

   An empty handler. `onblocked` fires when another connection holds the database
   at an older version — a second tab, the installed PWA, an iOS tab kept alive
   in the background. It resolves nothing and rejects nothing, and `init()`
   awaits `_open()` with no timeout, so:

     promise never settles -> init() never reaches its catch
                           -> neither pos:db:ready nor pos:db:unavailable fires
                           -> POS boot stops dead, with no crash and no error

   THE CONTRACT THIS PROVES

     blocked open -> bounded wait -> reject -> init() catch
                  -> pos:db:unavailable -> degraded -> POS continues

   It exercises BEHAVIOUR. `pos-db.js` is driven against a fake IndexedDB that
   fires `onblocked` and never succeeds, and the suite asserts on what the module
   DOES — which event it dispatches and whether it settles at all. Comparing
   source text against the live file would pass on a comment.

   Fake timers: the production wait is 5s and a test must not sleep for it. The
   module's `setTimeout` is replaced with one this harness can advance manually,
   so the bound is asserted rather than waited out.

   RUN  node scripts/test-pos-db-blocked-open.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'pos-db.js');

let PASS = 0, FAIL = 0, ASSERTS = 0;
const FAILURES = [];

function ok(label, cond, detail) {
  ASSERTS++;
  if (cond) { PASS++; return true; }
  FAIL++; FAILURES.push(label + (detail ? '  — ' + detail : ''));
  return false;
}

/* ── A controllable IndexedDB ────────────────────────────────────────
   `mode` decides which event the open request receives:
     'blocked'  onblocked fires and NOTHING else ever does — the real deadlock
     'success'  a normal open
     'late'     onblocked fires, then onsuccess arrives before the deadline    */
function makeEnv(mode) {
  const dispatched = [];
  const timers = [];
  let now = 0;

  const fakeSetTimeout = (fn, ms) => {
    const t = { fn, at: now + (ms || 0), cleared: false };
    timers.push(t);
    return t;
  };
  const fakeClearTimeout = (t) => { if (t) t.cleared = true; };

  /** Advance the clock and run anything due. */
  function advance(ms) {
    now += ms;
    timers.filter((t) => !t.cleared && t.at <= now && !t.done)
      .forEach((t) => { t.done = true; t.fn(); });
  }

  const requests = [];
  const indexedDB = {
    open() {
      const req = { result: null, error: null };
      requests.push(req);
      /* Handlers are attached synchronously after open() returns, so fire on a
         microtask — exactly as a browser would. */
      Promise.resolve().then(() => {
        if (mode === 'success') {
          req.result = fakeDb();
          if (req.onsuccess) req.onsuccess();
          return;
        }
        if (req.onblocked) req.onblocked();
        if (mode === 'late') {
          req.result = fakeDb();
          if (req.onsuccess) req.onsuccess();
        }
        /* mode 'blocked': nothing further, forever. */
      });
      return req;
    },
  };

  function fakeDb() {
    const names = [];
    return {
      version: 5,
      objectStoreNames: { contains: (n) => names.indexOf(n) !== -1 },
      close() {},
      transaction() { return { objectStore() { return { indexNames: { contains: () => true }, createIndex() {} }; } }; },
    };
  }

  const win = {
    dispatchEvent(e) { dispatched.push(e.type); return true; },
    addEventListener() {},
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  };

  const sandbox = {
    window: win, indexedDB, console,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    Promise, Object, Array, Error, String, Number, Date, Math, JSON,
    CustomEvent: function (type) { this.type = type; },
    TextEncoder: function () { this.encode = () => new Uint8Array(0); },
    crypto: { subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) } },
    Uint8Array, ArrayBuffer,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__PosDB = PosDB;',
                  sandbox, { filename: 'pos-db.js' });

  return { PosDB: sandbox.__PosDB, dispatched, advance, win: sandbox.window };
}

/** Run init() and report whether it SETTLED, without hanging the suite. */
function initWithin(env, advanceMs) {
  let settled = false;
  const p = env.PosDB.init().then(() => { settled = true; });
  /* Drain microtasks, advance the fake clock past the deadline, drain again. */
  return Promise.resolve()
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => { env.advance(advanceMs); })
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => Promise.race([p, Promise.resolve('pending')]))
    .then(() => settled);
}

(async function main() {

  /* ── 1. The deadlock case ────────────────────────────────────────── */
  const blocked = makeEnv('blocked');
  const settledBlocked = await initWithin(blocked, 10000);

  ok('1 init() SETTLES on a permanently blocked open', settledBlocked === true,
     'init() never settled — this is the boot hang');
  ok('1 pos:db:unavailable was dispatched',
     blocked.dispatched.indexOf('pos:db:unavailable') !== -1,
     'dispatched: [' + blocked.dispatched.join(', ') + ']');
  ok('1 pos:db:ready was NOT dispatched',
     blocked.dispatched.indexOf('pos:db:ready') === -1);
  ok('1 the cache reports degraded', blocked.PosDB.isDegraded() === true);
  ok('1 the block was marked for diagnosis', blocked.win.__posDbBlocked === true);
  ok('1 the failure reason is recorded',
     typeof blocked.win.__posDbError === 'string' && /blocked/i.test(blocked.win.__posDbError),
     'got ' + blocked.win.__posDbError);

  /* ── 2. POSITIVE CONTROL — a normal open still works ─────────────── */
  const good = makeEnv('success');
  const settledGood = await initWithin(good, 0);

  ok('2 control: init() settles on a normal open', settledGood === true);
  ok('2 control: pos:db:ready was dispatched',
     good.dispatched.indexOf('pos:db:ready') !== -1,
     'dispatched: [' + good.dispatched.join(', ') + ']');
  ok('2 control: pos:db:unavailable was NOT dispatched',
     good.dispatched.indexOf('pos:db:unavailable') === -1);

  /* ── 3. A block that CLEARS in time must still succeed ───────────── */
  /* The repair must not convert a recoverable block into a failure: if the
     other connection closes inside the window, onsuccess still wins. */
  const late = makeEnv('late');
  const settledLate = await initWithin(late, 0);

  ok('3 a block that clears in time still opens', settledLate === true);
  ok('3 it reports ready, not unavailable',
     late.dispatched.indexOf('pos:db:ready') !== -1 &&
     late.dispatched.indexOf('pos:db:unavailable') === -1,
     'dispatched: [' + late.dispatched.join(', ') + ']');

  /* ── 4. The wait is BOUNDED, not merely eventual ─────────────────── */
  const early = makeEnv('blocked');
  let earlySettled = false;
  early.PosDB.init().then(() => { earlySettled = true; });
  await new Promise((r) => setImmediate(r));
  early.advance(1000);                       /* well inside the 5s bound */
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  ok('4 it has NOT given up before the deadline', earlySettled === false,
     'settled too early — a recoverable block would be failed prematurely');
  early.advance(10000);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  ok('4 it HAS given up after the deadline', earlySettled === true,
     'still pending past the bound — the hang is not closed');

  /* ── Summary ─────────────────────────────────────────────────────── */
  console.log('\n' + '='.repeat(66));
  console.log('  POS-DB BLOCKED OPEN — REGRESSION');
  console.log('='.repeat(66));
  console.log('  assertions : ' + ASSERTS);
  console.log('  passed     : ' + PASS);
  console.log('  failed     : ' + FAIL);
  if (FAILURES.length) {
    console.log('\n  FAILURES');
    FAILURES.forEach((f) => console.log('   ✗ ' + f));
  }
  console.log('='.repeat(66));
  console.log(FAIL === 0 ? '  RESULT: FAILS CLOSED\n' : '  RESULT: DOES NOT FAIL CLOSED\n');
  process.exit(FAIL === 0 ? 0 : 1);

})().catch((e) => {
  console.error('\n  ✗ HARNESS CRASHED — regression did not complete');
  console.error('  ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
