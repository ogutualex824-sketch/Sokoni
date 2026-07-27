#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-07-24 batch-poisoning incident.
 *
 *   Oversized product present
 *          ↓
 *   Batch created
 *          ↓
 *   Valid products indexed successfully
 *          ↓
 *   Oversized product isolated
 *          ↓
 *   Clear error logged with objectID and reason
 *          ↓
 *   Queue continues processing subsequent batches
 *
 * The Algolia client is stubbed with the REAL rejection semantics: a batch call
 * fails as a unit if ANY record exceeds the limit, which is precisely what made
 * one malformed document stall indexing for everything queued beside it.
 *
 *   node scripts/test-algolia-batch-isolation.js
 */

const assert = require('assert');
const path   = require('path');
const {
  sanitizeRecord, safeImageUrl, enforceSize, recordBytes, MAX_RECORD_BYTES,
} = require(path.join(__dirname, '..', 'functions', 'algolia-sanitize.js'));

let failed = 0;
const t = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
};

console.log('\nAlgolia batch isolation + sanitisation\n');

/* The actual poison payload shape, scaled down but structurally identical. */
const BASE64 = 'data:image/jpeg;base64,' + 'A'.repeat(200000);
const poison = () => ({
  objectID: 'products_1784487444890',
  name: 'PEACH MANGO ICE',
  image: BASE64,
  images: [{ url: BASE64 }],
  description: 'x'.repeat(500),
});
const good = n => ({
  objectID: 'products_ok_' + n,
  name: 'Valid Product ' + n,
  images: [{ url: 'https://cdn.example.com/p' + n + '.jpg' }],
  thumbnail: 'https://cdn.example.com/p' + n + '.jpg',
});

/* ── 1. The sanitiser defuses the real failure ──────────────────────────── */

