/* Invoice numbering — block allocation.

   A single _counters document transacted once per invoice puts a Firestore hot
   spot inside the payment path. Firestore sustains ~1 write/sec to one
   document; past that, transactions contend and retry. Numbering now runs
   during payment confirmation, so contention there stalls money rather than
   delaying a report.

   Sharding would give uniqueness but destroy the ascending series an auditor
   expects. Block allocation gives both: one transaction reserves a run, the
   instance serves it from memory.

   Run from the functions directory so firebase-admin resolves:
     cd functions && node ../scripts/test-counter-blocks.js */
'use strict';
const path = require('path');

/* firebase-admin exposes .firestore as a getter, so it cannot be reassigned.
   Inject a stand-in through the module cache instead, before the engine loads
   it. Only the transaction is faked — the real _nextNumber runs. */
/* Counters are keyed by document id — _counters/INV-2026 and _counters/RCT-2026
   are separate documents. An earlier version of this fake returned one shared
   doc for every id, which made the INV series bleed into RCT and looked like a
   code defect. The fake was wrong, not the engine. */
const counters = new Map();
let txnCount = 0;
const firestoreFn = () => ({
  collection: () => ({ doc: (id) => ({ _id: id }) }),
  runTransaction: async (fn) => {
    txnCount++;
    return fn({
      get: async (ref) => {
        const v = counters.get(ref._id) || 0;
        return { exists: v > 0, data: () => ({ value: v }) };
      },
      set: (ref, d) => { counters.set(ref._id, d.value); },
    });
  },
  batch: () => ({ create() {}, commit: async () => {} }),
});
firestoreFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => n };

const adminPath = require.resolve(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
require.cache[adminPath] = {
  id: adminPath, filename: adminPath, loaded: true, children: [], paths: [],
  exports: { firestore: firestoreFn },
};

const fin = require(path.join(__dirname, '..', 'functions', 'financial-engine'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 60) + ']' : ''));
  ok ? pass++ : fail++;
};

(async () => {
  const nums = [];
  for (let i = 0; i < 120; i++) nums.push(await fin._nextNumber('INV'));
  const seqs = nums.map((n) => Number(n.slice(-6)));

  console.log('\n── Uniqueness and ordering (what an auditor checks) ──');
  ck('120 numbers, all unique', new Set(nums).size === 120, new Set(nums).size + ' distinct');
  ck('strictly ascending', seqs.every((v, i) => i === 0 || v > seqs[i - 1]));
  ck('series starts at 000001', nums[0].endsWith('-000001'), nums[0]);
  ck('no gaps across block boundaries', seqs[119] - seqs[0] === 119, 'span ' + (seqs[119] - seqs[0]));
  ck('format unchanged', /^SKN-INV-\d{4}-\d{6}$/.test(nums[119]), nums[119]);

  console.log('\n── Write reduction (the reason for the change) ──');
  ck('120 invoices cost 3 counter transactions', txnCount === 3, txnCount + ' txns / 120 numbers');
  ck('40x fewer counter writes', 120 / txnCount >= 40, Math.round(120 / txnCount) + 'x');
  ck('counter advanced by whole blocks', counters.get('INV-'+new Date().getUTCFullYear()) === 150, 'value=' + counters.get('INV-'+new Date().getUTCFullYear()));

  console.log('\n── Series independence ──');
  const r = await fin._nextNumber('RCT');
  ck('receipts numbered separately', /SKN-RCT-\d{4}-000001$/.test(r), r);

  console.log('\n── Backward compatibility ──');
  /* An existing counter at N must continue from N+1, never reissue. */
  counters.set('CRN-' + new Date().getUTCFullYear(), 500); txnCount = 0;
  const fin2 = require(path.join(__dirname, '..', 'functions', 'financial-engine'));
  const after = await fin2._nextNumber('CRN');
  ck('resumes above an existing counter value', Number(after.slice(-6)) === 501, after);

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
