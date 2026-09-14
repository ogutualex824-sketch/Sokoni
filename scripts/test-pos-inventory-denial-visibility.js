#!/usr/bin/env node
/* PRIORITY 20B — DENIED POS INVENTORY WRITES MUST BE OBSERVABLE.
 *
 * HOW THIS EXECUTES REAL CODE
 * `writeStockMovement` lives inside an IIFE and is not exported, so this harness SLICES ITS
 * SOURCE OUT OF pos-sync.js and compiles that exact text with its dependencies injected. It
 * runs the bytes that ship — not a paraphrase of them. If the slice ever stops compiling or
 * stops containing the route, the CONTROL assertions below fail loudly rather than passing
 * vacuously.
 *
 * WHAT IS AND IS NOT IN SCOPE (P20B)
 * In scope: making a DENIED inventory write observable and correctly classified.
 * NOT in scope, and asserted as unchanged: rules, employee authority, the two inventory
 * models, Rail 2 pricing/total authority, the movement/audit write, and retry/DLQ semantics.
 * The inner write is deliberately still swallowed — rethrowing it would fail the queue item
 * and change DLQ behaviour, which this slice is explicitly not allowed to decide.
 *
 * Verified against SERVED ruleset 59af870d-72eb-4791-a3b6-2f4de7eb8ff7 on 2026-09-01:
 * there is no rule for the bare `inventory` collection and no catch-all, so this write is
 * denied in production. `posStockMovements` create IS permitted — hence the divergence.
 */
'use strict';
const path = require('path');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..');
const SYNC_PATH = path.join(ROOT, 'pos-sync.js');

let pass = 0, fail = 0, unproven = 0;
function head (t) { console.log('\n' + t); }
function ck (label, cond, note) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}
function unk (label, why) { unproven++; console.log('  UNPROVEN  ' + label + '   [' + why + ']'); }

async function caught (fn) {
  try { const value = await fn(); return { ok: true, value: value === undefined ? {} : value, err: null }; }
  catch (err) { return { ok: false, value: {}, err: err || new Error('unknown') }; }
}

/* ── Slice the real routine out of the shipping file and compile it ──────────── */
function sliceRoute () {
  const SRC = fs.readFileSync(SYNC_PATH, 'utf8');
  const a = SRC.indexOf('const writeStockMovement');
  const b = SRC.indexOf('const writeProductUpdate');
  if (a < 0 || b < 0 || b <= a) return { src: null };
  return { src: SRC.slice(a, b), whole: SRC };
}

/* Build a runner around the sliced source. `invBehaviour` decides what the inventory
   write does, so denial and success are both exercised against the same bytes. */
function makeRunner (routeSrc, invBehaviour) {
  const calls = { movement: [], inventory: [], errors: [], warns: [] };
  const _fsSetDoc = async (ref, payload) => { calls.movement.push({ ref, payload }); };
  const _fsDoc    = (db, col, id) => ({ __col: col, __id: id });
  const _fsIncrement = (n) => ({ __increment: n });
  const _fsUpdateDoc = async (ref, payload) => {
    calls.inventory.push({ ref, payload });
    return invBehaviour();
  };
  const fakeConsole = {
    error: (...a) => calls.errors.push(a.map(String).join(' ')),
    warn:  (...a) => calls.warns.push(a.map(String).join(' ')),
    log:   () => {},
  };
  /* eslint-disable no-new-func */
  const factory = new Function(
    '_fsSetDoc', '_fsDoc', '_fsUpdateDoc', '_fsIncrement', 'db', 'docRef', 'data', 'enriched', 'console',
    routeSrc + '\nreturn writeStockMovement;'
  );
  const data     = { qty: 5, productId: 'prod_1', branchId: 'branch_A', id: 'mv_1' };
  const enriched = Object.assign({}, data, { _syncedAt: 'T', _queueId: 'q1', sellerId: 'uid_owner' });
  const docRef   = { __col: 'posStockMovements', __id: 'mv_1' };
  const fn = factory(_fsSetDoc, _fsDoc, _fsUpdateDoc, _fsIncrement, {}, docRef, data, enriched, fakeConsole);
  return { fn, calls };
}

const DENIED = () => { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; };
const MISSING = () => { const e = new Error('No document to update'); e.code = 'not-found'; throw e; };
const OK = () => undefined;

