#!/usr/bin/env node
/* P0-8 regression test — typesense-queue.js DLQ write must not contain
 * `undefined`, which Firestore rejects.
 *
 * PROVEN FAILURE (production, 30 entries in 7d):
 *   Error: Value for argument "data" is not a valid Firestore document.
 *   Cannot use "undefined" as a Firestore value (found in field "ref").
 *
 * Cause: functions/typesense-queue.js:313 does
 *     await db.collection(DLQ_COL).doc(item.ref.id).set({ ...item, ref: undefined })
 * The author intended to STRIP `ref` from the spread, but assigning `undefined`
 * does not remove a key — and Firestore rejects undefined values unless
 * ignoreUndefinedProperties is enabled. Every DLQ write therefore throws.
 *
 * This test asserts the OBSERVABLE: the object handed to .set() must carry no
 * `undefined` value and no `ref` key. It fails against the current code and
 * passes once the fix lands — run it BEFORE fixing to confirm it actually
 * catches the defect.
 *
 * Run: node scripts/test-typesense-dlq-undefined-ref.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'functions', 'typesense-queue.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${name}${detail ? '\n        ' + detail : ''}`);
  ok ? pass++ : fail++;
}

console.log('TYPESENSE DLQ — undefined `ref` regression');
console.log('='.repeat(70));

/* ---- 1. STATIC: the literal defect must not be present ------------------- */
const stripped = SRC
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' ');

const literalUndefined = /ref\s*:\s*undefined/.test(stripped);
check('no `ref: undefined` in code (comments stripped)', !literalUndefined,
  literalUndefined ? 'still present — Firestore will reject every DLQ write' : '');

/* Positive control: prove the stripper did NOT blank the file, or the check
   above would pass vacuously on an empty string. */
check('positive control: stripped source still contains the DLQ write',
  /collection\(\s*DLQ_COL\s*\)/.test(stripped),
  'if this fails the stripper destroyed the source and test 1 proved nothing');

/* ---- 2. BEHAVIOURAL: simulate the DLQ payload construction -------------- */
/* Mirrors the shape at the call site: item carries a `ref` DocumentReference
   plus document data. Whatever the fix, the resulting payload must be
   Firestore-valid. */
function firestoreValid(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) return { ok: false, field: k };
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
        && typeof v.toMillis !== 'function' && !v.__isRef) {
      const r = firestoreValid(v);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

const fakeRef = { id: 'queue-item-1', __isRef: true, delete: async () => {}, update: async () => {} };
const item = { ref: fakeRef, docId: 'p1', collection: 'products', priority: 1,
  attempts: 4, nextAttemptAt: 123, status: 'processing' };

/* The CURRENT construction, reproduced exactly as written at line ~307 */
const currentPayload = { ...item, status: 'failed', failedAt: Date.now(),
  lastError: 'boom', attempts: 5, ref: undefined };
const curValid = firestoreValid(currentPayload);
check('current construction is Firestore-INVALID (defect reproduced)',
  curValid.ok === false && curValid.field === 'ref',
  curValid.ok ? 'expected it to be invalid — the defect may already be fixed' : `rejected on field "${curValid.field}"`);

/* The PROPOSED construction: destructure `ref` out instead of nulling it */
const { ref: _omitted, ...rest } = item;
const fixedPayload = { ...rest, status: 'failed', failedAt: Date.now(),
  lastError: 'boom', attempts: 5 };
const fixValid = firestoreValid(fixedPayload);
check('proposed construction is Firestore-VALID', fixValid.ok,
  fixValid.ok ? '' : `still rejected on field "${fixValid.field}"`);
check('proposed construction carries no `ref` key', !('ref' in fixedPayload));
check('proposed construction preserves the queue data',
  fixedPayload.docId === 'p1' && fixedPayload.collection === 'products'
  && fixedPayload.attempts === 5 && fixedPayload.status === 'failed');

/* ---- 3. the DLQ doc id still comes from the ref ------------------------- */
check('doc id still derivable from ref after destructuring', _omitted.id === 'queue-item-1',
  'the fix must keep using ref.id for the DLQ document id');

console.log('='.repeat(70));
console.log(`  pass=${pass}  fail=${fail}`);
console.log('\n  NOTE: test 1 is EXPECTED TO FAIL until functions/typesense-queue.js');
console.log('  is fixed. That is the point — it proves the test detects the defect.');
process.exit(fail ? 1 : 0);
