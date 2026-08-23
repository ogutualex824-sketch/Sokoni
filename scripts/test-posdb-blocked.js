#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — IndexedDB may be unavailable, but it must never hold POS boot hostage
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-posdb-blocked.js

   THE BUG THIS GUARDS. `_open`'s onblocked handler was empty. onblocked resolves
   nothing and rejects nothing, and init() awaits _open() with no timeout
   anywhere in the file — so a blocked open hung forever, init() never reached
   its own catch, and POS boot stopped dead. Measured on a real iPhone: the boot
   reached pos-db.js (script index 7 of 69) and hung, with no crash and no error.

   onblocked fires when another connection holds the database at an older
   version — a second tab, the installed PWA, or a connection that never closed.
   DB_VERSION was bumped 4→5, which is exactly the condition that blocks.

   WHY THE BLOCKED CASE IS TESTED FIRST-CLASS. A suite that only exercises the
   success path would have passed against the broken code for as long as it
   existed. The failure mode is the absence of an event, so it has to be provoked
   deliberately.

   The real pos-db.js is loaded and driven through a stubbed indexedDB — the
   decisions under test are the module's own.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });

/* ── a stub indexedDB whose behaviour each case chooses ─────────────────── */
function install(mode) {
  const events = [];
  global.window = global;
  global.self = global;
  /* Node 20+ exposes crypto as a getter-only global; define rather than assign. */
  if (!global.crypto || !global.crypto.subtle) {
    try { Object.defineProperty(global, 'crypto', { value: { subtle: { digest: async () => new ArrayBuffer(32) } }, configurable: true }); }
    catch (_) {}
  }
  global.TextEncoder = global.TextEncoder || require('util').TextEncoder;
  global.CustomEvent = function (t) { this.type = t; };
  global.window.dispatchEvent = (e) => { events.push(e && e.type); return true; };
  global.window.addEventListener = () => {};

  const fakeDb = {
    version: 5,
    objectStoreNames: { contains: () => true, length: 30 },
    close() {}, transaction() { throw new Error('not used'); },
  };

  global.indexedDB = {
    open() {
      const req = { result: fakeDb, error: null };
      setTimeout(() => {
        if (mode === 'success') req.onsuccess && req.onsuccess();
        else if (mode === 'error') { req.error = new Error('quota'); req.onerror && req.onerror(); }
        else if (mode === 'blocked') req.onblocked && req.onblocked();      /* and NOTHING else, ever */
        else if (mode === 'blocked-then-clears') {
          req.onblocked && req.onblocked();
          setTimeout(() => req.onsuccess && req.onsuccess(), 200);          /* the tab closed */
        }
      }, 5);
      return req;
    },
  };
  return events;
}

function loadPosDb() {
  /* Fresh instance each time: the module caches _db and _degraded. */
  const src = fs.readFileSync(path.join(ROOT, 'pos-db.js'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'window', src + '\n;module.exports = PosDB;')(mod, mod.exports, global.window);
  return mod.exports;
}

(async () => {
  /* ── 1 · a normal open still resolves ready ──────────────────────────── */
  let events = install('success');
  let PosDB = loadPosDb();
  let t0 = Date.now();
  await PosDB.init();
  ck('D1  a NORMAL open resolves and reports ready',
    events.includes('pos:db:ready') && PosDB.isDegraded() === false,
    'events=' + JSON.stringify(events) + ' degraded=' + PosDB.isDegraded());

  /* ── 2 · a real error degrades, and does not throw ───────────────────── */
  events = install('error');
  PosDB = loadPosDb();
  let threw = false;
  try { await PosDB.init(); } catch (e) { threw = true; }
  ck('D2  an OPEN ERROR degrades instead of throwing',
    !threw && PosDB.isDegraded() === true && events.includes('pos:db:unavailable'),
    'threw=' + threw + ' degraded=' + PosDB.isDegraded() + ' events=' + JSON.stringify(events));

  /* ── 3 · THE ONE THAT HUNG ───────────────────────────────────────────── */
  events = install('blocked');
  PosDB = loadPosDb();
  t0 = Date.now();
  const timeoutGuard = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('init() NEVER SETTLED — the deadlock is back')), 20000));
  let blockedOk = true, blockedErr = '';
  try { await Promise.race([PosDB.init(), timeoutGuard]); }
  catch (e) { blockedOk = false; blockedErr = e.message; }
  const blockedMs = Date.now() - t0;

  ck('D3  a BLOCKED open SETTLES rather than hanging forever',
    blockedOk, blockedErr || 'settled in ' + blockedMs + ' ms');
  ck('D4  ...within a bounded wait, not an unbounded one',
    blockedOk && blockedMs < 15000, blockedMs + ' ms  | the deadlock had no bound at all');
  ck('D5  ...and POS is told the cache is unavailable, so boot continues',
    PosDB.isDegraded() === true && events.includes('pos:db:unavailable'),
    'degraded=' + PosDB.isDegraded() + ' events=' + JSON.stringify(events) +
    '  | reads return empty, writes no-op, Firestore stays authoritative');
  ck('D6  ...and init() did NOT throw into the caller',
    blockedOk, 'a POS-cache failure must never kill the shell');

  /* ── 4 · a block that CLEARS still succeeds normally ─────────────────── */
  events = install('blocked-then-clears');
  PosDB = loadPosDb();
  await PosDB.init();
  ck('D7  CONTROL a block that CLEARS resolves normally, not degraded',
    events.includes('pos:db:ready') && PosDB.isDegraded() === false,
    'events=' + JSON.stringify(events) + ' degraded=' + PosDB.isDegraded() +
    '  | "resolve on the next success" — the original intent, now real');

  /* ── 5 · scope: nothing destructive was introduced ───────────────────── */
  const src = fs.readFileSync(path.join(ROOT, 'pos-db.js'), 'utf8');
  ck('D8  SCOPE no database deletion was added',
    !/deleteDatabase/.test(src), 'the fix must never discard a merchant\'s local data');
  ck('D9  SCOPE DB_VERSION is unchanged at 5',
    /const DB_VERSION = 5;/.test(src), 'changing the version would force a fresh upgrade for everyone');
  ck('D10 SCOPE onerror and onsuccess still settle',
    /req\.onerror\s+= \(\) => done\(reject/.test(src) && /req\.onsuccess = \(\) => done\(resolve/.test(src),
    'both existing paths preserved, routed through the single-settle guard');

  const passed = rows.filter((r) => r.ok).length;
  console.log('');
  console.log('  PosDB BLOCKED-OPEN GUARD — IndexedDB may fail, POS must still boot');
  console.log('  ' + '='.repeat(68));
  console.log('');
  for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
  console.log('');
  console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
  console.log('');
  process.exit(passed === rows.length ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILED: ' + ((e && e.stack) || e)); process.exit(2); });