(async () => {

/* ── 1 · CONTROL — the harness must be running the shipping bytes ────────────── */
head('1 · CONTROL — the slice must be real, compile, and contain the route');
const sliced = sliceRoute();
ck('the stock-movement route was located in pos-sync.js', !!sliced.src,
   'a null slice would make every execution assertion below vacuous');
ck('CONTROL the slice is the route, not the whole file',
   !!sliced.src && sliced.src.length > 200 && sliced.src.length < 2500,
   sliced.src ? sliced.src.length + ' chars' : 'null');
ck('CONTROL the slice targets the unruled inventory collection',
   !!sliced.src && sliced.src.indexOf("'inventory'") > -1);
{
  const c = await caught(async () => makeRunner(sliced.src, OK));
  ck('CONTROL the sliced source compiles', c.ok, c.err ? String(c.err.message) : '');
}

/* ── 2 · THE SUCCESS PATH MUST BE UNCHANGED ─────────────────────────────────── */
head('2 · a permitted inventory write behaves exactly as before');
{
  const r = makeRunner(sliced.src, OK);
  const out = await caught(() => r.fn());
  ck('the routine completes without throwing', out.ok, out.err ? String(out.err.message) : '');
  ck('the movement/audit document is written', r.calls.movement.length === 1);
  ck('the inventory quantity is incremented', r.calls.inventory.length === 1 &&
     !!r.calls.inventory[0].payload.qty && r.calls.inventory[0].payload.qty.__increment === 5);
  ck('the inventory doc id stays branch-scoped',
     r.calls.inventory[0].ref.__id === 'branch_A__prod_1' && r.calls.inventory[0].ref.__col === 'inventory',
     'the two inventory models are NOT being reconciled here');
  ck('NEGATIVE a successful write reports no error', r.calls.errors.length === 0);
}

/* ── 3 · THE DENIAL — the behaviour this slice exists to change ──────────────── */
head('3 · a DENIED inventory write');
{
  const r = makeRunner(sliced.src, DENIED);
  const out = await caught(() => r.fn());

  /* Unchanged by design: not rethrowing keeps the queue item successful, so retry and DLQ
     semantics are untouched. Rethrowing here would be a synchronisation redesign. */
  ck('the routine still does NOT throw, so retry/DLQ semantics are untouched', out.ok,
     out.err ? 'it threw: ' + String(out.err.code || out.err.message) : '');
  ck('the movement/audit write still succeeds INDEPENDENTLY', r.calls.movement.length === 1,
     'this independence is the divergence, and this slice does not remove it');
  ck('the inventory write was attempted', r.calls.inventory.length === 1);

  /* THE POINT OF P20B. Against the unfixed file this FAILS, which is the evidence. */
  ck('THE DENIAL IS OBSERVABLE — it is reported, not silently discarded',
     r.calls.errors.length > 0,
     'unfixed behaviour: the .catch(() => {}) discards it and nothing is ever emitted');
  ck('the report identifies it as a PERMISSION problem, not a missing document',
     r.calls.errors.some((m) => m.indexOf('permission-denied') > -1),
     'the existing comment blames "inventory doc may not exist", which misclassifies a denial');
  ck('the report names the collection and document so it can be acted on',
     r.calls.errors.some((m) => m.indexOf('inventory') > -1 && m.indexOf('branch_A__prod_1') > -1));
}

/* ── 4 · A GENUINELY MISSING DOCUMENT MUST STAY BENIGN ──────────────────────── */
head('4 · not-found keeps its existing benign treatment');
{
  const r = makeRunner(sliced.src, MISSING);
  const out = await caught(() => r.fn());
  ck('a missing inventory doc still does not throw', out.ok);
  ck('the movement write still succeeds', r.calls.movement.length === 1);
  ck('NEGATIVE a missing document is NOT escalated to an error',
     !r.calls.errors.some((m) => m.indexOf('permission-denied') > -1),
     'new products legitimately have no inventory doc — that was always benign');
}

/* ── 5 · SCOPE — nothing outside this routine may have moved ─────────────────── */
head('5 · scope: no authority, no rules, no Rail 2, no queue redesign');
{
  const SRC   = sliced.whole;
  const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

  ck('CONTROL the rules probe still finds blocks known to exist',
     ['products', 'posTransactions', 'posStockMovements'].every((c) => RULES.indexOf('match /' + c + '/{') > -1));
  ck('NO rule was added for the bare inventory collection', RULES.indexOf('match /inventory/{') === -1);
  ck('and still no catch-all', RULES.indexOf('match /{document=**}') === -1);

  ck('NEGATIVE no employment store is consulted by the sync engine',
     SRC.indexOf('shopEmployees') === -1 && SRC.indexOf('workspaceMemberships') === -1 &&
     SRC.indexOf('posStaff') === -1);

  /* Retry/DLQ classification is scoped to its own block, per the standing rule. */
  const PE = SRC.slice(SRC.indexOf('function _isPermanentError'), SRC.indexOf('function _isPermanentError') + 300);
  ck('CONTROL the error-classification block was isolated', PE.indexOf('permanent') > -1);
  ck('retry classification is unchanged',
     PE.indexOf("'permission-denied', 'invalid-argument', 'not-found', 'already-exists'") > -1);

  /* The offline-first sale guarantee: the transaction route is untouched by this slice. */
  ck('the transaction route still maps posTransactions', SRC.indexOf("posTransactions:   'transaction'") > -1);
  ck('the callable shift-registration route is still present',
     SRC.indexOf("shift_registration: {") > -1 || SRC.indexOf('shift_registration:') > -1);
}

head('RESULT');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);

})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