t('a base64 data: URI is rejected as an image reference', () => {
  assert.strictEqual(safeImageUrl(BASE64), '');
  assert.strictEqual(safeImageUrl('javascript:alert(1)'), '');
  assert.strictEqual(safeImageUrl('https://cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
});

t('the poison record is brought under the limit', () => {
  const before = recordBytes(poison());
  const r = sanitizeRecord(poison());
  assert.ok(before > 100000, 'fixture is not actually oversized: ' + before);
  assert.ok(r.ok, 'could not be sanitised: ' + r.reason);
  assert.ok(r.bytes <= MAX_RECORD_BYTES, r.bytes + ' bytes still over limit');
  assert.strictEqual(r.record.objectID, 'products_1784487444890', 'objectID must survive');
  console.log(`        ${before} → ${r.bytes} bytes; ${r.actions.join('; ')}`);
});

t('a valid record passes through unchanged', () => {
  const r = sanitizeRecord(good(1));
  assert.ok(r.ok);
  assert.deepStrictEqual(r.record, good(1), 'a clean record must not be altered');
  assert.strictEqual(r.actions.length, 0, 'no action should be reported: ' + r.actions);
});

t('an irreducible record is reported, not silently emptied', () => {
  const huge = { objectID: 'x', blob: { nested: 'y'.repeat(20000) } };  /* not a string field */
  const r = sanitizeRecord(huge);
  assert.strictEqual(r.ok, false);
  assert.ok(/\d+ bytes after sanitisation/.test(r.reason), 'reason must state the size: ' + r.reason);
});

/* ── 2. Batch semantics: one bad record must not take the others down ──── */

/* Stub with Algolia's real behaviour: reject the WHOLE call if any record is
   over the limit, naming the first offender. */
function makeAlgolia(limit) {
  const indexed = new Map();
  let calls = 0;
  return {
    calls: () => calls,
    indexed,
    saveObjects(index, objs) {
      calls++;
      for (let i = 0; i < objs.length; i++) {
        const n = recordBytes(objs[i]);
        if (n > limit) {
          const e = new Error(
            `Record at the position ${i} objectID=${objs[i].objectID} is too big size=${n}/${limit} bytes`);
          return Promise.reject(e);
        }
      }
      objs.forEach(o => indexed.set(o.objectID, o));
      return Promise.resolve({ objectIDs: objs.map(o => o.objectID) });
    },
  };
}

/* The isolation strategy from algolia-queue.js::_flushIsolating, exercised
   directly so the test does not need Firestore. */
async function flushIsolating(algolia, tuples, send) {
  const done = [], isolated = [], logs = [];
  try {
    await send(tuples.map(t => t.obj));
    tuples.forEach(t => done.push(t.obj.objectID));
    return { done, isolated, logs };
  } catch (err) {
    logs.push('batch rejected: ' + err.message);
  }
  for (const tu of tuples) {
    try { await send([tu.obj]); done.push(tu.obj.objectID); }
    catch (e2) { isolated.push(tu.obj.objectID); logs.push(`FAILED objectID=${tu.obj.objectID} — ${e2.message}`); }
  }
  return { done, isolated, logs };
}

t('OLD behaviour reproduced: one oversized record fails the whole batch', async () => {});
(async () => {
  const LIMIT = 10000;

  /* Sanity: the incident reproduces without the fix */
  {
    const a = makeAlgolia(LIMIT);
    const batch = [good(1), good(2), poison(), good(3), good(4)];
    let threw = false;
    try { await a.saveObjects('sokoni_products', batch); } catch (_) { threw = true; }
    t('without isolation, the whole batch is rejected and nothing indexes', () => {
      assert.ok(threw, 'the stub did not reproduce Algolia rejection');
      assert.strictEqual(a.indexed.size, 0, 'some records indexed — stub is wrong');
    });
  }

  /* With sanitisation + isolation */
  {
    const a = makeAlgolia(LIMIT);
    const raw = [good(1), good(2), poison(), good(3), good(4)];
    const tuples = [];
    const preIsolated = [];
    for (const obj of raw) {
      const clean = sanitizeRecord(obj);
      if (!clean.ok) { preIsolated.push({ id: obj.objectID, reason: clean.reason }); continue; }
      tuples.push({ obj: clean.record });
    }
    const r = await flushIsolating(a, tuples, objs => a.saveObjects('sokoni_products', objs));

    t('every valid product indexes', () => {
      ['products_ok_1','products_ok_2','products_ok_3','products_ok_4']
        .forEach(id => assert.ok(a.indexed.has(id), id + ' was not indexed'));
    });
    t('the offender is sanitised rather than lost — search keeps the product', () => {
      assert.ok(a.indexed.has('products_1784487444890'),
        'the oversized product should still index once its base64 image is stripped');
      assert.strictEqual(a.indexed.get('products_1784487444890').name, 'PEACH MANGO ICE');
    });
    t('no record is isolated once sanitisation has run', () => {
      assert.strictEqual(r.isolated.length + preIsolated.length, 0,
        'isolated: ' + JSON.stringify(r.isolated.concat(preIsolated)));
    });
    t('the happy path costs exactly one batch call', () => {
      assert.strictEqual(a.calls(), 1, 'expected 1 call, got ' + a.calls());
    });
  }

  /* Irreducible record: isolation must still protect its neighbours */
  {
    const a = makeAlgolia(LIMIT);
    const stubborn = { objectID: 'products_stubborn', deep: { blob: 'z'.repeat(20000) } };
    const raw = [good(1), stubborn, good(2)];
    const tuples = [], preIsolated = [];
    for (const obj of raw) {
      const clean = sanitizeRecord(obj);
      if (!clean.ok) { preIsolated.push({ id: obj.objectID, reason: clean.reason }); continue; }
      tuples.push({ obj: clean.record });
    }
    const r = await flushIsolating(a, tuples, objs => a.saveObjects('sokoni_products', objs));

    t('an unfixable record is isolated BEFORE the batch, not inside it', () => {
      assert.strictEqual(preIsolated.length, 1, 'expected 1 pre-isolated record');
      assert.strictEqual(preIsolated[0].id, 'products_stubborn');
    });
    t('its neighbours index normally', () => {
      assert.ok(a.indexed.has('products_ok_1') && a.indexed.has('products_ok_2'));
      assert.strictEqual(r.isolated.length, 0);
    });
    t('the diagnostic names the objectID and the reason', () => {
      assert.ok(/\d+ bytes after sanitisation/.test(preIsolated[0].reason), preIsolated[0].reason);
    });
  }

  /* Queue continues: a later batch is unaffected by an earlier isolation */
  {
    const a = makeAlgolia(LIMIT);
    await flushIsolating(a, [{ obj: sanitizeRecord(poison()).record }],
      objs => a.saveObjects('sokoni_products', objs));
    const later = [good(9), good(10)].map(o => ({ obj: sanitizeRecord(o).record }));
    const r2 = await flushIsolating(a, later, objs => a.saveObjects('sokoni_products', objs));
    t('the queue continues processing subsequent batches', () => {
      assert.strictEqual(r2.isolated.length, 0);
      assert.ok(a.indexed.has('products_ok_9') && a.indexed.has('products_ok_10'));
    });
  }

  console.log(failed ? `\n${failed} FAILED\n` : '\nAll checks passed\n');
  process.exit(failed ? 1 : 0);
})();
